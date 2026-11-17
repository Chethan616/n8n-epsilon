# Test results

Two suites, both in [`../tests/`](../tests/) (see its README for how to run them).

| Suite | What it proves | Result |
|---|---|---|
| **Unit** (`npm run test:unit`) | the decision logic of every Code node, run from the same `workflows/src/*.js` files the workflow JSON is built from | **55 / 55 pass** |
| **End-to-end** (`npm run test:e2e`) | the *shipped workflows* in a **real n8n 2.45.7** (isolated profile, its own Data Table database), driven through webhooks, against a mock ServiceNow and an SMTP sink, with failures injected | **25 / 25 scenarios pass** (last run: 2026-11-17) |

## What is real and what is simulated

| Real | Simulated |
|---|---|
| n8n 2.45.7, its Data Table storage, the shipped nodes, HTTP requests, SMTP delivery, process kill (`taskkill`) | **ServiceNow** (`tests/lib/mock-servicenow.js`: Table API with Basic auth and `sysparm_limit/offset`, fault injection, a request barrier to force races) and **Gmail** (`tests/lib/smtp-sink.js`: an SMTP server that records what is really delivered) |

Differences between a test copy and the shipped workflow — nothing else is touched:
the Schedule Trigger is replaced by a Webhook (start a run on demand), the `Config` node is replaced by
a Code node returning the same defaults (optionally overridden per run), credentials point at the
mocks, and one extra copy of the monitor has the **run lease removed** (`Take Lock` → pass-through) so
the per-key claim can be tested on its own.

**Not covered:** the live ServiceNow PDI (its Basic-Auth restriction / hibernation behaviour) and real
Gmail delivery (rate limits, app-password rejection). Those need the real credentials and are tracked in
`plan.md`.

## End-to-end scenarios

| # | Scenario | Result | Time |
|---|---|---|---|
| 1 | setup workflow creates the table + run lock, and is safe to re-run | PASS | 0.9s |
| 2 | baseline: critical / high / stale alert exactly once; normal + resolved incidents are ignored | PASS | 2.0s |
| 3 | alert state survives an n8n restart (no duplicate after restart) | PASS | 18.8s |
| 4 | idle cycle: no incidents -> success, no email, only the lock row exists | PASS | 0.8s |
| 5 | pagination: incidents beyond the old 200-record limit are alerted (450 incidents, 3 pages) | PASS | 0.8s |
| 6 | pagination: an exact multiple of the page size (400) ends on an empty page, nothing lost | PASS | 0.8s |
| 7 | pagination: page size is configurable (50 -> 10 requests for 450 incidents) | PASS | 0.8s |
| 8 | pagination: hitting the page cap REFUSES to act on a partial list (no alerts, no state change) | PASS | 0.8s |
| 9 | reminder fires after the interval, exactly once per interval | PASS | 2.4s |
| 10 | acknowledgement: GET only shows a form; POST acknowledges, stops reminders, writes a ServiceNow work note | PASS | 2.0s |
| 11 | escalation: unacknowledged critical escalates L1 (30 min) then L2 (60 min), then only reminders | PASS | 3.1s |
| 12 | auto-acknowledge: In Progress + assigned stops reminders (new alert, and an existing one) | PASS | 2.4s |
| 13 | resolve + reopen: closing stops reminders; a reopened incident starts a fresh cycle with a new ack token | PASS | 3.1s |
| 14 | concurrency / lease: two simultaneous runs -> exactly one proceeds; a third inside the lease is skipped | PASS | 2.4s |
| 15 | concurrency / claim CAS alone (lease REMOVED): 3 simultaneous runs, 5 due reminders -> 5 emails, not 15 | PASS | 2.1s |
| 16 | concurrency / brand-new keys (lease REMOVED): 3 simultaneous runs INSERT the same keys -> still 5 emails | PASS | 2.0s |
| 17 | failure / ServiceNow: one transient 500 is retried and the run still succeeds | PASS | 3.7s |
| 18 | failure / ServiceNow: persistent outage -> run errors, admin is emailed, NO partial state change | PASS | 8.2s |
| 19 | failure / ServiceNow: bad credentials (401) -> run errors, nothing sent, nothing closed | PASS | 7.4s |
| 20 | failure / ServiceNow: HTTP 200 HTML (hibernating instance) -> clear error, existing alerts NOT closed | PASS | 1.6s |
| 21 | failure / pagination: a failure on page 2 is retried as a whole; a persistent one produces no partial alerts | PASS | 10.7s |
| 22 | failure / SMTP rejects -> row marked failed with the error; next run retries and sends exactly once | PASS | 1.6s |
| 23 | failure / one bad email among several: successes are recorded, only the failure is retried | PASS | 1.6s |
| 24 | crash: n8n killed WHILE the email is in flight -> claim recovered, alert delivered (never lost) | PASS | 19.6s |
| 25 | crash: n8n killed AFTER the email was delivered but before it was recorded -> one duplicate (documented at-least-once) | PASS | 20.6s |

Timing is machine-dependent; the n8n-restart and crash scenarios dominate because they restart n8n.

## Review item → evidence

| Feedback | Evidence (scenario names above) |
|---|---|
| Use a database instead of static data | *state survives an n8n restart*; both *kill n8n* scenarios (the `pending` claim is in the database the moment it is claimed, so recovery finds it); the three *concurrency* scenarios |
| Test concurrent executions | *lease*: 2 simultaneous runs → one proceeds · *claim CAS alone*: 3 simultaneous runs, 5 due reminders → **5 emails, not 15** · *brand-new keys*: 3 runs insert the same keys → still one email per alert |
| Test different failure scenarios | ServiceNow transient 5xx / persistent outage / 401 / HTTP-200-HTML / failure on page 2; SMTP rejects; one bad email in a batch; n8n killed mid-send; n8n killed after delivery |
| Pagination beyond 200 | 450 incidents (3 pages), exact multiple (400), `pageSize` 50 (10 requests), page cap refuses a partial list, failure on page 2 |
| Acknowledgement and escalation | *acknowledgement* (GET shows a form, POST acks, idempotent, wrong token 404, work note written), *escalation* (L1 at 30 min, L2 at 60, then reminders), *auto-acknowledge*, *resolve + reopen* (new token) |

## What the tests found

Running the real stack found defects that the unit tests (and the first mock-based run) did not.
All are fixed and each is now covered by a scenario:

1. **A failed item re-sent the whole email batch.** With *Retry On Fail* + *Continue On Fail*, n8n retries by re-running the node with **all** its input items (`workflow-execute.js`, retry loop). One rejected address would therefore re-send every alert that had already succeeded. The original workflow had this too. The email node now has no node-level retry; a failed item is recorded `failed` and retried alone on the next cycle. *(scenario: one bad email among several)*
2. **An HTTP error on a page in the middle of pagination looked like data.** The completion expression dereferenced `result` unguarded, threw on an error body, and n8n returned the error body as a "page"; a failure on page 2 was neither retried nor reported clearly. The expression is now guarded; the HTTP node fails properly (and is retried 3×), and `Evaluate Rules` reports a ServiceNow error body by name. *(scenarios: persistent outage, failure on page 2)*
3. **The acknowledgement endpoint returned 404 for valid links.** `Prepare Ack` read its request from `$input`, but `Config` sits between the webhook and that node. 55 unit tests passed; only the real-n8n run caught it. *(scenario: acknowledgement)*
4. **"Lease disabled" did not mean "no lock".** With the time-based lease off, the compare-and-swap on the lock row still let only one of several simultaneous runs through, so the claim could not be tested in isolation. The harness now uses a copy with the lock removed.
5. **n8n refuses to call an inactive error workflow** ("Workflow … is not active and cannot be executed"). Setup docs now say to publish it. *(scenario: persistent outage → admin email)*
6. **`crypto` is blocked in Code nodes** by default, so acknowledgement tokens fall back to a non-cryptographic generator unless the task runner allows `crypto`. Tokens are long (≥ 48 hex chars), single-purpose and rotated on reopen, but for a hardened deployment set `NODE_FUNCTION_ALLOW_BUILTIN=crypto` (the node uses `crypto.randomBytes` automatically when it is available).
7. **Data Table *Create* "reuse existing" did not reuse** (still raised "already exists" in this n8n version), so the Setup workflow tolerates that error instead of relying on the option.

## Known behaviour the suite documents on purpose

* **At-least-once delivery.** *killed AFTER the email was delivered but before it was recorded* ends with **two** emails for that alert (the second after recovery). A duplicate is possible in that narrow window; a missed alert is not (the *killed WHILE in flight* scenario delivers exactly once). Plain SMTP cannot do better.
* **Duplicate rows after a lost insert race.** In *brand-new keys (lease REMOVED)* the extra runs leave behind harmless duplicate rows (`15 rows stored for 5 alerts in the recorded run`); the oldest row wins and later runs ignore the rest. The Data Table has no unique constraint — see `state-store-evaluation.md`.

## Superseded results

The earlier version of this file described runs against the static-data implementation
(two consecutive runs, 3 emails in total). That implementation is gone; the *baseline* scenario above
is its replacement, and it additionally asserts the stored state.
