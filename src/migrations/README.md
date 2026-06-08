# Pricelist plugin — migration procedure

The entity definitions in `src/plugins/pricelist/entities/` are not yet
reflected in the database. This document explains how to generate the
migration **and which manual additions are required after generation**.

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
