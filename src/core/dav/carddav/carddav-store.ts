// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createHash } from 'node:crypto';

type DavValue = any;
type DavRecord = Record<string, DavValue>;

const ADDRESS_BOOK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const HREF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.vcf$/u;
const SYNC_TOKEN_PATTERN = /^urn:gulogulo:carddav:v1:([A-Za-z0-9_-]{22}):(\d+)$/u;
const MAX_VCARD_BYTES = 256 * 1024;
const MAX_VCARD_LINE_LENGTH = 16 * 1024;
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 2 * 1024;
const MAX_COLOR_LENGTH = 32;

export const CARD_DAV_SCHEMA_VERSION = 1;
export const CARD_DAV_MEDIA_TYPE = 'text/vcard';
export const CARD_DAV_SYNC_TOKEN_PREFIX = 'urn:gulogulo:carddav:v1:';

/**
 * Error raised by the CardDAV contract.
 *
 * The status and code are deliberately stable so the HTTP adapter can map
 * them to protocol responses without inspecting error messages.
 */
export class CardDavError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'CARD_DAV_ERROR', status = 400) {
    super(`CardDAV error: ${message}`);
    this.name = 'CardDavError';
    this.code = code;
    this.status = status;
  }
}

function cardDavError(message: string, code = 'CARD_DAV_ERROR', status = 400): CardDavError {
  return new CardDavError(message, code, status);
}

function assertString(value: DavValue, field: string, { pattern, maxLength = 1024, allowEmpty = false }: DavRecord = {}): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maxLength) {
    throw cardDavError(`${field} is invalid`, `INVALID_${field.toUpperCase()}`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw cardDavError(`${field} contains control characters`, `INVALID_${field.toUpperCase()}`);
  }
  if (pattern !== undefined && !pattern.test(value)) {
    throw cardDavError(`${field} is invalid`, `INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function readClock(clock: () => DavValue): number {
  const value = clock();
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw cardDavError('clock must return a valid non-negative timestamp', 'INVALID_CLOCK', 500);
  }
  return Math.trunc(timestamp);
}

export function normalizeScope(scope: DavValue): Readonly<DavRecord> {
  if (scope === null || typeof scope !== 'object') {
    throw cardDavError('an authenticated tenant/user scope is required', 'SCOPE_INVALID', 401);
  }
  const tenantId = assertString(scope.tenantId, 'tenantId', { pattern: SCOPE_ID_PATTERN, maxLength: 128 });
  const userId = assertString(scope.userId, 'userId', { pattern: SCOPE_ID_PATTERN, maxLength: 128 });
  // DAV content operations are intentionally user-scoped. A master/provider
  // caller must first obtain an explicitly delegated user session; passing a
  // role or target-user marker directly to this contract never grants access.
  if (scope.role !== undefined && scope.role !== 'user') {
    throw cardDavError('CardDAV content requires an authenticated user scope', 'SCOPE_ROLE_DENIED', 403);
  }
  if (scope.targetUserId !== undefined && scope.targetUserId !== userId) {
    throw cardDavError('targetUserId does not match the authenticated user', 'SCOPE_TARGET_DENIED', 403);
  }
  return Object.freeze({ tenantId, userId });
}

export function normalizeAddressBookId(value: DavValue): string {
  return assertString(value, 'addressBookId', { pattern: ADDRESS_BOOK_ID_PATTERN, maxLength: 64 });
}

export function normalizeHref(value: DavValue): string {
  const href = assertString(value, 'href', { pattern: HREF_PATTERN, maxLength: 128 });
  if (href.includes('..') || href.includes('%') || href.includes('/') || href.includes('\\')) {
    throw cardDavError('href must be a single safe vCard object name', 'INVALID_HREF');
  }
  return href;
}

function normalizeOptionalText(value: DavValue, field: string, maxLength: number): string {
  if (value === undefined || value === null) return '';
  return assertString(value, field, { maxLength, allowEmpty: true });
}

function keyFor(scope: DavRecord, addressBookId: string): string {
  return `${scope.tenantId}\u0000${scope.userId}\u0000${addressBookId}`;
}

export function scopeFingerprint(scope: DavRecord, addressBookId: string): string {
  return createHash('sha256')
    .update(`${scope.tenantId}\u0000${scope.userId}\u0000${addressBookId}`, 'utf8')
    .digest('base64url')
    .slice(0, 22);
}

export function makeSyncToken(scope: DavRecord, addressBookId: string, version: number): string {
  return `${CARD_DAV_SYNC_TOKEN_PREFIX}${scopeFingerprint(scope, addressBookId)}:${version}`;
}

export function parseSyncToken(token: DavValue, scope: DavRecord, addressBookId: string): number {
  if (typeof token !== 'string') {
    throw cardDavError('syncToken must be a string', 'SYNC_TOKEN_INVALID', 400);
  }
  const match = SYNC_TOKEN_PATTERN.exec(token);
  if (match === null || match[1] !== scopeFingerprint(scope, addressBookId)) {
    throw cardDavError('syncToken is not valid for this tenant/user collection', 'SYNC_TOKEN_INVALID', 409);
  }
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version)) {
    throw cardDavError('syncToken version is invalid', 'SYNC_TOKEN_INVALID', 409);
  }
  return version;
}

export function makeEtag(canonicalVCard: string): string {
  return `"${createHash('sha256').update(canonicalVCard, 'utf8').digest('base64url')}"`;
}

export function makeCollectionEtag(state: DavRecord): string {
  const value = `${state.addressBookId}\u0000${state.displayName}\u0000${state.description}\u0000${state.color}\u0000${state.revision}`;
  return `"${createHash('sha256').update(value, 'utf8').digest('base64url')}"`;
}

export function matchesIfMatch(ifMatch: DavValue, currentEtag: string): boolean {
  if (ifMatch === '*') return true;
  if (typeof ifMatch !== 'string' || ifMatch.length === 0) return false;
  return ifMatch.split(',').map((part) => part.trim()).some((part) => part === currentEtag);
}

export function assertIfMatch(ifMatch: DavValue, currentEtag: string, resourceName: string): void {
  if (ifMatch === undefined) {
    throw cardDavError(`If-Match is required for ${resourceName}`, 'PRECONDITION_REQUIRED', 428);
  }
  if (!matchesIfMatch(ifMatch, currentEtag)) {
    throw cardDavError(`If-Match does not match the current ${resourceName} ETag`, 'ETAG_MISMATCH', 412);
  }
}

function readVCardInput(options: DavRecord): DavValue {
  const value = options.vCard ?? options.vcard ?? options.vcardText;
  if (value === undefined) {
    throw cardDavError('vCard content is required', 'VCARD_REQUIRED', 400);
  }
  return value;
}

function unfoldVCardLines(text: string): string[] {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const rawLines = normalized.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  const lines = [];
  for (const rawLine of rawLines) {
    if (rawLine.length > MAX_VCARD_LINE_LENGTH) {
      throw cardDavError('vCard line is too long', 'VCARD_LINE_TOO_LONG', 400);
    }
    if (/^[ \t]/u.test(rawLine)) {
      if (lines.length === 0) {
        throw cardDavError('vCard folding cannot start the object', 'VCARD_INVALID', 400);
      }
      lines[lines.length - 1] += rawLine.slice(1);
    } else {
      lines.push(rawLine);
    }
  }
  if (lines.length === 0) {
    throw cardDavError('vCard is empty', 'VCARD_INVALID', 400);
  }
  return lines;
}

function parseVCardProperty(line: string): DavRecord {
  const match = /^(?:[A-Za-z][A-Za-z0-9-]*\.)?(?<name>[A-Za-z][A-Za-z0-9-]*)(?<parameters>(?:;[^:;]*)*):(?<value>.*)$/u.exec(line);
  if (match === null) {
    throw cardDavError('vCard property syntax is invalid', 'VCARD_INVALID', 400);
  }
  const { name, parameters, value } = match.groups!;
  if (/\p{Cc}/u.test(parameters.replaceAll('\t', '')) || /\p{Cc}/u.test(value.replaceAll('\t', ''))) {
    throw cardDavError('vCard properties cannot contain raw control characters', 'VCARD_INVALID', 400);
  }
  return Object.freeze({
    name: name.toUpperCase(),
    parameters,
    value,
  });
}

function unescapeVCardText(value: string): string {
  return value.replaceAll(/\\([nNrR,;\\])/gu, (_match: string, escaped: string) => {
    if (escaped.toLowerCase() === 'n' || escaped.toLowerCase() === 'r') return '\n';
    return escaped;
  });
}

function validateVCardText(value: DavValue): Readonly<DavRecord> {
  if (typeof value !== 'string') {
    throw cardDavError('vCard must be a string', 'VCARD_INVALID', 400);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_VCARD_BYTES) {
    throw cardDavError('vCard exceeds the maximum size', 'VCARD_TOO_LARGE', 413);
  }
  if (value.includes('\0')) {
    throw cardDavError('vCard contains a NUL character', 'VCARD_INVALID', 400);
  }
  const lines = unfoldVCardLines(value);
  if (lines[0]!.toUpperCase() !== 'BEGIN:VCARD' || lines.at(-1)!.toUpperCase() !== 'END:VCARD') {
    throw cardDavError('vCard must contain one BEGIN:VCARD and one END:VCARD', 'VCARD_INVALID', 400);
  }

  const properties = lines.map(parseVCardProperty);
  if (properties[0]!.name !== 'BEGIN' || properties.at(-1)!.name !== 'END') {
    throw cardDavError('vCard boundaries are invalid', 'VCARD_INVALID', 400);
  }
  const beginCount = properties.filter((property) => property.name === 'BEGIN').length;
  const endCount = properties.filter((property) => property.name === 'END').length;
  if (beginCount !== 1 || endCount !== 1) {
    throw cardDavError('a CardDAV object must contain exactly one vCard', 'VCARD_MULTIPLE_OBJECTS', 400);
  }

  const versions = properties.filter((property) => property.name === 'VERSION');
  if (versions.length !== 1 || !['3.0', '4.0'].includes(versions[0].value)) {
    throw cardDavError('vCard VERSION must be exactly 3.0 or 4.0', 'VCARD_VERSION_INVALID', 400);
  }
  const uidProperties = properties.filter((property) => property.name === 'UID');
  const fullNameProperties = properties.filter((property) => property.name === 'FN');
  if (uidProperties.length !== 1 || uidProperties[0].value.length === 0) {
    throw cardDavError('vCard must contain exactly one non-empty UID', 'VCARD_UID_INVALID', 400);
  }
  if (fullNameProperties.length !== 1 || unescapeVCardText(fullNameProperties[0].value).trim().length === 0) {
    throw cardDavError('vCard must contain exactly one non-empty FN', 'VCARD_FN_INVALID', 400);
  }
  const uid = unescapeVCardText(uidProperties[0].value);
  if (uid.length > 256 || /[\r\n]/u.test(uid)) {
    throw cardDavError('vCard UID is invalid', 'VCARD_UID_INVALID', 400);
  }

  const canonical = `${lines.join('\r\n')}\r\n`;
  const propertyNames = Object.freeze([...new Set(properties.slice(1, -1).map((property) => property.name))].sort());
  return Object.freeze({
    canonical,
    version: versions[0].value,
    uid,
    fullName: unescapeVCardText(fullNameProperties[0].value),
    mediaType: `${CARD_DAV_MEDIA_TYPE}; version=${versions[0].value}`,
    propertyNames,
    emailCount: properties.filter((property) => property.name === 'EMAIL').length,
    telCount: properties.filter((property) => property.name === 'TEL').length,
  });
}

/** Validate and normalize one vCard object without storing it. */
export function validateVCardObject(vCard: unknown): Readonly<DavRecord> {
  return validateVCardText(vCard);
}

export const validateVCard = validateVCardObject;
export const parseVCard = validateVCardObject;

function freezeObject<T extends object>(object: T): Readonly<T> {
  return Object.freeze(object);
}

function contactMetadata(contact: DavRecord): Readonly<DavRecord> {
  return freezeObject({
    href: contact.href,
    uid: contact.uid,
    fullName: contact.fullName,
    etag: contact.etag,
    mediaType: contact.mediaType,
    sizeBytes: contact.sizeBytes,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
    propertyNames: contact.propertyNames,
    emailCount: contact.emailCount,
    telCount: contact.telCount,
  });
}

function publicContact(contact: DavRecord): Readonly<DavRecord> {
  return freezeObject({
    ...contactMetadata(contact),
    vCard: contact.vCard,
  });
}

function publicAddressBook(state: DavRecord, scope: DavRecord): Readonly<DavRecord> {
  return freezeObject({
    schemaVersion: CARD_DAV_SCHEMA_VERSION,
    addressBookId: state.addressBookId,
    href: state.href,
    displayName: state.displayName,
    description: state.description,
    color: state.color,
    etag: makeCollectionEtag(state),
    ctag: makeSyncToken(scope, state.addressBookId, state.revision),
    syncToken: makeSyncToken(scope, state.addressBookId, state.revision),
    supportedAddressData: Object.freeze([...state.supportedAddressData]),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  });
}

function publicChange(change: DavRecord): Readonly<DavRecord> {
  return freezeObject({
    version: change.version,
    operation: change.operation,
    href: change.href,
    uid: change.uid,
    etag: change.etag,
    status: change.operation === 'deleted' ? 'deleted' : 'present',
  });
}

/**
 * In-memory CardDAV contract used by deterministic tests and future protocol
 * adapters. The adapter deliberately stores contacts under a composite
 * tenant/user/collection key; callers cannot address another user's data by
 * supplying a collection path alone.
 */
export class CardDavStore {
  readonly clock: () => DavValue;
  readonly addressBooks: Map<string, DavRecord>;

  constructor({ clock = () => Date.now() }: DavRecord = {}) {
    if (typeof clock !== 'function') {
      throw cardDavError('clock must be a function', 'INVALID_CONFIGURATION', 500);
    }
    this.clock = clock;
    this.addressBooks = new Map<string, DavRecord>();
  }

  #getState(scopeInput: DavValue, addressBookIdInput: DavValue): DavRecord {
    const scope = normalizeScope(scopeInput);
    const addressBookId = normalizeAddressBookId(addressBookIdInput);
    const state = this.addressBooks.get(keyFor(scope, addressBookId));
    if (state === undefined) {
      throw cardDavError('address book was not found in this tenant/user scope', 'ADDRESS_BOOK_NOT_FOUND', 404);
    }
    return { scope, addressBookId, state };
  }

  createAddressBook({ scope: scopeInput, addressBookId: addressBookIdInput, displayName, description = '', color = null }: DavRecord = {}): Readonly<DavRecord> {
    const scope = normalizeScope(scopeInput);
    const addressBookId = normalizeAddressBookId(addressBookIdInput);
    const key = keyFor(scope, addressBookId);
    if (this.addressBooks.has(key)) {
      throw cardDavError('address book already exists', 'ADDRESS_BOOK_EXISTS', 409);
    }
    const normalizedDisplayName = assertString(displayName, 'displayName', { maxLength: MAX_DISPLAY_NAME_LENGTH });
    const normalizedDescription = normalizeOptionalText(description, 'description', MAX_DESCRIPTION_LENGTH);
    const normalizedColor = color === null || color === undefined
      ? null
      : assertString(color, 'color', { maxLength: MAX_COLOR_LENGTH, pattern: /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/u });
    const now = new Date(readClock(this.clock)).toISOString();
    const state = {
      tenantId: scope.tenantId,
      userId: scope.userId,
      addressBookId,
      href: `/addressbooks/${addressBookId}/`,
      displayName: normalizedDisplayName,
      description: normalizedDescription,
      color: normalizedColor,
      supportedAddressData: ['text/vcard; version=3.0', 'text/vcard; version=4.0'],
      createdAt: now,
      updatedAt: now,
      revision: 0,
      contacts: new Map<string, DavRecord>(),
      changes: [] as DavRecord[],
    };
    this.addressBooks.set(key, state);
    return publicAddressBook(state, scope);
  }

  getAddressBook({ scope: scopeInput, addressBookId: addressBookIdInput }: DavRecord = {}): Readonly<DavRecord> {
    const { scope, state } = this.#getState(scopeInput, addressBookIdInput);
    return publicAddressBook(state, scope);
  }

  listAddressBooks({ scope: scopeInput }: DavRecord = {}): readonly Readonly<DavRecord>[] {
    const scope = normalizeScope(scopeInput);
    const result: Readonly<DavRecord>[] = [];
    for (const state of this.addressBooks.values()) {
      if (state.tenantId === scope.tenantId && state.userId === scope.userId) {
        result.push(publicAddressBook(state, scope));
      }
    }
    return Object.freeze(result.sort((left, right) => left.addressBookId.localeCompare(right.addressBookId)));
  }

  deleteAddressBook({ scope: scopeInput, addressBookId: addressBookIdInput, ifMatch }: DavRecord = {}): Readonly<DavRecord> {
    const { scope, addressBookId, state } = this.#getState(scopeInput, addressBookIdInput);
    assertIfMatch(ifMatch, makeCollectionEtag(state), 'address book');
    this.addressBooks.delete(keyFor(scope, addressBookId));
    return freezeObject({ addressBookId, status: 'deleted' });
  }

  #touch(state: DavRecord, scope: DavRecord, addressBookId: string): string {
    state.revision += 1;
    state.updatedAt = new Date(readClock(this.clock)).toISOString();
    return makeSyncToken(scope, addressBookId, state.revision);
  }

  #findUid(state: DavRecord, uid: string): DavRecord | null {
    for (const contact of state.contacts.values()) {
      if (contact.uid === uid) return contact;
    }
    return null;
  }

  #buildContact({ state, scope, addressBookId, href, parsed, now }: DavRecord): DavRecord {
    const revision = state.revision + 1;
    const etag = makeEtag(parsed.canonical);
    return {
      href,
      uid: parsed.uid,
      fullName: parsed.fullName,
      vCard: parsed.canonical,
      etag,
      mediaType: parsed.mediaType,
      sizeBytes: Buffer.byteLength(parsed.canonical, 'utf8'),
      createdAt: now,
      updatedAt: now,
      propertyNames: parsed.propertyNames,
      emailCount: parsed.emailCount,
      telCount: parsed.telCount,
      revision,
      tenantId: scope.tenantId,
      userId: scope.userId,
      addressBookId,
    };
  }

  #record(state: DavRecord, scope: DavRecord, addressBookId: string, contact: DavRecord, operation: string, etag: string | null = null): string {
    const syncToken = this.#touch(state, scope, addressBookId);
    state.changes.push({
      version: state.revision,
      operation,
      href: contact.href,
      uid: contact.uid,
      etag,
    });
    return syncToken;
  }

  createContact({ scope: scopeInput, addressBookId: addressBookIdInput, href: hrefInput, ifNoneMatch, ...options }: DavRecord = {}): Readonly<DavRecord> {
    const { scope, addressBookId, state } = this.#getState(scopeInput, addressBookIdInput);
    const parsed = validateVCardText(readVCardInput(options));
    const href = hrefInput === undefined ? normalizeHref(`${parsed.uid}.vcf`) : normalizeHref(hrefInput);
    if (ifNoneMatch !== '*') {
      throw cardDavError('If-None-Match: * is required to create a contact', 'PRECONDITION_REQUIRED', 428);
    }
    const existing = state.contacts.get(href);
    if (existing !== undefined) {
      throw cardDavError('contact already exists; create requires If-None-Match: *', 'CONTACT_EXISTS', 412);
    }
    if (this.#findUid(state, parsed.uid) !== null) {
      throw cardDavError('vCard UID already exists in this address book', 'VCARD_UID_EXISTS', 409);
    }
    const now = new Date(readClock(this.clock)).toISOString();
    const contact = this.#buildContact({ state, scope, addressBookId, href, parsed, now });
    state.contacts.set(href, contact);
    this.#record(state, scope, addressBookId, contact, 'created', contact.etag);
    return publicContact(contact);
  }

  getContact({ scope: scopeInput, addressBookId: addressBookIdInput, href: hrefInput }: DavRecord = {}): Readonly<DavRecord> {
    const { state } = this.#getState(scopeInput, addressBookIdInput);
    const href = normalizeHref(hrefInput);
    const contact = state.contacts.get(href);
    if (contact === undefined) {
      throw cardDavError('contact was not found in this tenant/user scope', 'CONTACT_NOT_FOUND', 404);
    }
    return publicContact(contact);
  }

  getContactMetadata({ scope: scopeInput, addressBookId: addressBookIdInput, href: hrefInput }: DavRecord = {}): Readonly<DavRecord> {
    const { state } = this.#getState(scopeInput, addressBookIdInput);
    const href = normalizeHref(hrefInput);
    const contact = state.contacts.get(href);
    if (contact === undefined) {
      throw cardDavError('contact was not found in this tenant/user scope', 'CONTACT_NOT_FOUND', 404);
    }
    return contactMetadata(contact);
  }

  listContacts({ scope: scopeInput, addressBookId: addressBookIdInput }: DavRecord = {}): readonly Readonly<DavRecord>[] {
    const { state } = this.#getState(scopeInput, addressBookIdInput);
    return Object.freeze([...state.contacts.values()]
      .sort((left, right) => left.href.localeCompare(right.href))
      .map((contact) => contactMetadata(contact)));
  }

  putContact({ scope: scopeInput, addressBookId: addressBookIdInput, href: hrefInput, ifMatch, ifNoneMatch, ...options }: DavRecord = {}): Readonly<DavRecord> {
    const { scope, addressBookId, state } = this.#getState(scopeInput, addressBookIdInput);
    const parsed = validateVCardText(readVCardInput(options));
    const href = normalizeHref(hrefInput === undefined ? `${parsed.uid}.vcf` : hrefInput);
    const existing = state.contacts.get(href);
    if (existing === undefined) {
      if (ifNoneMatch === '*') {
        return this.createContact({ scope, addressBookId, href, ifNoneMatch, vCard: parsed.canonical });
      }
      throw cardDavError('contact was not found; conditional create requires If-None-Match: *', 'CONTACT_NOT_FOUND', 404);
    }
    if (ifNoneMatch !== undefined) {
      throw cardDavError('If-None-Match: * cannot update an existing contact', 'PRECONDITION_FAILED', 412);
    }
    assertIfMatch(ifMatch, existing.etag, 'contact');
    if (parsed.uid !== existing.uid) {
      throw cardDavError('vCard UID cannot change during an update', 'VCARD_UID_IMMUTABLE', 409);
    }
    const otherContact = this.#findUid(state, parsed.uid);
    if (otherContact !== null && otherContact.href !== href) {
      throw cardDavError('vCard UID already exists in this address book', 'VCARD_UID_EXISTS', 409);
    }
    const candidateEtag = makeEtag(parsed.canonical);
    if (candidateEtag === existing.etag) return publicContact(existing);
    const now = new Date(readClock(this.clock)).toISOString();
    const replacement = this.#buildContact({ state, scope, addressBookId, href, parsed, now });
    replacement.createdAt = existing.createdAt;
    state.contacts.set(href, replacement);
    this.#record(state, scope, addressBookId, replacement, 'updated', replacement.etag);
    return publicContact(replacement);
  }

  updateContact(options: DavRecord = {}): Readonly<DavRecord> {
    return this.putContact(options);
  }

  upsertContact(options: DavRecord = {}): Readonly<DavRecord> {
    return this.putContact(options);
  }

  deleteContact({ scope: scopeInput, addressBookId: addressBookIdInput, href: hrefInput, ifMatch }: DavRecord = {}): Readonly<DavRecord> {
    const { scope, addressBookId, state } = this.#getState(scopeInput, addressBookIdInput);
    const href = normalizeHref(hrefInput);
    const contact = state.contacts.get(href);
    if (contact === undefined) {
      throw cardDavError('contact was not found in this tenant/user scope', 'CONTACT_NOT_FOUND', 404);
    }
    assertIfMatch(ifMatch, contact.etag, 'contact');
    state.contacts.delete(href);
    const syncToken = this.#record(state, scope, addressBookId, contact, 'deleted', null);
    return freezeObject({
      href,
      status: 'deleted',
      etag: null,
      syncToken,
    });
  }

  syncCollection({ scope: scopeInput, addressBookId: addressBookIdInput, syncToken: suppliedToken }: DavRecord = {}): Readonly<DavRecord> {
    const { scope, addressBookId, state } = this.#getState(scopeInput, addressBookIdInput);
    const currentToken = makeSyncToken(scope, addressBookId, state.revision);
    if (suppliedToken === undefined || suppliedToken === null) {
      return freezeObject({
        schemaVersion: CARD_DAV_SCHEMA_VERSION,
        addressBookId,
        syncToken: currentToken,
        ctag: currentToken,
        changes: Object.freeze([...state.contacts.values()]
          .sort((left, right) => left.href.localeCompare(right.href))
          .map((contact) => publicChange({ version: contact.revision, operation: 'created', href: contact.href, uid: contact.uid, etag: contact.etag }))),
      });
    }
    const fromVersion = parseSyncToken(suppliedToken, scope, addressBookId);
    if (fromVersion > state.revision) {
      throw cardDavError('syncToken is ahead of the address book state', 'SYNC_TOKEN_INVALID', 409);
    }
    return freezeObject({
      schemaVersion: CARD_DAV_SCHEMA_VERSION,
      addressBookId,
      previousSyncToken: suppliedToken,
      syncToken: currentToken,
      ctag: currentToken,
      changes: Object.freeze(state.changes
        .filter((change: DavRecord) => change.version > fromVersion)
        .map((change: DavRecord) => publicChange(change))),
    });
  }

  /**
   * Export only non-content metadata for an address book.
   *
   * This method intentionally omits vCard bodies, tenant/user identifiers,
   * session identifiers, credentials, and storage paths. A future explicit
   * user export endpoint may call getContact() after authorization.
   */
  exportAddressBookMetadata({ scope: scopeInput, addressBookId: addressBookIdInput }: DavRecord = {}): Readonly<DavRecord> {
    const { scope, addressBookId, state } = this.#getState(scopeInput, addressBookIdInput);
    const addressBook = publicAddressBook(state, scope);
    return freezeObject({
      schemaVersion: CARD_DAV_SCHEMA_VERSION,
      exportType: 'carddav-address-book-metadata',
      addressBook,
      contacts: Object.freeze([...state.contacts.values()]
        .sort((left, right) => left.href.localeCompare(right.href))
        .map((contact) => contactMetadata(contact))),
    });
  }
}

export const CardDAVStore = CardDavStore;
export const createCardDavStore = (options: DavRecord = {}): CardDavStore => new CardDavStore(options);
export const createCardDAVStore = createCardDavStore;

export const cardDavConstants = Object.freeze({
  schemaVersion: CARD_DAV_SCHEMA_VERSION,
  mediaType: CARD_DAV_MEDIA_TYPE,
  maxVCardBytes: MAX_VCARD_BYTES,
  maxVCardLineLength: MAX_VCARD_LINE_LENGTH,
});
