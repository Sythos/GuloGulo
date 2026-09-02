// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

export {
  DEFAULT_PASSWORD_MAX_LENGTH,
  DEFAULT_PASSWORD_MIN_LENGTH,
  MAX_PASSWORD_EXPIRY_DAYS,
  NO_PASSWORD_EXPIRY_DAYS,
  PASSWORD_SYMBOL_ALLOWLIST,
  assertPasswordExpiryDays,
  createPasswordPolicy,
  validateBaselinePassword,
  validatePasswordExpiryDays,
} from './password-policy.ts';

export {
  DEFAULT_PASSWORD_HASH_COST,
  PASSWORD_HASH_ALGORITHM,
  PASSWORD_HASH_KEY_BYTES,
  PASSWORD_HASH_SALT_BYTES,
  PASSWORD_HASH_VERSION,
  createPasswordHasher,
} from './password-hashing.ts';

export {
  TOTP_DEFAULT_ALGORITHM,
  TOTP_DEFAULT_DIGITS,
  TOTP_DEFAULT_LOCKOUT_MS,
  TOTP_DEFAULT_PERIOD_SECONDS,
  TOTP_DEFAULT_WINDOW,
  TOTP_MAX_FAILURES,
  TOTP_SECRET_BYTES,
  createAesGcmSecretProtector,
  createTotpManager,
  decodeBase32,
  encodeBase32,
  generateTotpCode,
} from './totp.ts';

export {
  WEBAUTHN_DEFAULT_ALGORITHMS,
  WEBAUTHN_DEFAULT_CHALLENGE_TTL_MS,
  WEBAUTHN_RP_NAME,
  createAuthenticatorData,
  createWebAuthnManager,
} from './webauthn.ts';

export {
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_BYTES,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  createRecoveryCodeManager,
  generateRecoveryCode,
} from './recovery-codes.ts';
