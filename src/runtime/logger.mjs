// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

const SENSITIVE_KEY_PATTERN = /(authorization|credential|password|passphrase|private|secret|token|key)/i;

function sanitizeValue(value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeValue(nestedValue),
      ]),
    );
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  return value;
}

function writeRecord(stream, record) {
  stream.write(`${JSON.stringify(record)}\n`);
}

/**
 * Create a small structured logger with an allow-by-convention, defensive
 * redaction pass. Callers must still avoid sending request bodies or secrets to
 * the logger.
 */
export function createLogger({
  serviceName = 'gulogulo-runtime',
  environment = 'development',
  output = process.stdout,
  errorOutput = process.stderr,
  clock = () => new Date(),
} = {}) {
  function log(level, event, details = {}, stream = output) {
    const record = {
      timestamp: clock().toISOString(),
      level,
      service: serviceName,
      environment,
      event,
      ...sanitizeValue(details),
    };

    writeRecord(stream, record);
  }

  return Object.freeze({
    info(event, details) {
      log('info', event, details);
    },
    warn(event, details) {
      log('warn', event, details);
    },
    error(event, details) {
      log('error', event, details, errorOutput);
    },
  });
}
