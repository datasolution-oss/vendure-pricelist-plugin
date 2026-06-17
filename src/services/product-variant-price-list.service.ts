import { Injectable } from '@nestjs/common';
import {
  ProductVariant,
  ProductVariantService,
  RequestContext,
  RequestContextCacheService,
  roundMoney
} from '@vendure/core';

import { PricelistOriginalCacheEntry, pricelistOriginalCacheKey } from '../strategies/pricelist-original-cache';
import { PricelistBadge } from '../types/resolved-price';

@Injectable()
export class ProductVariantPriceListService {
  constructor(
    private productVariantService: ProductVariantService,
    private requestCache: RequestContextCacheService
  ) {}

  /**
   * Resolves the winning pricelist badge for the strike-through surface.
   * Triggers hydration as a side effect so the strategy populates the
   * cache entry it later reads from.
   */
  async hydrateBadge(ctx: RequestContext, variant: ProductVariant): Promise<PricelistBadge | undefined> {
    const { entry } = await this.loadEntry(ctx, variant);
    return entry?.badge ?? undefined;
  }

  /**
   * Resolves the ORIGINAL (pre-pricelist) net price. Returns 0 when no
   * pricelist applied to this variant in the current request.
   */
  async hydrateOriginalPrice(ctx: RequestContext, variant: ProductVariant): Promise<number | undefined> {
    const { entry, hydratedVariant } = await this.loadEntry(ctx, variant);
    const originalPrice = entry?.originalPrice;
    if (!originalPrice) {
      return;
    }
    return roundMoney(
      hydratedVariant.listPriceIncludesTax ? hydratedVariant.taxRateApplied.netPriceOf(originalPrice) : originalPrice
    );
  }

  /**
   * Resolves the ORIGINAL (pre-pricelist) gross price. Returns 0 when no
   * pricelist applied to this variant in the current request.
   */
  async hydrateOriginalPriceWithTax(ctx: RequestContext, variant: ProductVariant): Promise<number | undefined> {
    const { entry, hydratedVariant } = await this.loadEntry(ctx, variant);
    const originalPrice = entry?.originalPrice;
    if (!originalPrice) {
      return;
    }
    return roundMoney(
      hydratedVariant.listPriceIncludesTax ? originalPrice : hydratedVariant.taxRateApplied.grossPriceOf(originalPrice)
    );
  }

  /**
   * Shared work: triggers Vendure's `hydratePriceFields` (which runs the
   * pricing strategy and, as a side effect, populates the pricelist
   * original-price entry in the request cache) and returns both the
   * hydrated variant and the entry — `undefined` when no pricelist
   * applied. Reuses the same per-request cache key as `ProductVariantService`.
   */
  private async loadEntry(
    ctx: RequestContext,
    variant: ProductVariant
  ): Promise<{ hydratedVariant: ProductVariant; entry: PricelistOriginalCacheEntry | undefined }> {
    const cacheKey = `hydrate-variant-price-fields-${variant.id}`;
    let populatePricesPromise = this.requestCache.get<Promise<ProductVariant>>(ctx, cacheKey);

    if (!populatePricesPromise) {
      await this.productVariantService.hydratePriceFields(ctx, variant, 'price');
    }

    populatePricesPromise = this.requestCache.get<Promise<ProductVariant>>(ctx, cacheKey);

    if (!populatePricesPromise) {
      throw new Error('populatePricesPromise should be the previous call');
    }

    const hydratedVariant = await populatePricesPromise;

    const entry = this.requestCache.get<PricelistOriginalCacheEntry>(
      ctx,
      pricelistOriginalCacheKey(variant.id, ctx.currencyCode)
    );

    return { hydratedVariant, entry };
  }
}
