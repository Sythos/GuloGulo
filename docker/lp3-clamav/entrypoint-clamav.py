#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

"""Minimal deterministic clamd protocol fixture for LP3 offline tests."""

import socketserver
import socket
import struct


EICAR = b"EICAR-STANDARD-ANTIVIRUS-TEST-FILE"


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        command = self._read_command()
        if command.startswith((b"PING", b"zPING")):
            self.request.sendall(b"PONG\0")
            return
        if command.startswith(b"VERSIONCOMMAND"):
            self.request.sendall(b"GuloGulo-LP3-ClamAV-Protocol-Stub:0.1\0")
            return
        if command.startswith(b"zINSTREAM") or command.startswith(b"INSTREAM"):
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
