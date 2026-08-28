# Read before using Gulo Gulo

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This is the practical hand-off sheet for anyone who is going to deploy, test,
or operate Gulo Gulo outside the repository. It exists because a green
repository gate is useful, but it is not a substitute for a real LDAP
directory, a real PostgreSQL service, real mail traffic, real storage, or a
real operator on call.

The root README is intentionally an implementation checklist. A checked item
there means that the repository contains the relevant code or contract and that
the repository gate for it passes. It does not mean that a provider has already
configured or exercised the item in the field. The field work belongs here and
in the release evidence record.

## Status model

- **DONE — repository** means that the code, contract, or runbook boundary is
  present and covered by a repository test or static gate.
- **VERIFY BEFORE USE** means that an operator or tester must exercise the
  boundary against the selected deployment and retain sanitized evidence.
- **OPEN CODE** means that a repository implementation is still missing. These
  items remain unchecked in the root README and are not field-verification
  tasks.

Never turn a VERIFY BEFORE USE item into a fake repository pass. Conversely,
do not leave an implementation checklist item open merely because the provider
has not run its deployment rehearsal yet.

## Container installation and first run

This is the practical path for bringing up the repository container without
mistaking a local proof image for a production deployment. The commands below
assume Docker Engine or Docker Desktop with Compose v2 and a Linux host (or a
Linux VM on a development workstation). The supported final image platforms
are `linux/amd64` (x86_64) and `linux/arm64` (ARM64). The final release path
builds both platforms directly; the optional field archive remains AMD64-only
for quick local experiments.

### Choose the image source

- **Source checkout:** use this when changing code or running the complete
  Compose proof. The checkout builds the image locally from the exact commit.
- **AMD64 field archive:** the manual `container-release` workflow can produce
  a downloadable `.docker.tar` plus a SHA-256 file. It is an offline field-test
  artifact for `linux/amd64`, not a multi-architecture production image.
- **Immutable registry image and Release:** pushing a numeric semver tag (for
  example `0.1.3`) whose value exactly matches `package.json.version` starts
  the trusted multi-architecture workflow. It publishes
  `linux/amd64,linux/arm64` to GHCR, generates the SBOM and Artifact
  Attestations, and creates or updates the matching GitHub Release with the
  SBOM and digest-bound evidence. The owner still explicitly chooses and
  pushes the version tag. A manual `publish=true` run remains available for a
  trusted rehearsal on `main`.

### Prepare a checkout and external volumes

Start from the release tag or commit that you intend to run. The following
example uses the `0.1.2` source tag and a machine-safe tenant prefix:

~~~text
git clone https://github.com/Sythos/GuloGulo.git gulogulo
cd gulogulo
git checkout 0.1.2
~~~

Copy `.env.example` to `.env` and edit only deployment-safe values. At minimum,
set `GULOGULO_ENV=production`, `APP_ENV=production`,
`GULOGULO_VERSION=0.1.2`, a unique `GULOGULO_VOLUME_PREFIX`, and
`GULOGULO_VOLUMES_EXTERNAL=true`. Keep LDAP, PostgreSQL, ACME, control-panel,
and backup credentials in the provider secret store; `.env` may contain only
their reference names. Never commit the populated file.

Create the four durable application volumes before the first start. The names
must match the prefix in `.env`; use a provider-backed volume driver or a
protected host storage policy when Docker's default volume root is not suitable:

~~~powershell
$prefix = 'gulogulo-tenant1'
'runtime-state','mail-data','dav-data','backup-data' |
  ForEach-Object { docker volume create "$prefix-$_" }
~~~

These volumes hold runtime state, mailbox data, DAV objects, and backup
references. They are deliberately external to disposable containers and must
survive `docker compose down` and image replacement. Do not use
`docker compose down --volumes` on a deployment that contains user data.

### Validate and start the runtime

Run the configuration check before creating containers, then build or select
the exact image and start only the default runtime service:

~~~powershell
docker compose config --quiet
docker compose build --pull gulogulo
docker compose up --detach gulogulo
docker compose ps
~~~

The default Compose binding is loopback-only (`127.0.0.1:8080`). Keep it that
way when a Plesk/cPanel-managed reverse proxy is in front of Gulo Gulo; let the
proxy own public TLS, DNS, and IPv4/IPv6 exposure. Do not mount the Docker
socket and do not publish the service directly to the Internet until the
provider has completed the dual-stack, certificate, firewall, and abuse review.

Check readiness and retain the sanitized result:

~~~powershell
Invoke-WebRequest http://127.0.0.1:8080/health/ready | Select-Object StatusCode, Content
docker compose logs --no-color --tail 100 gulogulo
~~~

LDAP and PostgreSQL are disabled by the safe empty-scaffold defaults. A real
deployment must enable them only after their TLS endpoints, secret references,
tenant mapping, roles, and network policy have been verified. The default
runtime is also read-only apart from its external volumes and a bounded `/tmp`.

### Importing the AMD64 field archive

When testing an Actions artifact on an AMD64 host, verify its checksum before
loading it and keep the imported tag visible in the evidence record:

~~~powershell
Get-Content .\gulogulo-field-<tag>.docker.tar.sha256
Get-FileHash .\gulogulo-field-<tag>.docker.tar -Algorithm SHA256
docker load --input .\gulogulo-field-<tag>.docker.tar
docker image inspect gulogulo:field-<tag>
~~~

The archive is intentionally a field-test package. Use the matching checkout
and Compose definition for a repeatable proof, or use the digest-pinned GHCR
image after the final multi-architecture publication gate. Do not infer ARM64
support from an AMD64 archive.

### Stop, upgrade, and roll back safely

Use `docker compose stop` when pausing a deployment; the external volumes stay
intact. For an upgrade, record the source and target digests, run the
preflight/readiness checks, start the green container with the same external
volume references, observe queue/IMAP IDLE/DAV behavior, and keep the blue
container available until the observation window closes. If a gate regresses,
cut traffic back to blue without copying or deleting mailbox data. The complete
Docker and Kubernetes procedure is in the migration runbook below.

The disposable `local`, `test`, `fixture`, `lp3`, and other proof profiles are
for repository verification only. They use synthetic identities and data and
must never be pointed at a tenant's production LDAP, PostgreSQL, mailbox, DAV,
scanner-signature, or backup volumes.

## Production-readiness map

The following sections cover the complete production-readiness boundary. Every
DONE line is intentionally marked as done at repository level. The indented
verification notes are the work for the future provider, administrator, or
tester.

### Security and identity

- [x] **DONE — mail safety and relay policy.** The mail policy rejects open
  relay, sender spoofing, unknown internal recipients, catch-all delivery, and
  automatic forwarding. Verify the behavior with the selected Postfix and
  submission topology, including negative tests from an untrusted network.
- [x] **DONE — TLS and certificate health contract.** The runtime exposes
  certificate-health metadata and the ACME state contract. Verify the complete
  certificate chain, hostname validation, renewal window, reload behavior,
  expiry alert, and failure recovery with the provider certificate authority.
- [x] **DONE — ACME policy and safe reload boundary.** Let's Encrypt is the
  default provider and a generic ACME profile is supported by contract. Verify
  DNS or HTTP challenge routing, firewall rules, rate limits, account-key
  protection, renewal, and rollback in the real network.
- [x] **DONE — LDAP security boundary.** The adapter requires LDAPS or verified
  StartTLS, uses a secret reference, limits requested attributes, builds a
  tenant-aware filter, rejects ambiguous results, and never falls back to a
  local password store. Verify the real CA, bind account permissions, directory
  indexes, user lookup, password bind, timeout, retry, and outage behavior.
- [x] **DONE — PostgreSQL security boundary.** The adapter supports verified
  TLS, bounded pools and retries, advisory-locked checksummed migrations,
  forced tenant RLS, transaction tenant context, and fail-closed dependency
  behavior. Verify the real certificate/hostname, database roles, firewall,
  RLS policy, migration permissions, connection limits, and outage behavior.
- [x] **DONE — secret-reference boundary.** Configuration rejects plaintext
  secret values and the LDAP, PostgreSQL, ACME, and backup contracts accept
  references rather than serialized credentials. Verify the selected secret
  store, access policy, rotation cadence, revocation, restart behavior, and
  audit trail. The provider-specific resolver and rotation adapter remains an
  OPEN CODE item below.
- [x] **DONE — browser security contracts.** Secure cookies, session rotation,
  logout invalidation, CSRF tokens, security headers, HTML sanitization,
  attachment/SSRF restrictions, generic login failures, and abuse limits are
  implemented and tested. Verify them with browser/device testing, a security
  review, and the provider reverse proxy.
- [x] **DONE — audit privacy.** Structured audit and operational events remove
  credentials, tokens, cookies, private keys, message bodies, and other
  content-like values. Verify redaction with representative logs and confirm
  that the chosen collector and retention policy do not reintroduce sensitive
  payloads.
- [x] **DONE — release SBOM, field container, and signed digest workflow.** The
  manual container-release workflow builds an amd64 field-test archive, emits
  an SPDX JSON SBOM, and the automatic numeric-version-tag path builds the
  final amd64+arm64 image directly, binds SBOM and build-provenance
  attestations to the immutable digest, verifies the result through the
  GitHub CLI, and creates or updates the matching GitHub Release. Verify GHCR
  visibility/retention, vulnerability disposition, clean-consumer
  verification, and field import before treating a release as operational.

### Data, retention, backup, and deletion

- [x] **DONE — source-of-truth separation.** LDAP owns identity, PostgreSQL
  owns application state, the mail store owns mailbox data, and DAV storage
  owns calendar/contact objects. Verify that the chosen adapters do not create
  shadow passwords, duplicate mailbox content, or cross-tenant indexes.
- [x] **DONE — gross and per-user quota ledger.** Tenant gross quota is
  immutable after bootstrap and allocations are checked atomically in the same
  transaction. Verify the real PostgreSQL constraints, concurrent allocation,
  storage accounting, and quota-alert thresholds.
- [x] **DONE — 28-day trash retention.** The server-side retention worker,
  holds, leases, idempotency keys, restore checks, and fail-safe purge result
  are implemented. Verify the real mailbox, folder, calendar, and contact
  deletion behavior with clocks, holds, retries, and recovery.
- [x] **DONE — user backup authorization.** A user backup is self-scoped,
  metadata-only at the request boundary, and excludes sessions, credentials,
  factors, and private keys. Verify authorization, download expiry/revocation,
  archive encryption, malware scanning, and tenant isolation.
- [x] **DONE — provider backup envelope.** Encrypted manifests, SHA-256
  members, external key references, scope checks, and overwrite protection are
  defined. Verify the selected object store, KMS, retention, access logging,
  replication, and key rotation.
- [x] **DONE — restore plan and DR record.** Restore validation checks scope,
  integrity, privacy, overwrite policy, and RPO/RTO objective shape. Verify an
  isolated restore of tenant, user, mailbox, DAV, PostgreSQL, configuration,
  and audit data, then retain measured timings.
- [x] **DONE — purge idempotency and hold handling.** Repeated operations return
  stable results and active holds block irreversible work. Verify worker lease
  behavior, crash recovery, replay, and evidence after a partial adapter
  failure.
- [x] **DONE — account deletion lifecycle and runbook definition.** The state
  machine, strong confirmation, recovery window, resource-by-resource cleanup
  plan, hold checks, idempotency, and metadata-only audit events are defined.
  The complete operator sequence is written below. Verify it with the real
  LDAP, PostgreSQL, mailbox, DAV, alias, delegation, MFA, and backup adapters.

### Mail, scanners, DAV, and client interoperability

- [x] **DONE — SMTP, authenticated submission, IMAP, IMAP IDLE, LMTP, and
  Sieve contracts.** The repository covers closed submission, queue/retry/
  bounce metadata, IDLE sequence continuity, and forwarding protection. Verify
  the selected Postfix and Dovecot versions, TLS ciphers, client matrix,
  reconnect behavior, delivery acknowledgement, and queue persistence.
- [x] **DONE — explicit aliases and no catch-all.** Alias resolution is
  tenant-scoped and does not create an implicit recipient. Verify addresses,
  loops, disabled users, abuse limits, and sender authorization in the actual
  directory and MTA.
- [x] **DONE — Rspamd and ClamAV fail-closed adapters and shared signature
  boundary.** Verdicts are normalized to safe metadata, an unavailable scanner
  cannot silently turn into an accepted message, and both readers consume
  verified generations from a shared read-only signature volume. Verify real
  scanner endpoints, timeouts, quarantine/reject policy, queue behavior,
  malware/spam samples, feed licensing, and the host-side updater.
- [x] **DONE — CalDAV/CardDAV object contracts.** Tenant/user scope,
  conditional writes, opaque ETags, sync tokens, tombstones, bounded
  iCalendar/vCard parsing, and metadata-only export are implemented. Verify
  the persistent DAV backend, XML method adapter, standard clients, sharing
  boundaries, and concurrency.
- [x] **DONE — discovery and timezone behavior.** HTTPS-only well-known
  resources, autodiscovery, manual fallback, ICS/vCard validation, and sender
  local-time presentation are defined. Verify DNS, reverse proxy paths,
  browser locale, daylight-saving changes, and real client configuration.

### Operations and availability

- [x] **DONE — health, readiness, metrics, logs, alerts, and queue views.**
  The repository has bounded contracts and sanitized payloads. Verify the
  deployed collector, dashboard, alert routing, paging, retention, Postfix
  queue access, and on-call ownership.
- [x] **DONE — dual-stack networking.** Local proof covers IPv4 and IPv6
  bindings and an offline private network. Verify real DNS AAAA records,
  firewall rules, reverse proxy behavior, SMTP policy, and client reachability
  on both families.
- [x] **DONE — external persistent storage.** Mail, DAV, runtime state,
  PostgreSQL data, and backup references are kept outside disposable
  containers. Verify volume creation, ownership, encryption, snapshots,
  replacement, restore, and protection against accidental deletion.
- [x] **DONE — Ubuntu 26.04 multi-architecture image policy.** The final
  version-tag release path builds `linux/amd64` and `linux/arm64` directly;
  the optional field archive remains AMD64-only. Verify the actual runtime on
  both architectures, base-image digest, package compatibility, resource
  limits, and registry pull behavior.
- [x] **DONE — build provenance attestations.** Trusted version-tag/manual
  workflows generate and verify OCI build-provenance attestations. Verify the
  final registry subject, consumer-side verification, retention, and release
  tag.
- [x] **DONE — container patch status and build-time patching.** Images run
  Ubuntu update steps and the maintenance helper exposes sanitized status.
  Verify the operator check/apply path, root boundary, maintenance window,
  rollback image, alerting, and package-change record.
- [x] **DONE — external Rspamd and ClamAV definition boundary.** The scanner
  readers, active-pointer layout, digest/freshness checks, read-only Compose
  mounts, health metadata, atomic activation, and rollback-preserving
  generation contract are implemented. The provider still has to install and
  verify its host-side freshclam/map updater, feed permissions, alerting, and
  filesystem policy; those are VERIFY BEFORE USE work, not container code.
- [x] **DONE — Docker replacement and Kubernetes blue/green contract.** The
  repository models plan, preflight, prepare, readiness, connection drain,
  queue/IMAP IDLE continuity, cutover, rollback, observation, and finalize
  while retaining external volumes. Verify real timings, traffic switching,
  graceful termination, storage continuity, and rollback in the target
  environment.
- [x] **DONE — RPO/RTO and incident/DR contract shape.** Recovery objectives,
  integrity/privacy checks, sanitized evidence, and operator procedures are
  represented. Verify and approve measured objectives, escalation paths,
  tabletop response, restore timing, and business continuity ownership.

### Governance, API, MCP, and browser boundary

- [x] **DONE — RBAC and delegation.** Provider, tenant-master, user, and
  monitor roles, one-colleague delegation, forced master delegation, quota
  administration, and default-deny content access are tested. Verify the
  real identity mapping, tenant boundaries, and approval records.
- [x] **DONE — master log visibility.** Tenant policy controls whether a
  master may see administrative logs and the default is off. Verify the
  setting, audit trail, redaction, and cross-user denial.
- [x] **DONE — tenant monitoring API and MCP.** The runtime exposes safe
  health, readiness, metrics, and patch-status reads. Verify authentication,
  tenant scope, rate limits, no secret/content leakage, and read-only
  behavior.
- [x] **DONE — provider migration vocabulary.** Docker and Kubernetes
  plan/preflight/prepare/status/cutover/rollback/finalize names, idempotency,
  allowlists, and audit metadata are documented. Verify the provider
  controller and approval process once it exists.
- [x] **DONE — optional upstream Plesk/cPanel tenant-tool boundary.** The
  provider-neutral configuration, tenant binding, read-only capability matrix,
  pull/webhook/hybrid vocabulary, secret-reference rules, and default-deny
  behavior are implemented. Verify the selected panel API version, least-
  privilege account, callback verification, DNS ownership, reconciliation,
  rotation, and disable/rollback behavior in the real deployment.
- [x] **DONE — ADRs, documentation, license, and artifact governance.** The
  accepted TypeScript architecture, MIT/SPDX attribution, documentation
  inventory, and trusted-push attestation policy are present. Verify owner
  approvals, release retention, and consumer access.
- [ ] **OPEN CODE — provider-backed browser login and session wiring.** The
  HTTP shell and fixture authenticator are implemented, but the default
  runtime does not yet wire the real LDAP adapter into the authenticated
  login/session path. This remains repository work.

## Runbook definitions

The repository contracts are deliberately explicit about what a provider
operator must do. The steps below close the procedural gaps without pretending
that a workstation can perform them against someone else's infrastructure.

### Account deletion runbook

1. Confirm the tenant and user scope from the authenticated operator context.
2. Confirm the request ID, reason, strong confirmation string, and current
   policy. Do not accept a mailbox path, browser-supplied tenant, or free-form
   shell command as scope.
3. Check legal, operational, and backup holds. A held account stays recoverable
   and cannot enter irreversible purge.
4. Create the deletion request. The repository state moves from active to
   deletion_requested and records the recovery deadline.
5. Soft-delete the account after the second confirmation. Disable new login,
   submission, DAV, and background work while preserving recovery.
6. During the recovery window, allow an authorized restore. A restore cancels
   the pending deletion and must emit a metadata-only audit event.
7. After the recovery window, queue the purge only when no hold exists. The
   durable worker must use an idempotency key and a lease.
8. Execute the cleanup plan separately for aliases, delegations, MFA factors,
   backup links, mailbox data, DAV collections, PostgreSQL references, and LDAP
   identity state. Record one sanitized result per resource.
9. Complete the purge only when every planned resource reports purged. A
   partial result remains retryable and must not be reported as success.
10. Retain the required audit metadata and verify that the 28-day trash policy,
   backup retention, and legal holds were respected.

The repository code already defines the state machine and safety checks. What
is still needed outside the repository is the transactional adapter execution,
durable worker, approval, and a witnessed rehearsal. Those are verification
tasks unless a provider-specific adapter is still absent.

### Optional Plesk and cPanel upstream tenant-tool runbook

Plesk or cPanel may sit upstream of Gulo Gulo as the tenant's hosting-account
and (where selected) DNS tool. It is optional and is not a second source of
truth for users, quotas, aliases, mailbox content, calendars, contacts,
authentication decisions, retention, or audit semantics.

1. Create a dedicated least-privilege panel account or API token and store the
   value in the provider secret store. Put only its reference in Gulo Gulo.
2. Confirm the panel's HTTPS certificate, API version, account identifier, and
   tenant/domain mapping. One panel account or domain must map to one intended
   Gulo Gulo tenant binding.
3. Decide explicitly whether the panel or another provider owns DNS. Gulo Gulo
   may read DNS/domain state for diagnostics, but the V1 contract does not
   authorize panel-driven DNS or deployment writes.
4. Select pull, signed webhook, or hybrid reconciliation. Every event must
   include a bounded timestamp, tenant/domain binding, idempotency key, and
   audit record; an unknown or mismatched external ID fails closed.
5. Exercise duplicate, delayed, malformed, replayed, cross-tenant, revoked,
   and provider-outage cases. A webhook is only a reconciliation hint and
   never an instruction to execute an arbitrary command.
6. Disable the integration and confirm that Gulo Gulo policy, mail, DAV, and
   monitoring remain usable. Record credential rotation and rollback evidence.

The repository currently proves the safe configuration and binding contract.
It does not claim a live Plesk/cPanel API adapter, automatic DNS mutation,
Docker-socket access, SSH execution, or unrestricted panel command execution.

### Backup and restore runbook

1. Declare the tenant scope, archive scope, operator, encryption-key reference,
   retention, and target environment.
2. Snapshot or export PostgreSQL, mailbox, DAV, runtime configuration, queue,
   and audit references using the provider's durable storage.
3. Build an encrypted manifest with SHA-256 members and no credentials,
   cookies, factor secrets, private keys, or message content in metadata.
4. Verify the archive in an isolated target before importing anything.
5. Restore into a new tenant or explicitly approved cutover target. A user
   restore must not overwrite existing data by default.
6. Check tenant isolation, mailbox/DAV counts, quota state, aliases,
   delegations, authentication references, and audit continuity.
7. Record observed RPO and RTO, integrity and privacy results, operator,
   release, archive, and evidence checksum.
8. Keep the original source untouched until the restore and rollback decision
   are approved.

The repository provides the manifest, integrity, privacy, and objective
contracts. External snapshot connectors, key management, scheduled workers,
and measured restore timing remain OPEN CODE or provider integration work.

### Scanner definition publication runbook

The scanner containers intentionally do not run a feed updater. They read
verified generations from the provider-owned shared volume, mounted read-only.
Do not describe the deterministic proof images as production Rspamd or ClamAV
until the provider has completed the host-side feed rehearsal:

1. Pin the vendor image and package/definition source.
2. Update ClamAV definitions through freshclam or the supported equivalent, and
   update Rspamd maps, rules, fuzzy data, and reputation feeds.
3. Verify signature/map freshness, health, disk space, update checksum, and
   compatibility with the running daemon.
4. Stage the new definitions beside the current known-good set.
5. Run clean, spam, malware, timeout, and unavailable-scanner samples.
6. Atomically activate the new set; on any failure, keep the previous set and
   fail closed.
7. Emit sanitized freshness, result, and rollback metadata to operations
   monitoring.

The repository implements the reader, digest, freshness, atomic-pointer, and
rollback-preserving boundary. The feed-specific host job and its operational
evidence remain VERIFY BEFORE USE. A cron, systemd timer, Task Scheduler job,
or Kubernetes maintenance job must be the single writer; it must never make
the scanner containers writable or add a Docker-socket escape hatch.

### Container patch and image release runbook

1. Build the selected Ubuntu 26.04 image with the pinned source revision and
   build-time apt-get update plus apt-get upgrade policy.
2. Record the base-image digest, target architecture, package changes,
   vulnerability scan, SBOM, and release subject digest.
3. Run the repository gates and build the final `linux/amd64,linux/arm64`
   artifact directly for the version tag.
4. Publish only immutable, signed registry subjects after the required release
   checks pass; the workflow then creates or updates the matching GitHub
   Release and uploads the SBOM and digest-bound evidence.
5. Verify GitHub Artifact Attestation from a clean consumer context.
6. Keep the previous image available for rollback and retain the evidence.

Artifact provenance, SBOM generation, the amd64 field-container package, and
digest-bound release attestations are implemented in
`.github/workflows/container-release.yml`. Version-tag pushes automatically
publish the multi-architecture GHCR image and GitHub Release; a trusted
manual main-only publish path remains available. Registry policy, consumer
verification, and field deployment evidence remain VERIFY BEFORE USE work.

### Docker replacement and Kubernetes blue/green runbook

1. Plan with source/target versions and immutable digests, architecture,
   schema window, volume names, secret references, backup freshness, and
   rollback feasibility.
2. Run preflight without changing traffic. Check liveness, readiness, LDAP,
   PostgreSQL, mail store, queue, certificate, scanner, and patch status.
3. Prepare the green Docker container or Kubernetes Deployment with the same
   external state references and an expand-compatible schema.
4. Observe readiness, queue depth, delivery, IMAP IDLE reconnects, metrics,
   error budget, and audit events.
5. Cut over only after the green gate and explicit provider approval. Drain
   HTTP, WebSocket, IMAP IDLE, SMTP, and DAV connections within the deadline.
6. Keep blue available during the observation window. Roll back the traffic
   target without copying or deleting mailbox data if any gate regresses.
7. Finalize only after the observation window, backup/restore check, and
   operator approval. Retire blue last.

The state machine and rehearsal contracts are DONE in the repository. Live
traffic, real external volumes, Kubernetes, and timing evidence are VERIFY
BEFORE USE work.

### Incident and disaster-recovery runbook

1. Declare the incident, affected tenant scope, correlation ID, operator, and
   current release without putting secrets or message content in the record.
2. Classify the failure: LDAP, PostgreSQL, mail store, DAV, ACME, Rspamd,
   ClamAV, storage, network, container, or deployment cutover.
3. Apply the fail-closed policy for the affected dependency. Preserve the
   current valid certificate, known-good scanner definitions, blue release,
   queue, and durable state.
4. Communicate impact and start the approved recovery objective clock.
5. Restore or cut back in an isolated target, verify integrity and privacy,
   and collect sanitized evidence.
6. Record observed RPO/RTO, data loss, connection drain, queue handling,
   customer impact, and the decision to resume service.
7. Run a post-incident review, rotate exposed credentials if necessary, and
   update the runbook and release evidence.

The policy and evidence shape are DONE. On-call ownership, paging, tabletop
exercise, external recovery, and formal approval are VERIFY BEFORE USE.

## Field verification checklist

The following checklist is intentionally for the people who will use the
system. It should be completed against a real deployment and attached to the
release evidence system as sanitized records.

### Provider and deployment operator

- Verify DNS, IPv4, IPv6, firewall, reverse proxy, ACME challenge, certificate
  renewal, and expiry alert.
- Verify the selected secret store, least-privilege access, rotation, revoke,
  restart, and recovery behavior.
- Verify external LDAP TLS, bind privilege, directory filters, user login,
  timeout/retry, and outage behavior.
- Verify PostgreSQL TLS, role grants, RLS, migrations, backups, restore, and
  connection limits.
- Verify external volume creation, encryption, snapshots, ownership, restore,
  and replacement without data loss.
- Verify vendor Postfix, Dovecot, Rspamd, ClamAV, freshclam, CalDAV, and
  CardDAV images, versions, digests, configuration, and update sources.
- Verify the optional Plesk/cPanel panel account, API version, TLS, tenant/domain
  binding, webhook or pull policy, DNS ownership, and credential rotation.
- Verify queue, scanner, certificate, storage, authentication, and dependency
  alerts reach the assigned operator.
- Verify Docker replacement, Kubernetes cutover, connection drain, rollback,
  and the observation window.

### Tenant master and user tester

- Verify tenant isolation, roles, delegation, quota ceiling, aliases, and
  default-deny mailbox/calendar/contact access.
- Verify the master log setting remains off unless the tenant explicitly
  enables it.
- Verify user backup scope, download expiry, restore authorization, and
  account deletion recovery.
- Verify SMTP, IMAP, IDLE, Sieve, CalDAV, CardDAV, discovery, timezone, and
  browser behavior with representative clients.
- Verify the API/MCP monitor returns only the caller's safe metadata and never
  permits tenant writes or arbitrary commands.

### Release and security tester

- Verify immutable image digests, SBOM, signature, provenance, and consumer
  attestation from a clean environment.
- Run negative tests for open relay, forwarding, catch-all, spoofing, scanner
  failure, CSRF, session replay, cross-tenant access, path traversal, and
  secret leakage.
- Exercise backup restore, account deletion, hold, rollback, and incident
  procedures with production-like data volume and sanitized evidence.
- Measure latency, memory, queue depth, storage pressure, connection counts,
  RPO, and RTO on both supported architectures where applicable.

## Evidence hand-off rules

Keep evidence small and useful:

- record release commit, image digest, platform, environment class, operator,
  start/end time, result, and an evidence checksum;
- keep credentials, private keys, cookies, raw logs, message bodies, archive
  contents, absolute workstation paths, and unrestricted command output out of
  the record;
- link the provider record to the corresponding Section 30 item and replace
  contract/deferred evidence with verified evidence only after the rehearsal;
- do not edit the root README merely to record a field rehearsal;
- keep the root README open only for the OPEN CODE items below.

## Repository implementation work still open

These are the remaining repository tasks. They are deliberately not disguised
as tester work:

- [ ] concrete provider secret-store and rotation adapter behind the existing
  secret-reference boundary;
- [ ] provider-backed authenticated login/session wiring that calls the real
  LDAP adapter instead of the fixture authenticator;
- [ ] production Postfix/Dovecot mail adapters, persistent DAV backend, and
  complete HTTP/WebDAV method and XML-report integration;
- [ ] durable external backup, restore, account-deletion execution, and
  scheduled retention workers for volume, PostgreSQL, mailbox, DAV, and
  object-store adapters;
- [ ] provider migration controller plus live provider API/MCP wiring for the
  documented Docker and Kubernetes operations;
- [ ] provider-specific Plesk/cPanel API adapter and idempotent reconciliation
  behind the validated read-only tenant binding;
- [ ] provider ACME/DNS client integration and deployed log collector,
  alert-delivery, and paging adapters.

Shared mailboxes, resource calendars, write-capable tenant API/MCP operations,
and assisted IMAP migration remain intentionally deferred product features,
not accidental readiness gaps.

## Final acceptance rule

Gulo Gulo can be called production-ready only when:

1. every OPEN CODE item required by the selected deployment is implemented and
   covered by repository gates;
2. every VERIFY BEFORE USE item has a sanitized provider/tester record;
3. backup, restore, account deletion, scanner updates, migration, rollback,
   RPO/RTO, and incident/DR evidence has an owner and approval;
4. the release evidence object contains the real commit and image subjects;
5. the release evaluator reports productionReady as true.

Until then, the honest description is a usable, tested repository contract
preview with a clearly documented deployment hand-off.
