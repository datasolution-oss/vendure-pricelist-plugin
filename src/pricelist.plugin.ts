import { PluginCommonModule, Type, VendurePlugin } from '@vendure/core';

import { adminApiExtensions, ALL_RESOLVERS } from './api';
import { PRICELIST_PLUGIN_OPTIONS } from './constants';
import { ALL_ENTITIES } from './entities';
import { priceListGroupPermission, priceListPermission } from './permissions';
import { purgePendingDeletionTask } from './scheduled-tasks/purge-pending-deletion-task';
import { ALL_SERVICES } from './services';
import { PluginInitOptions } from './types';

const DEFAULT_PURGE_AFTER_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_PURGE_BATCH_SIZE = 100;

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [
        ...ALL_SERVICES,
        { provide: PRICELIST_PLUGIN_OPTIONS, useFactory: () => PricelistPlugin.options },
    ],
    entities: ALL_ENTITIES,
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: ALL_RESOLVERS,
    },
    configuration: config => {
        config.authOptions.customPermissions.push(
            priceListPermission,
            priceListGroupPermission,
        );

        // Stage 1E: register the purge-pending-deletion cron task.
        //
        // Schedule semantics:
        //   - `null` → disable the task entirely (don't push it)
        //   - undefined → keep the task's built-in default schedule
        //     (every 15 minutes)
        //   - any other value → override the schedule
        //
        // Params are always overridden so the plugin's options govern
        // the grace period and batch size at runtime — re-configurable
        // without rebuilding the plugin.
        const scheduleOpt = PricelistPlugin.options.purgePendingDeletionSchedule;
        if (scheduleOpt !== null) {
            const task =
                scheduleOpt === undefined
                    ? purgePendingDeletionTask
                    : purgePendingDeletionTask.configure({ schedule: scheduleOpt });
            config.schedulerOptions.tasks.push(
                task.configure({
                    params: {
                        olderThanMs:
                            PricelistPlugin.options.purgePendingDeletionAfterMs ??
                            DEFAULT_PURGE_AFTER_MS,
                        batchSize:
                            PricelistPlugin.options.purgePendingDeletionBatchSize ??
                            DEFAULT_PURGE_BATCH_SIZE,
                    },
                }),
            );
        }

        return config;
    },
    dashboard: './dashboard/index.tsx',
    compatibility: '^3.6.0',
})
export class PricelistPlugin {
    static options: PluginInitOptions = {};

    static init(options: PluginInitOptions = {}): Type<PricelistPlugin> {
        this.options = options;
        return PricelistPlugin;
    }
}
