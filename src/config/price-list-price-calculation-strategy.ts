import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { InjectableStrategy, ProductVariant, RequestContext } from '@vendure/core';

import {
    ResolvedPrice,
    ResolvedPriceListGroup,
} from '../types/resolved-price';

/**
 * Orchestrates the cascade: pre-process the resolved groups, try a
 * caller-defined external short-circuit, then run the default
 * cascade — see `DefaultPriceListPriceCalculationStrategy` for the
 * exact iteration order (highest-priority group first, stop on
 * ABSOLUTE).
 *
 * Exposed as a strategy because the two hooks (`preProcessGroups`,
 * `tryExternalPrice`) are real enterprise requirements:
 *   - `preProcessGroups`: drop the PROMO group for customers on a
 *     B2B contract; inject a synthetic "CONTRACT-OVERRIDE" group
 *     sourced from an external system.
 *   - `tryExternalPrice`: short-circuit to an external pricing
 *     engine (configurator, ERP real-time). The returned
 *     `ResolvedPrice.source = 'EXTERNAL'` so downstream code can
 *     distinguish from the cascade result.
 *
 * The cascade body itself (the loop in `calculate()`) is system
 * semantics and is intended to be reused by every consumer via
 * subclassing the default impl — they override only the hooks.
 */
export abstract class PriceListPriceCalculationStrategy implements InjectableStrategy {
    init?(injector: import('@vendure/core').Injector): void | Promise<void>;
    destroy?(): void | Promise<void>;

    /**
     * Top-level entry. Runs `preProcessGroups` → `tryExternalPrice`
     * → cascade. Returns `null` if no list applies — the caller
     * (`PriceListLookupService`) then returns `null` and Vendure
     * falls back to its standard pricing.
     *
     * @param quantity drives the per-list stepQuantity tier
     * selection inside the cascade — see
     * `PriceListSelectionStrategy.selectWithinGroup`.
     */
    abstract calculate(
        ctx: RequestContext,
        variant: ProductVariant,
        currencyCode: CurrencyCode,
        quantity: number,
        groups: ResolvedPriceListGroup[],
    ): Promise<ResolvedPrice | null>;

    /**
     * Hook 1, default identity. Filter or augment the resolved
     * groups for this customer. Returning `[]` short-circuits the
     * cascade to `null`.
     */
    protected async preProcessGroups(
        ctx: RequestContext,
        variant: ProductVariant,
        groups: ResolvedPriceListGroup[],
    ): Promise<ResolvedPriceListGroup[]> {
        return groups;
    }

    /**
     * Hook 2, default null. Return a fully resolved price to
     * bypass the cascade entirely. Returned price MUST set
     * `source = 'EXTERNAL'`.
     */
    protected async tryExternalPrice(
        ctx: RequestContext,
        variant: ProductVariant,
        currencyCode: CurrencyCode,
        quantity: number,
    ): Promise<ResolvedPrice | null> {
        return null;
    }
}
