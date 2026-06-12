import { SimpleGraphQLClient, TestServer } from '@vendure/testing';
import path from 'path';

import { awaitRunningJobs } from './await-running-jobs';
import {
    assignProductVariantToChannelDocument,
    createChannelDocument,
    createCustomerGroupDocument,
    getCustomerListDocument,
    getProductVariantListDocument,
} from './graphql/shared-definitions';
import { ACTIVE_CHANNEL, DEFAULT_GROUP } from './graphql/pricelist-operations';
import { initialData } from '../e2e-common/e2e-initial-data';

export interface PricelistTestFixtures {
    /** The default channel (origin for every list created in tests). */
    channelA: { id: string; code: string; token: string };
    /** A second channel created in the bootstrap for sharing / scoping tests. */
    channelB: { id: string; code: string; token: string };
    /** Variant only assigned to channel A — used to exercise channel scoping. */
    variantV1Id: string;
    /** Variant assigned to both channel A and channel B. */
    variantV2Id: string;
    /** Two customers from the fixture (`customerCount: 2`). */
    customerIds: string[];
    /** A single customer group on channel A. */
    customerGroupId: string;
    /** Auto-created default group on channel A. */
    defaultGroupA: { id: string; code: string };
    /** Auto-created default group on channel B. */
    defaultGroupB: { id: string; code: string };
}

/**
 * Boots the server with the standard pricelist fixture data + creates a
 * second channel and pins variants V1/V2 to the right channels. Called
 * from each spec file's `beforeAll`.
 *
 * Returns the live `PricelistTestFixtures` so the spec can use ids/tokens
 * directly. Caller is responsible for keeping the adminClient logged in
 * as superadmin (this function leaves it that way on exit).
 */
export async function bootstrapPricelistFixtures(
    server: TestServer,
    adminClient: SimpleGraphQLClient,
): Promise<PricelistTestFixtures> {
    await server.init({
        initialData,
        productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
        customerCount: 2,
    });
    await adminClient.asSuperAdmin();
    // Generous timeout — the product import triggers a number of jobs.
    await awaitRunningJobs(adminClient, 20_000, 1000);

    const { activeChannel } = await adminClient.query<any>(ACTIVE_CHANNEL);
    const channelA = {
        id: String(activeChannel.id),
        code: String(activeChannel.code),
        token: String(activeChannel.token),
    };

    // Pick the first two variants; V1 stays in A only, V2 gets shared to B.
    const variantsRes = await adminClient.query(getProductVariantListDocument, {
        options: { take: 2 },
    });
    const variantV1Id = String(variantsRes.productVariants.items[0].id);
    const variantV2Id = String(variantsRes.productVariants.items[1].id);

    // Create channel B with the same zones / currency / language as A so it
    // interoperates cleanly with the default fixture.
    const newChannel = await adminClient.query(createChannelDocument, {
        input: {
            code: 'second-channel',
            token: 'second-channel-token',
            defaultLanguageCode: activeChannel.defaultLanguageCode,
            pricesIncludeTax: activeChannel.pricesIncludeTax,
            defaultCurrencyCode: activeChannel.defaultCurrencyCode,
            availableCurrencyCodes: [activeChannel.defaultCurrencyCode],
            defaultTaxZoneId: activeChannel.defaultTaxZone.id,
            defaultShippingZoneId: activeChannel.defaultShippingZone.id,
        },
    });
    const created = newChannel.createChannel as any;
    if (created.errorCode) {
        throw new Error(`createChannel failed: ${created.message}`);
    }
    const channelB = {
        id: String(created.id),
        code: String(created.code),
        token: String(created.token),
    };

    // Assign V2 to channel B; V1 remains in A only.
    await adminClient.query(assignProductVariantToChannelDocument, {
        input: {
            productVariantIds: [variantV2Id],
            channelId: channelB.id,
            priceFactor: 1,
        },
    });

    // Default groups for A and B. The plugin materializes one per channel
    // via OnApplicationBootstrap + the ChannelEvent listener.
    const aDefault = await adminClient.query<any>(DEFAULT_GROUP, {
        channelId: channelA.id,
    });
    const defaultGroupA = aDefault.priceListDefaultGroup;
    // The default for B is fetched while the active channel is B (the
    // event handler runs in B's context).
    adminClient.setChannelToken(channelB.token);
    const bDefault = await adminClient.query<any>(DEFAULT_GROUP, {
        channelId: channelB.id,
    });
    const defaultGroupB = bDefault.priceListDefaultGroup;
    adminClient.setChannelToken(channelA.token);

    // One customer group on A for access tests.
    const cg = await adminClient.query(createCustomerGroupDocument, {
        input: { name: 'Wholesale' },
    });
    const customerGroupId = String(cg.createCustomerGroup.id);

    const custs = await adminClient.query(getCustomerListDocument, {
        options: { take: 5 },
    });
    const customerIds = custs.customers.items.map((c: any) => String(c.id));

    return {
        channelA,
        channelB,
        variantV1Id,
        variantV2Id,
        customerIds,
        customerGroupId,
        defaultGroupA,
        defaultGroupB,
    };
}
