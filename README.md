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

LP5 is complete at the bounded synthetic operations and capacity boundary. Its
local operations, patch-state, abuse, observability, and capacity contracts
passed the integrated GitHub AMD64 Compose proof, followed by the final ARM64
artifact and attestation gate. This remains local-proof evidence, not a claim
of production capacity or external service interoperability.

LP6 is implemented at the bounded local backup, restore, retention, and
disaster-recovery boundary. Its synthetic proof is now being validated through
the AMD64-first GitHub gate, followed by the explicit ARM64 artifact gate;
until both are green, LP6 is not marked as a completed release milestone. This
is still local synthetic evidence, not a production backup, storage, or RPO/RTO
claim.

### Security

- [x] no open relay;
- [x] TLS and certificate health contract verified;
- [x] ACME renewal state and safe-reload contract tested;
- [ ] LDAP uses TLS and minimum bind privilege;
- [ ] PostgreSQL protected and backed up;
- [ ] secret store and rotation configured;
- [x] CSP, CSRF, and security headers;
- [x] secure web sessions, generic login failures, and login rate limits;
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
- [x] dual-stack IPv4 and IPv6 network support;
- [x] persistent external mail volumes and restart continuity;
- [x] offline synthetic LP2 LDAP and PostgreSQL dependency proof with verified TLS;
- [x] offline synthetic mail proof with Postfix, Dovecot, Rspamd, and ClamAV;
- [x] offline synthetic web/session/DAV/discovery proof with restart continuity;
- [x] fast amd64-first CI with an explicit multiarch amd64+arm64 final gate;
- [x] tenant-bound DAV ETags and sync tokens;
- [x] OCI build-provenance attestations generated and verified;
- [x] provenance permissions are granted only by push or manual callers, while pull-request validation remains read-only;
- [x] log rotation;
- [x] alerts;
- [x] Postfix queue visibility;
- [x] bounded LP5 operations and capacity proof (AMD64 Compose first, ARM64 final artifact gate);
- [x] fail-closed disposable patch helper and sanitized read-only patch status;
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
├── docker/
│   ├── lp1-network/
│   │   ├── Dockerfile
│   │   ├── entrypoint-ca.sh
│   │   └── entrypoint-dns.sh
│   ├── lp2-tls/
│   │   ├── .dockerignore
│   │   ├── Dockerfile
│   │   └── entrypoint-tls.sh
│   ├── lp2-ldap/
│   │   ├── .dockerignore
│   │   ├── Dockerfile
│   │   ├── bootstrap.ldif
│   │   ├── entrypoint-ldap.sh
│   │   └── healthcheck-ldap.sh
│   ├── lp2-postgres/
│   │   ├── .dockerignore
│   │   ├── Dockerfile
│   │   ├── entrypoint-postgres.sh
│   │   └── healthcheck-postgres.sh
│   ├── lp3-clamav/
│   │   ├── .dockerignore
│   │   ├── Dockerfile
│   │   ├── entrypoint-clamav.py
│   │   └── healthcheck-clamav.sh
│   ├── lp3-dovecot/
│   │   ├── .dockerignore
│   │   ├── Dockerfile
│   │   ├── default.sieve
│   │   ├── dovecot.conf
│   │   ├── entrypoint-dovecot.sh
│   │   ├── healthcheck-dovecot.sh
│   │   └── users
│   ├── lp3-postfix/
│   │   ├── .dockerignore
│   │   ├── Dockerfile
│   │   ├── entrypoint-postfix.sh
│   │   ├── healthcheck-postfix.sh
│   │   ├── lp3-aliases.regexp
│   │   ├── lp3-mailboxes.regexp
│   │   └── main.cf
│   ├── lp3-proof/
│   │   ├── .dockerignore
│   │   ├── Dockerfile
│   │   └── proof.py
│   ├── lp3-rspamd/
│   │   ├── .dockerignore
│   │   ├── Dockerfile
│   │   ├── entrypoint-rspamd.py
│   │   └── healthcheck-rspamd.sh
│   └── lp3-tls/
│       ├── .dockerignore
│       ├── Dockerfile
│       └── entrypoint-tls.sh
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
│   ├── local-proof-topology.md
│   ├── lp2-local-services.md
│   ├── lp3-local-mail.md
│   ├── lp4-local-web.md
│   ├── lp5-local-operations-capacity.md
│   ├── lp6-local-backup-dr.md
│   ├── mail-core.md
│   ├── rbac-admin-mfa.md
│   ├── release-readiness.md
│   ├── server-typescript.md
│   ├── observability.md
│   ├── storage-and-quotas.md
│   ├── upgrade-and-migration.md
│   └── web-foundation.md
├── scripts/
│   ├── m0-smoke.ps1
│   ├── m1-fixture-smoke.ps1
│   ├── lp0-scope-audit.mjs
│   ├── lp1-compose-audit.mjs
│   ├── lp1-proof-check.mjs
│   ├── lp1-proof-smoke.mjs
│   ├── lp2-compose-audit.mjs
│   ├── lp2-compose-smoke.mjs
│   ├── lp2-proof-smoke.mjs
│   ├── lp3-compose-audit.mjs
│   ├── lp3-compose-smoke.mjs
│   ├── lp3-proof-smoke.mjs
│   ├── lp4-compose-audit.ts
│   ├── lp4-compose-smoke.ts
│   ├── lp4-proof-check.ts
│   ├── lp4-web-runtime.ts
│   ├── lp5-capacity-smoke.ts
│   ├── lp5-compose-audit.ts
│   ├── lp5-compose-smoke.ts
│   ├── lp5-proof-check.ts
│   ├── lp6-source-fixture.ts
│   ├── lp6-backup-worker.ts
│   ├── lp6-restore-worker.ts
│   ├── lp6-compose-audit.ts
│   ├── lp6-compose-smoke.ts
│   ├── m10-release-audit.mjs
│   ├── container-patch.sh
│   └── runtime, fixture, and patch utilities
├── release/
│   ├── local-proof-scope.json
│   ├── local-proof-topology.json
│   ├── lp2-local-services.json
│   ├── lp3-local-mail.json
│   ├── lp4-local-web.json
│   ├── lp5-local-operations-capacity.json
│   ├── lp6-local-backup-dr.json
│   └── v1-release-evidence.template.json
├── src/
│   ├── admin/ (TypeScript RBAC, delegation, quota, and admin tools)
│   ├── auth/ (TypeScript password, TOTP, WebAuthn, and recovery contracts)
│   ├── backup/
│   │   ├── backup-contract.mjs
│   │   ├── backup-contract.test.mjs
│   │   ├── backup-contract.ts
│   │   ├── backup-contract.test.ts
│   │   ├── index.mjs
│   │   └── index.ts
│   ├── db/migrations/
│   ├── foundation/
│   ├── integrations/ (TypeScript LDAP, PostgreSQL, tenant, and migration adapters)
│   ├── lifecycle/
│   │   ├── account-lifecycle.mjs
│   │   ├── account-lifecycle.test.mjs
│   │   ├── account-lifecycle.ts
│   │   ├── account-lifecycle.test.ts
│   │   ├── index.mjs
│   │   ├── retention.mjs
│   │   ├── retention.test.mjs
│   │   ├── retention.ts
│   │   └── retention.test.ts
│   ├── mail/
│   │   ├── imap-idle.mjs
│   │   ├── imap-idle.test.ts
│   │   ├── imap-idle.ts
│   │   ├── mail-core.mjs
│   │   ├── mail-core.test.mjs
│   │   ├── mail-core.test.ts
│   │   ├── mail-core.ts
│   │   ├── mail-policy.mjs
│   │   ├── mail-policy.ts
│   │   ├── mail-queue.mjs
│   │   ├── mail-queue.ts
│   │   ├── mail-scanners.mjs
│   │   ├── mail-scanners.test.ts
│   │   └── mail-scanners.ts
│   ├── observability/
│   ├── capacity/ (typed bounded local-proof measurement contracts)
│   ├── release/
│   │   ├── index.mjs
│   │   ├── local-proof-scope.mjs
│   │   ├── local-proof-scope.test.mjs
│   │   ├── local-proof-topology.mjs
│   │   ├── local-proof-topology.test.mjs
│   │   ├── release-evidence.mjs
│   │   └── release-evidence.test.mjs
│   ├── ops/
│   │   ├── abuse/ (typed rate and abuse controls)
│   │   ├── acme/ (typed ACME and certificate health contracts)
│   │   └── patch/ (typed sanitized patch-status contract)
│   ├── upgrade/
│   │   ├── compatibility.mjs
│   │   ├── control-plane.mjs
│   │   ├── index.mjs
│   │   ├── rollout.mjs
│   │   └── upgrade-contract.test.mjs
│   ├── runtime/ (TypeScript HTTP runtime and observability)
│   ├── dav/
│   │   ├── caldav/ (strict TypeScript CalDAV contract and tests)
│   │   ├── carddav/ (strict TypeScript CardDAV contract and tests)
│   │   └── discovery/ (strict TypeScript discovery and tests)
│   └── web/
│       ├── backup/ (typed user backup boundary)
│       ├── content/ (typed sanitization, attachment, and timezone policies)
│       ├── realtime/ (typed metadata-only event normalization)
│       └── security/ (typed sessions, cookies, and CSRF)
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
├── tsconfig.json
├── tsconfig.lp4.json
├── tsconfig.lp5.json
├── tsconfig.lp6.json
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
