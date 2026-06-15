import { CurrencyCode } from '@vendure/common/lib/generated-types';

import { PriceListRoundingStrategy } from '../price-list-rounding-strategy';

/**
 * Default rounding: half-up to the nearest integer.
 *
 * `Math.round` is half-up for non-negative inputs in JS. Pricelist
 * values are non-negative (the cascade output represents a price),
 * so the asymmetry `Math.round(-2.5) = -2` doesn't matter here.
 *
 * 4250.5 → 4251, 4250.4 → 4250.
 */
export class HalfUpToMinorUnitRoundingStrategy implements PriceListRoundingStrategy {
    round(value: number, _currencyCode: CurrencyCode): number {
        return Math.round(value);
    }
}
