#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

python3 - <<'PY'
import socket

with socket.create_connection(('127.0.0.1', 3310), timeout=2) as sock:
    sock.sendall(b'PING\0')
    if b'PONG' not in sock.recv(64):
        raise SystemExit(1)

with socket.create_connection(('127.0.0.1', 3310), timeout=2) as sock:
    sock.sendall(b'VERSIONCOMMAND\0')
    if b'signature=ready' not in sock.recv(512):
        raise SystemExit(1)
PY
