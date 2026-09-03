<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

# Security Policy

We take security reports seriously, while keeping the process practical. Gulo Gulo is a
mail-first, tenant-isolated groupware platform running on real infrastructure, so a
vulnerability does not need to compromise the underlying host to be a real security issue.
If it can execute code, expose tenant data, cross a tenant boundary, or tamper with mail,
calendar, contacts or identity, please treat it as security-sensitive.

## Supported versions

| Release line | Security support | Notes |
| --- | --- | --- |
| Latest `0.1.x` release | Supported | Upgrade to the latest patch before reporting a regression. |
| `main` | Supported for triage | Development changes may move quickly, but security reports are welcome. |
| Older release lines | Not supported | Please reproduce on the latest stable release first. |

Gulo Gulo is still a young project, so only the latest release line carries security support.
The current stable release is listed on the
[GitHub releases page](https://github.com/Sythos/GuloGulo/releases).

## Reporting a vulnerability

**Do not open a public GitHub issue for a suspected security vulnerability.** Public Issues are
for ordinary bugs; they are not the place to leave a loaded exploit on the front porch.

### Preferred channel: private GitHub report

Use [GitHub Private Vulnerability Reporting](https://github.com/Sythos/GuloGulo/security/advisories/new)
whenever possible. It keeps the report, discussion and evidence private while we investigate.

### High or critical impact

For a **High** or **Critical** issue, also notify `sythos@gmail.com`. Use this route immediately
for any of the following:

- arbitrary code execution on the host or inside a tenant session;
- exposure, exfiltration or cross-tenant access to mail, calendar, contacts, identity data,
  tokens or secrets;
- LDAP, PostgreSQL, secret store or rotation compromise;
- CI, release, packaging (cPanel `.rpm`, Plesk `.deb`, standalone `.tar.gz`) or GitHub Actions
  compromise;
- runner or host compromise, persistence or unauthorized lateral movement;
- a practical bypass of authentication, session, CSRF, RBAC or tenant-isolation boundaries.

If private reporting is temporarily unavailable, email `sythos@gmail.com` first and do not
publish the details elsewhere. For Medium or Low security impact, the private GitHub channel is
normally enough unless the maintainer asks for an additional notification.

## What to include

Please include enough detail to reproduce the problem without sharing live secrets:

- affected package version, release tag or commit;
- deployment target (cPanel, Plesk or standalone), operating system, Node.js version and
  relevant runtime configuration;
- a minimal reproduction or sanitized proof of concept;
- expected and actual behavior;
- impact, prerequisites and whether tenant-specific data, credentials or a particular role is
  required;
- logs, stack traces and sample inputs with credentials, personal data and production
  identifiers removed.

Do not attach passwords, access tokens, private tenant data or an unredacted production sample.
The smallest useful reproduction is usually the fastest route to a fix.

## How we handle reports

1. We aim to acknowledge a private report within five business days.
2. We reproduce and assess impact, affected versions and exploitability.
3. We coordinate a fix, regression coverage and a release or advisory when appropriate.
4. We agree on a disclosure date with the reporter before publishing technical details.
5. We credit the reporter only with explicit permission.

Please do not disclose an exploitable issue, weaponized proof of concept or affected release
details publicly before coordinated disclosure is complete. A public issue may be used later for
a confirmed, non-sensitive fix or after the maintainer explicitly asks for public tracking.

## Public issues and non-security bugs

Public Issues are appropriate for reproducible errors, incorrect behavior, crashes, CalDAV/
CardDAV/discovery issues, documentation problems and performance regressions **after security
impact has been ruled out**. When in doubt, use the private channel. A crash can still be
security-relevant if it enables denial of service, resource exhaustion or a path to code or data
compromise.

## Scope

Reports are in scope when they affect the published TypeScript core, the cPanel, Plesk or
standalone packages, mail (SMTP/IMAP/Sieve), CalDAV/CardDAV/discovery, the web front end,
identity and LDAP/PostgreSQL integration, the secret store, tenant isolation, or the build,
packaging and release workflow.

## Security controls

Tenant isolation is a first-class boundary: identity, mail, calendar, contacts, quotas,
retention and audit are all scoped per tenant, and a report that crosses that boundary is
treated as high impact regardless of the mechanism.

LDAP connections use TLS with minimum bind privilege, and PostgreSQL access is protected and
backed up. The secret store and its rotation go through an allowlisted, versioned rotation/
expiry/rollback contract with tested versioned-file adapters. Web sessions are secure, login
failures are generic, and login attempts are rate-limited; CSP, CSRF and standard security
headers are enforced; email HTML is sanitized before rendering; rate and abuse controls are
contract-tested; the audit trail is verified to carry no secrets.

Each cPanel, Plesk and standalone release archive ships with a SHA256 checksum sidecar and an
aggregated `checksums.txt`, verified in CI before upload; GPG/minisign signing is not built yet.

Release integrity also depends on review as well as automation: the development toolchain is
bound by `package-lock.json`, and continuous integration installs dependencies with
`npm ci --ignore-scripts` in the quality-gate path. Neither replaces code review or
deployment-side verification.

Good-faith research is welcome. Please avoid privacy violations, service disruption,
persistence, data exfiltration and testing against tenants, systems or data that you do not
own. We will treat careful, non-destructive research made through this policy as authorized
for triage, subject to applicable law.
