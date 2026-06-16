import { RequestContext } from '@vendure/core';

import { PriceList } from '../entities/price-list.entity';

/**
 * One validity check applied during candidate-set resolution.
 *
 * Modeled as a composable AND-combined list rather than a strategy
 * slot per PLAN-STAGE-2 §1.1.5: the most common extension shape
 * ("add a new filter") is additive, not replacing — a predicate
 * list fits that better than forcing the consumer to reimplement
 * the whole resolution strategy to add e.g. a feature-flag filter.
 *
 * Defaults shipped: `date-validity`, `enabled`, `channel-match`,
 * `soft-deleted`. Plugin consumers add their own via
 * `PluginInitOptions.additionalValidityPredicates`.
 *
 * `nowUtc` is captured once per call to the resolution strategy
 * and reused for every predicate — see PLAN-STAGE-2 §Q4 on the
 * "now" handling decision.
 */
export interface PriceListValidityPredicate {
    /**
     * Returns `true` if the `PriceList` passes this predicate's
     * check at `nowUtc`. Returning `false` excludes the list from
     * the candidate set.
     *
     * Implementations are pure — no DB calls, no async work — so
     * the predicate chain stays cheap to evaluate per candidate.
     */
    test(ctx: RequestContext, list: PriceList, nowUtc: Date): boolean;
}
