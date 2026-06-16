import { CurrencyCode } from '@vendure/common/lib/generated-types';

import { PriceListRoundingStrategy } from '../price-list-rounding-strategy';

/**
 * Bankers' rounding (a.k.a. half-to-even):
 *   - non-halves round to nearest
 *   - exact halves round to the nearest **even** integer
 *
 * 4250.5 → 4250 (4250 is even). 4251.5 → 4252 (4252 is even).
 *
 * Reduces statistical bias over many rounding operations vs.
 * half-up — preferred by financial services merchants whose
 * compliance frameworks (e.g. IEEE 754 default in some locales)
 * call for this convention.
 */
export class BankersRoundingStrategy implements PriceListRoundingStrategy {
    round(value: number, _currencyCode: CurrencyCode): number {
        const floor = Math.floor(value);
        const diff = value - floor;
        if (diff < 0.5) return floor;
        if (diff > 0.5) return floor + 1;
        // Exactly .5 — round to nearest even.
        return floor % 2 === 0 ? floor : floor + 1;
    }
}
