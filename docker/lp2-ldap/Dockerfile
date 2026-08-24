# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

# The LP2 LDAP endpoint is a disposable OpenLDAP fixture. It is not a
# production directory image and is never published outside the internal
# Compose network.
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive \
    LDAP_CONFIG_DIR=/etc/gulogulo-lp2-ldap \
    LDAP_DATA_DIR=/var/lib/ldap

RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates ldap-utils openssl slapd; \
    rm -rf /var/lib/apt/lists/*; \
    install -d -o openldap -g openldap /var/lib/ldap /run/slapd /etc/gulogulo-lp2-ldap

COPY entrypoint-ldap.sh /usr/local/sbin/gulogulo-lp2-ldap
COPY bootstrap.ldif /etc/gulogulo-lp2-ldap/bootstrap.ldif
COPY healthcheck-ldap.sh /usr/local/sbin/gulogulo-lp2-ldap-health

RUN chmod 0755 /usr/local/sbin/gulogulo-lp2-ldap /usr/local/sbin/gulogulo-lp2-ldap-health \
    && chmod 0644 /etc/gulogulo-lp2-ldap/bootstrap.ldif

EXPOSE 636

HEALTHCHECK --interval=3s --timeout=3s --start-period=8s --retries=20 \
  CMD ["/usr/local/sbin/gulogulo-lp2-ldap-health"]

CMD ["/usr/local/sbin/gulogulo-lp2-ldap"]
