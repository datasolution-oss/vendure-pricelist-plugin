# PLAN-STAGE-3 — Wiring into Vendure's pricing pipeline + Shop API

> **Goal.** After executing this plan:
>
> - Vendure's Shop API returns pricelist-adjusted prices on
>   `ProductVariant.price` / `priceWithTax` when a list applies, and
>   standard prices otherwise.
> - Order lines snapshot the pricelist-adjusted price at addItemToOrder
>   time (free — Vendure's existing behavior).
> - Cart Promotions discount the pricelist-adjusted base (free — they
>   already operate on the variant's resolved price).
> - The Shop API exposes `originalPrice` / `originalPriceWithTax` for
>   strike-through rendering.
>
> Stage 2's `PriceListLookupService` is the only consumed dependency.
> No new entities, no new lookup logic.

## Revisions

### 2026-05-26 — Provenance snapshot via event subscriber, not strategy

§2.4 previously described overriding `OrderItemPriceCalculationStrategy`
and returning `customFields` alongside the `PriceCalculationResult` to
persist the pricelist provenance onto `OrderLine`.

**This does not compile.** Verified at
`node_modules/@vendure/core/dist/config/order/order-item-price-calculation-strategy.d.ts:71-73`:

```ts
calculateUnitPrice(
    ctx: RequestContext, productVariant: ProductVariant,
    orderLineCustomFields: { [key: string]: any }, order: Order, quantity: number
): PriceCalculationResult | Promise<PriceCalculationResult>;
```

Return type is `PriceCalculationResult` = `{ price, priceIncludesTax }`.
No `customFields` field exists. The strategy has no mechanism to persist
custom fields onto the OrderLine via its return value.

Secondary problem: the strategy fires on `addItemToOrder`,
`adjustOrderLine`, `setOrderShippingAddress`, and
`setOrderBillingAddress` (per the docstring at lines 18-23) — not just
at line freeze. We'd be re-snapshotting on every address change.

**Replacement design.** Subscribe to `OrderLineEvent('created')`
(verified at
`node_modules/@vendure/core/dist/event-bus/events/order-line-event.d.ts:12-17`).
The subscriber runs in the same request as `addItemToOrder`, calls
`PriceListLookupService.resolvePrice()` (hits the per-request cache —
free), JSON-stringifies the provenance, and persists it onto the line
via a connection update.

`OrderItemPriceCalculationStrategy` is therefore **NOT overridden** —
restoring §Q2's original "single hook" non-decision. The variant-price
strategy override (§2.1) remains the only Vendure strategy slot we
touch.

§2.4 has been rewritten below to reflect the corrected design. §2.7
(decision log) and §3.1 Q2 have been updated to remove the contradiction
that previously existed between them.

---

## 1. Answers to §3.1 questions

### Q1 — Vendure strategy slot to hook

**Slot: `ProductVariantPriceCalculationStrategy`**, registered at
`catalogOptions.productVariantPriceCalculationStrategy` (verified at
`node_modules/@vendure/core/dist/config/vendure-config.d.ts:770`).

Quoted contract from Stage 0 verification doc
(`node_modules/@vendure/core/dist/config/catalog/product-variant-price-calculation-strategy.d.ts:22-41`):

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

`PriceCalculationResult` (`common/types/common-types.d.ts:145-148`):

```ts
export type PriceCalculationResult = {
    price: number;
    priceIncludesTax: boolean;
};
```

**Why this slot** (also recorded in Stage 0 §0.2.2 — repeated here for
the decision log): pricelists adjust the *value* used as `inputPrice`;
they do not change *which* `ProductVariantPrice` row is selected. The
sibling `ProductVariantPriceSelectionStrategy` slot is therefore NOT
hooked.

### Q2 — Two hooks: variant price (qty 1) + order item (quantity tiers)

> **REVISED 2026-06-15 — decision reversed.** The original Q2 (kept below
> for the record) said NOT to override `OrderItemPriceCalculationStrategy`.
> That made `stepQuantity` tiers **dormant**: the catalog hook resolves at
> quantity 1, and the default order-item strategy just snapshots that
> qty-1 `listPrice`, so a volume tier (`stepQuantity ≥ 2`) could never take
> effect on an order line. Since tiers are a **defined, user-facing
> feature** (the dashboard lets merchandisers set per-`stepQuantity`
> prices), they must apply. We therefore **do** override
> `OrderItemPriceCalculationStrategy`.

**Current design — both hooks:**

- `ProductVariantPriceCalculationStrategy` (§2.1) → per-unit **catalog/PDP**
  price, resolved at `quantity = 1`.
- `OrderItemPriceCalculationStrategy.calculateUnitPrice(ctx, variant,
  customFields, order, quantity)` → **order-line** unit price, re-resolved
  with the line's actual `quantity` so the correct tier wins. Implemented
  in `strategies/pricelist-order-item-price-calculation.strategy.ts`
  (implements the interface directly — the default class's typed signature
  is narrower than the interface; the no-pricelist fallback inlines the
  default behaviour: pass `variant.listPrice` through). Registered at
  `orderOptions.orderItemPriceCalculationStrategy`.

**Accepted trade-off:** the order line no longer strictly freezes the
qty-1 PDP price — it reflects the price for the **quantity actually
ordered**, re-resolved against **current** validity at add/adjust time. A
list that expired between PDP view and add-to-cart will therefore not
apply on the line. This is the correct behaviour for quantity-break
pricing and is the intended trade-off of this reversal.

The provenance snapshot onto frozen order lines (meta-plan §0.2.11)
remains a separate concern handled by an `OrderLineEvent('created')`
subscriber — NOT by the order-item strategy. See §2.4.

---

<details>
<summary>Original Q2 (superseded 2026-06-15) — kept for the record</summary>

`OrderItemPriceCalculationStrategy` is NOT overridden. Vendure's default
behavior at the order-line level — snapshot the variant's
already-calculated price at `addItemToOrder` time — is exactly what we
want for pricelists. A future contributor reading this code may be
tempted to "complete" the pair by overriding the order-item strategy
too; **do not**.

**Reason:** the order line should freeze the price the customer saw on
the PDP, which is the pricelist-adjusted price. Vendure's default
`DefaultOrderItemPriceCalculationStrategy` already reads
`variant.listPrice` (post-calculation), so it correctly snapshots what
we returned from our strategy override. Hooking both would either be a
no-op or — worse — re-run pricelist resolution at order-add time with
potentially different validity (a list might have expired between PDP
view and add-to-cart).

The provenance snapshot onto frozen order lines (meta-plan §0.2.11) is
a separate concern handled by an `OrderLineEvent('created')` subscriber,
NOT by overriding the order-item strategy. See §2.4 below.

</details>

### Q3 — Tax handling

The default `DefaultProductVariantPriceCalculationStrategy` source
(quoted from Stage 0 verification,
`default-product-variant-price-calculation-strategy.js:17-35`):

```js
async calculate(args) {
    const { inputPrice, activeTaxZone, ctx, taxCategory } = args;
    let price = inputPrice;
    let priceIncludesTax = false;
    if (ctx.channel.pricesIncludeTax) {
        const isDefaultZone = idsAreEqual(activeTaxZone.id, ctx.channel.defaultTaxZone.id);
        if (isDefaultZone) {
            priceIncludesTax = true;
        } else {
            const taxRateForDefaultZone = await this.taxRateService.getApplicableTaxRate(
                ctx, ctx.channel.defaultTaxZone, taxCategory);
            price = roundMoney(taxRateForDefaultZone.netPriceOf(inputPrice));
        }
    }
    return { price, priceIncludesTax };
}
```

So the default impl takes whatever `inputPrice` is, optionally
net-of-tax it for cross-zone display, returns. Tax application proper
happens downstream in Vendure's tax-line calculation pipeline.

**Our subclass approach:**

```text
async calculate(args):
    resolved = await priceListLookupService.resolvePrice(
        args.ctx, args.productVariant, args.ctx.currencyCode)

    if resolved == null:
        return super.calculate(args)            # standard path

    # Mutate inputPrice with pricelist-resolved value, then delegate.
    # super.calculate handles cross-zone net conversion correctly because
    # the resolved value is in the same money mode (includes-tax or not)
    # as the inputPrice it replaces (channel determines that, not us).
    mutatedArgs = { ...args, inputPrice: resolved.value }
    return super.calculate(mutatedArgs)
```

**Why delegate to `super.calculate(mutatedArgs)` instead of returning
`{ price: resolved.value, priceIncludesTax: ctx.channel.pricesIncludeTax }`
directly:**

- The default impl's cross-zone net-conversion logic is non-trivial and
  versioned with Vendure core. Replicating it here means re-shipping
  bugfixes from upstream into our plugin.
- `args.inputPrice` and `resolved.value` are in the same money mode
  because they're both prices for the same `(channel, currency)` —
  the channel's `pricesIncludeTax` flag applies to both identically.
  Pricelist PERCENTAGE entries are applied multiplicatively, which
  preserves money mode.

**Edge — what about PERCENTAGE applied to a price-includes-tax base?**
If `inputPrice` is gross (includes tax) and we apply `× 0.9`, the
result is `gross × 0.9`. Is that what merchants want?

Yes — the discount applies to the displayed price. €100 with 20% VAT
displayed as €100 (gross), a 10% discount means €90 displayed
(gross). The arithmetic is the same regardless of money mode; Vendure
handles the gross↔net conversion downstream of our strategy. **No
special-casing needed.** Document this in the strategy docblock.

### Q4 — Promotion composition (non-decision recorded)

**Settled.** Pricelists run upstream at variant resolution. Vendure
Promotions run downstream in the cart on the already-pricelist-adjusted
price. The two systems are layered:

```text
ProductVariantPrice (DB row) → SelectionStrategy → CalculationStrategy (OURS, applies pricelist)
                                                       ↓
                                            variant.price (used everywhere)
                                                       ↓
                                              addItemToOrder snapshots
                                                       ↓
                                             OrderLine.unitPrice
                                                       ↓
                                          Promotion engine discounts THIS
```

Cart-level promotion discounts are computed off the
pricelist-adjusted base, not the original price. This is the merchant-
expected behavior: a pricelist already provides a "B2B price"; a
promotional "EXTRA10" code on top of that should discount the B2B
price further, not reset to the consumer price.

Plugin does NOT interact with the Promotion engine. No code, no
registrations. Stage 4 has one regression test row pinning this
behavior.

### Q5 — Strike-through on PDP (new Shop API surface)

#### 1.5.1 Field shape

```graphql
extend type ProductVariant {
    """
    The variant's price *before* any pricelist was applied. Null when no
    pricelist applies (= the variant's standard ProductVariantPrice in
    the active channel/currency).

    Storefronts render strike-through PDP pricing by displaying
    `originalPrice` alongside `price` when both are non-null and differ.
    """
    originalPrice: Int
    originalPriceWithTax: Int

    """
    Public marketing metadata about the winning pricelist. Returns null
    when no pricelist applies. Exposes only the human-readable list
    code and an optional display label; internal ids are NOT exposed
    over the Shop API.
    """
    priceListBadge: PriceListBadge
}

type PriceListBadge {
    """ Stable identifier for storefront i18n (e.g. 'BFRIDAY'). """
    code: String!
    """ Human-readable label (e.g. 'Black Friday Sale'). """
    label: String!
}
```

**Decision: NULL convention chosen over `originalPrice == price` when
no pricelist applies.** Reason: storefronts conditionally render the
strike-through. `if (variant.originalPrice != null) { renderStrike() }`
is cleaner than `if (variant.originalPrice !== variant.price)` and
avoids a corner case where a zero-discount pricelist (a list whose
PERCENTAGE happens to be 0 or whose ABSOLUTE matches the standard
price) would still render the strike-through.

**Decision: `priceListBadge` exposes `code` + `label` only, not `id`.**
Internal ids over the public API are an info leak (allows enumeration
of pricelists across customer sessions). The label is intended to
mean what a marketing team would call this — "Black Friday Sale" —
sourced from `PriceList.name`. The `code` is for stable client-side
i18n routing.

**Open: which pricelist's badge?** The cascade can have multiple
contributing entries in `provenance`. The badge should be the
**highest-priority contributing entry's pricelist** — the "last word"
in the cascade. Document this in the resolver. Storefronts that want
the full provenance can use the Admin API (which exposes everything,
§Q9 below).

#### 1.5.2 Resolution strategy

Computing `originalPrice` requires re-running tax/zone logic against
the **original** `inputPrice` (pre-pricelist). Three implementation
options:

| Option | Behavior | Cost |
| --- | --- | --- |
| **A — Always compute both** | Strategy returns both prices, resolver reads from cached pair | +1 trivial tax calc per variant resolution, even when storefront doesn't ask |
| **B — Lazy resolver** | Strategy returns only the adjusted price; `originalPrice` resolver re-invokes tax calc on-demand | Free when not asked; ~1 extra DB read when asked |
| **C — Hybrid** | Strategy memoizes the original in `RequestContextCacheService` only if the pricelist applied; resolver reads from there | Optimal — free when no pricelist; one read+write per variant when pricelist applies |

**Decision: C — hybrid.**

The strategy override always knows whether a pricelist applied. When it
did, the strategy already had to compute `super.calculate(args)` (the
delegate-to-default pattern from §1.3) *with the modified inputPrice*;
the *original* `super.calculate(args)` (with the unmodified inputPrice)
is one tiny extra step. Memoize that pair on the per-request cache.

```ts
// Inside PricelistVariantPriceCalculationStrategy.calculate(args):
const resolved = await this.lookup.resolvePrice(args.ctx, args.productVariant, args.ctx.currencyCode);
if (!resolved) {
    return super.calculate(args);          // no pricelist; no memoization needed
}

// Both calls share most work — args.taxCategory, args.activeTaxZone are
// shared. Vendure's default impl is cheap (one optional getApplicableTaxRate
// call), so the doubled cost is acceptable on the pricelist-applies path.
const originalResult = await super.calculate(args);
const adjustedResult = await super.calculate({ ...args, inputPrice: resolved.value });

this.requestCache.set(args.ctx, this.originalKey(args.productVariant, args.ctx.currencyCode), {
    originalPrice: originalResult.price,
    priceIncludesTax: originalResult.priceIncludesTax,
    badge: this.badgeFromProvenance(resolved.provenance),
});

return adjustedResult;
```

The resolver for `originalPrice` then reads from
`RequestContextCacheService` keyed on `(variant.id, currency)`. Cache
miss → no pricelist applied → return `null`.

### Q6 — Fallback contract

When `PriceListLookupService.resolvePrice()` returns `null`, the
strategy returns `super.calculate(args)` unchanged (= Vendure's default
behavior). `originalPrice` on the Shop API returns `null` (= no
pricelist applied; the storefront should not render strike-through).

### Q7 — Performance

Variant resolution can fire many times per request (collections, list
pages, search results). Mitigations:

- **Per-request memoization** of the lookup result via
  `RequestContextCacheService` (Stage 2 §1.3 Layer 0). One DB-bound
  lookup per `(variantId, currency)` per request, not per resolver
  call.
- **Layer A + Layer B** (process-wide, Stage 2 §1.3) absorb cross-
  request repetition.
- **Strategy does NOT do any DB work itself** — only delegates to the
  lookup service. The strategy class is pure orchestration.

Stage 4 test #15 (Stage 2 matrix) pins that repeated calls in the
same request hit the WeakMap and do not re-issue SQL.

### Q8 — Channel-share variant-not-in-channel

Vendure's pricing pipeline does NOT call
`ProductVariantPriceCalculationStrategy` for a variant that is not in
the active channel — the `SelectionStrategy` upstream returns
`undefined` for an out-of-channel variant, short-circuiting the
pipeline before our strategy runs. So the question is moot from our
strategy's perspective.

Confirmation: `DefaultProductVariantPriceSelectionStrategy.selectPrice`
(Stage 0 §0.2.2):

```js
selectPrice(ctx, prices) {
    const pricesInChannel = prices.filter(p => idsAreEqual(p.channelId, ctx.channelId));
    const priceInCurrency = pricesInChannel.find(p => p.currencyCode === ctx.currencyCode);
    return priceInCurrency;       // undefined if no row matches
}
```

`undefined` → Vendure short-circuits, no variant price exposed. Our
strategy is never invoked. The "shared pricelist contains variant X but
variant X is not in this channel" case is handled silently by Vendure
upstream — meta-plan §0.2.6 "must silently filter out (not error)" is
inherently satisfied.

**No defensive check needed in our strategy.** Document this as a
non-decision.

### Q9 — Surfacing provenance

**Admin API.** Stage 1 exposes full provenance on order-line detail
views via the snapshot custom field written at line-creation time.
This is the "price came from list X" support-debug view. Mechanism
(§2.4 of this plan): an `OrderLineEvent('created')` subscriber writes
the JSON-stringified provenance to `OrderLine.customFields.pricelistProvenance`
once per line, at addItemToOrder time.

**Shop API.** Limited to `priceListBadge` (§1.5.1). Public API does
NOT expose internal list ids, group ids, or the full multi-entry
provenance — info leak risk (price-list enumeration, cross-customer
discovery).

**Open question to the human:**
*Should the Shop API expose any list code/label at all?* Two stances:

- **Pro (badge enabled):** marketers explicitly want "Black Friday
  Price" labels on PDPs. The code is stable, opaque-from-the-outside
  marketing copy.
- **Con (badge disabled):** the code reveals pricing-strategy
  structure. A competitor scraping the Shop API can map out promo
  campaign timing.

**Default recommendation: enable, with a plugin option to disable.**
Add `pluginOptions.exposeBadgeOnShopApi: boolean = true`. Merchants
who consider the code a leak can flip it off; the resolver returns
`null` for `priceListBadge` when disabled.

---

## 2. Artifacts required (§3.2)

### 2.1 Strategy subclass

File: `src/plugins/pricelist/strategies/pricelist-variant-price-calculation.strategy.ts`

```ts
import { Injector } from '@vendure/core';
import {
    DefaultProductVariantPriceCalculationStrategy,
} from '@vendure/core/dist/config/catalog/default-product-variant-price-calculation-strategy';
import {
    ProductVariantPriceCalculationArgs,
} from '@vendure/core/dist/config/catalog/product-variant-price-calculation-strategy';
import { PriceCalculationResult } from '@vendure/core/dist/common/types/common-types';
import { RequestContextCacheService } from '@vendure/core/dist/cache/request-context-cache.service';
import { PriceListLookupService } from '../services/price-list-lookup.service';

interface PricelistOriginalCacheEntry {
    originalPrice: number;
    priceIncludesTax: boolean;
    badge: { code: string; label: string } | null;
}

export class PricelistVariantPriceCalculationStrategy
    extends DefaultProductVariantPriceCalculationStrategy
{
    private lookup: PriceListLookupService;
    private requestCache: RequestContextCacheService;

    init(injector: Injector): void {
        super.init(injector);                          // hydrates the inherited TaxRateService
        this.lookup = injector.get(PriceListLookupService);
        this.requestCache = injector.get(RequestContextCacheService);
    }

    async calculate(
        args: ProductVariantPriceCalculationArgs,
    ): Promise<PriceCalculationResult> {
        const resolved = await this.lookup.resolvePrice(
            args.ctx,
            args.productVariant,
            args.ctx.currencyCode,
        );

        if (!resolved) {
            return super.calculate(args);
        }

        // Compute both prices for strike-through support. The double super
        // call only fires on the pricelist-applies path; the no-pricelist
        // path keeps the single-call cost of the default strategy.
        const originalResult = await super.calculate(args);
        const adjustedResult = await super.calculate({
            ...args,
            inputPrice: resolved.value,
        });

        this.requestCache.set<PricelistOriginalCacheEntry>(
            args.ctx,
            this.cacheKey(args.productVariant.id, args.ctx.currencyCode),
            {
                originalPrice: originalResult.price,
                priceIncludesTax: originalResult.priceIncludesTax,
                badge: this.badgeFromProvenance(resolved.provenance),
            },
        );

        return adjustedResult;
    }

    private cacheKey(variantId: ID, currency: CurrencyCode): string {
        return `pricelist:original:${variantId}:${currency}`;
    }

    private badgeFromProvenance(
        provenance: ResolvedPriceProvenanceEntry[],
    ): { code: string; label: string } | null {
        // The badge is the last-applied (highest-priority) entry's pricelist —
        // the "last word" in the cascade, the most likely consumer-facing one.
        if (provenance.length === 0) return null;
        const last = provenance[provenance.length - 1];
        return { code: last.listCode, label: last.listCode };
        // NOTE: returning listCode for both is a placeholder. The real impl
        // resolves to PriceList.name for `label` via the lookup service or a
        // dedicated query. Done in implementation; not in this plan.
    }
}
```

### 2.2 Plugin `configuration` block change

Append to the existing `configuration` function in
`src/plugins/pricelist/pricelist.plugin.ts`:

```ts
configuration: config => {
    // Existing Stage 1 work: register permissions
    config.authOptions.customPermissions.push(
        priceListPermission,
        priceListGroupPermission,
    );

    // Stage 3 — replace the variant price calculation strategy
    config.catalogOptions.productVariantPriceCalculationStrategy =
        new PricelistVariantPriceCalculationStrategy();

    return config;
},
```

**Important:** Vendure's `productVariantPriceCalculationStrategy` config
is a **single** strategy, not a chain. Our subclass extends
`DefaultProductVariantPriceCalculationStrategy` directly so the default
behavior is preserved on the no-pricelist path. If another plugin in
the project also replaces this strategy, we have a conflict — the load
order in `vendure-config.ts` determines who wins. Document this as a
known limitation and add it to the manual regression checklist.

### 2.3 Shop API extension

Files:

- `src/plugins/pricelist/api/shop-api.schema.ts` — SDL excerpt from §1.5.1.
- `src/plugins/pricelist/api/price-list.shop-resolver.ts` — single
  resolver class with `@ResolveField` methods for `originalPrice`,
  `originalPriceWithTax`, `priceListBadge` on `ProductVariant`.

Resolver skeleton:

```ts
@Resolver('ProductVariant')
export class PriceListShopResolver {
    constructor(private requestCache: RequestContextCacheService) {}

    @ResolveField()
    async originalPrice(
        @Ctx() ctx: RequestContext,
        @Parent() variant: ProductVariant,
    ): Promise<number | null> {
        const entry = this.requestCache.get<PricelistOriginalCacheEntry>(
            ctx, `pricelist:original:${variant.id}:${ctx.currencyCode}`,
        );
        return entry?.originalPrice ?? null;
    }

    // originalPriceWithTax: reads entry from cache, applies Vendure's existing
    // gross-conversion if entry.priceIncludesTax === false. Implementation
    // details deferred to coding stage; mechanism is identical to the
    // default ProductVariant.priceWithTax resolver pattern.

    // priceListBadge: reads entry.badge from cache, returns null if disabled
    // via plugin option or if no pricelist applied.
}
```

Plugin `shopApiExtensions` block:

```ts
shopApiExtensions: {
    schema: shopApiSchema,
    resolvers: [PriceListShopResolver],
},
```

### 2.4 Order-line provenance snapshot (Stage 1 §0.2.11 fulfillment)

**Mechanism: `OrderLineEvent('created')` subscriber.**

Verified contract
(`node_modules/@vendure/core/dist/event-bus/events/order-line-event.d.ts:12-17`):

```ts
export declare class OrderLineEvent extends VendureEvent {
    ctx: RequestContext;
    order: Order;
    orderLine: OrderLine;
    type: 'created' | 'updated' | 'deleted' | 'cancelled';
    constructor(
        ctx: RequestContext, order: Order, orderLine: OrderLine,
        type: 'created' | 'updated' | 'deleted' | 'cancelled',
    );
}
```

The subscriber runs synchronously in the same `addItemToOrder` request,
so `ctx` is still alive, `PriceListLookupService.resolvePrice()` hits
the per-request cache populated by the variant-price strategy upstream,
and we write the provenance to the line's `customFields` via the
TypeORM connection.

```ts
// src/plugins/pricelist/subscribers/order-line-provenance.subscriber.ts
@Injectable()
export class OrderLineProvenanceSubscriber implements OnModuleInit {
    constructor(
        private eventBus: EventBus,
        private connection: TransactionalConnection,
        private lookup: PriceListLookupService,
    ) {}

    onModuleInit() {
        this.eventBus
            .ofType(OrderLineEvent)
            .pipe(filter(e => e.type === 'created'))
            .subscribe(async event => {
                const { ctx, orderLine } = event;
                const resolved = await this.lookup.resolvePrice(
                    ctx, orderLine.productVariant, ctx.currencyCode);

                const provenanceJson = resolved
                    ? JSON.stringify(resolved.provenance)
                    : null;

                // Update only the customField; do not touch other line state.
                await this.connection
                    .getRepository(ctx, OrderLine)
                    .update(orderLine.id, {
                        customFields: {
                            ...orderLine.customFields,
                            pricelistProvenance: provenanceJson,
                        },
                    });
            });
    }
}
```

**Why this works.**

- `OrderLineEvent('created')` fires *after* the line is persisted but
  *during* the same request, so `RequestContext` is live. The
  per-request cache memoized the lookup result when the variant-price
  strategy ran for the PDP query — re-calling
  `resolvePrice()` is free.
- The write is a single targeted `UPDATE order_line SET customFields=...`
  — no race with `addItemToOrder`'s own writes (those have already
  committed by the time the event fires; the docstring on `OrderLineEvent`
  describes it as post-mutation).
- Subsequent line mutations (`adjustOrderLine`, quantity changes) do
  NOT re-run the subscriber — we only filter on `type === 'created'`.
  The snapshot is taken once at line creation; if the customer changes
  quantity later, the provenance still reflects the price they
  originally saw. This matches the "denormalized snapshot" semantics
  of meta-plan §0.2.11.
- Deleting the underlying `PriceList` does not affect placed orders —
  the JSON column stands alone, no FK.

**Edge — line created with no pricelist applied.** `resolved == null`,
the subscriber writes `pricelistProvenance: null`. The customField is
present but null on every line; no special handling needed by
consumers.

**Edge — subscriber failure.** If the lookup or the DB update throws,
the event-bus default behavior is to log and continue. The order line
still exists with `pricelistProvenance: null`. This is the right
failure mode — a snapshot failure must NOT break the customer's
add-to-cart action. Log loudly so ops sees stale snapshots.

**Plugin customFields registration** (added in plugin `configuration`):

```ts
config.customFields.OrderLine.push({
    name: 'pricelistProvenance',
    type: 'text',                 // JSON-serialized array
    nullable: true,
    public: false,                // internal only — never exposed on Shop API
    readonly: true,
    internal: true,
});
```

**No `orderOptions.orderItemPriceCalculationStrategy` override** —
explicitly NOT touched. Vendure's default `DefaultOrderItemPriceCalculationStrategy`
correctly snapshots the pricelist-adjusted price because our
variant-price strategy override has already replaced
`variant.listPrice` upstream.

**Subscriber registration** — add `OrderLineProvenanceSubscriber` to
the plugin's `providers` array. NestJS's `OnModuleInit` lifecycle hook
ensures the subscription is attached before any HTTP requests are
served.

### 2.5 Sequence diagram

```text
[Shop API client]
       |
       | query products { ... variants { price, originalPrice, priceListBadge } }
       v
[Apollo / Vendure resolvers]
       |
       | ProductVariant.price resolver
       v
[Vendure pricing pipeline]
       |
       |   ProductVariantPriceSelectionStrategy.selectPrice(ctx, prices)
       |   → returns the matching ProductVariantPrice row (or undefined)
       |
       |   if undefined → no price exposed, pipeline ends
       |
       |   ProductVariantPriceCalculationStrategy.calculate(args)  ← OUR OVERRIDE
       |       |
       |       | PriceListLookupService.resolvePrice(ctx, variant, currency)
       |       |     |
       |       |     | RequestContextCacheService check → hit/miss
       |       |     |   miss:
       |       |     |     resolutionStrategy.resolve(ctx, customerId)
       |       |     |         |
       |       |     |         | CacheService(Layer A) check → hit/miss
       |       |     |         |   miss → DB query, build candidate set, write Layer A
       |       |     |         v
       |       |     |     calculationStrategy.calculate(ctx, variant, currency, groups)
       |       |     |         |
       |       |     |         | preProcessGroups (default: identity)
       |       |     |         | tryExternalPrice (default: null)
       |       |     |         | cascade across groups (lowest priority first)
       |       |     |         | roundingStrategy.round(...)
       |       |     |         v
       |       |     |     ResolvedPrice { value, provenance, source }
       |       |     |
       |       |     | (Layer B cached, RequestContextCache memoized)
       |       |     v
       |       |   ResolvedPrice | null
       |       |
       |       | if null:  return super.calculate(args)                  ← standard path
       |       | else:     originalResult = await super.calculate(args)
       |       |           adjustedResult = await super.calculate({...args, inputPrice: resolved.value})
       |       |           requestCache.set('pricelist:original:...', { originalPrice, badge })
       |       |           return adjustedResult
       |       v
       |   PriceCalculationResult { price, priceIncludesTax }
       v
[variant.price returned to GraphQL]

   then:
[ProductVariant.originalPrice resolver]
       |
       | requestCache.get('pricelist:original:...')
       v
   number | null
```

### 2.6 Manual regression checklist

Run after deploying Stage 3. Same Vendure dev stack as Stage 1's manual
test. Pre-conditions identical to Stage 1's §2.7 (default-channel +
b2b-channel, customers, variants, etc.), plus the pricelists created
in Stage 1's manual test should still exist (idempotent — re-create if
necessary).

**Test list (each row is a Shop API GraphQL query — use GraphiQL or
the dashboard's API explorer):**

1. **Variant with no applicable pricelist** — query a variant that has
   no pricelist matching. `price` = standard. `originalPrice` = null.
   `priceListBadge` = null.
2. **Variant with ABSOLUTE pricelist** — query as a customer who gets
   `STANDARD-EUR`. `price` = 4500 (the list value). `originalPrice` =
   the variant's standard price (e.g. 5000). `priceListBadge.code` =
   `STANDARD-EUR`.
3. **Variant with stacked PERCENTAGE cascade** — query as `alice@test`
   on a variant covered by the §2.4 worked-example setup. `price` =
   6840. `originalPrice` = 10000. `priceListBadge.code` = `BFRIDAY`
   (last-applied entry).
4. **PDP scenario, anonymous user** — same query, no auth. `price` =
   GLOBAL-assigned pricelist value (or standard if no GLOBAL).
   `originalPrice` reflects accordingly.
5. **Add to order: line snapshots adjusted price** — `addItemToOrder`
   with the §2.4 variant. Inspect the order line: `unitPrice` = 6840
   (pricelist-adjusted). `customFields.pricelistProvenance` is set to
   a JSON array with 3 entries (B2C-EUR, WHOLESALE-EUR, BFRIDAY).
6. **Promotion stacks on pricelist-adjusted base** — create a Vendure
   Promotion `EXTRA10` (= -10% of order total). Add the §2.4 variant
   to the cart, apply promo. Order total uses `6840` as the line price
   before the promo's -10%. Verify total = `6840 * 0.9 = 6156` (after
   the promo, before any rounding edge case).
7. **Shared variant not in active channel** — query as a customer on
   `b2b-channel` for `SKU-B` (only in default-channel). `price` and
   `originalPrice` both null/absent (Vendure short-circuits upstream).
   No error thrown.
8. **Kill switch on** — set
   `pluginOptions.killSwitchPerChannel.b2b-channel = true`. Repeat
   test 2's query on b2b-channel. `price` = standard, `originalPrice`
   = null, `priceListBadge` = null. Plugin acts as if disabled.
9. **Cache hit on repeated query** — query the same variant twice in
   the same request (e.g. via a `products { items { variants } }`
   collection query covering ~50 variants where 5 share the same
   variant). Verify only one `PriceListLookupService.resolvePrice`
   invocation in the logs.
10. **Tax-included channel** — switch the channel's `pricesIncludeTax`
    to true. Query the §2.4 variant. `price` should be the
    pricelist-adjusted value already-includes-tax;
    `priceIncludesTax: true` returned. Verify
    `originalPrice ≠ originalPriceWithTax` only on cross-zone queries.
11. **Badge disabled via plugin option** — set
    `pluginOptions.exposeBadgeOnShopApi = false`. Repeat test 3.
    `price` and `originalPrice` still work; `priceListBadge` = null.

### 2.7 Decision log (settled non-decisions worth recording)

Recorded here so future contributors can see what was deliberately not
done, and why:

1. **Single-hook strategy override** (§Q1) — only
   `ProductVariantPriceCalculationStrategy` is hooked.
   `ProductVariantPriceSelectionStrategy` is NOT, by design — pricelists
   adjust values, not selection.
2. **`OrderItemPriceCalculationStrategy` is NOT overridden** (§Q2 /
   §2.4). The provenance snapshot is handled by an
   `OrderLineEvent('created')` subscriber that writes to
   `OrderLine.customFields.pricelistProvenance`. Confirmed safe because
   the variant-price strategy upstream has already replaced
   `variant.listPrice`, so Vendure's default order-item strategy
   snapshots the correct (pricelist-adjusted) price.
3. **Promotions are downstream, untouched** (§Q4). No code interacts
   with the Promotion engine.
4. **Strike-through computed via "compute both prices" hybrid** (§Q5
   option C). Doubled super-call only on the pricelist-applies path;
   no-pricelist path keeps single-call cost.
5. **Public Shop API does NOT expose internal pricelist ids** (§Q9).
   Only the badge `code` + `label` are exposed, gated behind a plugin
   option `exposeBadgeOnShopApi`.
6. **No defensive variant-in-channel check in the strategy** (§Q8).
   Vendure's upstream selection strategy already short-circuits
   out-of-channel variants.

---

## 3. Out of scope for Stage 3

- Automated e2e tests — Stage 4.
- Shop API SDL fields beyond `originalPrice` / `originalPriceWithTax` /
  `priceListBadge`.
- Bulk variant repricing tools / admin operations on the resolved-price
  values.
- The `NOT_AVAILABLE` sentinel branch (recorded as v2 in Stage 2 §5).
- Multi-currency conversion (no FX; multi-currency requires explicit
  per-currency rows).

---

## 4. Resolved questions (decisions of record)

All resolved 2026-05-26.

1. **`priceListBadge` enabled by default — YES.**
   `pluginOptions.exposeBadgeOnShopApi: boolean = true`. Merchants who
   consider the list code an info leak can flip it off without code
   changes. Default-on supports the strike-through marketing-label
   workflow out of the box.

2. **`OrderLine.customFields.pricelistProvenance` — JSON text.**
   `type: 'text'`, `nullable: true`, `public: false`, `readonly: true`,
   `internal: true`. JSON-stringified `ResolvedPriceProvenanceEntry[]`.
   No dedicated `OrderLinePricelistSnapshot` entity — the snapshot is
   for support-debug display only, never queried by id.

3. **`priceListBadge.label` source — `PriceList.name`** for v1. No
   separate `marketingLabel` field. If the PO later asks for an
   admin-name distinct from a marketing-label, add the column as a
   Stage 1 backflow amendment at that time.

---

## 5. Next step

Upon approval of this document, Stage 4 produces `PLAN-STAGE-4.md`
(automated e2e suite using `@vendure/testing`, installed during Stage 0
amendment). Stage 4 references the manual checklists from Stages 1
and 3, plus the unit-test matrix from Stage 2, and converts every row
into a named, executable test.
