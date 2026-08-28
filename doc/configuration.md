# Configuration

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

Configuration is loaded before the HTTP service starts. If a value is wrong,
Gulo Gulo stops rather than guessing. That is useful in production: a typo in a
secret reference or a security invariant should never quietly turn into a
different deployment.

## The contract

The normative machine-readable schema is `config/schema.v1.json`. The
implementation lives in `src/runtime/config.ts` and exposes two entry points:

- `loadConfiguration()` returns the complete, frozen contract;
- `loadConfig()` keeps the small M0 runtime shape (`host`, `port`,
  `serviceName`, `environment`, and `shutdownTimeoutMs`) while attaching the
  complete contract as non-enumerable metadata.

The contract is versioned with `schemaVersion: 1`. It also carries the build
version and build digest used by health responses and structured logs.

## Precedence

Values are resolved in this order:

1. environment variables;
2. the JSON file mounted at `GULOGULO_CONFIG_FILE`;
3. safe built-in defaults.

The default path `/etc/gulogulo/config.json` is optional. A path explicitly set
through `GULOGULO_CONFIG_FILE` is mandatory: a missing or malformed file fails
closed. The mounted file is limited to 1 MiB and rejects unknown keys.

Canonical `GULOGULO_*` names win over the short compatibility names when both
are present. For example, `GULOGULO_PORT` wins over `PORT`.

## Safe defaults and fixed policy

The defaults keep the empty scaffold useful without external services:

```text
host: 0.0.0.0
port: 8080
environment: development
LDAP: disabled
PostgreSQL: disabled
upstream Plesk/cPanel tenant tool: disabled
IMAP IDLE: enabled
catch-all: false
automatic user forwarding: false
SMTP inbound: 25/TCP
SMTP submission: 587/TCP (465/TCP optional)
IMAPS: 993/TCP
scanner failure mode: fail_closed
mailbox root: /var/lib/gulogulo/mail
trash retention: 28 days
API/MCP: read-only
upgrade strategy: blue_green
patching mode: build_and_operator
```

The parser rejects attempts to enable catch-all, user forwarding, or a
write-capable API. Enabling LDAP requires `ldap.bindDn`, `ldap.bindSecretRef`,
and `ldap.userBaseDn`; enabling PostgreSQL requires `postgres.dsnSecretRef`.
The M3 mail limits (`maxMessageBytes`, `maxRecipients`, submission rate, and
queue retry settings) are bounded integers. The Rspamd and ClamAV flags describe
required adapter wiring; they do not place a scanner credential or endpoint in
the configuration file. A scanner failure cannot be configured as permissive.

The full mail behavior, adapter interfaces, queue states, Sieve rules, and
vendor-wiring checklist are in [M3 mail core](mail-core.md).

## Optional upstream Plesk or cPanel

The optional `controlPanel` section describes a tenant's upstream hosting
panel. Supported provider values are `plesk`, `cpanel`, and `none` (the default).
When enabled, it requires an HTTPS `baseUrl`, an external `accountRef`, and a
`credentialSecretRef`; `webhook` and `hybrid` synchronization additionally
require a `webhookSecretRef`. Environment variables use the same names with
the `CONTROL_PANEL_` prefix, for example:

```text
CONTROL_PANEL_ENABLED=false
CONTROL_PANEL_PROVIDER=none
CONTROL_PANEL_BASE_URL=
CONTROL_PANEL_ACCOUNT_REF=
CONTROL_PANEL_CREDENTIAL_SECRET_REF=
CONTROL_PANEL_WEBHOOK_SECRET_REF=
CONTROL_PANEL_SYNC_MODE=pull
```

The panel may own its hosting account and, if the provider chooses, DNS
workflow. Gulo Gulo remains authoritative for tenant policy, identity,
PostgreSQL state, mailbox/DAV content, retention, and audit. The contract is
read-only and rejects embedded URL credentials, arbitrary writes, shell/SSH,
Docker-socket, and unrestricted `kubectl` access. See [Optional Plesk and cPanel
integration](control-panel-integration.md) for the binding and field runbook.

## External scanner signature volume

Rspamd and ClamAV definition data is intentionally not stored in the image.
`GULOGULO_SCANNER_SIGNATURE_ROOT`,
`GULOGULO_SCANNER_SIGNATURE_MAX_AGE_SECONDS`, and
`GULOGULO_LP3_SCANNER_SIGNATURES_VOLUME` describe the provider-owned shared
volume and its freshness policy. The host-side updater is the single writer;
scanner containers mount the volume read-only and fail closed for missing,
stale, or invalid generations. See [Shared scanner-signature volume](scanner-signature-volume.md).

## Secrets

Do not put passwords, DSNs, tokens, cookies, or private keys in the JSON file
or in a normal environment variable. The contract accepts references such as
`ldap-bind` and `postgres-dsn`; the deployment platform resolves those
references separately. Configuration output, health responses, and logs never
echo the secret value.

The committed `.env.example` contains only empty reference fields and loopback
placeholders. Copy it for local work, but never commit a populated `.env` file.

## Build metadata

Set these values from the image or deployment pipeline:

```powershell
$env:GULOGULO_VERSION = '0.1.4'
$env:GULOGULO_BUILD_DIGEST = 'sha256:example'
```

`GULOGULO_BUILD_VERSION` remains a compatibility alias for
`GULOGULO_VERSION`. Build metadata is safe to expose; it must not contain a
credential or a message identifier.

## Troubleshooting

Run the compiled config tests directly when Windows process isolation prevents
the Node test runner from spawning child workers:

```powershell
npm run build:server
node dist/server/src/foundation/config.test.js
```

For a normal package run, use `npm test`. The CI image executes the same script
with the lockfile installed by `npm ci`.
