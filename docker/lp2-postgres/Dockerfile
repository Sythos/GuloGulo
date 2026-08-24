# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

# The LP2 PostgreSQL endpoint is a disposable local fixture. Production
# PostgreSQL remains an operator-managed external dependency.
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive \
    PGDATA=/var/lib/postgresql/lp2-data \
    POSTGRES_DB=gulogulo \
    POSTGRES_USER=gulogulo \
    POSTGRES_PASSWORD=lp2-synthetic-postgres

RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates openssl postgresql postgresql-client; \
    rm -rf /var/lib/apt/lists/*; \
    install -d -o postgres -g postgres /var/lib/postgresql/lp2-data

COPY entrypoint-postgres.sh /usr/local/sbin/gulogulo-lp2-postgres
COPY healthcheck-postgres.sh /usr/local/sbin/gulogulo-lp2-postgres-health

RUN chmod 0755 /usr/local/sbin/gulogulo-lp2-postgres /usr/local/sbin/gulogulo-lp2-postgres-health

EXPOSE 5432

HEALTHCHECK --interval=3s --timeout=5s --start-period=12s --retries=25 \
  CMD ["/usr/local/sbin/gulogulo-lp2-postgres-health"]

CMD ["/usr/local/sbin/gulogulo-lp2-postgres"]
