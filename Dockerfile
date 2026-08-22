# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

# The versioned tag keeps the first scaffold reproducible while the image
# digest can be pinned by the release pipeline once the base-image policy is
# established.
FROM node:22.17.1-alpine3.22

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    APP_ENV=production \
    LOG_LEVEL=info

WORKDIR /app

# The application package is deliberately supplied by the application
# milestone. Keeping this image boundary independent of the source layout
# lets the Docker-first scaffold run the same npm start contract in every
# OCI-compatible environment.
COPY --chown=node:node . .

RUN if [ ! -f package.json ]; then \
      echo 'Gulo Gulo requires package.json with an npm start script.' >&2; \
      exit 1; \
    fi \
    && if [ -f package-lock.json ]; then \
         npm ci --omit=dev --ignore-scripts; \
       else \
         npm install --omit=dev --ignore-scripts; \
       fi \
    && npm cache clean --force

# The node account is provided by the official Node image and has no root
# privileges in the final container.
USER node

EXPOSE 8080

# Readiness is intentionally used for the container health state. The
# application must expose both /health/live and /health/ready and distinguish
# process liveness from dependency readiness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
