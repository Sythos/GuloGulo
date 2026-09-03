// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import type { PostgresClientLike, PostgresPoolOptions, QueryResult } from '../integrations/types.ts';
import { createPostgresCalDavStore } from '../core/dav/caldav/postgres-caldav-store.ts';
import { createPostgresCardDavStore } from '../core/dav/carddav/postgres-carddav-store.ts';
import { createLogger } from './logger.js';
import { createRuntimeServer, startServer, stopServer } from './server.js';

// This suite exercises the HTTP PROPFIND/GET/PUT/DELETE/REPORT surface added
// to src/runtime/server.ts end to end, against the real
// createPostgresCalDavStore()/createPostgresCardDavStore() adapters wired to
// an in-memory fake PostgreSQL pool (same FakeClient/FakePool pattern as
// postgres-caldav-store.test.ts/postgres-carddav-store.test.ts) — not the
// in-memory contract doubles. There is still no real PostgreSQL instance and
// no real CalDAV/CardDAV client anywhere in this suite.

type TestRuntime = ReturnType<typeof createRuntimeServer>;

class FakeCalDavClient implements PostgresClientLike {
  collections: Record<string, unknown>[] = [];
  objects: Record<string, unknown>[] = [];
  changes: Record<string, unknown>[] = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<QueryResult<Row>> {
    const t = text.replace(/\s+/gu, ' ').trim();
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK' || t.includes('set_config')) return { rowCount: 0, rows: [] as Row[] };

    if (t.startsWith('SELECT 1 FROM dav_calendar_collections')) {
      const [tenantId, owner, collectionId] = values as string[];
      const match = this.collections.find((c) => c.tenant_id === tenantId && c.owner_user_id === owner && c.collection_id === collectionId);
      return { rowCount: match ? 1 : 0, rows: (match ? [{}] : []) as Row[] };
    }
    if (t.startsWith('SELECT * FROM dav_calendar_collections WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3')) {
      const [tenantId, owner, collectionId] = values as string[];
      const match = this.collections.find((c) => c.tenant_id === tenantId && c.owner_user_id === owner && c.collection_id === collectionId);
      return { rowCount: match ? 1 : 0, rows: (match ? [{ ...match }] : []) as unknown as Row[] };
    }
    if (t.startsWith('SELECT * FROM dav_calendar_collections WHERE tenant_id = $1 AND collection_id = $2 AND')) {
      const [tenantId, collectionId, actorUserId] = values as string[];
      const matches = this.collections.filter((c) => c.tenant_id === tenantId && c.collection_id === collectionId && (c.owner_user_id === actorUserId || c.acl_delegate_user_id === actorUserId));
      return { rowCount: matches.length, rows: matches.map((row) => ({ ...row })) as unknown as Row[] };
    }
    if (t.startsWith('SELECT * FROM dav_calendar_collections WHERE tenant_id = $1 AND (owner_user_id = $2 OR acl_delegate_user_id = $2)')) {
      const [tenantId, actorUserId] = values as string[];
      const matches = this.collections.filter((c) => c.tenant_id === tenantId && (c.owner_user_id === actorUserId || c.acl_delegate_user_id === actorUserId));
      return { rowCount: matches.length, rows: matches.map((row) => ({ ...row })) as unknown as Row[] };
    }
    if (t.startsWith('INSERT INTO dav_calendar_collections')) {
      const [tenantId, owner, collectionId, displayName, description, timezone, color, href] = values as string[];
      const row = {
        tenant_id: tenantId, owner_user_id: owner, collection_id: collectionId, display_name: displayName, description, timezone, color,
        href, acl_delegate_user_id: null, acl_permissions: null, revision: 0, created_at: new Date('2026-08-22T10:00:00.000Z'), updated_at: new Date('2026-08-22T10:00:00.000Z'),
      };
      this.collections.push(row);
      return { rowCount: 1, rows: [{ ...row }] as unknown as Row[] };
    }
    if (t.startsWith('UPDATE dav_calendar_collections SET revision = revision + 1')) {
      const [tenantId, owner, collectionId] = values as string[];
      const row = this.collections.find((c) => c.tenant_id === tenantId && c.owner_user_id === owner && c.collection_id === collectionId)!;
      row.revision = Number(row.revision) + 1;
      row.updated_at = new Date('2026-08-22T10:05:00.000Z');
      return { rowCount: 1, rows: [{ revision: row.revision }] as unknown as Row[] };
    }
    if (t.startsWith('DELETE FROM dav_calendar_collections')) {
      const [tenantId, owner, collectionId] = values as string[];
      const beforeObjects = this.objects.length;
      this.collections = this.collections.filter((c) => !(c.tenant_id === tenantId && c.owner_user_id === owner && c.collection_id === collectionId));
      void beforeObjects;
      return { rowCount: 1, rows: [] as Row[] };
    }

    if (t.startsWith('SELECT 1 FROM dav_calendar_objects')) {
      const [tenantId, owner, collectionId, objectId] = values as string[];
      const match = this.objects.find((o) => o.tenant_id === tenantId && o.owner_user_id === owner && o.collection_id === collectionId && o.object_id === objectId);
      return { rowCount: match ? 1 : 0, rows: (match ? [{}] : []) as Row[] };
    }
    if (t.startsWith('SELECT * FROM dav_calendar_objects WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3 AND object_id = $4')) {
      const [tenantId, owner, collectionId, objectId] = values as string[];
      const match = this.objects.find((o) => o.tenant_id === tenantId && o.owner_user_id === owner && o.collection_id === collectionId && o.object_id === objectId);
      return { rowCount: match ? 1 : 0, rows: (match ? [{ ...match }] : []) as unknown as Row[] };
    }
    if (t.startsWith('SELECT * FROM dav_calendar_objects WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3 ORDER BY object_id')) {
      const [tenantId, owner, collectionId] = values as string[];
      const matches = this.objects
        .filter((o) => o.tenant_id === tenantId && o.owner_user_id === owner && o.collection_id === collectionId)
        .sort((a, b) => (a.object_id as string).localeCompare(b.object_id as string));
      return { rowCount: matches.length, rows: matches.map((row) => ({ ...row })) as unknown as Row[] };
    }
    if (t.startsWith('SELECT COUNT(*)::int AS count FROM dav_calendar_objects')) {
      const [tenantId, owner, collectionId] = values as string[];
      const count = this.objects.filter((o) => o.tenant_id === tenantId && o.owner_user_id === owner && o.collection_id === collectionId).length;
      return { rowCount: 1, rows: [{ count }] as unknown as Row[] };
    }
    if (t.startsWith('INSERT INTO dav_calendar_objects')) {
      const [tenantId, owner, collectionId, objectId, uid, etag, icalData] = values as string[];
      const row = {
        tenant_id: tenantId, owner_user_id: owner, collection_id: collectionId, object_id: objectId, uid, etag, ical_data: icalData,
        created_at: new Date('2026-08-22T10:00:00.000Z'), updated_at: new Date('2026-08-22T10:00:00.000Z'),
      };
      this.objects.push(row);
      return { rowCount: 1, rows: [{ ...row }] as unknown as Row[] };
    }
    if (t.startsWith('UPDATE dav_calendar_objects SET etag')) {
      const [etag, icalData, tenantId, owner, collectionId, objectId] = values as string[];
      const row = this.objects.find((o) => o.tenant_id === tenantId && o.owner_user_id === owner && o.collection_id === collectionId && o.object_id === objectId)!;
      row.etag = etag;
      row.ical_data = icalData;
      row.updated_at = new Date('2026-08-22T10:05:00.000Z');
      return { rowCount: 1, rows: [{ ...row }] as unknown as Row[] };
    }
    if (t.startsWith('DELETE FROM dav_calendar_objects')) {
      const [tenantId, owner, collectionId, objectId] = values as string[];
      this.objects = this.objects.filter((o) => !(o.tenant_id === tenantId && o.owner_user_id === owner && o.collection_id === collectionId && o.object_id === objectId));
      return { rowCount: 1, rows: [] as Row[] };
    }

    if (t.startsWith('INSERT INTO dav_calendar_changes')) {
      const [tenantId, owner, collectionId, revision, objectId, uid, etag, deleted] = values as [string, string, string, number, string, string | null, string | null, boolean];
      this.changes.push({ tenant_id: tenantId, owner_user_id: owner, collection_id: collectionId, revision, object_id: objectId, uid, etag, deleted });
      return { rowCount: 1, rows: [] as Row[] };
    }
    if (t.startsWith('SELECT * FROM dav_calendar_changes')) {
      const [tenantId, owner, collectionId, since] = values as [string, string, string, number];
      const matches = this.changes
        .filter((c) => c.tenant_id === tenantId && c.owner_user_id === owner && c.collection_id === collectionId && Number(c.revision) > since)
        .sort((a, b) => Number(a.revision) - Number(b.revision));
      return { rowCount: matches.length, rows: matches.map((row) => ({ ...row })) as unknown as Row[] };
    }

    throw new Error(`FakeCalDavClient: unhandled query: ${t}`);
  }

  release(): void {}
}

class FakeCardDavClient implements PostgresClientLike {
  addressBooks: Record<string, unknown>[] = [];
  contacts: Record<string, unknown>[] = [];
  changes: Record<string, unknown>[] = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<QueryResult<Row>> {
    const t = text.replace(/\s+/gu, ' ').trim();
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK' || t.includes('set_config')) return { rowCount: 0, rows: [] as Row[] };

    if (t.startsWith('SELECT 1 FROM dav_address_books')) {
      const [tenantId, userId, abId] = values as string[];
      const match = this.addressBooks.find((a) => a.tenant_id === tenantId && a.user_id === userId && a.address_book_id === abId);
      return { rowCount: match ? 1 : 0, rows: (match ? [{}] : []) as Row[] };
    }
    if (t.startsWith('SELECT * FROM dav_address_books WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3')) {
      const [tenantId, userId, abId] = values as string[];
      const match = this.addressBooks.find((a) => a.tenant_id === tenantId && a.user_id === userId && a.address_book_id === abId);
      return { rowCount: match ? 1 : 0, rows: (match ? [{ ...match }] : []) as unknown as Row[] };
    }
    if (t.startsWith('SELECT * FROM dav_address_books WHERE tenant_id = $1 AND user_id = $2 ORDER BY address_book_id')) {
      const [tenantId, userId] = values as string[];
      const matches = this.addressBooks.filter((a) => a.tenant_id === tenantId && a.user_id === userId).sort((a, b) => (a.address_book_id as string).localeCompare(b.address_book_id as string));
      return { rowCount: matches.length, rows: matches.map((row) => ({ ...row })) as unknown as Row[] };
    }
    if (t.startsWith('INSERT INTO dav_address_books')) {
      const [tenantId, userId, abId, href, displayName, description, color] = values as string[];
      const row = {
        tenant_id: tenantId, user_id: userId, address_book_id: abId, href, display_name: displayName, description, color,
        revision: 0, created_at: new Date('2026-08-22T20:00:00.000Z'), updated_at: new Date('2026-08-22T20:00:00.000Z'),
      };
      this.addressBooks.push(row);
      return { rowCount: 1, rows: [{ ...row }] as unknown as Row[] };
    }
    if (t.startsWith('UPDATE dav_address_books SET revision = revision + 1')) {
      const [tenantId, userId, abId] = values as string[];
      const row = this.addressBooks.find((a) => a.tenant_id === tenantId && a.user_id === userId && a.address_book_id === abId)!;
      row.revision = Number(row.revision) + 1;
      row.updated_at = new Date('2026-08-22T20:05:00.000Z');
      return { rowCount: 1, rows: [{ revision: row.revision }] as unknown as Row[] };
    }
    if (t.startsWith('DELETE FROM dav_address_books')) {
      const [tenantId, userId, abId] = values as string[];
      this.addressBooks = this.addressBooks.filter((a) => !(a.tenant_id === tenantId && a.user_id === userId && a.address_book_id === abId));
      this.contacts = this.contacts.filter((c) => !(c.tenant_id === tenantId && c.user_id === userId && c.address_book_id === abId));
      this.changes = this.changes.filter((c) => !(c.tenant_id === tenantId && c.user_id === userId && c.address_book_id === abId));
      return { rowCount: 1, rows: [] as Row[] };
    }

    if (t.startsWith('SELECT 1 FROM dav_contacts') && t.includes('AND uid = $4') && !t.includes('href <>')) {
      const [tenantId, userId, abId, uid] = values as string[];
      const match = this.contacts.find((c) => c.tenant_id === tenantId && c.user_id === userId && c.address_book_id === abId && c.uid === uid);
      return { rowCount: match ? 1 : 0, rows: (match ? [{}] : []) as Row[] };
    }
    if (t.startsWith('SELECT 1 FROM dav_contacts') && t.includes('AND href = $4')) {
      const [tenantId, userId, abId, href] = values as string[];
      const match = this.contacts.find((c) => c.tenant_id === tenantId && c.user_id === userId && c.address_book_id === abId && c.href === href);
      return { rowCount: match ? 1 : 0, rows: (match ? [{}] : []) as Row[] };
    }
    if (t.startsWith('SELECT href FROM dav_contacts')) {
      const [tenantId, userId, abId, uid, href] = values as string[];
      const matches = this.contacts.filter((c) => c.tenant_id === tenantId && c.user_id === userId && c.address_book_id === abId && c.uid === uid && c.href !== href);
      return { rowCount: matches.length, rows: matches.map((row) => ({ href: row.href })) as unknown as Row[] };
    }
    if (t.startsWith('SELECT * FROM dav_contacts WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 AND href = $4')) {
      const [tenantId, userId, abId, href] = values as string[];
      const match = this.contacts.find((c) => c.tenant_id === tenantId && c.user_id === userId && c.address_book_id === abId && c.href === href);
      return { rowCount: match ? 1 : 0, rows: (match ? [{ ...match }] : []) as unknown as Row[] };
    }
    if (t.startsWith('SELECT * FROM dav_contacts WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 ORDER BY href')) {
      const [tenantId, userId, abId] = values as string[];
      const matches = this.contacts
        .filter((c) => c.tenant_id === tenantId && c.user_id === userId && c.address_book_id === abId)
        .sort((a, b) => (a.href as string).localeCompare(b.href as string));
      return { rowCount: matches.length, rows: matches.map((row) => ({ ...row })) as unknown as Row[] };
    }
    if (t.startsWith('INSERT INTO dav_contacts')) {
      const [tenantId, userId, abId, href, uid, fullName, vcardData, etag, mediaType, sizeBytes, revision] = values as (string | number)[];
      const row = {
        tenant_id: tenantId, user_id: userId, address_book_id: abId, href, uid, full_name: fullName, vcard_data: vcardData, etag,
        media_type: mediaType, size_bytes: sizeBytes, revision, created_at: new Date('2026-08-22T20:00:00.000Z'), updated_at: new Date('2026-08-22T20:00:00.000Z'),
      };
      this.contacts.push(row);
      return { rowCount: 1, rows: [{ ...row }] as unknown as Row[] };
    }
    if (t.startsWith('UPDATE dav_contacts SET full_name')) {
      const [fullName, vcardData, etag, mediaType, sizeBytes, revision, tenantId, userId, abId, href] = values as (string | number)[];
      const row = this.contacts.find((c) => c.tenant_id === tenantId && c.user_id === userId && c.address_book_id === abId && c.href === href)!;
      row.full_name = fullName;
      row.vcard_data = vcardData;
      row.etag = etag;
      row.media_type = mediaType;
      row.size_bytes = sizeBytes;
      row.revision = revision;
      row.updated_at = new Date('2026-08-22T20:05:00.000Z');
      return { rowCount: 1, rows: [{ ...row }] as unknown as Row[] };
    }
    if (t.startsWith('DELETE FROM dav_contacts')) {
      const [tenantId, userId, abId, href] = values as string[];
      this.contacts = this.contacts.filter((c) => !(c.tenant_id === tenantId && c.user_id === userId && c.address_book_id === abId && c.href === href));
      return { rowCount: 1, rows: [] as Row[] };
    }

    if (t.startsWith('INSERT INTO dav_contact_changes')) {
      const [tenantId, userId, abId, revision, href, uid, etag, operation] = values as (string | number | null)[];
      this.changes.push({ tenant_id: tenantId, user_id: userId, address_book_id: abId, revision, href, uid, etag, operation });
      return { rowCount: 1, rows: [] as Row[] };
    }
    if (t.startsWith('SELECT * FROM dav_contact_changes')) {
      const [tenantId, userId, abId, since] = values as [string, string, string, number];
      const matches = this.changes
        .filter((c) => c.tenant_id === tenantId && c.user_id === userId && c.address_book_id === abId && Number(c.revision) > since)
        .sort((a, b) => Number(a.revision) - Number(b.revision));
      return { rowCount: matches.length, rows: matches.map((row) => ({ ...row })) as unknown as Row[] };
    }

    throw new Error(`FakeCardDavClient: unhandled query: ${t}`);
  }

  release(): void {}
}

class FakePool<Client extends PostgresClientLike> {
  readonly options: PostgresPoolOptions;
  readonly client: Client;
  constructor(options: PostgresPoolOptions, client: Client) { this.options = options; this.client = client; }
  async connect(): Promise<Client> { return this.client; }
  async end(): Promise<void> {}
}

function postgresConfig() {
  return {
    contract: {
      postgres: {
        enabled: true, host: 'postgres.example', port: 5432, database: 'gulogulo', user: 'gulogulo',
        sslMode: 'verify-full', dsnSecretRef: 'postgres/dsn', connectTimeoutMs: 100, idleTimeoutMs: 1000,
        poolMax: 2, retryAttempts: 0,
      },
    },
  };
}

function makeDavStore() {
  const caldavClient = new FakeCalDavClient();
  const carddavClient = new FakeCardDavClient();
  class CalDavPool extends FakePool<FakeCalDavClient> { constructor(options: PostgresPoolOptions) { super(options, caldavClient); } }
  class CardDavPool extends FakePool<FakeCardDavClient> { constructor(options: PostgresPoolOptions) { super(options, carddavClient); } }
  const caldav = createPostgresCalDavStore({ config: postgresConfig(), resolveSecret: async () => 'postgresql://secret', PoolClass: CalDavPool });
  const carddav = createPostgresCardDavStore({ config: postgresConfig(), resolveSecret: async () => 'postgresql://secret', PoolClass: CardDavPool });
  if (!caldav.enabled || !carddav.enabled) throw new Error('fake DAV stores unexpectedly disabled');
  return { davStore: { caldav, carddav }, caldav, carddav };
}

function createTestLogger() {
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  return {
    logger: createLogger({ output: output as unknown as typeof process.stdout, errorOutput: errorOutput as unknown as typeof process.stderr }),
    output,
    errorOutput,
  };
}

const alice = Object.freeze({ tenantId: 'acme', domain: 'acme.example', userId: 'alice', actorId: 'alice', role: 'user' as const });

function makeTestRuntime(options: Parameters<typeof createRuntimeServer>[0] = {}) {
  const streams = createTestLogger();
  const runtime = createRuntimeServer({
    config: { host: '127.0.0.1', port: 0, serviceName: 'gulogulo-dav-test', environment: 'test', shutdownTimeoutMs: 1_000 },
    logger: streams.logger,
    authenticateLogin: async ({ email, password }) => (email === 'alice@acme.example' && password === 'test-only-password' ? alice : null),
    ...options,
  });
  return { runtime, ...streams };
}

function serverAddress(runtime: TestRuntime): AddressInfo {
  const address = runtime.server.address();
  assert.ok(address !== null && typeof address === 'object');
  return address;
}

interface RawResponse { statusCode: number | undefined; headers: IncomingHttpHeaders; body: string }

function rawRequest(runtime: TestRuntime, path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: OutgoingHttpHeaders; body?: string } = {}): Promise<RawResponse> {
  const address = serverAddress(runtime);
  return new Promise<RawResponse>((resolvePromise, reject) => {
    const requestHandle = request({
      host: address.address,
      port: address.port,
      path,
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolvePromise({ statusCode: response.statusCode, headers: response.headers, body: responseBody }));
    });
    requestHandle.on('error', reject);
    requestHandle.end(body);
  });
}

async function login(runtime: TestRuntime): Promise<string> {
  const response = await rawRequest(runtime, '/api/session/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alice@acme.example', password: 'test-only-password', rememberMe: false }),
  });
  assert.equal(response.statusCode, 200);
  const setCookie = response.headers['set-cookie'];
  assert.ok(Array.isArray(setCookie) && setCookie.length > 0);
  return setCookie[0]!.split(';', 1)[0]!;
}

function event({ summary = 'Team meeting', uid = 'event-1@example.test' }: { summary?: string; uid?: string } = {}) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Sythos//Gulo Gulo//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20260822T100000Z\r\nDTSTART:20260822T120000Z\r\nDTEND:20260822T130000Z\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
}

function vcard({ fullName = 'Ada Lovelace', uid = 'ada' }: { fullName?: string; uid?: string } = {}) {
  return `BEGIN:VCARD\r\nVERSION:4.0\r\nUID:${uid}\r\nFN:${fullName}\r\nEND:VCARD\r\n`;
}

test('DAV routes reject unauthenticated requests and unimplemented methods', async () => {
  const { davStore } = makeDavStore();
  const { runtime } = makeTestRuntime({ davStore });
  await startServer(runtime);
  try {
    const anonymous = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/', { method: 'PROPFIND', headers: { depth: '0' } });
    assert.equal(anonymous.statusCode, 401);

    const cookie = await login(runtime);
    const unsupported = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/', { method: 'MKCOL', headers: { cookie } });
    assert.equal(unsupported.statusCode, 501);
  } finally {
    await stopServer(runtime);
  }
});

test('CalDAV: PUT creates an object, GET reads it back, conditional update/delete enforce ETags, PROPFIND/REPORT list it', async () => {
  const { davStore, caldav } = makeDavStore();
  const { runtime } = makeTestRuntime({ davStore });
  await startServer(runtime);
  try {
    const cookie = await login(runtime);
    await caldav.createCalendarCollection(alice, { collectionId: 'personal', displayName: 'Alice calendar' });

    const created = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/event-1.ics', {
      method: 'PUT', headers: { cookie, 'if-none-match': '*', 'content-type': 'text/calendar' }, body: event(),
    });
    assert.equal(created.statusCode, 201);
    const etag = created.headers.etag as string;
    assert.match(etag, /^"[a-f0-9]{64}"$/u);

    const conflict = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/event-1.ics', {
      method: 'PUT', headers: { cookie, 'if-none-match': '*', 'content-type': 'text/calendar' }, body: event(),
    });
    assert.equal(conflict.statusCode, 412);

    const fetched = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/event-1.ics', { method: 'GET', headers: { cookie } });
    assert.equal(fetched.statusCode, 200);
    assert.match(fetched.headers['content-type'] as string, /^text\/calendar/u);
    assert.equal(fetched.headers.etag, etag);
    assert.match(fetched.body, /SUMMARY:Team meeting/u);

    const staleUpdate = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/event-1.ics', {
      method: 'PUT', headers: { cookie, 'if-match': '"stale"', 'content-type': 'text/calendar' }, body: event({ summary: 'Updated' }),
    });
    assert.equal(staleUpdate.statusCode, 412);

    const updated = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/event-1.ics', {
      method: 'PUT', headers: { cookie, 'if-match': etag, 'content-type': 'text/calendar' }, body: event({ summary: 'Updated' }),
    });
    assert.equal(updated.statusCode, 204);
    const updatedEtag = updated.headers.etag as string;
    assert.notEqual(updatedEtag, etag);

    const propfind0 = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/', { method: 'PROPFIND', headers: { cookie, depth: '0' } });
    assert.equal(propfind0.statusCode, 207);
    assert.match(propfind0.body, /<D:multistatus/u);
    assert.match(propfind0.body, /<D:sync-token>/u);
    assert.doesNotMatch(propfind0.body, /event-1\.ics/u);

    const propfind1 = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/', { method: 'PROPFIND', headers: { cookie, depth: '1' } });
    assert.equal(propfind1.statusCode, 207);
    assert.match(propfind1.body, /event-1\.ics/u);
    assert.match(propfind1.body, new RegExp(updatedEtag.replace(/"/gu, '&quot;'), 'u'));

    const report = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/', {
      method: 'REPORT', headers: { cookie, 'content-type': 'application/xml' }, body: '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"/>',
    });
    assert.equal(report.statusCode, 207);
    assert.match(report.body, /event-1\.ics/u);

    const staleDelete = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/event-1.ics', { method: 'DELETE', headers: { cookie, 'if-match': etag } });
    assert.equal(staleDelete.statusCode, 412);

    const deleted = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/event-1.ics', { method: 'DELETE', headers: { cookie, 'if-match': updatedEtag } });
    assert.equal(deleted.statusCode, 204);

    const afterDelete = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/event-1.ics', { method: 'GET', headers: { cookie } });
    assert.equal(afterDelete.statusCode, 404);
  } finally {
    await stopServer(runtime);
  }
});

test('CalDAV: REPORT sync-collection exposes created/updated objects and deletion tombstones by sync-token', async () => {
  const { davStore, caldav } = makeDavStore();
  const { runtime } = makeTestRuntime({ davStore });
  await startServer(runtime);
  try {
    const cookie = await login(runtime);
    await caldav.createCalendarCollection(alice, { collectionId: 'personal' });

    const initialSync = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/', {
      method: 'REPORT', headers: { cookie, 'content-type': 'application/xml' }, body: '<D:sync-collection xmlns:D="DAV:"/>',
    });
    assert.equal(initialSync.statusCode, 207);
    const initialTokenMatch = /<D:sync-token>([^<]*)<\/D:sync-token>/u.exec(initialSync.body);
    assert.ok(initialTokenMatch);
    const initialToken = initialTokenMatch![1]!;

    const created = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/event-1.ics', {
      method: 'PUT', headers: { cookie, 'if-none-match': '*', 'content-type': 'text/calendar' }, body: event(),
    });
    assert.equal(created.statusCode, 201);

    const incrementalSync = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/', {
      method: 'REPORT', headers: { cookie, 'content-type': 'application/xml' },
      body: `<D:sync-collection xmlns:D="DAV:"><D:sync-token>${initialToken}</D:sync-token></D:sync-collection>`,
    });
    assert.equal(incrementalSync.statusCode, 207);
    assert.match(incrementalSync.body, /event-1\.ics/u);
    assert.doesNotMatch(incrementalSync.body, /404 Not Found/u);
    const nextTokenMatch = /<D:sync-token>([^<]*)<\/D:sync-token>/u.exec(incrementalSync.body);
    const nextToken = nextTokenMatch![1]!;

    await rawRequest(runtime, '/dav/calendars/acme/alice/personal/event-1.ics', { method: 'DELETE', headers: { cookie, 'if-match': created.headers.etag as string } });

    const deletionSync = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/', {
      method: 'REPORT', headers: { cookie, 'content-type': 'application/xml' },
      body: `<D:sync-collection xmlns:D="DAV:"><D:sync-token>${nextToken}</D:sync-token></D:sync-collection>`,
    });
    assert.equal(deletionSync.statusCode, 207);
    assert.match(deletionSync.body, /event-1\.ics/u);
    assert.match(deletionSync.body, /404 Not Found/u);
  } finally {
    await stopServer(runtime);
  }
});

test('CalDAV: a request whose URL tenant does not match the session tenant is denied, never reaching the store', async () => {
  const { davStore, caldav } = makeDavStore();
  const { runtime } = makeTestRuntime({ davStore });
  await startServer(runtime);
  try {
    const cookie = await login(runtime);
    await caldav.createCalendarCollection(alice, { collectionId: 'personal' });

    const crossTenant = await rawRequest(runtime, '/dav/calendars/other-tenant/alice/personal/', { method: 'PROPFIND', headers: { cookie, depth: '0' } });
    assert.equal(crossTenant.statusCode, 403);
  } finally {
    await stopServer(runtime);
  }
});

test('CardDAV: PUT creates a contact, GET reads it back, conditional update/delete enforce ETags, sync-collection REPORT lists changes', async () => {
  const { davStore, carddav } = makeDavStore();
  const { runtime } = makeTestRuntime({ davStore });
  await startServer(runtime);
  try {
    const cookie = await login(runtime);
    await carddav.createAddressBook(alice, { addressBookId: 'personal', displayName: 'Alice contacts' });

    const created = await rawRequest(runtime, '/dav/contacts/acme/alice/personal/ada.vcf', {
      method: 'PUT', headers: { cookie, 'if-none-match': '*', 'content-type': 'text/vcard' }, body: vcard(),
    });
    assert.equal(created.statusCode, 201);
    const etag = created.headers.etag as string;

    const fetched = await rawRequest(runtime, '/dav/contacts/acme/alice/personal/ada.vcf', { method: 'GET', headers: { cookie } });
    assert.equal(fetched.statusCode, 200);
    assert.match(fetched.headers['content-type'] as string, /vcard/u);
    assert.match(fetched.body, /FN:Ada Lovelace/u);

    const staleUpdate = await rawRequest(runtime, '/dav/contacts/acme/alice/personal/ada.vcf', {
      method: 'PUT', headers: { cookie, 'if-match': '"stale"', 'content-type': 'text/vcard' }, body: vcard({ fullName: 'Changed' }),
    });
    assert.equal(staleUpdate.statusCode, 412);

    const updated = await rawRequest(runtime, '/dav/contacts/acme/alice/personal/ada.vcf', {
      method: 'PUT', headers: { cookie, 'if-match': etag, 'content-type': 'text/vcard' }, body: vcard({ fullName: 'Changed' }),
    });
    assert.equal(updated.statusCode, 204);
    const updatedEtag = updated.headers.etag as string;

    const report = await rawRequest(runtime, '/dav/contacts/acme/alice/personal/', {
      method: 'REPORT', headers: { cookie, 'content-type': 'application/xml' }, body: '<D:sync-collection xmlns:D="DAV:"/>',
    });
    assert.equal(report.statusCode, 207);
    assert.match(report.body, /ada\.vcf/u);
    assert.match(report.body, new RegExp(updatedEtag.replace(/"/gu, '&quot;'), 'u'));

    const staleDelete = await rawRequest(runtime, '/dav/contacts/acme/alice/personal/ada.vcf', { method: 'DELETE', headers: { cookie, 'if-match': etag } });
    assert.equal(staleDelete.statusCode, 412);

    const deleted = await rawRequest(runtime, '/dav/contacts/acme/alice/personal/ada.vcf', { method: 'DELETE', headers: { cookie, 'if-match': updatedEtag } });
    assert.equal(deleted.statusCode, 204);
  } finally {
    await stopServer(runtime);
  }
});

test('CardDAV: an address book URL for another user is denied even within the same tenant', async () => {
  const { davStore, carddav } = makeDavStore();
  const { runtime } = makeTestRuntime({ davStore });
  await startServer(runtime);
  try {
    const cookie = await login(runtime);
    await carddav.createAddressBook(alice, { addressBookId: 'personal', displayName: 'Alice contacts' });

    const crossUser = await rawRequest(runtime, '/dav/contacts/acme/bob/personal/', { method: 'PROPFIND', headers: { cookie, depth: '0' } });
    assert.equal(crossUser.statusCode, 403);
  } finally {
    await stopServer(runtime);
  }
});

test('DAV routes respond 503 when no DAV store is configured', async () => {
  const { runtime } = makeTestRuntime();
  await startServer(runtime);
  try {
    const cookie = await login(runtime);
    const response = await rawRequest(runtime, '/dav/calendars/acme/alice/personal/', { method: 'PROPFIND', headers: { cookie, depth: '0' } });
    assert.equal(response.statusCode, 503);
  } finally {
    await stopServer(runtime);
  }
});
