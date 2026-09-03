# Upgrade and migration operations

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This is the operator manual for upgrading an existing Gulo Gulo install in
place. Since [ADR-002](adr/ADR-002-gulogulo-packaging-and-distribution-targets.md),
there is no blue/green upgrade based on a container swap: each of the three
packaging targets — standalone, cPanel, Plesk — defines its own in-place
upgrade strategy (backup, then replace application files, then migrate,
then restart), without an atomic image/container swap. This document covers
that per-target procedure and the database migration discipline that
underlies all three.

## Database schema migrations: expand / backfill / switch / contract

Regardless of packaging target, every Gulo Gulo install shares one migration
mechanism: sequential, checksummed SQL files under
`src/core/db/migrations/` (currently just `0001_m2_foundation.sql`), applied
by an advisory-locked migration runner (`createMigrationRunner` in
`src/integrations/postgres-store.ts`) through `runMigrations.mjs`, the same
script every target's install/upgrade path calls. This part of the original
migration design is independent of the deployment/packaging model and remains
valid unchanged: schema changes should still be authored using the
**expand / backfill / switch / contract** discipline, because an in-place
upgrade still has a window — between the backup and the service restart, and
during the restart itself — where the schema must stay readable by whichever
version of the application code is currently running:

1. **Expand** — add new tables/columns/indexes in a way the *currently
   running* (old) version can still ignore safely. Never drop or rename
   anything in this phase.
2. **Backfill** — populate the new schema elements from existing data,
   in a way that is safe to interrupt and re-run (idempotent).
3. **Switch** — the new application code (deployed by the upgrade script,
   started on `systemctl restart`/manual restart) starts reading and writing
   the new schema elements instead of the old ones.
4. **Contract** — once the switch is confirmed safe (i.e., a subsequent
   migration, once nobody depends on the old shape anymore), drop the old
   schema elements that expand/backfill/switch made obsolete.

A migration file is not required to complete all four phases in one release;
splitting a schema change into an expand+backfill migration in one release
and a contract migration in a later one is the normal, safer pattern,
especially since none of the three targets currently roll back schema
changes automatically — the only rollback mechanism is restoring the
pre-upgrade backup each target's upgrade script takes (see below).

**Note on `src/core/upgrade/`:** `src/core/upgrade/compatibility.ts` is the
only module in this directory relevant today. It provides the
`MIGRATION_PHASES` vocabulary (`expand`/`backfill`/`switch`/`contract`) used
above and is the directly relevant migration-authoring guidance.

## Standalone: `upgrade.sh <new-tarball.tar.gz> <install-dir> [--non-interactive]`

1. **Backup.** Tars the entire current install directory to
   `<install-dir>.backup-<timestamp>.tar.gz` before touching anything.
2. **Extract.** Extracts the new tarball into a temporary directory.
3. **Copy in place, preserving local state.** Uses `rsync -a --exclude .env
   --exclude node_modules` if available, or a manual per-entry copy
   otherwise, so `.env` and anything not shipped by the package survive.
   External data — the PostgreSQL database, the LDAP directory, and mailbox
   storage — all live outside the install directory and are never touched.
4. **Reinstall dependencies:** `npm ci --omit=dev --no-audit --no-fund`.
5. **Migrate:** runs `run-migrations.mjs` against the new code (applies any
   pending migration files, no-op while `POSTGRES_ENABLED=false`).
6. **Does not restart the service.** By design — this target has no
   installed service of its own; whatever process manager the operator
   chose (systemd, pm2, or a manual foreground process) restarts the
   service on its own schedule. The script prints the reminder
   (`systemctl restart gulogulo` / `pm2 restart gulogulo`) but never runs
   it.

Rollback: restore `<install-dir>.backup-<timestamp>.tar.gz` over the install
directory and restart the service manually. No automatic rollback exists.

## cPanel: `upgrade.sh <new-tarball.tar.gz> <install-dir> [--non-interactive] [--dry-run]`

Same backup/extract/copy/`npm ci`/migrate sequence as standalone (the copy
step additionally preserves `gulogulo.service.rendered` if present), but
with one difference:

- **Automatically restarts the service:** `systemctl restart gulogulo`,
  because this target installs and manages a dedicated systemd unit itself
  — it is not a process the operator runs under their own supervisor, so
  there is no ambiguity about who owns the restart. Under `--dry-run`, every
  prior step (backup, extract, copy, `npm ci`, migrations) still runs for
  real — none of it touches host system configuration — but the final
  `systemctl restart gulogulo` is skipped and only printed.

Rollback: restore the backup tarball over the install directory, run
`npm ci`, and `systemctl restart gulogulo` again. Apache reverse-proxy
configuration and the optional WHM AppConfig registration are untouched by
upgrade — they were applied manually at install time and are not
reapplied or removed by `upgrade.sh`.

## Plesk: analogous to cPanel, through Plesk's own update mechanism

There is no dedicated `upgrade.php` lifecycle hook shipped in
`packaging/plesk/scripts/` — only `pre-install.php`, `post-install.php`, and
`pre-uninstall.php`. Updating the extension to a new version relies on
Plesk's own extension update mechanism: installing a newer package
(`gulogulo-<version>-plesk.zip`, with a higher `<version>`/`<release>` in
`meta.xml`) over an already-installed one. The most likely and standard
behavior for a Plesk extension without a separate upgrade hook is that Plesk
re-runs `pre-install.php` and `post-install.php` against the new `plib/`
contents — which would give the same practical steps as cPanel's
`upgrade.sh` (`npm ci`, run pending migrations, `systemctl restart` via
`systemctl enable --now gulogulo` again since `post-install.php` always
performs that step) but **without an explicit backup step**, since
`post-install.php` has no equivalent of `upgrade.sh`'s tar-before-replace
logic.

**This has not been verified against a real Plesk host and should be treated
as an assumption, not a documented fact**, consistent with the other
unverified Plesk specifics called out in `../INSTALL.md` and
`src/platform/plesk/README.md`. Before relying on this in production:

- confirm on a real Plesk instance whether an extension update actually
  re-runs `post-install.php`, runs some other hook, or requires a manual
  uninstall-then-reinstall cycle;
- if it does re-run `post-install.php`, consider adding an explicit backup
  step there (mirroring `upgrade.sh`'s tar-before-replace) before this
  target is treated as production-ready, since today an interrupted or
  failed Plesk extension update has no automatic rollback path;
- back up `plib/app/.env` yourself before triggering any Plesk extension
  update, for the same reason called out for uninstall in
  `../INSTALL.md` — the exact conditions under which Plesk touches
  or removes `plib/` around an update are unverified.

## Audit and failure behavior

None of the three upgrade scripts emit structured audit events of their own
today — they log to stdout only (`[upgrade] ...` / `[gulogulo post-install]
...`). An operator building evidence for a real upgrade should capture that
log output alongside the backup path, source/target versions, and the
migration runner's own summary line (`schema at <version> (<n> migration(s)
applied this run)`), and retain it per the evidence hand-off rules in
`../INSTALL.md`.

All three scripts fail closed on error (`set -euo pipefail` in the bash
scripts; explicit non-zero exits with `fail()` in the PHP hooks) — a failed
`npm ci` or a failed migration stops the script before it restarts (or,
for standalone, before it prints the restart reminder for) the service, so
a partially-upgraded install is left in place rather than silently brought
back up on old code with a new (possibly incompatible) schema, or vice
versa.

## Acceptance evidence still needed

Before any of these three upgrade paths is treated as production-ready:

- a real upgrade rehearsal on each target's real host type (a running
  standalone install upgraded in place; a real cPanel/WHM host upgraded and
  its systemd service confirmed to restart cleanly; a real Plesk extension
  update exercised end to end, resolving the open question above);
- a rollback rehearsal from each target's backup (standalone/cPanel) and a
  decision on what Plesk's rollback path even is, given it has no backup
  step today;
- at least one real expand/backfill/switch/contract migration exercised
  across an upgrade, not just the single foundational migration that exists
  today;
- confirmation that `.env` and any other operator-edited files genuinely
  survive the upgrade on a real host, not just under the `rsync --exclude`
  logic verified by unit/CI testing alone.
