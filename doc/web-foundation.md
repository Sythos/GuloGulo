# Web foundation: browser shell, sessions, and realtime contracts

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This is the practical guide to the first Gulo Gulo web layer. It covers the
HTML5 shell, the TypeScript-to-browser build, the server-side session and CSRF
contracts, safe message rendering, timezone display, and the small realtime
event envelope. It is deliberately honest about the boundary: the shell can
render a mailbox-shaped workspace, but it does not invent authentication or
mail storage. The protected API and the external protocol services remain the
source of truth.

## Files and build flow

The browser-facing files live under `web/`:

```text
web/
├── index.html          semantic shell and native dialogs
├── styles.css          responsive, keyboard-friendly presentation
├── manifest.json       optional PWA metadata
├── src/app.ts          browser source
├── build.mjs           pinned TypeScript build entry point
└── test/web-shell.test.mjs
```

Run the normal checks from the repository root:

```text
npm run typecheck
npm run build:web
npm run test:web
```

`typescript` is an exact, lockfile-resolved development dependency. The build
emits `web/dist/app.js`; `dist/` is ignored by Git and is rebuilt in CI and in
the Docker image. The runtime image installs development dependencies only
long enough to compile the browser asset, then runs `npm prune --omit=dev`.
The source is intentionally JavaScript-compatible while API types settle, so
the initial file has a narrowly documented `@ts-nocheck` marker. That marker is
not a licence to skip API design: shared request and response types are a
follow-up hardening task once the server routes are implemented.

## Serving the shell

The dependency-free Node HTTP server serves `web/index.html` at `/` and safe
files below `/web/`. The resolver decodes the URL once, rejects path traversal,
allows only known web extensions, and never exposes arbitrary files from the
application directory. A missing asset is a normal 404 JSON response.

Responses for the shell and assets include:

- a restrictive Content-Security-Policy with same-origin scripts, styles,
  images, and connections;
- `X-Content-Type-Options: nosniff`;
- `X-Frame-Options: DENY` and `frame-ancestors 'none'`;
- `Referrer-Policy: no-referrer`;
- a restrictive `Permissions-Policy`;
- `Cross-Origin-Opener-Policy: same-origin`.

HSTS is intentionally not emitted by the application server. The edge proxy
must add it only after HTTPS is actually enforced for the public hostname.

The shell expects same-origin user endpoints such as `/api/session`,
`/api/mail/folders/{folder}`, `/api/mail/messages/{id}`, `/api/mail/send`,
`/api/preferences`, and `/api/events`. These are contracts for later server
work; a browser URL or a value in `localStorage` never grants access to a
mailbox.

## Session contract

Session state is server-side. `src/web/security/session-manager.mjs` provides
the in-memory contract that a PostgreSQL-backed store can implement without
changing the security semantics.

```js
const security = createWebSecurity({
  clock,
  ttlMs: 8 * 60 * 60 * 1000,
});

const { session, setCookie } = security.createAuthenticatedSession({
  tenantId: 'example',
  domain: 'example.test',
  userId: 'alice',
  actorId: 'alice',
  role: 'user',
});
```

The cookie is `__Host-gulogulo-session` with `Secure`, `HttpOnly`, `Path=/`,
`SameSite=Lax`, and no `Domain`. Its value is a 32-byte CSPRNG identifier,
encoded as a URL-safe token. It contains no tenant, user, role, or email data.
The manager applies an absolute expiry, removes expired entries on access, and
supports explicit purge and per-user invalidation.

When authentication state changes, rotate the session ID. Rotation refuses to
change tenant, domain, user, actor, or role binding and invalidates the old
bearer before returning the new session. Logout invalidates the server record
and returns only a clearing cookie; callers must not log or expose the old
session ID.

The current implementation is an adapter contract, not a claim that the web
server already has a login route. Login, LDAP verification, TOTP, and WebAuthn
remain separate work. Never put a password, session token, or recovery code in
the URL or browser storage.

## CSRF contract

State-changing browser requests use a synchronizer token. `csrf.mjs` creates a
32-byte token, stores only its SHA-256 digest, binds it to the session ID, and
expires it after a short TTL. Tokens are single-use by default and can be
revoked with the session. A request may send the value in `X-CSRF-Token` or in
the body, but if both are present they must match.

The browser client reads the token from a server-rendered meta element and adds
the header only for non-GET/non-HEAD requests. The server must still validate
the origin policy, session, tenant context, and token for every mutation. A
missing token, token from another session, expired token, or replay is a hard
failure; it must not degrade into a best-effort warning.

## Mail HTML and attachments

Email body HTML is hostile input. `src/web/content/email-content.mjs` uses a
small element and attribute allow-list. It drops scripts, forms, iframes,
styles, event handlers, active protocols, unsafe attributes, and remote images
unless the caller explicitly enables a constrained image policy. The function
returns sanitized HTML, plain text, and redacted rendering metadata; it never
executes the input.

Attachment links are download-only. `attachment-policy.mjs` rejects unsafe
protocols, embedded credentials, private/link-local/metadata addresses,
non-allow-listed ports, executable MIME types, unsafe filenames, and DNS names
that resolve to private addresses. A real downloader must use the validated
result, disable redirects, stream with a byte limit, scan the content, set
`Content-Disposition: attachment`, and re-check authorization at download
time. Do not make a server-side fetch merely because a message contains a URL.

The browser shell applies a second, defensive DOM pass before inserting a
message fragment. This is useful for accidental integration mistakes, but it
does not replace server-side sanitization.

## Time and locale

`timezone.mjs` canonicalizes IANA timezone names through `Intl`, gives a manual
override priority over browser detection, and falls back to UTC. The source of
truth remains the UTC timestamp; local strings are presentation only.

`formatMessageTimestamp()` returns the sender-zone rendering and, when the
sender and viewer zones differ, appends the viewer-local equivalent in
parentheses. DST behavior belongs in deterministic tests using explicit
instants. Never store a localized string as the mail timestamp.

The shell keeps a manual choice in browser storage as a convenience only. The
server must persist the user preference through the authenticated preferences
API when that feature is available, and must not trust the local value for
authorization.

## Realtime events

`event-normalizer.mjs` accepts SSE, WebSocket, and IMAP IDLE input and emits a
single, versioned envelope:

```json
{
  "version": 1,
  "eventId": "imap-idle:example:alice:42",
  "source": "imap-idle",
  "type": "mail.changed",
  "tenantId": "example",
  "userId": "alice",
  "resource": "INBOX",
  "sequence": 42,
  "occurredAt": "2026-08-22T18:00:00.000Z",
  "data": { "mailbox": "INBOX", "uidNext": 101, "operation": "exists" }
}
```

The normalizer rejects tenant or user mismatches and removes body, HTML, raw
headers, attachment, and other content-shaped fields. The coalescer drops
duplicate event IDs, bounds the seen set, coalesces bursts by tenant/user/type/
resource, and flushes after a bounded window. It does not start a polling loop.

The shell uses a credentialed `EventSource` stream at `/api/events`. The server
must authorize the stream from the session, include a tenant/user scope in the
subscription key, support `Last-Event-ID`, send bounded heartbeats, and close
the stream on logout or revocation. Reconnect backoff and queue limits belong to
the server contract; event payloads must remain metadata-only.

## User backup hook

`src/web/backup/backup-request.mjs` is the small application hook for a user's
self-service backup. It accepts an already authenticated server session and
returns an immutable, metadata-only request envelope. The requested user must
be the session user; a master or provider cannot use this hook to silently
enter another user's session. Resources are limited to mail, calendar,
contacts, and preferences, and an idempotency key lets a later worker avoid
duplicate jobs.

The hook does not read mailbox content, create an archive, or mutate the
external backup volume. A provider-controlled worker will eventually consume
the envelope, re-check authorization, encrypt the result, record an audit
event, and expose download/expiry state through a separately documented API.

## API and MCP boundary

The browser's user API is not the provider monitoring API. User routes can be
implemented as authenticated, tenant/user-scoped application operations. The
tenant monitoring API and MCP remain read-only: they may report health, queue,
metrics, patch status, and audit summaries, but they cannot read another
user's mailbox or start an upgrade. Provider-only deployment commands stay
outside the tenant surface and require their own authorization and audit trail.

## CI and manual smoke checks

The quality workflow runs metadata checks, `npm ci`, the repository test script,
and the web shell smoke test. The smoke test compiles the TypeScript source,
loads the generated browser module, checks deterministic timezone behavior,
asserts CSRF headers and credentialed same-origin requests, and verifies the
HTML/CSS accessibility and CSP markers. A future visual browser job can add a
real Chromium pass without changing the contracts described here.

For a quick local check:

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
```

If the local Windows sandbox reports `spawn EPERM` while Node tries to create a
worker, run the individual test files directly. GitHub Actions remains the
authoritative Linux and multi-architecture verification environment.
