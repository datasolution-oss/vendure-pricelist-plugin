import { DefaultJobQueuePlugin, mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { initialData } from '../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../e2e-common/test-config';
import { PricelistPlugin } from '../src/pricelist.plugin';
import { awaitRunningJobs } from './await-running-jobs';
describe(`Pricelist plugin`, () => {
    

    const { server, adminClient, shopClient:_ } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [
                PricelistPlugin,
                DefaultJobQueuePlugin,
            ],
        }),
    );

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
            customerCount: 1,
        });
         await adminClient.asSuperAdmin();
        // We have extra time here because a lot of jobs are
        // triggered from all the product updates
        await awaitRunningJobs(adminClient, 20_000, 1000);
    },TEST_SETUP_TIMEOUT_MS),

     afterAll(async () => {
        await awaitRunningJobs(adminClient);
        await server.destroy();
    }, TEST_SETUP_TIMEOUT_MS);


     describe('[my test Group]', () => {
        it('[should do smth]', () => {});
     })
})