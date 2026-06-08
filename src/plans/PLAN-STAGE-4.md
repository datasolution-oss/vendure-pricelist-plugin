# PLAN-STAGE-4 — Automated e2e test suite

> **Goal.** Convert every scenario in the manual checklists (Stage 1 §2.7
> and Stage 3 §2.6) and the unit-test matrix (Stage 2 §2.7) into named,
> executable tests that run in CI. Failures fix regressions; passes
> certify the plugin behaves as designed.
>
> Dependency: `@vendure/testing@3.6.2` was installed in Stage 0
> verification (`devDependencies`).

---

## 1. Answers to §4.1 questions

### Q1 — Test harness: `@vendure/testing`

Confirmed (Stage 0 §0.9 + installed package).

API surface from
`node_modules/@vendure/testing/lib/create-test-environment.d.ts:57`:

```ts
export declare function createTestEnvironment(
    config: Required<VendureConfig>,
): TestEnvironment;

export interface TestEnvironment {
    server: TestServer;
    adminClient: SimpleGraphQLClient;
    shopClient: SimpleGraphQLClient;
}
```

`TestServer.init(options: TestServerOptions)` populates the DB from
the supplied `InitialData` and an optional CSV. Crucially: it
**caches the populated SQLite file per test file**, so subsequent
runs skip the populate step (typically 5-15s saved per file).

### Q2 — Test database: SQLite in-memory (via `sqljs-initializer`)

`@vendure/testing` ships three initializers:

- `sqljs-initializer` — SQLite in-memory, the recommended default.
- `postgres-initializer` — requires a running Postgres.
- `mysql-initializer` — requires a running MySQL.

**Decision: SQLite (`sqljs`).** Reasons:
- No external service in CI — tests run on a clean container with
  zero setup.
- File-based snapshot cache (`.sqlite` files per test file) makes
  subsequent runs fast.
- Stage 2's design pins one Postgres-specific feature: partial unique
  index on `PriceListGroup(channelId) WHERE isDefault=true` (Stage 1
  §1.1 Q6c). SQLite supports partial unique indexes since 3.8.0; the
  generated migration must include both Postgres and SQLite syntax in
  the `up()` method, or use raw SQL guarded by
  `queryRunner.connection.options.type`. **Confirm during
  implementation** — if SQLite refuses the partial index syntax, the
  test must use a different uniqueness mechanism (e.g. a service-layer
  check). This is the highest-risk dialect divergence in the plugin.

**Postgres-parity smoke test.** One CI job runs the suite against a
Postgres container in addition to the SQLite default. This catches
dialect divergences (collation, timestamp precision, partial index
syntax) before they reach production. Triggers only on PR branches,
not on every push.

### Q3 — Fixture strategy: Admin API for setup, service calls for inner cases

**Rule of thumb:**

- **Stage 1 coverage (entities + dashboard):** seed via the **Admin API**.
  Proves the dashboard surface works end-to-end. Each test file's
  `beforeAll` performs the full
  `createPriceListGroup → createPriceList → addPriceListItem →
  createPriceListAssignment` chain through the admin client. If any
  mutation breaks, the whole test file fails — strong signal.
- **Stage 2 coverage (lookup, cascade, cache):** seed via **direct
  service calls** in `beforeAll`. The unit-test matrix has 20 rows
  covering edge cases that aren't all easily expressible as
  mutation sequences. Direct service calls (`PriceListService.create`,
  `PriceListAssignmentService.create`, etc.) bypass GraphQL parsing
  for speed and let the test author construct exact DB state.
- **Stage 3 coverage (Shop API):** seed via Admin API, **assert via
  Shop API**. End-to-end: the user-facing API returns what the
  admin-facing API put in.

**One exception** to "Stage 1 = Admin API": the channel-creation
hook that auto-creates the default group (§Q6c). This is tested by
calling `ChannelService.create()` directly from a test that wraps the
test server's NestJS module ref:

```ts
const channelService = server.app.get(ChannelService);
await channelService.create(ctx, { code: 'test-channel', ... });
const groups = await server.app.get(PriceListGroupService)
    .findAll(ctxForNewChannel);
expect(groups.items).toHaveLength(1);
expect(groups.items[0].isDefault).toBe(true);
```

### Q4 — Scenario matrix → one test name per row

Test naming convention: `[<area>] <action> -> <expected outcome>`.
Areas: `entities`, `lookup`, `cascade`, `cache`, `shop-api`, `admin-api`.

Full list in §2.2 below.

### Q5 — Time-sensitive tests (validity windows)

Vendure's `RequestContext` doesn't carry a configurable clock — the
default impls use `new Date()`. Two patterns to inject "now" in tests:

- **Pattern A — Jest fake timers** (`jest.useFakeTimers({now: ...})`).
  Affects every `new Date()` call inside the same process. Easy to
  set up; brittle when async code resolves on real timers.
- **Pattern B — explicit clock provider.** Add an injected `Clock`
  service to `DefaultPriceListResolutionStrategy` (replaces the
  inline `new Date()`). Production binding returns `new Date()`;
  test binding returns a fixed instant. **Recommended.**

**Decision: B — explicit clock provider.** Cost: one new
`@Injectable() class SystemClock { now(): Date }` in
`src/plugins/pricelist/config/system-clock.ts`. Both
`DefaultPriceListResolutionStrategy` and any validity predicate that
needs "now" inject it. Tests bind a `MockClock` in the plugin's
overridden providers list.

This change is a **Stage 2 amendment** — recorded in this Stage 4
document for visibility, will be applied during implementation as a
revision to PLAN-STAGE-2.md (per the backflow rule).

**Revision note for PLAN-STAGE-2.md:**
> 2026-05-26 — Added `SystemClock` injected service per Stage 4 §Q5.
> Replaces inline `new Date()` calls in the resolution strategy and
> validity predicates. Required for time-sensitive test injection.
> No effect on production behavior.

### Q6 — Cache invalidation assertions

At least one test must mutate a PriceList and assert the cached
resolution is invalidated *within the same process*. Pattern:

```ts
// 1. Initial lookup (cache miss → SQL → cache write)
const a = await lookup.resolvePrice(ctx, variant, 'EUR');
// 2. Mutate
await priceListItemService.update(ctx, { id: itemId, value: 9999 });
// 3. Re-lookup (cache must miss)
const b = await lookup.resolvePrice(ctx, variant, 'EUR');
expect(b.value).not.toBe(a.value);
```

The test asserts the *value* changes, not directly that the cache
was busted — equivalent observable behavior, less brittle.

A second test variant: monkey-patch the `CacheService.get` call to
record invocations, then assert call counts. Used sparingly (only
for the cache-invariant tests #15 and #16 of Stage 2's matrix).

### Q7 — Channel/currency multi-axis

Mandatory:

- One multi-channel test: list shared from `default-channel` to
  `b2b-channel`. Verify the shared list participates in lookups on
  `b2b-channel` and is read-only there.
- One multi-currency test: variant with both EUR and USD prices; list
  item only in EUR. Lookup with `ctx.currencyCode='EUR'` resolves;
  lookup with `ctx.currencyCode='USD'` falls through to standard
  pricing (no FX conversion).

Both are individual rows in §2.2.

---

## 2. Artifacts required (§4.2)

### 2.1 File layout

```text
src/plugins/pricelist/__tests__/
├── fixtures/
│   ├── initial-data.ts                 # InitialData object: zones, taxes, channels, customers
│   ├── products.csv                    # Variants: SKU-A, SKU-B, SKU-WIDGET
│   ├── test-config.ts                  # extends @vendure/testing's testConfig: adds PricelistPlugin
│   ├── seed-helpers.ts                 # createList(), addItem(), assignTo*() — Admin-API wrappers
│   └── direct-helpers.ts               # service-call wrappers for fast inner-loop seeding
├── e2e/
│   ├── pricelist-entities.e2e-spec.ts          # Stage 1 coverage
│   ├── pricelist-lookup.e2e-spec.ts            # Stage 2 lookup + selection strategies
│   ├── pricelist-cascade.e2e-spec.ts           # Stage 2 cascade + rounding
│   ├── pricelist-cache.e2e-spec.ts             # Stage 2 cache layers
│   ├── pricelist-shop-api.e2e-spec.ts          # Stage 3 Shop API
│   └── pricelist-order-snapshot.e2e-spec.ts    # Stage 3 OrderLine.pricelistProvenance
└── unit/
    ├── selection-strategies.spec.ts             # the 3 selection defaults, pure unit
    ├── rounding-strategies.spec.ts              # the 3 rounding defaults
    └── cascade-math.spec.ts                     # multiplicative stacking, round-once divergence
```

**Separation rule:** anything that requires a running Vendure server
goes under `e2e/` (uses `createTestEnvironment`). Anything testable in
isolation (pure functions: rounding, cascade math, predicate logic)
goes under `unit/` and runs without bootstrapping the server. Unit
tests run in milliseconds; e2e tests run in seconds — keeping them
separate keeps the inner-loop fast.

### 2.2 Test list (one name per scenario)

#### Unit tests (pure, no server)

`unit/selection-strategies.spec.ts`:

- `[selection] HighestPriorityWins picks list with highest priority`
- `[selection] HighestPriorityWins tiebreaker: same priority -> latest startDate`
- `[selection] HighestPriorityWins tiebreaker: same priority same date -> highest id`
- `[selection] HighestPriorityWins returns null when no candidate matches (variant, currency)`
- `[selection] CheapestWins picks lowest effective price across ABSOLUTE candidates`
- `[selection] CheapestWins handles ABSOLUTE vs PERCENTAGE on equal footing using runningPrice`
- `[selection] CheapestWins excludes PERCENTAGE candidates when base price is null`
- `[selection] MostRecentWins picks candidate with latest list.startDate`

`unit/rounding-strategies.spec.ts`:

- `[rounding] HalfUpToMinorUnit 4250.5 -> 4251`
- `[rounding] HalfUpToMinorUnit 4250.49 -> 4250`
- `[rounding] HalfDownToMinorUnit 4250.5 -> 4250`
- `[rounding] HalfDownToMinorUnit 4250.6 -> 4251`
- `[rounding] Bankers 4250.5 -> 4250 (4250 is even)`
- `[rounding] Bankers 4251.5 -> 4252 (4252 is even)`

`unit/cascade-math.spec.ts`:

- `[cascade] ABSOLUTE replaces runningPrice`
- `[cascade] PERCENTAGE compounds against current runningPrice`
- `[cascade] PERCENTAGE falls back to variant standard price when runningPrice is null`
- `[cascade] PERCENTAGE with no standard price returns null and logs warn`
- `[cascade] two stacked -10% on base 5000 = 4050 (not 4000)`
- `[cascade] round-once: base 5005 + two -10% chained = 4054 (NOT 4055 like per-step)`
- `[cascade] empty groups returns null`
- `[cascade] external short-circuit bypasses cascade entirely`
- `[cascade] preProcessGroups can drop a group from the cascade`

#### e2e tests (require running server)

`e2e/pricelist-entities.e2e-spec.ts` — Stage 1 coverage:

- `[admin-api] createPriceListGroup creates a group in current channel`
- `[admin-api] new channel auto-creates a default group`
- `[admin-api] deleting the default group is rejected`
- `[admin-api] setDefaultPriceListGroup transfers the flag atomically`
- `[admin-api] createPriceList with no groupId lands in the default group`
- `[admin-api] addPriceListItem succeeds with ABSOLUTE EUR item`
- `[admin-api] addPriceListItem succeeds with PERCENTAGE EUR item (1000 bp)`
- `[admin-api] adding a duplicate (list,variant,currency) triplet is rejected`
- `[admin-api] createPriceListAssignment with GLOBAL target`
- `[admin-api] createPriceListAssignment with CUSTOMER target`
- `[admin-api] createPriceListAssignment with CUSTOMER_GROUP target`
- `[admin-api] createPriceListAssignment on a GROUP subject`
- `[admin-api] assignPriceListToChannel adds list to target channel with chosen group`
- `[admin-api] assignPriceListToChannel rejects when group is not in target channel`
- `[admin-api] updatePriceList from non-origin channel rejects with PRICELIST_READONLY_NON_ORIGIN_CHANNEL`
- `[admin-api] addPriceListItem from non-origin channel rejects`
- `[admin-api] softDelete sets deletedAt and excludes from list queries`

`e2e/pricelist-lookup.e2e-spec.ts` — Stage 2 lookup + selection:

- `[lookup] anonymous customer + GLOBAL list returns the GLOBAL list value`
- `[lookup] specific-customer list overrides GLOBAL in the same group`
- `[lookup] customer-group list applies to all members of the group`
- `[lookup] customer in two groups: tiebreaker is deterministic`
- `[lookup] expired list (endDate in past) is filtered out`
- `[lookup] not-yet-started list (startDate in future) is filtered out`
- `[lookup] open-ended validity (both dates null) is included`
- `[lookup] soft-deleted list is filtered out`
- `[lookup] disabled list is filtered out`
- `[lookup] HighestPriorityWins (default) picks expected list`
- `[lookup] CheapestWins picks expected list (config override)`
- `[lookup] MostRecentWins picks expected list (config override)`
- `[lookup] kill switch enabled for channel returns null`

`e2e/pricelist-cascade.e2e-spec.ts` — Stage 2 cascade + rounding:

- `[cascade] worked example (Stage 2 §2.4): base 10000 → -20% → -10% = 7200`
- `[cascade] two-group ABSOLUTE then PERCENTAGE: ABS 4500 → -10% = 4050`
- `[cascade] PERCENTAGE then ABSOLUTE: ABS replaces (no compounding from prior PERCENTAGE)`
- `[cascade] mixed ABS and PERCENTAGE across 3 groups produces correct order`
- `[cascade] currency mismatch returns null`
- `[cascade] PERCENTAGE-only group with no base price returns null + warn`
- `[cascade] provenance lists every contributing entry`

`e2e/pricelist-cache.e2e-spec.ts` — Stage 2 cache:

- `[cache] Layer A: second resolve in same process hits cache (no SQL)`
- `[cache] Layer A: invalidated when a new PriceList is created in the channel`
- `[cache] Layer A: invalidated when a CustomerGroup membership changes`
- `[cache] Layer A: invalidated when an assignment is created`
- `[cache] Layer A: TTL = soonest validity boundary among candidates`
- `[cache] Layer A: TTL falls back to defaultCacheTtlMs when no boundary`
- `[cache] Layer B: same input hits the same key`
- `[cache] Layer B: invalidated by item edit (tag pricelist:list:<id>)`
- `[cache] Layer B: invalidated by standard-price change (tag pricelist:variant:<id>)`
- `[cache] Layer 0: same variant queried twice in one request → one lookup`

`e2e/pricelist-shop-api.e2e-spec.ts` — Stage 3 Shop API:

- `[shop-api] variant.price returns pricelist value when list applies`
- `[shop-api] variant.price returns standard value when no list applies`
- `[shop-api] variant.originalPrice is null when no list applies`
- `[shop-api] variant.originalPrice equals pre-pricelist price when list applies`
- `[shop-api] variant.originalPriceWithTax respects tax-included channel mode`
- `[shop-api] variant.priceListBadge.code is the last-applied list code`
- `[shop-api] variant.priceListBadge is null when exposeBadgeOnShopApi=false`
- `[shop-api] shared variant not in active channel returns no price (Vendure short-circuits)`
- `[shop-api] one collection query with 50 variants triggers <=50 PriceListLookupService calls (request-cache)`
- `[shop-api] anonymous user sees GLOBAL-assigned list price`
- `[shop-api] authenticated customer sees customer-assigned list price`

`e2e/pricelist-order-snapshot.e2e-spec.ts` — Stage 3 order line:

- `[order] addItemToOrder snapshots pricelist-adjusted unitPrice onto OrderLine`
- `[order] OrderLine.customFields.pricelistProvenance contains JSON array of contributing entries`
- `[order] cart with Vendure Promotion: promo discounts the pricelist-adjusted base`
- `[order] order is placed -> provenance custom field persists on the frozen line`
- `[order] deleting the PriceList after order placement does NOT break order detail view`

**Total: 17 unit tests + 53 e2e tests = 70 named tests.**

### 2.3 Setup/teardown blueprint

`fixtures/test-config.ts`:

```ts
import { mergeConfig } from '@vendure/core';
import { testConfig } from '@vendure/testing';
import { PricelistPlugin } from '../../pricelist.plugin';

export const pricelistTestConfig = mergeConfig(testConfig, {
    plugins: [
        PricelistPlugin.init({
            // any non-default options for tests; mostly defaults
        }),
    ],
    // SystemClock binding overridden in time-sensitive specs only
});
```

`fixtures/initial-data.ts`:

```ts
import { InitialData, LanguageCode } from '@vendure/core';

export const initialData: InitialData = {
    defaultLanguage: LanguageCode.en,
    defaultZone: 'Europe',
    countries: [/* ... */],
    taxRates: [/* zero-VAT for simplicity in most tests; one spec switches to 20% */],
    shippingMethods: [],
    paymentMethods: [],
    collections: [],
};
```

`fixtures/products.csv` — three variants:

```text
name,slug,assets,sku,price,taxCategory,stockOnHand,trackInventory,variantAssets,facets
"Widget","widget",,"SKU-WIDGET",10000,"standard",100,false,,
"Item A","item-a",,"SKU-A",5000,"standard",100,false,,
"Item B","item-b",,"SKU-B",3000,"standard",100,false,,
```

**Per-spec lifecycle** (Jest pattern):

```ts
describe('pricelist lookup', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(pricelistTestConfig);

    beforeAll(async () => {
        await server.init({
            productsCsvPath: path.join(__dirname, '../fixtures/products.csv'),
            initialData,
            customerCount: 5,
        });
        await adminClient.asSuperAdmin();
    }, 60_000);                          // 60s timeout: first run can be slow

    afterAll(async () => {
        await server.destroy();
    });

    beforeEach(async () => {
        await clearAllPricelistData(server);   // helper: TRUNCATE pricelist tables
        await seedBaselinePricelistFixtures(server, adminClient);
    });

    // tests...
});
```

**Why `beforeEach` clears + reseeds:** Vendure's
`@vendure/testing` caches the populated DB per test file, not per
test. Without clearing, mutations in test N pollute test N+1. The
`clearAllPricelistData` helper TRUNCATEs only the plugin's tables
(`price_list*`), preserving the populated products/customers/channels
(which is expensive to rebuild).

### 2.4 Test runner choice

**Decision: Jest 29.x.** Reasons:

- Matches the de facto standard for Vendure e2e tests in the
  ecosystem (the @vendure/testing examples in
  `node_modules/@vendure/testing/lib/create-test-environment.d.ts:33-53`
  use Jest's `describe`/`beforeAll`/`afterAll`).
- TypeScript-first via `ts-jest`.
- Supports `jest.useFakeTimers` — kept available even though we
  chose `SystemClock` injection for primary clock control.

Required `devDependencies` additions:

```json
"jest": "^29.7.0",
"ts-jest": "^29.1.2",
"@types/jest": "^29.5.12"
```

`jest.config.ts`:

```ts
import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    rootDir: './src',
    testMatch: ['**/__tests__/**/*.{e2e-spec,spec}.ts'],
    testTimeout: 30_000,         // e2e tests may legitimately take 10-15s
    setupFilesAfterEach: ['./src/plugins/pricelist/__tests__/setup.ts'],
    maxWorkers: 1,               // serialize: each e2e spec boots a server
    forceExit: true,
};

export default config;
```

`maxWorkers: 1` is **critical** — running e2e specs in parallel would
spin up multiple Vendure servers competing for the same SQLite cache
file (`.sqlite` snapshots from @vendure/testing's populate cache).
The unit-test specs (no server) can run in parallel; if we later
need parallel unit tests, add a separate `jest-unit.config.ts` with
`maxWorkers: undefined` and a different `testMatch`.

`package.json` script additions:

```json
"scripts": {
    "test": "jest",
    "test:unit": "jest --testPathPattern=__tests__/unit",
    "test:e2e": "jest --testPathPattern=__tests__/e2e",
    "test:watch": "jest --watch --testPathPattern=__tests__/unit"
}
```

### 2.5 CI integration

**GitHub Actions workflow (or equivalent — adjust to project's CI):**

```yaml
# .github/workflows/test.yml
name: test
on: [pull_request, push]
jobs:
    unit:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - uses: actions/setup-node@v4
              with:
                  node-version: '20'
                  cache: 'npm'
            - run: npm ci
            - run: npm run test:unit
    e2e-sqlite:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - uses: actions/setup-node@v4
              with:
                  node-version: '20'
                  cache: 'npm'
            - run: npm ci
            - run: npm run test:e2e
    e2e-postgres:
        runs-on: ubuntu-latest
        if: github.event_name == 'pull_request'
        services:
            postgres:
                image: postgres:16
                env:
                    POSTGRES_PASSWORD: test
                ports: ['5432:5432']
                options: >-
                    --health-cmd pg_isready
                    --health-interval 10s
                    --health-timeout 5s
                    --health-retries 5
        env:
            PRICELIST_TEST_DB: postgres
            PRICELIST_TEST_DB_HOST: localhost
            PRICELIST_TEST_DB_USER: postgres
            PRICELIST_TEST_DB_PASS: test
        steps:
            - uses: actions/checkout@v4
            - uses: actions/setup-node@v4
              with:
                  node-version: '20'
                  cache: 'npm'
            - run: npm ci
            - run: npm run test:e2e
```

**Runtime budget:**

- Unit suite: ~5 seconds.
- e2e SQLite suite: ~3-5 minutes for the full set on a cold cache;
  ~1-2 minutes warm (population cache reused).
- e2e Postgres suite: +30-60s for container spin-up; otherwise same.

**Total CI time per PR:** ~5-7 minutes including install. Acceptable
for a backend plugin.

---

## 3. Out of scope for Stage 4

- Performance / load tests. Explicitly excluded by meta-plan §4.3.
- Mutation testing / fuzz testing.
- Visual regression on the dashboard. The dashboard work is covered
  by the Stage 1 manual checklist; automated dashboard testing would
  need Playwright/Cypress, which the project does not currently
  configure. Out of scope unless the PO asks.
- Cross-version compatibility tests (e.g. against Vendure 3.7
  pre-release). Add when needed.

---

## 4. Resolved questions (decisions of record)

All resolved 2026-05-26 unless noted.

1. **Harness — `@vendure/testing`** (Stage 0 §0.9 install).
2. **DB — SQLite default + Postgres PR job** (§Q2).
3. **Fixture seeding — Admin API for Stage 1/3, service calls for
   Stage 2** (§Q3).
4. **Clock injection — `SystemClock` service** (§Q5). Triggers a
   Stage 2 amendment recorded at the top of PLAN-STAGE-2.md upon
   implementation.
5. **Runner — Jest 29.x with `maxWorkers: 1` for e2e** (§2.4).
6. **70 named tests total** (§2.2) — 17 unit + 53 e2e.

---

## 5. Next step

This is the final stage plan. Upon approval:

1. **All four PLAN-STAGE-<n>.md documents are ready for implementation.**
   The meta-plan's process gate ("do not implement until all four plans
   exist and are approved") is satisfied.
2. **Pending Stage 2 amendment.** Apply the `SystemClock` revision
   noted in §Q5 when implementation begins on Stage 2.
3. **Implementation order matches the stage numbering** —
   Stage 1 (entities + dashboard), then Stage 2 (lookup), then Stage 3
   (wiring), then Stage 4 (tests). Each stage's tests can be drafted
   alongside the stage's code so the test suite grows incrementally.
4. **Backflow expectation.** Per the meta-plan rule, late discoveries
   will likely surface in Stage 2 or 3. When they do, amend the
   earlier plan with a dated Revisions entry, re-request human
   review, then resume.
