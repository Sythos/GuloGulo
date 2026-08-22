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
| CalDAV | `src/dav/caldav/caldav-contract.mjs` | iCalendar validation, collections, ACL, ETags, conditional writes, sync tokens, tombstones, metadata-only audit events |
| CardDAV | `src/dav/carddav/carddav-store.mjs` | vCard validation, address books, ETags, conditional writes, sync tokens, tombstones, metadata exports |
| CardDAV exports | `src/dav/carddav/index.mjs` | stable public module aliases for future adapters |
| Discovery | `src/dav/discovery/index.mjs` | tenant-bound `.well-known` resources, mail autoconfig, service endpoints, safe manual overrides |
| HTTP well-known | `src/runtime/server.mjs` | optional, explicitly injected discovery contract for GET/HEAD resources |
| Browser surface | `web/index.html`, `web/src/app.ts` | read-only Calendar and Contacts views, discovery status, and manual-fallback messaging |

The stores are deterministic in-memory contract doubles for now. A persistent
DAV provider can replace them without changing authorization, precondition,
ETag, or sync-token semantics. In production the DAV provider remains the
source of truth for calendars, events, address books, vCards, ETags, sync
history, and collection metadata. PostgreSQL may hold indexes or application
metadata, but it must not become a second mutable copy of those objects.

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
import { createCalDavStore } from './src/dav/caldav/caldav-contract.mjs';

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
import { createCardDAVStore } from './src/dav/carddav/carddav-store.mjs';

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
} from './src/dav/discovery/index.mjs';

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
node src/dav/caldav/caldav-contract.test.mjs
node src/dav/carddav/carddav-store.test.mjs
node src/dav/discovery/index.test.mjs
node src/runtime/runtime.test.mjs
npm run build:web
node web/test/web-shell.test.mjs
```

`npm test` includes all of the above contract tests. The GitHub quality gate
also checks the explicit entry points, MIT/SPDX headers, tenant-scope denial
markers, and the Ubuntu 26.04 LTS amd64/arm64 Docker build. Docker is not
required for the focused Node checks, but the Compose and multi-architecture
gates remain authoritative for the image.

## What is deliberately still ahead

This milestone establishes the security and data contract, not a claim that
every vendor client has already been rehearsed. Before production readiness we
still need:

1. a persistent DAV backend and transaction/locking adapter;
2. an authenticated HTTP adapter for the full DAV method set and XML reports;
3. real LDAP/session integration for DAV authentication;
4. Apple, Thunderbird, Evolution, and mobile-client interoperability tests;
5. quota reservation/rollback and rate limits around DAV uploads and reports;
6. restore/token-invalidation tests on the external DAV volume.

Shared mailboxes and resource calendars remain future considerations, as
specified by the canonical document. They must not be enabled by treating a
master or monitoring role as a content owner.
