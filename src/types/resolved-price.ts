import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';

import { PriceListGroup } from '../entities/price-list-group.entity';
import { PriceList } from '../entities/price-list.entity';
import { PriceListValueType } from '../entities/price-list-item.entity';

/**
 * One group's contribution to the candidate set returned by a
 * `PriceListResolutionStrategy`: the `PriceListGroup` itself plus
 * every `PriceList` in it that passed the validity + access filters.
 *
 * `candidates` is sorted by `PriceList.priority DESC` (highest first)
 * so the `PriceListSelectionStrategy` can iterate without re-sorting.
 * The list of groups returned by `resolve()` is sorted by
 * `group.priority ASC` (lowest first) — that's the cascade order:
 * base prices apply first, promos compound on top.
 */
export interface ResolvedPriceListGroup {
    group: PriceListGroup;
    candidates: PriceList[];
}

/**
 * One provenance entry per group that contributed to the final
 * cascade. Lets the dashboard render an order-line detail like
 * "B2C-EUR + WHOLESALE -20% + BFRIDAY -10% = €68.40" without going
 * back to the DB.
 *
 * `valueType` is denormalised onto this entry (it lives on the
 * parent list since Stage 1C, not on the item) so consumers don't
 * have to follow a relation to render the breadcrumb.
 *
 * `stepQuantity` is the quantity-tier that matched on this list —
 * useful when the merchandiser configures a ladder (e.g. qty ≥ 5)
 * and the dashboard wants to surface "applied at qty 5+".
 */
export interface ResolvedPriceProvenanceEntry {
    listId: ID;
    listCode: string;
    groupId: ID;
    groupCode: string;
    itemId: ID;
    stepQuantity: number;
    valueType: PriceListValueType;
    /**
     * Raw stored value:
     *   - ABSOLUTE list → integer minor units (cents)
     *   - PERCENTAGE list → basis points (1000 = -10%)
     */
    value: number;
}

/**
 * Last-applied (highest-priority) contributing pricelist — the "winning"
 * marker surfaced as a strike-through badge on the storefront. `listId`
 * lets consumers fetch the translated `PriceList.name` label without
 * exposing the raw id on the public API.
 */
export interface PricelistBadge {
    code: string;
    listId: ID;
}

/**
 * `source` distinguishes a cascade-produced price from one returned
 * by `PriceListPriceCalculationStrategy.tryExternalPrice()` — useful
 * for telemetry and for Stage 3 to decide whether to expose
 * provenance to the storefront.
 *
 * `NOT_AVAILABLE` is reserved for v2 (PLAN-STAGE-2 §5.1). Not emitted
 * in v1; consumers should still dispatch on `source`, not on `value`.
 */
export type ResolvedPriceSource = 'CASCADE' | 'EXTERNAL';

/**
 * Top-level return of `PriceListLookupService.resolvePrice` — what
 * Stage 3 hands back to Vendure's pricing pipeline.
 *
 * `value` is the post-rounding integer minor unit; the cascade math
 * may produce a fractional intermediate but rounding happens once at
 * the end (round-once is a documented decision — see PLAN-STAGE-2
 * §2.4 counter-example).
 */
export interface ResolvedPrice {
    value: number;
    currencyCode: CurrencyCode;
    /**
     * Ordered list of contributing entries, lowest-priority group
     * first through to the highest. Empty when `source = 'EXTERNAL'`.
     */
    provenance: ResolvedPriceProvenanceEntry[];
    source: ResolvedPriceSource;
}
