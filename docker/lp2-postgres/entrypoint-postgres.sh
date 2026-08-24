#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

tls_dir="${LP2_TLS_DIR:-/run/gulogulo-lp2-tls}"
pgdata="${PGDATA:-/var/lib/postgresql/lp2-data}"
database="${POSTGRES_DB:-gulogulo}"
user_name="${POSTGRES_USER:-gulogulo}"
password="${POSTGRES_PASSWORD:-lp2-synthetic-postgres}"
pg_bin_dir="$(pg_config --bindir)"

test -s "${tls_dir}/ca.crt"
test -s "${tls_dir}/lp2-postgres.crt"
test -s "${tls_dir}/lp2-postgres.key"

install -d -o postgres -g postgres "${pgdata}"
if [[ ! -s "${pgdata}/PG_VERSION" ]]; then
  runuser -u postgres -- "${pg_bin_dir}/initdb" \
    --auth-local=trust \
    --auth-host=scram-sha-256 \
    --username=postgres \
    --pgdata="${pgdata}" >/dev/null
fi

install -o postgres -g postgres -m 0644 "${tls_dir}/lp2-postgres.crt" "${pgdata}/server.crt"
install -o postgres -g postgres -m 0600 "${tls_dir}/lp2-postgres.key" "${pgdata}/server.key"
install -o postgres -g postgres -m 0644 "${tls_dir}/ca.crt" "${pgdata}/root.crt"

cat >> "${pgdata}/postgresql.conf" <<EOF
listen_addresses = '*'
port = 5432
ssl = on
ssl_cert_file = '${pgdata}/server.crt'
ssl_key_file = '${pgdata}/server.key'
ssl_ca_file = '${pgdata}/root.crt'
password_encryption = 'scram-sha-256'
EOF

cat > "${pgdata}/pg_hba.conf" <<EOF
local all all trust
hostssl all all 0.0.0.0/0 scram-sha-256
hostssl all all ::/0 scram-sha-256
host all all 0.0.0.0/0 reject
host all all ::/0 reject
EOF
chown postgres:postgres "${pgdata}/postgresql.conf" "${pgdata}/pg_hba.conf"

runuser -u postgres -- "${pg_bin_dir}/postgres" --pgdata="${pgdata}" &
postgres_pid=$!
cleanup() {
  kill "${postgres_pid}" 2>/dev/null || true
  wait "${postgres_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ready=false
for attempt in $(seq 1 60); do
  if runuser -u postgres -- "${pg_bin_dir}/pg_isready" --host=127.0.0.1 --port=5432 >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "${ready}" != true ]]; then
  echo 'LP2 synthetic PostgreSQL did not become ready.' >&2
  exit 1
fi

runuser -u postgres -- psql --dbname=postgres --set=ON_ERROR_STOP=1 \
  --command="DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${user_name}') THEN CREATE ROLE \"${user_name}\" LOGIN PASSWORD '${password}'; ELSE ALTER ROLE \"${user_name}\" LOGIN PASSWORD '${password}'; END IF; END \$\$;" \
  --command="SELECT 'CREATE DATABASE \"${database}\" OWNER \"${user_name}\"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${database}')\\gexec" >/dev/null

runuser -u postgres -- psql --dbname="${database}" --set=ON_ERROR_STOP=1 \
  --command="CREATE TABLE IF NOT EXISTS lp2_probe (probe_key text PRIMARY KEY, probe_value text NOT NULL);" \
  --command="INSERT INTO lp2_probe (probe_key, probe_value) VALUES ('deterministic', 'lp2-postgres-ready') ON CONFLICT (probe_key) DO UPDATE SET probe_value = EXCLUDED.probe_value;" \
  --command="ALTER TABLE lp2_probe OWNER TO \"${user_name}\";" >/dev/null

wait "${postgres_pid}"
