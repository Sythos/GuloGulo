// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { Buffer } from 'node:buffer';

import { sanitizeLogValue } from '../../runtime/logger.ts';

export interface StructuredEventOptions {
  service?: string; event?: string; level?: string; timestamp?: Date | string | number;
  tenant?: unknown; actor?: unknown; subject?: unknown; result?: string | null; reason?: unknown;
  details?: unknown; audit?: boolean; auditRetentionDays?: number; maxBytes?: number;
}
export interface StructuredEvent {
  timestamp: string; level: string; service: string; event: string; audit: boolean;
  tenant: string | null; actor: string | null; subject: string | null; result: string | null;
  reason: string | null; audit_retention_days: number; details: Record<string, unknown>;
}

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_.:-]{1,96}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.@:+/%/-]{1,192}$/u;
const LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
const RESULTS = Object.freeze(['success', 'failure', 'denied', 'deferred', 'unknown']);
const RESERVED_DETAILS = new Set([
  'timestamp',
  'level',
  'service',
  'event',
  'audit',
  'audit_retention_days',
  'tenant',
  'actor',
  'subject',
  'result',
  'reason',
]);

function normalizeIdentifier(value: unknown, name: string, { required = false }: { required?: boolean } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new TypeError(`${name} is required for an audit event`);
    }
    return null;
  }

  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'bigint' && typeof value !== 'symbol') {
    throw new TypeError(`${name} must be a short safe identifier`);
  }
  const normalized = String(value);
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new TypeError(`${name} must be a short safe identifier`);
  }

  return normalized;
}

function normalizeTimestamp(value: Date | string | number | undefined) {
  const timestamp = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError('Event timestamp must be a valid date');
  }

  return timestamp.toISOString();
}

function normalizeDetails(details: unknown): Record<string, unknown> {
  if (details === undefined || details === null) {
    return {};
  }
  if (typeof details !== 'object' || Array.isArray(details)) {
    throw new TypeError('Structured event details must be an object');
  }

  const sanitized = sanitizeLogValue(details);
  if (sanitized === null || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    throw new TypeError('Sanitized event details must be an object');
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sanitized)) {
    if (!RESERVED_DETAILS.has(key)) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function freezeEvent(event: StructuredEvent) {
  return Object.freeze({
    ...event,
    details: Object.freeze({ ...event.details }),
  });
}

/**
 * Build a bounded, metadata-only JSON event. Sensitive keys and inline
 * credentials are redacted by the runtime sanitizer; message bodies,
 * content, payloads, and protocol secrets must never be supplied as details.
 */
export function createStructuredEvent({
  service = 'gulogulo',
  event,
  level = 'info',
  timestamp,
  tenant,
  actor,
  subject,
  result = null,
  reason = null,
  details = {},
  audit = false,
  auditRetentionDays = 365,
  maxBytes = 256 * 1024,
}: StructuredEventOptions = {}) {
  if (typeof service !== 'string' || !IDENTIFIER_PATTERN.test(service)) {
    throw new TypeError('Event service must be a short safe identifier');
  }
  if (typeof event !== 'string' || !EVENT_NAME_PATTERN.test(event)) {
    throw new TypeError('Event names must be lower-case structured identifiers');
  }
  if (!LEVELS.includes(level)) {
    throw new TypeError(`Event level must be one of: ${LEVELS.join(', ')}`);
  }
  if (result !== null && !RESULTS.includes(result)) {
    throw new TypeError(`Event result must be one of: ${RESULTS.join(', ')}`);
  }
  if (typeof audit !== 'boolean') {
    throw new TypeError('Event audit flag must be boolean');
  }
  if (!Number.isSafeInteger(auditRetentionDays) || auditRetentionDays < 1 || auditRetentionDays > 36_500) {
    throw new RangeError('Audit retention must be between 1 and 36500 days');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > 1_048_576) {
    throw new RangeError('Event maxBytes must be between 512 and 1048576');
  }

  const record = {
    timestamp: normalizeTimestamp(timestamp),
    level,
    service,
    event,
    audit,
    tenant: normalizeIdentifier(tenant, 'tenant'),
    actor: normalizeIdentifier(actor, 'actor', { required: audit }),
    subject: normalizeIdentifier(subject, 'subject'),
    result,
    reason: reason === null || reason === undefined ? null : normalizeIdentifier(reason, 'reason'),
    audit_retention_days: auditRetentionDays,
    details: normalizeDetails(details),
  };

  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new RangeError('Structured event exceeds its bounded byte limit');
  }

  return freezeEvent(record);
}

export function createAuditEvent(options: StructuredEventOptions = {}) {
  return createStructuredEvent({ ...options, audit: true });
}

export function serializeStructuredEvent(event: unknown) {
  if (event === null || typeof event !== 'object' || !('event' in event) || typeof event.event !== 'string') {
    throw new TypeError('A structured event is required');
  }

  // Keep this boundary safe even when a caller did not use one of the factory
  // functions. Serialization must never become an accidental secret sink.
  const sanitized = sanitizeLogValue(event);
  return JSON.stringify(sanitized) + '\n';
}

export function isAuditEvent(event: unknown) {
  return event !== null && typeof event === 'object' && 'audit' in event && event.audit === true;
}

export const STRUCTURED_EVENT_LEVELS = LEVELS;
export const STRUCTURED_EVENT_RESULTS = RESULTS;
