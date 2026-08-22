<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

# ACME, abuse controls, and production Compose

This manual covers the M8 contracts in Gulo Gulo. It is written for the person
who has to put the service on a real host, keep certificates healthy, and stop
one noisy client from turning a tenant into a denial-of-service machine.

The code in this milestone is deliberately dependency-light. It validates
configuration, models renewal and reload state, applies bounded rate and
lockout rules, and checks a production Compose document. It does not pretend to
be a complete ACME client, a distributed rate-limit database, or a replacement
for an external secret store. Those adapters belong at the deployment boundary.

## 1. What M8 owns

M8 adds four operational contracts:

1. an ACME configuration contract with Let's Encrypt as the default provider;
2. a certificate-health and renewal state machine with safe reload metadata;
3. metadata-only abuse controls for HTTP, API, MCP, login, recovery, backup,
   WebSocket, DAV, SMTP, and IMAP channels;
4. a fail-closed production-Compose readiness check.

The tenant-facing API and MCP remain read-only in V1. A provider deployment
controller may use the same contracts from a privileged, separately audited
control plane, but it must not expose Docker sockets, arbitrary shell input, or
unrestricted `kubectl` to a tenant.

## 2. ACME configuration

The module is `src/ops/acme/index.mjs`. The main entry point is:

```js
import { createAcmeConfig } from './src/ops/acme/index.mjs';

const config = createAcmeConfig({
  domains: ['mail.example.test', 'autoconfig.example.test'],
  account: {
    contactEmail: 'postmaster@example.test',
    keySecretRef: 'secret/gulogulo/acme-account-key',
  },
  challenge: { type: 'http-01', listenPort: 8080, publicPort: 80 },
  renewal: { enabled: true, renewBeforeDays: 30 },
});
```

The returned object is frozen and contains only references to secrets. Private
keys, PEM blocks, bearer tokens, and passwords are rejected as configuration
values. Keep the actual material in the host secret store, Docker secrets,
Kubernetes Secrets backed by an appropriate provider, or an equivalent system.

Defaults are intentionally boring:

- provider: `letsencrypt`;
- directory: `https://acme-v02.api.letsencrypt.org/directory`;
- environment: `production`;
- challenge: HTTP-01;
- automatic renewal: enabled;
- renewal lead time: 30 days;
- expiry warning: 30 days;
- expiry critical: 7 days;
- TLS protocols: TLS 1.2 and TLS 1.3.

Use the staging directory before a new hostname or deployment is allowed to
hit production issuance:

```js
createAcmeConfig({
  domains: ['mail.example.test'],
  environment: 'staging',
  account: { keySecretRef: 'secret/gulogulo/acme-staging-account' },
});
```

Generic ACME is supported by supplying an HTTPS directory URL and selecting the
`acme` provider. This covers a corporate CA or a private test CA. Directory
URLs cannot contain credentials, query strings, or fragments.

### 2.1 HTTP-01 and DNS-01

HTTP-01 is the default and is suitable for ordinary, non-wildcard hostnames.
The reverse proxy or edge listener must route
`/.well-known/acme-challenge/` to the challenge handler without authentication
or content rewriting. The contract records the internal listener port and the
public port, so a port translation is explicit.

DNS-01 is required for wildcard names. It needs a DNS provider name and a
secret reference for that provider's credentials:

```js
createAcmeConfig({
  domains: ['*.example.test'],
  challenge: {
    type: 'dns-01',
    dnsProvider: 'cloud-dns',
    credentialsSecretRef: 'secret/gulogulo/dns-provider',
    propagationTimeoutSeconds: 180,
  },
  account: { keySecretRef: 'secret/gulogulo/acme-account-key' },
});
```

The application must never log the DNS credential, account key, certificate
PEM, or challenge token. The contract's redaction helper is a safety net, not a
reason to pass secrets through ordinary request metadata.

## 3. Renewal and reload lifecycle

`createRenewalState()` and `advanceRenewal()` model the provider-neutral
sequence:

```text
idle → authorizing → ordering → finalizing → reload_pending → active
                           ↘ retry_wait / degraded / failed
```

An adapter is expected to:

1. ask the contract whether renewal is due;
2. complete ACME authorization and order operations outside the web request;
3. store the new certificate and chain in the secret-capable persistent store;
4. create a `createSafeReloadPlan()` record for web, Postfix, and Dovecot;
5. reload consumers one at a time, checking health after each reload;
6. keep the previous valid certificate available until the observation window
   has passed;
7. emit `certificate.issued`, `certificate.renewed`, or
   `certificate.renewal_failed` with no private material.

Retry delays use a bounded exponential schedule. Renewal failure must preserve
the current valid certificate when possible, raise an expiry alert, and leave a
clear operator action. A failed reload is not success just because the new PEM
was written to disk.

## 4. Certificate health and monitoring

`evaluateCertificateHealth()` checks:

- `notBefore` and `notAfter` validity;
- the requested hostname, including wildcard matching;
- chain validity and private-key/certificate matching;
- renewal and expiry thresholds.

The result is safe to expose through read-only monitoring because it contains
status, timestamps, and alert types rather than certificate contents. A useful
monitoring response looks like this:

```json
{
  "status": "degraded",
  "renewalDue": true,
  "daysRemaining": 12,
  "alerts": [
    { "type": "certificate.expiry_warning", "severity": "warning" }
  ]
}
```

API/MCP read scopes may expose certificate status, provider name, renewal state,
last successful renewal, next retry, and days to expiry. They must not expose
account keys, private keys, DNS credentials, bearer tokens, or raw ACME
authorization objects. Any provider-side renewal action belongs to a separate
audited control plane and is outside the tenant read-only surface.

## 5. Abuse and rate controls

The module is `src/ops/abuse/index.mjs`. `createRateLimiter()` applies limits
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

## 6. Production Compose readiness

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

The real production runbook must still confirm DNS, firewalling, ACME challenge
routing, backup destination, secret rotation, alert delivery, and rollback.

## 7. Docker and Kubernetes notes

The application image remains an Ubuntu 26.04 LTS multi-architecture image for
`linux/amd64` and `linux/arm64`. Build-time APT patching is handled by the
existing image maintenance contract; a running production container is not
mutated through an exposed Docker socket.

For Docker-to-Docker replacement, keep the external volume names and secret
references stable, preflight the new image, observe it before cutover, and keep
the old container available for rollback. For Kubernetes, use the M9
blue/green Deployment and stable Service/Gateway procedure. M8 only validates
the production-readiness boundary; it does not mark the zero-downtime rehearsal
complete.

## 8. Verification boundary

The M8 tests cover default Let's Encrypt configuration, staging and generic
ACME, HTTP-01/DNS-01 validation, secret redaction, retry and renewal
transitions, TLS health, multi-dimensional rate limiting, lockout/quarantine,
audit redaction, and fail-closed Compose readiness. They do not contact a real
ACME CA, mutate DNS, reload a real Postfix/Dovecot process, or prove distributed
rate-limit consistency. Those are deliberate deployment acceptance gates for
later operational testing.
