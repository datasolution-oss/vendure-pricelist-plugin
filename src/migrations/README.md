# Pricelist plugin — migration procedure

Migrations are **owned by the host app**, not this plugin package. A
TypeORM migration is a diff of the *whole* schema (Vendure core + every
plugin), so it cannot live inside a single plugin. The plugin ships only
this guide; the generated migration file lives in the host app under
`src/migrations/`.

As of the channel rework there is **one** pricelist migration that
creates the final schema directly (host app:
`src/migrations/<timestamp>-PricelistPlugin.ts`). The earlier
two-step history (`AddPricelistPlugin` + `ReworkPricelistChannelModel`)
was collapsed into it — nothing was deployed with the intermediate
schema, so there was no reason to ship a rework-on-top migration.

## Final schema (what the migration creates)

- `price_list`, `price_list_translation`
- `price_list_item`
- `price_list_group`, `price_list_group_translation` — the group is
  **ChannelAware** (no `channelId`/`isDefault` column); its channel
  assignment lives in the M2M join `price_list_group_channels_channel`.
- `price_list_group_membership` — per-channel binding
  `(priceListId, channelId, groupId)` with `UNIQUE(priceListId, channelId)`.
- `price_list_channel_default_group` — channel-side default-group
  mapping, `UNIQUE(channelId)` (replaces the old per-channel `isDefault`
  flag + partial unique index).
- `price_list_channel_access` — per `(PriceList, Channel)` access
  (`assignedToEveryone`), `UNIQUE(priceListId, channelId)`, plus its two
  M2M joins `price_list_channel_access_customer` and
  `price_list_channel_access_customer_group`.
- `price_list_channels_channel` — standard `PriceList.channels`
  ChannelAware join.

No manual additions are needed: every UNIQUE/index is declared on the
entities, so a clean `generateMigration` reproduces them.

**Default groups are NOT seeded by the migration.** They are created at
runtime by `PriceListGroupService`: a `ChannelEvent('created')`
subscriber materialises the default group for new channels, and an
`onApplicationBootstrap` backfill covers channels that predate the
plugin. Both go through `PriceListChannelDefaultGroup`, idempotently.

## Apply

```bash
npm run migrate   # run pending migrations
```

## Regenerating from scratch (only if the entities change)

`generateMigration` diffs the entities against the live DB, so the
pricelist tables must be absent for it to re-emit the full create. With
the dev Postgres running:

1. Stop the dev server.
2. Delete the existing pricelist migration file(s) from the host app's
   `src/migrations/` (otherwise `generateMigration` refuses, seeing an
   un-run migration).
3. Drop the pricelist tables and purge their rows from the `migrations`
   table:
   ```sql
   DROP TABLE IF EXISTS
     price_list_channel_access_customer, price_list_channel_access_customer_group,
     price_list_channel_access, price_list_channel_default_group,
     price_list_group_channels_channel, price_list_channels_channel,
     price_list_group_membership, price_list_item, price_list_translation,
     price_list_group_translation, price_list_group, price_list CASCADE;
   DELETE FROM "migrations" WHERE "name" ILIKE '%ricelist%';
   ```
4. Generate + apply (programmatic, non-interactive):
   ```ts
   import { generateMigration, runMigrations } from '@vendure/core';
   import { config } from '../src/vendure-config';
   await generateMigration(config, { name: 'PricelistPlugin', outputDir: 'src/migrations' });
   await runMigrations(config);
   ```
   Run with `ts-node -r tsconfig-paths/register` and the DB env sourced
   from `.env`.

## SQLite (e2e)

The e2e DB is built from entity metadata (`synchronize`), so it gets the
final shape directly and does **not** run this migration — tests build
their own data. Only the Postgres dev/prod path uses the migration file.
