# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

# LP2 uses a disposable synthetic CA only for the offline Compose proof. It is
# deliberately separate from any production ACME or operator certificate
# workflow.
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates openssl; \
    rm -rf /var/lib/apt/lists/*

COPY entrypoint-tls.sh /usr/local/sbin/gulogulo-lp2-tls

RUN chmod 0755 /usr/local/sbin/gulogulo-lp2-tls

CMD ["/usr/local/sbin/gulogulo-lp2-tls"]
