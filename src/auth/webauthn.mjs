// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const WEBAUTHN_DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const WEBAUTHN_RP_NAME = 'Gulo Gulo';
export const WEBAUTHN_DEFAULT_ALGORITHMS = Object.freeze([-7, -257]);

const ID_PATTERN = /^[a-z0-9][a-z0-9._:@/-]{0,127}$/u;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{16,1024}$/u;
const FORBIDDEN_ROLES = new Set(['provider', 'tenant_master', 'master', 'monitor', 'admin']);

function authError(message, code = 'WEBAUTHN_ERROR') {
  const error = new Error(`WebAuthn error: ${message}`);
  error.code = code;
  return error;
}

function readTime(clock) {
  const value = clock();
  const time = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(time) || time < 0) {
    throw authError('clock must return a non-negative millisecond timestamp', 'INVALID_CLOCK');
  }
  return Math.trunc(time);
}

function assertIdentityPart(value, name) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw authError(`${name} is invalid`, 'INVALID_IDENTITY');
  }
  return value;
}

function assertRandomBytes(randomBytesFn, size) {
  const bytes = randomBytesFn(size);
  if (!Buffer.isBuffer(bytes) || bytes.length !== size) {
    throw authError(`randomBytesFn must return ${size} bytes`, 'INVALID_RANDOM_SOURCE');
  }
  return bytes;
}

function assertUserActor({ tenantId, userId, actorId = userId, role = 'user' }) {
  assertIdentityPart(tenantId, 'tenantId');
  assertIdentityPart(userId, 'userId');
  assertIdentityPart(actorId, 'actorId');
  if (actorId !== userId || FORBIDDEN_ROLES.has(role)) {
    throw authError('WebAuthn ceremonies must be initiated by the user', 'FACTOR_SCOPE_VIOLATION');
  }
  return { tenantId, userId, actorId, role };
}

function assertChallenge(value) {
  if (typeof value !== 'string' || !CHALLENGE_PATTERN.test(value)) {
    throw authError('challenge is invalid', 'CHALLENGE_INVALID');
  }
  return value;
}

function assertCredentialId(value) {
  if (typeof value !== 'string' || !CREDENTIAL_ID_PATTERN.test(value)) {
    throw authError('credentialId is invalid', 'CREDENTIAL_INVALID');
  }
  return value;
}

function decodeBase64Url(value, name, { min = 1, max = 4096 } = {}) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw authError(`${name} is not valid base64url`, 'MALFORMED_RESPONSE');
  }
  const result = Buffer.from(value, 'base64url');
  if (result.length < min || result.length > max) {
    throw authError(`${name} has an invalid length`, 'MALFORMED_RESPONSE');
  }
  return result;
}

function binaryValue(value, name, options) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return decodeBase64Url(value, name, options);
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function assertOrigin(origin) {
  if (typeof origin !== 'string' || origin.length > 512) {
    throw authError('origin is invalid', 'INVALID_ORIGIN');
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw authError('origin is invalid', 'INVALID_ORIGIN');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw authError('origin must be an HTTPS origin without credentials or a path', 'INVALID_ORIGIN');
  }
  return parsed.origin;
}

function assertRpId(rpId) {
  if (typeof rpId !== 'string' || rpId.length < 1 || rpId.length > 253 || rpId !== rpId.toLowerCase()
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(rpId)) {
    throw authError('rpId is invalid', 'INVALID_RP_ID');
  }
  return rpId;
}

function parseClientData(value) {
  const bytes = binaryValue(value, 'clientDataJSON', { min: 2, max: 16 * 1024 });
  let clientData;
  try {
    clientData = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw authError('clientDataJSON is not valid JSON', 'MALFORMED_RESPONSE');
  }
  if (clientData === null || typeof clientData !== 'object' || Array.isArray(clientData)
    || typeof clientData.type !== 'string' || typeof clientData.challenge !== 'string' || typeof clientData.origin !== 'string') {
    throw authError('clientDataJSON does not contain the required fields', 'MALFORMED_RESPONSE');
  }
  return Object.freeze({ type: clientData.type, challenge: clientData.challenge, origin: clientData.origin });
}

function parseAuthenticatorData(value, rpId, { registration = false, requireUserVerification = false } = {}) {
  const bytes = binaryValue(value, 'authenticatorData', { min: 37, max: 16 * 1024 });
  const expectedRpHash = createHash('sha256').update(rpId, 'utf8').digest();
  if (!timingSafeEqual(bytes.subarray(0, 32), expectedRpHash)) {
    throw authError('authenticatorData RP ID hash does not match the configured RP ID', 'RP_ID_MISMATCH');
  }
  const flags = bytes[32];
  if ((flags & 0x01) === 0) {
    throw authError('user presence flag is required', 'USER_PRESENCE_REQUIRED');
  }
  if (requireUserVerification && (flags & 0x04) === 0) {
    throw authError('user verification flag is required', 'USER_VERIFICATION_REQUIRED');
  }
  if (registration && (flags & 0x40) === 0) {
    throw authError('attested credential data is required during registration', 'ATTESTATION_REQUIRED');
  }
  return Object.freeze({
    bytes,
    rpIdHash: bytes.subarray(0, 32),
    flags,
    userPresent: true,
    userVerified: (flags & 0x04) !== 0,
    signCount: bytes.readUInt32BE(33),
    attestedCredentialData: registration ? bytes.subarray(37) : undefined,
  });
}

function compareStrings(left, right) {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function metadata(record) {
  return Object.freeze({
    credentialId: record.credentialId,
    type: 'webauthn',
    tenantId: record.tenantId,
    userId: record.userId,
    label: record.label,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    signCount: record.signCount,
    revokedAt: record.revokedAt,
    transports: record.transports,
  });
}

function auditEvent(audit, event) {
  try {
    audit(Object.freeze({ ...event }));
  } catch {
    // Never let an audit sink turn a safe ceremony failure into secret output.
  }
}

function normalizeLabel(label) {
  if (label === undefined) return 'passkey';
  if (typeof label !== 'string' || label.length < 1 || label.length > 64 || /[\r\n]/u.test(label)) {
    throw authError('label is invalid', 'INVALID_LABEL');
  }
  return label;
}

function verifierSucceeded(result) {
  return result === true || (result !== null && typeof result === 'object' && result.valid === true);
}

function isPublicKeyMaterial(value) {
  if (Buffer.isBuffer(value)) return value.length > 0 && value.length <= 16 * 1024;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  // COSE public keys do not contain these private-key fields. Refuse them at
  // the boundary so a later adapter cannot accidentally persist key material.
  return !Object.keys(value).some((key) => /^(?:d|private|privateKey|secret|secretKey|pem)$/iu.test(key));
}

/**
 * Contract-level WebAuthn ceremony manager. CBOR/COSE and attestation
 * signature verification remain behind the required credentialVerifier hook;
 * this boundary performs the server-side origin, RP ID, challenge, credential,
 * and signature-counter checks before mutating credential state.
 */
export function createWebAuthnManager({
  clock = () => Date.now(),
  randomBytesFn = nodeRandomBytes,
  expectedOrigins,
  rpId,
  rpName = WEBAUTHN_RP_NAME,
  challengeTtlMs = WEBAUTHN_DEFAULT_CHALLENGE_TTL_MS,
  requireUserVerification = false,
  credentialVerifier,
  rateLimiter = () => true,
  authorizeRevocation = () => false,
  audit = () => {},
  challenges = new Map(),
  credentials = new Map(),
} = {}) {
  if (!Array.isArray(expectedOrigins) || expectedOrigins.length === 0 || expectedOrigins.length > 8) {
    throw authError('expectedOrigins must contain one to eight origins', 'INVALID_ORIGIN');
  }
  const origins = new Set(expectedOrigins.map(assertOrigin));
  const canonicalRpId = assertRpId(rpId);
  for (const origin of origins) {
    const originHost = new URL(origin).hostname.toLowerCase();
    if (originHost !== canonicalRpId && !originHost.endsWith(`.${canonicalRpId}`)) {
      throw authError('configured origin is outside the RP ID scope', 'INVALID_RP_ID');
    }
  }
  if (typeof rpName !== 'string' || rpName.length < 1 || rpName.length > 64 || /[\r\n]/u.test(rpName)) {
    throw authError('rpName is invalid', 'INVALID_RP_ID');
  }
  if (!Number.isSafeInteger(challengeTtlMs) || challengeTtlMs < 30_000 || challengeTtlMs > 10 * 60 * 1000) {
    throw authError('challengeTtlMs is invalid', 'INVALID_TTL');
  }
  if (typeof credentialVerifier !== 'function') {
    throw authError('credentialVerifier is required', 'INVALID_VERIFIER');
  }
  if (typeof authorizeRevocation !== 'function') throw authError('authorizeRevocation must be a function', 'INVALID_AUTHORIZER');
  if (challenges === null || typeof challenges.get !== 'function' || typeof challenges.set !== 'function' || typeof challenges.delete !== 'function') {
    throw authError('challenges must implement get, set, and delete', 'INVALID_CHALLENGE_STORE');
  }
  if (credentials === null || typeof credentials.get !== 'function' || typeof credentials.set !== 'function' || typeof credentials.delete !== 'function') {
    throw authError('credentials must implement get, set, and delete', 'INVALID_CREDENTIAL_STORE');
  }

  function issueChallenge(type, identity, allowCredentials = []) {
    const challenge = base64Url(assertRandomBytes(randomBytesFn, 32));
    const now = readTime(clock);
    const record = Object.freeze({
      challenge,
      type,
      tenantId: identity.tenantId,
      userId: identity.userId,
      allowCredentials: Object.freeze([...allowCredentials]),
      createdAt: now,
      expiresAt: now + challengeTtlMs,
    });
    challenges.set(challenge, record);
    return record;
  }

  function consumeChallenge(challenge, type, tenantId, userId, now) {
    if (typeof challenge !== 'string' || !CHALLENGE_PATTERN.test(challenge)) return null;
    const record = challenges.get(challenge);
    challenges.delete(challenge);
    if (record === undefined || record.type !== type || record.tenantId !== tenantId || record.userId !== userId || record.expiresAt <= now) {
      return null;
    }
    return record;
  }

  function verifyClientData(clientDataJSON, expectedType, challenge) {
    const clientData = parseClientData(clientDataJSON);
    if (clientData.type !== expectedType || !compareStrings(clientData.challenge, challenge) || !origins.has(assertOrigin(clientData.origin))) {
      throw authError('clientData type, challenge, or origin does not match the ceremony', 'CLIENT_DATA_MISMATCH');
    }
    return clientData;
  }

  function callVerifier(payload) {
    try {
      return verifierSucceeded(credentialVerifier(Object.freeze(payload)));
    } catch {
      return false;
    }
  }

  function beginRegistration({ tenantId, userId, actorId = userId, role = 'user', displayName = userId } = {}) {
    const identity = assertUserActor({ tenantId, userId, actorId, role });
    if (Buffer.byteLength(userId, 'utf8') > 64) throw authError('userId is too long for a WebAuthn user handle', 'INVALID_IDENTITY');
    if (typeof displayName !== 'string' || displayName.length < 1 || displayName.length > 64 || /[\r\n]/u.test(displayName)) {
      throw authError('displayName is invalid', 'INVALID_IDENTITY');
    }
    const record = issueChallenge('registration', identity);
    return Object.freeze({
      challenge: record.challenge,
      rp: Object.freeze({ id: canonicalRpId, name: rpName }),
      user: Object.freeze({ id: base64Url(Buffer.from(userId, 'utf8')), name: userId, displayName }),
      pubKeyCredParams: WEBAUTHN_DEFAULT_ALGORITHMS,
      timeout: challengeTtlMs,
      attestation: 'none',
    });
  }

  function completeRegistration({
    tenantId,
    userId,
    challenge,
    credentialId,
    clientDataJSON,
    authenticatorData,
    credentialPublicKey,
    signature,
    attestationObject,
    label,
    transports = [],
  } = {}) {
    assertIdentityPart(tenantId, 'tenantId');
    assertIdentityPart(userId, 'userId');
    const now = readTime(clock);
    const ceremony = consumeChallenge(challenge, 'registration', tenantId, userId, now);
    if (ceremony === null) return Object.freeze({ registered: false, code: 'CHALLENGE_INVALID' });
    let id;
    try {
      id = assertCredentialId(credentialId);
      const parsedClientData = verifyClientData(clientDataJSON, 'webauthn.create', ceremony.challenge);
      const parsedAuthenticatorData = parseAuthenticatorData(authenticatorData, canonicalRpId, { registration: true, requireUserVerification });
      if (!isPublicKeyMaterial(credentialPublicKey)) {
        return Object.freeze({ registered: false, code: 'PUBLIC_KEY_INVALID' });
      }
      if (credentials.has(id)) return Object.freeze({ registered: false, code: 'CREDENTIAL_ALREADY_REGISTERED' });
      const valid = callVerifier({
        operation: 'registration',
        tenantId,
        userId,
        credentialId: id,
        clientData: parsedClientData,
        clientDataJSON: binaryValue(clientDataJSON, 'clientDataJSON', { min: 2, max: 16 * 1024 }),
        authenticatorData: parsedAuthenticatorData,
        signature: signature === undefined ? undefined : binaryValue(signature, 'signature', { min: 1, max: 16 * 1024 }),
        attestationObject: attestationObject === undefined ? undefined : binaryValue(attestationObject, 'attestationObject', { min: 1, max: 64 * 1024 }),
        credentialPublicKey,
      });
      if (!valid) return Object.freeze({ registered: false, code: 'ATTESTATION_INVALID' });
      if (!Array.isArray(transports) || transports.some((value) => typeof value !== 'string' || !['usb', 'nfc', 'ble', 'internal', 'hybrid'].includes(value))) {
        return Object.freeze({ registered: false, code: 'TRANSPORTS_INVALID' });
      }
      const record = {
        credentialId: id,
        tenantId,
        userId,
        label: normalizeLabel(label),
        publicKey: credentialPublicKey,
        signCount: parsedAuthenticatorData.signCount,
        createdAt: now,
        lastUsedAt: undefined,
        revokedAt: undefined,
        transports: Object.freeze([...transports]),
      };
      credentials.set(id, record);
      auditEvent(audit, { eventType: 'auth.webauthn.enrolled', tenantId, userId, credentialId: id, occurredAt: now });
      return Object.freeze({ registered: true, credential: metadata(record) });
    } catch (error) {
      if (error?.code === 'INVALID_ORIGIN' || error?.code === 'RP_ID_MISMATCH' || error?.code === 'CLIENT_DATA_MISMATCH' || error?.code === 'MALFORMED_RESPONSE' || error?.code === 'USER_PRESENCE_REQUIRED' || error?.code === 'ATTESTATION_REQUIRED') {
        return Object.freeze({ registered: false, code: error.code });
      }
      throw error;
    }
  }

  function beginAssertion({ tenantId, userId, actorId = userId, role = 'user', allowCredentials = [] } = {}) {
    const identity = assertUserActor({ tenantId, userId, actorId, role });
    if (!Array.isArray(allowCredentials) || allowCredentials.length > 64) {
      throw authError('allowCredentials is invalid', 'CREDENTIAL_INVALID');
    }
    const scoped = allowCredentials.map(assertCredentialId).filter((id) => {
      const credential = credentials.get(id);
      return credential !== undefined && credential.tenantId === tenantId && credential.userId === userId && credential.revokedAt === undefined;
    });
    const eligible = allowCredentials.length > 0 ? scoped : [...credentials.values()]
      .filter((credential) => credential.tenantId === tenantId && credential.userId === userId && credential.revokedAt === undefined)
      .map((credential) => credential.credentialId);
    const record = issueChallenge('assertion', identity, eligible);
    return Object.freeze({
      challenge: record.challenge,
      rpId: canonicalRpId,
      timeout: challengeTtlMs,
      userVerification: requireUserVerification ? 'required' : 'preferred',
      allowCredentials: Object.freeze(eligible.map((id) => Object.freeze({ id, type: 'public-key' }))),
    });
  }

  function completeAssertion({
    tenantId,
    userId,
    challenge,
    credentialId,
    clientDataJSON,
    authenticatorData,
    signature,
  } = {}) {
    assertIdentityPart(tenantId, 'tenantId');
    assertIdentityPart(userId, 'userId');
    const now = readTime(clock);
    const ceremony = consumeChallenge(challenge, 'assertion', tenantId, userId, now);
    if (ceremony === null) return Object.freeze({ verified: false, code: 'CHALLENGE_INVALID' });
    let id;
    try {
      id = assertCredentialId(credentialId);
      if (ceremony.allowCredentials.length > 0 && !ceremony.allowCredentials.includes(id)) {
        return Object.freeze({ verified: false, code: 'CREDENTIAL_NOT_ALLOWED' });
      }
      const credential = credentials.get(id);
      if (credential === undefined || credential.tenantId !== tenantId || credential.userId !== userId) {
        return Object.freeze({ verified: false, code: 'CREDENTIAL_NOT_FOUND' });
      }
      if (credential.revokedAt !== undefined) return Object.freeze({ verified: false, code: 'CREDENTIAL_REVOKED' });
      const parsedClientData = verifyClientData(clientDataJSON, 'webauthn.get', ceremony.challenge);
      const parsedAuthenticatorData = parseAuthenticatorData(authenticatorData, canonicalRpId, { requireUserVerification });
      const clientDataBytes = binaryValue(clientDataJSON, 'clientDataJSON', { min: 2, max: 16 * 1024 });
      const authenticatorBytes = parsedAuthenticatorData.bytes;
      const signedData = Buffer.concat([authenticatorBytes, createHash('sha256').update(clientDataBytes).digest()]);
      let allowed;
      try {
        allowed = rateLimiter({ action: 'auth.webauthn.assertion', key: `${tenantId}:${userId}:${id}`, tenantId, userId, credentialId: id });
      } catch {
        allowed = false;
      }
      if (!(allowed === true || (allowed !== false && allowed?.allowed === true))) return Object.freeze({ verified: false, code: 'RATE_LIMITED' });
      if (!callVerifier({
        operation: 'assertion',
        tenantId,
        userId,
        credentialId: id,
        credential,
        clientData: parsedClientData,
        clientDataJSON: clientDataBytes,
        authenticatorData: parsedAuthenticatorData,
        signature: binaryValue(signature, 'signature', { min: 1, max: 16 * 1024 }),
        signedData,
      })) {
        auditEvent(audit, { eventType: 'auth.webauthn.verification_failed', tenantId, userId, credentialId: id, reason: 'SIGNATURE_INVALID', occurredAt: now });
        return Object.freeze({ verified: false, code: 'SIGNATURE_INVALID' });
      }
      if (credential.signCount > 0 && parsedAuthenticatorData.signCount > 0 && parsedAuthenticatorData.signCount <= credential.signCount) {
        auditEvent(audit, { eventType: 'auth.webauthn.verification_failed', tenantId, userId, credentialId: id, reason: 'SIGN_COUNT_ROLLBACK', occurredAt: now });
        return Object.freeze({ verified: false, code: 'SIGN_COUNT_ROLLBACK' });
      }
      credential.signCount = parsedAuthenticatorData.signCount;
      credential.lastUsedAt = now;
      auditEvent(audit, { eventType: 'auth.webauthn.verified', tenantId, userId, credentialId: id, occurredAt: now });
      return Object.freeze({ verified: true, credential: metadata(credential) });
    } catch (error) {
      if (error?.code === 'INVALID_ORIGIN' || error?.code === 'RP_ID_MISMATCH' || error?.code === 'CLIENT_DATA_MISMATCH' || error?.code === 'MALFORMED_RESPONSE' || error?.code === 'USER_PRESENCE_REQUIRED' || error?.code === 'USER_VERIFICATION_REQUIRED') {
        return Object.freeze({ verified: false, code: error.code });
      }
      throw error;
    }
  }

  function getCredential(credentialId) {
    const id = assertCredentialId(credentialId);
    const record = credentials.get(id);
    return record === undefined ? null : metadata(record);
  }

  function listCredentialMetadata({ tenantId, userId } = {}) {
    assertIdentityPart(tenantId, 'tenantId');
    assertIdentityPart(userId, 'userId');
    return Object.freeze([...credentials.values()]
      .filter((credential) => credential.tenantId === tenantId && credential.userId === userId)
      .map(metadata));
  }

  function revokeCredential({ tenantId, userId, credentialId, actorId = userId, actorRole = 'user', reason = 'user_request' } = {}) {
    assertIdentityPart(tenantId, 'tenantId');
    assertIdentityPart(userId, 'userId');
    assertIdentityPart(actorId, 'actorId');
    let authorized = actorId === userId && actorRole === 'user';
    if (!authorized && actorId !== userId) {
      try {
        authorized = authorizeRevocation({ actorId, actorRole, tenantId, userId, credentialId: id });
      } catch {
        authorized = false;
      }
    }
    if (authorized !== true) throw authError('credential revocation is not authorized', 'FACTOR_SCOPE_VIOLATION');
    const id = assertCredentialId(credentialId);
    const record = credentials.get(id);
    if (record === undefined || record.tenantId !== tenantId || record.userId !== userId) return Object.freeze({ revoked: false, code: 'CREDENTIAL_NOT_FOUND' });
    if (typeof reason !== 'string' || reason.length < 1 || reason.length > 128 || /[\r\n]/u.test(reason)) throw authError('reason is invalid', 'INVALID_REASON');
    const now = readTime(clock);
    record.revokedAt = now;
    auditEvent(audit, { eventType: 'auth.webauthn.revoked', tenantId, userId, credentialId: id, actorId, actorRole, reason, occurredAt: now });
    return Object.freeze({ revoked: true, credential: metadata(record) });
  }

  return Object.freeze({
    beginRegistration,
    completeRegistration,
    beginAssertion,
    completeAssertion,
    getCredential,
    listCredentialMetadata,
    revokeCredential,
    challenges,
    credentials,
    configuration: Object.freeze({ rpId: canonicalRpId, origins: Object.freeze([...origins]), challengeTtlMs, requireUserVerification }),
  });
}

export function createAuthenticatorData({ rpId, flags = 0x41, signCount = 0, attestedCredentialData = Buffer.alloc(16 + 2 + 16) } = {}) {
  const canonicalRpId = assertRpId(rpId);
  if (!Number.isSafeInteger(signCount) || signCount < 0 || signCount > 0xffffffff) throw authError('signCount is invalid', 'INVALID_COUNTER');
  const tail = Buffer.isBuffer(attestedCredentialData) ? attestedCredentialData : Buffer.from(attestedCredentialData);
  if ((flags & 0x40) !== 0 && tail.length < 18) throw authError('attestedCredentialData is too short', 'MALFORMED_RESPONSE');
  const output = Buffer.alloc(37 + (((flags & 0x40) !== 0) ? tail.length : 0));
  createHash('sha256').update(canonicalRpId, 'utf8').digest().copy(output, 0);
  output[32] = flags;
  output.writeUInt32BE(signCount, 33);
  if ((flags & 0x40) !== 0) tail.copy(output, 37);
  return output.toString('base64url');
}
