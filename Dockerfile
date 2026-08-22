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
ARG TARGETARCH=amd64

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
    case "${TARGETARCH}" in \
      amd64) node_arch='x64' ;; \
      arm64) node_arch='arm64' ;; \
      arm) node_arch='armv7l' ;; \
      ppc64le) node_arch='ppc64le' ;; \
      s390x) node_arch='s390x' ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
    curl --fail --silent --show-error --location \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      --output /tmp/node.tar.xz; \
    curl --fail --silent --show-error --location \
      "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
      --output /tmp/SHASUMS256.txt; \
    grep -F "  node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" /tmp/SHASUMS256.txt | sha256sum --check --status -; \
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
    if [ ! -f package.json ]; then \
      echo 'Gulo Gulo requires package.json with an npm start script.' >&2; \
      exit 1; \
    fi; \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev --ignore-scripts; \
    else \
      npm install --omit=dev --ignore-scripts; \
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
