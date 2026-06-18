import { Args, Query, Resolver } from '@nestjs/graphql';
import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import { Allow, Ctx, RequestContext } from '@vendure/core';

import { priceListPermission } from '../permissions';
import {
    PriceListItemService,
    PriceListSimulationService,
    SimulatedVariantPrice,
    VariantPriceListAssociation,
} from '../services';

/**
 * Admin-only read queries backing the variant-page pricelist block:
 * - `priceListsForVariant` — lists (on the active channel) that contain
 *   this variant, with group + cells.
 * - `simulateVariantPrice` — "what would this customer/group pay?" run
 *   through the real cascade.
 */
@Resolver()
export class PriceListSimulationAdminResolver {
    constructor(
        private itemService: PriceListItemService,
        private simulationService: PriceListSimulationService,
    ) {}

    @Query()
    @Allow(priceListPermission.Read)
    async priceListsForVariant(
        @Ctx() ctx: RequestContext,
        @Args() args: { productVariantId: ID },
    ): Promise<VariantPriceListAssociation[]> {
        return this.itemService.findListsForVariant(ctx, args.productVariantId);
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
            };
        },
    ): Promise<SimulatedVariantPrice> {
        const { productVariantId, currencyCode, quantity, customerId, customerGroupId } =
            args.input;
        return this.simulationService.simulate(
            ctx,
            productVariantId,
            currencyCode,
            quantity,
            { customerId, customerGroupId },
        );
    }
}
