import type { PriceListPriceCalculationStrategy } from './config/price-list-price-calculation-strategy';
import type { PriceListResolutionStrategy } from './config/price-list-resolution-strategy';
import type { PriceListRoundingStrategy } from './config/price-list-rounding-strategy';
import type { PriceListSelectionStrategy } from './config/price-list-selection-strategy';
import type { PriceListValidityPredicate } from './config/price-list-validity-predicate';

/**
 * @description
 * Init options for the Pricelist plugin. All fields optional with sensible
 * defaults applied at the call sites in `pricelist.plugin.ts`.
 *
 * - Stage 1E knobs: `purgePendingDeletion*` — soft-delete grace period
 *   + cron schedule + batch size.
 * - Stage 2 knobs: strategy slots (resolution / selection / calculation /
 *   rounding), additional validity predicates, per-channel kill switch,
 *   cache TTL safety cap.
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

    // ─── Stage 2 strategy slots ──────────────────────────────────

    /**
     * Resolution strategy: builds the candidate set of `PriceList`s
     * applicable to the current `(channel, customer)`. Defaults to
     * `DefaultPriceListResolutionStrategy`.
     */
    resolutionStrategy?: PriceListResolutionStrategy;

    /**
     * Selection strategy: picks one `PriceListItem` per group during the
     * cascade. Defaults to `HighestPriorityWinsSelectionStrategy`.
     */
    selectionStrategy?: PriceListSelectionStrategy;

    /**
     * Calculation strategy: orchestrates the cascade hooks. Defaults to
     * `DefaultPriceListPriceCalculationStrategy`.
     */
    calculationStrategy?: PriceListPriceCalculationStrategy;

    /**
     * Rounding applied to the post-cascade fractional value. Defaults to
     * `HalfUpToMinorUnitRoundingStrategy`.
     */
    roundingStrategy?: PriceListRoundingStrategy;

    /**
     * Extra validity predicates AND-combined with the default chain
     * (`date-validity`, `enabled`, `channel-match`, `soft-deleted`).
     */
    additionalValidityPredicates?: PriceListValidityPredicate[];

    /**
     * Per-channel circuit breaker (`channelId | code → boolean`). When
     * `true` for the active channel the resolution strategy returns `[]`
     * → cascade returns `null` → Vendure falls back to standard pricing.
     * The env var `PRICELIST_KILL_CHANNELS` (comma-separated channel
     * codes) is merged into this map at bootstrap.
     */
    killSwitchPerChannel?: Record<string, boolean>;

    /**
     * Safety cap for Layer-A cache entries with no validity boundary
     * among the candidates. TTL = `min(soonestFutureBoundary, this)`.
     *
     * @default 3_600_000 (1 hour)
     */
    defaultCacheTtlMs?: number;

    /**
     * Expose `ProductVariant.priceListBadge` on the Shop API (the winning
     * pricelist's code + name, for storefront marketing labels). The
     * `originalPrice` / `originalPriceWithTax` strike-through fields are
     * always exposed; only the badge is gated, since the list code/name
     * may be considered an info leak by some merchants.
     *
     * @default true
     */
    exposeBadgeOnShopApi?: boolean;
}
