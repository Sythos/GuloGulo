// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createPostgresCardDavStore } from './postgres-carddav-store.ts';
import type { PostgresClientLike, PostgresPoolOptions, QueryResult } from '../../../integrations/types.ts';

// A tiny in-memory relational simulation of dav_address_books/dav_contacts/
// dav_contact_changes (src/core/db/migrations/0003_dav_storage.sql), driven
// by matching the exact query text postgres-carddav-store.ts issues. Mirrors
// the FakeClient/FakePool pattern already used by
// src/integrations/postgres-store.test.ts and
// src/platform/standalone/db-identity-client.test.ts, extended to hold state
// across calls instead of returning fixed rows.
class FakeClient implements PostgresClientLike {
  readonly queries: Array<{ text: string; values: unknown[] }> = [];
  released = false;
  addressBooks: Record<string, unknown>[] = [];
  contacts: Record<string, unknown>[] = [];
  changes: Record<string, unknown>[] = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<QueryResult<Row>> {
    this.queries.push({ text, values });
    const t = text.replace(/\s+/gu, ' ').trim();

    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK' || t.includes('set_config')) {
      return { rowCount: 0, rows: [] as Row[] };
    }

    // --- dav_address_books -------------------------------------------------
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

    // --- dav_contacts -------------------------------------------------
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

    // --- dav_contact_changes -------------------------------------------------
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
  const store = createPostgresCardDavStore({ config: config(), resolveSecret: async () => 'postgresql://secret', PoolClass: RowPool });
  return { store, fakeClient };
}

const alice = Object.freeze({ tenantId: 'acme', domain: 'acme.example', userId: 'alice' });
const bob = Object.freeze({ tenantId: 'acme', domain: 'acme.example', userId: 'bob' });

function aliceCard({ fullName = 'Alice Example', uid = 'alice-1' }: { fullName?: string; uid?: string } = {}) {
  return `BEGIN:VCARD\r\nVERSION:4.0\r\nUID:${uid}\r\nFN:${fullName}\r\nEMAIL;TYPE=work:alice@example.test\r\nEND:VCARD\r\n`;
}

test('createPostgresCardDavStore() is disabled when postgres is disabled', async () => {
  const store = createPostgresCardDavStore({ config: { contract: { postgres: { enabled: false } } } });
  assert.equal(store.enabled, false);
  assert.deepEqual(await store.healthCheck(), { status: 'disabled' });
  await store.close();
});

test('createAddressBook persists a row scoped to tenant/user', async () => {
  const { store } = makeStore();
  if (!store.enabled) throw new Error('store unexpectedly disabled');
  const created = await store.createAddressBook(alice, { addressBookId: 'personal', displayName: 'Personal contacts' });
  assert.equal(created.addressBookId, 'personal');
  assert.equal(created.href, '/addressbooks/personal/');
  assert.equal((await store.listAddressBooks(alice)).length, 1);
  assert.equal((await store.listAddressBooks(bob)).length, 0);
  await assert.rejects(
    () => store.getAddressBook(bob, { addressBookId: 'personal' }),
    (error: any) => error.code === 'ADDRESS_BOOK_NOT_FOUND' && error.status === 404,
  );
});

test('Postgres-computed contact ETags are byte-identical to the in-memory contract for the same inputs', async () => {
  const { store } = makeStore();
  if (!store.enabled) throw new Error('store unexpectedly disabled');
  await store.createAddressBook(alice, { addressBookId: 'personal', displayName: 'Personal' });
  const created = await store.createContact(alice, { addressBookId: 'personal', href: 'alice-1.vcf', ifNoneMatch: '*', vCard: aliceCard() });
  const { CardDavStore } = await import('./carddav-store.ts');
  const inMemory = new CardDavStore({ clock: () => Date.parse('2026-08-22T20:00:00Z') });
  inMemory.createAddressBook({ scope: alice, addressBookId: 'personal', displayName: 'Personal' });
  const memoryCreated = inMemory.createContact({ scope: alice, addressBookId: 'personal', href: 'alice-1.vcf', ifNoneMatch: '*', vCard: aliceCard() });
  assert.equal(created.etag, memoryCreated.etag);
});

test('contact create/update/delete enforce conditional ETags', async () => {
  const { store } = makeStore();
  if (!store.enabled) throw new Error('store unexpectedly disabled');
  await store.createAddressBook(alice, { addressBookId: 'personal', displayName: 'Personal' });
  const created = await store.createContact(alice, { addressBookId: 'personal', href: 'alice-1.vcf', ifNoneMatch: '*', vCard: aliceCard() });
  await assert.rejects(
    () => store.createContact(alice, { addressBookId: 'personal', href: 'missing.vcf', vCard: aliceCard() }),
    (error: any) => error.code === 'PRECONDITION_REQUIRED' && error.status === 428,
  );
  await assert.rejects(
    () => store.createContact(alice, { addressBookId: 'personal', href: 'alice-1.vcf', ifNoneMatch: '*', vCard: aliceCard() }),
    (error: any) => error.code === 'CONTACT_EXISTS' && error.status === 412,
  );
  await assert.rejects(
    () => store.putContact(alice, { addressBookId: 'personal', href: 'alice-1.vcf', ifMatch: '"stale"', vCard: aliceCard({ fullName: 'Changed' }) }),
    (error: any) => error.code === 'ETAG_MISMATCH' && error.status === 412,
  );
  const updated = await store.putContact(alice, { addressBookId: 'personal', href: 'alice-1.vcf', ifMatch: created.etag, vCard: aliceCard({ fullName: 'Changed' }) });
  assert.notEqual(updated.etag, created.etag);
  assert.equal(updated.fullName, 'Changed');
  const deleted = await store.deleteContact(alice, { addressBookId: 'personal', href: 'alice-1.vcf', ifMatch: updated.etag });
  assert.deepEqual({ href: deleted.href, status: deleted.status, etag: deleted.etag }, { href: 'alice-1.vcf', status: 'deleted', etag: null });
});

test('putContact is idempotent: an unchanged vCard does not bump the revision or append a change row', async () => {
  const { store, fakeClient } = makeStore();
  if (!store.enabled) throw new Error('store unexpectedly disabled');
  await store.createAddressBook(alice, { addressBookId: 'personal', displayName: 'Personal' });
  const created = await store.createContact(alice, { addressBookId: 'personal', href: 'alice-1.vcf', ifNoneMatch: '*', vCard: aliceCard() });
  const revisionAfterCreate = fakeClient.addressBooks[0]!.revision;
  const changesAfterCreate = fakeClient.changes.length;
  const resubmitted = await store.putContact(alice, { addressBookId: 'personal', href: 'alice-1.vcf', ifMatch: created.etag, vCard: aliceCard() });
  assert.equal(resubmitted.etag, created.etag);
  assert.equal(fakeClient.addressBooks[0]!.revision, revisionAfterCreate);
  assert.equal(fakeClient.changes.length, changesAfterCreate);
});

test('UID uniqueness is enforced within an address book; UID is immutable across an update', async () => {
  const { store } = makeStore();
  if (!store.enabled) throw new Error('store unexpectedly disabled');
  await store.createAddressBook(alice, { addressBookId: 'personal', displayName: 'Personal' });
  await store.createContact(alice, { addressBookId: 'personal', href: 'alice-1.vcf', ifNoneMatch: '*', vCard: aliceCard() });
  await assert.rejects(
    () => store.createContact(alice, { addressBookId: 'personal', href: 'dup.vcf', ifNoneMatch: '*', vCard: aliceCard() }),
    (error: any) => error.code === 'VCARD_UID_EXISTS' && error.status === 409,
  );
  const created = await store.putContact(alice, { addressBookId: 'personal', href: 'new.vcf', ifNoneMatch: '*', vCard: aliceCard({ uid: 'second' }) });
  await assert.rejects(
    () => store.putContact(alice, { addressBookId: 'personal', href: 'new.vcf', ifMatch: created.etag, vCard: aliceCard({ uid: 'alice-1' }) }),
    (error: any) => error.code === 'VCARD_UID_IMMUTABLE',
  );
});

test('sync tokens are opaque, tenant/user/address-book scoped, and expose deletion tombstones', async () => {
  const { store } = makeStore();
  if (!store.enabled) throw new Error('store unexpectedly disabled');
  const book = await store.createAddressBook(alice, { addressBookId: 'personal', displayName: 'Personal' });
  const initial = await store.syncCollection(alice, { addressBookId: 'personal', syncToken: book.syncToken });
  assert.deepEqual(initial.changes, []);
  const created = await store.createContact(alice, { addressBookId: 'personal', href: 'alice-1.vcf', ifNoneMatch: '*', vCard: aliceCard() });
  const afterCreate = await store.syncCollection(alice, { addressBookId: 'personal', syncToken: book.syncToken });
  assert.equal(afterCreate.changes.length, 1);
  assert.equal(afterCreate.changes[0].etag, created.etag);
  const afterDelete = await store.deleteContact(alice, { addressBookId: 'personal', href: 'alice-1.vcf', ifMatch: created.etag });
  const deletionSync = await store.syncCollection(alice, { addressBookId: 'personal', syncToken: afterCreate.syncToken });
  assert.equal(deletionSync.changes.length, 1);
  assert.equal(deletionSync.changes[0].status, 'deleted');
  assert.notEqual(afterDelete.syncToken, afterCreate.syncToken);
  await assert.rejects(
    () => store.syncCollection(bob, { addressBookId: 'personal', syncToken: afterCreate.syncToken }),
    (error: any) => error.code === 'ADDRESS_BOOK_NOT_FOUND',
  );
});

test('deleteAddressBook cascades away its contacts without a not-empty guard, matching the in-memory contract', async () => {
  const { store } = makeStore();
  if (!store.enabled) throw new Error('store unexpectedly disabled');
  await store.createAddressBook(alice, { addressBookId: 'personal', displayName: 'Personal' });
  await store.createContact(alice, { addressBookId: 'personal', href: 'alice-1.vcf', ifNoneMatch: '*', vCard: aliceCard() });
  const deleted = await store.deleteAddressBook(alice, { addressBookId: 'personal', ifMatch: '*' });
  assert.deepEqual(deleted, { addressBookId: 'personal', status: 'deleted' });
  await assert.rejects(
    () => store.getAddressBook(alice, { addressBookId: 'personal' }),
    (error: any) => error.code === 'ADDRESS_BOOK_NOT_FOUND',
  );
});

test('exportAddressBookMetadata never includes vCard content', async () => {
  const { store } = makeStore();
  if (!store.enabled) throw new Error('store unexpectedly disabled');
  await store.createAddressBook(alice, { addressBookId: 'personal', displayName: 'Personal' });
  await store.createContact(alice, { addressBookId: 'personal', href: 'alice-1.vcf', ifNoneMatch: '*', vCard: aliceCard() });
  const exported = await store.exportAddressBookMetadata(alice, { addressBookId: 'personal' });
  assert.equal(exported.exportType, 'carddav-address-book-metadata');
  assert.equal(exported.contacts.length, 1);
  assert.equal(Object.hasOwn(exported.contacts[0], 'vCard'), false);
});
