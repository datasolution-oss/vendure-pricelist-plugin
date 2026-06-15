# PLAN-STAGE-2 — Lookup logic (strategies + cache + service)

> **Goal.** Produce a pure, unit-tested service that, given a
> `RequestContext` + variant + currency, returns the effective price
> (or `null`). **Not yet wired into Vendure's pricing pipeline** —
> Stage 3 does that.
>
> Stage 1 entities are taken as given (no schema changes here). Stage 0
> verification doc is the source of truth for Vendure API signatures.

---

## 1. Answers to §2.1 questions

### Q1 — Strategy contracts (the four public seams)

The plugin exposes **four** abstract strategy classes. Each is registered
via a single plugin option; the plugin ships **default impls** so a
zero-config consumer gets working behavior.

#### 1.1.1 `PriceListResolutionStrategy`

**Purpose.** Gather all `PriceList`s applicable to the current context,
grouped by `PriceListGroup`. Does NOT pick a single winner. The default
impl reads materialized assignments; custom impls add derived
assignments (by naming convention, by customer attribute — meta-plan
§0.2.7).

```ts
// src/plugins/pricelist/config/price-list-resolution-strategy.ts
import { Injector, RequestContext, ID } from '@vendure/core';
import { InjectableStrategy } from '@vendure/core/dist/common/types/injectable-strategy';
import { PriceListGroup } from '../entities/price-list-group.entity';
import { PriceList } from '../entities/price-list.entity';

/**
 * One group's contribution to the candidate set: the group itself
 * plus every PriceList in it that passed the validity + assignment
 * filters. Ordered by PriceList.priority DESC so the SelectionStrategy
 * sees highest-priority candidates first.
 */
export interface ResolvedPriceListGroup {
    group: PriceListGroup;
    candidates: PriceList[];
}

export interface PriceListResolutionStrategy extends InjectableStrategy {
    /**
     * Returns the candidate set: every PriceList accessible to the
     * current customer in the current channel, that passes validity
     * and is enabled, grouped by PriceListGroup and ordered
     * ascending by group.priority (lowest first — base prices before
     * promos, ready for the cascade).
     *
     * Returns [] when no list applies (anonymous + no GLOBAL
     * assignments, etc.).
     *
     * The implementation MUST NOT pick a winner inside any group —
     * that is the SelectionStrategy's job.
     */
    resolve(
        ctx: RequestContext,
        customerId: ID | undefined,
    ): Promise<ResolvedPriceListGroup[]>;
}
```

#### 1.1.2 `PriceListSelectionStrategy`

**Purpose.** Pick **one** `PriceListItem` from one group's candidate
lists, for the current `(variant, currency)`. Defaults shipped:
`HighestPriorityWins` (default), `CheapestWins`, `MostRecentWins`
(meta-plan §0.2.2).

```ts
// src/plugins/pricelist/config/price-list-selection-strategy.ts
import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { ID, RequestContext, ProductVariant } from '@vendure/core';
import { InjectableStrategy } from '@vendure/core/dist/common/types/injectable-strategy';
import { PriceListItem } from '../entities/price-list-item.entity';
import { ResolvedPriceListGroup } from './price-list-resolution-strategy';

export interface PriceListSelectionStrategy extends InjectableStrategy {
    /**
     * Selects ONE PriceListItem from the group's candidate lists for
     * (variant, currency), or returns null if nothing in the group
     * matches.
     *
     * `runningPrice` is the cascade price *as it stands before this
     * group fires* (null on the very first group when no base price
     * has been resolved yet). Required for CheapestWins to compare
     * an ABSOLUTE candidate against the post-PERCENTAGE result of
     * any other candidate on equal footing.
     */
    selectWithinGroup(
        ctx: RequestContext,
        variant: ProductVariant,
        currencyCode: CurrencyCode,
        group: ResolvedPriceListGroup,
        runningPrice: number | null,
    ): Promise<PriceListItem | null>;
}
```

#### 1.1.3 `PriceListPriceCalculationStrategy`

**Purpose.** Orchestrate: run two hook methods then the default
cascade. Hooks let advanced B2B consumers filter/inject groups per
customer and short-circuit to external pricing — meta-plan §0.2.5.

```ts
// src/plugins/pricelist/config/price-list-price-calculation-strategy.ts
import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { RequestContext, ProductVariant } from '@vendure/core';
import { InjectableStrategy } from '@vendure/core/dist/common/types/injectable-strategy';
import { ResolvedPriceListGroup } from './price-list-resolution-strategy';
import { ResolvedPrice } from '../types/resolved-price';

export abstract class PriceListPriceCalculationStrategy implements InjectableStrategy {
    /**
     * Top-level entry: runs preProcessGroups → tryExternalPrice → cascade.
     * Default impl in DefaultPriceListPriceCalculationStrategy.
     *
     * Returns null if no list applies (caller must fall back to
     * Vendure's standard price).
     */
    abstract calculate(
        ctx: RequestContext,
        variant: ProductVariant,
        currencyCode: CurrencyCode,
        groups: ResolvedPriceListGroup[],
    ): Promise<ResolvedPrice | null>;

    /**
     * Hook 1 (default: identity).
     * Filter or augment the resolved groups for this customer.
     * Typical custom uses:
     *  - drop the PROMO group for customers on a B2B contract;
     *  - inject a synthetic "CONTRACT-OVERRIDE" group sourced from an
     *    external system.
     */
    protected async preProcessGroups(
        ctx: RequestContext,
        variant: ProductVariant,
        groups: ResolvedPriceListGroup[],
    ): Promise<ResolvedPriceListGroup[]> {
        return groups;
    }

    /**
     * Hook 2 (default: null).
     * Return a fully resolved price to short-circuit the cascade. Used
     * for external price sources (configurator, ERP real-time, etc.).
     * The returned `ResolvedPrice.provenance` should mark the source.
     */
    protected async tryExternalPrice(
        ctx: RequestContext,
        variant: ProductVariant,
        currencyCode: CurrencyCode,
    ): Promise<ResolvedPrice | null> {
        return null;
    }
}
```

The default impl is a concrete subclass `DefaultPriceListPriceCalculationStrategy`
that calls the two hooks then runs the cascade (see §1.2.3 below).

**Why this strategy is the "nuclear" replacement.** Selection and
rounding are merchandiser preferences. The cascade itself (lowest →
highest, replace vs. compound, fall back to standard price for first
percentage) is system semantics. We only expose it as a strategy
because the two **hooks** are real enterprise requirements; the cascade
body itself is intended to be reused by every consumer via subclassing
the default.

#### 1.1.4 `PriceListRoundingStrategy`

**Purpose.** End-of-cascade rounding. Defaults: `HalfUpToMinorUnit`
(default), `HalfDownToMinorUnit`, `Bankers`.

```ts
// src/plugins/pricelist/config/price-list-rounding-strategy.ts
import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { InjectableStrategy } from '@vendure/core/dist/common/types/injectable-strategy';

export interface PriceListRoundingStrategy extends InjectableStrategy {
    /**
     * Rounds a *post-cascade* monetary value to an integer minor unit
     * (cents). Input may be fractional after multiplicative
     * percentage application; output MUST be a non-negative integer.
     * Currency is passed for jurisdictions where minor-unit count
     * differs (e.g. JPY uses 0 minor units), but all currencies we
     * support today use 2 minor units — this is forward-compatibility.
     */
    round(value: number, currencyCode: CurrencyCode): number;
}
```

**Why the split.** Selection answers "which entry wins" — merchandiser
preference. Rounding answers "how do we resolve fractional cents" —
finance/legal preference. They are independently swappable;
`HalfUpToMinorUnitRoundingStrategy` is the right choice for a French
B2C site, `BankersRoundingStrategy` is the right choice for a financial
services merchant. Bundling them would force "I want cheapest-wins but
bankers-rounding" consumers to reimplement both.

#### 1.1.5 Validity predicate chain (NOT a top-level strategy)

Per meta-plan §0.2.9, validity rules (date, enabled, channel-match) are
a **composable predicate list inside the default resolution strategy**,
not a public strategy in their own right. Reason: the most common
extension shape ("add a new filter") is additive, not replacing — a
list of predicates AND-combined fits that better than a strategy slot
that forces the consumer to reimplement the whole resolution.

```ts
// src/plugins/pricelist/config/price-list-validity-predicate.ts
import { RequestContext } from '@vendure/core';
import { PriceList } from '../entities/price-list.entity';

export interface PriceListValidityPredicate {
    /**
     * Return true if the PriceList passes this predicate's check at
     * the resolution moment captured by `nowUtc`. False excludes the
     * list from the candidate set.
     */
    test(ctx: RequestContext, list: PriceList, nowUtc: Date): boolean;
}
```

Defaults shipped: see §1.5 below.

### Q2 — Default implementations

#### 1.2.1 `DefaultPriceListResolutionStrategy`

Pseudocode:

```text
resolve(ctx, customerId):
    nowUtc = new Date()          # captured ONCE per call, reused everywhere

    # Cache A — accessible lists for (channel, customer, groups)
    cacheKey = `pricelist:resolution:{channelId}:{customerId|"anon"}:{groupIds.sort().join(",")}`
    cached = await cacheService.get(cacheKey)
    if cached and nowUtc < cached.expiresAt:
        return cached.groups       # cache hit, fast path

    # SQL 1 — direct list assignments
    directListIds = SELECT subjectId
                    FROM price_list_assignment
                    WHERE subjectType='LIST'
                      AND channelId = ctx.channelId
                      AND (
                           targetType='GLOBAL'
                        OR (targetType='CUSTOMER' AND targetId = customerId)
                        OR (targetType='CUSTOMER_GROUP' AND targetId IN customer.groupIds)
                      )

    # SQL 2 — group assignments → expand to all lists in those groups
    assignedGroupIds = SELECT subjectId
                       FROM price_list_assignment
                       WHERE subjectType='GROUP' AND <same target filter>
    groupExpandedListIds = SELECT plc.priceListId
                           FROM price_list_channel plc
                           WHERE plc.channelId = ctx.channelId
                             AND plc.groupId IN assignedGroupIds

    allListIds = union(directListIds, groupExpandedListIds)

    # SQL 3 — load lists with their channel-group mapping
    lists = SELECT pl.*, plc.groupId, g.*
            FROM price_list pl
            JOIN price_list_channel plc ON plc.priceListId = pl.id
            JOIN price_list_group g ON g.id = plc.groupId
            WHERE pl.id IN allListIds
              AND plc.channelId = ctx.channelId
              AND pl.deletedAt IS NULL

    # Apply validity predicates (AND-combined)
    lists = lists.filter(l => validityPredicates.every(p => p.test(ctx, l, nowUtc)))

    # Group by groupId, sort
    grouped = groupBy(lists, l => l.groupId)
    result = []
    for groupId, groupLists in grouped:
        groupLists.sort((a, b) =>
            b.priority - a.priority                              # list priority DESC
            || nullsFirst(a.startDate, b.startDate)              # nulls first
            || a.startDate - b.startDate)                        # earlier first
        result.push({ group: groupOf(groupId), candidates: groupLists })
    result.sort((a, b) => a.group.priority - b.group.priority)   # group priority ASC

    # Cache A expiry = soonest future date boundary among candidates
    expiresAt = min(
        ...allCandidateLists.flatMap(l => [l.startDate, l.endDate])
                            .filter(d => d != null && d > nowUtc),
        nowUtc + DEFAULT_TTL_MS    # safety cap if no boundary exists
    )

    await cacheService.set(cacheKey, { groups: result, expiresAt },
                            { ttl: expiresAt - nowUtc,
                              tags: ['pricelist:resolution',
                                     `pricelist:channel:${ctx.channelId}`,
                                     `pricelist:customer:${customerId ?? "anon"}`] })
    return result
```

Important: the SQL queries above are illustrative; the real impl will
build them via TypeORM `QueryBuilder` against the `TransactionalConnection`,
respecting Vendure's per-channel filtering machinery wherever it applies
(e.g. `ListQueryBuilder.applyChannelFilter`).

**Edge:** anonymous context (`customerId == null`) — only `GLOBAL`
assignments match. The cache key uses `"anon"` so that anonymous traffic
shares one cache entry per channel, not millions.

**Edge:** customer's group memberships change mid-session — the cache
key includes a sorted CSV of `customer.groupIds`, so a re-fetched
customer with new groups gets a new key automatically. Group-membership
mutations also bump the `pricelist:customer:<id>` tag — see Q3.

#### 1.2.2 Selection strategy defaults

All three implement the `PriceListSelectionStrategy` interface above.

**`HighestPriorityWinsSelectionStrategy` (DEFAULT).**

```text
selectWithinGroup(ctx, variant, currency, group, runningPrice):
    # candidates already sorted by priority DESC by ResolutionStrategy
    for list in group.candidates:
        item = SELECT * FROM price_list_item
               WHERE priceListId = list.id
                 AND productVariantId = variant.id
                 AND currencyCode = currency
               LIMIT 1
        if item: return item
    return null
```

Note: a single query fetching all matching items at once and picking by
the priority order is also valid (and more cache-friendly). The impl
should batch — pseudocode above is for clarity.

**`CheapestWinsSelectionStrategy`.**

```text
selectWithinGroup(ctx, variant, currency, group, runningPrice):
    candidates = items in group.candidates matching (variant, currency)
    if candidates.empty: return null

    base = runningPrice ?? variant.standardPriceFor(currency)
    if base is null and any candidate is PERCENTAGE:
        # PERCENTAGE candidate cannot resolve without a base
        # — exclude it from cheapest comparison
        candidates = candidates.filter(c => c.valueType === 'ABSOLUTE')

    cheapest = candidates.minBy(c =>
        c.valueType === 'ABSOLUTE'
            ? c.value
            : base * (1 - c.value / 10000)
    )
    return cheapest
```

**`MostRecentWinsSelectionStrategy`.**

```text
selectWithinGroup(ctx, variant, currency, group, runningPrice):
    candidates = items in group.candidates matching (variant, currency)
        # tied to each candidate's parent list.startDate
    if candidates.empty: return null
    return candidates.maxBy(item => item.priceList.startDate ?? new Date(0))
```

**Worked example — same input, three different winners.**

Setup: a group `PROMO` (priority 10) contains three PriceLists:

| List | priority | startDate | item for (SKU-A, EUR) |
| --- | --- | --- | --- |
| `BFRIDAY-2026` | 5 | 2026-11-20 | PERCENTAGE 1500 (-15%) |
| `WINTER-CLEARANCE` | 8 | 2026-10-01 | ABSOLUTE 4200 |
| `LOYALTY-OCT` | 3 | 2026-10-25 | ABSOLUTE 4500 |

Base price (`runningPrice` coming into this group) = 5000.

- `HighestPriorityWins`: picks `WINTER-CLEARANCE` (priority 8 is
  highest). Effective contribution: 4200.
- `CheapestWins`: computes each — `BFRIDAY`: 5000 × 0.85 = 4250.
  `WINTER`: 4200. `LOYALTY`: 4500. Picks `WINTER-CLEARANCE` (4200).
  *(In this example the highest-priority and cheapest happen to agree.
  A case where they diverge: drop `WINTER-CLEARANCE` to priority 1 —
  `HighestPriorityWins` would now pick `BFRIDAY` (4250), while
  `CheapestWins` would still pick `WINTER-CLEARANCE` (4200).)*
- `MostRecentWins`: picks `BFRIDAY-2026` (startDate 2026-11-20, latest).
  Effective contribution: 5000 × 0.85 = 4250.

The Stage 2 test fixture must encode this exact input set with these
three expected outputs.

#### 1.2.3 Default calculation strategy (the cascade)

`DefaultPriceListPriceCalculationStrategy` extends the abstract base.

```text
calculate(ctx, variant, currency, groups):
    # Phase A — pre-process (default is identity)
    effectiveGroups = await preProcessGroups(ctx, variant, groups)
    if effectiveGroups.empty:
        return null

    # Phase B — external price short-circuit (default returns null)
    external = await tryExternalPrice(ctx, variant, currency)
    if external != null:
        return external    # bypasses the cascade entirely

    # Phase C — cascade
    runningPrice = null
    provenance = []

    for group in effectiveGroups:   # already sorted by priority ASC (low first)
        item = await selectionStrategy.selectWithinGroup(
            ctx, variant, currency, group, runningPrice)
        if item == null:
            continue                # nothing in this group matched

        if item.valueType == 'ABSOLUTE':
            runningPrice = item.value
        elif item.valueType == 'PERCENTAGE':
            base = runningPrice ?? variant.standardPriceFor(currency)
            if base == null:
                logger.warn(`PERCENTAGE entry ${item.id} has no base price
                             for ${variant.id}/${currency}; skipping cascade`)
                return null      # explicit unpriced — Vendure falls back
            runningPrice = base * (1 - item.value / 10000)

        provenance.push({
            listId: item.priceListId,
            listCode: item.priceList.code,
            groupId: group.group.id,
            groupCode: group.group.code,
            itemId: item.id,
            valueType: item.valueType,
            value: item.value,
        })

    if runningPrice == null:
        return null         # no group contributed

    finalPrice = await roundingStrategy.round(runningPrice, currency)

    return {
        value: finalPrice,
        currencyCode: currency,
        provenance: provenance,
        source: 'CASCADE',     # vs. 'EXTERNAL' from tryExternalPrice
    }
```

**Kill switch** (meta-plan §0.2.10). Lives in the *resolution* strategy:
if `pluginOptions.killSwitchPerChannel[ctx.channelId] === true`, `resolve()`
returns `[]` unconditionally. The calculation strategy then sees empty
groups → returns null → Vendure falls back to standard prices. Single
short-circuit point, no logic duplication.

#### 1.2.4 Rounding strategy defaults

`HalfUpToMinorUnitRoundingStrategy` (DEFAULT):

```text
round(value, currency):
    return Math.round(value)    # JS's Math.round is half-up for positives
```

Note: `Math.round(2.5)` returns `3` (half-up) and `Math.round(-2.5)`
returns `-2` (also rounding toward +∞). Pricelist values are
non-negative so the asymmetry does not bite us.

`HalfDownToMinorUnitRoundingStrategy`:

```text
round(value, currency):
    return Math.floor(value + 0.5 - Number.EPSILON)
    # half-down: 2.5 → 2, 2.6 → 3
```

`BankersRoundingStrategy` (half-to-even):

```text
round(value, currency):
    floor = Math.floor(value)
    diff = value - floor
    if diff < 0.5: return floor
    if diff > 0.5: return floor + 1
    # exactly 0.5 → round to nearest even integer
    return floor % 2 === 0 ? floor : floor + 1
```

**Worked example.** value = `4250.5`.

| Strategy | Result |
| --- | --- |
| `HalfUpToMinorUnit` | 4251 |
| `HalfDownToMinorUnit` | 4250 |
| `Bankers` | 4250 (4250 is even) |

For value `4251.5`:

| Strategy | Result |
| --- | --- |
| `HalfUpToMinorUnit` | 4252 |
| `HalfDownToMinorUnit` | 4251 |
| `Bankers` | 4252 (4252 is even) |

### Q3 — Caching (two layers)

> **REVISED 2026-06-15 — invalidation implementation.** The
> `PriceListEvent` / `PriceListGroupEvent` / `PriceListChannelEvent` /
> `PriceListAssignmentEvent` listed below were never emitted by the
> services (the pre-rework design assumed them). Rather than add event
> emission to ~15 write methods, `PriceListCacheInvalidatorService` now
> registers a **TypeORM `EntitySubscriber`**: any insert/update/remove on
> a pricelist entity (`PriceList`, `PriceListItem`, `PriceListGroup`,
> `PriceListGroupMembership`, and their translations) busts the
> `pricelist:resolution` + `pricelist:computed` namespaces wholesale. This
> is a coarser (channel-agnostic) nuke than the per-channel tags below,
> but admin writes are rare so the trade-off is fine, and it guarantees
> create/update/delete/share/group-change/item-edit take effect
> immediately. The **precise** paths are kept for the hot, frequent
> signals: `PriceListAccessChangeEvent` (per-customer / per-channel),
> `CustomerGroupChangeEvent` (per-customer), and `ProductVariantPriceEvent`
> (per-variant). `PriceListChannelAccess` writes are excluded from the
> entity subscriber so access changes stay on the precise path.

#### Layer A — accessible lists per customer

- **Service:** `CacheService` (process-wide; from Stage 0 §0.8).
- **Key:** `pricelist:resolution:{channelId}:{customerId|"anon"}:{groupIdsCSV}`.
- **Value:** `{ groups: ResolvedPriceListGroup[], expiresAt: number (UTC ms) }`.
- **TTL:** `min(soonest future boundary, DEFAULT_TTL_MS)`. Boundaries =
  every non-null `startDate` and `endDate` among the candidate lists
  that is `> now`. Boundaries from non-candidate lists (e.g. lists
  starting next month that are not yet in the candidate set) are NOT
  considered — that's a deliberate optimization, since a list that
  begins at T1 will pop into the candidate set at T1; we only need the
  *current* cache entry to expire by then. **Verify on first invalid
  cache miss:** if a list silently enters validity without invalidating
  any cache, this assumption is wrong and Layer A misses correctness;
  ship a test that pins this.
- **Tags** (for selective `invalidateTags()`):
  - `pricelist:resolution` (global blunt nuke — rare)
  - `pricelist:channel:{channelId}`
  - `pricelist:customer:{customerId | "anon"}`
- **Invalidation events:**
  - `PriceListEvent(created|updated|deleted)` →
    invalidate `pricelist:channel:{originChannelId}` and every shared
    channel tag.
  - `PriceListGroupEvent(any)` →
    invalidate `pricelist:channel:{group.channelId}`.
  - `PriceListChannelEvent(share|unshare)` →
    invalidate the source channel tag and the destination channel tag.
  - `PriceListAssignmentEvent(created|deleted)` →
    targetType=GLOBAL → invalidate the channel tag.
    targetType=CUSTOMER → invalidate `pricelist:customer:{targetId}`.
    targetType=CUSTOMER_GROUP → invalidate every customer tag for
    members of the group. (Expensive on large groups — for v1 it's
    acceptable to nuke `pricelist:channel:{channelId}` instead, which
    is the conservative-but-correct fallback. Document the choice.)
  - Vendure's `CustomerGroupChangeEvent` (member added/removed) →
    invalidate `pricelist:customer:{customerId}`.

#### Layer B — computed price

- **Service:** `CacheService` (process-wide).
- **Key:** `pricelist:computed:{hash(channelId + candidateListIds.sorted() + variantId + currency)}`.
  Hash because list-id arrays can be long; SHA-1 of the joined string
  is fine (this is cache, not crypto).
- **Value:** `ResolvedPrice` (the full type, including provenance).
- **TTL:** same as the Layer A entry that produced its `candidateListIds`,
  copied at write time. This keeps both layers expiring together when
  validity boundaries change.
- **Tags:**
  - `pricelist:computed`
  - `pricelist:list:{listId}` for every listId contributing to the
    provenance (selective bust on item edits).
  - `pricelist:variant:{variantId}`.
- **Invalidation events:**
  - `PriceListItemEvent(created|updated|deleted)` →
    invalidate `pricelist:list:{listId}`.
  - `ProductVariantPriceChangeEvent` (Vendure built-in, fires when the
    standard price changes) → invalidate `pricelist:variant:{variantId}`.
    Required because PERCENTAGE entries depend on the standard price as
    fallback base.

#### Layer 0 — intra-request memoization

- **Service:** `RequestContextCacheService` (per-request WeakMap).
- **Use:** memoize `resolutionStrategy.resolve()` and
  `calculationStrategy.calculate()` results for the duration of a
  single GraphQL request. Avoids re-resolving the same customer on
  every variant in a `Collection` query.
- **Key:** `pricelist:resolve:{customerId}` and
  `pricelist:compute:{variantId}:{currency}`.
- **No invalidation logic needed** — the WeakMap is GC'd when the
  request ends.

### Q4 — "Now" handling

Captured **once per call** to `resolutionStrategy.resolve()` and reused
for every validity predicate. **Not** part of the cache key
(meta-plan §0.2.3) — instead the cache entry's `expiresAt` is the
soonest future boundary among candidates. This is the reference
module's clever trick: the cache auto-invalidates exactly when a list
becomes / stops being valid.

```ts
// Wrong (poisons the cache key with monotonically increasing values):
const cacheKey = `...:${Date.now()}`;

// Right:
const nowUtc = new Date();
const cacheKey = `...:no-now-in-key`;
const cached = await cache.get(cacheKey);
if (cached && nowUtc.getTime() < cached.expiresAt) return cached.groups;
```

### Q5 — Currency mismatch

If no `PriceListItem` matches the requested currency on any candidate
list, the cascade simply finds no contributing entry and returns `null`.
Stage 3 then falls back to Vendure's standard pricing (which already
handles missing currency via its own selection strategy). **Document
explicitly:** the pricelist plugin does not perform cross-currency
conversion. Multi-currency pricing requires explicit `PriceListItem`
rows per currency.

### Q6 — `ResolvedPrice` type (with provenance)

```ts
// src/plugins/pricelist/types/resolved-price.ts
import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import { PriceListValueType } from '../entities/price-list-item.entity';

export interface ResolvedPriceProvenanceEntry {
    listId: ID;
    listCode: string;
    groupId: ID;
    groupCode: string;
    itemId: ID;
    valueType: PriceListValueType;
    value: number;          // raw stored value (bp for PERCENTAGE, cents for ABSOLUTE)
}

export type ResolvedPriceSource = 'CASCADE' | 'EXTERNAL';

export interface ResolvedPrice {
    /** Integer minor units (cents), post-rounding. */
    value: number;
    currencyCode: CurrencyCode;
    /**
     * Ordered list of contributing entries, from the first (lowest
     * priority) group that fired through to the last (highest
     * priority) group. Empty when source='EXTERNAL'.
     */
    provenance: ResolvedPriceProvenanceEntry[];
    source: ResolvedPriceSource;
}
```

The provenance list (not a single id — meta-plan §0.2.4) lets the
dashboard render "price came from list X (compounded with -10% from
group Y)" on order detail views.

### Q7 — Edge cases

Enumerated, each becomes a row in the test matrix (§2 below).

1. **PriceList shared into channel B, variant not in channel B.**
   Resolution strategy still returns the list as a candidate; the
   SQL join with `price_list_item` finds the item (item is at list
   level, not channel level). The item references a variant that is
   not in `ctx.channel.products` — the calculation strategy doesn't
   notice (it just sees an item), so it returns a price. **Decision:**
   the Stage 3 `ProductVariantPriceCalculationStrategy` wrapper short-
   circuits before invoking the pricelist lookup when the variant is
   not in the active channel — that's Vendure's existing behavior. So
   Stage 2 doesn't need a defensive check here; the lookup never gets
   called. Verified in Stage 3.
2. **Customer in two groups → two lists, same priority.** Both pass the
   filter and land in the same priority bucket. `HighestPriorityWins`
   uses the tiebreaker: `startDate ASC NULLS FIRST`, then `id ASC` as
   final deterministic tiebreaker. Document this in the strategy
   docblock — without a deterministic tiebreaker the same input could
   produce different prices on different requests, which is a recipe
   for support tickets.
3. **Overlapping validity windows between two lists at different
   priorities.** Both are candidates; group/list priority decides via
   the normal cascade. No special case.
4. **Percentage entry with no base price for that currency.** Default
   calc strategy logs a `warn` and returns `null`. Vendure falls back
   to standard pricing (which also has no base in that currency, so
   the variant ends up unpriced — the only honest behavior).
5. **Sentinel "explicitly not available" entry.** Encoded as
   `valueType=ABSOLUTE` + `value=0` ... no. Zero is a valid price
   (free samples). **Better:** add a third `valueType` value
   `NOT_AVAILABLE` (column already `varchar(16)`). When the cascade
   encounters one, it returns a distinct `ResolvedPrice` with
   `source='NOT_AVAILABLE'`. Stage 3 then translates this to "variant
   not purchasable", distinct from "no list matched → standard price".

   **Decision needed from PO:** is `NOT_AVAILABLE` in v1 scope?
   Meta-plan §0.2.4 said it's a reserved sentinel; meta-plan §2.1.7
   says to surface as a distinct return value. **Recommendation:**
   defer to v2 unless PO has a concrete use case. Reserve the
   column-value space; do not implement the cascade branch yet.
6. **Anonymous (no customer) context.** Only `GLOBAL` assignments
   apply. The resolution SQL uses `targetType='GLOBAL' OR …` so
   anonymous customers get the global subset; the `customerId|"anon"`
   cache key shares one entry across all anonymous traffic per
   channel.

### Q8 — Kill switch

`pluginOptions.killSwitchPerChannel: Record<string, boolean>`. Checked
inside `DefaultPriceListResolutionStrategy.resolve()` *before* the SQL
queries:

```text
if (this.pluginOptions.killSwitchPerChannel?.[ctx.channelId]) {
    return [];
}
```

Returning `[]` means the calc strategy returns `null` → Vendure default
pricing kicks in. Plugin options are passed via `PRICELIST_PLUGIN_OPTIONS`
(already wired in `pricelist.plugin.ts` from Stage 1).

For ops convenience also expose an env var
`PRICELIST_KILL_CHANNELS="channel-code-1,channel-code-2"` evaluated at
plugin bootstrap and merged into `pluginOptions.killSwitchPerChannel`.
This avoids needing a code deploy to disable the module in an incident.

---

## 2. Artifacts required (§2.2)

### 2.1 The four strategy interfaces

See §1.1 above. Files:

- `src/plugins/pricelist/config/price-list-resolution-strategy.ts`
- `src/plugins/pricelist/config/price-list-selection-strategy.ts`
- `src/plugins/pricelist/config/price-list-price-calculation-strategy.ts`
- `src/plugins/pricelist/config/price-list-rounding-strategy.ts`
- `src/plugins/pricelist/config/price-list-validity-predicate.ts`

### 2.2 Default selection strategies (with worked examples)

Three impls under `src/plugins/pricelist/config/defaults/`:

- `highest-priority-wins.selection-strategy.ts`
- `cheapest-wins.selection-strategy.ts`
- `most-recent-wins.selection-strategy.ts`

Worked example in §1.2.2 above — `BFRIDAY-2026` / `WINTER-CLEARANCE` /
`LOYALTY-OCT` showing all three pick different winners on the same
input.

### 2.3 Default rounding strategies (with worked examples)

Three impls:

- `half-up-to-minor-unit.rounding-strategy.ts` (DEFAULT)
- `half-down-to-minor-unit.rounding-strategy.ts`
- `bankers.rounding-strategy.ts`

Worked example in §1.2.4 — value `4250.5` and value `4251.5` producing
different outputs.

### 2.4 End-to-end cascade example (the documentation lynchpin)

**Setup.**

- Variant `SKU-WIDGET`, standard price 10000 EUR (= €100.00).
- Customer `alice` in CustomerGroup `wholesalers`.
- Three groups, priorities `BASE=0`, `B2B=5`, `PROMO=10`:

| Group | List | priority | assignment | item for (SKU-WIDGET, EUR) |
| --- | --- | --- | --- | --- |
| BASE | `B2C-EUR` | 0 | GLOBAL | ABSOLUTE 9500 (= €95.00) |
| B2B | `WHOLESALE-EUR` | 0 | CUSTOMER_GROUP=wholesalers | PERCENTAGE 2000 (-20%) |
| PROMO | `BFRIDAY` | 0 | GLOBAL | PERCENTAGE 1000 (-10%) |

Default selection strategy = `HighestPriorityWins`.

**Trace.**

```text
Phase A (preProcessGroups): no-op → groups unchanged
Phase B (tryExternalPrice): returns null → fall through to cascade
Phase C (cascade):
    runningPrice = null
    provenance = []

    iter 1: group=BASE (priority 0)
        selection: pick B2C-EUR's item (only candidate)
        item.valueType = ABSOLUTE, value = 9500
        runningPrice = 9500
        provenance += { B2C-EUR, ABSOLUTE 9500 }

    iter 2: group=B2B (priority 5)
        selection: pick WHOLESALE-EUR (only candidate, alice ∈ wholesalers)
        item.valueType = PERCENTAGE, value = 2000
        base = runningPrice = 9500    # NOT the standard 10000
        runningPrice = 9500 * (1 - 2000/10000) = 9500 * 0.8 = 7600
        provenance += { WHOLESALE-EUR, PERCENTAGE 2000 }

    iter 3: group=PROMO (priority 10)
        selection: pick BFRIDAY (only candidate)
        item.valueType = PERCENTAGE, value = 1000
        base = runningPrice = 7600
        runningPrice = 7600 * 0.9 = 6840
        provenance += { BFRIDAY, PERCENTAGE 1000 }

Rounding: HalfUpToMinorUnit
    finalPrice = round(6840) = 6840   # already integer

ResolvedPrice = {
    value: 6840,
    currencyCode: 'EUR',
    provenance: [B2C-EUR, WHOLESALE-EUR, BFRIDAY],
    source: 'CASCADE'
}
```

Customer sees €68.40 instead of €100.00. The dashboard, on the
corresponding order line detail page (Stage 3), shows "Price from
B2C-EUR + wholesale -20% + BFRIDAY -10% = €68.40 (was €100.00)".

**Counter-example showing why we round at the end.** If the BASE
list were ABSOLUTE 9501 instead of 9500 (forces fractional intermediates):

```text
runningPrice after BASE = 9501
runningPrice after B2B  = 9501 * 0.8  = 7600.8     # fractional
runningPrice after PROMO = 7600.8 * 0.9 = 6840.72  # fractional
finalPrice = round(6840.72) = 6841
```

If we rounded per step:

```text
runningPrice after BASE = 9501
runningPrice after B2B  = round(7600.8) = 7601
runningPrice after PROMO = round(7601 * 0.9) = round(6840.9) = 6841
```

Same result here. But for some inputs the two diverge by 1 cent — a
deliberate fixture in the test matrix must exercise such an input
(e.g. base 5005, two -10% chained: end-rounded = `round(5005*0.81) =
round(4054.05) = 4054`; per-step = `round(round(4504.5)*0.9) =
round(4505*0.9) = round(4054.5) = 4055`). Pin both with comments.

### 2.5 Validity predicate defaults

Files under `src/plugins/pricelist/config/defaults/`:

- `date-validity.predicate.ts` —
  `list.startDate ?? -∞ <= nowUtc <= list.endDate ?? +∞` (inclusive
  both ends, per meta-plan §0.2.3).
- `enabled.predicate.ts` — `list.enabled === true`.
- `channel-match.predicate.ts` — the list is present in
  `PriceListChannel` for `ctx.channelId`. Belt-and-suspenders: the
  resolution SQL already joins `PriceListChannel` filtered by
  `ctx.channelId`, but the predicate exists so a custom resolution
  strategy that builds its candidate set differently still gets the
  filter for free.
- `soft-deleted.predicate.ts` — `list.deletedAt == null`. Same
  belt-and-suspenders rationale as above.

The default resolution strategy applies all four AND-combined. The
plugin options accept additional predicates which extend (not replace)
the default chain. This is meta-plan §0.2.9's "predicate list vs.
strategy" decision.

### 2.6 `PriceListLookupService` (public API)

The single public entry point consumed by Stage 3.

```ts
// src/plugins/pricelist/services/price-list-lookup.service.ts
@Injectable()
export class PriceListLookupService {
    constructor(
        private resolutionStrategy: PriceListResolutionStrategy,
        private calculationStrategy: PriceListPriceCalculationStrategy,
        private requestCache: RequestContextCacheService,
        private cacheService: CacheService,
    ) {}

    /**
     * Top-level lookup. Returns null when no pricelist applies.
     * Stage 3's ProductVariantPriceCalculationStrategy is the only
     * caller in v1.
     */
    async resolvePrice(
        ctx: RequestContext,
        variant: ProductVariant,
        currencyCode: CurrencyCode,
    ): Promise<ResolvedPrice | null> {
        // Per-request memoization
        const reqKey = `pricelist:compute:${variant.id}:${currencyCode}`;
        const memoed = this.requestCache.get<ResolvedPrice | null>(ctx, reqKey);
        if (memoed !== undefined) return memoed;

        const customerId = ctx.activeUserId
            ? await this.resolveCustomerIdForUser(ctx)
            : undefined;

        const groups = await this.resolutionStrategy.resolve(ctx, customerId);
        if (groups.length === 0) {
            this.requestCache.set(ctx, reqKey, null);
            return null;
        }

        // Layer B cache check
        const layerBKey = this.buildLayerBKey(ctx, groups, variant, currencyCode);
        const cached = await this.cacheService.get<ResolvedPrice>(layerBKey);
        if (cached) {
            this.requestCache.set(ctx, reqKey, cached);
            return cached;
        }

        const resolved = await this.calculationStrategy.calculate(
            ctx, variant, currencyCode, groups);

        if (resolved) {
            await this.cacheService.set(layerBKey, resolved, {
                ttl: this.computeTTL(groups),
                tags: [
                    'pricelist:computed',
                    `pricelist:variant:${variant.id}`,
                    ...resolved.provenance.map(p => `pricelist:list:${p.listId}`),
                ],
            });
        }

        this.requestCache.set(ctx, reqKey, resolved);
        return resolved;
    }

    private buildLayerBKey(...): string;
    private computeTTL(groups: ResolvedPriceListGroup[]): number;
    private resolveCustomerIdForUser(ctx: RequestContext): Promise<ID | undefined>;
}
```

### 2.7 Unit-test matrix

Each row → one Jest/Vitest test under
`src/plugins/pricelist/__tests__/lookup/`.

| # | Scenario | Input | Expected candidate set | Expected winner per group | Expected ResolvedPrice |
| --- | --- | --- | --- | --- | --- |
| 1 | No assignments at all | global ctx, no lists | `[]` | — | `null` |
| 2 | Anonymous + GLOBAL ABSOLUTE | GLOBAL list `A` ABSOLUTE 4000 | `[BASE→[A]]` | `A` | 4000 |
| 3 | Customer-specific list overrides global | global list `G` ABS 5000, customer list `C` ABS 4000 in same group, higher priority on `C` | `[BASE→[C,G]]` | `C` | 4000 |
| 4 | Stacked PERCENTAGE | base 5000 from group BASE, -10% in PROMO | candidates resolved | `BASE→A`, `PROMO→P` | 4500 |
| 5 | PERCENTAGE without base price | only a PERCENTAGE list, no standard price for currency | candidates resolved | `PROMO→P` | `null` (warn logged) |
| 6 | Cheapest-wins differs from priority-wins | input from §1.2.2 worked example, `WINTER-CLEARANCE` priority 1 | same group, multiple lists | depends on strategy | 4200 or 4250 |
| 7 | Validity expired | list endDate in past | `[]` | — | `null` |
| 8 | Validity not yet started | list startDate in future | `[]` | — | `null` |
| 9 | Open-ended validity (null bounds) | both dates null | candidates include list | — | resolved |
| 10 | Customer in two groups, both have a list, same priority | tied | both lists in candidate set | tiebreaker by startDate then id | deterministic, same value every call |
| 11 | Group assignment expands to all lists in group | one GROUP assignment | every list in group is candidate | per cascade | resolved |
| 12 | Multi-currency: USD asked, only EUR items | candidates loaded but no items match | candidates resolved | nothing per group selection | `null` |
| 13 | Kill switch on for current channel | option set | `[]` from resolve() | — | `null` |
| 14 | Cache hit Layer A | second call same context | cached groups returned | — | (same value) |
| 15 | Cache invalidation: item edit | edit item, re-lookup | cache miss, recompute | — | new value |
| 16 | Cache invalidation: customer-group membership change | customer added to group | Layer A invalidated for that customer | — | new candidate set |
| 17 | Final rounding diverges from per-step | base 5005, two -10% chained | cascade runs | — | 4054 (final), NOT 4055 |
| 18 | External price short-circuit | custom CalculationStrategy subclass returns ResolvedPrice | groups ignored | — | external value, provenance=[], source='EXTERNAL' |
| 19 | preProcessGroups filters a group | custom subclass drops PROMO group | groups[0] only | per cascade | resolved without PROMO contribution |
| 20 | Soft-deleted list | list.deletedAt set | excluded by predicate | — | `null` |

Tests 17, 18, 19 are the most important — they pin the documented
extension points and the "round-once" decision.

---

## 3. Module wiring

Plugin options extended:

```ts
// src/plugins/pricelist/types.ts
export interface PriceListPluginOptions {
    resolutionStrategy?: PriceListResolutionStrategy;
    selectionStrategy?: PriceListSelectionStrategy;
    calculationStrategy?: PriceListPriceCalculationStrategy;
    roundingStrategy?: PriceListRoundingStrategy;
    additionalValidityPredicates?: PriceListValidityPredicate[];
    killSwitchPerChannel?: Record<string, boolean>;
    defaultCacheTtlMs?: number;          // safety cap when no validity boundary exists
}
```

The plugin's `init()` (already present from Stage 1) applies defaults:

```ts
static init(options: PriceListPluginOptions = {}): Type<PricelistPlugin> {
    this.options = {
        resolutionStrategy: new DefaultPriceListResolutionStrategy(),
        selectionStrategy: new HighestPriorityWinsSelectionStrategy(),
        calculationStrategy: new DefaultPriceListPriceCalculationStrategy(),
        roundingStrategy: new HalfUpToMinorUnitRoundingStrategy(),
        additionalValidityPredicates: [],
        killSwitchPerChannel: parseKillSwitchEnv(),
        defaultCacheTtlMs: 60 * 60 * 1000,    // 1 hour
        ...options,
    };
    return PricelistPlugin;
}
```

The strategies are provided via NestJS DI as `useFactory` providers that
read from `PricelistPlugin.options`, so the same `init()` injection
mechanism feeds both the plugin and the strategies.

---

## 4. Out of scope for Stage 2

- Hooking Vendure's `ProductVariantPriceCalculationStrategy` — Stage 3.
- Shop API extensions, strike-through — Stage 3.
- e2e tests — Stage 4.
- Bulk-import affecting cache invalidation — not v1 (§0.2.11).
- The `NOT_AVAILABLE` sentinel — recommended deferral to v2 (Q7.5).

---

## 5. Resolved questions (decisions of record)

All resolved 2026-05-26. Recorded here so a future contributor can see
the decision *and* the deferred items.

1. **`NOT_AVAILABLE` sentinel — DEFERRED to v2.** Out of v1. Reserve the
   column-value space only; do not implement the cascade branch yet.

   **Notes for the future contributor who picks this up:**
   - Add `'NOT_AVAILABLE'` to the `PriceListValueType` union in
     `entities/price-list-item.entity.ts` (the `varchar(16)` column
     already supports it — no migration).
   - Cascade branch goes in
     `DefaultPriceListPriceCalculationStrategy.calculate()` (the loop in
     §1.2.3): an extra `else if (item.valueType === 'NOT_AVAILABLE')`
     that immediately returns
     `{ value: 0, currencyCode, provenance: [...currentProvenance, thisEntry], source: 'NOT_AVAILABLE' }`
     short-circuiting the rest of the cascade. (`value: 0` is a
     placeholder; consumers MUST dispatch on `source`, not on `value`.)
   - Stage 3's `ProductVariantPriceCalculationStrategy` wrapper must
     translate `source: 'NOT_AVAILABLE'` into Vendure's
     "variant not purchasable" behavior. Confirm exact mechanism in
     `node_modules/@vendure/core/dist/api/...` at that time —
     candidates: throw an error, return a sentinel price, set a custom
     field on the variant. Pick whichever Vendure exposes cleanly.
   - Add a `ResolvedPriceSource = 'CASCADE' | 'EXTERNAL' | 'NOT_AVAILABLE'`
     union and one test row (extension of test #18 pattern).
   - Dashboard needs a `NOT_AVAILABLE` option in the value-type dropdown
     of `PriceListItemsGrid`, and the `value` input must hide when this
     type is selected.

   The reservation point is the `varchar(16)` column type. As long as
   nothing in v1 stores or reads `'NOT_AVAILABLE'`, picking the feature
   up later is purely additive.

2. **Customer-group membership invalidation — CONSERVATIVE.** When a
   `CUSTOMER_GROUP` target's membership changes, invalidate the entire
   channel tag (`pricelist:channel:{channelId}`) rather than iterating
   members. O(1) at the cost of over-invalidating other customers'
   cache entries on the same channel. Re-evaluate if cache hit rates
   suffer in production telemetry.

3. **Layer B cache key hash — SHA-1.** Use Node's built-in
   `crypto.createHash('sha1').update(joined).digest('hex')`. Zero
   dependencies. If a future need arises for faster cache-key hashing,
   switch to xxhash or similar at that time — the hash is an
   implementation detail, swappable behind the
   `PriceListLookupService.buildLayerBKey()` private method.

4. **`defaultCacheTtlMs` — 1 hour** (`60 * 60 * 1000`). Safety cap for
   Layer A entries with no validity boundary among candidates.

---

## 6. Next step

Upon approval of this document, Stage 3 produces
`PLAN-STAGE-3.md` (wiring into Vendure's
`ProductVariantPriceCalculationStrategy` and the Shop API
`originalPrice` extension). Stage 3 consumes only the public
`PriceListLookupService` defined in §2.6 above — no internal Stage 2
details leak.
