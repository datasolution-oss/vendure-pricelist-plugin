import { DefaultJobQueuePlugin, DefaultSchedulerPlugin, mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../e2e-common/test-config';
import { PricelistPlugin } from '../src/pricelist.plugin';

import { runTaskDocument } from './graphql/shared-definitions';
import {
    CREATE_PRICE_LIST,
    DELETE_PRICE_LIST,
    PRICE_LIST,
    PRICE_LISTS,
    SAVE_PIVOT,
    VARIANT_ITEMS,
} from './graphql/pricelist-operations';
import { bootstrapPricelistFixtures, PricelistTestFixtures } from './pricelist-test-env';

// Stage 1E: `purgePendingDeletionTask` hard-deletes soft-deleted PriceList
// rows once their grace period has elapsed. Configuring the plugin with
// `purgePendingDeletionAfterMs: 0` makes every soft-deleted list
// immediately purge-eligible, so a single `runScheduledTask` call cleans
// them out.
describe('purgePendingDeletionTask', () => {
    const { server, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            // The default `runTasksInWorkerOnly: true` would gate task
            // execution to the worker process; the test harness runs
            // API + worker in-process, but the worker flag isn't set
            // — flip the gate off so tasks actually execute here.
            schedulerOptions: { runTasksInWorkerOnly: false },
            plugins: [
                PricelistPlugin.init({
                    // Immediate purge — every soft-deleted row is past its
                    // grace period the moment it's deleted.
                    purgePendingDeletionAfterMs: 0,
                    purgePendingDeletionBatchSize: 100,
                }),
                DefaultJobQueuePlugin,
                // Short manualTriggerCheckInterval so a `runScheduledTask`
                // call is picked up by the strategy within the test's
                // polling window (default is 10s, which would force a
                // 10s+ wait per test). Pass a NUMBER (ms) — the option
                // is typed `string | number` but the strategy hands it
                // straight to `setInterval` with no parsing, so a string
                // like '500ms' is coerced to NaN → Node's
                // `TimeoutNaNWarning`.
                DefaultSchedulerPlugin.init({ manualTriggerCheckInterval: 500 }),
            ],
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

    it('hard-deletes a soft-deleted list once the grace period (= 0ms) has elapsed', async () => {
        const res = await adminClient.query<any>(CREATE_PRICE_LIST, {
            input: {
                code: 'purge-target',
                valueType: 'ABSOLUTE',
                priority: 1,
                translations: [{ languageCode: 'en', name: 'Purge target' }],
            },
        });
        const listId = String(res.createPriceList.id);
        // Seed an item to verify the purge cascade clears child rows.
        await adminClient.query<any>(SAVE_PIVOT, {
            input: {
                priceListId: listId,
                productVariantId: f.variantV1Id,
                rows: [{ currencyCode: 'USD', stepQuantity: 1, value: 100 }],
            },
        });

        await adminClient.query<any>(DELETE_PRICE_LIST, { id: listId });

        // Pending-deletion: still findable with `includeDeleted: true`.
        const pending = await adminClient.query<any>(PRICE_LISTS, {
            options: { take: 1000, includeDeleted: true },
        });
        expect(pending.priceLists.items.find((l: any) => l.id === listId)).toBeDefined();

        // Trigger the purge cron. `runScheduledTask` only RECORDS the
        // manual trigger; DefaultSchedulerPlugin's strategy executes it
        // on the next `manualTriggerCheckInterval` tick (500ms in this
        // suite). Poll until the list is gone from `includeDeleted`.
        const taskResult = await adminClient.query(runTaskDocument, {
            id: 'pricelist-purge-pending-deletion',
        });
        expect(taskResult.runScheduledTask.success).toBe(true);

        const stillPresent = async () => {
            const lists = await adminClient.query<any>(PRICE_LISTS, {
                options: { take: 1000, includeDeleted: true },
            });
            return lists.priceLists.items.some((l: any) => l.id === listId);
        };
        const deadline = Date.now() + 10_000;
        // eslint-disable-next-line no-await-in-loop
        while ((await stillPresent()) && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 200));
        }

        // Hard-deleted: no longer findable even with includeDeleted.
        expect(await stillPresent()).toBe(false);

        // Detail query returns null.
        const detail = await adminClient.query<any>(PRICE_LIST, { id: listId });
        expect(detail.priceList).toBeNull();

        // Items were dropped by the purge cascade.
        const itemRows = await adminClient.query<any>(VARIANT_ITEMS, {
            priceListId: listId,
            productVariantId: f.variantV1Id,
        });
        expect(itemRows.priceListVariantItems).toHaveLength(0);
    });

    it('purge run with nothing to do succeeds and is idempotent', async () => {
        // Second back-to-back invocation: no pending-deletion rows left.
        const first = await adminClient.query(runTaskDocument, {
            id: 'pricelist-purge-pending-deletion',
        });
        expect(first.runScheduledTask.success).toBe(true);

        const second = await adminClient.query(runTaskDocument, {
            id: 'pricelist-purge-pending-deletion',
        });
        expect(second.runScheduledTask.success).toBe(true);
    });
});
