<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

# Gulo Gulo web shell

This directory contains the dependency-light HTML5 login and workspace surface
for Gulo Gulo.
The browser source is `src/app.ts`; `dist/app.js` is the generated browser
module consumed by `index.html`. The source intentionally stays within the
JavaScript-compatible subset of TypeScript so that the initial shell has no
runtime or package-manager dependency.

## Build and test

From the repository root, run:

```text
npm run typecheck:web
npm run build:web
npm run test:web
```

The build is deterministic and uses the repository-pinned TypeScript compiler
to emit an ES module into `dist/`. The generated directory is ignored by Git
and rebuilt in CI and in the OCI image; it must never be edited by hand.

## Browser contract

- `index.html` starts with a semantic login surface. On desktop the approved
  Gulo Gulo artwork is rendered at exactly 128 × 128 CSS pixels in the
  upper-left area and the authentication form is on the right. The form comes
  first in DOM order and stays first when the narrow layout stacks, preserving
  keyboard and screen-reader priority.
- A successful `POST /api/session/login` receives `{email, password,
  rememberMe}` and must return a scoped `user` plus a fresh `csrfToken`. The
  client clears the password field and moves focus into the workspace. Invalid
  credentials and rate limits produce non-enumerating login errors.
- An initial `GET /api/session` restores only a valid server-side session;
  `{authenticated: false}` or an incomplete response leaves the login surface
  active. `POST /api/session/logout` clears the server cookie before returning
  to the login form.
- The authenticated workspace has keyboard-visible focus, skip navigation,
  labelled controls, responsive folder/message panes, and native dialogs.
- `app.ts` uses credentialed same-origin API requests and sends the CSRF token
  only on state-changing requests. The token lives in the document meta element
  and can be rotated by API responses; credentials, session cookies, and bearer
  tokens are never copied into browser storage.
- Mail HTML is parsed into a detached template. scripts, forms, active content,
  event attributes, unsafe URLs, and inline styles are removed before rendering.
- New-mail updates use a credentialed Server-Sent Events stream. The browser
  does not start a polling loop; the server remains responsible for event
  authorization and replay boundaries.
- Timezone selection defaults to the browser and can be overridden locally. A
  sender's equivalent local time is shown in parentheses when it differs from
  the user's selected timezone.
- Attachment links are rendered only when the protected API supplies a safe
  `https:` or `cid:` URL. The API remains responsible for authorization,
  content disposition, malware scanning, and download expiry.
- Calendar and Contacts are read-only API views. Their automatic CalDAV and
  CardDAV checks use same-origin discovery endpoints, show an explicit manual
  configuration fallback, and never connect directly to DAV storage.
- `calendar.changed` and `contacts.changed` SSE events carry metadata only; the
  corresponding view refreshes through the protected API after authorization.

The form initiates authentication but does not implement identity verification,
authorization, session issuance, mailbox access, or message persistence. Those
remain server-side contracts and must be enforced for every request, regardless
of browser state or URL parameters. The page never connects directly to LDAP,
PostgreSQL, mailbox storage, or DAV storage.
