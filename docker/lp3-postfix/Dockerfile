# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

# LP3 uses Ubuntu packages for the disposable SMTP/LMTP ingress proof. This
# image is a local protocol fixture, not a production mail relay image.
FROM ubuntu:26.04

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    printf '%s\n' '#!/bin/sh' 'exit 101' > /usr/sbin/policy-rc.d; \
    chmod 0755 /usr/sbin/policy-rc.d; \
    echo 'postfix postfix/mailname string gulogulo.test' | debconf-set-selections; \
    echo 'postfix postfix/main_mailer_type select No configuration' | debconf-set-selections; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates netcat-openbsd postfix; \
    rm -f /usr/sbin/policy-rc.d; \
    rm -rf /var/lib/apt/lists/*; \
    install -d -o postfix -g postdrop /var/lib/postfix /var/spool/postfix

COPY main.cf /etc/postfix/main.cf
COPY lp3-mailboxes.regexp /etc/postfix/lp3-mailboxes.regexp
COPY lp3-aliases.regexp /etc/postfix/lp3-aliases.regexp
COPY entrypoint-postfix.sh /usr/local/sbin/gulogulo-lp3-postfix
COPY healthcheck-postfix.sh /usr/local/sbin/gulogulo-lp3-postfix-health

# Keep the distribution's queue services, disable chroot for the LMTP client so
# Docker's internal DNS is available, and append only the explicit submission
# listener required by the local contract.
RUN sed -i -E 's/^(lmtp[[:space:]]+unix[[:space:]]+-[[:space:]]+-[[:space:]])y([[:space:]]+.*)$/\1n\2/' \
    /etc/postfix/master.cf

RUN cat >> /etc/postfix/master.cf <<'EOF'
submission inet n       -       n       -       -       smtpd
  -o syslog_name=postfix/submission
  -o smtpd_tls_security_level=may
  -o smtpd_recipient_restrictions=reject
  -o smtpd_relay_restrictions=reject
EOF

RUN chmod 0755 /usr/local/sbin/gulogulo-lp3-postfix /usr/local/sbin/gulogulo-lp3-postfix-health \
    && chmod 0644 /etc/postfix/main.cf /etc/postfix/lp3-mailboxes.regexp /etc/postfix/lp3-aliases.regexp \
    && postfix check

EXPOSE 25 587

HEALTHCHECK --interval=3s --timeout=5s --start-period=10s --retries=20 \
    CMD ["/usr/local/sbin/gulogulo-lp3-postfix-health"]

CMD ["/usr/local/sbin/gulogulo-lp3-postfix"]
