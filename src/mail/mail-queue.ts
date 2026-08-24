// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// Transitional typing waiver: the LP2-LP9 recovery plan closes this debt at
// the final server-language audit after each protocol slice is operational.
// @ts-nocheck

import { assertTenantAccess, assertTenantContext } from '../integrations/tenant-context.ts';

const QUEUE_STATES = new Set(['queued', 'delivering', 'deferred', 'delivered', 'bounced', 'quarantined']);
const SAFE_REASON = /^[A-Za-z0-9_.:-]{1,96}$/;

function queueError(message, code = 'MAIL_QUEUE_ERROR') {
  const error = new Error(`Mail queue error: ${message}`);
  error.code = code;
  return error;
}

function safeReason(reason) {
  const value = String(reason ?? 'unspecified');
  return SAFE_REASON.test(value) ? value : 'unspecified';
}

function clonePublic(entry) {
  return Object.freeze({
    queueId: entry.queueId,
    tenantId: entry.tenantId,
    sender: entry.sender,
    recipients: Object.freeze([...entry.recipients]),
    sizeBytes: entry.sizeBytes,
    state: entry.state,
    attempts: entry.attempts,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    nextAttemptAt: entry.nextAttemptAt,
    reason: entry.reason,
  });
}

/**
 * Persistent queue boundary. The in-memory implementation is deterministic and
 * is used by M3 contract tests; production wiring replaces it with the
 * Postfix queue adapter while retaining this metadata-only view contract.
 */
export function createMailQueue({
  clock = () => new Date(),
  idFactory,
  maxAttempts = 5,
  retryBaseMs = 60_000,
} = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw queueError('maxAttempts must be between 1 and 100', 'INVALID_INPUT');
  }
  if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1_000) {
    throw queueError('retryBaseMs must be at least one second', 'INVALID_INPUT');
  }

  const entries = new Map();
  let sequence = 0;
  const makeId = idFactory ?? (() => `q-${String(++sequence).padStart(8, '0')}`);

  function now() {
    return clock().toISOString();
  }

  function get(queueId) {
    const entry = entries.get(queueId);
    if (entry === undefined) throw queueError('queue item does not exist', 'NOT_FOUND');
    return entry;
  }

  function enqueue(context, { sender, recipients, sizeBytes = 0, messageRef = null, reason = 'accepted' } = {}) {
    const canonical = assertTenantContext(context);
    if (typeof sender !== 'string' || sender.length === 0 || !Array.isArray(recipients) || recipients.length === 0) {
      throw queueError('sender and recipients are required', 'INVALID_INPUT');
    }
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw queueError('sizeBytes must be a non-negative safe integer', 'INVALID_INPUT');
    }
    const timestamp = now();
    const queueId = String(makeId());
    const entry = {
      queueId,
      tenantId: canonical.tenantId,
      sender,
      recipients: [...new Set(recipients)],
      sizeBytes,
      state: 'queued',
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextAttemptAt: timestamp,
      reason: safeReason(reason),
      // The actual message stays behind the adapter boundary. It is never
      // copied into snapshots, logs, or master-facing responses.
      messageRef,
    };
    entries.set(queueId, entry);
    return clonePublic(entry);
  }

  function claim(queueId, context) {
    const canonical = assertTenantAccess(context, get(queueId).tenantId);
    const entry = get(queueId);
    if (!['queued', 'deferred'].includes(entry.state)) {
      throw queueError('queue item is not claimable', 'INVALID_STATE');
    }
    entry.state = 'delivering';
    entry.updatedAt = now();
    entry.attempts += 1;
    return Object.freeze({
      ...clonePublic(entry),
      tenantId: canonical.tenantId,
      messageRef: entry.messageRef,
    });
  }

  function defer(queueId, context, { reason = 'temporary_failure' } = {}) {
    assertTenantAccess(context, get(queueId).tenantId);
    const entry = get(queueId);
    if (!['queued', 'delivering', 'deferred'].includes(entry.state)) throw queueError('queue item cannot be deferred', 'INVALID_STATE');
    entry.state = entry.attempts >= maxAttempts ? 'bounced' : 'deferred';
    entry.reason = safeReason(entry.state === 'bounced' ? 'retry_exhausted' : reason);
    entry.nextAttemptAt = new Date(clock().getTime() + retryBaseMs * (2 ** Math.max(0, entry.attempts - 1))).toISOString();
    entry.updatedAt = now();
    return clonePublic(entry);
  }

  function complete(queueId, context, { state, reason = 'completed' } = {}) {
    assertTenantAccess(context, get(queueId).tenantId);
    if (!['delivered', 'bounced', 'quarantined'].includes(state)) throw queueError('unsupported terminal queue state', 'INVALID_STATE');
    const entry = get(queueId);
    entry.state = state;
    entry.reason = safeReason(reason);
    entry.updatedAt = now();
    return clonePublic(entry);
  }

  function view(context, { state } = {}) {
    const canonical = assertTenantContext(context);
    if (!['provider', 'tenant_master', 'monitor'].includes(canonical.role)) {
      throw queueError('queue visibility requires an authorized operational role', 'FORBIDDEN');
    }
    const values = [...entries.values()]
      .filter((entry) => entry.tenantId === canonical.tenantId)
      .filter((entry) => state === undefined || entry.state === state)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return Object.freeze(values.map(clonePublic));
  }

  function size(context) {
    return view(context).length;
  }

  return Object.freeze({
    enqueue,
    claim,
    defer,
    complete,
    view,
    size,
    states: Object.freeze([...QUEUE_STATES]),
  });
}

export { clonePublic, queueError };
