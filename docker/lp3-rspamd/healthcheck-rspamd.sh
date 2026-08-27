#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

python3 - <<'PY'
import json
import urllib.request

with urllib.request.urlopen('http://127.0.0.1:11333/health', timeout=2) as response:
    payload = json.load(response)
if payload.get('status') != 'ok' or payload.get('production') is not False or payload.get('signatureStatus') != 'ready':
    raise SystemExit(1)
PY
