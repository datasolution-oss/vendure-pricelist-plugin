let# Stage 0 — Vendure API Verification

> **Purpose.** Verifies every Vendure API the meta-plan cites against the
> installed source (`@vendure/core@3.6.2`, `@vendure/dashboard@3.6.2`).
> All signatures quoted below are **verbatim** from the installed `.d.ts`
> files — line numbers refer to the source path immediately above the
> quote.
>
> Sections marked **DIVERGENCE** require the meta-plan to be amended
> before the corresponding `PLAN-STAGE-<n>.md` is written.

---

## 0.1 Environment

- `@vendure/core`: **3.6.2** (from `package.json`)
- `@vendure/dashboard`: **3.6.2**
- `node_modules/@vendure/core` is fully populated. No `npm install` needed.
- TypeScript: 5.8.3.

## 0.2 Strategy slots — VERIFIED, with one structural divergence

### 0.2.1 `ProductVariantPriceCalculationStrategy`

File: `node_modules/@vendure/core/dist/config/catalog/product-variant-price-calculation-strategy.d.ts:22-41`

```ts
export interface ProductVariantPriceCalculationStrategy extends InjectableStrategy {
    calculate(args: ProductVariantPriceCalculationArgs): Promise<PriceCalculationResult>;
}

export interface ProductVariantPriceCalculationArgs {
    inputPrice: number;
    productVariantPrice?: ProductVariantPrice;
    productVariant: ProductVariant;
    taxCategory: TaxCategory;
    activeTaxZone: Zone;
    ctx: RequestContext;
}
```

Default impl (`default-product-variant-price-calculation-strategy.js:17-35`)
takes `inputPrice` (the price already selected by the *selection* strategy
upstream) and applies tax conversion. The pricelist plugin's
calculation-strategy subclass replaces this `inputPrice` with a
pricelist-adjusted value when an applicable list exists, then either
delegates tax handling to the default impl or replicates its logic.

**Implications vs. meta-plan §3.1.1:**
- Method signature is **single args object**, not positional. Meta-plan
  Stage 3 must show subclassing pattern (override `calculate(args)`, fall
  through to `super.calculate(args)` with a mutated `args.inputPrice`).
- The strategy receives `productVariantPrice` (the already-selected
  `ProductVariantPrice` row) and `productVariant` — both are available
  for the pricelist lookup, no extra DB hit needed.
- `RequestContext` is the *last* field of the args object.

### 0.2.2 `ProductVariantPriceSelectionStrategy` — UNANTICIPATED SIBLING SLOT

File: `node_modules/@vendure/core/dist/config/catalog/product-variant-price-selection-strategy.d.ts:20-22`

```ts
export interface ProductVariantPriceSelectionStrategy extends InjectableStrategy {
    selectPrice(ctx: RequestContext, prices: ProductVariantPrice[]):
        ProductVariantPrice | undefined | Promise<ProductVariantPrice | undefined>;
}
```

Default impl (`default-product-variant-price-selection-strategy.js:16-21`)
picks the first `ProductVariantPrice` row whose `channelId` matches the
context and whose `currencyCode` matches the context.

**DIVERGENCE FROM META-PLAN.** The meta-plan §3.1.1 talks about a single
hook. There are in fact **two related hooks** in the Vendure pricing
pipeline:

| Stage | Strategy | What it does |
|---|---|---|
| 1. Selection | `ProductVariantPriceSelectionStrategy` | picks **one** `ProductVariantPrice` row from the candidates stored on the variant (per channel/currency) |
| 2. Calculation | `ProductVariantPriceCalculationStrategy` | takes that row's `.price` as `inputPrice` and applies tax-zone logic to produce the final `PriceCalculationResult` |

**Decision for Stage 3 (recorded here, do not re-debate):**
The pricelist plugin hooks **only the calculation strategy**, not the
selection strategy. Rationale:
- The pricelist concept is **layered on top of** the variant's standard
  price (the `ProductVariantPrice` row already selected by the default
  selection strategy). It replaces the *value* used as `inputPrice`, not
  *which row* is selected.
- For ABSOLUTE pricelist entries, `inputPrice` is overwritten with the
  list value.
- For PERCENTAGE entries, the cascade starts from the standard
  `inputPrice` and compounds — exactly what the calculation slot
  receives.
- Hooking the selection strategy would force us to materialize pricelist
  entries as `ProductVariantPrice` rows, which would either pollute the
  standard table or duplicate the entity model.

Single-hook scope is therefore confirmed; the meta-plan §3.1.2 holds.
But Stage 3 must explicitly acknowledge the *sibling* selection strategy
exists so a future contributor doesn't mistakenly hook it too.

### 0.2.3 `PriceCalculationResult` — shape confirmed

File: `node_modules/@vendure/core/dist/common/types/common-types.d.ts:145-148`

```ts
export type PriceCalculationResult = {
    price: number;
    priceIncludesTax: boolean;
};
```

Exactly two fields. `price` is a number (integer minor units — see §0.3).
The result is used by *both* `ProductVariantPriceCalculationStrategy` and
`OrderItemPriceCalculationStrategy`. The `ResolvedPrice` type proposed in
meta-plan §2.2 is **internal** to the pricelist plugin — at the Vendure
boundary it must be reduced to this two-field type. Stage 2 must define
the adapter.

### 0.2.4 `InjectableStrategy`

Both strategy interfaces extend `InjectableStrategy`. This is the
Vendure mixin that supplies the optional `init(injector: Injector)` and
`destroy()` hooks (e.g. used by the default calc strategy to obtain
`TaxRateService` — see `default-product-variant-price-calculation-strategy.js:14-16`).
Any custom strategy that needs to inject services must implement `init()`.

## 0.3 Money / currency representation — VERIFIED

- `ProductVariantPrice.price` is `number`
  (`product-variant-price.entity.d.ts:16`).
- `PriceCalculationResult.price` is `number`.
- `roundMoney(value: number, quantity?: number): number`
  (`common/round-money.d.ts:8`) — applies the configured `MoneyStrategy`.
  Use this in `PriceListRoundingStrategy` defaults rather than reinventing
  rounding.
- **No `Money` wrapper type.** All monetary values are integer minor
  units (e.g. cents). The meta-plan §0.2.4 storage decision (basis points
  for `value`, cents for ABSOLUTE) needs no adjustment; just confirm in
  Stage 1 that the entity column type is `int`, not `decimal`.

## 0.4 Entity base interfaces — VERIFIED

File: `node_modules/@vendure/core/dist/common/types/common-types.d.ts:14-26`

```ts
export interface ChannelAware {
    channels: Channel[];
}

export interface SoftDeletable {
    deletedAt: Date | null;
}
```

Both are plain TypeScript interfaces, **not mixins**. An entity opts in by
implementing the interface and declaring a `@ManyToMany(() => Channel)`
relation (for `ChannelAware`) or a `@Column({ type: 'timestamp', nullable: true })`
on `deletedAt` (for `SoftDeletable`). Vendure's services then take these
interfaces into account when filtering query results.

`VendureEntity` base class (`entity/base/base.entity.d.ts:9-14`) supplies
`id`, `createdAt`, `updatedAt`. All pricelist entities will extend this.

## 0.5 `@VendurePlugin` decorator slots — VERIFIED

File: `node_modules/@vendure/core/dist/plugin/vendure-plugin.d.ts:15-63`

Relevant slots for the pricelist plugin:

| Slot | Type | Purpose |
|---|---|---|
| `entities` | `Array<Type<any>> \| (() => Array<Type<any>>)` | TypeORM entity registration |
| `configuration` | `(config: RuntimeVendureConfig) => RuntimeVendureConfig \| Promise<…>` | mutate `catalogOptions.productVariantPriceCalculationStrategy`, register custom permissions, etc. |
| `adminApiExtensions` | `APIExtensionDefinition` | `{ schema, resolvers, scalars }` |
| `shopApiExtensions` | `APIExtensionDefinition` | same shape, for the `originalPrice` field on `ProductVariant` (meta-plan §3.1.5) |
| `dashboard` | `string \| { location: string }` | path to the dashboard extension entry file (see §0.7) |
| `compatibility` | `string` | semver — bump from current `^3.0.0` to `^3.6.0` for safety |

`APIExtensionDefinition.schema` accepts a `DocumentNode` (from
`graphql-tag`) or a function `(schema?) => DocumentNode | undefined`. The
CLI template uses `gql\`\`` template strings
(`@vendure/cli/dist/commands/add/api-extension/templates/api-extensions.template.ts:3`).
This is the pattern we'll follow.

## 0.6 Permissions — VERIFIED, helper available

File: `node_modules/@vendure/core/dist/common/permission-definition.d.ts`

- `PermissionDefinition` (line 83) constructor takes
  `{ name, description?, assignable?, internal? }`. **No channel-scoping
  semantics in the constructor** — the permission name is the only
  identity. Channel scoping happens at the API layer via the `@Allow`
  decorator + `RequestContext.channel`. Cross-channel "read-only on
  shared list" rule (meta-plan §0.2.11) is therefore **a service-layer
  guard**, not a permission flag. Stage 1 must specify this guard.

- `CrudPermissionDefinition` (line 129) — convenience class that
  auto-creates `Create…`, `Read…`, `Update…`, `Delete…` for a given name.
  Meta-plan §1.1 Q7 lists exactly these four permissions for `PriceList`
  (and Group). Stage 1 should use `new CrudPermissionDefinition('PriceList')`
  and `new CrudPermissionDefinition('PriceListGroup')` — saves boilerplate.

Permissions are registered via the `configuration` slot:
`config.authOptions.customPermissions.push(...)` — confirmed by the
inline example in the same .d.ts file.

## 0.7 Admin GraphQL extension API — VERIFIED

- Schema: `gql\`extend type X { … }\`` template string, passed to
  `APIExtensionDefinition.schema`. Reference:
  `node_modules/@vendure/cli/dist/commands/add/api-extension/templates/api-extensions.template.ts:3`.
- Resolvers: NestJS class with `@Resolver()`, methods decorated with
  `@Query()` / `@Mutation()`.
- Decorators (`node_modules/@vendure/core/dist/api/decorators/`):
  - `@Allow(...permissions: Permission[])` — guards the method.
  - `@Ctx() ctx: RequestContext` — injects the request context.
  - `@Transaction()` — wraps the method in a DB transaction; required
    on every mutation that writes more than one row.
- Typegen: no separate typegen step in the CLI template. Resolvers
  declare argument and return types inline (often `any` in templates).
  Stage 1 should adopt the same convention: write SDL, then declare
  resolver method signatures with explicit TS types derived from the SDL.
  No codegen tooling is enforced by the framework — verify whether this
  project already configures one before adding it.

## 0.8 Cache services — VERIFIED, both flavors available

- **`CacheService`** (`cache/cache.service.d.ts:15`) — process-wide cache,
  backed by the configured `CacheStrategy` (default plugin uses a DB
  table; can be swapped to Redis via env config).
  - `get(key)`, `set(key, value, options?: { ttl?, tags? })`,
    `delete(key)`, `invalidateTags(tags)`.
  - `createCache(config: { getKey, options })` returns a `Cache` wrapper
    that supports lazy-fill: `cache.get(id, () => fetch())`.

- **`RequestContextCacheService`** (`cache/request-context-cache.service.d.ts:14`)
  — per-request cache, `WeakMap`-keyed on `RequestContext`. Auto-GC'd
  after the request ends.

**Mapping to the dual-cache design (meta-plan §0.2.8):**

| Meta-plan layer | Vendure service to use |
|---|---|
| Layer A — accessible lists per customer (process-wide, tag-invalidatable) | `CacheService` with tags `['pricelist:assignments', 'pricelist:customer:<id>']` |
| Layer B — computed price per (lists × variant × currency) | `CacheService` with tags `['pricelist:item:<id>', 'pricelist:list:<id>']` for selective invalidation |

Per-request memoization of the resolved candidate set inside a single
GraphQL query (e.g. when a `Collection` query resolves prices for many
variants) → `RequestContextCacheService`. Stage 2 must specify which
service backs which call.

## 0.9 `@vendure/testing` — **DIVERGENCE**

**Not installed.** `ls node_modules/@vendure/` confirms it is absent.

The meta-plan §0.4 verification table and §4.1 question 1 both assume
the package is available. **Stage 4 cannot proceed as written.**

**Options (decision deferred to Stage 4 planning, but flagged now so the
human can make a call early):**

1. **Add `@vendure/testing` to `devDependencies`** — the package exists
   on npm at version 3.6.2, parallel to core. Brings the standard
   `createTestEnvironment` fixture API and SQLite-in-memory harness.
   Recommended path; matches the meta-plan as-written. Requires
   PO sign-off on adding a dependency.
2. **Roll our own integration harness** — bootstrap the Vendure app in a
   `beforeAll` hook, talk to it via `supertest` + the GraphQL endpoint.
   More boilerplate, no schema validation on test queries.
3. **Skip e2e entirely for v1** — Stage 4 becomes unit + service-level
   tests only. Worse coverage, but unblocks shipping.

**Recommendation:** option 1. Defer the actual install command to the
Stage 4 plan, but record the decision now so Stage 1/2 know that the
e2e seed path described in meta-plan §4.1.3 ("seed via the Admin API")
remains viable.

## 0.10 Dashboard extension API — VERIFIED

- Plugin slot: `dashboard: string | { location: string }`
  (`vendure-plugin.d.ts:110`).
- Entry point pattern: a single `index.tsx` (or `.ts`) that calls
  `defineDashboardExtension({...})` for **side effects** — the function
  registers the extension in a global registry; nothing is exported.
  Reference:
  `node_modules/@vendure/dashboard/src/lib/framework/extension-api/define-dashboard-extension.ts:89`.
- `DashboardExtension` interface
  (`extension-api/extension-api-types.ts:37-131`) accepts:
  `routes`, `navSections`, `pageBlocks`, `actionBarItems`, `alerts`,
  `widgets`, `customFormComponents`, `dataTables`, `detailForms`,
  `login`, `historyEntries`, `toolbarItems` (since 3.5.3).

**Concrete in-repo example:**
`node_modules/@datasolution/vendure-plugin-devtools/lib/src/dashboard/index.tsx`
— calls `defineDashboardExtension` with a populated `login.afterForm`
slot. File layout: `dashboard/index.tsx` sibling to the plugin's TS
sources.

**Stage 1 mapping.** The dashboard screens proposed in meta-plan §1.1 Q9
(list, detail, group list/detail, share-action, assignment UI) map to:

| Meta-plan screen | Dashboard extension primitive |
|---|---|
| PriceList list page | `routes` + `dataTables` (custom data table OR a `routes` entry serving a custom React page) |
| PriceList detail | `routes` + `detailForms` |
| Group list/detail | same as above for groups |
| Share-to-channel action | `actionBarItems` on the PriceList detail route |
| Assignment UI | embedded section of the PriceList detail form |
| Nav entry | `navSections` |

Stage 1 must decide for each screen whether to use the structured
primitives (`detailForms`, `dataTables`) or full custom `routes`. The
structured primitives are cheaper but more constrained; custom routes
are more work but support arbitrary UI.

## 0.11 Existing plugin scaffold — current state

File: `src/plugins/pricelist/pricelist.plugin.ts`

```ts
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [{ provide: PRICELIST_PLUGIN_OPTIONS, useFactory: () => PricelistPlugin.options }],
    configuration: config => { return config; },
    compatibility: '^3.0.0',
})
export class PricelistPlugin {
    static options: PluginInitOptions;
    static init(options: PluginInitOptions): Type<PricelistPlugin> { ... }
}
```

Empty but well-formed. Stage 1 amendments needed:
- `entities: [...]` — populated by stage 1.
- `configuration` — register `customPermissions`, swap
  `catalogOptions.productVariantPriceCalculationStrategy` (Stage 3).
- `adminApiExtensions` / `shopApiExtensions` — added by Stage 1 (admin)
  and Stage 3 (shop).
- `dashboard: './dashboard/index.tsx'` — added by Stage 1.
- Bump `compatibility` from `^3.0.0` to `^3.6.0`.

`src/plugins/pricelist/dashboard/` exists but is empty (only `.gitkeep`).

---

## Summary of divergences to fold into the meta-plan

Before writing `PLAN-STAGE-1.md`, the meta-plan §0.2 should be amended
to reflect:

1. **§0.2 — Add §0.2.12** noting the two-slot pricing pipeline
   (selection then calculation) and recording the decision that the
   plugin hooks only the calculation slot. Cross-reference §0.2.2 in
   this verification document.
2. **§0.4 — Note** that `@vendure/testing` is not installed; flag the
   three options listed in §0.9 above; assume option 1 (install on
   demand) for planning purposes.
3. **§1.1 Q7 — Note** `CrudPermissionDefinition` exists; specify use of
   the helper instead of four individual `PermissionDefinition` calls.
4. **§3.1.1 — Quote** the verified `ProductVariantPriceCalculationStrategy`
   signature and `ProductVariantPriceCalculationArgs` shape verbatim.
   Strategy method is `calculate(args)`, single object, not positional.
5. **§2.1.3 — Map** Layer A and Layer B to `CacheService` (with
   `invalidateTags` for selective bust) plus `RequestContextCacheService`
   for intra-request memoization.
6. **§1.1 Q9 — Decide** in Stage 1 between structured dashboard
   primitives (`detailForms`, `dataTables`, `actionBarItems`) and full
   custom `routes` for each screen.

None of these divergences invalidate the meta-plan's overall structure
or staged sequence. They sharpen the assumptions about Vendure surfaces
the implementation will rely on.

## Next step

Await human review of this document. Upon approval, proceed to
`PLAN-STAGE-1.md` (entities + dashboard).
