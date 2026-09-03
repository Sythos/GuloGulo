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
`src/integrations/ldap-client.ts` oppure, quando la configurazione caricata
imposta `identity.source = 'database'`, `createDatabaseIdentityClient()` da
`./db-identity-client.ts` — una tabella `local_users` in PostgreSQL invece di
LDAP, per installazioni singole/leggere che non vogliono gestire una directory
esterna (vedi `doc/identity-and-postgres.md`). `createDataStore()` richiama
`createPostgresStore()` da `src/integrations/postgres-store.ts`, e
`createSessionStore()` usa lo store in-memory di default già impiegato da
`src/web/security/session-manager.ts`.

Identità e dati supportati oggi: LDAP (via `ldap`/`ldaps://`), un identity
client DB-backed su PostgreSQL (`local_users`, opt-in via
`IDENTITY_SOURCE=database`), e PostgreSQL come data store. Il wiring del login
reale (`src/runtime/login.ts`) risolve questo adapter e chiama il client
d'identità risultante per ogni `POST /api/session/login` fuori da
`GULOGULO_FIXTURE_MODE=true`. Non esiste ancora un'interfaccia di
amministrazione per creare/ruotare righe `local_users`: oggi va fatto
inserendo righe direttamente con `createPasswordHasher().hash(password)` come
`password_hash` (backlog).

Il supporto MySQL/MariaDB promesso da ADR-002 per questo target è pianificato
come lavoro successivo (backlog), non ancora implementato: replicare in modo
sicuro le garanzie di isolamento multi-tenant che PostgreSQL offre oggi via
row-level security su un motore diverso è un lavoro sostanziale a sé stante,
fuori dallo scope di questa milestone.
