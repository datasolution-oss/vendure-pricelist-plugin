import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import { TransactionalConnection } from '@vendure/core';
import { IsNull, LessThanOrEqual } from 'typeorm';

import { PriceListItem } from '../../entities/price-list-item.entity';

/**
 * Shared helper used by every default selection strategy: find the
 * `PriceListItem` whose `stepQuantity` is the largest value `≤
 * quantity` for the given `(list, variant, currency)`. Returns the
 * item with its parent list and product variant eagerly loaded so
 * the caller can read `item.priceList.valueType` and
 * `item.productVariant.id` without a follow-up query.
 *
 * Returns `null` when no row matches — either because the variant
 * isn't priced on this list at all, or because every tier's
 * `stepQuantity` exceeds the requested `quantity` (e.g. ladder
 * starts at qty 5, asked qty 1). Callers interpret `null` as
 * "this list contributes nothing".
 *
 * Stage 1 UNIQUE constraint `(priceList, variant, currency,
 * stepQuantity)` ensures at most one row per tier — `ORDER BY
 * stepQuantity DESC LIMIT 1` is a one-row lookup.
 */
export async function pickTierItem(
    connection: TransactionalConnection,
    ctx: import('@vendure/core').RequestContext,
    priceListId: ID,
    productVariantId: ID,
    currencyCode: CurrencyCode,
    quantity: number,
): Promise<PriceListItem | null> {
    return (
        (await connection.getRepository(ctx, PriceListItem).findOne({
            where: {
                priceListId,
                productVariantId,
                currencyCode,
                stepQuantity: LessThanOrEqual(quantity),
                // Defense in depth: a parent list pending purge shouldn't
                // contribute, even if the resolution predicate chain was
                // bypassed by a custom strategy that loaded raw rows.
                priceList: { deletedAt: IsNull() },
            },
            relations: ['priceList', 'productVariant'],
            order: { stepQuantity: 'DESC' },
        })) ?? null
    );
}
