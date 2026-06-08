# PLAN-STAGE-1 — Entities + Dashboard (manual-test surface)

> **Goal.** After executing this plan, a human can log into the Vendure
> dashboard and exercise every creation path from meta-plan §0.1 by hand:
> create groups, lists, items (absolute and percentage), share lists
> across channels, assign lists/groups globally / to customers / to
> customer groups. **No lookup logic yet** — Stage 1 produces the
> editable surface only.
>
> Stage 0 verification doc is the prerequisite for this plan; signatures
> below were quoted from there.

## Implementation status — 2026-05-28 (IMPLEMENTED, two rounds of lead-review revisions)

Stage 1 is built, migrated, validated end-to-end against the live dev DB
(GraphQL Playground walkthrough Parts 2–7 — schema introspection,
happy-path CRUD, all 5 service-layer guards, polymorphic assignments,
DB-level partial-unique enforcement). Two rounds of lead-dev review were
applied as follow-up batches; the revisions are summarised here and
folded into the body of this document.

### Lead-review batch 2 — channel/group split, flatten assignments (2026-05-28)

Five structural changes addressing anti-patterns and design mismatches
caught after batch 1 shipped:

1. **`PriceList` is now *truly* ChannelAware.** Standard Vendure
   `@ManyToMany @JoinTable channels: Channel[]` replaces the previous
   fake `implements ChannelAware` (which had a plain field with no
   decorator). `findOneInChannel` and the rest of Vendure's
   channel-filtering machinery work natively.
2. **Channel ↔ Group binding decoupled.** The old combined pivot
   `PriceListChannelAssociation` (which held the `(priceListId,
   channelId, groupId)` triple) is gone. Replaced by:
   - the standard Vendure channels pivot (handles "which channels can
     see this list")
   - a new custom `PriceListGroupMembership` entity (just
     `(priceListId, groupId)`; channel is derived from
     `group.channelId` since groups are channel-local)
3. **`PriceListAssignment` polymorphic table removed.** Replaced by
   three direct fields on `PriceList`:
   - `assignedToEveryone: boolean`
   - `@ManyToMany Customer[] assignedCustomers`
   - `@ManyToMany CustomerGroup[] assignedCustomerGroups`

   Stage 2 lookup becomes a straight OR predicate, no discriminator
   columns.
4. **Group-level assignments dropped entirely.** Per the PO/lead's
   direction ("les groupes sont globaux / seul les lists sont
   assignées"), `PriceListGroup` carries no access scope — it remains
   a purely organisational/priority bucket. The original spec
   (meta-plan §0.2.7) listed both LIST and GROUP as valid assignment
   subjects; that flexibility is dropped, and Stage 2's cascade
   accordingly resolves access at the list level only.
5. **`PriceListItem.deletedAt` removed.** Items are hard-deleted on
   removal. Soft-delete of the parent list is O(1) (one UPDATE on the
   parent row) — items become invisible because every item-returning
   query JOINs the parent and filters `priceList.deletedAt IS NULL`.
   Trades individual-item-undo for a performance characteristic that
   scales with the catalog rather than per-list item count. The
   `removePriceListItem` mutation is therefore a real DELETE; "audit
   trail" was already out of scope (meta-plan §0.2.11).

### Migrations applied (3 total)

- `1779868073136-AddPricelistPlugin.ts` — initial schema
- `1779893401448-RefactorPricelistEntities.ts` — batch 1 (Translatable,
  HasCustomFields, pivot rename, stepQuantity, soft-delete cascade,
  per-channel code uniqueness)
- `1779959229390-SplitChannelGroupAndFlattenAssignments.ts` — batch 2
  (channel/group split, flatten assignments). Data backfilled from
  `price_list_channel_association` → `price_list_channels_channel` +
  `price_list_group_membership`. Data backfilled from
  `price_list_assignment` → `assignedToEveryone` + 4 new ManyToMany
  pivots. Old tables dropped.
- `1779959761096-RemoveGroupAssignments.ts` — cleanup of batch 2's
  over-build. Drops `price_list_group.assignedToEveryone` + 2
  group-assignment pivots that were prematurely added. The single
  group-level GLOBAL test row was discarded (intentional per the lead's
  "groups are global" direction).

### Lead-review batch 1 (folded into body)

These nine items were applied in the first revision pass and remain in
the current code.

### Stage 1D refactor — Vendure-compliance pass + pivot editor (2026-06-04)

Direction from PO/lead: prefer existing Vendure dashboard primitives over
hand-rolled UI, surface a real per-item detail page at the pricelist
level, use the channel locale for content instead of a dedicated
translations block, and hold back the timezone picker until Stage 2
actually consumes it.

Five changes, in order:

1. **Items table on the pricelist detail uses `PaginatedListDataTable`.**
   Hand-rolled hierarchical table (SKU → currency → tiers) replaced by
   the standard Vendure paginated table — one row per distinct variant
   in the list, columns `Variant / Currencies / Tiers / Last updated`.
   Native sort, filter, column visibility, persistence all come for
   free. Click on a SKU navigates to the new item-detail route.

2. **New route `/pricelists/$id/items/$variantId` with a pivot
   editor.** Rows are currencies (default first, then alphabetical),
   columns are stepQuantity tiers (ascending). Each cell is empty (no
   price) or holds a value (integer minor units for ABSOLUTE,
   basis points for PERCENTAGE — `PercentageInput` is reused). Toolbar
   adds tiers/currencies; Save commits the entire pivot via the new
   bulk mutation. Page composed from Vendure UI primitives (`Card`,
   `Table`, `Input`, `Select`, `Button`, `Badge`) — no custom layout.

3. **Backend: per-variant aggregate + atomic pivot save.**

   - `priceListVariantSummaries(priceListId, options): PriceListVariantSummaryList!`
     — paginated, one row per distinct `productVariantId` with
     currency/tier counts and `MAX(updatedAt)`. Built on TypeORM's
     query builder with `GROUP BY` so it stays portable.
   - `priceListVariantItems(priceListId, productVariantId): [PriceListItem!]!`
     — every cell of the pivot for a single variant, ordered by
     currency + stepQuantity for stable rendering. Not paginated.
   - `savePriceListVariantPivot(input): [PriceListItem!]!` mutation.
     Diffs the incoming `rows` set against the stored set:
     INSERT new cells, UPDATE changed values, DELETE missing. Wrapped
     in a transaction so the round-trip is atomic. Defensive: rejects
     duplicate `(currencyCode, stepQuantity)` keys in the payload, and
     enforces positive-integer `stepQuantity` + non-negative integer
     `value`.

4. **Translations editing moved inline to the Summary card.** The
   dedicated `Translations (N)` Card on the detail page is removed.
   Name and Description fields now read/write the translation row
   keyed on the dashboard's active **content language** (Vendure's
   `useUserSettings().settings.contentLanguage`, mirrored by the API
   client on every mutation). Label decoration: `Name (FR)`,
   `Description (FR)` — the locale tag tells the merchandiser which
   language they're editing. Entity stays Translatable; no DB change.

5. **Timezone field hidden from the UI; DB column kept.**
   `TimezoneSelect` no longer mounted in the create dialog or detail
   page. The SDL `CreatePriceListInput.timezone` is made optional
   (defaults to `'UTC'` server-side when omitted). The column itself
   stays `NOT NULL DEFAULT 'UTC'` on `price_list` — the picker will
   be re-introduced when Stage-2 lookup actually evaluates the
   window against the merchandiser-set zone.

**Files touched (incremental over 1C):**

- `services/price-list-item.service.ts` — `findByVariant`,
  `findVariantSummariesForList`, `savePivot`; `ProductVariantService`
  injected
- `services/price-list.service.ts` — `CreatePriceListInput.timezone`
  is optional, defaults to `'UTC'` in the create path
- `services/index.ts` — re-export the new input/summary types
- `api/admin-api.schema.ts` — new types `PriceListVariantSummary` +
  `…List`, new input `SavePriceListVariantPivotInput`, queries
  `priceListVariantSummaries`/`priceListVariantItems`, mutation
  `savePriceListVariantPivot`, `CreatePriceListInput.timezone` made
  optional
- `api/price-list-item.admin-resolver.ts` — two new queries + bulk
  save mutation resolver
- `dashboard/gql/queries.ts` — `priceListVariantSummariesQuery`,
  `priceListVariantItemsQuery`; `originChannel` selection retained
  for currency info
- `dashboard/gql/mutations.ts` — `savePriceListVariantPivotMutation`;
  stale `valueType` and inline assigned-customer selections cleaned
  out
- `dashboard/pages/price-list-detail.tsx` — uses
  `useUserSettings().settings.contentLanguage` for label + load
  hydration; Translations card removed; Timezone FormRow removed
- `dashboard/pages/price-list-item-detail.tsx` (new) — pivot editor
- `dashboard/components/price-list-items-grid.tsx` — rewritten as
  thin wrapper around `PaginatedListDataTable`
- `dashboard/components/create-price-list-dialog.tsx` — timezone
  picker mount removed; translation row keyed on
  `contentLanguage` instead of hard-coded `'en'`
- `dashboard/index.tsx` — new route registered at
  `/pricelists/$id/items/$variantId`
- `dashboard/i18n/fr.po` — 21 new strings translated

**Migration:** none for Stage 1D. All changes are SDL-additive
(`timezone` made *less* strict) or dashboard-only.

### Stage 1C refactor — PO direction (2026-06-01)

Four substantial changes were merged in one pass at the PO/lead's
request. They are breaking against the Stage-1B schema and dashboard
contract; the migration applies in-place against existing test data.

1. **`valueType` moves from `PriceListItem` to `PriceList`.** A list
   must be ABSOLUTE or PERCENTAGE — mixing conventions across items in
   the same list silently produced incoherent prices in the Stage-2
   cascade. The field is **not** updatable after creation: changing it
   would re-interpret every existing item's `value`. To switch type, a
   new list must be created.

   - DB: `price_list.valueType varchar(16) NOT NULL DEFAULT 'ABSOLUTE'`
     added; `price_list_item.valueType` dropped.
   - SDL: `PriceList.valueType: PriceListValueType!`; the field is
     removed from `PriceListItem`, `CreatePriceListItemInput`, and
     `UpdatePriceListItemInput`. `CreatePriceListInput.valueType` is
     required; `UpdatePriceListInput` does **not** carry `valueType`.
   - Test data: the single orphan PERCENTAGE item on the `TEST-EUR` list
     is dropped on migration up(); the list itself becomes ABSOLUTE
     (PO option a). No general backfill — there is no defensible
     mapping when items in a single list disagree.

2. **`timezone` (IANA) added to `PriceList`, required.** Stage-2 lookup
   evaluates the `startDate`/`endDate` window against this zone rather
   than the server's local time. The dashboard picker prefers
   `Intl.supportedValuesOf('timeZone')` and falls back to a curated
   short-list when the runtime doesn't expose that API.

   - DB: `price_list.timezone varchar(64) NOT NULL DEFAULT 'UTC'`.
   - SDL: `PriceList.timezone: String!`;
     `CreatePriceListInput.timezone: String!`;
     `UpdatePriceListInput.timezone: String` (updatable — only changes
     window interpretation, doesn't re-derive stored values).

3. **Items grid: paginated + SKU-grouped.** The previous flat table
   inlined the full item set on every detail-page load — unworkable
   past a few hundred SKUs. The grid now loads its own page slice
   (50 rows) via the new `priceListItems` query (paginated wrapping of
   `PriceList.items(options)`). Items with multiple quantity-tier rows
   for the same SKU collapse under a single grouped header (sorted by
   `stepQuantity` ascending). Per-row edit/remove affordances are
   preserved; `valueType` is no longer an editable per-row field
   (list-wide invariant now).

4. **Customer access: paginated + searchable; inline arrays dropped
   from SDL.** Direct customer assignments routinely run into the
   several thousand range. The detail query no longer exposes
   `assignedCustomers` / `assignedCustomerGroups` inline. Two new
   paginated queries replace them:

   - `priceListAssignedCustomers(priceListId, options): PriceListCustomerList!`
   - `priceListAssignedCustomerGroups(priceListId, options): PriceListCustomerGroupList!`

   Both accept `{ skip, take, filter }` where `filter` is a
   case-insensitive substring match against email/first/last name
   (customers) or `name` (groups). The dashboard access block renders
   a two-tab panel (customers / groups) with a debounced search input
   (250 ms) and prev/next pagination at PAGE_SIZE=25. The
   single-customer add/remove affordances continue to use the existing
   `addCustomersToPriceList` / `removeCustomersFromPriceList`
   mutations.

   Implementation note: the M2M from `Customer` → `PriceList` is
   one-directional (declared only on PriceList), so the service joins
   the TypeORM-default pivot tables directly
   (`price_list_assigned_customers_customer`,
   `price_list_assigned_customer_groups_customer_group`) with their
   camelCase FK columns. Pivot identifiers were confirmed against the
   Stage-1B migration.

**Migration:** `1780300997114-Stage1CValueTypeAndTimezone.ts`. Down is
non-destructive on schema but does not attempt to recreate the deleted
test-data PERCENTAGE row.

**Files touched (incremental over batch 2):**

- `entities/price-list.entity.ts` — `valueType`, `timezone` columns
- `entities/price-list-item.entity.ts` — `valueType` column removed
- `services/price-list.service.ts` — input shapes, `findAssignedCustomers`,
  `findAssignedCustomerGroups`; `findOne` no longer loads
  `assignedCustomers` / `assignedCustomerGroups`
- `services/price-list-item.service.ts` — `valueType` removed from inputs
  and add/update paths
- `api/admin-api.schema.ts` — SDL: new fields, new paginated queries,
  inline arrays dropped from `PriceList`
- `api/price-list.admin-resolver.ts` — two paginated query resolvers
- `dashboard/components/create-price-list-dialog.tsx` — collects
  valueType + timezone
- `dashboard/components/timezone-select.tsx` (new) — IANA picker
- `dashboard/components/add-price-list-item-dialog.tsx` — inherits list
  `valueType`, no per-item type picker
- `dashboard/components/price-list-items-grid.tsx` — own pagination,
  SKU grouping
- `dashboard/components/price-list-access-block.tsx` — tabbed
  paginated/search panes for customers + customer groups
- `dashboard/pages/price-list-detail.tsx` — timezone editor, valueType
  display, props dropped for inline customer arrays
- `dashboard/gql/queries.ts` — `priceListItemsQuery`,
  `priceListAssignedCustomersQuery`,
  `priceListAssignedCustomerGroupsQuery`; inline arrays removed from
  `priceListDetailQuery`
- `dashboard/gql/types.ts` — type updates to match

### Files shipped (final state after both review batches)

```text
src/plugins/pricelist/
├── constants.ts                              # error codes, DEFAULT_GROUP_CODE
├── permissions.ts                            # CrudPermissionDefinition × 2
├── types.ts                                  # PluginInitOptions
├── pricelist.plugin.ts                       # @VendurePlugin wiring
├── entities/
│   ├── index.ts                              # ALL_ENTITIES barrel (6 entities)
│   ├── price-list.entity.ts                  # ChannelAware (real @ManyToMany) + SoftDeletable + Translatable + HasCustomFields + 3 assignment fields
│   ├── price-list-translation.entity.ts
│   ├── price-list-item.entity.ts             # HasCustomFields + stepQuantity (NO SoftDeletable — hard delete)
│   ├── price-list-group.entity.ts            # Translatable + HasCustomFields (purely organisational; no assignment fields)
│   ├── price-list-group-translation.entity.ts
│   └── price-list-group-membership.entity.ts # NEW (batch 2): list ↔ group pivot, no channel column
├── services/
│   ├── index.ts                              # ALL_SERVICES barrel
│   ├── price-list.service.ts                 # findOneInChannel; O(1) soft-delete; share/unshare; assignment methods
│   ├── price-list-item.service.ts            # JOIN-filter on parent.deletedAt; hard-delete on remove
│   └── price-list-group.service.ts           # TranslatableSaver + TranslatorService
├── api/
│   ├── index.ts                              # ALL_RESOLVERS barrel
│   ├── admin-api.schema.ts                   # SDL — no PriceListAssignment* types; 3 assignment fields + 5 mutations on PriceList
│   ├── price-list.admin-resolver.ts          # CRUD + share + 5 assignment mutations
│   ├── price-list-item.admin-resolver.ts
│   ├── price-list-group.admin-resolver.ts    # CRUD only (no group-level assignments)
│   └── price-list-entity.admin-resolver.ts   # @ResolveField for paginated items
├── migrations/
│   └── README.md                             # left for historical reference
├── dashboard/
│   ├── README.md                             # Stage 1 status + deferred UI list
│   ├── index.tsx                             # defineDashboardExtension + nav + 4 routes
│   ├── i18n/
│   │   ├── en.po                             # 57 source strings extracted
│   │   ├── de.po                             # awaiting translation
│   │   └── fr.po                             # awaiting translation
│   ├── gql/
│   │   ├── queries.ts                        # graphql(/* GraphQL */ `...`); fetches groupMemberships + assignment fields
│   │   └── types.ts                          # local TS types (pending gql.tada codegen)
│   └── pages/
│       ├── price-list-list.tsx               # @/vdb/* components + useLingui
│       ├── price-list-detail.tsx             # Channel memberships + Customer access + Translations blocks
│       ├── price-list-group-list.tsx
│       └── price-list-group-detail.tsx
└── plans/
    ├── PLAN-STAGE-0-API-VERIFICATION.md
    ├── PLAN-STAGE-1.md                       # this file
    ├── PLAN-STAGE-2.md
    ├── PLAN-STAGE-3.md
    └── PLAN-STAGE-4.md

src/migrations/
├── 1779868073136-AddPricelistPlugin.ts                          # initial schema
├── 1779893401448-RefactorPricelistEntities.ts                   # batch 1 revisions
├── 1779959229390-SplitChannelGroupAndFlattenAssignments.ts      # batch 2 revisions
└── 1779959761096-RemoveGroupAssignments.ts                      # batch 2 cleanup (drop group-side assignment work)
```

**Entities/services/resolvers deleted along the way:**
`PriceListChannelAssociation` (replaced by standard channels pivot +
`PriceListGroupMembership`), `PriceListAssignment` (flattened into
fields), `PriceListAssignmentService`, `PriceListAssignmentAdminResolver`.

1. **Translatable** added to `PriceList` (name + description) and
   `PriceListGroup` (name). New translation entities + tables.
   `TranslatorService` invoked in service-layer reads to expose the
   active-language `LocaleString` fields. Section §1 Q4 / Q9 amended
   to reflect translation-bearing SDL inputs (`CreatePriceListInput`
   takes `translations: [PriceListTranslationInput!]!` instead of
   `name: String!`).
2. **`HasCustomFields`** added to `PriceList`, `PriceListGroup`,
   `PriceListItem`, and both translation tables. Plugin-defined
   entities cannot participate in Vendure's auto-generated
   `Custom<Entity>Fields` typing (that machinery is core-only), so we
   expose a `simple-json` column with `default '{}'`. Satisfies the
   interface and lets merchants attach metadata without per-field
   migrations.
3. **Pivot rename** — `PriceListChannel` → `PriceListChannelAssociation`
   (entity, class, table, all imports). Table renamed in place via
   `ALTER TABLE ... RENAME TO` so existing pivot rows are preserved;
   PK/UQ/FK constraint names updated to TypeORM's expected hashes so
   future `migrate -g` diffs stay clean. The public SDL field
   `PriceList.groupAssignments: [PriceListChannelGroup!]!` retains its
   external name (the internal entity is the pivot; the GraphQL type
   is the customer-facing pair shape).
4. **Soft-delete cascade** on `PriceListItem` — Option A from the
   review. `deletedAt` column added to the item entity;
   `PriceListService.softDelete` now soft-deletes the list AND every
   non-already-deleted child item in a single transaction. All
   `findOne`/`findByList`/`findAll` paths filter `deletedAt IS NULL`.
5. **`minQuantity` → `stepQuantity`** with new semantics: quantity-tier
   ladder. Multiple `PriceListItem` rows allowed per
   `(priceList, variant, currency)`, each defining the price for
   purchases of ≥ `stepQuantity` units. `NOT NULL DEFAULT 1`. UNIQUE
   constraint widened to `(priceListId, productVariantId, currencyCode, stepQuantity)`.
   Stage 2 lookup signature will need a `quantity` argument to pick
   the right tier — noted as a Stage 2 amendment.
6. **Per-channel code uniqueness** — new partial unique index
   `uq_price_list_origin_code_alive ON price_list (originChannelId, code) WHERE deletedAt IS NULL`.
   Allows the same `code` across channels and on soft-deleted rows;
   prevents accidental duplicates within a single live origin
   channel. Resolves §4 Q3.
7. **`findOneInChannel` pattern** — applied where the entity is plain
   Vendure-style ChannelAware. PriceList uses a custom pivot
   (`PriceListChannelAssociation` carries the per-channel
   `groupId`) and therefore filters by joining the pivot manually; the
   spirit of "always channel-filter at the service layer" is matched.
8. **Dashboard design-system conformance** — all 4 pages refactored
   from raw `<table>`/`<dl>` HTML + Tailwind to canonical
   `@/vdb/components/ui/{table,card,badge}.js`,
   `@/vdb/components/data-display/{date-time,money}.js`,
   `@/vdb/components/shared/detail-page-button.js`. Imports use the
   `@/vdb/` alias (project canonical), not `@vendure/dashboard`
   directly. Hard-coded colours replaced with semantic tokens
   (`text-destructive`, `text-muted-foreground`).
9. **i18n via Lingui** — every user-facing string wrapped in `` t`…` ``
   from `@lingui/react/macro`. 51 source strings extracted into
   `src/plugins/pricelist/dashboard/i18n/en.po`; `de.po` and `fr.po`
   stubs pending translation. Matches the pattern used by
   `@datasolution/vendure-plugin-external-caching-support`.

### Database state after all migrations (live, 9 tables)

```text
public.price_list                                              — assignedToEveryone bool; no name/description (live in translations)
public.price_list_translation                                  — en row backfilled
public.price_list_group                                        — purely organisational; no assignment columns
public.price_list_group_translation                            — en row backfilled
public.price_list_item                                         — + stepQuantity (default 1), + customFields; NO deletedAt
public.price_list_channels_channel                             — standard Vendure ChannelAware pivot (batch 2)
public.price_list_group_membership                             — NEW (batch 2): list ↔ group, no channel column
public.price_list_assigned_customers_customer                  — standard ManyToMany pivot (batch 2)
public.price_list_assigned_customer_groups_customer_group      — standard ManyToMany pivot (batch 2)

Removed tables (batch 2 + cleanup):
  price_list_channel_association                               — split into channels pivot + group_membership
  price_list_assignment                                        — flattened into the 3 fields on price_list
  price_list_group_assigned_customers_customer                 — over-built; dropped per "groups are global"
  price_list_group_assigned_customer_groups_customer_group     — same

Indexes / constraints preserved:
  uq_price_list_group_default_per_channel                      — partial unique (initial migration)
  uq_price_list_origin_code_alive                              — partial unique on (originChannelId, code) WHERE deletedAt IS NULL
  UQ_b3b500f4295266c61a0d1ef98bf                                — UNIQUE (priceListId, productVariantId, currencyCode, stepQuantity)
  UQ_8c873668172c5f0d2c225b236ee                                — UNIQUE (priceListId, groupId) on group_membership
```

### Validation completed

- **Schema introspection** — all 21 SDL types/inputs registered ✓
- **Happy path CRUD** — create list, add items (ABS + PERCENTAGE),
  read via dashboard ✓
- **Service-layer guards** — duplicate item rejected (USER_INPUT_ERROR),
  default group undeleteable (ILLEGAL_OPERATION), atomic default
  transfer flips correctly, polymorphic assignments insert across all
  4 combinations ✓
- **DB partial unique** — second `isDefault=true` for same channel
  rejected at the DB layer with the expected constraint-violation
  error ✓
- **Cross-channel guard** — skipped (only one channel in dev DB; guard
  is in code, not exercised at runtime)

### What's deferred to subsequent stages or future batches

- **Lookup logic + cascade arithmetic** — Stage 2 (the actual
  per-variant price resolution; pricelist data is stored but not yet
  used to price products).
- **Editor UIs in the dashboard** — read-only today; create/update
  flows happen via GraphQL until variant picker, items grid, share
  dialog, assignment panel, and percentage input components are
  built.
- **`NOT_AVAILABLE` sentinel valueType** — column space reserved
  (varchar(16)), no code branch (Stage 2 §5 Q1, deferred to v2).
- **Stage 2 backflow item — quantity argument on
  `PriceListLookupService.resolvePrice`** — recorded; the lookup
  signature needs a `quantity: number` parameter to pick the
  matching stepQuantity tier.
- **Stage 2 backflow item — `SystemClock` injected service** —
  already recorded in Stage 4 §Q5.

### Quick reference — manual test artefacts left in the DB (post-batch-2)

After running through Part 4–6 of the GraphiQL walkthrough plus the
two review batches, the live DB contains:

- `price_list` row `id=1`, code `TEST-EUR`, originChannel 1,
  `assignedToEveryone = true` (from the GLOBAL assignment backfilled in
  batch 2)
- 4 items: 3 ABSOLUTE (variants 5, 1, 2 @ 4500 EUR) + 1 PERCENTAGE
  (variant 4 @ 1000 bp), all `stepQuantity=1`, no `deletedAt`
- `price_list_channels_channel`: 1 row `(1, 1)` (TEST-EUR shared to
  channel 1, its origin) — backfilled from the dropped pivot
- `price_list_group_membership`: 1 row `(1, 1)` (TEST-EUR in group 1)
- `price_list_assigned_customers_customer`: 1 row `(1, 1)` (Alice
  directly assigned to TEST-EUR) — backfilled from the polymorphic
  table
- `price_list_assigned_customer_groups_customer_group`: 1 row `(1, 1)`
  (wholesalers group assigned to TEST-EUR) — backfilled
- `price_list_group` rows: `default` (channel 1), `promo` (channel 1,
  priority 10), `default` (channel 2 — from a second channel created
  in passing during testing). No `assignedToEveryone` column.
- `price_list_translation`: one `en` row for the TEST-EUR list with
  the original name "Test EUR Pricelist"
- `price_list_group_translation`: `en` rows for all three groups
- **Dropped during batch 2 cleanup:** the original group-level GLOBAL
  assignment (subjectType=GROUP, subjectId=1) — intentional per "groups
  are global / not scoped"

This is fine state to take into Stage 2 — none of it blocks the
lookup work.

---

## 0. Development environment — the path-alias convention

The plugin source lives at `src/plugins/pricelist/`. It is also published
to the project's private Artifactory registry as
`@datasolution/vendure-plugin-pricelist@^0.2.0` (declared as a
`dependency` in `package.json`).

**During development, `node_modules/@datasolution/vendure-plugin-pricelist`
is intentionally absent.** TypeScript path aliases in `tsconfig.json:17-26`
and `tsconfig.dashboard.json:23-27` redirect all imports of the package
name to the local source:

```jsonc
"paths": {
    "@datasolution/vendure-plugin-pricelist": [
        "./src/plugins/pricelist/pricelist.plugin",
        "./plugins/pricelist/pricelist.plugin"
    ],
    "@datasolution/vendure-plugin-pricelist/*": [
        "./src/plugins/pricelist/*",
        "./plugins/pricelist/*"
    ]
}
```

`vendure-config.ts` imports `PricelistPlugin` via the package name; the
alias makes that resolve to the in-tree source. This is the standard
`@datasolution/vendure-plugin-*` workflow used by the project's other
plugins (devtools, extended-product-attributes, external-caching-support).

**Implications for Stage 1 implementation:**

- Always edit the source at `src/plugins/pricelist/`, never the
  (non-existent) `node_modules` copy.
- Public entry point for the plugin is
  `src/plugins/pricelist/pricelist.plugin.ts` (this matches the path
  alias). Anything consumers should be able to `import { … } from
  '@datasolution/vendure-plugin-pricelist'` must be re-exported from
  `pricelist.plugin.ts` (or via a barrel `src/plugins/pricelist/index.ts`
  if added — verify the alias resolves either way before relying on it).
- Submodule imports (`@datasolution/vendure-plugin-pricelist/<path>`)
  resolve to `src/plugins/pricelist/<path>` via the `*` alias.

**Caveat — `npm install` failure.** The `.npmrc` carries
`min-release-age=7`, blocking installation of any package version
published in the last 7 days. If the latest published `0.2.x` of the
pricelist plugin falls inside that window, `npm install` will fail
with `ENOVERSIONS` ("No versions available"). Two workarounds, neither
blocking dev work:

1. Wait until the published version has aged past 7 days.
2. Temporarily lower `min-release-age` in `.npmrc`.

Local development is unaffected — the path alias provides the source.

---

## 1. Answers to §1.1 questions

### Q1 — Entity graph

Entities introduced by the plugin:

1. **`PriceList`** — channel-aware, soft-deletable. Has many `PriceListItem`.
   The pricelist itself (code, validity, priority).
2. **`PriceListItem`** — the actual `(variant, currency, value, valueType)`
   triplet. Belongs to one `PriceList`.
3. **`PriceListGroup`** — channel-local (NOT shareable, see Q6). Holds the
   role-level priority and the `isDefault` flag.
4. **`PriceListChannel`** — pivot row carrying `(priceListId, channelId, groupId)`.
   Replaces the implicit `@JoinTable` for the standard ChannelAware
   ManyToMany so we can attach `groupId` to each membership row.
   `UNIQUE(priceListId, channelId)`.
5. **`PriceListAssignment`** — polymorphic assignment row.
   `(subjectType: LIST|GROUP, subjectId, targetType: GLOBAL|CUSTOMER|CUSTOMER_GROUP, targetId nullable, channelId)`.
   See "Polymorphic vs typed: decision" below.

**Polymorphic vs typed assignment table — decision: polymorphic.**

- Typed alternative would mean 2 (subject) × 3 (target) = 6 tables, all
  with the same column shape minus the FK side. Adds 6 migrations, 6
  resolver paths, 6 cache-invalidation rules.
- Polymorphic loses DB-level FK validity on `subjectId` and `targetId`
  (they can point at two different tables each).
- Mitigation: TypeScript discriminated-union types at the service layer,
  plus a service-layer existence check on every insert. Indexes on
  `(subjectType, subjectId)` and `(targetType, targetId)` make lookups
  cheap.
- The reference (§0.2.7) treats assignment as flat membership — adopting
  polymorphic mirrors that model directly. Group→customer and
  list→customer are the same row shape.

**Relationship summary:**

```text
PriceListGroup 1───n PriceListChannel n───1 PriceList 1───n PriceListItem
                            │                    │
                            └──→ Channel (FK)    └──→ ProductVariant (FK)
                                                  └──→ CurrencyCode

PriceList   ──n PriceListAssignment (subjectType=LIST,  subjectId=list.id)
PriceListGroup ──n PriceListAssignment (subjectType=GROUP, subjectId=group.id)

PriceListAssignment.targetType ∈ {GLOBAL, CUSTOMER, CUSTOMER_GROUP}
  targetId is NULL when GLOBAL
  targetId FK→Customer when CUSTOMER (validated in service)
  targetId FK→CustomerGroup when CUSTOMER_GROUP (validated in service)
```

`PriceList` itself implements `ChannelAware` via `channels: Channel[]`
(meta-plan §0.2.6) but the relation is implemented through the explicit
`PriceListChannel` pivot, not a vanilla `@JoinTable`. This is required
because the pivot must carry `groupId` (§0.2.11). Vendure's default
ChannelAware filtering machinery (`@ChannelAware` decorator + the
`ListQueryBuilder`) operates on the standard pivot column names; we
align by naming our pivot columns `priceListId` and `channelId` (the
join helpers infer from these by convention — verify when the migration
is generated; if Vendure's helpers can't pick it up, fall back to an
explicit `channels: Channel[]` getter that joins via `PriceListChannel`).

### Q2 — Priority semantics

- `PriceListGroup.priority: number` (integer). Outer axis. **Cascade
  evaluates lowest-priority first** (meta-plan §0.2.4 — base prices first,
  promos last).
- `PriceList.priority: number` (integer). Inner axis. Used by the
  default `HighestPriorityWinsSelectionStrategy` — *higher* value wins
  within a group.
- Tiebreaker: `startDate ASC NULLS FIRST` (open-ended lists rank before
  bounded lists with same priority).
- "Cheapest wins within a group" is NOT the default. It is a separate
  selection strategy a merchandiser opts into (meta-plan §0.2.2 — Stage 2
  ships it as a default impl, but at the entity-schema level there is
  nothing to encode: the choice lives in plugin options, not on the
  list).

### Q3 — Validity window

- `PriceList.startDate: Date | null` and `PriceList.endDate: Date | null`.
- Inclusive on both ends. Either may be null (open-ended).
- Stored as `timestamp with time zone` (Postgres) / `datetime` (SQLite).
  TypeORM `@Column({ type: 'timestamp', nullable: true })`.
- No per-list timezone. All comparisons in UTC; the dashboard converts
  to the admin's local TZ for display.
- DB index: `idx_price_list_validity ON (startDate, endDate)` — speeds
  up the "currently active" filter that Stage 2 will need.

### Q4 — Percentage entries

`PriceListItem` schema:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `ID` (inherited from `VendureEntity`) | |
| `priceListId` | FK → `PriceList` | indexed |
| `productVariantId` | FK → `ProductVariant` | indexed |
| `currencyCode` | `varchar(3)` (`CurrencyCode` enum) | mandatory even for PERCENTAGE (constrains applicability) |
| `valueType` | enum `'ABSOLUTE' \| 'PERCENTAGE'` | column type: TypeORM `enum` on Postgres; `varchar(16)` on SQLite (TypeORM coerces) |
| `value` | `int` | **basis points for PERCENTAGE** (`1000` = -10%), **minor units (cents) for ABSOLUTE** |
| `minQuantity` | `int NULL` | **reserved** — Stage 1 does not use it, but pre-creating the column avoids a future migration (meta-plan §0.2.4) |
| `createdAt`, `updatedAt` | `Date` (inherited) | |

`UNIQUE(priceListId, productVariantId, currencyCode)` — prevents
duplicate triplets (meta-plan §0.1: "set of unique triplets").

**Percentage semantics — CONFIRMED by PO (2026-05-26):**

`value = 1000` on a `PERCENTAGE` line means "10% discount", stored in
basis points, applied multiplicatively as `running × (1 - value/10000)`,
**stacking multiplicatively** across groups (`-10%` then `-10%`
compounds to net `-19%`, not `-20%`), **rounded once at the end** of the
cascade.

Industry validation (research on Sylius, Magento, Intershop):

- **Discount direction** — universal convention (Sylius
  `PercentageDiscountPromotionActionCommand`, Magento `by_percent`).
- **Multiplicative stacking** — matches Magento catalog rules
  (`ProductPriceCalculator::calculate`) and Sylius's sequential
  `PromotionApplicator` (mutates subject in place, so subsequent
  actions see the discounted state). Intershop does NOT stack — it
  picks one winning pricelist — so it is precedent for selection, not
  for our cascade.
- **Basis-point storage** — our choice; differs from Sylius (float
  `[0, 1]`) and Magento (float `[0, 100]`). Defensible (FP-free
  integer math) but unusual; **document loudly in the column docblock
  and in the dashboard input component**.
- **Final-only rounding** — diverges from Sylius/Magento (both round
  per step). Numerically cleaner; will differ from naive
  "apply-each-line-independently" hand calculations by ≤1 minor unit
  in some cases. Stage 2 must ship a test fixture that pins this
  behavior so a future contributor doesn't "fix" it into per-step
  rounding.

**Reserved future extension (do NOT implement in v1).** Magento's
`to_percent` operator (replacement semantics: "set price to 60% of
base") is a real merchant ask that our single `PERCENTAGE` type does
not cover. Reserve it as a future `PERCENTAGE_OF_BASE` value. The
`varchar(16)` column type supports it without migration. **Do not
overload the existing `PERCENTAGE` meaning** to add replacement —
that would silently invert the math on every existing row.

### Q5 — Channel sharing

- `PriceList.channels: Channel[]` — ManyToMany via `PriceListChannel` pivot.
- `PriceList.originChannelId: ID` (FK → `Channel`, **not nullable**).
  Tracks the channel that originally created the list. Used by:
  - the read-only guard at the service layer (any write attempt where
    `ctx.channelId !== list.originChannelId` rejects with a
    `ForbiddenError`),
  - the dashboard to render a "shared" badge on non-origin channels.
- `PriceListItem` does **not** carry a channels relation. Items inherit
  channel scope from their parent list — they exist on every channel the
  list is shared to, but Stage 2's resolution strategy is responsible for
  filtering out items whose `productVariant` is not in the current
  channel (meta-plan §0.2.6 — silent filter, not error).
- The pivot row carries `groupId` (Q6).

**Read-only enforcement (service layer):**

```ts
// PriceListService.update / addItem / removeItem / share / etc.
private assertOriginChannel(ctx: RequestContext, list: PriceList): void {
    if (!idsAreEqual(ctx.channelId, list.originChannelId)) {
        throw new ForbiddenError('PRICELIST_READONLY_NON_ORIGIN_CHANNEL');
    }
}
```

Resolver-level `@Allow(pricelistPermissions.Update)` does NOT cover this —
permissions are channel-scoped but a user CAN have `UpdatePriceList` on
channel B; that allows editing channel-B-owned lists, not channel-A
lists shared into B. The guard must be in the service.

### Q6 — Group scoping

**Q6a — channel-aware AND shareable?**
`PriceListGroup` is channel-LOCAL (single `Channel` FK), NOT shareable.
`PriceListGroup.channelId: ID` (FK, not nullable). No `channels: Channel[]`
relation, no pivot table.

**Q6b — membership shape.**
`PriceListChannel` pivot: `(priceListId, channelId, groupId)`.
`UNIQUE(priceListId, channelId)` — a list belongs to at most one group
per channel where it is present.
Service-layer guard: on insert/update of the pivot row,
`group.channelId === channelId` MUST hold (cross-channel FK consistency
not expressible at DB level without composite FK; checked in code).

**Q6c — default group per channel.**
`PriceListGroup.isDefault: boolean` column.
DB constraint:

```sql
CREATE UNIQUE INDEX uq_pricelist_group_default_per_channel
    ON pricelist_group (channelId) WHERE isDefault = true;
```

(Partial unique index — Postgres-native; SQLite supports via partial
unique index since 3.8.0.)

Auto-creation hook: subscribe to `ChannelEvent` with `type='created'`
(verified at `node_modules/@vendure/core/dist/event-bus/events/channel-event.d.ts:15`).
In the handler, insert `PriceListGroup { code: 'default', isDefault: true,
priority: 0, channelId: event.entity.id }`.

Default-group deletion guard: `PriceListGroupService.delete()` rejects
if `group.isDefault === true`. Renaming and reprioritizing are allowed;
transferring `isDefault` to another group is done via a dedicated
mutation `setDefaultPriceListGroup(channelId, groupId)` which atomically
flips the flag (single transaction, both rows updated).

### Q7 — Permissions

Use Vendure's `CrudPermissionDefinition` helper
(`node_modules/@vendure/core/dist/common/permission-definition.d.ts:129`):

```ts
// src/plugins/pricelist/permissions.ts
import { CrudPermissionDefinition } from '@vendure/core';

export const priceListPermission = new CrudPermissionDefinition('PriceList');
export const priceListGroupPermission = new CrudPermissionDefinition('PriceListGroup');
```

Registered in the plugin's `configuration`:

```ts
configuration: config => {
    config.authOptions.customPermissions.push(
        priceListPermission,
        priceListGroupPermission,
    );
    return config;
},
```

**Channel-scoping contract**: as recorded in Q5 — service-layer guard,
not permission flag. A user with `UpdatePriceList` on channel B can:

- edit any list whose `originChannelId === channelB`,
- NOT edit a list shared into B from elsewhere.

This is enforced inside every mutation service method. The resolver-level
`@Allow(priceListPermission.Update)` only handles the "does the user
have the permission at all on this channel" check.

### Q8 — Admin GraphQL surface

SDL excerpt — full SDL in `src/plugins/pricelist/api/admin-api.schema.ts`:

```graphql
# ---- Types ----

type PriceList implements Node {
    id: ID!
    code: String!
    name: String!
    description: String
    startDate: DateTime
    endDate: DateTime
    priority: Int!
    enabled: Boolean!
    originChannel: Channel!
    channels: [Channel!]!
    groupAssignments: [PriceListChannelGroup!]!   # the (channel, group) pairs
    items(options: PriceListItemListOptions): PriceListItemList!
    assignments: [PriceListAssignment!]!
    createdAt: DateTime!
    updatedAt: DateTime!
    deletedAt: DateTime
}

type PriceListItem implements Node {
    id: ID!
    priceList: PriceList!
    productVariant: ProductVariant!
    currencyCode: CurrencyCode!
    valueType: PriceListValueType!
    value: Int!
    minQuantity: Int
    createdAt: DateTime!
    updatedAt: DateTime!
}

enum PriceListValueType { ABSOLUTE PERCENTAGE }

type PriceListGroup implements Node {
    id: ID!
    code: String!
    name: String!
    priority: Int!
    isDefault: Boolean!
    channel: Channel!
    createdAt: DateTime!
    updatedAt: DateTime!
}

type PriceListChannelGroup {           # one row of the PriceListChannel pivot
    channel: Channel!
    group: PriceListGroup!
}

type PriceListAssignment implements Node {
    id: ID!
    subjectType: PriceListAssignmentSubjectType!
    subjectId: ID!         # resolves to PriceList or PriceListGroup; clients dispatch on subjectType
    targetType: PriceListAssignmentTargetType!
    targetId: ID           # null when targetType=GLOBAL
    channel: Channel!
    createdAt: DateTime!
}

enum PriceListAssignmentSubjectType { LIST GROUP }
enum PriceListAssignmentTargetType { GLOBAL CUSTOMER CUSTOMER_GROUP }

type PriceListList { items: [PriceList!]! totalItems: Int! }
type PriceListItemList { items: [PriceListItem!]! totalItems: Int! }
type PriceListGroupList { items: [PriceListGroup!]! totalItems: Int! }

# ---- Queries ----

extend type Query {
    priceList(id: ID!): PriceList
    priceLists(options: PriceListListOptions): PriceListList!
    priceListGroup(id: ID!): PriceListGroup
    priceListGroups(options: PriceListGroupListOptions): PriceListGroupList!
}

# ---- Mutations ----

extend type Mutation {
    createPriceList(input: CreatePriceListInput!): PriceList!
    updatePriceList(input: UpdatePriceListInput!): PriceList!
    deletePriceList(id: ID!): DeletionResponse!

    addPriceListItem(input: CreatePriceListItemInput!): PriceListItem!
    updatePriceListItem(input: UpdatePriceListItemInput!): PriceListItem!
    removePriceListItem(id: ID!): DeletionResponse!

    # Channel sharing — requires explicit groupId on target channel (§0.2.11)
    assignPriceListToChannel(input: AssignPriceListToChannelInput!): PriceList!
    removePriceListFromChannel(priceListId: ID!, channelId: ID!): PriceList!

    createPriceListGroup(input: CreatePriceListGroupInput!): PriceListGroup!
    updatePriceListGroup(input: UpdatePriceListGroupInput!): PriceListGroup!
    deletePriceListGroup(id: ID!): DeletionResponse!
    setDefaultPriceListGroup(channelId: ID!, groupId: ID!): PriceListGroup!

    createPriceListAssignment(input: CreatePriceListAssignmentInput!): PriceListAssignment!
    removePriceListAssignment(id: ID!): DeletionResponse!
}

# ---- Input types ----

input CreatePriceListInput {
    code: String!
    name: String!
    description: String
    startDate: DateTime
    endDate: DateTime
    priority: Int!
    enabled: Boolean
    groupId: ID                  # if null → use ctx.channel's default group
}

input UpdatePriceListInput {
    id: ID!
    code: String
    name: String
    description: String
    startDate: DateTime
    endDate: DateTime
    priority: Int
    enabled: Boolean
    # NOTE: cannot change groupId via this mutation — use assignPriceListToChannel
}

input CreatePriceListItemInput {
    priceListId: ID!
    productVariantId: ID!
    currencyCode: CurrencyCode!
    valueType: PriceListValueType!
    value: Int!
    minQuantity: Int
}

input UpdatePriceListItemInput {
    id: ID!
    value: Int
    valueType: PriceListValueType
    minQuantity: Int
}

input AssignPriceListToChannelInput {
    priceListId: ID!
    channelId: ID!
    groupId: ID!                 # MANDATORY (§0.2.11 — no defaulting at share time)
}

input CreatePriceListGroupInput {
    code: String!
    name: String!
    priority: Int!
    # isDefault is NOT settable on create — use setDefaultPriceListGroup
}

input UpdatePriceListGroupInput {
    id: ID!
    code: String
    name: String
    priority: Int
}

input CreatePriceListAssignmentInput {
    subjectType: PriceListAssignmentSubjectType!
    subjectId: ID!
    targetType: PriceListAssignmentTargetType!
    targetId: ID                 # required for CUSTOMER / CUSTOMER_GROUP; ignored for GLOBAL
}
```

**No Shop API yet.** Shop API extensions are Stage 3 (the `originalPrice`
field for strike-through, §3.1.5).

**Mutation-side service enforcement of the read-only rule:** every
mutation that takes a `PriceList` id resolves the list, calls
`assertOriginChannel(ctx, list)`, and rejects with `ForbiddenError` if
the active channel is not the origin. This applies to:
`updatePriceList`, `deletePriceList`, `addPriceListItem`,
`updatePriceListItem`, `removePriceListItem`,
`assignPriceListToChannel` (rejects if `ctx.channelId` is not the
list's origin — sharing is initiated from the origin),
`removePriceListFromChannel`, `createPriceListAssignment` (when
`subjectType=LIST`), `removePriceListAssignment` (same).

`assignPriceListToChannel` additionally enforces:

- the target `group.channelId === input.channelId` (cross-channel group
  consistency),
- the `(listId, channelId)` pair does not already exist in
  `PriceListChannel` (UNIQUE constraint backstops this at the DB level
  but a clear error message beats a constraint violation).

### Q9 — Dashboard screens

**File layout** (extending the existing `src/plugins/pricelist/dashboard/`
which currently contains only `.gitkeep`):

```text
src/plugins/pricelist/dashboard/
├── index.tsx                              # defineDashboardExtension({...}) entry point
├── nav.ts                                  # navSections entry (Catalog → Pricelists)
├── routes/
│   ├── price-list-list.tsx                 # GET / table view + filters
│   ├── price-list-detail.tsx               # GET/PUT detail form
│   ├── price-list-group-list.tsx           # group list (current channel only)
│   └── price-list-group-detail.tsx
├── components/
│   ├── PriceListItemsGrid.tsx              # variant picker + items editor
│   ├── PriceListAssignmentsPanel.tsx       # assign global / customer / group
│   ├── ShareToChannelDialog.tsx            # picks channelId + groupId
│   ├── ReadOnlyBanner.tsx                  # shown when current channel != origin
│   ├── SharedBadge.tsx                     # row indicator in list view
│   └── PercentageValueInput.tsx            # bp-aware input with worked-example tooltip
├── gql/
│   ├── queries.ts                          # gql`` documents (priceLists, priceList, etc.)
│   ├── mutations.ts                        # gql`` documents
│   └── fragments.ts                        # PriceListFragment, PriceListItemFragment
└── i18n/
    ├── en.json
    └── fr.json
```

**Plugin registration:**

```ts
// src/plugins/pricelist/pricelist.plugin.ts
@VendurePlugin({
    ...
    dashboard: './dashboard/index.tsx',
    ...
})
```

**Per-screen primitive choice** (decided per §0.10 of Stage 0):

| Screen | Primitive | Why |
| --- | --- | --- |
| Nav entry | `navSections` | adds "Pricelists" + "Pricelist Groups" entries under a "Pricing" section |
| PriceList list page | custom `routes` entry | needs custom badge column (origin/shared), filter chips per channel, channel-aware row actions — `dataTables` is too constrained |
| PriceList detail | custom `routes` entry | header form + items grid + assignments panel + share dialog — `detailForms` would force three nested forms |
| PriceListGroup list/detail | `dataTables` + `detailForms` | simpler shape, the structured primitives fit |
| Share-to-channel action | `actionBarItems` on PriceList detail route | renders a button that opens `ShareToChannelDialog` |
| Default-group transfer | `actionBarItems` on Group detail route | "Make default" button, disabled if already default |

**Behaviors to encode in components:**

- `PriceListList`: badge `Origin` (green) for rows where
  `originChannelId === ctx.channelId`, badge `Shared` (gray) otherwise.
  Row actions: `Edit` enabled only for origin; `Delete` same. `Stop sharing`
  on shared rows (removes from current channel only).
- `PriceListDetail`: if `originChannelId !== ctx.channelId`, render
  `<ReadOnlyBanner />` at top and disable every input + every mutation
  button. Items grid still renders but in read-only mode.
- `PriceListItemsGrid`: variant picker (autocomplete against
  `searchProductVariants` admin query), currency dropdown (constrained
  to channel currencies), value-type toggle (ABSOLUTE/PERCENTAGE) with
  `PercentageValueInput` switching mode. For PERCENTAGE, the input
  shows `10.00 %` UI-side but writes `1000` (basis points) on submit;
  tooltip: *"`-10%` means the final price is `base × 0.9`. Two stacked
  10% discounts compound to `-19%`, not `-20%`."*
- `PriceListItemsGrid` graceful handling: when current channel is not
  the variant's home channel (variant FK exists but variant not in
  current channel), row renders greyed with warning icon and tooltip
  "Variant not available in current channel" (meta-plan §1.1 Q9). The
  row is still editable (it might be valid in another channel where the
  list is shared).
- `PriceListAssignmentsPanel`: three tabs — Global / Customer / Customer
  Group. Each lists existing assignments, add/remove buttons. Customer
  picker uses `searchCustomers`; group picker uses `customerGroups`.
- `ShareToChannelDialog`: two selects — channel (excluding origin and
  channels already shared to), then group (scoped to chosen channel).
  Both mandatory.
- Group list view: scoped to current channel only (no cross-channel
  view). Default group has a star icon next to its name, delete button
  is disabled with tooltip "Default group cannot be deleted; transfer
  the default first."

---

## 2. Artifacts required (§1.2)

### 2.1 Entity definitions

Files under `src/plugins/pricelist/entities/`. All entities extend
`VendureEntity` (from `@vendure/core/dist/entity/base/base.entity`).

#### `price-list.entity.ts`

```ts
import { DeepPartial } from '@vendure/common/lib/shared-types';
import { Channel, ChannelAware, SoftDeletable, VendureEntity } from '@vendure/core';
import {
    Column, Entity, Index, JoinColumn, ManyToOne, OneToMany,
} from 'typeorm';

@Entity()
@Index(['startDate', 'endDate'])
export class PriceList extends VendureEntity implements ChannelAware, SoftDeletable {
    constructor(input?: DeepPartial<PriceList>) { super(input); }

    @Column() code: string;
    @Column() name: string;
    @Column({ nullable: true }) description: string | null;

    @Column({ type: 'timestamp', nullable: true }) startDate: Date | null;
    @Column({ type: 'timestamp', nullable: true }) endDate: Date | null;

    @Column({ default: 0 }) priority: number;
    @Column({ default: true }) enabled: boolean;

    @ManyToOne(() => Channel, { nullable: false, eager: true })
    @JoinColumn()
    originChannel: Channel;
    @Column() originChannelId: ID;

    // ChannelAware — populated via the PriceListChannel pivot (see entity below).
    // The relation itself is NOT a TypeORM @ManyToMany on this side; we expose
    // `channels` as a derived field resolved at the service layer to keep the
    // pivot row's `groupId` column accessible. Vendure's standard channel
    // filtering machinery still needs `channels: Channel[]` to satisfy the
    // ChannelAware interface — see Q5 caveat.
    channels: Channel[];

    @OneToMany(() => PriceListItem, item => item.priceList)
    items: PriceListItem[];

    @OneToMany(() => PriceListChannel, plc => plc.priceList)
    channelMemberships: PriceListChannel[];

    @OneToMany(() => PriceListAssignment, a => a.priceListSubject)
    assignments: PriceListAssignment[];

    @Column({ type: 'timestamp', nullable: true }) deletedAt: Date | null;
}
```

#### `price-list-item.entity.ts`

```ts
import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { DeepPartial } from '@vendure/common/lib/shared-types';
import { ProductVariant, VendureEntity } from '@vendure/core';
import {
    Column, Entity, Index, ManyToOne, Unique,
} from 'typeorm';

export type PriceListValueType = 'ABSOLUTE' | 'PERCENTAGE';

@Entity()
@Unique(['priceList', 'productVariant', 'currencyCode'])
@Index(['productVariant', 'currencyCode'])    // hot path for Stage 2 lookups
export class PriceListItem extends VendureEntity {
    constructor(input?: DeepPartial<PriceListItem>) { super(input); }

    @ManyToOne(() => PriceList, list => list.items, { onDelete: 'CASCADE' })
    priceList: PriceList;
    @Column() priceListId: ID;

    @ManyToOne(() => ProductVariant, { nullable: false })
    productVariant: ProductVariant;
    @Column() productVariantId: ID;

    @Column({ length: 3 })
    currencyCode: CurrencyCode;

    @Column({ type: 'varchar', length: 16 })
    valueType: PriceListValueType;

    /**
     * For ABSOLUTE: integer minor units (cents).
     * For PERCENTAGE: basis points of a *discount* (1000 = -10%). Confirmed
     * with PO 2026-05-26.
     *
     * Worked example: value=1000, valueType=PERCENTAGE on a base of 5000 cents
     *   → applied as base * (1 - 1000/10000) = 5000 * 0.9 = 4500 cents.
     * Two stacked -10% lines compound multiplicatively: 5000 * 0.9 * 0.9 = 4050.
     *
     * NOTE on storage convention: we use basis points (integer) where Sylius
     * uses float [0,1] and Magento uses float [0,100]. Our choice is for
     * FP-free arithmetic. The dashboard input component is responsible for
     * the bp ↔ "X.XX %" UI conversion.
     *
     * NOTE on future extension: replacement semantics ("price = X% of base",
     * Magento's `to_percent` operator) is reserved for a future
     * `PERCENTAGE_OF_BASE` valueType. The column type supports it without
     * migration. Do NOT change the meaning of the existing PERCENTAGE value
     * — adding a new valueType is the only safe migration path.
     */
    @Column({ type: 'int' })
    value: number;

    @Column({ type: 'int', nullable: true })
    minQuantity: number | null;   // reserved, not used in v1
}
```

#### `price-list-group.entity.ts`

```ts
import { DeepPartial } from '@vendure/common/lib/shared-types';
import { Channel, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';

@Entity()
@Index(['channelId'])
export class PriceListGroup extends VendureEntity {
    constructor(input?: DeepPartial<PriceListGroup>) { super(input); }

    @Column() code: string;
    @Column() name: string;
    @Column({ default: 0 }) priority: number;
    @Column({ default: false }) isDefault: boolean;

    @ManyToOne(() => Channel, { nullable: false })
    channel: Channel;
    @Column() channelId: ID;
}
```

**Partial unique index** (must be added via migration manually — TypeORM
does not generate `WHERE` clauses for unique indexes):

```sql
CREATE UNIQUE INDEX uq_pricelist_group_default_per_channel
    ON price_list_group ("channelId") WHERE "isDefault" = true;
```

#### `price-list-channel.entity.ts` (pivot)

```ts
import { Channel, VendureEntity } from '@vendure/core';
import { Column, Entity, ManyToOne, Unique } from 'typeorm';
import { PriceList } from './price-list.entity';
import { PriceListGroup } from './price-list-group.entity';

@Entity()
@Unique(['priceList', 'channel'])
export class PriceListChannel extends VendureEntity {
    @ManyToOne(() => PriceList, list => list.channelMemberships, { onDelete: 'CASCADE' })
    priceList: PriceList;
    @Column() priceListId: ID;

    @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
    channel: Channel;
    @Column() channelId: ID;

    @ManyToOne(() => PriceListGroup, { nullable: false, onDelete: 'RESTRICT' })
    group: PriceListGroup;
    @Column() groupId: ID;
}
```

#### `price-list-assignment.entity.ts`

```ts
import { Channel, Customer, CustomerGroup, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { PriceList } from './price-list.entity';
import { PriceListGroup } from './price-list-group.entity';

export type AssignmentSubjectType = 'LIST' | 'GROUP';
export type AssignmentTargetType = 'GLOBAL' | 'CUSTOMER' | 'CUSTOMER_GROUP';

@Entity()
@Index(['subjectType', 'subjectId'])
@Index(['targetType', 'targetId'])
@Index(['channelId'])
export class PriceListAssignment extends VendureEntity {
    @Column({ type: 'varchar', length: 16 })
    subjectType: AssignmentSubjectType;
    @Column() subjectId: ID;

    @Column({ type: 'varchar', length: 32 })
    targetType: AssignmentTargetType;
    @Column({ nullable: true }) targetId: ID | null;

    @ManyToOne(() => Channel, { nullable: false })
    channel: Channel;
    @Column() channelId: ID;

    // Convenience relations resolved at the service layer (NOT FKs — the type
    // discriminator decides which entity is referenced). Exposed for GraphQL
    // resolution only.
    priceListSubject?: PriceList;            // when subjectType === 'LIST'
    priceListGroupSubject?: PriceListGroup;  // when subjectType === 'GROUP'
    customerTarget?: Customer;               // when targetType === 'CUSTOMER'
    customerGroupTarget?: CustomerGroup;     // when targetType === 'CUSTOMER_GROUP'
}
```

**Important**: `priceListSubject` is decorated `@OneToMany` from
`PriceList.assignments` (above) because TypeORM needs an inverse side for
the relation to be navigable from the list. The decorator is added on
the `PriceList` side via filter (`subjectType='LIST' AND subjectId=this.id`).
**Caveat**: TypeORM does NOT support filtered relations natively. The
practical workaround is to expose `assignments` on `PriceList` as a
*service-resolved* field, not a TypeORM relation. Update the
`PriceList.assignments` decorator above to remove `@OneToMany` and
treat it as a non-relational property populated by
`PriceListAssignmentService.findBySubject(ctx, 'LIST', list.id)`.

### 2.2 Migration strategy

Single migration: `[timestamp]-AddPricelistPlugin.ts`. Generated via
`npm run migrate -- generate AddPricelistPlugin` (Vendure CLI wraps
TypeORM's migration generator) **after** the entities are added to
`PricelistPlugin.entities` and the plugin is loaded in `vendure-config.ts`.

The auto-generated migration will create:

- `price_list` table with FK to `channel` (origin) and a composite index on
  `(start_date, end_date)`.
- `price_list_item` table with UNIQUE `(price_list_id, product_variant_id, currency_code)`
  and an index on `(product_variant_id, currency_code)`.
- `price_list_group` table with an index on `channel_id`.
- `price_list_channel` table with UNIQUE `(price_list_id, channel_id)`.
- `price_list_assignment` table with three indexes.

**Manual additions to the generated migration:**

1. **Partial unique index for `isDefault`** (TypeORM cannot generate this):

   ```ts
   await queryRunner.query(`
       CREATE UNIQUE INDEX uq_pricelist_group_default_per_channel
           ON price_list_group ("channelId") WHERE "isDefault" = true;
   `);
   ```

   In the `down()` migration, drop it before the table.

2. **Backfill default groups for existing channels** (idempotent):

   ```ts
   await queryRunner.query(`
       INSERT INTO price_list_group ("createdAt", "updatedAt", "code", "name",
           "priority", "isDefault", "channelId")
       SELECT NOW(), NOW(), 'default', 'Default', 0, true, c.id
       FROM channel c
       WHERE NOT EXISTS (
           SELECT 1 FROM price_list_group g
           WHERE g."channelId" = c.id AND g."isDefault" = true
       );
   `);
   ```

3. **Permissions are added at runtime**, not in the migration — Vendure
   registers them via `authOptions.customPermissions` on bootstrap.

### 2.3 Service layer outline (signatures only)

Files under `src/plugins/pricelist/services/`:

#### `price-list.service.ts`

```ts
@Injectable()
export class PriceListService {
    constructor(
        private connection: TransactionalConnection,
        private listQueryBuilder: ListQueryBuilder,
        private channelService: ChannelService,
        private eventBus: EventBus,
    ) {}

    findAll(ctx: RequestContext, options?: ListQueryOptions<PriceList>): Promise<PaginatedList<PriceList>>;
    findOne(ctx: RequestContext, id: ID): Promise<PriceList | undefined>;
    findByCode(ctx: RequestContext, code: string): Promise<PriceList | undefined>;

    create(ctx: RequestContext, input: CreatePriceListInput): Promise<PriceList>;
    update(ctx: RequestContext, input: UpdatePriceListInput): Promise<PriceList>;
    softDelete(ctx: RequestContext, id: ID): Promise<DeletionResponse>;

    assignToChannel(ctx: RequestContext, input: AssignPriceListToChannelInput): Promise<PriceList>;
    removeFromChannel(ctx: RequestContext, priceListId: ID, channelId: ID): Promise<PriceList>;

    private assertOriginChannel(ctx: RequestContext, list: PriceList): void;
    private resolveCreateGroupId(ctx: RequestContext, explicitGroupId?: ID): Promise<ID>;
}
```

#### `price-list-item.service.ts`

```ts
@Injectable()
export class PriceListItemService {
    constructor(
        private connection: TransactionalConnection,
        private priceListService: PriceListService,
    ) {}

    findOne(ctx: RequestContext, id: ID): Promise<PriceListItem | undefined>;
    findByList(ctx: RequestContext, priceListId: ID, options?: ListQueryOptions<PriceListItem>): Promise<PaginatedList<PriceListItem>>;

    add(ctx: RequestContext, input: CreatePriceListItemInput): Promise<PriceListItem>;
    update(ctx: RequestContext, input: UpdatePriceListItemInput): Promise<PriceListItem>;
    remove(ctx: RequestContext, id: ID): Promise<DeletionResponse>;
}
```

#### `price-list-group.service.ts`

```ts
@Injectable()
export class PriceListGroupService {
    constructor(
        private connection: TransactionalConnection,
        private listQueryBuilder: ListQueryBuilder,
        private eventBus: EventBus,
    ) {}

    findAll(ctx: RequestContext, options?: ListQueryOptions<PriceListGroup>): Promise<PaginatedList<PriceListGroup>>;
    findOne(ctx: RequestContext, id: ID): Promise<PriceListGroup | undefined>;
    findDefaultForChannel(ctx: RequestContext, channelId: ID): Promise<PriceListGroup>;

    create(ctx: RequestContext, input: CreatePriceListGroupInput): Promise<PriceListGroup>;
    update(ctx: RequestContext, input: UpdatePriceListGroupInput): Promise<PriceListGroup>;
    delete(ctx: RequestContext, id: ID): Promise<DeletionResponse>;     // rejects if isDefault
    setDefault(ctx: RequestContext, channelId: ID, groupId: ID): Promise<PriceListGroup>;  // atomic flip

    /** Subscribed to ChannelEvent(type='created') — creates the default group. */
    onChannelCreated(event: ChannelEvent): Promise<void>;
}
```

#### `price-list-assignment.service.ts`

```ts
@Injectable()
export class PriceListAssignmentService {
    constructor(private connection: TransactionalConnection) {}

    findBySubject(ctx: RequestContext, subjectType: AssignmentSubjectType, subjectId: ID): Promise<PriceListAssignment[]>;

    create(ctx: RequestContext, input: CreatePriceListAssignmentInput): Promise<PriceListAssignment>;
    remove(ctx: RequestContext, id: ID): Promise<DeletionResponse>;

    private validateTarget(ctx: RequestContext, input: CreatePriceListAssignmentInput): Promise<void>;
}
```

### 2.4 Resolver layer outline

Files under `src/plugins/pricelist/api/`:

- `admin-api.schema.ts` — exports `gql\`...\`` with the SDL from Q8.
- `price-list.admin-resolver.ts` — Query + Mutation methods for
  `PriceList`. Class-based, NestJS `@Resolver()`. Every mutation method
  decorated with `@Transaction()`, `@Allow(priceListPermission.<op>)`,
  `@Ctx() ctx: RequestContext`.
- `price-list-group.admin-resolver.ts` — same shape for groups.
- `price-list-assignment.admin-resolver.ts` — assignments.
- `price-list-entity.admin-resolver.ts` — `@ResolveField` resolvers for
  `PriceList.items`, `PriceList.channels`, `PriceList.assignments`,
  `PriceList.groupAssignments`, `PriceListAssignment.subjectId`
  hydration via union dispatch on `subjectType`, etc.

Total: **5 resolver classes**, **4 service classes**, **5 entity files**,
**1 permissions file**, **1 admin SDL file**, **1 plugin file** to amend.

### 2.5 Dashboard extension

File layout per Q9 above. Skeleton for `index.tsx`:

```tsx
// src/plugins/pricelist/dashboard/index.tsx
import { defineDashboardExtension } from '@vendure/dashboard';
import { priceListNavSections } from './nav';
import { PriceListListPage } from './routes/price-list-list';
import { PriceListDetailPage } from './routes/price-list-detail';
import { PriceListGroupListPage } from './routes/price-list-group-list';
import { PriceListGroupDetailPage } from './routes/price-list-group-detail';

defineDashboardExtension({
    routes: [
        { path: '/pricelists', component: () => <PriceListListPage /> },
        { path: '/pricelists/:id', component: () => <PriceListDetailPage /> },
        { path: '/pricelist-groups', component: () => <PriceListGroupListPage /> },
        { path: '/pricelist-groups/:id', component: () => <PriceListGroupDetailPage /> },
    ],
    navSections: priceListNavSections,
    actionBarItems: [
        // Share-to-channel button on PriceList detail
        { locationId: '/pricelists/:id', component: ShareActionButton },
    ],
});
```

Detailed component contracts are in Q9 above. Stage 1 does NOT include
i18n strings (English placeholders in JSX; `i18n/en.json` + `fr.json`
stubbed empty for later).

### 2.6 Plugin file amendments

```ts
// src/plugins/pricelist/pricelist.plugin.ts
import { adminApiSchema } from './api/admin-api.schema';
import { allEntities } from './entities';
import { allResolvers } from './api';
import { allServices } from './services';
import { priceListPermission, priceListGroupPermission } from './permissions';

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [
        ...allServices,
        { provide: PRICELIST_PLUGIN_OPTIONS, useFactory: () => PricelistPlugin.options },
    ],
    entities: allEntities,
    adminApiExtensions: {
        schema: adminApiSchema,
        resolvers: allResolvers,
    },
    configuration: config => {
        config.authOptions.customPermissions.push(
            priceListPermission,
            priceListGroupPermission,
        );
        return config;
    },
    dashboard: './dashboard/index.tsx',
    compatibility: '^3.6.0',
})
export class PricelistPlugin {
    static options: PluginInitOptions;
    static init(options: PluginInitOptions): Type<PricelistPlugin> {
        this.options = options;
        return PricelistPlugin;
    }
}
```

`vendure-config.ts` must include `PricelistPlugin` in `plugins: [...]`.

### 2.7 Manual test script

The dashboard surface is "done" when an admin user can complete every
step below in order, with no console errors and no thrown 500s.

**Pre-conditions:**

- Two channels exist: `default-channel` and `b2b-channel`.
- At least one currency configured on each: EUR on default, EUR + USD
  on b2b.
- Three test customers: `alice@test`, `bob@test`, `carol@test`.
- One customer group: `wholesalers` with `alice` and `bob` as members.
- At least two product variants: `SKU-A` (in both channels, EUR price
  5000), `SKU-B` (only in default-channel, EUR price 3000).
- Server bootstrap succeeded with the migration applied; both channels
  auto-received a default group `default` with `isDefault=true`.

**Test sequence:**

1. **Group CRUD on default-channel.**
   - Navigate `Pricing → Groups`. Verify "default" group exists, marked
     with star, priority 0, delete button disabled.
   - Create group `promo` with priority 10. Verify it appears in the
     list.
   - Edit `promo` — change priority to 20. Save. Verify.
   - Try deleting `default` — confirm error message.
   - Click "Make default" on `promo`. Verify the star moves and `default`
     loses `isDefault`. Verify `promo`'s delete button is now disabled
     and `default`'s is enabled.
   - Click "Make default" on `default` again to restore initial state.

2. **PriceList creation in origin channel.**
   - Navigate `Pricing → Pricelists`. Verify empty list.
   - Create `STANDARD-EUR`: name "Standard EUR", priority 0, no group
     specified, no dates. Verify it lands in the default group.
   - Create `PROMO-Q4` in group `promo`, priority 5, start = today,
     end = today + 30 days.

3. **Add items.**
   - Open `STANDARD-EUR`. Add item: variant `SKU-A`, EUR, ABSOLUTE,
     value 4500 (= €45.00). Save.
   - Add item: variant `SKU-B`, EUR, ABSOLUTE, value 2800. Save.
   - Open `PROMO-Q4`. Add item: variant `SKU-A`, EUR, PERCENTAGE,
     value 1000 (= -10%). Save. Verify tooltip shows the worked
     example.
   - Try to add a second item: variant `SKU-A`, EUR — confirm UNIQUE
     constraint error.

4. **Assignments — global.**
   - On `STANDARD-EUR`, open Assignments tab. Add a Global assignment.
     Verify the row appears with `targetType=GLOBAL`, `targetId=null`.

5. **Assignments — customer.**
   - On `PROMO-Q4`, add a Customer assignment for `alice@test`. Verify.

6. **Assignments — customer group.**
   - On `PROMO-Q4`, also add a CustomerGroup assignment for
     `wholesalers`. Verify both assignments coexist.

7. **Group-level assignment.**
   - Open group `promo`. Add a Global assignment on the GROUP (not the
     list). Verify `subjectType=GROUP`.

8. **Channel share.**
   - On `STANDARD-EUR`, click "Share to channel". Pick `b2b-channel`,
     pick group (must show `b2b-channel`'s groups only — default).
     Save.
   - Switch active channel to `b2b-channel` in the top header.
   - Navigate to Pricelists. Verify `STANDARD-EUR` appears with the
     `Shared` badge. Verify edit/delete are disabled. Verify the share
     dialog cannot be opened.
   - Open `STANDARD-EUR` detail. Verify the read-only banner.
   - Try invoking `updatePriceList` via GraphQL Playground (admin API
     URL `/admin-api`) — should reject with
     `PRICELIST_READONLY_NON_ORIGIN_CHANNEL`.

9. **Channel share — variant not in target channel.**
   - On `STANDARD-EUR` (still in b2b-channel view), confirm `SKU-B` row
     renders greyed with the warning icon (variant not in b2b-channel).
     Hover to confirm the tooltip.

10. **Stop sharing.**
    - Switch back to `default-channel`.
    - On the Pricelists list, on the `STANDARD-EUR` row, click
      "Stop sharing" → pick `b2b-channel`. Verify the row disappears
      from b2b-channel.

11. **Group cross-channel guard.**
    - In `default-channel`, attempt to assign `STANDARD-EUR` to
      `default-channel` again using a `groupId` belonging to
      `b2b-channel` (use GraphQL Playground to bypass the dashboard's
      filtered picker). Confirm rejection.

12. **Overlapping validity.**
    - Create `STANDARD-EUR-V2` with start = today + 15, end = today + 60,
      priority 1. Add the same `SKU-A` EUR ABSOLUTE 4200 item. Verify
      both `STANDARD-EUR` and `STANDARD-EUR-V2` exist with overlapping
      windows; no error (Stage 2 will decide which wins).

13. **Soft delete.**
    - Delete `STANDARD-EUR-V2`. Verify it disappears from the list
      view. Inspect DB: `deleted_at` is set, row remains.

**Definition of done for Stage 1**: every step above completes without
console errors and produces the documented DB state.

---

## 3. Out of scope for Stage 1 (do not implement)

- Lookup logic, candidate-set resolution, cascade — Stage 2.
- Shop API extensions, `ProductVariantPriceCalculationStrategy`
  override, strike-through — Stage 3.
- e2e tests — Stage 4.
- Bulk import, audit trail, quantity tiers (already excluded by §0.2.11).
- i18n strings (placeholders only in v1).

---

## 4. Open questions for the human

1. ~~**Percentage semantics confirmation (§1.1 Q4).**~~
   **RESOLVED 2026-05-26.** See §1 Q4 above for the confirmed semantics
   and the industry-research notes (Sylius / Magento / Intershop) that
   informed the decision.
2. **Dashboard primitive choice for PriceList list/detail.** Plan
   recommends custom `routes`. If the project has a preference for
   `dataTables` + `detailForms` everywhere for consistency, that
   constrains the badge column and the read-only banner. *(Not
   blocking Stage 2; defer to implementation.)*
3. **Code uniqueness.** Should `PriceList.code` be unique per channel,
   globally, or non-unique? The plan currently treats it as a free-text
   label. If unique-per-channel is needed, add a partial unique index
   and a service-layer check. *(Not blocking Stage 2.)*
4. **Naming of the public `PriceListChannel` GraphQL field.** SDL above
   uses `groupAssignments: [PriceListChannelGroup!]!`. Open to better
   names. *(Not blocking Stage 2.)*

---

## 5. Next step

Upon approval of this document, the next stage of work is
`PLAN-STAGE-2.md` (lookup logic + strategies + cache). Stage 2 will
reference the entity shapes defined here verbatim. If any of the entity
decisions above need revision after Stage 2 surfaces a requirement, the
backflow rule from the meta-plan applies: amend this document with a
dated Revisions entry, re-request review, then continue.
