#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

"""Small deterministic HTTP contract stub for the LP3 offline proof.

It models only the health and checkv2-shaped responses consumed by the proof
client. It is not Rspamd and is intentionally not suitable for production.
"""

import json
import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path
import re
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

    def _signature_status(self):
        return read_signature_status("rspamd")

    def _service_payload(self, payload):
        signature = self._signature_status()
        result = dict(payload)
        result["signatureStatus"] = signature["status"]
        if signature["status"] == "ready":
            result["signatureGeneration"] = signature["generation"]
            result["signatureDigest"] = signature["contentDigest"]
            result["signatureFileCount"] = signature["fileCount"]
        return result

    def do_GET(self):  # noqa: N802 - stdlib handler API
        if self.path in ("/", "/health", "/ping"):
            signature = self._signature_status()
            status = 200 if signature["status"] == "ready" else 503
            self._send(status, self._service_payload({"status": "ok" if status == 200 else "unavailable", "engine": "lp3-rspamd-protocol-stub", "production": False}))
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802 - stdlib handler API
        signature = self._signature_status()
        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length)
        if signature["status"] != "ready":
            self._send(503, self._service_payload({"error": "signature_database_unavailable", "production": False}))
            return
        rejected = b"EICAR-STANDARD-ANTIVIRUS-TEST-FILE" in payload or b"X-LP3-Scan: reject" in payload
        self._send(
            200,
            self._service_payload({
                "action": "reject" if rejected else "no action",
                "score": 15.0 if rejected else 0.0,
                "symbols": ["LP3_SYNTHETIC_REJECT"] if rejected else [],
                "engine": "lp3-rspamd-protocol-stub",
                "production": False,
            }),
        )

    def log_message(self, *_args):
        return


class IPv6ThreadingHTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


SAFE_GENERATION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
SAFE_SOURCE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
SAFE_PATH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$")
SIGNATURE_ROOT = Path(os.environ.get("GULOGULO_SCANNER_SIGNATURE_ROOT", "/var/lib/gulogulo/scanner-signatures"))
MAX_SIGNATURE_AGE = max(1, int(os.environ.get("GULOGULO_SCANNER_SIGNATURE_MAX_AGE_SECONDS", "604800")))


def _invalid_signature(reason):
    return {"status": reason, "reason": reason}


def read_signature_status(scanner):
    """Read and verify one externally published, read-only signature generation."""
    try:
        pointer_path = SIGNATURE_ROOT / scanner / "active.json"
        pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
        generation = pointer.get("generation")
        if pointer.get("schemaVersion") != 1 or pointer.get("scanner") != scanner or not isinstance(generation, str) or not SAFE_GENERATION.fullmatch(generation):
            return _invalid_signature("invalid")
        directory = f"versions/{generation}"
        if pointer.get("directory") != directory:
            return _invalid_signature("invalid")
        generation_root = SIGNATURE_ROOT / scanner / directory
        manifest = json.loads((generation_root / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("schemaVersion") != 1 or manifest.get("scanner") != scanner or manifest.get("generation") != generation or manifest.get("status") != "ready":
            return _invalid_signature("invalid")
        published = manifest.get("publishedAt")
        source = manifest.get("source")
        content_digest = manifest.get("contentDigest")
        files = manifest.get("files")
        if not isinstance(published, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z", published):
            return _invalid_signature("invalid")
        if not isinstance(source, str) or not SAFE_SOURCE.fullmatch(source) or not isinstance(content_digest, str) or not content_digest.startswith("sha256:") or not SHA256.fullmatch(content_digest[7:]) or not isinstance(files, list) or not files:
            return _invalid_signature("invalid")
        descriptors = []
        seen = set()
        for entry in files:
            path = entry.get("path") if isinstance(entry, dict) else None
            digest = entry.get("sha256") if isinstance(entry, dict) else None
            size = entry.get("size") if isinstance(entry, dict) else None
            if not isinstance(path, str) or not SAFE_PATH.fullmatch(path) or "\\" in path or path.startswith("/") or ".." in path.split("/") or path in seen or not isinstance(digest, str) or not SHA256.fullmatch(digest) or not isinstance(size, int) or size < 0:
                return _invalid_signature("invalid")
            seen.add(path)
            file_path = (generation_root / path).resolve()
            if generation_root.resolve() not in file_path.parents:
                return _invalid_signature("invalid")
            try:
                data = file_path.read_bytes()
            except (OSError, ValueError):
                return _invalid_signature("invalid")
            if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
                return _invalid_signature("invalid")
            descriptors.append((path, digest))
        descriptor = "".join(f"{path}\0{digest}\n" for path, digest in sorted(descriptors))
        if "sha256:" + hashlib.sha256(descriptor.encode("utf-8")).hexdigest() != content_digest:
            return _invalid_signature("invalid")
        try:
            published_at = datetime.fromisoformat(published.replace("Z", "+00:00"))
        except ValueError:
            return _invalid_signature("invalid")
        age = (datetime.now(timezone.utc) - published_at).total_seconds()
        if age < 0 or age > MAX_SIGNATURE_AGE:
            return {"status": "stale", "reason": "stale", "generation": generation, "contentDigest": content_digest, "fileCount": len(files)}
        return {"status": "ready", "generation": generation, "contentDigest": content_digest, "fileCount": len(files)}
    except FileNotFoundError:
        return _invalid_signature("missing")
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return _invalid_signature("invalid")


if __name__ == "__main__":
    IPv6ThreadingHTTPServer(("::", 11333), Handler).serve_forever()
