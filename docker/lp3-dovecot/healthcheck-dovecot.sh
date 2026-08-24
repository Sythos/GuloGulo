#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

dovecot -n >/dev/null
nc -z 127.0.0.1 143
nc -z 127.0.0.1 24
nc -z 127.0.0.1 4190
