# PLAN-STAGE-1F — Lead-review redesign: ChannelAware groups, per-channel access, granular permissions

**Date:** 2026-06-11
**Status:** PROPOSED — awaiting implementation
**Supersedes:** PLAN-STAGE-1 §Q5 (channel sharing), §Q6 (group scoping),
§Q7 (permissions), and the "flatten assignments" decision from the
2026-05-28 lead-review batch 2.

> This revision reworks the channel/group/access model following the
> second lead review. The data currently on `develop` works and is
> channel-isolated, but it is **non-idiomatic** to Vendure and bakes
> three concerns into shapes that don't extend cleanly. This plan brings
> the model in line with Vendure conventions and the agreed product
> behaviour.

---

## 1. Why (lead feedback, condensed)

1. **Groups are not `ChannelAware`.** Every channel-scoped entity in
   Vendure core (16 of them: Product, Collection, Customer, Promotion,
   StockLocation, …) is `ChannelAware` (ManyToMany `channels`). **Zero**
   core entities model channel ownership as a single `ManyToOne(Channel)`.
   Our `PriceListGroup` uses `ManyToOne(Channel)` + manual `channelId`
   filtering — correct today, but the isolation rests on developer
   discipline, not the framework.
2. **`isDefault` on the group is the real root cause.** Vendure stores
   "default-per-channel" on the *channel side* (`Channel.defaultTaxZone`,
   `Channel.defaultShippingZone` → FK to a shared, ChannelAware `Zone`).
   A boolean flag on a shared entity cannot express "default on A, not on
   B". This flag is what forces the `ManyToOne`.
3. **Customer access should be per `(PriceList, Channel)`**, not global on
   the PriceList. A list shared to A and B may grant different customers
   on each channel.
4. **Permissions, not roles.** Authorization must emerge from
   permissions + channel scope, not a hardcoded role ladder. The
   permission set must surface in the dashboard role form
   (`roles/new`, `roles/:id`).
5. **`PriceListGroupMembership` carries both `group` and `groupId`** —
   this is the idiomatic TypeORM relation+FK pattern (lets us set/read the
   FK without loading the relation, and avoids the `save()`-rewrites-FK
   pitfall). **Kept as-is.** Not a problem.
6. **SQL vs ORM at volume** — the admin aggregate query
   (`findVariantSummariesForList`) already pushes counts to SQL
   (`COUNT(DISTINCT)`, `GROUP BY`, paginated, bulk cell/variant fetch, no
   N+1). The hot path is the Stage-2 lookup (separate branch). No admin
   change needed here beyond what this plan touches.

---

## 2. Locked decisions (from discussion 2026-06-11)

| # | Decision |
|---|---|
| D1 | `PriceListGroup` becomes **ChannelAware** (ManyToMany `channels`). Default behaviour = each group assigned to exactly **one** channel (its creating channel), so user-facing behaviour is unchanged. Door open to multi-channel group sharing later, no schema change required. |
| D2 | `isDefault` **removed** from the group. "Default group per channel" stored on the **channel side** via a dedicated mapping entity `PriceListChannelDefaultGroup (channelId → groupId)`. |
| D3 | `PriceListGroupMembership` gains an explicit **`channelId`** column. A binding is now `(priceList, channel, group)`. `UNIQUE(priceListId, channelId)` — one group per channel for a given list. |
| D4 | Customer access becomes **per `(PriceList, Channel)`**. Replaces the global `assignedCustomers` / `assignedCustomerGroups` ManyToMany and the global `assignedToEveryone` column. `assignedToEveryone` is **per channel** too. |
| D5 | **Two authorization guards** (see §5): *content edits* are origin-channel-only; *channel-local actions* (group binding, access management) are allowed on any channel the list is shared to, gated by the permission **on that channel**. |
| D6 | Sharing a list to a channel: target **group optional** → falls back to the target channel's default group. |
| D7 | Un-sharing: allowed from **both** origin and the target channel admin (each can remove the list from their own channel). |
| D8 | **Granular permissions** that surface in `roles/new` (see §4). |

---

## 3. Entity model — before / after

### 3.1 `PriceListGroup` — becomes ChannelAware, loses `isDefault`

```ts
@Entity()
export class PriceListGroup
    extends VendureEntity
    implements ChannelAware, Translatable, HasCustomFields
{
    @Column() code: string;
    name: LocaleString;
    @Column({ default: 0 }) priority: number;

    // REMOVED: channel: ManyToOne, channelId: Column, isDefault: Column
    // ADDED:
    @ManyToMany(() => Channel) @JoinTable()
    channels: Channel[];

    @OneToMany(() => PriceListGroupTranslation, t => t.base, { eager: true })
    translations: Array<Translation<PriceListGroup>>;

    @Column({ type: 'simple-json', default: '{}' })
    customFields: { [key: string]: any } = {};
}
```

### 3.2 `PriceListChannelDefaultGroup` (NEW) — default group per channel

```ts
@Entity()
@Unique(['channelId']) // exactly one default group per channel
export class PriceListChannelDefaultGroup extends VendureEntity {
    @ManyToOne(() => Channel, { onDelete: 'CASCADE' }) channel: Channel;
    @Column() channelId: ID;
    @ManyToOne(() => PriceListGroup, { onDelete: 'CASCADE' }) group: PriceListGroup;
    @Column() groupId: ID;
}
```

> Rationale: mirrors `Channel.defaultTaxZone`. Keeps the group shareable
> while making "default" a channel-side fact. The unique-on-`channelId`
> replaces the old partial unique index.

### 3.3 `PriceListGroupMembership` — gains `channelId`

```ts
@Entity()
@Unique(['priceList', 'channel']) // one group per channel per list
export class PriceListGroupMembership extends VendureEntity {
    @ManyToOne(() => PriceList, l => l.groupMemberships, { onDelete: 'CASCADE' })
    priceList: PriceList;
    @Column() priceListId: ID;

    @ManyToOne(() => Channel, { onDelete: 'CASCADE' }) channel: Channel; // NEW
    @Column() channelId: ID;                                            // NEW

    @ManyToOne(() => PriceListGroup, { nullable: false, onDelete: 'RESTRICT' })
    group: PriceListGroup;
    @Column() groupId: ID;
}
```

> Service guard: on write, the bound `group` MUST be assigned to
> `channelId` (i.e. `group.channels` contains the channel). Cross-table
> consistency not expressible as a DB FK; checked in code (unchanged
> approach, just `group.channelId` → `group.channels` membership test).

### 3.4 `PriceList` — drop global access fields

```ts
// REMOVED from PriceList:
//   @ManyToMany(() => Customer) assignedCustomers
//   @ManyToMany(() => CustomerGroup) assignedCustomerGroups
//   @Column() assignedToEveryone
// KEPT: channels (ChannelAware), originChannel, items, groupMemberships, …
```

### 3.5 `PriceListChannelAccess` (NEW) — per-(list, channel) access scope

```ts
@Entity()
@Unique(['priceListId', 'channelId'])
export class PriceListChannelAccess extends VendureEntity {
    @ManyToOne(() => PriceList, { onDelete: 'CASCADE' }) priceList: PriceList;
    @Column() priceListId: ID;
    @ManyToOne(() => Channel, { onDelete: 'CASCADE' }) channel: Channel;
    @Column() channelId: ID;

    @Column({ default: false }) assignedToEveryone: boolean;  // per channel

    @ManyToMany(() => Customer) @JoinTable() customers: Customer[];
    @ManyToMany(() => CustomerGroup) @JoinTable() customerGroups: CustomerGroup[];
}
```

> One access row per channel the list participates in. Created lazily
> (first access mutation on that channel) or alongside the channel
> membership. Stage-2 lookup reads the row for the request's channel.

**Entity count:** was 6 → becomes 8 (`+PriceListChannelDefaultGroup`,
`+PriceListChannelAccess`; `PriceListGroup` reshaped; membership reshaped;
PriceList loses 2 relations + 1 column).

---

## 4. Permission model (surfaces in `roles/new`)

Custom permissions registered in `config.authOptions.customPermissions`
are rendered automatically by the dashboard role form, grouped by name.
We move from 2 CRUD bundles to a CRUD bundle + targeted action perms so a
role can grant exactly one capability.

```ts
// permissions.ts
export const priceListPermission       = new CrudPermissionDefinition('PriceList');
export const priceListGroupPermission  = new CrudPermissionDefinition('PriceListGroup');

// Targeted, channel-local actions — single PermissionDefinition each:
export const sharePriceListPermission  = new PermissionDefinition({
    name: 'SharePriceList',
    description: 'Allows sharing/un-sharing a PriceList to/from channels',
});
export const assignPriceListGroupPermission = new PermissionDefinition({
    name: 'AssignPriceListGroup',
    description: 'Allows binding a PriceList to a group within a channel',
});
export const managePriceListAccessPermission = new PermissionDefinition({
    name: 'ManagePriceListAccess',
    description: 'Allows managing customer/customer-group access for a PriceList on a channel',
});
```

Mapping of capability → permission → channel scope in §5. All five
appear in `roles/new` automatically; **dashboard verification step**:
confirm the three new permissions render with their descriptions in the
role permission grid (no custom React expected; if grouping is poor, add
a `PermissionDefinition` group label).

---

## 5. Authorization — the two guards

A "modification" is **not** one block. Two distinct gates:

| Capability | Permission | Channel checked | Origin-guarded? |
|---|---|---|---|
| Read a list | `ReadPriceList` | active (any channel it is shared to) | no |
| Edit **content** (code, prices/items, dates, valueType, priority) | `UpdatePriceList` | must be **origin** | **yes** |
| Create a list | `CreatePriceList` | active (becomes origin) | n/a |
| Delete a list | `DeletePriceList` | **origin** | **yes** |
| **Share** to channel C | `SharePriceList` | origin (push) | **yes** for share; un-share allowed from origin **or** C (D7) |
| **Bind to group** on channel C | `AssignPriceListGroup` | **channel C** | **no** (local to C) |
| Manage **access** on channel C | `ManagePriceListAccess` | **channel C** | **no** (local to C) |

Service helpers:
- `assertContentEditable(ctx, list)` — origin guard (existing
  `assertEditableList`, renamed/kept for content mutations only).
- `assertChannelLocalAction(ctx, list, channelId)` — asserts the list is
  shared to `channelId` and `ctx.channelId === channelId` (you act on the
  channel you are in). No origin requirement.

> The agreed product behaviour now **emerges** from permissions:
> a single-channel admin (e.g. US-only) holding `AssignPriceListGroup` +
> `ManagePriceListAccess` on US can re-bucket and set US customers for a
> list shared from FR, but cannot touch its prices (no `UpdatePriceList`
> on the origin). "Super-admin sets the group while sharing" = holds
> `SharePriceList` on origin **and** `AssignPriceListGroup` on target.

---

## 6. Service-layer changes

`PriceListGroupService`
- Replace `ManyToOne`/`channelId` scoping with **ChannelAware** scoping:
  `ListQueryBuilder.build(PriceListGroup, opts, { channelId: ctx.channelId })`
  (auto-joins the `channels` pivot), and
  `ChannelService.assignToChannels(PriceListGroup, id, [ctx.channelId])`
  on create.
- Drop `isDefault` reads/writes. Default resolution now via
  `PriceListChannelDefaultGroup`:
  - `findDefaultForChannel(ctx, channelId)` → join through the mapping.
  - `setDefault(ctx, channelId, groupId)` → upsert the mapping row
    (single row per channel, `UNIQUE(channelId)`).
  - `ensureDefaultGroup(ctx, channelId)` → create group (assigned to the
    channel) + mapping row if absent. Still idempotent; still driven by
    `ChannelEvent('created')` + bootstrap backfill.
- `delete()` guard: refuse if the group is the default for **any** channel
  (look up the mapping) instead of checking `isDefault`.

`PriceListService`
- Rename `assertEditableList` → `assertContentEditable` (content perms).
- Add `assertChannelLocalAction`.
- `assignPriceListToChannel(priceListId, channelId, groupId?)` — groupId
  optional (D6 → default). Adds the `channels` membership AND a
  `PriceListGroupMembership(priceList, channel, group)` AND lazily a
  `PriceListChannelAccess(priceList, channel)` row.
- `removePriceListFromChannel` — allowed from origin or target (D7);
  removes membership + access rows for that channel.
- `changePriceListGroup(priceListId, channelId, groupId)` — now a
  channel-local action (`assertChannelLocalAction`), repoints the
  membership for that channel.
- **Access methods become channel-scoped** — every signature gains
  `channelId`:
  `setAssignedToEveryone(ctx, priceListId, channelId, assigned)`,
  `addCustomers/removeCustomers(ctx, priceListId, channelId, ids)`,
  `add/removeCustomerGroups(...)`. All gated by
  `assertChannelLocalAction` + `ManagePriceListAccess`.

New `PriceListAccessService` (optional split) or fold into
`PriceListService` — TBD during impl; lean toward a dedicated service for
the `PriceListChannelAccess` lifecycle.

---

## 7. GraphQL / SDL changes (admin)

- `PriceList`:
  - remove inline-global access semantics; `assignedToEveryone` is no
    longer a bare field — exposed per channel.
  - add `channelAccess(channelId: ID!): PriceListChannelAccess` (or keep
    the paginated `priceListAssignedCustomers`/`...Groups` queries but add
    a **required `channelId`** arg).
- Mutations gain `channelId`:
  `setPriceListAssignedToEveryone(priceListId, channelId, assigned)`,
  `addCustomersToPriceList(priceListId, channelId, customerIds)`, etc.
- `assignPriceListToChannel` input: `groupId` becomes optional.
- `priceListGroupsByChannel` unchanged in signature; impl now queries via
  the `channels` pivot.
- New: `setDefaultPriceListGroup(channelId, groupId)` already exists —
  repoint to the mapping table.
- Permissions: annotate the new mutations with `@Allow(...)` for
  `SharePriceList` / `AssignPriceListGroup` / `ManagePriceListAccess`.

---

## 8. Migration strategy

Single migration `ReworkPricelistChannelModel`:

1. `CREATE TABLE price_list_group_channels_channel` (ManyToMany join).
2. `CREATE TABLE price_list_channel_default_group`.
3. `CREATE TABLE price_list_channel_access` (+ its two ManyToMany joins).
4. `ALTER TABLE price_list_group_membership ADD channelId` (+ FK + unique).
5. **Data backfill (in `up()`):**
   - For each existing group: insert a `*_channels_channel` row from its
     current `channelId`.
   - For each group with `isDefault = true`: insert a
     `price_list_channel_default_group(channelId, groupId)` row.
   - For each existing membership: set `channelId = (its group's old channelId)`.
   - For each PriceList with global access: create one
     `price_list_channel_access` per channel in the list's `channels`,
     copying `assignedToEveryone` and the customer/group assignments.
     (Global → replicated to every participating channel. Documented as a
     one-time widening; acceptable since today access is global anyway.)
6. Drop old columns/joins: `price_list_group.channelId`,
   `price_list_group.isDefault`, the partial unique index, and the
   `price_list_assigned_customers*` / `assignedToEveryone` artefacts.
7. `down()` reverses (re-add columns, collapse access back to global —
   lossy if multi-channel divergence occurred; documented).

SQLite (e2e) note from PLAN-STAGE-1 still applies — keep DDL dialect-safe.

---

## 9. Dashboard / UI changes

- **`roles/new` / role form**: verify the 3 new permissions render
  (automatic via `customPermissions`). Add a smoke note to the manual
  test script.
- **`price-list-detail.tsx`** (viewed on a non-origin channel):
  - `read-only-banner.tsx` → "Managed on <origin>. Read-only here."
  - Content fields (code, dates, items, valueType) **disabled**.
  - **Share / Delete** hidden on non-origin.
  - **Group selector** active if user holds `AssignPriceListGroup` on the
    active channel (channel-local).
  - **Access block** (`price-list-access-block.tsx`) becomes
    **channel-scoped**: it reads/writes access for the **active channel**
    only, active if user holds `ManagePriceListAccess` there. Add a small
    "Access for channel <code>" heading.
- **`price-list-list.tsx`**: "Shared from <origin>" badge on rows whose
  `originChannel !== active channel`.
- **`share-to-channel-dialog.tsx`**: destination group becomes optional
  (placeholder "Default group of <target>").

---

## 10. E2E impact (test/e2e-stage-1 branch)

Existing spec assertions to update:
- `createPriceList` default-group binding: membership now carries
  `channelId`; assert `groupMemberships[0].channel.id`.
- group default: assert via `PriceListChannelDefaultGroup` / the
  `priceListGroupsByChannel` + a `defaultGroupForChannel` query rather
  than `isDefault` on the group.
- access tests: add `channelId` arg to every access mutation/query.
- new tests: per-channel access isolation (assign customer on default
  channel only; second channel sees none), channel-local group change by
  a non-origin context, content-edit rejection on non-origin.

---

## 11. Implementation order (each step compiles + dev:push-able)

1. Entities (§3) + entity index + `ALL_ENTITIES`.
2. Migration (§8) — generate, hand-edit backfill, apply on dev DB.
3. Permissions (§4) + plugin registration.
4. Services (§6).
5. Resolvers + SDL (§7) + `admin-api.schema.ts` typings.
6. Dashboard (§9).
7. E2E spec update (§10) on `test/e2e-stage-1`.
8. Update `migrations/README.md` + this plan's status → IMPLEMENTED.

Push to a dedicated branch `feat/stage-1-channel-rework` (NOT develop) —
develop is in MR review; rebase order with `feat/stage-2-lookup` decided
after lead sign-off on this plan.

---

## 12. Open points for lead sign-off

- §3.5: per-channel access as a **row-per-channel** entity vs. adding
  `channelId` to existing assignment pivots — proposing the former
  (cleaner lifecycle). Confirm.
- §7: keep the paginated `priceListAssignedCustomers` queries (add
  required `channelId`) vs. a single `channelAccess(channelId)` resolver —
  proposing keep+`channelId` to preserve pagination. Confirm.
- §4: are `SharePriceList` / `AssignPriceListGroup` / `ManagePriceListAccess`
  the right granularity, or fold share+group into `UpdatePriceList`?
  Proposing the three explicit perms (they're what `roles/new` should
  expose). Confirm.
