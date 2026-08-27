# Upgrade and migration operations

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This is the operator manual for replacing a Gulo Gulo container with a newer
image and for preparing the Kubernetes zero-downtime path. M9 established the
dependency-light, deterministic contract boundary in `src/upgrade/`; LP7 carries
that contract into a bounded synthetic Docker replacement and Kubernetes
blue/green rehearsal. Together they validate the provider-only operation model,
the expand/backfill/switch/contract schema window, shared external state, queue
hand-off, connection draining, Docker replacement, Kubernetes readiness,
rollback, and finalization gates.

The contract is deliberately not a claim that this checkout can already mutate
a live Docker host or Kubernetes cluster. A deployment controller still has to
connect these validated plans to the approved operator runtime and to real
external stores. Keeping that boundary explicit makes the local and CI tests
useful without pretending that a fixture is a production rollout.

## Two API surfaces, two trust levels

The tenant monitoring API and MCP remain read-only. They can report version,
digest, health, queue state, patch status, and migration evidence, but they
cannot start or cut over a deployment.

Upgrade execution belongs to a separate provider/operator control plane. It
must have its own token audience, RBAC, approval workflow, audit stream,
idempotency store, timeout, and rollback policy. It must never expose the
Docker socket, accept arbitrary shell input, or forward unrestricted
`kubectl` arguments.

The operation contract is:

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

## Canonical M9 contract and LP7 rehearsal

The implementation is split into three small modules:

- `src/upgrade/compatibility.ts` owns version/digest validation, the
  expand/backfill/switch/contract sequence, forward-compatible checkpoints,
  and the rollback-safe schema window;
- `src/upgrade/rollout.ts` owns external-state references, queue hand-off,
  connection drain/reconnect behavior, Docker replacement plans, Kubernetes
  blue/green readiness, and the action allowlist;
- `src/upgrade/control-plane.ts` owns provider/operator authorization,
  idempotency, the operation state machine, sanitized status, and audit events.

The `.mjs` files in this directory are behavior-free compatibility bridges for
legacy callers. The canonical public barrel is `src/upgrade/index.ts`; the
legacy `src/upgrade/index.mjs` re-exports it. Run the focused contract suite
with:

```text
npm run test:m9
```

The state machine is intentionally boring and easy to inspect:

```text
planned
  -> preflight_passed
  -> prepared
  -> serving_green
  -> finalized

prepared or serving_green -> rolled_back -> finalized
any pre-cutover failure   -> failed      -> rolled_back
```

The controller refuses a tenant, master, user, or monitoring role; only the
provider/operator audience can execute it. The tenant monitoring API and MCP
remain read-only. Mutating provider calls require an idempotency key, the
expected source version and digest, a target digest, a bounded deadline, and a
validated platform. The returned objects contain no secret, raw shell text,
Docker socket path, unrestricted `kubectl`, mailbox content, or registry
credential.

The M9 contract tests cover:

- strict request and digest validation, including unsafe command rejection;
- idempotent plans and provider-versus-tenant authorization;
- forward-compatible schema phases and checkpoint evidence;
- persistent queue and duplicate-delivery protection;
- HTTP, WebSocket, IMAP IDLE, SMTP, and DAV drain ordering;
- Docker external-volume replacement without mailbox copying;
- Kubernetes readiness, zero `maxUnavailable`, PDB, and rollback readiness;
- preflight, prepare, cutover, rollback, and observation/restore finalization.

LP7 adds the strict TypeScript rehearsal in `src/upgrade/rehearsal.ts` and its
five direct tests. The rehearsal models Docker replacement and Kubernetes
blue/green state transitions without invoking a host runtime: external
PostgreSQL/LDAP references and named volumes remain shared, readiness gates the
switch, queue entries are deduplicated and handed off, IMAP IDLE reconnect
sequence numbers continue, and rollback keeps blue serving while retaining
green metadata for audit. Its Compose proof is documented in
`doc/lp7-local-upgrade.md` and is intentionally synthetic and offline.

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

Before these commands are enabled against a real deployment, M9 must
demonstrate:

- Docker-to-Docker replacement with external volumes and no mailbox loss;
- blue/green Compose or equivalent cutover and rollback;
- Kubernetes green readiness, Service cutover, drain, and rollback;
- N-to-N+1 expand/backfill/switch/contract compatibility;
- queue and IMAP IDLE reconnect behavior without duplicate delivery;
- operation idempotency, RBAC, audit, rate limiting, and redaction;
- negative tests for arbitrary command, volume deletion, readiness bypass,
  unverified digest, and tenant-token escalation;
- workflow artefacts showing the full rehearsal and its restore check.

The current M9 milestone records the deterministic contract and all local/CI
quality gates. Live CA/DNS, Postfix/Dovecot session behavior, a real external
volume snapshot, Docker-host replacement, Kubernetes traffic switching, and a
measured zero-downtime rehearsal remain operational evidence for the final
release path.
