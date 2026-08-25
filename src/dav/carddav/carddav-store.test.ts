// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CardDavError,
  CardDavStore,
  createCardDAVStore,
  validateVCardObject,
} from './carddav-store.ts';

const alice = Object.freeze({ tenantId: 'acme', userId: 'alice' });
const bob = Object.freeze({ tenantId: 'acme', userId: 'bob' });
const otherTenantAlice = Object.freeze({ tenantId: 'other', userId: 'alice' });

function makeClock() {
  let now = Date.parse('2026-08-22T20:00:00.000Z');
  return {
    clock: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

function aliceCard({ fullName = 'Alice Example', email = 'alice@example.test', note = '' }: any = {}) {
  return [
    'BEGIN:VCARD',
    'VERSION:4.0',
    'UID:alice-1',
    `FN:${fullName}`,
    `EMAIL;TYPE=work:${email}`,
    note === '' ? null : `NOTE:${note}`,
    'END:VCARD',
  ].filter((line) => line !== null).join('\r\n');
}

function createAliceBook(store: CardDavStore) {
  return store.createAddressBook({
    scope: alice,
    addressBookId: 'personal',
    displayName: 'Personal contacts',
    description: 'Alice\'s private contacts',
  });
}

test('address books are persisted and listed only inside the exact tenant/user scope', () => {
  const { clock } = makeClock();
  const store = new CardDavStore({ clock });
  const created = createAliceBook(store);

  assert.equal(created.addressBookId, 'personal');
  assert.equal(created.href, '/addressbooks/personal/');
  assert.equal(store.listAddressBooks({ scope: alice }).length, 1);
  assert.equal(store.listAddressBooks({ scope: bob }).length, 0);
  assert.equal(store.listAddressBooks({ scope: otherTenantAlice }).length, 0);
  assert.throws(
    () => store.listAddressBooks({ scope: { tenantId: 'acme', userId: 'alice', role: 'master' } }),
    (error: any) => error instanceof CardDavError && error.code === 'SCOPE_ROLE_DENIED' && error.status === 403,
  );
  assert.throws(
    () => store.listAddressBooks({ scope: { tenantId: 'acme', userId: 'alice', targetUserId: 'bob' } }),
    (error: any) => error instanceof CardDavError && error.code === 'SCOPE_TARGET_DENIED' && error.status === 403,
  );
  assert.throws(
    () => store.getAddressBook({ scope: bob, addressBookId: 'personal' }),
    (error: any) => error instanceof CardDavError && error.code === 'ADDRESS_BOOK_NOT_FOUND' && error.status === 404,
  );
});

test('vCard validation normalizes CRLF/folding and exposes safe metadata', () => {
  const parsed = validateVCardObject([
    'BEGIN:VCARD',
    'VERSION:3.0',
    'UID:folded-1',
    'FN:Alice Example',
    'NOTE:This value is folded',
    ' over two lines',
    'EMAIL:alice@example.test',
    'TEL:+39000000000',
    'END:VCARD',
  ].join('\n'));

  assert.equal(parsed.canonical.endsWith('\r\n'), true);
  assert.equal(parsed.canonical.includes('NOTE:This value is foldedover two lines'), true);
  assert.equal(parsed.uid, 'folded-1');
  assert.equal(parsed.emailCount, 1);
  assert.equal(parsed.telCount, 1);
  assert.equal(parsed.mediaType, 'text/vcard; version=3.0');
  assert.throws(
    () => validateVCardObject('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Missing UID\r\nEND:VCARD'),
    (error: any) => error.code === 'VCARD_UID_INVALID',
  );
  assert.throws(
    () => validateVCardObject('BEGIN:VCARD\r\nVERSION:2.1\r\nUID:legacy\r\nFN:Legacy\r\nEND:VCARD'),
    (error: any) => error.code === 'VCARD_VERSION_INVALID',
  );
});

test('contact create/update/delete enforce conditional ETags', () => {
  const time = makeClock();
  const store = new CardDavStore({ clock: time.clock });
  createAliceBook(store);
  const created = store.createContact({
    scope: alice,
    addressBookId: 'personal',
    href: 'alice-1.vcf',
    ifNoneMatch: '*',
    vCard: aliceCard(),
  });

  assert.throws(
    () => store.createContact({ scope: alice, addressBookId: 'personal', href: 'missing.vcf', vCard: aliceCard() }),
    (error: any) => error.code === 'PRECONDITION_REQUIRED' && error.status === 428,
  );

  assert.match(created.etag, /^"[A-Za-z0-9_-]+"$/u);
  assert.equal(created.vCard.endsWith('\r\n'), true);
  assert.throws(
    () => store.createContact({ scope: alice, addressBookId: 'personal', href: 'alice-1.vcf', ifNoneMatch: '*', vCard: aliceCard() }),
    (error: any) => error.code === 'CONTACT_EXISTS' && error.status === 412,
  );
  assert.throws(
    () => store.putContact({ scope: alice, addressBookId: 'personal', href: 'alice-1.vcf', vCard: aliceCard({ fullName: 'Changed' }) }),
    (error: any) => error.code === 'PRECONDITION_REQUIRED' && error.status === 428,
  );
  assert.throws(
    () => store.putContact({ scope: alice, addressBookId: 'personal', href: 'alice-1.vcf', ifMatch: '"stale"', vCard: aliceCard({ fullName: 'Changed' }) }),
    (error: any) => error.code === 'ETAG_MISMATCH' && error.status === 412,
  );
  time.advance(1000);
  const updated = store.putContact({
    scope: alice,
    addressBookId: 'personal',
    href: 'alice-1.vcf',
    ifMatch: created.etag,
    vCard: aliceCard({ fullName: 'Changed' }),
  });
  assert.notEqual(updated.etag, created.etag);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, '2026-08-22T20:00:01.000Z');
  assert.throws(
    () => store.deleteContact({ scope: alice, addressBookId: 'personal', href: 'alice-1.vcf', ifMatch: created.etag }),
    (error: any) => error.code === 'ETAG_MISMATCH' && error.status === 412,
  );
  const deleted = store.deleteContact({ scope: alice, addressBookId: 'personal', href: 'alice-1.vcf', ifMatch: updated.etag });
  assert.deepEqual({ href: deleted.href, status: deleted.status, etag: deleted.etag }, {
    href: 'alice-1.vcf',
    status: 'deleted',
    etag: null,
  });
});

test('conditional PUT can create a missing object and keeps UID immutable', () => {
  const store = createCardDAVStore({ clock: () => Date.parse('2026-08-22T20:00:00Z') });
  createAliceBook(store);
  const created = store.putContact({
    scope: alice,
    addressBookId: 'personal',
    href: 'new.vcf',
    ifNoneMatch: '*',
    vCard: aliceCard(),
  });
  assert.equal(created.href, 'new.vcf');
  assert.throws(
    () => store.putContact({
      scope: alice,
      addressBookId: 'personal',
      href: 'new.vcf',
      ifMatch: created.etag,
      vCard: aliceCard().replace('UID:alice-1', 'UID:another'),
    }),
    (error: any) => error.code === 'VCARD_UID_IMMUTABLE',
  );
});

test('sync tokens are opaque and collection/owner scoped, including tombstones', () => {
  const time = makeClock();
  const store = new CardDavStore({ clock: time.clock });
  const book = createAliceBook(store);
  const initial = store.syncCollection({ scope: alice, addressBookId: 'personal', syncToken: book.syncToken });
  assert.deepEqual(initial.changes, []);
  const created = store.createContact({ scope: alice, addressBookId: 'personal', href: 'alice-1.vcf', ifNoneMatch: '*', vCard: aliceCard() });
  const afterCreate = store.syncCollection({ scope: alice, addressBookId: 'personal', syncToken: book.syncToken });
  assert.equal(afterCreate.changes.length, 1);
  assert.equal(afterCreate.changes[0].href, 'alice-1.vcf');
  assert.equal(Object.hasOwn(afterCreate.changes[0], 'vCard'), false);
  assert.equal(afterCreate.changes[0].etag, created.etag);
  const afterDelete = store.deleteContact({ scope: alice, addressBookId: 'personal', href: 'alice-1.vcf', ifMatch: created.etag });
  const deletionSync = store.syncCollection({ scope: alice, addressBookId: 'personal', syncToken: afterCreate.syncToken });
  assert.equal(deletionSync.changes.length, 1);
  assert.equal(deletionSync.changes[0].status, 'deleted');
  assert.equal(deletionSync.changes[0].etag, null);
  assert.notEqual(afterDelete.syncToken, afterCreate.syncToken);
  assert.throws(
    () => store.syncCollection({ scope: bob, addressBookId: 'personal', syncToken: afterCreate.syncToken }),
    (error: any) => error.code === 'ADDRESS_BOOK_NOT_FOUND',
  );
  assert.throws(
    () => store.syncCollection({ scope: alice, addressBookId: 'personal', syncToken: afterCreate.syncToken.replace(/:1$/u, ':999') }),
    (error: any) => error.code === 'SYNC_TOKEN_INVALID' && error.status === 409,
  );
});

test('metadata export never includes vCard content or identity/session data', () => {
  const store = new CardDavStore({ clock: () => Date.parse('2026-08-22T20:00:00Z') });
  createAliceBook(store);
  store.createContact({ scope: alice, addressBookId: 'personal', href: 'alice-1.vcf', ifNoneMatch: '*', vCard: aliceCard() });
  const exported = store.exportAddressBookMetadata({ scope: alice, addressBookId: 'personal' });
  assert.equal(exported.exportType, 'carddav-address-book-metadata');
  assert.equal(exported.contacts.length, 1);
  assert.equal(Object.hasOwn(exported.contacts[0], 'vCard'), false);
  assert.equal(Object.hasOwn(exported.contacts[0], 'tenantId'), false);
  assert.equal(Object.hasOwn(exported.contacts[0], 'userId'), false);
  assert.equal(Object.hasOwn(exported, 'sessionId'), false);
  assert.throws(
    () => store.exportAddressBookMetadata({ scope: bob, addressBookId: 'personal' }),
    (error: any) => error.code === 'ADDRESS_BOOK_NOT_FOUND' && error.status === 404,
  );
});

test('unsafe collection, href, and vCard inputs fail closed', () => {
  const store = new CardDavStore({ clock: () => Date.parse('2026-08-22T20:00:00Z') });
  assert.throws(
    () => store.createAddressBook({ scope: alice, addressBookId: '../private', displayName: 'Private' }),
    (error: any) => error.code === 'INVALID_ADDRESSBOOKID',
  );
  createAliceBook(store);
  assert.throws(
    () => store.createContact({ scope: alice, addressBookId: 'personal', href: '../secret.vcf', ifNoneMatch: '*', vCard: aliceCard() }),
    (error: any) => error.code === 'INVALID_HREF',
  );
  assert.throws(
    () => store.createContact({ scope: alice, addressBookId: 'personal', href: 'bad.vcf', ifNoneMatch: '*', vCard: `${aliceCard()}\0` }),
    (error: any) => error.code === 'VCARD_INVALID',
  );
});
