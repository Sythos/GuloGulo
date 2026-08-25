#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

state_dir="${GULOGULO_PATCH_STATE_DIR:-/var/lib/gulogulo/patch}"
state_file="${GULOGULO_PATCH_STATUS_FILE:-${state_dir}/status.json}"
base_image="${GULOGULO_BASE_IMAGE:-ubuntu:26.04}"
node_version="${GULOGULO_NODE_VERSION:-26.7.0}"

safe_metadata() {
  local value="$1"
  local fallback="$2"

  if [[ "$value" =~ ^[A-Za-z0-9._:+/-]{1,255}$ ]]; then
    printf '%s' "$value"
  else
    printf '%s' "$fallback"
  fi
}

base_image="$(safe_metadata "$base_image" 'unknown')"
node_version="$(safe_metadata "$node_version" 'unknown')"

write_status() {
  local state="$1"
  local reason="${2:-}"
  local now
  local state_parent
  local temporary_file
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  state_parent="$(dirname "$state_file")"

  install -d -m 0750 "$state_dir" "$state_parent"
  umask 027
  temporary_file="$(mktemp "${state_file}.tmp.XXXXXX")"
  if [[ -n "$reason" ]]; then
    printf '{"schemaVersion":1,"state":"%s","checkedAt":"%s","baseImage":"%s","nodeVersion":"%s","reason":"%s"}\n' \
      "$state" "$now" "$base_image" "$node_version" "$reason" >"$temporary_file"
  else
    printf '{"schemaVersion":1,"state":"%s","checkedAt":"%s","baseImage":"%s","nodeVersion":"%s"}\n' \
      "$state" "$now" "$base_image" "$node_version" >"$temporary_file"
  fi
  chmod 0640 "$temporary_file"
  mv -f "$temporary_file" "$state_file"
}

fail_patch() {
  local reason="$1"
  write_status 'failed' "$reason"
  echo "Container patch operation failed (${reason})." >&2
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
      printf '{"schemaVersion":1,"state":"unknown","reason":"status_unavailable"}\n'
    fi
    ;;
  check)
    require_root
    write_status 'checking'
    export DEBIAN_FRONTEND=noninteractive
    if ! apt-get update >/dev/null 2>&1; then
      fail_patch 'apt_update_failed'
      exit 1
    fi
    updates=''
    if ! updates="$(apt-get --just-print upgrade 2>/dev/null | awk '/^Inst / { updates = 1 } END { print updates ? "yes" : "no" }')"; then
      fail_patch 'apt_check_failed'
      exit 1
    fi
    if [[ "$updates" == 'yes' ]]; then
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
    if ! apt-get update >/dev/null 2>&1; then
      fail_patch 'apt_update_failed'
      exit 1
    fi
    if ! apt-get upgrade -y >/dev/null 2>&1; then
      fail_patch 'apt_apply_failed'
      exit 1
    fi
    write_status 'current'
    cat "$state_file"
    ;;
  *)
    echo 'Usage: gulogulo-container-patch {status|check|apply}' >&2
    exit 64
    ;;
esac
