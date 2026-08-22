// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

const SOURCES = new Set(['sse', 'websocket', 'imap-idle']);
const EVENT_TYPES = new Set(['mail.changed', 'calendar.changed', 'contacts.changed', 'system.changed']);
const SAFE_DATA_KEYS = new Set([
  'mailbox', 'uidNext', 'messageId', 'folder', 'count', 'operation', 'resourceId', 'resourceType',
  'calendarId', 'contactId', 'changedAt', 'lastModified', 'state', 'status', 'reason', 'sequence',
]);
const SENSITIVE_KEY = /^(?:body|html|text|content|raw|payload|source|attachment|headers?)$/iu;

function realtimeError(message, code = 'REALTIME_EVENT_ERROR') {
  const error = new Error(`Realtime event error: ${message}`);
  error.code = code;
  return error;
}

function token(value, field, { required = true, max = 128 } = {}) {
  if (value === null || value === undefined || value === '') {
    if (!required) return null;
    throw realtimeError(`${field} is required`, 'INVALID_EVENT');
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(value) || value.length > max) throw realtimeError(`${field} is invalid`, 'INVALID_EVENT');
  return value;
}

function parseObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { throw realtimeError('event payload is not valid JSON', 'INVALID_EVENT_PAYLOAD'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw realtimeError('event payload must be an object', 'INVALID_EVENT_PAYLOAD');
  return value;
}

function safeMetadata(value, depth = 0) {
  if (depth > 2 || value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 512);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => safeMetadata(item, depth + 1));
  if (typeof value !== 'object') return null;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!SAFE_DATA_KEYS.has(key) || SENSITIVE_KEY.test(key)) continue;
    output[key] = safeMetadata(entry, depth + 1);
  }
  return output;
}

function safeEventData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const sanitized = safeMetadata(value);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : {};
}

function validDate(value, fallback) {
  if (value === undefined || value === null) return fallback().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw realtimeError('event timestamp is invalid', 'INVALID_EVENT');
  return date.toISOString();
}

/** Normalize server-published events into one tenant-scoped, content-free envelope. */
export function normalizeRealtimeEvent(input, {
  source,
  tenantId,
  userId,
  clock = () => new Date(),
} = {}) {
  if (!SOURCES.has(source)) throw realtimeError('event source is unsupported', 'INVALID_EVENT');
  const payload = parseObject(input);
  const eventTenant = payload.tenantId ?? tenantId;
  if (eventTenant !== tenantId) throw realtimeError('event tenant does not match the subscription', 'TENANT_MISMATCH');
  const eventUser = payload.userId ?? userId;
  if (eventUser !== userId) throw realtimeError('event user does not match the subscription', 'USER_MISMATCH');
  const type = payload.type ?? (source === 'imap-idle' ? 'mail.changed' : payload.event);
  if (!EVENT_TYPES.has(type)) throw realtimeError('event type is unsupported', 'INVALID_EVENT');
  const sequence = payload.sequence === undefined ? null : payload.sequence;
  if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 1)) throw realtimeError('event sequence is invalid', 'INVALID_EVENT');
  const eventId = token(payload.eventId ?? payload.id, 'eventId', { required: false }) ?? `${source}:${tenantId}:${userId ?? 'tenant'}:${sequence ?? validDate(undefined, clock)}`;
  const data = safeEventData(payload.data ?? payload.details ?? payload);
  const resource = token(payload.resource ?? payload.mailbox ?? payload.resourceId, 'resource', { required: false });
  const normalized = {
    version: 1,
    eventId,
    source,
    type,
    tenantId,
    userId: userId ?? null,
    resource,
    sequence,
    occurredAt: validDate(payload.occurredAt, clock),
    data: Object.freeze(data ?? {}),
  };
  return Object.freeze(normalized);
}

export function normalizeSseEvent(frame, context = {}) {
  const parsed = parseObject(frame?.data ?? frame);
  const payload = { ...parsed };
  if (frame && typeof frame === 'object' && frame.id !== undefined && payload.id === undefined) payload.id = frame.id;
  if (frame && typeof frame === 'object' && frame.event !== undefined && payload.type === undefined) payload.type = frame.event;
  return normalizeRealtimeEvent(payload, { ...context, source: 'sse' });
}

export function normalizeWebSocketEvent(frame, context = {}) {
  return normalizeRealtimeEvent(parseObject(frame), { ...context, source: 'websocket' });
}

export function normalizeImapIdleEvent(frame, context = {}) {
  return normalizeRealtimeEvent({
    ...frame,
    type: 'mail.changed',
    resource: frame.mailbox ?? 'INBOX',
    data: {
      mailbox: frame.mailbox ?? 'INBOX',
      uidNext: frame.uidNext ?? null,
      sequence: frame.sequence ?? null,
      operation: frame.kind ?? 'exists',
    },
  }, { ...context, source: 'imap-idle' });
}

/** Coalesce bursts from SSE/WebSocket/IMAP IDLE without polling or unbounded timers. */
export function createEventCoalescer({ windowMs = 250, maxWaitMs = 2_000, clock = () => Date.now(), onFlush = () => {} } = {}) {
  if (!Number.isFinite(windowMs) || windowMs < 0 || !Number.isFinite(maxWaitMs) || maxWaitMs < windowMs) throw realtimeError('coalescing windows are invalid', 'INVALID_CONFIGURATION');
  const pending = new Map();
  const seen = new Set();
  let windowTimer = null;
  let maxTimer = null;
  let firstPendingAt = null;

  function schedule() {
    if (windowTimer !== null) clearTimeout(windowTimer);
    windowTimer = setTimeout(() => flush(), windowMs);
    windowTimer.unref?.();
    if (maxTimer === null) {
      maxTimer = setTimeout(() => flush(), maxWaitMs);
      maxTimer.unref?.();
    }
  }

  function keyOf(event) {
    return `${event.tenantId}/${event.userId ?? '-'}/${event.type}/${event.resource ?? '-'}`;
  }

  function push(event) {
    if (!event || typeof event !== 'object' || !event.eventId) throw realtimeError('normalized event is required', 'INVALID_EVENT');
    if (seen.has(event.eventId)) return Object.freeze({ accepted: false, reason: 'duplicate', pending: pending.size });
    seen.add(event.eventId);
    if (seen.size > 2048) seen.delete(seen.values().next().value);
    const key = keyOf(event);
    const previous = pending.get(key);
    if (previous) {
      pending.set(key, Object.freeze({
        ...event,
        coalescedCount: (previous.coalescedCount ?? 1) + 1,
        firstEventId: previous.firstEventId ?? previous.eventId,
        sequence: event.sequence ?? previous.sequence,
      }));
    } else {
      pending.set(key, Object.freeze({ ...event, coalescedCount: 1, firstEventId: event.eventId }));
    }
    if (firstPendingAt === null) firstPendingAt = clock();
    schedule();
    return Object.freeze({ accepted: true, coalesced: Boolean(previous), pending: pending.size });
  }

  function flush() {
    if (windowTimer !== null) clearTimeout(windowTimer);
    if (maxTimer !== null) clearTimeout(maxTimer);
    windowTimer = null;
    maxTimer = null;
    firstPendingAt = null;
    const events = Object.freeze([...pending.values()].sort((left, right) => (left.occurredAt < right.occurredAt ? -1 : left.occurredAt > right.occurredAt ? 1 : 0)));
    pending.clear();
    if (events.length > 0) onFlush(events);
    return events;
  }

  function close() {
    flush();
  }

  return Object.freeze({ push, flush, close, pending: () => pending.size });
}

export { realtimeError };
