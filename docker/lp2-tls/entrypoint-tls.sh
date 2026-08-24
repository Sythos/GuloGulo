#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

tls_dir="${LP2_TLS_DIR:-/run/gulogulo-lp2-tls}"
mkdir -p "${tls_dir}"
chmod 0755 "${tls_dir}"
umask 077

ca_key="${tls_dir}/ca.key"
ca_cert="${tls_dir}/ca.crt"

if [[ ! -s "${ca_cert}" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 7 \
    -keyout "${ca_key}" \
    -out "${ca_cert}" \
    -subj "/CN=GuloGulo LP2 Synthetic CA/O=Sythos"
fi

create_leaf() {
  local name="$1"
  local san="$2"
  local key="${tls_dir}/${name}.key"
  local csr="${tls_dir}/${name}.csr"
  local cert="${tls_dir}/${name}.crt"
  local config="${tls_dir}/${name}.cnf"

  if [[ -s "${cert}" && -s "${key}" ]]; then
    return
  fi

  cat > "${config}" <<EOF
[req]
distinguished_name = req_distinguished_name
req_extensions = req_ext
prompt = no

[req_distinguished_name]
CN = ${name}
O = Sythos

[req_ext]
subjectAltName = ${san}
extendedKeyUsage = serverAuth
keyUsage = digitalSignature, keyEncipherment
EOF

  openssl req -new -newkey rsa:2048 -nodes -sha256 \
    -keyout "${key}" \
    -out "${csr}" \
    -config "${config}"
  openssl x509 -req -sha256 -days 7 \
    -in "${csr}" \
    -CA "${ca_cert}" \
    -CAkey "${ca_key}" \
    -CAcreateserial \
    -out "${cert}" \
    -extfile "${config}" \
    -extensions req_ext

  rm -f "${csr}" "${config}" "${tls_dir}/ca.srl"
  chmod 0644 "${cert}"
  chmod 0600 "${key}"
}

create_leaf "lp2-ldap" "DNS:lp2-ldap,DNS:ldap.gulogulo.test,DNS:localhost,IP:127.0.0.1,IP:::1"
create_leaf "lp2-postgres" "DNS:lp2-postgres,DNS:postgres.gulogulo.test,DNS:localhost,IP:127.0.0.1,IP:::1"

# The signing key is not needed by either dependency service. Removing it
# before the container becomes healthy prevents the read-only service mounts
# from exposing a reusable CA key. The CA and leaf files are synthetic and
# short-lived by design.
rm -f "${ca_key}"
chmod 0644 "${ca_cert}"
chmod 0600 "${tls_dir}/lp2-ldap.key" "${tls_dir}/lp2-postgres.key"

printf '%s\n' 'lp2-tls-ready'
exec tail -f /dev/null
