# Development guide — @datasolution/vendure-plugin-pricelist

> **Internal document.** This guide targets contributors working on the plugin
> itself (dev mode, repo layout, push/pull workflow). For end-user installation,
> see [`README.md`](./README.md).

Pricelist plugin for [Vendure](https://www.vendure.io/).

---

## Installation (published version)

Install the plugin from the internal Artifactory registry as a regular npm
dependency on your Vendure project:

```bash
npm install @datasolution/vendure-plugin-pricelist
```

### Required peer dependencies

This plugin declares the following `peerDependencies` that **must** be
installed on the host Vendure project:

- `@vendure/core` `^3.6.0` — already present in any Vendure project.
- `@vendure/dashboard` `^3.6.0` — already present in any Vendure project
  using the dashboard.

### Register the plugin

```ts
import { VendureConfig } from '@vendure/core';
import { PricelistPlugin } from '@datasolution/vendure-plugin-pricelist';

export const config: VendureConfig = {
  // ...
  plugins: [
    PricelistPlugin.init({
      // Plugin options
    }),
  ],
};
```

Options are documented in `src/types.ts` (`PluginInitOptions`).

---

## Dev mode on a Vendure project

The main Vendure project supports a per-developer "dev mode" that pulls this
plugin's `src/` into `src/plugins/pricelist/` so you can edit it locally and
push the changes back to this repository — without ever committing plugin
sources to the main project.

### First activation (registry not yet populated)

```bash
npm run plugin:dev:on -- pricelist \
  --repo https://gitlab.datasolution.fr/datasolution/vendure/plugins/pricelist.git \
  --package @datasolution/vendure-plugin-pricelist
```

Add `--branch develop` (or any other branch) if you don't want the repo's
default branch.

### Subsequent activations

Once the plugin is registered in `.vendure/plugins-registry.json`, a short
command is enough:

```bash
npm run plugin:dev:on -- pricelist [--branch <branch>]
```

### Typical workflow

```bash
# 1. Activate dev mode
npm run plugin:dev:on -- pricelist

# 2. Edit files under src/plugins/pricelist/src/…

# 3. Push local src/ changes back to this plugin repo
npm run plugin:dev:push -- pricelist -m "fix: handle pricelist update"

# 4. Pull latest upstream src/ into the active dev-mode plugin
npm run plugin:dev:pull -- pricelist [--force]

# 5. List plugins currently in dev mode
npm run plugin:dev:list

# 6. Deactivate: restore the published version and remove the local src/
npm run plugin:dev:off -- pricelist [--force]

# 7. Bump the plugin version in package.json and commit on the main project
git commit -am "chore: bump pricelist plugin"
```

### Guard

A `.husky/pre-commit` hook on the main project refuses to commit while any
plugin is still in dev mode, or while `package.json` still references a plugin
as `file:./src/plugins/…`. Always run `plugin:dev:off` before committing on
the main project.

---

## Plugin repository layout

```
.
├── package.json          # name, version, main, peerDependencies
├── index.ts              # public entry point
└── src/
    ├── constants.ts
    ├── pricelist.plugin.ts
    └── types.ts
```

The `src/` folder is what gets rsynced locally; `package.json` is read to
generate a minimal synthetic `src/plugins/pricelist/package.json` so that
`npm install file:./src/plugins/pricelist` resolves correctly on the main
project.

`@vendure/core` and `@vendure/dashboard` are declared as
`peerDependencies` to avoid duplicate copies in the main project's
`node_modules`.

---
