# Read before using Gulo Gulo

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
[ADR-002](../../ADR-002-gulogulo-packaging-and-distribution-targets.md), which
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
via `packaging/shared/stage-application.ts`:

- **Standalone** (`packaging/standalone/`) — a generic tarball for any
  server/VPS, no panel required. Identity via LDAP, data via PostgreSQL.
- **cPanel** (`packaging/cpanel/`) — a tarball for a cPanel/WHM server,
  installed by an operator running the installer as root. Identity via
  cPanel UAPI, data via the same PostgreSQL integration.
- **Plesk** (`packaging/plesk/`) — a real Plesk extension ZIP (`meta.xml` +
  `plib/scripts/` lifecycle hooks), installed through Plesk's own extension
  mechanism. Identity via the Plesk REST API, data via the same PostgreSQL
  integration.

**Current state, honestly:** the packaging code and build scripts for all
three targets are complete and pass their respective CI workflows
(`.github/workflows/package-{standalone,cpanel,plesk}.yml`). But the depth of
verification differs sharply by target:

- **Standalone is the only target with a real end-to-end install rehearsal in
  CI.** `package-standalone.yml` builds the tarball, extracts it, runs
  `install.sh --non-interactive` for real, starts the compiled server, and
  polls `/health/ready` and `/` until they respond. This is a genuine,
  automated install-and-boot proof, on a disposable Ubuntu CI runner.
- **cPanel is only dry-run tested.** `package-cpanel.yml` builds the tarball
  and runs `install.sh --non-interactive --dry-run`, which exercises argument
  parsing, precondition checks (downgraded to warnings off a real cPanel
  host), `.env` creation, `npm ci`, and the no-op migration step — but never
  writes a systemd unit, never touches Apache, and never actually starts the
  service, because the CI runner is not a real cPanel/WHM host. Nobody has
  run this installer against a real cPanel/WHM server yet.
- **Plesk is only structurally verified.** `package-plesk.yml` builds the
  ZIP, checks that `meta.xml` sits at the archive root with the required
  fields, confirms the ZIP is well-formed, and runs `php -l` on the three
  lifecycle scripts. It does **not** execute `pre-install.php`,
  `post-install.php`, or `pre-uninstall.php` — that needs root on a real
  Linux host with systemd and, more importantly, a real Plesk installation,
  which no CI runner here provides. Nobody has installed this extension on a
  real Plesk server yet.

In short: **the code is ready and verified in CI, but cPanel and Plesk
install/upgrade/uninstall are unvalidated against a real host.** Do not treat
a green CI run for those two targets as equivalent to a working production
install — treat it as "the scripts are internally consistent and the archive
has the right shape."

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
  there is no working authentication path on this target (see Section 5).

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

### Build

```bash
node --experimental-strip-types packaging/cpanel/build-cpanel-package.ts
```

Same staging mechanism as standalone, plus the cPanel-specific operator
scripts. Produces `packaging/dist/gulogulo-<version>-cpanel.tar.gz`.

### Install (`install.sh [--non-interactive] [--dry-run] [--yes]`)

Must run as root on a real cPanel/WHM server (checks `/usr/local/cpanel`
exists; both the root and cPanel checks are downgraded to warnings only under
`--dry-run`, which is how CI exercises the script safely on a non-cPanel
runner).

1. Node.js ≥ 26 check, `.env` creation from `.env.example` (also hints at
   setting `CPANEL_API_*` for the UAPI identity adapter and `POSTGRES_*` for
   an existing PostgreSQL database), `npm ci --omit=dev`, and the same
   no-op-while-disabled migration step as standalone.
2. **Really installs and starts a systemd service.** cPanel's own Application
   Manager is Passenger-based and is not a fit for a standalone-port
   `app.listen()` Node process, so this target renders
   `gulogulo.service.template` (substituting install dir, service user/group,
   `node` binary path, and a read-write path), creates a dedicated
   `gulogulo` system user if one doesn't exist, and — subject to
   confirmation (interactive prompt, or `--yes` in non-interactive mode; both
   skipped entirely under `--dry-run`) — writes the unit to
   `/etc/systemd/system/gulogulo.service` and runs
   `systemctl daemon-reload && systemctl enable --now gulogulo`. If not
   confirmed, the rendered unit is left at `gulogulo.service.rendered` for
   manual review and manual `cp`/`daemon-reload`/`enable --now`.
3. Writes `gulogulo-proxy.conf.example` (an Apache reverse-proxy snippet,
   rewritten to the port from `.env` if not 8080) — **never applies it**; the
   operator applies it manually via WHM's Include Editor or a userdata hook,
   then rebuilds/restarts Apache.
4. Points at `gulogulo-appconfig.conf.example` as an **optional** WHM
   AppConfig registration, not required for Gulo Gulo to work, applied
   manually with `cp ... /var/cpanel/apps/gulogulo.conf` followed by
   `register_appconfig` — never run automatically.

### Requirements

Same as standalone (Node.js ≥ 26, PostgreSQL optional, LDAP not applicable
since identity comes from cPanel's own UAPI — see Section 5 for the current
`authenticate()` limitation), plus: a real cPanel/WHM host with root access,
since this installer refuses to do its irreversible work anywhere else
(outside `--dry-run`).

### Uninstall (`uninstall.sh [--non-interactive] [--dry-run] [--yes]`)

Stops/disables the systemd service (with confirmation) and optionally removes
the unit file, then — separately confirmed — removes application files and
optionally `.env`. Never touches PostgreSQL data, and never touches Apache
configuration or WHM AppConfig registration; it only prints reminders for
those two, since both are manual, host-wide changes the operator made
deliberately.

### CI status

**DONE — repository, dry-run only.** `package-cpanel.yml` never runs on a
real cPanel/WHM host, so it can only validate that the installer's logic is
internally sound (`--dry-run` skips every systemd/Apache/user write, argument
parsing rejects unknown flags, no systemd unit or system user is left behind).
**VERIFY BEFORE USE:** an actual install on a real cPanel/WHM server —
systemd unit creation and startup, the dedicated system user, the Apache
reverse proxy wiring, and (if used) the AppConfig registration.

## 4. Plesk

### Build

```bash
node --experimental-strip-types packaging/plesk/build-plesk-package.ts
```

Unlike the other two targets, this produces a real Plesk extension **ZIP**
(`packaging/dist/gulogulo-<version>-plesk.zip`), built by a dependency-free
ZIP writer (`createZipArchive` in `packaging/shared/stage-application.ts`,
built on `node:zlib`), with `meta.xml` at the archive root and lifecycle
scripts under `plib/scripts/` — the layout Plesk's extension installer
requires. The staged application lives under `plib/app/` (same staging
helper as the other two targets, plus the systemd unit template shared with
cPanel, the nginx proxy example, and `run-migrations.mjs`).

`meta.xml` declares `plesk_min_version` `18.0.29` (the Obsidian line, chosen
as the conservative floor for the modern REST API v2 this project's Plesk
adapter uses) and an open-ended `plesk_max_version` (`18.999.999`). **This
floor has not been verified against a real Plesk instance** — see
`src/platform/plesk/README.md` for the same caveat already documented for the
REST endpoints this package's identity adapter calls (only
`GET /api/v2/domains` is confirmed; the mail-accounts and server-probe
endpoints are the most reasonable guess, not verified).

### Install — run by Plesk itself, not by the operator directly

Plesk runs these hooks as root as part of its own extension lifecycle:

1. **`pre-install.php`** — checks `PHP_OS_FAMILY === 'Linux'` and Node.js ≥
   26 (parsed from `node --version`). A non-zero exit aborts the install with
   this script's stderr shown to the operator; nothing is written yet.
2. **`post-install.php`** — the same steps as the cPanel `install.sh`, driven
   from PHP: creates `.env` from `.env.example` if missing (hints at
   `POSTGRES_*`), runs `npm ci --omit=dev` and the migration step, then
   **always** creates the `gulogulo` system user if missing and installs +
   enables + starts the systemd service — there is no interactive/`--yes`
   distinction here, because this script runs with root privileges
   unconditionally by construction of the Plesk extension mechanism. It also
   writes (never applies) `gulogulo-proxy.conf.example`, an nginx directive
   snippet rewritten to the configured port, applied manually via Plesk's
   Websites & Domains → Apache & nginx Settings → "Additional nginx
   directives".

**No dedicated Plesk upgrade hook exists in this repository.** The packaging
ships only `pre-install.php`, `post-install.php`, and `pre-uninstall.php` — no
`upgrade.php`. Plesk's own extension update mechanism (installing a newer
package version over an already-installed one) is assumed to re-run
`pre-install.php`/`post-install.php` against the new files, which is the
standard shape of a Plesk extension lifecycle, but **this has not been
verified against a real Plesk host** and is a real open question, not a
documented fact. See `doc/upgrade-and-migration.md` for how this affects the
Plesk upgrade story.

### Uninstall (`pre-uninstall.php`)

Stops/disables the systemd service, removes the unit file, and removes the
generated build/dependency directories (`node_modules/`, `dist/`,
`web/dist/`). **Known risk, called out explicitly in the script's own
comments:** once `pre-uninstall.php` returns successfully, Plesk deletes the
extension's entire `plib/` directory itself — including `plib/app/.env`. This
has not been verified against a real Plesk host. The script's own default
(leaving `.env` in place unless `GULOGULO_PLESK_PURGE_ENV=1` is set) is the
safer of the two possible outcomes, but if Plesk does delete `plib/`
regardless, this script cannot prevent the loss of `.env` — **back up `.env`
yourself before uninstalling if you want to keep it.**

### Requirements

Linux Plesk host, Node.js ≥ 26, PostgreSQL optional (same as the other
targets), Plesk Obsidian (18.0.29+, floor unverified) with the modern REST
API v2 reachable locally.

### CI status

**DONE — repository, structure only.** `package-plesk.yml` cannot install a
real extension (no Plesk CLI, extension catalog, or panel-user PHP context on
the `ubuntu-latest` runner, and no suitable official Plesk Docker image). It
verifies the ZIP builds with the exact structure Plesk requires, that
`meta.xml` is well-formed XML with the required fields, and that all three
PHP scripts pass `php -l`. **VERIFY BEFORE USE, in full:** the actual
extension install/upgrade/uninstall cycle on a real Plesk host, the assumed
REST endpoints, the `plesk_min_version` floor, the systemd install, the nginx
reverse-proxy wiring, and especially the `plib/` deletion behavior on
uninstall.

## 5. Cross-cutting known limitations

- **Password authentication on cPanel and Plesk is fail-closed and not
  implemented.** Neither cPanel's UAPI nor Plesk's REST API exposes a
  generic, safe way to verify an arbitrary mail account's password from the
  outside. Rather than build against an undocumented, unverifiable endpoint,
  `authenticate()` on both the `cpanel` and `plesk` identity adapters
  **always returns `false`** and logs why. **LDAP (standalone target only) is
  the only identity source that actually authenticates users today.** Real
  cPanel/Plesk login is future work; the most likely paths, per
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
- [x] **DONE — repository, dry-run only.** The cPanel package builds and its
  installer's argument parsing, precondition handling, and non-destructive
  steps are verified under `--dry-run`. Verify a real cPanel/WHM host: the
  systemd unit, the dedicated system user, and the Apache reverse-proxy
  wiring.
- [x] **DONE — repository, structure only.** The Plesk package builds a
  structurally valid extension ZIP and its PHP lifecycle scripts pass
  `php -l`. Verify a real Plesk host: the actual install/upgrade/uninstall
  cycle, the assumed REST endpoints, the `plesk_min_version` floor, and the
  `plib/` deletion behavior on uninstall.
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
- [x] **DONE — TLS and certificate health contract.** The runtime exposes
  certificate-health metadata and the ACME state contract. Verify the complete
  certificate chain, hostname validation, renewal window, reload behavior,
  expiry alert, and failure recovery with the provider certificate authority.
- [x] **DONE — ACME policy and safe reload boundary.** Let's Encrypt is the
  default provider and a generic ACME profile is supported by contract. Verify
  DNS or HTTP challenge routing, firewall rules, rate limits, account-key
  protection, renewal, and rollback in the real network.
- [x] **DONE — LDAP security boundary (standalone identity).** The adapter
  requires LDAPS or verified StartTLS, uses a secret reference, limits
  requested attributes, builds a tenant-aware filter, rejects ambiguous
  results, and never falls back to a local password store. Verify the real
  CA, bind account permissions, directory indexes, user lookup, password
  bind, timeout, retry, and outage behavior.
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
- [x] **DONE — CalDAV/CardDAV object contracts.** Tenant/user scope,
  conditional writes, opaque ETags, sync tokens, tombstones, bounded
  iCalendar/vCard parsing, and metadata-only export are implemented. Verify
  the persistent DAV backend, XML method adapter, standard clients, sharing
  boundaries, and concurrency.
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
- [x] **DONE — per-target in-place upgrade scripts.** Each of the three
  targets ships its own backup-then-replace upgrade script (or, for Plesk,
  relies on Plesk's own package-replace mechanism); see
  `doc/upgrade-and-migration.md`. Verify each target's real upgrade path end
  to end, including rollback from the backup taken.
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
- [ ] **OPEN CODE — provider-backed browser login and session wiring.** The
  HTTP shell and fixture authenticator are implemented, but the default
  runtime does not yet wire the real LDAP adapter (standalone) into the
  authenticated login/session path, and cPanel/Plesk authentication remains
  fail-closed as described above. This remains repository work.

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
   ACME, Rspamd, ClamAV, storage, network, or an in-place package upgrade.
3. Apply the fail-closed policy for the affected dependency. Preserve the
   current valid certificate, known-good scanner definitions, the pre-upgrade
   backup taken by the target's own upgrade script, queue, and durable state.
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
  timeout/retry, and outage behavior (standalone identity).
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
- Verify each target's install, upgrade, and uninstall scripts on a real host
  of that type — standalone on a plain server/VPS, cPanel on a real
  cPanel/WHM server as root, Plesk through a real Plesk extension
  install/update/remove cycle.

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
- [ ] provider-backed authenticated login/session wiring that calls the real
  LDAP adapter instead of the fixture authenticator (standalone);
- [ ] production Postfix/Dovecot mail adapters, persistent DAV backend, and
  complete HTTP/WebDAV method and XML-report integration;
- [ ] durable external backup, restore, account-deletion execution, and
  scheduled retention workers for volume, PostgreSQL, mailbox, DAV, and
  object-store adapters;
- [ ] provider-specific Plesk/cPanel API adapter and idempotent reconciliation
  behind the validated read-only tenant binding (the optional upstream
  tenant-tool integration);
- [ ] provider ACME/DNS client integration and deployed log collector,
  alert-delivery, and paging adapters.

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
