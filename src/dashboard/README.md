# Pricelist dashboard extension — Stage 1 status

This directory contains the dashboard extension registered via the
`dashboard: './dashboard/index.tsx'` slot on `PricelistPlugin`.

## What ships in Stage 1 (this checkpoint)

- **Nav section "Pricing"** in the sidebar with two entries: Pricelists,
  Groups.
- **4 routes** wired to React components:
  - `/pricelists` — table listing all lists in the current channel.
  - `/pricelists/$id` — detail view: summary, items, channel
    memberships, assignments.
  - `/pricelist-groups` — table listing groups in the current channel.
  - `/pricelist-groups/$id` — detail view: summary.
- **GraphQL queries** in `gql/queries.ts` consumed by all four pages
  via TanStack Query + the dashboard's `api.query` helper.

All four pages render real backend data via the Admin GraphQL surface
defined in `src/plugins/pricelist/api/`. Pages are **read-only**.

## What is intentionally NOT in Stage 1

The following pieces of UI are deferred — the plan listed them in
PLAN-STAGE-1 §1.1 Q9 but Stage 1's shipping bar is "manual testing
through the Admin API". UI editors are a follow-up implementation
batch.

| UI piece | Where the back end is ready | What's missing in the dashboard |
| --- | --- | --- |
| Create / edit pricelist form | `createPriceList`, `updatePriceList` mutations | Form component |
| `PriceListItemsGrid` (add/edit items) | `addPriceListItem`, `updatePriceListItem`, `removePriceListItem` | Variant picker, currency dropdown, valueType toggle, bp → % conversion |
| `PriceListAssignmentsPanel` (assign global/customer/group) | `createPriceListAssignment`, `removePriceListAssignment` | Three-tab UI with target pickers |
| `ShareToChannelDialog` | `assignPriceListToChannel`, `removePriceListFromChannel` | Channel + group select dialog |
| Group CRUD form | `createPriceListGroup`, `updatePriceListGroup`, `deletePriceListGroup`, `setDefaultPriceListGroup` | Form + "Make default" action |
| `ReadOnlyBanner` / shared-row badges | Service-layer guard already rejects non-origin edits | Visual indicator + button-disabling logic |
| `PercentageValueInput` with worked-example tooltip | — | The component itself |

## Manual testing today

Until the editor UIs land, the plan's manual test script
(PLAN-STAGE-1 §2.7) is executed against the Admin API via
GraphQL Playground or `gh graphql`. The dashboard pages above can be
used to **verify** the resulting DB state visually.

Example creation via GraphQL Playground (logged in as superadmin):

```graphql
mutation {
    createPriceList(input: {
        code: "STANDARD-EUR"
        name: "Standard EUR"
        priority: 0
    }) {
        id code name
    }
}
```

Then navigate to `/pricelists` in the dashboard — the new list should
appear in the table.
