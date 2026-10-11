// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import { validateICalendar } from '../core/dav/caldav/caldav-contract.ts';
import { request, type IncomingHttpHeaders } from 'node:http';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createDiscoveryContract } from '../core/dav/discovery/index.ts';
import { imapClientError } from '../core/mail/imap-client.ts';
import type { ImapClient, ImapIdleSession, ImapMailboxStatus, ImapMessageSummary } from '../core/mail/imap-client.ts';
import type { DavStore } from '../platform/contract/platform-adapter.ts';
import { createLogger } from './logger.js';
import { startServer, stopServer } from './server.js';
import { createProductionRuntimeServer } from './wiring.ts';

// Exercises the entrypoint wiring (`createProductionRuntimeServer`, the same
// factory `src/runtime/index.ts` starts) over real HTTP, against fake IMAP and
// DAV backends keyed by tenant/user, so a leak between users or tenants would
// show up in a response body.

const PASSWORDS: Record<string, string> = {
  'alice@acme.example': 'alice-synthetic-password',
  'bob@acme.example': 'bob-synthetic-password',
  'eve@other.example': 'eve-synthetic-password',
};
const IDENTITIES: Record<string, { tenantId: string; domain: string; userId: string }> = {
  'alice@acme.example': { tenantId: 'acme', domain: 'acme.example', userId: 'alice' },
  'bob@acme.example': { tenantId: 'acme', domain: 'acme.example', userId: 'bob' },
  'eve@other.example': { tenantId: 'other', domain: 'other.example', userId: 'eve' },
};

function summary(uid: number, subject: string, flags: string[] = []): ImapMessageSummary {
  return { uid, sequence: uid, flags, internalDate: '2026-09-01T10:00:00.000Z', date: '2026-09-01T10:00:00.000Z', subject, from: 'sender@acme.example', to: 'rcpt@acme.example', messageId: null };
}

const MAILBOXES: Record<string, ImapMessageSummary[]> = {
  'alice@acme.example': [summary(1, 'alice-secret-subject'), summary(2, 'alice newest', ['\\Seen'])],
  'bob@acme.example': [summary(1, 'bob-secret-subject')],
  'eve@other.example': [summary(1, 'eve-secret-subject')],
};

class FakeImapClient implements ImapClient {
  static connectError: Error | null = null;
  static logins: string[] = [];
  private mailbox: ImapMessageSummary[] = [];
  async connect(): Promise<void> { if (FakeImapClient.connectError !== null) throw FakeImapClient.connectError; }
  async login(username: string, password: string): Promise<void> {
    FakeImapClient.logins.push(username);
    if (PASSWORDS[username] !== password) throw imapClientError('authentication failed', 'AUTHENTICATION_FAILED');
    this.mailbox = MAILBOXES[username] ?? [];
  }
  async select(): Promise<ImapMailboxStatus> { return { exists: this.mailbox.length, uidNext: null }; }
  async fetchSummaries(first: number, last: number): Promise<readonly ImapMessageSummary[]> {
    return this.mailbox.filter((message) => message.sequence >= first && message.sequence <= last).sort((a, b) => b.sequence - a.sequence);
  }
  async fetchMessage(): Promise<null> { return null; }
  async moveMessage(): Promise<void> {}
  async idle(): Promise<ImapIdleSession> { return { stop: async () => {} }; }
  async logout(): Promise<void> {}
  close(): void {}
}

function ical(summaryText: string) {
  return validateICalendar(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Gulo Gulo//Test//EN\r\nBEGIN:VEVENT\r\nUID:uid-1\r\nDTSTAMP:20260901T000000Z\r\nDTSTART:20260901T100000Z\r\nDTEND:20260901T110000Z\r\nSUMMARY:${summaryText}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
}

function createFakeDavStore(options: { failing?: boolean } = {}): { store: DavStore; actors: Array<Record<string, unknown>> } {
  const actors: Array<Record<string, unknown>> = [];
  const calendars: Record<string, Array<{ calendarId: string; summary: string }>> = {
    'acme/alice': [{ calendarId: 'alice/main', summary: 'alice-secret-event' }],
    'acme/bob': [{ calendarId: 'bob/main', summary: 'bob-secret-event' }],
    'other/eve': [{ calendarId: 'eve/main', summary: 'eve-secret-event' }],
  };
  const contacts: Record<string, string[]> = {
    'acme/alice': ['alice-secret-contact'],
    'acme/bob': ['bob-secret-contact'],
    'other/eve': ['eve-secret-contact'],
  };
  const key = (actor: unknown) => {
    const scope = jsonObject(actor);
    assert.equal(typeof scope.tenantId, 'string');
    assert.equal(typeof scope.userId, 'string');
    return `${String(scope.tenantId)}/${String(scope.userId)}`;
  };
  const fail = () => { if (options.failing === true) throw new Error('database unavailable'); };
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected DAV test operation'); };
  const store: DavStore = {
    caldav: {
      enabled: true,
      healthCheck: async () => ({ status: 'ok' }),
      close: async () => {},
      createCalendarCollection: unavailable,
      getCalendarCollection: unavailable,
      setCalendarAcl: unavailable,
      revokeCalendarAcl: unavailable,
      getCalendarEtag: unavailable,
      createCalendarObject: unavailable,
      getCalendarObject: unavailable,
      updateCalendarObject: unavailable,
      deleteCalendarObject: unavailable,
      deleteCalendarCollection: unavailable,
      listCalendarCollections: async (actor) => {
        actors.push(jsonObject(actor)); fail();
        return (calendars[key(actor)] ?? []).map((calendar) => ({
          calendarId: calendar.calendarId, collectionId: 'main', href: '/dav/calendars/main/',
          tenantId: String(jsonObject(actor).tenantId), ownerUserId: String(jsonObject(actor).userId),
          displayName: 'Main', description: '', timezone: 'UTC', color: null, permissions: ['read'], acl: [],
          syncToken: 'sync-token', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
        }));
      },
      listCalendarObjects: async (actor, { calendarId } = {}) => ({
        calendarId: String(calendarId), deletedObjectIds: [], syncToken: 'sync-token',
        objects: (calendars[key(actor)] ?? []).filter((calendar) => calendar.calendarId === calendarId).map((calendar) => ({
          objectId: 'event-1', href: `/dav/calendars/${String(jsonObject(actor).tenantId)}/${String(calendarId)}/event-1`, uid: 'uid-1', etag: '"etag-1"', metadata: ical(calendar.summary),
          calendarId: String(calendarId), tenantId: String(jsonObject(actor).tenantId), ownerUserId: String(jsonObject(actor).userId),
          createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', ical: ical(calendar.summary).canonicalText,
        })),
      }),
    },
    carddav: {
      enabled: true,
      healthCheck: async () => ({ status: 'ok' }),
      close: async () => {},
      createAddressBook: unavailable,
      getAddressBook: unavailable,
      deleteAddressBook: unavailable,
      createContact: unavailable,
      getContact: unavailable,
      getContactMetadata: unavailable,
      putContact: unavailable,
      updateContact: unavailable,
      upsertContact: unavailable,
      deleteContact: unavailable,
      syncCollection: unavailable,
      exportAddressBookMetadata: unavailable,
      listAddressBooks: async (scope) => {
        actors.push(jsonObject(scope)); fail();
        return (contacts[key(scope)] ?? []).length > 0 ? [{
          schemaVersion: 1, addressBookId: 'default', displayName: 'Contacts', syncToken: 'sync-token',
          href: '/dav/addressbooks/default/', description: '', color: null, etag: '"etag"', ctag: 'ctag',
          supportedAddressData: ['text/vcard'], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
        }] : [];
      },
      listContacts: async (scope) => (contacts[key(scope)] ?? []).map((name, index) => ({
        href: `c${index}.vcf`, uid: `uid-${index}`, etag: '"etag"', fullName: name, emailCount: 1, telCount: 0,
        mediaType: 'text/vcard', sizeBytes: 128, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', propertyNames: ['FN'],
      })),
    },
  };
  return { store, actors };
}

function createTestRuntime(options: { davStore?: DavStore } = {}) {
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  return createProductionRuntimeServer({
    config: { host: '127.0.0.1', port: 0, serviceName: 'gulogulo-test', environment: 'test', shutdownTimeoutMs: 1_000 },
    logger: createLogger({ output, errorOutput }),
    authenticateLogin: async ({ email, password }) => {
      const identity = IDENTITIES[email];
      return identity !== undefined && PASSWORDS[email] === password ? { ...identity, actorId: identity.userId, role: 'user' } : null;
    },
    davStore: options.davStore,
    createImapClient: () => new FakeImapClient(),
    discoveryContract: createDiscoveryContract({ tenantId: 'acme', domain: 'acme.example', origin: 'https://acme.example' }),
  });
}

type TestRuntime = ReturnType<typeof createTestRuntime>;
interface JsonResponse { statusCode: number | undefined; headers: IncomingHttpHeaders; body: Record<string, unknown>; raw: string }

function jsonObject(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object');
  return value as Record<string, unknown>;
}

function jsonArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'Expected a JSON array');
  return value;
}

function requestJson(runtime: TestRuntime, path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<JsonResponse> {
  const address = runtime.server.address() as AddressInfo;
  return new Promise<JsonResponse>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const handle = request({
      host: address.address, port: address.port, path, method,
      headers: { ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }) },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body: jsonObject(JSON.parse(raw || '{}')), raw }));
    });
    handle.on('error', reject);
    handle.end(payload);
  });
}

async function login(runtime: TestRuntime, email: string): Promise<string> {
  const response = await requestJson(runtime, '/api/session/login', { method: 'POST', body: { email, password: PASSWORDS[email], rememberMe: false } });
  assert.equal(response.statusCode, 200);
  const cookies = response.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length > 0);
  return cookies[0].split(';', 1)[0];
}

async function withRuntime(options: { davStore?: DavStore }, run: (runtime: TestRuntime) => Promise<void>): Promise<void> {
  FakeImapClient.connectError = null;
  FakeImapClient.logins = [];
  const runtime = createTestRuntime(options);
  await startServer(runtime);
  try {
    await run(runtime);
  } finally {
    await stopServer(runtime);
  }
}

test('production wiring returns the signed-in user\'s real mail, calendar and contacts, scoped to that user', async () => {
  const { store, actors } = createFakeDavStore();
  await withRuntime({ davStore: store }, async (runtime) => {
    const cookie = await login(runtime, 'alice@acme.example');

    const mail = await requestJson(runtime, '/api/mail/messages', { headers: { cookie } });
    assert.equal(mail.statusCode, 200);
    assert.deepEqual(mail.body.scope, { tenantId: 'acme', userId: 'alice' });
    assert.deepEqual(jsonArray(mail.body.messages).map((message) => jsonObject(message).subject), ['alice newest', 'alice-secret-subject']);
    assert.deepEqual(jsonArray(mail.body.messages).map((message) => jsonObject(message).unread), [false, true]);
    assert.deepEqual(FakeImapClient.logins, ['alice@acme.example']);

    const calendar = await requestJson(runtime, '/api/calendar/events', { headers: { cookie } });
    assert.equal(calendar.statusCode, 200);
    assert.equal(jsonArray(calendar.body.events).length, 1);
    assert.equal(jsonObject(jsonArray(calendar.body.events)[0]).summary, 'alice-secret-event');
    assert.equal(jsonObject(jsonArray(calendar.body.events)[0]).start, '2026-09-01T10:00:00Z');

    const contacts = await requestJson(runtime, '/api/contacts', { headers: { cookie } });
    assert.equal(contacts.statusCode, 200);
    assert.deepEqual(jsonArray(contacts.body.contacts).map((contact) => jsonObject(contact).displayName), ['alice-secret-contact']);

    const discovery = await requestJson(runtime, '/api/discovery', { headers: { cookie } });
    assert.equal(discovery.statusCode, 200);
    assert.ok(Array.isArray(discovery.body.services));

    for (const response of [mail, calendar, contacts]) {
      assert.equal(/bob-secret|eve-secret/u.test(response.raw), false);
      assert.equal(response.raw.includes(PASSWORDS['alice@acme.example']), false);
    }
    assert.ok(actors.length > 0);
    assert.ok(actors.every((actor) => actor.tenantId === 'acme' && actor.userId === 'alice' && actor.domain === 'acme.example'));
  });
});

test('another user in the same tenant and a user of another tenant only see their own data', async () => {
  const { store } = createFakeDavStore();
  await withRuntime({ davStore: store }, async (runtime) => {
    const bob = await login(runtime, 'bob@acme.example');
    const bobMail = await requestJson(runtime, '/api/mail/messages', { headers: { cookie: bob } });
    const bobCalendar = await requestJson(runtime, '/api/calendar/events', { headers: { cookie: bob } });
    const bobContacts = await requestJson(runtime, '/api/contacts', { headers: { cookie: bob } });
    assert.equal(jsonArray(bobMail.body.messages).length, 1);
    for (const response of [bobMail, bobCalendar, bobContacts]) {
      assert.equal(/alice-secret|eve-secret/u.test(response.raw), false);
      assert.deepEqual(response.body.scope, { tenantId: 'acme', userId: 'bob' });
    }
    assert.equal(jsonObject(jsonArray(bobCalendar.body.events)[0]).summary, 'bob-secret-event');

    const eve = await login(runtime, 'eve@other.example');
    const eveMail = await requestJson(runtime, '/api/mail/messages', { headers: { cookie: eve } });
    const eveContacts = await requestJson(runtime, '/api/contacts', { headers: { cookie: eve } });
    assert.equal(/alice-secret|bob-secret/u.test(eveMail.raw + eveContacts.raw), false);
    assert.deepEqual(jsonArray(eveContacts.body.contacts).map((contact) => jsonObject(contact).displayName), ['eve-secret-contact']);

    // The discovery contract belongs to tenant acme; another tenant must not receive it.
    const eveDiscovery = await requestJson(runtime, '/api/discovery', { headers: { cookie: eve } });
    assert.equal(eveDiscovery.statusCode, 503);
    assert.equal(eveDiscovery.raw.includes('acme.example'), false);
  });
});

test('backend failures are reported as 503, never as an empty list', async () => {
  const { store } = createFakeDavStore({ failing: true });
  await withRuntime({ davStore: store }, async (runtime) => {
    const cookie = await login(runtime, 'alice@acme.example');

    FakeImapClient.connectError = imapClientError('connection timed out', 'TIMEOUT');
    const mail = await requestJson(runtime, '/api/mail/messages', { headers: { cookie } });
    assert.equal(mail.statusCode, 503);
    assert.equal(jsonObject(mail.body.error).code, 'RESOURCE_UNAVAILABLE');
    assert.equal(Object.hasOwn(mail.body, 'messages'), false);

    for (const path of ['/api/calendar/events', '/api/contacts']) {
      const response = await requestJson(runtime, path, { headers: { cookie } });
      assert.equal(response.statusCode, 503, path);
      assert.equal(jsonObject(response.body.error).code, 'RESOURCE_UNAVAILABLE');
      assert.equal(response.raw.includes('database unavailable'), false);
    }
  });
});

test('an unconfigured DAV store makes calendar and contacts fail instead of returning empty lists', async () => {
  await withRuntime({}, async (runtime) => {
    const cookie = await login(runtime, 'alice@acme.example');
    for (const path of ['/api/calendar/events', '/api/contacts']) {
      const response = await requestJson(runtime, path, { headers: { cookie } });
      assert.equal(response.statusCode, 503, path);
    }
    const mail = await requestJson(runtime, '/api/mail/messages', { headers: { cookie } });
    assert.equal(mail.statusCode, 200);
  });
});

test('unauthenticated requests are still rejected before any backend is touched', async () => {
  const { store, actors } = createFakeDavStore();
  await withRuntime({ davStore: store }, async (runtime) => {
    for (const path of ['/api/mail/messages', '/api/calendar/events', '/api/contacts', '/api/discovery']) {
      assert.equal((await requestJson(runtime, path)).statusCode, 401, path);
    }
    assert.equal(actors.length, 0);
    assert.deepEqual(FakeImapClient.logins, []);
  });
});
