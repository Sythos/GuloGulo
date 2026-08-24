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

# The empty named volumes inherit the ownership and queue layout baked into
# the image. Do not recursively chown them here: Postfix deliberately keeps a
# mixed root/postdrop/postfix ownership model for its queue directories, and a
# blanket chown prevents the queue manager from handing accepted mail to the
# LMTP client. The root filesystem is read-only at runtime, so all mutable
# state remains in the mounted volumes.

exec postfix start-fg
