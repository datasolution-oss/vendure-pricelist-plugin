# PLAN-STAGE-1B — Dashboard editor UIs

> **Status:** PENDING. Splits off the dashboard editor work that was
> originally scoped into Stage 1 (`PLAN-STAGE-1.md` §1.1 Q9) but
> deferred so the backend entity model could stabilise across two
> lead-review revisions. The backend is now stable; the dashboard
> currently exposes only a read surface. This batch makes the dashboard
> capable of performing every mutation the Admin API supports — no more
> GraphiQL-only flows.
>
> Acceptance criteria (single sentence): **the manual-test script in
> `PLAN-STAGE-1.md` §2.7 can be completed end-to-end without leaving
> the dashboard**.

## 0. Conventions — match the project's existing plugins

This document is a strict application of the rules in
`.claude/coderules/`. Every component listed below has a specific
canonical import path; deviating from these would re-introduce the
anti-patterns we cleaned up in lead-review batches.

### 0.1 Import aliases

| Need | Use |
| --- | --- |
| Dashboard core types/hooks | `@/vdb/...` |
| GraphQL client + codegen | `@/vdb/graphql/{api,graphql}.js` |
| i18n | `@lingui/react/macro` (`useLingui` + `` t`...` ``) |
| Routing | `@tanstack/react-router` |
| Data fetching | `@tanstack/react-query` |
| Toasts | `sonner` (`toast.success(t\`…\`)`, `toast.error(t\`…\`)`) |
| Icons | `lucide-react` |

**Forbidden:** importing directly from `@vendure/dashboard` for things
that have a `@/vdb/...` alias (the alias is project-canonical;
`@vendure/dashboard` is the published package consumed only by
`vendure-config.ts`). Verified anti-pattern in
`.claude/coderules/02-vendure-design-system.md`.

### 0.2 High-level page builders (prefer over hand-rolling)

| Component | When to use | Path |
| --- | --- | --- |
| `ListPage` | Standard paginated entity list (PriceList list, PriceListGroup list) | `@/vdb/framework/page/list-page.js` |
| `DetailPage` | Form-driven create/edit detail view | `@/vdb/framework/page/detail-page.js` |
| `PaginatedListDataTable` | Custom list layouts that don't fit `ListPage` | `@/vdb/components/shared/paginated-list-data-table.js` |

`ListPage` and `DetailPage` are the **strongly-recommended** path
(`.claude/coderules/02-vendure-design-system.md` §"Best Practices §7"
— "Use ListPage and DetailPage when possible. Only build custom pages
when ListPage/DetailPage don't fit your needs.").

This batch's two list pages (Pricelists, Groups) will migrate from the
current hand-rolled `<Page><Table>…</Table></Page>` to `ListPage`. The
two detail pages will migrate to `DetailPage` (which provides
React-Hook-Form integration + create/update document plumbing out of
the box).

### 0.3 Existing shared selectors (use, do not rebuild)

All under `@/vdb/components/shared/`:

| Selector | Use case here |
| --- | --- |
| `ProductVariantSelector` | Items grid — variant picker |
| `CustomerSelector` | PriceList customer-access block |
| `CustomerGroupSelector` | PriceList customer-group-access block |
| `ChannelSelector` | Share-to-channel dialog |
| `AssignToChannelDialog` | **Maybe reusable** for our share flow (see §3.2 below — needs evaluation; if it doesn't take a custom `groupId` argument we'll wrap it or skip) |
| `DetailPageButton` | List-page row → detail navigation (already used) |
| `CustomerGroupChip`, `ChannelChip` | Display chips in the assignment block |

### 0.4 Data display components

| Component | Use |
| --- | --- |
| `Money` from `@/vdb/components/data-display/money.js` | ABSOLUTE item values |
| `DateTime` from `@/vdb/components/data-display/date-time.js` | startDate/endDate, createdAt |
| `BooleanDisplayBadge` | enabled/isDefault columns |

### 0.5 Form input components

| Component | Use here |
| --- | --- |
| `TextInput` (`@/vdb/components/data-input/text-input.js`) | code, single-line name (inside translation editor) |
| `TextareaInput` (`@/vdb/components/data-input/textarea-input.js`) | description |
| `DateTimeInput` (`@/vdb/components/data-input/datetime-input.js`) | startDate, endDate |
| `NumberInput` (`@/vdb/components/data-input/number-input.js`) | priority, stepQuantity, ABSOLUTE value |
| `BooleanInput` (`@/vdb/components/data-input/boolean-input.js`) | enabled, assignedToEveryone |
| `SelectWithOptions` (`@/vdb/components/data-input/select-with-options.js`) | currency, valueType, target channel for share |
| `MoneyInput` (`@/vdb/components/data-input/money-input.js`) | **NOT** for our PERCENTAGE value (basis points, not currency) — only for ABSOLUTE if we want locale-aware money input |
| `TranslatableFormFieldWrapper` (`@/vdb/components/shared/translatable-form-field.js`) | Wrapping name + description for the active-language editor |

### 0.6 The bp ↔ % gap

There is no existing dashboard component for "basis-points-as-percent
input". We build one (§4.3 below) and place it under
`src/plugins/pricelist/dashboard/components/percentage-input.tsx`.
The component MUST follow the Lingui pattern (no inline strings) and
use base primitives (`NumberInput` + a static `%` suffix). Tooltip
explains the bp convention and the worked example
("1000 = −10% applied as base × 0.9; two −10% stacks to −19%, not −20%").

### 0.7 Confirmation prompts

`ConfirmationDialog` from `@/vdb/components/shared/confirmation-dialog.js`
for every destructive action (delete pricelist, delete group, remove
item, unshare from channel, remove customer-access entry).

### 0.8 i18n discipline

Every new user-facing string wrapped in `` t`...` ``. Re-run
`npm run translation` at the end of the batch. Confirm `en.po` source
count grew by the right amount; `de.po` and `fr.po` remain at-source
with 0 translations (translators populate them separately).

---

## 1. Scope — components to build

Twelve components total. Numbered for cross-reference in the
acceptance-criteria section (§6).

### 1.1 — `PriceListListPage` migration to `ListPage`

**Today:** hand-rolled `<Page><Table>…</Table></Page>` reading
`priceListsListQuery`.

**Target:** `<ListPage pageId="pricelist-list" listQuery={…} title={t\`Pricelists\`} route={route} customizeColumns={…} bulkActions={…}>` with an action-bar "New Pricelist" button.

Columns (via `customizeColumns`):

- `code` (Code) — mono font, links to detail
- `name` (Name)
- `enabled` (Status) — uses `BooleanDisplayBadge`
- `originChannel.code` (Origin)
- `priority` (Priority)
- `startDate` / `endDate` (Validity) — combined cell with `DateTime`

Action-bar button: "New Pricelist" → navigates to `/pricelists/new`
(uses Tanstack Router; same convention as Vendure's own product list).

Bulk action: `DeletePriceListBulkAction` — soft-deletes selected lists
in one request via the existing `deletePriceList` mutation.

File: `dashboard/pages/price-list-list.tsx` (replaces current).

### 1.2 — `PriceListDetailPage` migration to `DetailPage`

**Today:** read-only multi-card layout.

**Target:** `<DetailPage pageId="pricelist-detail" queryDocument={priceListDetailQuery} createDocument={createPriceListDocument} updateDocument={updatePriceListDocument} setValuesForUpdate={fn} route={route} title={entity => entity?.name ?? t\`New Pricelist\`}>` with composed PageBlocks for each section.

PageBlocks (existing layout preserved; just becomes form-driven):

- **Header form** — code, priority, enabled, startDate, endDate,
  description, translations (via `TranslatableFormFieldWrapper`)
- **Items grid** (§1.4)
- **Channel memberships** (§1.5 — read-only display + Share action bar
  button)
- **Customer access** (§1.6)
- **Translations** — kept read-only here; editing happens inline in the
  header form via `TranslatableFormFieldWrapper`

The "New Pricelist" route hits the same component with no `id` param
and shows only the header form (items/channels/access blocks hidden
until the list is saved).

File: `dashboard/pages/price-list-detail.tsx` (replaces current).

### 1.3 — `setValuesForUpdate` mapper

`DetailPage` needs a function that converts a fetched `PriceList`
entity into the shape `updatePriceList` expects. Lives in
`dashboard/lib/price-list-form-mapper.ts`:

```ts
export function priceListEntityToUpdateInput(pl: PriceListDetail): UpdatePriceListInput {
    return {
        id: pl.id,
        code: pl.code,
        priority: pl.priority,
        enabled: pl.enabled,
        startDate: pl.startDate,
        endDate: pl.endDate,
        translations: pl.translations.map(t => ({
            id: t.id,
            languageCode: t.languageCode,
            name: t.name,
            description: t.description ?? '',
        })),
    };
}
```

### 1.4 — `PriceListItemsGrid` (the centerpiece)

A nested editable table inside the PriceList detail. Rows are
`PriceListItem` records.

File: `dashboard/components/price-list-items-grid.tsx`.

**Behavior:**

- Always-visible header row.
- One row per item, sorted by `(productVariant.sku, currencyCode, stepQuantity)`.
- Per-row inline edit: clicking a cell turns it into the matching
  data-input component (or use a per-row "Edit" toggle to expand all
  cells into edits at once — see §1.4.1 below).
- "+ Add item" trigger opens a new blank row at the bottom or a small
  inline dialog.
- Per-row "remove" icon button → triggers `ConfirmationDialog` →
  `removePriceListItem` mutation.
- After mutate, invalidate `['pricelist', id]` so the page re-fetches.

**Columns:**

| Column | Read mode | Edit mode |
| --- | --- | --- |
| Variant | SKU + product name | `ProductVariantSelector` |
| Currency | code | `SelectWithOptions` populated from `ctx.channel.availableCurrencyCodes` |
| Type | Badge (ABSOLUTE/PERCENTAGE) | `SelectWithOptions` with two options |
| Step Qty | int | `NumberInput min=1` |
| Value | `<Money>` for ABSOLUTE, `<PercentageInput>` formatted for PERCENTAGE | `NumberInput` for ABSOLUTE, `PercentageInput` (§4.3) for PERCENTAGE |
| Actions | edit / remove icon buttons | save / cancel |

#### 1.4.1 Inline-edit pattern decision

Two options:

- **A — per-row "Edit" toggle.** Click pencil icon; the whole row's
  cells become inputs; "Save" / "Cancel" buttons appear in the actions
  column. Mirrors Vendure's own facet-value rows pattern.
- **B — inline-per-cell editing.** Click any cell; it becomes an input
  on the spot. Save on blur.

Recommendation: **A**. Less surprising; explicit save; cleaner with
multiple-field validation (variant + currency + type + stepQuantity
must all be valid for the UNIQUE constraint check to make sense).
Per-cell editing is also harder to make accessible.

### 1.5 — Channel memberships block + `ShareToChannelDialog`

The detail page renders `pl.groupMemberships` as a list of `(channel,
group)` pairs (already done — keep as-is).

Add to the action bar (PageActionBar) on the detail page:

- **"Share to channel"** button (visible only when active channel ==
  origin channel) → opens `ShareToChannelDialog`.

**`ShareToChannelDialog`** (new file
`dashboard/components/share-to-channel-dialog.tsx`):

- Two `Select` controls:
  - **Target channel** — filtered to channels NOT already in
    `pl.channels`. Uses `useChannel()` to scope.
  - **Target group** — filtered to groups of the chosen channel.
    Empty until a channel is picked.
- Both required. Submit calls `assignPriceListToChannel` mutation.
- On success: invalidate `['pricelist', id]`, close dialog,
  `toast.success(t\`Shared to channel\`)`.
- On error (e.g. `PRICELIST_GROUP_CHANNEL_MISMATCH`): inline error
  message, dialog stays open.

**Decision on Vendure's built-in `AssignToChannelDialog`:**
Inspecting `node_modules/@vendure/dashboard/src/lib/components/shared/assign-to-channel-dialog.tsx`,
it's tightly coupled to entities that have a `pricePreviewVariantId` /
`priceFactor` mechanism (Product/ProductVariant). It does NOT accept
a `groupId` argument. **Don't reuse.** Our dialog is plugin-specific.

Per-row "Unshare" / "Stop sharing" action on shared channel rows →
`ConfirmationDialog` → `removePriceListFromChannel` mutation.

### 1.6 — Customer access block (editable)

Replaces the current read-only "Customer access" Card. Three controls:

- **"Available to everyone"** toggle (`BooleanInput` or `Switch`) →
  `setPriceListAssignedToEveryone` on change.
- **Specific customers** — a `CustomerSelector`-driven add picker plus
  a list of currently-assigned customers, each with a remove button.
- **Customer groups** — same shape via `CustomerGroupSelector`.

Add mutations: `addCustomersToPriceList` /
`removeCustomersFromPriceList` / `addCustomerGroupsToPriceList` /
`removeCustomerGroupsFromPriceList`.

Disable all three controls when `pl.originChannelId !== ctx.channelId`
(read-only on non-origin channels — service still enforces, this is
visual feedback).

File: `dashboard/components/price-list-access-block.tsx`.

### 1.7 — `ReadOnlyBanner`

Sticky banner at the top of the detail page when
`pl.originChannelId !== ctx.channelId`:

> "This pricelist was created on channel **{originChannel.code}**.
> Edits are only allowed from its origin channel."

Plus disable all edit controls on the page when the banner is showing
(propagated via a `useIsEditable()` hook backed by `useChannel()` and
the loaded `pl`).

File: `dashboard/components/read-only-banner.tsx`.

### 1.8 — `PriceListGroupListPage` migration to `ListPage`

Same pattern as §1.1 but for groups.

- Columns: code, name, priority, default (★ when isDefault).
- Action-bar "New Group" button.
- Row actions:
  - "Set as default" (only on non-default rows) → confirmation →
    `setDefaultPriceListGroup` mutation.
- Default group's "delete" action is disabled (server enforces; visual
  feedback mirrors).

### 1.9 — `PriceListGroupDetailPage` migration to `DetailPage`

- Form: code, priority, translations.
- `isDefault` is read-only on this page (toggle is the explicit
  "Set as default" action on the list page).
- No items/channels/access blocks (groups carry no scope per the
  batch-2 design).

### 1.10 — `PercentageInput` (the bp ↔ % UI)

The one new primitive this batch ships. Specs:

- Input shows `10.00 %` to the user, persists `1000` to the model.
- On focus, value formats with two decimal places.
- On blur, converts via `Math.round(parseFloat(input) * 100)` →
  basis-point integer.
- Pop-over tooltip on a `?` icon next to the field explains:
  - "Discount in basis points. `1000` means `-10%`."
  - "Applied as `running × (1 − value / 10000)`."
  - "Two stacked `-10%` lines compound to `-19%`, not `-20%`."
- Validation: 0 ≤ bp ≤ 10000. Submit-time check.

File: `dashboard/components/percentage-input.tsx`.

### 1.11 — `New Pricelist` / `New Group` create flows

Both detail pages should accept a `new` route variant:

- `/pricelists/new` → empty form, only the header block visible.
- `/pricelist-groups/new` → empty form.

`DetailPage` natively supports this via its `createDocument` prop. On
save, navigate to the newly-created `/pricelists/{id}` (or
`/pricelist-groups/{id}`).

### 1.12 — Bulk-delete action

`DeletePriceListBulkAction` for the list page. Uses
`PaginatedListDataTable`'s built-in bulk-action wiring — invoke
`deletePriceList(id)` per selected row, show progress toast, refresh
list query at end.

File: `dashboard/components/delete-price-list-bulk-action.tsx`.

---

## 2. File layout after this batch

```text
src/plugins/pricelist/dashboard/
├── README.md                        # updated to reflect editor UIs as shipped
├── index.tsx                        # routes unchanged; nav unchanged
├── i18n/
│   ├── en.po                        # re-extracted, ~150 strings expected
│   ├── de.po                        # awaiting translation
│   └── fr.po                        # awaiting translation
├── gql/
│   ├── queries.ts                   # query docs unchanged
│   ├── mutations.ts                 # NEW — all mutation docs
│   └── types.ts                     # local TS types extended
├── lib/
│   ├── price-list-form-mapper.ts    # entity → updateInput
│   └── use-is-editable.ts           # origin-channel guard hook
├── components/
│   ├── price-list-items-grid.tsx
│   ├── price-list-access-block.tsx
│   ├── share-to-channel-dialog.tsx
│   ├── read-only-banner.tsx
│   ├── percentage-input.tsx
│   └── delete-price-list-bulk-action.tsx
└── pages/
    ├── price-list-list.tsx          # rewritten with ListPage
    ├── price-list-detail.tsx        # rewritten with DetailPage
    ├── price-list-group-list.tsx    # rewritten with ListPage
    └── price-list-group-detail.tsx  # rewritten with DetailPage
```

Total: 11 new/rewritten component files + 2 helper files + 1 mutations
gql file. Estimated ~1500 lines.

---

## 3. Mutations consumed (already shipped on the backend)

For traceability — every backend mutation already exists; this batch
wires UI to them. No backend changes.

| Mutation | Consumed by |
| --- | --- |
| `createPriceList` | DetailPage `createDocument` (§1.2, §1.11) |
| `updatePriceList` | DetailPage `updateDocument` |
| `deletePriceList` | Bulk action (§1.12), single-delete confirmation on detail page |
| `addPriceListItem` | Items grid add row (§1.4) |
| `updatePriceListItem` | Items grid row save |
| `removePriceListItem` | Items grid row remove |
| `assignPriceListToChannel` | Share dialog (§1.5) |
| `removePriceListFromChannel` | "Stop sharing" per-row action |
| `setPriceListAssignedToEveryone` | Access block toggle (§1.6) |
| `addCustomersToPriceList` / `removeCustomersFromPriceList` | Access block customer picker |
| `addCustomerGroupsToPriceList` / `removeCustomerGroupsFromPriceList` | Access block customer-group picker |
| `createPriceListGroup` | Group detail page create flow |
| `updatePriceListGroup` | Group detail page update |
| `deletePriceListGroup` | Group list page row action |
| `setDefaultPriceListGroup` | Group list page "Set as default" action |

## 4. Anti-patterns to avoid (from `.claude/coderules/02-vendure-design-system.md`)

Re-stated explicitly because the lead's review flagged each of these
before:

1. **No raw `<table>` / `<button>` / `<dl>`** — use `Table` / `Button` /
   `Card` from `@/vdb/components/ui/...`.
2. **No `text-red-600` etc.** — use semantic tokens (`text-destructive`,
   `text-muted-foreground`).
3. **No manual money formatting** — `<Money>` from `data-display`.
4. **No custom dialog implementations** — use `Dialog` / `AlertDialog`.
5. **No `useState`-only form state** — wire forms through
   `DetailPage` (uses React Hook Form internally) or the `Form`
   primitive.
6. **No imports from `@vendure/dashboard`** for things that have a
   `@/vdb/...` alias.
7. **No inline strings** in user-facing text — every one goes through
   `` t`...` ``.

## 5. Behavior on non-origin channels

The service layer rejects edits when `ctx.channelId !== pl.originChannelId`.
The UI mirrors this:

- `ReadOnlyBanner` shows at the top of the detail page (§1.7).
- All form inputs and action buttons are `disabled={!isEditable}`.
- The "Share to channel" action button is hidden (only origin can share).
- The list page badges shared rows with a `Badge variant="secondary"` "Shared".
- Bulk actions on shared rows are filtered out before submission.

The guard is enforced at three levels: DB (read-only data), service
(throws `IllegalOperationError`), UI (disables controls). The two
upper layers exist to give a clean UX; the DB/service guard is the
source of truth.

---

## 6. Acceptance criteria — `PLAN-STAGE-1.md` §2.7 doable from dashboard

The 13-step manual test script from Stage 1 §2.7 is the gold standard.
After this batch, every step is doable **without GraphiQL**.

| Step | Dashboard mechanism after this batch |
| --- | --- |
| 1. Group CRUD on default-channel | Group list page + DetailPage forms + "Set as default" action |
| 2. PriceList creation in origin channel | List page "New Pricelist" → DetailPage form |
| 3. Add items (ABSOLUTE + PERCENTAGE) | Items grid (§1.4) with PercentageInput |
| 4. Global assignment | Access block toggle "Available to everyone" (§1.6) |
| 5. Customer assignment | Access block CustomerSelector |
| 6. Customer-group assignment | Access block CustomerGroupSelector |
| 7. ~~Group-level assignment~~ | **Dropped per batch-2 lead direction** — groups carry no scope. Strike from acceptance criteria. |
| 8. Channel share | "Share to channel" action → ShareToChannelDialog (§1.5) |
| 9. Variant not in target channel | Items grid renders the row greyed with a warning when `variant.channels` doesn't include `pl.channels` ∩ target |
| 10. Stop sharing | "Unshare" per-row action on channel memberships block |
| 11. Cross-channel group rejection | Surfaced as inline error in ShareToChannelDialog when service rejects |
| 12. Overlapping validity | Just two pricelists created via the create flow; no special UI |
| 13. Soft delete | Delete button on detail page action bar (single) + bulk action on list page (multi) |

Step 7 (group-level assignment) is **removed** from the manual test
script — `PLAN-STAGE-1.md` §2.7 should be amended in the next plan-doc
pass to reflect this.

---

## 7. What this batch does NOT include

- **Provenance display on order line detail** — that's Stage 3 (admin
  cart/order detail shows "price came from list X"). Lives there
  because it requires the lookup output from Stage 2.
- **Strike-through pricing in the Shop API** — Stage 3.
- **Bulk import (CSV) of pricelist items** — meta-plan §0.2.11
  explicitly v2.
- **Audit trail** — meta-plan §0.2.11 explicitly out of scope.
- **Group reordering / drag-handle priority editing** — `priority`
  remains a free-text int input. If the lead wants reordering UX,
  that's a follow-up batch with `@dnd-kit`.
- **Variant search with channel-scoped autocomplete** — the
  `ProductVariantSelector` already searches across the active channel;
  no extra work needed.
- **Restoring a soft-deleted list** — a "restore" mutation would
  reverse `deletedAt = NULL`, but the backend doesn't expose it yet.
  Could be a one-line service method + mutation if needed. Not in this
  batch.

---

## 8. Open questions for the human before execution

1. **Inline-edit pattern for the items grid** (§1.4.1) — Option A
   (per-row Edit toggle) or B (per-cell on-click)? Recommended A.
2. **Item bulk actions on the items grid?** E.g. bulk-update a column
   like `stepQuantity` across many rows. The plan today has only
   per-row edit. If the lead wants bulk, that's worth flagging.
3. **Channel switcher discipline.** When a user lands on the detail
   page for a shared list, do we auto-switch their active channel to
   the origin? Or just show the banner? Recommend the banner only —
   auto-switching is surprising.
4. **Variant-not-in-channel rendering** (acceptance step 9) — Items
   grid shows a greyed row with a warning. Or hide it entirely.
   Recommend greyed-with-warning (visible feedback that the item
   exists but won't price for this channel's customers).

## 9. Execution order (when approved)

Single long working pass, batched into checkpoints:

1. New gql file (`mutations.ts`) + types extension
2. `PercentageInput` + `ReadOnlyBanner` + `useIsEditable` (primitives
   that other components depend on)
3. `PriceListItemsGrid` (the centerpiece, longest single file)
4. `ShareToChannelDialog` + `PriceListAccessBlock` +
   `DeletePriceListBulkAction`
5. Page migrations: `ListPage`/`DetailPage` for both pairs (4 files)
6. `npm run translation` to extract new strings
7. Compile check on both tsconfigs + visual smoke against the running
   dashboard

Estimated session length similar to lead-review batch 2.

## 10. Stage 1 doc update after this batch lands

`PLAN-STAGE-1.md` "Implementation status" section gets a new entry
"Stage 1B — editor UIs (2026-MM-DD)" with the file inventory, count of
new strings extracted, and "Stage 1 dashboard surface complete: §2.7
manual test fully dashboard-doable" tick.
