import { DefaultJobQueuePlugin, mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../e2e-common/test-config';
import {
    ERR_PRICELIST_ALREADY_SHARED_TO_CHANNEL,
    ERR_PRICELIST_ORIGIN_CHANNEL_NOT_REMOVABLE,
} from '../src/constants';
import { PricelistPlugin } from '../src/pricelist.plugin';

import { createChannelDocument } from './graphql/shared-definitions';
import {
    ADD_ITEM,
    ASSIGN_TO_CHANNEL,
    CREATE_GROUP,
    CREATE_PRICE_LIST,
    DELETE_PRICE_LIST,
    PRICE_LIST,
    PRICE_LISTS,
    REMOVE_FROM_CHANNEL,
    RESTORE_PRICE_LIST,
    SAVE_PIVOT,
    UPDATE_PRICE_LIST,
} from './graphql/pricelist-operations';
import { bootstrapPricelistFixtures, PricelistTestFixtures } from './pricelist-test-env';

describe('PriceList entity', () => {
    const { server, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [PricelistPlugin, DefaultJobQueuePlugin],
        }),
    );

    let f: PricelistTestFixtures;

    beforeAll(async () => {
        f = await bootstrapPricelistFixtures(server, adminClient);
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    }, TEST_SETUP_TIMEOUT_MS);

    // ------------------------------------------------------------
    // A. CRUD
    // ------------------------------------------------------------
    describe('A. CRUD', () => {
        let absoluteListId: string;

        it('creates an ABSOLUTE list — defaults timezone to UTC, binds to channel default group on the origin channel', async () => {
            const { createPriceList } = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'crud-absolute',
                    valueType: 'ABSOLUTE',
                    priority: 10,
                    translations: [{ languageCode: 'en', name: 'CRUD Absolute', description: '' }],
                },
            });

            absoluteListId = String(createPriceList.id);
            expect(createPriceList.code).toBe('crud-absolute');
            expect(createPriceList.valueType).toBe('ABSOLUTE');
            expect(createPriceList.timezone).toBe('UTC');
            expect(createPriceList.enabled).toBe(true);
            expect(createPriceList.priority).toBe(10);
            expect(createPriceList.name).toBe('CRUD Absolute');
            expect(createPriceList.originChannel.id).toBe(f.channelA.id);
            expect(createPriceList.channels.map((c: any) => c.id)).toEqual([f.channelA.id]);
            expect(createPriceList.groupMemberships).toHaveLength(1);
            expect(createPriceList.groupMemberships[0].channel.id).toBe(f.channelA.id);
            expect(createPriceList.groupMemberships[0].group.id).toBe(f.defaultGroupA.id);
        });

        it('creates a PERCENTAGE list (valueType persisted)', async () => {
            const { createPriceList } = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'crud-percentage',
                    valueType: 'PERCENTAGE',
                    priority: 5,
                    translations: [{ languageCode: 'en', name: 'CRUD Percentage' }],
                },
            });
            expect(createPriceList.valueType).toBe('PERCENTAGE');
        });

        it('reads a list back by id', async () => {
            const { priceList } = await adminClient.query<any>(PRICE_LIST, { id: absoluteListId });
            expect(priceList.id).toBe(absoluteListId);
            expect(priceList.code).toBe('crud-absolute');
        });

        it('updates priority, enabled, code and translations', async () => {
            const { updatePriceList } = await adminClient.query<any>(UPDATE_PRICE_LIST, {
                input: {
                    id: absoluteListId,
                    code: 'crud-absolute-renamed',
                    priority: 99,
                    enabled: false,
                    translations: [{ languageCode: 'en', name: 'Renamed', description: 'updated' }],
                },
            });
            expect(updatePriceList.code).toBe('crud-absolute-renamed');
            expect(updatePriceList.priority).toBe(99);
            expect(updatePriceList.enabled).toBe(false);
            expect(updatePriceList.name).toBe('Renamed');
            expect(updatePriceList.description).toBe('updated');
        });

        it('priceLists pagination — skip/take/totalItems', async () => {
            // Snapshot the current total, then create three more and verify
            // skip + take return the expected slice.
            const before = await adminClient.query<any>(PRICE_LISTS, {
                options: { take: 1000 },
            });
            const baseline = before.priceLists.totalItems;

            for (let i = 0; i < 3; i++) {
                await adminClient.query<any>(CREATE_PRICE_LIST, {
                    input: {
                        code: `paginated-${i}`,
                        valueType: 'ABSOLUTE',
                        priority: 1,
                        translations: [{ languageCode: 'en', name: `Paginated ${i}` }],
                    },
                });
            }
            const page1 = await adminClient.query<any>(PRICE_LISTS, {
                options: { take: 2 },
            });
            expect(page1.priceLists.totalItems).toBe(baseline + 3);
            expect(page1.priceLists.items).toHaveLength(2);

            const page2 = await adminClient.query<any>(PRICE_LISTS, {
                options: { skip: 2, take: 2 },
            });
            expect(page2.priceLists.totalItems).toBe(baseline + 3);
            // No id from page 1 reappears in page 2.
            const page1Ids = new Set(page1.priceLists.items.map((l: any) => String(l.id)));
            for (const item of page2.priceLists.items) {
                expect(page1Ids.has(String(item.id))).toBe(false);
            }
        });

        it('translations round-trip — create with [en, fr], read both back, resolve by languageCode', async () => {
            const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'i18n-list',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [
                        { languageCode: 'en', name: 'English Name', description: 'EN desc' },
                        { languageCode: 'fr', name: 'Nom Français', description: 'FR desc' },
                    ],
                },
            });
            const i18nId = String(res.createPriceList.id);

            // Default languageCode (en) resolves to English.
            const inEn = await adminClient.query<any>(PRICE_LIST, { id: i18nId });
            expect(inEn.priceList.name).toBe('English Name');

            // Request the FR language via the ?languageCode=fr query param —
            // server resolves `name`/`description` to the FR translation.
            const inFr = await adminClient.query<any>(
                PRICE_LIST,
                { id: i18nId },
                { languageCode: 'fr' },
            );
            expect(inFr.priceList.name).toBe('Nom Français');
        });

        it('updatePriceList translations replaces same-language entry and preserves others', async () => {
            const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'i18n-update',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [
                        { languageCode: 'en', name: 'EN Original' },
                        { languageCode: 'fr', name: 'FR Original' },
                    ],
                },
            });
            const id = String(res.createPriceList.id);

            // Update only the EN translation; the FR one must persist
            // (translatable saver merges by languageCode).
            await adminClient.query<any>(UPDATE_PRICE_LIST, {
                input: {
                    id,
                    translations: [{ languageCode: 'en', name: 'EN Updated' }],
                },
            });

            const inEn = await adminClient.query<any>(PRICE_LIST, { id });
            expect(inEn.priceList.name).toBe('EN Updated');

            const inFr = await adminClient.query<any>(
                PRICE_LIST,
                { id },
                { languageCode: 'fr' },
            );
            expect(inFr.priceList.name).toBe('FR Original');
        });

        it('createPriceList with a groupId not assigned to the active channel is rejected', async () => {
            // A group owned by channel A (active = A), so we need a group
            // assigned only to channel B to trigger the mismatch. We make a
            // group on B from B's context, then attempt to create a list on
            // A passing that B-only group id.
            adminClient.setChannelToken(f.channelB.token);
            const onB = await adminClient.query<any>(CREATE_GROUP, {
                input: {
                    code: 'b-only-group-create',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'B only' }],
                },
            });
            const foreignGroupId = String(onB.createPriceListGroup.id);
            adminClient.setChannelToken(f.channelA.token);

            await expect(
                adminClient.query<any>(CREATE_PRICE_LIST, {
                    input: {
                        code: 'foreign-group-create',
                        valueType: 'ABSOLUTE',
                        priority: 1,
                        groupId: foreignGroupId,
                        translations: [{ languageCode: 'en', name: 'Foreign group' }],
                    },
                }),
            ).rejects.toThrow(/PRICELIST_GROUP_CHANNEL_MISMATCH/);
        });
    });

    // ------------------------------------------------------------
    // E. Channel sharing
    // ------------------------------------------------------------
    describe('E. Channel sharing', () => {
        let listId: string;

        beforeAll(async () => {
            const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'share-list',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'Share list' }],
                },
            });
            listId = String(res.createPriceList.id);
            // One item for V1 (only on channel A) — sharing must NOT be
            // blocked by items whose variant isn't on the target channel.
            await adminClient.query<any>(SAVE_PIVOT, {
                input: {
                    priceListId: listId,
                    productVariantId: f.variantV1Id,
                    rows: [{ currencyCode: 'USD', stepQuantity: 1, value: 500 }],
                },
            });
        });

        it('assignPriceListToChannel without explicit groupId — falls back to B default group', async () => {
            const res = await adminClient.query<any>(ASSIGN_TO_CHANNEL, {
                input: { priceListId: listId, channelId: f.channelB.id },
            });
            const channelIds = res.assignPriceListToChannel.channels
                .map((c: any) => c.id)
                .sort();
            expect(channelIds).toEqual([f.channelA.id, f.channelB.id].sort());
            const bMembership = res.assignPriceListToChannel.groupMemberships.find(
                (m: any) => m.channel.id === f.channelB.id,
            );
            expect(bMembership.group.id).toBe(f.defaultGroupB.id);
        });

        it('re-assigning to an already-shared channel errors', async () => {
            await expect(
                adminClient.query<any>(ASSIGN_TO_CHANNEL, {
                    input: { priceListId: listId, channelId: f.channelB.id },
                }),
            ).rejects.toThrow(ERR_PRICELIST_ALREADY_SHARED_TO_CHANNEL);
        });

        it('removePriceListFromChannel removes the binding', async () => {
            const res = await adminClient.query<any>(REMOVE_FROM_CHANNEL, {
                priceListId: listId,
                channelId: f.channelB.id,
            });
            const channelIds = res.removePriceListFromChannel.channels.map((c: any) => c.id);
            expect(channelIds).not.toContain(f.channelB.id);
            expect(channelIds).toContain(f.channelA.id);
        });

        it('removing the origin channel is refused', async () => {
            await expect(
                adminClient.query<any>(REMOVE_FROM_CHANNEL, {
                    priceListId: listId,
                    channelId: f.channelA.id,
                }),
            ).rejects.toThrow(ERR_PRICELIST_ORIGIN_CHANNEL_NOT_REMOVABLE);
        });

        it('assignPriceListToChannel with a groupId not assigned to the target channel is rejected', async () => {
            // Fresh list to avoid the "already shared" path stealing the error.
            const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'foreign-group-assign',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'Foreign group assign' }],
                },
            });
            const newListId = String(res.createPriceList.id);

            // A group owned by channel A (the active one) is foreign to B.
            const aGroup = await adminClient.query<any>(CREATE_GROUP, {
                input: {
                    code: 'a-only-group-assign',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'A only' }],
                },
            });
            const aGroupId = String(aGroup.createPriceListGroup.id);

            await expect(
                adminClient.query<any>(ASSIGN_TO_CHANNEL, {
                    input: {
                        priceListId: newListId,
                        channelId: f.channelB.id,
                        groupId: aGroupId,
                    },
                }),
            ).rejects.toThrow(/PRICELIST_GROUP_CHANNEL_MISMATCH/);
        });

        it('removePriceListFromChannel from a 3rd channel (neither origin nor target) is rejected', async () => {
            // Create channel C and a list shared A → B, then try removing
            // B while the active channel is C — hits the
            // `!isOrigin && !isSelfRemoval` branch in the service.
            const cRes = await adminClient.query(createChannelDocument, {
                input: {
                    code: 'third-channel',
                    token: 'third-channel-token',
                    defaultLanguageCode: 'en',
                    pricesIncludeTax: false,
                    defaultCurrencyCode: 'USD',
                    availableCurrencyCodes: ['USD'],
                    defaultTaxZoneId: '1',
                    defaultShippingZoneId: '1',
                },
            });
            const cCreated = cRes.createChannel as any;
            const channelC = {
                id: String(cCreated.id),
                token: String(cCreated.token),
            };

            const listRes = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'three-channel-list',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: '3-channel list' }],
                },
            });
            const threeChannelListId = String(listRes.createPriceList.id);
            await adminClient.query<any>(ASSIGN_TO_CHANNEL, {
                input: { priceListId: threeChannelListId, channelId: f.channelB.id },
            });

            adminClient.setChannelToken(channelC.token);
            try {
                await expect(
                    adminClient.query<any>(REMOVE_FROM_CHANNEL, {
                        priceListId: threeChannelListId,
                        channelId: f.channelB.id,
                    }),
                ).rejects.toThrow(/PRICELIST_READONLY_NON_ORIGIN_CHANNEL/);
            } finally {
                adminClient.setChannelToken(f.channelA.token);
            }
        });

        it('priceList(id) returns null when read from a channel the list is not shared to', async () => {
            // Create a list owned by A, never shared to B. Reading it from
            // B's context must come back null (the service gates on the
            // active channel being in `list.channels`).
            const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'a-only-visibility',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'A only visibility' }],
                },
            });
            const aOnlyId = String(res.createPriceList.id);

            adminClient.setChannelToken(f.channelB.token);
            try {
                const { priceList } = await adminClient.query<any>(PRICE_LIST, { id: aOnlyId });
                expect(priceList).toBeNull();
            } finally {
                adminClient.setChannelToken(f.channelA.token);
            }
        });
    });

    // ------------------------------------------------------------
    // G. Soft-delete / restore
    // ------------------------------------------------------------
    describe('G. Soft-delete / restore', () => {
        let listId: string;

        beforeAll(async () => {
            const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'soft-delete-list',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'Soft delete' }],
                },
            });
            listId = String(res.createPriceList.id);
        });

        it('deletePriceList sets deletedAt; list is hidden by default and visible via includeDeleted / priceList(id)', async () => {
            const del = await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });
            expect(del.deletePriceList.result).toBe('DELETED');

            const def = await adminClient.query<any>(PRICE_LISTS, { options: { take: 100 } });
            expect(def.priceLists.items.find((l: any) => l.id === listId)).toBeUndefined();

            const inc = await adminClient.query<any>(PRICE_LISTS, {
                options: { take: 100, includeDeleted: true },
            });
            const found = inc.priceLists.items.find((l: any) => l.id === listId);
            expect(found).toBeDefined();
            expect(found.deletedAt).toBeTruthy();

            const detail = await adminClient.query<any>(PRICE_LIST, { id: listId });
            expect(detail.priceList).not.toBeNull();
            expect(detail.priceList.deletedAt).toBeTruthy();
        });

        it('restorePriceList clears deletedAt and brings the list back to active', async () => {
            const restored = await adminClient.query<any>(RESTORE_PRICE_LIST, { id: listId });
            expect(restored.restorePriceList.deletedAt).toBeNull();

            const def = await adminClient.query<any>(PRICE_LISTS, { options: { take: 100 } });
            expect(def.priceLists.items.find((l: any) => l.id === listId)).toBeDefined();
        });

        it('after soft-delete: priceList.items is empty and content mutations report not-found', async () => {
            // Fresh list with one item, soft-deleted. The items query
            // filters on `priceList.deletedAt IS NULL`; the content-edit
            // guard does the same and reports a generic "not found"
            // (ID enumeration protection).
            const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'soft-delete-items',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'Soft delete items' }],
                },
            });
            const downstreamId = String(res.createPriceList.id);
            await adminClient.query<any>(SAVE_PIVOT, {
                input: {
                    priceListId: downstreamId,
                    productVariantId: f.variantV1Id,
                    rows: [{ currencyCode: 'USD', stepQuantity: 1, value: 100 }],
                },
            });
            await adminClient.query<any>(DELETE_PRICE_LIST, { id: downstreamId });

            const detail = await adminClient.query<any>(PRICE_LIST, { id: downstreamId });
            // Detail still loads (pending-deletion view), but items
            // collection on the soft-deleted list is empty.
            expect(detail.priceList.items.items).toHaveLength(0);
            expect(detail.priceList.items.totalItems).toBe(0);

            // Content mutations report not-found (channel scope + deletedAt
            // IS NULL filter).
            await expect(
                adminClient.query<any>(UPDATE_PRICE_LIST, {
                    input: { id: downstreamId, priority: 1 },
                }),
            ).rejects.toThrow(/not found/i);

            await expect(
                adminClient.query<any>(SAVE_PIVOT, {
                    input: {
                        priceListId: downstreamId,
                        productVariantId: f.variantV1Id,
                        rows: [{ currencyCode: 'USD', stepQuantity: 1, value: 999 }],
                    },
                }),
            ).rejects.toThrow(/not found/i);
        });

        it('restore on a non-deleted list is idempotent', async () => {
            const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'restore-idempotent',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'Restore idempotent' }],
                },
            });
            const aliveId = String(res.createPriceList.id);
            // Already-active list: restore is documented as a no-op.
            const restored = await adminClient.query<any>(RESTORE_PRICE_LIST, { id: aliveId });
            expect(restored.restorePriceList.deletedAt).toBeNull();
        });

        it('restorePriceList from a non-origin channel is rejected', async () => {
            // Soft-delete a fresh list from A, then try restoring it from B.
            // The list must be shared to B for the channel-scoped lookup to
            // see it; the origin guard rejects the actual restore.
            const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'restore-guard-list',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'Restore guard' }],
                },
            });
            const restoreListId = String(res.createPriceList.id);
            await adminClient.query<any>(ASSIGN_TO_CHANNEL, {
                input: { priceListId: restoreListId, channelId: f.channelB.id },
            });
            await adminClient.query<any>(DELETE_PRICE_LIST, { id: restoreListId });

            adminClient.setChannelToken(f.channelB.token);
            try {
                await expect(
                    adminClient.query<any>(RESTORE_PRICE_LIST, { id: restoreListId }),
                ).rejects.toThrow(/PRICELIST_READONLY_NON_ORIGIN_CHANNEL/);
            } finally {
                adminClient.setChannelToken(f.channelA.token);
            }
        });
    });

    // ------------------------------------------------------------
    // H. Origin-channel edit guard
    // ------------------------------------------------------------
    describe('H. Origin-channel edit guard', () => {
        let listId: string;

        beforeAll(async () => {
            // Owned by A, shared to B. All assertions in this block run
            // as superadmin (so permissions aren't a factor) and toggle
            // only the channel context.
            const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
                input: {
                    code: 'origin-guard-list',
                    valueType: 'ABSOLUTE',
                    priority: 1,
                    translations: [{ languageCode: 'en', name: 'Origin guard' }],
                },
            });
            listId = String(res.createPriceList.id);
            await adminClient.query<any>(ASSIGN_TO_CHANNEL, {
                input: { priceListId: listId, channelId: f.channelB.id },
            });
        });

        afterAll(() => {
            adminClient.setChannelToken(f.channelA.token);
        });

        it('updatePriceList from a non-origin channel is rejected', async () => {
            adminClient.setChannelToken(f.channelB.token);
            await expect(
                adminClient.query<any>(UPDATE_PRICE_LIST, {
                    input: { id: listId, priority: 42 },
                }),
            ).rejects.toThrow(/PRICELIST_READONLY_NON_ORIGIN_CHANNEL/);
        });

        it('savePriceListVariantPivot from a non-origin channel is rejected', async () => {
            adminClient.setChannelToken(f.channelB.token);
            await expect(
                adminClient.query<any>(SAVE_PIVOT, {
                    input: {
                        priceListId: listId,
                        productVariantId: f.variantV2Id,
                        rows: [{ currencyCode: 'USD', stepQuantity: 1, value: 1 }],
                    },
                }),
            ).rejects.toThrow(/PRICELIST_READONLY_NON_ORIGIN_CHANNEL/);
        });

        it('addPriceListItem from a non-origin channel is rejected', async () => {
            adminClient.setChannelToken(f.channelB.token);
            await expect(
                adminClient.query<any>(ADD_ITEM, {
                    input: {
                        priceListId: listId,
                        productVariantId: f.variantV2Id,
                        currencyCode: 'USD',
                        value: 1,
                        stepQuantity: 1,
                    },
                }),
            ).rejects.toThrow(/PRICELIST_READONLY_NON_ORIGIN_CHANNEL/);
        });

        it('deletePriceList from a non-origin channel is rejected', async () => {
            adminClient.setChannelToken(f.channelB.token);
            await expect(
                adminClient.query<any>(DELETE_PRICE_LIST, { id: listId }),
            ).rejects.toThrow(/PRICELIST_READONLY_NON_ORIGIN_CHANNEL/);
        });

        it('the same updatePriceList succeeds from the origin channel', async () => {
            adminClient.setChannelToken(f.channelA.token);
            const res = await adminClient.query<any>(UPDATE_PRICE_LIST, {
                input: { id: listId, priority: 42 },
            });
            expect(res.updatePriceList.priority).toBe(42);
        });
    });
});
