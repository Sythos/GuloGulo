// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

const SOURCES = new Set<RealtimeSource>(['sse', 'websocket', 'imap-idle']);
const EVENT_TYPES = new Set<RealtimeEventType>(['mail.changed', 'calendar.changed', 'contacts.changed', 'system.changed']);
const SAFE_DATA_KEYS = new Set(['mailbox', 'uidNext', 'messageId', 'folder', 'count', 'operation', 'resourceId', 'resourceType', 'calendarId', 'contactId', 'changedAt', 'lastModified', 'state', 'status', 'reason', 'sequence']);
const SENSITIVE_KEY = /^(?:body|html|text|content|raw|payload|source|attachment|headers?)$/iu;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

export type RealtimeSource = 'sse' | 'websocket' | 'imap-idle';
export type RealtimeEventType = 'mail.changed' | 'calendar.changed' | 'contacts.changed' | 'system.changed';
export type SafeMetadata = string | number | boolean | null | readonly SafeMetadata[] | SafeMetadataObject;
export interface SafeMetadataObject { readonly [key: string]: SafeMetadata }
export interface RealtimeContext { tenantId?: string; userId?: string | null; clock?: () => Date }
export interface NormalizedRealtimeEvent {
  readonly version: 1; readonly eventId: string; readonly source: RealtimeSource; readonly type: RealtimeEventType;
  readonly tenantId: string; readonly userId: string | null; readonly resource: string | null; readonly sequence: number | null;
  readonly occurredAt: string; readonly data: SafeMetadataObject;
  readonly coalescedCount?: number; readonly firstEventId?: string;
}

export class RealtimeEventError extends Error {
  readonly code: string;
  constructor(message: string, code = 'REALTIME_EVENT_ERROR') { super(`Realtime event error: ${message}`); this.name = 'RealtimeEventError'; this.code = code; }
}

function realtimeError(message: string, code = 'REALTIME_EVENT_ERROR'): RealtimeEventError { return new RealtimeEventError(message, code); }
function token(value: unknown, field: string, { required = true, max = 128 }: { required?: boolean; max?: number } = {}): string | null {
  if (value === null || value === undefined || value === '') { if (!required) return null; throw realtimeError(`${field} is required`, 'INVALID_EVENT'); }
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value) || value.length > max) throw realtimeError(`${field} is invalid`, 'INVALID_EVENT');
  return value;
}

function parseObject(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value) as unknown; } catch { throw realtimeError('event payload is not valid JSON', 'INVALID_EVENT_PAYLOAD'); } }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw realtimeError('event payload must be an object', 'INVALID_EVENT_PAYLOAD');
  return parsed as Record<string, unknown>;
}

function safeMetadata(value: unknown, depth = 0): SafeMetadata {
  if (depth > 2 || value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 512);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return Object.freeze(value.slice(0, 32).map((item) => safeMetadata(item, depth + 1)));
  if (typeof value !== 'object') return null;
  const output: Record<string, SafeMetadata> = {};
  for (const [key, entry] of Object.entries(value)) if (SAFE_DATA_KEYS.has(key) && !SENSITIVE_KEY.test(key)) output[key] = safeMetadata(entry, depth + 1);
  return Object.freeze(output);
}

function safeEventData(value: unknown): SafeMetadataObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  const sanitized = safeMetadata(value);
  return sanitized !== null && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized as SafeMetadataObject : Object.freeze({});
}

function validDate(value: unknown, fallback: () => Date): string {
  const date = value === undefined || value === null ? fallback() : new Date(value as string | number | Date);
  if (Number.isNaN(date.getTime())) throw realtimeError('event timestamp is invalid', 'INVALID_EVENT');
  return date.toISOString();
}

export function normalizeRealtimeEvent(input: unknown, { source, tenantId, userId = null, clock = () => new Date() }: RealtimeContext & { source?: RealtimeSource } = {}): NormalizedRealtimeEvent {
  if (source === undefined || !SOURCES.has(source)) throw realtimeError('event source is unsupported', 'INVALID_EVENT');
  const canonicalTenantId = token(tenantId, 'tenantId')!;
  const canonicalUserId = token(userId, 'userId', { required: false });
  const payload = parseObject(input);
  const eventTenant = payload.tenantId ?? canonicalTenantId;
  if (eventTenant !== canonicalTenantId) throw realtimeError('event tenant does not match the subscription', 'TENANT_MISMATCH');
  const eventUser = payload.userId ?? canonicalUserId;
  if (eventUser !== canonicalUserId) throw realtimeError('event user does not match the subscription', 'USER_MISMATCH');
  const typeValue = payload.type ?? (source === 'imap-idle' ? 'mail.changed' : payload.event);
  if (typeof typeValue !== 'string' || !EVENT_TYPES.has(typeValue as RealtimeEventType)) throw realtimeError('event type is unsupported', 'INVALID_EVENT');
  const sequence = payload.sequence === undefined ? null : payload.sequence;
  if (sequence !== null && (!Number.isSafeInteger(sequence) || (sequence as number) < 1)) throw realtimeError('event sequence is invalid', 'INVALID_EVENT');
  const occurredAt = validDate(payload.occurredAt, clock);
  const eventId = token(payload.eventId ?? payload.id, 'eventId', { required: false }) ?? `${source}:${canonicalTenantId}:${canonicalUserId ?? 'tenant'}:${sequence ?? occurredAt}`;
  const resource = token(payload.resource ?? payload.mailbox ?? payload.resourceId, 'resource', { required: false });
  return Object.freeze({
    version: 1, eventId, source, type: typeValue as RealtimeEventType, tenantId: canonicalTenantId, userId: canonicalUserId,
    resource, sequence: sequence as number | null, occurredAt, data: safeEventData(payload.data ?? payload.details ?? payload),
  });
}

export function normalizeSseEvent(frame: unknown, context: RealtimeContext = {}): NormalizedRealtimeEvent {
  const record = frame !== null && typeof frame === 'object' ? frame as Record<string, unknown> : null;
  const parsed = parseObject(record?.data ?? frame);
  const payload = { ...parsed };
  if (record?.id !== undefined && payload.id === undefined) payload.id = record.id;
  if (record?.event !== undefined && payload.type === undefined) payload.type = record.event;
  return normalizeRealtimeEvent(payload, { ...context, source: 'sse' });
}

export function normalizeWebSocketEvent(frame: unknown, context: RealtimeContext = {}): NormalizedRealtimeEvent { return normalizeRealtimeEvent(parseObject(frame), { ...context, source: 'websocket' }); }

export function normalizeImapIdleEvent(frame: unknown, context: RealtimeContext = {}): NormalizedRealtimeEvent {
  const record = parseObject(frame);
  return normalizeRealtimeEvent({ ...record, type: 'mail.changed', resource: record.mailbox ?? 'INBOX', data: { mailbox: record.mailbox ?? 'INBOX', uidNext: record.uidNext ?? null, sequence: record.sequence ?? null, operation: record.kind ?? 'exists' } }, { ...context, source: 'imap-idle' });
}

export function createEventCoalescer({ windowMs = 250, maxWaitMs = 2_000, clock = () => Date.now(), onFlush = () => undefined }: { windowMs?: number; maxWaitMs?: number; clock?: () => number; onFlush?: (events: readonly NormalizedRealtimeEvent[]) => void } = {}) {
  if (!Number.isFinite(windowMs) || windowMs < 0 || !Number.isFinite(maxWaitMs) || maxWaitMs < windowMs) throw realtimeError('coalescing windows are invalid', 'INVALID_CONFIGURATION');
  const pending = new Map<string, NormalizedRealtimeEvent>();
  const seen = new Set<string>();
  let windowTimer: NodeJS.Timeout | null = null;
  let maxTimer: NodeJS.Timeout | null = null;
  let firstPendingAt: number | null = null;

  function flush(): readonly NormalizedRealtimeEvent[] {
    if (windowTimer) clearTimeout(windowTimer);
    if (maxTimer) clearTimeout(maxTimer);
    windowTimer = null; maxTimer = null; firstPendingAt = null;
    const events = Object.freeze([...pending.values()].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)));
    pending.clear();
    if (events.length > 0) onFlush(events);
    return events;
  }
  function schedule(): void {
    if (windowTimer) clearTimeout(windowTimer);
    windowTimer = setTimeout(flush, windowMs); windowTimer.unref();
    if (!maxTimer) { maxTimer = setTimeout(flush, maxWaitMs); maxTimer.unref(); }
  }
  function push(event: NormalizedRealtimeEvent) {
    if (!event?.eventId) throw realtimeError('normalized event is required', 'INVALID_EVENT');
    if (seen.has(event.eventId)) return Object.freeze({ accepted: false, reason: 'duplicate' as const, pending: pending.size });
    seen.add(event.eventId);
    if (seen.size > 2048) { const oldest = seen.values().next().value as string | undefined; if (oldest) seen.delete(oldest); }
    const key = `${event.tenantId}/${event.userId ?? '-'}/${event.type}/${event.resource ?? '-'}`;
    const previous = pending.get(key);
    pending.set(key, Object.freeze(previous ? { ...event, coalescedCount: (previous.coalescedCount ?? 1) + 1, firstEventId: previous.firstEventId ?? previous.eventId, sequence: event.sequence ?? previous.sequence } : { ...event, coalescedCount: 1, firstEventId: event.eventId }));
    if (firstPendingAt === null) firstPendingAt = clock();
    schedule();
    return Object.freeze({ accepted: true, coalesced: Boolean(previous), pending: pending.size });
  }
  function close(): void { flush(); }
  return Object.freeze({ push, flush, close, pending: () => pending.size });
}

export { realtimeError };
