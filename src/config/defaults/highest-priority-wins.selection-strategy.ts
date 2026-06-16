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
 * Default selection. Iterates the group's candidate lists in
 * `priority DESC` order (the resolution strategy is contracted to
 * sort them this way) and returns the first list whose
 * `stepQuantity` ladder has a tier matching the requested
 * `quantity`. Stops at the first hit — no comparison across
 * candidates.
 *
 * "Right" semantics for merchandisers whose mental model is
 * "the more specific list wins" (e.g. a customer-specific list
 * with priority 10 always wins over a less-specific list with
 * priority 5, even if the latter is cheaper).
 */
export class HighestPriorityWinsSelectionStrategy
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
        for (const list of group.candidates) {
            const item = await pickTierItem(
                this.connection,
                ctx,
                list.id,
                variant.id,
                currencyCode,
                quantity,
            );
            if (item) {
                return item;
            }
        }
        return null;
    }
}
