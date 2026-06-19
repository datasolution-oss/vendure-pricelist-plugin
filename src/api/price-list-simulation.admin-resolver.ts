import { Args, Query, Resolver } from '@nestjs/graphql';
import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import { Allow, Ctx, RequestContext } from '@vendure/core';

import { priceListPermission } from '../permissions';
import { PriceList } from '../entities';
import {
    PriceListService,
    PriceListSimulationService,
    SimulatedVariantPrice,
} from '../services';

/**
 * Admin-only read queries backing the variant-page pricelist block:
 * - `priceListsForVariant` — paginated lists (on the active channel) that
 *   contain this variant; powers the standard Vendure list table.
 * - `simulateVariantPrice` — "what would this customer/group pay?" run
 *   through the real cascade.
 */
@Resolver()
export class PriceListSimulationAdminResolver {
    constructor(
        private priceListService: PriceListService,
        private simulationService: PriceListSimulationService,
    ) {}

    @Query()
    @Allow(priceListPermission.Read)
    async priceListsForVariant(
        @Ctx() ctx: RequestContext,
        @Args() args: { productVariantId: ID; options?: any },
    ): Promise<{ items: PriceList[]; totalItems: number }> {
        return this.priceListService.findAllForVariant(
            ctx,
            args.productVariantId,
            args.options,
        );
    }

    @Query()
    @Allow(priceListPermission.Read)
    async simulateVariantPrice(
        @Ctx() ctx: RequestContext,
        @Args()
        args: {
            input: {
                productVariantId: ID;
                currencyCode: CurrencyCode;
                quantity: number;
                customerId?: ID;
                customerGroupId?: ID;
                at?: Date;
            };
        },
    ): Promise<SimulatedVariantPrice> {
        const { productVariantId, currencyCode, quantity, customerId, customerGroupId, at } =
            args.input;
        return this.simulationService.simulate(
            ctx,
            productVariantId,
            currencyCode,
            quantity,
            { customerId, customerGroupId },
            at,
        );
    }
}
