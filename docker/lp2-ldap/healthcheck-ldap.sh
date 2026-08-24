#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

tls_dir="${LP2_TLS_DIR:-/run/gulogulo-lp2-tls}"
root_dn="${LP2_LDAP_ROOT_DN:-cn=admin,dc=gulogulo,dc=test}"
root_password="${LP2_LDAP_ROOT_PASSWORD:-lp2-synthetic-root}"
base_dn="${LP2_LDAP_BASE_DN:-dc=gulogulo,dc=test}"

LDAPTLS_CACERT="${tls_dir}/ca.crt" LDAPTLS_REQCERT=demand \
  ldapsearch -H ldaps://lp2-ldap:636 -x -D "${root_dn}" -w "${root_password}" \
    -b "${base_dn}" -s base '(objectClass=*)' dn >/dev/null
