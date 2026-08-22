// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

const RSPAMD_ACTIONS = new Set(['accept', 'no_action', 'soft_reject', 'reject', 'quarantine', 'unavailable']);
const CLAMAV_STATUSES = new Set(['clean', 'infected', 'unavailable']);

function scannerError(message, code = 'MAIL_SCANNER_ERROR') {
  const error = new Error(`Mail scanner error: ${message}`);
  error.code = code;
  return error;
}

function normalizeScore(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw scannerError('Rspamd score must be finite', 'INVALID_VERDICT');
  }
  return value;
}

export function normalizeRspamdVerdict(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw scannerError('Rspamd verdict must be an object', 'INVALID_VERDICT');
  }
  const action = value.action ?? (value.status === 'ok' ? 'accept' : value.status);
  if (!RSPAMD_ACTIONS.has(action)) {
    throw scannerError('Rspamd returned an unsupported action', 'INVALID_VERDICT');
  }
  const symbols = Array.isArray(value.symbols)
    ? value.symbols.filter((symbol) => typeof symbol === 'string' && /^[A-Z0-9_.:-]{1,64}$/.test(symbol)).slice(0, 128)
    : [];
  return Object.freeze({
    action,
    score: normalizeScore(value.score),
    symbols: Object.freeze(symbols),
  });
}

export function normalizeClamAvVerdict(value) {
  if (typeof value === 'string') {
    value = { status: value };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw scannerError('ClamAV verdict must be an object', 'INVALID_VERDICT');
  }
  const status = value.status;
  if (!CLAMAV_STATUSES.has(status)) {
    throw scannerError('ClamAV returned an unsupported status', 'INVALID_VERDICT');
  }
  return Object.freeze({
    status,
    signature: status === 'infected' && typeof value.signature === 'string' && /^[A-Za-z0-9_.:+/-]{1,128}$/.test(value.signature)
      ? value.signature
      : null,
  });
}

/**
 * Wrap an external Rspamd endpoint. A missing or failed endpoint returns an
 * explicit unavailable verdict; callers must apply the selected fail-closed
 * policy instead of silently accepting a message.
 */
export function createRspamdScanner({ scan, logger = console } = {}) {
  return Object.freeze({
    async scan(message) {
      if (typeof scan !== 'function') return Object.freeze({ action: 'unavailable', score: null, symbols: [] });
      try {
        return normalizeRspamdVerdict(await scan(message));
      } catch (error) {
        logger.warn?.('mail_rspamd_unavailable', { error: { name: error?.name ?? 'Error' } });
        return Object.freeze({ action: 'unavailable', score: null, symbols: [] });
      }
    },
  });
}

export function createClamAvScanner({ scan, logger = console } = {}) {
  return Object.freeze({
    async scan(message) {
      if (typeof scan !== 'function') return Object.freeze({ status: 'unavailable', signature: null });
      try {
        return normalizeClamAvVerdict(await scan(message));
      } catch (error) {
        logger.warn?.('mail_clamav_unavailable', { error: { name: error?.name ?? 'Error' } });
        return Object.freeze({ status: 'unavailable', signature: null });
      }
    },
  });
}

export const mailScannerStatuses = Object.freeze({
  rspamdActions: Object.freeze([...RSPAMD_ACTIONS]),
  clamAvStatuses: Object.freeze([...CLAMAV_STATUSES]),
});
