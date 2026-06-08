import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { DeepPartial, ID } from '@vendure/common/lib/shared-types';
import { HasCustomFields, ProductVariant, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne, Unique } from 'typeorm';

import { PriceList } from './price-list.entity';

export type PriceListValueType = 'ABSOLUTE' | 'PERCENTAGE';

/**
 * UNIQUE includes `stepQuantity` so the same (list, variant, currency) can
 * carry multiple rows defining a price ladder by quantity tier. The lookup
 * (Stage 2) picks the row with the largest `stepQuantity ≤ requestedQty`.
 *
 * NOT SoftDeletable. Items are hard-deleted on individual removal.
 * Visibility under a soft-deleted parent list is enforced by every
 * item-returning query joining the parent and filtering
 * `priceList.deletedAt IS NULL` — O(1) parent soft-delete with no per-row
 * UPDATE cost on the items.
 */
@Entity()
@Unique(['priceList', 'productVariant', 'currencyCode', 'stepQuantity'])
@Index(['productVariantId', 'currencyCode'])
export class PriceListItem extends VendureEntity implements HasCustomFields {
    constructor(input?: DeepPartial<PriceListItem>) {
        super(input);
    }

    @ManyToOne(() => PriceList, list => list.items, { onDelete: 'CASCADE' }) 
    priceList: PriceList;

    @Column()
    priceListId: ID;

    @ManyToOne(() => ProductVariant, { nullable: false })
    productVariant: ProductVariant;

    @Column()
    productVariantId: ID;

    @Column('varchar')
    currencyCode: CurrencyCode;

    /**
     * Interpretation depends on the parent `PriceList.valueType` (moved up
     * during the Stage 1C refactor so a pricelist can't mix conventions
     * across items):
     *
     * - parent ABSOLUTE  → integer minor units (cents).
     * - parent PERCENTAGE → basis points of a *discount* (1000 = -10%).
     *   Worked example: value=1000 on a 5000-cent base →
     *   base * (1 - 1000/10000) = 5000 * 0.9 = 4500. Two stacked -10%
     *   lines compound multiplicatively: 5000 * 0.9 * 0.9 = 4050.
     *
     * Storage convention: basis points (integer) — FP-free arithmetic;
     * differs from Sylius (float [0,1]) and Magento (float [0,100]). The
     * dashboard input component owns the bp ↔ "X.XX %" UI conversion.
     */
    @Column({ type: 'int' })
    value: number;

    /**
     * Quantity-tier break point. The price defined by this row applies for
     * purchase quantities >= stepQuantity. Multiple rows per
     * (list, variant, currency) define a ladder, e.g.:
     *
     *   stepQuantity=1 -> €10 (any order)
     *   stepQuantity=5 -> €8  (5+ units)
     *   stepQuantity=10 -> €7 (10+ units)
     *
     * Defaults to 1 so the simple "one price per variant" case requires no
     * caller-side awareness of the tier mechanism.
     */
    @Column({ type: 'int', default: 1 })
    stepQuantity: number;

    /** See `PriceList.customFields` for rationale. */
    @Column({ type: 'simple-json', default: '{}' })
    customFields: { [key: string]: any } = {};
}
