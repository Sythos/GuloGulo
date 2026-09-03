<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

# ADR-002: Gulo Gulo Packaging and Distribution Targets

- **Status:** Accepted
- **Date:** 2026-09-02
- **Project:** Gulo Gulo
- **Decision owner:** Sythos
- **Author:** Sythos (https://www.sythos.net)

## Decision

Gulo Gulo abandons the Docker/OCI-native distribution model described in
ADR-001 in favor of three packages built from the same application core:

- a cPanel package (plugin/extension, identity via UAPI and whmapi1, MySQL as
  primary data engine);
- a Plesk package (extension, identity via the modern Plesk REST API or
  XML-RPC ≥ 1.6.9.1, MySQL as primary data engine);
- a generic standalone archive (config file/env driven, multi-database
  connectors for PostgreSQL and MySQL/MariaDB).

The application core (TypeScript: RBAC, TenantContext, quota, delegation,
auth, calendar/contacts/mail business logic, and the HTML5 + TypeScript web
frontend) remains unchanged and is reused across all three targets. It does
not depend on the deployment model.

Source tree is reorganized as:

- `src/core/` — platform-agnostic business logic;
- `src/platform/contract/` — the adapter interface shared by all targets;
- `src/platform/cpanel/`, `src/platform/plesk/`, `src/platform/standalone/` —
  target-specific adapters implementing that interface;
- `src/runtime/` — bootstrap logic common to all targets;
- `git/packaging/cpanel/`, `git/packaging/plesk/`, `git/packaging/standalone/`
  — scripts and manifests that assemble each of the three distributable
  packages.

The data layer, today PostgreSQL-only, becomes multi-engine (PostgreSQL and
MySQL/MariaDB) behind the abstract interface already defined by
`PostgresPoolLike` and `PostgresClientLike`.

Identity, today external LDAP only, becomes pluggable:

- LDAP remains the identity source for the standalone package;
- cPanel and Plesk packages use the native identity of their host panel,
  reached through the panel's own API, as an alternative identity source.

There is no blue/green upgrade based on container swap. Each target defines
its own in-place upgrade strategy (migration script plus backup), without an
atomic container swap.

Version policy: no hard dependency on a specific cPanel or Plesk major
version. Only stable, documented APIs are used — cPanel UAPI and whmapi1,
avoiding the deprecated cpapi2; Plesk's modern REST API or XML-RPC
≥ 1.6.9.1. The exact compatibility matrix (API calls used and minimum panel
version) is documented separately once the adapters are implemented.

Package naming: `gulogulo-<semver>-cpanel.tar.gz`,
`gulogulo-<semver>-plesk.tar.gz`, `gulogulo-<semver>-standalone.tar.gz`. The
package name does not encode a panel major version; exact version
compatibility is documented apart from the package itself.

Distro-specific Linux packages (`.deb`, `.rpm`, etc.) remain out of scope and
may be evaluated in the future.

## Reference architecture

~~~text
src/core/            (RBAC, TenantContext, quota, delegation, auth,
                       calendar/contacts/mail logic, web frontend)
      │
      ├── src/platform/contract/     (adapter interface)
      │
      ├── src/platform/cpanel/       (UAPI/whmapi1 identity, MySQL)
      ├── src/platform/plesk/        (REST/XML-RPC identity, MySQL)
      └── src/platform/standalone/   (LDAP identity, PostgreSQL or MySQL)
      │
      └── src/runtime/               (common bootstrap)
            │
            ├── git/packaging/cpanel/       → gulogulo-<semver>-cpanel.tar.gz
            ├── git/packaging/plesk/        → gulogulo-<semver>-plesk.tar.gz
            └── git/packaging/standalone/   → gulogulo-<semver>-standalone.tar.gz
~~~

The browser must never connect directly to LDAP, PostgreSQL/MySQL, mailbox
storage, or secrets, regardless of the package target. This boundary, set in
ADR-001, is unchanged.

## Rationale

The target operating environment for most Gulo Gulo installs is shared or
managed hosting running cPanel or Plesk, where operators do not control the
container runtime and generally cannot or will not run Docker/OCI images
alongside the panel. Requiring Docker on these hosts would exclude the
majority of the realistic install base and would work against, not with, the
panel's own extension mechanisms.

Splitting distribution from the application core rather than rewriting the
core per target:

- keeps one implementation of RBAC, tenant isolation, quota, delegation, and
  mail/calendar/contacts logic, reducing duplicated security-sensitive code;
- lets each target reuse the native identity and data facilities already
  present on the host (panel user database, MySQL) instead of requiring
  operators to stand up LDAP and PostgreSQL on hosting they do not control;
- keeps the standalone archive as the path for operators who do want LDAP and
  PostgreSQL, or who are not running cPanel/Plesk at all;
- confines panel-specific code to a narrow adapter surface
  (`src/platform/{cpanel,plesk}/`), which is easier to audit, version, and
  update independently of panel releases than a monolithic deployment.

cPanel UAPI reference:

https://api.docs.cpanel.net/guides/guide-to-uapi/

cPanel whmapi1 reference:

https://api.docs.cpanel.net/whm/introduction/

Plesk REST API reference:

https://docs.plesk.com/en-US/obsidian/api-rpc/about-rest-api.79141/

## Container/OCI position

Docker/OCI packaging remains technically viable and is not disallowed as a
future, separately justified distribution target. It is not selected as a
baseline target because it does not match how most cPanel and Plesk hosts
are operated, and maintaining it as a fourth parallel target alongside the
three panel/standalone packages would not be justified by current demand.

The OCI-native reference architecture described in ADR-001 — Ubuntu 26.04
LTS base images, blue/green container upgrades — is superseded by this
decision. It may be reconsidered only if a future requirement introduces:

- a hosting environment that specifically requires container-based
  deployment;
- an operator segment that cannot use cPanel, Plesk, or the standalone
  archive;
- a separately justified component with clear ownership and packaging
  boundaries.

Container packaging must not be reintroduced merely as a fourth parallel
target without such a justification, because it would triple the packaging
and upgrade-testing surface without a corresponding install base.

## Initial implementation policy

The first packaging implementation should remain scoped and incremental:

1. finalize `src/platform/contract/` as the single interface the three
   adapters implement;
2. extract existing LDAP/PostgreSQL-coupled code out of `src/core/` and into
   `src/platform/standalone/`, with no behavior change for existing
   standalone-style deployments;
3. implement the MySQL/MariaDB engine behind `PostgresPoolLike` /
   `PostgresClientLike` before implementing either panel adapter;
4. implement the cPanel adapter (UAPI/whmapi1 identity) and its
   `git/packaging/cpanel/` build;
5. implement the Plesk adapter (REST/XML-RPC ≥ 1.6.9.1 identity) and its
   `git/packaging/plesk/` build;
6. document the exact API call list and minimum panel version per adapter as
   each one lands, separately from this ADR;
7. define and document the in-place upgrade procedure (migration script plus
   backup) independently for each of the three targets before declaring any
   of them stable.

A Linux distro-specific package (`.deb`, `.rpm`) may be evaluated later, but
only after the three baseline targets are stable.

## Consequences

### Positive consequences

- Matches the actual operating environment of most prospective installs
  (cPanel/Plesk shared and managed hosting).
- Single application core keeps RBAC, tenant isolation, quota, delegation,
  and business logic implemented once and reused across all targets.
- Panel-native identity removes the requirement to run external LDAP on
  hosts where operators do not control the base OS.
- MySQL/MariaDB support removes the requirement to run PostgreSQL on hosts
  where it is not offered.
- Narrow, auditable adapter surface per target instead of one large
  container-oriented deployment path.
- Standalone archive keeps the original PostgreSQL/LDAP deployment model
  available for operators who want or need it.

### Trade-offs

- Three packaging pipelines and three upgrade strategies must be built,
  tested, and maintained instead of one container image.
- The data layer must support two SQL engines behind one interface, which
  adds engine-specific testing and migration work.
- Identity must support both external LDAP and two different panel identity
  APIs, increasing the identity abstraction's surface.
- No atomic blue/green swap; each in-place upgrade path must independently
  guarantee a safe rollback via backup and migration scripting.
- cPanel and Plesk API behavior can vary across panel versions even within
  the "stable, documented API" policy, requiring ongoing compatibility
  verification as panel releases ship.
- Loss of the single deployment artifact simplicity that Docker/OCI
  provided; operators and support processes must now handle three distinct
  installers.

## Scope boundary

This decision applies to:

- the packaging and distribution model for Gulo Gulo releases;
- the source tree split between `src/core/`, `src/platform/`, and
  `src/runtime/`;
- the identity abstraction (LDAP vs. panel-native);
- the data layer engine abstraction (PostgreSQL vs. MySQL/MariaDB);
- per-target upgrade strategy.

This decision does not replace:

- the TypeScript-everywhere stack, the HTML5 + TypeScript frontend, and the
  Node.js backend defined in ADR-001;
- the absence of PHP from the baseline architecture;
- the security boundary that the browser never connects directly to LDAP,
  PostgreSQL/MySQL, mailbox storage, or secrets;
- Postfix, Dovecot, CalDAV, CardDAV, Rspamd, ClamAV, or any other service
  external to the Gulo Gulo application layer.

Those remain governed by ADR-001 and the canonical Gulo Gulo specification,
except where this document explicitly supersedes them.

## Related references

- ADR-001: ADR-001-gulogulo-runtime-and-frontend-architecture.md
- Canonical specification: GULOGULO.md
- Delivery plan: GULOGULO-MILESTONES.md
- cPanel UAPI guide: https://api.docs.cpanel.net/guides/guide-to-uapi/
- cPanel whmapi1 introduction: https://api.docs.cpanel.net/whm/introduction/
- Plesk REST API: https://docs.plesk.com/en-US/obsidian/api-rpc/about-rest-api.79141/
