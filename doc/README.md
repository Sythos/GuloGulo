# Gulo Gulo documentation

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This folder is the running, hands-on manual for the pieces that actually exist
in the repository. It is deliberately written for a person who is setting up,
testing, or operating Gulo Gulo, not for a generated API catalogue. Every new
component gets its own practical notes here before it is treated as part of the
normal workflow.

## What is documented today

- [Configuration](configuration.md) — the versioned configuration contract,
  precedence rules, safe defaults, and secret references.
- [Runtime and observability](observability.md) — health, logs, request IDs,
  metrics, and the small HTTP surface used by the scaffold.
- [Compose and fixtures](compose-and-fixtures.md) — local profiles,
  deterministic test data, and the smoke harness.
- [Container patching](container-patching.md) — Ubuntu 26.04 LTS image policy,
  build-time security updates, and controlled maintenance operations.
- [API and MCP operations](api-and-mcp.md) — the read-only monitoring contract,
  safe examples, and the boundary between monitoring and deployment control.
- [External identity and application state](identity-and-postgres.md) — LDAP,
  PostgreSQL, migrations, tenant isolation, and transactional quota checks.
- [Persistent storage and quotas](storage-and-quotas.md) — external volumes,
  blue/green mounts, backup boundaries, and durable gross-quota accounting.
- [M3 mail core](mail-core.md) — explicit mailbox and alias delivery, closed
  submission, scanner verdicts, LMTP retry/bounce behavior, queue visibility,
  Sieve forwarding protection, and deterministic IMAP IDLE events.
- [Upgrade and migration operations](upgrade-and-migration.md) — the planned
  provider-only API/MCP command contract, Docker-to-Docker replacement, and
  Kubernetes blue/green cutover and rollback runbook.
- [Web foundation](web-foundation.md) — the HTML5/TypeScript shell, secure
  session and CSRF contracts, message sanitization, attachment policy,
  timezone display, realtime events, and browser/API boundaries.
- [CalDAV, CardDAV, and discovery](dav-and-discovery.md) — user-scoped
  calendar and address-book contracts, conditional writes, ETags, sync tokens,
  iCalendar/vCard validation, `.well-known` responses, and safe manual
  configuration fallback.

The project is still intentionally small. The documents describe real behavior
only; the DAV contract is now implemented as a deterministic adapter boundary.
Production deployment still needs a persistent DAV backend, authenticated HTTP
method adapter, and standard-client interoperability rehearsal before it is
treated as a complete external service.
