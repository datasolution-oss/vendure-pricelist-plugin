import { ID } from '@vendure/common/lib/shared-types';
import { InjectableStrategy, RequestContext } from '@vendure/core';

import { ResolvedPriceListGroup } from '../types/resolved-price';

/**
 * Strategy that decides which `PriceList`s are visible to a given
 * `(channel, customer)` pair, grouped by `PriceListGroup`.
 *
 * Does NOT pick a winner within a group — that's the
 * `PriceListSelectionStrategy`'s job. Does NOT compute a price —
 * that's the `PriceListPriceCalculationStrategy`'s job. The single
 * responsibility here is: build the candidate set.
 *
 * The shipped default (`DefaultPriceListResolutionStrategy`) reads
 * the materialised assignments on `PriceList` (`assignedToEveryone`,
 * `assignedCustomers`, `assignedCustomerGroups`). Custom impls swap
 * this for derived assignments (by naming convention, by customer
 * attribute, by external system call) — see PLAN-STAGE-2 §1.1.1.
 */
export interface PriceListResolutionStrategy extends InjectableStrategy {
    /**
     * Returns the candidate set: every `PriceList` accessible to the
     * current customer in the current channel, that passes validity
     * and is enabled, grouped by `PriceListGroup` and ordered
     * ascending by `group.priority` (lowest first — base prices
     * before promos, ready for the cascade).
     *
     * `customerGroupIds` is pre-resolved by
     * `PriceListLookupService.resolvePrice` — passed in rather than
     * re-fetched here so derived-assignment custom strategies that
     * also need that data don't double-query.
     *
     * Returns `[]` when no list applies (anonymous + no
     * `assignedToEveryone` lists, kill switch on, etc.). The
     * calculation strategy interprets an empty array as "no list
     * matched → fall back to Vendure's standard price".
     *
     * Implementations MUST NOT pick a winner inside any group.
     */
    resolve(
        ctx: RequestContext,
        customerId: ID | undefined,
        customerGroupIds: ID[],
        opts?: ResolveOptions,
    ): Promise<ResolvedPriceListGroup[]>;
}

/**
 * Optional resolution modifiers.
 *
 * `asOf` evaluates date-validity against an arbitrary instant instead of
 * "now" — used by admin tooling (the variant-page price simulator) to
 * preview which lists would be active at a future/past date. When set, the
 * shipped default strategy also **bypasses its candidate-set cache** (read
 * and write): that cache is keyed without a date and its TTL is tied to the
 * real next validity boundary, so an arbitrary `asOf` must neither read a
 * "now" entry nor write a dated one that would poison live pricing.
 */
export interface ResolveOptions {
    asOf?: Date;
}
