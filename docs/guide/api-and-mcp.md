# API and MCP operations

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

The tenant-facing API/MCP is read-only end to end; no provider-side
provisioning/upgrade API exists or is planned (see
`doc/upgrade-and-migration.md` for the actual, current per-target upgrade
mechanism).
