#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Thin wrapper around switch-runtime.sh - see that script for what this
# actually does. Usage: ./switch-to-bun.sh [install-dir] [--non-interactive]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/switch-runtime.sh" bun "$@"
