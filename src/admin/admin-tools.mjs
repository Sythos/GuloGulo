// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { assertAdminActor, authorize, authorizationError } from './rbac.mjs';

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){1,5}$/u;
const REASON_PATTERN = /^[A-Za-z0-9_.: -]{1,256}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_METADATA_KEYS = new Set([
  'action',
  'changedFields',
  'correlationId',
  'count',
  'queueId',
  'reason',
  'requestId',
  'resourceId',
  'sizeBytes',
  'sourceNetwork',
  'state',
  'statusCode',
  'subjectId',
  'targetUserId',
  'userAgent',
]);
const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|credential|private|secret|password|passphrase|token|body|content|message|payload|attachment|raw|dsn|key)/iu;
const RESULT_VALUES = new Set(['success', 'failure', 'denied', 'deferred']);

function adminToolsError(message, code = 'ADMIN_TOOLS_ERROR', status = 403) {
  const error = new Error(`Admin tools error: ${message}`);
  error.name = 'AdminToolsError';
  error.code = code;
  error.status = status;
  return error;
}

function cloneValue(value, field) {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value))) return value;
  if (typeof value === 'string' && value.length <= 256 && !/[\r\n]/u.test(value)) return value;
  if (Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/u.test(item))) {
    return Object.freeze([...value]);
  }
  throw adminToolsError(`${field} contains an unsafe value`, 'UNSAFE_AUDIT_DATA', 400);
}

function normalizeMetadata(metadata = {}) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw adminToolsError('metadata must be an object', 'INVALID_AUDIT_DATA', 400);
  }
  const normalized = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_METADATA_KEYS.has(key) || SENSITIVE_KEY_PATTERN.test(key)) {
      throw adminToolsError('metadata contains a disallowed field', 'SENSITIVE_AUDIT_DATA', 400);
    }
    normalized[key] = cloneValue(value, key);
  }
  return Object.freeze(normalized);
}

function normalizeEventType(value) {
  if (typeof value !== 'string' || !EVENT_TYPE_PATTERN.test(value) || value.length > 96) {
    throw adminToolsError('eventType is invalid', 'INVALID_AUDIT_DATA', 400);
  }
  return value;
}

function normalizeReason(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !REASON_PATTERN.test(value.trim())) {
    throw adminToolsError('reason is invalid', 'INVALID_AUDIT_DATA', 400);
  }
  return value.trim();
}

function normalizeRequestId(value, field = 'requestId') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    throw adminToolsError(`${field} is invalid`, 'INVALID_AUDIT_DATA', 400);
  }
  return value;
}

function normalizeTimestamp(value, field = 'occurredAt') {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw adminToolsError(`${field} is invalid`, 'INVALID_AUDIT_DATA', 400);
  return date;
}

function cloneAuditEvent(event) {
  return Object.freeze({
    schemaVersion: 1,
    eventType: event.eventType,
    tenantId: event.tenantId,
    actorId: event.actorId,
    actorRole: event.actorRole,
    subjectId: event.subjectId,
    resourceId: event.resourceId,
    action: event.action,
    result: event.result,
    reason: event.reason,
    requestId: event.requestId,
    correlationId: event.correlationId,
    occurredAt: event.occurredAt.toISOString(),
    metadata: Object.freeze({ ...event.metadata }),
  });
}

/**
 * Metadata-only audit ledger. It intentionally rejects message bodies,
 * credentials, tokens, and arbitrary nested payloads before they can reach a
 * durable audit adapter or a tenant/master log view.
 */
export function createAuditStore({ clock = () => new Date(), maxEvents = 10_000 } = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1_000_000) {
    throw adminToolsError('maxEvents is invalid', 'INVALID_CONFIGURATION', 500);
  }
  const events = [];

  function record(actor, {
    eventType,
    subjectId = null,
    resourceId = null,
    action = null,
    result = 'success',
    reason = null,
    requestId = null,
    correlationId = null,
    occurredAt = undefined,
    metadata = {},
  } = {}) {
    const canonical = assertAdminActor(actor);
    const normalizedType = normalizeEventType(eventType);
    if (!RESULT_VALUES.has(result)) throw adminToolsError('result is invalid', 'INVALID_AUDIT_DATA', 400);
    if (subjectId !== null && (typeof subjectId !== 'string' || subjectId.length > 128)) throw adminToolsError('subjectId is invalid', 'INVALID_AUDIT_DATA', 400);
    if (resourceId !== null && (typeof resourceId !== 'string' || resourceId.length > 128)) throw adminToolsError('resourceId is invalid', 'INVALID_AUDIT_DATA', 400);
    if (action !== null && (typeof action !== 'string' || !/^[a-z][a-z0-9_.:-]{0,95}$/u.test(action))) throw adminToolsError('action is invalid', 'INVALID_AUDIT_DATA', 400);
    const timestamp = normalizeTimestamp(occurredAt ?? clock());
    const event = {
      eventType: normalizedType,
      tenantId: canonical.tenantId,
      actorId: canonical.actorId,
      actorRole: canonical.role,
      subjectId,
      resourceId,
      action,
      result,
      reason: normalizeReason(reason),
      requestId: normalizeRequestId(requestId),
      correlationId: normalizeRequestId(correlationId, 'correlationId'),
      occurredAt: timestamp,
      metadata: normalizeMetadata(metadata),
    };
    events.push(event);
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
    return cloneAuditEvent(event);
  }

  function view(actor, {
    eventType = null,
    subjectUserId = null,
    limit = 100,
    policy = {},
  } = {}) {
    const canonical = assertAdminActor(actor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw adminToolsError('limit is invalid', 'INVALID_LIMIT', 400);
    const requestedSubject = subjectUserId === null ? null : String(subjectUserId);
    if (canonical.role === 'user') {
      if (requestedSubject !== null && requestedSubject !== canonical.userId) {
        throw authorizationError('audit subject is outside the user scope', 'USER_SCOPE_DENIED');
      }
      authorize(canonical, { permission: 'audit.read.self', targetUserId: canonical.userId, resource: 'audit' });
    } else {
      authorize(canonical, {
        permission: 'audit.read',
        resource: 'audit',
        policy,
      });
    }
    if (eventType !== null) normalizeEventType(eventType);
    const filtered = events
      .filter((event) => event.tenantId === canonical.tenantId)
      .filter((event) => eventType === null || event.eventType === eventType)
      .filter((event) => {
        if (canonical.role !== 'user') return requestedSubject === null || event.subjectId === requestedSubject;
        return event.actorId === canonical.actorId || event.subjectId === canonical.userId;
      })
      .slice(-limit)
      .reverse()
      .map(cloneAuditEvent);
    return Object.freeze(filtered);
  }

  function size() {
    return events.length;
  }

  return Object.freeze({ record, view, size });
}

function sanitizeQueueEntry(entry) {
  if (entry === null || typeof entry !== 'object') throw adminToolsError('queue adapter returned invalid metadata', 'QUEUE_ADAPTER_INVALID', 500);
  const allowed = [
    'queueId',
    'tenantId',
    'sender',
    'recipients',
    'sizeBytes',
    'state',
    'attempts',
    'createdAt',
    'updatedAt',
    'nextAttemptAt',
    'reason',
  ];
  const value = {};
  for (const key of allowed) {
    if (entry[key] !== undefined) value[key] = Array.isArray(entry[key]) ? Object.freeze([...entry[key]]) : entry[key];
  }
  return Object.freeze(value);
}

/**
 * RBAC wrapper for operational metadata. Queue views never expose messageRef
 * or body data. Queue actions are only authorized here; execution stays in a
 * separately audited provider adapter and is not part of the read-only API or
 * MCP surface.
 */
export function createAdminTools({ queue = null, audit = createAuditStore(), masterLogAccess = false } = {}) {
  function viewQueue(actor, options = {}) {
    const canonical = assertAdminActor(actor);
    authorize(canonical, { permission: 'queue.read', resource: 'mail_queue' });
    if (queue === null || typeof queue.view !== 'function') throw adminToolsError('queue adapter is not configured', 'QUEUE_UNAVAILABLE', 503);
    const entries = queue.view(canonical, options);
    if (!Array.isArray(entries)) throw adminToolsError('queue adapter returned invalid data', 'QUEUE_ADAPTER_INVALID', 500);
    return Object.freeze(entries.map(sanitizeQueueEntry));
  }

  function authorizeQueueAction(actor, { action = 'retry', queueId = null } = {}) {
    const canonical = assertAdminActor(actor);
    authorize(canonical, { permission: 'queue.action', resource: 'mail_queue' });
    if (typeof action !== 'string' || !/^[a-z][a-z0-9_.:-]{0,63}$/u.test(action)) throw adminToolsError('queue action is invalid', 'INVALID_ACTION', 400);
    if (queueId !== null && (typeof queueId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(queueId))) throw adminToolsError('queueId is invalid', 'INVALID_QUEUE_ID', 400);
    return Object.freeze({ allowed: true, tenantId: canonical.tenantId, actorId: canonical.actorId, action, queueId });
  }

  function viewAudit(actor, options = {}) {
    if (audit === null || typeof audit.view !== 'function') throw adminToolsError('audit adapter is not configured', 'AUDIT_UNAVAILABLE', 503);
    const canonical = assertAdminActor(actor);
    return audit.view(canonical, { ...options, policy: { ...(options.policy ?? {}), masterLogAccess } });
  }

  function recordAudit(actor, event) {
    if (audit === null || typeof audit.record !== 'function') throw adminToolsError('audit adapter is not configured', 'AUDIT_UNAVAILABLE', 503);
    return audit.record(actor, event);
  }

  return Object.freeze({ viewQueue, authorizeQueueAction, viewAudit, recordAudit, audit });
}

export { adminToolsError, normalizeMetadata, sanitizeQueueEntry };
