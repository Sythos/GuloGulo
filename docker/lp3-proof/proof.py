#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

"""Offline LP3 protocol proof: SMTP -> LMTP -> IMAP plus scanner contracts."""

import email.message
import imaplib
import json
import socket
import smtplib
import struct
import time
import urllib.request


PASSWORD = "lp3-synthetic-password"
USER = "alice@gulogulo.test"


def read_until(sock, marker=b"\n", timeout=4):
    sock.settimeout(timeout)
    data = bytearray()
    while marker not in data:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data.extend(chunk)
    return bytes(data)


def probe_line(host, port, command, expected):
    with socket.create_connection((host, port), timeout=5) as sock:
        greeting = read_until(sock)
        sock.sendall(command)
        response = read_until(sock)
        if expected not in greeting + response:
            raise RuntimeError(f"{host}:{port} did not expose {expected!r}")


def smtp_to_lmtp():
    message = email.message.EmailMessage()
    message["From"] = "sender@gulogulo.test"
    message["To"] = USER
    message["Subject"] = "LP3 synthetic delivery proof"
    message.set_content("LP3 SMTP to Dovecot LMTP delivery contract.\n")
    with smtplib.SMTP("lp3-postfix", 25, timeout=8) as smtp:
        smtp.ehlo("lp3-proof")
        code, _ = smtp.mail(message["From"])
        if code != 250:
            raise RuntimeError(f"SMTP MAIL failed: {code}")
        code, _ = smtp.rcpt(message["To"])
        if code != 250:
            raise RuntimeError(f"SMTP RCPT failed: {code}")
        code, _ = smtp.data(message.as_bytes())
        if code != 250:
            raise RuntimeError(f"SMTP DATA failed: {code}")


def imap_delivery_and_idle():
    deadline = time.time() + 25
    last_error = None
    while time.time() < deadline:
        try:
            with imaplib.IMAP4("lp3-dovecot", 143) as client:
                capability = client.capability()[1][0].decode().upper()
                if "IDLE" not in capability:
                    raise RuntimeError("Dovecot IMAP capability does not include IDLE")
                client.login(USER, PASSWORD)
                status, mailbox_data = client.select("INBOX")
                if status != "OK":
                    raise RuntimeError(f"Dovecot IMAP INBOX select failed: {mailbox_data!r}")
                status, data = client.search(None, "SUBJECT", '"LP3 synthetic delivery proof"')
                if status == "OK" and data and data[0]:
                    client.logout()
                    return
                client.logout()
                last_error = f"no matching message (capability={capability!r}, search={data!r})"
        except (imaplib.IMAP4.error, OSError, RuntimeError) as error:
            last_error = repr(error)
        time.sleep(1)
    raise RuntimeError(
        "SMTP message did not become visible through Dovecot IMAP"
        f"; last IMAP probe: {last_error or 'no response'}"
    )


def scanners():
    with urllib.request.urlopen("http://lp3-rspamd:11333/health", timeout=5) as response:
        health = json.load(response)
    if health.get("status") != "ok" or health.get("production") is not False:
        raise RuntimeError("LP3 Rspamd proof endpoint is not healthy")
    request = urllib.request.Request(
        "http://lp3-rspamd:11333/checkv2",
        data=b"Subject: LP3 scanner proof\n\nclean fixture\n",
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        scan = json.load(response)
    if scan.get("action") != "no action":
        raise RuntimeError("LP3 Rspamd clean scan was not accepted")

    with socket.create_connection(("lp3-clamav", 3310), timeout=5) as sock:
        sock.sendall(b"PING\0")
        if b"PONG" not in sock.recv(64):
            raise RuntimeError("LP3 ClamAV PING contract failed")
    with socket.create_connection(("lp3-clamav", 3310), timeout=5) as sock:
        sock.sendall(b"zINSTREAM\0")
        body = b"Subject: LP3 scanner proof\n\nclean fixture\n"
        sock.sendall(struct.pack(">I", len(body)) + body + struct.pack(">I", 0))
        if b"stream: OK" not in sock.recv(128):
            raise RuntimeError("LP3 ClamAV INSTREAM contract failed")


def main():
    smtp_to_lmtp()
    imap_delivery_and_idle()
    probe_line("lp3-dovecot", 24, b"LHLO lp3-proof\r\n", b"250")
    probe_line("lp3-dovecot", 4190, b"CAPABILITY\r\n", b"IMPLEMENTATION")
    scanners()
    print("LP3 synthetic mail topology proof passed: SMTP, IMAP IDLE, LMTP, Sieve, Rspamd, ClamAV")


if __name__ == "__main__":
    main()
