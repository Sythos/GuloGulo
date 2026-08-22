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

<p align="center">
  <img src="assets/gulo-gulo-calendar-mail.png" alt="Wolverine tearing through a calendar and paper correspondence" width="720">
</p>

Gulo Gulo is an OCI-native, mail-first, tenant-isolated groupware platform.
The guiding animal is the wolverine (*Gulo gulo*). Human-facing text uses
**Gulo Gulo**; file names, paths, package names, and other machine-facing
identifiers use **gulogulo** without spaces. Documentation, source code,
variables, configuration, tests, and notes are written in English.

The complete license text is available in [LICENSE](LICENSE). The authoritative
product specification is maintained beside this checkout as `GULOGULO.md`.

## Production readiness checklist

This is the checklist from section 30 of the authoritative specification. A
check mark means that the repository contains an implementation contract and a
passing verification gate for that item; deployment evidence is still required
where the item depends on external infrastructure.

### Security

- [ ] no open relay;
- [ ] TLS and certificates verified;
- [ ] ACME renewal tested;
- [ ] LDAP uses TLS and minimum bind privilege;
- [ ] PostgreSQL protected and backed up;
- [ ] secret store and rotation configured;
- [x] CSP, CSRF, and security headers;
- [x] email HTML sanitization;
- [ ] rate and abuse controls;
- [ ] audit has no secrets;
- [ ] images have SBOM and verified digest.

### Data

- [x] sources of truth documented;
- [x] quota ledger verified;
- [ ] 28-day retention tested;
- [x] user backup authorization tested;
- [ ] provider backup encrypted;
- [ ] restore tested;
- [ ] purge idempotent;
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
- [ ] log rotation;
- [ ] alerts;
- [x] Postfix queue visibility;
- [ ] automatic Rspamd/ClamAV updates;
- [ ] blue/green rehearsal;
- [ ] rollback test;
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
│   ├── compose-and-fixtures.md
│   ├── configuration.md
│   ├── container-patching.md
│   ├── dav-and-discovery.md
│   ├── identity-and-postgres.md
│   ├── mail-core.md
│   ├── observability.md
│   ├── storage-and-quotas.md
│   ├── upgrade-and-migration.md
│   └── web-foundation.md
├── scripts/
│   └── runtime, fixture, and patch utilities
├── src/
│   ├── db/migrations/
│   ├── foundation/
│   ├── integrations/
│   ├── mail/
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

Use the latest stable release of every package, library, action, runtime,
image, and external software dependency. Exact resolved versions are recorded
in the lockfile and in the relevant documentation. Never commit secrets,
credentials, private keys, or real user data.

GitHub Actions run the same read-only quality gates for pushed commits and pull
requests from both internal branches and external forks. A contribution must
pass the applicable checks, preserve tenant isolation and source-of-truth
boundaries, and update this directory tree whenever files are added or moved.

Gulo Gulo is released under the MIT License.
