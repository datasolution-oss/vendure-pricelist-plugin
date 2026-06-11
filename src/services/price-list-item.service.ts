import { Injectable } from '@nestjs/common';
import {
    CurrencyCode,
    DeletionResponse,
    DeletionResult,
} from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import {
    ListQueryBuilder,
    ListQueryOptions,
    PaginatedList,
    ProductVariant,
    ProductVariantService,
    RequestContext,
    TransactionalConnection,
    Translated,
    UserInputError,
} from '@vendure/core';
import { IsNull } from 'typeorm';

import { PriceListItem } from '../entities';

import { PriceListService } from './price-list.service';

/**
 * Note: `valueType` is no longer an item field. It lives on the parent
 * `PriceList` — all items in a list share one convention. The interpretation
 * of `value` here depends on the parent's `valueType`:
 *   - ABSOLUTE list → `value` is integer minor units (cents)
 *   - PERCENTAGE list → `value` is basis points of a discount (1000 = -10%)
 */
export interface CreatePriceListItemInput {
    priceListId: ID;
    productVariantId: ID;
    currencyCode: CurrencyCode;
    value: number;
    stepQuantity?: number;
}

export interface UpdatePriceListItemInput {
    id: ID;
    value?: number;
    stepQuantity?: number;
}

/**
 * One row of the pivot save payload — a single (currency, stepQuantity)
 * cell with its value. The dashboard sends the full set of cells the
 * merchandiser currently has in view; the service diffs against the
 * stored set (insert / update / delete) so the round-trip is idempotent.
 */
export interface PriceListVariantPivotRowInput {
    currencyCode: CurrencyCode;
    stepQuantity: number;
    value: number;
}

export interface SavePriceListVariantPivotInput {
    priceListId: ID;
    productVariantId: ID;
    rows: PriceListVariantPivotRowInput[];
}

/**
 * Summary row for the per-variant table on the pricelist detail page.
 * Aggregates the underlying `price_list_item` rows by variant so the
 * merchandiser sees "this variant has 3 currencies × 2 tiers" at a
 * glance instead of 6 flat rows. The detail surface for editing a
 * single variant's pivot is on the item-detail page.
 */
export interface PriceListVariantSummaryCell {
    currencyCode: string;
    stepQuantity: number;
    value: number;
}

export interface PriceListVariantSummary {
    /**
     * Mirrors `productVariant.id` — one summary row per variant in the
     * pricelist, so the variant id is a stable per-row identifier. Lives
     * here as a top-level field because the SDL needs `id` to satisfy
     * `PaginatedList.items: [Node!]!`.
     */
    id: ID;
    productVariant: Translated<ProductVariant>;
    /** Distinct currency codes priced for this variant in the list. */
    currencyCount: number;
    /** Distinct stepQuantity tiers defined for this variant. */
    tierCount: number;
    /** Total filled cells (`cellCount = currencies × covered tiers`, generally ≤ currencyCount × tierCount). */
    cellCount: number;
    /**
     * The raw cells (currency × stepQuantity × value) for this variant,
     * inlined so the dashboard can render a hover-detail without an
     * extra round-trip. Ordered by currency then stepQuantity for
     * stable rendering. Kept inline because per-variant cell counts
     * are realistically small (typical merchandiser: a few currencies
     * × a few tiers); page-level take is capped at 25 by default.
     */
    cells: PriceListVariantSummaryCell[];
    latestUpdatedAt: Date;
}

@Injectable()
export class PriceListItemService {
    constructor(
        private connection: TransactionalConnection,
        private listQueryBuilder: ListQueryBuilder,
        private priceListService: PriceListService,
        private productVariantService: ProductVariantService,
    ) {}

    /**
     * Items are never directly soft-deleted — they're hard-deleted on
     * removal, or hidden via their parent list's `deletedAt`. Each read
     * filters on the parent via TypeORM's relation-where syntax
     * (`priceList: { deletedAt: IsNull() }`) — this produces a
     * properly-aliased JOIN.
     */
    findOne(ctx: RequestContext, id: ID): Promise<PriceListItem | undefined> {
        return this.connection
            .getRepository(ctx, PriceListItem)
            .findOne({
                where: {
                    id,
                    priceList: { deletedAt: IsNull() },
                },
                relations: ['priceList', 'productVariant'],
            })
            .then(it => it ?? undefined);
    }

    findByList(
        ctx: RequestContext,
        priceListId: ID,
        options?: ListQueryOptions<PriceListItem>,
    ): Promise<PaginatedList<PriceListItem>> {
        const qb = this.listQueryBuilder.build(PriceListItem, options, {
            where: {
                priceListId,
                priceList: { deletedAt: IsNull() },
            },
            relations: ['productVariant', 'priceList'],
            ctx,
        });
        // Channel scoping via EXISTS rather than a relation `where`:
        // ListQueryBuilder does not auto-join nested relation conditions, and
        // an EXISTS avoids row multiplication on the channels pivot. Restricts
        // items to variants assigned to the active channel.
        qb.andWhere(
            `EXISTS (SELECT 1 FROM "product_variant_channels_channel" "pvcc" ` +
                `WHERE "pvcc"."productVariantId" = "${qb.alias}"."productVariantId" ` +
                `AND "pvcc"."channelId" = :plChannelId)`,
            { plChannelId: ctx.channelId },
        );
        return qb
            .getManyAndCount()
            .then(([items, totalItems]) => ({ items, totalItems }));
    }

    /**
     * All items for a single (priceList, productVariant) pair — the raw
     * cells of the pivot table on the item-detail page. Ordered by
     * currency then stepQuantity for stable rendering.
     */
    findByVariant(
        ctx: RequestContext,
        priceListId: ID,
        productVariantId: ID,
    ): Promise<PriceListItem[]> {
        return this.connection.getRepository(ctx, PriceListItem).find({
            where: {
                priceListId,
                productVariantId,
                priceList: { deletedAt: IsNull() },
                // Channel scoping: the variant must be assigned to the active
                // channel. Prevents reading cells for a variant that exists
                // only on the list's origin channel when viewed from a
                // channel the list is shared to.
                productVariant: { channels: { id: ctx.channelId } },
            },
            relations: ['productVariant', 'priceList'],
            order: { currencyCode: 'ASC', stepQuantity: 'ASC' },
        });
    }

    /**
     * Paginated aggregate by variant — one row per distinct
     * productVariantId with currency/tier counts and the latest write
     * timestamp. Built with a TypeORM query builder rather than raw SQL
     * so it stays portable across the driver options Vendure supports.
     *
     * Sort is fixed (latest-updated first) for now — opens to a list
     * options shape once the dashboard needs sort/filter on top.
     */
    async findVariantSummariesForList(
        ctx: RequestContext,
        priceListId: ID,
        options?: { skip?: number; take?: number },
    ): Promise<PaginatedList<PriceListVariantSummary>> {
        const take = options?.take ?? 25;
        const skip = options?.skip ?? 0;
        const repo = this.connection.getRepository(ctx, PriceListItem);

        // `tierCount` counts DISTINCT stepQuantity values (the tier
        // ladder for this variant), NOT the raw row count — otherwise
        // adding a second currency would inflate the tier number even
        // though the ladder hasn't actually grown. `cellCount` is the
        // total filled cells = currencies × covered tiers (rarely a
        // full cross), kept around because it answers a different but
        // useful merchandiser question ("how many prices are set?").
        const rowsQb = repo
            .createQueryBuilder('item')
            .innerJoin('item.priceList', 'pl')
            // Channel scoping: only surface variants assigned to the active
            // channel. A list shared to channel B must not show variants that
            // exist only on the origin channel. Filtering in SQL (before
            // LIMIT/OFFSET) keeps both totalItems and pagination correct.
            .innerJoin('item.productVariant', 'pv')
            .innerJoin('pv.channels', 'pvch', 'pvch.id = :channelId', {
                channelId: ctx.channelId,
            })
            .where('item.priceListId = :pid', { pid: priceListId })
            .andWhere('pl.deletedAt IS NULL')
            .select('item.productVariantId', 'productVariantId')
            .addSelect('COUNT(DISTINCT item.currencyCode)', 'currencyCount')
            .addSelect('COUNT(DISTINCT item.stepQuantity)', 'tierCount')
            .addSelect('COUNT(*)', 'cellCount')
            .addSelect('MAX(item.updatedAt)', 'latestUpdatedAt')
            .groupBy('item.productVariantId')
            .orderBy('MAX(item.updatedAt)', 'DESC')
            .limit(take)
            .offset(skip);

        const rows: Array<{
            productVariantId: ID;
            currencyCount: string;
            tierCount: string;
            cellCount: string;
            latestUpdatedAt: string;
        }> = await rowsQb.getRawMany();

        const countRow: { count: string } | undefined = await repo
            .createQueryBuilder('item')
            .innerJoin('item.priceList', 'pl')
            // Same channel scoping as the rows query so the count matches the
            // number of variants actually shown in the active channel.
            .innerJoin('item.productVariant', 'pv')
            .innerJoin('pv.channels', 'pvch', 'pvch.id = :channelId', {
                channelId: ctx.channelId,
            })
            .where('item.priceListId = :pid', { pid: priceListId })
            .andWhere('pl.deletedAt IS NULL')
            .select('COUNT(DISTINCT item.productVariantId)', 'count')
            .getRawOne();
        const totalItems = Number(countRow?.count ?? 0);

        const variantIds = rows.map(r => r.productVariantId);
        // Vendure's ProductVariantService returns translated entities;
        // resolves the name in the current ctx.languageCode for us.
        const variants =
            variantIds.length > 0
                ? await this.productVariantService.findByIds(ctx, variantIds)
                : [];
        const variantMap = new Map(
            variants.map(v => [String(v.id), v] as const),
        );

        // One bulk fetch of every cell for the page's variants. Bounded
        // by `take` (default 25) × few cells/variant, so still small.
        // Indexed by variantId for O(1) lookup when assembling the
        // summary objects below.
        const cellsByVariant = new Map<string, PriceListVariantSummaryCell[]>();
        if (variantIds.length > 0) {
            const cellRows = await repo
                .createQueryBuilder('item')
                .innerJoin('item.priceList', 'pl')
                .where('item.priceListId = :pid', { pid: priceListId })
                .andWhere('pl.deletedAt IS NULL')
                .andWhere('item.productVariantId IN (:...vids)', { vids: variantIds })
                .select('item.productVariantId', 'productVariantId')
                .addSelect('item.currencyCode', 'currencyCode')
                .addSelect('item.stepQuantity', 'stepQuantity')
                .addSelect('item.value', 'value')
                .orderBy('item.productVariantId', 'ASC')
                .addOrderBy('item.currencyCode', 'ASC')
                .addOrderBy('item.stepQuantity', 'ASC')
                .getRawMany<{
                    productVariantId: ID;
                    currencyCode: string;
                    stepQuantity: string;
                    value: string;
                }>();
            cellRows.forEach(c => {
                const key = String(c.productVariantId);
                const list = cellsByVariant.get(key) ?? [];
                list.push({
                    currencyCode: c.currencyCode,
                    stepQuantity: Number(c.stepQuantity),
                    value: Number(c.value),
                });
                cellsByVariant.set(key, list);
            });
        }

        const items: PriceListVariantSummary[] = [];
        rows.forEach(r => {
            const v = variantMap.get(String(r.productVariantId));
            if (!v) return;
            items.push({
                id: v.id,
                productVariant: v,
                currencyCount: Number(r.currencyCount),
                tierCount: Number(r.tierCount),
                cellCount: Number(r.cellCount),
                cells: cellsByVariant.get(String(r.productVariantId)) ?? [],
                latestUpdatedAt: new Date(r.latestUpdatedAt),
            });
        });

        return { items, totalItems };
    }

    async add(ctx: RequestContext, input: CreatePriceListItemInput): Promise<PriceListItem> {
        await this.priceListService.assertEditableListPublic(ctx, input.priceListId);

        const stepQuantity = input.stepQuantity ?? 1;
        const existing = await this.connection.getRepository(ctx, PriceListItem).findOne({
            where: {
                priceListId: input.priceListId,
                productVariantId: input.productVariantId,
                currencyCode: input.currencyCode,
                stepQuantity,
            },
        });
        if (existing) {
            throw new UserInputError(
                `An item already exists for (variant ${input.productVariantId}, ` +
                    `${input.currencyCode}, stepQuantity ${stepQuantity}) ` +
                    `in PriceList ${input.priceListId}`,
            );
        }

        const item = new PriceListItem({
            priceListId: input.priceListId,
            productVariantId: input.productVariantId,
            currencyCode: input.currencyCode,
            value: input.value,
            stepQuantity,
        });
        const saved = await this.connection.getRepository(ctx, PriceListItem).save(item);
        return this.findOne(ctx, saved.id) as Promise<PriceListItem>;
    }

    async update(
        ctx: RequestContext,
        input: UpdatePriceListItemInput,
    ): Promise<PriceListItem> {
        const item = await this.findOne(ctx, input.id);
        if (!item) {
            throw new UserInputError(`PriceListItem ${input.id} not found`);
        }
        await this.priceListService.assertEditableListPublic(ctx, item.priceListId);

        if (input.value !== undefined) item.value = input.value;
        if (input.stepQuantity !== undefined) item.stepQuantity = input.stepQuantity;

        await this.connection.getRepository(ctx, PriceListItem).save(item);
        return this.findOne(ctx, item.id) as Promise<PriceListItem>;
    }

    /**
     * Replace the entire pivot for (priceList, variant) atomically.
     *
     * The dashboard pivot editor renders the cross of currencies × step
     * quantities; on save it sends the full set of cells the merchandiser
     * has in view. The service diffs vs the stored cells:
     *
     *   - rows in incoming but not stored → INSERT
     *   - rows in both with different value → UPDATE
     *   - rows in stored but not incoming → DELETE
     *
     * Diff key is `${currencyCode}::${stepQuantity}`. Sending an empty
     * `rows` is a legal way to clear all cells for the variant.
     *
     * Wrapped in a transaction so partial failures don't leave the pivot
     * half-applied.
     */
    async savePivot(
        ctx: RequestContext,
        input: SavePriceListVariantPivotInput,
    ): Promise<PriceListItem[]> {
        await this.priceListService.assertEditableListPublic(ctx, input.priceListId);

        const cellKey = (currency: string, step: number) => `${currency}::${step}`;
        // Defensive: reject duplicates in the incoming payload so we
        // don't silently let "two rows for (EUR, qty 1)" through.
        const seen = new Set<string>();
        input.rows.forEach(r => {
            const key = cellKey(r.currencyCode, r.stepQuantity);
            if (seen.has(key)) {
                throw new UserInputError(
                    `Duplicate cell in pivot payload: (${r.currencyCode}, stepQuantity ${r.stepQuantity})`,
                );
            }
            seen.add(key);
            if (!Number.isInteger(r.stepQuantity) || r.stepQuantity < 1) {
                throw new UserInputError(
                    `stepQuantity must be a positive integer; got ${r.stepQuantity}`,
                );
            }
            if (!Number.isInteger(r.value) || r.value < 0) {
                throw new UserInputError(
                    `value must be a non-negative integer; got ${r.value}`,
                );
            }
        });

        return this.connection.rawConnection.transaction(async manager => {
            const repo = manager.getRepository(PriceListItem);

            const existing = await repo.find({
                where: {
                    priceListId: input.priceListId,
                    productVariantId: input.productVariantId,
                },
            });
            const existingMap = new Map(
                existing.map(e => [cellKey(e.currencyCode, e.stepQuantity), e] as const),
            );
            const incomingMap = new Map(
                input.rows.map(r => [cellKey(r.currencyCode, r.stepQuantity), r] as const),
            );

            // Deletes: in stored but not incoming.
            const toDelete = existing.filter(
                e => !incomingMap.has(cellKey(e.currencyCode, e.stepQuantity)),
            );
            if (toDelete.length > 0) {
                await repo.remove(toDelete);
            }

            // Updates + inserts.
            const toSave: PriceListItem[] = [];
            input.rows.forEach(r => {
                const key = cellKey(r.currencyCode, r.stepQuantity);
                const stored = existingMap.get(key);
                if (stored) {
                    if (stored.value !== r.value) {
                        stored.value = r.value;
                        toSave.push(stored);
                    }
                } else {
                    toSave.push(
                        new PriceListItem({
                            priceListId: input.priceListId,
                            productVariantId: input.productVariantId,
                            currencyCode: r.currencyCode,
                            stepQuantity: r.stepQuantity,
                            value: r.value,
                        }),
                    );
                }
            });
            if (toSave.length > 0) {
                await repo.save(toSave);
            }

            return repo.find({
                where: {
                    priceListId: input.priceListId,
                    productVariantId: input.productVariantId,
                },
                relations: ['productVariant'],
                order: { currencyCode: 'ASC', stepQuantity: 'ASC' },
            });
        });
    }

    /** Hard delete — items aren't SoftDeletable. */
    async remove(ctx: RequestContext, id: ID): Promise<DeletionResponse> {
        const item = await this.findOne(ctx, id);
        if (!item) {
            return {
                result: DeletionResult.NOT_DELETED,
                message: `PriceListItem ${id} not found`,
            };
        }
        await this.priceListService.assertEditableListPublic(ctx, item.priceListId);
        await this.connection.getRepository(ctx, PriceListItem).remove(item);
        return { result: DeletionResult.DELETED };
    }
}
