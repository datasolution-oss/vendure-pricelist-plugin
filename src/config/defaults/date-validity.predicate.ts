import { RequestContext } from '@vendure/core';

import { PriceList } from '../../entities/price-list.entity';
import { PriceListValidityPredicate } from '../price-list-validity-predicate';

/**
 * `list.startDate ?? -∞ <= nowUtc <= list.endDate ?? +∞` — inclusive
 * on both bounds per meta-plan §0.2.3.
 *
 * Timezone handling lives at the edge, not here: `startDate`/`endDate`
 * are stored as absolute UTC instants (the dashboard converts the
 * merchandiser's wall-clock from `list.timezone` to UTC on save), so a
 * direct `nowUtc` comparison is correct and DST-safe by construction.
 * `list.timezone` is not consulted in the lookup.
 */
export class DateValidityPredicate implements PriceListValidityPredicate {
    test(_ctx: RequestContext, list: PriceList, nowUtc: Date): boolean {
        const start = list.startDate ? new Date(list.startDate).getTime() : -Infinity;
        const end = list.endDate ? new Date(list.endDate).getTime() : Infinity;
        const t = nowUtc.getTime();
        return start <= t && t <= end;
    }
}
