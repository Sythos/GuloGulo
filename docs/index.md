<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

![Wolverine tearing through a calendar and paper correspondence](assets/hero.png)

# Gulo Gulo

Gulo Gulo is a mail-first, tenant-isolated groupware platform: secure
webmail, calendar, and contacts, distributed as cPanel, Plesk, and
standalone packages built from the same TypeScript core. The guiding animal
is the wolverine (*Gulo gulo*).

This site mirrors the project's own `doc/` directory — see **Guide** in the
navigation for the full technical documentation (configuration, mail core,
DAV, identity, observability, upgrade/migration, and every other subsystem),
plus the two [Architecture Decision Records](adr/ADR-001-gulogulo-runtime-and-frontend-architecture.md)
the project is built on.

## Why three packages

Nobody deploys a mail/groupware app the same way twice: some run it on a
hosting panel they already have, some run it on a bare Linux box they fully
control. One generic artifact can't serve both well, so each package targets
the OS its ecosystem actually runs on — cPanel and Plesk get a real,
OS-native package format; a bare Linux host gets a plain tarball and
`install.sh`. All three currently ship as a `.tar.gz` plus shell scripts
while code signing is still pending; see the
[README](https://github.com/Sythos/GuloGulo/blob/main/README.md#why-three-packages-and-why-these-targets)
for the full rationale.

## How Gulo Gulo sits behind Plesk or cPanel

If a tenant already runs its domain from Plesk or cPanel, Gulo Gulo can sit
behind that panel as an optional upstream tool — the panel is never a second
mailbox, policy, or identity store:

```text
Tenant / provider
       │
       ├── Plesk or cPanel (optional upstream account and DNS tool)
       │       └── explicit provider adapter or webhook/pull boundary
       │
       └── Gulo Gulo
               ├── tenant policy and RBAC
               ├── LDAP identity
               ├── PostgreSQL application state
               ├── mailbox and DAV data
               └── audit and read-only API/MCP
```

Gulo Gulo stays authoritative for tenant policy, users, quotas, aliases,
delegations, mailbox content, calendars, contacts, authentication decisions,
retention, audit semantics, and application state — a panel is never a
shortcut around those rules. The panel may own the hosting account and DNS
workflow; Gulo Gulo can read that state for diagnostics and reconciliation,
but the current contract grants no DNS or domain write access, so a panel
credential can never become an unbounded deployment or mail-control
credential. There is no direct browser-to-panel call, Docker socket, SSH
command, arbitrary CLI, or unrestricted `kubectl` path.

The integration is disabled by default (`CONTROL_PANEL_ENABLED=false`) and
supports three sync modes once enabled — **pull** (periodic read, the
safest starting point when the panel cannot sign callbacks), **webhook**
(a provider-authenticated change notification that triggers a scoped read,
never a write), and **hybrid** (both). See
[Optional Plesk and cPanel integration](guide/control-panel-integration.md)
for the full configuration contract, ownership rules, and capability matrix.

## Install and setup

- **[Install guide](install.md)** — build/install/upgrade instructions and
  known gaps, per target
- **[README](https://github.com/Sythos/GuloGulo/blob/main/README.md)**
  — full project overview and the production readiness checklist
- **[Releases](https://github.com/Sythos/GuloGulo/releases)**
  — packaged `.tar.gz` archives for each target
- **[Repository](https://github.com/Sythos/GuloGulo)**
  — source, issues, and CI

### For the tenant/provider running the install

A production install is not "done" once `install.sh` exits — it is done once
these are verified against the real deployment (the complete checklist is in
the [Install guide's field verification section](install.md#field-verification-checklist)):

- DNS, firewall, and reverse proxy (Apache on cPanel, nginx on Plesk, your
  own choice on standalone), plus certificate issuance/renewal and expiry
  alerting.
- The secret store you selected: least-privilege access, rotation, revoke,
  restart, and recovery behavior.
- Identity: external LDAP (TLS, bind privilege, directory filters, timeout/
  retry, outage behavior) or, on standalone with `IDENTITY_SOURCE=database`,
  the local-users migration and row-level security instead.
- PostgreSQL: TLS, role grants, row-level security, migrations, backups,
  restore, and connection limits.
- If you enabled the optional Plesk/cPanel upstream integration: the account
  binding, API version, TLS, webhook or pull policy, DNS ownership, and
  credential rotation.
- Tenant isolation, roles, delegation, quota ceilings, aliases, and
  default-deny mailbox/calendar/contact access, exercised with a real
  tenant and user, not just fixtures.
- Vendor Postfix, Dovecot, Rspamd, ClamAV, CalDAV, and CardDAV versions and
  configuration actually installed on the host.

None of this is optional polish — it is the difference between "the
repository's own gate is green" and "this is safe to run in production."
The [production readiness checklist](https://github.com/Sythos/GuloGulo/blob/main/README.md#production-readiness-checklist)
in the README tracks exactly that boundary.

### Node.js or Bun

Node.js is the default runtime on every target and is always required at
install time regardless of choice — `npm` installs dependencies and runs
database migrations either way. Bun is available as an alternative runtime
for the compiled server itself, chosen with one script,
`switch-runtime.sh`, on every target:

```bash
./install.sh --runtime=bun        # choose it at install time
./switch-runtime.sh bun           # or switch an existing install later
```

On cPanel and Plesk this re-renders and restarts the managed systemd unit;
on standalone it updates the recorded choice and prints the correct manual
start command, since that target never owns a systemd unit of its own. The
choice is recorded in a `.runtime` marker next to `.env` and survives
`upgrade.sh`. `switch-to-node.sh` and `switch-to-bun.sh` are optional
one-argument shortcuts for the same script, for anyone who would rather not
remember the exact runtime name.

## Status

This project tracks its own readiness honestly: a checked item in the
[production readiness checklist](https://github.com/Sythos/GuloGulo/blob/main/README.md#production-readiness-checklist)
means the repository contains the code, contract, or runbook and its gate
passes — not that it has been field-verified against a real external LDAP,
Postgres, cPanel, or Plesk deployment. See the
[Install guide](install.md) for exactly what still needs field verification
on each target before production use.
