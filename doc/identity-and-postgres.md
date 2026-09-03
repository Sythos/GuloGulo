# External identity and application state

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

M2 adds the first real external-service contracts. LDAP is the default
identity source and PostgreSQL remains the application-state source. Gulo
Gulo never sends credentials to the browser.

The standalone target (`src/platform/standalone/`) additionally supports a
PostgreSQL-backed `local_users` table as an explicit, opt-in alternative to
LDAP (`identity.source = 'database'`, see "Database-backed identity" below) —
for lighter single/few-tenant installs that would rather not stand up an
external directory. LDAP stays the default: an operator who never sets
`identity.source` keeps the LDAP-only behavior described below unchanged.
cPanel and Plesk are unaffected — they always use their own panel API and
never fall back to a local password store.

## LDAP

Enable LDAP only when all three references are configured:

```text
LDAP_ENABLED=true
LDAP_URL=ldaps://ldap.example.test:636
LDAP_BIND_DN=cn=gulogulo,ou=services,dc=example,dc=test
LDAP_BIND_SECRET_REF=ldap/bind
LDAP_USER_BASE_DN=ou=users,dc=example,dc=test
```

`LDAP_BIND_SECRET_REF` is a reference, not a password. A deployment-specific
secret resolver supplies the value to the adapter at runtime. The value is not
written to configuration output, logs, health responses, or audit records.

LDAPS verifies the server certificate. A plain `ldap://` endpoint is accepted
only with `LDAP_STARTTLS=true`, and StartTLS uses certificate verification as
well. Embedded credentials in the URL are rejected. Connection and operation
timeouts, pool size, and bounded retry attempts are explicit configuration
values; retries use short exponential backoff and never log bind material.

User lookup is tenant-aware. The adapter builds a parameter-free LDAP filter
that includes the requested local username and the tenant domain, requests
only identity attributes (`uid`, `mail`, `displayName`, `cn`, and `active`),
and rejects ambiguous results. Password authentication binds a short-lived
client as the resolved user DN. A failure always returns an authentication
failure; it is never converted into a local fallback login.

## Database-backed identity (standalone only)

Enable the DB-backed identity source instead of LDAP with:

```text
IDENTITY_SOURCE=database
POSTGRES_ENABLED=true
```

`src/runtime/config.ts` rejects `IDENTITY_SOURCE=database` unless
`POSTGRES_ENABLED=true` — a local-users table with no database to live in is
a configuration error, not a silent fallback.

Users live in the `local_users` table
(`src/core/db/migrations/0002_standalone_local_identity.sql`): one row per
tenant-scoped username, with the same forced row-level security as every
other tenant-scoped table (`gulogulo.tenant_id`, set per transaction).
Password verification reuses `createPasswordHasher()`
(`src/core/auth/password-hashing.ts` — versioned scrypt, the same hasher used
elsewhere in the project) instead of a second hashing scheme.
`src/platform/standalone/db-identity-client.ts` builds the actual
`local_users` connection by reusing `createPostgresStore()`
(`withTenantTransaction()`), not a separate pool.

This repository does not yet ship an admin flow to create/rotate
`local_users` rows; provisioning one today means inserting a row with
`createPasswordHasher().hash(password)` as `password_hash` directly, e.g.
through `psql` or a one-off script. A proper admin UI/API for local user
management is tracked as follow-up work, not implemented by this change.

## PostgreSQL

Enable PostgreSQL with a secret reference to the complete connection string:

```text
POSTGRES_ENABLED=true
POSTGRES_HOST=postgres.example.test
POSTGRES_PORT=5432
POSTGRES_DB=gulogulo
POSTGRES_USER=gulogulo
POSTGRES_DSN_SECRET_REF=postgres/dsn
POSTGRES_SSLMODE=verify-full
```

`verify-full` is the default and requires certificate and hostname
verification. `require` encrypts the connection but deliberately does not
claim certificate verification. The adapter configures bounded pool size,
connection timeout, idle timeout, and retry attempts.

Run migrations through the store before enabling stateful traffic:

```js
const store = createPostgresStore({ config, resolveSecret, logger });
await store.runMigrations();
```

Migrations take a PostgreSQL advisory transaction lock, record a SHA-256
checksum in `schema_migrations`, and fail closed if an already-applied file is
modified. The first migration creates tenant, policy, user-reference, quota,
alias, delegation, role, and audit-reference tables. Tenant-scoped tables use
forced row-level security and the store sets `gulogulo.tenant_id` inside every
transaction before it can read or mutate data.

## Tenant and quota contract

Every state operation requires a canonical tenant context containing tenant ID,
domain, actor, and role. A different tenant ID is rejected before a query is
issued; PostgreSQL RLS is the second, database-side boundary.

The tenant's gross quota is immutable after bootstrap. User allocations are
locked and summed in the same transaction that creates or changes an
allocation. An allocation is rejected when the sum would exceed the gross
quota. This check is performed by the Gulo Gulo application's state adapter
and repeated by PostgreSQL constraints/RLS; it is not delegated to a client or
a host-side script.

## Failure behavior

LDAP and PostgreSQL outages are visible to the dependency health contract and
fail closed for authentication and administrative writes. No password, DSN,
message body, or mailbox content is included in an error or audit reference.
The M2 unit tests use deterministic fake clients. A real-PostgreSQL
integration test also exists (`src/integrations/postgres.integration.test.ts`)
and runs when `GULOGULO_M2_POSTGRES_DSN` is set, but no current CI workflow
sets it — the disposable-database service that used to provide it belonged
to the retired Docker-Compose CI model, and has not been readapted to the
package-based workflows. The test itself still passes locally against a real
PostgreSQL instance; wiring it back into CI is open follow-up work, not a
code gap.
