<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

# LP9 local release and source audit

LP9 is the last local-proof step before the owner decides whether Gulo Gulo is
ready for a separate external deployment track. It is deliberately boring in
the best possible way: start from a clean checkout, run the same source audit
and contract gates, and leave a small evidence object that another developer
can inspect without guessing what was actually proven.

## What the audit enforces

`[scripts/lp9-source-audit.ts](../scripts/lp9-source-audit.ts)` walks the
tracked `src/`, `scripts/`, and `web/` source roots. Application code, backend
code, browser source, build tooling, and Node tests are canonical TypeScript.
Generated browser JavaScript in `web/dist/` is expected and is not counted as
source. A remaining `.mjs` file is accepted only when all of the following are
true:

- a same-name `.ts` canonical file exists;
- the file carries the project MIT/SPDX attribution;
- it explains that it is a compatibility bridge or shim;
- it contains only a direct TypeScript import/export, or the documented import
  of a compiled runtime entry point;
- it contains no product logic, filesystem policy, network behavior, or test
  assertions of its own.

The audit also rejects source JavaScript and package scripts that still invoke
legacy source entry points. Existing `@ts-nocheck` lines are counted and
reported as historical debt; they are not silently presented as strict source
coverage.

## Reproducible local commands

From the repository root:

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck:lp9
npm run test:lp9
npm test
git diff --check
```

`test:lp9` runs the strict LP9 TypeScript project, the source audit test, the
release-manifest test, the source audit itself, and the release-manifest audit.
The ordinary `npm test` path invokes the canonical `.ts` tests directly; the
legacy `.mjs` names remain only as safe compatibility entry points.

## Architecture and evidence boundary

The functional proof is AMD64-first (`linux/amd64`, Ubuntu 26.04). After it is
green, the multiarch workflow builds and attests the declared `linux/amd64`
and `linux/arm64` OCI artifacts without repeating the stateful Compose proof
under emulation. GitHub Artifact Attestations are generated only for push or
manual workflow contexts; pull-request validation stays read-only.

`[release/lp9-local-proof.json](../release/lp9-local-proof.json)` is safe to
share, synthetic-data-only evidence. It records the source-language policy,
reproducible commands, inherited passed workflow evidence, and the external
items that still need a real provider environment. It does not claim public
DNS, public ACME, external LDAP/PostgreSQL hardening, registry publication,
live mail interoperability, live Kubernetes traffic, measured production
capacity, or approved RPO/RTO.

## Compatibility bridge policy

The bridges are intentionally tiny so older local scripts do not break while
the canonical TypeScript paths remain obvious. They are not an alternate
runtime and must not grow behavior. Sythos owns their eventual removal once
downstream consumers no longer need the legacy names.
