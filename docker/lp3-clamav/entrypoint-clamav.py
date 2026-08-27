#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

"""Minimal deterministic clamd protocol fixture for LP3 offline tests."""

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import re
import socketserver
import socket
import struct


EICAR = b"EICAR-STANDARD-ANTIVIRUS-TEST-FILE"
SAFE_GENERATION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
SAFE_SOURCE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
SAFE_PATH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$")
SIGNATURE_ROOT = Path(os.environ.get("GULOGULO_SCANNER_SIGNATURE_ROOT", "/var/lib/gulogulo/scanner-signatures"))
MAX_SIGNATURE_AGE = max(1, int(os.environ.get("GULOGULO_SCANNER_SIGNATURE_MAX_AGE_SECONDS", "604800")))


def read_signature_status():
    """Read and verify one externally published, read-only signature generation."""
    scanner = "clamav"
    try:
        pointer = json.loads((SIGNATURE_ROOT / scanner / "active.json").read_text(encoding="utf-8"))
        generation = pointer.get("generation")
        if pointer.get("schemaVersion") != 1 or pointer.get("scanner") != scanner or not isinstance(generation, str) or not SAFE_GENERATION.fullmatch(generation):
            return {"status": "invalid", "reason": "invalid"}
        directory = f"versions/{generation}"
        if pointer.get("directory") != directory:
            return {"status": "invalid", "reason": "invalid"}
        generation_root = SIGNATURE_ROOT / scanner / directory
        manifest = json.loads((generation_root / "manifest.json").read_text(encoding="utf-8"))
        published = manifest.get("publishedAt")
        source = manifest.get("source")
        content_digest = manifest.get("contentDigest")
        files = manifest.get("files")
        if manifest.get("schemaVersion") != 1 or manifest.get("scanner") != scanner or manifest.get("generation") != generation or manifest.get("status") != "ready" or not isinstance(published, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z", published) or not isinstance(source, str) or not SAFE_SOURCE.fullmatch(source) or not isinstance(content_digest, str) or not content_digest.startswith("sha256:") or not SHA256.fullmatch(content_digest[7:]) or not isinstance(files, list) or not files:
            return {"status": "invalid", "reason": "invalid"}
        descriptors = []
        seen = set()
        for entry in files:
            path = entry.get("path") if isinstance(entry, dict) else None
            digest = entry.get("sha256") if isinstance(entry, dict) else None
            size = entry.get("size") if isinstance(entry, dict) else None
            if not isinstance(path, str) or not SAFE_PATH.fullmatch(path) or "\\" in path or path.startswith("/") or ".." in path.split("/") or path in seen or not isinstance(digest, str) or not SHA256.fullmatch(digest) or not isinstance(size, int) or size < 0:
                return {"status": "invalid", "reason": "invalid"}
            seen.add(path)
            file_path = (generation_root / path).resolve()
            if generation_root.resolve() not in file_path.parents:
                return {"status": "invalid", "reason": "invalid"}
            data = file_path.read_bytes()
            if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
                return {"status": "invalid", "reason": "invalid"}
            descriptors.append((path, digest))
        descriptor = "".join(f"{path}\0{digest}\n" for path, digest in sorted(descriptors))
        if "sha256:" + hashlib.sha256(descriptor.encode("utf-8")).hexdigest() != content_digest:
            return {"status": "invalid", "reason": "invalid"}
        published_at = datetime.fromisoformat(published.replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - published_at).total_seconds()
        if age < 0 or age > MAX_SIGNATURE_AGE:
            return {"status": "stale", "reason": "stale", "generation": generation, "contentDigest": content_digest, "fileCount": len(files)}
        return {"status": "ready", "generation": generation, "contentDigest": content_digest, "fileCount": len(files)}
    except FileNotFoundError:
        return {"status": "missing", "reason": "missing"}
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {"status": "invalid", "reason": "invalid"}


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        signature = read_signature_status()
        command = self._read_command()
        if command.startswith((b"PING", b"zPING")):
            self.request.sendall(b"PONG\0")
            return
        if command.startswith(b"VERSIONCOMMAND"):
            if signature["status"] == "ready":
                version = f"GuloGulo-LP3-ClamAV-Protocol-Stub:0.1 signature=ready generation={signature['generation']} digest={signature['contentDigest']}"
            else:
                version = f"GuloGulo-LP3-ClamAV-Protocol-Stub:0.1 signature={signature['status']}"
            self.request.sendall((version + "\0").encode("utf-8"))
            return
        if command.startswith(b"zINSTREAM") or command.startswith(b"INSTREAM"):
            if signature["status"] != "ready":
                self.request.sendall(b"stream: Signature database unavailable\0")
                return
            chunks = bytearray()
            while True:
                header = self._read_exact(4)
                if not header:
                    return
                size = struct.unpack(">I", header)[0]
                if size == 0:
                    break
                chunks.extend(self._read_exact(size))
                if len(chunks) > 64 * 1024 * 1024:
                    self.request.sendall(b"INSTREAM size limit exceeded.\0")
                    return
            if EICAR in chunks:
                self.request.sendall(b"stream: Win.Test.EICAR_HDB-1 FOUND\0")
            else:
                self.request.sendall(b"stream: OK\0")

    def _read_command(self):
        command = bytearray()
        while True:
            byte = self.request.recv(1)
            if not byte:
                return bytes(command)
            command.extend(byte)
            if byte == b"\0":
                return bytes(command)

    def _read_exact(self, size):
        result = bytearray()
        while len(result) < size:
            chunk = self.request.recv(size - len(result))
            if not chunk:
                return bytes(result)
            result.extend(chunk)
        return bytes(result)


class Server(socketserver.ThreadingTCPServer):
    address_family = socket.AF_INET6
    allow_reuse_address = True
    daemon_threads = True

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


if __name__ == "__main__":
    with Server(("::", 3310), Handler) as server:
        server.serve_forever()
