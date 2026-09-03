#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Gulo Gulo standalone installer. Run from inside an extracted
# gulogulo-<version>-standalone.tar.gz. Installs production dependencies,
# creates .env from .env.example on first run, and applies pending database
# migrations (a no-op while POSTGRES_ENABLED=false, the packaged default).
#
# Usage: ./install.sh [--runtime=node|bun] [--non-interactive]
# Non-interactive mode is also enabled via GULOGULO_NON_INTERACTIVE=1.
# --runtime defaults to node; see switch-runtime.sh to change it later
# without reinstalling. Either way dist/server/ is the exact same compiled
# JS - only which interpreter runs it changes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NON_INTERACTIVE="${GULOGULO_NON_INTERACTIVE:-0}"
RUNTIME="node"

for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --runtime=node) RUNTIME="node" ;;
    --runtime=bun) RUNTIME="bun" ;;
    *) echo "[install] Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

log() { printf '[install] %s\n' "$1"; }
fail() { printf '[install] ERROR: %s\n' "$1" >&2; exit 1; }

# Node.js is always required, regardless of --runtime: npm installs
# dependencies and runs database migrations either way (see below) - this
# script never uses `bun install` or a bun-based migration runner. --runtime
# only chooses which interpreter later executes the compiled server.
command -v node >/dev/null 2>&1 || fail "Node.js is required but was not found in PATH."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 26 ]; then
  fail "Node.js >= 26 is required (found $(node -v))."
fi

if [ "$RUNTIME" = bun ]; then
  command -v bun >/dev/null 2>&1 || fail "bun was not found in PATH. Install it (see https://bun.com/docs/installation), then re-run this script."
  log "Bun found: $(bun --version). No minimum version is enforced yet - only the version exercised by this project's own CI (see .github/workflows/bun-compat.yml) is verified; running Bun in production is VERIFY BEFORE USE."
fi

RUNTIME_BIN="$(command -v "$RUNTIME")"

cd "$SCRIPT_DIR"
printf '%s\n' "$RUNTIME" > .runtime

if [ ! -f .env ]; then
  cp .env.example .env
  log ".env created from .env.example - review and edit it before starting the service."
else
  log ".env already exists; leaving it untouched."
fi

log "Installing production dependencies (npm ci --omit=dev)..."
npm ci --omit=dev --no-audit --no-fund

log "Applying database migrations (skipped automatically while Postgres is disabled)..."
node --env-file=.env "$SCRIPT_DIR/run-migrations.mjs"

log "Install complete."
log "Start the service with:"
log "  $RUNTIME_BIN --env-file=.env dist/server/src/runtime/index.js"
log "A systemd unit example is available at gulogulo.service.example - copy it,"
log "edit the paths/user, and enable it manually; it is never installed automatically."
log "A daily retention/purge timer example is also available at"
log "gulogulo-purge.service.example / gulogulo-purge.timer.example - same deal,"
log "copy them to /etc/systemd/system/, adjust the paths/user, then"
log "systemctl daemon-reload && systemctl enable --now gulogulo-purge.timer."

if [ "$NON_INTERACTIVE" != "1" ]; then
  log "Review .env before starting the service in production."
fi
