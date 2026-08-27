#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

tls_dir="${LP3_TLS_DIR:-/run/gulogulo-lp3-tls}"
mkdir -p "${tls_dir}"
chmod 0700 "${tls_dir}"

if [[ ! -s "${tls_dir}/ca.crt" || ! -s "${tls_dir}/lp3-postfix.crt" || \
  ! -s "${tls_dir}/lp3-postfix.key" || ! -s "${tls_dir}/lp3-dovecot.crt" || \
  ! -s "${tls_dir}/lp3-dovecot.key" ]]; then
  work_dir="$(mktemp -d)"
  trap 'rm -rf "${work_dir}"' EXIT

  openssl req -x509 -newkey rsa:2048 -nodes -days 7 \
    -keyout "${work_dir}/ca.key" -out "${work_dir}/ca.crt" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:1" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -subj "/CN=Gulo Gulo LP3 synthetic CA"

  for service in postfix dovecot; do
    cat > "${work_dir}/${service}.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:lp3-${service},DNS:${service}.gulogulo.test,DNS:localhost,IP:127.0.0.1,IP:::1
EOF
    openssl req -new -newkey rsa:2048 -nodes \
      -keyout "${work_dir}/lp3-${service}.key" \
      -out "${work_dir}/lp3-${service}.csr" \
      -subj "/CN=lp3-${service}.gulogulo.test"
    openssl x509 -req -days 7 -sha256 \
      -in "${work_dir}/lp3-${service}.csr" \
      -CA "${work_dir}/ca.crt" -CAkey "${work_dir}/ca.key" \
      -CAcreateserial -out "${work_dir}/lp3-${service}.crt" \
      -extfile "${work_dir}/${service}.ext"
  done

  install -m 0644 "${work_dir}/ca.crt" "${tls_dir}/ca.crt"
  for service in postfix dovecot; do
    install -m 0644 "${work_dir}/lp3-${service}.crt" "${tls_dir}/lp3-${service}.crt"
    install -m 0600 "${work_dir}/lp3-${service}.key" "${tls_dir}/lp3-${service}.key"
  done
fi

exec sleep infinity
