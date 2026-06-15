import { RequestContext } from '@vendure/core';

import { PriceList } from '../../entities/price-list.entity';
import { PriceListValidityPredicate } from '../price-list-validity-predicate';

/**
 * `list.deletedAt == null`. Since Stage 1E `deletedAt != null` no
 * longer means "permanently soft-deleted" — it means "pending purge
 * by the cron task" — but the lookup exclusion is the same: a
 * pending-deletion list shouldn't apply prices to in-flight orders
 * (the merchandiser may restore, but until they do the list isn't
 * effective).
 */
export class SoftDeletedPredicate implements PriceListValidityPredicate {
    test(_ctx: RequestContext, list: PriceList, _nowUtc: Date): boolean {
        return list.deletedAt == null;
    }
}
