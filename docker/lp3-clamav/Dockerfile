# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

# This image is a deterministic clamd-compatible protocol proof stub. It is
# deliberately not ClamAV and must not be presented as a malware scanner.
FROM ubuntu:26.04

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates python3; \
    rm -rf /var/lib/apt/lists/*; \
    install -d /opt/gulogulo-lp3-clamav

COPY entrypoint-clamav.py /opt/gulogulo-lp3-clamav/entrypoint.py
COPY healthcheck-clamav.sh /usr/local/sbin/gulogulo-lp3-clamav-health

RUN chmod 0755 /opt/gulogulo-lp3-clamav/entrypoint.py /usr/local/sbin/gulogulo-lp3-clamav-health

EXPOSE 3310

HEALTHCHECK --interval=3s --timeout=3s --start-period=3s --retries=15 \
    CMD ["/usr/local/sbin/gulogulo-lp3-clamav-health"]

CMD ["/usr/bin/python3", "/opt/gulogulo-lp3-clamav/entrypoint.py"]
