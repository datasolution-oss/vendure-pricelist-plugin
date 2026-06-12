import { DefaultJobQueuePlugin, mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../e2e-common/test-config';
import { PricelistPlugin } from '../src/pricelist.plugin';

import {
    ADD_CUSTOMER_GROUPS,
    ADD_CUSTOMERS,
    ASSIGN_TO_CHANNEL,
    ASSIGNED_CUSTOMERS,
    ASSIGNED_GROUPS,
    CHANNEL_ACCESS,
    CREATE_PRICE_LIST,
    REMOVE_CUSTOMER_GROUPS,
    REMOVE_CUSTOMERS,
    SET_EVERYONE,
} from './graphql/pricelist-operations';
import { bootstrapPricelistFixtures, PricelistTestFixtures } from './pricelist-test-env';

describe('PriceListChannelAccess', () => {
    const { server, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [PricelistPlugin, DefaultJobQueuePlugin],
        }),
    );

    let f: PricelistTestFixtures;
    let listId: string;

    beforeAll(async () => {
        // server.init() inline so the SqljsInitializer cache key resolves
        // to THIS spec file (otherwise every spec shares the helper's
        // cache → parallel-cold-start race).
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
            customerCount: 2,
        });
        f = await bootstrapPricelistFixtures(adminClient);

        const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: 'access-list',
                valueType: 'ABSOLUTE',
                priority: 1,
                translations: [{ languageCode: 'en', name: 'Access list' }],
            },
        });
        listId = String(res.createPriceList.id);
        // Share to B so per-channel access on B is meaningful.
        await adminClient.query<any>(ASSIGN_TO_CHANNEL, {
            input: { priceListId: listId, channelId: f.channelB.id },
        });
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    }, TEST_SETUP_TIMEOUT_MS);

    it('setPriceListAssignedToEveryone reflects on priceListChannelAccess', async () => {
        const res = await adminClient.query<any>(SET_EVERYONE, {
            priceListId: listId,
            channelId: f.channelA.id,
            assigned: true,
        });
        expect(res.setPriceListAssignedToEveryone.assignedToEveryone).toBe(true);
        expect(res.setPriceListAssignedToEveryone.channel.id).toBe(f.channelA.id);

        const check = await adminClient.query<any>(CHANNEL_ACCESS, {
            priceListId: listId,
            channelId: f.channelA.id,
        });
        expect(check.priceListChannelAccess.assignedToEveryone).toBe(true);
    });

    it('addCustomers / removeCustomers — paginated lookup reflects the membership', async () => {
        await adminClient.query<any>(ADD_CUSTOMERS, {
            priceListId: listId,
            channelId: f.channelA.id,
            customerIds: f.customerIds.slice(0, 2),
        });
        const after = await adminClient.query<any>(ASSIGNED_CUSTOMERS, {
            priceListId: listId,
            channelId: f.channelA.id,
            options: { take: 50 },
        });
        expect(after.priceListAssignedCustomers.totalItems).toBe(2);
        const got = after.priceListAssignedCustomers.items.map((c: any) => String(c.id)).sort();
        expect(got).toEqual([...f.customerIds.slice(0, 2)].sort());

        await adminClient.query<any>(REMOVE_CUSTOMERS, {
            priceListId: listId,
            channelId: f.channelA.id,
            customerIds: [f.customerIds[0]],
        });
        const post = await adminClient.query<any>(ASSIGNED_CUSTOMERS, {
            priceListId: listId,
            channelId: f.channelA.id,
            options: { take: 50 },
        });
        expect(post.priceListAssignedCustomers.totalItems).toBe(1);
        expect(String(post.priceListAssignedCustomers.items[0].id)).toBe(f.customerIds[1]);
    });

    it('addCustomerGroups / removeCustomerGroups — paginated lookup reflects the membership', async () => {
        await adminClient.query<any>(ADD_CUSTOMER_GROUPS, {
            priceListId: listId,
            channelId: f.channelA.id,
            customerGroupIds: [f.customerGroupId],
        });
        const after = await adminClient.query<any>(ASSIGNED_GROUPS, {
            priceListId: listId,
            channelId: f.channelA.id,
            options: { take: 50 },
        });
        expect(after.priceListAssignedCustomerGroups.totalItems).toBe(1);
        expect(String(after.priceListAssignedCustomerGroups.items[0].id)).toBe(
            f.customerGroupId,
        );

        await adminClient.query<any>(REMOVE_CUSTOMER_GROUPS, {
            priceListId: listId,
            channelId: f.channelA.id,
            customerGroupIds: [f.customerGroupId],
        });
        const post = await adminClient.query<any>(ASSIGNED_GROUPS, {
            priceListId: listId,
            channelId: f.channelA.id,
            options: { take: 50 },
        });
        expect(post.priceListAssignedCustomerGroups.totalItems).toBe(0);
    });

    it('priceListAssignedCustomers paginates correctly — skip/take/totalItems + filter', async () => {
        // Assign both customers; verify pagination, then filter by email.
        await adminClient.query<any>(ADD_CUSTOMERS, {
            priceListId: listId,
            channelId: f.channelA.id,
            customerIds: f.customerIds.slice(0, 2),
        });
        try {
            const page1 = await adminClient.query<any>(ASSIGNED_CUSTOMERS, {
                priceListId: listId,
                channelId: f.channelA.id,
                options: { take: 1 },
            });
            expect(page1.priceListAssignedCustomers.totalItems).toBe(2);
            expect(page1.priceListAssignedCustomers.items).toHaveLength(1);

            const page2 = await adminClient.query<any>(ASSIGNED_CUSTOMERS, {
                priceListId: listId,
                channelId: f.channelA.id,
                options: { skip: 1, take: 1 },
            });
            expect(page2.priceListAssignedCustomers.totalItems).toBe(2);
            expect(page2.priceListAssignedCustomers.items).toHaveLength(1);
            expect(page2.priceListAssignedCustomers.items[0].id).not.toBe(
                page1.priceListAssignedCustomers.items[0].id,
            );

            // Filter substring on email. The first customer's email
            // contains a unique fragment; the populate-customers helper
            // generates predictable addresses like `hayden.zieme@…`.
            const sampleEmail: string =
                page1.priceListAssignedCustomers.items[0].emailAddress;
            const fragment = sampleEmail.split('@')[0];
            const filtered = await adminClient.query<any>(ASSIGNED_CUSTOMERS, {
                priceListId: listId,
                channelId: f.channelA.id,
                options: { filter: fragment, take: 50 },
            });
            expect(filtered.priceListAssignedCustomers.totalItems).toBeGreaterThanOrEqual(1);
            for (const c of filtered.priceListAssignedCustomers.items) {
                expect(c.emailAddress.toLowerCase()).toContain(fragment.toLowerCase());
            }
        } finally {
            // Restore the channel A access row to empty so subsequent
            // tests (which read this row) aren't surprised.
            await adminClient.query<any>(REMOVE_CUSTOMERS, {
                priceListId: listId,
                channelId: f.channelA.id,
                customerIds: f.customerIds.slice(0, 2),
            });
        }
    });

    it('priceListAssignedCustomerGroups filter matches by name substring', async () => {
        await adminClient.query<any>(ADD_CUSTOMER_GROUPS, {
            priceListId: listId,
            channelId: f.channelA.id,
            customerGroupIds: [f.customerGroupId],
        });
        try {
            const matching = await adminClient.query<any>(ASSIGNED_GROUPS, {
                priceListId: listId,
                channelId: f.channelA.id,
                options: { filter: 'whole', take: 50 },
            });
            expect(matching.priceListAssignedCustomerGroups.totalItems).toBe(1);
            expect(matching.priceListAssignedCustomerGroups.items[0].name).toMatch(/whole/i);

            const noMatch = await adminClient.query<any>(ASSIGNED_GROUPS, {
                priceListId: listId,
                channelId: f.channelA.id,
                options: { filter: 'no-such-group-name-xyz', take: 50 },
            });
            expect(noMatch.priceListAssignedCustomerGroups.totalItems).toBe(0);
        } finally {
            await adminClient.query<any>(REMOVE_CUSTOMER_GROUPS, {
                priceListId: listId,
                channelId: f.channelA.id,
                customerGroupIds: [f.customerGroupId],
            });
        }
    });

    it('access mutation with channelId ≠ active channel is rejected', async () => {
        // Active is A; pass B as channelId — the guard requires they match.
        await expect(
            adminClient.query<any>(SET_EVERYONE, {
                priceListId: listId,
                channelId: f.channelB.id,
                assigned: true,
            }),
        ).rejects.toThrow(/channel it applies to/i);
    });

    it('access mutation on a channel the list is not shared to is rejected', async () => {
        // Fresh list owned by A, never shared to B. Switch active to B and
        // call setEveryone(channelId=B, …) — passes the active-channel
        // guard but fails the share check with PRICELIST_NOT_SHARED_TO_CHANNEL.
        const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: 'access-not-shared',
                valueType: 'ABSOLUTE',
                priority: 1,
                translations: [{ languageCode: 'en', name: 'Access not shared' }],
            },
        });
        const isolatedListId = String(res.createPriceList.id);

        adminClient.setChannelToken(f.channelB.token);
        try {
            await expect(
                adminClient.query<any>(SET_EVERYONE, {
                    priceListId: isolatedListId,
                    channelId: f.channelB.id,
                    assigned: true,
                }),
            ).rejects.toThrow(/PRICELIST_NOT_SHARED_TO_CHANNEL/);
        } finally {
            adminClient.setChannelToken(f.channelA.token);
        }
    });

    it('access is independent per channel — everyone-true on A leaves B untouched', async () => {
        // A was set to everyone=true earlier; B was never touched.
        // Reading B's access row requires the active channel to be B (the
        // mutation API guard is per-channel).
        adminClient.setChannelToken(f.channelB.token);
        try {
            const bAccess = await adminClient.query<any>(CHANNEL_ACCESS, {
                priceListId: listId,
                channelId: f.channelB.id,
            });
            // Either there's no row yet, or there is one but
            // assignedToEveryone is false — both satisfy "untouched".
            if (bAccess.priceListChannelAccess) {
                expect(bAccess.priceListChannelAccess.assignedToEveryone).toBe(false);
            } else {
                expect(bAccess.priceListChannelAccess).toBeNull();
            }
        } finally {
            adminClient.setChannelToken(f.channelA.token);
        }
    });
});
