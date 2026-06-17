import { DefaultJobQueuePlugin, mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../e2e-common/test-config';
import { PricelistPlugin } from '../src/pricelist.plugin';

import { awaitRunningJobs } from './await-running-jobs';
import {
    addCustomersToGroupDocument,
    createCustomerDocument,
    createCustomerGroupDocument,
    getProductVariantListDocument,
} from './graphql/shared-definitions';
import {
    ADD_CUSTOMER_GROUPS,
    ASSIGN_TO_CHANNEL,
    CHANGE_GROUP,
    CREATE_GROUP,
    CREATE_PRICE_LIST,
    DELETE_PRICE_LIST,
    SAVE_PIVOT,
    SET_EVERYONE,
    UPDATE_PRICE_LIST,
} from './graphql/pricelist-operations';

// Stage 2/3 — pricelist applies at the catalog (variant.price) and
// order-line (lines.unitPrice) layers via the two strategies registered
// unconditionally by the plugin. These tests verify the end-to-end
// behaviour through the Shop API, which is what the customer sees.

// ─── Shop API operations ──────────────────────────────────────────
// Plain gql; the introspection snapshot doesn't include the pricelist
// schema and the shop schema isn't typed in this repo.

const SHOP_PRODUCT = gql`
    query ShopProduct($id: ID!) {
        product(id: $id) {
            id
            variants {
                id
                sku
                price
                priceWithTax
                currencyCode
            }
        }
    }
`;

const SHOP_ADD_ITEM_TO_ORDER = gql`
    mutation AddItemToOrder($productVariantId: ID!, $quantity: Int!) {
        addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) {
            ... on Order {
                id
                lines {
                    id
                    quantity
                    unitPrice
                    unitPriceWithTax
                    linePrice
                    linePriceWithTax
                    productVariant {
                        id
                    }
                }
                total
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const SHOP_REMOVE_LINE = gql`
    mutation RemoveOrderLine($orderLineId: ID!) {
        removeOrderLine(orderLineId: $orderLineId) {
            ... on Order {
                id
                lines {
                    id
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
            sku
            price
            product {
                id
            }
        }
    }
`;

describe('Pricing (Stage 2/3)', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [PricelistPlugin, DefaultJobQueuePlugin],
        }),
    );

    // The variant we drive all pricing scenarios on. `standardPrice` is the
    // catalog-API list price before any pricelist applies — captured once
    // and used as the comparison baseline.
    let variantId: string;
    let productId: string;
    let standardPrice: number;
    let channelAId: string;

    // Customer & group used by the targeting test.
    const TEST_CUSTOMER_EMAIL = 'pricing-customer@example.com';
    const TEST_CUSTOMER_PASSWORD = 'pricing1234';
    let vipGroupId: string;

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
            customerCount: 1,
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

        // Pick one variant for every scenario. Capture its standard
        // catalog price BEFORE any pricelist exists — that's our baseline.
        const variants = await adminClient.query(getProductVariantListDocument, {
            options: { take: 1 },
        });
        variantId = String(variants.productVariants.items[0].id);

        const detail = await adminClient.query<any>(ADMIN_VARIANT, { id: variantId });
        productId = String(detail.productVariant.product.id);
        standardPrice = detail.productVariant.price;

        // Customer + group for the targeting scenario.
        const cust = await adminClient.query(createCustomerDocument, {
            input: {
                firstName: 'Pricing',
                lastName: 'Customer',
                emailAddress: TEST_CUSTOMER_EMAIL,
            },
            password: TEST_CUSTOMER_PASSWORD,
        });
        const customerId = String((cust.createCustomer as any).id);

        const grp = await adminClient.query(createCustomerGroupDocument, {
            input: { name: 'PricingVIP' },
        });
        vipGroupId = String(grp.createCustomerGroup.id);

        await adminClient.query(addCustomersToGroupDocument, {
            groupId: vipGroupId,
            customerIds: [customerId],
        });
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    }, TEST_SETUP_TIMEOUT_MS);

    /**
     * Fresh-list helper: creates an `everyone`-accessible pricelist with
     * one ABSOLUTE/PERCENTAGE row on our test variant + optional explicit
     * group. Returns the list id so the test can later delete it
     * (keeping subsequent tests free of cross-contamination).
     */
    async function makeList(opts: {
        code: string;
        valueType: 'ABSOLUTE' | 'PERCENTAGE';
        rows: Array<{ stepQuantity: number; value: number }>;
        groupId?: string;
        everyone?: boolean;
        enabled?: boolean;
        startDate?: string;
    }): Promise<string> {
        const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: opts.code,
                valueType: opts.valueType,
                enabled: opts.enabled ?? true,
                startDate: opts.startDate ?? null,
                groupId: opts.groupId ?? undefined,
                translations: [{ languageCode: 'en', name: opts.code }],
            },
        });
        const id = String(res.createPriceList.id);
        await adminClient.query<any>(SAVE_PIVOT, {
            input: {
                priceListId: id,
                productVariantId: variantId,
                rows: opts.rows.map(r => ({
                    currencyCode: 'USD',
                    stepQuantity: r.stepQuantity,
                    value: r.value,
                })),
            },
        });
        if (opts.everyone !== false) {
            await adminClient.query<any>(SET_EVERYONE, {
                priceListId: id,
                channelId: channelAId,
                assigned: true,
            });
        }
        return id;
    }

    async function getShopPrice(): Promise<number> {
        const res = await shopClient.query<any>(SHOP_PRODUCT, { id: productId });
        const v = res.product.variants.find((x: any) => String(x.id) === variantId);
        return v.price;
    }

    // ────────────────────────────────────────────────────────────
    // A. Pure ABSOLUTE override
    // ────────────────────────────────────────────────────────────
    it('ABSOLUTE list assigned to everyone replaces the catalog price', async () => {
        const target = Math.floor(standardPrice / 2);
        const listId = await makeList({
            code: 'absolute-everyone',
            valueType: 'ABSOLUTE',
            rows: [{ stepQuantity: 1, value: target }],
        });
        try {
            expect(await getShopPrice()).toBe(target);
        } finally {
            await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
        }
    });

    // ────────────────────────────────────────────────────────────
    // B. PERCENTAGE applied to the standard price
    // ────────────────────────────────────────────────────────────
    it('PERCENTAGE list applies the discount in basis points to the standard price', async () => {
        // 1000 basis points = -10%.
        const listId = await makeList({
            code: 'percentage-everyone',
            valueType: 'PERCENTAGE',
            rows: [{ stepQuantity: 1, value: 1000 }],
        });
        try {
            const price = await getShopPrice();
            // Default rounding is half-up to minor units; allow a tiny ±1
            // delta if tax-zone reconversion shifts by a unit.
            const expected = Math.round(standardPrice * (1 - 1000 / 10000));
            expect(Math.abs(price - expected)).toBeLessThanOrEqual(1);
        } finally {
            await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
        }
    });

    // ────────────────────────────────────────────────────────────
    // C. Cascade — base (priority 0) + promo (priority +)
    // ────────────────────────────────────────────────────────────
    it('cascade — base ABSOLUTE list runs first, then a higher-priority PERCENTAGE group discounts it', async () => {
        // Default group on channel A has priority 0 — the BASE list lives
        // there. We create a second group with priority 10 (applied AFTER
        // base in the cascade) and put the PROMO list in it.
        const promoGroup = await adminClient.query<any>(CREATE_GROUP, {
            input: {
                code: 'promo-group',
                priority: 10,
                translations: [{ languageCode: 'en', name: 'Promo' }],
            },
        });
        const promoGroupId = String(promoGroup.createPriceListGroup.id);

        const base = await makeList({
            code: 'cascade-base',
            valueType: 'ABSOLUTE',
            rows: [{ stepQuantity: 1, value: 100_00 }],
        });
        const promo = await makeList({
            code: 'cascade-promo',
            valueType: 'PERCENTAGE',
            rows: [{ stepQuantity: 1, value: 2000 }], // -20%
            groupId: promoGroupId,
        });
        try {
            // 100.00 base × (1 - 0.20) = 80.00
            expect(await getShopPrice()).toBe(80_00);
        } finally {
            await adminClient.query<any>(DELETE_PRICE_LIST, { id: promo });
            await adminClient.query<any>(DELETE_PRICE_LIST, { id: base });
        }
    });

    // ────────────────────────────────────────────────────────────
    // D. Quantity tiers — addItemToOrder picks the right step
    // ────────────────────────────────────────────────────────────
    it('order line price honours stepQuantity tiers via addItemToOrder', async () => {
        const QTY1 = 100_00;
        const QTY2 = 80_00;
        const listId = await makeList({
            code: 'tiered',
            valueType: 'ABSOLUTE',
            rows: [
                { stepQuantity: 1, value: QTY1 },
                { stepQuantity: 2, value: QTY2 },
            ],
        });
        try {
            // Use a NEW guest cart for this test so we don't inherit state.
            await shopClient.asAnonymousUser();
            const res = await shopClient.query<any>(SHOP_ADD_ITEM_TO_ORDER, {
                productVariantId: variantId,
                quantity: 2,
            });
            const line = res.addItemToOrder.lines.find(
                (l: any) => String(l.productVariant.id) === variantId,
            );
            expect(line.quantity).toBe(2);
            expect(line.unitPrice).toBe(QTY2);
            expect(line.linePrice).toBe(QTY2 * 2);
        } finally {
            await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
        }
    });

    // ────────────────────────────────────────────────────────────
    // E. Customer-group targeting — anon vs member
    // ────────────────────────────────────────────────────────────
    it('customer-group-targeted list — anonymous shopper sees standard price, group member sees discounted', async () => {
        const target = Math.floor(standardPrice / 3);
        const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: 'targeted-group',
                valueType: 'ABSOLUTE',
                translations: [{ languageCode: 'en', name: 'Targeted group' }],
            },
        });
        const listId = String(res.createPriceList.id);
        await adminClient.query<any>(SAVE_PIVOT, {
            input: {
                priceListId: listId,
                productVariantId: variantId,
                rows: [{ currencyCode: 'USD', stepQuantity: 1, value: target }],
            },
        });
        await adminClient.query<any>(ADD_CUSTOMER_GROUPS, {
            priceListId: listId,
            channelId: channelAId,
            customerGroupIds: [vipGroupId],
        });
        try {
            await shopClient.asAnonymousUser();
            expect(await getShopPrice()).toBe(standardPrice);

            await shopClient.asUserWithCredentials(
                TEST_CUSTOMER_EMAIL,
                TEST_CUSTOMER_PASSWORD,
            );
            expect(await getShopPrice()).toBe(target);
        } finally {
            await shopClient.asAnonymousUser();
            await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
        }
    });

    // ────────────────────────────────────────────────────────────
    // F. Validity — startDate in the future
    // ────────────────────────────────────────────────────────────
    it('list with startDate in the future does NOT apply — standard price wins', async () => {
        // 10 years from now — safely outside any plausible test window.
        const future = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000).toISOString();
        const target = Math.floor(standardPrice / 4);
        const listId = await makeList({
            code: 'not-yet-active',
            valueType: 'ABSOLUTE',
            rows: [{ stepQuantity: 1, value: target }],
            startDate: future,
        });
        try {
            await shopClient.asAnonymousUser();
            expect(await getShopPrice()).toBe(standardPrice);
        } finally {
            await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
        }
    });

    // ────────────────────────────────────────────────────────────
    // G. enabled: false
    // ────────────────────────────────────────────────────────────
    it('list with enabled: false does NOT apply — standard price wins', async () => {
        const target = Math.floor(standardPrice / 5);
        const listId = await makeList({
            code: 'disabled-list',
            valueType: 'ABSOLUTE',
            rows: [{ stepQuantity: 1, value: target }],
            enabled: false,
        });
        try {
            await shopClient.asAnonymousUser();
            expect(await getShopPrice()).toBe(standardPrice);

            // Flip enabled → true, the discount should apply.
            await adminClient.query<any>(UPDATE_PRICE_LIST, {
                input: { id: listId, enabled: true },
            });
            expect(await getShopPrice()).toBe(target);
        } finally {
            await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
        }
    });

    // ────────────────────────────────────────────────────────────
    // H. Soft-deleted list — no longer applies (regression)
    // ────────────────────────────────────────────────────────────
    it('soft-deleted list is excluded from the cascade — standard price wins', async () => {
        const target = Math.floor(standardPrice / 6);
        const listId = await makeList({
            code: 'about-to-delete',
            valueType: 'ABSOLUTE',
            rows: [{ stepQuantity: 1, value: target }],
        });
        await shopClient.asAnonymousUser();
        expect(await getShopPrice()).toBe(target);

        await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
        expect(await getShopPrice()).toBe(standardPrice);
    });

    // ────────────────────────────────────────────────────────────
    // I. Cache invalidation — edit the pivot, next read sees the new value
    // ────────────────────────────────────────────────────────────
    it('cache invalidation — editing an item value is reflected immediately on the next read', async () => {
        const initial = Math.floor(standardPrice / 7);
        const updated = Math.floor(standardPrice / 8);
        const listId = await makeList({
            code: 'cache-invalidate',
            valueType: 'ABSOLUTE',
            rows: [{ stepQuantity: 1, value: initial }],
        });
        try {
            await shopClient.asAnonymousUser();
            expect(await getShopPrice()).toBe(initial);

            // Re-save the pivot with the new value (replaces the cell).
            await adminClient.query<any>(SAVE_PIVOT, {
                input: {
                    priceListId: listId,
                    productVariantId: variantId,
                    rows: [{ currencyCode: 'USD', stepQuantity: 1, value: updated }],
                },
            });
            expect(await getShopPrice()).toBe(updated);
        } finally {
            await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
        }
    });
});
