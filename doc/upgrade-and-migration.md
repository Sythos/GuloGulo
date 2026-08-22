# Upgrade and migration operations

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This is the operator manual for replacing a Gulo Gulo container with a newer
image and for preparing the Kubernetes zero-downtime path. The implementation
is planned for M9; the current M3 repository exposes no write-capable upgrade
endpoint. The examples below define the contract that future deployment
controllers must implement and test.

## Two API surfaces, two trust levels

The tenant monitoring API and MCP remain read-only. They can report version,
digest, health, queue state, patch status, and migration evidence, but they
cannot start or cut over a deployment.

Upgrade execution belongs to a separate provider/operator control plane. It
must have its own token audience, RBAC, approval workflow, audit stream,
idempotency store, timeout, and rollback policy. It must never expose the
Docker socket, accept arbitrary shell input, or forward unrestricted
`kubectl` arguments.

The planned operations are:

| Operation | HTTP | MCP | Mutates deployment? |
|---|---|---|---:|
| Capabilities | `GET /provider/upgrade/capabilities` | `gulogulo.upgrade.capabilities` | No |
| Plan | `POST /provider/upgrade/plan` | `gulogulo.upgrade.plan` | No |
| Preflight | `POST /provider/upgrade/preflight` | `gulogulo.upgrade.preflight` | No |
| Prepare green | `POST /provider/upgrade/prepare` | `gulogulo.upgrade.prepare` | Yes |
| Status | `GET /provider/upgrade/status/{operationId}` | `gulogulo.upgrade.status` | No |
| Cutover | `POST /provider/upgrade/cutover` | `gulogulo.upgrade.cutover` | Yes |
| Rollback | `POST /provider/upgrade/rollback` | `gulogulo.upgrade.rollback` | Yes |
| Finalize | `POST /provider/upgrade/finalize` | `gulogulo.upgrade.finalize` | Yes |

The mutating operations require `provider/operator` authorization and a
structured request containing:

```json
{
  "sourceVersion": "0.3.0",
  "sourceDigest": "sha256:source-image-digest",
  "targetVersion": "0.4.0",
  "targetDigest": "sha256:target-image-digest",
  "platform": "docker",
  "strategy": "blue_green",
  "deadlineSeconds": 1800,
  "idempotencyKey": "upgrade-2026-08-22-gulogulo-0001"
}
```

The controller returns an `operationId`, state, sanitized checks, and a
correlation ID. It does not return secrets, registry credentials, message
content, or raw deployment command output. Repeating an idempotency key returns
the original operation state instead of starting a second rollout.

## Docker-to-Docker replacement

The important detail is what does not move: mailbox and control-plane data are
not copied through the application container. The target uses the same
external `runtime-state`, `mail-data`, `dav-data`, and `backup-data` volumes,
plus the same external PostgreSQL and LDAP services. On a different Docker
host, the provider first makes those stores available through the approved
storage/backup mechanism, verifies their checksums, and only then prepares the
target.

### Declarative sequence

1. **Plan** — verify target image digest, Ubuntu 26.04 architecture support,
   schema compatibility, volume names, secret references, backup freshness,
   and rollback feasibility.
2. **Preflight** — start the target on an isolated port. Check liveness,
   readiness, LDAP/PostgreSQL connectivity, mail-store access, queue state,
   certificate health, and patch status. No public traffic changes.
3. **Prepare** — start green beside blue using the same external stores and an
   expand-compatible database schema.
4. **Observe** — monitor health, queue depth, LMTP outcomes, IMAP IDLE
   reconnects, error rates, metrics, and audit events.
5. **Cut over** — switch the edge/reverse-proxy target, drain old connections,
   and keep blue available for rollback.
6. **Rollback** — return traffic to blue when an SLO, dependency, queue, or
   data-integrity gate fails. Do not delete or overwrite mailbox data.
7. **Finalize** — retire blue only after the observation window and a restore
   check in an isolated environment.

An implementation may use Compose, systemd, or a container runtime underneath,
but the API/MCP request remains declarative. The controller allowlist must
validate image digest, platform, project name, volume names, network names,
timeouts, and the expected source version before it invokes the runtime.

## Kubernetes blue/green, zero-downtime path

The Kubernetes driver uses `gulogulo-blue` and `gulogulo-green` Deployments and
a stable Service or Gateway. Both versions use external PostgreSQL, LDAP, DAV,
mail, backup, and queue state. The mail queue and mailbox data are never held
only in a Pod filesystem.

Green is eligible for cutover only when all of these are true:

- startup, liveness, and readiness probes are healthy;
- the expanded schema is readable by both versions;
- `maxUnavailable: 0` and a bounded `maxSurge` are in force;
- the PodDisruptionBudget and topology-spread constraints are satisfied;
- pre-stop drain and termination grace are configured for HTTP, SMTP, IMAP
  IDLE, and WebSocket reconnects;
- image digest, schema-window, and configuration compatibility checks pass;
- queue, dependency, smoke, and audit checks are green.

The controller may use an internal command allowlist equivalent to:

```text
kubectl apply -f gulogulo-green.yaml
kubectl rollout status deployment/gulogulo-green --namespace gulogulo --timeout=10m
kubectl get endpoints gulogulo-web --namespace gulogulo
kubectl patch service gulogulo-web --namespace gulogulo --type=merge --patch '{"spec":{"selector":{"track":"green"}}}'
kubectl rollout undo deployment/gulogulo-green --namespace gulogulo
```

Those strings are not accepted from the caller. Namespace, resource names,
selectors, image digests, and timeout bounds come from validated deployment
configuration. The controller refuses volume deletion, readiness bypass, an
unverified image, a second concurrent cutover, or a tenant token attempting to
invoke an operator command.

Blue remains scaled and rollback-ready until the observation window ends. A
successful cutover is a routing change over shared durable state, not a blind
file copy. The sequence is therefore safe to rehearse repeatedly and can be
rolled back without destroying forward-compatible data.

## Audit and failure behavior

Every operation records its operation ID, source/target versions and digests,
platform, actor, tenant/provider scope, correlation ID, timestamps, decision,
and sanitized failure reason. Never record registry credentials, pull-secret
contents, Kubernetes tokens, raw command output, mailbox data, or message
bodies.

The controller fails closed when LDAP, PostgreSQL, mail storage, the persistent
queue, certificate state, or readiness checks are unavailable. A failed green
deployment leaves blue serving. A rollback is not considered complete until
traffic points to blue and the status endpoint confirms healthy dependencies.

## M9 acceptance evidence

Before these commands are enabled, M9 must demonstrate:

- Docker-to-Docker replacement with external volumes and no mailbox loss;
- blue/green Compose or equivalent cutover and rollback;
- Kubernetes green readiness, Service cutover, drain, and rollback;
- N-to-N+1 expand/backfill/switch/contract compatibility;
- queue and IMAP IDLE reconnect behavior without duplicate delivery;
- operation idempotency, RBAC, audit, rate limiting, and redaction;
- negative tests for arbitrary command, volume deletion, readiness bypass,
  unverified digest, and tenant-token escalation;
- workflow artefacts showing the full rehearsal and its restore check.
