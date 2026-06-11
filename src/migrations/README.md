# Pricelist plugin — migration procedure

The entity definitions in `src/plugins/pricelist/entities/` are not yet
reflected in the database. This document explains how to generate the
migration **and which manual additions are required after generation**.

> **PLAN-STAGE-1F readers:** the channel/group/access rework has its own
> generate-then-edit procedure at the bottom of this file —
> see **"Migration: ReworkPricelistChannelModel"**. The section
> immediately below is the original Stage-1 `AddPricelistPlugin`
> migration, kept for history.

## 1. Generate the migration

With the dev Postgres running (see `README.md` in the repo root) and
`PricelistPlugin.init({})` already registered in
`src/vendure-config.ts:163` (it is, as of Stage 1):

```bash
npm run migrate
# When prompted: name the migration "AddPricelistPlugin"
```

This will produce a new file under `src/migrations/`,
e.g. `<timestamp>-AddPricelistPlugin.ts`, containing `CREATE TABLE`
statements for the 5 plugin entities, all FK constraints, and TypeORM's
deterministically-named indexes.

## 2. Manual additions to the generated migration

Open the generated migration. **In the `up()` method, AFTER all
`CREATE TABLE` and `ALTER TABLE` lines**, append:

```ts
// Partial unique index — TypeORM cannot generate WHERE clauses on uniques.
// Enforces "exactly one default group per channel" (PLAN-STAGE-1 §1.1 Q6c).
await queryRunner.query(`
    CREATE UNIQUE INDEX "uq_price_list_group_default_per_channel"
        ON "price_list_group" ("channelId") WHERE "isDefault" = true
`);

// Backfill default groups for existing channels (idempotent — INSERT WHERE NOT EXISTS).
// New channels created after this migration will get their default group via
// the ChannelEvent('created') subscriber in PriceListGroupService.
await queryRunner.query(`
    INSERT INTO "price_list_group"
        ("createdAt", "updatedAt", "code", "name", "priority", "isDefault", "channelId")
    SELECT NOW(), NOW(), 'default', 'Default', 0, true, c.id
    FROM "channel" c
    WHERE NOT EXISTS (
        SELECT 1 FROM "price_list_group" g
        WHERE g."channelId" = c.id AND g."isDefault" = true
    )
`);
```

**In the `down()` method, BEFORE the `DROP TABLE` for `price_list_group`**,
prepend:

```ts
await queryRunner.query(`DROP INDEX IF EXISTS "uq_price_list_group_default_per_channel"`);
```

(The default-group rows are removed by the subsequent
`DROP TABLE "price_list_group"`, so no separate cleanup is needed.)

## 3. Apply

```bash
npm run migrate
# When prompted: select "Run pending migrations"
```

## 4. Smoke check

After migration, verify in psql:

```sql
\dt price_list*
-- Should list: price_list, price_list_item, price_list_group,
--              price_list_channel, price_list_assignment

SELECT code, name, "isDefault", "channelId" FROM price_list_group;
-- Each existing channel should appear with code='default', isDefault=true.
```

## SQLite note (for e2e tests, Stage 4)

The partial unique index uses Postgres syntax. SQLite ≥3.8.0 supports
partial unique indexes via the same `WHERE` clause syntax. If e2e tests
later fail on the SQLite test DB with the index DDL, the migration must
be split per-dialect using `queryRunner.connection.options.type` as the
discriminator. Flagged in PLAN-STAGE-4 §Q2 as the highest-risk dialect
divergence.

---

# Migration: ReworkPricelistChannelModel (PLAN-STAGE-1F)

This migration moves the channel/group/access model to the idiomatic
shape: groups become `ChannelAware`, the per-channel default group is
stored channel-side, group memberships gain an explicit `channelId`, and
customer access becomes per `(PriceList, Channel)`.

## 1. Generate the schema diff

With the dev Postgres running and the new entities in place:

```bash
npm run migrate
# name it "ReworkPricelistChannelModel"
```

TypeORM will emit, in `up()`, the schema changes for the new shape:

- **CREATE TABLE** `price_list_group_channels_channel` — the new
  ChannelAware M2M join for `PriceListGroup.channels`
  (columns `priceListGroupId`, `channelId`).
- **CREATE TABLE** `price_list_channel_default_group`
  (`channelId`, `groupId`, unique on `channelId`).
- **CREATE TABLE** `price_list_channel_access`
  (`priceListId`, `channelId`, `assignedToEveryone`, unique on
  `(priceListId, channelId)`) plus its two M2M joins, whose names +
  columns are **pinned** via `@JoinTable` on the entity:
  `price_list_channel_access_customer` (`accessId`, `customerId`) and
  `price_list_channel_access_customer_group` (`accessId`, `customerGroupId`).
- **ALTER TABLE** `price_list_group_membership` **ADD** `channelId`
  (+ FK + `UNIQUE(priceListId, channelId)`).
- **DROP** `price_list_group.isDefault`, `price_list_group.channelId`,
  the `uq_price_list_group_default_per_channel` partial index, and
  `price_list.assignedToEveryone`; **DROP TABLE**
  `price_list_assigned_customers_customer` and
  `price_list_assigned_customer_groups_customer_group`.

## 2. CRITICAL — reorder + insert backfill

TypeORM generates DROPs and CREATEs with **no data migration**. You MUST
move every DROP of an old column/table to the **end** of `up()`, and
insert the backfill below **after** the CREATEs but **before** those
DROPs. Otherwise the source data is gone before it is copied.

Exact table/column identifiers must match the generated file — verify
each against your generated migration before running (TODO markers
below flag the ones to double-check).

```ts
// --- after CREATE TABLEs, before any DROP ---

// (a) Groups -> ChannelAware join: one row per group's former channel.
await queryRunner.query(`
    INSERT INTO "price_list_group_channels_channel" ("priceListGroupId", "channelId")
    SELECT id, "channelId" FROM "price_list_group"
`);

// (b) Default group per channel -> channel-side mapping.
await queryRunner.query(`
    INSERT INTO "price_list_channel_default_group"
        ("createdAt", "updatedAt", "channelId", "groupId")
    SELECT NOW(), NOW(), "channelId", id
    FROM "price_list_group" WHERE "isDefault" = true
`);

// (c) Membership.channelId <- its group's former channel.
await queryRunner.query(`
    UPDATE "price_list_group_membership" m
    SET "channelId" = g."channelId"
    FROM "price_list_group" g
    WHERE m."groupId" = g.id
`);

// (d) Per-channel access rows: one per (list, channel) it participates in,
//     copying the old GLOBAL assignedToEveryone to every channel.
await queryRunner.query(`
    INSERT INTO "price_list_channel_access"
        ("createdAt", "updatedAt", "priceListId", "channelId", "assignedToEveryone")
    SELECT NOW(), NOW(), plc."priceListId", plc."channelId", pl."assignedToEveryone"
    FROM "price_list_channels_channel" plc          -- TODO: confirm PriceList.channels join table name
    JOIN "price_list" pl ON pl.id = plc."priceListId"
`);

// (e) Replicate the old GLOBAL customer/group assignments to EVERY
//     per-channel access row of the list. (Global -> widened per channel.)
await queryRunner.query(`
    INSERT INTO "price_list_channel_access_customer" ("accessId", "customerId")
    SELECT a.id, pac."customerId"
    FROM "price_list_channel_access" a
    JOIN "price_list_assigned_customers_customer" pac
        ON pac."priceListId" = a."priceListId"
`);
await queryRunner.query(`
    INSERT INTO "price_list_channel_access_customer_group" ("accessId", "customerGroupId")
    SELECT a.id, pacg."customerGroupId"
    FROM "price_list_channel_access" a
    JOIN "price_list_assigned_customer_groups_customer_group" pacg
        ON pacg."priceListId" = a."priceListId"
`);

// --- THEN the moved DROPs (old columns, old M2M tables, partial index) ---
```

## 3. `down()`

Reverse order: re-add the dropped columns/tables, then collapse the
per-channel data back to global. Collapsing is **lossy** when channels
diverged after the upgrade (different customers per channel) — document
that the down path keeps an arbitrary channel's set. For a dev/test DB
the simplest acceptable `down()` re-adds the columns empty and relies on
re-running `up()` to repopulate; flag this in the migration file.

## 4. Apply + smoke check

```bash
npm run migrate   # run pending
```

```sql
-- every existing channel still has exactly one default group:
SELECT "channelId", COUNT(*) FROM price_list_channel_default_group GROUP BY "channelId";
-- memberships carry a channelId:
SELECT COUNT(*) FROM price_list_group_membership WHERE "channelId" IS NULL;  -- expect 0
-- access rows exist for shared lists:
SELECT "priceListId", "channelId", "assignedToEveryone" FROM price_list_channel_access;
```

## SQLite (e2e)

The e2e DB is created from entity metadata (synchronize), so it gets the
new shape directly and does NOT run this migration — no backfill needed
there (tests build their own data). Only the Postgres dev/prod path uses
this file.
