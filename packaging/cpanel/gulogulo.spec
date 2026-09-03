# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# RPM spec for the ADR-002 "cpanel" distribution target: a real .rpm for a
# cPanel/WHM server. cPanel & WHM only runs on RHEL-family Linux
# (AlmaLinux/CloudLinux/RHEL), so this package is built and verified inside
# an AlmaLinux 9 container (see .github/workflows/package-cpanel.yml)
# instead of the Ubuntu runner the repository otherwise defaults to -
# rpmbuild itself, and a realistic target environment, are both
# RHEL-family-only. This target previously shipped as a generic
# gulogulo-<version>-cpanel.tar.gz plus install.sh/upgrade.sh/uninstall.sh;
# those three scripts are retired in favor of this spec's
# %pre/%post/%preun/%postun scriptlets, which do the same jobs through the
# mechanism every RHEL-family operator already knows: `dnf install
# ./gulogulo-<version>.rpm` / `rpm -Uvh` / `dnf remove gulogulo`.
#
# Unlike the tar.gz target (installed to an operator-chosen extraction
# directory), an RPM install location is fixed by packaging convention:
# the application lands at /opt/gulogulo, the systemd unit at
# %{_unitdir}/gulogulo.service, and writable runtime state at
# /var/lib/gulogulo, all owned by a dedicated "gulogulo" system user
# created in %pre.
#
# Built via `rpmbuild -bb` from packaging/cpanel/build-cpanel-package.ts
# (packaging/shared/stage-application.ts's createRpmPackage()), which
# stages application files with the same stageCommonApplicationFiles() the
# standalone and plesk targets use, packs them into a source tarball, and
# passes --define "gulogulo_version <value>" read from package.json so this
# spec never hardcodes a version. See INSTALL.md section 3 for the full
# operator-facing walkthrough and current CI verification status.

%global app_home /opt/%{name}

Name:           gulogulo
Version:        %{gulogulo_version}
Release:        1%{?dist}
Summary:        Gulo Gulo groupware runtime (mail, calendar, contacts) - cPanel/WHM target
License:        MIT
URL:            https://github.com/Sythos/GuloGulo
Source0:        %{name}-%{version}-cpanel-src.tar.gz

# noarch, not merely because the application's own npm dependencies are
# pure JavaScript (they are - ldapts and pg carry no native/compiled
# bindings, and password hashing uses node:crypto's built-in scrypt, not a
# native library like argon2; see src/core/auth/password-hashing.ts and
# INSTALL.md's dependency audit), but because node_modules/ is not part of
# this RPM's payload at all: %post below runs `npm ci --omit=dev` at
# install time, same as the tar.gz installer did. The payload this package
# actually ships (compiled JS, HTML/CSS/JS web assets, SQL migrations,
# scriptlets) is architecture-independent by construction. If a native
# dependency is ever added, that only changes what %post's `npm ci`
# compiles at install time on whatever architecture the host actually is -
# this package itself would still stay noarch.
BuildArch:      noarch

# systemd-rpm-macros provides %{_unitdir} and %systemd_requires used below.
# Plain `rpmbuild -bb` (unlike mock/dnf builddep) does not auto-install
# BuildRequires - the CI container installs it explicitly before building.
BuildRequires:  (systemd-rpm-macros or systemd)
%{?systemd_requires}

# %pre uses useradd/groupadd/getent to create the dedicated system account.
Requires(pre): shadow-utils

# Node.js >= 26 is intentionally NOT declared as a `Requires:` here.
# Research done for this packaging conversion (see INSTALL.md and the
# in-repo task notes) found that RHEL9/AlmaLinux9's own AppStream repos do
# not ship a Node.js >= 26 package. NodeSource does publish a third-party
# RPM repository that provides one for EL9 (setup_26.x, see
# https://github.com/nodesource/distributions), but that repository is not
# enabled by default on a stock AlmaLinux 9 host, is not part of RHEL's own
# supported package set, and its long-term availability/currency for any
# specific Node 26.x point release cannot be verified with certainty from
# here. Declaring `Requires: nodejs >= 26` would make `dnf install
# ./gulogulo-*.rpm` fail outright on any host that has not already enabled
# a Node 26-capable repository - worse than a clear, actionable runtime
# check. %post below checks for a working `node` >= 26 in PATH and fails
# with instructions if it is missing; the operator is responsible for
# installing Node.js >= 26 first (NodeSource's repo, a `dnf module` stream
# if one becomes available, or their own source).

%description
Gulo Gulo is a self-hosted, tenant-isolated groupware runtime (mail,
calendar, contacts) built on a single TypeScript application core. This
package installs the cPanel/WHM distribution target: identity via cPanel's
UAPI, data via PostgreSQL (optional, disabled by default), started as a
dedicated systemd service - cPanel's Passenger-based Application Manager is
not a fit for a standalone-port `app.listen()` Node process, which is why
this package installs and manages a real systemd unit instead. The Apache
reverse proxy (EasyApache 4) and the optional WHM AppConfig registration
are never applied automatically; see the example files under
%{_docdir}/%{name}/ and INSTALL.md in the source repository for how to
apply them by hand.

%prep
%setup -q -n %{name}-%{version}-cpanel-src

%build
# Nothing to compile here: the web/server TypeScript bundles are already
# built by build-cpanel-package.ts (npm run build:web / npm run
# build:server) before this spec ever runs - this source tarball ships
# pre-built output only, the same as the standalone/plesk targets.

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}%{app_home}
cp -a app/. %{buildroot}%{app_home}/
chmod 0755 %{buildroot}%{app_home}/run-migrations.mjs

install -Dm0644 systemd/gulogulo-rpm.service %{buildroot}%{_unitdir}/gulogulo.service
install -Dm0644 doc/gulogulo-proxy.conf.example %{buildroot}%{_docdir}/%{name}/gulogulo-proxy.conf.example
install -Dm0644 doc/gulogulo-appconfig.conf.example %{buildroot}%{_docdir}/%{name}/gulogulo-appconfig.conf.example

mkdir -p %{buildroot}/var/lib/gulogulo

%pre
getent group gulogulo >/dev/null || groupadd --system gulogulo
getent passwd gulogulo >/dev/null || useradd --system --no-create-home \
  --shell /sbin/nologin --gid gulogulo \
  --comment "Gulo Gulo groupware service account" gulogulo
exit 0

%post
# Deliberately kept fail-fast (set -e), matching the retired install.sh's
# behavior: if `npm ci` or the migration step fails, %post stops before
# `daemon-reload`/`enable`, leaving the application files installed but the
# service NOT wired up - a loud, visible failure (rpm/dnf reports the
# scriptlet error) rather than a silently half-configured service.
set -e

if ! command -v node >/dev/null 2>&1; then
  echo "[gulogulo] ERROR: Node.js was not found in PATH." >&2
  echo "[gulogulo] Install Node.js >= 26 first, e.g. via the NodeSource RPM repo:" >&2
  echo "[gulogulo]   curl -fsSL https://rpm.nodesource.com/setup_26.x | bash -" >&2
  echo "[gulogulo]   dnf install -y nodejs" >&2
  echo "[gulogulo] then re-run: dnf install ./<this-package>.rpm (or rpm -Uvh <this-package>.rpm)." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 26 ]; then
  echo "[gulogulo] ERROR: Node.js >= 26 is required (found $(node -v))." >&2
  exit 1
fi

cd %{app_home}

if [ ! -f .env ]; then
  cp .env.example .env
  # Unlike the retired tar.gz target, .env now lands at a fixed, predictable
  # path (%{app_home}/.env) on a host that is definitionally full of other,
  # untrusted shell users (cPanel accounts). Lock it down to the service
  # user/group only - it holds CPANEL_API_* tokens and eventually Postgres
  # credentials, and the default `cp` mode would otherwise leave it
  # world-readable.
  chown root:gulogulo .env
  chmod 0640 .env
  echo "[gulogulo] .env created from .env.example at %{app_home}/.env (mode 0640, root:gulogulo) - review and edit it before starting the service."
  echo "[gulogulo] In particular set CPANEL_API_* for the UAPI identity adapter and POSTGRES_* for an existing PostgreSQL database."
else
  echo "[gulogulo] .env already exists at %{app_home}/.env; leaving it untouched."
fi

echo "[gulogulo] Installing production dependencies (npm ci --omit=dev)..."
npm ci --omit=dev --no-audit --no-fund

echo "[gulogulo] Applying database migrations (skipped cleanly while POSTGRES_ENABLED=false)..."
node --env-file=.env run-migrations.mjs

systemctl daemon-reload

if [ "$1" -eq 1 ]; then
  # $1 == 1: first install of this package (not an upgrade, which passes
  # the count of remaining installed versions, >= 2). Enable but do not
  # start: the operator must review .env first.
  systemctl enable gulogulo
  echo "[gulogulo] systemd service installed and enabled (not started). Review %{app_home}/.env, then run:"
  echo "[gulogulo]   systemctl start gulogulo"
else
  # $1 >= 2: upgrading an existing install. gulogulo is a dedicated
  # systemd unit this package itself installs and manages, not a process
  # the operator runs under their own supervisor, so restart automatically
  # to pick up the new code - matching the retired tar.gz target's
  # upgrade.sh, which always restarted unconditionally too. Do not
  # re-enable here: an operator who deliberately disabled the unit between
  # versions should stay disabled across an upgrade.
  echo "[gulogulo] Upgrade detected - restarting the gulogulo systemd service..."
  systemctl restart gulogulo
  echo "[gulogulo] Service restarted."
fi

echo "[gulogulo] Apache reverse proxy (never applied automatically): %{_docdir}/%{name}/gulogulo-proxy.conf.example"
echo "[gulogulo]   apply it via WHM > Service Configuration > Apache Configuration > Include Editor, or a userdata"
echo "[gulogulo]   hook, then /scripts/rebuildhttpdconf && systemctl restart httpd."
echo "[gulogulo] Optional WHM AppConfig registration (never applied automatically): %{_docdir}/%{name}/gulogulo-appconfig.conf.example"

%preun
if [ "$1" -eq 0 ]; then
  # $1 == 0: this is a real removal, not an upgrade (which passes the
  # count of remaining package versions, >= 1). Never disable/stop the
  # service just because an upgrade is about to replace it with a new
  # version - %post's restart-on-upgrade branch handles that case.
  systemctl disable --now gulogulo >/dev/null 2>&1 || true
fi
exit 0

%postun
if [ "$1" -eq 0 ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
  # node_modules/ is produced by `npm ci` in %post and is not tracked by
  # rpm (it is not listed in %files below), so it survives a plain
  # `rpm -e`/`dnf remove` unless removed here explicitly.
  rm -rf %{app_home}/node_modules
  echo "[gulogulo] Package removed. %{app_home}/.env, /var/lib/gulogulo, and any external"
  echo "[gulogulo] PostgreSQL database were left in place - remove them yourself if you want them gone."
  echo "[gulogulo] Reminders (never done automatically by this package):"
  echo "[gulogulo]   - remove the Apache reverse proxy snippet you added from gulogulo-proxy.conf.example."
  echo "[gulogulo]   - if you registered the optional WHM AppConfig entry, unregister it:"
  echo "[gulogulo]       /usr/local/cpanel/bin/unregister_appconfig gulogulo"
fi
exit 0

%files
%{app_home}
%{_unitdir}/gulogulo.service
%dir %{_docdir}/%{name}
%doc %{_docdir}/%{name}/gulogulo-proxy.conf.example
%doc %{_docdir}/%{name}/gulogulo-appconfig.conf.example
%attr(0750,gulogulo,gulogulo) %dir /var/lib/gulogulo
