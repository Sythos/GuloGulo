# Gulo Gulo Installation Guide

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This is the practical hand-off sheet for anyone who is going to deploy, test,
or operate Gulo Gulo outside the repository. It exists because a green
repository gate is useful, but it is not a substitute for a real LDAP
directory, a real PostgreSQL service, real mail traffic, real storage, or a
real operator on call.

The root README is intentionally an implementation checklist. A checked item
there means that the repository contains the relevant code or contract and that
the repository gate for it passes. It does not mean that a provider has already
configured or exercised the item in the field. The field work belongs here and
in the release evidence record.

Gulo Gulo's distribution model is defined by
[ADR-002](doc/adr/ADR-002-gulogulo-packaging-and-distribution-targets.md), which
superseded the Docker/OCI-native model of ADR-001. Read ADR-002 first if you
need the rationale; this document only covers the practical hand-off.

## Status model

- **DONE — repository** means that the code, contract, or runbook boundary is
  present and covered by a repository test or static gate.
- **VERIFY BEFORE USE** means that an operator or tester must exercise the
  boundary against the selected deployment and retain sanitized evidence.
- **OPEN CODE** means that a repository implementation is still missing. These
  items remain unchecked in the root README and are not field-verification
  tasks.

Never turn a VERIFY BEFORE USE item into a fake repository pass. Conversely,
do not leave an implementation checklist item open merely because the provider
has not run its deployment rehearsal yet.

## 1. Executive summary

Gulo Gulo is a self-hosted groupware runtime (mail, calendar, contacts) built
on a single TypeScript application core — RBAC, tenant isolation, quota,
delegation, mail/calendar/contacts business logic, and the HTML5 + TypeScript
web frontend. That core does not change across deployment targets; only the
identity source, the installation mechanics, and (eventually) the data engine
differ.

Gulo Gulo ships as three packages, all built from the same application core
via `packaging/shared/stage-application.ts`. **All three currently ship as a
plain `.tar.gz` plus `install.sh`/`upgrade.sh`/`uninstall.sh` shell scripts**
— see "Temporary reversion to tar.gz for cPanel and Plesk" below for why:

- **Standalone** (`packaging/standalone/`) — a generic tarball for any
  server/VPS, no panel required. Identity via LDAP, data via PostgreSQL.
- **cPanel** (`packaging/cpanel/`) — `gulogulo-<version>_cpanel_.tar.gz`,
  for a cPanel/WHM server — RHEL-family Linux only (AlmaLinux/CloudLinux/
  RHEL), which is the only family cPanel & WHM actually runs on. Identity
  via cPanel UAPI, data via the same PostgreSQL integration. A real RPM
  package (built with `rpmbuild`, installed with `dnf install`/`rpm -Uvh`)
  is fully implemented (`packaging/cpanel/gulogulo.spec`) but not currently
  built by `build-cpanel-package.ts`.
- **Plesk** (`packaging/plesk/`) — `gulogulo-<version>_plesk_.tar.gz`, for a
  Debian/Ubuntu server — deliberately not Plesk's own extension mechanism
  (see below). Identity via the Plesk REST API, data via the same
  PostgreSQL integration. A real Debian `.deb` package (built with
  `dpkg-deb`, installed with `dpkg -i`/`apt install`) is fully implemented
  (`packaging/plesk/debian/`) but not currently built by
  `build-plesk-package.ts`.

### Temporary reversion to tar.gz for cPanel and Plesk

cPanel and Plesk both had a real, OS-native package format (`.rpm` and
`.deb` respectively) implemented and CI-verified. Both build scripts now
produce a plain tar.gz instead, **temporarily, until a code-signing
key/certificate for RPM/DEB packages exists.** The reasoning: publishing an
*unsigned* package through a host's own package manager (`dnf install
./gulogulo-*.rpm`, `apt install ./gulogulo_*.deb`) is a worse trust signal
than an unsigned tar.gz — a package-manager install implies the artifact
went through a normal, curated distribution channel with the usual
signature verification, while a plain archive the operator downloads and
extracts themselves communicates "verify this yourself" (check the SHA256
checksum, read the scripts before running them as root) far more clearly.
None of the RPM/DEB code was deleted:

- `packaging/cpanel/gulogulo.spec` and `createRpmPackage()` in
  `packaging/shared/stage-application.ts` still build a working `.rpm` if
  invoked directly.
- `packaging/plesk/debian/DEBIAN/{control,postinst,prerm,postrm}` and
  `createDebPackage()` in `packaging/shared/stage-application.ts` still
  build a working `.deb` if invoked directly.
- `packaging/cpanel/build-cpanel-package.ts` and
  `packaging/plesk/build-plesk-package.ts` each carry a top-of-file comment
  explaining exactly which line to restore to re-enable the native package
  output once a signing key exists.

To make the tar.gz path fully functional again, each target's shell
operator scripts (`packaging/{cpanel,plesk}/scripts/{install,upgrade,
uninstall}.sh`) are **straight shell translations** of that target's own
RPM/DEB scriptlets — `gulogulo.spec`'s `%pre`/`%post`/`%preun`/`%postun`
for cPanel, `DEBIAN/{postinst,prerm,postrm}` for Plesk — not a reinvented
install flow. Read the relevant scriptlet/script pair side by side if you
need to verify a specific step's behavior.

**Current state, honestly:** the packaging code and build scripts for all
three targets are complete and pass their respective CI workflows
(`.github/workflows/package-{standalone,cpanel,plesk}.yml`), and **all
three now get a real, non-interactive install rehearsal in CI**, not just
standalone:

- **Standalone** — `package-standalone.yml` builds the tarball, extracts
  it, runs `install.sh --non-interactive` for real, starts the compiled
  server, and polls `/health/ready` and `/` until they respond, on a
  disposable Ubuntu CI runner. This target never installs a systemd unit
  automatically (`gulogulo.service.example` is opt-in), so there is nothing
  for CI to stub.
- **cPanel** — `package-cpanel.yml` runs inside an actual `almalinux:9`
  container: it builds the tar.gz, extracts it, verifies the package
  payload and a `bash -n` syntax check of the three operator scripts,
  then runs `install.sh --non-interactive` for real — dedicated system
  user creation, `.env` creation and permission lock-down, `npm ci
  --omit=dev`, migrations, and rendering the systemd unit file all execute
  for real — before starting the compiled server directly and polling
  `/health/ready` and `/`. The one part that cannot run for real is
  `systemctl daemon-reload`/`enable`: a plain container has no running
  init system (no PID 1 systemd, no D-Bus) for `systemctl` to talk to, so
  CI stubs `systemctl` with a no-op script on `PATH` for that one call. So
  the systemd unit actually starting and staying running under systemd,
  and the Apache reverse-proxy wiring, have never been exercised end to
  end by CI — nor has anybody installed this package on a real host yet.
- **Plesk** — `package-plesk.yml` runs the equivalent sequence inside an
  actual `debian:trixie` container, with the same `systemctl` stub for the
  same reason. The nginx reverse-proxy wiring and the assumed Plesk REST
  endpoints (if used for identity) have never been exercised end to end by
  CI — nor has anybody installed this package on a real host yet.

In short: **the code is ready and verified in CI, including a real
non-interactive install and a real server boot for all three targets, but
the systemd-managed service lifecycle on cPanel/Plesk, and both panels'
reverse-proxy wiring, are unvalidated against a real host.** Do not treat a
green CI run for cPanel/Plesk as equivalent to a working production
install with the service actually running under systemd — treat it as "the
scripts are internally consistent, install to completion outside of the
systemd calls, and the server boots and answers requests once started."

## 2. Standalone

### Build

```bash
node --experimental-strip-types packaging/standalone/build-standalone-package.ts
```

Runs `npm run build:web` and `npm run build:server` itself unless
`GULOGULO_SKIP_BUILD=1` is set (CI sets it, to avoid building twice). Produces
`packaging/dist/gulogulo-<version>-standalone.tar.gz`, containing the
compiled server (`dist/server/`), web assets (`web/`), static assets
(`assets/`), database migrations (`src/core/db/migrations/`),
`package.json`/`package-lock.json`/`LICENSE`/`.env.example`, a `VERSION`
file, and the operator scripts below.

Also writes a `gulogulo-<version>-standalone.tar.gz.sha256` sidecar file
next to the archive (standard `sha256sum` format) and updates the
aggregated `packaging/dist/checksums.txt` covering every package currently
in that directory. Verify a downloaded/generated archive before trusting it:

```bash
cd packaging/dist
sha256sum -c gulogulo-<version>-standalone.tar.gz.sha256
```

### Install (`install.sh [--non-interactive]`)

1. Requires `node` in `PATH` and Node.js ≥ 26 (checked from
   `process.versions.node`).
2. Copies `.env.example` to `.env` if `.env` does not already exist; leaves an
   existing `.env` untouched.
3. Runs `npm ci --omit=dev --no-audit --no-fund`.
4. Runs `run-migrations.mjs`, which is a clean no-op while
   `POSTGRES_ENABLED=false` (the packaged default) and otherwise applies
   pending PostgreSQL migrations.
5. Prints the manual start command
   (`node --env-file=.env dist/server/src/runtime/index.js`) and points at
   `gulogulo.service.example` as an optional systemd unit — **the installer
   never starts the service and never installs a systemd unit itself.**

### Requirements

- Node.js ≥ 26.
- PostgreSQL — optional. Disabled by default (`POSTGRES_ENABLED=false`); the
  operator enables it and provides `POSTGRES_DSN_SECRET_REF` plus a
  `GULOGULO_POSTGRES_DSN` environment variable before running migrations for
  real.
- LDAP — optional. Disabled by default (`LDAP_ENABLED=false`); without it,
  there is no working authentication path on this target (see Section 5),
  unless the DB-backed alternative below is used instead.
- Identity source — `IDENTITY_SOURCE=ldap` (default) or
  `IDENTITY_SOURCE=database`. The `database` option stores users directly in
  PostgreSQL (`local_users` table) instead of an external LDAP directory —
  simpler for a single/few-tenant install that would rather not stand up a
  directory service. Requires `POSTGRES_ENABLED=true`; see
  `doc/identity-and-postgres.md` for the table, the migration, and the
  current lack of an admin UI to provision users (insert rows directly for
  now).

### Uninstall (`uninstall.sh [--non-interactive] [--yes]`)

Interactively confirms (or, non-interactively, requires `--yes` for) removing
the application files (`dist/`, `web/`, `assets/`, `src/`, `node_modules/`,
`package*.json`, `LICENSE`, `VERSION`) and, separately, removing `.env`.
Never touches external PostgreSQL or LDAP data — none of it lives inside the
install directory.

### CI status

**DONE — repository, with a real end-to-end proof.** `package-standalone.yml`
installs non-interactively, starts the compiled server, and verifies
`/health/ready` and `/` respond. This is the strongest evidence of the three
targets, but it still runs against synthetic defaults (Postgres and LDAP both
disabled) on a disposable CI runner, not a production host with real traffic,
a real database, or a real directory.

## 3. cPanel

**This target currently ships as a plain tar.gz, not the real RPM package
its code already implements.** See "Temporary reversion to tar.gz for
cPanel and Plesk" in Section 1 for the full rationale (no code-signing key
yet for RPM). `packaging/cpanel/gulogulo.spec` and `createRpmPackage()`
still build a working `.rpm` if invoked directly — nothing was deleted.
`packaging/cpanel/scripts/{install,upgrade,uninstall}.sh` are straight
shell translations of that spec's `%pre`/`%post`/`%preun`/`%postun`
scriptlets (each script's own header comment says so); read the spec file
alongside a script if you need to verify a specific step. Identity comes
through cPanel's UAPI (`src/platform/cpanel/`), unaffected by this
packaging-format choice.

### Build

```bash
node --experimental-strip-types packaging/cpanel/build-cpanel-package.ts
```

Runs `npm run build:web` and `npm run build:server` itself unless
`GULOGULO_SKIP_BUILD=1` is set (CI sets it), stages the same application
files as standalone (`packaging/shared/stage-application.ts`) plus this
target's own `install.sh`/`upgrade.sh`/`uninstall.sh`, the shared
parameterized systemd unit template
(`packaging/shared/gulogulo-deb.service.template` — the same template the
Plesk target's `install.sh` renders, reused here since a tar.gz install
location is operator-chosen at extraction time, unlike an RPM's fixed
location), and the Apache reverse-proxy/WHM AppConfig example docs. Packs
all of that into `packaging/dist/gulogulo-<version>_cpanel_.tar.gz` via the
same `createTarball()` helper the standalone target uses (note the
underscore-wrapped `_cpanel_` — this filename deliberately does not match
either the standalone target's `gulogulo-<version>-standalone` convention
or the RPM NVRA filename `rpmbuild` itself would produce).

Also writes a `.sha256` sidecar and updates `packaging/dist/checksums.txt`,
same as the other two targets. Verify the package before installing it:

```bash
cd packaging/dist
sha256sum -c gulogulo-<version>_cpanel_.tar.gz.sha256
tar tzf gulogulo-<version>_cpanel_.tar.gz            # file listing
```

### Install (`install.sh [--non-interactive]`, run as root)

A shell translation of `gulogulo.spec`'s `%pre` and `%post` (first-install
branch):

1. Requires `node` in `PATH` and Node.js ≥ 26 (checked from
   `process.versions.node`), same check as `%post`.
2. Creates the dedicated `gulogulo` system user/group if neither already
   exists (`%pre`'s equivalent).
3. Copies `.env.example` to `.env` if `.env` does not already exist, and
   locks it down to mode `0640`, owned `root:gulogulo` — same as `%post`:
   this host is definitionally full of other, untrusted shell users
   (cPanel accounts), so `.env` (which will hold `CPANEL_API_*`/
   `POSTGRES_*` values) is deliberately not left world-readable. Leaves an
   existing `.env` untouched.
4. Runs `npm ci --omit=dev --no-audit --no-fund`.
5. Runs `run-migrations.mjs` (a clean no-op while `POSTGRES_ENABLED=false`).
6. Renders the systemd unit template with the extraction directory's actual
   path and installs it at `/etc/systemd/system/gulogulo.service`, then
   `systemctl daemon-reload` and `systemctl enable gulogulo` — **enabled
   but not started**, matching `%post`'s first-install branch: review `.env`
   first, then `systemctl start gulogulo`.
7. Prints (never applies) pointers to `gulogulo-proxy.conf.example` (an
   Apache reverse-proxy snippet) and the optional
   `gulogulo-appconfig.conf.example` WHM AppConfig registration — apply
   manually via WHM's Include Editor or a userdata hook, then
   `/scripts/rebuildhttpdconf && systemctl restart httpd`;
   `register_appconfig` for AppConfig.

The script is fail-fast (`set -euo pipefail`, matching `%post`'s `set -e`):
if `npm ci` or the migration step fails, it stops before wiring up systemd,
leaving the application files installed but the service not enabled — a
loud, visible failure rather than a silently half-configured service.

### Upgrade (`upgrade.sh <new-tarball.tar.gz> <install-dir> [--non-interactive]`, run as root)

Same backup-then-replace style as the standalone target's `upgrade.sh`
(tars the current install directory before touching it, extracts the new
package, copies files in while preserving `.env`), plus the same
`npm ci`/migrate/re-render-systemd-unit steps as `install.sh`. Then, unlike
standalone's `upgrade.sh` (which never restarts anything), it **restarts
the service automatically** if it is enabled
(`systemctl restart gulogulo`) — this matches `gulogulo.spec`'s `%post`
upgrade branch (`$1 >= 2`): gulogulo is a dedicated systemd unit this
package itself manages, not a process the operator runs under their own
supervisor. It deliberately does **not** re-run `systemctl enable`, so an
operator who had disabled the unit between versions stays disabled.
Previous install is backed up to `<install-dir>.backup-<timestamp>.tar.gz`
before anything is touched. See `doc/upgrade-and-migration.md` for the full
picture.

### Uninstall (`uninstall.sh [--non-interactive] [--yes]`, run as root)

A shell translation of `%preun`/`%postun`: stops and disables the systemd
service and removes the rendered unit file, interactively confirms (or,
non-interactively, requires `--yes` for) removing the application files,
and separately confirms removing `.env`. Never touches external PostgreSQL
data or `/var/lib/gulogulo`, never touches Apache configuration or WHM
AppConfig registration (only prints reminders for those two, same as
`%postun`), and never deletes the dedicated `gulogulo` system user.

### Requirements

Same as standalone (Node.js ≥ 26, PostgreSQL optional, LDAP not applicable
since identity comes from cPanel's own UAPI — see Section 5 for the current
`authenticate()` limitation), plus root access on a real RHEL-family
cPanel/WHM host.

### CI status

**DONE — repository, with a real non-interactive install rehearsal.**
`package-cpanel.yml` runs inside an actual `almalinux:9` container: it
builds the tar.gz, extracts it, checks for every expected file, runs a
`bash -n` syntax check plus content tripwires on the three operator
scripts, then runs `install.sh --non-interactive` for real — user
creation, `.env` creation/permissions, `npm ci`, migrations, and rendering
the systemd unit file all execute for real (verified: the `gulogulo` user
exists, `.env` has mode `0640 root:gulogulo`, the unit file is written) —
before starting the compiled server directly and polling `/health/ready`
and `/` until they respond, same proof standalone's own CI gives. The one
step that cannot run for real is `systemctl daemon-reload`/`enable`: the CI
container has no running init system for `systemctl` to talk to, so CI
stubs it with a no-op script on `PATH` for that call only. **VERIFY BEFORE
USE:** the systemd unit actually starting and staying running under a real
init system, the Apache reverse-proxy wiring, and the full
install/upgrade/uninstall cycle on a real cPanel/WHM host.

## 4. Plesk

**This target currently ships as a plain tar.gz, not the real Debian `.deb`
package its code already implements.** See "Temporary reversion to tar.gz
for cPanel and Plesk" in Section 1 for the full rationale (no code-signing
key yet for DEB). `packaging/plesk/debian/DEBIAN/{control,postinst,prerm,
postrm}` and `createDebPackage()` still build a working `.deb` if invoked
directly — nothing was deleted. `packaging/plesk/scripts/{install,upgrade,
uninstall}.sh` are straight shell translations of those maintainer scripts
(each script's own header comment says so); read `DEBIAN/postinst`
alongside `install.sh` if you need to verify a specific step. This target
still targets a Debian/Ubuntu host that Plesk may also be managing domains
on; it identifies users through Plesk's REST API (`src/platform/plesk/`)
the same as before, unaffected by this packaging-format choice.

### Build

```bash
node --experimental-strip-types packaging/plesk/build-plesk-package.ts
```

Runs `npm run build:web` and `npm run build:server` itself unless
`GULOGULO_SKIP_BUILD=1` is set (CI sets it), stages the same application
files as standalone (`packaging/shared/stage-application.ts`) plus this
target's own `install.sh`/`upgrade.sh`/`uninstall.sh`, the shared
parameterized systemd unit template
(`packaging/shared/gulogulo-deb.service.template` — the same template
`DEBIAN/postinst` renders at install time), and the nginx reverse-proxy
example. Packs all of that into
`packaging/dist/gulogulo-<version>_plesk_.tar.gz` via the same
`createTarball()` helper the standalone target uses (note the
underscore-wrapped `_plesk_` — this filename deliberately does not match
either the standalone target's `gulogulo-<version>-standalone` convention
or the retired `gulogulo_<version>_all.deb` Debian archive naming).

Also writes a `.sha256` sidecar and updates `packaging/dist/checksums.txt`,
same as the other two targets. Verify the package before installing it:

```bash
cd packaging/dist
sha256sum -c gulogulo-<version>_plesk_.tar.gz.sha256
tar tzf gulogulo-<version>_plesk_.tar.gz            # file listing
```

### Install (`install.sh [--non-interactive]`, run as root)

A shell translation of `DEBIAN/postinst`:

1. Requires `node` in `PATH` and Node.js ≥ 26 (checked from
   `process.versions.node`), same check as `postinst`.
2. Copies `.env.example` to `.env` if `.env` does not already exist (hints
   at `POSTGRES_*`); leaves an existing `.env` untouched. Unlike the cPanel
   script, this does **not** lock down `.env` permissions — same as
   `postinst`, which does not either.
3. Runs `npm ci --omit=dev --no-audit --no-fund`.
4. Runs `run-migrations.mjs` (a clean no-op while `POSTGRES_ENABLED=false`).
5. Creates the dedicated system user if missing (override the name via
   `GULOGULO_SERVICE_USER`/`GULOGULO_SERVICE_GROUP`, same env vars
   `postinst` reads).
6. Renders the systemd unit template with the extraction directory's actual
   path and installs it at `/etc/systemd/system/gulogulo.service`, then
   `systemctl daemon-reload` and `systemctl enable --now gulogulo` —
   **enabled and started immediately**, unconditionally, matching
   `postinst`, which has no separate first-install/upgrade branch.
7. Writes (never applies) a copy of `gulogulo-proxy.conf.example` rewritten
   to the configured `PORT` — apply manually via Plesk's Websites & Domains
   → Apache & nginx Settings → "Additional nginx directives", or the Plesk
   CLI.

### Upgrade (`upgrade.sh <new-tarball.tar.gz> <install-dir> [--non-interactive]`, run as root)

Same backup-then-replace style as the standalone target's `upgrade.sh`
(tars the current install directory before touching it, extracts the new
package, copies files in while preserving `.env`), plus the same
`npm ci`/migrate/re-render-systemd-unit/`enable --now` steps as
`install.sh` — mirroring `DEBIAN/prerm upgrade` (a no-op — it deliberately
leaves the service running) followed by `DEBIAN/postinst` re-running its
full configure sequence unconditionally. **This script does not explicitly
restart the service**, same as `postinst`: `systemctl enable --now` on an
already-running unit does not force a restart. If you need the new code
running immediately after an upgrade, restart it yourself:
`systemctl restart gulogulo`. Previous install is backed up to
`<install-dir>.backup-<timestamp>.tar.gz` before anything is touched. See
`doc/upgrade-and-migration.md` for the full picture.

### Uninstall (`uninstall.sh [--non-interactive] [--yes] [--purge]`, run as root)

A shell translation of `prerm`/`postrm`: stops and disables the systemd
service, removes `node_modules/` and the rendered unit file, interactively
confirms (or, non-interactively, requires `--yes` for) removing the
application files. `.env` is left in place unless `--purge` is also given
(mirroring `postrm remove` vs. `postrm purge`). Never touches external data
(PostgreSQL database, mailbox storage) or
`GULOGULO_SERVICE_READ_WRITE_PATH`/`/var/lib/gulogulo`, and never deletes
the dedicated system user — same caution as the cPanel target's
`uninstall.sh`.

### Requirements

Debian/Ubuntu host, Node.js ≥ 26 pre-installed (`install.sh` checks for it
but does not install it), PostgreSQL optional (same as the other targets),
root access. Plesk itself is not required to be installed on the host at
all for this to work; the Plesk REST API identity adapter
(`src/platform/plesk/`) is only relevant if the host is also Plesk-managed
and you intend to use it for identity.

### CI status

**DONE — repository, with a real non-interactive install rehearsal.**
`package-plesk.yml` runs inside an actual `debian:trixie` container: it
installs Node.js 26 via NodeSource, builds the tar.gz, extracts it, checks
for every expected file, runs a `bash -n` syntax check plus content
tripwires on the three operator scripts, then runs `install.sh
--non-interactive` for real — user creation, `.env` creation, `npm ci`,
migrations, and rendering the systemd unit file all execute for real
(verified: the `gulogulo` user exists, `.env` and the unit file are
written) — before starting the compiled server directly and polling
`/health/ready` and `/` until they respond, same proof standalone's own CI
gives. The one step that cannot run for real is `systemctl daemon-reload`/
`enable --now`: the CI container has no running init system for
`systemctl` to talk to, so CI stubs it with a no-op script on `PATH` for
that call only. **VERIFY BEFORE USE:** the systemd unit actually starting
and staying running under a real init system, the assumed Plesk REST
endpoints (if used for identity), the nginx reverse-proxy wiring, and the
full install/upgrade/uninstall cycle on a real Debian/Ubuntu host.

## 5. Cross-cutting known limitations

- **Password authentication on cPanel and Plesk is fail-closed and not
  implemented.** Neither cPanel's UAPI nor Plesk's REST API exposes a
  generic, safe way to verify an arbitrary mail account's password from the
  outside. Rather than build against an undocumented, unverifiable endpoint,
  `authenticate()` on both the `cpanel` and `plesk` identity adapters
  **always returns `false`** and logs why. **LDAP and the DB-backed
  `local_users` table (standalone target only, `IDENTITY_SOURCE=ldap` or
  `database`) are the only identity sources that actually authenticate users
  today.** `src/runtime/login.ts` resolves the configured target
  (`GULOGULO_PLATFORM`) and calls its real identity client for every
  `POST /api/session/login` outside `GULOGULO_FIXTURE_MODE=true` — including
  for cPanel/Plesk, where that real client is the fail-closed one above, so a
  login attempt is genuinely rejected by the adapter, not by a fixed stub.
  Real cPanel/Plesk password login is future work; the most likely paths, per
  `src/platform/cpanel/README.md` and `src/platform/plesk/README.md`, are a
  direct IMAP/POP3 bind against the local mail server, or a dedicated
  panel plugin/extension.
- **MySQL/MariaDB is not implemented.** ADR-002 promises MySQL/MariaDB as the
  primary data engine for cPanel and Plesk hosts, but today all three
  targets — standalone, cpanel, and plesk — reuse the exact same
  `createPostgresStore()`. A cPanel or Plesk host must have PostgreSQL
  available and enabled for Gulo Gulo's own data, independent of whatever
  MySQL the panel itself uses for its own purposes. Replicating PostgreSQL's
  row-level-security-based tenant isolation on a different engine is
  substantial work, tracked as backlog, not started.
- **`CPANEL_API_*` / Plesk API settings exist in configuration but are not
  wired up.** `.env.example` and `IntegrationConfig` (`src/integrations/
  types.ts`) already carry `CpanelApiSettings` and `PleskApiSettings`, but
  loading them into `src/runtime/config.ts` (which today only knows
  `ldap`/`postgres`/`controlPanel`) has not landed. Until it does, the
  cPanel and Plesk identity integrations stay disabled by default regardless
  of what is set in `.env`.
- **Sessions are in-memory on every target.** All three adapters use the same
  in-memory session store — fine for a single process, but there is no
  persistent or shared session store, so restarting the process invalidates
  every session, and there is no multi-process/clustered deployment story
  yet.
- **Do not confuse the cPanel/Plesk *packaging targets* (Sections 2–4) with
  the separate, optional "upstream tenant-tool" integration**
  (`CONTROL_PANEL_*` in `.env.example`, documented in
  `doc/control-panel-integration.md`). That is a different feature: Plesk or
  cPanel acting as an *upstream* hosting-account/DNS tool in front of an
  already-running Gulo Gulo instance (any target), not the mechanism by which
  Gulo Gulo itself gets installed.

## Production-readiness map

The following sections cover the production-readiness boundary as it stands
after the ADR-002 packaging change. Every DONE line is intentionally marked
as done at repository level. The indented verification notes are the work for
the future provider, administrator, or tester. Items that only made sense
under the superseded Docker/OCI model (container image policy, build
provenance attestations, Docker/Kubernetes blue-green cutover) have been
removed or replaced below; see ADR-002 for why.

### Packaging and distribution

- [x] **DONE — repository, real proof.** The standalone package builds,
  installs non-interactively, starts, and answers `/health/ready` and `/` in
  CI. Verify a real host: real traffic, PostgreSQL/LDAP enabled, and process
  supervision (systemd/pm2) chosen and configured by the operator.
- [x] **DONE — repository, real proof except the systemd calls.** The
  cPanel package builds a `gulogulo-<version>_cpanel_.tar.gz` (RPM code
  implemented but not currently built — see Section 3), its operator
  scripts pass `bash -n`, and CI runs `install.sh --non-interactive` for
  real inside an `almalinux:9` container — user creation, `.env`
  permissions, `npm ci`, migrations, and rendering the systemd unit file
  all execute for real — then starts the compiled server directly and
  verifies `/health/ready` and `/`. Only `systemctl daemon-reload`/`enable`
  is stubbed (no init system in the container). Verify a real cPanel/WHM
  host: the systemd unit actually starting and staying running, and the
  Apache reverse-proxy wiring.
- [x] **DONE — repository, real proof except the systemd calls.** The
  Plesk package builds a `gulogulo-<version>_plesk_.tar.gz` (DEB code
  implemented but not currently built — see Section 4), its operator
  scripts pass `bash -n`, and CI runs `install.sh --non-interactive` for
  real inside a `debian:trixie` container — user creation, `.env`
  creation, `npm ci`, migrations, and rendering the systemd unit file all
  execute for real — then starts the compiled server directly and verifies
  `/health/ready` and `/`. Only `systemctl daemon-reload`/`enable --now` is
  stubbed (no init system in the container). Verify a real Debian/Ubuntu
  host: the systemd unit actually starting and staying running, the
  assumed Plesk REST endpoints (if used for identity), and the nginx
  reverse-proxy wiring.
- [ ] **OPEN CODE — MySQL/MariaDB data engine.** ADR-002's promise of a
  MySQL/MariaDB engine for cPanel/Plesk hosts is not implemented; all three
  targets require PostgreSQL today.
- [ ] **OPEN CODE — cPanel/Plesk password authentication.** `authenticate()`
  is fail-closed by design on both adapters; no real password check exists
  yet for panel-native identity.
- [ ] **OPEN CODE — cPanel/Plesk configuration wiring.** `CPANEL_API_*` and
  Plesk API settings are defined in types and `.env.example` but not yet
  loaded by `src/runtime/config.ts`.

### Security and identity

- [x] **DONE — mail safety and relay policy.** The mail policy rejects open
  relay, sender spoofing, unknown internal recipients, catch-all delivery, and
  automatic forwarding. Verify the behavior with the selected Postfix and
  submission topology, including negative tests from an untrusted network.
- [x] **DONE — LDAP security boundary (standalone identity).** The adapter
  requires LDAPS or verified StartTLS, uses a secret reference, limits
  requested attributes, builds a tenant-aware filter, rejects ambiguous
  results, and never falls back to a local password store. Verify the real
  CA, bind account permissions, directory indexes, user lookup, password
  bind, timeout, retry, and outage behavior.
- [x] **DONE — DB-backed identity boundary (standalone, opt-in).** The
  `identity.source = 'database'` alternative
  (`src/platform/standalone/db-identity-client.ts`) stores users in a
  tenant-scoped, forced-RLS `local_users` table
  (`src/core/db/migrations/0002_standalone_local_identity.sql`) and reuses
  the existing versioned scrypt hasher
  (`src/core/auth/password-hashing.ts`) instead of a second scheme; config
  validation rejects it unless PostgreSQL is enabled. Verify the real
  migration, the operator's own row-provisioning process (no admin UI exists
  yet — see `doc/identity-and-postgres.md`), and RLS behavior in the field.
- [x] **DONE — provider-backed login/session wiring.**
  `src/runtime/login.ts` resolves the configured packaging target
  (`GULOGULO_PLATFORM`) and calls its real `PlatformAdapter`'s identity
  client for every login outside fixture mode, replacing the previous
  fixed-reject stub; `GULOGULO_FIXTURE_MODE=true` is unchanged. Tested against
  fake LDAP/PostgreSQL transports and the real fail-closed cPanel adapter.
  Verify against a real LDAP directory, a real PostgreSQL `local_users` table,
  and (once implemented) real cPanel/Plesk authentication.
- [x] **DONE — PostgreSQL security boundary.** The adapter supports verified
  TLS, bounded pools and retries, advisory-locked checksummed migrations,
  forced tenant RLS, transaction tenant context, and fail-closed dependency
  behavior. Verify the real certificate/hostname, database roles, firewall,
  RLS policy, migration permissions, connection limits, and outage behavior.
- [x] **DONE — secret store and rotation boundary.** Configuration rejects
  plaintext secret values and the repository provides an allowlisted,
  provider-neutral resolver plus managed versioned-file rotation/rollback.
  Verify the selected secret store, access policy, rotation cadence,
  revocation, restart behavior, provider ACLs, and durable audit trail in the
  field.
- [x] **DONE — browser security contracts.** Secure cookies, session rotation,
  logout invalidation, CSRF tokens, security headers, HTML sanitization,
  attachment/SSRF restrictions, generic login failures, and abuse limits are
  implemented and tested. Verify them with browser/device testing, a security
  review, and the operator's own reverse proxy on each target.
- [x] **DONE — audit privacy.** Structured audit and operational events remove
  credentials, tokens, cookies, private keys, message bodies, and other
  content-like values. Verify redaction with representative logs and confirm
  that the chosen collector and retention policy do not reintroduce sensitive
  payloads.
- [ ] **OPEN CODE — cPanel/Plesk panel-native password authentication.** See
  the packaging section above; `authenticate()` is fail-closed on both
  adapters today.

### Data, retention, backup, and deletion

- [x] **DONE — source-of-truth separation.** LDAP (or the panel's own
  identity, on cPanel/Plesk) owns identity, PostgreSQL owns application
  state, the mail store owns mailbox data, and DAV storage owns
  calendar/contact objects. Verify that the chosen adapters do not create
  shadow passwords, duplicate mailbox content, or cross-tenant indexes.
- [x] **DONE — gross and per-user quota ledger.** Tenant gross quota is
  immutable after bootstrap and allocations are checked atomically in the same
  transaction. Verify the real PostgreSQL constraints, concurrent allocation,
  storage accounting, and quota-alert thresholds.
- [x] **DONE — 28-day trash retention.** The server-side retention worker,
  holds, leases, idempotency keys, restore checks, and fail-safe purge result
  are implemented. Verify the real mailbox, folder, calendar, and contact
  deletion behavior with clocks, holds, retries, and recovery.
- [x] **DONE — user backup authorization.** A user backup is self-scoped,
  metadata-only at the request boundary, and excludes sessions, credentials,
  factors, and private keys. Verify authorization, download expiry/revocation,
  archive encryption, malware scanning, and tenant isolation.
- [x] **DONE — provider backup envelope.** Encrypted manifests, SHA-256
  members, external key references, scope checks, and overwrite protection are
  defined. Verify the selected object store, KMS, retention, access logging,
  replication, and key rotation.
- [x] **DONE — restore plan and DR record.** Restore validation checks scope,
  integrity, privacy, overwrite policy, and RPO/RTO objective shape. Verify an
  isolated restore of tenant, user, mailbox, DAV, PostgreSQL, configuration,
  and audit data, then retain measured timings.
- [x] **DONE — purge idempotency and hold handling.** Repeated operations return
  stable results and active holds block irreversible work. Verify worker lease
  behavior, crash recovery, replay, and evidence after a partial adapter
  failure.
- [x] **DONE — account deletion lifecycle and runbook definition.** The state
  machine, strong confirmation, recovery window, resource-by-resource cleanup
  plan, hold checks, idempotency, and metadata-only audit events are defined.
  The complete operator sequence is written below. Verify it with the real
  LDAP/panel identity, PostgreSQL, mailbox, DAV, alias, delegation, MFA, and
  backup adapters.

### Mail, scanners, DAV, and client interoperability

- [x] **DONE — SMTP, authenticated submission, IMAP, IMAP IDLE, LMTP, and
  Sieve contracts.** The repository covers closed submission, queue/retry/
  bounce metadata, IDLE sequence continuity, and forwarding protection. Verify
  the selected Postfix and Dovecot versions, TLS ciphers, client matrix,
  reconnect behavior, delivery acknowledgement, and queue persistence.
- [x] **DONE — explicit aliases and no catch-all.** Alias resolution is
  tenant-scoped and does not create an implicit recipient. Verify addresses,
  loops, disabled users, abuse limits, and sender authorization in the actual
  directory and MTA.
- [x] **DONE — Rspamd and ClamAV fail-closed adapters and shared signature
  boundary.** Verdicts are normalized to safe metadata, an unavailable scanner
  cannot silently turn into an accepted message, and both readers consume
  verified generations from a shared read-only signature volume. Verify real
  scanner endpoints, timeouts, quarantine/reject policy, queue behavior,
  malware/spam samples, feed licensing, and the host-side updater.
- [x] **DONE — CalDAV/CardDAV object contracts and persistent PostgreSQL
  backend.** Tenant/user scope, conditional writes, opaque ETags, sync
  tokens, tombstones, bounded iCalendar/vCard parsing, and metadata-only
  export are implemented, plus a PostgreSQL-backed storage adapter
  (`src/core/dav/caldav/postgres-caldav-store.ts`,
  `src/core/dav/carddav/postgres-carddav-store.ts`,
  `src/core/db/migrations/0003_dav_storage.sql`) tested against a fake pool.
  Verify against a real PostgreSQL instance, the XML method adapter, standard
  clients, sharing boundaries, and concurrency.
- [x] **DONE — discovery and timezone behavior.** HTTPS-only well-known
  resources, autodiscovery, manual fallback, ICS/vCard validation, and sender
  local-time presentation are defined. Verify DNS, reverse proxy paths
  (Apache on cPanel, nginx on Plesk, operator's own choice on standalone),
  browser locale, daylight-saving changes, and real client configuration.

### Operations and availability

- [x] **DONE — health, readiness, metrics, logs, alerts, and queue views.**
  The repository has bounded contracts and sanitized payloads. Verify the
  deployed collector, dashboard, alert routing, paging, retention, Postfix
  queue access, and on-call ownership on each target.
- [x] **DONE — external persistent storage.** Mail, DAV, runtime state, and
  PostgreSQL data are kept outside the install/extension directory on every
  target. Verify volume/directory creation, ownership, encryption, snapshots,
  and protection against accidental deletion for the chosen host.
- [x] **DONE — external Rspamd and ClamAV definition boundary.** The scanner
  readers, active-pointer layout, digest/freshness checks, read-only mounts,
  health metadata, atomic activation, and rollback-preserving generation
  contract are implemented. The provider still has to install and verify its
  host-side freshclam/map updater, feed permissions, alerting, and filesystem
  policy; those are VERIFY BEFORE USE work, not packaging code.
- [x] **DONE — per-target upgrade mechanism.** All three targets currently
  ship their own backup-then-replace `upgrade.sh` (cPanel and Plesk's are
  shell translations of what their still-implemented, not-currently-built
  RPM/DEB scriptlets do — see Sections 3–4); see
  `doc/upgrade-and-migration.md`. Verify each target's real upgrade path
  end to end, including rollback from the backup each `upgrade.sh` takes
  before touching the install directory.
- [x] **DONE — RPO/RTO and incident/DR contract shape.** Recovery objectives,
  integrity/privacy checks, sanitized evidence, and operator procedures are
  represented. Verify and approve measured objectives, escalation paths,
  tabletop response, restore timing, and business continuity ownership.

### Governance, API, MCP, and browser boundary

- [x] **DONE — RBAC and delegation.** Provider, tenant-master, user, and
  monitor roles, one-colleague delegation, forced master delegation, quota
  administration, and default-deny content access are tested. Verify the
  real identity mapping, tenant boundaries, and approval records.
- [x] **DONE — master log visibility.** Tenant policy controls whether a
  master may see administrative logs and the default is off. Verify the
  setting, audit trail, redaction, and cross-user denial.
- [x] **DONE — tenant monitoring API and MCP.** The runtime exposes safe
  health, readiness, metrics, and patch-status reads. Verify authentication,
  tenant scope, rate limits, no secret/content leakage, and read-only
  behavior.
- [x] **DONE — optional upstream Plesk/cPanel tenant-tool boundary.** This is
  the separate `CONTROL_PANEL_*` integration described in Section 5, not the
  packaging targets. The provider-neutral configuration, tenant binding,
  read-only capability matrix, pull/webhook/hybrid vocabulary, secret-
  reference rules, and default-deny behavior are implemented. Verify the
  selected panel API version, least-privilege account, callback verification,
  DNS ownership, reconciliation, rotation, and disable/rollback behavior in
  the real deployment.
- [x] **DONE — ADRs, documentation, license, and artifact governance.**
  ADR-001 and ADR-002, MIT/SPDX attribution, and the documentation inventory
  are present. Verify owner approvals and release retention.
- [x] **DONE — provider-backed browser login and session wiring.** The HTTP
  shell, fixture authenticator, and `src/runtime/login.ts` now wire the real
  `PlatformAdapter`/identity client (LDAP or DB-backed for standalone, UAPI
  for cPanel, REST for Plesk) into the authenticated login/session path for
  every run outside `GULOGULO_FIXTURE_MODE=true`. cPanel/Plesk authentication
  is still fail-closed by design (Section 5), but a login attempt against
  them now genuinely reaches and is rejected by that real adapter, not a
  fixed stub. Verify against real LDAP/PostgreSQL/cPanel/Plesk backends.

## Runbook definitions

The repository contracts are deliberately explicit about what a provider
operator must do. The steps below close the procedural gaps without pretending
that a workstation can perform them against someone else's infrastructure.

### Account deletion runbook

1. Confirm the tenant and user scope from the authenticated operator context.
2. Confirm the request ID, reason, strong confirmation string, and current
   policy. Do not accept a mailbox path, browser-supplied tenant, or free-form
   shell command as scope.
3. Check legal, operational, and backup holds. A held account stays recoverable
   and cannot enter irreversible purge.
4. Create the deletion request. The repository state moves from active to
   deletion_requested and records the recovery deadline.
5. Soft-delete the account after the second confirmation. Disable new login,
   submission, DAV, and background work while preserving recovery.
6. During the recovery window, allow an authorized restore. A restore cancels
   the pending deletion and must emit a metadata-only audit event.
7. After the recovery window, queue the purge only when no hold exists. The
   durable worker must use an idempotency key and a lease.
8. Execute the cleanup plan separately for aliases, delegations, MFA factors,
   backup links, mailbox data, DAV collections, PostgreSQL references, and
   identity state (LDAP or the panel's own directory). Record one sanitized
   result per resource.
9. Complete the purge only when every planned resource reports purged. A
   partial result remains retryable and must not be reported as success.
10. Retain the required audit metadata and verify that the 28-day trash policy,
   backup retention, and legal holds were respected.

The repository code already defines the state machine and safety checks. What
is still needed outside the repository is the transactional adapter execution,
durable worker, approval, and a witnessed rehearsal. Those are verification
tasks unless a provider-specific adapter is still absent.

### Optional Plesk and cPanel upstream tenant-tool runbook

Plesk or cPanel may sit upstream of Gulo Gulo as the tenant's hosting-account
and (where selected) DNS tool. It is optional and is not a second source of
truth for users, quotas, aliases, mailbox content, calendars, contacts,
authentication decisions, retention, or audit semantics. This is the
`CONTROL_PANEL_*` integration, distinct from the cPanel/Plesk packaging
targets in Sections 3–4.

1. Create a dedicated least-privilege panel account or API token and store the
   value in the provider secret store. Put only its reference in Gulo Gulo.
2. Confirm the panel's HTTPS certificate, API version, account identifier, and
   tenant/domain mapping. One panel account or domain must map to one intended
   Gulo Gulo tenant binding.
3. Decide explicitly whether the panel or another provider owns DNS. Gulo Gulo
   may read DNS/domain state for diagnostics, but the V1 contract does not
   authorize panel-driven DNS or deployment writes.
4. Select pull, signed webhook, or hybrid reconciliation. Every event must
   include a bounded timestamp, tenant/domain binding, idempotency key, and
   audit record; an unknown or mismatched external ID fails closed.
5. Exercise duplicate, delayed, malformed, replayed, cross-tenant, revoked,
   and provider-outage cases. A webhook is only a reconciliation hint and
   never an instruction to execute an arbitrary command.
6. Disable the integration and confirm that Gulo Gulo policy, mail, DAV, and
   monitoring remain usable. Record credential rotation and rollback evidence.

The repository currently proves the safe configuration and binding contract.
It does not claim a live Plesk/cPanel API adapter, automatic DNS mutation, SSH
execution, or unrestricted panel command execution.

### Backup and restore runbook

1. Declare the tenant scope, archive scope, operator, encryption-key reference,
   retention, and target environment.
2. Snapshot or export PostgreSQL, mailbox, DAV, runtime configuration, queue,
   and audit references using the provider's durable storage.
3. Build an encrypted manifest with SHA-256 members and no credentials,
   cookies, factor secrets, private keys, or message content in metadata.
4. Verify the archive in an isolated target before importing anything.
5. Restore into a new tenant or explicitly approved cutover target. A user
   restore must not overwrite existing data by default.
6. Check tenant isolation, mailbox/DAV counts, quota state, aliases,
   delegations, authentication references, and audit continuity.
7. Record observed RPO and RTO, integrity and privacy results, operator,
   release, archive, and evidence checksum.
8. Keep the original source untouched until the restore and rollback decision
   are approved.

The repository provides the manifest, integrity, privacy, and objective
contracts. External snapshot connectors, key management, scheduled workers,
and measured restore timing remain OPEN CODE or provider integration work.

### Scanner definition publication runbook

The scanner containers/services intentionally do not run a feed updater. They
read verified generations from the provider-owned shared volume, mounted
read-only. Do not describe the deterministic proof images as production
Rspamd or ClamAV until the provider has completed the host-side feed
rehearsal:

1. Pin the vendor package/definition source.
2. Update ClamAV definitions through freshclam or the supported equivalent, and
   update Rspamd maps, rules, fuzzy data, and reputation feeds.
3. Verify signature/map freshness, health, disk space, update checksum, and
   compatibility with the running daemon.
4. Stage the new definitions beside the current known-good set.
5. Run clean, spam, malware, timeout, and unavailable-scanner samples.
6. Atomically activate the new set; on any failure, keep the previous set and
   fail closed.
7. Emit sanitized freshness, result, and rollback metadata to operations
   monitoring.

The repository implements the reader, digest, freshness, atomic-pointer, and
rollback-preserving boundary. The feed-specific host job and its operational
evidence remain VERIFY BEFORE USE. A cron, systemd timer, or Task Scheduler
job must be the single writer; it must never make the scanner service
writable from Gulo Gulo's own process.

### Incident and disaster-recovery runbook

1. Declare the incident, affected tenant scope, correlation ID, operator, and
   current release without putting secrets or message content in the record.
2. Classify the failure: LDAP/panel identity, PostgreSQL, mail store, DAV,
   Rspamd, ClamAV, storage, network, or an in-place package upgrade.
3. Apply the fail-closed policy for the affected dependency. Preserve the
   known-good scanner definitions, the pre-upgrade backup taken by the
   target's own upgrade script, queue, and durable state.
4. Communicate impact and start the approved recovery objective clock.
5. Restore or roll back (from the upgrade script's own backup, on the
   affected target) in an isolated target, verify integrity and privacy, and
   collect sanitized evidence.
6. Record observed RPO/RTO, data loss, queue handling, customer impact, and
   the decision to resume service.
7. Run a post-incident review, rotate exposed credentials if necessary, and
   update the runbook and release evidence.

The policy and evidence shape are DONE. On-call ownership, paging, tabletop
exercise, external recovery, and formal approval are VERIFY BEFORE USE.

## Field verification checklist

The following checklist is intentionally for the people who will use the
system. It should be completed against a real deployment and attached to the
release evidence system as sanitized records.

### Provider and deployment operator

- Verify DNS, firewall, reverse proxy (Apache on cPanel, nginx on Plesk, the
  operator's own choice on standalone), ACME challenge, certificate renewal,
  and expiry alert.
- Verify the selected secret store, least-privilege access, rotation, revoke,
  restart, and recovery behavior.
- Verify external LDAP TLS, bind privilege, directory filters, user login,
  timeout/retry, and outage behavior (standalone identity); or, if
  `IDENTITY_SOURCE=database` is used instead, verify the `local_users`
  migration, row provisioning process, and RLS behavior against a real
  PostgreSQL service.
- Verify PostgreSQL TLS, role grants, RLS, migrations, backups, restore, and
  connection limits on every target.
- Verify external volume/directory creation, encryption, snapshots, ownership,
  restore, and replacement without data loss.
- Verify vendor Postfix, Dovecot, Rspamd, ClamAV, freshclam, CalDAV, and
  CardDAV versions, configuration, and update sources.
- Verify the optional Plesk/cPanel upstream tenant-tool account, API version,
  TLS, tenant/domain binding, webhook or pull policy, DNS ownership, and
  credential rotation.
- Verify queue, scanner, certificate, storage, authentication, and dependency
  alerts reach the assigned operator.
- Verify each target's install, upgrade, and uninstall path on a real host of
  that type — standalone on a plain server/VPS, cPanel through a real
  `install.sh`/`upgrade.sh`/`uninstall.sh` cycle as root on a real
  cPanel/WHM server, Plesk through the same cycle on a Debian/Ubuntu host —
  including the systemd unit actually starting and staying running, which
  CI cannot exercise for either (see Sections 3–4).

### Tenant master and user tester

- Verify tenant isolation, roles, delegation, quota ceiling, aliases, and
  default-deny mailbox/calendar/contact access.
- Verify the master log setting remains off unless the tenant explicitly
  enables it.
- Verify user backup scope, download expiry, restore authorization, and
  account deletion recovery.
- Verify SMTP, IMAP, IDLE, Sieve, CalDAV, CardDAV, discovery, timezone, and
  browser behavior with representative clients.
- Verify the API/MCP monitor returns only the caller's safe metadata and never
  permits tenant writes or arbitrary commands.

### Release and security tester

- Run negative tests for open relay, forwarding, catch-all, spoofing, scanner
  failure, CSRF, session replay, cross-tenant access, path traversal, and
  secret leakage.
- Exercise backup restore, account deletion, hold, rollback, and incident
  procedures with production-like data volume and sanitized evidence.
- Measure latency, memory, queue depth, storage pressure, connection counts,
  RPO, and RTO on each of the three targets that will actually be deployed.

## Evidence hand-off rules

Keep evidence small and useful:

- record release commit, package version (standalone/cpanel/plesk), target
  host type, environment class, operator, start/end time, result, and an
  evidence checksum;
- keep credentials, private keys, cookies, raw logs, message bodies, archive
  contents, absolute workstation paths, and unrestricted command output out of
  the record;
- link the provider record to the corresponding Section 30 item and replace
  contract/deferred evidence with verified evidence only after the rehearsal;
- do not edit the root README merely to record a field rehearsal;
- keep the root README open only for the OPEN CODE items below.

## Repository implementation work still open

These are the remaining repository tasks. They are deliberately not disguised
as tester work:

- [ ] MySQL/MariaDB data engine behind the existing `PostgresPoolLike`/
  `PostgresClientLike` abstraction, the multi-engine support ADR-002 promises
  for cPanel/Plesk hosts;
- [ ] real cPanel/Plesk panel-native password authentication (both adapters
  are fail-closed today);
- [ ] wiring `CPANEL_API_*` and Plesk API settings into
  `src/runtime/config.ts` so those integrations can actually be enabled;
- [ ] an admin UI/API to create, rotate, and deactivate `local_users` rows for
  the DB-backed identity option (today's workaround is inserting rows
  directly with `createPasswordHasher().hash(password)`, see
  `doc/identity-and-postgres.md`);
- [ ] production Postfix/Dovecot mail adapters: minimal IMAP IDLE and SMTP
  submission protocol clients and their adapters (`src/core/mail/imap-client.ts`,
  `src/core/mail/imap-idle-adapter.ts`, `src/core/mail/smtp-client.ts`,
  `src/core/mail/smtp-queue-adapter.ts`) are implemented and tested end to end
  against a local TCP protocol fake (see `doc/mail-core.md`); verification
  against a real Dovecot/Postfix installation is still outstanding;
- [x] persistent DAV backend: PostgreSQL-backed CalDAV/CardDAV storage
  (`src/core/dav/caldav/postgres-caldav-store.ts`,
  `src/core/dav/carddav/postgres-carddav-store.ts`,
  `src/core/db/migrations/0003_dav_storage.sql`), reusing the pure in-memory
  contracts' own ETag/sync-token functions so the two implementations cannot
  drift; tested against a fake pool — verification against a real PostgreSQL
  instance and real CalDAV/CardDAV clients is still outstanding;
- [x] HTTP/WebDAV method and XML-report integration: `src/runtime/server.ts`
  now routes `PROPFIND`/`GET`/`PUT`/`DELETE`/`REPORT` under
  `/dav/calendars/{tenantId}/{ownerUserId}/{collectionId}/...` and
  `/dav/contacts/{tenantId}/{userId}/{addressBookId}/...` to the real
  `PlatformAdapter.createDavStore()` Postgres-backed stores, authenticated by
  the same session cookie as `/api/*` (see `doc/dav-and-discovery.md` for the
  method-by-method coverage); tested end to end against a fake pool
  (`src/runtime/dav-runtime.test.ts`) — **VERIFY BEFORE USE**: a real
  PostgreSQL instance and a real CalDAV/CardDAV client (Apple Calendar,
  Thunderbird, DAVx5, ...) have not been rehearsed against it, and
  calendar/address-book *creation* (`MKCOL`/`MKCALENDAR`) is still not
  exposed over HTTP — a collection must already exist (created directly
  against the contract, e.g. during provisioning) before a client can PUT
  into it;
- [x] local filesystem backup adapter and account-deletion/purge wiring:
  `src/core/backup/filesystem-backup-adapter.ts` really writes
  manifests/archives/encrypted metadata to disk, `createBackupStorage()` on
  every `PlatformAdapter` returns it with a `/var/lib/gulogulo/backups`
  default, and `src/core/lifecycle/account-lifecycle-wiring.ts` connects
  account-purge transitions to it plus `retention.ts`'s `runPurgeBatch()`
  (a CLI entry point and systemd timer/service now exist too — see
  `doc/lifecycle-backup-dr.md`); still outstanding: a **remote/external**
  storage adapter for volume, PostgreSQL, mailbox, DAV, and object-store
  data (this local one is fast same-host recovery, explicitly not disaster
  recovery), a **persistent** retention store (today's is in-memory, so the
  scheduled worker is a safe no-op), and wiring `src/core/lifecycle/**` into
  the build/packaging scripts;
- [ ] provider-specific Plesk/cPanel API adapter and idempotent reconciliation
  behind the validated read-only tenant binding (the optional upstream
  tenant-tool integration);
- [x] alert-delivery webhook adapter, with the log collector and paging
  questions resolved (the ACME/DNS client that used to be paired with this
  item was removed architecturally - cPanel/Plesk own certificate issuance
  via their AutoSSL/Let's Encrypt integration, and standalone doesn't
  configure a reverse proxy at all - so it is no longer a backlog gap):
  `src/core/observability/webhook-alert-adapter.ts` is a real, generic HTTP
  webhook delivery adapter (Slack/Discord/any JSON endpoint) for
  `alert-policy.ts`'s evaluated alerts, wired through
  `PlatformAdapter.createAlertDelivery()` and `alerting.*` config
  (`src/runtime/config.ts`) on all three targets, tested against a local
  `node:http` fake (see `doc/observability.md`); the log collector is
  intentionally not application code — systemd/journald (or logrotate) on
  every current, non-container target already captures and rotates the
  stdout/stderr JSON log stream; paging reuses the same webhook mechanism
  with `alerting.minSeverity: 'critical'`, no dedicated paging adapter
  exists or is needed. Still outstanding: nothing in the runtime yet calls
  `alert-policy.ts`'s `evaluate()` on a periodic snapshot and feeds the
  result to the delivery adapter (the wiring point,
  `deliverAlertEvaluation()`, exists and is tested, but nothing schedules
  it), and none of this has been verified against a real Slack/Discord/
  PagerDuty endpoint.

Shared mailboxes, resource calendars, write-capable tenant API/MCP operations,
and assisted IMAP migration remain intentionally deferred product features,
not accidental readiness gaps.

## Final acceptance rule

Gulo Gulo can be called production-ready only when:

1. every OPEN CODE item required by the selected deployment target is
   implemented and covered by repository gates;
2. every VERIFY BEFORE USE item has a sanitized provider/tester record —
   including, for cPanel and Plesk, at least one real install on a real host
   of that type;
3. backup, restore, account deletion, scanner updates, upgrade, rollback,
   RPO/RTO, and incident/DR evidence has an owner and approval;
4. the release evidence object contains the real commit and package version;
5. the release evaluator reports productionReady as true.

Until then, the honest description is a usable, tested repository contract
preview — with a real end-to-end proof for the standalone target only — and a
clearly documented deployment hand-off for cPanel and Plesk.
