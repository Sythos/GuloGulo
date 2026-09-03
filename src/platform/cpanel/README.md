<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

Adapter `cpanel` (ADR-002): il secondo target di distribuzione, per un
operatore che ospita Gulo Gulo su un account cPanel. Implementa
`PlatformAdapter` (`src/platform/contract/platform-adapter.ts`) come sottile
layer di wiring, sullo stesso modello dell'adapter `standalone`
(`src/platform/standalone/`), con un'unica differenza sostanziale:
l'identità utente non passa da LDAP, perché cPanel gestisce i propri account
email autonomamente.

## Cosa implementa oggi

- **Client API iniettabile** (`cpanel-api-client.ts`): `createCpanelApiClient()`
  parla con l'UAPI locale di cPanel (`https://127.0.0.1:2083/execute/<Modulo>/
  <funzione>`) via `fetch` nativo di Node, autenticato con
  `Authorization: cpanel <utente>:<token>`. Gestisce timeout configurabile,
  errore su risposta non-2xx ed errore su corpo JSON malformato; l'username e
  il token non compaiono mai in un messaggio d'errore o in un log. L'intera
  interazione HTTP passa dall'interfaccia `CpanelApiClientLike`, così ogni
  consumatore (a partire dall'identity client) può ricevere un fake iniettato
  nei test invece di dipendere dal comportamento HTTP reale.
- **Identità via UAPI** (`cpanel-identity-client.ts`):
  `createCpanelIdentityClient()` ritorna la stessa shape `LdapIdentityClient`
  già usata per lo standalone (`lookupUser`, `authenticate`, `healthCheck`,
  `close`) implementata sopra `CpanelApiClientLike`. `lookupUser()` chiama
  `Email::list_pops` per verificare se esiste un account email corrispondente
  nel dominio del tenant e lo mappa in `TenantIdentity`. `healthCheck()` usa
  `DomainInfo::domains_data` come probe di raggiungibilità a basso impatto.
- **Dati**: `createDataStore()` riusa `createPostgresStore()` esistente — la
  stessa scelta pragmatica già fatta per lo standalone in PK2. Il motore
  MySQL/MariaDB tipico di cPanel promesso da ADR-002 resta backlog: un host
  cPanel con PostgreSQL abilitato funziona oggi.
- **Sessioni**: `createSessionStore()` usa lo stesso store in-memory di
  default dello standalone.
- **Configurazione**: `CpanelApiSettings` (`src/integrations/types.ts`,
  aggiunto in modo additivo a `IntegrationConfig`) — `baseUrl`, `username`,
  `apiTokenSecretRef`, `timeoutMs`. Il caricamento di questi valori da file di
  configurazione ed env (`CPANEL_API_*`, vedi `.env.example`) è cablato in
  `src/runtime/config.ts`, con lo stesso meccanismo e la stessa validazione
  già usati per `ldap`/`postgres`/`controlPanel`: resta disabilitata di
  default finché `cpanel.enabled`/`CPANEL_API_ENABLED` non è impostato.

## Limitazione nota: `authenticate()`

L'UAPI di cPanel non espone un endpoint generico e sicuro per verificare la
password di un account email arbitrario dall'esterno — `Email::list_pops` e
gli endpoint affini gestiscono gli account, non li autenticano. Piuttosto che
inventare un endpoint non documentato e non verificabile contro un cPanel
reale, `authenticate()` fallisce **sempre e in modo esplicito**: ritorna
`false` (fail-closed) e logga il motivo. La verifica password reale per gli
account email cPanel è pianificata per una milestone successiva, con due
strade più probabili: un login IMAP/POP3 diretto contro il server mail locale
(pattern già disponibile in questo progetto per i percorsi di autenticazione
basati su LDAP), oppure un plugin/hook cPanel dedicato.

## Cosa manca

Il packaging per questo target (installer, unit systemd, reverse proxy) è
pianificato per il prossimo task di questa stessa milestone, non incluso qui.
