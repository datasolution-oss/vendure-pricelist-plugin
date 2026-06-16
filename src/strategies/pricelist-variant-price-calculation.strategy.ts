import { Injector, RequestContextCacheService } from '@vendure/core';
import { DefaultProductVariantPriceCalculationStrategy } from '@vendure/core/dist/config/catalog/default-product-variant-price-calculation-strategy';
import { ProductVariantPriceCalculationArgs } from '@vendure/core/dist/config/catalog/product-variant-price-calculation-strategy';
import { PriceCalculationResult } from '@vendure/core/dist/common/types/common-types';

import { PriceListLookupService } from '../services/price-list-lookup.service';
import { ResolvedPriceProvenanceEntry } from '../types/resolved-price';

import { pricelistOriginalCacheKey } from './pricelist-original-cache';

/**
 * Stage 3 — the single integration seam between the Stage 2 lookup
 * pipeline and Vendure's pricing. Registered at
 * `catalogOptions.productVariantPriceCalculationStrategy`.
 *
 * Extends `DefaultProductVariantPriceCalculationStrategy` so the
 * no-pricelist path is byte-for-byte Vendure's default (incl. the
 * non-trivial cross-zone net-of-tax conversion, which we delegate to
 * `super` rather than re-implement).
 *
 * Flow:
 *   - `resolvePrice` returns `null` → `super.calculate(args)` (default).
 *   - non-null → recompute `super.calculate` with `inputPrice` replaced
 *     by the resolved value, and stash the ORIGINAL price + badge in the
 *     per-request cache for the Shop API strike-through surface (§2.3).
 *
 * Money mode: `inputPrice` and `resolved.value` are both prices for the
 * same `(channel, currency)`, so the channel's `pricesIncludeTax` flag
 * applies identically to both. A PERCENTAGE entry is multiplicative and
 * preserves money mode. Tax conversion happens downstream of this
 * strategy — no special-casing needed (PLAN-STAGE-3 §Q3).
 */
export class PricelistVariantPriceCalculationStrategy extends DefaultProductVariantPriceCalculationStrategy {
    private lookup!: PriceListLookupService;
    private requestCache!: RequestContextCacheService;

    init(injector: Injector): void {
        super.init(injector); // hydrates the inherited TaxRateService
        this.lookup = injector.get(PriceListLookupService);
        this.requestCache = injector.get(RequestContextCacheService);
    }

    async calculate(
        args: ProductVariantPriceCalculationArgs,
    ): Promise<PriceCalculationResult> {
        const resolved = await this.lookup.resolvePrice(
            args.ctx,
            args.productVariant,
            args.ctx.currencyCode,
        );

        if (!resolved) {
            return super.calculate(args);
        }

        // Compute both prices for strike-through support. The double
        // `super` call only fires on the pricelist-applies path; the
        // no-pricelist path keeps the single-call cost of the default.
        const originalResult = await super.calculate(args);
        const adjustedResult = await super.calculate({
            ...args,
            inputPrice: resolved.value,
        });

        this.requestCache.set(
            args.ctx,
            pricelistOriginalCacheKey(args.productVariant.id, args.ctx.currencyCode),
            {
                originalPrice: originalResult.price,
                priceIncludesTax: originalResult.priceIncludesTax,
                badge: this.badgeFromProvenance(resolved.provenance),
            },
        );

        return adjustedResult;
    }

    private badgeFromProvenance(
        provenance: ResolvedPriceProvenanceEntry[],
    ): { code: string; listId: import('@vendure/common/lib/shared-types').ID } | null {
        // The badge is the last-applied (highest-priority) entry — the
        // "last word" in the cascade, the most consumer-facing one. The
        // resolver turns `listId` into the translated PriceList.name label.
        if (provenance.length === 0) return null;
        const last = provenance[provenance.length - 1];
        return { code: last.listCode, listId: last.listId };
    }
}
