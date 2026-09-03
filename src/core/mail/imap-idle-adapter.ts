// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// Connects the minimal IMAP client (`imap-client.ts`) to the pure,
// dependency-free IDLE event broker in `imap-idle.ts`. `imap-idle.ts` stays
// the contract — "the real adapter subscribes to Dovecot" — and this file is
// that adapter: it opens a real IMAP IDLE connection per (tenant, user,
// mailbox) watch and turns each real `EXISTS` update into a
// `broker.notify(...)` call so local subscribers see it. The IMAP transport
// is injected through `ImapClientFactory`, never imported as a concrete
// hardcoded implementation, so this stays testable against a fake server or
// a stub.

import { createImapClient } from './imap-client.ts';
import type { ImapClient, ImapClientLogger } from './imap-client.ts';
import { assertTenantContext } from '../../integrations/tenant-context.ts';
import type { TenantContext } from '../../integrations/types.ts';

export interface ImapIdleTarget {
  readonly host: string;
  readonly port: number;
  readonly tls?: boolean;
}

/** Injection seam: swap in a fake/stub client for tests, or a different transport entirely. */
export type ImapClientFactory = (target: ImapIdleTarget) => ImapClient;

export interface ImapIdleCredentials {
  readonly username: string;
  readonly password: string;
}

export interface ImapIdleWatchOptions {
  readonly userId: string;
  readonly mailbox?: string;
  readonly credentials: ImapIdleCredentials;
}

export interface ImapIdleWatch {
  readonly stop: () => Promise<void>;
}

/** The subset of `ImapIdleBroker` (`imap-idle.ts`) this adapter depends on. */
export interface ImapIdleBrokerLike {
  readonly notify: (context: unknown, options?: {
    readonly userId?: unknown;
    readonly mailbox?: unknown;
    readonly kind?: unknown;
    readonly uidNext?: unknown;
  }) => unknown;
}

export interface ImapIdleAdapterOptions {
  readonly broker: ImapIdleBrokerLike;
  readonly host: string;
  readonly port: number;
  readonly tls?: boolean;
  readonly idleRefreshMs?: number;
  readonly createClient?: ImapClientFactory;
  readonly logger?: ImapClientLogger;
}

export interface ImapIdleAdapter {
  watch(context: unknown, options: ImapIdleWatchOptions): Promise<ImapIdleWatch>;
}

interface CodedError extends Error {
  readonly code: string;
}

function adapterError(message: string, code = 'IMAP_IDLE_ADAPTER_ERROR'): CodedError {
  const error = new Error(`IMAP IDLE adapter error: ${message}`) as CodedError;
  Object.defineProperty(error, 'code', { configurable: true, enumerable: true, value: code, writable: false });
  return error;
}

/**
 * Build the real IMAP IDLE adapter. Every watch opens its own connection
 * (LOGIN, SELECT, IDLE) and forwards `EXISTS` updates into `broker.notify`;
 * `stop()` sends `DONE`, logs out, and closes the socket. No message content
 * ever crosses this boundary — only the mailbox/user scope and an event kind,
 * matching the metadata-only contract `imap-idle.ts` already enforces.
 */
export function createImapIdleAdapter(options: ImapIdleAdapterOptions): ImapIdleAdapter {
  const { broker, host, port } = options;
  const tls = options.tls ?? true;
  const idleRefreshMs = options.idleRefreshMs;
  const logger = options.logger ?? {};
  const factory: ImapClientFactory = options.createClient
    ?? ((target) => createImapClient({ ...target, idleRefreshMs, logger }));

  async function watch(context: unknown, watchOptions: ImapIdleWatchOptions): Promise<ImapIdleWatch> {
    const canonical: TenantContext = assertTenantContext(context);
    const userId = watchOptions.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw adapterError('userId is required', 'INVALID_INPUT');
    }
    const mailbox = watchOptions.mailbox ?? 'INBOX';
    const credentials = watchOptions.credentials;
    if (credentials === undefined || typeof credentials.username !== 'string' || typeof credentials.password !== 'string') {
      throw adapterError('IMAP credentials are required', 'INVALID_INPUT');
    }

    const client = factory({ host, port, tls });
    let session: { readonly stop: () => Promise<void> };
    try {
      await client.connect();
      await client.login(credentials.username, credentials.password);
      await client.select(mailbox);
      session = await client.idle((event) => {
        if (event.kind !== 'exists') return;
        try {
          broker.notify(canonical, { userId, mailbox, kind: 'exists', uidNext: null });
        } catch (error) {
          logger.warn?.('imap_idle_notify_failed', { error: { name: error instanceof Error ? error.name : 'Error' } });
        }
      });
    } catch (error) {
      client.close();
      throw error;
    }

    let stopped = false;
    async function stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        await session.stop();
      } finally {
        try {
          await client.logout();
        } catch {
          client.close();
        }
      }
    }

    return Object.freeze({ stop });
  }

  return Object.freeze({ watch });
}

export { adapterError };
