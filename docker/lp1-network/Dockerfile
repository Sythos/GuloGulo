# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

# Disposable LP1 network utility image. It is deliberately separate from the
# application image: the local CA and DNS boundary must never be mistaken for
# a production certificate or public resolver.
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates dnsmasq openssl; \
    rm -rf /var/lib/apt/lists/*

COPY entrypoint-ca.sh /usr/local/sbin/gulogulo-lp1-ca
COPY entrypoint-dns.sh /usr/local/sbin/gulogulo-lp1-dns

RUN chmod 0755 /usr/local/sbin/gulogulo-lp1-ca /usr/local/sbin/gulogulo-lp1-dns

# Compose selects the entrypoint for each logical utility role.
CMD ["/usr/local/sbin/gulogulo-lp1-dns"]
