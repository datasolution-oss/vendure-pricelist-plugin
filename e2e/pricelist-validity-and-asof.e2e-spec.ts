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
    CREATE_PRICE_LIST,
    DELETE_PRICE_LIST,
    SAVE_PIVOT,
    SET_EVERYONE,
    SIMULATE_VARIANT_PRICE,
} from './graphql/pricelist-operations';
import {
    addCustomersToGroupDocument,
    createCustomerDocument,
    createCustomerGroupDocument,
} from './graphql/shared-definitions';
import { bootstrapPricelistFixtures, PricelistTestFixtures } from './pricelist-test-env';

// Date-validity + `asOf` preview coverage for `simulateVariantPrice`.
// Predicate contract (DateValidityPredicate): `start ?? -∞ <= t <= end ?? +∞`,
// inclusive on both ends. `t = opts.asOf ?? now`. When `asOf` is set the
// resolution-strategy cache is bypassed for read AND write so the simulator
// preview cannot poison live pricing for real shoppers.

const SHOP_PRODUCT_PRICE = gql`
    query ShopProductPriceVA($id: ID!) {
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
    query AdminVariantVA($id: ID!) {
        productVariant(id: $id) {
            id
            price
            product {
                id
            }
        }
    }
`;

describe('Date validity + asOf preview', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [PricelistPlugin, DefaultJobQueuePlugin],
        }),
    );

    let f: PricelistTestFixtures;
    let productId: string;
    let standardPrice: number;
    // Baseline list in the channel-A default group: cheapest-among-applicable
    // selection makes the dated list visible in `resolvedPrice` /
    // `provenance[].listCode` whenever it's valid (its value is HALF of
    // baseline). When the dated list is excluded, the baseline wins.
    const BASELINE_VALUE = 200_00;
    const DATED_VALUE = 100_00;
    let baselineId: string;

    // Customer + group for the §4 spot-check that a non-anonymous target
    // honours `asOf` the same way as anonymous.
    const TARGET_EMAIL = 'asof-target@example.com';
    const TARGET_PASSWORD = 'asof1234';
    let targetGroupId: string;

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
            customerCount: 0,
        });
        f = await bootstrapPricelistFixtures(adminClient);

        const detail = await adminClient.query<any>(ADMIN_VARIANT, { id: f.variantV1Id });
        productId = String(detail.productVariant.product.id);
        standardPrice = detail.productVariant.price;

        // Baseline: undated, applies always, cheaper than catalog but more
        // expensive than the dated lists we'll layer on top.
        baselineId = await makeList({
            code: 'baseline-undated',
            value: BASELINE_VALUE,
            everyone: true,
        });

        // Customer + group for §4 non-anonymous spot-check.
        const cust = await adminClient.query(createCustomerDocument, {
            input: {
                firstName: 'AsOf',
                lastName: 'Target',
                emailAddress: TARGET_EMAIL,
            },
            password: TARGET_PASSWORD,
        });
        const customerId = String((cust.createCustomer as any).id);
        const grp = await adminClient.query(createCustomerGroupDocument, {
            input: { name: 'AsOfTargetGroup' },
        });
        targetGroupId = String(grp.createCustomerGroup.id);
        await adminClient.query(addCustomersToGroupDocument, {
            groupId: targetGroupId,
            customerIds: [customerId],
        });
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    }, TEST_SETUP_TIMEOUT_MS);

    async function makeList(opts: {
        code: string;
        value: number;
        everyone?: boolean;
        startDate?: Date | null;
        endDate?: Date | null;
    }): Promise<string> {
        const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: opts.code,
                valueType: 'ABSOLUTE',
                startDate:
                    opts.startDate === undefined ? null : opts.startDate?.toISOString() ?? null,
                endDate:
                    opts.endDate === undefined ? null : opts.endDate?.toISOString() ?? null,
                translations: [{ languageCode: 'en', name: opts.code }],
            },
        });
        const id = String(res.createPriceList.id);
        await adminClient.query<any>(SAVE_PIVOT, {
            input: {
                priceListId: id,
                productVariantId: f.variantV1Id,
                rows: [{ currencyCode: 'USD', stepQuantity: 1, value: opts.value }],
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

    async function simulate(input: {
        quantity?: number;
        customerId?: string;
        customerGroupId?: string;
        at?: Date;
    } = {}): Promise<any> {
        const res = await adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
            input: {
                productVariantId: f.variantV1Id,
                currencyCode: 'USD',
                quantity: input.quantity ?? 1,
                customerId: input.customerId,
                customerGroupId: input.customerGroupId,
                at: input.at ? input.at.toISOString() : undefined,
            },
        });
        return res.simulateVariantPrice;
    }

    async function shopAnonPrice(): Promise<number> {
        await shopClient.asAnonymousUser();
        const res = await shopClient.query<any>(SHOP_PRODUCT_PRICE, { id: productId });
        const v = res.product.variants.find((x: any) => String(x.id) === f.variantV1Id);
        return v.price;
    }

    // Relative time helpers — explicit absolute UTC ISO instants. Tests
    // build dates from `Date.now() ± N` so they don't rot.
    const ONE_HOUR = 3600_000;
    const ONE_DAY = 24 * ONE_HOUR;
    const TEN_DAYS = 10 * ONE_DAY;
    const TWENTY_DAYS = 20 * ONE_DAY;

    // ─── §3 Date-validity matrix (no `at`) ──────────────────────────
    describe('Date-validity matrix at "now"', () => {
        it('row 1 — start=null, end=null → applies (always valid)', async () => {
            const id = await makeList({
                code: 'mx-1-null-null',
                value: DATED_VALUE,
                everyone: true,
                startDate: null,
                endDate: null,
            });
            try {
                const sim = await simulate();
                expect(sim.resolvedPrice).toBe(DATED_VALUE);
                expect(sim.provenance.map((p: any) => p.listCode)).toContain(
                    'mx-1-null-null',
                );
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('row 2 — start=past, end=null → applies', async () => {
            const id = await makeList({
                code: 'mx-2-past-null',
                value: DATED_VALUE,
                everyone: true,
                startDate: new Date(Date.now() - ONE_DAY),
                endDate: null,
            });
            try {
                const sim = await simulate();
                expect(sim.resolvedPrice).toBe(DATED_VALUE);
                expect(sim.provenance.map((p: any) => p.listCode)).toContain(
                    'mx-2-past-null',
                );
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('row 3 — start=future, end=null → excluded (scheduled)', async () => {
            const id = await makeList({
                code: 'mx-3-future-null',
                value: DATED_VALUE,
                everyone: true,
                startDate: new Date(Date.now() + ONE_DAY),
                endDate: null,
            });
            try {
                const sim = await simulate();
                expect(sim.resolvedPrice).toBe(BASELINE_VALUE);
                expect(sim.provenance.map((p: any) => p.listCode)).not.toContain(
                    'mx-3-future-null',
                );

                // Shop-API parity: same exclusion via the production path.
                expect(await shopAnonPrice()).toBe(BASELINE_VALUE);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('row 4 — start=null, end=past → excluded (expired)', async () => {
            const id = await makeList({
                code: 'mx-4-null-past',
                value: DATED_VALUE,
                everyone: true,
                startDate: null,
                endDate: new Date(Date.now() - ONE_HOUR),
            });
            try {
                const sim = await simulate();
                expect(sim.resolvedPrice).toBe(BASELINE_VALUE);
                expect(sim.provenance.map((p: any) => p.listCode)).not.toContain(
                    'mx-4-null-past',
                );
                expect(await shopAnonPrice()).toBe(BASELINE_VALUE);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('row 5 — start=null, end=future → applies', async () => {
            const id = await makeList({
                code: 'mx-5-null-future',
                value: DATED_VALUE,
                everyone: true,
                startDate: null,
                endDate: new Date(Date.now() + ONE_DAY),
            });
            try {
                const sim = await simulate();
                expect(sim.resolvedPrice).toBe(DATED_VALUE);
                expect(sim.provenance.map((p: any) => p.listCode)).toContain(
                    'mx-5-null-future',
                );
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('row 6 — start=past, end=future → applies (active window)', async () => {
            const id = await makeList({
                code: 'mx-6-past-future',
                value: DATED_VALUE,
                everyone: true,
                startDate: new Date(Date.now() - ONE_DAY),
                endDate: new Date(Date.now() + ONE_DAY),
            });
            try {
                const sim = await simulate();
                expect(sim.resolvedPrice).toBe(DATED_VALUE);
                expect(sim.provenance.map((p: any) => p.listCode)).toContain(
                    'mx-6-past-future',
                );
                expect(await shopAnonPrice()).toBe(DATED_VALUE);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('row 7 — start=future, end=future → excluded (not started)', async () => {
            const id = await makeList({
                code: 'mx-7-future-future',
                value: DATED_VALUE,
                everyone: true,
                startDate: new Date(Date.now() + ONE_DAY),
                endDate: new Date(Date.now() + 2 * ONE_DAY),
            });
            try {
                const sim = await simulate();
                expect(sim.resolvedPrice).toBe(BASELINE_VALUE);
                expect(sim.provenance.map((p: any) => p.listCode)).not.toContain(
                    'mx-7-future-future',
                );
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('row 8 — start=past, end=past → excluded (expired)', async () => {
            const id = await makeList({
                code: 'mx-8-past-past',
                value: DATED_VALUE,
                everyone: true,
                startDate: new Date(Date.now() - 2 * ONE_DAY),
                endDate: new Date(Date.now() - ONE_DAY),
            });
            try {
                const sim = await simulate();
                expect(sim.resolvedPrice).toBe(BASELINE_VALUE);
                expect(sim.provenance.map((p: any) => p.listCode)).not.toContain(
                    'mx-8-past-past',
                );
                expect(await shopAnonPrice()).toBe(BASELINE_VALUE);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('row 9 — start≈now, end=future → applies (inclusive lower bound)', async () => {
            // startDate slightly in the past so resolve()'s "now" is
            // unambiguously >= startDate; predicate is `start <= t` so this
            // exercises the inclusive boundary.
            const id = await makeList({
                code: 'mx-9-start-eq-now',
                value: DATED_VALUE,
                everyone: true,
                startDate: new Date(Date.now() - 100),
                endDate: new Date(Date.now() + ONE_DAY),
            });
            try {
                const sim = await simulate();
                expect(sim.resolvedPrice).toBe(DATED_VALUE);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('row 10 — start=past, end≈now → applies (inclusive upper bound)', async () => {
            // endDate a few seconds in the future so resolve()'s "now"
            // is still <= endDate even after setup latency. Exercises the
            // `t <= end` inclusive upper boundary.
            const id = await makeList({
                code: 'mx-10-end-eq-now',
                value: DATED_VALUE,
                everyone: true,
                startDate: new Date(Date.now() - ONE_DAY),
                endDate: new Date(Date.now() + 5000),
            });
            try {
                const sim = await simulate();
                expect(sim.resolvedPrice).toBe(DATED_VALUE);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });
    });

    // ─── §4 asOf preview ────────────────────────────────────────────
    describe('asOf preview', () => {
        it('future-scheduled list — excluded now, applies at asOf inside its window', async () => {
            const start = new Date(Date.now() + TEN_DAYS);
            const id = await makeList({
                code: 'asof-future',
                value: DATED_VALUE,
                everyone: true,
                startDate: start,
            });
            try {
                const atNow = await simulate();
                expect(atNow.resolvedPrice).toBe(BASELINE_VALUE);

                const atFuture = await simulate({
                    at: new Date(Date.now() + TWENTY_DAYS),
                });
                expect(atFuture.resolvedPrice).toBe(DATED_VALUE);
                expect(
                    atFuture.provenance.map((p: any) => p.listCode),
                ).toContain('asof-future');
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('expired list — excluded now, applies at asOf inside its past window', async () => {
            const end = new Date(Date.now() - ONE_DAY);
            const id = await makeList({
                code: 'asof-expired',
                value: DATED_VALUE,
                everyone: true,
                endDate: end,
            });
            try {
                const atNow = await simulate();
                expect(atNow.resolvedPrice).toBe(BASELINE_VALUE);

                const atPast = await simulate({
                    at: new Date(Date.now() - TEN_DAYS),
                });
                expect(atPast.resolvedPrice).toBe(DATED_VALUE);
                expect(atPast.provenance.map((p: any) => p.listCode)).toContain(
                    'asof-expired',
                );
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('asOf exact boundary — at == start (applies) and at == start-1ms (excluded)', async () => {
            const start = new Date(Date.now() + TEN_DAYS);
            const id = await makeList({
                code: 'asof-bound-start',
                value: DATED_VALUE,
                everyone: true,
                startDate: start,
            });
            try {
                const atExact = await simulate({ at: start });
                expect(atExact.resolvedPrice).toBe(DATED_VALUE);

                const justBefore = await simulate({
                    at: new Date(start.getTime() - 1),
                });
                expect(justBefore.resolvedPrice).toBe(BASELINE_VALUE);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('asOf exact boundary — at == end (applies) and at == end+1ms (excluded)', async () => {
            const end = new Date(Date.now() + TEN_DAYS);
            const id = await makeList({
                code: 'asof-bound-end',
                value: DATED_VALUE,
                everyone: true,
                endDate: end,
            });
            try {
                const atExact = await simulate({ at: end });
                expect(atExact.resolvedPrice).toBe(DATED_VALUE);

                const justAfter = await simulate({
                    at: new Date(end.getTime() + 1),
                });
                expect(justAfter.resolvedPrice).toBe(BASELINE_VALUE);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('asOf omitted behaves identically to the "now" matrix (cross-check)', async () => {
            // Same scenario as matrix row 3 (future startDate) — both shapes
            // (with and without `at`) must agree when `at` is omitted.
            const id = await makeList({
                code: 'asof-no-at',
                value: DATED_VALUE,
                everyone: true,
                startDate: new Date(Date.now() + ONE_DAY),
            });
            try {
                const noAt = await simulate();
                const withAtUndefined = await simulate({ at: undefined });
                expect(noAt.resolvedPrice).toBe(BASELINE_VALUE);
                expect(withAtUndefined.resolvedPrice).toBe(BASELINE_VALUE);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('non-anonymous target honours asOf the same way as anonymous', async () => {
            // Future list targeted at a customer group. Anonymous never
            // sees it; the targeted customer-group sees it only when
            // `at` is inside the window.
            const start = new Date(Date.now() + TEN_DAYS);
            const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'asof-targeted',
                    valueType: 'ABSOLUTE',
                    startDate: start.toISOString(),
                    translations: [{ languageCode: 'en', name: 'AsOf targeted' }],
                },
            });
            const listId = String(res.createPriceList.id);
            await adminClient.query<any>(SAVE_PIVOT, {
                input: {
                    priceListId: listId,
                    productVariantId: f.variantV1Id,
                    rows: [{ currencyCode: 'USD', stepQuantity: 1, value: DATED_VALUE }],
                },
            });
            await adminClient.query<any>(ADD_CUSTOMER_GROUPS, {
                priceListId: listId,
                channelId: f.channelA.id,
                customerGroupIds: [targetGroupId],
            });
            try {
                const atNow = await simulate({ customerGroupId: targetGroupId });
                expect(atNow.resolvedPrice).toBe(BASELINE_VALUE);

                const atFuture = await simulate({
                    customerGroupId: targetGroupId,
                    at: new Date(Date.now() + TWENTY_DAYS),
                });
                expect(atFuture.resolvedPrice).toBe(DATED_VALUE);
                expect(
                    atFuture.provenance.map((p: any) => p.listCode),
                ).toContain('asof-targeted');
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
            }
        });
    });

    // ─── §5 cache lock — the critical part ──────────────────────────
    // Each test builds its own future list. The TypeORM cache invalidator
    // wipes the resolution cache on every list insert/update/delete, so each
    // test starts with a clean cache regardless of order.
    describe('cache lock — no live-pricing corruption', () => {
        it('§5.1 no poison on write — asOf preview does not write the dated result to the cache', async () => {
            const id = await makeList({
                code: 'cache-no-poison',
                value: DATED_VALUE,
                everyone: true,
                startDate: new Date(Date.now() + TEN_DAYS),
            });
            try {
                // Baseline reads (build the live "now" cache entry).
                const liveShop1 = await shopAnonPrice();
                const liveSim1 = await simulate();
                expect(liveShop1).toBe(BASELINE_VALUE);
                expect(liveSim1.resolvedPrice).toBe(BASELINE_VALUE);

                // asOf preview — must NOT persist its dated result.
                const previewed = await simulate({
                    at: new Date(Date.now() + TWENTY_DAYS),
                });
                expect(previewed.resolvedPrice).toBe(DATED_VALUE);

                // Re-query live: would be WRONG if `asOf` had poisoned the
                // shared cache. Asserts on resolvedPrice AND provenance so a
                // wrong candidate set is caught.
                const liveShop2 = await shopAnonPrice();
                const liveSim2 = await simulate();
                expect(liveShop2).toBe(BASELINE_VALUE);
                expect(liveSim2.resolvedPrice).toBe(BASELINE_VALUE);
                expect(
                    liveSim2.provenance.map((p: any) => p.listCode),
                ).not.toContain('cache-no-poison');
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('§5.2 no stale read — asOf returns the dated result even after a "now" cache entry has been warmed', async () => {
            const id = await makeList({
                code: 'cache-no-stale',
                value: DATED_VALUE,
                everyone: true,
                startDate: new Date(Date.now() + TEN_DAYS),
            });
            try {
                // Warm the "now" cache first.
                expect(await shopAnonPrice()).toBe(BASELINE_VALUE);
                expect((await simulate()).resolvedPrice).toBe(BASELINE_VALUE);

                // Preview at a future instant — must NOT read the warm "now"
                // entry; must re-resolve at asOf and surface the dated list.
                const previewed = await simulate({
                    at: new Date(Date.now() + TWENTY_DAYS),
                });
                expect(previewed.resolvedPrice).toBe(DATED_VALUE);
                expect(
                    previewed.provenance.map((p: any) => p.listCode),
                ).toContain('cache-no-stale');
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id });
            }
        });

        it('§5.3 repeatability — interleaved now/asOf-future/asOf-past/now stay constant', async () => {
            const futureId = await makeList({
                code: 'cache-repeat-future',
                value: DATED_VALUE,
                everyone: true,
                startDate: new Date(Date.now() + TEN_DAYS),
            });
            const expiredId = await makeList({
                code: 'cache-repeat-expired',
                value: DATED_VALUE,
                everyone: true,
                endDate: new Date(Date.now() - ONE_DAY),
            });
            try {
                async function snapshot() {
                    return {
                        now: (await simulate()).resolvedPrice,
                        asOfFuture: (
                            await simulate({
                                at: new Date(Date.now() + TWENTY_DAYS),
                            })
                        ).resolvedPrice,
                        asOfPast: (
                            await simulate({
                                at: new Date(Date.now() - TEN_DAYS),
                            })
                        ).resolvedPrice,
                    };
                }

                const a = await snapshot();
                const b = await snapshot();
                const c = await snapshot();

                // Every "now" must be the baseline (both dated lists
                // excluded); every dated `at` must surface its dated list.
                expect(a).toEqual({
                    now: BASELINE_VALUE,
                    asOfFuture: DATED_VALUE,
                    asOfPast: DATED_VALUE,
                });
                expect(b).toEqual(a);
                expect(c).toEqual(a);

                // And live shop price has stayed constant the whole time —
                // confirms no dated entry leaked into the shared cache.
                expect(await shopAnonPrice()).toBe(BASELINE_VALUE);
            } finally {
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: futureId });
                await adminClient.query<any>(DELETE_PRICE_LIST, { id: expiredId });
            }
        });
    });

    // ─── §6 guards (covered already in pricelist-variant-queries, but
    // re-asserted with `at` in the picture so the new parameter doesn't
    // bypass the guards) ───────────────────────────────────────────
    describe('guards', () => {
        it('customerId + customerGroupId together → rejected (even when `at` is set)', async () => {
            await expect(
                simulate({
                    customerId: 'T_1',
                    customerGroupId: 'T_1',
                    at: new Date(Date.now() + ONE_DAY),
                }),
            ).rejects.toThrow(/either a customerId or a customerGroupId/i);
        });

        it('quantity < 1 → rejected', async () => {
            await expect(simulate({ quantity: 0 })).rejects.toThrow(
                /quantity must be a positive integer/i,
            );
        });

        it('malformed `at` (non-DateTime) → GraphQL scalar parse error', async () => {
            await expect(
                adminClient.query<any>(SIMULATE_VARIANT_PRICE, {
                    input: {
                        productVariantId: f.variantV1Id,
                        currencyCode: 'USD',
                        quantity: 1,
                        at: 'not-a-date',
                    },
                }),
            ).rejects.toThrow(/DateTime|cannot represent|invalid/i);
        });
    });
});
