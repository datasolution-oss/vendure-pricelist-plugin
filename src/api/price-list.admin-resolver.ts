import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DeletionResponse } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import {
    Allow,
    Ctx,
    Customer,
    CustomerGroup,
    PaginatedList,
    RequestContext,
    Transaction,
} from '@vendure/core';

import { PriceList } from '../entities';
import { priceListPermission } from '../permissions';
import {
    AssignPriceListToChannelInput,
    CreatePriceListInput,
    PriceListService,
    UpdatePriceListInput,
} from '../services';

interface AssignedListOptions {
    skip?: number;
    take?: number;
    filter?: string;
}

@Resolver()
export class PriceListAdminResolver {
    constructor(private priceListService: PriceListService) {}

    @Query()
    @Allow(priceListPermission.Read)
    async priceList(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<PriceList | undefined> {
        // includeDeleted: the detail page must be able to open a
        // pending-deletion list (visible in the "show pending" toggle)
        // to view it and Restore — otherwise clicking it 404s.
        return this.priceListService.findOne(ctx, args.id, {
            includeDeleted: true,
        });
    }

    @Query()
    @Allow(priceListPermission.Read)
    async priceLists(
        @Ctx() ctx: RequestContext,
        @Args()
        args: {
            options?: { skip?: number; take?: number; includeDeleted?: boolean };
        },
    ): Promise<PaginatedList<PriceList>> {
        // Strip `includeDeleted` off the listQueryOptions before forwarding —
        // it isn't a column-bound field, so passing it through would
        // confuse the ListQueryBuilder's filter/sort generator. The
        // service consumes it from the second parameter instead.
        const { includeDeleted, ...listOptions } = args.options ?? {};
        return this.priceListService.findAll(ctx, listOptions, { includeDeleted });
    }

    @Query()
    @Allow(priceListPermission.Read)
    async priceListAssignedCustomers(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; options?: AssignedListOptions },
    ): Promise<PaginatedList<Customer>> {
        return this.priceListService.findAssignedCustomers(
            ctx,
            args.priceListId,
            args.options,
        );
    }

    @Query()
    @Allow(priceListPermission.Read)
    async priceListAssignedCustomerGroups(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; options?: AssignedListOptions },
    ): Promise<PaginatedList<CustomerGroup>> {
        return this.priceListService.findAssignedCustomerGroups(
            ctx,
            args.priceListId,
            args.options,
        );
    }

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Create)
    async createPriceList(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: CreatePriceListInput },
    ): Promise<PriceList> {
        return this.priceListService.create(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Update)
    async updatePriceList(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: UpdatePriceListInput },
    ): Promise<PriceList> {
        return this.priceListService.update(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Delete)
    async deletePriceList(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<DeletionResponse> {
        return this.priceListService.softDelete(ctx, args.id);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Update)
    async restorePriceList(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<PriceList> {
        return this.priceListService.restore(ctx, args.id);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Update)
    async assignPriceListToChannel(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: AssignPriceListToChannelInput },
    ): Promise<PriceList> {
        return this.priceListService.assignToChannel(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Update)
    async removePriceListFromChannel(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; channelId: ID },
    ): Promise<PriceList> {
        return this.priceListService.removeFromChannel(ctx, args.priceListId, args.channelId);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Update)
    async changePriceListGroup(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; channelId: ID; groupId: ID },
    ): Promise<PriceList> {
        return this.priceListService.changeGroup(
            ctx,
            args.priceListId,
            args.channelId,
            args.groupId,
        );
    }

    @Query()
    @Allow(priceListPermission.Read)
    async priceListsByGroup(
        @Ctx() ctx: RequestContext,
        @Args() args: { groupId: ID; options?: { skip?: number; take?: number } },
    ): Promise<PaginatedList<PriceList>> {
        return this.priceListService.findByGroup(ctx, args.groupId, args.options);
    }

    // === Assignment management ===

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Update)
    async setPriceListAssignedToEveryone(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; assigned: boolean },
    ): Promise<PriceList> {
        return this.priceListService.setAssignedToEveryone(ctx, args.priceListId, args.assigned);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Update)
    async addCustomersToPriceList(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; customerIds: ID[] },
    ): Promise<PriceList> {
        return this.priceListService.addAssignedCustomers(ctx, args.priceListId, args.customerIds);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Update)
    async removeCustomersFromPriceList(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; customerIds: ID[] },
    ): Promise<PriceList> {
        return this.priceListService.removeAssignedCustomers(ctx, args.priceListId, args.customerIds);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Update)
    async addCustomerGroupsToPriceList(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; customerGroupIds: ID[] },
    ): Promise<PriceList> {
        return this.priceListService.addAssignedCustomerGroups(ctx, args.priceListId, args.customerGroupIds);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Update)
    async removeCustomerGroupsFromPriceList(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; customerGroupIds: ID[] },
    ): Promise<PriceList> {
        return this.priceListService.removeAssignedCustomerGroups(ctx, args.priceListId, args.customerGroupIds);
    }
}
