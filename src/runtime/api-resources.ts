// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// The production implementations behind `/api/mail/messages`,
// `/api/calendar/events`, `/api/contacts` and `/api/discovery`. Every
// resource is derived only from the authenticated session's tenant/user scope:
// mail is read over IMAP with the session's own mailbox login, CalDAV/CardDAV
// objects come from the tenant-scoped PostgreSQL stores, discovery from the
// tenant-bound contract. Nothing here catches a backend failure — a missing or
// failing backend must reach `server.ts` as an error (503), never as an empty
// list.

import type { ImapClient } from '../core/mail/imap-client.ts';
import { buildDiscoveryDocument } from '../core/dav/discovery/index.ts';
import type { DavStore, MailClientFactories } from '../platform/contract/platform-adapter.ts';

interface ApiScope { tenantId: string; userId: string; role: string }
interface ApiContext {
  readonly domain: string | undefined;
  readonly mailCredentials: { readonly mailAddress: string; readonly password: string } | null;
}
type ApiResource = (scope: ApiScope, context: ApiContext) => Promise<Record<string, unknown>>;
export interface ProductionApiResources {
  readonly mail: ApiResource;
  readonly calendar: ApiResource;
  readonly contacts: ApiResource;
  readonly discovery: ApiResource;
}

export interface ProductionApiResourceOptions {
  /** Persistent CalDAV/CardDAV stores; undefined makes calendar and contacts fail. */
  readonly davStore?: DavStore;
  /** IMAP client factory bound to the local mail server; undefined makes mail fail. */
  readonly createImapClient?: MailClientFactories['createImapClient'];
  /** Tenant-bound discovery contract; undefined makes discovery fail. */
  readonly discoveryContract?: unknown;
  /** Newest messages returned per request. */
  readonly mailPageSize?: number;
}

const DEFAULT_MAIL_PAGE_SIZE = 50;
const MAIL_FOLDER = 'INBOX';

type DavRecord = Record<string, any>;

function resourceError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function icalDate(value: DavRecord | null | undefined): { value: string | null; timeZone: string | null; allDay: boolean } {
  const raw = typeof value?.value === 'string' ? value.value : null;
  if (raw === null) return { value: null, timeZone: null, allDay: false };
  const date = /^(\d{4})(\d{2})(\d{2})$/u.exec(raw);
  if (date !== null) return { value: `${date[1]}-${date[2]}-${date[3]}`, timeZone: null, allDay: true };
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/u.exec(raw);
  if (dateTime === null) return { value: raw, timeZone: null, allDay: false };
  const iso = `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}T${dateTime[4]}:${dateTime[5]}:${dateTime[6]}${dateTime[7]}`;
  return { value: iso, timeZone: typeof value?.timeZone === 'string' ? value.timeZone : null, allDay: false };
}

export function createProductionApiResources({
  davStore,
  createImapClient,
  discoveryContract,
  mailPageSize = DEFAULT_MAIL_PAGE_SIZE,
}: ProductionApiResourceOptions = {}): ProductionApiResources {
  const dav = (name: string): DavStore => {
    if (davStore === undefined) throw resourceError(`${name} storage is not configured`, 'DAV_STORE_UNAVAILABLE');
    return davStore;
  };
  const actorFor = (scope: ApiScope, context: ApiContext) => {
    if (context.domain === undefined) throw resourceError('session has no tenant domain', 'SCOPE_INCOMPLETE');
    return { tenantId: scope.tenantId, domain: context.domain, userId: scope.userId, role: scope.role };
  };

  const resources: ProductionApiResources = {
    async mail(_scope, context) {
      if (createImapClient === undefined) throw resourceError('mail backend is not configured', 'MAIL_BACKEND_UNAVAILABLE');
      const credentials = context.mailCredentials;
      if (credentials === null) throw resourceError('session has no mailbox credentials', 'MAIL_CREDENTIALS_UNAVAILABLE');
      // The mailbox is whatever the session logged in as; refuse one that is not in the session's tenant domain.
      const addressDomain = credentials.mailAddress.slice(credentials.mailAddress.lastIndexOf('@') + 1).toLowerCase();
      if (context.domain === undefined || addressDomain !== context.domain.toLowerCase()) {
        throw resourceError('mailbox is outside the session tenant domain', 'MAIL_SCOPE_MISMATCH');
      }
      const client: ImapClient = createImapClient();
      let connected = false;
      try {
        await client.connect();
        connected = true;
        await client.login(credentials.mailAddress, credentials.password);
        const status = await client.select(MAIL_FOLDER);
        const summaries = status.exists === 0
          ? []
          : await client.fetchSummaries(Math.max(1, status.exists - mailPageSize + 1), status.exists);
        return {
          folder: MAIL_FOLDER,
          total: status.exists,
          messages: summaries.map((summary) => ({
            id: String(summary.uid),
            uid: summary.uid,
            folder: MAIL_FOLDER,
            from: summary.from,
            to: summary.to,
            subject: summary.subject,
            date: summary.date ?? summary.internalDate,
            unread: !summary.flags.some((flag) => flag.toLowerCase() === '\\seen'),
            preview: '',
          })),
        };
      } finally {
        if (connected) {
          try { await client.logout(); } catch { client.close(); }
        } else {
          client.close();
        }
      }
    },

    async calendar(scope, context) {
      const store = dav('CalDAV').caldav;
      if (!store.enabled) throw resourceError('CalDAV storage is not configured', 'DAV_STORE_UNAVAILABLE');
      const actor = actorFor(scope, context);
      const calendars = await store.listCalendarCollections(actor);
      const events: Record<string, unknown>[] = [];
      for (const calendar of calendars) {
        const listing = await store.listCalendarObjects(actor, { calendarId: calendar.calendarId });
        for (const object of listing.objects as readonly DavRecord[]) {
          const start = icalDate(object.metadata?.dtStart);
          const end = icalDate(object.metadata?.dtEnd);
          events.push({
            id: `${calendar.calendarId}/${object.objectId}`,
            calendarId: calendar.calendarId,
            objectId: object.objectId,
            href: object.href,
            uid: object.uid,
            etag: object.etag,
            summary: object.metadata?.summary ?? '',
            description: object.metadata?.description ?? '',
            start: start.value,
            end: end.value,
            timeZone: start.timeZone,
            allDay: start.allDay,
          });
        }
      }
      return {
        calendars: calendars.map((calendar) => ({ calendarId: calendar.calendarId, displayName: calendar.displayName, syncToken: calendar.syncToken })),
        events,
      };
    },

    async contacts(scope, context) {
      const store = dav('CardDAV').carddav;
      if (!store.enabled) throw resourceError('CardDAV storage is not configured', 'DAV_STORE_UNAVAILABLE');
      const actor = actorFor(scope, context);
      const addressBooks = await store.listAddressBooks(actor);
      const contacts: Record<string, unknown>[] = [];
      for (const addressBook of addressBooks) {
        const listing = await store.listContacts(actor, { addressBookId: addressBook.addressBookId });
        for (const contact of listing) {
          contacts.push({
            id: `${addressBook.addressBookId}/${contact.href}`,
            addressBookId: addressBook.addressBookId,
            href: contact.href,
            uid: contact.uid,
            etag: contact.etag,
            displayName: contact.fullName,
            emailCount: contact.emailCount,
            telCount: contact.telCount,
          });
        }
      }
      return {
        addressBooks: addressBooks.map((addressBook) => ({ addressBookId: addressBook.addressBookId, displayName: addressBook.displayName, syncToken: addressBook.syncToken })),
        contacts,
      };
    },

    async discovery(scope) {
      if (discoveryContract === undefined) throw resourceError('discovery contract is not configured', 'DISCOVERY_UNAVAILABLE');
      // Throws when the contract belongs to another tenant, so no cross-tenant document is ever returned.
      const document = buildDiscoveryDocument(discoveryContract, { tenantId: scope.tenantId });
      return {
        domain: document.domain,
        services: Object.entries(document.services as DavRecord).map(([name, endpoint]) => ({ name, ...endpoint })),
      };
    },
  };
  return Object.freeze(resources);
}
