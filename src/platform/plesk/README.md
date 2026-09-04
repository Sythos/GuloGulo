<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

Adapter `plesk` (ADR-002): il terzo target di distribuzione, per un
operatore che ospita Gulo Gulo su un server Plesk. Implementa
`PlatformAdapter` (`src/platform/contract/platform-adapter.ts`) come sottile
layer di wiring, sullo stesso modello degli adapter `standalone`
(`src/platform/standalone/`) e `cpanel` (`src/platform/cpanel/`), con
un'unica differenza sostanziale: l'identità utente non passa da LDAP, perché
Plesk gestisce i propri account email autonomamente tramite la sua REST API
moderna (`/api/v2/*`, in ascolto tipicamente su `:8443`).

## Cosa implementa oggi

- **Client API iniettabile** (`plesk-api-client.ts`): `createPleskApiClient()`
  parla con la REST API locale di Plesk (`https://127.0.0.1:8443/api/v2/
  <path>`) via `fetch` nativo di Node, autenticato con header
  `X-API-Key: <chiave>`. Gestisce timeout configurabile, errore su risposta
  non-2xx, corpo vuoto (risolto a `null` invece di fallire) ed errore su
  corpo JSON malformato; la chiave API non compare mai in un messaggio
  d'errore o in un log. L'intera interazione HTTP passa dall'interfaccia
  `PleskApiClientLike` (`request(method, path, body?)`), così ogni
  consumatore (a partire dall'identity client) può ricevere un fake iniettato
  nei test invece di dipendere dal comportamento HTTP reale.
- **Identità via REST API** (`plesk-identity-client.ts`):
  `createPleskIdentityClient()` ritorna la stessa shape `LdapIdentityClient`
  già usata per standalone e cPanel (`lookupUser`, `authenticate`,
  `healthCheck`, `close`) implementata sopra `PleskApiClientLike`.
  `lookupUser()` chiama `GET /api/v2/domains` per risolvere il dominio del
  tenant, poi `GET /api/v2/domains/{id}/mail-accounts` per cercare l'account
  email corrispondente e lo mappa in `TenantIdentity`. `healthCheck()` usa
  `GET /api/v2/server` come probe di raggiungibilità a basso impatto.
- **Dati**: `createDataStore()` riusa `createPostgresStore()` esistente — la
  stessa scelta pragmatica già fatta per standalone e cPanel. Il motore
  MySQL/MariaDB tipico di Plesk promesso da ADR-002 resta backlog: un host
  Plesk con PostgreSQL abilitato funziona oggi.
- **Sessioni**: `createSessionStore()` usa lo stesso store in-memory di
  default degli altri due target.
- **Configurazione**: `PleskApiSettings` (`src/integrations/types.ts`,
  aggiunto in modo additivo a `IntegrationConfig`, stesso pattern di
  `CpanelApiSettings`) — `baseUrl`, `apiKeySecretRef`, `timeoutMs`. Il
  caricamento di questi valori da file di configurazione ed env
  (`PLESK_API_*`, vedi `.env.example`) è cablato in `src/runtime/config.ts`,
  con lo stesso meccanismo e la stessa validazione già usati per
  `ldap`/`postgres`/`controlPanel`: resta disabilitata di default finché
  `plesk.enabled`/`PLESK_API_ENABLED` non è impostato.

## Endpoint REST assunti, da validare sul campo

Non è stato possibile verificare questi dettagli contro un'istanza Plesk
reale. Solo `GET /api/v2/domains` è confermato dalla ricerca fatta a monte
di questo task; il resto è l'ipotesi più ragionevole sulla forma della REST
API, documentata inline nel codice (`plesk-identity-client.ts`) e da
confermare prima di un uso in produzione:

- `GET /api/v2/domains/{id}/mail-accounts` per elencare gli account email di
  un dominio — potrebbe invece essere una collezione top-level tipo
  `/api/v2/mail-accounts?domain=...`, o avere un path diverso.
- `GET /api/v2/server` come probe di raggiungibilità — qualunque altro
  endpoint `/api/v2/*` read-only e stabile andrebbe bene allo stesso scopo.

## `authenticate()`: verifica reale via IMAP LOGIN

La REST API di Plesk non espone un endpoint generico e sicuro per verificare
la password di un account email arbitrario dall'esterno — le risorse
dominio/mail-account gestiscono gli account, non li autenticano. L'unico
meccanismo di verifica realmente disponibile è quindi un login IMAP diretto
contro il server mail locale, stessa scelta già fatta per l'adapter cPanel:
`authenticate()` tenta una vera `LOGIN` IMAP
(`src/core/mail/imap-client.ts`, via l'helper condiviso
`authenticateWithImapLogin()` in
`../contract/platform-adapter.ts`) verso `127.0.0.1` sulla porta IMAP
configurata (`mail.imapsPort`), usando `<username>@<dominio del tenant>`
come utente IMAP e la password sottomessa al login. Un login accettato
ritorna `true`; una password rifiutata, un server IMAP irraggiungibile, o
qualunque altro errore ritornano `false` (fail-closed) — mai un'eccezione
verso il chiamante. `createImapClient` è iniettato da `plesk-adapter.ts`
tramite `createLocalMailClients()`, lo stesso factory già usato per il
probe di capability IMAP IDLE (vedi `INSTALL.md`, sezione "IMAP IDLE
availability"). Verificato con un client IMAP fake nei test
(`plesk-identity-client.test.ts`); non ancora verificato contro un host
Plesk reale con Dovecot/Postfix in produzione.

## Cosa manca

Il packaging per questo target (installer, unit systemd, reverse proxy) è
pianificato per il prossimo task di questa stessa milestone, non incluso qui.
