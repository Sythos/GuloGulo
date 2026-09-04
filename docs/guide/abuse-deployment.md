<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

# Abuse controls and production readiness

> **⚠️ Documento in transizione.** Le sezioni di questo documento che descrivono deployment container/Docker/Kubernetes (volumi, socket, sidecar, rollout blue/green) si riferiscono al modello precedente, abbandonato — vedi [ADR-002](../adr/ADR-002-gulogulo-packaging-and-distribution-targets.md). Il contenuto su protocolli, sicurezza applicativa, e logica di business resta valido; gli aspetti di deployment container-specifici non sono più applicabili e saranno riscritti quando necessario.

This manual covers the M8 abuse-control contracts in Gulo Gulo. It is written
for the person who has to put the service on a real host and stop one noisy
client from turning a tenant into a denial-of-service machine.

The code in this milestone is deliberately dependency-light. It applies
bounded rate and lockout rules and checks a production Compose document. It
does not pretend to be a distributed rate-limit database or a replacement for
an external secret store. Those adapters belong at the deployment boundary.

## 1. What M8 owns

M8 adds two operational contracts:

1. metadata-only abuse controls for HTTP, API, MCP, login, recovery, backup,
   WebSocket, DAV, SMTP, and IMAP channels;
2. a fail-closed production-Compose readiness check.

The tenant-facing API and MCP remain read-only in V1. A provider deployment
controller may use the same contracts from a privileged, separately audited
control plane, but it must not expose Docker sockets, arbitrary shell input, or
unrestricted `kubectl` to a tenant.

## 2. Abuse and rate controls

The canonical module is `src/core/ops/abuse/index.ts` (there is no `.mjs`
compatibility bridge). `createRateLimiter()` applies limits
per tenant, IP, and opaque session for every required channel. The default
channels are:

```text
http api mcp login recovery backup websocket dav smtp imap
```

Each decision returns `allowed`, `limitedBy`, `retryAfterMs`, `remaining`, and a
reset timestamp. IP addresses and session identifiers are hashed before they
enter state or appear in a result. The limiter is an in-process contract; a
production deployment must put a bounded, tenant-aware shared store behind it
when more than one application replica is active.

`createAbuseGuard()` adds failure windows, lockout, quarantine, release, and
metadata-only audit callbacks. Use it for repeated authentication failures,
recovery abuse, suspicious backup downloads, and other high-cost operations.
Do not put message bodies, request payloads, cookies, credentials, or raw
session identifiers in the details object.

Example:

```js
const decision = limiter.consume({
  channel: 'login',
  tenantId: 'tenant-acme',
  ipAddress: request.ip,
  sessionId: request.sessionId,
});

if (!decision.allowed) {
  return new Response('Too many requests', {
    status: 429,
    headers: { 'retry-after': String(Math.ceil(decision.retryAfterMs / 1000)) },
  });
}
```

The API/MCP may read aggregate counters, lockout status, quarantine status, and
redacted audit events when the caller has the monitoring scope. It must not
allow a tenant to disable global safety ceilings or retrieve another tenant's
raw identities. Any provider override is an explicitly authorized and audited
operation, not a query parameter.

## 3. Production Compose readiness

`validateComposeProductionReadiness()` is a preflight check, not a substitute
for a deployment review. A production service must be:

- non-root and read-only;
- `cap_drop: [ALL]` with `no-new-privileges:true`;
- bounded for CPU, memory, and PIDs;
- connected to external LDAP and PostgreSQL through external hosts and secret
  references when those dependencies are enabled;
- mounted only on the named external volumes `runtime-state`, `mail-data`,
  `dav-data`, and `backup-data`;
- free of host networking, host namespaces, and Docker socket mounts.

The check fails closed for missing secret references, plaintext secret values,
loopback or placeholder dependency hosts, mutable filesystems, missing limits,
root users, weak privileges, host namespaces, and non-external data volumes.
Disabled optional dependencies produce warnings, not false readiness failures.

Run the contract locally with:

```powershell
npm run test:m8
```

The real production runbook must still confirm DNS, firewalling, backup
destination, secret rotation, alert delivery, and rollback.

## 4. Docker and Kubernetes notes

The application image remains an Ubuntu 26.04 LTS image for `linux/amd64`.
Build-time APT patching is handled by the existing image maintenance contract;
a running production container is not mutated through an exposed Docker
socket.

For Docker-to-Docker replacement, keep the external volume names and secret
references stable, preflight the new image, observe it before cutover, and keep
the old container available for rollback. For Kubernetes, use the M9
blue/green Deployment and stable Service/Gateway procedure. M8 only validates
the production-readiness boundary; it does not mark the zero-downtime rehearsal
complete.

## 5. Verification boundary

The M8 tests cover multi-dimensional rate limiting, lockout/quarantine, audit
redaction, and fail-closed Compose readiness. They do not reload a real
Postfix/Dovecot process or prove distributed rate-limit consistency. Those are
deliberate deployment acceptance gates for later operational testing.
