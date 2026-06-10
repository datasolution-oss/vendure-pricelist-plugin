import { Injectable, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import {
    DeletionResponse,
    DeletionResult,
    LanguageCode,
} from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import {
    Channel,
    ChannelEvent,
    ChannelService,
    EventBus,
    IllegalOperationError,
    ListQueryBuilder,
    ListQueryOptions,
    Logger,
    PaginatedList,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
    TranslatableSaver,
    TranslatorService,
    UserInputError,
    idsAreEqual,
} from '@vendure/core';
import { filter } from 'rxjs/operators';

import {
    DEFAULT_GROUP_CODE,
    ERR_PRICELIST_GROUP_DEFAULT_NOT_DELETABLE,
    loggerCtx,
} from '../constants';
import { PriceListGroupTranslation } from '../entities/price-list-group-translation.entity';
import { PriceListGroup } from '../entities/price-list-group.entity';

export interface CreatePriceListGroupInput {
    code: string;
    priority: number;
    translations: Array<{ languageCode: LanguageCode; name: string }>;
}

export interface UpdatePriceListGroupInput {
    id: ID;
    code?: string;
    priority?: number;
    translations?: Array<{ languageCode: LanguageCode; name: string }>;
}

@Injectable()
export class PriceListGroupService implements OnModuleInit, OnApplicationBootstrap {
    constructor(
        private connection: TransactionalConnection,
        private listQueryBuilder: ListQueryBuilder,
        private eventBus: EventBus,
        private translatableSaver: TranslatableSaver,
        private translator: TranslatorService,
        private channelService: ChannelService,
        private requestContextService: RequestContextService,
    ) {}

    /**
     * Forward path: any channel created **after** the plugin is loaded
     * gets its default `PriceListGroup` materialized through the event
     * bus. The handler is idempotent (existence check first), so a
     * race with the bootstrap backfill below is benign.
     */
    onModuleInit() {
        this.eventBus
            .ofType(ChannelEvent)
            .pipe(filter(e => e.type === 'created'))
            .subscribe(async event => {
                const { ctx, entity: channel } = event;
                await this.ensureDefaultGroup(ctx, channel.id);
            });
    }

    /**
     * Bootstrap path: any channel that **predates** the plugin install
     * never received the `ChannelEvent` and therefore has no default
     * group — `findDefaultForChannel` would throw on the first
     * pricelist create. We backfill at application bootstrap so the
     * plugin is drop-in safe on an existing system.
     *
     * Runs once per server start, scans every active channel, and
     * skips those that already have a default group. Failure on a
     * single channel is logged but does not abort bootstrap of the
     * other channels (or of the rest of Vendure).
     */
    async onApplicationBootstrap(): Promise<void> {
        try {
            const ctx = await this.requestContextService.create({
                apiType: 'admin',
            });
            const allChannels = await this.channelService.findAll(ctx, {
                take: 1000,
            });
            for (const channel of allChannels.items) {
                try {
                    await this.ensureDefaultGroup(ctx, channel.id);
                } catch (err) {
                    Logger.error(
                        `Failed to ensure default group for channel ${channel.code} (${channel.id}): ${
                            (err as Error).message
                        }`,
                        loggerCtx,
                    );
                }
            }
        } catch (err) {
            // Top-level catch — never let a plugin's bootstrap kill the
            // server. We log and let `findDefaultForChannel` throw
            // later with its user-facing message if a list is created
            // on a channel without a default group.
            Logger.error(
                `Default-group backfill failed: ${(err as Error).message}`,
                loggerCtx,
            );
        }
    }

    /**
     * Idempotent helper: creates the default group for `channelId` if
     * one doesn't exist. Shared between the channel-creation event
     * handler and the bootstrap backfill.
     */
    private async ensureDefaultGroup(
        ctx: RequestContext,
        channelId: ID,
    ): Promise<void> {
        const existing = await this.connection
            .getRepository(ctx, PriceListGroup)
            .findOne({ where: { channelId, isDefault: true } });
        if (existing) {
            return;
        }
        // Non-translated fields set via beforeSave; translatableSaver
        // handles the translation row in the same transaction.
        await this.translatableSaver.create({
            ctx,
            input: {
                translations: [
                    { languageCode: ctx.languageCode, name: 'Default' },
                ],
            },
            entityType: PriceListGroup,
            translationType: PriceListGroupTranslation,
            beforeSave: g => {
                g.code = DEFAULT_GROUP_CODE;
                g.priority = 0;
                g.isDefault = true;
                g.channelId = channelId;
            },
        });
        Logger.info(
            `Created default PriceListGroup for channel ${channelId}.`,
            loggerCtx,
        );
    }

    findAll(
        ctx: RequestContext,
        options?: ListQueryOptions<PriceListGroup>,
    ): Promise<PaginatedList<PriceListGroup>> {
        return this.listQueryBuilder
            .build(PriceListGroup, options, {
                where: { channelId: ctx.channelId },
                relations: ['translations', 'channel'],
                ctx,
            })
            .getManyAndCount()
            .then(([items, totalItems]) => ({
                items: items.map(g => this.translator.translate(g, ctx)),
                totalItems,
            }));
    }

    async findOne(ctx: RequestContext, id: ID): Promise<PriceListGroup | undefined> {
        const group = await this.connection
            .getRepository(ctx, PriceListGroup)
            .findOne({
                where: { id, channelId: ctx.channelId },
                relations: ['translations', 'channel'],
            });
        return group ? this.translator.translate(group, ctx) : undefined;
    }

    /**
     * Fetch all groups belonging to a given channel — used by the share
     * dialog to populate the destination-group dropdown for a target
     * channel different from the active one. Bypasses the
     * `ctx.channelId` filter that `findAll` applies. Read-only;
     * permission gate is at the resolver via `priceListGroupPermission.Read`.
     */
    findByChannel(ctx: RequestContext, channelId: ID): Promise<PriceListGroup[]> {
        return this.connection
            .getRepository(ctx, PriceListGroup)
            .find({
                where: { channelId },
                relations: ['translations', 'channel'],
                order: { priority: 'ASC' },
            })
            .then(groups => groups.map(g => this.translator.translate(g, ctx)));
    }

    async findDefaultForChannel(
        ctx: RequestContext,
        channelId: ID,
    ): Promise<PriceListGroup> {
        const group = await this.connection
            .getRepository(ctx, PriceListGroup)
            .findOne({
                where: { channelId, isDefault: true },
                relations: ['translations', 'channel'],
            });
        if (!group) {
            throw new UserInputError(
                `No default PriceListGroup found for channel ${channelId}. ` +
                    `Channel-creation hook may not have fired.`,
            );
        }
        return group;
    }

    async create(
        ctx: RequestContext,
        input: CreatePriceListGroupInput,
    ): Promise<PriceListGroup> {
        return this.translatableSaver.create({
            ctx,
            input: {
                translations: input.translations,
            },
            entityType: PriceListGroup,
            translationType: PriceListGroupTranslation,
            beforeSave: g => {
                g.code = input.code;
                g.priority = input.priority;
                g.isDefault = false;
                g.channelId = ctx.channelId;
            },
        });
    }

    async update(
        ctx: RequestContext,
        input: UpdatePriceListGroupInput,
    ): Promise<PriceListGroup> {
        const group = await this.findOne(ctx, input.id);
        if (!group) {
            throw new UserInputError(`PriceListGroup ${input.id} not found`);
        }

        // Non-translated fields directly on the entity.
        if (input.code !== undefined) group.code = input.code;
        if (input.priority !== undefined) group.priority = input.priority;
        await this.connection.getRepository(ctx, PriceListGroup).save(group);

        // Translated fields via the saver.
        if (input.translations) {
            await this.translatableSaver.update({
                ctx,
                input: {
                    id: group.id,
                    translations: input.translations,
                },
                entityType: PriceListGroup,
                translationType: PriceListGroupTranslation,
            });
        }
        return (await this.findOne(ctx, group.id)) as PriceListGroup;
    }

    async delete(ctx: RequestContext, id: ID): Promise<DeletionResponse> {
        const group = await this.findOne(ctx, id);
        if (!group) {
            return {
                result: DeletionResult.NOT_DELETED,
                message: `PriceListGroup ${id} not found`,
            };
        }
        if (group.isDefault) {
            throw new IllegalOperationError(ERR_PRICELIST_GROUP_DEFAULT_NOT_DELETABLE);
        }
        await this.connection.getRepository(ctx, PriceListGroup).remove(group);
        return { result: DeletionResult.DELETED };
    }

    async setDefault(
        ctx: RequestContext,
        channelId: ID,
        groupId: ID,
    ): Promise<PriceListGroup> {
        if (!idsAreEqual(ctx.channelId, channelId)) {
            throw new IllegalOperationError(
                'Cannot set default group from a different active channel',
            );
        }
        const repo = this.connection.getRepository(ctx, PriceListGroup);
        const newDefault = await repo.findOne({ where: { id: groupId, channelId } });
        if (!newDefault) {
            throw new UserInputError(`PriceListGroup ${groupId} not found in channel`);
        }
        if (newDefault.isDefault) {
            return newDefault;
        }
        await this.connection.rawConnection.transaction(async manager => {
            const txRepo = manager.getRepository(PriceListGroup);
            await txRepo.update({ channelId, isDefault: true }, { isDefault: false });
            await txRepo.update({ id: groupId }, { isDefault: true });
        });
        return this.findDefaultForChannel(ctx, channelId);
    }
}
