<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

# Gulo Gulo

[![Issues](https://img.shields.io/github/issues/Sythos/GuloGulo?label=issues)](https://github.com/Sythos/GuloGulo/issues)
[![Last commit](https://img.shields.io/github/last-commit/Sythos/GuloGulo?label=last%20commit)](https://github.com/Sythos/GuloGulo/commits/main/)
[![Commit tests](https://github.com/Sythos/GuloGulo/actions/workflows/commit-tests.yml/badge.svg)](https://github.com/Sythos/GuloGulo/actions/workflows/commit-tests.yml)
[![PR validation](https://github.com/Sythos/GuloGulo/actions/workflows/pr-validation.yml/badge.svg)](https://github.com/Sythos/GuloGulo/actions/workflows/pr-validation.yml)
[![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/HTML)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Package standalone archive](https://github.com/Sythos/GuloGulo/actions/workflows/package-standalone.yml/badge.svg)](https://github.com/Sythos/GuloGulo/actions/workflows/package-standalone.yml)

<p align="center">
  <img src="assets/gulo-gulo-calendar-mail.png" alt="Wolverine tearing through a calendar and paper correspondence" width="720">
</p>

Gulo Gulo is a mail-first, tenant-isolated groupware platform, distributed as
cPanel, Plesk, and standalone packages built from the same TypeScript core
(see [ADR-002](doc/adr/ADR-002-gulogulo-packaging-and-distribution-targets.md)).
The guiding animal is the wolverine (*Gulo gulo*). Human-facing text uses
**Gulo Gulo**; file names, paths, package names, and other machine-facing
identifiers use **gulogulo** without spaces.

The complete license text is available in [LICENSE](LICENSE).

If a tenant already runs its domain from Plesk or cPanel, Gulo Gulo can sit
behind that panel as an optional upstream tool. The panel may own the hosting
account and DNS workflow; Gulo Gulo still owns groupware policy, identity,
mail, calendar, contacts, quotas, retention, and audit. The integration is
deliberately read-only and tenant-bound today, with provider-specific API
reconciliation kept as a separate backlog item.

## Why three packages, and why these targets

Gulo Gulo used to ship as a single OCI container image (ADR-001). ADR-002
replaced that with three packages built from the same TypeScript core,
because in practice nobody deploys a mail/groupware app the same way twice:
some run it on a hosting panel they already have, some run it on a bare
Linux box they fully control. One generic artifact can't serve both well.

Each package targets the OS its ecosystem actually runs on, and uses that
OS's native package format instead of a generic tarball + shell script,
so the host's own package manager handles dependency resolution, upgrade
tracking, and clean removal instead of Gulo Gulo reinventing it:

- **cPanel → `.rpm`, built and tested on AlmaLinux 9.** cPanel & WHM only
  runs on RHEL-family Linux (AlmaLinux/CloudLinux/RHEL) - there is no such
  thing as "cPanel on Ubuntu". Building and CI-testing on anything else
  would validate a host that doesn't actually exist in cPanel's world.
- **Plesk → `.deb`, built and tested on Debian Trixie.** Plesk officially
  supports Debian/Ubuntu (also RHEL-family and Windows, out of scope here).
  This deliberately does not use Plesk's own extension mechanism
  (`meta.xml` + `plesk bin extension -i`) - the extension format buys UI
  integration this project never wired up anyway, at the cost of not being
  a package the host's own package manager understands.
- **Standalone → `.tar.gz`, built and tested on Ubuntu.** No panel, no OS
  constraint - this is the "any Linux host with Node.js 26+" target, so it
  stays the simplest, most portable format rather than picking one
  distro's native package for a target that isn't distro-specific.

See [ADR-002](doc/adr/ADR-002-gulogulo-packaging-and-distribution-targets.md)
for the full architectural rationale.

## Quickstart

Full instructions, requirements, and known gaps for each target are in
[INSTALL.md](INSTALL.md) - this is the short version.

**Standalone** (any Linux host, Node.js 26+):

```bash
node --experimental-strip-types packaging/standalone/build-standalone-package.ts
tar xzf packaging/dist/gulogulo-<version>-standalone.tar.gz -C /opt/gulogulo
cd /opt/gulogulo && ./install.sh
```

**cPanel** (RHEL-family host - AlmaLinux/CloudLinux/RHEL - with root/WHM
access; ships as a real `.rpm`, built and installed at a fixed
`/opt/gulogulo`, and Node.js 26+ must already be installed, see
INSTALL.md):

```bash
node --experimental-strip-types packaging/cpanel/build-cpanel-package.ts
sudo dnf install ./packaging/dist/gulogulo-<version>-1*.rpm
```

**Plesk** (Debian/Ubuntu host; ships as a real `.deb`, not a Plesk extension
- root access required, and Node.js 26+ must already be installed, see
INSTALL.md):

```bash
node --experimental-strip-types packaging/plesk/build-plesk-package.ts
sudo apt install ./packaging/dist/gulogulo_<version>_all.deb
```

Only the standalone archive has a real end-to-end install-and-health-check
rehearsal today (in CI, on a clean runner). The cPanel `.rpm` and Plesk
`.deb` build and their structure is verified (each additionally gets a real
partial extraction/unpack inside its target OS's CI container - `almalinux:9`
for cPanel, `debian:trixie` for Plesk), but completing an install on a real
host is still field work - see the honesty notes in INSTALL.md before
relying on either in production.

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
- [x] cPanel, Plesk, and standalone packages build and their structure is
  verified in CI; only the standalone archive has a real install-and-health-
  check rehearsal today, tracked in [INSTALL.md](INSTALL.md);
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
  password authentication for cPanel/Plesk mailboxes and MySQL/MariaDB support
  remain backlog, documented in each adapter's README;
- [x] wire the CPANEL_API_*/PLESK_API_* settings from .env.example into
  runtime/config.ts's loader (same file/env pattern as ldap/postgres);
- [ ] provider-backed authenticated login/session wiring to the real LDAP
  adapter;
- [ ] production Postfix/Dovecot mail adapters, persistent DAV backend, and
  complete HTTP/WebDAV method and XML-report integration;
- [ ] durable external backup, restore, account-deletion execution, and
  scheduled retention workers;
- [ ] deployed log collector, alert-delivery, and paging adapters (the ACME/DNS
  client that used to be paired with this item was removed architecturally -
  cPanel/Plesk own certificate issuance via their AutoSSL/Let's Encrypt
  integration, and standalone doesn't configure a reverse proxy at all - so it
  is no longer a backlog gap).

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
│   ├── cpanel/ (build-cpanel-package.ts, gulogulo.spec, systemd unit + reverse-proxy example)
│   └── plesk/ (build-plesk-package.ts, debian/DEBIAN/ control + maintainer scripts)
├── scripts/
│   ├── lp3-proof-smoke.ts (+ .mjs compatibility bridge)
│   ├── lp4-proof-check.ts
│   ├── lp5-proof-check.ts
│   ├── lp6-source-fixture.ts
│   ├── lp6-backup-worker.ts
│   ├── lp6-restore-worker.ts
│   ├── lp7-proof-check.ts
│   ├── m10-release-audit.ts (+ .mjs compatibility bridge)
│   ├── sbom-release-audit.ts
│   ├── sbom-release-audit.test.ts
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
│   │   ├── standalone/ (LDAP + PostgreSQL adapter)
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
