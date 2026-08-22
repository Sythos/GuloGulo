// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/**
 * The baseline Gulo Gulo password alphabet deliberately stops at printable
 * ASCII.  A password is never normalized: accepting a normalized equivalent
 * would make the value stored by LDAP differ from the value the user chose.
 *
 * The symbol list is intentionally explicit so a client cannot accidentally
 * introduce whitespace, control characters, non-ASCII punctuation, or a
 * locale-specific character class.
 */
export const PASSWORD_SYMBOL_ALLOWLIST = Object.freeze(
  "!#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".split(''),
);

export const DEFAULT_PASSWORD_MIN_LENGTH = 8;
export const DEFAULT_PASSWORD_MAX_LENGTH = 256;
export const MAX_PASSWORD_EXPIRY_DAYS = 9999;
export const NO_PASSWORD_EXPIRY_DAYS = 0;

const PASSWORD_PATTERN = /^[A-Za-z0-9!#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]+$/u;
const INTEGER_PATTERN = /^(0|[1-9][0-9]{0,3})$/u;

function policyError(message, code = 'PASSWORD_POLICY_ERROR') {
  const error = new Error(`Password policy error: ${message}`);
  error.code = code;
  return error;
}

function assertInteger(value, name) {
  if (!Number.isSafeInteger(value)) {
    throw policyError(`${name} must be an integer`, 'INVALID_POLICY');
  }
  return value;
}

/**
 * Validate the configurable expiry without ever accepting a value larger
 * than the normative 9999-day limit. Zero means that expiry is disabled.
 */
export function validatePasswordExpiryDays(expiryDays) {
  if (!Number.isSafeInteger(expiryDays) || expiryDays < NO_PASSWORD_EXPIRY_DAYS || expiryDays > MAX_PASSWORD_EXPIRY_DAYS) {
    return Object.freeze({
      valid: false,
      code: 'PASSWORD_EXPIRY_OUT_OF_RANGE',
      message: `Password expiry must be between 0 and ${MAX_PASSWORD_EXPIRY_DAYS} days`,
    });
  }
  return Object.freeze({ valid: true, expiryDays });
}

/**
 * Create a tenant-safe password policy. The minimum may be increased by a
 * tenant/master, but the baseline cannot be weakened. The validator returns
 * reason codes and never includes the submitted password in an error.
 */
export function createPasswordPolicy({
  minLength = DEFAULT_PASSWORD_MIN_LENGTH,
  maxLength = DEFAULT_PASSWORD_MAX_LENGTH,
  expiryDays = NO_PASSWORD_EXPIRY_DAYS,
} = {}) {
  assertInteger(minLength, 'minLength');
  assertInteger(maxLength, 'maxLength');
  if (minLength < DEFAULT_PASSWORD_MIN_LENGTH || minLength > maxLength) {
    throw policyError(`minLength must be between ${DEFAULT_PASSWORD_MIN_LENGTH} and maxLength`, 'INVALID_POLICY');
  }
  if (maxLength < DEFAULT_PASSWORD_MAX_LENGTH || maxLength > 1024) {
    throw policyError(`maxLength must be between ${DEFAULT_PASSWORD_MAX_LENGTH} and 1024`, 'INVALID_POLICY');
  }
  const expiry = validatePasswordExpiryDays(expiryDays);
  if (!expiry.valid) {
    throw policyError(expiry.message, 'INVALID_POLICY');
  }

  function validate(password) {
    if (typeof password !== 'string') {
      return Object.freeze({ valid: false, code: 'PASSWORD_NOT_STRING', message: 'Password must be a string' });
    }
    // JS string length is sufficient after the ASCII check. No normalization
    // or case folding is performed here or by any helper in this module.
    if (password.length < minLength) {
      return Object.freeze({ valid: false, code: 'PASSWORD_TOO_SHORT', message: `Password must contain at least ${minLength} characters` });
    }
    if (password.length > maxLength) {
      return Object.freeze({ valid: false, code: 'PASSWORD_TOO_LONG', message: `Password must contain at most ${maxLength} characters` });
    }
    if (!PASSWORD_PATTERN.test(password)) {
      const hasNonAscii = [...password].some((character) => character.codePointAt(0) > 0x7f);
      return Object.freeze({
        valid: false,
        code: hasNonAscii ? 'PASSWORD_NON_ASCII' : 'PASSWORD_CHARACTER_NOT_ALLOWED',
        message: hasNonAscii ? 'Password may contain ASCII characters only' : 'Password contains a character outside the ordinary ASCII allowlist',
      });
    }
    return Object.freeze({ valid: true, expiryDays });
  }

  function assert(password) {
    const result = validate(password);
    if (!result.valid) {
      throw policyError(result.message, result.code);
    }
    return result;
  }

  return Object.freeze({
    minLength,
    maxLength,
    expiryDays,
    validate,
    assert,
    validateExpiryDays: validatePasswordExpiryDays,
    symbolAllowlist: PASSWORD_SYMBOL_ALLOWLIST,
  });
}

/**
 * Check whether a value is a valid printable baseline password without
 * creating a policy object. This is useful at API boundaries that only need
 * the immutable baseline.
 */
export function validateBaselinePassword(password) {
  return createPasswordPolicy().validate(password);
}

export function assertPasswordExpiryDays(expiryDays) {
  const result = validatePasswordExpiryDays(expiryDays);
  if (!result.valid) {
    throw policyError(result.message, result.code);
  }
  return result.expiryDays;
}

// Keep these constants in the module as executable documentation. They also
// make accidental edits to the explicit ASCII contract easy to detect.
if (PASSWORD_SYMBOL_ALLOWLIST.join('') !== "!#$%&'()*+,-./:;<=>?@[\\]^_`{|}~" || !INTEGER_PATTERN.test('9999')) {
  throw new Error('Password policy constants are inconsistent');
}
