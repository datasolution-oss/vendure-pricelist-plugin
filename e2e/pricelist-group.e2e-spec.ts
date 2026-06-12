import { DefaultJobQueuePlugin, mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../e2e-common/test-config';
import { PricelistPlugin } from '../src/pricelist.plugin';

import {
    CHANGE_GROUP,
    CREATE_GROUP,
    CREATE_PRICE_LIST,
    DEFAULT_GROUP,
    DELETE_GROUP,
    GROUPS_BY_CHANNEL,
    PRICE_LIST_GROUP,
    PRICE_LISTS_BY_GROUP,
    SET_DEFAULT_GROUP,
    UPDATE_GROUP,
} from './graphql/pricelist-operations';
import { bootstrapPricelistFixtures, PricelistTestFixtures } from './pricelist-test-env';

describe('PriceListGroup', () => {
    const { server, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [PricelistPlugin, DefaultJobQueuePlugin],
        }),
    );

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

    it('createPriceListGroup — translated name, ChannelAware to active channel', async () => {
        const { createPriceListGroup } = await adminClient.query<any>(CREATE_GROUP, {
            input: {
                code: 'wholesale',
                priority: 10,
                translations: [{ languageCode: 'en', name: 'Wholesale Group' }],
            },
        });
        expect(createPriceListGroup.code).toBe('wholesale');
        expect(createPriceListGroup.name).toBe('Wholesale Group');
        expect(createPriceListGroup.channel.id).toBe(f.channelA.id);
    });

    it('priceListDefaultGroup returns the auto-created default; setDefaultPriceListGroup switches it', async () => {
        const before = await adminClient.query<any>(DEFAULT_GROUP, { channelId: f.channelA.id });
        expect(before.priceListDefaultGroup.id).toBe(f.defaultGroupA.id);

        const { createPriceListGroup } = await adminClient.query<any>(CREATE_GROUP, {
            input: {
                code: 'new-default',
                priority: 1,
                translations: [{ languageCode: 'en', name: 'New Default' }],
            },
        });
        const newGroupId = String(createPriceListGroup.id);
        await adminClient.query<any>(SET_DEFAULT_GROUP, {
            channelId: f.channelA.id,
            groupId: newGroupId,
        });
        const after = await adminClient.query<any>(DEFAULT_GROUP, { channelId: f.channelA.id });
        expect(after.priceListDefaultGroup.id).toBe(newGroupId);

        // Restore the original default so later tests using the
        // "channel default" fallback aren't affected.
        await adminClient.query<any>(SET_DEFAULT_GROUP, {
            channelId: f.channelA.id,
            groupId: f.defaultGroupA.id,
        });
        const restored = await adminClient.query<any>(DEFAULT_GROUP, {
            channelId: f.channelA.id,
        });
        expect(restored.priceListDefaultGroup.id).toBe(f.defaultGroupA.id);
    });

    it('deletePriceListGroup refuses to delete the default group', async () => {
        await expect(
            adminClient.query<any>(DELETE_GROUP, { id: f.defaultGroupA.id }),
        ).rejects.toThrow(/PRICELIST_GROUP_DEFAULT_NOT_DELETABLE/);
    });

    it('setDefaultPriceListGroup with channelId ≠ active channel is rejected', async () => {
        // Active is A; pass B as channelId — the service's guard requires
        // ctx.channelId === channelId.
        await expect(
            adminClient.query<any>(SET_DEFAULT_GROUP, {
                channelId: f.channelB.id,
                groupId: f.defaultGroupA.id,
            }),
        ).rejects.toThrow(/different active channel/i);
    });

    it('setDefaultPriceListGroup with a group not assigned to the channel is rejected', async () => {
        // Default group of B is foreign to A.
        await expect(
            adminClient.query<any>(SET_DEFAULT_GROUP, {
                channelId: f.channelA.id,
                groupId: f.defaultGroupB.id,
            }),
        ).rejects.toThrow(/not found in channel/i);
    });

    it('changePriceListGroup with channelId ≠ active channel is rejected', async () => {
        const listRes = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: 'change-group-wrong-channel',
                valueType: 'ABSOLUTE',
                priority: 1,
                translations: [{ languageCode: 'en', name: 'Wrong channel' }],
            },
        });
        const listId = String(listRes.createPriceList.id);

        await expect(
            adminClient.query<any>(CHANGE_GROUP, {
                priceListId: listId,
                channelId: f.channelB.id, // active is A
                groupId: f.defaultGroupB.id,
            }),
        ).rejects.toThrow(/only target the active channel/i);
    });

    it('changePriceListGroup on a channel the list is not shared to is rejected', async () => {
        // List owned by A, not shared to B. Switch active to B and try to
        // rebind on B — hits `PRICELIST_NOT_SHARED_TO_CHANNEL`.
        const listRes = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: 'change-group-not-shared',
                valueType: 'ABSOLUTE',
                priority: 1,
                translations: [{ languageCode: 'en', name: 'Not shared' }],
            },
        });
        const listId = String(listRes.createPriceList.id);

        adminClient.setChannelToken(f.channelB.token);
        try {
            await expect(
                adminClient.query<any>(CHANGE_GROUP, {
                    priceListId: listId,
                    channelId: f.channelB.id,
                    groupId: f.defaultGroupB.id,
                }),
            ).rejects.toThrow(/PRICELIST_NOT_SHARED_TO_CHANNEL/);
        } finally {
            adminClient.setChannelToken(f.channelA.token);
        }
    });

    it('changePriceListGroup repoints membership on the channel; priceListsByGroup lists the moved list', async () => {
        const groupRes = await adminClient.query<any>(CREATE_GROUP, {
            input: {
                code: 'movable',
                priority: 20,
                translations: [{ languageCode: 'en', name: 'Movable' }],
            },
        });
        const movableId = String(groupRes.createPriceListGroup.id);

        const listRes = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: 'group-move-list',
                valueType: 'ABSOLUTE',
                priority: 1,
                translations: [{ languageCode: 'en', name: 'Group move list' }],
            },
        });
        const listId = String(listRes.createPriceList.id);

        const beforeMove = await adminClient.query<any>(PRICE_LISTS_BY_GROUP, {
            groupId: movableId,
        });
        expect(beforeMove.priceListsByGroup.totalItems).toBe(0);

        const moved = await adminClient.query<any>(CHANGE_GROUP, {
            priceListId: listId,
            channelId: f.channelA.id,
            groupId: movableId,
        });
        const aMembership = moved.changePriceListGroup.groupMemberships.find(
            (m: any) => m.channel.id === f.channelA.id,
        );
        expect(aMembership.group.id).toBe(movableId);

        const afterMove = await adminClient.query<any>(PRICE_LISTS_BY_GROUP, {
            groupId: movableId,
        });
        expect(afterMove.priceListsByGroup.totalItems).toBe(1);
        expect(afterMove.priceListsByGroup.items[0].id).toBe(listId);
    });

    it('updatePriceListGroup updates code, priority and translations', async () => {
        const res = await adminClient.query<any>(CREATE_GROUP, {
            input: {
                code: 'updatable-group',
                priority: 5,
                translations: [{ languageCode: 'en', name: 'Updatable' }],
            },
        });
        const id = String(res.createPriceListGroup.id);

        const updated = await adminClient.query<any>(UPDATE_GROUP, {
            input: {
                id,
                code: 'updatable-renamed',
                priority: 50,
                translations: [{ languageCode: 'en', name: 'Renamed group' }],
            },
        });
        expect(updated.updatePriceListGroup.code).toBe('updatable-renamed');
        expect(updated.updatePriceListGroup.priority).toBe(50);
        expect(updated.updatePriceListGroup.name).toBe('Renamed group');
    });

    it('PriceListGroup translations — create [en, fr]; resolves by languageCode', async () => {
        const res = await adminClient.query<any>(CREATE_GROUP, {
            input: {
                code: 'i18n-group',
                priority: 1,
                translations: [
                    { languageCode: 'en', name: 'Wholesale' },
                    { languageCode: 'fr', name: 'Vente en gros' },
                ],
            },
        });
        const id = String(res.createPriceListGroup.id);

        const inEn = await adminClient.query<any>(PRICE_LIST_GROUP, { id });
        expect(inEn.priceListGroup.name).toBe('Wholesale');

        const inFr = await adminClient.query<any>(
            PRICE_LIST_GROUP,
            { id },
            { languageCode: 'fr' },
        );
        expect(inFr.priceListGroup.name).toBe('Vente en gros');
    });

    it('priceListGroupsByChannel returns groups assigned to the given channel', async () => {
        // Create a group on A; assert it appears in groupsByChannel(A) and
        // NOT in groupsByChannel(B).
        const res = await adminClient.query<any>(CREATE_GROUP, {
            input: {
                code: 'scoped-to-a',
                priority: 1,
                translations: [{ languageCode: 'en', name: 'Scoped to A' }],
            },
        });
        const scopedId = String(res.createPriceListGroup.id);

        const onA = await adminClient.query<any>(GROUPS_BY_CHANNEL, {
            channelId: f.channelA.id,
        });
        expect(onA.priceListGroupsByChannel.map((g: any) => String(g.id))).toContain(scopedId);

        const onB = await adminClient.query<any>(GROUPS_BY_CHANNEL, {
            channelId: f.channelB.id,
        });
        expect(onB.priceListGroupsByChannel.map((g: any) => String(g.id))).not.toContain(
            scopedId,
        );
    });

    it('priceListsByGroup paginates correctly — skip/take/totalItems', async () => {
        const groupRes = await adminClient.query<any>(CREATE_GROUP, {
            input: {
                code: 'page-group',
                priority: 30,
                translations: [{ languageCode: 'en', name: 'Page group' }],
            },
        });
        const groupId = String(groupRes.createPriceListGroup.id);

        const listIds: string[] = [];
        for (let i = 0; i < 3; i++) {
            const r = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: `page-list-${i}`,
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: `Page ${i}` }],
                },
            });
            const lid = String(r.createPriceList.id);
            await adminClient.query<any>(CHANGE_GROUP, {
                priceListId: lid,
                channelId: f.channelA.id,
                groupId,
            });
            listIds.push(lid);
        }

        const page = await adminClient.query<any>(PRICE_LISTS_BY_GROUP, {
            groupId,
        });
        expect(page.priceListsByGroup.totalItems).toBe(3);
        expect(page.priceListsByGroup.items.map((i: any) => String(i.id)).sort()).toEqual(
            listIds.slice().sort(),
        );
    });
});
