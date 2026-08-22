#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

state_dir="${GULOGULO_PATCH_STATE_DIR:-/var/lib/gulogulo/patch}"
state_file="${GULOGULO_PATCH_STATUS_FILE:-${state_dir}/status.json}"
base_image="${GULOGULO_BASE_IMAGE:-ubuntu:26.04}"
node_version="${GULOGULO_NODE_VERSION:-26.7.0}"

write_status() {
  local state="$1"
  local reason="${2:-}"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  install -d -m 0750 "$state_dir"
  umask 027
  if [[ -n "$reason" ]]; then
    printf '{"schemaVersion":1,"state":"%s","checkedAt":"%s","baseImage":"%s","nodeVersion":"%s","reason":"%s"}\n' \
      "$state" "$now" "$base_image" "$node_version" "$reason" >"$state_file"
  else
    printf '{"schemaVersion":1,"state":"%s","checkedAt":"%s","baseImage":"%s","nodeVersion":"%s"}\n' \
      "$state" "$now" "$base_image" "$node_version" >"$state_file"
  fi
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo 'The container patch command requires root in a disposable maintenance container.' >&2
    exit 2
  fi
}

case "${1:-status}" in
  status)
    if [[ -f "$state_file" ]]; then
      cat "$state_file"
    else
      write_status 'unknown' 'status_unavailable'
      cat "$state_file"
    fi
    ;;
  check)
    require_root
    write_status 'checking'
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    if apt-get --just-print upgrade | grep -q '^Inst '; then
      write_status 'updates_available'
    else
      write_status 'current'
    fi
    cat "$state_file"
    ;;
  apply)
    require_root
    write_status 'applying'
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get upgrade -y
    write_status 'current'
    cat "$state_file"
    ;;
  *)
    echo 'Usage: gulogulo-container-patch {status|check|apply}' >&2
    exit 64
    ;;
esac
