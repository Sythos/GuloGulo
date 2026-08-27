# LP3 scanner-signature fixture

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This directory is a deterministic, offline-only fixture for the LP3 proof. It
is not a Rspamd map distribution or a ClamAV database. The smoke harness copies
it into the disposable external-signature volume; production operators must
replace it with provider-verified definitions using the documented atomic
`active.json` pointer workflow.
