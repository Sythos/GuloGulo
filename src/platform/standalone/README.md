<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

Adapter `standalone` (ADR-002): il target "archivio generico" per un
operatore che installa Gulo Gulo sul proprio server/VPS, senza cPanel/Plesk.
Implementa `PlatformAdapter` (`src/platform/contract/platform-adapter.ts`)
come sottile layer di wiring sopra il runtime esistente: `loadConfig()`
richiama `loadConfig()` da `src/runtime/config.ts` (file JSON via path/env
var), `createIdentityClient()` richiama `createLdapIdentityClient()` da
`src/integrations/ldap-client.ts`, `createDataStore()` richiama
`createPostgresStore()` da `src/integrations/postgres-store.ts`, e
`createSessionStore()` usa lo store in-memory di default già impiegato da
`src/web/security/session-manager.ts`.

Identità e dati supportati oggi: LDAP (via `ldap`/`ldaps://`) e PostgreSQL.
Il supporto MySQL/MariaDB promesso da ADR-002 per questo target è pianificato
come lavoro successivo (backlog), non ancora implementato: replicare in modo
sicuro le garanzie di isolamento multi-tenant che PostgreSQL offre oggi via
row-level security su un motore diverso è un lavoro sostanziale a sé stante,
fuori dallo scope di questa milestone.
