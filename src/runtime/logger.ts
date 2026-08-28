// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|content|payload|html|(?:^|[_-])message(?:[_-]|$)|(?:^|[_-])body(?:[_-]|$))/i;
const INLINE_SECRET_PATTERN =
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*|(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?id|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const RESERVED_FIELDS = new Set([
  'timestamp',
  'level',
  'service',
  'environment',
  'version',
  'build',
  'event',
]);
const CONTEXT_ALIASES = Object.freeze({
  requestId: 'request_id',
  correlationId: 'correlation_id',
});

function isSensitiveKey(key) {
  return typeof key === 'string' && SENSITIVE_KEY_PATTERN.test(key);
}

function redactText(value) {
  return value.replace(INLINE_SECRET_PATTERN, REDACTED);
}

/**
 * Convert arbitrary diagnostic data into a JSON-safe value.
 *
 * Logging is deliberately defensive: sensitive field names, inline
 * credentials, circular objects, and unbounded recursive structures cannot
 * escape through the structured log stream. Callers must still avoid passing
 * complete request bodies or message objects to the logger.
 */
export function sanitizeLogValue(value, seen = new WeakSet(), key = '') {
  if (isSensitiveKey(key)) {
    return REDACTED;
  }

  if (value instanceof Error) {
    return {
      name: redactText(String(value.name || 'Error')),
      message: redactText(String(value.message || '')),
    };
  }

  if (typeof value === 'string') {
    return redactText(value);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return null;
    }

    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLogValue(entry, seen));
  }

  // Keep the public diagnostic value as an ordinary JSON object while defining
  // properties explicitly so an attacker-controlled `__proto__` key cannot
  // mutate the object prototype during redaction.
  const sanitized = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    Object.defineProperty(sanitized, entryKey, {
      configurable: true,
      enumerable: true,
      value: sanitizeLogValue(entryValue, seen, entryKey),
      writable: true,
    });
  }

  return sanitized;
}

function normalizeContext(context) {
  const sanitized = sanitizeLogValue(context);
  if (sanitized === null || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(sanitized)) {
    const normalizedKey = CONTEXT_ALIASES[key] ?? key;
    normalized[normalizedKey] = value;
  }

  return normalized;
}

function writeRecord(stream, record) {
  stream.write(JSON.stringify(record) + '\n');
}

/**
 * Create a dependency-free structured JSON logger.
 *
 * The stable fields are UTC timestamp, level, service, environment, version,
 * build, event, tenant, actor, subject, correlation_id, request_id, result,
 * and reason. Additional event-specific fields are allowed after the stable
 * fields and pass through the same redaction routine.
 */
export function createLogger({
  serviceName = 'gulogulo-runtime',
  environment = 'development',
  version = '0.1.4',
  build = 'development',
  output = process.stdout,
  errorOutput = process.stderr,
  clock = () => new Date(),
  context = {},
} = {}) {
  const loggerContext = normalizeContext(context);
  const loggerOptions = {
    serviceName,
    environment,
    version,
    build,
    output,
    errorOutput,
    clock,
  };

  function log(level, event, details = {}, stream = output) {
    const sanitizedDetails = sanitizeLogValue(details);
    const rawEventDetails =
      sanitizedDetails !== null &&
      typeof sanitizedDetails === 'object' &&
      !Array.isArray(sanitizedDetails)
        ? sanitizedDetails
        : { details: sanitizedDetails };
    const eventDetails = Object.fromEntries(
      Object.entries(rawEventDetails).filter(([field]) => !RESERVED_FIELDS.has(field)),
    );

    const record = {
      timestamp: clock().toISOString(),
      level,
      service: serviceName,
      environment,
      version,
      build,
      event: redactText(String(event)),
      tenant: null,
      actor: null,
      subject: null,
      correlation_id: null,
      request_id: null,
      result: null,
      reason: null,
      ...eventDetails,
      ...loggerContext,
    };

    writeRecord(stream, record);
  }

  const logger = {
    info(event, details) {
      log('info', event, details);
    },
    warn(event, details) {
      log('warn', event, details, errorOutput);
    },
    error(event, details) {
      log('error', event, details, errorOutput);
    },
    child(childContext = {}) {
      return createLogger({
        ...loggerOptions,
        context: {
          ...loggerContext,
          ...childContext,
        },
      });
    },
    withContext(childContext = {}) {
      return this.child(childContext);
    },
  };

  return Object.freeze(logger);
}

export { REDACTED };
