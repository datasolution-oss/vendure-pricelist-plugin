import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { InjectableStrategy } from '@vendure/core';

/**
 * End-of-cascade rounding. Three defaults shipped:
 *   - `HalfUpToMinorUnitRoundingStrategy` (default) — 4250.5 → 4251
 *   - `HalfDownToMinorUnitRoundingStrategy` — 4250.5 → 4250
 *   - `BankersRoundingStrategy` (half-to-even) — 4250.5 → 4250
 *
 * Split from `PriceListSelectionStrategy` because the two answer
 * orthogonal questions:
 *   - Selection: "which entry wins?" — merchandiser preference
 *   - Rounding: "how do we resolve fractional cents?" — finance /
 *     legal preference
 *
 * Bundling them would force consumers wanting e.g. "cheapest-wins +
 * bankers-rounding" to reimplement both. See PLAN-STAGE-2 §1.1.4
 * for the full rationale.
 */
export interface PriceListRoundingStrategy extends InjectableStrategy {
    /**
     * Round a post-cascade monetary value to an integer minor unit
     * (cents). Input may be fractional after multiplicative
     * percentage application; output MUST be a non-negative
     * integer.
     *
     * `currencyCode` is passed for jurisdictions where the minor-
     * unit count differs (e.g. JPY uses 0 minor units). Today all
     * shipped currencies use 2 minor units — this argument is
     * forward-compatibility hook.
     */
    round(value: number, currencyCode: CurrencyCode): number;
}
