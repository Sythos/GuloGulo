#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

set -euo pipefail

tls_dir="${LP2_TLS_DIR:-/run/gulogulo-lp2-tls}"
config_dir="${LDAP_CONFIG_DIR:-/etc/gulogulo-lp2-ldap}"
data_dir="${LDAP_DATA_DIR:-/var/lib/ldap}"
root_dn="${LP2_LDAP_ROOT_DN:-cn=admin,dc=gulogulo,dc=test}"
root_password="${LP2_LDAP_ROOT_PASSWORD:-lp2-synthetic-root}"
base_dn="${LP2_LDAP_BASE_DN:-dc=gulogulo,dc=test}"
user_dn="${LP2_LDAP_USER_BASE_DN:-ou=users,dc=gulogulo,dc=test}"

test -s "${tls_dir}/ca.crt"
test -s "${tls_dir}/lp2-ldap.crt"
test -s "${tls_dir}/lp2-ldap.key"

mkdir -p /run/slapd "${data_dir}"
chown -R openldap:openldap /run/slapd "${data_dir}"
install -o openldap -g openldap -m 0640 "${tls_dir}/lp2-ldap.key" /run/slapd/lp2-ldap.key
install -o openldap -g openldap -m 0644 "${tls_dir}/lp2-ldap.crt" /run/slapd/lp2-ldap.crt
install -o openldap -g openldap -m 0644 "${tls_dir}/ca.crt" /run/slapd/ca.crt

root_password_hash="$(slappasswd -n -s "${root_password}")"
config_file="/run/slapd/slapd.conf"
cat > "${config_file}" <<EOF
include /etc/ldap/schema/core.schema
include /etc/ldap/schema/cosine.schema
include /etc/ldap/schema/inetorgperson.schema

pidfile /run/slapd/slapd.pid
argsfile /run/slapd/slapd.args
modulepath /usr/lib/ldap
moduleload back_mdb

TLSCACertificateFile /run/slapd/ca.crt
TLSCertificateFile /run/slapd/lp2-ldap.crt
TLSCertificateKeyFile /run/slapd/lp2-ldap.key

database mdb
maxsize 1073741824
suffix "${base_dn}"
rootdn "${root_dn}"
rootpw ${root_password_hash}
directory ${data_dir}
index objectClass eq
index uid,mail eq
EOF
chown openldap:openldap "${config_file}"
chmod 0640 "${config_file}"

slapd -f "${config_file}" -h 'ldaps:///' -u openldap -g openldap -d 0 &
slapd_pid=$!
cleanup() {
  kill "${slapd_pid}" 2>/dev/null || true
  wait "${slapd_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ready=false
for attempt in $(seq 1 40); do
  if LDAPTLS_CACERT="${tls_dir}/ca.crt" LDAPTLS_REQCERT=demand \
    ldapwhoami -H ldaps://127.0.0.1:636 -x -D "${root_dn}" -w "${root_password}" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "${ready}" != true ]]; then
  echo 'LP2 synthetic LDAP did not become ready.' >&2
  exit 1
fi

existing_user="$(LDAPTLS_CACERT="${tls_dir}/ca.crt" LDAPTLS_REQCERT=demand \
  ldapsearch -H ldaps://127.0.0.1:636 -x -D "${root_dn}" -w "${root_password}" \
    -b "${user_dn}" -s sub '(uid=alice)' uid mail 2>/dev/null || true)"
if ! grep -q '^uid: alice$' <<<"${existing_user}"; then
  LDAPTLS_CACERT="${tls_dir}/ca.crt" LDAPTLS_REQCERT=demand \
    ldapadd -H ldaps://127.0.0.1:636 -x -D "${root_dn}" -w "${root_password}" \
      -f "${config_dir}/bootstrap.ldif"
fi

LDAPTLS_CACERT="${tls_dir}/ca.crt" LDAPTLS_REQCERT=demand \
  ldapsearch -H ldaps://127.0.0.1:636 -x -D "${root_dn}" -w "${root_password}" \
    -b "${base_dn}" -s base '(objectClass=*)' dn >/dev/null

wait "${slapd_pid}"
