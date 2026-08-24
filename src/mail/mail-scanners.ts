// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/** The only Rspamd actions understood by the mail policy boundary. */
export type RspamdAction =
  | 'accept'
  | 'no_action'
  | 'soft_reject'
  | 'reject'
  | 'quarantine'
  | 'unavailable';

/** The only ClamAV statuses understood by the mail policy boundary. */
export type ClamAvStatus = 'clean' | 'infected' | 'unavailable';

/**
 * Deliberately small input passed to a scanner adapter.  The scanner boundary
 * never receives RFC 5322 content, a subject, an attachment, or credentials.
 */
export interface MailScanMetadata {
  readonly sender?: string;
  readonly recipients?: readonly string[];
  readonly sizeBytes?: number;
  readonly messageRef?: string | null;
}

export interface RspamdVerdict {
  readonly action: RspamdAction;
  readonly score: number | null;
  readonly symbols: readonly string[];
}

export interface ClamAvVerdict {
  readonly status: ClamAvStatus;
  readonly signature: string | null;
}

export interface MailScannerLogger {
  readonly warn?: (event: string, details?: Record<string, unknown>) => void;
}

export type RspamdScan = (message: MailScanMetadata) => unknown | Promise<unknown>;
export type ClamAvScan = (message: MailScanMetadata) => unknown | Promise<unknown>;

export interface RspamdScannerOptions {
  readonly scan?: RspamdScan;
  readonly logger?: MailScannerLogger;
}

export interface ClamAvScannerOptions {
  readonly scan?: ClamAvScan;
  readonly logger?: MailScannerLogger;
}

export interface RspamdScanner {
  readonly scan: (message?: MailScanMetadata) => Promise<RspamdVerdict>;
}

export interface ClamAvScanner {
  readonly scan: (message?: MailScanMetadata) => Promise<ClamAvVerdict>;
}

interface CodedError extends Error {
  readonly code: string;
}

const RSPAMD_ACTIONS: ReadonlySet<RspamdAction> = new Set<RspamdAction>([
  'accept',
  'no_action',
  'soft_reject',
  'reject',
  'quarantine',
  'unavailable',
]);

const CLAMAV_STATUSES: ReadonlySet<ClamAvStatus> = new Set<ClamAvStatus>([
  'clean',
  'infected',
  'unavailable',
]);

const SYMBOL_PATTERN = /^[A-Z0-9_.:-]{1,64}$/u;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_.:+/-]{1,128}$/u;

function scannerError(message: string, code = 'MAIL_SCANNER_ERROR'): CodedError {
  const error = new Error(`Mail scanner error: ${message}`) as CodedError;
  Object.defineProperty(error, 'code', { configurable: true, enumerable: true, value: code, writable: false });
  return error;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeScore(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw scannerError('Rspamd score must be finite', 'INVALID_VERDICT');
  }
  return value;
}

function isRspamdAction(value: unknown): value is RspamdAction {
  return typeof value === 'string' && RSPAMD_ACTIONS.has(value as RspamdAction);
}

function isClamAvStatus(value: unknown): value is ClamAvStatus {
  return typeof value === 'string' && CLAMAV_STATUSES.has(value as ClamAvStatus);
}

/** Normalize and bound the metadata sent to an external scanner adapter. */
function metadataOnly(value: MailScanMetadata | undefined): MailScanMetadata {
  const input = asRecord(value);
  const sender = typeof input.sender === 'string' ? input.sender : undefined;
  const recipients = Array.isArray(input.recipients)
    ? Object.freeze(input.recipients.filter((recipient): recipient is string => typeof recipient === 'string').slice(0, 256))
    : undefined;
  const sizeBytes = typeof input.sizeBytes === 'number' && Number.isSafeInteger(input.sizeBytes) && input.sizeBytes >= 0
    ? input.sizeBytes
    : undefined;
  const messageRef = typeof input.messageRef === 'string' ? input.messageRef : null;
  return Object.freeze({ sender, recipients, sizeBytes, messageRef });
}

export function normalizeRspamdVerdict(value: unknown): RspamdVerdict {
  const input = asRecord(value);
  if (Object.keys(input).length === 0 && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw scannerError('Rspamd verdict must be an object', 'INVALID_VERDICT');
  }

  const candidate = input.action ?? (input.status === 'ok' ? 'accept' : input.status);
  if (!isRspamdAction(candidate)) {
    throw scannerError('Rspamd returned an unsupported action', 'INVALID_VERDICT');
  }
  const symbols = Array.isArray(input.symbols)
    ? Object.freeze(input.symbols
      .filter((symbol): symbol is string => typeof symbol === 'string' && SYMBOL_PATTERN.test(symbol))
      .slice(0, 128))
    : Object.freeze([] as string[]);
  return Object.freeze({
    action: candidate,
    score: normalizeScore(input.score),
    symbols,
  });
}

export function normalizeClamAvVerdict(value: unknown): ClamAvVerdict {
  const input = typeof value === 'string' ? { status: value } : asRecord(value);
  if (Object.keys(input).length === 0 && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw scannerError('ClamAV verdict must be an object', 'INVALID_VERDICT');
  }
  const status = input.status;
  if (!isClamAvStatus(status)) {
    throw scannerError('ClamAV returned an unsupported status', 'INVALID_VERDICT');
  }
  return Object.freeze({
    status,
    signature: status === 'infected' && typeof input.signature === 'string' && SIGNATURE_PATTERN.test(input.signature)
      ? input.signature
      : null,
  });
}

const unavailableRspamdVerdict = Object.freeze({ action: 'unavailable' as const, score: null, symbols: Object.freeze([] as string[]) });
const unavailableClamAvVerdict = Object.freeze({ status: 'unavailable' as const, signature: null });

/**
 * Wrap an external Rspamd endpoint. A missing, malformed, or failed endpoint
 * returns an explicit unavailable verdict; callers must apply fail-closed
 * policy instead of silently accepting a message.
 */
export function createRspamdScanner({ scan, logger = console }: RspamdScannerOptions = {}): RspamdScanner {
  return Object.freeze({
    async scan(message: MailScanMetadata = {}): Promise<RspamdVerdict> {
      if (typeof scan !== 'function') return unavailableRspamdVerdict;
      try {
        return normalizeRspamdVerdict(await scan(metadataOnly(message)));
      } catch (error: unknown) {
        logger.warn?.('mail_rspamd_unavailable', { error: { name: error instanceof Error ? error.name : 'Error' } });
        return unavailableRspamdVerdict;
      }
    },
  });
}

export function createClamAvScanner({ scan, logger = console }: ClamAvScannerOptions = {}): ClamAvScanner {
  return Object.freeze({
    async scan(message: MailScanMetadata = {}): Promise<ClamAvVerdict> {
      if (typeof scan !== 'function') return unavailableClamAvVerdict;
      try {
        return normalizeClamAvVerdict(await scan(metadataOnly(message)));
      } catch (error: unknown) {
        logger.warn?.('mail_clamav_unavailable', { error: { name: error instanceof Error ? error.name : 'Error' } });
        return unavailableClamAvVerdict;
      }
    },
  });
}

export const mailScannerStatuses = Object.freeze({
  rspamdActions: Object.freeze([...RSPAMD_ACTIONS]),
  clamAvStatuses: Object.freeze([...CLAMAV_STATUSES]),
});

export { scannerError };
