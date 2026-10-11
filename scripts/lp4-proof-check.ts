// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

type ProofRecord = Record<string, unknown>;

function proofRecord(value: unknown, name: string): ProofRecord {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  return value as ProofRecord;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`LP4 proof requires ${name}.`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`LP4 proof failed: ${message}`);
}

async function request(path: string, options: RequestInit = {}): Promise<{ response: Response; body: ProofRecord }> {
  const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual', ...options });
  const text = await response.text();
  let body: ProofRecord = {};
  if (text.length > 0 && response.headers.get('content-type')?.includes('json')) {
    const parsed: unknown = JSON.parse(text);
    body = proofRecord(parsed, `${path} JSON response`);
  }
  return { response, body };
}

const baseUrl = requiredEnvironment('LP4_BASE_URL').replace(/\/$/u, '');
const email = requiredEnvironment('LP4_LOGIN_EMAIL');
const password = requiredEnvironment('LP4_LOGIN_PASSWORD');
const tenantId = process.env.LP4_TENANT_ID || 'acme';
const userId = process.env.LP4_USER_ID || 'alice';

const shell = await fetch(`${baseUrl}/`);
const html = await shell.text();
assert(shell.status === 200, 'static web entry did not return 200');
for (const marker of ['login', 'mail', 'calendar', 'contacts']) {
  assert(html.toLowerCase().includes(marker), `static web entry is missing ${marker}`);
}

const absent = await request('/api/session');
assert(absent.response.status === 200 && absent.body.authenticated === false, 'anonymous session contract is invalid');

const login = await request('/api/session/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, rememberMe: false }),
});
assert(login.response.status === 200 && login.body.authenticated === true, 'synthetic login failed');
const loginUser = proofRecord(login.body.user, 'login user');
assert(loginUser.tenantId === tenantId && loginUser.userId === userId, 'login identity is not tenant/user scoped');
assert(typeof login.body.csrfToken === 'string' && login.body.csrfToken.length > 0, 'login omitted CSRF token');
assert(!JSON.stringify(login.body).includes(password), 'login response exposed the password');
const setCookie = login.response.headers.get('set-cookie') || '';
assert(setCookie.includes('__Host-gulogulo-session='), 'login omitted the host-only session cookie');
for (const attribute of ['Secure', 'HttpOnly', 'Path=/', 'SameSite=Lax']) assert(setCookie.includes(attribute), `session cookie omitted ${attribute}`);
const cookie = setCookie.split(';', 1)[0];

const authenticated = await request('/api/session', { headers: { cookie } });
const sessionUser = proofRecord(authenticated.body.user, 'session user');
assert(authenticated.body.authenticated === true && sessionUser.tenantId === tenantId, 'session lookup lost tenant scope');

for (const [path, collection] of [['/api/calendar/events', 'events'], ['/api/contacts', 'contacts']] as const) {
  const result = await request(path, { headers: { cookie } });
  assert(result.response.status === 200, `${path} did not return 200`);
  const scope = proofRecord(result.body.scope, `${path} scope`);
  assert(scope.tenantId === tenantId && scope.userId === userId, `${path} scope is invalid`);
  const data = proofRecord(result.body.data, `${path} data`);
  const entries: unknown = data[collection];
  assert(Array.isArray(entries) && entries.length === 1, `${path} fixture is missing`);
  assert(typeof data.syncToken === 'string' && data.syncToken.length > 16, `${path} sync token is missing`);
  const entry = proofRecord(entries[0], `${path} fixture`);
  assert(typeof entry.etag === 'string', `${path} ETag is missing`);
}

const discovery = await request('/api/discovery', { headers: { cookie } });
const discoveryScope = proofRecord(discovery.body.scope, 'discovery scope');
assert(discovery.response.status === 200 && discoveryScope.tenantId === tenantId, 'discovery API is not tenant scoped');
assert(JSON.stringify(discovery.body).includes(password) === false, 'discovery exposed the login password');

for (const [path, service] of [['/.well-known/caldav', 'caldav'], ['/.well-known/carddav', 'carddav']] as const) {
  const result = await request(path);
  assert(result.response.status === 308, `${service} well-known response is not a permanent redirect`);
  assert(result.response.headers.get('location')?.startsWith('https://'), `${service} redirect is not HTTPS`);
}

const logout = await request('/api/session/logout', {
  method: 'POST',
  headers: { cookie, 'x-csrf-token': login.body.csrfToken },
});
assert(logout.response.status === 200 && logout.body.authenticated === false, 'logout failed');
assert((logout.response.headers.get('set-cookie') || '').includes('Max-Age=0'), 'logout did not clear the session cookie');

console.log(JSON.stringify({
  milestone: 'LP4',
  staticWeb: true,
  login: 'synthetic_runtime_only',
  tenantId: 'redacted',
  userId: 'redacted',
  calendar: 'etag_and_sync_token',
  contacts: 'etag_and_sync_token',
  discovery: 'tenant_bound_https_redirects',
  credentialsCommitted: false,
  status: 'pass',
}, null, 2));
