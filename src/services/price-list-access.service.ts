import { Injectable } from '@nestjs/common';
import { ID } from '@vendure/common/lib/shared-types';
import {
    Customer,
    CustomerGroup,
    IllegalOperationError,
    ListQueryBuilder,
    PaginatedList,
    RequestContext,
    TransactionalConnection,
    UserInputError,
    idsAreEqual,
} from '@vendure/core';
import { IsNull } from 'typeorm';

import { ERR_PRICELIST_NOT_SHARED_TO_CHANNEL } from '../constants';
import { PriceListChannelAccess } from '../entities/price-list-channel-access.entity';
import { PriceList } from '../entities/price-list.entity';

/**
 * Manages customer / customer-group access for a PriceList, scoped per
 * `(PriceList, Channel)` via `PriceListChannelAccess`.
 *
 * Every mutation is a **channel-local** action (PLAN-STAGE-1F §5): it
 * applies to the channel the actor is currently in, requires the list to
 * be shared to that channel, and is gated at the resolver by
 * `ManagePriceListAccess`. It is NOT origin-guarded — a single-channel
 * admin can scope access for a list shared from another channel without
 * being able to edit its content.
 */
@Injectable()
export class PriceListAccessService {
    constructor(
        private connection: TransactionalConnection,
        private listQueryBuilder: ListQueryBuilder,
    ) {}

    /**
     * Asserts the action targets the active channel and that the list is
     * shared to it, then returns the `(priceList, channel)` access row,
     * creating it lazily if absent.
     */
    private async getOrCreateAccessRow(
        ctx: RequestContext,
        priceListId: ID,
        channelId: ID,
    ): Promise<PriceListChannelAccess> {
        if (!idsAreEqual(ctx.channelId, channelId)) {
            throw new IllegalOperationError(
                'Access can only be managed from the channel it applies to',
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
        const repo = this.connection.getRepository(ctx, PriceListChannelAccess);
        const existing = await repo.findOne({
            where: { priceListId, channelId },
            relations: ['customers', 'customerGroups'],
        });
        if (existing) {
            return existing;
        }
        return repo.save(
            new PriceListChannelAccess({
                priceListId,
                channelId,
                assignedToEveryone: false,
                customers: [],
                customerGroups: [],
            }),
        );
    }

    /** Read-only fetch of the access row (or undefined) without creating one. */
    getAccess(
        ctx: RequestContext,
        priceListId: ID,
        channelId: ID,
    ): Promise<PriceListChannelAccess | null> {
        return this.connection
            .getRepository(ctx, PriceListChannelAccess)
            .findOne({ where: { priceListId, channelId } });
    }

    async setAssignedToEveryone(
        ctx: RequestContext,
        priceListId: ID,
        channelId: ID,
        assigned: boolean,
    ): Promise<PriceListChannelAccess> {
        const row = await this.getOrCreateAccessRow(ctx, priceListId, channelId);
        await this.connection
            .getRepository(ctx, PriceListChannelAccess)
            .update({ id: row.id }, { assignedToEveryone: assigned });
        return (await this.getAccess(ctx, priceListId, channelId)) as PriceListChannelAccess;
    }

    async addCustomers(
        ctx: RequestContext,
        priceListId: ID,
        channelId: ID,
        customerIds: ID[],
    ): Promise<PriceListChannelAccess> {
        const row = await this.getOrCreateAccessRow(ctx, priceListId, channelId);
        const customers = await this.connection
            .getRepository(ctx, Customer)
            .findByIds(customerIds);
        const existing = new Set(row.customers.map(c => String(c.id)));
        row.customers = [
            ...row.customers,
            ...customers.filter(c => !existing.has(String(c.id))),
        ];
        await this.connection.getRepository(ctx, PriceListChannelAccess).save(row);
        return row;
    }

    async removeCustomers(
        ctx: RequestContext,
        priceListId: ID,
        channelId: ID,
        customerIds: ID[],
    ): Promise<PriceListChannelAccess> {
        const row = await this.getOrCreateAccessRow(ctx, priceListId, channelId);
        const removeSet = new Set(customerIds.map(String));
        row.customers = row.customers.filter(c => !removeSet.has(String(c.id)));
        await this.connection.getRepository(ctx, PriceListChannelAccess).save(row);
        return row;
    }

    async addCustomerGroups(
        ctx: RequestContext,
        priceListId: ID,
        channelId: ID,
        customerGroupIds: ID[],
    ): Promise<PriceListChannelAccess> {
        const row = await this.getOrCreateAccessRow(ctx, priceListId, channelId);
        const cgs = await this.connection
            .getRepository(ctx, CustomerGroup)
            .findByIds(customerGroupIds);
        const existing = new Set(row.customerGroups.map(c => String(c.id)));
        row.customerGroups = [
            ...row.customerGroups,
            ...cgs.filter(c => !existing.has(String(c.id))),
        ];
        await this.connection.getRepository(ctx, PriceListChannelAccess).save(row);
        return row;
    }

    async removeCustomerGroups(
        ctx: RequestContext,
        priceListId: ID,
        channelId: ID,
        customerGroupIds: ID[],
    ): Promise<PriceListChannelAccess> {
        const row = await this.getOrCreateAccessRow(ctx, priceListId, channelId);
        const removeSet = new Set(customerGroupIds.map(String));
        row.customerGroups = row.customerGroups.filter(
            c => !removeSet.has(String(c.id)),
        );
        await this.connection.getRepository(ctx, PriceListChannelAccess).save(row);
        return row;
    }

    /**
     * Paginated lookup of customers assigned to a list **on a channel**.
     * Joins the access row's customers pivot. Returns empty when no access
     * row exists yet for the pair.
     */
    async findAssignedCustomers(
        ctx: RequestContext,
        priceListId: ID,
        channelId: ID,
        options?: { skip?: number; take?: number; filter?: string },
    ): Promise<PaginatedList<Customer>> {
        const access = await this.getAccess(ctx, priceListId, channelId);
        if (!access) {
            return { items: [], totalItems: 0 };
        }
        const { filter, ...listOpts } = options ?? {};
        const qb = this.listQueryBuilder.build(Customer, listOpts, { ctx });
        // Join table + columns pinned on the entity's @JoinTable.
        qb.innerJoin(
            'price_list_channel_access_customer',
            'placc',
            'placc."customerId" = customer.id AND placc."accessId" = :aid',
            { aid: access.id },
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

    async findAssignedCustomerGroups(
        ctx: RequestContext,
        priceListId: ID,
        channelId: ID,
        options?: { skip?: number; take?: number; filter?: string },
    ): Promise<PaginatedList<CustomerGroup>> {
        const access = await this.getAccess(ctx, priceListId, channelId);
        if (!access) {
            return { items: [], totalItems: 0 };
        }
        const { filter, ...listOpts } = options ?? {};
        const qb = this.listQueryBuilder.build(CustomerGroup, listOpts, { ctx });
        // Join table + columns pinned on the entity's @JoinTable.
        qb.innerJoin(
            'price_list_channel_access_customer_group',
            'placcg',
            'placcg."customerGroupId" = customer_group.id AND placcg."accessId" = :aid',
            { aid: access.id },
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
}
