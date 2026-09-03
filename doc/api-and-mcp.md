# API and MCP operations

> **⚠️ Documento in transizione.** Le sezioni di questo documento che descrivono deployment container/Docker/Kubernetes (volumi, socket, sidecar, rollout blue/green) si riferiscono al modello precedente, abbandonato — vedi [ADR-002](../../ADR-002-gulogulo-packaging-and-distribution-targets.md). Il contenuto su protocolli, sicurezza applicativa, e logica di business resta valido; gli aspetti di deployment container-specifici non sono più applicabili e saranno riscritti quando necessario.

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

The API surface in this milestone is intentionally read-only. It is useful for
health checks, dashboards, and tenant-scoped monitoring, but it is not a remote
shell and it cannot change configuration, install packages, or read another
user's mailbox.

## Current HTTP contract

The runtime exposes:

```text
GET /health/live
GET /health/ready
GET /healthz
GET /readyz
GET /metrics
GET /ops/patch/status
```

`HEAD` is accepted for the same routes. Other methods receive `405` with an
explicit `Allow: GET, HEAD` header. Responses include request and correlation
IDs, so an operator can join an HTTP response to the JSON log stream.

The patch endpoint returns the typed, metadata-only DTO from
`src/core/ops/patch/status.ts`. It never returns APT output, shell text, credentials,
or arbitrary error strings. Missing or malformed state is deliberately reported
as `unknown`, and the route cannot start `apt-get` or mutate the patch volume.
Runtime requests also pass through bounded channel rate limits; a rejected
request receives `429` and `Retry-After`, while the structured audit stream
records only the channel and redacted decision metadata.

For a quick check:

```powershell
$headers = @{ 'x-request-id' = 'manual-001'; 'x-correlation-id' = 'ops-001' }
Invoke-RestMethod http://127.0.0.1:8080/health/ready -Headers $headers
Invoke-RestMethod http://127.0.0.1:8080/ops/patch/status -Headers $headers
```

## MCP mapping

When the read-only MCP adapter is introduced, map monitoring tools to the same
contracts instead of inventing a second status model. A useful first set is:

```text
gulogulo.health.live
gulogulo.health.ready
gulogulo.metrics.snapshot
gulogulo.patch.status
```

Each tool must enforce tenant scope, expose only the fields allowed by the
caller role, redact secrets and message content, and emit an audit event for
the access. The MCP layer must call application services; it must never connect
directly to LDAP, PostgreSQL, mailbox storage, or the Docker socket.

## What is deliberately not here

There is no write API or write MCP tool in V1. In particular, no request may:

- run `apt-get`;
- choose an arbitrary image, package, or shell command;
- change a tenant, user, alias, quota, or policy;
- open another user's mailbox, calendar, contacts, or session;
- return a password, token, DSN, private key, or message body.

Provider-side patch orchestration is a deployment concern. If a future
operator-only control endpoint is needed, it gets its own threat model,
allowlist, authentication, approval/audit trail, idempotency key, timeout,
rollback behavior, and negative tests before it becomes callable.

## Upgrade and migration command contract

M9 now provides a deterministic provider-only migration control-plane contract.
It is intentionally separate from the tenant monitoring API/MCP described
above. The tenant surface stays read-only; the provider surface may execute
only the allowlisted deployment operations below after a real deployment
controller supplies its own threat model, approval workflow, and runtime
credentials.

The command names are stable across Docker Compose and Kubernetes. A controller
behind the API/MCP maps them to the selected deployment driver; it never passes
through arbitrary shell text, Docker socket calls, image names from an
untrusted request, or unrestricted `kubectl` arguments.

| Operation | Provider HTTP route | MCP tool | Safe purpose |
|---|---|---|---|
| Capabilities | `GET /provider/upgrade/capabilities` | `gulogulo.upgrade.capabilities` | Show current version, supported strategy, architecture, and feature flags |
| Plan | `POST /provider/upgrade/plan` | `gulogulo.upgrade.plan` | Validate source/target digests, schema window, volumes, backups, and rollback plan; no mutation |
| Preflight | `POST /provider/upgrade/preflight` | `gulogulo.upgrade.preflight` | Run readiness, dependency, compatibility, and storage checks; no traffic change |
| Prepare | `POST /provider/upgrade/prepare` | `gulogulo.upgrade.prepare` | Start the verified green Docker container or Kubernetes Deployment |
| Status | `GET /provider/upgrade/status/{operationId}` | `gulogulo.upgrade.status` | Read rollout, queue, connection-drain, audit, and error-budget state |
| Cutover | `POST /provider/upgrade/cutover` | `gulogulo.upgrade.cutover` | Switch traffic only after green readiness and explicit approval |
| Rollback | `POST /provider/upgrade/rollback` | `gulogulo.upgrade.rollback` | Restore blue traffic target while retaining external data |
| Finalize | `POST /provider/upgrade/finalize` | `gulogulo.upgrade.finalize` | Retire blue only after the observation window and restore evidence |

Every request that can mutate deployment state requires a provider/operator
role, `idempotencyKey`, `sourceVersion`, `sourceDigest`, `targetVersion`,
`targetDigest`, `platform` (`docker` or `kubernetes`), and a bounded
`deadline`. A response contains an `operationId`, a state, safe checks, and a
correlation ID. It never contains secrets, pull credentials, raw command
output, message bodies, or a writable token for another operation.

Example plan request:

```http
POST /provider/upgrade/plan
Authorization: Bearer <provider-scoped-token>
Content-Type: application/json
Idempotency-Key: upgrade-2026-08-22-gulogulo-0001

{
  "sourceVersion": "0.3.0",
  "sourceDigest": "sha256:source-image-digest",
  "targetVersion": "0.4.0",
  "targetDigest": "sha256:target-image-digest",
  "platform": "kubernetes",
  "strategy": "blue_green",
  "deadlineSeconds": 1800
}
```

The same operation through MCP uses structured arguments rather than a shell
string:

```text
gulogulo.upgrade.plan({
  sourceVersion: "0.3.0",
  sourceDigest: "sha256:source-image-digest",
  targetVersion: "0.4.0",
  targetDigest: "sha256:target-image-digest",
  platform: "kubernetes",
  strategy: "blue_green",
  deadlineSeconds: 1800,
  idempotencyKey: "upgrade-2026-08-22-gulogulo-0001"
})
```

The tool must return a plan or a non-revealing validation error. It must not
start an upgrade merely because a plan was requested.

## Docker-to-Docker replacement

The deployment controller uses the external `runtime-state`, `mail-data`,
`dav-data`, and `backup-data` volumes plus external PostgreSQL and LDAP. It
does not copy mailbox files through an application container and it never
assumes that a container filesystem is durable.

The provider runbook is:

1. `plan` verifies the immutable target digest, architecture, schema
   compatibility, external volume names, secret references, backup freshness,
   and rollback feasibility.
2. `preflight` starts the target container on an isolated port and checks
   liveness, readiness, LDAP/PostgreSQL, mail-store, queue, certificate, and
   patch-status contracts.
3. `prepare` starts green beside blue with the same external volumes and an
   expand-compatible schema.
4. `status` watches queue depth, LMTP delivery, IMAP IDLE reconnects, health,
   error rate, metrics, and audit evidence.
5. `cutover` changes the edge/reverse-proxy target, drains connections with a
   grace period, and leaves blue available for rollback.
6. `rollback` changes the edge target back to blue without copying or deleting
   mailbox data.
7. `finalize` is permitted only after the observation window and a successful
   isolated backup/restore check.

The controller may internally use a deployment-specific Compose or container
runtime command, but the public API/MCP request contains declarative fields
only. Every action is idempotent and audited.

## Kubernetes zero-downtime preparation

The Kubernetes driver uses two Deployments, `gulogulo-blue` and
`gulogulo-green`, and one stable Service/Gateway target. Both versions share
external PostgreSQL, LDAP, DAV, mail, backup, and queue state. The green
Deployment must provide:

- startup, liveness, and readiness probes with separate failure semantics;
- `maxUnavailable: 0` and a bounded `maxSurge`;
- a PodDisruptionBudget and topology spread where the cluster supports it;
- a `preStop` drain hook and a termination grace period long enough for HTTP,
  IMAP IDLE, SMTP, and WebSocket reconnect behavior;
- the same external volume claims or storage class contract, never an
  application-only ephemeral mailbox volume;
- image digest pinning and a compatibility label containing the schema window.

The controller's internal allowlist is equivalent to the following commands;
the API/MCP caller cannot substitute values into them:

```text
kubectl apply -f gulogulo-green.yaml
kubectl rollout status deployment/gulogulo-green --namespace gulogulo --timeout=10m
kubectl get endpoints gulogulo-web --namespace gulogulo
kubectl patch service gulogulo-web --namespace gulogulo --type=merge --patch '{"spec":{"selector":{"track":"green"}}}'
kubectl rollout undo deployment/gulogulo-green --namespace gulogulo
```

Cutover is allowed only after green readiness, dependency checks, queue
stability, and smoke tests pass. Blue remains running and rollback-ready until
the observation window expires. The driver must refuse destructive volume
operations, an unverified image, a bypassed readiness gate, a namespace or
resource name outside its allowlist, or an attempt to turn a tenant-scoped
read-only token into an operator token.

The detailed release sequence and required audit events are also part of the
canonical specification's blue/green section and the M9 milestone record.
