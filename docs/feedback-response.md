# Response to reviewer feedback

Project 2 — *ServiceNow Incident Monitoring and Alerts* (Sanjna J & Manikonda Chethan Krishna).
The reviewers' overall observation was that the project shows a stronger understanding of workflow
reliability and real-world failure scenarios, and that the next step is to **validate the
implementation under different execution conditions and make it more robust and production-ready.**
This page maps each point to what changed and where to verify it.

## What went well — and what we did with it

| Reviewer said | What we did |
|---|---|
| Good understanding of ServiceNow REST API integration | Kept; extended with real pagination (below) and an optional work-note write-back (PATCH). |
| Monitoring for critical, high-priority and stale incidents | Unchanged rules. Alerts now also close themselves when the condition clears and start a fresh cycle if it returns. |
| Configurable reminder intervals | Kept (`reminderMinutesUrgent`, `reminderHours`); reminders now stop once an alert is acknowledged. |
| *Claim-before-send* was a particularly good design decision | Kept as the core idea, and made it **actually atomic and crash-persistent** — see item 1; this was the main weakness underneath it. |
| Failure recovery, execution locks, error handling considered | Recovery is now one compare-and-swap take-over; the lock is a lease shared by all executions; the error path is verified end to end (admin email arrives). |

## Areas for improvement

### 1. Use a database instead of n8n static data — **done**

* Alert state now lives in the n8n Data Table `servicenow_alert_state` (one row per `incident:alertType`).
* Why it mattered: n8n saves workflow static data only **when an execution ends**, replaces the **whole** blob, and skips manual runs. So the "pending" claim was not on disk until the run finished (a crash lost it), and overlapping runs overwrote each other. Evidence from the installed n8n source is in [`state-store-evaluation.md`](state-store-evaluation.md) §1.
* Every write is a `version`-guarded compare-and-swap (`UPDATE … WHERE dedup_key = ? AND version = ?`); the loser gets no row back and sends nothing.
* Options compared (static data / Data Table / Postgres) and the Postgres upgrade path: [`state-store-evaluation.md`](state-store-evaluation.md).
* Code: `workflows/src/plan-actions.js`, `select-my-claims.js`, `resolve-claims.js`; setup: *ServiceNow Monitor - Setup* workflow.

### 2. Test concurrent executions and different failure scenarios — **done (mock ServiceNow / SMTP sink; live run pending)**

* `tests/` runs the **shipped workflows in a real n8n** (isolated profile) against a mock ServiceNow and an SMTP sink, plus unit tests for every Code node.
* Concurrency: two simultaneous runs with the lease on (one proceeds); three simultaneous runs with the lease **removed** racing for 5 due reminders (5 emails, not 15); three runs inserting the same brand-new keys (still one email each).
* Failures: ServiceNow transient 5xx, outage, 401, HTTP-200-HTML, failure on page 2 of 3; SMTP rejection and a partly failing batch; n8n **killed** while an email is in flight (recovered, delivered once) and right after delivery (one duplicate — the documented at-least-once window).
* Real bugs it found are listed in [`test-results.md`](test-results.md#what-the-tests-found).

### 3. API pagination beyond the 200-record limit — **done**

* `sysparm_limit = pageSize`, `sysparm_offset = $pageCount × pageSize`, stable `ORDERBYnumber`, stop at the first short page; `pageSize` and `maxPages` are config.
* If the page cap is reached with a full last page the run **fails** instead of acting on a partial list, because closing "cleared" alerts from a truncated list would mis-resolve them. A failed page fails the whole fetch (no partial evaluation).
* Verified with 450 incidents (alerts on pages 1, 2 and 3), an exact multiple (400), a different page size, the cap, and a mid-pagination failure.

### 4. Acknowledgement and escalation workflows — **done**

* **Acknowledge:** every alert email carries a link. `GET` shows a confirmation form (mail scanners open links, so a GET never changes state); `POST` with the per-alert secret token acknowledges, bumps `version`, and optionally writes a work note to ServiceNow. An incident that is *In Progress and assigned* counts as acknowledged automatically (`autoAckOnProgress`).
* **Escalate:** a critical alert that is still unacknowledged is escalated at `escalateL1Minutes` (30) to the L1 recipient and at `escalateL2Minutes` (60) to L2 — each in addition to the normal recipient; after the last level only reminders continue. Acknowledgement or resolution stops everything.
* **Lifecycle fix found on the way:** resolved alerts are now marked `resolved`; if the incident reopens, a fresh cycle starts with a new token (this was in `plan.md` but had never been implemented).

## What did not change / still open

* **Delivery is at-least-once** (documented and reproduced in a test): a duplicate is possible in a narrow window, a missed alert is not.
* **Data Table has no unique constraint.** The lease normally prevents it; if two runs ever insert the same new key, the oldest row wins before any email is sent. Postgres would remove the gap entirely.
* **Not yet run against the live PDI or real Gmail** (tracked in `plan.md`). The mock-based tests cover the logic and the n8n behaviour, not ServiceNow's real Basic-Auth restrictions or Gmail's rate limits.
* Retention of `resolved` rows is manual.

## Where to look

| Topic | File |
|---|---|
| Design | [`architecture.md`](architecture.md) |
| Database decision | [`state-store-evaluation.md`](state-store-evaluation.md) |
| Executed test results | [`test-results.md`](test-results.md) |
| How to import / configure | [`../workflows/README.md`](../workflows/README.md) |
| Code-node sources | [`../workflows/src/`](../workflows/src/) |
| Tests | [`../tests/`](../tests/) |
