import { DefaultJobQueuePlugin, mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../e2e-common/test-config';
import { PricelistPlugin } from '../src/pricelist.plugin';

import {
    ADD_CUSTOMER_GROUPS,
    CREATE_ADMIN,
    CREATE_GROUP,
    CREATE_PRICE_LIST,
    CREATE_ROLE,
    DEFAULT_GROUP,
    DELETE_PRICE_LIST,
    PRICE_LISTS_FOR_VARIANT,
    SAVE_PIVOT,
    SET_DEFAULT_GROUP,
    SET_EVERYONE,
    SIMULATE_VARIANT_PRICE,
} from './graphql/pricelist-operations';
import {
    addCustomersToGroupDocument,
    createCustomerDocument,
    createCustomerGroupDocument,
} from './graphql/shared-definitions';
import { bootstrapPricelistFixtures, PricelistTestFixtures } from './pricelist-test-env';

// Variant-page admin API surface:
//   §1 priceListsForVariant     — paginated lists that contain an item for V
//   §2 simulateVariantPrice     — cascade simulator (admin, target-agnostic)
//   §3 Channel.customFields.defaultPriceListGroup is `internal: true`
//   §4 permissions — both queries gated by ReadPriceList

const ADMIN_VARIANT = gql`
    query AdminVariant($id: ID!) {
        productVariant(id: $id) {
            id
            sku
            price
            priceWithTax
            currencyCode
            product {
                id
            }
        }
    }
`;

const SHOP_PRODUCT_PRICE = gql`
    query ShopProductPrice($id: ID!) {
        product(id: $id) {
            id
            variants {
                id
                price
                priceWithTax
            }
        }
    }
`;

// Default channel base SDL test — verifies that the relation custom field is
// not surfaced as a `defaultPriceListGroup` sub-selection on `customFields`.
const ACTIVE_CHANNEL_TRY_INTERNAL_FIELD = gql`
    query ActiveChannelTryInternal {
        activeChannel {
            id
            customFields {
                defaultPriceListGroup {
                    id
                }
            }
        }
    }
`;

describe('Variant-page pricelist API', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [PricelistPlugin, DefaultJobQueuePlugin],
        }),
    );

    let f: PricelistTestFixtures;
    let standardPrice: number;
    let standardPriceWithTax: number;
    let productId: string;

    // Test customer used by §2 customer-target / Shop-API parity.
    const VIP_EMAIL = 'variant-vip@example.com';
    const VIP_PASSWORD = 'variant1234';
    let vipCustomerId: string;
    let vipGroupId: string;

    beforeAll(async () => {
        // server.init() inline so the SqljsInitializer cache key resolves
        // to THIS spec file (otherwise every spec would share the helper's
        // cache → parallel-cold-start race).
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
            customerCount: 1,
        });
        f = await bootstrapPricelistFixtures(adminClient);

        const detail = await adminClient.query<any>(ADMIN_VARIANT, { id: f.variantV1Id });
        productId = String(detail.productVariant.product.id);
        standardPrice = detail.productVariant.price;
        standardPriceWithTax = detail.productVariant.priceWithTax;

        // A VIP customer in a targeted group — used by both §2 customer-id
        // resolution and the Shop-API parity cross-check.
        const cust = await adminClient.query(createCustomerDocument, {
            input: {
                firstName: 'Variant',
                lastName: 'VIP',
                emailAddress: VIP_EMAIL,
            },
            password: VIP_PASSWORD,
        });
        vipCustomerId = String((cust.createCustomer as any).id);
        const grp = await adminClient.query(createCustomerGroupDocument, {
            input: { name: 'VariantQueriesVIP' },
        });
        vipGroupId = String(grp.createCustomerGroup.id);
        await adminClient.query(addCustomersToGroupDocument, {
            groupId: vipGroupId,
            customerIds: [vipCustomerId],
        });
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    }, TEST_SETUP_TIMEOUT_MS);

    // Create a list with one cell on a chosen variant. Returns its id and
    // cleans up after the test through the standard DELETE_PRICE_LIST flow.
    async function makeList(opts: {
        code: string;
        name?: string;
        valueType?: 'ABSOLUTE' | 'PERCENTAGE';
        variantId: string;
        rows: Array<{ stepQuantity: number; value: number; currencyCode?: string }>;
        everyone?: boolean;
        groupId?: string;
    }): Promise<string> {
        const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: opts.code,
                valueType: opts.valueType ?? 'ABSOLUTE',
                groupId: opts.groupId ?? undefined,
                translations: [
                    { languageCode: 'en', name: opts.name ?? opts.code },
                ],
            },
        });
        const id = String(res.createPriceList.id);
        await adminClient.query<any>(SAVE_PIVOT, {
            input: {
                priceListId: id,
                productVariantId: opts.variantId,
                rows: opts.rows.map(r => ({
                    currencyCode: r.currencyCode ?? 'USD',
                    stepQuantity: r.stepQuantity,
                    value: r.value,
                })),
            },
        });
        if (opts.everyone) {
            await adminClient.query<any>(SET_EVERYONE, {
                priceListId: id,
                channelId: f.channelA.id,
                assigned: true,
            });
        }
        return id;
    }

    // ─── §1 priceListsForVariant ────────────────────────────────────
    describe('priceListsForVariant', () => {
        it('returns lists that contain an item for the variant; excludes lists with items only for other variants', async () => {
            const onV1 = await makeList({
                code: 'pl4v-on-v1',
                variantId: f.variantV1Id,
                rows: [{ stepQuantity: 1, value: 1000 }],
            });
            const onOther = await makeList({
                code: 'pl4v-on-v2',
                variantId: f.variantV2Id,
                rows: [{ stepQuantity: 1, value: 1000 }],
            });
            try {
                const res = await adminClient.query<any>(PRICE_LISTS_FOR_VARIANT, {
                    productVariantId: f.variantV1Id,
                });
                const ids = res.priceListsForVariant.items.map((l: any) => String(l.id));
                expect(ids).toContain(onV1);
                expect(ids).not.toContain(onOther);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: onV1 });
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: onOther });
            }
        });

        it('a list with cells in multiple currencies / tiers for one variant still yields ONE row', async () => {
            const listId = await makeList({
                code: 'pl4v-dedup',
                variantId: f.variantV1Id,
                rows: [
                    { stepQuantity: 1, value: 1000 },
                    { stepQuantity: 10, value: 900 },
                    { stepQuantity: 1, value: 950, currencyCode: 'EUR' },
                    { stepQuantity: 10, value: 850, currencyCode: 'EUR' },
                ],
            });
            try {
                const res = await adminClient.query<any>(PRICE_LISTS_FOR_VARIANT, {
                    productVariantId: f.variantV1Id,
                });
                const matches = res.priceListsForVariant.items.filter(
                    (l: any) => String(l.id) === listId,
                );
                expect(matches).toHaveLength(1);
                // Items returned are full `PriceList` entities, not per-cell.
                expect(matches[0].code).toBe('pl4v-dedup');
                expect(matches[0].valueType).toBe('ABSOLUTE');
                expect(matches[0].name).toBe('pl4v-dedup');
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
            }
        });

        it('a variant with no list returns an empty result', async () => {
            const res = await adminClient.query<any>(PRICE_LISTS_FOR_VARIANT, {
                productVariantId: f.variantV1Id,
            });
            // No leftover lists from earlier `try { … } finally { DELETE }`
            // pairs — every test cleans up after itself, so a fresh query
            // here sees nothing.
            expect(res.priceListsForVariant.items).toHaveLength(0);
            expect(res.priceListsForVariant.totalItems).toBe(0);
        });

        it('excludes soft-deleted lists', async () => {
            const listId = await makeList({
                code: 'pl4v-deleted',
                variantId: f.variantV1Id,
                rows: [{ stepQuantity: 1, value: 100 }],
            });
            // Visible before soft-delete.
            let res = await adminClient.query<any>(PRICE_LISTS_FOR_VARIANT, {
                productVariantId: f.variantV1Id,
            });
            expect(res.priceListsForVariant.items.map((l: any) => String(l.id))).toContain(
                listId,
            );

            await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });

            res = await adminClient.query<any>(PRICE_LISTS_FOR_VARIANT, {
                productVariantId: f.variantV1Id,
            });
            expect(res.priceListsForVariant.items.map((l: any) => String(l.id))).not.toContain(
                listId,
            );
        });

        it('excludes lists that exist only on another channel', async () => {
            // List created on B, with an item for V2 (V2 lives in both A and
            // B). Querying for V2 from channel A must NOT see this list.
            adminClient.setChannelToken(f.channelB.token);
            const onBOnly = await makeList({
                code: 'pl4v-on-b-only',
                variantId: f.variantV2Id,
                rows: [{ stepQuantity: 1, value: 500 }],
            });
            try {
                adminClient.setChannelToken(f.channelA.token);
                const res = await adminClient.query<any>(PRICE_LISTS_FOR_VARIANT, {
                    productVariantId: f.variantV2Id,
                });
                expect(res.priceListsForVariant.items.map((l: any) => String(l.id))).not.toContain(
                    onBOnly,
                );
            } finally {
                adminClient.setChannelToken(f.channelB.token);
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: onBOnly });
                adminClient.setChannelToken(f.channelA.token);
            }
        });

        it('paginates correctly — skip/take with totalItems', async () => {
            const ids: string[] = [];
            for (let i = 0; i < 3; i++) {
                ids.push(
                    await makeList({
                        code: `pl4v-page-${i}`,
                        variantId: f.variantV1Id,
                        rows: [{ stepQuantity: 1, value: 100 + i }],
                    }),
                );
            }
            try {
                const page1 = await adminClient.query<any>(PRICE_LISTS_FOR_VARIANT, {
                    productVariantId: f.variantV1Id,
                    options: { take: 2 },
                });
                expect(page1.priceListsForVariant.totalItems).toBe(3);
                expect(page1.priceListsForVariant.items).toHaveLength(2);

                const page2 = await adminClient.query<any>(PRICE_LISTS_FOR_VARIANT, {
                    productVariantId: f.variantV1Id,
                    options: { skip: 2, take: 2 },
                });
                expect(page2.priceListsForVariant.totalItems).toBe(3);
                expect(page2.priceListsForVariant.items).toHaveLength(1);

                const seen = new Set([
                    ...page1.priceListsForVariant.items.map((l: any) => String(l.id)),
                    ...page2.priceListsForVariant.items.map((l: any) => String(l.id)),
                ]);
                expect(seen.size).toBe(3);
                for (const id of ids) expect(seen.has(id)).toBe(true);
            } finally {
                for (const id of ids) {
                    await adminClient.query<any>(DELETE_PRICE_LIST, { id });
                }
            }
        });
    });

    // ─── §2 simulateVariantPrice ────────────────────────────────────
    describe('simulateVariantPrice', () => {
        function rawId(maybePrefixed: string): string {
            return maybePrefixed.replace(/^T_/, '');
        }

        it('anonymous + no list applies → standardPrice = catalog, resolvedPrice null, source null, provenance []', async () => {
            const res = await adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
                input: {
                    productVariantId: f.variantV1Id,
                    currencyCode: 'USD',
                    quantity: 1,
                },
            });
            const sim = res.simulateVariantPrice;
            expect(sim.standardPrice).toBe(standardPrice);
            expect(sim.standardPriceWithTax).toBe(standardPriceWithTax);
            expect(sim.resolvedPrice).toBeNull();
            expect(sim.resolvedPriceWithTax).toBeNull();
            expect(sim.source).toBeNull();
            expect(sim.provenance).toEqual([]);
        });

        it('anonymous + everyone-list applies → resolvedPrice = list value, provenance carries the list', async () => {
            const target = Math.floor(standardPrice / 2);
            const listId = await makeList({
                code: 'sim-anon-everyone',
                variantId: f.variantV1Id,
                rows: [{ stepQuantity: 1, value: target }],
                everyone: true,
            });
            try {
                const res = await adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
                    input: {
                        productVariantId: f.variantV1Id,
                        currencyCode: 'USD',
                        quantity: 1,
                    },
                });
                const sim = res.simulateVariantPrice;
                expect(sim.resolvedPrice).toBe(target);
                expect(sim.resolvedPriceWithTax).toBeGreaterThan(target);
                expect(sim.source).toBe('CASCADE');
                expect(sim.provenance).toHaveLength(1);
                const entry = sim.provenance[0];
                expect(entry.listCode).toBe('sim-anon-everyone');
                expect(rawId(entry.listId)).toBe(rawId(listId));
                expect(entry.valueType).toBe('ABSOLUTE');
                expect(entry.value).toBe(target);
                expect(entry.stepQuantity).toBe(1);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
            }
        });

        it('customerGroup target → resolves a group-targeted list anonymous would not see', async () => {
            const target = Math.floor(standardPrice / 3);
            const listRes = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'sim-group-target',
                    valueType: 'ABSOLUTE',
                    translations: [{ languageCode: 'en', name: 'Group target' }],
                },
            });
            const listId = String(listRes.createPriceList.id);
            await adminClient.query<any>(SAVE_PIVOT, {
                input: {
                    priceListId: listId,
                    productVariantId: f.variantV1Id,
                    rows: [{ currencyCode: 'USD', stepQuantity: 1, value: target }],
                },
            });
            await adminClient.query<any>(ADD_CUSTOMER_GROUPS, {
                priceListId: listId,
                channelId: f.channelA.id,
                customerGroupIds: [vipGroupId],
            });
            try {
                const anon = await adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
                    input: {
                        productVariantId: f.variantV1Id,
                        currencyCode: 'USD',
                        quantity: 1,
                    },
                });
                expect(anon.simulateVariantPrice.resolvedPrice).toBeNull();

                const member = await adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
                    input: {
                        productVariantId: f.variantV1Id,
                        currencyCode: 'USD',
                        quantity: 1,
                        customerGroupId: vipGroupId,
                    },
                });
                expect(member.simulateVariantPrice.resolvedPrice).toBe(target);
                expect(member.simulateVariantPrice.provenance[0].listCode).toBe(
                    'sim-group-target',
                );
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
            }
        });

        it('customerId target equals customerGroup target when the customer belongs to that group', async () => {
            const target = Math.floor(standardPrice / 4);
            const listRes = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'sim-customer-vs-group',
                    valueType: 'ABSOLUTE',
                    translations: [{ languageCode: 'en', name: 'Customer vs group' }],
                },
            });
            const listId = String(listRes.createPriceList.id);
            await adminClient.query<any>(SAVE_PIVOT, {
                input: {
                    priceListId: listId,
                    productVariantId: f.variantV1Id,
                    rows: [{ currencyCode: 'USD', stepQuantity: 1, value: target }],
                },
            });
            await adminClient.query<any>(ADD_CUSTOMER_GROUPS, {
                priceListId: listId,
                channelId: f.channelA.id,
                customerGroupIds: [vipGroupId],
            });
            try {
                const byGroup = await adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
                    input: {
                        productVariantId: f.variantV1Id,
                        currencyCode: 'USD',
                        quantity: 1,
                        customerGroupId: vipGroupId,
                    },
                });
                const byCustomer = await adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
                    input: {
                        productVariantId: f.variantV1Id,
                        currencyCode: 'USD',
                        quantity: 1,
                        customerId: vipCustomerId,
                    },
                });
                expect(byCustomer.simulateVariantPrice.resolvedPrice).toBe(
                    byGroup.simulateVariantPrice.resolvedPrice,
                );
                expect(byCustomer.simulateVariantPrice.provenance).toEqual(
                    byGroup.simulateVariantPrice.provenance,
                );
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
            }
        });

        it('passing BOTH customerId and customerGroupId is rejected', async () => {
            await expect(
                adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
                    input: {
                        productVariantId: f.variantV1Id,
                        currencyCode: 'USD',
                        quantity: 1,
                        customerId: vipCustomerId,
                        customerGroupId: vipGroupId,
                    },
                }),
            ).rejects.toThrow(/either a customerId or a customerGroupId/i);
        });

        it('quantity < 1 is rejected', async () => {
            await expect(
                adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
                    input: {
                        productVariantId: f.variantV1Id,
                        currencyCode: 'USD',
                        quantity: 0,
                    },
                }),
            ).rejects.toThrow(/quantity must be a positive integer/i);
        });

        it('tier ladder — quantity selects the matching stepQuantity tier', async () => {
            const listId = await makeList({
                code: 'sim-tiers',
                variantId: f.variantV1Id,
                rows: [
                    { stepQuantity: 1, value: 1000 },
                    { stepQuantity: 10, value: 900 },
                    { stepQuantity: 50, value: 800 },
                ],
                everyone: true,
            });
            try {
                async function sim(q: number) {
                    const r = await adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
                        input: {
                            productVariantId: f.variantV1Id,
                            currencyCode: 'USD',
                            quantity: q,
                        },
                    });
                    return r.simulateVariantPrice;
                }

                const at1 = await sim(1);
                expect(at1.resolvedPrice).toBe(1000);
                expect(at1.provenance[0].stepQuantity).toBe(1);

                const at10 = await sim(10);
                expect(at10.resolvedPrice).toBe(900);
                expect(at10.provenance[0].stepQuantity).toBe(10);

                const at50 = await sim(50);
                expect(at50.resolvedPrice).toBe(800);
                expect(at50.provenance[0].stepQuantity).toBe(50);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
            }
        });

        it('PERCENTAGE list — provenance carries basis points; resolvedPrice applies the discount', async () => {
            const bps = 2500; // -25%
            const listId = await makeList({
                code: 'sim-percentage',
                valueType: 'PERCENTAGE',
                variantId: f.variantV1Id,
                rows: [{ stepQuantity: 1, value: bps }],
                everyone: true,
            });
            try {
                const res = await adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
                    input: {
                        productVariantId: f.variantV1Id,
                        currencyCode: 'USD',
                        quantity: 1,
                    },
                });
                const sim = res.simulateVariantPrice;
                expect(sim.provenance[0].valueType).toBe('PERCENTAGE');
                expect(sim.provenance[0].value).toBe(bps);
                // -25% applied to the standard catalog price (±1 minor unit
                // for the half-up rounding edge).
                const expected = Math.round(standardPrice * (1 - bps / 10000));
                expect(Math.abs(sim.resolvedPrice - expected)).toBeLessThanOrEqual(1);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
            }
        });

        it('cheapest-in-group selection — simulator matches the production Shop API for the same customer', async () => {
            // Two everyone-lists in the SAME (default) group on the same
            // variant; default selection is the cheapest within a group.
            const cheap = await makeList({
                code: 'sim-cheapest',
                variantId: f.variantV1Id,
                rows: [{ stepQuantity: 1, value: 100 }],
                everyone: true,
            });
            const pricey = await makeList({
                code: 'sim-pricey',
                variantId: f.variantV1Id,
                rows: [{ stepQuantity: 1, value: 200 }],
                everyone: true,
            });
            try {
                const sim = await adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
                    input: {
                        productVariantId: f.variantV1Id,
                        currencyCode: 'USD',
                        quantity: 1,
                        customerId: vipCustomerId,
                    },
                });
                expect(sim.simulateVariantPrice.resolvedPrice).toBe(100);
                expect(sim.simulateVariantPrice.provenance[0].listCode).toBe('sim-cheapest');

                // Shop-API parity for the SAME customer at qty=1.
                await shopClient.asUserWithCredentials(VIP_EMAIL, VIP_PASSWORD);
                try {
                    const shopRes = await shopClient.query<any>(SHOP_PRODUCT_PRICE, {
                        id: productId,
                    });
                    const v = shopRes.product.variants.find(
                        (x: any) => String(x.id) === f.variantV1Id,
                    );
                    expect(v.price).toBe(sim.simulateVariantPrice.resolvedPrice);
                    expect(v.priceWithTax).toBe(
                        sim.simulateVariantPrice.resolvedPriceWithTax,
                    );
                } finally {
                    await shopClient.asAnonymousUser();
                }
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: cheap });
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: pricey });
            }
        });

        it('HT/TTC consistency — *WithTax tracks the variant tax rate for both standard and resolved', async () => {
            const target = Math.floor(standardPrice / 5);
            const listId = await makeList({
                code: 'sim-tax-mode',
                variantId: f.variantV1Id,
                rows: [{ stepQuantity: 1, value: target }],
                everyone: true,
            });
            try {
                const res = await adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
                    input: {
                        productVariantId: f.variantV1Id,
                        currencyCode: 'USD',
                        quantity: 1,
                    },
                });
                const sim = res.simulateVariantPrice;
                // Standard tax ratio captured at startup. Resolved must
                // honour the same ratio (same tax category).
                const standardRatio = standardPriceWithTax / standardPrice;
                const resolvedRatio = sim.resolvedPriceWithTax / sim.resolvedPrice;
                expect(Math.abs(standardRatio - resolvedRatio)).toBeLessThan(0.001);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
            }
        });
    });

    // ─── §3 internal default-group custom field ─────────────────────
    describe('Channel.customFields.defaultPriceListGroup is internal', () => {
        it('is NOT exposed on activeChannel.customFields — query fails to validate', async () => {
            // Two possible GraphQL error wordings depending on whether the
            // schema generator gave `Channel.customFields` an object type
            // (other public fields present → "Cannot query field … on type
            // ChannelCustomFields") or the JSON fallback (this plugin is the
            // only consumer and only registers an `internal` field → the
            // whole `customFields` collapses to the JSON scalar and any
            // sub-selection is rejected by GraphQL validation).
            await expect(
                adminClient.query<any>(ACTIVE_CHANNEL_TRY_INTERNAL_FIELD),
            ).rejects.toThrow(
                /Cannot query field|must not have a selection|defaultPriceListGroup/i,
            );
        });

        it('priceListDefaultGroup still resolves the channel default', async () => {
            const res = await adminClient.query<any>(DEFAULT_GROUP, {
                channelId: f.channelA.id,
            });
            expect(res.priceListDefaultGroup.id).toBe(f.defaultGroupA.id);
        });

        it('setDefaultPriceListGroup still updates the channel default', async () => {
            const newGroup = await adminClient.query<any>(CREATE_GROUP, {
                input: {
                    code: 'vq-new-default',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'VQ new default' }],
                },
            });
            const newGroupId = String(newGroup.createPriceListGroup.id);
            try {
                await adminClient.query<any>(SET_DEFAULT_GROUP, {
                    channelId: f.channelA.id,
                    groupId: newGroupId,
                });
                const after = await adminClient.query<any>(DEFAULT_GROUP, {
                    channelId: f.channelA.id,
                });
                expect(after.priceListDefaultGroup.id).toBe(newGroupId);
            } finally {
                // Restore the original default so siblings using the
                // default-group fallback aren't disturbed.
                await adminClient.query<any>(SET_DEFAULT_GROUP, {
                    channelId: f.channelA.id,
                    groupId: f.defaultGroupA.id,
                });
            }
        });
    });

    // ─── §4 permissions ─────────────────────────────────────────────
    describe('Permissions', () => {
        const PERM_PASSWORD = 'permtest1234';

        async function asLimitedAdmin(
            tag: string,
            permissions: string[],
        ): Promise<{ email: string }> {
            const role = await adminClient.query<any>(CREATE_ROLE, {
                input: {
                    code: `vq-role-${tag}`,
                    description: `VQ role: ${tag}`,
                    permissions,
                    channelIds: [f.channelA.id],
                },
            });
            const email = `vq-admin-${tag}@example.com`;
            await adminClient.query<any>(CREATE_ADMIN, {
                input: {
                    firstName: 'VQ',
                    lastName: tag,
                    emailAddress: email,
                    password: PERM_PASSWORD,
                    roleIds: [String(role.createRole.id)],
                },
            });
            return { email };
        }

        async function restore() {
            await adminClient.asSuperAdmin();
            adminClient.setChannelToken(f.channelA.token);
        }

        it('priceListsForVariant requires ReadPriceList', async () => {
            const { email } = await asLimitedAdmin('no-read-pl', ['Authenticated']);
            try {
                await adminClient.asUserWithCredentials(email, PERM_PASSWORD);
                adminClient.setChannelToken(f.channelA.token);
                await expect(
                    adminClient.query<any>(PRICE_LISTS_FOR_VARIANT, {
                        productVariantId: f.variantV1Id,
                    }),
                ).rejects.toThrow(/authori[sz]ed|permission|forbidden/i);
            } finally {
                await restore();
            }
        });

        it('simulateVariantPrice requires ReadPriceList', async () => {
            const { email } = await asLimitedAdmin('no-read-pl-sim', [
                'Authenticated',
            ]);
            try {
                await adminClient.asUserWithCredentials(email, PERM_PASSWORD);
                adminClient.setChannelToken(f.channelA.token);
                await expect(
                    adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
                        input: {
                            productVariantId: f.variantV1Id,
                            currencyCode: 'USD',
                            quantity: 1,
                        },
                    }),
                ).rejects.toThrow(/authori[sz]ed|permission|forbidden/i);
            } finally {
                await restore();
            }
        });
    });
});
