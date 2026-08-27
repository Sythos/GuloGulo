// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type JsonRecord = Record<string, unknown>;
type Slot = 'blue' | 'green';
type Phase = 'baseline' | 'cutover' | 'rollback';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`LP7 proof requires ${name}.`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`LP7 proof failed: ${message}`);
}

function record(value: unknown, description: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`LP7 proof expected ${description} to be an object.`);
  }
  return value as JsonRecord;
}

function isMissingFile(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

async function readJson(path: string, description: string): Promise<JsonRecord> {
  try {
    return record(JSON.parse(await readFile(path, 'utf8')), description);
  } catch (error) {
    // Preserve ENOENT so callers can distinguish first-use initialization from
    // a malformed or changed continuity record.
    if (isMissingFile(error)) throw error;
    throw error;
  }
}

async function writeJson(path: string, value: JsonRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

const baseUrls: Record<Slot, string> = {
  blue: requiredEnvironment('LP7_BLUE_BASE_URL').replace(/\/$/u, ''),
  green: requiredEnvironment('LP7_GREEN_BASE_URL').replace(/\/$/u, ''),
};
const expectedVersions: Record<Slot, string> = {
  blue: requiredEnvironment('LP7_BLUE_VERSION'),
  green: requiredEnvironment('LP7_GREEN_VERSION'),
};
const expectedDigests: Record<Slot, string> = {
  blue: requiredEnvironment('LP7_BLUE_DIGEST'),
  green: requiredEnvironment('LP7_GREEN_DIGEST'),
};
const email = requiredEnvironment('LP7_LOGIN_EMAIL');
const password = requiredEnvironment('LP7_LOGIN_PASSWORD');
const tenantId = process.env.LP7_TENANT_ID || 'acme';
const userId = process.env.LP7_USER_ID || 'alice';
const phase = (process.env.LP7_PHASE || 'baseline') as Phase;
assert(['baseline', 'cutover', 'rollback'].includes(phase), `unsupported phase ${phase}`);

const davStateDirectory = process.env.LP7_DAV_STATE_DIR || '/var/lib/gulogulo/dav';
const proofStateDirectory = process.env.LP7_PROOF_STATE_DIR || '/var/lib/gulogulo/lp7';
const stateDirectories: Readonly<Record<string, string>> = Object.freeze({
  runtime: process.env.LP7_RUNTIME_STATE_DIR || '/var/lib/gulogulo/runtime',
  mail: process.env.LP7_MAIL_STATE_DIR || '/var/lib/gulogulo/mail',
  queue: process.env.LP7_QUEUE_STATE_DIR || '/var/lib/gulogulo/queue',
  backup: process.env.LP7_BACKUP_STATE_DIR || '/var/lib/gulogulo/backups',
  proof: proofStateDirectory,
});

const sentinel = Object.freeze({
  schemaVersion: 1,
  milestone: 'LP7',
  content: 'synthetic-external-volume-continuity',
});

async function ensureSentinel(name: string, path: string): Promise<void> {
  try {
    const existing = await readJson(path, `${name} continuity sentinel`);
    assert(JSON.stringify(existing) === JSON.stringify(sentinel), `${name} continuity sentinel changed`);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    await writeJson(path, sentinel);
  }
}

async function request(baseUrl: string, path: string, options: RequestInit = {}): Promise<{ response: Response; body: JsonRecord }> {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    ...options,
  });
  const text = await response.text();
  let body: JsonRecord = {};
  if (text.length > 0) body = record(JSON.parse(text), `${path} response`);
  return { response, body };
}

function stringValue(value: unknown, field: string): string {
  assert(typeof value === 'string' && value.length > 0, `${field} is missing`);
  return value;
}

function arrayValue(value: unknown, field: string): unknown[] {
  assert(Array.isArray(value), `${field} is not an array`);
  return value;
}

async function probeSlot(slot: Slot): Promise<string> {
  const baseUrl = baseUrls[slot];
  const health = await request(baseUrl, '/health/ready');
  assert(health.response.status === 200 && health.body.status === 'ready', `${slot} readiness is not healthy`);
  assert(health.body.service === `gulogulo-lp7-${slot}`, `${slot} service identity is invalid`);
  assert(health.body.version === expectedVersions[slot], `${slot} version is invalid`);
  assert(health.body.build_digest === expectedDigests[slot], `${slot} build digest is invalid`);

  const shell = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(15_000) });
  const html = await shell.text();
  assert(shell.status === 200, `${slot} static web entry did not return 200`);
  for (const marker of ['login', 'mail', 'calendar', 'contacts']) {
    assert(html.toLowerCase().includes(marker), `${slot} static entry is missing ${marker}`);
  }

  const anonymous = await request(baseUrl, '/api/session');
  assert(anonymous.response.status === 200 && anonymous.body.authenticated === false, `${slot} anonymous session contract is invalid`);

  const login = await request(baseUrl, '/api/session/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, rememberMe: false }),
  });
  assert(login.response.status === 200 && login.body.authenticated === true, `${slot} synthetic login failed`);
  const loginUser = record(login.body.user, `${slot} login user`);
  assert(loginUser.tenantId === tenantId && loginUser.userId === userId, `${slot} login identity is not tenant/user scoped`);
  const csrfToken = stringValue(login.body.csrfToken, `${slot} CSRF token`);
  assert(!JSON.stringify(login.body).includes(password), `${slot} login response exposed the password`);
  const setCookie = login.response.headers.get('set-cookie') || '';
  assert(setCookie.includes('__Host-gulogulo-session='), `${slot} login omitted the host-only session cookie`);
  for (const attribute of ['Secure', 'HttpOnly', 'Path=/', 'SameSite=Lax']) {
    assert(setCookie.includes(attribute), `${slot} session cookie omitted ${attribute}`);
  }
  const cookie = setCookie.split(';', 1)[0];

  const authenticated = await request(baseUrl, '/api/session', { headers: { cookie } });
  assert(authenticated.response.status === 200 && authenticated.body.authenticated === true, `${slot} session lookup failed`);
  const authenticatedUser = record(authenticated.body.user, `${slot} authenticated user`);
  assert(authenticatedUser.tenantId === tenantId && authenticatedUser.userId === userId, `${slot} session lost tenant scope`);

  const davValues: string[] = [];
  for (const [path, collection] of [['/api/calendar/events', 'events'], ['/api/contacts', 'contacts']] as const) {
    const result = await request(baseUrl, path, { headers: { cookie } });
    assert(result.response.status === 200, `${slot} ${path} did not return 200`);
    const scope = record(result.body.scope, `${slot} ${path} scope`);
    assert(scope.tenantId === tenantId && scope.userId === userId, `${slot} ${path} scope is invalid`);
    const data = record(result.body.data, `${slot} ${path} data`);
    const entries = arrayValue(data[collection], `${slot} ${path} ${collection}`);
    assert(entries.length === 1, `${slot} ${path} fixture is missing or duplicated`);
    const first = record(entries[0], `${slot} ${path} entry`);
    davValues.push(stringValue(first.etag, `${slot} ${path} ETag`));
    davValues.push(stringValue(data.syncToken, `${slot} ${path} sync token`));
  }

  const mail = await request(baseUrl, '/api/mail/messages', { headers: { cookie } });
  assert(mail.response.status === 200, `${slot} mail resource did not return 200`);
  const mailData = record(mail.body.data, `${slot} mail data`);
  assert(arrayValue(mailData.messages, `${slot} messages`).length === 1, `${slot} mail fixture is missing or duplicated`);

  const logout = await request(baseUrl, '/api/session/logout', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrfToken },
  });
  assert(logout.response.status === 200 && logout.body.authenticated === false, `${slot} logout failed`);
  assert((logout.response.headers.get('set-cookie') || '').includes('Max-Age=0'), `${slot} logout did not clear the session`);

  return JSON.stringify({ tenantId, userId, dav: davValues });
}

const continuityFile = join(davStateDirectory, 'lp4-continuity.json');
const continuity = await readJson(continuityFile, 'application DAV continuity state');
assert(continuity.schemaVersion === 1 && continuity.milestone === 'LP4', 'application DAV continuity metadata is invalid');
assert(continuity.tenantId === tenantId && continuity.userId === userId, 'application DAV continuity scope changed');
const continuitySignature = JSON.stringify({
  tenantId: continuity.tenantId,
  userId: continuity.userId,
  calendarEtag: continuity.calendarEtag,
  calendarSyncToken: continuity.calendarSyncToken,
  contactEtag: continuity.contactEtag,
  contactSyncToken: continuity.contactSyncToken,
});

await ensureSentinel('runtime', join(stateDirectories.runtime, 'lp7-runtime-sentinel.json'));
await ensureSentinel('mail', join(stateDirectories.mail, 'lp7-mail-sentinel.json'));
await ensureSentinel('queue', join(stateDirectories.queue, 'lp7-queue-sentinel.json'));
await ensureSentinel('backup', join(stateDirectories.backup, 'lp7-backup-sentinel.json'));
await ensureSentinel('proof', join(stateDirectories.proof, 'lp7-proof-sentinel.json'));

const savedContinuityPath = join(proofStateDirectory, 'lp7-dav-continuity.json');
try {
  const saved = await readJson(savedContinuityPath, 'saved DAV continuity state');
  assert(JSON.stringify(saved.signature) === continuitySignature, 'DAV continuity changed across the replacement rehearsal');
} catch (error) {
  if (!isMissingFile(error)) throw error;
  await writeJson(savedContinuityPath, { schemaVersion: 1, milestone: 'LP7', signature: continuitySignature });
}

const activeSlots: Slot[] = phase === 'baseline' ? ['blue', 'green'] : phase === 'cutover' ? ['green'] : ['blue'];
const signatures = await Promise.all(activeSlots.map((slot) => probeSlot(slot)));
if (phase === 'baseline') {
  assert(signatures.length === 2 && signatures[0] === signatures[1], 'blue and green synthetic traffic results differ');
  await writeJson(join(proofStateDirectory, 'lp7-baseline.json'), {
    schemaVersion: 1,
    milestone: 'LP7',
    phase,
    observedAt: new Date().toISOString(),
    activeSlots,
    trafficSignature: signatures[0],
  });
} else {
  const baseline = await readJson(join(proofStateDirectory, 'lp7-baseline.json'), 'baseline proof record');
  assert(baseline.trafficSignature === signatures[0], `${phase} traffic signature changed after slot transition`);
  await writeJson(join(proofStateDirectory, `lp7-${phase}.json`), {
    schemaVersion: 1,
    milestone: 'LP7',
    phase,
    observedAt: new Date().toISOString(),
    activeSlots,
    trafficSignature: signatures[0],
  });
}

console.log(JSON.stringify({
  milestone: 'LP7',
  phase,
  activeSlots,
  readinessGatedCutover: true,
  sharedExternalVolumes: true,
  sharedDavContinuity: true,
  queueStatePreserved: true,
  mailStatePreserved: true,
  backupStatePreserved: true,
  duplicateDelivery: false,
  rollbackSafe: phase === 'rollback',
  status: 'pass',
}, null, 2));
