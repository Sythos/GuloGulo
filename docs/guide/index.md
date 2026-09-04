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

## Getting started

For install, setup, and deployment hand-off instructions across the
standalone, cPanel, and Plesk targets, see the root
[INSTALL.md](../install.md) — the production hand-off sheet: repository code
that is done, field verification that belongs to providers and testers,
runbook definitions, evidence rules, and the remaining implementation
backlog.

## What is documented today

- [Configuration](configuration.md) — the versioned configuration contract,
  precedence rules, safe defaults, and secret references.
- [Secret store and rotation](secret-store-and-rotation.md) — allowlisted
  resolution, versioned file rotation and rollback, metadata-only audit, and
  read-only Docker/Kubernetes projected-secret adapters.
- [Runtime and observability](observability.md) — health, logs, request IDs,
  metrics, and the small HTTP surface used by the scaffold.
- [API and MCP operations](api-and-mcp.md) — the read-only monitoring contract,
  safe examples, and the boundary between monitoring and deployment control.
- [External identity and application state](identity-and-postgres.md) — LDAP,
  PostgreSQL, migrations, tenant isolation, and transactional quota checks.
- [Persistent storage and quotas](storage-and-quotas.md) — external volumes,
  blue/green mounts, backup boundaries, and durable gross-quota accounting.
- [M3 mail core](mail-core.md) — explicit mailbox and alias delivery, closed
  submission, scanner verdicts, LMTP retry/bounce behavior, queue visibility,
  Sieve forwarding protection, and deterministic IMAP IDLE events.
- [Shared scanner-signature volume](scanner-signature-volume.md) — the external
  Rspamd/ClamAV definition layout, atomic activation, read-only mounts, host
  updater boundary, and freshness/rollback rules.
- [Optional Plesk and cPanel integration](control-panel-integration.md) — the
  upstream tenant-tool boundary, ownership rules, safe references, pull and
  webhook modes, and provider verification checklist.
- [RBAC, administration, and web MFA](rbac-admin-mfa.md) — role and permission
  matrices, delegation, quota/admin metadata, password policy, TOTP, WebAuthn,
  recovery, and the content/session privacy boundary.
- [Lifecycle, backup, and disaster recovery](lifecycle-backup-dr.md) — the
  28-day purge rule, account lifecycle, encrypted backup envelopes, restore
  metadata, and operational evidence limits.
- [Abuse controls and production readiness](abuse-deployment.md) —
  metadata-only rate and abuse controls, and fail-closed Compose readiness.
- [Upgrade and migration operations](upgrade-and-migration.md) — the
  expand/backfill/switch/contract database-migration discipline shared by all
  three packaging targets, and each target's own in-place upgrade script
  (standalone, cPanel, Plesk) since ADR-002 replaced the earlier
  Docker-to-Docker/Kubernetes blue-green cutover model.
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
- [Server TypeScript boundary](server-typescript.md) — compiler settings,
  build and test commands, compiled production startup, and the temporary
  compatibility-bridge rule.

The LP0–LP9 local-proof documents (`local-proof-scope.md`,
`local-proof-topology.md`, `lp2-local-services.md` through
`lp9-local-release.md`, `compose-and-fixtures.md`, `container-patching.md`)
and the retired `sbom-release-plan.md` GHCR/container-release write-up
described the earlier Docker/OCI-native deployment model (ADR-001). They have
been archived to `old_docs/lp-proof-records/` now that
[ADR-002](../adr/ADR-002-gulogulo-packaging-and-distribution-targets.md) has
replaced that model with the standalone/cPanel/Plesk packages; see
`../INSTALL.md` for the current, real deployment and verification story.

The project is still intentionally small. The documents describe real behavior
only: DAV, administration, lifecycle, backup, observability, abuse, and
upgrade are deterministic contract boundaries until their external adapters and
rehearsals are in place. The release-readiness guide collects those limits in a
machine-checkable decision, but production deployment still needs a persistent
DAV backend, authenticated HTTP method adapter, measured RPO/RTO, a real
in-place upgrade rehearsal on each of the three packaging targets (see
`doc/upgrade-and-migration.md`), and standard-client interoperability
rehearsal before it is treated as a complete external service. TLS
certificates are the panel's own AutoSSL/Let's Encrypt integration on
cPanel/Plesk, and the operator's own reverse proxy on standalone - Gulo Gulo
does not manage certificates itself.
