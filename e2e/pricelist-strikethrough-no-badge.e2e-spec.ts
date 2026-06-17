import { DefaultJobQueuePlugin, mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../e2e-common/test-config';
import { PricelistPlugin } from '../src/pricelist.plugin';

import { awaitRunningJobs } from './await-running-jobs';
import { CREATE_PRICE_LIST, SAVE_PIVOT, SET_EVERYONE } from './graphql/pricelist-operations';
import { getProductVariantListDocument } from './graphql/shared-definitions';

// Stage 3 §2.3 case 4: PricelistPlugin.init({ exposeBadgeOnShopApi: false })
// — `priceListBadge` returns null but `originalPrice` / `originalPriceWithTax`
// continue to be populated. Lives in its own spec file because the plugin's
// `init()` runs once per process.

const SHOP_PRODUCT_WITH_STRIKE = gql`
  query ShopProductWithStrike($id: ID!) {
    product(id: $id) {
      id
      variants {
        id
        price
        originalPrice
        originalPriceWithTax
        priceListBadge {
          code
          label
        }
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

describe('Strike-through Shop API — exposeBadgeOnShopApi: false', () => {
  const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig(), {
      plugins: [PricelistPlugin.init({ exposeBadgeOnShopApi: false }), DefaultJobQueuePlugin]
    })
  );

  let variantId: string;
  let productId: string;
  let standardPrice: number;
  let channelAId: string;

  beforeAll(async () => {
    await server.init({
      initialData,
      productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
      customerCount: 0
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
      options: { take: 1 }
    });
    variantId = String(variants.productVariants.items[0].id);

    const detail = await adminClient.query<any>(ADMIN_VARIANT, { id: variantId });
    productId = String(detail.productVariant.product.id);
    standardPrice = detail.productVariant.price;
  }, TEST_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await server.destroy();
  }, TEST_SETUP_TIMEOUT_MS);

  it('badge is null but originalPrice/originalPriceWithTax remain populated', async () => {
    const target = Math.floor(standardPrice / 2);
    const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
      input: {
        code: 'WINTER',
        valueType: 'ABSOLUTE',
                translations: [{ languageCode: 'en', name: 'Soldes Hiver' }]
      }
    });
    const listId = String(res.createPriceList.id);
    await adminClient.query<any>(SAVE_PIVOT, {
      input: {
        priceListId: listId,
        productVariantId: variantId,
        rows: [{ currencyCode: 'USD', stepQuantity: 1, value: target }]
      }
    });
    await adminClient.query<any>(SET_EVERYONE, {
      priceListId: listId,
      channelId: channelAId,
      assigned: true
    });

    await shopClient.asAnonymousUser();
    const shopRes = await shopClient.query<any>(SHOP_PRODUCT_WITH_STRIKE, {
      id: productId
    });
    const v = shopRes.product.variants.find((x: any) => String(x.id) === variantId);

    // Strike-through still rendered — only the badge is suppressed.
    expect(v.price).toBe(target);
    expect(v.originalPrice).toBe(standardPrice);
    expect(v.originalPriceWithTax).not.toBeUndefined();
    expect(v.priceListBadge).toBeNull();
  });
});
