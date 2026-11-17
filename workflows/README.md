# Workflows

| File | Purpose |
|---|---|
| `servicenow-monitor-setup.json` | **Run once.** Creates the `servicenow_alert_state` Data Table and the run-lease row. Safe to re-run. |
| `servicenow-incident-monitor.json` | Main workflow: poll ServiceNow every 5 min (paginated), evaluate rules, claim / send / record, reminders, escalation |
| `servicenow-incident-ack.json` | Acknowledgement webhook: the link in each alert email stops reminders and escalation |
| `error-handler.json` | Error workflow: emails the administrator when the monitor fails |
| `src/*.js` | Readable source of every Code node. **These are the source of truth** — the JSON files above (except `error-handler.json`) are generated from them |

All exports contain **credential names only** (no secrets).

## Rebuilding the JSON

```
node scripts/build-workflows.js
```

Edit the logic in `workflows/src/`, run the command, re-import. `tests/` runs those same `src/` files.

## Import and configure (first time)

1. Import all four JSON files into n8n.
2. Create credentials and select them on the nodes:
   - **ServiceNow Basic Auth** — an *HTTP Basic Auth* credential on `Get ServiceNow Incidents` (and on `Write Work Note` in the Ack workflow).
   - **Gmail SMTP** — an *SMTP* credential on `Send Alert Email` and on `Email Administrator`: host `smtp.gmail.com`, port `465`, SSL on, user = your Workspace address, password = a Google App Password.
3. Open **ServiceNow Monitor - Setup** and click **Execute workflow** once. It creates the Data Table `servicenow_alert_state` and the lease row. (Without it the monitor stops with *"Run-lock row not found … Run the Setup workflow"*.)
4. Edit the **Config** node of the monitor (see below), and the small **Config** node of the Ack workflow (`instanceUrl`, `writeBack`).
5. Edit `Email Administrator` in the error handler (from/to), then in the monitor's *Settings → Error Workflow* select `ServiceNow Monitor - Error Handler`. **Publish the error handler too** — n8n will not run an inactive error workflow.
6. Publish **ServiceNow Incident Ack** and **ServiceNow Incident Monitor**.
7. Make sure the acknowledge link is reachable by whoever reads the email: for a local n8n, `http://localhost:5678/...` only works on your own machine; on a server set `WEBHOOK_URL` and put the same base in `Config.ackBaseUrl`.

## Config (monitor)

| Setting | Default | Meaning |
|---|---|---|
| `instanceUrl`, `recipient`, `fromEmail` | placeholders | ServiceNow instance, alert recipient(s), sender |
| `staleHours` / `reminderHours` | 24 / 24 | stale = unresolved and not updated for this long; reminder interval for `stale` alerts |
| `alertHigh` | true | whether priority-2 incidents alert at all |
| `reminderMinutesUrgent` | 10 | reminder interval for `critical` / `high` while unresolved **and unacknowledged** |
| `staleClaimMinutes` | 10 | a `pending` claim older than this is treated as a crashed send and taken over |
| `runLockMinutes` | 4 | run lease; keep it **below** the 5-minute schedule. `0` disables the time-based lease |
| `pageSize` / `maxPages` | 200 / 50 | pagination: records per request; max requests per run. Reaching `maxPages` with a full last page **fails the run** instead of acting on a partial list |
| `autoAckOnProgress` | true | an incident that is *In Progress* **and assigned** counts as acknowledged |
| `ackBaseUrl` | `http://localhost:5678/webhook/servicenow-incident-ack` | base of the acknowledge link in emails; empty = no link |
| `escalateTypes` | `critical` | comma-separated alert types that escalate |
| `escalateL1Minutes` / `escalateL1Recipient` | 30 / placeholder | unacknowledged this long after the first alert → also email this address. Empty recipient disables the level |
| `escalateL2Minutes` / `escalateL2Recipient` | 60 / placeholder | second level |

## How the monitor works

`Every 5 Minutes` → `Config` → **lease** (`Read Lock` → `Try Acquire Lock` → `Take Lock` → `Verify Lock`)
→ `Get ServiceNow Incidents` (paginated) → `Evaluate Rules` → `Load Alert State` → `Plan Actions`
→ `Route New vs Existing` → `Insert New Alert Rows` / `Claim Existing Rows` → `Merge Claims`
→ `Re-read Alert State` → `Select My Claims` → `Send Alert Email` → `Resolve Claims`
→ `Record Results` → `Raise Failures`

- **Lease** — a row in the alert-state table taken with a compare-and-swap; a second run that starts while one is active, or loses the swap, ends quietly. It expires by time, so a crashed run cannot lock the workflow.
- **Get ServiceNow Incidents** — `sysparm_limit = pageSize`, `sysparm_offset = $pageCount × pageSize`, stable `ORDERBYnumber`; stops at the first page shorter than `pageSize`.
- **Evaluate Rules** — P1 → `critical`; P2 → `high`; unresolved and not updated for `staleHours` → `stale`. Resolved/Closed/Canceled (6/7/8) ignored. Throws if the response is not a real result list (e.g. a hibernating instance) or if the page cap was hit with a full last page. Always emits one item.
- **Plan Actions** — per `<incident>:<alertType>` key: new → claim; `sent` + interval elapsed + unacknowledged → reminder; unacknowledged past an escalation level → escalation; `failed` → retry; `pending` and abandoned → take over; acknowledged → nothing; condition gone → `resolved`; condition back after `resolved` → fresh cycle with a new ack token.
- **Insert New Alert Rows / Claim Existing Rows** — write `status = pending` **before** any email is attempted; updates are compare-and-swap on `version`, so only one of several racing runs gets the row back.
- **Re-read Alert State → Select My Claims** — keeps only the claims this run still owns (if two runs inserted the same brand-new key, the lowest row id wins) and builds the emails.
- **Send Alert Email** — subjects: `[CRITICAL INCIDENT]`, `[REMINDER] …`, `[ESCALATION L1] …`; escalations also go to that level's recipient.
- **Resolve Claims → Record Results** — `pending → sent` (or `failed` + `last_error`), guarded by `claim_id`. A successful send is recorded even if others in the batch failed.
- **Raise Failures** — errors *after* recording if any email failed, so the error workflow notifies the administrator while the failed rows retry next run.

This is **at-least-once** delivery: a narrow-window duplicate is possible (n8n killed after SMTP accepted the mail, before `sent` was stored); a missed critical alert is not.

## Acknowledgement workflow

- `GET /webhook/servicenow-incident-ack?key=…&token=…` → shows a confirmation form. **A GET never changes state** (email security scanners open every link).
- `POST` (the form) → checks `key` + the per-alert `token`, sets `acked_at / acked_by / ack_source = email-link`, bumps `version`. If `writeBack` is true in the Ack workflow's Config and the incident has a `sys_id`, it also writes a work note to ServiceNow (the ServiceNow account then needs write access on `incident`; a failure to write the note does not undo the acknowledgement).
- A re-opened incident gets a **new** token, so an old email link cannot acknowledge the new occurrence.

## Notes

- Alert state lives in the Data Table, which (unlike workflow static data) persists immediately, is shared by overlapping runs, and is also saved for manual test runs. You can see and edit it under **Data tables** in n8n.
- Resolved rows are kept (that is what makes a reopened incident start a fresh cycle); purge old ones occasionally.
- Only use sample data; never commit exports containing real credentials or production incident data.

See [`../docs/feedback-response.md`](../docs/feedback-response.md) for why these changes were made, [`../docs/state-store-evaluation.md`](../docs/state-store-evaluation.md) for the database decision, and [`../docs/test-results.md`](../docs/test-results.md) for test coverage.
