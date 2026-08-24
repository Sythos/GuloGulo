#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

tls_dir="${LP2_TLS_DIR:-/run/gulogulo-lp2-tls}"
database="${POSTGRES_DB:-gulogulo}"
user_name="${POSTGRES_USER:-gulogulo}"
password="${POSTGRES_PASSWORD:-lp2-synthetic-postgres}"

PGPASSWORD="${password}" PGSSLMODE=verify-full PGSSLROOTCERT="${tls_dir}/ca.crt" \
  psql --host=lp2-postgres --port=5432 --username="${user_name}" --dbname="${database}" \
    --no-password --tuples-only --command="SELECT 1" >/dev/null
