import { RequestContext } from '@vendure/core';

import { PriceList } from '../../entities/price-list.entity';
import { PriceListValidityPredicate } from '../price-list-validity-predicate';

/**
 * `list.enabled === true`. Trivial guard but exposed as a predicate
 * so a custom resolution strategy that bypasses the SQL still gets
 * the check applied via the predicate chain.
 */
export class EnabledPredicate implements PriceListValidityPredicate {
    test(_ctx: RequestContext, list: PriceList, _nowUtc: Date): boolean {
        return list.enabled === true;
    }
}
