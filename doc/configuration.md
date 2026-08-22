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
implementation lives in `src/runtime/config.mjs` and exposes two entry points:

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
IMAP IDLE: enabled
catch-all: false
automatic user forwarding: false
trash retention: 28 days
API/MCP: read-only
upgrade strategy: blue_green
patching mode: build_and_operator
```

The parser rejects attempts to enable catch-all, user forwarding, or a
write-capable API. Enabling LDAP requires `ldap.bindSecretRef`; enabling
PostgreSQL requires `postgres.dsnSecretRef`.

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
$env:GULOGULO_VERSION = '0.0.0'
$env:GULOGULO_BUILD_DIGEST = 'sha256:example'
```

`GULOGULO_BUILD_VERSION` remains a compatibility alias for
`GULOGULO_VERSION`. Build metadata is safe to expose; it must not contain a
credential or a message identifier.

## Troubleshooting

Run the config tests directly when Windows process isolation prevents the
Node test runner from spawning child workers:

```powershell
node src/foundation/config.test.mjs
```

For a normal package run, use `npm test`. The CI image executes the same script
with the lockfile installed by `npm ci`.
