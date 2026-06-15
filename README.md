# @datasolution/vendure-plugin-pricelist

A pricelist plugin for [Vendure](https://www.vendure.io/).

It adds price lists, price-list groups and channel-scoped access controls to the
Vendure Admin, including soft-delete with a configurable purge cron task and a
dashboard UI.

---

## Installation

```bash
npm install @datasolution/vendure-plugin-pricelist
```

### Peer dependencies

The plugin declares the following `peerDependencies`, which must already be
present on your Vendure project:

| Package              | Version   |
| -------------------- | --------- |
| `@vendure/core`      | `^3.6.0`  |
| `@vendure/dashboard` | `^3.6.0`  |

`@vendure/core` and `@vendure/dashboard` ship with any standard Vendure
project.

---

## Usage

### 1. Register the plugin

Add `PricelistPlugin` to the `plugins` array of your Vendure config:

```ts
import { VendureConfig } from '@vendure/core';
import { PricelistPlugin } from '@datasolution/vendure-plugin-pricelist';

export const config: VendureConfig = {
  // ...
  plugins: [
    PricelistPlugin.init({
      // options — see below
    }),
  ],
};
```

### 2. The dashboard UI

There is **nothing extra to set up** for the dashboard. The plugin ships a
dashboard extension declared through its `dashboard` slot, and the Vendure
dashboard Vite plugin discovers it automatically — simply registering
`PricelistPlugin.init({})` in `vendure-config.ts` (step 1) is enough.

Rebuild the dashboard and you will get a new **Pricing** section in the sidebar
with **Pricelists** and **Groups**.

> The UI honours Vendure permissions: menu entries are hidden from users without
> the corresponding read permission, and the Admin API is independently guarded.

### 3. Run a database migration

The plugin adds new entities and custom fields. Generate and run a migration as
you would for any Vendure plugin change:

```bash
npx vendure migrate
```

---

## Configuration

All `init()` options are optional and have sensible defaults.

| Option                          | Type                                              | Default                       | Description                                                                                          |
| ------------------------------- | ------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `purgePendingDeletionAfterMs`   | `number`                                          | `3_600_000` (1 hour)          | Grace period between a user-initiated delete and irreversible purge by the cron task.               |
| `purgePendingDeletionSchedule`  | `string \| ((cron) => string) \| null`            | `cron => cron.every(15).minutes()` | Cron schedule for the purge task. Set to `null` to disable the task entirely.                  |
| `purgePendingDeletionBatchSize` | `number`                                          | `100`                         | Max number of pricelists hard-deleted per cron tick, keeping each transaction bounded.              |

Example:

```ts
PricelistPlugin.init({
  purgePendingDeletionAfterMs: 24 * 60 * 60 * 1000, // 24 hours
  purgePendingDeletionSchedule: cron => cron.every(1).hours(),
  purgePendingDeletionBatchSize: 50,
});
```

---

## Compatibility

| Plugin | Vendure  |
| ------ | -------- |
| `0.7.x`| `^3.6.0` |

---

## License

[MIT](./LICENSE.md)

---

## Contributing

Source code and contribution guidelines live at
[github.com/datasolution-oss/vendure-pricelist-plugin](https://github.com/datasolution-oss/vendure-pricelist-plugin).
See [`DEVELOPMENT.md`](./DEVELOPMENT.md) for the contributor workflow.
