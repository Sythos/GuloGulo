# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

# The proof client is disposable and contains no application secrets. It
# exercises only the internal LP3 protocol contracts.
FROM ubuntu:26.04

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates python3; \
    rm -rf /var/lib/apt/lists/*

COPY proof.py /usr/local/bin/gulogulo-lp3-proof

RUN chmod 0755 /usr/local/bin/gulogulo-lp3-proof

CMD ["/usr/bin/python3", "/usr/local/bin/gulogulo-lp3-proof"]
