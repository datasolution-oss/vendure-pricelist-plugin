import { CurrencyCode } from '@vendure/common/lib/generated-types';

import { PriceListRoundingStrategy } from '../price-list-rounding-strategy';

/**
 * Half-down rounding: 4250.5 → 4250, 4250.6 → 4251.
 *
 * Symmetric counterpart of `HalfUpToMinorUnit` — pick this when the
 * merchant's accounting convention rounds half-cents in the
 * customer's favour. Implementation:
 * `floor(value + 0.5 - ε)` — pure arithmetic, no special cases.
 */
export class HalfDownToMinorUnitRoundingStrategy implements PriceListRoundingStrategy {
    round(value: number, _currencyCode: CurrencyCode): number {
        return Math.floor(value + 0.5 - Number.EPSILON);
    }
}
