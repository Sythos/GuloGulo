# Server TypeScript boundary

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

The server side of Gulo Gulo is authored in TypeScript. The browser remains
the separate HTML5 and TypeScript client, while this document covers the
Node.js HTTP runtime and the LP2 identity, state, authentication, and admin
boundaries.

## The useful commands

From the repository checkout:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck:server
npm run build:server
npm run test:server
npm run test:m6
npm run test:lp2
```

`build:server` writes generated JavaScript and declarations below
`dist/server/`. That directory is build output and is deliberately ignored by
Git. The production Docker image performs this build before development
dependencies are pruned, then starts the compiled runtime with:

```text
node dist/server/src/runtime/index.js
```

The image therefore does not need the TypeScript compiler at runtime.

## Compiler boundary

[`tsconfig.server.json`](../tsconfig.server.json) uses Node's native ESM
resolution, `strict: true`, declaration output, and relative import rewriting.
The LP2 source areas currently covered by the server build are:

- `src/runtime/` and `src/foundation/`;
- `src/integrations/` for tenant context, LDAP, PostgreSQL, and migrations;
- `src/auth/` for password, TOTP, WebAuthn, and recovery contracts;
- `src/admin/` for RBAC, delegation, quota, and metadata-only admin tools.

The compiled runtime tests execute from `dist/server`. The LP2 contract tests
also run directly from TypeScript with Node 26's
`--experimental-strip-types`, which keeps fixtures deterministic without
adding a second application runtime. The typecheck and build remain mandatory
CI gates in both commit and pull-request workflows.

LP8 extends the same boundary to the release validators and LP0–LP3 audit and
smoke scripts. The canonical files are now `.ts` and are executed with
`node --experimental-strip-types`; package scripts and the quality workflow
use those paths directly. Their old `.mjs` names remain as behavior-free
compatibility bridges for one transition window. The complete bridge list and
the LP9 cleanup owner are recorded in the LP8 evidence bundle.

## Temporary compatibility bridges

Some mail and legacy runtime consumers are still JavaScript until their own
recovery milestone. Small `.mjs` bridge files remain only where an older
consumer still imports the moved module. A bridge contains no business logic:
it re-exports the TypeScript implementation or the compiled JavaScript output.
The LP2 bridge is `src/integrations/tenant-context.mjs`; the runtime bridges
are in `src/runtime/`.

When a later milestone migrates a remaining consumer, remove its bridge in the
same change and update the affected test and documentation entry points. Do
not add new product behavior to a bridge.

## Runtime and dependency notes

Node.js 26 is the supported runtime for the current checkout. `@types/node`
and TypeScript are locked in `package-lock.json`; normal dependency updates
must use the latest stable releases and rerun the complete package test suite.
The browser output remains generated JavaScript, and shell, PowerShell, SQL,
HTML, CSS, and JSON are not counted as server application-language debt.

All TypeScript modules retain the repository's MIT SPDX header and Sythos
attribution. Secrets, mailbox content, session material, and private keys do
not belong in source, test fixtures, or generated proof output.
