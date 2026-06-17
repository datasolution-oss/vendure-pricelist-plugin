import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { InjectableStrategy, ProductVariant, RequestContext } from '@vendure/core';

import { PriceListItem } from '../entities/price-list-item.entity';
import { ResolvedPriceListGroup } from '../types/resolved-price';

/**
 * Picks **one** `PriceListItem` from a group's candidate lists for
 * the current `(variant, currency, quantity)` tuple, or returns
 * `null` if nothing in the group matches.
 *
 * `PriceList` does not carry an intra-group priority — the group is the
 * unit of ordering in the cascade. The selection strategy is what
 * disambiguates when several candidates in the same group match.
 *
 * Two defaults are shipped:
 *   - `CheapestWinsSelectionStrategy` (default) — compute every
 *     candidate's hypothetical contribution against `runningPrice` and
 *     pick the lowest. "Always give the best deal" semantics.
 *   - `MostRecentWinsSelectionStrategy` — pick the candidate whose
 *     parent list has the most recent `startDate`. Right semantics
 *     for time-bounded campaign overrides.
 */
export interface PriceListSelectionStrategy extends InjectableStrategy {
    /**
     * @param quantity drives the `stepQuantity` tier lookup: for
     * each candidate list, the strategy picks the row with the
     * largest `stepQuantity ≤ quantity`. If no row matches the
     * variant + currency at all (or every tier exceeds `quantity`),
     * that candidate contributes nothing. Pass `quantity = 1` for
     * catalog-browse contexts where no order line exists yet.
     *
     * @param runningPrice the cascade's current tentative price
     * (`standardPrice * accumulated multiplier` from PERCENTAGE groups
     * seen so far; `null` if no standard price is available). Used by
     * `CheapestWins` to compare ABSOLUTE candidates against post-
     * PERCENTAGE candidates on equal footing.
     *
     * `valueType` lives on the parent `PriceList` since Stage 1C —
     * implementations read `item.priceList.valueType` rather than
     * `item.valueType`.
     */
    selectWithinGroup(
        ctx: RequestContext,
        variant: ProductVariant,
        currencyCode: CurrencyCode,
        quantity: number,
        group: ResolvedPriceListGroup,
        runningPrice: number | null,
    ): Promise<PriceListItem | null>;
}
