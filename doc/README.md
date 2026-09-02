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

- [Read before use](READ_BEFORE_USE.md) — the production hand-off sheet:
  repository code that is done, field verification that belongs to providers
  and testers, runbook definitions, evidence rules, and the remaining
  implementation backlog.
- [Configuration](configuration.md) — the versioned configuration contract,
  precedence rules, safe defaults, and secret references.
- [Secret store and rotation](secret-store-and-rotation.md) — allowlisted
  resolution, versioned file rotation and rollback, metadata-only audit, and
  read-only Docker/Kubernetes projected-secret adapters.
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
- [LP1 isolated local topology](local-proof-topology.md) — the private dual-stack
  Compose network, disposable CA/DNS utilities, IPv4/IPv6 loopback-only
  application bindings, external-capable named volumes, restart continuity
  check, and Docker proof harness.
- [LP2 local LDAP and PostgreSQL proof](lp2-local-services.md) — the
  offline dual-stack dependency lab, verified LDAPS and PostgreSQL TLS,
  deterministic fixtures, disposable volumes, and the Compose rehearsal.
- [LP3 local mail proof](lp3-local-mail.md) — the offline Postfix, Dovecot,
  Rspamd, and ClamAV boundary with IMAP IDLE, LMTP, Sieve, queue/retry/bounce,
  explicit aliases, and persistent restart-safe volumes.
- [LP4 local web, DAV, and discovery proof](lp4-local-web.md) — the
  authenticated HTML5 shell, secure session and CSRF boundary, tenant-scoped
  CalDAV/CardDAV contracts, discovery resources, dual-stack Compose proof,
  runtime credentials, and restart continuity checks.
- [LP5 local operations and capacity proof](lp5-local-operations-capacity.md) —
  fail-closed patch status, typed abuse and observability controls, bounded
  web/DAV/mail/IMAP-IDLE measurements, resource limits, and the AMD64 CI
  workflow.
- [LP6 local backup and disaster-recovery proof](lp6-local-backup-dr.md) —
  deterministic encrypted backup metadata, isolated restore, 28-day retention,
  holds, idempotent purge, and the provider evidence boundary.
- [LP7 local upgrade proof](lp7-local-upgrade.md) — Docker replacement and
  Kubernetes blue/green rehearsal, readiness and drain gates, queue/IDLE
  continuity, rollback, external volumes, and the AMD64-first workflow.
- [LP8 evidence bundle and operator handbook](lp8-evidence-operator.md) — the
  reproducible hand-off manifest, exact base digest, checksums, safe-sharing
  rules, API/MCP examples, CI provenance, and the temporary TypeScript bridge
  inventory owned by LP9.
- [Server TypeScript boundary](server-typescript.md) — compiler settings,
  build and test commands, compiled production startup, and the temporary
  compatibility-bridge rule.
- [SBOM and signed-image release workflow](sbom-release-plan.md) — the manual
  amd64 field-container package, automatic numeric-tag GHCR and GitHub
  Release lane, digest-bound SBOM/provenance attestations, permissions, and
  consumer verification.

The project is still intentionally small. The documents describe real behavior
only: DAV, administration, lifecycle, backup, observability, ACME, abuse, and
upgrade are deterministic contract boundaries until their external adapters and
rehearsals are in place. The release-readiness guide collects those limits in a
machine-checkable decision, but production deployment still needs a persistent
DAV backend, authenticated HTTP method adapter, real ACME/DNS operations,
measured RPO/RTO, an actual Docker/Kubernetes cutover, and standard-client
interoperability rehearsal before it is treated as a complete external service.
