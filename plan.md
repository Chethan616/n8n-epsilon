# Implementation plan — ServiceNow Incident Monitoring & Alerts

Owners: **Sanjna J** and **Manikonda Chethan Krishna**. This plan covers the two design changes we agreed on — a reminder/escalation policy so active critical incidents aren't emailed once and forgotten, and a claim-based send pattern so a crash between "send" and "save" can't produce a silent duplicate (or a silent miss).

## 1. Notification policy (reminder / escalation)

Today the workflow sends one email per `incident:alertType` and never again. That's wrong for an incident that stays critical for hours. New behavior:

| Time | Incident state | Action |
|---|---|---|
| 10:00 | Critical, first seen | Send email. Save `status=sent`, `last_notified_at=10:00`. |
| 10:01–10:09 | Still critical | Wait. `reminder_interval` hasn't elapsed — no email. |
| 10:10 | Still critical | `reminder_interval` elapsed — send a reminder, update `last_notified_at=10:10`. |
| 10:15 | Resolved | Mark resolved, stop sending. No more reminders for this key. |

- `reminder_interval` is configurable per alert type (e.g. critical: 10 min, stale: 24h — stale already has this via `reminderHours`; critical/high get a new, shorter one since "still critical and unresolved" is more urgent than "still stale").
- Never reset `status` back to unsent on every run — only `last_notified_at` moves forward. This is what turns "re-alert" into "controlled reminder" instead of "accidental duplicate every 5 minutes."
- A resolved/closed incident (states 6/7/8) is already filtered out in `Evaluate Rules` — once that happens, its key naturally stops getting reminders. We additionally mark it `resolved` in the store so a flapping incident (closed, then reopened) starts a fresh notification cycle instead of being silently skipped forever.
- Stretch goal, not required for the assignment: escalate to a second recipient if a critical incident has had N reminders without resolution.

## 2. Claim-based send (fixes send-then-save duplicate risk)

Current risk: email sends, then the state save fails (crash, API hiccup) → next run has no record of the send → duplicate email.

New sequence, per incident:alertType key:

1. **Look up** — read the key from the Alert State Store. If `status=sent` and the reminder interval hasn't elapsed, skip.
2. **Claim** — write `status=pending`, `claimed_at=now` *before* sending. This is the record that survives a crash.
3. **Send** — attempt the Gmail SMTP send.
4. **Resolve** — on success, `pending → sent`, set `last_notified_at`. On a definite failure (SMTP rejected), `pending → failed` so it's retried next run. On no clear answer (timeout), leave it `pending` — step 5 below cleans it up.
5. **Stale-claim recovery** — on every run, any key still `pending` older than a threshold (e.g. 10 minutes) is treated as a crashed/abandoned attempt and is eligible to retry.
6. **Concurrency** — the Schedule Trigger shouldn't overlap with itself. Set the workflow's **"Prevent concurrent executions"** option in n8n (Workflow Settings) so a slow run can't start a second run that claims the same key at the same time.

This is **at-least-once** delivery, not exactly-once — a duplicate email is possible (narrow window) but a missed critical alert is not, which is the right tradeoff for an incident monitor. Plain SMTP cannot give exactly-once, so we're not trying to.

**Data model (Alert State Store), updated:**

| Field | Example | Notes |
|---|---|---|
| `key` | `INC0010042:critical` | incident number + alert type |
| `status` | `pending` / `sent` / `failed` / `resolved` | |
| `claimed_at` | `2026-10-25T10:00:03Z` | set on claim, used for stale-claim recovery |
| `last_notified_at` | `2026-10-25T10:10:00Z` | drives the reminder interval |
| `incident_state` | `In Progress` | used to detect state changes (reopen, etc.) |

## 3. Code changes needed

- `dedup.js` → split into **`lookup.js`** (decide skip / claim / reminder-due) and keep the claim write as its own step before the email node, not after.
- `save.js` → becomes **`resolve-claim.js`**: on success mark `sent`, on failure mark `failed`, both keyed by the item that was actually claimed (not re-derived from the email result alone).
- New **`recover-stale-claims.js`**, run once per cycle before lookup: scans the store for `pending` entries older than the threshold and resets them to retryable.
- `evaluate.js` — add `incident_state` into the emitted item so lookup can detect state changes.
- Workflow settings — enable "Prevent concurrent executions."

## 4. Task split

| Task | Owner | Status |
|---|---|---|
| Reminder/escalation policy design (this doc, section 1) | Chethan | Done |
| Claim-based send design (this doc, section 2–3) | Chethan | Done |
| Implement `lookup.js`, `claim.js`, `resolve-claim.js`, `recover-stale-claims.js`, `acquire-lock.js` | Chethan | Done |
| Unit tests for the full claim lifecycle (lock, stale-claim recovery, lookup, claim, resolve, two-run integration) | Chethan | Done — all passing |
| Wire new nodes into `workflows/servicenow-incident-monitor.json`, validate against mock ServiceNow + SMTP sink across two consecutive runs | Chethan | Done — see `docs/test-results.md` |
| Update `docs/architecture.md`, `workflows/README.md`, `docs/test-results.md` with the final behavior | Chethan | Done |
| ServiceNow dev instance connectivity + sample incident data (P1/P2/P3, one stale, one resolved) | Chethan | Still blocked — instance (`dev421307`) is hibernating as of 2026-10-26; needs a manual sign-in at developer.servicenow.com to wake, then retry. Sanjna created a second PDI (`dev268562`) and has Gmail SMTP working, but ServiceNow Basic Auth is still failing there too |
| Gmail SMTP credential setup + real send test | **Sanjna** | To do |
| Reminder actually firing after the real interval elapses — live run, not simulated timestamps | **Sanjna** | To do |
| Live test matrix once the instance is awake: real critical/high/stale alerts, a real reminder firing, a real resolve stopping reminders | Shared — Sanjna runs reminder/resolve cases once Gmail is wired up, Chethan runs ServiceNow-side cases | To do |
| Error workflow delivery test (trigger a real failure, confirm the admin email arrives) | **Sanjna** | To do |
| Re-export sanitized workflow JSON after any further edits, final PPT update (slide 6 per the agreed wording below) | Chethan | Done — artifact deck's workflow slide updated to all 11 nodes with the agreed wording |

Slide 6 wording to use in the deck once this ships: *"Alert state is claimed as pending before sending and marked sent after success. Failed and stale attempts are retried, with concurrency controls to reduce duplicates."*

## 5. Order of work

1. Wake the ServiceNow instance, confirm API connectivity, seed sample incidents (blocks everything downstream — Chethan, now).
2. Implement claim/lookup/resolve code nodes against the mock API first (no live credentials needed) — can run in parallel with step 1.
3. Wire into the real workflow, test against the live dev instance.
4. Gmail SMTP credential + real send test.
5. Full test matrix, then update docs and the deck.

## 6. Review feedback follow-up (2026-11-17)

Reviewer feedback and the response are in [`docs/feedback-response.md`](docs/feedback-response.md).

| Task | Owner | Status |
|---|---|---|
| Evaluate a database instead of workflow static data; implement it | Chethan | Done — n8n Data Table `servicenow_alert_state`, version-guarded compare-and-swap writes; evaluation in `docs/state-store-evaluation.md` |
| Concurrency + failure-scenario tests (concurrent runs, ServiceNow/SMTP failures, crash mid-send) | Chethan | Done against a mock ServiceNow + SMTP sink on a real n8n — see `docs/test-results.md` |
| API pagination beyond 200 records | Chethan | Done — offset paging, `pageSize` / `maxPages` config, cap fails the run |
| Acknowledgement + escalation | Chethan | Done — ack webhook (link + auto-ack), two escalation levels |
| `resolved` status / fresh cycle on reopen (was described in section 1 above, never implemented) | Chethan | Done |
| Live run against the real ServiceNow PDI + real Gmail (the mock tests do not cover ServiceNow's Basic-Auth restriction or Gmail limits) | Shared | Still to do — same blockers as section 4 |
| Error workflow delivery to a real inbox | **Sanjna** | Verified against the SMTP sink (admin email arrives); still to do with real Gmail |
| Decide whether to move state to Postgres (multi-worker / hard unique key) | Shared | Open — only needed if n8n runs in queue mode |
| Retention job for `resolved` rows | Shared | Open, low priority |

Things the test suite found that changed the design (all fixed, each now has a test): n8n re-runs the
*whole* batch when a multi-item node with retry-on-fail has one failing item (so the email node has no
node-level retry); an HTTP error on a page in the middle of pagination was returned as data; the ack
endpoint read its request from the wrong node.
