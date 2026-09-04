# Upgrade and migration operations

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This is the operator manual for upgrading an existing Gulo Gulo install in
place. Since [ADR-002](../adr/ADR-002-gulogulo-packaging-and-distribution-targets.md),
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

## cPanel: `upgrade.sh <new-tarball.tar.gz> <install-dir> [--non-interactive]` (run as root)

This target currently ships as a plain tar.gz, not the real RPM package its
code already implements — see "Temporary reversion to tar.gz for cPanel and
Plesk" in `../INSTALL.md` (no code-signing key yet for RPM).
`packaging/cpanel/scripts/upgrade.sh` is a straight shell translation of
`packaging/cpanel/gulogulo.spec`'s `%post` upgrade branch (`$1 >= 2`, i.e.
rpm's own upgrade transaction re-invoking `%post`); read them side by side
if you need to verify a specific step. `createRpmPackage()` and the spec
file itself are untouched and still build a working `.rpm` — with its own
`dnf install`/`rpm -Uvh` upgrade path — once a signing key exists.

1. **Backup.** Same as standalone: tars the entire current install
   directory to `<install-dir>.backup-<timestamp>.tar.gz` before touching
   anything.
2. **Extract.** Extracts the new tarball into a temporary directory.
3. **Copy in place, preserving local state.** Same `rsync -a --exclude .env
   --exclude node_modules` (or manual per-entry copy) as standalone, plus
   this target's own `gulogulo.service.template`,
   `gulogulo-proxy.conf.example`, and `gulogulo-appconfig.conf.example`.
4. **Reinstall dependencies:** `npm ci --omit=dev --no-audit --no-fund`.
5. **Migrate:** runs `run-migrations.mjs` against the new code.
6. **Re-render the systemd unit.** Renders `gulogulo.service.template`
   again against `$INSTALL_DIR`/`$SERVICE_USER`/`$SERVICE_GROUP`/etc. and
   writes it to `/etc/systemd/system/gulogulo.service`, then `systemctl
   daemon-reload`.
7. **Restart if enabled, never re-enable.** If `gulogulo.service` is
   currently enabled, runs `systemctl restart gulogulo` to pick up the new
   code — matching `gulogulo.spec`'s still-implemented `%post` upgrade
   branch, which this script translates. It deliberately does **not**
   re-run `systemctl enable`, so an operator who disabled the unit between
   versions stays disabled; if the unit is not enabled, the script logs
   that and leaves it alone instead of starting it.

Rollback: restore `<install-dir>.backup-<timestamp>.tar.gz` over the
install directory and restart the service manually. No automatic rollback
exists.

**This upgrade path has not been exercised against a real host by this
project's CI** (`.github/workflows/package-cpanel.yml` runs `install.sh
--non-interactive` end to end inside an `almalinux:9` container, including a
real server boot, but does not currently invoke `upgrade.sh` — see that
workflow's own steps). Before relying on this in production:

- rehearse an actual `upgrade.sh <new-tarball> <install-dir>` run over an
  already-running install on a real cPanel/WHM host;
- confirm the systemd unit actually restarts and comes back up under a real
  init system — the CI container stubs `systemctl`, see `../INSTALL.md`;
- Apache reverse-proxy configuration and the optional WHM AppConfig
  registration are untouched by `upgrade.sh` — they were applied manually
  at install time and are not reapplied or removed by it.

## Plesk: `upgrade.sh <new-tarball.tar.gz> <install-dir> [--non-interactive]` (run as root)

This target currently ships as a plain tar.gz, not the real Debian `.deb`
package its code already implements — see "Temporary reversion to tar.gz
for cPanel and Plesk" in `../INSTALL.md` (no code-signing key yet for DEB).
`packaging/plesk/scripts/upgrade.sh` is a straight shell translation of
`packaging/plesk/debian/DEBIAN/{prerm,postinst}`: `prerm upgrade` is a
no-op (it deliberately leaves the service running), then `postinst`
re-runs its full configure sequence unconditionally — there is no separate
first-install branch in `postinst`, so this script preserves that exact
behavior rather than adding a restart step `postinst` itself does not have.
`createDebPackage()` and the `DEBIAN/` maintainer scripts are untouched and
still build a working `.deb` — with its own `apt install`/`dpkg -i` upgrade
path — once a signing key exists.

1. **Backup.** Same as standalone.
2. **Extract.** Same as standalone.
3. **Copy in place, preserving local state.** Same as standalone, plus
   this target's own `gulogulo.service.template` and
   `gulogulo-proxy.conf.example`.
4. **Reinstall dependencies:** `npm ci --omit=dev --no-audit --no-fund`.
5. **Migrate:** runs `run-migrations.mjs`.
6. **Create the system user if missing, re-render, and re-enable the
   systemd unit.** Creates the dedicated `gulogulo` system user if it does
   not already exist, re-renders `gulogulo.service.template`, writes it to
   `/etc/systemd/system/gulogulo.service`, then `systemctl daemon-reload`
   and `systemctl enable --now gulogulo`, unconditionally — matching
   `postinst`'s own behavior, which does not distinguish a fresh configure
   from a reconfigure. **This does not force a restart**: `systemctl
   enable --now` on an already-running unit is a no-op for a running
   service. If you need the new code running immediately, restart it
   yourself: `systemctl restart gulogulo`.

Rollback: same as cPanel/standalone — restore
`<install-dir>.backup-<timestamp>.tar.gz` over the install directory.

**This upgrade path has not been exercised against a real host by this
project's CI** (`.github/workflows/package-plesk.yml` runs `install.sh
--non-interactive` end to end inside a `debian:trixie` container, including
a real server boot, but does not currently invoke `upgrade.sh`). Before
relying on this in production:

- rehearse an actual `upgrade.sh <new-tarball> <install-dir>` run on a real
  Debian/Ubuntu host;
- confirm the service comes back up under a real init system — the CI
  container stubs `systemctl`, see `../INSTALL.md`;
- the nginx reverse-proxy wiring is untouched by an upgrade — reapply
  manually if the upstream port changed.

## Audit and failure behavior

None of the three upgrade scripts emit structured audit events of their own
today — all three log to stdout only, under the same `[upgrade] ...` prefix
(`upgrade.sh` is now the same script style on every target, standalone,
cPanel, and Plesk alike). An operator building evidence for a real upgrade
should capture that log output alongside the backup path, source/target
versions, and the migration runner's own summary line (`schema at <version>
(<n> migration(s) applied this run)`), and retain it per the evidence
hand-off rules in `../INSTALL.md`.

All three scripts fail closed on error (`set -euo pipefail`, with explicit
non-zero exits via a `fail()` helper) — a failed `npm ci` or a failed
migration stops the script before it restarts (or, for standalone, before
it prints the restart reminder for) the service, so a partially-upgraded
install is left in place rather than silently brought back up on old code
with a new (possibly incompatible) schema, or vice versa.

## Acceptance evidence still needed

Before any of these three upgrade paths is treated as production-ready:

- a real upgrade rehearsal on each target's real host type (a running
  standalone install upgraded in place; a real cPanel/WHM host upgraded via
  `upgrade.sh` with its systemd service confirmed to restart cleanly; a
  real Plesk host upgraded the same way, resolving the open question
  above);
- a rollback rehearsal on each target from the backup its own `upgrade.sh`
  takes before touching the install directory — the mechanism is now
  identical across standalone, cPanel, and Plesk;
- at least one real expand/backfill/switch/contract migration exercised
  across an upgrade, not just the single foundational migration that exists
  today;
- confirmation that `.env` and any other operator-edited files genuinely
  survive the upgrade on a real host, not just under the `rsync --exclude`
  logic verified by unit/CI testing alone.
