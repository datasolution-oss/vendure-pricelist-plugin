import { RequestContext } from '@vendure/core';

import { PriceList } from '../../entities/price-list.entity';
import { PriceListValidityPredicate } from '../price-list-validity-predicate';

/**
 * `list.startDate ?? -∞ <= nowUtc <= list.endDate ?? +∞` — inclusive
 * on both bounds per meta-plan §0.2.3.
 *
 * **TODO (Stage 1D timezone hold).** `PriceList.timezone` exists on
 * the entity but its dashboard picker was held back. The v1
 * implementation compares against `nowUtc` directly. When the picker
 * comes back, evaluate the window in the list's zone (i.e.
 * `toZonedTime(nowUtc, list.timezone)` against the merchandiser-set
 * bounds) and pin a DST-boundary test.
 */
export class DateValidityPredicate implements PriceListValidityPredicate {
    test(_ctx: RequestContext, list: PriceList, nowUtc: Date): boolean {
        const start = list.startDate ? new Date(list.startDate).getTime() : -Infinity;
        const end = list.endDate ? new Date(list.endDate).getTime() : Infinity;
        const t = nowUtc.getTime();
        return start <= t && t <= end;
    }
}
