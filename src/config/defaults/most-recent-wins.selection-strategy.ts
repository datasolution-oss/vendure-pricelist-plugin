import { CurrencyCode } from '@vendure/common/lib/generated-types';
import {
    Injector,
    ProductVariant,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';

import { PriceListItem } from '../../entities/price-list-item.entity';
import { PriceListSelectionStrategy } from '../price-list-selection-strategy';
import { ResolvedPriceListGroup } from '../../types/resolved-price';

import { pickTierItem } from './pick-tier-item';

/**
 * Picks the candidate list with the most recent `startDate` (null
 * treated as `-∞`, so a list with no start date loses to any
 * dated list).
 *
 * "Right" semantics for time-bounded campaign overrides — the
 * latest-scheduled campaign supersedes earlier ones in the same
 * group regardless of priority. The merchandiser models that by
 * giving every campaign list the same priority and trusting the
 * date tiebreaker.
 */
export class MostRecentWinsSelectionStrategy
    implements PriceListSelectionStrategy
{
    private connection!: TransactionalConnection;

    init(injector: Injector): void {
        this.connection = injector.get(TransactionalConnection);
    }

    async selectWithinGroup(
        ctx: RequestContext,
        variant: ProductVariant,
        currencyCode: CurrencyCode,
        quantity: number,
        group: ResolvedPriceListGroup,
        _runningPrice: number | null,
    ): Promise<PriceListItem | null> {
        const resolved = await Promise.all(
            group.candidates.map(async list => {
                const item = await pickTierItem(
                    this.connection,
                    ctx,
                    list.id,
                    variant.id,
                    currencyCode,
                    quantity,
                );
                return { list, item };
            }),
        );
        const matching = resolved.filter(r => r.item !== null);
        if (matching.length === 0) {
            return null;
        }
        // Winner: the candidate whose parent list has the latest
        // `startDate`. Null treated as -∞.
        let winner = matching[0];
        let winnerTime = winner.list.startDate
            ? new Date(winner.list.startDate).getTime()
            : Number.NEGATIVE_INFINITY;
        for (let i = 1; i < matching.length; i++) {
            const sd = matching[i].list.startDate;
            const t = sd ? new Date(sd).getTime() : Number.NEGATIVE_INFINITY;
            if (t > winnerTime) {
                winner = matching[i];
                winnerTime = t;
            }
        }
        return winner.item as PriceListItem;
    }
}
