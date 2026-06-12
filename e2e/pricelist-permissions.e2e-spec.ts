import { DefaultJobQueuePlugin, mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../e2e-common/test-config';
import { PricelistPlugin } from '../src/pricelist.plugin';

import {
    ASSIGN_TO_CHANNEL,
    CREATE_ADMIN,
    CREATE_PRICE_LIST,
    CREATE_ROLE,
    PRICE_LISTS,
    SET_EVERYONE,
} from './graphql/pricelist-operations';
import { bootstrapPricelistFixtures, PricelistTestFixtures } from './pricelist-test-env';

describe('Pricelist permissions', () => {
    const { server, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [PricelistPlugin, DefaultJobQueuePlugin],
        }),
    );

    const PASSWORD = 'test1234';
    let f: PricelistTestFixtures;

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
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    }, TEST_SETUP_TIMEOUT_MS);

    // Restore the superadmin session + active channel after each test
    // so failures in one case don't poison the next.
    async function restore() {
        await adminClient.asSuperAdmin();
        adminClient.setChannelToken(f.channelA.token);
    }

    async function createRoleAndAdmin(
        tag: string,
        permissions: string[],
        channelIds: string[],
    ): Promise<{ emailAddress: string }> {
        const role = await adminClient.query<any>(CREATE_ROLE, {
            input: {
                code: `e2e-role-${tag}`,
                description: `E2E role: ${tag}`,
                permissions,
                channelIds,
            },
        });
        const emailAddress = `e2e-admin-${tag}@example.com`;
        await adminClient.query<any>(CREATE_ADMIN, {
            input: {
                firstName: 'E2E',
                lastName: tag,
                emailAddress,
                password: PASSWORD,
                roleIds: [String(role.createRole.id)],
            },
        });
        return { emailAddress };
    }

    it('ReadPriceList alone — can read but cannot create', async () => {
        const { emailAddress } = await createRoleAndAdmin(
            'reader',
            ['Authenticated', 'ReadPriceList'],
            [f.channelA.id],
        );
        try {
            await adminClient.asUserWithCredentials(emailAddress, PASSWORD);
            adminClient.setChannelToken(f.channelA.token);

            const list = await adminClient.query<any>(PRICE_LISTS, { options: { take: 5 } });
            expect(list.priceLists).toBeDefined();

            await expect(
                adminClient.query<any>(CREATE_PRICE_LIST, {
                    input: {
                        code: 'reader-attempt',
                        valueType: 'ABSOLUTE',
                        priority: 1,
                        translations: [{ languageCode: 'en', name: 'Reader attempt' }],
                    },
                }),
            ).rejects.toThrow(/authori[sz]ed|permission|forbidden/i);
        } finally {
            await restore();
        }
    });

    it('Full CRUD but no SharePriceList — can create, cannot share', async () => {
        const { emailAddress } = await createRoleAndAdmin(
            'editor-no-share',
            [
                'Authenticated',
                'ReadPriceList',
                'CreatePriceList',
                'UpdatePriceList',
                'DeletePriceList',
            ],
            [f.channelA.id],
        );
        try {
            await adminClient.asUserWithCredentials(emailAddress, PASSWORD);
            adminClient.setChannelToken(f.channelA.token);

            const created = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'editor-can-create',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'Editor created' }],
                },
            });
            const newListId = String(created.createPriceList.id);

            await expect(
                adminClient.query<any>(ASSIGN_TO_CHANNEL, {
                    input: { priceListId: newListId, channelId: f.channelB.id },
                }),
            ).rejects.toThrow(/authori[sz]ed|permission|forbidden/i);
        } finally {
            await restore();
        }
    });

    it('ManagePriceListAccess alone — can manage access, cannot create lists', async () => {
        // The limited admin needs an existing list to act on; create it
        // as superadmin first so permissions aren't in play here.
        const ownerRes = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: 'access-mgr-target',
                valueType: 'ABSOLUTE',
                priority: 1,
                translations: [{ languageCode: 'en', name: 'Access manager target' }],
            },
        });
        const targetListId = String(ownerRes.createPriceList.id);

        const { emailAddress } = await createRoleAndAdmin(
            'access-only',
            ['Authenticated', 'ReadPriceList', 'ManagePriceListAccess'],
            [f.channelA.id],
        );
        try {
            await adminClient.asUserWithCredentials(emailAddress, PASSWORD);
            adminClient.setChannelToken(f.channelA.token);

            const setEveryone = await adminClient.query<any>(SET_EVERYONE, {
                priceListId: targetListId,
                channelId: f.channelA.id,
                assigned: true,
            });
            expect(setEveryone.setPriceListAssignedToEveryone.assignedToEveryone).toBe(true);

            await expect(
                adminClient.query<any>(CREATE_PRICE_LIST, {
                    input: {
                        code: 'access-mgr-attempt',
                        valueType: 'ABSOLUTE',
                        priority: 1,
                        translations: [{ languageCode: 'en', name: 'Access mgr attempt' }],
                    },
                }),
            ).rejects.toThrow(/authori[sz]ed|permission|forbidden/i);
        } finally {
            await restore();
        }
    });
});
