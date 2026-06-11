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
import { DEFAULT_PRICE_LIST_GROUP_FIELD } from '../custom-fields';
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
     * the group (assigned to the channel) AND records it as the channel's
     * default (the `Channel.defaultPriceListGroup` relation custom field) if
     * absent. Shared between the channel-creation event handler and the
     * bootstrap backfill.
     */
    private async ensureDefaultGroup(
        ctx: RequestContext,
        channelId: ID,
    ): Promise<void> {
        const channel = await this.connection.getRepository(ctx, Channel).findOne({
            where: { id: channelId },
            relations: [`customFields.${DEFAULT_PRICE_LIST_GROUP_FIELD}`],
        });
        if (channel?.customFields.defaultPriceListGroup) {
            return;
        }
        // Atomic: create the group, assign it to the channel (ChannelAware),
        // and record it as the channel's default in one transaction. Without
        // this, a failure between steps could leave a created-but-unreferenced
        // group, and the next run (which only checks the custom field) would
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
            const channelRepo = this.connection.getRepository(txCtx, Channel);
            const txChannel = await channelRepo.findOneOrFail({
                where: { id: channelId },
            });
            txChannel.customFields.defaultPriceListGroup = created;
            await channelRepo.save(txChannel);
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

    /**
     * The single channel a group belongs to. A group is assigned to exactly
     * one channel (its creating channel), so we return the first of the
     * ChannelAware `channels` relation. Used by the `PriceListGroup.channel`
     * field resolver for the paths where the relation wasn't eagerly loaded.
     */
    async findChannelForGroup(
        ctx: RequestContext,
        groupId: ID,
    ): Promise<Channel | undefined> {
        const group = await this.connection.getRepository(ctx, PriceListGroup).findOne({
            where: { id: groupId },
            relations: ['channels'],
        });
        return group?.channels?.[0];
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
     * `Channel.defaultPriceListGroup` relation custom field (no `isDefault`
     * flag on the group itself). The group is re-fetched by id (not scoped to
     * the active channel) because the default may be queried for a channel
     * other than `ctx.channelId`.
     */
    async findDefaultForChannel(
        ctx: RequestContext,
        channelId: ID,
    ): Promise<PriceListGroup> {
        const channel = await this.connection.getRepository(ctx, Channel).findOne({
            where: { id: channelId },
            relations: [`customFields.${DEFAULT_PRICE_LIST_GROUP_FIELD}`],
        });
        const groupId = channel?.customFields.defaultPriceListGroup?.id;
        if (!groupId) {
            throw new UserInputError(
                `No default PriceListGroup found for channel ${channelId}. ` +
                    `Channel-creation hook may not have fired.`,
            );
        }
        const group = await this.connection.getRepository(ctx, PriceListGroup).findOne({
            where: { id: groupId },
            relations: ['translations', 'channels'],
        });
        if (!group) {
            throw new UserInputError(
                `Default PriceListGroup ${groupId} for channel ${channelId} no longer exists.`,
            );
        }
        return this.translator.translate(group, ctx);
    }

    /**
     * True if `groupId` is the default group of `channelId`.
     *
     * Single check on the channel's `defaultPriceListGroup` custom field — no
     * need to scan every channel: a group is assigned to a single channel and
     * `setDefault` only allows a channel to default to a group it owns, so the
     * sole channel that could reference this group as default is the one it
     * belongs to (the active channel at deletion time).
     */
    async isDefaultForChannel(
        ctx: RequestContext,
        channelId: ID,
        groupId: ID,
    ): Promise<boolean> {
        const channel = await this.connection.getRepository(ctx, Channel).findOne({
            where: { id: channelId },
            relations: [`customFields.${DEFAULT_PRICE_LIST_GROUP_FIELD}`],
        });
        const defaultId = channel?.customFields.defaultPriceListGroup?.id;
        return defaultId != null && idsAreEqual(defaultId, groupId);
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
        if (await this.isDefaultForChannel(ctx, ctx.channelId, id)) {
            throw new IllegalOperationError(ERR_PRICELIST_GROUP_DEFAULT_NOT_DELETABLE);
        }
        await this.connection.getRepository(ctx, PriceListGroup).remove(group);
        return { result: DeletionResult.DELETED };
    }

    /**
     * Set the default group for a channel — assigns the channel-side
     * `Channel.defaultPriceListGroup` relation custom field (one value per
     * channel, structural since the FK lives on the channel row). The group
     * must be assigned to the channel.
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
        const channelRepo = this.connection.getRepository(ctx, Channel);
        const channel = await channelRepo.findOneOrFail({ where: { id: channelId } });
        channel.customFields.defaultPriceListGroup = group;
        await channelRepo.save(channel);
        return this.findDefaultForChannel(ctx, channelId);
    }
}
