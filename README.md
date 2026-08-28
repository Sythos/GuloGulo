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

If a tenant already runs its domain from Plesk or cPanel, Gulo Gulo can sit
behind that panel as an optional upstream tool. The panel may own the hosting
account and DNS workflow; Gulo Gulo still owns groupware policy, identity,
mail, calendar, contacts, quotas, retention, and audit. The integration is
deliberately read-only and tenant-bound today, with provider-specific API
reconciliation kept as a separate backlog item.

## Production readiness checklist

This is the implementation checklist derived from section 30 of the
authoritative specification. A check mark means that the repository contains
the relevant code, contract, or runbook and its repository gate passes.
Deployment and field evidence do not keep an implementation item open: they are
tracked in [READ_BEFORE_USE.md](doc/READ_BEFORE_USE.md) and the release evidence
record. An unchecked item means that repository code or release automation is
still missing.

### Security

- [x] no open relay;
- [x] TLS and certificate health contract verified;
- [x] ACME renewal state and safe-reload contract tested;
- [x] LDAP uses TLS and minimum bind privilege;
- [x] PostgreSQL protected and backed up;
- [ ] secret store and rotation configured;
- [x] CSP, CSRF, and security headers;
- [x] secure web sessions, generic login failures, and login rate limits;
- [x] email HTML sanitization;
- [x] rate and abuse controls contract tested;
- [x] audit has no secrets;
- [x] images have an SBOM workflow, digest-bound attestations, and a
  consumer-verification gate; an owner-pushed numeric version tag publishes
  the final image and matching GitHub Release automatically, as documented in
  [READ_BEFORE_USE.md](doc/READ_BEFORE_USE.md).

### Data

- [x] sources of truth documented;
- [x] quota ledger verified;
- [x] 28-day retention tested;
- [x] user backup authorization tested;
- [x] provider backup encrypted;
- [x] restore tested;
- [x] purge idempotent;
- [x] account deletion runbook defined; provider approval and rehearsal are
  tracked in READ_BEFORE_USE.md.

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
- [x] final registry publication is gated to the multiarch amd64+arm64 target;
- [x] default-deny Docker build context and runtime-layer cleanup keep documentation, tests, fixtures, CI metadata, bridges, and local tooling outside the application image;
- [x] dual-stack IPv4 and IPv6 network support;
- [x] persistent external mail volumes and restart continuity;
- [x] offline synthetic LP2 LDAP and PostgreSQL dependency proof with verified TLS;
- [x] offline synthetic mail proof with Postfix, Dovecot, Rspamd, and ClamAV;
- [x] offline synthetic web/session/DAV/discovery proof with restart continuity;
- [x] fast amd64-first CI with an explicit multiarch amd64+arm64 final gate;
- [x] tenant-bound DAV ETags and sync tokens;
- [x] OCI build-provenance attestations generated and verified;
- [x] manual amd64 field-container packaging plus automatic numeric-tag
  multiarch GHCR publication, digest-bound SBOM/attestations, and GitHub
  Release evidence;
- [x] reproducible local release evidence and consumer-verifiable provenance metadata;
- [x] provenance and release permissions are granted only by version-tag pushes
  or trusted manual callers, while pull-request validation remains read-only;
- [x] log rotation;
- [x] alerts;
- [x] Postfix queue visibility;
- [x] bounded operations and capacity proof (AMD64 Compose first, ARM64 final artifact gate);
- [x] fail-closed disposable patch helper and sanitized read-only patch status;
- [x] externally managed Rspamd/ClamAV definition updates through a shared
  read-only signature volume with freshness, atomic activation, and rollback
  metadata; provider updater execution is tracked in READ_BEFORE_USE.md;
- [x] provider-only migration contract, compatibility window, and rollback state machine;
- [x] bounded Docker replacement and Kubernetes blue/green rehearsal with external-volume continuity (AMD64 functional proof plus AMD64+ARM64 artifact/provenance gate);
- [x] blue/green cutover and rollback runbook defined; live rehearsal is
  tracked in READ_BEFORE_USE.md;
- [x] RPO/RTO contract defined; measured objectives and approval are tracked
  in READ_BEFORE_USE.md;
- [x] incident and DR runbooks defined; tabletop and deployment evidence are
  tracked in READ_BEFORE_USE.md.

### Governance

- [x] roles and delegation policy approved;
- [x] master log access is off by default;
- [x] API/MCP are read-only;
- [x] future features are not enabled;
- [x] ADRs are current;
- [x] canonical TypeScript source tree and behavior-free compatibility bridges audited;
- [x] optional upstream Plesk/cPanel tenant-tool contract with safe binding and
  read-only capabilities;
- [x] deployment documentation is complete for the local-proof hand-off;
  provider runbooks remain an external release responsibility.

## Repository implementation backlog

The production checklist above is intentionally about repository work. These
are the only remaining unchecked implementation items; field verification for
the checked contracts belongs in [READ_BEFORE_USE.md](doc/READ_BEFORE_USE.md).

- [ ] concrete provider secret-store and rotation adapter;
- [x] SBOM generation, field-container packaging, immutable multiarch registry
  digest publication, GitHub Release assets, and consumer verification
  workflow; the owner still controls the version tag and field evidence is
  documented in [READ_BEFORE_USE.md](doc/READ_BEFORE_USE.md);
- [ ] provider-specific Plesk/cPanel API adapter and idempotent reconciliation;
- [ ] provider-backed authenticated login/session wiring to the real LDAP
  adapter;
- [ ] production Postfix/Dovecot mail adapters, persistent DAV backend, and
  complete HTTP/WebDAV method and XML-report integration;
- [ ] durable external backup, restore, account-deletion execution, and
  scheduled retention workers;
- [ ] provider migration controller and live provider API/MCP wiring;
- [ ] provider ACME/DNS client plus deployed log collector, alert-delivery,
  and paging adapters.

## Repository layout

The tree below is kept current with every repository change. Generated
dependencies and build output are intentionally omitted.

~~~text
gulogulo/
├── .github/
│   └── workflows/
│       ├── container-release.yml
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
│   ├── READ_BEFORE_USE.md
│   ├── api-and-mcp.md
│   ├── acme-abuse-deployment.md
│   ├── compose-and-fixtures.md
│   ├── control-panel-integration.md
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
│   ├── lp7-local-upgrade.md
│   ├── lp8-evidence-operator.md
│   ├── mail-core.md
│   ├── rbac-admin-mfa.md
│   ├── release-readiness.md
│   ├── sbom-release-plan.md
│   ├── scanner-signature-volume.md
│   ├── server-typescript.md
│   ├── observability.md
│   ├── storage-and-quotas.md
│   ├── upgrade-and-migration.md
│   └── web-foundation.md
├── scripts/
│   ├── m0-smoke.ps1
│   ├── m1-fixture-smoke.ps1
│   ├── lp0-scope-audit.ts (+ .mjs compatibility bridge)
│   ├── lp1-compose-audit.ts (+ .mjs compatibility bridge)
│   ├── lp1-proof-check.ts (+ .mjs compatibility bridge)
│   ├── lp1-proof-smoke.ts (+ .mjs compatibility bridge)
│   ├── lp2-compose-audit.ts (+ .mjs compatibility bridge)
│   ├── lp2-compose-smoke.ts (+ .mjs compatibility bridge)
│   ├── lp2-proof-smoke.ts (+ .mjs compatibility bridge)
│   ├── lp3-compose-audit.ts (+ .mjs compatibility bridge)
│   ├── lp3-compose-smoke.ts (+ .mjs compatibility bridge)
│   ├── lp3-proof-smoke.ts (+ .mjs compatibility bridge)
│   ├── lp8-bundle-smoke.ts
│   ├── lp8-evidence-audit.test.ts
│   ├── lp8-evidence-audit.ts
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
│   ├── lp7-compose-audit.ts
│   ├── lp7-compose-smoke.ts
│   ├── lp7-proof-check.ts
│   ├── m10-release-audit.ts (+ .mjs compatibility bridge)
│   ├── sbom-release-audit.ts
│   ├── sbom-release-audit.test.ts
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
│   ├── lp7-local-upgrade.json
│   ├── lp8-local-proof-bundle.json
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
│   ├── integrations/ (TypeScript LDAP, PostgreSQL, tenant, migration, and optional Plesk/cPanel adapters)
│   ├── lifecycle/
│   │   ├── account-lifecycle.mjs
│   │   ├── account-lifecycle.test.mjs
│   │   ├── account-lifecycle.ts
│   │   ├── account-lifecycle.test.ts
│   │   ├── index.mjs
│   │   ├── index.ts
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
│   │   ├── mail-scanners.ts
│   │   ├── scanner-signatures.test.ts
│   │   └── scanner-signatures.ts
│   ├── observability/
│   ├── capacity/ (typed bounded local-proof measurement contracts)
│   ├── release/
│   │   ├── index.ts (+ .mjs compatibility bridge)
│   │   ├── local-proof-scope.ts (+ .mjs compatibility bridge)
│   │   ├── local-proof-scope.test.ts (+ .mjs compatibility bridge)
│   │   ├── local-proof-topology.ts (+ .mjs compatibility bridge)
│   │   ├── local-proof-topology.test.ts (+ .mjs compatibility bridge)
│   │   ├── release-evidence.ts (+ .mjs compatibility bridge)
│   │   └── release-evidence.test.ts (+ .mjs compatibility bridge)
│   ├── ops/
│   │   ├── abuse/ (typed rate and abuse controls)
│   │   ├── acme/ (typed ACME and certificate health contracts)
│   │   └── patch/ (typed sanitized patch-status contract)
│   ├── upgrade/
│   │   ├── compatibility.mjs
│   │   ├── compatibility.ts
│   │   ├── control-plane.mjs
│   │   ├── control-plane.ts
│   │   ├── index.mjs
│   │   ├── index.ts
│   │   ├── rollout.mjs
│   │   ├── rollout.ts
│   │   ├── rehearsal.test.ts
│   │   ├── rehearsal.ts
│   │   ├── upgrade-contract.test.mjs
│   │   └── upgrade-contract.test.ts
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
