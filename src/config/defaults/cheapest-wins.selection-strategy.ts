import { CurrencyCode } from '@vendure/common/lib/generated-types';
import {
    Injector,
    Logger,
    ProductVariant,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';

import { loggerCtx } from '../../constants';
import { PriceListItem } from '../../entities/price-list-item.entity';
import { PriceListSelectionStrategy } from '../price-list-selection-strategy';
import { ResolvedPriceListGroup } from '../../types/resolved-price';

import { pickTierItem } from './pick-tier-item';

/**
 * Selection that picks the candidate list whose hypothetical
 * contribution is the lowest at the moment this group fires.
 *
 * Each candidate is resolved to a `PriceListItem` via the tier
 * helper. The hypothetical contribution depends on the parent
 * list's `valueType`:
 *   - `ABSOLUTE`  → `item.value` directly
 *   - `PERCENTAGE` → `(runningPrice ?? variant.standardPrice) *
 *     (1 - item.value / 10000)`
 *
 * If `runningPrice` is null AND the variant has no standard price
 * in this currency, PERCENTAGE candidates can't be evaluated and
 * are excluded from the comparison — but ABSOLUTE candidates still
 * apply normally.
 *
 * "Right" semantics for merchandisers whose mental model is
 * "always give the customer the best deal we can".
 */
export class CheapestWinsSelectionStrategy implements PriceListSelectionStrategy {
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
        runningPrice: number | null,
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
        const matching = resolved.filter(r => r.item !== null) as Array<{
            list: typeof resolved[number]['list'];
            item: PriceListItem;
        }>;
        if (matching.length === 0) {
            return null;
        }

        const base = runningPrice ?? this.standardPriceFor(variant, currencyCode);
        // No base AND a PERCENTAGE candidate → that candidate can't
        // resolve. Filter such candidates rather than skipping the
        // whole group; an ABSOLUTE sibling may still win.
        const usable = base === null
            ? matching.filter(r => r.list.valueType === 'ABSOLUTE')
            : matching;
        if (usable.length === 0) {
            Logger.debug(
                `CheapestWins: every candidate is PERCENTAGE and no base ` +
                    `price for ${variant.id}/${currencyCode}; group skipped.`,
                loggerCtx,
            );
            return null;
        }

        let best = usable[0];
        let bestCost = this.hypotheticalCost(best, base);
        for (let i = 1; i < usable.length; i++) {
            const cost = this.hypotheticalCost(usable[i], base);
            if (cost < bestCost) {
                best = usable[i];
                bestCost = cost;
            }
        }
        return best.item;
    }

    private hypotheticalCost(
        r: { list: { valueType: 'ABSOLUTE' | 'PERCENTAGE' }; item: PriceListItem },
        base: number | null,
    ): number {
        if (r.list.valueType === 'ABSOLUTE') {
            return r.item.value;
        }
        // PERCENTAGE — caller has filtered to ensure base !== null
        // when this branch is reached.
        return (base as number) * (1 - r.item.value / 10000);
    }

    private standardPriceFor(
        variant: ProductVariant,
        currencyCode: CurrencyCode,
    ): number | null {
        const match = variant.productVariantPrices?.find(
            p => p.currencyCode === currencyCode,
        );
        return match?.price ?? null;
    }
}
