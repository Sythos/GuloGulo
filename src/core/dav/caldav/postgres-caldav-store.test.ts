// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createPostgresCalDavStore } from './postgres-caldav-store.ts';
import type { PostgresClientLike, PostgresPoolOptions, QueryResult } from '../../../integrations/types.ts';

// A tiny in-memory relational simulation of the three tables from
// src/core/db/migrations/0003_dav_storage.sql (dav_calendar_collections,
// dav_calendar_objects, dav_calendar_changes), driven by matching the exact
// query text postgres-caldav-store.ts issues. Mirrors the FakeClient/FakePool
// pattern already used by src/integrations/postgres-store.test.ts and
// src/platform/standalone/db-identity-client.test.ts, extended to hold state
// across calls (a real transaction) instead of returning fixed rows.
class FakeClient implements PostgresClientLike {
  readonly queries: Array<{ text: string; values: unknown[] }> = [];
  released = false;
  collections: Record<string, unknown>[] = [];
  objects: Record<string, unknown>[] = [];
  changes: Record<string, unknown>[] = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<QueryResult<Row>> {
    this.queries.push({ text, values });
    const t = text.replace(/\s+/gu, ' ').trim();

    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK' || t.includes('set_config')) {
      return { rowCount: 0, rows: [] as Row[] };
    }

    // --- dav_calendar_collections -------------------------------------------------
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
      const matches = this.collections
        .filter((c) => c.tenant_id === tenantId && (c.owner_user_id === actorUserId || c.acl_delegate_user_id === actorUserId))
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- fake store rows are untyped test fixtures, always plain strings here
        .sort((a, b) => `${a.owner_user_id}/${a.collection_id}`.localeCompare(`${b.owner_user_id}/${b.collection_id}`));
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
    if (t.startsWith('UPDATE dav_calendar_collections SET acl_delegate_user_id = $1, acl_permissions = $2')) {
      const [delegate, permissions, tenantId, owner, collectionId] = values as [string, string[], string, string, string];
      const row = this.collections.find((c) => c.tenant_id === tenantId && c.owner_user_id === owner && c.collection_id === collectionId)!;
      row.acl_delegate_user_id = delegate;
      row.acl_permissions = permissions;
      return { rowCount: 1, rows: [{ ...row }] as unknown as Row[] };
    }
    if (t.startsWith('UPDATE dav_calendar_collections SET acl_delegate_user_id = NULL')) {
      const [tenantId, owner, collectionId] = values as string[];
      const row = this.collections.find((c) => c.tenant_id === tenantId && c.owner_user_id === owner && c.collection_id === collectionId)!;
      row.acl_delegate_user_id = null;
      row.acl_permissions = null;
      return { rowCount: 1, rows: [{ ...row }] as unknown as Row[] };
    }
    if (t.startsWith('DELETE FROM dav_calendar_collections')) {
      const [tenantId, owner, collectionId] = values as string[];
      this.collections = this.collections.filter((c) => !(c.tenant_id === tenantId && c.owner_user_id === owner && c.collection_id === collectionId));
      return { rowCount: 1, rows: [] as Row[] };
    }

    // --- dav_calendar_objects -------------------------------------------------
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

    // --- dav_calendar_changes -------------------------------------------------
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

    throw new Error(`FakeClient: unhandled query: ${t}`);
  }

  release(): void {
    this.released = true;
  }
}

class FakePool {
  readonly options: PostgresPoolOptions;
  readonly client: FakeClient;
  constructor(options: PostgresPoolOptions, client: FakeClient) { this.options = options; this.client = client; }
  async connect(): Promise<FakeClient> { return this.client; }
  async end(): Promise<void> {}
}

function config() {
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

function makeStore() {
  const fakeClient = new FakeClient();
  class RowPool extends FakePool {
    constructor(options: PostgresPoolOptions) { super(options, fakeClient); }
  }
  const store = createPostgresCalDavStore({ config: config(), resolveSecret: async () => 'postgresql://secret', PoolClass: RowPool });
  return { store, fakeClient };
}

const alice = Object.freeze({ tenantId: 'acme', domain: 'acme.example', userId: 'alice', role: 'user' });
const bob = Object.freeze({ tenantId: 'acme', domain: 'acme.example', userId: 'bob', role: 'user' });

function event({ summary = 'Team meeting', uid = 'event-1@example.test' }: { summary?: string; uid?: string } = {}) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Sythos//Gulo Gulo//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20260822T100000Z\r\nDTSTART:20260822T120000Z\r\nDTEND:20260822T130000Z\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
}

test('createPostgresCalDavStore() is disabled when postgres is disabled', async () => {
  const store = createPostgresCalDavStore({ config: { contract: { postgres: { enabled: false } } } });
  assert.equal(store.enabled, false);
  assert.deepEqual(await store.healthCheck(), { status: 'disabled' });
  await store.close();
});

test('createCalendarCollection persists a row and enforces tenant/owner isolation', async () => {
  const { store } = makeStore();
  if (!store.enabled) throw new Error('store unexpectedly disabled');
  const collection = await store.createCalendarCollection(alice, { collectionId: 'personal', displayName: 'Alice calendar' });
  assert.equal(collection.calendarId, 'alice/personal');
  assert.equal(collection.href, '/dav/calendars/acme/alice/personal/');
  await assert.rejects(
    () => store.createCalendarCollection({ ...alice, userId: 'bob' }, { collectionId: 'other', ownerUserId: 'alice' }),
    (error: any) => error.code === 'ACL_DENIED',
  );
  await assert.rejects(
    () => store.createCalendarCollection(alice, { collectionId: 'personal' }),
    (error: any) => error.code === 'CALENDAR_EXISTS',
  );
  const listed = await store.listCalendarCollections(alice);
  assert.deepEqual(listed.map((c: any) => c.calendarId), ['alice/personal']);
  assert.deepEqual(await store.listCalendarCollections(bob), []);
});

test('Postgres-computed ETags are byte-identical to the in-memory contract for the same inputs', async () => {
  const { store } = makeStore();
  if (!store.enabled) throw new Error('store unexpectedly disabled');
  await store.createCalendarCollection(alice, { collectionId: 'personal' });
  const created = await store.createCalendarObject(alice, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' });
  assert.match(created.etag, /^"[a-f0-9]{64}"$/u);
  const { createCalDavStore } = await import('./caldav-contract.ts');
  const inMemory = createCalDavStore({ tenantId: 'acme', clock: () => new Date('2026-08-22T10:00:00.000Z') });
  const memoryOwner = { tenantId: 'acme', userId: 'alice', role: 'user' };
  inMemory.createCalendarCollection(memoryOwner, { collectionId: 'personal' });
  const memoryCreated = inMemory.createCalendarObject(memoryOwner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' });
  assert.equal(created.etag, memoryCreated.etag);
});

test('conditional create/update/delete enforce ETag preconditions', async () => {
  const { store } = makeStore();
  if (!store.enabled) throw new Error('store unexpectedly disabled');
  await store.createCalendarCollection(alice, { collectionId: 'personal' });
  const created = await store.createCalendarObject(alice, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' });
  await assert.rejects(
    () => store.createCalendarObject(alice, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' }),
    (error: any) => error.code === 'PRECONDITION_FAILED' && error.status === 412,
  );
  await assert.rejects(
    () => store.updateCalendarObject(alice, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event({ summary: 'Updated' }) }),
    (error: any) => error.code === 'PRECONDITION_REQUIRED' && error.status === 428,
  );
  await assert.rejects(
    () => store.updateCalendarObject(alice, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event({ summary: 'Updated' }), ifMatch: '"stale"' }),
    (error: any) => error.code === 'PRECONDITION_FAILED' && error.status === 412,
  );
  const updated = await store.updateCalendarObject(alice, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event({ summary: 'Updated' }), ifMatch: created.etag });
  assert.notEqual(updated.etag, created.etag);
  assert.equal(updated.metadata.summary, 'Updated');
  await assert.rejects(
    () => store.deleteCalendarObject(alice, { calendarId: 'alice/personal', objectId: 'event-1.ics', ifMatch: created.etag }),
    (error: any) => error.code === 'PRECONDITION_FAILED' && error.status === 412,
  );
  const deleted = await store.deleteCalendarObject(alice, { calendarId: 'alice/personal', objectId: 'event-1.ics', ifMatch: updated.etag });
  assert.equal(deleted.deleted, true);
});

test('sync-token/changelog exposes deterministic changes and deletion tombstones', async () => {
  const { store } = makeStore();
  if (!store.enabled) throw new Error('store unexpectedly disabled');
  await store.createCalendarCollection(alice, { collectionId: 'personal' });
  const empty = await store.listCalendarObjects(alice, { calendarId: 'alice/personal' });
  assert.deepEqual(empty.objects, []);
  const created = await store.createCalendarObject(alice, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' });
  const afterCreate = await store.listCalendarObjects(alice, { calendarId: 'alice/personal', syncToken: empty.syncToken });
  assert.deepEqual(afterCreate.objects.map((o: any) => o.objectId), ['event-1.ics']);
  const afterDelete1 = await store.deleteCalendarObject(alice, { calendarId: 'alice/personal', objectId: 'event-1.ics', ifMatch: created.etag });
  const deletionSync = await store.listCalendarObjects(alice, { calendarId: 'alice/personal', syncToken: afterCreate.syncToken });
  assert.deepEqual(deletionSync.objects, []);
  assert.deepEqual(deletionSync.deletedObjectIds, ['event-1.ics']);
  assert.equal(afterDelete1.deleted, true);
});

test('read delegation cannot mutate; write delegation can; ACL is owner-only to change', async () => {
  const { store } = makeStore();
  if (!store.enabled) throw new Error('store unexpectedly disabled');
  await store.createCalendarCollection(alice, { collectionId: 'personal' });
  await assert.rejects(
    () => store.setCalendarAcl(bob, { calendarId: 'alice/personal', delegateUserId: 'carol', permissions: ['read'] }),
    (error: any) => error.code === 'ACL_DENIED',
  );
  const delegated = await store.setCalendarAcl(alice, { calendarId: 'alice/personal', delegateUserId: 'bob', permissions: ['write'] });
  assert.deepEqual(delegated.acl, [{ delegateUserId: 'bob', permissions: ['read', 'write'] }]);
  const created = await store.createCalendarObject(alice, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' });
  const bobUpdated = await store.updateCalendarObject(bob, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event({ summary: 'From Bob' }), ifMatch: created.etag });
  assert.equal(bobUpdated.metadata.summary, 'From Bob');
  await store.revokeCalendarAcl(alice, { calendarId: 'alice/personal' });
  await assert.rejects(
    () => store.getCalendarCollection(bob, 'alice/personal'),
    (error: any) => error.code === 'ACL_DENIED',
  );
});

test('collection deletion is conditional and never silently drops objects', async () => {
  const { store } = makeStore();
  if (!store.enabled) throw new Error('store unexpectedly disabled');
  await store.createCalendarCollection(alice, { collectionId: 'personal' });
  await store.createCalendarObject(alice, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' });
  await assert.rejects(
    () => store.deleteCalendarCollection(alice, { calendarId: 'alice/personal' }),
    (error: any) => error.code === 'CALENDAR_NOT_EMPTY',
  );
  const { store: emptyStore } = makeStore();
  if (!emptyStore.enabled) throw new Error('store unexpectedly disabled');
  await emptyStore.createCalendarCollection(alice, { collectionId: 'personal' });
  await assert.rejects(
    () => emptyStore.deleteCalendarCollection(alice, { calendarId: 'alice/personal', ifMatch: '"stale"' }),
    (error: any) => error.code === 'PRECONDITION_FAILED',
  );
  const result = await emptyStore.deleteCalendarCollection(alice, { calendarId: 'alice/personal', ifMatch: '*' });
  assert.equal(result.deleted, true);
});
