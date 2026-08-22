# RBAC, administration, passwords, and web MFA

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This guide describes the M6 contracts that sit behind the future Gulo Gulo
administration screens and protected web API. The code in this milestone is a
small, deterministic policy layer: it validates scope and intent, emits safe
metadata, and leaves the actual LDAP, PostgreSQL, mail queue, and WebAuthn
adapters to the integration layer. That boundary is deliberate. A policy
contract can be tested thoroughly without pretending that an in-memory example
is a production mailbox or identity store.

## What is covered

The M6 modules live in two folders:

```text
src/admin/
├── rbac.mjs           role and permission matrix
├── delegation.mjs     one active colleague delegation per user
├── quota.mjs          gross tenant quota ledger and reservations
└── admin-tools.mjs    queue and audit metadata tools

src/auth/
├── password-policy.mjs
├── password-hashing.mjs
├── totp.mjs
├── webauthn.mjs
└── recovery-codes.mjs
```

Every public operation receives an explicit actor and tenant scope. Missing or
ambiguous scope fails closed. The modules never return mailbox bodies,
calendar content, contact fields, passwords, session identifiers, cookies,
tokens, private keys, or factor secrets in an audit or administration result.

## Roles and tenant boundaries

`src/admin/rbac.mjs` defines four roles:

| Role | Intended scope | Content access |
| --- | --- | --- |
| `provider` | provider-wide operational administration | never through this contract |
| `tenant_master` | one tenant's users, aliases, policy, quotas, queue metadata, and audit metadata when enabled | never; no mailbox, calendar, contacts, or user session |
| `user` | the authenticated user's own settings and content through a separate content adapter | only the user's own scope |
| `monitor` | read-only operational observation | never |

The master is intentionally powerful around configuration and intentionally
blind around user content. `authorize()` requires a matching tenant and a
declared permission. Content-shaped requests are rejected even if the caller
has another administrative permission. This same rule must be applied again by
the HTTP API, MCP read-only adapter, DAV handlers, IMAP adapter, background
jobs, backup service, and realtime event broker; an API route must not treat a
successful LDAP lookup as authorization.

```js
import { authorize } from './src/admin/rbac.mjs';

authorize(
  { role: 'tenant_master', tenantId: 'example.test', actorId: 'master' },
  {
    tenantId: 'example.test',
    permission: 'user.manage',
    targetUserId: 'ada@example.test',
  },
);
```

For a denied request, callers should keep the external response deliberately
uninteresting (`403` or `404` according to the route policy) and log only a
redacted event identifier, actor scope, target class, and reason code.

## Delegation

`createDelegationStore()` models the one-colleague rule from the product
specification. A user can have at most one active delegation. The owner may
grant explicit mailbox, calendar, or contacts read/write scopes. A tenant
master may force the delegation, but a forced delegation still does not grant
the master content access; it grants the named colleague only the scopes that
were recorded. Creation, updates, forced changes, and revocation all require a
reason and produce metadata-only history entries.

The adapter that persists this state must enforce the same uniqueness
constraint transactionally. Do not implement the “one delegate” rule by
counting rows in application code after a concurrent insert.

## Quotas and administrative tools

`createQuotaLedger()` keeps an immutable gross tenant quota and an allocation
for each known user. Allocation and message/DAV reservations are checked before
they are committed, so the sum of user allocations and active reservations
cannot cross the tenant boundary. A reservation has a caller-supplied ID and
can be released idempotently after a retry.

`createAdminTools()` exposes queue and audit views as metadata-only operations.
Queue output is limited to identifiers, state, timestamps, retry counts, and
safe routing metadata. Message bodies, headers with sensitive values, and
secrets are not part of the contract. Master log visibility is disabled by
default and has to be explicitly enabled by the tenant configuration. Queue
actions (for example retry or quarantine) are separately authorized and are
always audit-worthy.

## Password policy and hashing

The baseline password policy is intentionally simple and portable:

- printable ASCII only;
- at least eight characters;
- an explicit alphanumeric and ordinary-symbol allowlist;
- no Unicode normalization or locale-specific character classes;
- configurable expiry from zero (no expiry) through 9,999 days.

`password-hashing.mjs` uses versioned `scrypt` records with a per-password
salt and constant-time verification. The encoded record carries the algorithm
and cost version so a later cost increase can be rolled out at login without
storing plaintext. LDAP remains the identity source of truth; this module is a
policy and hashing contract, not a second user directory.

## TOTP

`createTotpManager()` implements the RFC 6238 flow without exposing the secret:

1. create an encrypted pending enrollment;
2. confirm it with the current code;
3. verify codes with a bounded clock window;
4. remember the accepted time-step to reject replay;
5. record only metadata for success, failure, lockout, and revocation.

The supplied AES-GCM protector expects a key reference owned by the deployment
secret store. Production wiring must provide key rotation and a decryptable
key-ring policy; the application must never put the raw key in environment
logs, audit events, API responses, or backups.

## WebAuthn

`webauthn.mjs` validates the ceremony envelope before an external cryptographic
verifier is called. It checks the HTTPS origin, relying-party ID, challenge
ownership and expiry, credential scope, user presence/verification flags, and
monotonic signature counters. Registration and assertion challenges are
single-use. Private-key-shaped input is rejected so a caller cannot accidentally
send key material into a metadata contract.

The cryptographic verifier remains an explicit adapter because the project has
not selected a WebAuthn library yet. When one is introduced, pin its latest
stable release in `package.json` and lockfile, keep origin/RP checks in this
policy layer, and add browser and authenticator interoperability tests.

## Recovery codes

Recovery codes are generated once, shown once, and stored only as salted
digests. Consumption is scoped to one tenant and user, is one-time, and shares
the same bounded failure and lockout hooks as TOTP. Recovery may revoke a
factor, but neither the recovery endpoint nor an administrator may retrieve the
original codes. An administrative recovery action must be auditable without
including the code or a session token.

## Test and integration commands

The focused M6 suite is intentionally sequential, which is friendlier to the
Windows development environment and avoids the `spawn EPERM` issue seen with
parallel Node workers:

```text
npm run test:m6
```

The normal `npm test` command runs the same suite before the rest of the
repository gates. The tests prove policy behavior and redaction. They do not
claim that LDAP, PostgreSQL, a live authenticator, or a live mail queue is
available; those integrations belong to their own disposable contract and
Docker/Actions checks.

## API and MCP guidance

The current API/MCP surface remains read-only for monitoring. It may expose
health, queue metadata, audit summaries, policy status, and MFA enrollment
state only when the caller's tenant scope permits it. It must not expose factor
secrets, recovery codes, password hashes, session cookies, or mailbox content,
and it must not turn a monitoring token into an administrative write token.

Use the same actor envelope as the policy layer and include a request ID so a
redacted audit event can be correlated across the web API, MCP adapter, and
background jobs.

## What is still an adapter task

M6 intentionally leaves these production tasks for later integration work:

- transactional persistence in external PostgreSQL;
- LDAP password update and account lock mapping;
- a selected WebAuthn verifier and browser interoperability tests;
- encrypted secret-store/key-ring rotation;
- HTTP/MCP route wiring, session CSRF checks, and user-facing recovery UX;
- live Postfix/Dovecot queue and audit sinks.

Keeping these items explicit prevents the in-memory contracts from being
mistaken for a finished deployment while still giving every later adapter a
stable, testable boundary.
