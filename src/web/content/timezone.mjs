// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

function timezoneError(message, code = 'TIMEZONE_ERROR') {
  const error = new Error(`Timezone error: ${message}`);
  error.code = code;
  return error;
}

export function normalizeTimeZone(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw timezoneError('time zone must be a non-empty string', 'INVALID_TIMEZONE');
  const candidate = value.trim();
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
    return resolved === 'Etc/UTC' ? 'UTC' : resolved;
  } catch {
    throw timezoneError(`unknown time zone: ${candidate}`, 'INVALID_TIMEZONE');
  }
}

/** Detect once from the browser environment; callers should persist the result and avoid polling. */
export function detectBrowserTimeZone({ intl = globalThis.Intl } = {}) {
  try {
    const candidate = intl?.DateTimeFormat?.().resolvedOptions?.().timeZone;
    return normalizeTimeZone(candidate ?? 'UTC');
  } catch {
    return 'UTC';
  }
}

export function resolveViewerTimeZone({ manualOverride = null, browserTimeZone = null, defaultTimeZone = 'UTC' } = {}) {
  if (manualOverride !== null && manualOverride !== undefined && manualOverride !== '') {
    return Object.freeze({ timeZone: normalizeTimeZone(manualOverride), source: 'manual' });
  }
  if (browserTimeZone !== null && browserTimeZone !== undefined && browserTimeZone !== '') {
    return Object.freeze({ timeZone: normalizeTimeZone(browserTimeZone), source: 'browser' });
  }
  return Object.freeze({ timeZone: normalizeTimeZone(defaultTimeZone), source: 'default' });
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw timezoneError('timestamp is invalid', 'INVALID_TIMESTAMP');
  return date;
}

export function formatLocalTimestamp(value, { timeZone = 'UTC', locale = 'en-GB', includeTimeZoneName = false } = {}) {
  const canonical = normalizeTimeZone(timeZone);
  const options = {
    timeZone: canonical,
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  };
  if (includeTimeZoneName) options.timeZoneName = 'short';
  return new Intl.DateTimeFormat(locale, options).format(asDate(value));
}

/** Build the webmail display string, adding the viewer-local equivalent only when zones differ. */
export function formatMessageTimestamp(value, { viewerTimeZone = 'UTC', senderTimeZone = null, locale = 'en-GB' } = {}) {
  const viewer = normalizeTimeZone(viewerTimeZone);
  const sender = senderTimeZone ? normalizeTimeZone(senderTimeZone) : null;
  const local = formatLocalTimestamp(value, { timeZone: viewer, locale });
  const senderDisplay = sender ? formatLocalTimestamp(value, { timeZone: sender, locale }) : local;
  const differentTimeZone = Boolean(sender && sender !== viewer);
  return Object.freeze({
    display: differentTimeZone ? `${senderDisplay} (${local})` : senderDisplay,
    local,
    sender: senderDisplay,
    viewerTimeZone: viewer,
    senderTimeZone: sender,
    differentTimeZone,
  });
}

export { timezoneError };
