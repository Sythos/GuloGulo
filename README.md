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
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

<p align="center">
  <img src="assets/gulo-gulo-calendar-mail.png" alt="Wolverine tearing through a calendar and paper correspondence" width="720">
</p>

Gulo Gulo is an OCI-native, mail-first, tenant-isolated groupware platform.
The guiding animal is the wolverine (*Gulo gulo*). Human-facing text uses
**Gulo Gulo**; file names, paths, package names, and other machine-facing
identifiers use **gulogulo** without spaces.

The complete license text is available in [LICENSE](LICENSE). A quick note from
me, Sythos: I had the Gulo Gulo artwork made with AI because I am honestly
hopeless on the artistic side. And, since I have not written a single line of
code comments in roughly a third of a century, the documentation for this
project is entrusted to Enya, my virtual AI agent. She keeps the paperwork
tidy while I focus on making the wolverine do useful things.

## Production readiness checklist

This is the checklist from section 30 of the authoritative specification. A
check mark means that the repository contains an implementation contract and a
passing verification gate for that item; deployment evidence is still required
where the item depends on external infrastructure.

### Security

- [ ] no open relay;
- [x] TLS and certificate health contract verified;
- [x] ACME renewal state and safe-reload contract tested;
- [ ] LDAP uses TLS and minimum bind privilege;
- [ ] PostgreSQL protected and backed up;
- [ ] secret store and rotation configured;
- [x] CSP, CSRF, and security headers;
- [x] email HTML sanitization;
- [x] rate and abuse controls contract tested;
- [x] audit has no secrets;
- [ ] images have SBOM and verified digest.

### Data

- [x] sources of truth documented;
- [x] quota ledger verified;
- [x] 28-day retention tested;
- [x] user backup authorization tested;
- [x] provider backup encrypted;
- [x] restore tested;
- [x] purge idempotent;
- [ ] account deletion runbook approved.

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
- [x] multi-architecture Docker images for Ubuntu 26.04 LTS on amd64 (x86_64) and arm64;
- [x] log rotation;
- [x] alerts;
- [x] Postfix queue visibility;
- [ ] automatic Rspamd/ClamAV updates;
- [x] provider-only migration contract, compatibility window, and rollback state machine;
- [ ] live blue/green rehearsal;
- [ ] live rollback rehearsal;
- [ ] RPO/RTO approved;
- [ ] incident and DR runbooks.

### Governance

- [x] roles and delegation policy approved;
- [x] master log access is off by default;
- [x] API/MCP are read-only;
- [x] future features are not enabled;
- [x] ADRs are current;
- [ ] deployment documentation is complete.

## Repository layout

The tree below is kept current with every repository change. Generated
dependencies and build output are intentionally omitted.

~~~text
gulogulo/
├── .github/
│   └── workflows/
│       ├── commit-tests.yml
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
│   ├── acme-abuse-deployment.md
│   ├── compose-and-fixtures.md
│   ├── configuration.md
│   ├── container-patching.md
│   ├── dav-and-discovery.md
│   ├── identity-and-postgres.md
│   ├── lifecycle-backup-dr.md
│   ├── local-proof-scope.md
│   ├── mail-core.md
│   ├── rbac-admin-mfa.md
│   ├── release-readiness.md
│   ├── observability.md
│   ├── storage-and-quotas.md
│   ├── upgrade-and-migration.md
│   └── web-foundation.md
├── scripts/
│   ├── m0-smoke.ps1
│   ├── m1-fixture-smoke.ps1
│   ├── lp0-scope-audit.mjs
│   ├── m10-release-audit.mjs
│   ├── container-patch.sh
│   └── runtime, fixture, and patch utilities
├── release/
│   ├── local-proof-scope.json
│   └── v1-release-evidence.template.json
├── src/
│   ├── admin/
│   ├── auth/
│   ├── backup/
│   ├── db/migrations/
│   ├── foundation/
│   ├── integrations/
│   ├── lifecycle/
│   ├── mail/
│   ├── observability/
│   ├── release/
│   │   ├── index.mjs
│   │   ├── local-proof-scope.mjs
│   │   ├── local-proof-scope.test.mjs
│   │   ├── release-evidence.mjs
│   │   └── release-evidence.test.mjs
│   ├── ops/
│   │   ├── abuse/
│   │   └── acme/
│   ├── upgrade/
│   │   ├── compatibility.mjs
│   │   ├── control-plane.mjs
│   │   ├── index.mjs
│   │   ├── rollout.mjs
│   │   └── upgrade-contract.test.mjs
│   ├── runtime/
│   ├── dav/
│   │   ├── caldav/
│   │   ├── carddav/
│   │   └── discovery/
│   └── web/
│       ├── backup/
│       ├── content/
│       ├── realtime/
│       └── security/
├── test/
│   └── fixtures/
├── web/
│   ├── README.md
│   ├── build.mjs
│   ├── index.html
│   ├── manifest.json
│   ├── src/
│   └── test/
├── .dockerignore
├── .env.example
├── Dockerfile
├── LICENSE
├── README.md
├── compose.yaml
├── package-lock.json
├── package.json
└── tsconfig.json
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
