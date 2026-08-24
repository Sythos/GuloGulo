#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

tls_dir="${LP3_TLS_DIR:-/run/gulogulo-lp3-tls}"
test -s "${tls_dir}/lp3-postfix.crt"
test -s "${tls_dir}/lp3-postfix.key"
test -s "${tls_dir}/ca.crt"

mkdir -p /var/spool/postfix /var/lib/postfix
chown -R postfix:postdrop /var/spool/postfix /var/lib/postfix

exec postfix start-fg
