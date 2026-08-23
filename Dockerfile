# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

# Ubuntu 26.04 LTS (Resolute Raccoon) is the supported Gulo Gulo container
# target. The tag is verified against the Canonical Docker Official Image
# before adoption; the build performs a controlled security upgrade so the
# resulting layer contains the current Ubuntu security patches available at
# build time.
FROM ubuntu:26.04

ARG NODE_VERSION=26.7.0
ARG TARGETARCH
ARG INSTALL_DEV=false

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    APP_ENV=production \
    LOG_LEVEL=info

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install the current stable Node.js release from the official Node.js
# distribution, while keeping the operating-system patch lifecycle in the
# Ubuntu package manager. TARGETARCH keeps the image usable on the OCI
# architectures supported by the Node.js release.
RUN set -eux; \
    debian_arch="$(dpkg --print-architecture)"; \
    target_arch="${TARGETARCH:-${debian_arch}}"; \
    if [ "${target_arch}" != "${debian_arch}" ]; then \
      echo "TARGETARCH ${target_arch} does not match the Ubuntu target architecture ${debian_arch}" >&2; \
      exit 1; \
    fi; \
    case "${target_arch}" in \
      amd64) node_arch='x64' ;; \
      arm64) node_arch='arm64' ;; \
      arm) node_arch='armv7l' ;; \
      ppc64le) node_arch='ppc64le' ;; \
      s390x) node_arch='s390x' ;; \
      *) echo "Unsupported TARGETARCH: ${target_arch}" >&2; exit 1 ;; \
    esac; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates curl libatomic1 xz-utils; \
    curl --fail --silent --show-error --location \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      --output /tmp/node.tar.xz; \
    curl --fail --silent --show-error --location \
      "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
      --output /tmp/SHASUMS256.txt; \
    grep -F "  node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" /tmp/SHASUMS256.txt | \
      sed "s#  node-v${NODE_VERSION}-linux-${node_arch}.tar.xz#  /tmp/node.tar.xz#" | \
      sha256sum --check --status -; \
    tar --extract --file /tmp/node.tar.xz --directory /usr/local --strip-components=1; \
    rm -f /tmp/node.tar.xz /tmp/SHASUMS256.txt; \
    apt-get purge -y --auto-remove curl xz-utils; \
    rm -rf /var/lib/apt/lists/*

# The service runs without root. The patch helper is intentionally installed
# separately so an operator can invoke it in a short-lived maintenance
# container as root, with an explicit writable state volume, rather than
# mutating the running application container through a write-capable API.
RUN set -eux; \
    groupadd --system --gid 10001 gulogulo; \
    useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin gulogulo; \
    install -d -o gulogulo -g gulogulo /var/lib/gulogulo/patch

WORKDIR /app

# The application package is deliberately supplied by the application
# milestone. Keeping this image boundary independent of the source layout
# lets the Docker-first scaffold run the same npm start contract in every
# OCI-compatible environment.
COPY --chown=gulogulo:gulogulo . .

RUN set -eux; \
    install -m 0755 scripts/container-patch.sh /usr/local/sbin/gulogulo-container-patch; \
    install -d -o gulogulo -g gulogulo /var/lib/gulogulo/lp1; \
    if [ ! -f package.json ]; then \
      echo 'Gulo Gulo requires package.json with an npm start script.' >&2; \
      exit 1; \
    fi; \
    if [ -f package-lock.json ]; then \
      npm ci --include=dev --ignore-scripts --no-audit --no-fund; \
    else \
      npm install --include=dev --ignore-scripts --no-audit --no-fund; \
    fi; \
    typescript_platform_package=''; \
    case "${TARGETARCH:-${debian_arch}}" in \
      amd64) typescript_platform_package='@typescript/typescript-linux-x64' ;; \
      arm64) typescript_platform_package='@typescript/typescript-linux-arm64' ;; \
    esac; \
    if [ -n "${typescript_platform_package}" ] && ! node -e "require.resolve('${typescript_platform_package}/package.json')" >/dev/null 2>&1; then \
      typescript_version="$(node -p "require('./node_modules/typescript/package.json').version")"; \
      npm install --no-save --ignore-scripts --no-audit --no-fund "${typescript_platform_package}@${typescript_version}"; \
    fi; \
    if [ -f web/src/app.ts ]; then \
      npm run build:web; \
    fi; \
    if [ "${INSTALL_DEV}" != "true" ]; then \
      npm prune --omit=dev; \
    fi; \
    npm cache clean --force; \
    chown -R gulogulo:gulogulo /app

# The service is deliberately unprivileged in the final container.
USER gulogulo

EXPOSE 8080

# Readiness is intentionally used for the container health state. The
# application exposes both /health/live and /health/ready and distinguishes
# process liveness from dependency readiness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
