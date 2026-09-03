# CalDAV, CardDAV, and discovery

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This is the practical note for the first Gulo Gulo calendar, contacts, and
automatic-configuration contracts. It is deliberately a little more concrete
than a protocol overview: these modules are the boundary that a real DAV HTTP
adapter must honour. They do not quietly become a second mail store, and they
do not give the master a back door into a user's content.

## What is in the repository

| Area | Source | What it owns |
| --- | --- | --- |
| CalDAV | `src/core/dav/caldav/caldav-contract.ts` | iCalendar validation, collections, ACL, ETags, conditional writes, sync tokens, tombstones, metadata-only audit events |
| CalDAV PostgreSQL adapter | `src/core/dav/caldav/postgres-caldav-store.ts` | persistent storage for the same CalDAV operations, backed by `0003_dav_storage.sql` |
| CardDAV | `src/core/dav/carddav/carddav-store.ts` | vCard validation, address books, ETags, conditional writes, sync tokens, tombstones, metadata exports |
| CardDAV PostgreSQL adapter | `src/core/dav/carddav/postgres-carddav-store.ts` | persistent storage for the same CardDAV operations, backed by `0003_dav_storage.sql` |
| CardDAV exports | `src/core/dav/carddav/index.ts` | stable public module aliases for future adapters |
| DAV storage migration | `src/core/db/migrations/0003_dav_storage.sql` | `dav_calendar_collections`/`dav_calendar_objects`/`dav_calendar_changes`, `dav_address_books`/`dav_contacts`/`dav_contact_changes`, tenant-forced RLS |
| Discovery | `src/core/dav/discovery/index.ts` | tenant-bound `.well-known` resources, mail autoconfig, service endpoints, safe manual overrides |
| HTTP well-known | `src/runtime/server.ts` | optional, explicitly injected discovery contract for GET/HEAD resources |
| Platform wiring | `src/platform/contract/platform-adapter.ts` (`createDavStore()`), and the standalone/cPanel/Plesk adapters | resolves the PostgreSQL-backed CalDAV/CardDAV stores for each packaging target |
| Browser surface | `web/index.html`, `web/src/app.ts` | read-only Calendar and Contacts views, discovery status, and manual-fallback messaging |

`caldav-contract.ts` and `carddav-store.ts` stay deterministic, synchronous,
in-memory contract doubles — every method there returns a plain value, never
a `Promise`, and their own tests call them without `await`. That is
deliberate: it keeps the pure validation/authorization/ETag/sync-token logic
free of I/O and trivially testable. `postgres-caldav-store.ts` and
`postgres-carddav-store.ts` are a **separate, asynchronous** implementation
of the same operations, backed by PostgreSQL instead of a `Map` — genuine
network I/O cannot be added to a synchronous public method without breaking
that contract's own tests, so the two live side by side rather than one
being "injected into" the other. To keep them from silently drifting on
anything a real DAV client observes on the wire, the PostgreSQL adapters
import the pure contracts' own exported ETag (`calculateEtag`/
`collectionEtag`/`makeEtag`/`makeCollectionEtag`), sync-token
(`makeToken`/`decodeToken`/`makeSyncToken`/`parseSyncToken`), and scope/id
validation functions rather than reimplementing them — an ETag or sync token
computed by the PostgreSQL adapter is byte-for-byte identical to what the
in-memory contract would compute for the same tenant/collection/object/
content. In production the PostgreSQL adapter is the source of truth for
calendars, events, address books, vCards, ETags, sync history, and
collection metadata — nothing else becomes a second mutable copy of those
objects.

## Scope and authorization

Every operation receives an authenticated scope. The scope is not inferred
from a user-controlled path, query string, `tenantId` field, or object body.

CalDAV actors have the shape:

```js
{ tenantId: 'acme', userId: 'alice', role: 'user' }
```

The CalDAV contract rejects provider, tenant-master, and monitoring roles for
content operations with `CONTENT_SCOPE_REQUIRED`. CardDAV rejects the same
roles with `SCOPE_ROLE_DENIED`. An administrator must obtain an explicitly
delegated user scope; passing `targetUserId` or an owner path is not a
delegation mechanism.

The V1 sharing rule is intentionally narrow: an owner can have at most one
active delegate. Permissions are `read` and `write`; write always includes
read. ACL changes are owner-only and are suitable for audit logging. A
delegated session is still distinguishable from the owner in the audit event.

## CalDAV contract

Create a store for one tenant and use it from a verified user context:

```js
import { createCalDavStore } from './src/core/dav/caldav/caldav-contract.ts';

const store = createCalDavStore({ tenantId: 'acme' });
const alice = { tenantId: 'acme', userId: 'alice', role: 'user' };

store.createCalendarCollection(alice, {
  collectionId: 'personal',
  displayName: 'Alice calendar',
  timezone: 'Europe/Rome',
});

const created = store.createCalendarObject(alice, {
  calendarId: 'alice/personal',
  objectId: 'event-1.ics',
  ifNoneMatch: '*',
  ical: '...canonical iCalendar text...',
});

store.updateCalendarObject(alice, {
  calendarId: 'alice/personal',
  objectId: 'event-1.ics',
  ifMatch: created.etag,
  ical: '...same UID, changed properties... ',
});
```

The contract maps naturally to the usual DAV method set:

| HTTP method | Contract operation | Important rule |
| --- | --- | --- |
| `OPTIONS` | adapter capability response | advertise only methods actually wired by the adapter |
| `PROPFIND` | list/get collection metadata | never enumerate another user's collection |
| `REPORT` | `listCalendarObjects` with a sync token | token is tenant, owner, and collection scoped |
| `MKCOL` | `createCalendarCollection` | owner creates only their own collection |
| `GET` | `getCalendarObject` or collection metadata | read ACL is checked first |
| `PUT` | create/update object | create uses `If-None-Match: *`; update requires `If-Match` |
| `DELETE` | delete object/empty collection | object deletion requires `If-Match`; non-empty collections are not dropped silently |

The current runtime intentionally exposes only the optional `.well-known`
resources. A protocol adapter must authenticate the request, create the user
scope, apply the table above, and then call the store. It must not call a store
with a role elevated from an HTTP header or a path segment.

### iCalendar input

`validateICalendar()` accepts a bounded, interoperable subset:

- one closed `VCALENDAR` with exactly one `VEVENT`;
- `VERSION:2.0`, `PRODID`, `UID`, `DTSTART`, and optional `DTEND` or `DURATION`;
- `VTIMEZONE` with `STANDARD`/`DAYLIGHT` transitions;
- UTC, explicit `TZID`, floating local time, and date-only values;
- attendees, organizer, method, sequence, summary, description, and alarms at
  the supported level;
- CRLF canonical output, folded-property unfolding, control-character checks,
  size, line, component-count, and nesting limits.

Floating and date-only values are retained as floating/date-only values. They
are not silently converted to UTC, which would change their meaning around DST
boundaries. A TZID used by an event must have a matching `VTIMEZONE` definition
in the object; undefined zones fail closed.

ETags are opaque SHA-256 values over the tenant, collection, object id, and
canonical object. A stale ETag returns a precondition failure and never
overwrites the newer object. Each successful mutation creates a change record
and advances the collection sync token atomically in the contract double.
Deleted objects appear as tombstones in a subsequent sync result.

## CardDAV contract

CardDAV uses the same user/tenant boundary, with address-book collections and
single-object vCards:

```js
import { createCardDAVStore } from './src/core/dav/carddav/carddav-store.ts';

const store = createCardDAVStore();
const scope = { tenantId: 'acme', userId: 'alice', role: 'user' };
store.createAddressBook({
  scope,
  addressBookId: 'personal',
  displayName: 'Alice contacts',
});

const contact = store.createContact({
  scope,
  addressBookId: 'personal',
  href: 'ada.vcf',
  ifNoneMatch: '*',
  vCard: 'BEGIN:VCARD\\r\\nVERSION:4.0\\r\\nUID:ada\\r\\nFN:Ada Lovelace\\r\\nEND:VCARD\\r\\n',
});

store.putContact({
  scope,
  addressBookId: 'personal',
  href: 'ada.vcf',
  ifMatch: contact.etag,
  vCard: '...same UID, changed properties...',
});
```

Both vCard 3.0 and 4.0 are accepted. The validator canonicalizes line endings
to CRLF, unfolds safe folded lines, requires exactly one `UID` and `FN`,
rejects NUL/control data, and keeps bounded object and line sizes. The UID is
immutable for an existing href. ETags are opaque hashes of the canonical
vCard. `syncCollection()` returns metadata changes and deletion tombstones;
it does not put vCard bodies into a sync event.

`exportAddressBookMetadata()` is deliberately metadata-only. A user export
adapter may fetch the actual vCard objects after a fresh authorization check;
the master and a monitoring role cannot turn this method into a privileged
export.

## Persistent PostgreSQL backend

`createPostgresCalDavStore()`/`createPostgresCardDavStore()` implement the
same operations as the pure contracts above, asynchronously, against the
tables in `src/core/db/migrations/0003_dav_storage.sql`. They reuse
`createPostgresStore()` (`src/integrations/postgres-store.ts`) for the
connection pool, retry, SSL, and RLS transaction plumbing — the same pattern
`src/platform/standalone/db-identity-client.ts` already uses for
`local_users` — so `withTenantTransaction()` sets the `gulogulo.tenant_id`
RLS context per request and every table carries a `FORCE ROW LEVEL SECURITY`
tenant-isolation policy.

```js
import { createPostgresCalDavStore } from './src/core/dav/caldav/postgres-caldav-store.ts';

const store = createPostgresCalDavStore({ config, resolveSecret, logger });
if (store.enabled) {
  // actor extends the pure contract's {tenantId, userId, role} shape with a
  // `domain`, required because withTenantTransaction() needs a full
  // TenantContext (see src/integrations/tenant-context.ts).
  const alice = { tenantId: 'acme', domain: 'acme.example', userId: 'alice', role: 'user' };
  await store.createCalendarCollection(alice, { collectionId: 'personal' });
}
```

Schema shape, one row per object:

- `dav_calendar_collections` / `dav_address_books` — one row per calendar or
  address book, owner/user-scoped, with a `revision bigint` sync-token
  counter and (CalDAV only) a single-delegate `acl_delegate_user_id`/
  `acl_permissions` pair, matching the V1 one-delegate sharing rule.
- `dav_calendar_objects` / `dav_contacts` — one row per iCalendar object or
  vCard, storing the canonical text, ETag, and UID. `dav_contacts` has a
  `UNIQUE (tenant_id, user_id, address_book_id, uid)` constraint (CardDAV
  checks UID uniqueness); `dav_calendar_objects` deliberately does not (the
  pure CalDAV contract never checks it either).
- `dav_calendar_changes` / `dav_contact_changes` — the changelog/tombstone
  table behind the sync-token report: every create/update/delete appends a
  row here instead of soft-deleting the object row, matching the in-memory
  contracts' separate in-memory `changes` array.

The sync-token revision is a **per-collection** counter, bumped with
`UPDATE ... RETURNING` on the collection/address-book row so the bump and
the resulting change row commit under that row's lock (the in-memory
contract uses one global-per-tenant-store counter instead; nothing in either
public contract compares revisions across collections, so this is a safe,
non-observable implementation difference). `deleteCalendarCollection()`
still refuses a non-empty collection (`CALENDAR_NOT_EMPTY`, 409) by counting
objects before deleting, matching the pure contract; `deleteAddressBook()`
does not — the pure CardDAV contract never refuses either, it just drops the
whole collection, which here is an `ON DELETE CASCADE` from
`dav_contacts`/`dav_contact_changes`.

`putContact()`'s idempotent no-op — an unchanged vCard returns the existing
contact without bumping the revision or appending a change row — is
preserved: the adapter recomputes the ETag before writing and short-circuits
on a match, same as `CardDavStore#putContact()`.

`PlatformAdapter.createDavStore(config)` (`src/platform/contract/platform-adapter.ts`)
wires this into all three packaging targets
(`src/platform/standalone/standalone-adapter.ts`,
`src/platform/cpanel/cpanel-adapter.ts`, `src/platform/plesk/plesk-adapter.ts`),
each building its own pool from the same PostgreSQL connection settings
`createDataStore()` already uses.

**Status: DONE (code + tests against a fake pool) / VERIFY BEFORE USE
(a real PostgreSQL instance, and a real CalDAV/CardDAV client speaking
through the still-outstanding HTTP/WebDAV method and XML-report adapter).**
No HTTP DAV surface calls either the in-memory or the PostgreSQL store yet.

## Sync tokens and conditional writes

CalDAV tokens encode an opaque HTTPS-shaped token bound to tenant, owner, and
collection. CardDAV tokens use a non-enumerable scoped fingerprint bound to
tenant, user, and address book. Neither token is accepted for another scope,
another tenant, or a future revision. A persistent adapter must invalidate
tokens after restore, compaction, or loss of change history and force a full
resynchronization.

Conditional rules are intentionally strict:

- create: `If-None-Match: *`;
- update: current `If-Match` (or an explicitly supported wildcard);
- delete: current `If-Match`;
- stale preconditions: `412`;
- missing update/delete preconditions: `428`;
- malformed input: bounded `4xx` error with no object content in the message.

## Discovery and manual fallback

Build a tenant-bound discovery contract with public HTTPS hosts only:

```js
import {
  createDiscoveryContract,
  getWellKnownResource,
  WELL_KNOWN_PATHS,
} from './src/core/dav/discovery/index.ts';

const discovery = createDiscoveryContract({
  tenantId: 'acme',
  domain: 'example.test',
  origin: 'https://example.test',
  manualOverrides: {
    smtp: { host: 'submit.example.test', port: 587, tlsMode: 'starttls' },
  },
});

const resource = getWellKnownResource(discovery, WELL_KNOWN_PATHS.autoconfig, {
  tenantId: 'acme',
});
```

The contract publishes:

- `/.well-known/caldav` and `/.well-known/carddav` as HTTPS `308` redirects;
- `/.well-known/autoconfig/mail/config-v1.1.xml` for IMAP and SMTP;
- `/.well-known/gulogulo/discovery.json` for enabled service metadata.

IMAP, SMTP submission, CalDAV, CardDAV, and optional POP3S are represented.
POP3S is disabled by default and an override cannot re-enable a disabled
service. The payload contains host, port, TLS mode, path, and the `{email}`
username placeholder, but no password, token, tenant id, internal hostname, or
secret.

The validator rejects private/reserved/metadata hosts, credentials in URLs,
plaintext TLS, unsafe paths, double-encoding indicators, and untrusted origin
hosts. It never takes the HTTP `Host` header as a tenant decision. When
automatic discovery fails, the UI keeps a manual host/port/TLS/username path
visible and explains that it is a fallback rather than guessing.

The runtime serves these resources only when a validated contract and an
explicit tenant context are injected into `createRuntimeServer()`. Without
that injection the paths return `404`; this fail-closed default prevents an
unconfigured container from publishing internal service names.

## Browser and API boundaries

The Calendar and Contacts panels use same-origin application API paths and
never connect directly to LDAP, PostgreSQL, DAV storage, or discovery hosts.
Realtime `calendar.changed` and `contacts.changed` events contain metadata only
and trigger a refresh; they do not carry event or contact bodies. API and MCP
remain read-only monitoring surfaces. They may report collection counts,
adapter health, sync health, discovery health, and storage usage, but they do
not create, modify, delete, ACL-share, or export DAV content.

## Tests and local workflow

Run the focused checks when changing these modules:

```text
node --experimental-strip-types src/core/dav/caldav/caldav-contract.test.ts
node --experimental-strip-types src/core/dav/caldav/postgres-caldav-store.test.ts
node --experimental-strip-types src/core/dav/carddav/carddav-store.test.ts
node --experimental-strip-types src/core/dav/carddav/postgres-carddav-store.test.ts
node --experimental-strip-types src/core/dav/discovery/index.test.ts
node --experimental-strip-types --test src/platform/standalone/*.test.ts src/platform/cpanel/*.test.ts src/platform/plesk/*.test.ts
node dist/server/src/runtime/runtime.test.js
npm run build:web
node --experimental-strip-types web/test/web-shell.test.ts
```

The `postgres-*-store.test.ts` files exercise the PostgreSQL adapters against
a fake pool (same `FakePool`/`FakeClient` pattern as
`src/integrations/postgres-store.test.ts`), including a test that asserts the
PostgreSQL-computed ETag is byte-identical to what the in-memory contract
computes for the same input — there is no real PostgreSQL instance or real
DAV client in this test suite.

`npm test` includes all of the above contract tests. The GitHub quality gate
(`.github/workflows/quality-gates.yml`) also checks the explicit repository
entry points, MIT/SPDX headers, and tenant-scope denial markers, on an Ubuntu
`ubuntu-latest` runner. There is no Docker build or Compose gate in the
current packaging model; the standalone, cPanel, and Plesk package workflows
(`.github/workflows/package-{standalone,cpanel,plesk}.yml`) are the
authoritative install/build checks — see `../INSTALL.md`.

## What is deliberately still ahead

This milestone establishes the security and data contract, not a claim that
every vendor client has already been rehearsed. Before production readiness we
still need:

1. ~~a persistent DAV backend and transaction/locking adapter~~ — done in
   code/tests (`postgres-caldav-store.ts`/`postgres-carddav-store.ts`
   above); verification against a real PostgreSQL instance is still
   outstanding;
2. an authenticated HTTP adapter for the full DAV method set and XML reports
   (nothing calls either storage backend yet);
3. real LDAP/session integration for DAV authentication;
4. Apple, Thunderbird, Evolution, and mobile-client interoperability tests;
5. quota reservation/rollback and rate limits around DAV uploads and reports;
6. restore/token-invalidation tests on the external DAV volume.

Shared mailboxes and resource calendars remain future considerations, as
specified by the canonical document. They must not be enabled by treating a
master or monitoring role as a content owner.
