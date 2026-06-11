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
import { PriceListChannelAccess } from '../entities/price-list-channel-access.entity';
import {
    assignPriceListGroupPermission,
    managePriceListAccessPermission,
    priceListPermission,
    sharePriceListPermission,
} from '../permissions';
import {
    AssignPriceListToChannelInput,
    CreatePriceListInput,
    PriceListAccessService,
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
    constructor(
        private priceListService: PriceListService,
        private accessService: PriceListAccessService,
    ) {}

    @Query()
    @Allow(priceListPermission.Read)
    async priceList(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<PriceList | undefined> {
        // includeDeleted: the detail page must be able to open a
        // pending-deletion list to view it and Restore.
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
        const { includeDeleted, ...listOptions } = args.options ?? {};
        return this.priceListService.findAll(ctx, listOptions, { includeDeleted });
    }

    @Query()
    @Allow(priceListPermission.Read)
    async priceListChannelAccess(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; channelId: ID },
    ): Promise<PriceListChannelAccess | null> {
        return this.accessService.getAccess(ctx, args.priceListId, args.channelId);
    }

    @Query()
    @Allow(priceListPermission.Read)
    async priceListAssignedCustomers(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; channelId: ID; options?: AssignedListOptions },
    ): Promise<PaginatedList<Customer>> {
        return this.accessService.findAssignedCustomers(
            ctx,
            args.priceListId,
            args.channelId,
            args.options,
        );
    }

    @Query()
    @Allow(priceListPermission.Read)
    async priceListAssignedCustomerGroups(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; channelId: ID; options?: AssignedListOptions },
    ): Promise<PaginatedList<CustomerGroup>> {
        return this.accessService.findAssignedCustomerGroups(
            ctx,
            args.priceListId,
            args.channelId,
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
    @Allow(sharePriceListPermission.Permission)
    async assignPriceListToChannel(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: AssignPriceListToChannelInput },
    ): Promise<PriceList> {
        return this.priceListService.assignToChannel(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(sharePriceListPermission.Permission)
    async removePriceListFromChannel(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; channelId: ID },
    ): Promise<PriceList> {
        return this.priceListService.removeFromChannel(ctx, args.priceListId, args.channelId);
    }

    @Mutation()
    @Transaction()
    @Allow(assignPriceListGroupPermission.Permission)
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

    // === Channel-scoped access management ===

    @Mutation()
    @Transaction()
    @Allow(managePriceListAccessPermission.Permission)
    async setPriceListAssignedToEveryone(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; channelId: ID; assigned: boolean },
    ): Promise<PriceListChannelAccess> {
        return this.accessService.setAssignedToEveryone(
            ctx,
            args.priceListId,
            args.channelId,
            args.assigned,
        );
    }

    @Mutation()
    @Transaction()
    @Allow(managePriceListAccessPermission.Permission)
    async addCustomersToPriceList(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; channelId: ID; customerIds: ID[] },
    ): Promise<PriceListChannelAccess> {
        return this.accessService.addCustomers(
            ctx,
            args.priceListId,
            args.channelId,
            args.customerIds,
        );
    }

    @Mutation()
    @Transaction()
    @Allow(managePriceListAccessPermission.Permission)
    async removeCustomersFromPriceList(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; channelId: ID; customerIds: ID[] },
    ): Promise<PriceListChannelAccess> {
        return this.accessService.removeCustomers(
            ctx,
            args.priceListId,
            args.channelId,
            args.customerIds,
        );
    }

    @Mutation()
    @Transaction()
    @Allow(managePriceListAccessPermission.Permission)
    async addCustomerGroupsToPriceList(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; channelId: ID; customerGroupIds: ID[] },
    ): Promise<PriceListChannelAccess> {
        return this.accessService.addCustomerGroups(
            ctx,
            args.priceListId,
            args.channelId,
            args.customerGroupIds,
        );
    }

    @Mutation()
    @Transaction()
    @Allow(managePriceListAccessPermission.Permission)
    async removeCustomerGroupsFromPriceList(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; channelId: ID; customerGroupIds: ID[] },
    ): Promise<PriceListChannelAccess> {
        return this.accessService.removeCustomerGroups(
            ctx,
            args.priceListId,
            args.channelId,
            args.customerGroupIds,
        );
    }
}
