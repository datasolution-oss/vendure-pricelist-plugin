import { DefaultJobQueuePlugin, mergeConfig } from '@vendure/core';
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
    CREATE_PRICE_LIST,
    SAVE_PIVOT,
    SET_EVERYONE,
} from './graphql/pricelist-operations';

// Stage 2 kill-switch: configured per-channel, returns `[]` from
// resolution → no pricelist ever applies on that channel → Vendure falls
// back to standard pricing. Tested in a dedicated spec because the
// plugin's `init()` runs once per process and we need a config distinct
// from the main pricing spec.
//
// Vendure's testing harness names the default channel `__default_channel__`.

const SHOP_PRODUCT = gql`
    query ShopProduct($id: ID!) {
        product(id: $id) {
            id
            variants {
                id
                price
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

describe('Pricing kill-switch', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [
                PricelistPlugin.init({
                    // Kill switch ON for the default channel — keyed on
                    // channel code (also accepts id).
                    killSwitchPerChannel: { __default_channel__: true },
                }),
                DefaultJobQueuePlugin,
            ],
        }),
    );

    let variantId: string;
    let productId: string;
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

        const variants = await adminClient.query(getProductVariantListDocument, {
            options: { take: 1 },
        });
        variantId = String(variants.productVariants.items[0].id);

        const detail = await adminClient.query<any>(ADMIN_VARIANT, { id: variantId });
        productId = String(detail.productVariant.product.id);
        standardPrice = detail.productVariant.price;
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    }, TEST_SETUP_TIMEOUT_MS);

    it('with killSwitchPerChannel ON, an everyone-list does NOT apply — standard price wins', async () => {
        // Create a list that would otherwise replace the price wholesale.
        const target = Math.floor(standardPrice / 2);
        const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: 'would-discount-but-killed',
                valueType: 'ABSOLUTE',
                priority: 1,
                translations: [{ languageCode: 'en', name: 'Killed' }],
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
        await adminClient.query<any>(SET_EVERYONE, {
            priceListId: listId,
            channelId: channelAId,
            assigned: true,
        });

        // Kill-switch ON → resolution returns [] → cascade returns null →
        // Vendure falls back to the standard catalog price.
        const shopRes = await shopClient.query<any>(SHOP_PRODUCT, { id: productId });
        const v = shopRes.product.variants.find((x: any) => String(x.id) === variantId);
        expect(v.price).toBe(standardPrice);
    });
});
