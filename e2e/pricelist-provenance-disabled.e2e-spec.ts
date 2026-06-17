import { DefaultJobQueuePlugin, mergeConfig, OrderLine, TransactionalConnection } from '@vendure/core';
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

// Stage 3 §2.4 opt-out — `PricelistPlugin.init({ recordOrderLineProvenance: false })`
// short-circuits the `OrderLineProvenanceSubscriber` registration, so the
// `pricelistProvenance` custom field stays `null` even when a price list
// applied to the line. Lives in its own spec file because the plugin's
// `init()` runs once per process (sibling spec to `pricelist-strikethrough-no-badge`).

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

describe('OrderLine pricelist provenance — recordOrderLineProvenance: false', () => {
  const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig(), {
      plugins: [PricelistPlugin.init({ recordOrderLineProvenance: false }), DefaultJobQueuePlugin]
    })
  );

  let variantId: string;
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
    standardPrice = detail.productVariant.price;
  }, TEST_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await server.destroy();
  }, TEST_SETUP_TIMEOUT_MS);

  /**
   * Reads the provenance JSON column for a given order line id. Same
   * decoding logic as in the main `pricelist-provenance` spec.
   */
  async function getProvenance(orderLineId: string): Promise<any[] | null> {
    const connection = server.app.get(TransactionalConnection);
    const decoded = parseInt(orderLineId.replace(/^T_/, ''), 10);
    const line = await connection.rawConnection.getRepository(OrderLine).findOne({ where: { id: decoded as any } });
    if (!line) throw new Error(`OrderLine ${orderLineId} (decoded ${decoded}) not found`);
    const raw = (line.customFields as any).pricelistProvenance;
    if (raw == null) return null;
    return JSON.parse(raw);
  }

  async function addOneItem(productVariantId: string, quantity = 1): Promise<string> {
    await shopClient.asAnonymousUser();
    const res = await shopClient.query<any>(SHOP_ADD_ITEM_TO_ORDER, {
      productVariantId,
      quantity
    });
    const line = res.addItemToOrder.lines.find((l: any) => String(l.productVariant.id) === productVariantId);
    if (!line) {
      throw new Error(
        `addItemToOrder did not create a line for variant ${productVariantId}: ${JSON.stringify(res.addItemToOrder)}`
      );
    }
    return String(line.id);
  }

  it('subscriber is not registered — provenance is null even when a list applies', async () => {
    // Create a list that would otherwise produce a 1-entry provenance.
    const target = Math.floor(standardPrice / 2);
    const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
      input: {
        code: 'PROV_OFF',
        valueType: 'ABSOLUTE',
                translations: [{ languageCode: 'en', name: 'Provenance disabled' }]
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

    const lineId = await addOneItem(variantId, 1);

    // Sanity-check that the list DID apply (price was actually adjusted)
    // — otherwise the assertion below would be vacuously true.
    const order = await shopClient.query<any>(gql`
      query ActiveOrder {
        activeOrder {
          lines {
            id
            unitPrice
          }
        }
      }
    `);
    const line = order.activeOrder.lines.find((l: any) => String(l.id) === lineId);
    expect(line.unitPrice).toBe(target);

    // The opt-out: no provenance recorded.
    const provenance = await getProvenance(lineId);
    expect(provenance).toBeNull();
  });
});
