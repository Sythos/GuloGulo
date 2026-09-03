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

## cPanel: through rpm/dnf's own upgrade mechanism

This target ships as a real RPM package (see `../INSTALL.md`), not a
tarball plus `install.sh`/`upgrade.sh`/`uninstall.sh` — those three scripts
were deliberately retired in favor of an OS-native package, since cPanel &
WHM only runs on RHEL-family Linux anyway. There is no separate "upgrade"
script of its own: upgrading means installing a newer `.rpm` — `dnf install
./gulogulo-<newversion>-1*.rpm` (or `rpm -Uvh`) — over an already-installed
one. rpm's own transaction handles this the standard way: the new package's
files replace the old package's files, then `%post` runs against the new
files — the same `npm ci --omit=dev`, run pending migrations, and
`systemctl daemon-reload` as a fresh install, but on an upgrade (`$1 >= 2`
inside `%post`) it runs `systemctl restart gulogulo` instead of `systemctl
enable gulogulo` (which only fires on `$1 == 1`, a genuinely first
install) — restarting automatically because gulogulo is a dedicated
systemd unit this package itself installs and manages, not a process the
operator runs under their own supervisor, and deliberately not re-enabling,
so an operator who disabled the unit between versions stays disabled.

Unlike the standalone script, this has **no explicit backup step** — rpm
overwrites the package's shipped files (`dist/`, `web/`, migrations,
`package.json`, ...) directly, with no tar-before-replace equivalent to
`upgrade.sh`'s. `/opt/gulogulo/.env` and anything else `%post` created at
runtime (`node_modules/`) are not shipped by the package, so rpm does not
touch them across an upgrade — they survive by construction, not by any
explicit preservation logic.

**This rpm upgrade path has not been exercised against a real host by this
project's CI** (`.github/workflows/package-cpanel.yml` builds and inspects
the `.rpm` structurally, syntax-checks its scriptlets, and runs `rpm -i
--test` plus a real `rpm2cpio | cpio` extraction, but cannot run `%post` to
completion — see that workflow's own comments for why: `systemctl
daemon-reload`/`enable`/`restart` need a running init system the CI
container does not have). Before relying on this in production:

- back up `/opt/gulogulo/.env` yourself before an upgrade — not because rpm
  is expected to touch it, but because there is no automated backup of it
  anywhere in this package, unlike the standalone target;
- rehearse an actual `dnf install ./gulogulo-<newversion>-1*.rpm` upgrade
  over a running install on a real cPanel/WHM host before treating this
  target as production-ready — confirm `%post` actually re-runs cleanly
  against an existing `.env`/`node_modules` and that the service restarts
  and comes back up;
- rollback is `dnf downgrade gulogulo` / `rpm -Uvh --oldpackage` against a
  previously-built `.rpm` you kept around — there is no automatic rollback
  to the previous version's files otherwise, and `%post` still reruns on a
  downgrade the same way it does on an upgrade. Apache reverse-proxy
  configuration and the optional WHM AppConfig registration are untouched
  by an upgrade or a downgrade either way — they were applied manually at
  install time and are not reapplied or removed by rpm.

## Plesk: through dpkg/apt's own upgrade mechanism

This target ships as a real Debian `.deb` package (see `../INSTALL.md`), not
a Plesk extension — the Plesk extension mechanism (`meta.xml` +
`plib/scripts/` PHP lifecycle hooks) was deliberately retired in favor of an
OS-native package. There is no separate "upgrade" script of its own:
upgrading means installing a newer `.deb` — `apt install
./gulogulo_<newversion>_all.deb` (or `dpkg -i`) — over an already-installed
one. dpkg's own maintainer-script contract handles this the standard way:
`DEBIAN/prerm upgrade <new-version>` runs first (deliberately a no-op here —
it leaves the service running, see `packaging/plesk/debian/DEBIAN/prerm`),
dpkg replaces the package's files, then `DEBIAN/postinst configure
<old-version>` runs against the new files — the same `npm ci --omit=dev`,
run pending migrations, and `systemctl enable --now gulogulo` (restarting
the service) as a fresh install, since `postinst` does not distinguish a
fresh configure from a reconfigure.

Unlike the standalone script, this has **no explicit backup step** (neither
does the cPanel `.rpm`, for the same reason — see the cPanel section above)
— dpkg overwrites the package's shipped files (`dist/`, `web/`, migrations,
`package.json`, ...) directly, with no tar-before-replace equivalent to
`upgrade.sh`'s. `.env` and anything else `postinst` created at runtime
(`node_modules/`) are not shipped by the package, so dpkg does not touch
them across an upgrade — they survive by construction, not by any explicit
preservation logic.

**This dpkg upgrade path has not been exercised against a real host by this
project's CI** (`.github/workflows/package-plesk.yml` builds and inspects
the `.deb` structurally but cannot run `postinst` to completion — see that
workflow's own comments for why: `systemctl enable --now` needs a running
init system the CI container does not have). Before relying on this in
production:

- back up `/opt/gulogulo/.env` yourself before an upgrade — not because
  dpkg is expected to touch it, but because there is no automated backup of
  it anywhere in this package, unlike the standalone target;
- rehearse an actual `apt install ./gulogulo_<newversion>_all.deb` upgrade
  over a running install on a real Debian/Ubuntu host before treating this
  target as production-ready — confirm `postinst` actually re-runs cleanly
  against an existing `.env`/`node_modules` and that the service comes back
  up;
- if an upgrade fails mid-`postinst`, dpkg leaves the package
  "half-configured" — `dpkg --configure gulogulo` retries `postinst` after
  fixing whatever caused the failure (e.g. Node.js version); there is no
  automatic rollback to the previous version's files.

## Audit and failure behavior

None of the three upgrade scripts emit structured audit events of their own
today — they log to stdout only (`[upgrade] ...` for standalone, `[gulogulo]
...` for the cPanel RPM's `%post`, `[gulogulo postinst] ...` for the Plesk
`.deb`'s `postinst`). An operator building evidence for a real upgrade should capture that
log output alongside the backup path, source/target versions, and the
migration runner's own summary line (`schema at <version> (<n> migration(s)
applied this run)`), and retain it per the evidence hand-off rules in
`../INSTALL.md`.

All three scripts fail closed on error (`set -euo pipefail` in standalone's
`upgrade.sh`, `set -e` in the cPanel RPM's `%post` and the Plesk `.deb`'s
`postinst`; explicit non-zero exits via a `fail()` helper in `upgrade.sh` and
`postinst`, plain `exit 1` in `%post`) — a failed
`npm ci` or a failed migration stops the script before it restarts (or,
for standalone, before it prints the restart reminder for) the service, so
a partially-upgraded install is left in place rather than silently brought
back up on old code with a new (possibly incompatible) schema, or vice
versa.

## Acceptance evidence still needed

Before any of these three upgrade paths is treated as production-ready:

- a real upgrade rehearsal on each target's real host type (a running
  standalone install upgraded in place; a real cPanel/WHM host upgraded via
  `dnf install`/`rpm -Uvh` with its systemd service confirmed to restart
  cleanly; a real Plesk `.deb` update exercised end to end, resolving the
  open question above);
- a rollback rehearsal from the standalone target's backup, and a decision
  on what the cPanel (`dnf downgrade`/`rpm -Uvh --oldpackage`) and Plesk
  rollback paths even look like exercised for real, given neither package
  has a backup step of its own today;
- at least one real expand/backfill/switch/contract migration exercised
  across an upgrade, not just the single foundational migration that exists
  today;
- confirmation that `.env` and any other operator-edited files genuinely
  survive the upgrade on a real host, not just under the `rsync --exclude`
  logic verified by unit/CI testing alone.
