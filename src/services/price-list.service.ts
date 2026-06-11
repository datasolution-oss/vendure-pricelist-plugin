import { Injectable } from '@nestjs/common';
import {
    DeletionResponse,
    DeletionResult,
    LanguageCode,
} from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import {
    Channel,
    IllegalOperationError,
    ListQueryBuilder,
    ListQueryOptions,
    PaginatedList,
    RequestContext,
    TransactionalConnection,
    TranslatableSaver,
    TranslatorService,
    UserInputError,
    idsAreEqual,
} from '@vendure/core';
import { IsNull } from 'typeorm';

import {
    ERR_PRICELIST_GROUP_CHANNEL_MISMATCH,
    ERR_PRICELIST_NOT_SHARED_TO_CHANNEL,
    ERR_PRICELIST_READONLY_NON_ORIGIN_CHANNEL,
} from '../constants';
import { PriceListChannelAccess } from '../entities/price-list-channel-access.entity';
import { PriceListGroupMembership } from '../entities/price-list-group-membership.entity';
import { PriceListGroup } from '../entities/price-list-group.entity';
import { PriceListItem, PriceListValueType } from '../entities/price-list-item.entity';
import { PriceListTranslation } from '../entities/price-list-translation.entity';
import { PriceList } from '../entities/price-list.entity';

import { PriceListGroupService } from './price-list-group.service';

export interface PriceListTranslationInput {
    languageCode: LanguageCode;
    name: string;
    description?: string | null;
}

export interface CreatePriceListInput {
    code: string;
    valueType: PriceListValueType;
    /**
     * Optional at the API edge (Stage 1D — picker held back); defaults
     * to `'UTC'` when omitted.
     */
    timezone?: string;
    startDate?: Date | null;
    endDate?: Date | null;
    priority: number;
    enabled?: boolean;
    groupId?: ID;
    translations: PriceListTranslationInput[];
}

/**
 * `valueType` is intentionally NOT updatable here — flipping it mid-life
 * would silently re-interpret every item value. `timezone` may be updated.
 */
export interface UpdatePriceListInput {
    id: ID;
    code?: string;
    timezone?: string;
    startDate?: Date | null;
    endDate?: Date | null;
    priority?: number;
    enabled?: boolean;
    translations?: PriceListTranslationInput[];
}

export interface AssignPriceListToChannelInput {
    priceListId: ID;
    channelId: ID;
    /** Optional — falls back to the target channel's default group. */
    groupId?: ID;
}

@Injectable()
export class PriceListService {
    constructor(
        private connection: TransactionalConnection,
        private listQueryBuilder: ListQueryBuilder,
        private groupService: PriceListGroupService,
        private translatableSaver: TranslatableSaver,
        private translator: TranslatorService,
    ) {}

    private static readonly DETAIL_RELATIONS = [
        'originChannel',
        'translations',
        'channels',
        'groupMemberships',
        'groupMemberships.channel',
        'groupMemberships.group',
        'groupMemberships.group.translations',
    ];

    findAll(
        ctx: RequestContext,
        options?: ListQueryOptions<PriceList>,
        opts: { includeDeleted?: boolean } = {},
    ): Promise<PaginatedList<PriceList>> {
        return this.listQueryBuilder
            .build(PriceList, options, {
                relations: PriceListService.DETAIL_RELATIONS,
                where: opts.includeDeleted ? {} : { deletedAt: IsNull() },
                ctx,
                channelId: ctx.channelId,
            })
            .getManyAndCount()
            .then(([items, totalItems]) => ({
                items: items.map(pl => this.translatePriceList(pl, ctx)),
                totalItems,
            }));
    }

    async findOne(
        ctx: RequestContext,
        id: ID,
        opts: { includeDeleted?: boolean } = {},
    ): Promise<PriceList | undefined> {
        const list = await this.connection
            .getRepository(ctx, PriceList)
            .findOne({
                where: {
                    id,
                    ...(opts.includeDeleted ? {} : { deletedAt: IsNull() }),
                },
                relations: PriceListService.DETAIL_RELATIONS,
            });
        // Access scoping is enforced in JS rather than via a `channels`
        // relation-where: filtering on `channels` in the query prunes the
        // loaded collection to the active channel, so the detail view could
        // never show all the channels a list is shared to. Load the full
        // relation, then gate access here (the list must reach the active
        // channel to be visible).
        if (
            !list ||
            !list.channels?.some(c => idsAreEqual(c.id, ctx.channelId))
        ) {
            return undefined;
        }
        return this.translatePriceList(list, ctx);
    }

    findByCode(ctx: RequestContext, code: string): Promise<PriceList | undefined> {
        return this.connection
            .getRepository(ctx, PriceList)
            .findOne({
                where: { code, originChannelId: ctx.channelId, deletedAt: IsNull() },
                relations: ['translations'],
            })
            .then(pl => pl ?? undefined);
    }

    /**
     * Translates the PriceList AND each nested PriceListGroup on its group
     * memberships, so the dashboard can render `group.name` in the active
     * language without a separate fetch.
     */
    private translatePriceList(list: PriceList, ctx: RequestContext): PriceList {
        const translated = this.translator.translate(list, ctx) as PriceList;
        if (translated.groupMemberships) {
            translated.groupMemberships.forEach(m => {
                if (m.group) {
                    m.group = this.translator.translate(m.group, ctx) as typeof m.group;
                }
            });
        }
        return translated;
    }

    // === CRUD ===

    async create(ctx: RequestContext, input: CreatePriceListInput): Promise<PriceList> {
        const groupId = await this.resolveCreateGroupId(ctx, input.groupId);
        const activeChannel = await this.requireChannel(ctx, ctx.channelId);

        const list = await this.translatableSaver.create({
            ctx,
            input: {
                translations: input.translations.map(t => ({
                    languageCode: t.languageCode,
                    name: t.name,
                    description: t.description ?? '',
                })),
            },
            entityType: PriceList,
            translationType: PriceListTranslation,
            beforeSave: pl => {
                pl.code = input.code;
                pl.valueType = input.valueType;
                pl.timezone = input.timezone ?? 'UTC';
                pl.startDate = input.startDate ?? null;
                pl.endDate = input.endDate ?? null;
                pl.priority = input.priority;
                pl.enabled = input.enabled ?? true;
                pl.originChannelId = ctx.channelId;
                pl.channels = [activeChannel];
            },
        });

        // Bind to the resolved group on the origin channel.
        await this.connection
            .getRepository(ctx, PriceListGroupMembership)
            .save(
                new PriceListGroupMembership({
                    priceListId: list.id,
                    channelId: ctx.channelId,
                    groupId,
                }),
            );

        return this.findOne(ctx, list.id) as Promise<PriceList>;
    }

    async update(ctx: RequestContext, input: UpdatePriceListInput): Promise<PriceList> {
        const list = await this.assertContentEditable(ctx, input.id);

        if (input.code !== undefined) list.code = input.code;
        if (input.timezone !== undefined) list.timezone = input.timezone;
        if (input.priority !== undefined) list.priority = input.priority;
        if (input.enabled !== undefined) list.enabled = input.enabled;
        if (input.startDate !== undefined) list.startDate = input.startDate;
        if (input.endDate !== undefined) list.endDate = input.endDate;
        await this.connection.getRepository(ctx, PriceList).save(list);

        if (input.translations) {
            await this.translatableSaver.update({
                ctx,
                input: {
                    id: list.id,
                    translations: input.translations.map(t => ({
                        languageCode: t.languageCode,
                        name: t.name,
                        description: t.description ?? '',
                    })),
                },
                entityType: PriceList,
                translationType: PriceListTranslation,
            });
        }
        return this.findOne(ctx, list.id) as Promise<PriceList>;
    }

    /**
     * O(1) soft delete: a single UPDATE on the parent. Items are filtered
     * out of every item query by `priceList.deletedAt IS NULL`. Subject to
     * the `purgePendingDeletionTask` cron after the grace period.
     */
    async softDelete(ctx: RequestContext, id: ID): Promise<DeletionResponse> {
        const list = await this.assertContentEditable(ctx, id);
        await this.connection
            .getRepository(ctx, PriceList)
            .update({ id: list.id }, { deletedAt: new Date() });
        return { result: DeletionResult.DELETED };
    }

    /**
     * Clear `deletedAt` on a pricelist still in its grace period. Throws if
     * the active channel isn't the origin (consistent with the content
     * edit guard). Idempotent.
     */
    async restore(ctx: RequestContext, id: ID): Promise<PriceList> {
        const list = await this.connection
            .getRepository(ctx, PriceList)
            .findOne({ where: { id, channels: { id: ctx.channelId } } });
        if (!list) {
            throw new UserInputError(`PriceList ${id} not found`);
        }
        if (!idsAreEqual(ctx.channelId, list.originChannelId)) {
            throw new IllegalOperationError(ERR_PRICELIST_READONLY_NON_ORIGIN_CHANNEL);
        }
        if (list.deletedAt === null) {
            return this.findOne(ctx, id) as Promise<PriceList>;
        }
        await this.connection
            .getRepository(ctx, PriceList)
            .update({ id: list.id }, { deletedAt: null });
        return this.findOne(ctx, id) as Promise<PriceList>;
    }

    /**
     * Hard-delete pricelists whose grace period has expired. Called by the
     * `purgePendingDeletionTask`. Idempotent + interruption-safe.
     *
     * `PriceListItem` is purged explicitly in bounded sub-batches *before*
     * the parent rows, because that is where the volume lives: a single
     * pricelist may hold hundreds of thousands of items, and leaving them to
     * the parent's `onDelete: CASCADE` would delete them all inside one
     * transaction (long locks, large WAL). The remaining children
     * (translations, memberships, channel access) are low-cardinality and
     * still cascade with the parent delete.
     *
     * Interruption-safety is preserved: items are removed under a still
     * soft-deleted parent, so a crash between item-purge and parent-delete
     * just leaves the list to be re-selected on the next run (its items
     * already gone). Returns the count of pricelists purged.
     */
    async purgePending(
        ctx: RequestContext,
        opts: { olderThan: Date; batchSize: number },
    ): Promise<number> {
        const repo = this.connection.getRepository(ctx, PriceList);
        let totalPurged = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const candidateIds = await repo
                .createQueryBuilder('pl')
                .select('pl.id', 'id')
                .where('pl.deletedAt IS NOT NULL')
                .andWhere('pl.deletedAt < :cutoff', { cutoff: opts.olderThan })
                .orderBy('pl.deletedAt', 'ASC')
                .limit(opts.batchSize)
                .getRawMany<{ id: ID }>();
            if (candidateIds.length === 0) {
                break;
            }
            const ids = candidateIds.map(r => r.id);
            // High-volume child first, in its own bounded transactions.
            await this.purgeItemsForLists(ids, opts.batchSize);
            // Parent + remaining low-volume children (cascade).
            await this.connection.rawConnection.transaction(async manager => {
                await manager
                    .getRepository(PriceList)
                    .createQueryBuilder()
                    .delete()
                    .where('id IN (:...ids)', { ids })
                    .execute();
            });
            totalPurged += candidateIds.length;
            if (candidateIds.length < opts.batchSize) {
                break;
            }
        }
        return totalPurged;
    }

    /**
     * Delete all `PriceListItem` rows belonging to the given pricelists, in
     * transactions of at most `batchSize` rows. Postgres has no
     * `DELETE ... LIMIT`, so each batch is bounded via an `id IN (subquery
     * LIMIT n)`. Loops until no rows remain for these lists.
     */
    private async purgeItemsForLists(ids: ID[], batchSize: number): Promise<void> {
        const itemTable =
            this.connection.rawConnection.getMetadata(PriceListItem).tableName;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const result = await this.connection.rawConnection.transaction(manager =>
                manager
                    .getRepository(PriceListItem)
                    .createQueryBuilder()
                    .delete()
                    .where(
                        `id IN (SELECT id FROM "${itemTable}" ` +
                            `WHERE "priceListId" IN (:...ids) LIMIT :lim)`,
                        { ids, lim: batchSize },
                    )
                    .execute(),
            );
            if (!result.affected || result.affected < batchSize) {
                break;
            }
        }
    }

    // === Channel sharing ===

    /**
     * Share a list to a channel. Origin-guarded (you push from where the
     * list lives). The destination `groupId` is optional — when omitted
     * the list lands in the target channel's default group, leaving the
     * receiving channel's admin to re-bucket it later.
     */
    async assignToChannel(
        ctx: RequestContext,
        input: AssignPriceListToChannelInput,
    ): Promise<PriceList> {
        const list = await this.assertContentEditable(ctx, input.priceListId);

        const groupId = await this.resolveGroupForChannel(
            ctx,
            input.channelId,
            input.groupId,
        );

        const targetChannel = await this.requireChannel(ctx, input.channelId);
        const withChannels = await this.connection
            .getRepository(ctx, PriceList)
            .findOne({ where: { id: list.id }, relations: ['channels'] });
        if (!withChannels) {
            throw new UserInputError(`PriceList ${list.id} not found`);
        }
        if (withChannels.channels.some(c => idsAreEqual(c.id, input.channelId))) {
            throw new UserInputError(
                `PriceList ${input.priceListId} is already shared to channel ${input.channelId}`,
            );
        }
        withChannels.channels.push(targetChannel);
        await this.connection.getRepository(ctx, PriceList).save(withChannels);

        await this.connection
            .getRepository(ctx, PriceListGroupMembership)
            .save(
                new PriceListGroupMembership({
                    priceListId: list.id,
                    channelId: input.channelId,
                    groupId,
                }),
            );

        return this.findOne(ctx, list.id) as Promise<PriceList>;
    }

    /**
     * Un-share a list from a channel. Allowed from the origin channel
     * (which can remove any target) or from the target channel itself
     * (an admin removing the list from their own channel) — D7. The origin
     * channel cannot be removed (delete the list instead).
     */
    async removeFromChannel(
        ctx: RequestContext,
        priceListId: ID,
        channelId: ID,
    ): Promise<PriceList> {
        const list = await this.connection
            .getRepository(ctx, PriceList)
            .findOne({
                where: { id: priceListId, deletedAt: IsNull() },
                relations: ['channels'],
            });
        if (!list) {
            throw new UserInputError(`PriceList ${priceListId} not found`);
        }
        if (idsAreEqual(channelId, list.originChannelId)) {
            throw new UserInputError(
                `Cannot remove a PriceList from its origin channel; delete the list instead`,
            );
        }
        const isOrigin = idsAreEqual(ctx.channelId, list.originChannelId);
        const isSelfRemoval = idsAreEqual(ctx.channelId, channelId);
        if (!isOrigin && !isSelfRemoval) {
            throw new IllegalOperationError(ERR_PRICELIST_READONLY_NON_ORIGIN_CHANNEL);
        }

        list.channels = list.channels.filter(c => !idsAreEqual(c.id, channelId));
        await this.connection.getRepository(ctx, PriceList).save(list);

        // Drop the per-channel group binding and access scope for that channel.
        await this.connection
            .getRepository(ctx, PriceListGroupMembership)
            .delete({ priceListId, channelId });
        await this.connection
            .getRepository(ctx, PriceListChannelAccess)
            .delete({ priceListId, channelId });

        // `findOne(ctx, …)` is channel-scoped, so on a self-removal
        // (ctx.channel === the channel just dropped) it would return null on
        // a non-nullable field. Re-fetch without the channel filter for the
        // return value — the actor performed an authorized action and just
        // needs the updated entity back.
        const result = await this.connection
            .getRepository(ctx, PriceList)
            .findOne({
                where: { id: priceListId },
                relations: PriceListService.DETAIL_RELATIONS,
            });
        return result ? this.translatePriceList(result, ctx) : list;
    }

    /**
     * Reassign which group a pricelist belongs to **on a given channel** —
     * a channel-local action (NOT origin-guarded): allowed for whoever
     * holds `AssignPriceListGroup` on `channelId`, even if the list's
     * content is owned by another origin. Repoints the membership for that
     * channel at `groupId` (which must be assigned to `channelId`).
     */
    async changeGroup(
        ctx: RequestContext,
        priceListId: ID,
        channelId: ID,
        groupId: ID,
    ): Promise<PriceList> {
        await this.assertChannelLocalAction(ctx, priceListId, channelId);

        const targetGroupId = await this.resolveGroupForChannel(ctx, channelId, groupId);

        const current = await this.connection
            .getRepository(ctx, PriceListGroupMembership)
            .findOne({ where: { priceListId, channelId } });
        if (!current) {
            throw new UserInputError(
                `PriceList ${priceListId} has no group binding on channel ${channelId}`,
            );
        }
        if (idsAreEqual(current.groupId, targetGroupId)) {
            return this.findOne(ctx, priceListId) as Promise<PriceList>;
        }
        // Targeted column update — NOT entity .save() (which would re-derive
        // groupId from a loaded relation and discard the change).
        await this.connection
            .getRepository(ctx, PriceListGroupMembership)
            .update({ id: current.id }, { groupId: targetGroupId });

        return this.findOne(ctx, priceListId) as Promise<PriceList>;
    }

    /**
     * Every pricelist bound to a group (via the membership pivot),
     * paginated. Backs the "pricelists in this group" block.
     */
    findByGroup(
        ctx: RequestContext,
        groupId: ID,
        options?: { skip?: number; take?: number },
    ): Promise<PaginatedList<PriceList>> {
        const qb = this.listQueryBuilder.build(PriceList, options, {
            relations: ['originChannel', 'translations'],
            where: { deletedAt: IsNull() },
            ctx,
            // ChannelAware scoping: never surface lists from other channels
            // even if the group is shared across channels.
            channelId: ctx.channelId,
        });
        qb.innerJoin(
            'price_list_group_membership',
            'plgm',
            'plgm."priceListId" = pricelist.id AND plgm."groupId" = :gid ' +
                'AND plgm."channelId" = :cid',
            { gid: groupId, cid: ctx.channelId },
        );
        return qb.getManyAndCount().then(([items, totalItems]) => ({
            items: items.map(pl => this.translatePriceList(pl, ctx)),
            totalItems,
        }));
    }

    // === Guards / helpers ===

    private async resolveCreateGroupId(
        ctx: RequestContext,
        explicitGroupId?: ID,
    ): Promise<ID> {
        return this.resolveGroupForChannel(ctx, ctx.channelId, explicitGroupId);
    }

    /**
     * Resolve a group id for a channel: validate an explicit group is
     * assigned to the channel, or fall back to the channel's default.
     */
    private async resolveGroupForChannel(
        ctx: RequestContext,
        channelId: ID,
        explicitGroupId?: ID,
    ): Promise<ID> {
        if (explicitGroupId) {
            const group = await this.connection
                .getRepository(ctx, PriceListGroup)
                .findOne({
                    where: { id: explicitGroupId, channels: { id: channelId } },
                });
            if (!group) {
                throw new UserInputError(ERR_PRICELIST_GROUP_CHANNEL_MISMATCH);
            }
            return group.id;
        }
        const def = await this.groupService.findDefaultForChannel(ctx, channelId);
        return def.id;
    }

    private async requireChannel(ctx: RequestContext, id: ID): Promise<Channel> {
        const channel = await this.connection
            .getRepository(ctx, Channel)
            .findOne({ where: { id } });
        if (!channel) {
            throw new UserInputError(`Channel ${id} not found`);
        }
        return channel;
    }

    /**
     * Content-edit guard: the active channel MUST be the list's origin.
     * Gates code/items/prices/validity/delete mutations.
     */
    private async assertContentEditable(
        ctx: RequestContext,
        id: ID,
    ): Promise<PriceList> {
        const list = await this.connection
            .getRepository(ctx, PriceList)
            .findOne({
                // Channel-scoped: a list not shared to the active channel is
                // reported "not found" rather than leaking its existence via
                // the origin-only error (ID enumeration).
                where: { id, deletedAt: IsNull(), channels: { id: ctx.channelId } },
            });
        if (!list) {
            throw new UserInputError(`PriceList ${id} not found`);
        }
        if (!idsAreEqual(ctx.channelId, list.originChannelId)) {
            throw new IllegalOperationError(ERR_PRICELIST_READONLY_NON_ORIGIN_CHANNEL);
        }
        return list;
    }

    /** Exposed for the item service / resolvers gating content mutations. */
    async assertEditableListPublic(ctx: RequestContext, id: ID): Promise<PriceList> {
        return this.assertContentEditable(ctx, id);
    }

    /**
     * Channel-local guard: the action targets the active channel and the
     * list is shared to it. NOT origin-guarded. Gates group binding (and,
     * via PriceListAccessService, access management).
     */
    private async assertChannelLocalAction(
        ctx: RequestContext,
        priceListId: ID,
        channelId: ID,
    ): Promise<PriceList> {
        if (!idsAreEqual(ctx.channelId, channelId)) {
            throw new IllegalOperationError(
                'Action can only target the active channel',
            );
        }
        const list = await this.connection
            .getRepository(ctx, PriceList)
            .findOne({
                where: { id: priceListId, deletedAt: IsNull() },
                relations: ['channels'],
            });
        if (!list) {
            throw new UserInputError(`PriceList ${priceListId} not found`);
        }
        if (!list.channels.some(c => idsAreEqual(c.id, channelId))) {
            throw new IllegalOperationError(ERR_PRICELIST_NOT_SHARED_TO_CHANNEL);
        }
        return list;
    }
}
