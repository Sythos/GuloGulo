// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createAesGcmSecretProtector, createRecoveryCodeManager, createTotpManager, generateTotpCode } from '../core/auth/index.ts';
import { createLogger } from './logger.js';
import { createMfaGate, type MfaPolicy, type MfaRecoveryManager, type MfaTotpManager, type MfaWebAuthnManager } from './mfa.ts';
import { createRuntimeServer, startServer, stopServer } from './server.ts';

interface JsonResponse { statusCode: number | undefined; headers: IncomingHttpHeaders; body: any }

const USERS: Record<string, { tenantId: string; domain: string; userId: string }> = {
  'alice@acme.example': { tenantId: 'acme.example', domain: 'acme.example', userId: 'alice' },
  'bob@acme.example': { tenantId: 'acme.example', domain: 'acme.example', userId: 'bob' },
  'alice@other.example': { tenantId: 'other.example', domain: 'other.example', userId: 'alice' },
};
const PASSWORD = 'test-only-password';
const START = Date.UTC(2026, 0, 1, 12, 0, 0);

function setup(policy: Partial<MfaPolicy> = {}, webauthn?: MfaWebAuthnManager) {
  let nowMs = START;
  const totp = createTotpManager({ clock: () => nowMs, secretProtector: createAesGcmSecretProtector({ key: Buffer.alloc(32, 7) }) }) as unknown as MfaTotpManager;
  const recovery = createRecoveryCodeManager({ clock: () => nowMs }) as unknown as MfaRecoveryManager;
  const gate = createMfaGate({
    policy: { totp: 'required', webauthn: 'disabled', recoveryCodes: true, ...policy },
    clock: () => new Date(nowMs),
    totp,
    recovery,
    ...(webauthn === undefined ? {} : { webauthn }),
  });
  const output = new PassThrough();
  const runtime = createRuntimeServer({
    config: { host: '127.0.0.1', port: 0, serviceName: 'gulogulo-test', environment: 'test', shutdownTimeoutMs: 1_000 } as never,
    logger: createLogger({ output: output as unknown as typeof process.stdout, errorOutput: new PassThrough() as unknown as typeof process.stderr }),
    clock: () => new Date(nowMs),
    rateLimiter: { consume: () => ({ allowed: true }) },
    authenticateLogin: async ({ email, password }) => {
      const identity = USERS[email];
      return identity !== undefined && password === PASSWORD ? { ...identity, actorId: identity.userId, role: 'user' } : null;
    },
    mfaGate: gate,
    apiResources: { mail: async () => ({ messages: [{ id: 'synthetic-1' }] }) },
  });
  return { runtime, advance: (ms: number) => { nowMs += ms; }, code: (secret: string) => generateTotpCode(secret, Math.floor(nowMs / 1000 / 30)), totp };
}

function post(runtime: ReturnType<typeof createRuntimeServer>, path: string, body: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const address = runtime.server.address() as AddressInfo;
  return new Promise<JsonResponse>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const handle = request({
      host: address.address, port: address.port, path, method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body: text.length > 0 ? JSON.parse(text) : null }));
    });
    handle.on('error', reject);
    handle.end(payload);
  });
}

function get(runtime: ReturnType<typeof createRuntimeServer>, path: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const address = runtime.server.address() as AddressInfo;
  return new Promise<JsonResponse>((resolve, reject) => {
    const handle = request({ host: address.address, port: address.port, path, method: 'GET', headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body: text.length > 0 ? JSON.parse(text) : null }));
    });
    handle.on('error', reject);
    handle.end();
  });
}

const login = (runtime: ReturnType<typeof createRuntimeServer>, email: string) => post(runtime, '/api/session/login', { email, password: PASSWORD, rememberMe: false });
const cookieOf = (response: JsonResponse) => {
  const values = response.headers['set-cookie'];
  assert.ok(Array.isArray(values) && values.length > 0);
  return values[0].split(';', 1)[0];
};

/** Enrolls TOTP through the HTTP flow for a user with no factors and returns the secret plus the one-time recovery codes. */
async function enrollThroughLogin(ctx: ReturnType<typeof setup>, email: string) {
  const first = await login(ctx.runtime, email);
  const enrollment = await post(ctx.runtime, '/api/session/mfa/totp/enroll', { mfaToken: first.body.mfaToken });
  assert.equal(enrollment.statusCode, 200);
  const secret: string = enrollment.body.totp.secret;
  const done = await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: first.body.mfaToken, method: 'totp', code: ctx.code(secret) });
  assert.equal(done.statusCode, 200);
  assert.equal(done.body.authenticated, true);
  return { secret, recoveryCodes: done.body.recoveryCodes as string[], done };
}

test('required TOTP: a correct password alone creates no session and unlocks nothing', async () => {
  const ctx = setup();
  await startServer(ctx.runtime);
  try {
    const response = await login(ctx.runtime, 'alice@acme.example');
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.authenticated, false);
    assert.equal(response.body.mfaRequired, true);
    assert.deepEqual(response.body.factors, [{ type: 'totp', required: true, enrolled: false, satisfied: false }]);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(Object.hasOwn(response.body, 'csrfToken'), false);
    assert.equal(Object.hasOwn(response.body, 'user'), false);
    assert.equal(ctx.runtime.webSecurity.sessions.size, 0);

    assert.equal((await get(ctx.runtime, '/api/mail/messages')).statusCode, 401);
    // The challenge token is not a credential for the API, in any transport.
    assert.equal((await get(ctx.runtime, '/api/mail/messages', { cookie: `__Host-gulogulo-session=${response.body.mfaToken}` })).statusCode, 401);
    assert.equal((await get(ctx.runtime, '/api/session', { authorization: `Bearer ${response.body.mfaToken}` })).body.authenticated, false);
  } finally {
    await stopServer(ctx.runtime);
  }
});

test('required TOTP: enrollment and a valid code complete the login and issue recovery codes once', async () => {
  const ctx = setup();
  await startServer(ctx.runtime);
  try {
    const { done, recoveryCodes } = await enrollThroughLogin(ctx, 'alice@acme.example');
    assert.equal(done.body.user.userId, 'alice');
    assert.equal(recoveryCodes.length, 10);
    const cookie = cookieOf(done);
    assert.equal((await get(ctx.runtime, '/api/mail/messages', { cookie })).statusCode, 200);
  } finally {
    await stopServer(ctx.runtime);
  }
});

test('required TOTP: wrong, replayed, and reused-challenge attempts are refused', async () => {
  const ctx = setup();
  await startServer(ctx.runtime);
  try {
    const { secret } = await enrollThroughLogin(ctx, 'alice@acme.example');
    ctx.advance(30_000);

    const challenge = await login(ctx.runtime, 'alice@acme.example');
    assert.deepEqual(challenge.body.factors, [{ type: 'totp', required: true, enrolled: true, satisfied: false }]);
    const wrong = await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: challenge.body.mfaToken, method: 'totp', code: '000000' });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.headers['set-cookie'], undefined);

    const good = ctx.code(secret);
    const ok = await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: challenge.body.mfaToken, method: 'totp', code: good });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.authenticated, true);
    assert.equal(Object.hasOwn(ok.body, 'recoveryCodes'), false);

    const reused = await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: challenge.body.mfaToken, method: 'totp', code: ctx.code(secret) });
    assert.equal(reused.statusCode, 401);
    assert.equal(reused.body.error.code, 'MFA_CHALLENGE_INVALID');

    // The same code cannot be replayed on a fresh challenge in the same time step.
    const again = await login(ctx.runtime, 'alice@acme.example');
    const replay = await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: again.body.mfaToken, method: 'totp', code: good });
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.headers['set-cookie'], undefined);
  } finally {
    await stopServer(ctx.runtime);
  }
});

test('required TOTP: challenges expire and a failure budget destroys them', async () => {
  const ctx = setup();
  await startServer(ctx.runtime);
  try {
    const { secret } = await enrollThroughLogin(ctx, 'alice@acme.example');
    ctx.advance(30_000);

    const expiring = await login(ctx.runtime, 'alice@acme.example');
    ctx.advance(5 * 60 * 1000 + 1);
    const late = await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: expiring.body.mfaToken, method: 'totp', code: ctx.code(secret) });
    assert.equal(late.statusCode, 401);
    assert.equal(late.body.error.code, 'MFA_CHALLENGE_INVALID');

    const guessing = await login(ctx.runtime, 'alice@acme.example');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: guessing.body.mfaToken, method: 'totp', code: '000000' })).statusCode, 401);
    }
    const afterBudget = await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: guessing.body.mfaToken, method: 'totp', code: ctx.code(secret) });
    assert.equal(afterBudget.body.error.code, 'MFA_CHALLENGE_INVALID');
  } finally {
    await stopServer(ctx.runtime);
  }
});

test('recovery codes complete a login once and cannot replace an enrollment', async () => {
  const ctx = setup();
  await startServer(ctx.runtime);
  try {
    const fresh = await login(ctx.runtime, 'bob@acme.example');
    const bypass = await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: fresh.body.mfaToken, method: 'recovery', code: 'AAAA-BBBB-CCCC-DDDD' });
    assert.equal(bypass.statusCode, 403);
    assert.equal(bypass.headers['set-cookie'], undefined);

    const { recoveryCodes } = await enrollThroughLogin(ctx, 'alice@acme.example');
    ctx.advance(30_000);
    const challenge = await login(ctx.runtime, 'alice@acme.example');
    assert.equal(challenge.body.recoveryAvailable, true);
    const used = await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: challenge.body.mfaToken, method: 'recovery', code: recoveryCodes[0] });
    assert.equal(used.statusCode, 200);
    assert.equal(used.body.authenticated, true);

    const next = await login(ctx.runtime, 'alice@acme.example');
    const reuse = await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: next.body.mfaToken, method: 'recovery', code: recoveryCodes[0] });
    assert.equal(reuse.statusCode, 401);
    assert.equal(reuse.headers['set-cookie'], undefined);
  } finally {
    await stopServer(ctx.runtime);
  }
});

test('factors and challenges cannot be transferred between users or tenants', async () => {
  const ctx = setup();
  await startServer(ctx.runtime);
  try {
    const { secret } = await enrollThroughLogin(ctx, 'alice@acme.example');
    ctx.advance(30_000);

    // Another user in the same tenant: Alice's current code means nothing for Bob.
    const bob = await login(ctx.runtime, 'bob@acme.example');
    const notEnrolled = await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: bob.body.mfaToken, method: 'totp', code: ctx.code(secret) });
    assert.equal(notEnrolled.statusCode, 403);
    await post(ctx.runtime, '/api/session/mfa/totp/enroll', { mfaToken: bob.body.mfaToken });
    const stillWrong = await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: bob.body.mfaToken, method: 'totp', code: ctx.code(secret) });
    assert.equal(stillWrong.statusCode, 401);
    assert.equal(stillWrong.headers['set-cookie'], undefined);

    // Same user name in another tenant has its own, unenrolled, factor state.
    const other = await login(ctx.runtime, 'alice@other.example');
    assert.deepEqual(other.body.factors, [{ type: 'totp', required: true, enrolled: false, satisfied: false }]);
    const crossTenant = await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: other.body.mfaToken, method: 'totp', code: ctx.code(secret) });
    assert.equal(crossTenant.statusCode, 403);

    // A completed challenge yields a session for the identity that started it.
    const own = await login(ctx.runtime, 'alice@acme.example');
    const done = await post(ctx.runtime, '/api/session/mfa/verify', { mfaToken: own.body.mfaToken, method: 'totp', code: ctx.code(secret) });
    assert.equal(done.body.user.tenantId, 'acme.example');
    assert.equal(done.body.user.userId, 'alice');
  } finally {
    await stopServer(ctx.runtime);
  }
});

test('optional TOTP only gates users who have an active factor', async () => {
  const ctx = setup({ totp: 'optional' });
  await startServer(ctx.runtime);
  try {
    const plain = await login(ctx.runtime, 'bob@acme.example');
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.body.authenticated, true);

    const enrollment = ctx.totp.enroll({ tenantId: 'acme.example', userId: 'alice' });
    const confirmed = ctx.totp.confirmEnrollment({ factorId: enrollment.factor.factorId, tenantId: 'acme.example', userId: 'alice', code: ctx.code(enrollment.secret) });
    assert.equal(confirmed.confirmed, true);
    ctx.advance(30_000);
    const gated = await login(ctx.runtime, 'alice@acme.example');
    assert.equal(gated.body.mfaRequired, true);
    assert.equal(gated.headers['set-cookie'], undefined);
  } finally {
    await stopServer(ctx.runtime);
  }
});

test('required WebAuthn fails closed without a verifier, and both factors must be satisfied when both are required', async () => {
  const missing = setup({ totp: 'disabled', webauthn: 'required' });
  await startServer(missing.runtime);
  try {
    const response = await login(missing.runtime, 'alice@acme.example');
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(missing.runtime.mfaGate.pendingCount, 0);
  } finally {
    await stopServer(missing.runtime);
  }

  const stub: MfaWebAuthnManager = {
    beginRegistration: () => ({ challenge: 'registration' }),
    completeRegistration: () => ({ registered: false }),
    beginAssertion: () => ({ challenge: 'assertion' }),
    completeAssertion: (input) => ({ verified: input.signature === 'good-signature' && input.userId === 'alice' }),
    listCredentialMetadata: ({ userId }) => (userId === 'alice' ? [{ credentialId: 'credential-alice-0001' }] : []),
  };
  const both = setup({ totp: 'required', webauthn: 'required' }, stub);
  await startServer(both.runtime);
  try {
    const challenge = await login(both.runtime, 'alice@acme.example');
    const token = challenge.body.mfaToken;
    assert.deepEqual(challenge.body.factors.map((factor: { type: string }) => factor.type), ['totp', 'webauthn']);

    // The existing passkey must be proven before a TOTP factor can be added by a password-only caller.
    assert.equal((await post(both.runtime, '/api/session/mfa/totp/enroll', { mfaToken: token })).statusCode, 403);
    const options = await post(both.runtime, '/api/session/mfa/webauthn/options', { mfaToken: token });
    assert.equal(options.body.webauthn.ceremony, 'assertion');
    const bad = await post(both.runtime, '/api/session/mfa/webauthn/complete', { mfaToken: token, credentialId: 'credential-alice-0001', signature: 'bad' });
    assert.equal(bad.statusCode, 401);

    const half = await post(both.runtime, '/api/session/mfa/webauthn/complete', { mfaToken: token, credentialId: 'credential-alice-0001', signature: 'good-signature' });
    assert.equal(half.statusCode, 200);
    assert.equal(half.body.authenticated, false);
    assert.equal(half.headers['set-cookie'], undefined);
    assert.equal(half.body.factors.find((factor: { type: string }) => factor.type === 'webauthn').satisfied, true);

    const enrollment = await post(both.runtime, '/api/session/mfa/totp/enroll', { mfaToken: token });
    assert.equal(enrollment.statusCode, 200);
    const done = await post(both.runtime, '/api/session/mfa/verify', { mfaToken: token, method: 'totp', code: both.code(enrollment.body.totp.secret) });
    assert.equal(done.statusCode, 200);
    assert.equal(done.body.authenticated, true);
  } finally {
    await stopServer(both.runtime);
  }
});
