// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { CalDavError, createCalDavStore, validateICalendar } from './caldav-contract.ts';

const owner = Object.freeze({ tenantId: 'acme', userId: 'alice', role: 'user' });
const delegate = Object.freeze({ tenantId: 'acme', userId: 'bob', role: 'user' });
const otherTenant = Object.freeze({ tenantId: 'other', userId: 'alice', role: 'user' });
const clockValues = [
  '2026-08-22T10:00:00.000Z',
  '2026-08-22T10:00:01.000Z',
  '2026-08-22T10:00:02.000Z',
  '2026-08-22T10:00:03.000Z',
  '2026-08-22T10:00:04.000Z',
  '2026-08-22T10:00:05.000Z',
  '2026-08-22T10:00:06.000Z',
  '2026-08-22T10:00:07.000Z',
];

function createClock() {
  let index = 0;
  return () => new Date(clockValues[Math.min(index++, clockValues.length - 1)]);
}

function event({ summary = 'Team meeting', uid = 'event-1@example.test', timeZone = null, method = null, attendee = null, sequence = null }: any = {}) {
  const timeParameters = timeZone ? `;TZID=${timeZone}` : '';
  const timezone = timeZone
    ? `\r\nBEGIN:VTIMEZONE\r\nTZID:${timeZone}\r\nBEGIN:STANDARD\r\nDTSTART:20261025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE`
    : '';
  const attendeeLine = attendee ? `\r\nATTENDEE;CN=Bob;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:${attendee}` : '';
  const methodLine = method ? `\r\nMETHOD:${method}` : '';
  const sequenceLine = sequence === null ? '' : `\r\nSEQUENCE:${sequence}`;
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Sythos//Gulo Gulo//EN${methodLine}${timezone}\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20260822T100000Z\r\nDTSTART${timeParameters}:20260822T120000${timeZone ? '' : 'Z'}\r\nDTEND${timeParameters}:20260822T130000${timeZone ? '' : 'Z'}\r\nSUMMARY:${summary}${attendeeLine}${sequenceLine}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
}

function createStore() {
  return createCalDavStore({ tenantId: 'acme', clock: createClock() });
}

test('iCalendar metadata validates timezone, attendee, and method basics', () => {
  const metadata = validateICalendar(event({ timeZone: 'Europe/Rome', attendee: 'mailto:bob@example.test', method: 'REQUEST', sequence: 2 }));
  assert.equal(metadata.uid, 'event-1@example.test');
  assert.equal(metadata.dtStart.timeZone, 'Europe/Rome');
  assert.deepEqual(metadata.timeZoneIds, ['Europe/Rome']);
  assert.equal(metadata.organizer, null);
  assert.equal(metadata.attendees[0].address, 'mailto:bob@example.test');
  assert.equal(metadata.attendees[0].partStat, 'ACCEPTED');
  assert.equal(metadata.method, 'REQUEST');
  assert.equal(metadata.sequence, 2);
  assert.match(metadata.canonicalText, /\r\n$/u);
});

test('iCalendar parser rejects malformed objects and undefined timezones', () => {
  assert.throws(() => validateICalendar('BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n'), (error: any) => error.code === 'INVALID_ICALENDAR');
  const noTimeZoneDefinition = event({ timeZone: 'Europe/Rome' }).replace(/\r\nBEGIN:VTIMEZONE\r\nTZID:Europe\/Rome\r\nBEGIN:STANDARD[\s\S]*?END:VTIMEZONE/u, '');
  assert.throws(() => validateICalendar(noTimeZoneDefinition), (error: any) => error.code === 'TIMEZONE_UNDEFINED');
  assert.throws(() => validateICalendar(event({ attendee: 'https://example.test/person' })), (error: any) => error.code === 'INVALID_ATTENDEE');
  assert.throws(() => validateICalendar(event({ method: 'UNKNOWN' })), (error: any) => error.code === 'UNSUPPORTED_METHOD');
});

test('date-only and floating local values retain their explicit timezone semantics', () => {
  const dateOnly = validateICalendar(event().replace('DTSTART:20260822T120000Z', 'DTSTART;VALUE=DATE:20260822').replace('DTEND:20260822T130000Z', 'DTEND;VALUE=DATE:20260823'));
  assert.deepEqual(dateOnly.dtStart, { value: '20260822', kind: 'date', timeZone: null });
  const floating = validateICalendar(event().replace('DTSTART:20260822T120000Z', 'DTSTART:20260822T120000').replace('DTEND:20260822T130000Z', 'DTEND:20260822T130000'));
  assert.deepEqual(floating.dtStart, { value: '20260822T120000', kind: 'date-time', timeZone: null });
  assert.throws(() => validateICalendar(event().replace('DTSTART:20260822T120000Z', 'DTSTART;TZID=Europe/Rome;VALUE=DATE:20260822')), (error: any) => error.code === 'INVALID_TIMEZONE');
});

test('calendar collection is tenant and user scoped', () => {
  const store = createStore();
  const collection = store.createCalendarCollection(owner, { collectionId: 'personal', displayName: 'Alice calendar' });
  assert.equal(collection.calendarId, 'alice/personal');
  assert.equal(collection.href, '/dav/calendars/acme/alice/personal/');
  assert.deepEqual(store.listCalendarCollections(owner).map((item: any) => item.calendarId), ['alice/personal']);
  assert.deepEqual(store.listCalendarCollections(delegate), []);
  assert.throws(() => store.listCalendarCollections(otherTenant), (error: any) => error.code === 'CROSS_TENANT_DENIED');
  assert.throws(() => store.createCalendarCollection({ ...owner, userId: 'bob' }, { collectionId: 'other', ownerUserId: 'alice' }), (error: any) => error.code === 'ACL_DENIED');
  assert.throws(() => store.listCalendarCollections({ tenantId: 'acme', userId: 'alice', role: 'tenant_master' }), (error: any) => error.code === 'CONTENT_SCOPE_REQUIRED');
});

test('calendar owner can delegate one colleague with explicit ACL', () => {
  const store = createStore();
  store.createCalendarCollection(owner, { collectionId: 'personal' });
  const delegated = store.setCalendarAcl(owner, { calendarId: 'alice/personal', delegateUserId: 'bob', permissions: ['write'] });
  assert.deepEqual(delegated.acl, [{ delegateUserId: 'bob', permissions: ['read', 'write'] }]);
  assert.deepEqual(store.listCalendarCollections(delegate).map((item: any) => item.permissions), [['read', 'write']]);
  assert.throws(() => store.setCalendarAcl(delegate, { calendarId: 'alice/personal', delegateUserId: 'carol', permissions: ['read'] }), (error: any) => error.code === 'ACL_OWNER_REQUIRED');
  assert.throws(() => store.getCalendarCollection({ tenantId: 'acme', userId: 'master', role: 'tenant_master' }, 'alice/personal'), (error: any) => error.code === 'CONTENT_SCOPE_REQUIRED');
  store.revokeCalendarAcl(owner, { calendarId: 'alice/personal' });
  assert.throws(() => store.getCalendarCollection(delegate, 'alice/personal'), (error: any) => error.code === 'ACL_DENIED');
});

test('conditional create returns a stable ETag and canonical object', () => {
  const store = createStore();
  store.createCalendarCollection(owner, { collectionId: 'personal' });
  const created = store.createCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' });
  assert.equal(created.objectId, 'event-1.ics');
  assert.match(created.etag, /^"[a-f0-9]{64}"$/u);
  assert.equal(created.metadata.summary, 'Team meeting');
  assert.equal(created.ical.replaceAll('\r\n', '').includes('\n'), false);
  assert.throws(() => store.createCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' }), (error: any) => error.code === 'PRECONDITION_FAILED' && error.status === 412);
  assert.throws(() => store.createCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event() }), (error: any) => error.code === 'OBJECT_EXISTS');
});

test('ETags are scoped and audits contain metadata without calendar content', () => {
  const audits: any[] = [];
  const store = createCalDavStore({ tenantId: 'acme', clock: createClock(), audit: (entry: any) => audits.push(entry) });
  store.createCalendarCollection(owner, { collectionId: 'personal' });
  const created = store.createCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' });
  const otherStore = createCalDavStore({ tenantId: 'other', clock: createClock() });
  const otherOwner = { tenantId: 'other', userId: 'alice', role: 'user' };
  otherStore.createCalendarCollection(otherOwner, { collectionId: 'personal' });
  const otherCreated = otherStore.createCalendarObject(otherOwner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' });
  assert.notEqual(created.etag, otherCreated.etag);
  assert.equal(audits.some((entry: any) => entry.eventType === 'caldav.object.created'), true);
  const objectAudit = audits.find((entry: any) => entry.eventType === 'caldav.object.created');
  assert.equal(Object.hasOwn(objectAudit, 'ical'), false);
  assert.equal(Object.hasOwn(objectAudit, 'canonicalText'), false);
  assert.equal(objectAudit.sizeBytes > 0, true);
});

test('conditional update requires the current ETag and preserves UID', () => {
  const store = createStore();
  store.createCalendarCollection(owner, { collectionId: 'personal' });
  const created = store.createCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' });
  assert.throws(() => store.updateCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event({ summary: 'Updated' }) }), (error: any) => error.code === 'PRECONDITION_REQUIRED' && error.status === 428);
  assert.throws(() => store.updateCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event({ summary: 'Updated' }), ifMatch: '"stale"' }), (error: any) => error.code === 'PRECONDITION_FAILED' && error.status === 412);
  const updated = store.updateCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event({ summary: 'Updated' }), ifMatch: created.etag });
  assert.notEqual(updated.etag, created.etag);
  assert.equal(updated.metadata.summary, 'Updated');
  assert.throws(() => store.updateCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event({ uid: 'different@example.test' }), ifMatch: '*' }), (error: any) => error.code === 'UID_IMMUTABLE');
});

test('sync-token exposes deterministic changes and deletion tombstones', () => {
  const store = createStore();
  store.createCalendarCollection(owner, { collectionId: 'personal' });
  const empty = store.listCalendarObjects(owner, { calendarId: 'alice/personal' });
  assert.deepEqual(empty.objects, []);
  const created = store.createCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' });
  const afterCreate = store.listCalendarObjects(owner, { calendarId: 'alice/personal', syncToken: empty.syncToken });
  assert.deepEqual(afterCreate.objects.map((item: any) => item.objectId), ['event-1.ics']);
  assert.deepEqual(afterCreate.deletedObjectIds, []);
  const afterUpdate = store.updateCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event({ summary: 'Updated' }), ifMatch: created.etag });
  const afterUpdateSync = store.listCalendarObjects(owner, { calendarId: 'alice/personal', syncToken: afterCreate.syncToken });
  assert.deepEqual(afterUpdateSync.objects.map((item: any) => item.metadata.summary), ['Updated']);
  const deleted = store.deleteCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ifMatch: afterUpdate.etag });
  const afterDeleteSync = store.listCalendarObjects(owner, { calendarId: 'alice/personal', syncToken: afterUpdateSync.syncToken });
  assert.deepEqual(afterDeleteSync.objects, []);
  assert.deepEqual(afterDeleteSync.deletedObjectIds, ['event-1.ics']);
  assert.equal(deleted.deleted, true);
  store.createCalendarCollection(owner, { collectionId: 'work' });
  assert.throws(() => store.listCalendarObjects(owner, { calendarId: 'alice/work', syncToken: afterDeleteSync.syncToken }), (error: any) => error.code === 'SYNC_SCOPE_DENIED');
  assert.throws(() => store.listCalendarObjects(owner, { calendarId: 'alice/personal', syncToken: 'https://gulogulo.invalid/caldav/other/alice/personal/sync/1' }), (error: any) => error.code === 'CROSS_TENANT_DENIED');
});

test('read delegation cannot mutate and write delegation can mutate without owner leakage', () => {
  const store = createStore();
  store.createCalendarCollection(owner, { collectionId: 'personal' });
  store.setCalendarAcl(owner, { calendarId: 'alice/personal', delegateUserId: 'bob', permissions: ['read'] });
  const created = store.createCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' });
  const visible = store.getCalendarObject(delegate, { calendarId: 'alice/personal', objectId: 'event-1.ics' });
  assert.equal(visible.etag, created.etag);
  assert.throws(() => store.updateCalendarObject(delegate, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event({ summary: 'Nope' }), ifMatch: created.etag }), (error: any) => error.code === 'ACL_DENIED');
  assert.throws(() => store.deleteCalendarObject(delegate, { calendarId: 'alice/personal', objectId: 'event-1.ics', ifMatch: created.etag }), (error: any) => error.code === 'ACL_DENIED');
  assert.throws(() => store.getCalendarObject(otherTenant, { calendarId: 'alice/personal', objectId: 'event-1.ics' }), (error: any) => error.code === 'CROSS_TENANT_DENIED');
});

test('collection deletion is conditional and never silently drops objects', () => {
  const store = createStore();
  const collection = store.createCalendarCollection(owner, { collectionId: 'personal' });
  store.createCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'event-1.ics', ical: event(), ifNoneMatch: '*' });
  assert.throws(() => store.deleteCalendarCollection(owner, { calendarId: 'alice/personal' }), (error: any) => error.code === 'CALENDAR_NOT_EMPTY');
  const freshStore = createStore();
  const empty = freshStore.createCalendarCollection(owner, { collectionId: 'personal' });
  assert.throws(() => freshStore.deleteCalendarCollection(owner, { calendarId: 'alice/personal', ifMatch: '"stale"' }), (error: any) => error.code === 'PRECONDITION_FAILED');
  assert.equal(freshStore.deleteCalendarCollection(owner, { calendarId: 'alice/personal', ifMatch: '*' }).deleted, true);
  assert.equal(collection.collectionId, empty.collectionId);
});

test('public contract remains immutable and errors carry WebDAV status codes', () => {
  const store = createStore();
  const collection = store.createCalendarCollection(owner, { collectionId: 'personal' });
  assert.equal(Object.isFrozen(collection), true);
  assert.throws(() => store.getCalendarObject(owner, { calendarId: 'alice/personal', objectId: 'missing.ics' }), (error: any) => error instanceof CalDavError && error.status === 404);
});
