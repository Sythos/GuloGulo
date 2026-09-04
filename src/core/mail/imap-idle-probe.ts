// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// A one-shot capability check, not a subscription: connects, logs in,
// selects INBOX, asks the server to accept IDLE (RFC 2177), then immediately
// stops and logs out. It never registers `onEvent` behavior beyond the
// no-op required to open the IDLE command — ongoing IMAP IDLE watching stays
// `imap-idle-adapter.ts`'s job. Kept deliberately short-timeout (unlike
// `imap-idle-adapter.ts`'s long-lived connections) since this runs lazily on
// a webmail UI request, never inside the login critical path.

import type { ImapClient } from './imap-client.ts';

const PROBE_MAILBOX = 'INBOX';
const PROBE_CONNECT_TIMEOUT_MS = 3_000;
const PROBE_COMMAND_TIMEOUT_MS = 3_000;

export interface ImapIdleProbeLogger {
  readonly warn?: (event: string, details?: Record<string, unknown>) => void;
}

export async function probeImapIdleAvailability({
  createImapClient,
  mailAddress,
  password,
  logger,
}: {
  readonly createImapClient: (overrides?: { readonly connectTimeoutMs?: number; readonly commandTimeoutMs?: number }) => ImapClient;
  readonly mailAddress: string;
  readonly password: string;
  readonly logger?: ImapIdleProbeLogger;
}): Promise<boolean> {
  const client = createImapClient({ connectTimeoutMs: PROBE_CONNECT_TIMEOUT_MS, commandTimeoutMs: PROBE_COMMAND_TIMEOUT_MS });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.login(mailAddress, password);
    await client.select(PROBE_MAILBOX);
    const idleSession = await client.idle(() => {});
    await idleSession.stop();
    return true;
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
    logger?.warn?.('imap_idle_probe_failed', { error: { name: error instanceof Error ? error.name : 'Error', code: typeof code === 'string' ? code : 'unknown' } });
    return false;
  } finally {
    if (connected) {
      try { await client.logout(); } catch { client.close(); }
    } else {
      client.close();
    }
  }
}
