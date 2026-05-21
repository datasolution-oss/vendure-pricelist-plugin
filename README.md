# @datasolution/vendure-plugin-keycloak

Keycloak OAuth 2.0 authentication plugin for [Vendure](https://www.vendure.io/).

Provides Keycloak-based authentication for both the Shop and Admin APIs using
the OAuth 2.0 authorization code flow, with automatic user linking by email and
GraphQL queries to retrieve the authorization URLs.

---

## Installation (published version)

Install the plugin from the internal Artifactory registry as a regular npm
dependency on your Vendure project:

```bash
npm install @datasolution/vendure-plugin-keycloak
```

### Required peer dependencies

This plugin declares the following `peerDependencies` that **must** be
installed on the host Vendure project:

- `@vendure/core` `^3.6.0` — already present in any Vendure project.
- `jose` `^6.1.3` — **must be installed explicitly** on the main project:

```bash
npm install jose@^6.1.3
```

Without `jose`, token verification will fail at runtime.

### Register the plugin

```ts
import { VendureConfig } from '@vendure/core';
import { KeycloakPlugin } from '@datasolution/vendure-plugin-keycloak';

export const config: VendureConfig = {
  // ...
  plugins: [
    KeycloakPlugin.init({
      serverUrl: 'https://keycloak.example.com',
      realm: 'my-realm',
      adminClient: {
        clientId: 'vendure-admin',
        clientSecret: 'admin-secret',
        redirectUri: 'http://localhost:3000/admin',
      },
      // Optional — falls back to `adminClient` if omitted
      shopClient: {
        clientId: 'vendure-shop',
        clientSecret: 'shop-secret',
        redirectUri: 'http://localhost:4000/shop',
      },
    }),
  ],
};
```

Options are documented in `src/keycloak/types.ts` (`KeycloakPluginOptions`).

---

## Dev mode on a Vendure project

The main Vendure project supports a per-developer "dev mode" that pulls this
plugin's `src/` into `src/plugins/keycloak/` so you can edit it locally and
push the changes back to this repository — without ever committing plugin
sources to the main project.

### First activation (registry not yet populated)

```bash
npm run plugin:dev:on -- keycloak \
  --repo https://gitlab.datasolution.fr/datasolution/vendure/plugins/keycloak.git \
  --package @datasolution/vendure-plugin-keycloak
```

Add `--branch develop` (or any other branch) if you don't want the repo's
default branch.

### Subsequent activations

Once the plugin is registered in `.vendure/plugins-registry.json`, a short
command is enough:

```bash
npm run plugin:dev:on -- keycloak [--branch <branch>]
```

### Typical workflow

```bash
# 1. Activate dev mode
npm run plugin:dev:on -- keycloak

# 2. Edit files under src/plugins/keycloak/src/…

# 3. Push local src/ changes back to this plugin repo
npm run plugin:dev:push -- keycloak -m "fix: handle expired token"

# 4. Pull latest upstream src/ into the active dev-mode plugin
npm run plugin:dev:pull -- keycloak [--force]

# 5. List plugins currently in dev mode
npm run plugin:dev:list

# 6. Deactivate: restore the published version and remove the local src/
npm run plugin:dev:off -- keycloak [--force]

# 7. Bump the plugin version in package.json and commit on the main project
git commit -am "chore: bump keycloak plugin"
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
└── src/
    └── keycloak/         # plugin source (rsynced into the main project)
        ├── api/
        ├── dashboard/
        ├── services/
        ├── strategies/
        ├── constants.ts
        ├── keycloak.plugin.ts
        └── types.ts
```

The `src/` folder is what gets rsynced locally; `package.json` is read to
generate a minimal synthetic `src/plugins/keycloak/package.json` so that
`npm install file:./src/plugins/keycloak` resolves correctly on the main
project.

`@vendure/core` and `jose` are declared as `peerDependencies` to avoid
duplicate copies in the main project's `node_modules`.

---

