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

import { PriceListItem } from '../entities';
import { priceListPermission } from '../permissions';
import {
    CreatePriceListItemInput,
    PriceListItemService,
    PriceListVariantSummary,
    SavePriceListVariantPivotInput,
    UpdatePriceListItemInput,
} from '../services';

@Resolver()
export class PriceListItemAdminResolver {
    constructor(private priceListItemService: PriceListItemService) {}

    @Query()
    @Allow(priceListPermission.Read)
    async priceListVariantSummaries(
        @Ctx() ctx: RequestContext,
        @Args()
        args: {
            priceListId: ID;
            options?: { skip?: number; take?: number };
        },
    ): Promise<PaginatedList<PriceListVariantSummary>> {
        return this.priceListItemService.findVariantSummariesForList(
            ctx,
            args.priceListId,
            args.options,
        );
    }

    @Query()
    @Allow(priceListPermission.Read)
    async priceListVariantItems(
        @Ctx() ctx: RequestContext,
        @Args() args: { priceListId: ID; productVariantId: ID },
    ): Promise<PriceListItem[]> {
        return this.priceListItemService.findByVariant(
            ctx,
            args.priceListId,
            args.productVariantId,
        );
    }

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Update)
    async addPriceListItem(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: CreatePriceListItemInput },
    ): Promise<PriceListItem> {
        return this.priceListItemService.add(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Update)
    async updatePriceListItem(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: UpdatePriceListItemInput },
    ): Promise<PriceListItem> {
        return this.priceListItemService.update(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Update)
    async removePriceListItem(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<DeletionResponse> {
        return this.priceListItemService.remove(ctx, args.id);
    }

    /**
     * Bulk save of the full pivot for one (priceList, variant) pair —
     * see PriceListItemService.savePivot. The mutation already runs in
     * a service-layer transaction; the `@Transaction()` decorator is a
     * belt-and-suspenders no-op here that aligns the outer request
     * context with that transaction.
     */
    @Mutation()
    @Transaction()
    @Allow(priceListPermission.Update)
    async savePriceListVariantPivot(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: SavePriceListVariantPivotInput },
    ): Promise<PriceListItem[]> {
        return this.priceListItemService.savePivot(ctx, args.input);
    }
}
