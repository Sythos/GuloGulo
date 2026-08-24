# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

# LP3's certificate authority is disposable and exists only for the offline
# Compose proof. It is not an ACME, production PKI, or trust anchor.
FROM ubuntu:26.04

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates openssl; \
    rm -rf /var/lib/apt/lists/*

COPY entrypoint-tls.sh /usr/local/sbin/gulogulo-lp3-tls

RUN chmod 0755 /usr/local/sbin/gulogulo-lp3-tls

HEALTHCHECK --interval=2s --timeout=2s --start-period=2s --retries=15 \
    CMD test -s /run/gulogulo-lp3-tls/ca.crt \
      && test -s /run/gulogulo-lp3-tls/lp3-postfix.crt \
      && test -s /run/gulogulo-lp3-tls/lp3-postfix.key \
      && test -s /run/gulogulo-lp3-tls/lp3-dovecot.crt \
      && test -s /run/gulogulo-lp3-tls/lp3-dovecot.key

CMD ["/usr/local/sbin/gulogulo-lp3-tls"]
