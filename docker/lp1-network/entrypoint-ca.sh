#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

ca_dir="${LP1_CA_DIR:-/run/gulogulo-ca}"
mkdir -p "$ca_dir"
chmod 0700 "$ca_dir"

if [[ ! -s "$ca_dir/ca.key" || ! -s "$ca_dir/ca.crt" ]]; then
  rm -f "$ca_dir"/ca.key "$ca_dir"/ca.crt
  openssl req -x509 -newkey rsa:3072 -nodes \
    -keyout "$ca_dir/ca.key" \
    -out "$ca_dir/ca.crt" \
    -days 7 \
    -sha256 \
    -subj '/CN=Gulo Gulo LP1 Local CA' \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:1' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign'
fi

if [[ ! -s "$ca_dir/gulogulo.test.key" || ! -s "$ca_dir/gulogulo.test.crt" ]]; then
  rm -f "$ca_dir"/gulogulo.test.key "$ca_dir"/gulogulo.test.crt "$ca_dir"/gulogulo.test.csr "$ca_dir"/ca.srl
  openssl req -new -newkey rsa:2048 -nodes \
    -keyout "$ca_dir/gulogulo.test.key" \
    -out "$ca_dir/gulogulo.test.csr" \
    -subj '/CN=gulogulo.test'

  cat > "$ca_dir/gulogulo.test.ext" <<'EOF'
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:gulogulo.test,DNS:webmail.localhost,DNS:calendar.localhost,DNS:contacts.localhost
EOF

  openssl x509 -req \
    -in "$ca_dir/gulogulo.test.csr" \
    -CA "$ca_dir/ca.crt" \
    -CAkey "$ca_dir/ca.key" \
    -CAcreateserial \
    -out "$ca_dir/gulogulo.test.crt" \
    -days 7 \
    -sha256 \
    -extfile "$ca_dir/gulogulo.test.ext"

  rm -f "$ca_dir/gulogulo.test.csr" "$ca_dir/gulogulo.test.ext" "$ca_dir/ca.srl"
fi

chmod 0600 "$ca_dir/ca.key" "$ca_dir/gulogulo.test.key"
chmod 0644 "$ca_dir/ca.crt" "$ca_dir/gulogulo.test.crt"

echo 'gulogulo-lp1-ca-ready'
trap 'exit 0' TERM INT
while :; do
  sleep 3600 &
  wait $!
done
