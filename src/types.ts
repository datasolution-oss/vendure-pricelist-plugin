/**
 * @description
 * Init options for the Pricelist plugin. All fields optional with sensible
 * defaults applied at the call sites in `pricelist.plugin.ts`.
 *
 * Stage 1E ships the soft-delete-with-cron knobs below; Stage 2 will add
 * strategy slots (resolution, selection, calculation, rounding),
 * `killSwitchPerChannel`, and `defaultCacheTtlMs`.
 */
export interface PluginInitOptions {
    /**
     * Grace period (ms) between user-initiated delete and irreversible
     * purge by the cron task. A `PriceList` whose `deletedAt` is more
     * than this old gets hard-deleted on the next cron run. The
     * merchandiser can restore the list any time before that.
     *
     * @default 3_600_000 (1 hour)
     */
    purgePendingDeletionAfterMs?: number;

    /**
     * Cron schedule for the purge task. Accepts a standard cron string
     * or a function over the cron-time-generator builder (the
     * Vendure-canonical form). Set to `null` to disable the task
     * entirely.
     *
     * @default cron => cron.every(15).minutes()
     */
    purgePendingDeletionSchedule?:
        | string
        | ((cron: any) => string)
        | null;

    /**
     * Max number of pricelists hard-deleted per cron tick. Keeps the
     * transaction bounded so an interrupted task only loses an
     * in-flight batch; the next tick picks up from the same WHERE
     * clause.
     *
     * @default 100
     */
    purgePendingDeletionBatchSize?: number;
}
