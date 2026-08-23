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
- [RBAC, administration, and web MFA](rbac-admin-mfa.md) — role and permission
  matrices, delegation, quota/admin metadata, password policy, TOTP, WebAuthn,
  recovery, and the content/session privacy boundary.
- [Lifecycle, backup, and disaster recovery](lifecycle-backup-dr.md) — the
  28-day purge rule, account lifecycle, encrypted backup envelopes, restore
  metadata, and operational evidence limits.
- [ACME, abuse, and production deployment](acme-abuse-deployment.md) —
  Let's Encrypt and generic ACME configuration, renewal/reload health,
  metadata-only rate and abuse controls, and fail-closed Compose readiness.
- [Upgrade and migration operations](upgrade-and-migration.md) — the
  provider-only API/MCP command contract, expand/backfill/switch/contract
  compatibility window, Docker-to-Docker replacement, connection drain, and
  Kubernetes blue/green cutover and rollback runbook.
- [Web foundation](web-foundation.md) — the HTML5/TypeScript shell, secure
  session and CSRF contracts, message sanitization, attachment policy,
  timezone display, realtime events, and browser/API boundaries.
- [CalDAV, CardDAV, and discovery](dav-and-discovery.md) — user-scoped
  calendar and address-book contracts, conditional writes, ETags, sync tokens,
  iCalendar/vCard validation, `.well-known` responses, and safe manual
  configuration fallback.
- [Release readiness](release-readiness.md) — the Section 30 evidence object,
  hardening review matrix, sanitized provider API/MCP read surface, and the
  honest boundary between a usable contract preview and a production service.
- [LP0 local proof scope](local-proof-scope.md) — the reserved local names,
  synthetic-data rule, offline runtime boundary, disposable service inventory,
  architecture targets, and the explicit deferral of the external phase.
- [LP1 isolated local topology](local-proof-topology.md) — the private Compose
  network, disposable CA/DNS utilities, loopback-only application binding,
  external-capable named volumes, restart continuity check, and Docker proof
  harness.

The project is still intentionally small. The documents describe real behavior
only: DAV, administration, lifecycle, backup, observability, ACME, abuse, and
upgrade are deterministic contract boundaries until their external adapters and
rehearsals are in place. The release-readiness guide collects those limits in a
machine-checkable decision, but production deployment still needs a persistent
DAV backend, authenticated HTTP method adapter, real ACME/DNS operations,
measured RPO/RTO, an actual Docker/Kubernetes cutover, and standard-client
interoperability rehearsal before it is treated as a complete external service.
