// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

type ProofRecord = Record<string, any>;

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
  if (text.length > 0 && response.headers.get('content-type')?.includes('json')) body = JSON.parse(text) as ProofRecord;
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
assert(login.body.user?.tenantId === tenantId && login.body.user?.userId === userId, 'login identity is not tenant/user scoped');
assert(typeof login.body.csrfToken === 'string' && login.body.csrfToken.length > 0, 'login omitted CSRF token');
assert(!JSON.stringify(login.body).includes(password), 'login response exposed the password');
const setCookie = login.response.headers.get('set-cookie') || '';
assert(setCookie.includes('__Host-gulogulo-session='), 'login omitted the host-only session cookie');
for (const attribute of ['Secure', 'HttpOnly', 'Path=/', 'SameSite=Lax']) assert(setCookie.includes(attribute), `session cookie omitted ${attribute}`);
const cookie = setCookie.split(';', 1)[0];

const authenticated = await request('/api/session', { headers: { cookie } });
assert(authenticated.body.authenticated === true && authenticated.body.user?.tenantId === tenantId, 'session lookup lost tenant scope');

for (const [path, collection] of [['/api/calendar/events', 'events'], ['/api/contacts', 'contacts']] as const) {
  const result = await request(path, { headers: { cookie } });
  assert(result.response.status === 200, `${path} did not return 200`);
  assert(result.body.scope?.tenantId === tenantId && result.body.scope?.userId === userId, `${path} scope is invalid`);
  assert(Array.isArray(result.body.data?.[collection]) && result.body.data[collection].length === 1, `${path} fixture is missing`);
  assert(typeof result.body.data.syncToken === 'string' && result.body.data.syncToken.length > 16, `${path} sync token is missing`);
  assert(typeof result.body.data[collection][0].etag === 'string', `${path} ETag is missing`);
}

const discovery = await request('/api/discovery', { headers: { cookie } });
assert(discovery.response.status === 200 && discovery.body.scope?.tenantId === tenantId, 'discovery API is not tenant scoped');
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
