// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createHash } from 'node:crypto';

type DavValue = any;
type DavRecord = Record<string, DavValue>;

const ACTOR_ROLES = new Set(['provider', 'tenant_master', 'user', 'monitor']);
const CALENDAR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const TZID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/u;
const COLOR_PATTERN = /^#[0-9A-F]{6}$/iu;
const TOKEN_PATTERN = /^https:\/\/gulogulo\.invalid\/caldav\/([^/]+)\/([^/]+)\/([^/]+)\/sync\/(\d+)$/u;
const SUPPORTED_COMPONENTS = new Set(['VCALENDAR', 'VEVENT', 'VTIMEZONE', 'STANDARD', 'DAYLIGHT', 'VALARM']);
const ATTENDEE_ROLES = new Set(['CHAIR', 'REQ-PARTICIPANT', 'OPT-PARTICIPANT', 'NON-PARTICIPANT']);
const ATTENDEE_PARTSTAT = new Set(['NEEDS-ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE', 'DELEGATED', 'COMPLETED', 'IN-PROCESS']);
const ACL_PERMISSIONS = new Set(['read', 'write']);
const MAX_ICALENDAR_BYTES = 1_048_576;
const MAX_ICALENDAR_LINES = 10_000;
const MAX_ICALENDAR_LINE_LENGTH = 8_192;
const MAX_COMPONENT_COUNT = 256;
const MAX_COMPONENT_DEPTH = 4;

/**
 * Error raised by the dependency-free CalDAV contract.
 *
 * `status` deliberately mirrors the HTTP/WebDAV status that a later adapter
 * should expose. The contract itself never opens a socket or talks to DAV.
 */
export class CalDavError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: DavValue;

  constructor(message: string, code = 'CALDAV_ERROR', status = 400, details: DavValue = undefined) {
    super(`CalDAV contract error: ${message}`);
    this.name = 'CalDavError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function fail(message: string, code: string, status = 400, details: DavValue = undefined): never {
  throw new CalDavError(message, code, status, details);
}

function requiredPattern(value: DavValue, pattern: RegExp, field: string, code = 'INVALID_REQUEST'): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${field} is invalid`, code, 422);
  return value;
}

export function canonicalTenantId(value: DavValue): string {
  return requiredPattern(value, TENANT_ID_PATTERN, 'tenantId', 'INVALID_TENANT');
}

export function canonicalUserId(value: DavValue, field = 'userId'): string {
  return requiredPattern(value, USER_ID_PATTERN, field, 'INVALID_USER');
}

export function canonicalCalendarSlug(value: DavValue, field = 'calendarId'): string {
  return requiredPattern(value, CALENDAR_ID_PATTERN, field, 'INVALID_CALENDAR_ID');
}

function assertDate(value: DavValue, field: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) fail(`${field} is invalid`, 'INVALID_TIMESTAMP', 422);
  return date;
}

function isoDate(value: DavValue, field = 'timestamp'): string {
  return assertDate(value, field).toISOString();
}

function freezeArray<T>(items: Iterable<T>): readonly T[] {
  return Object.freeze([...items]);
}

function freezeObject<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function normalizeActor(actor: DavValue, tenantId: string): Readonly<DavRecord> {
  if (actor === null || typeof actor !== 'object') fail('an authenticated DAV actor is required', 'AUTHENTICATION_REQUIRED', 401);
  const actorTenantId = canonicalTenantId(actor.tenantId);
  if (actorTenantId !== tenantId) fail('cross-tenant DAV access is denied', 'CROSS_TENANT_DENIED', 403);
  const userId = actor.userId ?? actor.actorId;
  canonicalUserId(userId, 'actor.userId');
  if (!ACTOR_ROLES.has(actor.role)) fail('actor role is invalid', 'INVALID_ACTOR_ROLE', 403);
  if (actor.role !== 'user') fail('CalDAV content requires an authenticated user scope', 'CONTENT_SCOPE_REQUIRED', 403);
  return freezeObject({ tenantId: actorTenantId, userId, role: actor.role });
}

export function canonicalCalendarKey(ownerUserId: string, collectionId: string): string {
  return `${ownerUserId}/${collectionId}`;
}

export function splitCalendarId(value: DavValue): { ownerUserId: string | null; collectionId: string } {
  if (typeof value !== 'string') fail('calendarId is required', 'INVALID_CALENDAR_ID', 422);
  const parts = value.split('/');
  if (parts.length === 1) return { ownerUserId: null, collectionId: canonicalCalendarSlug(parts[0]) };
  if (parts.length !== 2) fail('calendarId has an invalid scope', 'INVALID_CALENDAR_ID', 422);
  return {
    ownerUserId: canonicalUserId(parts[0], 'calendarId owner'),
    collectionId: canonicalCalendarSlug(parts[1], 'calendarId collection'),
  };
}

export function decodeToken(value: DavValue, { tenantId, ownerUserId, collectionId }: DavRecord): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'string') fail('syncToken is invalid', 'INVALID_SYNC_TOKEN', 400);
  const match = TOKEN_PATTERN.exec(value);
  if (!match) fail('syncToken is invalid', 'INVALID_SYNC_TOKEN', 400);
  let tokenScope: DavRecord;
  try {
    tokenScope = {
      tenantId: decodeURIComponent(match[1]),
      ownerUserId: decodeURIComponent(match[2]),
      collectionId: decodeURIComponent(match[3]),
    };
  } catch {
    fail('syncToken is invalid', 'INVALID_SYNC_TOKEN', 400);
  }
  if (tokenScope.tenantId !== tenantId) fail('syncToken belongs to another tenant', 'CROSS_TENANT_DENIED', 403);
  if (tokenScope.ownerUserId !== ownerUserId || tokenScope.collectionId !== collectionId) fail('syncToken belongs to another calendar collection', 'SYNC_SCOPE_DENIED', 403);
  const revision = Number(match[4]);
  if (!Number.isSafeInteger(revision) || revision < 0) fail('syncToken is invalid', 'INVALID_SYNC_TOKEN', 400);
  return revision;
}

export function makeToken(tenantId: string, ownerUserId: string, collectionId: string, revision: number): string {
  return `https://gulogulo.invalid/caldav/${encodeURIComponent(tenantId)}/${encodeURIComponent(ownerUserId)}/${encodeURIComponent(collectionId)}/sync/${revision}`;
}

function canonicalLineEndings(icalText: DavValue): { lines: string[]; canonical: string } {
  if (typeof icalText !== 'string' || icalText.length === 0) fail('iCalendar data is required', 'INVALID_ICALENDAR', 422);
  if (Buffer.byteLength(icalText, 'utf8') > MAX_ICALENDAR_BYTES) fail('iCalendar exceeds the maximum object size', 'ICALENDAR_TOO_LARGE', 413);
  if (icalText.includes('\r') && !icalText.includes('\r\n')) fail('bare CR is not valid iCalendar input', 'INVALID_ICALENDAR', 422);
  const unix = icalText.replaceAll('\r\n', '\n');
  const lines = unix.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > MAX_ICALENDAR_LINES) fail('iCalendar contains too many lines', 'ICALENDAR_TOO_LARGE', 413);
  if (lines.some((line) => line.length > MAX_ICALENDAR_LINE_LENGTH)) fail('iCalendar line exceeds the maximum length', 'ICALENDAR_TOO_LARGE', 413);
  if (lines.some((line) => /[\u0000\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(line))) {
    fail('iCalendar contains a control character', 'INVALID_ICALENDAR', 422);
  }
  if (lines.length === 0) fail('iCalendar has no content', 'INVALID_ICALENDAR', 422);

  const unfolded = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else if (line.startsWith(' ') || line.startsWith('\t')) {
      fail('iCalendar continuation appears before a property', 'INVALID_ICALENDAR', 422);
    } else {
      unfolded.push(line);
    }
  }
  return { lines: unfolded, canonical: `${unfolded.join('\r\n')}\r\n` };
}

function parseProperty(line: string): DavRecord {
  const colon = line.indexOf(':');
  if (colon <= 0) fail('iCalendar property has no name or value separator', 'INVALID_ICALENDAR', 422);
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  const name = parts.shift()?.toUpperCase();
  if (!name || !/^[A-Z][A-Z0-9-]*$/u.test(name)) fail('iCalendar property name is invalid', 'INVALID_ICALENDAR', 422);
  const parameters: Record<string, string> = {};
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator <= 0) fail('iCalendar parameter is invalid', 'INVALID_ICALENDAR', 422);
    const key = part.slice(0, separator).toUpperCase();
    let parameterValue = part.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9-]*$/u.test(key) || parameterValue.length === 0) fail('iCalendar parameter is invalid', 'INVALID_ICALENDAR', 422);
    if (parameterValue.startsWith('"') || parameterValue.endsWith('"')) {
      if (!(parameterValue.startsWith('"') && parameterValue.endsWith('"'))) fail('iCalendar parameter quotes are unbalanced', 'INVALID_ICALENDAR', 422);
      parameterValue = parameterValue.slice(1, -1);
    }
    parameters[key] = parameterValue;
  }
  return { name, value, parameters };
}

function parseCalendarComponents(icalText: DavValue): DavRecord {
  const { lines, canonical } = canonicalLineEndings(icalText);
  const stack: DavRecord[] = [];
  let componentCount = 0;
  let root: DavRecord | null = null;
  for (const line of lines) {
    const beginMatch = /^BEGIN:([A-Za-z0-9-]+)$/u.exec(line);
    const endMatch = /^END:([A-Za-z0-9-]+)$/u.exec(line);
    if (beginMatch) {
      const name = beginMatch[1].toUpperCase();
      if (!SUPPORTED_COMPONENTS.has(name)) fail(`component ${name} is not supported`, 'UNSUPPORTED_COMPONENT', 422);
      componentCount += 1;
      if (componentCount > MAX_COMPONENT_COUNT) fail('iCalendar contains too many components', 'ICALENDAR_TOO_LARGE', 413);
      if (stack.length >= MAX_COMPONENT_DEPTH) fail('iCalendar component nesting is too deep', 'ICALENDAR_TOO_LARGE', 413);
      const component = { name, properties: [], children: [] };
      if (stack.length === 0) {
        if (root !== null || name !== 'VCALENDAR') fail('VCALENDAR must be the sole root component', 'INVALID_ICALENDAR', 422);
        root = component;
      } else {
        const parent = stack.at(-1)!;
        if (parent.name === 'VCALENDAR' && !['VEVENT', 'VTIMEZONE'].includes(name)) fail(`component ${name} is not valid in VCALENDAR`, 'INVALID_ICALENDAR', 422);
        if (parent.name === 'VTIMEZONE' && !['STANDARD', 'DAYLIGHT'].includes(name)) fail(`component ${name} is not valid in VTIMEZONE`, 'INVALID_ICALENDAR', 422);
        if (parent.name === 'VEVENT' && name !== 'VALARM') fail(`component ${name} is not valid in VEVENT`, 'INVALID_ICALENDAR', 422);
        if (parent.name === 'VALARM') fail('nested VALARM components are not supported', 'INVALID_ICALENDAR', 422);
        parent.children.push(component);
      }
      stack.push(component);
      continue;
    }
    if (endMatch) {
      const name = endMatch[1].toUpperCase();
      const current = stack.at(-1);
      if (!current || current.name !== name) fail('iCalendar component boundaries do not match', 'INVALID_ICALENDAR', 422);
      stack.pop();
      continue;
    }
    if (stack.length === 0) fail('iCalendar property appears outside a component', 'INVALID_ICALENDAR', 422);
    stack.at(-1)!.properties.push(parseProperty(line));
  }
  if (root === null || stack.length !== 0 || root.name !== 'VCALENDAR') fail('iCalendar must contain a closed VCALENDAR', 'INVALID_ICALENDAR', 422);
  return { root, canonical };
}

function properties(component: DavRecord, name: string): DavRecord[] {
  return component.properties.filter((property: DavRecord) => property.name === name);
}

function oneProperty(component: DavRecord, name: string, required = false): DavRecord | null {
  const matches = properties(component, name);
  if (matches.length > 1) fail(`${name} must occur at most once`, 'INVALID_ICALENDAR', 422);
  if (required && matches.length === 0) fail(`${name} is required`, 'INVALID_ICALENDAR', 422);
  return matches[0] ?? null;
}

function unescapeText(value: string): string {
  return value.replaceAll('\\N', '\n').replaceAll('\\n', '\n').replaceAll('\\,', ',').replaceAll('\\;', ';').replaceAll('\\\\', '\\');
}

function assertDateValue(property: DavRecord | null, field: string): DavRecord | null {
  if (!property) return null;
  const valueType = property.parameters.VALUE?.toUpperCase() ?? null;
  const value = property.value;
  if (valueType === 'DATE') {
    if (property.parameters.TZID) fail(`${field} DATE value cannot use TZID`, 'INVALID_TIMEZONE', 422);
    if (!/^\d{8}$/u.test(value)) fail(`${field} DATE value is invalid`, 'INVALID_ICALENDAR', 422);
    return { value, kind: 'date', timeZone: null };
  }
  if (!/^\d{8}T\d{6}(Z)?$/u.test(value)) fail(`${field} DATE-TIME value is invalid`, 'INVALID_ICALENDAR', 422);
  const utc = value.endsWith('Z');
  if (utc && property.parameters.TZID) fail(`${field} cannot use TZID with UTC notation`, 'INVALID_ICALENDAR', 422);
  const timeZone = property.parameters.TZID ?? (utc ? 'UTC' : null);
  if (timeZone !== null) requiredPattern(timeZone, TZID_PATTERN, `${field} TZID`, 'INVALID_TIMEZONE');
  return { value, kind: 'date-time', timeZone };
}

function parseAddress(property: DavRecord | null, field: string): Readonly<DavRecord> | null {
  if (!property) return null;
  if (!/^mailto:[^\s<>@]+@[^\s<>@]+$/iu.test(property.value)) fail(`${field} must be a mailto address`, 'INVALID_ATTENDEE', 422);
  const role = property.parameters.ROLE?.toUpperCase() ?? null;
  const partStat = property.parameters.PARTSTAT?.toUpperCase() ?? null;
  if (role !== null && !ATTENDEE_ROLES.has(role)) fail(`${field} ROLE is invalid`, 'INVALID_ATTENDEE', 422);
  if (partStat !== null && !ATTENDEE_PARTSTAT.has(partStat)) fail(`${field} PARTSTAT is invalid`, 'INVALID_ATTENDEE', 422);
  return freezeObject({
    address: property.value.toLowerCase(),
    commonName: property.parameters.CN ? unescapeText(property.parameters.CN) : null,
    role: role ?? 'REQ-PARTICIPANT',
    partStat: partStat ?? 'NEEDS-ACTION',
  });
}

function calendarMetadata(root: DavRecord): Readonly<DavRecord> {
  const version = oneProperty(root, 'VERSION', true)!;
  if (version.value !== '2.0') fail('iCalendar VERSION must be 2.0', 'INVALID_ICALENDAR', 422);
  oneProperty(root, 'PRODID', true);
  const events = root.children.filter((component: DavRecord) => component.name === 'VEVENT');
  if (events.length !== 1) fail('exactly one VEVENT is required per calendar object', 'INVALID_ICALENDAR', 422);
  const event = events[0];
  const uid = oneProperty(event, 'UID', true)!;
  if (uid.value.length === 0 || uid.value.length > 512) fail('UID is invalid', 'INVALID_ICALENDAR', 422);
  const dtStart = assertDateValue(oneProperty(event, 'DTSTART', true), 'DTSTART');
  const dtEnd = assertDateValue(oneProperty(event, 'DTEND'), 'DTEND');
  const duration = oneProperty(event, 'DURATION');
  if (dtEnd && duration) fail('DTEND and DURATION cannot both be present', 'INVALID_ICALENDAR', 422);
  if (duration && !/^[-+]?P(?:\d+W|(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?)$/u.test(duration.value)) fail('DURATION is invalid', 'INVALID_ICALENDAR', 422);

  const timeZoneIds = new Set();
  const timeZoneDefinitions = new Set();
  for (const component of [root, ...root.children, ...root.children.flatMap((child: DavRecord) => child.children)]) {
    for (const property of component.properties) {
      if (property.parameters.TZID) {
        requiredPattern(property.parameters.TZID, TZID_PATTERN, 'TZID', 'INVALID_TIMEZONE');
        timeZoneIds.add(property.parameters.TZID);
      }
    }
    if (component.name === 'VTIMEZONE') {
      const zone = oneProperty(component, 'TZID', true)!;
      requiredPattern(zone.value, TZID_PATTERN, 'VTIMEZONE TZID', 'INVALID_TIMEZONE');
      if (timeZoneDefinitions.has(zone.value)) fail(`VTIMEZONE ${zone.value} is duplicated`, 'INVALID_TIMEZONE', 422);
      timeZoneDefinitions.add(zone.value);
      for (const transition of [...properties(component, 'TZOFFSETFROM'), ...properties(component, 'TZOFFSETTO')]) {
        if (!/^[+-]\d{4}$/u.test(transition.value)) fail('VTIMEZONE offset is invalid', 'INVALID_TIMEZONE', 422);
      }
    }
  }
  for (const timeZoneId of timeZoneIds) {
    if (timeZoneId !== 'UTC' && !timeZoneDefinitions.has(timeZoneId)) fail(`TZID ${timeZoneId} has no VTIMEZONE definition`, 'TIMEZONE_UNDEFINED', 422);
  }

  const organizerProperty = oneProperty(event, 'ORGANIZER');
  const attendees = properties(event, 'ATTENDEE').map((property) => parseAddress(property, 'ATTENDEE'));
  const organizer = parseAddress(organizerProperty, 'ORGANIZER');
  const sequence = oneProperty(event, 'SEQUENCE');
  if (sequence && !/^\d+$/u.test(sequence.value)) fail('SEQUENCE is invalid', 'INVALID_ICALENDAR', 422);
  const method = oneProperty(root, 'METHOD');
  if (method && !['PUBLISH', 'REQUEST', 'REPLY', 'CANCEL', 'ADD', 'REFRESH'].includes(method.value.toUpperCase())) fail('METHOD is not supported', 'UNSUPPORTED_METHOD', 422);
  return freezeObject({
    uid: uid.value,
    summary: unescapeText(oneProperty(event, 'SUMMARY')?.value ?? ''),
    description: unescapeText(oneProperty(event, 'DESCRIPTION')?.value ?? ''),
    dtStart,
    dtEnd,
    duration: duration?.value ?? null,
    timeZoneIds: freezeArray([...timeZoneIds]),
    organizer,
    attendees: freezeArray(attendees),
    method: method?.value.toUpperCase() ?? null,
    sequence: sequence ? Number(sequence.value) : 0,
    component: 'VEVENT',
  });
}

/**
 * Parse and validate a small, interoperable iCalendar subset.
 *
 * The parser intentionally validates the object boundary needed by CalDAV;
 * it is not a replacement for a full RFC 5545 recurrence engine.
 */
export function validateICalendar(icalText: unknown): Readonly<DavRecord> {
  const { root, canonical } = parseCalendarComponents(icalText);
  return freezeObject({ ...calendarMetadata(root), canonicalText: canonical });
}

export function calculateEtag({ tenantId, calendarKey, objectId, canonicalText }: DavRecord): string {
  const scopedInput = `${tenantId}\u0000${calendarKey}\u0000${objectId}\u0000${canonicalText}`;
  return `"${createHash('sha256').update(scopedInput, 'utf8').digest('hex')}"`;
}

function publicAcl(collection: DavRecord, actor: DavRecord): DavValue {
  if (actor.userId === collection.ownerUserId) {
    return freezeArray(collection.acl ? [{ delegateUserId: collection.acl.delegateUserId, permissions: freezeArray(collection.acl.permissions) }] : []);
  }
  if (collection.acl?.delegateUserId === actor.userId) return freezeArray([{ delegateUserId: collection.ownerUserId, permissions: freezeArray(collection.acl.permissions) }]);
  return freezeArray([]);
}

function publicCollection(collection: DavRecord, actor: DavRecord): Readonly<DavRecord> {
  const own = actor.userId === collection.ownerUserId;
  const permissions = own ? ['read', 'write'] : (collection.acl?.permissions ?? []);
  return freezeObject({
    calendarId: canonicalCalendarKey(collection.ownerUserId, collection.collectionId),
    collectionId: collection.collectionId,
    href: collection.href,
    tenantId: collection.tenantId,
    ownerUserId: collection.ownerUserId,
    displayName: collection.displayName,
    description: collection.description,
    timezone: collection.timezone,
    color: collection.color,
    permissions: freezeArray(permissions),
    acl: publicAcl(collection, actor),
    syncToken: collection.syncToken,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  });
}

function publicObject(collection: DavRecord, object: DavRecord, includeContent = true): Readonly<DavRecord> {
  const result: DavRecord = {
    href: `${collection.href}${encodeURIComponent(object.objectId)}`,
    calendarId: canonicalCalendarKey(collection.ownerUserId, collection.collectionId),
    objectId: object.objectId,
    tenantId: object.tenantId,
    ownerUserId: object.ownerUserId,
    uid: object.metadata.uid,
    etag: object.etag,
    metadata: object.metadata,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
  };
  if (includeContent) result.ical = object.ical;
  return freezeObject(result);
}

function permissionFor(collection: DavRecord, actor: DavRecord): Set<string> {
  if (actor.userId === collection.ownerUserId) return new Set(['read', 'write']);
  if (collection.acl?.delegateUserId === actor.userId) return new Set(collection.acl.permissions);
  return new Set();
}

function assertPermission(collection: DavRecord, actor: DavRecord, permission: string): void {
  const permissions = permissionFor(collection, actor);
  if (!permissions.has(permission)) fail(`actor is not allowed to ${permission} this calendar`, 'ACL_DENIED', 403);
}

export function collectionEtag(collection: DavRecord): string {
  return `"${createHash('sha256').update(`${collection.displayName}\u0000${collection.description}\u0000${collection.updatedAt}`, 'utf8').digest('hex')}"`;
}

/**
 * Create a deterministic, in-memory CalDAV contract double.
 *
 * A production adapter can map these operations to a DAV store without
 * changing authorization, precondition, ETag, or sync-token semantics.
 */
export function createCalDavStore({ tenantId, clock = () => new Date(), audit = null }: DavRecord = {}): Readonly<DavRecord> {
  const canonicalTenant = canonicalTenantId(tenantId);
  if (typeof clock !== 'function') fail('clock must be a function', 'INVALID_CONFIGURATION', 422);
  if (audit !== null && typeof audit !== 'function') fail('audit must be a function or null', 'INVALID_CONFIGURATION', 422);
  const collections = new Map<string, DavRecord>();
  const changes: DavRecord[] = [];
  let revision = 0;

  function now() {
    return isoDate(clock(), 'clock result');
  }

  function nextRevision() {
    revision += 1;
    return revision;
  }

  function emitAudit(eventType: string, actor: DavRecord, collection: DavRecord, details: DavRecord = {}): DavValue {
    if (typeof audit !== 'function') return null;
    const event = freezeObject({
      eventType,
      tenantId: canonicalTenant,
      actorId: actor.userId,
      calendarId: canonicalCalendarKey(collection.ownerUserId, collection.collectionId),
      ownerUserId: collection.ownerUserId,
      ...details,
    });
    audit(event);
    return event;
  }

  function resolveCollection(actor: DavValue, requestedCalendarId: DavValue): DavRecord {
    const normalizedActor = normalizeActor(actor, canonicalTenant);
    const { ownerUserId, collectionId } = splitCalendarId(requestedCalendarId);
    let collection;
    if (ownerUserId !== null) {
      collection = collections.get(canonicalCalendarKey(ownerUserId, collectionId));
    } else {
      const matches = [...collections.values()].filter((candidate) => candidate.collectionId === collectionId && permissionFor(candidate, normalizedActor).has('read'));
      if (matches.length > 1) fail('calendarId is ambiguous; use ownerUserId/calendarId', 'AMBIGUOUS_CALENDAR_ID', 409);
      collection = matches[0];
    }
    if (!collection) fail('calendar collection was not found', 'CALENDAR_NOT_FOUND', 404);
    if (collection.tenantId !== canonicalTenant) fail('cross-tenant calendar access is denied', 'CROSS_TENANT_DENIED', 403);
    assertPermission(collection, normalizedActor, 'read');
    return { actor: normalizedActor, collection };
  }

  function recordChange(collection: DavRecord, objectId: string, object: DavRecord | null, deleted: boolean): number {
    const changeRevision = nextRevision();
    changes.push({
      revision: changeRevision,
      calendarKey: canonicalCalendarKey(collection.ownerUserId, collection.collectionId),
      objectId,
      object: object ? { ...object } : null,
      deleted,
    });
    collection.syncToken = makeToken(canonicalTenant, collection.ownerUserId, collection.collectionId, changeRevision);
    collection.updatedAt = now();
    return changeRevision;
  }

  function createCalendarCollection(actor: DavValue, {
    collectionId = 'default',
    ownerUserId = actor?.userId ?? actor?.actorId,
    displayName = collectionId,
    description = '',
    timezone = 'UTC',
    color = null,
  }: DavRecord = {}): Readonly<DavRecord> {
    const normalizedActor = normalizeActor(actor, canonicalTenant);
    const owner = canonicalUserId(ownerUserId, 'ownerUserId');
    if (owner !== normalizedActor.userId) fail('an actor can create only its own calendar collection', 'ACL_DENIED', 403);
    const slug = canonicalCalendarSlug(collectionId, 'collectionId');
    const key = canonicalCalendarKey(owner, slug);
    if (collections.has(key)) fail('calendar collection already exists', 'CALENDAR_EXISTS', 409);
    if (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > 255) fail('displayName is invalid', 'INVALID_COLLECTION', 422);
    if (typeof description !== 'string' || description.length > 2_000) fail('description is invalid', 'INVALID_COLLECTION', 422);
    requiredPattern(timezone, TZID_PATTERN, 'timezone', 'INVALID_TIMEZONE');
    if (color !== null && (typeof color !== 'string' || !COLOR_PATTERN.test(color))) fail('color is invalid', 'INVALID_COLLECTION', 422);
    const timestamp = now();
    const collection = {
      tenantId: canonicalTenant,
      ownerUserId: owner,
      collectionId: slug,
      displayName: displayName.trim(),
      description,
      timezone,
      color: color?.toUpperCase() ?? null,
      href: `/dav/calendars/${encodeURIComponent(canonicalTenant)}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/`,
      createdAt: timestamp,
      updatedAt: timestamp,
      syncToken: makeToken(canonicalTenant, owner, slug, revision),
      acl: null,
      objects: new Map<string, DavRecord>(),
    };
    collections.set(key, collection);
    emitAudit('caldav.collection.created', normalizedActor, collection, {
      displayName: collection.displayName,
      timezone: collection.timezone,
    });
    return publicCollection(collection, normalizedActor);
  }

  function listCalendarCollections(actor: DavValue): readonly Readonly<DavRecord>[] {
    const normalizedActor = normalizeActor(actor, canonicalTenant);
    return freezeArray([...collections.values()]
      .filter((collection) => permissionFor(collection, normalizedActor).has('read'))
      .map((collection) => publicCollection(collection, normalizedActor)));
  }

  function getCalendarCollection(actor: DavValue, requestedCalendarId: DavValue): Readonly<DavRecord> {
    const { actor: normalizedActor, collection } = resolveCollection(actor, requestedCalendarId);
    return publicCollection(collection, normalizedActor);
  }

  function setCalendarAcl(actor: DavValue, { calendarId, delegateUserId, permissions = ['read'] }: DavRecord = {}): Readonly<DavRecord> {
    const { actor: normalizedActor, collection } = resolveCollection(actor, calendarId);
    if (normalizedActor.userId !== collection.ownerUserId) fail('only the calendar owner may change its ACL', 'ACL_OWNER_REQUIRED', 403);
    const delegate = canonicalUserId(delegateUserId, 'delegateUserId');
    if (delegate === collection.ownerUserId) fail('a calendar cannot delegate to itself', 'INVALID_ACL', 422);
    if (!Array.isArray(permissions) || permissions.length === 0 || permissions.some((permission) => !ACL_PERMISSIONS.has(permission))) fail('permissions must contain read and/or write', 'INVALID_ACL', 422);
    const unique = [...new Set(permissions)];
    if (unique.includes('write') && !unique.includes('read')) unique.unshift('read');
    collection.acl = { delegateUserId: delegate, permissions: unique };
    collection.updatedAt = now();
    emitAudit('caldav.acl.updated', normalizedActor, collection, {
      delegateUserId: delegate,
      permissions: freezeArray(unique),
    });
    return publicCollection(collection, normalizedActor);
  }

  function revokeCalendarAcl(actor: DavValue, { calendarId }: DavRecord = {}): Readonly<DavRecord> {
    const { actor: normalizedActor, collection } = resolveCollection(actor, calendarId);
    if (normalizedActor.userId !== collection.ownerUserId) fail('only the calendar owner may change its ACL', 'ACL_OWNER_REQUIRED', 403);
    collection.acl = null;
    collection.updatedAt = now();
    emitAudit('caldav.acl.revoked', normalizedActor, collection);
    return publicCollection(collection, normalizedActor);
  }

  function getCalendarEtag(actor: DavValue, requestedCalendarId: DavValue): Readonly<DavRecord> {
    const { actor: normalizedActor, collection } = resolveCollection(actor, requestedCalendarId);
    return freezeObject({ calendarId: canonicalCalendarKey(collection.ownerUserId, collection.collectionId), etag: collectionEtag(collection), actor: normalizedActor.userId });
  }

  function createCalendarObject(actor: DavValue, { calendarId, objectId, ical, ifNoneMatch }: DavRecord = {}): Readonly<DavRecord> {
    const { actor: normalizedActor, collection } = resolveCollection(actor, calendarId);
    assertPermission(collection, normalizedActor, 'write');
    const id = canonicalCalendarSlug(objectId, 'objectId');
    const existing = collection.objects.get(id);
    if (existing) {
      if (ifNoneMatch === '*') fail('calendar object already exists', 'PRECONDITION_FAILED', 412);
      fail('calendar object already exists', 'OBJECT_EXISTS', 409);
    }
    if (ifNoneMatch !== undefined && ifNoneMatch !== '*') fail('If-None-Match must be * for a conditional create', 'INVALID_PRECONDITION', 400);
    const metadata = validateICalendar(ical);
    const timestamp = now();
    const object = {
      tenantId: canonicalTenant,
      ownerUserId: collection.ownerUserId,
      objectId: id,
      uid: metadata.uid,
      ical: metadata.canonicalText,
      metadata,
      etag: calculateEtag({ tenantId: canonicalTenant, calendarKey: canonicalCalendarKey(collection.ownerUserId, collection.collectionId), objectId: id, canonicalText: metadata.canonicalText }),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    collection.objects.set(id, object);
    recordChange(collection, id, object, false);
    emitAudit('caldav.object.created', normalizedActor, collection, {
      objectId: id,
      uid: metadata.uid,
      etag: object.etag,
      sizeBytes: Buffer.byteLength(object.ical, 'utf8'),
    });
    return publicObject(collection, object);
  }

  function getCalendarObject(actor: DavValue, { calendarId, objectId }: DavRecord = {}): Readonly<DavRecord> {
    const { collection } = resolveCollection(actor, calendarId);
    const id = canonicalCalendarSlug(objectId, 'objectId');
    const object = collection.objects.get(id);
    if (!object) fail('calendar object was not found', 'OBJECT_NOT_FOUND', 404);
    return publicObject(collection, object);
  }

  function updateCalendarObject(actor: DavValue, { calendarId, objectId, ical, ifMatch }: DavRecord = {}): Readonly<DavRecord> {
    const { actor: normalizedActor, collection } = resolveCollection(actor, calendarId);
    assertPermission(collection, normalizedActor, 'write');
    const id = canonicalCalendarSlug(objectId, 'objectId');
    const existing = collection.objects.get(id);
    if (!existing) fail('calendar object was not found', 'OBJECT_NOT_FOUND', 404);
    if (ifMatch === undefined) fail('If-Match is required for update', 'PRECONDITION_REQUIRED', 428);
    if (ifMatch !== '*' && ifMatch !== existing.etag) fail('If-Match does not match the current ETag', 'PRECONDITION_FAILED', 412);
    const metadata = validateICalendar(ical);
    if (metadata.uid !== existing.metadata.uid) fail('UID cannot change during an update', 'UID_IMMUTABLE', 409);
    const updated = {
      ...existing,
      ical: metadata.canonicalText,
      metadata,
      etag: calculateEtag({ tenantId: canonicalTenant, calendarKey: canonicalCalendarKey(collection.ownerUserId, collection.collectionId), objectId: id, canonicalText: metadata.canonicalText }),
      updatedAt: now(),
    };
    collection.objects.set(id, updated);
    recordChange(collection, id, updated, false);
    emitAudit('caldav.object.updated', normalizedActor, collection, {
      objectId: id,
      uid: metadata.uid,
      etag: updated.etag,
      sizeBytes: Buffer.byteLength(updated.ical, 'utf8'),
    });
    return publicObject(collection, updated);
  }

  function deleteCalendarObject(actor: DavValue, { calendarId, objectId, ifMatch }: DavRecord = {}): Readonly<DavRecord> {
    const { actor: normalizedActor, collection } = resolveCollection(actor, calendarId);
    assertPermission(collection, normalizedActor, 'write');
    const id = canonicalCalendarSlug(objectId, 'objectId');
    const existing = collection.objects.get(id);
    if (!existing) fail('calendar object was not found', 'OBJECT_NOT_FOUND', 404);
    if (ifMatch === undefined) fail('If-Match is required for delete', 'PRECONDITION_REQUIRED', 428);
    if (ifMatch !== '*' && ifMatch !== existing.etag) fail('If-Match does not match the current ETag', 'PRECONDITION_FAILED', 412);
    collection.objects.delete(id);
    recordChange(collection, id, null, true);
    emitAudit('caldav.object.deleted', normalizedActor, collection, {
      objectId: id,
      uid: existing.metadata.uid,
      previousEtag: existing.etag,
    });
    return freezeObject({ deleted: true, calendarId: canonicalCalendarKey(collection.ownerUserId, collection.collectionId), objectId: id, previousEtag: existing.etag, syncToken: collection.syncToken });
  }

  function listCalendarObjects(actor: DavValue, { calendarId, syncToken }: DavRecord = {}): Readonly<DavRecord> {
    const { collection } = resolveCollection(actor, calendarId);
    const calendarKey = canonicalCalendarKey(collection.ownerUserId, collection.collectionId);
    const since = decodeToken(syncToken, {
      tenantId: canonicalTenant,
      ownerUserId: collection.ownerUserId,
      collectionId: collection.collectionId,
    });
    if (since > revision) fail('syncToken is from the future', 'INVALID_SYNC_TOKEN', 400);
    const changed = new Map<string, DavRecord>();
    if (syncToken === undefined || syncToken === null) {
      for (const object of collection.objects.values()) changed.set(object.objectId, { object, deleted: false });
    } else {
      for (const change of changes) {
        if (change.revision > since && change.calendarKey === calendarKey) changed.set(change.objectId, { object: change.object, deleted: change.deleted });
      }
    }
    const objects: Readonly<DavRecord>[] = [];
    const deletedObjectIds: string[] = [];
    for (const [objectId, change] of changed) {
      if (change.deleted) deletedObjectIds.push(objectId);
      else if (change.object) objects.push(publicObject(collection, change.object));
    }
    return freezeObject({
      calendarId: calendarKey,
      objects: freezeArray(objects),
      deletedObjectIds: freezeArray(deletedObjectIds),
      syncToken: makeToken(canonicalTenant, collection.ownerUserId, collection.collectionId, revision),
    });
  }

  function deleteCalendarCollection(actor: DavValue, { calendarId, ifMatch }: DavRecord = {}): Readonly<DavRecord> {
    const { actor: normalizedActor, collection } = resolveCollection(actor, calendarId);
    if (normalizedActor.userId !== collection.ownerUserId) fail('only the calendar owner may delete a collection', 'ACL_OWNER_REQUIRED', 403);
    if (collection.objects.size > 0) fail('calendar collection is not empty', 'CALENDAR_NOT_EMPTY', 409);
    if (ifMatch !== undefined && ifMatch !== '*' && ifMatch !== collectionEtag(collection)) fail('If-Match does not match the collection ETag', 'PRECONDITION_FAILED', 412);
    collections.delete(canonicalCalendarKey(collection.ownerUserId, collection.collectionId));
    return freezeObject({ deleted: true, calendarId: canonicalCalendarKey(collection.ownerUserId, collection.collectionId) });
  }

  return freezeObject({
    tenantId: canonicalTenant,
    createCalendarCollection,
    listCalendarCollections,
    getCalendarCollection,
    setCalendarAcl,
    revokeCalendarAcl,
    getCalendarEtag,
    createCalendarObject,
    getCalendarObject,
    updateCalendarObject,
    deleteCalendarObject,
    listCalendarObjects,
    deleteCalendarCollection,
    makeSyncToken: ({ calendarId, revision: requestedRevision = revision }: DavRecord = {}) => {
      const { ownerUserId, collectionId } = splitCalendarId(calendarId);
      if (ownerUserId === null) fail('calendarId must include ownerUserId for a scoped sync token', 'INVALID_CALENDAR_ID', 422);
      if (!Number.isSafeInteger(requestedRevision) || requestedRevision < 0 || requestedRevision > revision) fail('sync token revision is invalid', 'INVALID_SYNC_TOKEN', 400);
      return makeToken(canonicalTenant, ownerUserId, collectionId, requestedRevision);
    },
  });
}

export const calDavContract = Object.freeze({
  calendarIdPattern: CALENDAR_ID_PATTERN,
  userIdPattern: USER_ID_PATTERN,
  tenantIdPattern: TENANT_ID_PATTERN,
  tzidPattern: TZID_PATTERN,
  colorPattern: COLOR_PATTERN,
  aclPermissions: freezeArray([...ACL_PERMISSIONS]),
  supportedComponents: freezeArray([...SUPPORTED_COMPONENTS]),
});
