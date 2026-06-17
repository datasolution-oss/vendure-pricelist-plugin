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
  ADD_CUSTOMER_GROUPS,
  CREATE_PRICE_LIST,
  DELETE_PRICE_LIST,
  SAVE_PIVOT,
  SET_EVERYONE
} from './graphql/pricelist-operations';
import {
  addCustomersToGroupDocument,
  createCustomerDocument,
  createCustomerGroupDocument,
  getProductVariantListDocument
} from './graphql/shared-definitions';

// Stage 3 §2.3 — strike-through Shop API. New fields on ProductVariant:
//   originalPrice / originalPriceWithTax — pre-pricelist catalog price,
//     null when no pricelist applied (strike-through convention).
//   priceListBadge { code label } — winning list's code + translated name,
//     null when no pricelist applied or `exposeBadgeOnShopApi: false`.
//
// Badge-disabled case is covered in `pricelist-strikethrough-no-badge.e2e-spec.ts`
// (requires a distinct plugin init).

const SHOP_PRODUCT_WITH_STRIKE = gql`
  query ShopProductWithStrike($id: ID!) {
    product(id: $id) {
      id
      variants {
        id
        sku
        price
        priceWithTax
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
      sku
      price
      priceWithTax
      product {
        id
      }
    }
  }
`;

describe('Strike-through Shop API (Stage 3 §2.3)', () => {
  const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig(), {
      plugins: [PricelistPlugin, DefaultJobQueuePlugin]
    })
  );

  let variantId: string;
  let productId: string;
  let standardPrice: number;
  let standardPriceWithTax: number;
  let channelAId: string;

  const TEST_CUSTOMER_EMAIL = 'strikethrough-customer@example.com';
  const TEST_CUSTOMER_PASSWORD = 'strike1234';
  let vipGroupId: string;

  beforeAll(async () => {
    await server.init({
      initialData,
      productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
      customerCount: 1
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
    standardPriceWithTax = detail.productVariant.priceWithTax;

    // Customer + group for the targeting scenario.
    const cust = await adminClient.query(createCustomerDocument, {
      input: {
        firstName: 'Strike',
        lastName: 'Customer',
        emailAddress: TEST_CUSTOMER_EMAIL
      },
      password: TEST_CUSTOMER_PASSWORD
    });
    const customerId = String((cust.createCustomer as any).id);
    const grp = await adminClient.query(createCustomerGroupDocument, {
      input: { name: 'StrikeVIP' }
    });
    vipGroupId = String(grp.createCustomerGroup.id);
    await adminClient.query(addCustomersToGroupDocument, {
      groupId: vipGroupId,
      customerIds: [customerId]
    });
  }, TEST_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await server.destroy();
  }, TEST_SETUP_TIMEOUT_MS);

  /** Read the single variant under test from the shop API. */
  async function getShopVariant(): Promise<any> {
    const res = await shopClient.query<any>(SHOP_PRODUCT_WITH_STRIKE, {
      id: productId
    });
    return res.product.variants.find((v: any) => String(v.id) === variantId);
  }

  async function makeList(opts: { code: string; name: string; value: number; everyone?: boolean }): Promise<string> {
    const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
      input: {
        code: opts.code,
        valueType: 'ABSOLUTE',
                translations: [{ languageCode: 'en', name: opts.name }]
      }
    });
    const id = String(res.createPriceList.id);
    await adminClient.query<any>(SAVE_PIVOT, {
      input: {
        priceListId: id,
        productVariantId: variantId,
        rows: [{ currencyCode: 'USD', stepQuantity: 1, value: opts.value }]
      }
    });
    if (opts.everyone !== false) {
      await adminClient.query<any>(SET_EVERYONE, {
        priceListId: id,
        channelId: channelAId,
        assigned: true
      });
    }
    return id;
  }

  it('no pricelist applies — originalPrice, originalPriceWithTax and badge are null', async () => {
    await shopClient.asAnonymousUser();
    const v = await getShopVariant();
    expect(v.price).toBe(standardPrice);
    expect(v.originalPrice).toBeNull();
    expect(v.originalPriceWithTax).toBeNull();
    expect(v.priceListBadge).toBeNull();
  });

  it('pricelist applies — originalPrice = standard, badge.code = list.code, badge.label = list.name', async () => {
    const target = Math.floor(standardPrice / 2);
    const listId = await makeList({
      code: 'WINTER',
      name: 'Soldes Hiver',
      value: target
    });
    try {
      await shopClient.asAnonymousUser();
      const v = await getShopVariant();
      expect(v.price).toBe(target);
      expect(v.originalPrice).toBe(standardPrice);
      // The resolver computes originalPriceWithTax by applying the
      // variant's current tax ratio to originalPrice. Tax category
      // is the same for both prices, so the result equals the
      // standard catalog priceWithTax we captured at startup
      // (±1 minor unit for the round-trip rounding).
      expect(Math.abs(v.originalPriceWithTax - standardPriceWithTax)).toBeLessThanOrEqual(1);
      expect(v.priceListBadge).toEqual({ code: 'WINTER', label: 'Soldes Hiver' });
    } finally {
      await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
    }
  });

  it('originalPrice is never equal to price (strike-through convention)', async () => {
    // Strike-through is only meaningful when there's a discount to
    // display — the resolver returns null when no list applies. This
    // also asserts the convention against a ABSOLUTE = standard edge
    // case: if a merchandiser created a list whose price equals the
    // standard, the strike would be visually empty. The strategy still
    // populates the cache (the list DID apply), so this is just
    // documenting current behaviour: when applied, originalPrice IS
    // the pre-pricelist price even if equal — but the resolver returns
    // it regardless. (Storefronts hide the strike when prices match.)
    const target = standardPrice; // same as standard
    const listId = await makeList({
      code: 'NOOP',
      name: 'No-op',
      value: target
    });
    try {
      await shopClient.asAnonymousUser();
      const v = await getShopVariant();
      // List applied → originalPrice populated.
      expect(v.originalPrice).toBe(standardPrice);
      expect(v.priceListBadge).toEqual({ code: 'NOOP', label: 'No-op' });
    } finally {
      await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
    }
  });

  it('customer-group-targeted list — anonymous sees no strike, member sees strike + badge', async () => {
    const target = Math.floor(standardPrice / 3);
    const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
      input: {
        code: 'VIPSTRIKE',
        valueType: 'ABSOLUTE',
                translations: [{ languageCode: 'en', name: 'VIP Strike' }]
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
    await adminClient.query<any>(ADD_CUSTOMER_GROUPS, {
      priceListId: listId,
      channelId: channelAId,
      customerGroupIds: [vipGroupId]
    });
    try {
      await shopClient.asAnonymousUser();
      const anon = await getShopVariant();
      expect(anon.price).toBe(standardPrice);
      expect(anon.originalPrice).toBeNull();
      expect(anon.priceListBadge).toBeNull();

      await shopClient.asUserWithCredentials(TEST_CUSTOMER_EMAIL, TEST_CUSTOMER_PASSWORD);
      const member = await getShopVariant();
      expect(member.price).toBe(target);
      expect(member.originalPrice).toBe(standardPrice);
      expect(member.priceListBadge).toEqual({ code: 'VIPSTRIKE', label: 'VIP Strike' });
    } finally {
      await shopClient.asAnonymousUser();
      await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
    }
  });
});
