// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// Connects the minimal SMTP client (`smtp-client.ts`) to the existing,
// unchanged queue contract in `mail-queue.ts`. `mail-queue.ts` stays the
// contract test double described in doc/mail-core.md; this file is the
// "production wiring [that] replaces it with the Postfix queue adapter" the
// comment there refers to — it claims a queued item, submits it over real
// SMTP to the local Postfix submission port, and reports the outcome back to
// the SAME queue instance so retry/backoff/bounce stay owned by
// `mail-queue.ts` (`queueMaxAttempts`/`queueRetryBaseMs`), not duplicated
// here.

import { createSmtpClient, SmtpCommandError } from './smtp-client.ts';
import type { SmtpClient, SmtpClientLogger, SmtpTlsMode } from './smtp-client.ts';

export interface MailQueueEntry {
  readonly queueId: string;
  readonly tenantId: string;
  readonly sender: string;
  readonly recipients: readonly string[];
  readonly sizeBytes: number;
  readonly state: string;
  readonly attempts: number;
  readonly messageRef?: unknown;
}

/** The subset of `createMailQueue()`'s return value (`mail-queue.ts`) this adapter depends on. */
export interface MailQueueLike {
  readonly claim: (queueId: string, context: unknown) => MailQueueEntry;
  readonly defer: (queueId: string, context: unknown, options?: { readonly reason?: string }) => MailQueueEntry;
  readonly complete: (
    queueId: string,
    context: unknown,
    options: { readonly state: 'delivered' | 'bounced' | 'quarantined'; readonly reason?: string },
  ) => MailQueueEntry;
}

export type MessageReader = (messageRef: unknown) => Promise<string | Buffer>;

export interface SmtpQueueTarget {
  readonly host: string;
  readonly port: number;
  readonly tls?: SmtpTlsMode;
}

export type SmtpClientFactory = (target: SmtpQueueTarget) => SmtpClient;

export interface SmtpQueueCredentials {
  readonly username: string;
  readonly password: string;
}

export type SmtpQueueCredentialResolver = (
  context: unknown,
  entry: MailQueueEntry,
) => Promise<SmtpQueueCredentials | null> | SmtpQueueCredentials | null;

export interface SmtpQueueAdapterOptions {
  readonly queue: MailQueueLike;
  readonly host: string;
  readonly port: number;
  readonly tls?: SmtpTlsMode;
  readonly clientHostname?: string;
  readonly readMessage: MessageReader;
  readonly resolveCredentials?: SmtpQueueCredentialResolver;
  readonly createClient?: SmtpClientFactory;
  readonly logger?: SmtpClientLogger;
}

export interface SmtpRejectedRecipient {
  readonly address: string;
  readonly code: number | null;
}

export interface SmtpDeliveryResult {
  readonly queueId: string;
  readonly state: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly SmtpRejectedRecipient[];
}

export interface SmtpQueueAdapter {
  deliver(context: unknown, queueId: string): Promise<SmtpDeliveryResult>;
}

async function safeClose(client: SmtpClient): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.close();
  }
}

/**
 * Build the real SMTP submission adapter. `deliver()` claims one queue item,
 * hands it to Postfix over SMTP, and reports the outcome back onto the same
 * queue: a hard 5xx (or an unrecognized/malformed reply) bounces, a soft 4xx
 * or a connection failure defers for the queue's own exponential backoff. The
 * queue's `claim()`/`defer()`/`complete()` already own attempt counting and
 * `nextAttemptAt`; this adapter never keeps a second counter.
 */
export function createSmtpQueueAdapter(options: SmtpQueueAdapterOptions): SmtpQueueAdapter {
  const { queue, host, port, readMessage } = options;
  const tls: SmtpTlsMode = options.tls ?? 'starttls';
  const clientHostname = options.clientHostname ?? 'localhost';
  const resolveCredentials = options.resolveCredentials;
  const logger = options.logger ?? {};
  const factory: SmtpClientFactory = options.createClient
    ?? ((target) => createSmtpClient({ ...target, logger }));

  async function deliver(context: unknown, queueId: string): Promise<SmtpDeliveryResult> {
    const claimed = queue.claim(queueId, context);
    const client = factory({ host, port, tls });
    const accepted: string[] = [];
    const rejected: SmtpRejectedRecipient[] = [];

    try {
      await client.connect();
      await client.ehlo(clientHostname);
      if (tls === 'starttls') {
        await client.startTls();
        await client.ehlo(clientHostname);
      }

      const credentials = typeof resolveCredentials === 'function' ? await resolveCredentials(context, claimed) : null;
      if (credentials !== null && credentials !== undefined) {
        await client.authLogin(credentials.username, credentials.password);
      }

      await client.mailFrom(claimed.sender);
      for (const recipient of claimed.recipients) {
        try {
          await client.rcptTo(recipient);
          accepted.push(recipient);
        } catch (error) {
          rejected.push({ address: recipient, code: error instanceof SmtpCommandError ? error.code : null });
        }
      }

      if (accepted.length === 0) {
        await safeClose(client);
        const permanentOnly = rejected.length > 0 && rejected.every((entry) => entry.code !== null && entry.code >= 500);
        const updated = permanentOnly
          ? queue.complete(queueId, context, { state: 'bounced', reason: 'smtp_rejected' })
          : queue.defer(queueId, context, { reason: 'smtp_temporary_failure' });
        return Object.freeze({ queueId, state: updated.state, accepted: Object.freeze(accepted), rejected: Object.freeze(rejected) });
      }

      const payload = await readMessage(claimed.messageRef);
      await client.data(payload);
      await safeClose(client);
      const updated = queue.complete(queueId, context, { state: 'delivered', reason: 'smtp_delivered' });
      return Object.freeze({ queueId, state: updated.state, accepted: Object.freeze(accepted), rejected: Object.freeze(rejected) });
    } catch (error) {
      client.close();
      const temporary = !(error instanceof SmtpCommandError) || error.temporary;
      logger.warn?.('smtp_delivery_failed', {
        queueId,
        temporary,
        error: { name: error instanceof Error ? error.name : 'Error' },
      });
      const updated = temporary
        ? queue.defer(queueId, context, { reason: 'smtp_temporary_failure' })
        : queue.complete(queueId, context, { state: 'bounced', reason: 'smtp_rejected' });
      return Object.freeze({ queueId, state: updated.state, accepted: Object.freeze(accepted), rejected: Object.freeze(rejected) });
    }
  }

  return Object.freeze({ deliver });
}
