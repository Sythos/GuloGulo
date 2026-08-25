// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

export class TimezoneError extends Error {
  readonly code: string;
  constructor(message: string, code = 'TIMEZONE_ERROR') { super(`Timezone error: ${message}`); this.name = 'TimezoneError'; this.code = code; }
}

function timezoneError(message: string, code = 'TIMEZONE_ERROR'): TimezoneError { return new TimezoneError(message, code); }

export function normalizeTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw timezoneError('time zone must be a non-empty string', 'INVALID_TIMEZONE');
  const candidate = value.trim();
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
    return resolved === 'Etc/UTC' ? 'UTC' : resolved;
  } catch { throw timezoneError(`unknown time zone: ${candidate}`, 'INVALID_TIMEZONE'); }
}

export function detectBrowserTimeZone({ intl = globalThis.Intl }: { intl?: typeof Intl } = {}): string {
  try { return normalizeTimeZone(intl?.DateTimeFormat?.().resolvedOptions?.().timeZone ?? 'UTC'); } catch { return 'UTC'; }
}

export function resolveViewerTimeZone({ manualOverride = null, browserTimeZone = null, defaultTimeZone = 'UTC' }: { manualOverride?: string | null; browserTimeZone?: string | null; defaultTimeZone?: string } = {}) {
  if (manualOverride) return Object.freeze({ timeZone: normalizeTimeZone(manualOverride), source: 'manual' as const });
  if (browserTimeZone) return Object.freeze({ timeZone: normalizeTimeZone(browserTimeZone), source: 'browser' as const });
  return Object.freeze({ timeZone: normalizeTimeZone(defaultTimeZone), source: 'default' as const });
}

function asDate(value: Date | string | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw timezoneError('timestamp is invalid', 'INVALID_TIMESTAMP');
  return date;
}

export function formatLocalTimestamp(value: Date | string | number, { timeZone = 'UTC', locale = 'en-GB', includeTimeZoneName = false }: { timeZone?: string; locale?: string; includeTimeZoneName?: boolean } = {}): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: normalizeTimeZone(timeZone), year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  };
  if (includeTimeZoneName) options.timeZoneName = 'short';
  return new Intl.DateTimeFormat(locale, options).format(asDate(value));
}

export function formatMessageTimestamp(value: Date | string | number, { viewerTimeZone = 'UTC', senderTimeZone = null, locale = 'en-GB' }: { viewerTimeZone?: string; senderTimeZone?: string | null; locale?: string } = {}) {
  const viewer = normalizeTimeZone(viewerTimeZone);
  const sender = senderTimeZone ? normalizeTimeZone(senderTimeZone) : null;
  const local = formatLocalTimestamp(value, { timeZone: viewer, locale });
  const senderDisplay = sender ? formatLocalTimestamp(value, { timeZone: sender, locale }) : local;
  const differentTimeZone = Boolean(sender && sender !== viewer);
  return Object.freeze({ display: differentTimeZone ? `${senderDisplay} (${local})` : senderDisplay, local, sender: senderDisplay, viewerTimeZone: viewer, senderTimeZone: sender, differentTimeZone });
}

export { timezoneError };
