# @datasolution/vendure-plugin-pricelist

A pricelist plugin for [Vendure](https://www.vendure.io/).

It adds price lists, price-list groups and channel-scoped access controls to the
Vendure Admin, including soft-delete with a configurable purge cron task and a
dashboard UI.

---

## Installation

```bash
npm install @datasolution/vendure-plugin-pricelist
```

### Peer dependencies

The plugin declares the following `peerDependencies`, which must already be
present on your Vendure project:

| Package              | Version  |
| -------------------- | -------- |
| `@vendure/core`      | `^3.6.0` |
| `@vendure/dashboard` | `^3.6.0` |

`@vendure/core` and `@vendure/dashboard` ship with any standard Vendure
project.

---

## Usage

### 1. Register the plugin

Add `PricelistPlugin` to the `plugins` array of your Vendure config:

```ts
import { VendureConfig } from '@vendure/core';
import { PricelistPlugin } from '@datasolution/vendure-plugin-pricelist';

export const config: VendureConfig = {
  // ...
  plugins: [
    PricelistPlugin.init({
      // options — see below
    })
  ]
};
```

### 2. The dashboard UI

There is **nothing extra to set up** for the dashboard. The plugin ships a
dashboard extension declared through its `dashboard` slot, and the Vendure
dashboard Vite plugin discovers it automatically — simply registering
`PricelistPlugin.init({})` in `vendure-config.ts` (step 1) is enough.

Rebuild the dashboard and you will get a new **Pricing** section in the sidebar
with **Pricelists** and **Groups**.

> The UI honours Vendure permissions: menu entries are hidden from users without
> the corresponding read permission, and the Admin API is independently guarded.

### 3. Run a database migration

The plugin adds new entities and custom fields. Generate and run a migration as
you would for any Vendure plugin change:

```bash
npx vendure migrate
```

---

## Configuration

All `init()` options are optional and have sensible defaults — calling
`PricelistPlugin.init({})` (or even registering the bare `PricelistPlugin`)
gives you a fully working plugin.

### Soft-delete / purge options

These govern the grace period between a user deleting a price list and the
cron task irreversibly purging it.

| Option                          | Type                                   | Default                            | Description                                                                                                               |
| ------------------------------- | -------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `purgePendingDeletionAfterMs`   | `number`                               | `3_600_000` (1 hour)               | Grace period between a user-initiated delete and irreversible purge. A list can be restored any time before this elapses. |
| `purgePendingDeletionSchedule`  | `string \| ((cron) => string) \| null` | `cron => cron.every(15).minutes()` | Cron schedule for the purge task. Accepts a cron string, a builder function, or `null` to **disable** the task entirely.  |
| `purgePendingDeletionBatchSize` | `number`                               | `100`                              | Max number of pricelists hard-deleted per cron tick, so an interrupted run only loses an in-flight batch.                 |

### Pricing strategy options

These are the extension points for the pricing cascade. See
[Pricing strategies & overriding](#pricing-strategies--overriding) below for
how they fit together.

| Option                         | Type                                | Default                                    | Description                                                                                                          |
| ------------------------------ | ----------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `resolutionStrategy`           | `PriceListResolutionStrategy`       | `DefaultPriceListResolutionStrategy`       | Builds the candidate set of price lists applicable to the current `(channel, customer)`, grouped by group.           |
| `selectionStrategy`            | `PriceListSelectionStrategy`        | `CheapestWinsSelectionStrategy`            | Picks the one winning `PriceListItem` within each group (groups are ordered by `PriceListGroup.priority`; within a group, candidates carry no intrinsic priority — the selection strategy decides). |
| `calculationStrategy`          | `PriceListPriceCalculationStrategy` | `DefaultPriceListPriceCalculationStrategy` | Orchestrates the cascade and exposes the `preProcessGroups` / `tryExternalPrice` hooks.                              |
| `roundingStrategy`             | `PriceListRoundingStrategy`         | `HalfUpToMinorUnitRoundingStrategy`        | Resolves the fractional cents produced by the cascade into an integer minor unit.                                    |
| `additionalValidityPredicates` | `PriceListValidityPredicate[]`      | `[]`                                       | Extra validity checks **AND-combined** with the built-in chain (`date`, `enabled`, `channel-match`, `soft-deleted`). |

### Operational options

| Option                 | Type                      | Default              | Description                                                                                                                                                                                                                       |
| ---------------------- | ------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `killSwitchPerChannel` | `Record<string, boolean>` | `{}`                 | Per-channel circuit breaker, keyed by channel **id or code**. When `true` for the active channel, no pricelist applies and Vendure falls back to standard pricing. Merged with the `PRICELIST_KILL_CHANNELS` env var (see below). |
| `defaultCacheTtlMs`    | `number`                  | `3_600_000` (1 hour) | Safety cap for the resolution cache when no validity boundary applies. The effective TTL is `min(soonestFutureBoundary, this)`.                                                                                                   |
| `exposeBadgeOnShopApi` | `boolean`                 | `true`               | Expose `ProductVariant.priceListBadge` (the winning list's code + name) on the Shop API. The strike-through `originalPrice` fields are always exposed; only the badge — which may leak list naming — is gated.                    |
| `recordOrderLineProvenance` | `boolean`            | `true`               | Persist a JSON snapshot of the cascade that produced the price on each new `OrderLine` (`customFields.pricelistProvenance`, internal/readonly). Disable to skip the per-line write — e.g. when a parallel audit pipeline already captures it.            |

Full example:

```ts
PricelistPlugin.init({
  // soft-delete / purge
  purgePendingDeletionAfterMs: 24 * 60 * 60 * 1000, // 24 hours
  purgePendingDeletionSchedule: cron => cron.every(1).hours(),
  purgePendingDeletionBatchSize: 50,

  // pricing strategies
  selectionStrategy: new CheapestWinsSelectionStrategy(),
  roundingStrategy: new BankersRoundingStrategy(),
  additionalValidityPredicates: [new MyFeatureFlagPredicate()],

  // operational
  killSwitchPerChannel: { 'legacy-channel': true },
  defaultCacheTtlMs: 5 * 60 * 1000, // 5 minutes
  exposeBadgeOnShopApi: false,
  recordOrderLineProvenance: false
});
```

#### The `PRICELIST_KILL_CHANNELS` environment variable

For an emergency kill switch you don't want to redeploy code for, set the
`PRICELIST_KILL_CHANNELS` env var to a comma-separated list of **channel
codes**:

```bash
PRICELIST_KILL_CHANNELS=black-friday-channel,legacy-shop
```

These are merged into `killSwitchPerChannel` at bootstrap (the programmatic
option wins on key conflicts). Any listed channel falls back to Vendure's
standard pricing with no DB round-trip.

---

## Pricing strategies & overriding

> **⚠️ This plugin overrides Vendure's standard price calculation strategies.**
> On registration it replaces `config.catalogOptions.productVariantPriceCalculationStrategy`
> and `config.orderOptions.orderItemPriceCalculationStrategy` with its own
> implementations so that resolved pricelist prices flow into catalog/shop
> pricing and the cart/order (the order-line strategy resolves with the line
> quantity, so `stepQuantity` tiers apply on the order — the catalog hook only
> resolves at quantity 1). When no pricelist applies these delegate to
> Vendure's default behaviour unchanged. If another plugin also sets either
> strategy, the last one registered wins — see the [load order note](#replace-resolution-or-selection-wholesale).

### How the cascade works

When Vendure asks the plugin for a variant's price, the request flows through
four cooperating strategies. Keeping them separate means you can swap one
without reimplementing the others.

```
                               (channel, customer, variant, currency, quantity)
                                                       │
   1. PriceListResolutionStrategy                      ▼
      "Which lists apply, grouped?"       ┌──────────────────────────────┐
        • reads access assignments        │ candidate groups, sorted by  │
        • runs validity predicates        │ group.priority ASC           │
        • honours the kill switch         └──────────────┬───────────────┘
        • caches the result (Layer A)                    │
                                                         ▼
   2. PriceListPriceCalculationStrategy     ┌───────────────────────────┐
      "Drive the cascade"                   │ preProcessGroups() hook   │
        • preProcessGroups (filter/inject)  │ tryExternalPrice() hook   │
        • tryExternalPrice (short-circuit)  │ then loop groups DESC...  │
        • walk groups high→low priority,    └────────────┬──────────────┘
          stop on the first ABSOLUTE                     │ per group
   3. PriceListSelectionStrategy                         ▼
      "Which item wins in this group?"     ┌───────────────────────────┐
        • cheapest / most-recent           │ one PriceListItem (or     │
          (no intra-group priority)        │ null) → apply ABSOLUTE or │
        • resolves the stepQuantity tier   │ PERCENTAGE to runningPrice│
                                           └────────────┬──────────────┘
                                                        │ after last group
   4. PriceListRoundingStrategy                         ▼
      "Resolve fractional cents"           ┌───────────────────────────┐
        • half-up / half-down / bankers    │ ResolvedPrice (integer    │
                                           │ minor unit) + provenance  │
                                           └───────────────────────────┘
```

Two design rules worth knowing:

- **Cascade is `group.priority DESC` with early exit.** Groups are walked from
  highest to lowest priority. PERCENTAGE contributions accumulate as a
  multiplier; the first ABSOLUTE encountered becomes the base price and the
  walk stops there. If no ABSOLUTE applies, the variant's standard catalog
  price plays that role. (`PriceList` itself has no priority — the group is
  the unit of ordering, and the selection strategy disambiguates ties inside
  a group.)
- **Round once, at the end.** The cascade keeps a fractional `runningPrice`
  and only hands it to the rounding strategy after resolution, avoiding
  per-step drift on chained percentages.

An empty candidate set (no list matched, kill switch on, etc.) makes the whole
chain return `null`, and Vendure falls back to its standard pricing — the
no-pricelist code path is byte-for-byte unchanged.

### The shipped defaults

| Slot        | Default                                                           | Other shipped implementations                                      |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Resolution  | `DefaultPriceListResolutionStrategy`                              | —                                                                  |
| Selection   | `CheapestWinsSelectionStrategy`                                   | `MostRecentWinsSelectionStrategy`                                  |
| Calculation | `DefaultPriceListPriceCalculationStrategy`                        | —                                                                  |
| Rounding    | `HalfUpToMinorUnitRoundingStrategy`                               | `HalfDownToMinorUnitRoundingStrategy`, `BankersRoundingStrategy`   |
| Validity    | `date` + `enabled` + `channel-match` + `soft-deleted` (always on) | add your own via `additionalValidityPredicates`                    |

All interfaces and default implementations are exported from the package root:

```ts
import {
  // interfaces (implement to build your own)
  PriceListResolutionStrategy,
  PriceListSelectionStrategy,
  PriceListPriceCalculationStrategy,
  PriceListRoundingStrategy,
  PriceListValidityPredicate,
  // defaults (extend or pass through)
  DefaultPriceListPriceCalculationStrategy,
  CheapestWinsSelectionStrategy,
  BankersRoundingStrategy
} from '@datasolution/vendure-plugin-pricelist';
```

The package root also re-exports the plugin's **services**
(`PriceListLookupService`, `PriceListService`, …) for injection into custom
strategies, its **entities** (`PriceList`, `PriceListItem`, …), the cascade
value types (`ResolvedPrice`, `ResolvedPriceListGroup`), the
`PRICELIST_PLUGIN_OPTIONS` injection token, and the GraphQL error-code
constants.

### Overriding a strategy

Every slot is an `InjectableStrategy`: implement the interface, optionally use
the `init(injector)` lifecycle hook to grab services, and pass the instance to
`init()`.

#### Pick a different shipped behaviour

The cheapest swap — use a different bundled implementation:

```ts
import {
  PricelistPlugin,
  CheapestWinsSelectionStrategy,
  BankersRoundingStrategy
} from '@datasolution/vendure-plugin-pricelist';

PricelistPlugin.init({
  selectionStrategy: new CheapestWinsSelectionStrategy(),
  roundingStrategy: new BankersRoundingStrategy()
});
```

#### Add a validity predicate

The most common extension is additive — a new filter on the candidate set.
Predicates are **pure** (no DB / async work) so the chain stays cheap, and they
are AND-combined with the built-in chain:

```ts
import { RequestContext } from '@vendure/core';
import { PricelistPlugin, PriceListValidityPredicate, PriceList } from '@datasolution/vendure-plugin-pricelist';

class FeatureFlagPredicate implements PriceListValidityPredicate {
  test(ctx: RequestContext, list: PriceList, nowUtc: Date): boolean {
    // exclude lists tagged "beta" unless the channel opted in
    return !list.customFields?.beta || ctx.channel.code === 'beta-channel';
  }
}

PricelistPlugin.init({
  additionalValidityPredicates: [new FeatureFlagPredicate()]
});
```

#### Override only the cascade hooks (recommended)

The calculation strategy is an **abstract class**, not a bare interface, on
purpose: the cascade body is system semantics you should reuse. Subclass
`DefaultPriceListPriceCalculationStrategy` and override only the two hooks:

- **`preProcessGroups(ctx, variant, groups)`** — filter or augment the resolved
  groups before the cascade runs. Return `[]` to short-circuit to "no
  pricelist". Good for dropping a PROMO group for B2B contract customers, or
  injecting a synthetic group sourced from an external system.
- **`tryExternalPrice(ctx, variant, currency, quantity)`** — return a fully
  resolved price to bypass the cascade entirely (e.g. a configurator or
  real-time ERP). The returned price **must** set `source: 'EXTERNAL'`.

```ts
import { Injector, RequestContext, ProductVariant } from '@vendure/core';
import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { PricelistPlugin, DefaultPriceListPriceCalculationStrategy } from '@datasolution/vendure-plugin-pricelist';

class ContractAwareCalculationStrategy extends DefaultPriceListPriceCalculationStrategy {
  private contractService: MyContractService;

  init(injector: Injector) {
    super.init(injector); // keep the default's selection + rounding wiring
    this.contractService = injector.get(MyContractService);
  }

  protected async preProcessGroups(ctx, variant, groups) {
    const onContract = await this.contractService.isOnContract(ctx);
    // B2B contract customers never see the PROMO group
    return onContract ? groups.filter(g => g.group.code !== 'promo') : groups;
  }

  protected async tryExternalPrice(ctx, variant, currencyCode, quantity) {
    const price = await this.contractService.lookup(ctx, variant, currencyCode);
    if (price == null) return null; // fall through to the normal cascade
    return { value: price, currencyCode, provenance: [], source: 'EXTERNAL' };
  }
}

PricelistPlugin.init({
  calculationStrategy: new ContractAwareCalculationStrategy()
});
```

#### Replace resolution or selection wholesale

For deeper changes — e.g. deriving access from a customer attribute or an
external system instead of the materialised assignment fields — implement
`PriceListResolutionStrategy` or `PriceListSelectionStrategy` directly. Mind
the documented contracts:

- A resolution strategy **must not** pick a winner inside a group (that's the
  selection strategy's job) and must return groups sorted `priority ASC`.
- A selection strategy returns at most one `PriceListItem` per group and must
  honour the `quantity` argument for `stepQuantity` tier lookup.

> **Load order note:** the plugin sets Vendure's
> `productVariantPriceCalculationStrategy` and
> `orderItemPriceCalculationStrategy`. If another plugin also overrides those,
> the last one registered wins — order your `plugins` array accordingly.

---

## Order-line price provenance

Whenever a pricelist price is applied to an order line, the plugin records a
**denormalised snapshot** of _how_ that price was reached. This is meant for
support and forensics — answering "why did this customer pay €68.40 on this
line six months ago?" without re-running (or trusting) the cascade against
data that may since have changed.

### Where it is stored

The snapshot lives in an **internal** custom field on `OrderLine`:

```ts
config.customFields.OrderLine.push({
  name: 'pricelistProvenance',
  type: 'text',      // serialised JSON
  nullable: true,    // null when no pricelist applied
  public: false,
  readonly: true,
  internal: true,    // NOT exposed on the Admin or Shop GraphQL API
});
```

Because it is `internal: true`, the field is **not exposed on the GraphQL
API** — it is a back-office record read directly from the database (e.g. in a
support tool or report), not a storefront/admin field.

### What gets serialised

The column holds `JSON.stringify(resolvedPrice.provenance)` — an **ordered
array** of `ResolvedPriceProvenanceEntry`, one entry per group that
contributed to the cascade, lowest-priority group first. Each entry is the
breadcrumb of a single cascade step:

```json
[
  {
    "listId": "12",
    "listCode": "B2C-EUR",
    "groupId": "3",
    "groupCode": "base",
    "itemId": "87",
    "stepQuantity": 1,
    "valueType": "ABSOLUTE",
    "value": 8550
  },
  {
    "listId": "21",
    "listCode": "WHOLESALE",
    "groupId": "5",
    "groupCode": "promo",
    "itemId": "140",
    "stepQuantity": 10,
    "valueType": "PERCENTAGE",
    "value": 2000
  }
]
```

Reading the `value` field:

- `valueType: "ABSOLUTE"` → integer **minor units** (cents) — `8550` = €85.50.
- `valueType: "PERCENTAGE"` → **basis points** — `2000` = −20%.

`stepQuantity` is the volume tier that matched on that list for the line's
quantity. An empty array (`[]`) means the price came from the external
short-circuit (`source: 'EXTERNAL'`); a `null` column means no pricelist
applied and the line uses Vendure's standard price.

### When it is written

A **blocking** event handler (`OrderLineProvenanceSubscriber`) writes the
snapshot, so it lands inside the same transaction as the order mutation rather
than racing with downstream reads:

- It fires on `OrderLineEvent` of type **`updated`**, not `created` — Vendure
  creates the line at quantity 0 and only sets the real quantity afterwards,
  so resolving on `updated` lets the correct `stepQuantity` tier match the
  line's actual quantity.
- It is written **once**: the snapshot reflects the price the customer first
  saw and is not refreshed on later edits (a line that first resolved to "no
  list" may re-snapshot, harmlessly, to the same `null`).
- The JSON **stands alone — there is no foreign key** to the `PriceList`.
  Deleting or editing a pricelist later does **not** alter the provenance on
  already-placed orders.
- A failure to record provenance is caught and logged; it never rolls back the
  order itself.

---

## Compatibility

| Plugin  | Vendure  |
| ------- | -------- |
| `1.x.x` | `^3.6.0` |

---

## License

[MIT](./LICENSE.md)

---

## Contributing

Source code and contribution guidelines live at
[github.com/datasolution-oss/vendure-pricelist-plugin](https://github.com/datasolution-oss/vendure-pricelist-plugin).
See [`DEVELOPMENT.md`](./DEVELOPMENT.md) for the contributor workflow.
