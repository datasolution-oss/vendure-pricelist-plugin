import { Logger, RequestContextService, ScheduledTask } from '@vendure/core';

import { loggerCtx } from '../constants';
import { PriceListService } from '../services/price-list.service';

/**
 * Scheduled task that hard-deletes `PriceList` rows whose grace period
 * has expired (`deletedAt < now() - purgePendingDeletionAfterMs`).
 *
 * Wired by `PricelistPlugin` in `configuration:` with the plugin
 * options threaded as task params. The runtime task can be reconfigured
 * by the Vendure admin via the standard `scheduledTasks` admin API,
 * or replaced wholesale by the consumer project's `schedulerOptions`.
 *
 * The heavy lifting lives in `PriceListService.purgePending` — the task
 * is a thin shim that resolves the cutoff and forwards the call.
 *
 * Idempotent + interruption-safe: see the docstring on
 * `purgePending`. Re-running is harmless; killing mid-batch only
 * rolls back the in-flight batch.
 */
interface PurgeParams {
    /**
     * Grace period in milliseconds. `deletedAt < now() - olderThanMs`
     * is the purge predicate. `null` means "purge nothing" and is the
     * sentinel value used to disable purging without removing the
     * task entirely (e.g. for environments that prefer manual
     * cleanup).
     */
    olderThanMs: number | null;
    /**
     * Max rows per batch (each batch = its own transaction).
     */
    batchSize: number;
}

export const purgePendingDeletionTask = new ScheduledTask<PurgeParams>({
    id: 'pricelist-purge-pending-deletion',
    description:
        'Hard-deletes PriceList rows whose grace period has expired (Stage 1E).',
    // Default schedule; overridden by the plugin's `configuration:` step
    // when init options provide a custom value.
    schedule: cron => cron.every(15).minutes(),
    params: {
        olderThanMs: 60 * 60 * 1000,
        batchSize: 100,
    },
    async execute({ injector, scheduledContext, params }) {
        if (params.olderThanMs === null) {
            Logger.debug(
                'Purge disabled (olderThanMs=null); skipping run.',
                loggerCtx,
            );
            return { purged: 0, skipped: true };
        }

        const cutoff = new Date(Date.now() - params.olderThanMs);
        const ctxService = injector.get(RequestContextService);
        // Spawn a fresh, top-level RequestContext for the work. We
        // intentionally skip channel scoping: the cron operates across
        // every channel's pending lists (the cutoff predicate alone
        // governs eligibility).
        const ctx = await ctxService.create({
            apiType: 'admin',
            languageCode: scheduledContext.languageCode,
        });

        const priceListService = injector.get(PriceListService);
        const purged = await priceListService.purgePending(ctx, {
            olderThan: cutoff,
            batchSize: params.batchSize,
        });

        if (purged > 0) {
            Logger.info(
                `Purged ${purged} pricelist(s) past grace period.`,
                loggerCtx,
            );
        }
        return { purged };
    },
});
