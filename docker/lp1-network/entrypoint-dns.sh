#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

dns_port="${LP1_DNS_PORT:-5353}"

exec dnsmasq \
  --no-daemon \
  --keep-in-foreground \
  --no-resolv \
  --no-hosts \
  --listen-address=0.0.0.0 \
  --bind-interfaces \
  --port="$dns_port" \
  --address=/gulogulo.test/127.0.0.1 \
  --address=/webmail.localhost/127.0.0.1 \
  --address=/calendar.localhost/127.0.0.1 \
  --address=/contacts.localhost/127.0.0.1 \
  --address=/.localhost/127.0.0.1 \
  --log-facility=- \
  --user=nobody \
  --group=nogroup
