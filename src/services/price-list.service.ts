import { Injectable } from '@nestjs/common';
import {
    DeletionResponse,
    DeletionResult,
    LanguageCode,
} from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import {
    Channel,
    Customer,
    CustomerGroup,
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
    ERR_PRICELIST_READONLY_NON_ORIGIN_CHANNEL,
} from '../constants';
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
     * to `'UTC'` when omitted. The DB column itself is NOT NULL DEFAULT
     * 'UTC' so this fallback is purely an input-shape convenience.
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
 * `valueType` is intentionally NOT updatable here. The interpretation of
 * every item under this list depends on it; flipping the type mid-life would
 * silently change pricing semantics. To switch type the merchandiser must
 * create a new list. `timezone`, by contrast, may be updated — it changes
 * how the window is evaluated but not the stored item values.
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
    groupId: ID;
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

    findAll(
        ctx: RequestContext,
        options?: ListQueryOptions<PriceList>,
        opts: { includeDeleted?: boolean } = {},
    ): Promise<PaginatedList<PriceList>> {
        // `includeDeleted` lets the dashboard "Show pending deletion"
        // toggle surface lists whose `deletedAt` is set. Without it,
        // the default UX matches the historical Stage 1B behavior:
        // soft-deleted lists are invisible.
        return this.listQueryBuilder
            .build(PriceList, options, {
                relations: [
                    'originChannel',
                    'translations',
                    'channels',
                    'groupMemberships',
                    'groupMemberships.group',
                    'groupMemberships.group.translations',
                    'groupMemberships.group.channel',
                ],
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

    async findOne(ctx: RequestContext, id: ID): Promise<PriceList | undefined> {
        // We DON'T use `connection.findOneInChannel(...)` here even though it
        // looks like the right tool: that helper sets up a query builder with
        // alias 'entity' AND calls `setFindOptions({ relationLoadStrategy:
        // 'query', relations: [...] })` — the per-relation sub-queries it
        // emits reference the entity's lowercased class name ('pricelist')
        // as an alias, producing
        //   "missing FROM-clause entry for table 'pricelist'"
        // at runtime. Reproducible against TypeORM's relationLoadStrategy
        // when the QB alias differs from the metadata-derived alias.
        //
        // Standard repo.findOne() uses the metadata-derived alias
        // consistently. We add the channel filter via `where: { channels: {
        // id: ctx.channelId } }` instead — TypeORM expands that to the
        // appropriate join automatically.
        const list = await this.connection
            .getRepository(ctx, PriceList)
            .findOne({
                where: {
                    id,
                    deletedAt: IsNull(),
                    channels: { id: ctx.channelId },
                },
                relations: [
                    'originChannel',
                    'translations',
                    'channels',
                    'groupMemberships',
                    'groupMemberships.group',
                    'groupMemberships.group.translations',
                    'groupMemberships.group.channel',
                ],
                // assignedCustomers / assignedCustomerGroups intentionally NOT
                // loaded here — fetched via paginated queries
                // (`priceListAssignedCustomers`, `priceListAssignedCustomerGroups`).
                // A merchandiser pricelist can carry several-thousand-entry
                // direct customer assignments and inlining was a payload + UI
                // killer.
            });
        return list ? this.translatePriceList(list, ctx) : undefined;
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

        // Translatable saver handles the entity + translation rows in one tx.
        // Pass `beforeSave` to set the non-translated fields on the entity
        // instance before the save commits — cleaner than mixing them into
        // the typed `input` (which is `TranslatedInput<T>` and only carries
        // the `translations` array).
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

        // Bind the list to its default group on the origin channel via the
        // group-membership pivot (the per-channel group binding).
        const membership = new PriceListGroupMembership({
            priceListId: list.id,
            groupId,
        });
        await this.connection
            .getRepository(ctx, PriceListGroupMembership)
            .save(membership);

        return this.findOne(ctx, list.id) as Promise<PriceList>;
    }

    async update(ctx: RequestContext, input: UpdatePriceListInput): Promise<PriceList> {
        const list = await this.assertEditableList(ctx, input.id);

        // Non-translated fields: assign directly on the entity. (Don't touch
        // name/description here — those are `LocaleString` and live on
        // `PriceListTranslation` rows, handled by `translatableSaver` below.)
        if (input.code !== undefined) list.code = input.code;
        if (input.timezone !== undefined) list.timezone = input.timezone;
        if (input.priority !== undefined) list.priority = input.priority;
        if (input.enabled !== undefined) list.enabled = input.enabled;
        if (input.startDate !== undefined) list.startDate = input.startDate;
        if (input.endDate !== undefined) list.endDate = input.endDate;
        await this.connection.getRepository(ctx, PriceList).save(list);

        // Translated fields: route through the saver, which diffs the
        // `translations` array and applies inserts/updates as needed.
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
     * O(1) soft delete: a single UPDATE on the parent. Items are *not*
     * touched — they're filtered out of every item query by the join on
     * `priceList.deletedAt IS NULL`. Avoids the cascading per-row UPDATE
     * that would otherwise scale linearly with item count.
     *
     * Since Stage 1E, soft-deleted lists are also subject to the
     * `purgePendingDeletionTask` cron, which hard-deletes them after the
     * configured grace period. The merchandiser can call `restore` any
     * time before the cron picks them up.
     */
    async softDelete(ctx: RequestContext, id: ID): Promise<DeletionResponse> {
        const list = await this.assertEditableList(ctx, id);
        await this.connection
            .getRepository(ctx, PriceList)
            .update({ id: list.id }, { deletedAt: new Date() });
        return { result: DeletionResult.DELETED };
    }

    /**
     * Clear `deletedAt` on a pricelist that's still in its grace period
     * (i.e. soft-deleted but not yet purged). Throws if the list is not
     * actually pending deletion, or if the active channel isn't the
     * origin — restoring from a non-origin channel would be inconsistent
     * with the rest of the edit guards.
     *
     * Returns the now-active list, fully translated and relation-loaded
     * (same shape as `findOne`), so the dashboard can refresh its row
     * without a follow-up fetch.
     */
    async restore(ctx: RequestContext, id: ID): Promise<PriceList> {
        const list = await this.connection
            .getRepository(ctx, PriceList)
            .findOne({ where: { id } });
        if (!list) {
            throw new UserInputError(`PriceList ${id} not found`);
        }
        if (!idsAreEqual(ctx.channelId, list.originChannelId)) {
            throw new IllegalOperationError(ERR_PRICELIST_READONLY_NON_ORIGIN_CHANNEL);
        }
        if (list.deletedAt === null) {
            // Idempotent: nothing to do, return the list as-is rather
            // than error out — re-running Restore should be safe.
            return this.findOne(ctx, id) as Promise<PriceList>;
        }
        await this.connection
            .getRepository(ctx, PriceList)
            .update({ id: list.id }, { deletedAt: null });
        return this.findOne(ctx, id) as Promise<PriceList>;
    }

    /**
     * Hard-delete pricelists whose grace period has expired. Called by
     * the `purgePendingDeletionTask` scheduled task.
     *
     * Idempotent + interruption-safe: the WHERE clause naturally excludes
     * rows already deleted, so re-running picks up where a killed run
     * left off. Each batch is its own transaction — an SIGTERM mid-batch
     * rolls back that batch only, and the cascade FKs guarantee child
     * tables (`price_list_item`, translations, group memberships,
     * channel pivots, customer/group pivots) follow on row deletion.
     *
     * Returns the count of pricelists actually purged, for telemetry.
     */
    async purgePending(
        ctx: RequestContext,
        opts: { olderThan: Date; batchSize: number },
    ): Promise<number> {
        const repo = this.connection.getRepository(ctx, PriceList);
        let totalPurged = 0;
        // Outer loop drains the cohort. Each iteration pulls one batch
        // worth of expired IDs and deletes them in a transaction. If a
        // batch fails or the process is killed, the transaction rolls
        // back; the next tick re-selects the same IDs (they're still
        // in DB) and tries again.
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
            await this.connection.rawConnection.transaction(async manager => {
                await manager
                    .getRepository(PriceList)
                    .createQueryBuilder()
                    .delete()
                    .where('id IN (:...ids)', {
                        ids: candidateIds.map(r => r.id),
                    })
                    .execute();
            });
            totalPurged += candidateIds.length;
            // Defensive: if a batch came back smaller than batchSize it
            // means we've drained the cohort — short-circuit instead of
            // spinning on an empty subsequent query.
            if (candidateIds.length < opts.batchSize) {
                break;
            }
        }
        return totalPurged;
    }

    // === Channel sharing — splits the binding into two writes ===

    async assignToChannel(
        ctx: RequestContext,
        input: AssignPriceListToChannelInput,
    ): Promise<PriceList> {
        const list = await this.assertEditableList(ctx, input.priceListId);

        const targetGroup = await this.connection
            .getRepository(ctx, PriceListGroup)
            .findOne({ where: { id: input.groupId } });
        if (!targetGroup || !idsAreEqual(targetGroup.channelId, input.channelId)) {
            throw new UserInputError(ERR_PRICELIST_GROUP_CHANNEL_MISMATCH);
        }

        // Add standard ChannelAware membership (drives findOneInChannel).
        const targetChannel = await this.requireChannel(ctx, input.channelId);
        const withChannels = await this.connection
            .getRepository(ctx, PriceList)
            .findOne({ where: { id: list.id }, relations: ['channels'] });
        if (!withChannels) {
            throw new UserInputError(`PriceList ${list.id} not found`);
        }
        const channelExists = withChannels.channels.some(c =>
            idsAreEqual(c.id, input.channelId),
        );
        if (channelExists) {
            throw new UserInputError(
                `PriceList ${input.priceListId} is already shared to channel ${input.channelId}`,
            );
        }
        withChannels.channels.push(targetChannel);
        await this.connection.getRepository(ctx, PriceList).save(withChannels);

        // Add per-channel group binding via membership pivot. The group's own
        // channelId encodes "which channel this binding applies to".
        const membership = new PriceListGroupMembership({
            priceListId: list.id,
            groupId: input.groupId,
        });
        await this.connection
            .getRepository(ctx, PriceListGroupMembership)
            .save(membership);

        return this.findOne(ctx, list.id) as Promise<PriceList>;
    }

    async removeFromChannel(
        ctx: RequestContext,
        priceListId: ID,
        channelId: ID,
    ): Promise<PriceList> {
        const list = await this.assertEditableList(ctx, priceListId);
        if (idsAreEqual(channelId, list.originChannelId)) {
            throw new UserInputError(
                `Cannot remove a PriceList from its origin channel; delete the list instead`,
            );
        }

        // Drop the standard ChannelAware membership.
        const withChannels = await this.connection
            .getRepository(ctx, PriceList)
            .findOne({ where: { id: list.id }, relations: ['channels'] });
        if (withChannels) {
            withChannels.channels = withChannels.channels.filter(
                c => !idsAreEqual(c.id, channelId),
            );
            await this.connection.getRepository(ctx, PriceList).save(withChannels);
        }

        // Drop the per-channel group binding(s). A list could in theory have
        // multiple memberships pointing at groups on the same channel only
        // if the service-layer guard fails — be defensive and remove all.
        await this.connection
            .getRepository(ctx, PriceListGroupMembership)
            .createQueryBuilder()
            .delete()
            .where(
                'priceListId = :priceListId AND groupId IN ' +
                    '(SELECT id FROM price_list_group WHERE "channelId" = :channelId)',
                { priceListId, channelId },
            )
            .execute();

        return this.findOne(ctx, priceListId) as Promise<PriceList>;
    }

    // === Customer / customer-group assignment management ===

    async setAssignedToEveryone(
        ctx: RequestContext,
        priceListId: ID,
        assigned: boolean,
    ): Promise<PriceList> {
        await this.assertEditableList(ctx, priceListId);
        await this.connection
            .getRepository(ctx, PriceList)
            .update({ id: priceListId }, { assignedToEveryone: assigned });
        return this.findOne(ctx, priceListId) as Promise<PriceList>;
    }

    /**
     * Paginated lookup of customers directly assigned to a price list.
     *
     * Replaces the SDL `priceList.assignedCustomers` inline array, which was
     * unworkable for lists with thousands of assignments — every detail-page
     * load would inline the full list, blowing up payload size and the
     * dashboard render. Routes through ListQueryBuilder for the standard
     * skip/take/sort machinery; `filter` is applied separately as an ILIKE
     * substring match against email/first/last name (the merchandiser-facing
     * fields).
     *
     * The M2M join from Customer → PriceList is one-directional (only
     * declared on PriceList), so we join the pivot table directly. The
     * pivot identifier (`price_list_assigned_customers_customer` with
     * camelCase FK columns) is TypeORM's default — confirmed against the
     * Stage-1B migration.
     */
    findAssignedCustomers(
        ctx: RequestContext,
        priceListId: ID,
        options?: { skip?: number; take?: number; filter?: string },
    ): Promise<PaginatedList<Customer>> {
        const { filter, ...listOpts } = options ?? {};
        const qb = this.listQueryBuilder.build(Customer, listOpts, { ctx });
        qb.innerJoin(
            'price_list_assigned_customers_customer',
            'plac',
            'plac."customerId" = customer.id AND plac."priceListId" = :pid',
            { pid: priceListId },
        );
        if (filter && filter.trim().length > 0) {
            qb.andWhere(
                '(' +
                    'LOWER(customer."emailAddress") LIKE :flt OR ' +
                    'LOWER(customer."firstName") LIKE :flt OR ' +
                    'LOWER(customer."lastName") LIKE :flt' +
                    ')',
                { flt: `%${filter.trim().toLowerCase()}%` },
            );
        }
        return qb
            .getManyAndCount()
            .then(([items, totalItems]) => ({ items, totalItems }));
    }

    /** Paginated lookup of customer groups assigned to a price list. See `findAssignedCustomers`. */
    findAssignedCustomerGroups(
        ctx: RequestContext,
        priceListId: ID,
        options?: { skip?: number; take?: number; filter?: string },
    ): Promise<PaginatedList<CustomerGroup>> {
        const { filter, ...listOpts } = options ?? {};
        const qb = this.listQueryBuilder.build(CustomerGroup, listOpts, { ctx });
        qb.innerJoin(
            'price_list_assigned_customer_groups_customer_group',
            'placg',
            'placg."customerGroupId" = customer_group.id AND placg."priceListId" = :pid',
            { pid: priceListId },
        );
        if (filter && filter.trim().length > 0) {
            qb.andWhere('LOWER(customer_group."name") LIKE :flt', {
                flt: `%${filter.trim().toLowerCase()}%`,
            });
        }
        return qb
            .getManyAndCount()
            .then(([items, totalItems]) => ({ items, totalItems }));
    }

    async addAssignedCustomers(
        ctx: RequestContext,
        priceListId: ID,
        customerIds: ID[],
    ): Promise<PriceList> {
        await this.assertEditableList(ctx, priceListId);
        const list = await this.requireWithCustomers(ctx, priceListId);
        const customers = await this.connection
            .getRepository(ctx, Customer)
            .findByIds(customerIds);
        const existing = new Set(list.assignedCustomers.map(c => String(c.id)));
        list.assignedCustomers = [
            ...list.assignedCustomers,
            ...customers.filter(c => !existing.has(String(c.id))),
        ];
        await this.connection.getRepository(ctx, PriceList).save(list);
        return this.findOne(ctx, priceListId) as Promise<PriceList>;
    }

    async removeAssignedCustomers(
        ctx: RequestContext,
        priceListId: ID,
        customerIds: ID[],
    ): Promise<PriceList> {
        await this.assertEditableList(ctx, priceListId);
        const list = await this.requireWithCustomers(ctx, priceListId);
        const removeSet = new Set(customerIds.map(String));
        list.assignedCustomers = list.assignedCustomers.filter(
            c => !removeSet.has(String(c.id)),
        );
        await this.connection.getRepository(ctx, PriceList).save(list);
        return this.findOne(ctx, priceListId) as Promise<PriceList>;
    }

    async addAssignedCustomerGroups(
        ctx: RequestContext,
        priceListId: ID,
        customerGroupIds: ID[],
    ): Promise<PriceList> {
        await this.assertEditableList(ctx, priceListId);
        const list = await this.requireWithCustomerGroups(ctx, priceListId);
        const cgs = await this.connection
            .getRepository(ctx, CustomerGroup)
            .findByIds(customerGroupIds);
        const existing = new Set(list.assignedCustomerGroups.map(c => String(c.id)));
        list.assignedCustomerGroups = [
            ...list.assignedCustomerGroups,
            ...cgs.filter(c => !existing.has(String(c.id))),
        ];
        await this.connection.getRepository(ctx, PriceList).save(list);
        return this.findOne(ctx, priceListId) as Promise<PriceList>;
    }

    async removeAssignedCustomerGroups(
        ctx: RequestContext,
        priceListId: ID,
        customerGroupIds: ID[],
    ): Promise<PriceList> {
        await this.assertEditableList(ctx, priceListId);
        const list = await this.requireWithCustomerGroups(ctx, priceListId);
        const removeSet = new Set(customerGroupIds.map(String));
        list.assignedCustomerGroups = list.assignedCustomerGroups.filter(
            c => !removeSet.has(String(c.id)),
        );
        await this.connection.getRepository(ctx, PriceList).save(list);
        return this.findOne(ctx, priceListId) as Promise<PriceList>;
    }

    // === Guards / helpers ===

    private async resolveCreateGroupId(
        ctx: RequestContext,
        explicitGroupId?: ID,
    ): Promise<ID> {
        if (explicitGroupId) {
            const group = await this.connection
                .getRepository(ctx, PriceListGroup)
                .findOne({ where: { id: explicitGroupId } });
            if (!group || !idsAreEqual(group.channelId, ctx.channelId)) {
                throw new UserInputError(ERR_PRICELIST_GROUP_CHANNEL_MISMATCH);
            }
            return group.id;
        }
        const def = await this.groupService.findDefaultForChannel(ctx, ctx.channelId);
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

    private async assertEditableList(ctx: RequestContext, id: ID): Promise<PriceList> {
        const list = await this.connection
            .getRepository(ctx, PriceList)
            .findOne({ where: { id, deletedAt: IsNull() } });
        if (!list) {
            throw new UserInputError(`PriceList ${id} not found`);
        }
        if (!idsAreEqual(ctx.channelId, list.originChannelId)) {
            throw new IllegalOperationError(ERR_PRICELIST_READONLY_NON_ORIGIN_CHANNEL);
        }
        return list;
    }

    async assertEditableListPublic(ctx: RequestContext, id: ID): Promise<PriceList> {
        return this.assertEditableList(ctx, id);
    }

    private async requireWithCustomers(
        ctx: RequestContext,
        priceListId: ID,
    ): Promise<PriceList> {
        const list = await this.connection
            .getRepository(ctx, PriceList)
            .findOne({
                where: { id: priceListId, deletedAt: IsNull() },
                relations: ['assignedCustomers'],
            });
        if (!list) {
            throw new UserInputError(`PriceList ${priceListId} not found`);
        }
        return list;
    }

    private async requireWithCustomerGroups(
        ctx: RequestContext,
        priceListId: ID,
    ): Promise<PriceList> {
        const list = await this.connection
            .getRepository(ctx, PriceList)
            .findOne({
                where: { id: priceListId, deletedAt: IsNull() },
                relations: ['assignedCustomerGroups'],
            });
        if (!list) {
            throw new UserInputError(`PriceList ${priceListId} not found`);
        }
        return list;
    }
}
