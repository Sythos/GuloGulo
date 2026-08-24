#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

tls_dir="${LP3_TLS_DIR:-/run/gulogulo-lp3-tls}"
test -s "${tls_dir}/lp3-dovecot.crt"
test -s "${tls_dir}/lp3-dovecot.key"
test -s "${tls_dir}/ca.crt"

mkdir -p /run/dovecot /var/lib/dovecot /var/mail/vhosts/gulogulo.test
# Keep restarts idempotent: GNU install also chmods existing vmail-owned paths,
# which requires CAP_FOWNER after the container drops all capabilities.
for user in alice postmaster; do
  mkdir -p \
    "/var/mail/vhosts/gulogulo.test/${user}/Maildir/cur" \
    "/var/mail/vhosts/gulogulo.test/${user}/Maildir/new" \
    "/var/mail/vhosts/gulogulo.test/${user}/Maildir/tmp" \
    "/var/mail/vhosts/gulogulo.test/${user}/sieve"
done
chown -R vmail:vmail /var/mail/vhosts /var/lib/dovecot

dovecot -n >/dev/null
exec dovecot -F -c /etc/dovecot/dovecot.conf
