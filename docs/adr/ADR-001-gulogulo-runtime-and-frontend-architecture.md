<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

# ADR-001: Gulo Gulo Runtime and Frontend Architecture

> **Superseded in part by [ADR-002](ADR-002-gulogulo-packaging-and-distribution-targets.md)**:
> the container/OCI distribution model described in this document was
> abandoned in favor of cPanel/Plesk/standalone OS-native packages. The
> decisions on the TypeScript stack, the absence of PHP, and the browser-backend
> security boundary remain valid and governing. Every reference in this
> document to Docker, OCI images, or a specific Ubuntu base image describes
> that retired model; see ADR-002 for the current packaging and distribution
> targets.

- **Status:** Accepted
- **Date:** 2026-08-22
- **Project:** Gulo Gulo
- **Decision owner:** Sythos
- **Author:** Sythos (https://www.sythos.net)

## Decision

Gulo Gulo will use:

- HTML5 for the browser-facing structure;
- TypeScript as the frontend source language;
- JavaScript as the compiled browser runtime;
- Node.js with TypeScript for the Gulo Gulo backend and HTTP API;
- WebSocket or Server-Sent Events for realtime browser updates;
- external LDAP for identity;
- external PostgreSQL for application state;
- Postfix, Dovecot, CalDAV, and CardDAV for protocol services.

PHP is not part of the baseline architecture. The base OS target and package
build matrix are decided per distribution target in ADR-002, not here.

## Reference architecture

~~~text
Browser
  └── HTML5 + TypeScript
        └── HTTPS / WebSocket / Server-Sent Events
              └── Gulo Gulo API
                    ├── External LDAP
                    ├── External PostgreSQL
                    ├── IMAP / SMTP services
                    └── CalDAV / CardDAV services
~~~

The browser must never connect directly to LDAP or PostgreSQL. Authentication,
authorization, tenant isolation, session handling, CSRF protection, and
application policy remain server-side responsibilities.

## Rationale

Using TypeScript for both the browser client and Gulo Gulo backend provides:

- one primary language across the Gulo Gulo application layer;
- shared types for API contracts;
- native support for asynchronous I/O and streaming HTTP;
- a natural implementation path for IMAP IDLE notifications;
- straightforward WebSocket or Server-Sent Events integration;
- fewer runtime families to operate on the host;
- a smaller operational surface than introducing PHP-FPM and a separate
  FastCGI-oriented runtime.

Node.js provides stable HTTP primitives suitable for streaming and persistent
connections:

https://nodejs.org/api/http.html

Modern browsers provide WebSocket support through the standard Web API:

https://developer.mozilla.org/en-US/docs/Web/API/WebSocket

## PHP position

PHP remains technically viable, but it is not selected for the Gulo Gulo
baseline.

PHP would introduce an additional server runtime, normally operated through
PHP-FPM or another FastCGI integration:

https://www.php.net/manual/en/install.fpm.php

PHP may be reconsidered only if a future requirement introduces:

- mandatory reuse of an existing PHP application;
- a required PHP-only integration;
- an external deployment constraint that makes PHP preferable;
- a separately justified component with clear ownership and security
  boundaries.

PHP must not be introduced merely to render the browser interface, because the
browser interface is already implemented with HTML5 and TypeScript.

## Initial implementation policy

The first Gulo Gulo web application implementation should remain
dependency-light:

1. HTML5 semantic markup;
2. TypeScript source;
3. compiled JavaScript browser assets;
4. a small Node.js HTTP service;
5. explicit API contracts;
6. secure cookie-based sessions;
7. CSRF protection;
8. tenant-aware authorization;
9. WebSocket or Server-Sent Events only where realtime behavior requires it;
10. no direct browser access to LDAP, PostgreSQL, mailbox storage, or secrets.

A frontend framework may be evaluated later, but it must not be introduced
before the API, session, tenant, and security contracts are stable.

## Consequences

### Positive consequences

- Consistent TypeScript tooling across frontend and Gulo Gulo API.
- Fewer application runtimes to install and patch on the host.
- Natural support for realtime mail and calendar updates.
- Clear separation between browser, API, identity, state, and protocol
  services.
- Easier reuse of API contract types and validation logic.

### Trade-offs

- The team must maintain a Node.js runtime and JavaScript dependency supply
  chain.
- TypeScript compilation and browser testing become mandatory CI gates.
- Long-lived connections require explicit timeout, reconnect, and resource
  management policies.
- Server-side rendering is not the default and may require a separately
  justified component if later needed.

## Scope boundary

This decision applies to:

- webmail;
- calendar UI;
- contact UI;
- browser authentication;
- Gulo Gulo API;
- browser realtime events;
- user preferences and web settings.

This decision does not replace:

- Postfix;
- Dovecot;
- LDAP;
- PostgreSQL;
- CalDAV;
- CardDAV;
- Rspamd;
- ClamAV.

Those remain separate services or external dependencies defined by the
canonical Gulo Gulo specification.

## Related references

- Canonical specification: GULOGULO.md
- Delivery plan: GULOGULO-MILESTONES.md
- Node.js HTTP API: https://nodejs.org/api/http.html
- Browser WebSocket API: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
- PHP-FPM documentation: https://www.php.net/manual/en/install.fpm.php
