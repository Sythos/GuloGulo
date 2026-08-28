// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createRuntimeServer, startServer, stopServer } from '../dist/server/src/runtime/server.js';
import { createCalDavStore } from '../src/dav/caldav/caldav-contract.ts';
import { createCardDavStore } from '../src/dav/carddav/carddav-store.ts';
import { buildDiscoveryDocument, createDiscoveryContract } from '../src/dav/discovery/index.ts';

type RuntimeValue = any;
type RuntimeRecord = Record<string, RuntimeValue>;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`LP4 local runtime requires ${name}.`);
  }
  return value;
}

function equalSecret(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

const loginEmail = requiredEnvironment('LP4_LOGIN_EMAIL').trim().toLowerCase();
const loginPassword = requiredEnvironment('LP4_LOGIN_PASSWORD');
const tenantId = process.env.LP4_TENANT_ID || 'acme';
const domain = process.env.LP4_TENANT_DOMAIN || 'example.test';
const userId = process.env.LP4_USER_ID || 'alice';
const davStateDirectory = process.env.LP4_DAV_STATE_DIR || '/var/lib/gulogulo/dav';
const actor = Object.freeze({ tenantId, userId, role: 'user' });
const fixedClock = () => new Date('2026-08-25T12:00:00.000Z');

const calendarStore = createCalDavStore({ tenantId, clock: fixedClock });
calendarStore.createCalendarCollection(actor, {
  collectionId: 'personal',
  displayName: 'Personal calendar',
  timezone: 'Europe/Rome',
  color: '#2C5F4C',
});
const calendarObject = calendarStore.createCalendarObject(actor, {
  calendarId: 'personal',
  objectId: 'lp4-proof-event',
  ifNoneMatch: '*',
  ical: [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gulo Gulo//LP4 local proof//EN',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Rome',
    'BEGIN:STANDARD',
    'DTSTART:20261025T030000',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:lp4-proof-event@example.test',
    'DTSTART;TZID=Europe/Rome:20260825T140000',
    'DTEND;TZID=Europe/Rome:20260825T143000',
    'SUMMARY:LP4 local calendar proof',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n'),
});
const calendarSnapshot = calendarStore.listCalendarObjects(actor, { calendarId: 'personal' });

const cardStore = createCardDavStore({ clock: () => fixedClock().getTime() });
cardStore.createAddressBook({ scope: actor, addressBookId: 'personal', displayName: 'Personal contacts' });
const contact = cardStore.createContact({
  scope: actor,
  addressBookId: 'personal',
  href: 'lp4-proof-contact.vcf',
  ifNoneMatch: '*',
  vCard: [
    'BEGIN:VCARD',
    'VERSION:4.0',
    'UID:lp4-proof-contact',
    'FN:LP4 Synthetic Contact',
    'EMAIL:contact@example.test',
    'END:VCARD',
    '',
  ].join('\r\n'),
});
const contactSnapshot = cardStore.syncCollection({ scope: actor, addressBookId: 'personal' });

const discoveryContract = createDiscoveryContract({
  tenantId,
  domain,
  origin: `https://${domain}`,
});

const continuity = Object.freeze({
  schemaVersion: 1,
  milestone: 'LP4',
  tenantId,
  userId,
  calendarEtag: calendarObject.etag,
  calendarSyncToken: calendarSnapshot.syncToken,
  contactEtag: contact.etag,
  contactSyncToken: contactSnapshot.syncToken,
});

async function ensureContinuityState(): Promise<void> {
  await mkdir(davStateDirectory, { recursive: true });
  const statePath = join(davStateDirectory, 'lp4-continuity.json');
  try {
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as RuntimeRecord;
    if (JSON.stringify(stored) !== JSON.stringify(continuity)) {
      throw new Error('LP4 DAV continuity metadata changed across restart.');
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Blue and green containers have separate PID namespaces, so process.pid is
  // not unique when both runtimes initialize the shared volume concurrently.
  // A UUID keeps each atomic-write staging file independent.
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(continuity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, statePath);
}

await ensureContinuityState();

const createLocalRuntime = createRuntimeServer as any;
const runtime = createLocalRuntime({
  discoveryContract,
  discoveryTenantId: tenantId,
  authenticateLogin: async ({ email, password }: RuntimeRecord) => (
    typeof email === 'string'
    && typeof password === 'string'
    && equalSecret(email.trim().toLowerCase(), loginEmail)
    && equalSecret(password, loginPassword)
      ? { email: loginEmail, tenantId, domain, userId, actorId: userId, role: 'user' }
      : null
  ),
  apiResources: {
    mail: async () => ({ messages: [{ id: 'lp4-synthetic-message', subject: 'LP4 local web proof', unread: true }] }),
    calendar: async (scope: RuntimeRecord) => {
      if (scope.tenantId !== tenantId || scope.userId !== userId) throw new Error('Calendar scope mismatch.');
      return {
        events: calendarSnapshot.objects.map((entry: RuntimeRecord) => ({
          id: entry.objectId,
          uid: entry.uid,
          summary: entry.metadata.summary,
          start: entry.metadata.dtStart,
          end: entry.metadata.dtEnd,
          etag: entry.etag,
        })),
        syncToken: calendarSnapshot.syncToken,
      };
    },
    contacts: async (scope: RuntimeRecord) => {
      if (scope.tenantId !== tenantId || scope.userId !== userId) throw new Error('Contact scope mismatch.');
      return {
        contacts: cardStore.listContacts({ scope: actor, addressBookId: 'personal' }).map((entry: RuntimeRecord) => ({
          id: entry.href,
          uid: entry.uid,
          fullName: entry.fullName,
          etag: entry.etag,
        })),
        syncToken: contactSnapshot.syncToken,
      };
    },
    discovery: async (scope: RuntimeRecord) => {
      if (scope.tenantId !== tenantId || scope.userId !== userId) throw new Error('Discovery scope mismatch.');
      return buildDiscoveryDocument(discoveryContract, { tenantId });
    },
  },
});

await startServer(runtime);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  await stopServer(runtime, { signal });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
