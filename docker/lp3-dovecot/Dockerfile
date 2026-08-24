# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

# LP3 uses Ubuntu's Dovecot packages for the disposable IMAP/IDLE/LMTP/Sieve
# contract. This is an offline synthetic service topology, not a production
# mailbox image.
FROM ubuntu:26.04

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    printf '%s\n' '#!/bin/sh' 'exit 101' > /usr/sbin/policy-rc.d; \
    chmod 0755 /usr/sbin/policy-rc.d; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates netcat-openbsd \
      dovecot-core dovecot-imapd dovecot-lmtpd dovecot-sieve dovecot-managesieved; \
    rm -f /usr/sbin/policy-rc.d; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --system --gid 5000 vmail; \
    useradd --system --uid 5000 --gid vmail --home-dir /var/mail/vhosts \
      --no-create-home --shell /usr/sbin/nologin vmail; \
    install -d -o vmail -g vmail /var/mail/vhosts /var/lib/dovecot /run/dovecot \
      /etc/dovecot/sieve

RUN rm -f /etc/dovecot/conf.d/*.conf
COPY dovecot.conf /etc/dovecot/dovecot.conf
COPY users /etc/dovecot/users
COPY default.sieve /etc/dovecot/sieve/default.sieve
COPY entrypoint-dovecot.sh /usr/local/sbin/gulogulo-lp3-dovecot
COPY healthcheck-dovecot.sh /usr/local/sbin/gulogulo-lp3-dovecot-health

RUN chmod 0755 /usr/local/sbin/gulogulo-lp3-dovecot /usr/local/sbin/gulogulo-lp3-dovecot-health \
    && chmod 0640 /etc/dovecot/users \
    && chown root:dovecot /etc/dovecot/users \
    && chmod 0644 /etc/dovecot/dovecot.conf /etc/dovecot/sieve/default.sieve

EXPOSE 143 993 24 4190

HEALTHCHECK --interval=3s --timeout=5s --start-period=10s --retries=20 \
    CMD ["/usr/local/sbin/gulogulo-lp3-dovecot-health"]

CMD ["/usr/local/sbin/gulogulo-lp3-dovecot"]
