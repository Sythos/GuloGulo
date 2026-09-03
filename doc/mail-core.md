# M3 mail core and delivery safety

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This document describes the M3 mail boundary in Gulo Gulo. It is intentionally
written as an operator's manual rather than as a protocol marketing page: the
interesting part is where a message is allowed to go, which component owns the
decision, and what happens when a dependency is unavailable.

## What M3 delivers

M3 is the first mail-core implementation. It provides dependency-free,
deterministic contracts for the services that will be wired to Postfix,
Rspamd, ClamAV, Dovecot, LMTP, and Sieve:

- `src/core/mail/mail-policy.ts` owns tenant-domain checks, explicit mailbox and
  alias resolution, submission authorization, message limits, Sieve safety,
  and the per-user submission rate limit;
- `src/core/mail/mail-scanners.ts` normalizes Rspamd and ClamAV results and turns a
  missing or broken scanner into an explicit `unavailable` result;
- `src/core/mail/mail-queue.ts` owns retry, defer, bounce, quarantine, and a
  metadata-only operational view;
- `src/core/mail/imap-idle.ts` supplies monotonic, reconnect-safe notification
  identities for the Dovecot IMAP IDLE adapter;
- `src/core/mail/mail-core.ts` composes those contracts into inbound delivery and
  authenticated submission flows.

The current implementation keeps the message itself behind an opaque
`messageRef`. Queue snapshots, audit records, metrics, and ordinary logs never
contain the message body, subject, attachment, credential, or scanner payload.
The production adapters can therefore be added without changing the security
boundary already tested in M3.

## Trust and source-of-truth boundaries

The service topology remains the one defined by `GULOGULO.md`:

```text
Internet SMTP                 Authenticated client
      |                                |
      v                                v
   Postfix :25                  Postfix :587/:465
      |                                |
      +---------- Rspamd --------------+
                    |
                  ClamAV
                    |
                   LMTP
                    |
                 Dovecot
             IMAP / IDLE / Sieve
```

Gulo Gulo owns policy and control-plane metadata. Dovecot owns mailboxes,
folders, flags, UID state, and the actual message store. PostgreSQL owns tenant
policy, identities, aliases, quotas, audit metadata, and queue/outbox metadata;
it is not a second mailbox store.

M3 does not silently install vendor images or invent vendor configuration. The
Postfix, Rspamd, ClamAV, and Dovecot images must be selected and verified by the
deployment owner against the current supported releases, architecture
support, update mechanism, and license. The contract tests run without network
access and are the gate that every future adapter must pass.

## Safe inbound delivery

`createMailCore().receiveInbound(context, options)` follows this order:

1. Canonicalize the tenant context and the sender address.
2. Resolve every recipient against active users and explicit aliases.
3. Reject an unknown recipient. There is no catch-all fallback.
4. Apply the Rspamd verdict.
5. Apply the ClamAV verdict.
6. Reserve the recipient's quota before acknowledging LMTP delivery.
7. Deliver through LMTP, then emit an IMAP IDLE event for each mailbox.
8. Queue temporary LMTP failures for retry; do not acknowledge them as
   delivered.
9. Return only status, safe addresses, counts, queue metadata, and an audit
   reference.

The scanner policy is fail-closed. `reject` is a spam-policy rejection,
`quarantined` is used for malware or an explicit quarantine verdict, and an
unavailable scanner produces a deferred queue item. A future deployment may
choose a more specific quarantine workflow, but it must not turn an unknown
scanner state into an accepted message.

Example:

```js
const result = await mailCore.receiveInbound(tenantContext, {
  sender: 'sender@example.net',
  recipients: ['sales@example.test'],
  users: [
    { userId: 'alice', address: 'alice@example.test' },
    { userId: 'bob', address: 'bob@example.test' },
  ],
  aliases: [
    { address: 'sales@example.test', destinations: ['alice', 'bob'] },
  ],
  sizeBytes: 4096,
  messageRef: opaqueDeliveryHandle,
});

// { status: 'delivered', delivered: ['alice@example.test', 'bob@example.test'], ... }
```

The `messageRef` is intentionally opaque. Do not replace it with raw RFC 5322
content in logs, HTTP responses, audit details, or queue snapshots.

## Safe authenticated submission

`mailCore.submit(context, options)` is for Postfix submission (`587` or
`465`) and for a future Gulo Gulo compose path. It requires all of the
following:

- a successful external LDAP authentication represented by
  `authenticated: true`;
- an actor matching `authenticatedUserId` when the context is a user context;
- a sender in the tenant domain;
- a sender mailbox or explicit sender alias owned by that user;
- no unknown internal recipients;
- the configured message and recipient limits;
- the per-user submission rate window.

The accepted message is placed in the persistent Postfix queue adapter. M3's
in-memory queue is a contract-test double; it is not a production queue.

An unauthenticated submission is always rejected with
`OPEN_RELAY_DISABLED`. The code does not provide a permissive mode, and an
external recipient never becomes a reason to bypass authentication.

## Aliases and forwarding

An alias has one tenant-scoped address and one or more explicit active-user
destinations. Alias resolution is one-way and deterministic. Alias creation,
updates, and deletion are control-plane operations and must be audited by the
PostgreSQL adapter.

The following are deliberately not implemented as hidden conveniences:

- catch-all recipient matching;
- automatic forwarding;
- Sieve `redirect` actions;
- arbitrary external alias destinations;
- an alias that shadows a real mailbox.

`validateSieve()` accepts the V1 local actions (`fileinto`, `vacation`, `keep`,
`discard`, and `stop`) and rejects redirect/forwarding syntax before a script
reaches Dovecot Pigeonhole. A production Sieve adapter must repeat this check
at its boundary; the API and UI are not trusted as the only enforcement layer.

## Rspamd and ClamAV adapters

The scanner adapters have tiny, deliberately boring interfaces:

```js
const rspamd = {
  async scan({ sender, recipients, sizeBytes, messageRef }) {
    return { action: 'accept', score: -1.2, symbols: ['DKIM_VALID'] };
  },
};

const clamav = {
  async scan({ sender, recipients, sizeBytes, messageRef }) {
    return { status: 'clean' };
  },
};
```

Rspamd actions are `accept`, `no_action`, `soft_reject`, `reject`,
`quarantine`, and `unavailable`. ClamAV statuses are `clean`, `infected`, and
`unavailable`. Symbols and malware signatures are normalized to short safe
identifiers for audit/metrics use; the message body is never copied into a
verdict.

An adapter must keep the last known-good definitions and expose update health.
Gulo Gulo's scanner readers consume both Rspamd and ClamAV definitions from the
provider-owned shared `scanner-signatures` volume, mounted read-only in every
scanner container. Each scanner verifies the active pointer, generation
manifest, per-file SHA-256 values, aggregate descriptor digest, and freshness
window before reporting ready. A stale, missing, malformed, or mismatched
generation is unavailable and therefore cannot be treated as a clean verdict.

The provider-side update path remains: download, verify, stage beside the
known-good generation, write and validate a manifest, flush, atomically replace
the active pointer, health-check, and retain the previous generation for
rollback. `freshclam` and Rspamd map/rule updates are deployment concerns, not
an excuse to weaken the delivery decision. The writer belongs to the host or a
provider maintenance job; scanner containers never become writable and never
run a feed cron job.

## Queue, retry, and bounce

The queue contract stores safe envelope metadata:

| Field | Meaning |
|---|---|
| `queueId` | Non-enumerable deployment identifier returned by the adapter |
| `tenantId` | Tenant scope used for authorization and RLS |
| `sender` | Envelope sender, not message content |
| `recipients` | Envelope recipients |
| `sizeBytes` | Declared message size |
| `state` | `queued`, `delivering`, `deferred`, `delivered`, `bounced`, or `quarantined` |
| `attempts` | Number of delivery claims |
| `nextAttemptAt` | Backoff scheduling hint |
| `reason` | Short allowlisted operational reason |

`claim()` moves an item to `delivering`. `defer()` applies exponential backoff
and turns the item into `bounced` after `queueMaxAttempts`. `complete()` accepts
only terminal states. A queue view is available to `tenant_master`, `provider`,
and `monitor` contexts and is always metadata-only; a master cannot use it to
read a user's mailbox or message body.

The production queue adapter must be persistent on the external mail volume.
An in-place upgrade on any of the three packaging targets (see
`doc/upgrade-and-migration.md`) must not discard the Postfix queue.

## IMAP IDLE notifications

The IDLE broker returns an immutable event with:

- a monotonic `sequence`;
- a unique `eventId` suitable for reconnect deduplication;
- tenant, user, and mailbox scope;
- a small event kind such as `exists`;
- optional `uidNext`;
- UTC timestamp.

No message content is present. The Dovecot adapter should publish an event only
after a durable mailbox change. A reconnecting client should use the event ID
and then resynchronize mailbox state through normal IMAP semantics; it must not
assume that an IDLE event is a complete message list.

## Configuration

The M3 configuration fields are secret-free and available both in
`config/schema.v1.json` and as environment variables:

| Setting | Default | Purpose |
|---|---:|---|
| `GULOGULO_MAIL_SMTP_INBOUND_PORT` | `25` | Server-to-server SMTP |
| `GULOGULO_MAIL_SMTP_SUBMISSION_PORT` | `587` | Authenticated submission |
| `GULOGULO_MAIL_SMTP_IMPLICIT_TLS_PORT` | `465` | Optional implicit-TLS submission |
| `GULOGULO_MAIL_IMAPS_PORT` | `993` | Primary IMAPS access |
| `GULOGULO_MAIL_LMTP_SOCKET` | `/var/run/dovecot/lmtp` | Dovecot LMTP boundary |
| `GULOGULO_MAILBOX_ROOT` | `/var/lib/gulogulo/mail` | External mail volume mount |
| `GULOGULO_MAIL_RSPAMD_ENABLED` | `true` | Require Rspamd adapter wiring |
| `GULOGULO_MAIL_CLAMAV_ENABLED` | `true` | Require ClamAV adapter wiring |
| `GULOGULO_SCANNER_SIGNATURE_ROOT` | `/var/lib/gulogulo/scanner-signatures` | Read-only verified definition root |
| `GULOGULO_SCANNER_SIGNATURE_MAX_AGE_SECONDS` | `604800` | Maximum accepted definition age |
| `GULOGULO_LP3_SCANNER_SIGNATURES_VOLUME` | `gulogulo-scanner-signatures` | Provider-owned shared scanner volume |
| `GULOGULO_MAIL_SCAN_FAILURE_MODE` | `fail_closed` | Never accept with an unknown scan result |
| `GULOGULO_MAIL_MAX_MESSAGE_BYTES` | `52428800` | Envelope size limit |
| `GULOGULO_MAIL_MAX_RECIPIENTS` | `100` | Recipients per message |
| `GULOGULO_MAIL_MAX_CONNECTIONS_PER_IP` | `20` | SMTP edge connection ceiling |
| `GULOGULO_MAIL_MAX_MESSAGES_PER_USER_PER_MINUTE` | `60` | Authenticated submission ceiling |
| `GULOGULO_MAIL_QUEUE_MAX_ATTEMPTS` | `5` | Retry limit before bounce |
| `GULOGULO_MAIL_QUEUE_RETRY_BASE_MS` | `60000` | Exponential backoff base |

`GULOGULO_MAIL_CATCH_ALL` and `GULOGULO_MAIL_USER_FORWARDING` are retained as
explicit false invariants. Attempts to set them to true fail configuration
loading before a service starts.

## Testing

Run the complete local gate from `git/`:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

`src/core/mail/mail-core.test.ts` covers the M3 acceptance cases:

- unknown recipients and catch-all rejection;
- alias expansion;
- open-relay and forwarding negative paths;
- internal recipient validation and submission rate limiting;
- Rspamd spam rejection;
- ClamAV malware quarantine;
- fail-closed scanner unavailability;
- quota rejection before LMTP acknowledgement;
- temporary LMTP failures, retry, and bounce;
- metadata-only queue views;
- deterministic IMAP IDLE event sequences.

The CI workflow runs this test with the existing M0–M2 gates. It does not claim
that a fake scanner is a production Rspamd or ClamAV deployment: real service
interoperability, image selection, TLS certificates, and freshclam/map update
rehearsals remain operational verification work.

## Operational checklist before wiring vendors

1. Select current stable, architecture-compatible Postfix, Dovecot, Rspamd, and
   ClamAV images or packages and record their immutable digests.
2. Mount the external `mail-data` volume and persistent Postfix queue outside
   the Gulo Gulo application's own install/extension directory lifecycle, so
   an in-place upgrade or reinstall on any packaging target never touches
   mail data.
3. Configure Dovecot as the mailbox/UID/quota source of truth and expose only
   LMTP/IMAP interfaces required by the deployment.
4. Configure Postfix submission authentication against LDAP through the
   approved service adapter; test the open-relay negative case from outside
   the tenant.
5. Configure the host-side Rspamd and ClamAV definition writer with integrity
   checks, atomic active-pointer replacement, rollback, alerts, and a
   documented fail-closed policy. Mount its provider-owned volume read-only in
   the scanner services.
6. Run the M3 contract tests plus real SMTP, LMTP, IMAP IDLE, Sieve, alias,
   quota, spam, malware, queue, and restart tests in a disposable environment.
7. Inspect logs and queue views to confirm that no body, credential, or secret
   is present and that tenant/master visibility remains metadata-only.
