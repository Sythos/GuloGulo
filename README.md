<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

# Gulo Gulo

<p align="center">
  <img src="assets/gulo-gulo-calendar-mail.png" alt="Wolverine tearing through a calendar and paper correspondence" width="720">
</p>

[![Issues](https://img.shields.io/github/issues/Sythos/GuloGulo?label=issues)](https://github.com/Sythos/GuloGulo/issues)
[![Last commit](https://img.shields.io/github/last-commit/Sythos/GuloGulo?label=last%20commit)](https://github.com/Sythos/GuloGulo/commits/main/)
[![Commit tests](https://github.com/Sythos/GuloGulo/actions/workflows/commit-tests.yml/badge.svg)](https://github.com/Sythos/GuloGulo/actions/workflows/commit-tests.yml)
[![PR validation](https://github.com/Sythos/GuloGulo/actions/workflows/pr-validation.yml/badge.svg)](https://github.com/Sythos/GuloGulo/actions/workflows/pr-validation.yml)

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/HTML)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/Bun-F472B6?logo=bun&logoColor=white)](https://bun.sh/)
[![Package standalone archive](https://github.com/Sythos/GuloGulo/actions/workflows/package-standalone.yml/badge.svg)](https://github.com/Sythos/GuloGulo/actions/workflows/package-standalone.yml)

Gulo Gulo is a mail-first, tenant-isolated groupware platform, distributed as
cPanel, Plesk, and standalone packages built from the same TypeScript core
(see ADR-002). The guiding animal is the wolverine (*Gulo gulo*).
Human-facing text uses **Gulo Gulo**; file names, paths, package names, and
other machine-facing identifiers use **gulogulo** without spaces.

The complete license text is available in [LICENSE](LICENSE).

If a tenant already runs its domain from Plesk or cPanel, Gulo Gulo can sit
behind that panel as an optional upstream tool. The panel may own the hosting
account and DNS workflow; Gulo Gulo still owns groupware policy, identity,
mail, calendar, contacts, quotas, retention, and audit. The integration is
deliberately read-only and tenant-bound today, with provider-specific API
reconciliation kept as a separate backlog item.

## Why three packages, and why these targets

Gulo Gulo used to ship as a single all-in-one deployment (ADR-001). ADR-002
replaced that with three OS-native packages built from the same TypeScript
core, because in practice nobody deploys a mail/groupware app the same way
twice: some run it on a hosting panel they already have, some run it on a
bare Linux box they fully control. One generic artifact can't serve both
well.

Each package targets the OS its ecosystem actually runs on. The
cPanel/Plesk targets have a real, OS-native package format fully
implemented (`.rpm` for cPanel, `.deb` for Plesk - see below), but **all
three targets currently ship as a plain `.tar.gz` + shell scripts**: this
project does not yet have a code-signing key/certificate for RPM/DEB
packages, and publishing an unsigned package through a host's package
manager (`dnf install`/`apt install`) is a worse trust signal than an
unsigned tar.gz - a package-manager install implies the artifact went
through a normal, curated channel, while a plain archive the operator
downloads and extracts themselves communicates "verify this yourself" far
more clearly. The RPM/DEB code is not deleted; it is one call away from
being re-enabled once a signing key exists (see
`packaging/cpanel/build-cpanel-package.ts` and
`packaging/plesk/build-plesk-package.ts`'s top-of-file comments).

- **cPanel → `gulogulo-<version>_cpanel_.tar.gz`, built and tested on
  AlmaLinux 9.** cPanel & WHM only runs on RHEL-family Linux
  (AlmaLinux/CloudLinux/RHEL) - there is no such thing as "cPanel on
  Ubuntu". Building and CI-testing on anything else would validate a host
  that doesn't actually exist in cPanel's world. A real `.rpm` pipeline
  (`packaging/cpanel/gulogulo.spec`, built with `rpmbuild`) already exists
  and is verified to build correctly, but is not published while unsigned.
- **Plesk → `gulogulo-<version>_plesk_.tar.gz`, built and tested on Debian
  Trixie.** Plesk officially supports Debian/Ubuntu (also RHEL-family and
  Windows, out of scope here). This does not use Plesk's own extension
  mechanism (`meta.xml` + `plesk bin extension -i`) - the extension format
  buys UI integration this project never wired up anyway, at the cost of
  not being a package the host's own package manager understands. A real
  `.deb` pipeline (`packaging/plesk/debian/`, built with `dpkg-deb`)
  already exists and is verified to build correctly, but is not published
  while unsigned.
- **Standalone → `.tar.gz`, built and tested on Ubuntu.** No panel, no OS
  constraint - this is the "any Linux host with Node.js 26+" target (Bun
  1.4.0+ is also supported as the runtime, interchangeable with Node.js
  anytime after install via `switch-runtime.sh`), so it stays the
  simplest, most portable format rather than picking one
  distro's native package for a target that isn't distro-specific. This
  target was never RPM/DEB-based, so it is unaffected by the signing-key
  gap above.

## Quickstart

Full instructions, requirements, and known gaps for each target are in
[INSTALL.md](INSTALL.md) - this is the short version. Every target also
needs a local mail server reachable on `127.0.0.1` for SMTP and IMAP -
Gulo Gulo only ever connects to it as a client, on localhost; see
INSTALL.md for what "reachable" actually depends on (TCP/25 is not
guaranteed just because the host is up).

**Standalone** (any Linux host, Node.js 26+ - Bun 1.4.0+ also supported as
the runtime, interchangeable with Node.js anytime after install; the build
step below always uses Node.js regardless of which runtime you pick):

```bash
node --experimental-strip-types packaging/standalone/build-standalone-package.ts
mkdir -p /opt/gulogulo
tar xzf packaging/dist/gulogulo-<version>-standalone.tar.gz -C /opt/gulogulo --strip-components=1
cd /opt/gulogulo && ./install.sh
# or, to run the server under Bun instead of Node.js: ./install.sh --runtime=bun
```

**cPanel** (RHEL-family host - AlmaLinux/CloudLinux/RHEL - with root/WHM
access; ships as a `.tar.gz` while the RPM pipeline is unsigned - see "Why
three packages" above - and Node.js 26+ must already be installed, see
INSTALL.md; Bun 1.4.0+ is also supported as the runtime, interchangeable
with Node.js anytime after install):

```bash
node --experimental-strip-types packaging/cpanel/build-cpanel-package.ts
sudo mkdir -p /opt/gulogulo
sudo tar xzf packaging/dist/gulogulo-<version>_cpanel_.tar.gz -C /opt/gulogulo --strip-components=1
cd /opt/gulogulo && sudo ./install.sh
# or, to run the server under Bun instead of Node.js: sudo ./install.sh --runtime=bun
```

**Plesk** (Debian/Ubuntu host; ships as a `.tar.gz` while the DEB pipeline
is unsigned - see "Why three packages" above - root access required, and
Node.js 26+ must already be installed, see INSTALL.md; Bun 1.4.0+ is also
supported as the runtime, interchangeable with Node.js anytime after
install):

```bash
node --experimental-strip-types packaging/plesk/build-plesk-package.ts
sudo mkdir -p /opt/gulogulo
sudo tar xzf packaging/dist/gulogulo-<version>_plesk_.tar.gz -C /opt/gulogulo --strip-components=1
cd /opt/gulogulo && sudo ./install.sh
# or, to run the server under Bun instead of Node.js: sudo ./install.sh --runtime=bun
```

All three archives now get a real end-to-end install-and-health-check
rehearsal in CI: each package-*.yml workflow extracts the tarball, runs
`install.sh --non-interactive` for real (dedicated system user, `npm ci`,
migrations), starts the compiled server, and polls `/health/ready` and `/`
until they respond. The cPanel and Plesk workflows additionally run inside
a real target-OS environment (`almalinux:9`, `debian:trixie`) and stub only
`systemctl` (those CI environments have no running init system for it to
talk to) - actually enabling/starting the systemd unit, and the Apache/nginx
reverse-proxy wiring, remain field work on a real host; see the honesty
notes in INSTALL.md before relying on either in production.

## Production readiness checklist

This is the implementation checklist derived from section 30 of the
authoritative specification. A check mark means that the repository contains
the relevant code, contract, or runbook and its repository gate passes.
Deployment and field evidence do not keep an implementation item open: they are
tracked in [INSTALL.md](INSTALL.md) and the release evidence
record. An unchecked item means that repository code or release automation is
still missing.

### Security

- [x] no open relay;
- [x] LDAP uses TLS and minimum bind privilege;
- [x] PostgreSQL protected and backed up;
- [x] secret store and rotation configured through an allowlisted, versioned
  rotation/expiry/rollback contract with tested versioned-file adapters;
- [x] CSP, CSRF, and security headers;
- [x] secure web sessions, generic login failures, and login rate limits;
- [x] email HTML sanitization;
- [x] rate and abuse controls contract tested;
- [x] audit has no secrets;
- [x] SHA256 checksum sidecar and aggregated checksums.txt for the cPanel,
  Plesk, and standalone archives, verified in each package-*.yml CI job
  before upload; GPG/minisign signing not built yet.

### Data

- [x] sources of truth documented;
- [x] quota ledger verified;
- [x] 28-day retention tested;
- [x] user backup authorization tested;
- [x] provider backup encrypted;
- [x] restore tested;
- [x] purge idempotent;
- [x] account deletion runbook defined; provider approval and rehearsal are
  tracked in INSTALL.md.

### Interoperability

- [x] SMTP and IMAP;
- [x] IMAP IDLE;
- [x] Sieve;
- [x] aliases;
- [x] CalDAV contract and conditional object semantics;
- [x] CardDAV contract and conditional object semantics;
- [x] .well-known resources;
- [x] autodiscovery contract with safe manual fallback;
- [x] ICS/vCard validation and metadata export;
- [x] timezone behavior.

### Operations

- [x] health and metrics;
- [x] dual-stack IPv4 and IPv6 network support;
- [x] persistent external mail storage and restart continuity;
- [x] offline synthetic LP2 LDAP and PostgreSQL dependency proof with verified TLS;
- [x] offline synthetic mail proof with Postfix, Dovecot, Rspamd, and ClamAV;
- [x] offline synthetic web/session/DAV/discovery proof with restart continuity;
- [x] fast CI on Ubuntu 26.04 LTS (AMD64);
- [x] tenant-bound DAV ETags and sync tokens;
- [x] cPanel, Plesk, and standalone packages all ship as `.tar.gz` today
  (RPM/DEB code exists and builds correctly but is not published unsigned -
  see "Why three packages" above) and each gets a real install-and-health-
  check rehearsal in CI (`install.sh --non-interactive`, server boot,
  `/health/ready`); on cPanel/Plesk the systemd enable/start step is stubbed
  since their CI environments have no init system, tracked in
  [INSTALL.md](INSTALL.md);
- [x] provenance and release permissions are granted only by version-tag pushes
  or trusted manual callers, while pull-request validation remains read-only;
- [x] log rotation;
- [x] alerts;
- [x] Postfix queue visibility;
- [x] capacity contract tested;
- [x] fail-closed disposable patch helper and sanitized read-only patch status;
- [x] externally managed Rspamd/ClamAV definition updates through a shared
  read-only signature volume with freshness, atomic activation, and rollback
  metadata; provider updater execution is tracked in INSTALL.md;
- [x] provider-only migration contract, compatibility window, and rollback state machine;
- [x] in-place upgrade scripts for all three packaging targets (backup,
  replace, migrate, restart); field rehearsal on cPanel/Plesk is tracked in
  INSTALL.md;
- [x] in-place upgrade and rollback runbook defined; live rehearsal is
  tracked in INSTALL.md;
- [x] RPO/RTO contract defined; measured objectives and approval are tracked
  in INSTALL.md;
- [x] incident and DR runbooks defined; tabletop and deployment evidence are
  tracked in INSTALL.md.

### Governance

- [x] roles and delegation policy approved;
- [x] master log access is off by default;
- [x] API/MCP are read-only;
- [x] future features are not enabled;
- [x] ADRs are current;
- [x] canonical TypeScript source tree audited, with a single build boundary and zero compatibility bridges;
- [x] optional upstream Plesk/cPanel tenant-tool contract with safe binding and
  read-only capabilities;
- [x] deployment documentation is complete for the packaging hand-off in
  [INSTALL.md](INSTALL.md); field verification on real
  cPanel and Plesk hosts remains an external release responsibility.

## Repository implementation backlog

The production checklist above is intentionally about repository work. These
are the only remaining unchecked implementation items; field verification for
the checked contracts belongs in [INSTALL.md](INSTALL.md).

- [x] provider-neutral secret-store contract and managed versioned-file rotation;
- [x] package checksum (SHA256) and verification gate for the cPanel, Plesk,
  and standalone archives; signing (GPG/minisign) not built yet;
- [x] cPanel and Plesk PlatformAdapter implementations (identity via UAPI/REST,
  data via the existing PostgreSQL store, packaging pipeline for both) - real
  password authentication for cPanel/Plesk mailboxes now works via IMAP LOGIN
  against the local mail server (neither panel API exposes a safe password
  check), verified with an injected fake IMAP client; a real cPanel/Plesk host
  rehearsal and MySQL/MariaDB support remain backlog, documented in each
  adapter's README;
- [x] a lazy, per-session IMAP IDLE capability check
  (`src/core/mail/imap-idle-probe.ts`, `GET /api/mail/idle-status`) reusing an
  encrypted, session-scoped copy of the login password
  (`src/web/security/session-credential.ts`, AES-256-GCM under a key derived
  from the session ID); the webmail UI shows a notice and falls back to a
  configurable auto-refresh timer when IDLE is unavailable — see INSTALL.md's
  "IMAP IDLE availability" for the full behavior;
- [x] wire the CPANEL_API_*/PLESK_API_* settings from .env.example into
  runtime/config.ts's loader (same file/env pattern as ldap/postgres);
- [x] provider-backed authenticated login/session wiring (src/runtime/login.ts)
  that resolves the configured packaging target and calls its real
  PlatformAdapter identity client — LDAP or DB-backed local_users for
  standalone, UAPI for cPanel, REST for Plesk — instead of the fixture
  authenticator; field verification against real backends belongs in
  INSTALL.md;
- [ ] production mail server adapters: minimal IMAP IDLE and SMTP submission
  protocol clients and their adapters (`src/core/mail/imap-client.ts`,
  `src/core/mail/imap-idle-adapter.ts`, `src/core/mail/smtp-client.ts`,
  `src/core/mail/smtp-queue-adapter.ts`) are RFC-compliant and
  implementation-agnostic (they depend on no vendor-specific behavior, only
  standard SMTP and IMAP4rev1 + the IDLE extension) and are implemented and
  tested end to end against a local TCP protocol fake (see
  `doc/mail-core.md`); verification against a real SMTP/IMAP server
  installation (Postfix/Exim + Dovecot are the common examples) is still
  outstanding;
- [x] persistent DAV backend: PostgreSQL-backed CalDAV/CardDAV storage
  (`src/core/dav/caldav/postgres-caldav-store.ts`,
  `src/core/dav/carddav/postgres-carddav-store.ts`,
  `src/core/db/migrations/0003_dav_storage.sql`), reusing the pure in-memory
  contracts' own ETag/sync-token functions so the two implementations cannot
  drift; tested against a fake pool (see `doc/dav-and-discovery.md`) —
  verification against a real PostgreSQL instance and real CalDAV/CardDAV
  clients is still outstanding;
- [x] HTTP/WebDAV method and XML-report integration: `src/runtime/server.ts`
  now routes `PROPFIND`/`GET`/`PUT`/`DELETE`/`REPORT` under
  `/dav/calendars/{tenantId}/{ownerUserId}/{collectionId}/...` and
  `/dav/contacts/{tenantId}/{userId}/{addressBookId}/...` to the real
  `PlatformAdapter.createDavStore()` Postgres-backed stores, authenticated by
  the same session cookie as `/api/*` (see `doc/dav-and-discovery.md` for the
  method-by-method coverage); tested end to end against a fake pool
  (`src/runtime/dav-runtime.test.ts`) — verification against a real
  PostgreSQL instance and a real CalDAV/CardDAV client (Apple Calendar,
  Thunderbird, DAVx5, ...) is still outstanding, and calendar/address-book
  *creation* (`MKCOL`/`MKCALENDAR`) is still not exposed over HTTP;
- [x] local filesystem backup adapter and account-deletion/purge wiring:
  `src/core/backup/filesystem-backup-adapter.ts` really writes
  manifests/archives/encrypted metadata to disk, `createBackupStorage()` on
  every `PlatformAdapter` returns it with a `/var/lib/gulogulo/backups`
  default, and `src/core/lifecycle/account-lifecycle-wiring.ts` connects
  account-purge transitions to it plus `retention.ts`'s `runPurgeBatch()`
  (a CLI entry point and systemd timer/service now exist too — see
  `doc/lifecycle-backup-dr.md`); still outstanding: a **remote/external**
  storage adapter (this local one is fast same-host recovery, explicitly
  not disaster recovery), and a **persistent** retention store (today's is
  in-memory, so the scheduled worker is a safe no-op);
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
  every current, OS-native target already captures and rotates the
  stdout/stderr JSON log stream; paging reuses the same webhook mechanism
  with `alerting.minSeverity: 'critical'`, no dedicated paging adapter
  exists or is needed. Still outstanding: nothing in the runtime yet calls
  `alert-policy.ts`'s `evaluate()` on a periodic snapshot and feeds the
  result to the delivery adapter (the wiring point,
  `deliverAlertEvaluation()`, exists and is tested, but nothing schedules
  it), and none of this has been verified against a real Slack/Discord/
  PagerDuty endpoint.

## Repository layout

The tree below is kept current with every repository change. Generated
dependencies and build output are intentionally omitted.

~~~text
gulogulo/
├── .github/
│   └── workflows/
│       ├── commit-tests.yml
│       ├── package-cpanel.yml
│       ├── package-plesk.yml
│       ├── package-standalone.yml
│       ├── pr-validation.yml
│       └── quality-gates.yml
├── assets/
│   ├── README.md
│   └── gulo-gulo-calendar-mail.png
├── config/
│   └── schema.v1.json
├── doc/
│   ├── README.md
│   ├── api-and-mcp.md
│   ├── abuse-deployment.md
│   ├── control-panel-integration.md
│   ├── configuration.md
│   ├── dav-and-discovery.md
│   ├── identity-and-postgres.md
│   ├── lifecycle-backup-dr.md
│   ├── mail-core.md
│   ├── rbac-admin-mfa.md
│   ├── release-readiness.md
│   ├── scanner-signature-volume.md
│   ├── server-typescript.md
│   ├── observability.md
│   ├── storage-and-quotas.md
│   ├── upgrade-and-migration.md
│   └── web-foundation.md
├── packaging/
│   ├── shared/ (staging + tar/deb/rpm package-building helpers shared by all three build scripts)
│   ├── standalone/ (build-standalone-package.ts, install/upgrade/uninstall.sh)
│   ├── cpanel/ (build-cpanel-package.ts + scripts/install-upgrade-uninstall.sh (active);
│   │   gulogulo.spec (RPM pipeline, implemented, not currently published - see README))
│   └── plesk/ (build-plesk-package.ts + scripts/install-upgrade-uninstall.sh (active);
│       debian/DEBIAN/ (DEB pipeline, implemented, not currently published - see README))
├── scripts/
│   ├── lp3-proof-smoke.ts (+ .mjs compatibility bridge)
│   ├── lp4-proof-check.ts
│   ├── lp5-proof-check.ts
│   ├── lp6-source-fixture.ts
│   ├── lp6-backup-worker.ts
│   ├── lp6-restore-worker.ts
│   ├── lp7-proof-check.ts
│   ├── m10-release-audit.ts (+ .mjs compatibility bridge)
│   └── runtime and fixture utilities
├── release/
│   ├── local-proof-scope.json
│   ├── local-proof-topology.json
│   ├── lp2-local-services.json
│   ├── lp3-local-mail.json
│   ├── lp4-local-web.json
│   ├── lp5-local-operations-capacity.json
│   ├── lp6-local-backup-dr.json
│   ├── lp7-local-upgrade.json
│   ├── lp8-local-proof-bundle.json
│   └── v1-release-evidence.template.json
├── src/
│   ├── core/
│   │   ├── admin/ (TypeScript RBAC, delegation, quota, and admin tools)
│   │   ├── auth/ (TypeScript password, TOTP, WebAuthn, and recovery contracts)
│   │   ├── backup/
│   │   │   ├── backup-contract.ts
│   │   │   ├── backup-contract.test.ts
│   │   │   └── index.ts
│   │   ├── capacity/ (typed bounded local-proof measurement contracts)
│   │   ├── dav/
│   │   │   ├── caldav/ (strict TypeScript CalDAV contract and tests)
│   │   │   ├── carddav/ (strict TypeScript CardDAV contract and tests)
│   │   │   └── discovery/ (strict TypeScript discovery and tests)
│   │   ├── db/migrations/
│   │   ├── foundation/
│   │   ├── lifecycle/
│   │   │   ├── account-lifecycle.ts
│   │   │   ├── account-lifecycle.test.ts
│   │   │   ├── index.ts
│   │   │   ├── retention.ts
│   │   │   └── retention.test.ts
│   │   ├── mail/
│   │   │   ├── imap-idle.ts
│   │   │   ├── imap-idle.test.ts
│   │   │   ├── mail-core.ts
│   │   │   ├── mail-core.test.ts
│   │   │   ├── mail-policy.ts
│   │   │   ├── mail-queue.ts
│   │   │   ├── mail-scanners.ts
│   │   │   ├── mail-scanners.test.ts
│   │   │   ├── scanner-signatures.ts
│   │   │   └── scanner-signatures.test.ts
│   │   ├── observability/
│   │   ├── ops/
│   │   │   ├── abuse/ (typed rate and abuse controls)
│   │   │   └── patch/ (typed sanitized patch-status contract)
│   │   ├── release/
│   │   │   ├── index.ts
│   │   │   ├── local-proof-scope.ts
│   │   │   ├── local-proof-scope.test.ts
│   │   │   ├── local-proof-topology.ts
│   │   │   ├── local-proof-topology.test.ts
│   │   │   ├── release-evidence.ts
│   │   │   └── release-evidence.test.ts
│   │   ├── secrets/ (typed provider-neutral secret-store, rotation, and versioned-file adapters)
│   │   └── upgrade/
│   │       ├── compatibility.ts
│   │       ├── index.ts
│   │       └── upgrade-contract.test.ts
│   ├── integrations/ (TypeScript LDAP, PostgreSQL, tenant, migration, and optional Plesk/cPanel adapters)
│   ├── platform/
│   │   ├── contract/ (PlatformAdapter interface)
│   │   ├── standalone/ (LDAP or DB-backed local_users identity + PostgreSQL adapter)
│   │   ├── cpanel/ (UAPI identity client + adapter)
│   │   └── plesk/ (REST identity client + adapter)
│   ├── runtime/ (TypeScript HTTP runtime and observability)
│   └── web/
│       ├── backup/ (typed user backup boundary)
│       ├── content/ (typed sanitization, attachment, and timezone policies)
│       ├── realtime/ (typed metadata-only event normalization)
│       └── security/ (typed sessions, cookies, and CSRF)
├── test/
│   └── fixtures/
│       └── scanner-signatures/ (offline shared-volume fixture)
├── web/
│   ├── README.md
│   ├── build.mjs
│   ├── build.ts
│   ├── index.html
│   ├── manifest.json
│   ├── src/
│   └── test/
│       └── web-shell.test.ts
├── .env.example
├── INSTALL.md
├── LICENSE
├── README.md
├── package-lock.json
├── package.json
├── tsconfig.json
├── tsconfig.lp4.json
├── tsconfig.lp5.json
├── tsconfig.lp6.json
├── tsconfig.lp7.json
├── tsconfig.lp8.json
└── tsconfig.server.json
~~~

## Development and contribution

I keep dependencies, actions, runtimes, images, and external tools on their
latest stable releases; the lockfile and the companion docs record the exact
versions that were resolved. Please keep secrets, credentials, private keys,
and real user data out of commits entirely.

Every pushed commit and every pull request, whether it comes from an internal
branch or an external fork, goes through the same read-only quality gates. A
change is ready when those checks are green, tenant isolation and source-of-
truth boundaries are still intact, and the repository tree in this README has
been kept in sync with any files that were added or moved.

That is the whole spirit of the project: make a focused change, explain the
interesting bits, run the checks, and leave the next person a tidy trail to
follow. Gulo Gulo is released under the MIT License.
