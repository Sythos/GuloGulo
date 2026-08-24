# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

# This image is a deterministic HTTP-compatible Rspamd proof endpoint. It is
# deliberately not the Rspamd vendor daemon and must not be presented as such.
FROM ubuntu:26.04

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates python3; \
    rm -rf /var/lib/apt/lists/*; \
    install -d /opt/gulogulo-lp3-rspamd

COPY entrypoint-rspamd.py /opt/gulogulo-lp3-rspamd/entrypoint.py
COPY healthcheck-rspamd.sh /usr/local/sbin/gulogulo-lp3-rspamd-health

RUN chmod 0755 /opt/gulogulo-lp3-rspamd/entrypoint.py /usr/local/sbin/gulogulo-lp3-rspamd-health

EXPOSE 11333

HEALTHCHECK --interval=3s --timeout=3s --start-period=3s --retries=15 \
    CMD ["/usr/local/sbin/gulogulo-lp3-rspamd-health"]

CMD ["/usr/bin/python3", "/opt/gulogulo-lp3-rspamd/entrypoint.py"]
