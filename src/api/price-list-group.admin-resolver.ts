import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DeletionResponse } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import {
    Allow,
    Ctx,
    PaginatedList,
    RequestContext,
    Transaction,
} from '@vendure/core';

import { PriceListGroup } from '../entities';
import { priceListGroupPermission } from '../permissions';
import {
    CreatePriceListGroupInput,
    PriceListGroupService,
    UpdatePriceListGroupInput,
} from '../services';

@Resolver()
export class PriceListGroupAdminResolver {
    constructor(private priceListGroupService: PriceListGroupService) {}

    @Query()
    @Allow(priceListGroupPermission.Read)
    async priceListGroup(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<PriceListGroup | undefined> {
        return this.priceListGroupService.findOne(ctx, args.id);
    }

    @Query()
    @Allow(priceListGroupPermission.Read)
    async priceListGroups(
        @Ctx() ctx: RequestContext,
        @Args() args: { options?: { skip?: number; take?: number } },
    ): Promise<PaginatedList<PriceListGroup>> {
        return this.priceListGroupService.findAll(ctx, args.options);
    }

    @Query()
    @Allow(priceListGroupPermission.Read)
    async priceListGroupsByChannel(
        @Ctx() ctx: RequestContext,
        @Args() args: { channelId: ID },
    ): Promise<PriceListGroup[]> {
        return this.priceListGroupService.findByChannel(ctx, args.channelId);
    }

    @Query()
    @Allow(priceListGroupPermission.Read)
    async priceListDefaultGroup(
        @Ctx() ctx: RequestContext,
        @Args() args: { channelId: ID },
    ): Promise<PriceListGroup> {
        return this.priceListGroupService.findDefaultForChannel(ctx, args.channelId);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListGroupPermission.Create)
    async createPriceListGroup(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: CreatePriceListGroupInput },
    ): Promise<PriceListGroup> {
        return this.priceListGroupService.create(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListGroupPermission.Update)
    async updatePriceListGroup(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: UpdatePriceListGroupInput },
    ): Promise<PriceListGroup> {
        return this.priceListGroupService.update(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListGroupPermission.Delete)
    async deletePriceListGroup(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<DeletionResponse> {
        return this.priceListGroupService.delete(ctx, args.id);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListGroupPermission.Update)
    async setDefaultPriceListGroup(
        @Ctx() ctx: RequestContext,
        @Args() args: { channelId: ID; groupId: ID },
    ): Promise<PriceListGroup> {
        return this.priceListGroupService.setDefault(ctx, args.channelId, args.groupId);
    }
}
