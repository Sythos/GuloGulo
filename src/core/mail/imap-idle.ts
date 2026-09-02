// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { assertTenantContext } from '../../integrations/tenant-context.ts';
import type { TenantContext } from '../../integrations/types.ts';

const MAILBOX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const KIND_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,31}$/u;

export interface ImapIdleEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly tenantId: string;
  readonly userId: string;
  readonly mailbox: string;
  readonly kind: string;
  readonly uidNext: number | null;
  readonly occurredAt: string;
}

export type ImapIdleEventHandler = (event: ImapIdleEvent) => void;

export interface ImapIdleSubscribeOptions {
  readonly userId?: unknown;
  readonly mailbox?: unknown;
  readonly onEvent?: ImapIdleEventHandler;
}

export interface ImapIdleNotifyOptions {
  readonly userId?: unknown;
  readonly mailbox?: unknown;
  readonly kind?: unknown;
  readonly uidNext?: unknown;
}

export interface ImapIdleSubscription {
  readonly id: string;
  readonly close: () => void;
}

export interface ImapIdleNotification {
  readonly event: ImapIdleEvent;
  readonly delivered: number;
}

export interface ImapIdleBroker {
  readonly subscribe: (context: unknown, options?: ImapIdleSubscribeOptions) => ImapIdleSubscription;
  readonly notify: (context: unknown, options?: ImapIdleNotifyOptions) => ImapIdleNotification;
  readonly count: () => number;
}

interface CodedError extends Error {
  readonly code: string;
}

interface Subscription {
  readonly tenantId: string;
  readonly userId: string;
  readonly mailbox: string;
  readonly onEvent: ImapIdleEventHandler;
}

function idleError(message: string, code = 'IMAP_IDLE_ERROR'): CodedError {
  const error = new Error(`IMAP IDLE error: ${message}`) as CodedError;
  Object.defineProperty(error, 'code', { configurable: true, enumerable: true, value: code, writable: false });
  return error;
}

function safeMailbox(value: unknown): string {
  if (typeof value !== 'string' || !MAILBOX_PATTERN.test(value)) {
    throw idleError('mailbox is invalid', 'INVALID_INPUT');
  }
  return value;
}

function safeUserId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw idleError('userId is required', 'INVALID_INPUT');
  }
  return value;
}

function safeKind(value: unknown): string {
  return typeof value === 'string' && KIND_PATTERN.test(value) ? value : 'exists';
}

function safeUidNext(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : null;
}

/**
 * Deterministic event broker for Dovecot IMAP IDLE notifications. The real
 * adapter subscribes to Dovecot; this contract guarantees process-wide,
 * monotonic event sequences and reconnect-safe event identities without
 * exposing message content.
 */
export function createImapIdleBroker({ clock = () => new Date() }: { readonly clock?: () => Date } = {}): ImapIdleBroker {
  const subscriptions = new Map<string, Subscription>();
  let subscriptionSequence = 0;
  let eventSequence = 0;

  function subscribe(context: unknown, options: ImapIdleSubscribeOptions = {}): ImapIdleSubscription {
    const canonical = assertTenantContext(context);
    const userId = safeUserId(options.userId);
    const onEvent = options.onEvent;
    if (typeof onEvent !== 'function') {
      throw idleError('userId and onEvent are required', 'INVALID_INPUT');
    }
    if (canonical.role === 'user' && canonical.actorId !== userId) {
      throw idleError('a user may subscribe only to its own mailbox', 'FORBIDDEN');
    }
    const id = `idle-${String(++subscriptionSequence).padStart(8, '0')}`;
    subscriptions.set(id, Object.freeze({
      tenantId: canonical.tenantId,
      userId,
      mailbox: safeMailbox(options.mailbox ?? 'INBOX'),
      onEvent,
    }));
    return Object.freeze({
      id,
      close(): void {
        subscriptions.delete(id);
      },
    });
  }

  function notify(context: unknown, options: ImapIdleNotifyOptions = {}): ImapIdleNotification {
    const canonical: TenantContext = assertTenantContext(context);
    const userId = safeUserId(options.userId);
    const targetMailbox = safeMailbox(options.mailbox ?? 'INBOX');
    const sequence = ++eventSequence;
    const event: ImapIdleEvent = Object.freeze({
      eventId: `idle-event-${String(sequence).padStart(8, '0')}`,
      sequence,
      tenantId: canonical.tenantId,
      userId,
      mailbox: targetMailbox,
      kind: safeKind(options.kind),
      uidNext: safeUidNext(options.uidNext ?? null),
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

  function count(): number {
    return subscriptions.size;
  }

  return Object.freeze({ subscribe, notify, count });
}

export { idleError };
