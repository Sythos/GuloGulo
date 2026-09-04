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

If a tenant already runs its domain from Plesk or cPanel, Gulo Gulo can sit
behind that panel as an optional upstream tool. The panel may own the
hosting account and DNS workflow; Gulo Gulo still owns groupware policy,
identity, mail, calendar, contacts, quotas, retention, and audit.

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

## Install and setup

- **[Install guide](https://github.com/Sythos/GuloGulo/blob/main/INSTALL.md)**
  — build/install/upgrade instructions and known gaps, per target
- **[README](https://github.com/Sythos/GuloGulo/blob/main/README.md)**
  — full project overview and the production readiness checklist
- **[Releases](https://github.com/Sythos/GuloGulo/releases)**
  — packaged `.tar.gz` archives for each target
- **[Repository](https://github.com/Sythos/GuloGulo)**
  — source, issues, and CI

### Node.js or Bun

Node.js is the default runtime on every target and is always required at
install time regardless of choice — `npm` installs dependencies and runs
database migrations either way. Bun is available as an alternative
runtime for the compiled server itself:

```bash
./install.sh --runtime=bun
```

Already installed under Node? Switch a running instance without
reinstalling:

```bash
./switch-to-bun.sh    # or ./switch-to-node.sh to switch back
```

On cPanel and Plesk this re-renders and restarts the managed systemd
unit; on standalone it updates the recorded choice and prints the
correct manual start command, since that target never owns a systemd
unit of its own. The choice is recorded in a `.runtime` marker next to
`.env` and survives `upgrade.sh`.

## Status

This project tracks its own readiness honestly: a checked item in the
[production readiness checklist](https://github.com/Sythos/GuloGulo/blob/main/README.md#production-readiness-checklist)
means the repository contains the code, contract, or runbook and its gate
passes — not that it has been field-verified against a real external LDAP,
Postgres, cPanel, or Plesk deployment. See
[INSTALL.md](https://github.com/Sythos/GuloGulo/blob/main/INSTALL.md) for
exactly what still needs field verification on each target before
production use.
