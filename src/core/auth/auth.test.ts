// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)


import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAesGcmSecretProtector,
  createAuthenticatorData,
  createPasswordHasher,
  createPasswordPolicy,
  createRecoveryCodeManager,
  createTotpManager,
  createWebAuthnManager,
  generateTotpCode,
  validatePasswordExpiryDays,
} from './index.ts';

function createClock(start = 1_756_000_000_000) {
  let now = start;
  return {
    clock: () => now,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function createDeterministicRandomBytes() {
  let value = 1;
  return (size: number) => {
    const output = Buffer.alloc(size, value);
    value = (value % 250) + 1;
    return output;
  };
}

function identity(overrides: Partial<{tenantId: string; userId: string; actorId: string; role: string}> = {}) {
  return { tenantId: 'acme', userId: 'alice', actorId: 'alice', role: 'user', ...overrides };
}

function failureCode(result: unknown): string {
  assert.ok(result !== null && typeof result === 'object' && 'code' in result && typeof result.code === 'string');
  return result.code;
}

test('password policy is ASCII-only, explicit, and never normalizes input', () => {
  const policy = createPasswordPolicy();
  assert.equal(policy.validate('Abcd1234!').valid, true);
  assert.equal(failureCode(policy.validate('Äbcdef12')), 'PASSWORD_NON_ASCII');
  assert.equal(failureCode(policy.validate('Abcd 1234')), 'PASSWORD_CHARACTER_NOT_ALLOWED');
  assert.equal(failureCode(policy.validate('Abc123!')), 'PASSWORD_TOO_SHORT');
  assert.equal(failureCode(policy.validate('Abcd1234🙂')), 'PASSWORD_NON_ASCII');
  const validPassword = policy.validate('Abcd1234!');
  assert.ok(validPassword.valid);
  assert.equal(validPassword.expiryDays, 0);
  assert.equal(validatePasswordExpiryDays(9999).valid, true);
  assert.equal(failureCode(validatePasswordExpiryDays(10000)), 'PASSWORD_EXPIRY_OUT_OF_RANGE');
  assert.equal(validatePasswordExpiryDays(-1).valid, false);
  assert.equal(JSON.stringify(policy.validate('Abcd1234!')).includes('Abcd1234'), false);
});

test('password hashes use a versioned, upgradeable scrypt record without exposing the password', () => {
  const hasher = createPasswordHasher({ randomBytesFn: () => Buffer.alloc(16, 6) });
  const encoded = hasher.hash('Abcd1234!');
  assert.match(encoded, /^scrypt\$v1\$N=16384,r=8,p=1\$/u);
  assert.equal(hasher.verify('Abcd1234!', encoded).valid, true);
  assert.equal(hasher.verify('Wrong123!', encoded).valid, false);
  assert.equal(encoded.includes('Abcd1234'), false);
  assert.equal(hasher.verify('Äbcdef12', encoded).valid, false);
});

test('TOTP matches RFC 6238 vectors and protects secrets at rest', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(generateTotpCode(secret, Math.floor(59 / 30), { digits: 8 }), '94287082');
  assert.equal(generateTotpCode(secret, Math.floor(1111111109 / 30), { digits: 8 }), '07081804');

  const clock = createClock(1_700_000_000_000);
  const protector = createAesGcmSecretProtector({ key: Buffer.alloc(32, 7), randomBytesFn: () => Buffer.alloc(12, 8) });
  const auditEvents: Readonly<Record<string, unknown>>[] = [];
  const manager = createTotpManager({
    clock: clock.clock,
    randomBytesFn: createDeterministicRandomBytes(),
    secretProtector: protector,
    audit: (event) => auditEvents.push(event),
  });
  const enrollment = manager.enroll(identity());
  assert.equal(enrollment.factor.status, 'pending');
  const factor = manager.getFactor(enrollment.factor.factorId);
  assert.ok(factor);
  assert.equal('secret' in factor, false);
  assert.equal(JSON.stringify(manager.getFactor(enrollment.factor.factorId)).includes(enrollment.secret), false);
  assert.equal(enrollment.otpauthUri.startsWith('otpauth://totp/'), true);

  const counter = Math.floor(clock.clock() / 1000 / 30);
  const code = generateTotpCode(enrollment.secret, counter);
  const confirmed = manager.confirmEnrollment({ ...identity(), factorId: enrollment.factor.factorId, code });
  assert.equal(confirmed.confirmed, true);
  assert.equal(manager.verify({ ...identity(), factorId: enrollment.factor.factorId, code }).verified, false);
  clock.advance(30_000);
  const nextCode = generateTotpCode(enrollment.secret, counter + 1);
  assert.equal(manager.verify({ ...identity(), factorId: enrollment.factor.factorId, code: nextCode }).verified, true);
  assert.equal(auditEvents.some((event) => Object.values(event).includes(enrollment.secret)), false);
});

test('TOTP rejects cross-user access, invalidates revoked factors, and locks repeated failures', () => {
  const clock = createClock();
  const protector = createAesGcmSecretProtector({ key: Buffer.alloc(32, 9), randomBytesFn: () => Buffer.alloc(12, 3) });
  const manager = createTotpManager({ clock: clock.clock, randomBytesFn: createDeterministicRandomBytes(), secretProtector: protector, maxFailures: 2, lockoutMs: 60_000 });
  const enrollment = manager.enroll(identity());
  const code = generateTotpCode(enrollment.secret, Math.floor(clock.clock() / 1000 / 30));
  assert.throws(() => manager.confirmEnrollment({ ...identity({ userId: 'bob', actorId: 'bob' }), factorId: enrollment.factor.factorId, code }), { code: 'FACTOR_SCOPE_VIOLATION' });
  assert.equal(manager.confirmEnrollment({ ...identity(), factorId: enrollment.factor.factorId, code }).confirmed, true);
  assert.equal(failureCode(manager.verify({ ...identity(), factorId: enrollment.factor.factorId, code: '000000' })), 'INVALID_CODE');
  const locked = manager.verify({ ...identity(), factorId: enrollment.factor.factorId, code: '000000' });
  assert.ok('lockedUntil' in locked && locked.lockedUntil !== undefined && locked.lockedUntil > clock.clock());
  assert.equal(manager.revoke({ ...identity(), factorId: enrollment.factor.factorId }).revoked, true);
  assert.equal(failureCode(manager.verify({ ...identity(), factorId: enrollment.factor.factorId, code: '000000' })), 'FACTOR_REVOKED');
});

function clientData(type: string, challenge: string, origin = 'https://mail.example.test') {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8').toString('base64url');
}

test('WebAuthn validates origin, RP ID, challenge, credential, and monotonic counter', () => {
  const clock = createClock();
  const randomBytesFn = createDeterministicRandomBytes();
  const verifierCalls: string[] = [];
  const manager = createWebAuthnManager({
    clock: clock.clock,
    randomBytesFn,
    expectedOrigins: ['https://mail.example.test'],
    rpId: 'mail.example.test',
    credentialVerifier: (payload) => {
      verifierCalls.push(payload.operation);
      return true;
    },
  });
  const registration = manager.beginRegistration(identity());
  const credentialId = Buffer.alloc(16, 4).toString('base64url');
  const registrationResult = manager.completeRegistration({
    ...identity(),
    challenge: registration.challenge,
    credentialId,
    clientDataJSON: clientData('webauthn.create', registration.challenge),
    authenticatorData: createAuthenticatorData({ rpId: 'mail.example.test', flags: 0x41, signCount: 0 }),
    credentialPublicKey: { kty: 2, alg: -7 },
    signature: Buffer.alloc(64, 1).toString('base64url'),
  });
  assert.equal(registrationResult.registered, true);
  assert.deepEqual(verifierCalls, ['registration']);

  const assertion = manager.beginAssertion({ ...identity(), allowCredentials: [credentialId] });
  const assertionResult = manager.completeAssertion({
    ...identity(),
    challenge: assertion.challenge,
    credentialId,
    clientDataJSON: clientData('webauthn.get', assertion.challenge),
    authenticatorData: createAuthenticatorData({ rpId: 'mail.example.test', flags: 0x01, signCount: 1 }),
    signature: Buffer.alloc(64, 2).toString('base64url'),
  });
  assert.equal(assertionResult.verified, true);
  assert.deepEqual(verifierCalls, ['registration', 'assertion']);

  const rollback = manager.beginAssertion({ ...identity(), allowCredentials: [credentialId] });
  assert.equal(failureCode(manager.completeAssertion({
    ...identity(),
    challenge: rollback.challenge,
    credentialId,
    clientDataJSON: clientData('webauthn.get', rollback.challenge),
    authenticatorData: createAuthenticatorData({ rpId: 'mail.example.test', flags: 0x01, signCount: 1 }),
    signature: Buffer.alloc(64, 3).toString('base64url'),
  })), 'SIGN_COUNT_ROLLBACK');

  const wrongOrigin = manager.beginAssertion({ ...identity(), allowCredentials: [credentialId] });
  assert.equal(failureCode(manager.completeAssertion({
    ...identity(),
    challenge: wrongOrigin.challenge,
    credentialId,
    clientDataJSON: clientData('webauthn.get', wrongOrigin.challenge, 'https://evil.example.test'),
    authenticatorData: createAuthenticatorData({ rpId: 'mail.example.test', flags: 0x01, signCount: 2 }),
    signature: Buffer.alloc(64, 4).toString('base64url'),
  })), 'CLIENT_DATA_MISMATCH');
  assert.equal(failureCode(manager.completeAssertion({
    ...identity(),
    challenge: wrongOrigin.challenge,
    credentialId,
    clientDataJSON: clientData('webauthn.get', wrongOrigin.challenge),
    authenticatorData: createAuthenticatorData({ rpId: 'mail.example.test', flags: 0x01, signCount: 2 }),
    signature: Buffer.alloc(64, 4).toString('base64url'),
  })), 'CHALLENGE_INVALID');
});

test('WebAuthn never permits an administrative actor to enroll a user factor', () => {
  const manager = createWebAuthnManager({ expectedOrigins: ['https://mail.example.test'], rpId: 'mail.example.test', credentialVerifier: () => true });
  assert.throws(() => manager.beginRegistration({ ...identity(), actorId: 'master', role: 'tenant_master' }), { code: 'FACTOR_SCOPE_VIOLATION' });
});

test('WebAuthn passes the validated credential ID to a delegated revocation hook', () => {
  const manager = createWebAuthnManager({
    expectedOrigins: ['https://mail.example.test'],
    rpId: 'mail.example.test',
    credentialVerifier: () => true,
    authorizeRevocation: (request) => request.actorId === 'master' && request.credentialId === credentialId,
  });
  const credentialId = Buffer.alloc(16, 8).toString('base64url');
  const registration = manager.beginRegistration(identity());
  assert.equal(manager.completeRegistration({
    ...identity(), challenge: registration.challenge, credentialId,
    clientDataJSON: clientData('webauthn.create', registration.challenge),
    authenticatorData: createAuthenticatorData({ rpId: 'mail.example.test' }),
    credentialPublicKey: { kty: 2, alg: -7 },
  }).registered, true);
  assert.equal(manager.revokeCredential({ ...identity(), credentialId, actorId: 'master', actorRole: 'tenant_master' }).revoked, true);
});

test('WebAuthn rejects private-key-shaped public-key material', () => {
  const manager = createWebAuthnManager({ expectedOrigins: ['https://mail.example.test'], rpId: 'mail.example.test', credentialVerifier: () => true });
  const registration = manager.beginRegistration(identity());
  const result = manager.completeRegistration({
    ...identity(),
    challenge: registration.challenge,
    credentialId: Buffer.alloc(16, 5).toString('base64url'),
    clientDataJSON: clientData('webauthn.create', registration.challenge),
    authenticatorData: createAuthenticatorData({ rpId: 'mail.example.test', flags: 0x41 }),
    credentialPublicKey: { kty: 2, d: 'private' },
  });
  assert.equal(failureCode(result), 'PUBLIC_KEY_INVALID');
});

test('recovery codes are one-time, salted, scoped, rate-limited, and revocable', () => {
  const clock = createClock();
  const auditEvents: Readonly<Record<string, unknown>>[] = [];
  const manager = createRecoveryCodeManager({ clock: clock.clock, randomBytesFn: createDeterministicRandomBytes(), count: 5, audit: (event) => auditEvents.push(event) });
  const enrollment = manager.enroll(identity());
  assert.equal(enrollment.codes.length, 5);
  assert.match(enrollment.codes[0], /^[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){3}$/u);
  assert.equal(manager.getFactor(enrollment.factor.factorId)?.remainingCodes, 5);
  assert.equal(manager.consume({ ...identity(), factorId: enrollment.factor.factorId, code: enrollment.codes[0] }).recovered, true);
  assert.equal(manager.consume({ ...identity(), factorId: enrollment.factor.factorId, code: enrollment.codes[0] }).recovered, false);
  assert.equal(manager.getFactor(enrollment.factor.factorId)?.remainingCodes, 4);
  assert.equal(auditEvents.some((event) => Object.values(event).some((value) => typeof value === 'string' && enrollment.codes.includes(value))), false);
  assert.equal(manager.revoke({ ...identity(), factorId: enrollment.factor.factorId }).revoked, true);
  assert.equal(failureCode(manager.consume({ ...identity(), factorId: enrollment.factor.factorId, code: enrollment.codes[1] })), 'FACTOR_REVOKED');
  assert.throws(() => manager.enroll({ ...identity(), actorId: 'master', role: 'tenant_master' }), { code: 'FACTOR_SCOPE_VIOLATION' });
});
