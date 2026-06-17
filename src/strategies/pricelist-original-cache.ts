import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';

import { PricelistBadge } from '../types/resolved-price';

/**
 * Per-request cache entry written by
 * `PricelistVariantPriceCalculationStrategy` and read by the Shop API
 * strike-through resolver (`PriceListShopResolver`). Holds the ORIGINAL
 * (pre-pricelist) catalog price + the winning pricelist's badge source.
 */
export interface PricelistOriginalCacheEntry {
    /** Pre-pricelist catalog price (same money mode as the variant price). */
    originalPrice: number;
    /** Whether `originalPrice` includes tax (channel money mode). */
    originalPriceIncludesTax: boolean;
    /** Winning (highest-priority) contributing pricelist, or null when none applied. */
    badge: PricelistBadge | null;
}

/** Shared key so the strategy (writer) and the resolver (reader) agree. */
export function pricelistOriginalCacheKey(
    variantId: ID,
    currency: CurrencyCode,
): string {
    return `pricelist:original:${variantId}:${currency}`;
}
