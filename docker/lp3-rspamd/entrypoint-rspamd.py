#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

"""Small deterministic HTTP contract stub for the LP3 offline proof.

It models only the health and checkv2-shaped responses consumed by the proof
client. It is not Rspamd and is intentionally not suitable for production.
"""

import json
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    server_version = "GuloGulo-LP3-Rspamd-Proof/1.0"

    def _send(self, status, payload):
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - stdlib handler API
        if self.path in ("/", "/health", "/ping"):
            self._send(200, {"status": "ok", "engine": "lp3-rspamd-protocol-stub", "production": False})
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802 - stdlib handler API
        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length)
        rejected = b"EICAR-STANDARD-ANTIVIRUS-TEST-FILE" in payload or b"X-LP3-Scan: reject" in payload
        self._send(
            200,
            {
                "action": "reject" if rejected else "no action",
                "score": 15.0 if rejected else 0.0,
                "symbols": ["LP3_SYNTHETIC_REJECT"] if rejected else [],
                "engine": "lp3-rspamd-protocol-stub",
                "production": False,
            },
        )

    def log_message(self, *_args):
        return


class IPv6ThreadingHTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


if __name__ == "__main__":
    IPv6ThreadingHTTPServer(("::", 11333), Handler).serve_forever()
