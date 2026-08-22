# Gulo Gulo M1 fixtures

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This directory contains deterministic, non-secret fixtures for the M1
configuration and test harness. The fixture set uses reserved `.invalid`
domains and loopback-only failure endpoints. It must never contain passwords,
tokens, cookies, private keys, production addresses, or message content.

`manifest.json` is the entry point. `tenant.json` models one isolated tenant
with two users and one alias. `failure-modes.json` describes dependency outage
cases that must remain fail-closed when the real adapters are introduced.

The fixture smoke harness validates all three files before starting the
container and tears its Compose project and named volumes down idempotently.
