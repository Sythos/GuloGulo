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

Gulo Gulo is released under the MIT License. See [LICENSE](LICENSE) for the
complete license text.

Gulo Gulo is an OCI-native, mail-first, tenant-isolated groupware platform
built around open protocols and operationally safe deployment.

The guiding animal is the wolverine, whose binomial name is *Gulo gulo*.
Human-facing project text uses **Gulo Gulo**. Machine-facing names use
**gulogulo** without spaces.

## Project status

The repository is in the foundation phase. The production-readiness checklist
below is the initial acceptance baseline and is intentionally not marked
complete until each item has implementation evidence and a verification test.

The full authoritative specification is maintained as GULOGULO.md in the
document folder beside this repository during bootstrap. Repository
documentation, source code, variables, configuration, tests, and notes are
written in English.

## M0 Docker-first scaffold

The first runnable milestone contains a dependency-light Node.js runtime with
safe liveness and readiness endpoints. Docker and Compose are required from
this point onward:

~~~powershell
npm test
docker compose --env-file .env.example config
./scripts/m0-smoke.ps1
~~~

The M0 container is intentionally not a mail server yet. LDAP and PostgreSQL
are external, disabled by default, and represented only by non-secret
configuration placeholders. The accepted Gulo Gulo runtime and frontend
architecture is recorded in ADR-001-gulogulo-runtime-and-frontend-architecture.md
in the document folder.

M1 adds the versioned configuration contract, structured logs, metrics,
deterministic fixtures, and read-only patch status. M2 adds the first external
identity and application-state adapters: LDAP lookups, PostgreSQL migrations,
tenant RLS, and transactional gross-quota enforcement. M3 adds the mail-core
contracts for closed SMTP submission, explicit aliases, fail-closed Rspamd and
ClamAV verdicts, LMTP retry/bounce behavior, queue metadata, Sieve forwarding
protection, and deterministic IMAP IDLE events. The hands-on manual for each
implemented component lives in [doc/](doc/README.md).

Gulo Gulo-owned images target Ubuntu 26.04 LTS on `linux/amd64` and
`linux/arm64`. The Docker build runs `apt-get update` and
`apt-get upgrade -y`, verifies the official Node.js tarball checksum, and
keeps runtime patch control in the deployment pipeline rather than mutating a
live non-root container.

## Core architecture

The V1 platform is designed around:

- Postfix for SMTP and authenticated submission;
- Rspamd for spam scoring, reputation, and mail policy;
- ClamAV for malware scanning;
- Dovecot for IMAP, IMAP IDLE, LMTP, and Sieve;
- an external LDAP directory;
- an external PostgreSQL database;
- Gulo Gulo web application implemented with HTML5 and TypeScript;
- CalDAV and CardDAV interoperability;
- tenant, master, and user RBAC;
- explicit quotas, aliases, delegations, and audit;
- ACME certificates with Let's Encrypt as the default provider;
- web-only TOTP and WebAuthn/passkey factors;
- read-only monitoring API and MCP surfaces;
- blue/green upgrades with external persistent state.

The V1 security invariants include:

- catch-all is disabled;
- user automatic forwarding is disabled;
- the master cannot read user mailbox, calendar, contact, or session content;
- the sum of user quotas cannot exceed the original gross tenant quota;
- user-deleted trash is purged progressively after 28 days;
- API and MCP are read-only;
- all relevant administrative and security events are audited.

## Production-readiness checklist

This checklist is derived from the authoritative project specification and is
the acceptance baseline for a production deployment.

### Security

- [ ] no open relay;
- [ ] TLS and certificates verified;
- [ ] ACME renewal tested;
- [ ] LDAP uses TLS and minimum bind privilege;
- [ ] PostgreSQL is protected and backed up;
- [ ] secret store and rotation are configured;
- [ ] CSP, CSRF, and security headers are verified;
- [ ] email HTML sanitization is verified;
- [ ] rate and abuse controls are active;
- [ ] audit output contains no secrets;
- [ ] images have an SBOM and verified digest.

### Data

- [ ] sources of truth are documented;
- [ ] the quota ledger is verified;
- [ ] 28-day retention is tested;
- [ ] user backup authorization is tested;
- [ ] provider backups are encrypted;
- [ ] restore is tested in an isolated environment;
- [ ] purge jobs are idempotent and resumable;
- [ ] the account-deletion runbook is approved.

### Interoperability

- [ ] SMTP and IMAP;
- [ ] IMAP IDLE;
- [ ] Sieve;
- [ ] aliases;
- [ ] CalDAV;
- [ ] CardDAV;
- [ ] .well-known resources;
- [ ] autodiscovery;
- [ ] ICS and vCard;
- [ ] timezone behavior.

### Operations

- [ ] health and metrics;
- [ ] log rotation;
- [ ] alerts;
- [ ] Postfix queue visibility;
- [ ] automatic Rspamd and ClamAV definition updates;
- [ ] blue/green rehearsal;
- [ ] rollback test;
- [ ] RPO and RTO approved;
- [ ] incident and disaster-recovery runbooks.

### Governance

- [ ] roles and delegation policy approved;
- [ ] master log access is disabled by default;
- [ ] API and MCP are read-only;
- [ ] future features are not enabled accidentally;
- [ ] architecture decision records are current;
- [ ] deployment documentation is complete.

## Continuous integration

GitHub Actions are enabled from the beginning:

- Commit tests run on every pushed commit and can also be started manually.
- Pull request validation runs for both internal branches and external
  contributor forks through the pull_request event.
- External pull requests run with read-only repository permissions and no
  project secrets.
- The same reusable quality-gates workflow is used by commit and pull request
  checks to avoid different standards for different contribution paths.
- The workflow performs repository checks immediately and runs package-manager
  installation and the test script automatically when package metadata exists.

The pull request workflow intentionally does not use pull_request_target for
untrusted code. Branch protection can later mark the Commit tests and PR
validation checks as required before merge.

## Development principles

- Keep persistent state outside containers.
- Preserve one source of truth for each data type.
- Enforce tenant isolation and RBAC in the backend.
- Do not add V2 features as implicit V1 behavior.
- Prefer standard protocols over proprietary adapters.
- Keep migrations backward-compatible for the blue/green window.
- Never commit secrets, credentials, private keys, or real user data.
- Inspect the remote, branch, and staged scope before pushing.
- Use the latest stable release of every package, library, action, runtime,
  image, and external software dependency; record any approved exception.

## Repository layout

~~~text
gulogulo/
├── .github/
│   └── workflows/
│       ├── commit-tests.yml
│       ├── pr-validation.yml
│       └── quality-gates.yml
├── config/
│   └── schema.v1.json
├── doc/
│   ├── README.md
│   ├── api-and-mcp.md
│   ├── compose-and-fixtures.md
│   ├── configuration.md
│   ├── container-patching.md
│   ├── identity-and-postgres.md
│   ├── mail-core.md
│   ├── observability.md
│   ├── upgrade-and-migration.md
│   └── storage-and-quotas.md
├── scripts/
│   ├── container-patch.sh
│   ├── m0-smoke.ps1
│   └── m1-fixture-smoke.ps1
├── README.md
└── future application, infrastructure, and documentation directories
~~~

## Contribution and review

Every contribution must pass the applicable GitHub Actions checks. Pull
requests should explain:

- the problem being solved;
- the affected source of truth;
- tenant and RBAC implications;
- migration and rollback behavior;
- backup, audit, and retention implications;
- tests and verification evidence.

External contributors must use a fork and pull request. Internal contributors
must use a branch and pull request. Both paths are validated by the same
read-only workflow.

Do not publish, release, push to protected branches, or change repository
visibility without explicit project-owner authorization.

## Future considerations

Shared mailboxes, shared resource calendars, write-capable API or MCP,
OAuth2/XOAUTH2 for legacy clients, proprietary migration tooling, and a native
mobile application are future considerations, not V1 requirements.
