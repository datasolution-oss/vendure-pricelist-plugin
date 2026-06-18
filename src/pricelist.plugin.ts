import { LanguageCode, PluginCommonModule, Type, VendurePlugin } from '@vendure/core';

import { adminApiExtensions, ALL_RESOLVERS, ALL_SHOP_RESOLVERS, shopApiExtensions } from './api';
import {
  CheapestWinsSelectionStrategy,
  DefaultPriceListPriceCalculationStrategy,
  DefaultPriceListResolutionStrategy,
  HalfUpToMinorUnitRoundingStrategy
} from './config/defaults';
import { PRICELIST_PLUGIN_OPTIONS } from './constants';
import { DEFAULT_PRICE_LIST_GROUP_FIELD } from './custom-fields';
import { ALL_ENTITIES } from './entities';
import { PriceListGroup } from './entities/price-list-group.entity';
import {
  assignPriceListGroupPermission,
  managePriceListAccessPermission,
  priceListGroupPermission,
  priceListPermission,
  sharePriceListPermission
} from './permissions';
import { purgePendingDeletionTask } from './scheduled-tasks/purge-pending-deletion-task';
import { ALL_SERVICES } from './services';
import { PricelistOrderItemPriceCalculationStrategy } from './strategies/pricelist-order-item-price-calculation.strategy';
import { PricelistVariantPriceCalculationStrategy } from './strategies/pricelist-variant-price-calculation.strategy';
import { OrderLineProvenanceSubscriber } from './subscribers/order-line-provenance.subscriber';
import { PluginInitOptions } from './types';

const DEFAULT_PURGE_AFTER_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_PURGE_BATCH_SIZE = 100;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour safety cap for Layer A

/**
 * Parses `PRICELIST_KILL_CHANNELS` (comma-separated channel codes) into
 * the `killSwitchPerChannel` shape — keyed on code, since ops write the
 * env var with channel codes, not numeric ids. The resolution strategy
 * checks the map against both `ctx.channelId` and `ctx.channel.code`.
 */
function parseKillSwitchEnv(): Record<string, boolean> {
  const raw = process.env.PRICELIST_KILL_CHANNELS;
  if (!raw) return {};
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .reduce<Record<string, boolean>>((acc, code) => {
      acc[code] = true;
      return acc;
    }, {});
}

/**
 * Merges defaults into the consumer's init options. Strategy instances are
 * constructed once per `init()` call (which runs at most once per process).
 */
function withDefaults(options: PluginInitOptions): PluginInitOptions {
  return {
    purgePendingDeletionAfterMs: options.purgePendingDeletionAfterMs ?? DEFAULT_PURGE_AFTER_MS,
    purgePendingDeletionSchedule: options.purgePendingDeletionSchedule,
    purgePendingDeletionBatchSize: options.purgePendingDeletionBatchSize ?? DEFAULT_PURGE_BATCH_SIZE,
    resolutionStrategy: options.resolutionStrategy ?? new DefaultPriceListResolutionStrategy(),
    selectionStrategy: options.selectionStrategy ?? new CheapestWinsSelectionStrategy(),
    calculationStrategy: options.calculationStrategy ?? new DefaultPriceListPriceCalculationStrategy(),
    roundingStrategy: options.roundingStrategy ?? new HalfUpToMinorUnitRoundingStrategy(),
    additionalValidityPredicates: options.additionalValidityPredicates ?? [],
    killSwitchPerChannel: {
      ...parseKillSwitchEnv(),
      ...(options.killSwitchPerChannel ?? {})
    },
    defaultCacheTtlMs: options.defaultCacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    exposeBadgeOnShopApi: options.exposeBadgeOnShopApi ?? true,
    recordOrderLineProvenance: options.recordOrderLineProvenance ?? true
  };
}

@VendurePlugin({
  imports: [PluginCommonModule],
  providers: [
    ...ALL_SERVICES,
    OrderLineProvenanceSubscriber,
    { provide: PRICELIST_PLUGIN_OPTIONS, useFactory: () => PricelistPlugin.options }
  ],
  entities: ALL_ENTITIES,
  adminApiExtensions: {
    schema: adminApiExtensions,
    resolvers: ALL_RESOLVERS
  },
  shopApiExtensions: {
    schema: shopApiExtensions,
    resolvers: ALL_SHOP_RESOLVERS
  },
  configuration: config => {
    // Normalise options with defaults even when the plugin was added
    // without `.init()` (bare `PricelistPlugin`). The pricing strategies
    // below are registered unconditionally and call the resolution
    // strategy, so the strategy slots MUST be populated or every variant
    // price calc would crash. `withDefaults` is idempotent (the `??`
    // keeps any already-provided strategy instances).
    PricelistPlugin.options = withDefaults(PricelistPlugin.options);

    config.authOptions.customPermissions.push(
      priceListPermission,
      priceListGroupPermission,
      sharePriceListPermission,
      assignPriceListGroupPermission,
      managePriceListAccessPermission
    );

    // Stage 3 — hook the variant price calculation so resolved
    // pricelist prices flow into Vendure's catalog/shop pricing.
    // The inner strategy extends Vendure's default (no-pricelist
    // path is byte-for-byte unchanged); the caching decorator adds
    // the §2.3 strike-through side effect (per-request cache of the
    // original price + winning badge). Last plugin to set this wins
    // — mind load order if another plugin also overrides it.
    ((config.catalogOptions.productVariantPriceCalculationStrategy = new PricelistVariantPriceCalculationStrategy()),
      // Order-line price resolution with the line quantity, so
      // stepQuantity tiers apply on the cart/order (the catalog hook
      // above only resolves at qty 1). Reverses PLAN-STAGE-3 §Q2.
      (config.orderOptions.orderItemPriceCalculationStrategy = new PricelistOrderItemPriceCalculationStrategy()));

    // Stage 3 §2.4 — denormalised pricelist provenance snapshot on the
    // order line (support/forensics). Written by
    // OrderLineProvenanceSubscriber on line creation. Internal + readonly
    // JSON text; never queried by id.
    config.customFields.OrderLine.push({
      name: 'pricelistProvenance',
      type: 'text',
      nullable: true,
      public: false,
      readonly: true,
      internal: true
    });

    // Channel-side default PriceListGroup (replaces the former
    // `PriceListChannelDefaultGroup` entity). A relation custom field on
    // `Channel` — mirrors `Channel.defaultTaxZone` — so "one default per
    // channel" is structural (the FK lives on the channel row) and the
    // value is exposed for free as `Channel.customFields.defaultPriceListGroup`.
    // `eager: false`: callers load it explicitly via
    // `relations: ['customFields.defaultPriceListGroup']`.
    config.customFields.Channel.push({
      name: DEFAULT_PRICE_LIST_GROUP_FIELD,
      type: 'relation',
      entity: PriceListGroup,
      graphQLType: 'PriceListGroup',
      list: false,
      nullable: true,
      eager: false,
      public: false,
      // Hidden from the API + dashboard: the channel's default group is
      // managed through the dedicated `setDefaultPriceListGroup` mutation /
      // `priceListDefaultGroup` query and the pricelist UI, not as a raw
      // relation field on the Channel detail page. `internal` only affects
      // GraphQL exposure — the DB column is unchanged (no migration) and the
      // value is still read server-side via the entity relation.
      internal: true,
      label: [{ languageCode: LanguageCode.en, value: 'Default price list group' }],
      description: [
        {
          languageCode: LanguageCode.en,
          value:
            "The channel's default price list group. A new price list " +
            'created on this channel with no explicit group lands here.'
        }
      ]
    });

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
            olderThanMs: PricelistPlugin.options.purgePendingDeletionAfterMs ?? DEFAULT_PURGE_AFTER_MS,
            batchSize: PricelistPlugin.options.purgePendingDeletionBatchSize ?? DEFAULT_PURGE_BATCH_SIZE
          }
        })
      );
    }

    return config;
  },
  dashboard: './dashboard/index.tsx',
  compatibility: '^3.6.0'
})
export class PricelistPlugin {
  static options: PluginInitOptions = {};

  static init(options: PluginInitOptions = {}): Type<PricelistPlugin> {
    this.options = withDefaults(options);
    return PricelistPlugin;
  }
}
