import { Injector, Order, ProductVariant, RequestContext } from '@vendure/core';
import { PriceCalculationResult } from '@vendure/core/dist/common/types/common-types';
import { OrderItemPriceCalculationStrategy } from '@vendure/core/dist/config/order/order-item-price-calculation-strategy';

import { PriceListLookupService } from '../services/price-list-lookup.service';

/**
 * Stage 3 — order-line price resolution **with quantity**, so
 * `stepQuantity` tiers actually apply when a customer orders N units.
 *
 * The catalog hook (`PricelistVariantPriceCalculationStrategy`) resolves
 * at quantity 1 — the per-unit PDP price. Vendure's default order-item
 * strategy then just snapshots that qty-1 `listPrice`, so volume tiers
 * (`stepQuantity ≥ 2`) would never apply. This strategy re-resolves with
 * the order line's actual `quantity` so the correct tier wins.
 *
 * Implements the interface directly (rather than extending
 * `DefaultOrderItemPriceCalculationStrategy`, whose typed signature is
 * narrower than the interface). The no-pricelist fallback inlines the
 * default behaviour: pass the variant's already-calculated `listPrice`
 * through unchanged.
 *
 * NOTE: this intentionally hooks `OrderItemPriceCalculationStrategy`,
 * which PLAN-STAGE-3 §Q2 had decided to leave untouched. Reversed because
 * tiers are a defined feature and must take effect on the order line.
 */
export class PricelistOrderItemPriceCalculationStrategy
    implements OrderItemPriceCalculationStrategy
{
    private lookup!: PriceListLookupService;

    init(injector: Injector): void {
        this.lookup = injector.get(PriceListLookupService);
    }

    async calculateUnitPrice(
        ctx: RequestContext,
        productVariant: ProductVariant,
        orderLineCustomFields: { [key: string]: any },
        order: Order,
        quantity: number,
    ): Promise<PriceCalculationResult> {
        const resolved = await this.lookup.resolvePrice(
            ctx,
            productVariant,
            ctx.currencyCode,
            quantity,
        );
        if (resolved) {
            // Same money mode as the variant's listPrice (same channel /
            // currency); tax conversion is handled downstream.
            return {
                price: resolved.value,
                priceIncludesTax: productVariant.listPriceIncludesTax,
            };
        }
        // Fallback = Vendure's DefaultOrderItemPriceCalculationStrategy:
        // pass the variant's list price through unchanged.
        return {
            price: productVariant.listPrice,
            priceIncludesTax: productVariant.listPriceIncludesTax,
        };
    }
}
