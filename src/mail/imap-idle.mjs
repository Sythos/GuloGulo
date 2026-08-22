// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { assertTenantContext } from '../integrations/tenant-context.mjs';

const MAILBOX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function idleError(message, code = 'IMAP_IDLE_ERROR') {
  const error = new Error(`IMAP IDLE error: ${message}`);
  error.code = code;
  return error;
}

function safeMailbox(value) {
  if (typeof value !== 'string' || !MAILBOX_PATTERN.test(value)) throw idleError('mailbox is invalid', 'INVALID_INPUT');
  return value;
}

/**
 * Deterministic event broker for Dovecot IMAP IDLE notifications. The real
 * adapter subscribes to Dovecot; this contract guarantees monotonic sequence
 * numbers and reconnect-safe event identity without exposing message content.
 */
export function createImapIdleBroker({ clock = () => new Date() } = {}) {
  const subscriptions = new Map();
  let subscriptionSequence = 0;
  let eventSequence = 0;

  function subscribe(context, { userId, mailbox = 'INBOX', onEvent } = {}) {
    const canonical = assertTenantContext(context);
    if (typeof userId !== 'string' || userId.length === 0 || typeof onEvent !== 'function') {
      throw idleError('userId and onEvent are required', 'INVALID_INPUT');
    }
    if (canonical.role === 'user' && canonical.actorId !== userId) {
      throw idleError('a user may subscribe only to its own mailbox', 'FORBIDDEN');
    }
    const id = `idle-${String(++subscriptionSequence).padStart(8, '0')}`;
    subscriptions.set(id, { tenantId: canonical.tenantId, userId, mailbox: safeMailbox(mailbox), onEvent });
    return Object.freeze({
      id,
      close() {
        subscriptions.delete(id);
      },
    });
  }

  function notify(context, { userId, mailbox = 'INBOX', kind = 'exists', uidNext = null } = {}) {
    const canonical = assertTenantContext(context);
    const targetMailbox = safeMailbox(mailbox);
    if (typeof userId !== 'string' || userId.length === 0) throw idleError('userId is required', 'INVALID_INPUT');
    const event = Object.freeze({
      eventId: `idle-event-${String(++eventSequence).padStart(8, '0')}`,
      sequence: eventSequence,
      tenantId: canonical.tenantId,
      userId,
      mailbox: targetMailbox,
      kind: /^[A-Za-z][A-Za-z0-9_.:-]{0,31}$/.test(kind) ? kind : 'exists',
      uidNext: uidNext === null ? null : Number.isSafeInteger(uidNext) && uidNext >= 1 ? uidNext : null,
      occurredAt: clock().toISOString(),
    });
    let delivered = 0;
    for (const subscription of subscriptions.values()) {
      if (subscription.tenantId !== canonical.tenantId || subscription.userId !== userId || subscription.mailbox !== targetMailbox) continue;
      subscription.onEvent(event);
      delivered += 1;
    }
    return Object.freeze({ event, delivered });
  }

  function count() {
    return subscriptions.size;
  }

  return Object.freeze({ subscribe, notify, count });
}

export { idleError };
