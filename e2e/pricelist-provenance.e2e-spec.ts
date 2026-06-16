import { DefaultJobQueuePlugin, mergeConfig, OrderLine, TransactionalConnection } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../e2e-common/test-config';
import { PricelistPlugin } from '../src/pricelist.plugin';

import { awaitRunningJobs } from './await-running-jobs';
import { getProductVariantListDocument } from './graphql/shared-definitions';
import {
    CREATE_GROUP,
    CREATE_PRICE_LIST,
    SAVE_PIVOT,
    SET_EVERYONE,
} from './graphql/pricelist-operations';

// Stage 3 §2.4 — denormalised provenance snapshot on the order line.
// `OrderLine.customFields.pricelistProvenance` is `internal: true` so it
// never appears in the admin/shop API. Tests read it directly from the
// TypeORM connection on `server.app`.

const SHOP_ADD_ITEM_TO_ORDER = gql`
    mutation AddItemToOrder($productVariantId: ID!, $quantity: Int!) {
        addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) {
            ... on Order {
                id
                lines {
                    id
                    quantity
                    unitPrice
                    productVariant {
                        id
                    }
                }
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const ADMIN_VARIANT = gql`
    query AdminVariant($id: ID!) {
        productVariant(id: $id) {
            id
            price
            product {
                id
            }
        }
    }
`;

describe('OrderLine pricelist provenance (Stage 3 §2.4)', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [PricelistPlugin, DefaultJobQueuePlugin],
        }),
    );

    let variantUnlistedId: string;
    let variantUnlistedSku: string;
    let variantListedId: string;
    let variantListedSku: string;
    let standardPrice: number;
    let channelAId: string;

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
            customerCount: 0,
        });
        await adminClient.asSuperAdmin();
        await awaitRunningJobs(adminClient, 20_000, 1000);

        const { activeChannel } = await adminClient.query<any>(gql`
            query ActiveChannel {
                activeChannel {
                    id
                }
            }
        `);
        channelAId = String(activeChannel.id);

        // Two variants: one with no pricelist (control), one carrying
        // every pricelist scenario. Both come from the standard fixture.
        const variants = await adminClient.query(getProductVariantListDocument, {
            options: { take: 2 },
        });
        const v0 = variants.productVariants.items[0];
        const v1 = variants.productVariants.items[1];
        variantUnlistedId = String(v0.id);
        variantUnlistedSku = String(v0.sku);
        variantListedId = String(v1.id);
        variantListedSku = String(v1.sku);

        const detail = await adminClient.query<any>(ADMIN_VARIANT, { id: variantListedId });
        standardPrice = detail.productVariant.price;
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    }, TEST_SETUP_TIMEOUT_MS);

    /**
     * Reads the provenance JSON column for a given order line id.
     *
     * The test config uses `TestingEntityIdStrategy` which encodes ids as
     * `T_<n>`; the DB row id is the raw integer. We strip the prefix and
     * decode to the underlying primary key before the repo lookup.
     */
    async function getProvenance(orderLineId: string): Promise<any[] | null> {
        const connection = server.app.get(TransactionalConnection);
        const decoded = parseInt(orderLineId.replace(/^T_/, ''), 10);
        const line = await connection.rawConnection
            .getRepository(OrderLine)
            .findOne({ where: { id: decoded as any } });
        if (!line) throw new Error(`OrderLine ${orderLineId} (decoded ${decoded}) not found`);
        // `customFields.pricelistProvenance` is text/JSON (or null when no
        // pricelist applied at line creation).
        const raw = (line.customFields as any).pricelistProvenance;
        if (raw == null) return null;
        return JSON.parse(raw);
    }

    async function addOneItem(
        productVariantId: string,
        quantity = 1,
    ): Promise<string> {
        await shopClient.asAnonymousUser();
        const res = await shopClient.query<any>(SHOP_ADD_ITEM_TO_ORDER, {
            productVariantId,
            quantity,
        });
        const line = res.addItemToOrder.lines.find(
            (l: any) => String(l.productVariant.id) === productVariantId,
        );
        if (!line) {
            throw new Error(
                `addItemToOrder did not create a line for variant ${productVariantId}: ${JSON.stringify(res.addItemToOrder)}`,
            );
        }
        return String(line.id);
    }

    it('line without pricelist — customFields.pricelistProvenance is null', async () => {
        const lineId = await addOneItem(variantUnlistedId, 1);
        const provenance = await getProvenance(lineId);
        expect(provenance).toBeNull();
    });

    it('line with one applied list — provenance has one entry with list metadata', async () => {
        const target = Math.floor(standardPrice / 2);
        const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: 'SINGLE_PROV',
                valueType: 'ABSOLUTE',
                priority: 1,
                translations: [{ languageCode: 'en', name: 'Single provenance' }],
            },
        });
        const listId = String(res.createPriceList.id);
        await adminClient.query<any>(SAVE_PIVOT, {
            input: {
                priceListId: listId,
                productVariantId: variantListedId,
                rows: [{ currencyCode: 'USD', stepQuantity: 1, value: target }],
            },
        });
        await adminClient.query<any>(SET_EVERYONE, {
            priceListId: listId,
            channelId: channelAId,
            assigned: true,
        });

        const lineId = await addOneItem(variantListedId, 1);
        const provenance = await getProvenance(lineId);
        expect(provenance).not.toBeNull();
        expect(provenance).toHaveLength(1);
        const entry = provenance![0];
        expect(entry.listCode).toBe('SINGLE_PROV');
        // Provenance stores raw DB ids; the test-side `listId` carries
        // the TestingEntityIdStrategy "T_" prefix. Compare on the decoded
        // integer.
        expect(String(entry.listId)).toBe(listId.replace(/^T_/, ''));
        expect(entry.valueType).toBe('ABSOLUTE');
        expect(entry.value).toBe(target);
        expect(entry.stepQuantity).toBe(1);
        // groupId / groupCode are populated from the membership pivot.
        expect(entry.groupId).toBeTruthy();
        expect(entry.groupCode).toBeTruthy();
    });

    it('cascade — provenance contains one entry per contributing list', async () => {
        // BASE in the default group, PROMO in a higher-priority group.
        const promoGroup = await adminClient.query<any>(CREATE_GROUP, {
            input: {
                code: 'cascade-prov-group',
                priority: 10,
                translations: [{ languageCode: 'en', name: 'Cascade group' }],
            },
        });
        const promoGroupId = String(promoGroup.createPriceListGroup.id);

        // Use a 3rd variant for clean isolation from the previous test.
        // We re-use variantUnlistedId — until now it had no list applied,
        // so the line we created earlier was snapshotted with null
        // provenance and the upcoming list is what shows on a NEW line.
        const base = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: 'CASCADE_BASE',
                valueType: 'ABSOLUTE',
                priority: 1,
                translations: [{ languageCode: 'en', name: 'Cascade base' }],
            },
        });
        const baseId = String(base.createPriceList.id);
        await adminClient.query<any>(SAVE_PIVOT, {
            input: {
                priceListId: baseId,
                productVariantId: variantUnlistedId,
                rows: [{ currencyCode: 'USD', stepQuantity: 1, value: 100_00 }],
            },
        });
        await adminClient.query<any>(SET_EVERYONE, {
            priceListId: baseId,
            channelId: channelAId,
            assigned: true,
        });

        const promo = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: 'CASCADE_PROMO',
                valueType: 'PERCENTAGE',
                priority: 1,
                groupId: promoGroupId,
                translations: [{ languageCode: 'en', name: 'Cascade promo' }],
            },
        });
        const promoId = String(promo.createPriceList.id);
        await adminClient.query<any>(SAVE_PIVOT, {
            input: {
                priceListId: promoId,
                productVariantId: variantUnlistedId,
                rows: [{ currencyCode: 'USD', stepQuantity: 1, value: 2000 }],
            },
        });
        await adminClient.query<any>(SET_EVERYONE, {
            priceListId: promoId,
            channelId: channelAId,
            assigned: true,
        });

        const lineId = await addOneItem(variantUnlistedId, 1);
        const provenance = await getProvenance(lineId);
        expect(provenance).not.toBeNull();
        expect(provenance).toHaveLength(2);
        const codes = provenance!.map((e: any) => e.listCode);
        expect(codes).toEqual(expect.arrayContaining(['CASCADE_BASE', 'CASCADE_PROMO']));
        // Each entry carries its own metadata.
        const baseEntry = provenance!.find((e: any) => e.listCode === 'CASCADE_BASE');
        const promoEntry = provenance!.find((e: any) => e.listCode === 'CASCADE_PROMO');
        expect(baseEntry.valueType).toBe('ABSOLUTE');
        expect(baseEntry.value).toBe(100_00);
        expect(promoEntry.valueType).toBe('PERCENTAGE');
        expect(promoEntry.value).toBe(2000);
    });

    it('tier — provenance reflects the stepQuantity matching the order line quantity', async () => {
        // List with two tiers; order at qty 2 should pick the qty=2 tier.
        const variants = await adminClient.query(getProductVariantListDocument, {
            options: { take: 3 },
        });
        const v3Id = String(variants.productVariants.items[2].id);

        const list = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: 'TIERED_PROV',
                valueType: 'ABSOLUTE',
                priority: 1,
                translations: [{ languageCode: 'en', name: 'Tiered provenance' }],
            },
        });
        const listId = String(list.createPriceList.id);
        await adminClient.query<any>(SAVE_PIVOT, {
            input: {
                priceListId: listId,
                productVariantId: v3Id,
                rows: [
                    { currencyCode: 'USD', stepQuantity: 1, value: 100_00 },
                    { currencyCode: 'USD', stepQuantity: 2, value: 80_00 },
                ],
            },
        });
        await adminClient.query<any>(SET_EVERYONE, {
            priceListId: listId,
            channelId: channelAId,
            assigned: true,
        });

        const lineId = await addOneItem(v3Id, 2);
        const provenance = await getProvenance(lineId);
        expect(provenance).not.toBeNull();
        expect(provenance).toHaveLength(1);
        const entry = provenance![0];
        expect(entry.listCode).toBe('TIERED_PROV');
        expect(entry.stepQuantity).toBe(2);
        expect(entry.value).toBe(80_00);
    });
});
