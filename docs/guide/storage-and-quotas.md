# Persistent storage and quota operations

> **⚠️ Documento in transizione.** Le sezioni di questo documento che descrivono deployment container/Docker/Kubernetes (volumi, socket, sidecar, rollout blue/green) si riferiscono al modello precedente, abbandonato (vedi ADR-002). Il contenuto su protocolli, sicurezza applicativa, e logica di business resta valido; gli aspetti di deployment container-specifici non sono più applicabili e saranno riscritti quando necessario.

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

Container layers are disposable. User data must not live in a writable layer
that disappears when an image is replaced, a container is recreated, or a
Compose project is updated. Gulo Gulo therefore mounts named volumes outside
the container root filesystem:

```text
runtime-state  -> /var/lib/gulogulo
mail-data      -> /var/lib/gulogulo/mail
dav-data       -> /var/lib/gulogulo/dav
backup-data    -> /var/lib/gulogulo/backups
```

The application image remains read-only. The Docker socket is never mounted and
the application has no authority to create, delete, or rewire its volumes.

## Production volumes

For a production deployment, create and back up the volumes independently of
the Compose project, then set:

```text
GULOGULO_VOLUME_PREFIX=gulogulo-production
GULOGULO_VOLUMES_EXTERNAL=true
```

With `GULOGULO_VOLUMES_EXTERNAL=true`, Compose expects the named volumes to
already exist and will not remove them as part of project lifecycle. Never use
`docker compose down --volumes` against a production project. A blue/green
upgrade mounts the same external volumes into the new revision only after the
backup and health gates pass.

The `local` and CI profiles leave the flag false and use disposable named
volumes. The fixture and test profiles intentionally remove their mounts so
they cannot modify developer data.

## Quota source of truth

The gross tenant quota and each user's allocation are application state in
external PostgreSQL. The mail and DAV volume paths hold content; the quota
adapter in the Gulo Gulo container decides whether a new allocation is valid.
Each allocation is committed transactionally with a tenant row lock, and the
sum of allocations can never exceed the tenant gross quota. A container restart
therefore reuses the same quota state instead of resetting or recalculating it
from an ephemeral layer.

Backups must cover both the persistent content volumes and PostgreSQL. Restoring
only one side can produce an intentional operational alarm because quota state
and content no longer describe the same point in time.
