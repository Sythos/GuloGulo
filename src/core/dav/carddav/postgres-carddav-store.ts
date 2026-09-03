// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createPostgresStore } from '../../../integrations/postgres-store.ts';
import { assertTenantContext } from '../../../integrations/tenant-context.ts';
import type {
  IntegrationLogger,
  PostgresClientLike,
  PostgresPoolConstructor,
  PostgresStore,
  PostgresStoreEnabled,
  SecretResolver,
} from '../../../integrations/types.ts';
import {
  CARD_DAV_SCHEMA_VERSION,
  CardDavError,
  assertIfMatch,
  makeCollectionEtag,
  makeEtag,
  makeSyncToken,
  normalizeAddressBookId,
  normalizeHref,
  normalizeScope,
  parseSyncToken,
  validateVCardObject,
} from './carddav-store.ts';

type DavValue = any;
type DavRecord = Record<string, DavValue>;

const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/u;
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 2 * 1024;
const MAX_COLOR_LENGTH = 32;

interface PostgresCardDavStoreOptions {
  readonly config?: unknown;
  readonly resolveSecret?: SecretResolver;
  readonly logger?: IntegrationLogger;
  /** Injectable for tests: overrides the `pg` Pool constructor used by the underlying PostgreSQL store. */
  readonly PoolClass?: PostgresPoolConstructor;
  /** Injectable for tests: overrides how the underlying PostgreSQL store is built. */
  readonly createStore?: (options: DavRecord) => PostgresStore;
}

interface DisabledPostgresCardDavStore {
  readonly enabled: false;
  readonly healthCheck: () => Promise<{ status: 'disabled' }>;
  readonly close: () => Promise<void>;
}

interface EnabledPostgresCardDavStore {
  readonly enabled: true;
  readonly healthCheck: () => Promise<{ status: 'ok' }>;
  readonly close: () => Promise<void>;
  readonly createAddressBook: (scope: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly getAddressBook: (scope: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly listAddressBooks: (scope: DavValue, options?: DavRecord) => Promise<readonly Readonly<DavRecord>[]>;
  readonly deleteAddressBook: (scope: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly createContact: (scope: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly getContact: (scope: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly getContactMetadata: (scope: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly listContacts: (scope: DavValue, options?: DavRecord) => Promise<readonly Readonly<DavRecord>[]>;
  readonly putContact: (scope: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly updateContact: (scope: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly upsertContact: (scope: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly deleteContact: (scope: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly syncCollection: (scope: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly exportAddressBookMetadata: (scope: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
}

export type PostgresCardDavStore = DisabledPostgresCardDavStore | EnabledPostgresCardDavStore;

function toIso(value: DavValue): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertBoundedText(value: DavValue, field: string, { maxLength = 1024, allowEmpty = false, pattern }: DavRecord = {}): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maxLength) {
    throw new CardDavError(`${field} is invalid`, `INVALID_${field.toUpperCase()}`);
  }
  if (/\p{Cc}/u.test(value)) throw new CardDavError(`${field} contains control characters`, `INVALID_${field.toUpperCase()}`);
  if (pattern !== undefined && !pattern.test(value)) throw new CardDavError(`${field} is invalid`, `INVALID_${field.toUpperCase()}`);
  return value;
}

function readVCardInput(options: DavRecord): DavValue {
  const value = options.vCard ?? options.vcard ?? options.vcardText;
  if (value === undefined) throw new CardDavError('vCard content is required', 'VCARD_REQUIRED', 400);
  return value;
}

function contactMetadataRow(row: DavRecord): Readonly<DavRecord> {
  const parsed = validateVCardObject(row.vcard_data);
  return Object.freeze({
    href: row.href,
    uid: row.uid,
    fullName: row.full_name,
    etag: row.etag,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    propertyNames: parsed.propertyNames,
    emailCount: parsed.emailCount,
    telCount: parsed.telCount,
  });
}

function publicContactRow(row: DavRecord): Readonly<DavRecord> {
  return Object.freeze({ ...contactMetadataRow(row), vCard: row.vcard_data });
}

function publicAddressBookRow(row: DavRecord): Readonly<DavRecord> {
  const revision = Number(row.revision);
  const token = makeSyncToken({ tenantId: row.tenant_id, userId: row.user_id }, row.address_book_id, revision);
  return Object.freeze({
    schemaVersion: CARD_DAV_SCHEMA_VERSION,
    addressBookId: row.address_book_id,
    href: row.href,
    displayName: row.display_name,
    description: row.description,
    color: row.color,
    etag: makeCollectionEtag({ addressBookId: row.address_book_id, displayName: row.display_name, description: row.description, color: row.color, revision }),
    ctag: token,
    syncToken: token,
    supportedAddressData: Object.freeze(['text/vcard; version=3.0', 'text/vcard; version=4.0']),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

function publicChangeRow(change: DavRecord): Readonly<DavRecord> {
  return Object.freeze({
    version: change.version,
    operation: change.operation,
    href: change.href,
    uid: change.uid,
    etag: change.etag,
    status: change.operation === 'deleted' ? 'deleted' : 'present',
  });
}

/**
 * PostgreSQL-backed CardDAV storage adapter.
 *
 * `src/core/dav/carddav/carddav-store.ts` stays the pure, synchronous,
 * in-memory `CardDavStore` its own tests exercise — every public method
 * there returns a plain value, never a `Promise`. This adapter is a
 * separate, async, tenant/user-scoped implementation of the same
 * operations, backed by the tables in
 * `src/core/db/migrations/0003_dav_storage.sql` instead of nested `Map`s.
 *
 * To keep the two implementations from silently drifting on anything a real
 * CardDAV client observes on the wire, this module imports the contract's
 * own exported ETag (`makeEtag`/`makeCollectionEtag`), sync-token
 * (`makeSyncToken`/`parseSyncToken`), and scope/href validation
 * (`normalizeScope`/`normalizeAddressBookId`/`normalizeHref`/`assertIfMatch`)
 * functions rather than reimplementing them.
 *
 * Reuses `createPostgresStore()` (`src/integrations/postgres-store.ts`) for
 * the connection pool, retry, SSL, and RLS transaction plumbing, the same
 * way `src/platform/standalone/db-identity-client.ts` does.
 *
 * `deleteAddressBook()` deliberately does not refuse a non-empty address
 * book: the in-memory contract does not either (unlike CalDAV's
 * `CALENDAR_NOT_EMPTY` guard), it simply drops the whole collection — here
 * that is the `ON DELETE CASCADE` from `dav_contacts`/`dav_contact_changes`
 * to `dav_address_books`.
 */
export function createPostgresCardDavStore({
  config,
  resolveSecret,
  logger = console,
  PoolClass,
  createStore = createPostgresStore,
}: PostgresCardDavStoreOptions = {}): PostgresCardDavStore {
  const store = createStore({
    config,
    resolveSecret,
    logger,
    ...(PoolClass === undefined ? {} : { PoolClass }),
  });

  if (!store.enabled) {
    return Object.freeze({
      enabled: false as const,
      healthCheck: async () => ({ status: 'disabled' as const }),
      close: async () => {},
    });
  }
  const enabledStore: PostgresStoreEnabled = store;

  function normalizeCardDavScope(scopeInput: DavValue): DavRecord {
    const normalized = normalizeScope(scopeInput);
    const domain = typeof scopeInput?.domain === 'string' ? scopeInput.domain : undefined;
    return { ...normalized, domain };
  }

  function buildTenantContext(scope: DavRecord): DavValue {
    try {
      return assertTenantContext({ tenantId: scope.tenantId, domain: scope.domain, actorId: scope.userId, role: 'user' });
    } catch {
      throw new CardDavError('a valid domain is required for the PostgreSQL-backed CardDAV store', 'INVALID_DOMAIN', 422);
    }
  }

  async function getAddressBookRow(client: PostgresClientLike, scope: DavRecord, addressBookId: string, { forUpdate = false }: DavRecord = {}): Promise<DavRecord> {
    const result = await client.query<DavRecord>(
      `SELECT * FROM dav_address_books WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3${forUpdate ? ' FOR UPDATE' : ''}`,
      [scope.tenantId, scope.userId, addressBookId],
    );
    const row = result.rows[0];
    if (!row) throw new CardDavError('address book was not found in this tenant/user scope', 'ADDRESS_BOOK_NOT_FOUND', 404);
    return row;
  }

  async function bumpAddressBookRevision(client: PostgresClientLike, tenantId: string, userId: string, addressBookId: string, { href, uid = null, etag = null, operation }: DavRecord): Promise<number> {
    const updated = await client.query<DavRecord>(
      'UPDATE dav_address_books SET revision = revision + 1, updated_at = now() WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 RETURNING revision',
      [tenantId, userId, addressBookId],
    );
    const revision = Number(updated.rows[0].revision);
    await client.query(
      'INSERT INTO dav_contact_changes (tenant_id, user_id, address_book_id, revision, href, uid, etag, operation) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [tenantId, userId, addressBookId, revision, href, uid, etag, operation],
    );
    return revision;
  }

  async function insertContactRow(client: PostgresClientLike, scope: DavRecord, addressBookId: string, href: string, parsed: DavRecord): Promise<Readonly<DavRecord>> {
    const uidClash = await client.query(
      'SELECT 1 FROM dav_contacts WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 AND uid = $4',
      [scope.tenantId, scope.userId, addressBookId, parsed.uid],
    );
    if ((uidClash.rowCount ?? 0) > 0) throw new CardDavError('vCard UID already exists in this address book', 'VCARD_UID_EXISTS', 409);
    const etag = makeEtag(parsed.canonical);
    const revision = await bumpAddressBookRevision(client, scope.tenantId, scope.userId, addressBookId, { href, uid: parsed.uid, etag, operation: 'created' });
    const inserted = await client.query<DavRecord>(
      `INSERT INTO dav_contacts (tenant_id, user_id, address_book_id, href, uid, full_name, vcard_data, etag, media_type, size_bytes, revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [scope.tenantId, scope.userId, addressBookId, href, parsed.uid, parsed.fullName, parsed.canonical, etag, parsed.mediaType, Buffer.byteLength(parsed.canonical, 'utf8'), revision],
    );
    return publicContactRow(inserted.rows[0]);
  }

  async function createAddressBook(scopeInput: DavValue, { addressBookId, displayName, description = '', color = null }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const scope = normalizeCardDavScope(scopeInput);
    const abId = normalizeAddressBookId(addressBookId);
    const normalizedDisplayName = assertBoundedText(displayName, 'displayName', { maxLength: MAX_DISPLAY_NAME_LENGTH });
    const normalizedDescription = description === undefined || description === null ? '' : assertBoundedText(description, 'description', { maxLength: MAX_DESCRIPTION_LENGTH, allowEmpty: true });
    const normalizedColor = color === null || color === undefined ? null : assertBoundedText(color, 'color', { maxLength: MAX_COLOR_LENGTH, pattern: COLOR_PATTERN });
    const href = `/addressbooks/${abId}/`;
    const context = buildTenantContext(scope);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const existing = await client.query('SELECT 1 FROM dav_address_books WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3', [scope.tenantId, scope.userId, abId]);
      if ((existing.rowCount ?? 0) > 0) throw new CardDavError('address book already exists', 'ADDRESS_BOOK_EXISTS', 409);
      const inserted = await client.query<DavRecord>(
        'INSERT INTO dav_address_books (tenant_id, user_id, address_book_id, href, display_name, description, color) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [scope.tenantId, scope.userId, abId, href, normalizedDisplayName, normalizedDescription, normalizedColor],
      );
      return publicAddressBookRow(inserted.rows[0]);
    });
  }

  async function getAddressBook(scopeInput: DavValue, { addressBookId }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const scope = normalizeCardDavScope(scopeInput);
    const abId = normalizeAddressBookId(addressBookId);
    const context = buildTenantContext(scope);
    return enabledStore.withTenantTransaction(context, async (client) => publicAddressBookRow(await getAddressBookRow(client, scope, abId)));
  }

  async function listAddressBooks(scopeInput: DavValue): Promise<readonly Readonly<DavRecord>[]> {
    const scope = normalizeCardDavScope(scopeInput);
    const context = buildTenantContext(scope);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const result = await client.query<DavRecord>('SELECT * FROM dav_address_books WHERE tenant_id = $1 AND user_id = $2 ORDER BY address_book_id', [scope.tenantId, scope.userId]);
      return Object.freeze(result.rows.map((row) => publicAddressBookRow(row)));
    });
  }

  async function deleteAddressBook(scopeInput: DavValue, { addressBookId, ifMatch }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const scope = normalizeCardDavScope(scopeInput);
    const abId = normalizeAddressBookId(addressBookId);
    const context = buildTenantContext(scope);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const row = await getAddressBookRow(client, scope, abId, { forUpdate: true });
      const currentEtag = makeCollectionEtag({ addressBookId: row.address_book_id, displayName: row.display_name, description: row.description, color: row.color, revision: Number(row.revision) });
      assertIfMatch(ifMatch, currentEtag, 'address book');
      await client.query('DELETE FROM dav_address_books WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3', [scope.tenantId, scope.userId, abId]);
      return Object.freeze({ addressBookId: abId, status: 'deleted' });
    });
  }

  async function createContact(scopeInput: DavValue, { addressBookId, href: hrefInput, ifNoneMatch, ...options }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const scope = normalizeCardDavScope(scopeInput);
    const abId = normalizeAddressBookId(addressBookId);
    const parsed = validateVCardObject(readVCardInput(options));
    const href = hrefInput === undefined ? normalizeHref(`${parsed.uid}.vcf`) : normalizeHref(hrefInput);
    if (ifNoneMatch !== '*') throw new CardDavError('If-None-Match: * is required to create a contact', 'PRECONDITION_REQUIRED', 428);
    const context = buildTenantContext(scope);
    return enabledStore.withTenantTransaction(context, async (client) => {
      await getAddressBookRow(client, scope, abId, { forUpdate: true });
      const existing = await client.query('SELECT 1 FROM dav_contacts WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 AND href = $4', [scope.tenantId, scope.userId, abId, href]);
      if ((existing.rowCount ?? 0) > 0) throw new CardDavError('contact already exists; create requires If-None-Match: *', 'CONTACT_EXISTS', 412);
      return insertContactRow(client, scope, abId, href, parsed);
    });
  }

  async function getContact(scopeInput: DavValue, { addressBookId, href: hrefInput }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const scope = normalizeCardDavScope(scopeInput);
    const abId = normalizeAddressBookId(addressBookId);
    const href = normalizeHref(hrefInput);
    const context = buildTenantContext(scope);
    return enabledStore.withTenantTransaction(context, async (client) => {
      await getAddressBookRow(client, scope, abId);
      const result = await client.query<DavRecord>('SELECT * FROM dav_contacts WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 AND href = $4', [scope.tenantId, scope.userId, abId, href]);
      const row = result.rows[0];
      if (!row) throw new CardDavError('contact was not found in this tenant/user scope', 'CONTACT_NOT_FOUND', 404);
      return publicContactRow(row);
    });
  }

  async function getContactMetadata(scopeInput: DavValue, { addressBookId, href: hrefInput }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const scope = normalizeCardDavScope(scopeInput);
    const abId = normalizeAddressBookId(addressBookId);
    const href = normalizeHref(hrefInput);
    const context = buildTenantContext(scope);
    return enabledStore.withTenantTransaction(context, async (client) => {
      await getAddressBookRow(client, scope, abId);
      const result = await client.query<DavRecord>('SELECT * FROM dav_contacts WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 AND href = $4', [scope.tenantId, scope.userId, abId, href]);
      const row = result.rows[0];
      if (!row) throw new CardDavError('contact was not found in this tenant/user scope', 'CONTACT_NOT_FOUND', 404);
      return contactMetadataRow(row);
    });
  }

  async function listContacts(scopeInput: DavValue, { addressBookId }: DavRecord = {}): Promise<readonly Readonly<DavRecord>[]> {
    const scope = normalizeCardDavScope(scopeInput);
    const abId = normalizeAddressBookId(addressBookId);
    const context = buildTenantContext(scope);
    return enabledStore.withTenantTransaction(context, async (client) => {
      await getAddressBookRow(client, scope, abId);
      const result = await client.query<DavRecord>('SELECT * FROM dav_contacts WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 ORDER BY href', [scope.tenantId, scope.userId, abId]);
      return Object.freeze(result.rows.map((row) => contactMetadataRow(row)));
    });
  }

  async function putContact(scopeInput: DavValue, { addressBookId, href: hrefInput, ifMatch, ifNoneMatch, ...options }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const scope = normalizeCardDavScope(scopeInput);
    const abId = normalizeAddressBookId(addressBookId);
    const parsed = validateVCardObject(readVCardInput(options));
    const href = normalizeHref(hrefInput === undefined ? `${parsed.uid}.vcf` : hrefInput);
    const context = buildTenantContext(scope);
    return enabledStore.withTenantTransaction(context, async (client) => {
      await getAddressBookRow(client, scope, abId, { forUpdate: true });
      const existingResult = await client.query<DavRecord>('SELECT * FROM dav_contacts WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 AND href = $4 FOR UPDATE', [scope.tenantId, scope.userId, abId, href]);
      const existing = existingResult.rows[0];
      if (!existing) {
        if (ifNoneMatch === '*') return insertContactRow(client, scope, abId, href, parsed);
        throw new CardDavError('contact was not found; conditional create requires If-None-Match: *', 'CONTACT_NOT_FOUND', 404);
      }
      if (ifNoneMatch !== undefined) throw new CardDavError('If-None-Match: * cannot update an existing contact', 'PRECONDITION_FAILED', 412);
      assertIfMatch(ifMatch, existing.etag, 'contact');
      if (parsed.uid !== existing.uid) throw new CardDavError('vCard UID cannot change during an update', 'VCARD_UID_IMMUTABLE', 409);
      const otherClash = await client.query(
        'SELECT href FROM dav_contacts WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 AND uid = $4 AND href <> $5',
        [scope.tenantId, scope.userId, abId, parsed.uid, href],
      );
      if ((otherClash.rowCount ?? 0) > 0) throw new CardDavError('vCard UID already exists in this address book', 'VCARD_UID_EXISTS', 409);
      const candidateEtag = makeEtag(parsed.canonical);
      // Idempotent no-op: matches CardDavStore#putContact(), which returns the
      // existing contact without bumping the revision or appending a change
      // row when the recomputed ETag is unchanged.
      if (candidateEtag === existing.etag) return publicContactRow(existing);
      const revision = await bumpAddressBookRevision(client, scope.tenantId, scope.userId, abId, { href, uid: parsed.uid, etag: candidateEtag, operation: 'updated' });
      const updated = await client.query<DavRecord>(
        `UPDATE dav_contacts SET full_name = $1, vcard_data = $2, etag = $3, media_type = $4, size_bytes = $5, revision = $6, updated_at = now()
         WHERE tenant_id = $7 AND user_id = $8 AND address_book_id = $9 AND href = $10 RETURNING *`,
        [parsed.fullName, parsed.canonical, candidateEtag, parsed.mediaType, Buffer.byteLength(parsed.canonical, 'utf8'), revision, scope.tenantId, scope.userId, abId, href],
      );
      return publicContactRow(updated.rows[0]);
    });
  }

  async function deleteContact(scopeInput: DavValue, { addressBookId, href: hrefInput, ifMatch }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const scope = normalizeCardDavScope(scopeInput);
    const abId = normalizeAddressBookId(addressBookId);
    const href = normalizeHref(hrefInput);
    const context = buildTenantContext(scope);
    return enabledStore.withTenantTransaction(context, async (client) => {
      await getAddressBookRow(client, scope, abId, { forUpdate: true });
      const result = await client.query<DavRecord>('SELECT * FROM dav_contacts WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 AND href = $4 FOR UPDATE', [scope.tenantId, scope.userId, abId, href]);
      const contact = result.rows[0];
      if (!contact) throw new CardDavError('contact was not found in this tenant/user scope', 'CONTACT_NOT_FOUND', 404);
      assertIfMatch(ifMatch, contact.etag, 'contact');
      await client.query('DELETE FROM dav_contacts WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 AND href = $4', [scope.tenantId, scope.userId, abId, href]);
      const revision = await bumpAddressBookRevision(client, scope.tenantId, scope.userId, abId, { href, uid: contact.uid, etag: null, operation: 'deleted' });
      return Object.freeze({
        href,
        status: 'deleted',
        etag: null,
        syncToken: makeSyncToken({ tenantId: scope.tenantId, userId: scope.userId }, abId, revision),
      });
    });
  }

  async function syncCollection(scopeInput: DavValue, { addressBookId, syncToken: suppliedToken }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const scope = normalizeCardDavScope(scopeInput);
    const abId = normalizeAddressBookId(addressBookId);
    const context = buildTenantContext(scope);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const row = await getAddressBookRow(client, scope, abId);
      const currentRevision = Number(row.revision);
      const currentToken = makeSyncToken({ tenantId: scope.tenantId, userId: scope.userId }, abId, currentRevision);
      if (suppliedToken === undefined || suppliedToken === null) {
        const result = await client.query<DavRecord>('SELECT * FROM dav_contacts WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 ORDER BY href', [scope.tenantId, scope.userId, abId]);
        return Object.freeze({
          schemaVersion: CARD_DAV_SCHEMA_VERSION,
          addressBookId: abId,
          syncToken: currentToken,
          ctag: currentToken,
          changes: Object.freeze(result.rows.map((contactRow) => publicChangeRow({ version: Number(contactRow.revision), operation: 'created', href: contactRow.href, uid: contactRow.uid, etag: contactRow.etag }))),
        });
      }
      const fromVersion = parseSyncToken(suppliedToken, { tenantId: scope.tenantId, userId: scope.userId }, abId);
      if (fromVersion > currentRevision) throw new CardDavError('syncToken is ahead of the address book state', 'SYNC_TOKEN_INVALID', 409);
      const changes = await client.query<DavRecord>(
        'SELECT * FROM dav_contact_changes WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 AND revision > $4 ORDER BY revision',
        [scope.tenantId, scope.userId, abId, fromVersion],
      );
      return Object.freeze({
        schemaVersion: CARD_DAV_SCHEMA_VERSION,
        addressBookId: abId,
        previousSyncToken: suppliedToken,
        syncToken: currentToken,
        ctag: currentToken,
        changes: Object.freeze(changes.rows.map((change) => publicChangeRow({ version: Number(change.revision), operation: change.operation, href: change.href, uid: change.uid, etag: change.etag }))),
      });
    });
  }

  async function exportAddressBookMetadata(scopeInput: DavValue, { addressBookId }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const scope = normalizeCardDavScope(scopeInput);
    const abId = normalizeAddressBookId(addressBookId);
    const context = buildTenantContext(scope);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const row = await getAddressBookRow(client, scope, abId);
      const result = await client.query<DavRecord>('SELECT * FROM dav_contacts WHERE tenant_id = $1 AND user_id = $2 AND address_book_id = $3 ORDER BY href', [scope.tenantId, scope.userId, abId]);
      return Object.freeze({
        schemaVersion: CARD_DAV_SCHEMA_VERSION,
        exportType: 'carddav-address-book-metadata',
        addressBook: publicAddressBookRow(row),
        contacts: Object.freeze(result.rows.map((contactRow) => contactMetadataRow(contactRow))),
      });
    });
  }

  const enabledClient: EnabledPostgresCardDavStore = {
    enabled: true,
    healthCheck: async () => enabledStore.healthCheck(),
    close: () => enabledStore.close(),
    createAddressBook,
    getAddressBook,
    listAddressBooks,
    deleteAddressBook,
    createContact,
    getContact,
    getContactMetadata,
    listContacts,
    putContact,
    updateContact: putContact,
    upsertContact: putContact,
    deleteContact,
    syncCollection,
    exportAddressBookMetadata,
  };
  return Object.freeze(enabledClient);
}
