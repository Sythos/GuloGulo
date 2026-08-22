<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

# Gulo Gulo web shell

This directory contains the dependency-light HTML5 user surface for Gulo Gulo.
The browser source is `src/app.ts`; `dist/app.js` is the generated browser
module consumed by `index.html`. The source intentionally stays within the
JavaScript-compatible subset of TypeScript so that the initial shell has no
runtime or package-manager dependency.

## Build and test

From the repository root, run:

```text
node web/build.mjs
node web/test/web-shell.test.mjs
```

The build is deterministic and uses the repository-pinned TypeScript compiler
to emit an ES module into `dist/`. The generated directory is ignored by Git
and rebuilt in CI and in the OCI image; it must never be edited by hand.

## Browser contract

- `index.html` is a semantic shell with keyboard-visible focus, skip navigation,
  labelled controls, responsive folder/message panes, and native dialogs.
- `app.ts` uses credentialed same-origin API requests and sends the CSRF token
  only on state-changing requests. It never stores credentials or bearer tokens
  in browser storage.
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

The shell intentionally does not implement authentication, authorization,
session issuance, mailbox access, or message persistence. Those are server-side
contracts and must remain enforced for every request, regardless of browser
state or URL parameters.
