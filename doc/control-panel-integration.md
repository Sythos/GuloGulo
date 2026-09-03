# Optional Plesk and cPanel integration

> **⚠️ Documento in transizione.** Le sezioni di questo documento che descrivono deployment container/Docker/Kubernetes (volumi, socket, sidecar, rollout blue/green) si riferiscono al modello precedente, abbandonato — vedi [ADR-002](../../ADR-002-gulogulo-packaging-and-distribution-targets.md). Il contenuto su protocolli, sicurezza applicativa, e logica di business resta valido; gli aspetti di deployment container-specifici non sono più applicabili e saranno riscritti quando necessario.

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

Some tenants already run their domains from Plesk or cPanel. Gulo Gulo can sit
behind either one as an optional upstream hosting and tenant tool. The panel
can own the hosting account, DNS workflow, and provider-side provisioning
conversation; it does not become a second mailbox, policy, or identity store.

The useful mental model is:

```text
Tenant / provider
       │
       ├── Plesk or cPanel (optional upstream account and DNS tool)
       │       └── explicit provider adapter or webhook/pull boundary
       │
       └── Gulo Gulo
               ├── tenant policy and RBAC
               ├── LDAP identity
               ├── PostgreSQL application state
               ├── mailbox and DAV data
               └── audit and read-only API/MCP
```

## Ownership rules

Gulo Gulo remains authoritative for tenant policy, users, quotas, aliases,
delegations, mailbox content, calendars, contacts, authentication decisions,
retention, audit semantics, and application state. A panel must never be used
as a shortcut around those rules.

The panel may be authoritative for the hosting account and may be the place
where a provider manages DNS or a domain's hosting lifecycle. Gulo Gulo may
read that state for diagnostics and reconciliation, but the V1 contract does
not grant DNS or domain write operations. This prevents a panel credential
from becoming an unbounded deployment or mail-control credential.

There is no direct browser-to-panel call, Docker socket, SSH command, arbitrary
CLI, or unrestricted `kubectl` path. A future provider adapter must be
idempotent, tenant-scoped, explicitly allowlisted, audited, and safe to disable.

## Configuration contract

The integration is disabled by default. Environment variables are references,
not credential values:

```text
CONTROL_PANEL_ENABLED=false
CONTROL_PANEL_PROVIDER=none       # none, plesk, or cpanel
CONTROL_PANEL_BASE_URL=
CONTROL_PANEL_ACCOUNT_REF=
CONTROL_PANEL_CREDENTIAL_SECRET_REF=
CONTROL_PANEL_WEBHOOK_SECRET_REF=
CONTROL_PANEL_SYNC_MODE=pull      # pull, webhook, or hybrid
```

When enabled, the provider, HTTPS base URL, external account reference, and
credential secret reference are required. `webhook` and `hybrid` also require
a webhook secret reference. URLs cannot contain userinfo, query strings, or
fragments. Secret values never belong in Compose, JSON configuration, source,
logs, API payloads, or MCP output.

`src/integrations/control-panel.ts` is the provider-neutral contract. It
validates the configuration, creates a tenant/domain binding, reports a
metadata-only status, and exposes an explicit capability matrix. Both Plesk
and cPanel use the same boundary; provider-specific HTTP adapters and
reconciliation remain a separate implementation slice.

## Pull, webhook, and hybrid modes

- **Pull** periodically reads the panel's domain/account state through a
  provider adapter. It is the safest starting point when the panel cannot
  sign callbacks.
- **Webhook** accepts a provider-authenticated change notification and then
  performs a scoped read. A webhook is a hint to reconcile, not permission to
  mutate Gulo Gulo state blindly.
- **Hybrid** combines both: webhooks reduce latency and scheduled pulls catch
  missed events.

Every event must carry a tenant/domain binding, an idempotency key, a bounded
timestamp window, and an audit record. A mismatch or unknown external ID is a
fail-closed reconciliation result, not an invitation to guess a tenant.

## Tenant binding example

The contract deliberately stores references rather than panel passwords:

```json
{
  "provider": "plesk",
  "tenantId": "acme",
  "domain": "example.com",
  "accountRef": "tenant/acme",
  "externalDomainId": "domain-42"
}
```

The domain is normalized to lowercase and the tenant ID is checked against the
same safe identifier rules used by the rest of the integration layer. A panel
binding does not grant mailbox, calendar, contact, queue, or user-session
access. Content access still follows the Gulo Gulo RBAC matrix.

## Operator checklist

Before enabling a real panel integration, the provider should:

1. create a least-privilege panel account or API token in the external secret
   store;
2. confirm the panel's TLS certificate and API version;
3. map exactly one panel account/domain to the intended Gulo Gulo tenant;
4. decide whether DNS remains panel-owned or another provider owns it;
5. configure webhook signature verification if using webhook or hybrid mode;
6. test duplicate, delayed, malformed, cross-tenant, and revoked events;
7. verify that disabling the integration leaves Gulo Gulo policy and content
   fully usable;
8. record a rollback and credential-rotation procedure in
   `READ_BEFORE_USE.md`.

The repository currently proves the configuration and binding boundary only.
It does not claim a live Plesk/cPanel API connector or automatic DNS mutation.
