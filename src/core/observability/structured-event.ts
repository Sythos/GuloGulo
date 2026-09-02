// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import { Buffer } from 'node:buffer';

import { sanitizeLogValue } from '../../runtime/logger.ts';

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

function normalizeIdentifier(value, name, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new TypeError(`${name} is required for an audit event`);
    }
    return null;
  }

  const normalized = String(value);
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new TypeError(`${name} must be a short safe identifier`);
  }

  return normalized;
}

function normalizeTimestamp(value) {
  const timestamp = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError('Event timestamp must be a valid date');
  }

  return timestamp.toISOString();
}

function normalizeDetails(details) {
  if (details === undefined || details === null) {
    return {};
  }
  if (typeof details !== 'object' || Array.isArray(details)) {
    throw new TypeError('Structured event details must be an object');
  }

  const sanitized = sanitizeLogValue(details);
  const normalized = {};
  for (const [key, value] of Object.entries(sanitized)) {
    if (!RESERVED_DETAILS.has(key)) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function freezeEvent(event) {
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
} = {}) {
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

export function createAuditEvent(options = {}) {
  return createStructuredEvent({ ...options, audit: true });
}

export function serializeStructuredEvent(event) {
  if (event === null || typeof event !== 'object' || typeof event.event !== 'string') {
    throw new TypeError('A structured event is required');
  }

  // Keep this boundary safe even when a caller did not use one of the factory
  // functions. Serialization must never become an accidental secret sink.
  const sanitized = sanitizeLogValue(event);
  return JSON.stringify(sanitized) + '\n';
}

export function isAuditEvent(event) {
  return event !== null && typeof event === 'object' && event.audit === true;
}

export const STRUCTURED_EVENT_LEVELS = LEVELS;
export const STRUCTURED_EVENT_RESULTS = RESULTS;
