import { Injectable, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import {
    DeletionResponse,
    DeletionResult,
    LanguageCode,
} from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import {
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
import { PriceListChannelDefaultGroup } from '../entities/price-list-channel-default-group.entity';
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
     * group. We backfill at application bootstrap so the plugin is
     * drop-in safe on an existing system. Idempotent per channel.
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
            Logger.error(
                `Default-group backfill failed: ${(err as Error).message}`,
                loggerCtx,
            );
        }
    }

    /**
     * Idempotent helper: ensures `channelId` has a default group. Creates
     * the group (assigned to the channel) AND the channel-side default
     * mapping row if absent. Shared between the channel-creation event
     * handler and the bootstrap backfill.
     */
    private async ensureDefaultGroup(
        ctx: RequestContext,
        channelId: ID,
    ): Promise<void> {
        const existingDefault = await this.connection
            .getRepository(ctx, PriceListChannelDefaultGroup)
            .findOne({ where: { channelId } });
        if (existingDefault) {
            return;
        }
        // Atomic: create the group, assign it to the channel (ChannelAware),
        // and record it as the channel's default in one transaction. Without
        // this, a failure between steps could leave a created-but-unmapped
        // group, and the next run (which only checks the mapping) would
        // create a second orphan group.
        await this.connection.withTransaction(ctx, async txCtx => {
            const created = await this.translatableSaver.create({
                ctx: txCtx,
                input: {
                    translations: [
                        { languageCode: txCtx.languageCode, name: 'Default' },
                    ],
                },
                entityType: PriceListGroup,
                translationType: PriceListGroupTranslation,
                beforeSave: g => {
                    g.code = DEFAULT_GROUP_CODE;
                    g.priority = 0;
                },
            });
            await this.channelService.assignToChannels(
                txCtx,
                PriceListGroup,
                created.id,
                [channelId],
            );
            await this.connection
                .getRepository(txCtx, PriceListChannelDefaultGroup)
                .save(
                    new PriceListChannelDefaultGroup({
                        channelId,
                        groupId: created.id,
                    }),
                );
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
        // ChannelAware scoping: passing `channelId` makes ListQueryBuilder
        // auto-join the channels pivot and filter to the active channel —
        // no hand-rolled `where: { channelId }` needed.
        return this.listQueryBuilder
            .build(PriceListGroup, options, {
                relations: ['translations'],
                channelId: ctx.channelId,
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
                where: { id, channels: { id: ctx.channelId } },
                relations: ['translations', 'channels'],
            });
        return group ? this.translator.translate(group, ctx) : undefined;
    }

    /**
     * Fetch all groups assigned to a given channel — used by the share
     * dialog to populate the destination-group dropdown for a target
     * channel different from the active one. Read-only; permission gate is
     * at the resolver via `priceListGroupPermission.Read`.
     */
    findByChannel(ctx: RequestContext, channelId: ID): Promise<PriceListGroup[]> {
        return this.connection
            .getRepository(ctx, PriceListGroup)
            .find({
                where: { channels: { id: channelId } },
                relations: ['translations', 'channels'],
                order: { priority: 'ASC' },
            })
            .then(groups => groups.map(g => this.translator.translate(g, ctx)));
    }

    /**
     * The default group for a channel, resolved via the channel-side
     * `PriceListChannelDefaultGroup` mapping (no `isDefault` flag on the
     * group itself).
     */
    async findDefaultForChannel(
        ctx: RequestContext,
        channelId: ID,
    ): Promise<PriceListGroup> {
        const mapping = await this.connection
            .getRepository(ctx, PriceListChannelDefaultGroup)
            .findOne({
                where: { channelId },
                relations: ['group', 'group.translations'],
            });
        if (!mapping?.group) {
            throw new UserInputError(
                `No default PriceListGroup found for channel ${channelId}. ` +
                    `Channel-creation hook may not have fired.`,
            );
        }
        return this.translator.translate(mapping.group, ctx);
    }

    /** True if the group is the default for one or more channels. */
    async isDefaultForAnyChannel(ctx: RequestContext, groupId: ID): Promise<boolean> {
        const count = await this.connection
            .getRepository(ctx, PriceListChannelDefaultGroup)
            .count({ where: { groupId } });
        return count > 0;
    }

    async create(
        ctx: RequestContext,
        input: CreatePriceListGroupInput,
    ): Promise<PriceListGroup> {
        const saved = await this.translatableSaver.create({
            ctx,
            input: {
                translations: input.translations,
            },
            entityType: PriceListGroup,
            translationType: PriceListGroupTranslation,
            beforeSave: g => {
                g.code = input.code;
                g.priority = input.priority;
            },
        });
        // Assign to the active channel (ChannelAware). A group starts life
        // in exactly one channel; sharing it elsewhere is a later action.
        await this.channelService.assignToChannels(ctx, PriceListGroup, saved.id, [
            ctx.channelId,
        ]);
        // Re-fetch via findOne so the returned entity is translated and
        // carries `channels` — returning the raw translatableSaver output
        // leaves `name` null, which the non-nullable SDL field rejects.
        return (await this.findOne(ctx, saved.id)) as PriceListGroup;
    }

    async update(
        ctx: RequestContext,
        input: UpdatePriceListGroupInput,
    ): Promise<PriceListGroup> {
        const group = await this.findOne(ctx, input.id);
        if (!group) {
            throw new UserInputError(`PriceListGroup ${input.id} not found`);
        }

        if (input.code !== undefined) group.code = input.code;
        if (input.priority !== undefined) group.priority = input.priority;
        await this.connection.getRepository(ctx, PriceListGroup).save(group);

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
        if (await this.isDefaultForAnyChannel(ctx, id)) {
            throw new IllegalOperationError(ERR_PRICELIST_GROUP_DEFAULT_NOT_DELETABLE);
        }
        await this.connection.getRepository(ctx, PriceListGroup).remove(group);
        return { result: DeletionResult.DELETED };
    }

    /**
     * Set the default group for a channel — upserts the channel-side
     * `PriceListChannelDefaultGroup` mapping (one row per channel,
     * enforced by `UNIQUE(channelId)`). The group must be assigned to the
     * channel.
     */
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
        const group = await this.connection
            .getRepository(ctx, PriceListGroup)
            .findOne({
                where: { id: groupId, channels: { id: channelId } },
                relations: ['channels'],
            });
        if (!group) {
            throw new UserInputError(`PriceListGroup ${groupId} not found in channel`);
        }
        const repo = this.connection.getRepository(ctx, PriceListChannelDefaultGroup);
        const existing = await repo.findOne({ where: { channelId } });
        if (existing) {
            await repo.update({ id: existing.id }, { groupId });
        } else {
            await repo.save(new PriceListChannelDefaultGroup({ channelId, groupId }));
        }
        return this.findDefaultForChannel(ctx, channelId);
    }
}
