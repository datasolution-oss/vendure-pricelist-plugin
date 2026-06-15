import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { InjectableStrategy, ProductVariant, RequestContext } from '@vendure/core';

import { PriceListItem } from '../entities/price-list-item.entity';
import { ResolvedPriceListGroup } from '../types/resolved-price';

/**
 * Picks **one** `PriceListItem` from a group's candidate lists for
 * the current `(variant, currency, quantity)` tuple, or returns
 * `null` if nothing in the group matches.
 *
 * Three defaults are shipped:
 *   - `HighestPriorityWinsSelectionStrategy` (default) — iterate
 *     candidates in `priority DESC` order, return the first list
 *     whose stepQuantity ladder has a matching tier.
 *   - `CheapestWinsSelectionStrategy` — compute every candidate's
 *     hypothetical contribution against `runningPrice` and pick the
 *     lowest. Required for merchandisers who want "always the best
 *     deal" semantics.
 *   - `MostRecentWinsSelectionStrategy` — pick the candidate whose
 *     parent list has the most recent `startDate`. Right semantics
 *     for time-bounded campaign overrides.
 *
 * See PLAN-STAGE-2 §1.2.2 for worked examples showing all three
 * picking different winners on the same input.
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
     * @param runningPrice the cascade price as it stands **before**
     * this group fires (`null` on the first group if no base has
     * been resolved yet). Used by `CheapestWins` to compare
     * ABSOLUTE candidates against post-PERCENTAGE candidates on
     * equal footing.
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
