import { DefaultJobQueuePlugin, mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../e2e-common/test-config';
import {
    ERR_PRICELIST_ITEM_DUPLICATE,
    ERR_PRICELIST_PIVOT_DUPLICATE_CELL,
    ERR_PRICELIST_PIVOT_INVALID_STEP_QUANTITY,
    ERR_PRICELIST_PIVOT_INVALID_VALUE,
} from '../src/constants';
import { PricelistPlugin } from '../src/pricelist.plugin';

import {
    ADD_ITEM,
    ASSIGN_TO_CHANNEL,
    CREATE_PRICE_LIST,
    PRICE_LIST,
    REMOVE_ITEM,
    SAVE_PIVOT,
    UPDATE_ITEM,
    VARIANT_ITEMS,
    VARIANT_SUMMARIES,
} from './graphql/pricelist-operations';
import { bootstrapPricelistFixtures, PricelistTestFixtures } from './pricelist-test-env';

describe('PriceListItem', () => {
    const { server, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [PricelistPlugin, DefaultJobQueuePlugin],
        }),
    );

    let f: PricelistTestFixtures;

    beforeAll(async () => {
        f = await bootstrapPricelistFixtures(server, adminClient);
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    }, TEST_SETUP_TIMEOUT_MS);

    // ------------------------------------------------------------
    // B. Items & pivot
    // ------------------------------------------------------------
    describe('B. Items & pivot', () => {
        let listId: string;

        beforeAll(async () => {
            const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'pivot-list',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'Pivot list' }],
                },
            });
            listId = String(res.createPriceList.id);
        });

        it('savePivot inserts every cell of the (currency × stepQuantity) grid', async () => {
            const rows = [
                { currencyCode: 'USD', stepQuantity: 1, value: 1000 },
                { currencyCode: 'USD', stepQuantity: 10, value: 900 },
                { currencyCode: 'EUR', stepQuantity: 1, value: 950 },
                { currencyCode: 'EUR', stepQuantity: 10, value: 850 },
            ];
            const res = await adminClient.query<any>(SAVE_PIVOT, {
                input: { priceListId: listId, productVariantId: f.variantV1Id, rows },
            });
            expect(res.savePriceListVariantPivot).toHaveLength(4);

            const { priceListVariantItems } = await adminClient.query<any>(VARIANT_ITEMS, {
                priceListId: listId,
                productVariantId: f.variantV1Id,
            });
            expect(priceListVariantItems).toHaveLength(4);
            expect(
                priceListVariantItems.map((i: any) => ({
                    c: i.currencyCode,
                    q: i.stepQuantity,
                    v: i.value,
                })),
            ).toEqual(
                expect.arrayContaining([
                    { c: 'USD', q: 1, v: 1000 },
                    { c: 'USD', q: 10, v: 900 },
                    { c: 'EUR', q: 1, v: 950 },
                    { c: 'EUR', q: 10, v: 850 },
                ]),
            );
        });

        it('savePivot diff — updates one cell, drops one, adds one — keeps only the new set', async () => {
            const rows = [
                { currencyCode: 'USD', stepQuantity: 1, value: 1111 }, // changed
                { currencyCode: 'USD', stepQuantity: 10, value: 900 }, // unchanged
                { currencyCode: 'EUR', stepQuantity: 1, value: 950 }, // unchanged
                { currencyCode: 'GBP', stepQuantity: 1, value: 800 }, // new
                // (EUR, 10) intentionally dropped
            ];
            await adminClient.query<any>(SAVE_PIVOT, {
                input: { priceListId: listId, productVariantId: f.variantV1Id, rows },
            });
            const { priceListVariantItems } = await adminClient.query<any>(VARIANT_ITEMS, {
                priceListId: listId,
                productVariantId: f.variantV1Id,
            });
            expect(priceListVariantItems).toHaveLength(4);
            const map = new Map(
                priceListVariantItems.map((i: any) => [
                    `${i.currencyCode}::${i.stepQuantity}`,
                    i.value,
                ]),
            );
            expect(map.get('USD::1')).toBe(1111);
            expect(map.get('USD::10')).toBe(900);
            expect(map.get('EUR::1')).toBe(950);
            expect(map.get('GBP::1')).toBe(800);
            expect(map.has('EUR::10')).toBe(false);
        });

        it('priceListVariantSummaries — one aggregate row per variant with counts', async () => {
            const { priceListVariantSummaries } = await adminClient.query<any>(
                VARIANT_SUMMARIES,
                { priceListId: listId },
            );
            expect(priceListVariantSummaries.totalItems).toBe(1);
            expect(priceListVariantSummaries.items).toHaveLength(1);
            const row = priceListVariantSummaries.items[0];
            expect(String(row.productVariant.id)).toBe(f.variantV1Id);
            // 4 cells over 3 currencies and 2 distinct step quantities.
            expect(row.cellCount).toBe(4);
            expect(row.currencyCount).toBe(3);
            expect(row.tierCount).toBe(2);
            expect(row.cells).toHaveLength(4);
        });

        it('empty rows clears every cell for the variant', async () => {
            await adminClient.query<any>(SAVE_PIVOT, {
                input: { priceListId: listId, productVariantId: f.variantV1Id, rows: [] },
            });
            const { priceListVariantItems } = await adminClient.query<any>(VARIANT_ITEMS, {
                priceListId: listId,
                productVariantId: f.variantV1Id,
            });
            expect(priceListVariantItems).toHaveLength(0);
        });

        it('priceListVariantSummaries paginates correctly — skip/take/totalItems', async () => {
            // Fresh list with 3 distinct variants seeded, then paginate.
            const listRes = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'summaries-pagination',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'Summaries paginated' }],
                },
            });
            const otherListId = String(listRes.createPriceList.id);

            // V2 is in both channels; we still seed via channel A. Three
            // distinct variants: V1, V2, plus a 3rd from the fixture. Reuse
            // shared catalogue to avoid setup churn.
            for (const vid of [f.variantV1Id, f.variantV2Id]) {
                await adminClient.query<any>(SAVE_PIVOT, {
                    input: {
                        priceListId: otherListId,
                        productVariantId: vid,
                        rows: [{ currencyCode: 'USD', stepQuantity: 1, value: 100 }],
                    },
                });
            }

            const page1 = await adminClient.query<any>(VARIANT_SUMMARIES, {
                priceListId: otherListId,
                options: { take: 1 },
            });
            expect(page1.priceListVariantSummaries.totalItems).toBe(2);
            expect(page1.priceListVariantSummaries.items).toHaveLength(1);

            const page2 = await adminClient.query<any>(VARIANT_SUMMARIES, {
                priceListId: otherListId,
                options: { skip: 1, take: 1 },
            });
            expect(page2.priceListVariantSummaries.totalItems).toBe(2);
            expect(page2.priceListVariantSummaries.items).toHaveLength(1);
            expect(page2.priceListVariantSummaries.items[0].productVariant.id).not.toBe(
                page1.priceListVariantSummaries.items[0].productVariant.id,
            );
        });

        it('savePivot rejects a payload with duplicate (currency, stepQuantity) cells', async () => {
            await expect(
                adminClient.query<any>(SAVE_PIVOT, {
                    input: {
                        priceListId: listId,
                        productVariantId: f.variantV1Id,
                        rows: [
                            { currencyCode: 'USD', stepQuantity: 1, value: 100 },
                            { currencyCode: 'USD', stepQuantity: 1, value: 200 },
                        ],
                    },
                }),
            ).rejects.toThrow(ERR_PRICELIST_PIVOT_DUPLICATE_CELL);
        });

        it('savePivot rejects stepQuantity < 1', async () => {
            await expect(
                adminClient.query<any>(SAVE_PIVOT, {
                    input: {
                        priceListId: listId,
                        productVariantId: f.variantV1Id,
                        rows: [{ currencyCode: 'USD', stepQuantity: 0, value: 100 }],
                    },
                }),
            ).rejects.toThrow(ERR_PRICELIST_PIVOT_INVALID_STEP_QUANTITY);
        });

        it('savePivot rejects a negative value', async () => {
            await expect(
                adminClient.query<any>(SAVE_PIVOT, {
                    input: {
                        priceListId: listId,
                        productVariantId: f.variantV1Id,
                        rows: [{ currencyCode: 'USD', stepQuantity: 1, value: -1 }],
                    },
                }),
            ).rejects.toThrow(ERR_PRICELIST_PIVOT_INVALID_VALUE);
        });

        it('addPriceListItem rejects a duplicate (variant, currency, stepQuantity) tuple', async () => {
            // First add succeeds, second add of the same tuple is rejected.
            await adminClient.query<any>(ADD_ITEM, {
                input: {
                    priceListId: listId,
                    productVariantId: f.variantV1Id,
                    currencyCode: 'USD',
                    stepQuantity: 1,
                    value: 100,
                },
            });
            await expect(
                adminClient.query<any>(ADD_ITEM, {
                    input: {
                        priceListId: listId,
                        productVariantId: f.variantV1Id,
                        currencyCode: 'USD',
                        stepQuantity: 1,
                        value: 200,
                    },
                }),
            ).rejects.toThrow(ERR_PRICELIST_ITEM_DUPLICATE);
        });
    });

    // ------------------------------------------------------------
    // Item-level content edits from a non-origin channel are rejected
    // (delegate to assertEditableListPublic in the service).
    // ------------------------------------------------------------
    describe('Item content-edit guard (non-origin channel)', () => {
        let listId: string;
        let itemId: string;

        beforeAll(async () => {
            const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'item-guard-list',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'Item guard' }],
                },
            });
            listId = String(res.createPriceList.id);
            // Seed one item (on V2 so it's visible from B). Then share to B.
            const item = await adminClient.query<any>(ADD_ITEM, {
                input: {
                    priceListId: listId,
                    productVariantId: f.variantV2Id,
                    currencyCode: 'USD',
                    stepQuantity: 1,
                    value: 100,
                },
            });
            itemId = String(item.addPriceListItem.id);
            await adminClient.query<any>(ASSIGN_TO_CHANNEL, {
                input: { priceListId: listId, channelId: f.channelB.id },
            });
        });

        afterAll(() => {
            adminClient.setChannelToken(f.channelA.token);
        });

        it('updatePriceListItem from a non-origin channel is rejected', async () => {
            adminClient.setChannelToken(f.channelB.token);
            await expect(
                adminClient.query<any>(UPDATE_ITEM, {
                    input: { id: itemId, value: 999 },
                }),
            ).rejects.toThrow(/PRICELIST_READONLY_NON_ORIGIN_CHANNEL/);
        });

        it('removePriceListItem from a non-origin channel is rejected', async () => {
            adminClient.setChannelToken(f.channelB.token);
            await expect(
                adminClient.query<any>(REMOVE_ITEM, { id: itemId }),
            ).rejects.toThrow(/PRICELIST_READONLY_NON_ORIGIN_CHANNEL/);
        });
    });

    // ------------------------------------------------------------
    // C. Channel scoping of items
    //
    // Setup: V1 only on channel A; V2 on A + B. A list created on A with
    // items for both variants and then shared to B must show only V2 when
    // read from B.
    // ------------------------------------------------------------
    describe('C. Channel scoping of items', () => {
        let listId: string;

        beforeAll(async () => {
            const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'scoping-list',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'Scoping list' }],
                },
            });
            listId = String(res.createPriceList.id);
            await adminClient.query<any>(SAVE_PIVOT, {
                input: {
                    priceListId: listId,
                    productVariantId: f.variantV1Id,
                    rows: [{ currencyCode: 'USD', stepQuantity: 1, value: 100 }],
                },
            });
            await adminClient.query<any>(SAVE_PIVOT, {
                input: {
                    priceListId: listId,
                    productVariantId: f.variantV2Id,
                    rows: [{ currencyCode: 'USD', stepQuantity: 1, value: 200 }],
                },
            });
            await adminClient.query<any>(ASSIGN_TO_CHANNEL, {
                input: { priceListId: listId, channelId: f.channelB.id },
            });
        });

        it('from channel A — summaries include both V1 and V2 (totalItems = 2)', async () => {
            adminClient.setChannelToken(f.channelA.token);
            const { priceListVariantSummaries } = await adminClient.query<any>(
                VARIANT_SUMMARIES,
                { priceListId: listId },
            );
            expect(priceListVariantSummaries.totalItems).toBe(2);
            const ids = priceListVariantSummaries.items
                .map((r: any) => String(r.productVariant.id))
                .sort();
            expect(ids).toEqual([f.variantV1Id, f.variantV2Id].sort());
        });

        it('from channel B — summaries only include V2 (totalItems = 1)', async () => {
            adminClient.setChannelToken(f.channelB.token);
            try {
                const { priceListVariantSummaries } = await adminClient.query<any>(
                    VARIANT_SUMMARIES,
                    { priceListId: listId },
                );
                expect(priceListVariantSummaries.totalItems).toBe(1);
                expect(priceListVariantSummaries.items).toHaveLength(1);
                expect(String(priceListVariantSummaries.items[0].productVariant.id)).toBe(
                    f.variantV2Id,
                );

                const { priceListVariantItems } = await adminClient.query<any>(VARIANT_ITEMS, {
                    priceListId: listId,
                    productVariantId: f.variantV1Id,
                });
                expect(priceListVariantItems).toHaveLength(0);

                const { priceList } = await adminClient.query<any>(PRICE_LIST, { id: listId });
                const variantIds = priceList.items.items.map((it: any) =>
                    String(it.productVariant.id),
                );
                expect(variantIds).not.toContain(f.variantV1Id);
                expect(variantIds).toContain(f.variantV2Id);
            } finally {
                adminClient.setChannelToken(f.channelA.token);
            }
        });
    });
});
