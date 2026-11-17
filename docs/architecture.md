# ServiceNow Incident Monitoring & Alerts — Architecture

The system uses ServiceNow as the incident source, n8n as the automation engine, an n8n **Data Table**
as the alert-state database, and Gmail SMTP for notifications. It periodically retrieves **all** open
incidents (paginated), evaluates alert rules, avoids duplicate notifications with an atomic claim,
sends emails, and lets people **acknowledge** an alert or have it **escalate**.

The design is intentionally low-code and can run on a local machine or a cloud-hosted n8n instance.

> Changes since the first review are summarised in [`feedback-response.md`](feedback-response.md);
> the state-store decision is argued in [`state-store-evaluation.md`](state-store-evaluation.md).

## 1. High-level architecture

- **ServiceNow Incident Management** — incident records, priority, state, assignee, last updated
- **n8n Schedule Trigger** — starts a monitoring run every 5 minutes
- **Run lease** — a row in the alert-state table; stops overlapping runs
- **ServiceNow REST API** — authenticated, **paginated** HTTP request to the Incident Table API
- **Evaluate rules** — validate fields, check priority, detect stale incidents, detect auto-acknowledgement
- **Alert state (Data Table `servicenow_alert_state`)** — one row per `incident:alertType`, written with compare-and-swap
- **Plan + claim** — decide what is due (alert / reminder / escalation), claim it atomically *before* sending
- **Gmail SMTP** — send the alert, reminder or escalation
- **Acknowledgement webhook** — second workflow; a link in the email stops reminders and escalation
- **Error workflow** — emails the administrator when a run fails

Execution logs and error handling apply throughout the workflow.

## 2. Component-by-component design

### A. ServiceNow — incident source

Stores the incidents to be monitored. The workflow reads the incident table (`incident`) using the
ServiceNow Table API. Important fields: `sys_id`, `number`, `priority`, `state`, `assigned_to`,
`short_description`, `sys_updated_on`.

### B. n8n — workflow orchestration

Three workflows:

| Workflow | Trigger | Purpose |
|---|---|---|
| **ServiceNow Incident Monitor** | Schedule, every 5 min | the monitoring cycle (20 nodes) |
| **ServiceNow Incident Ack** | Webhook `GET`/`POST` `/servicenow-incident-ack` | acknowledgement endpoint (15 nodes) |
| **ServiceNow Monitor - Setup** | Manual, once | creates the Data Table and the run-lease row (5 nodes) |

plus the **Error Handler** workflow that is selected as the monitor's *Error Workflow*.

### C. Incident processing and rules

`Evaluate Rules` flattens every page of the response, de-duplicates records that moved between page
requests, and produces the list of alerts that apply *now*. It always emits exactly one item — even
with zero alerts — because the *absence* of alerts is what lets the next step close cleared ones.

### D. Alert state — n8n Data Table

One row per alert key (`INC0010042:critical`) plus a reserved `__run_lock__` row. Columns and the
reasons for choosing a database over workflow static data are in
[`state-store-evaluation.md`](state-store-evaluation.md). Every write is a **compare-and-swap**:

```
UPDATE servicenow_alert_state SET ..., version = N+1  WHERE dedup_key = :key AND version = N
```

If another run (or an acknowledgement) changed the row first, the `WHERE` no longer matches and this
run gets no row back — it lost the claim and does nothing.

### E. Gmail SMTP — notification delivery

Sends a structured email containing the incident number, priority, description, status, assignee,
a link to the record, and (if configured) an **acknowledge link**. Uses `smtp.gmail.com` with an App
Password on a Google Workspace account. Credentials live in n8n's credential manager.

### F. Acknowledgement endpoint

`GET /webhook/servicenow-incident-ack?key=…&token=…` only renders a confirmation form (email link
scanners fetch every link; a GET must not change state). `POST` validates `key` + `token` against the
row, sets `acked_at / acked_by / ack_source`, bumps `version`, and optionally writes a **work note**
back to the ServiceNow incident.

## 3. Alert rules, lifecycle and decision logic

### Rules

| Rule | Condition | Action |
|---|---|---|
| Critical incident | Priority 1 — Critical | Immediate alert; reminders; **escalation** if unacknowledged |
| High-priority incident | Priority 2 — High (toggle `alertHigh`) | Alert; reminders (escalation optional via `escalateTypes`) |
| Stale incident | Unresolved, not updated for `staleHours` (24) | Alert; reminder every `reminderHours` (24) |

### Lifecycle of one alert key

```
 (no row) ──claim+send──▶ sent ──interval elapsed, unacked──▶ reminder ──▶ sent …
                           │  └─ unacked past L1/L2 minutes ─▶ escalation ──▶ sent …
                           │
                           ├── acknowledged (link, or auto: In Progress + assigned) ──▶ no more reminders / escalation
                           │
                           └── condition gone (resolved / downgraded / updated) ──▶ resolved
                                                                                      │ condition returns
                                                                                      ▼
                                                                          fresh cycle, NEW ack token

 pending (claimed, send in flight) ──send ok──▶ sent        failed ──retried next run──▶ pending …
        └─ abandoned for > staleClaimMinutes ──taken over by the next run──▶ pending
```

| Situation | Behaviour |
|---|---|
| No row for the key | claim (INSERT) → send → `sent` |
| `sent`, reminder interval not elapsed | nothing |
| `sent`, interval elapsed, not acknowledged | claim → **reminder** |
| `sent`, unacknowledged, `escalateL1Minutes` since the first alert (and level < 1) | claim → **escalation L1** (to primary + L1 recipient) |
| …and `escalateL2Minutes` | **escalation L2** (to primary + L2 recipient). After the last level only reminders continue |
| acknowledged | no reminders, no escalation |
| In Progress **and** assigned (`autoAckOnProgress`) | treated as acknowledged |
| `failed` | retried immediately (no interval wait) |
| `pending`, fresh | another run is mid-send → skip |
| `pending`, older than `staleClaimMinutes` | abandoned → taken over in one compare-and-swap |
| Condition no longer holds (resolved, downgraded, updated) | row → `resolved`; no more mail |
| `resolved` and the condition returns | fresh cycle: counters reset, **new ack token** |

### Claim-based send (crash-safe, concurrency-safe)

1. **Lease** — `Read Lock` → `Try Acquire Lock` → `Take Lock` (compare-and-swap) → `Verify Lock`. A
   second run that starts while the first holds the lease, or that loses the swap, ends quietly. The
   lease expires by time (`runLockMinutes`, < the schedule interval), so a crashed run can never
   leave the workflow locked.
2. **Plan** — compare the alerts that apply now with the stored rows and produce one *patch* per
   change, each carrying `version + 1`.
3. **Claim** — new keys are INSERTed; existing rows are updated by compare-and-swap. This writes
   `status = pending` **before** any email is attempted, and it is committed immediately (this is
   the property workflow static data could not give).
4. **Verify** — re-read the table; if two runs inserted the same new key, the lowest row id wins and
   the other drops its claim before sending.
5. **Send** — Gmail SMTP.
6. **Record** — `pending → sent` (or `failed` with `last_error`), guarded by `claim_id` so a run whose
   claim was taken over cannot overwrite the new owner's result. A successful send is recorded even
   if other emails in the same batch failed.
7. **Raise** — if any email failed, the run errors *after* recording, so the error workflow emails the
   administrator while the failed rows retry next cycle.

This is **at-least-once** delivery. If n8n dies after the SMTP server accepted a message but before
`sent` is stored, the next run re-sends it — a duplicate is possible, a missed critical alert is
not. Plain SMTP cannot give exactly-once, so the design doesn't try to (the test suite reproduces this
window on purpose).

## 4. Detailed n8n workflow (monitor)

1. **Every 5 Minutes** — Schedule Trigger.
2. **Config** — all tunables (see `workflows/README.md`).
3. **Read Lock → Try Acquire Lock → Take Lock → Verify Lock** — the run lease.
4. **Get ServiceNow Incidents** — GET, paginated with `sysparm_limit`/`sysparm_offset`, retried 3×.
5. **Evaluate Rules** — flatten pages, apply rules, **refuse to continue if the page cap was hit with a full last page**.
6. **Load Alert State** — read the table.
7. **Plan Actions** — decide claims and housekeeping (close cleared alerts, auto-acknowledge).
8. **Route New vs Existing** → **Insert New Alert Rows** / **Claim Existing Rows** → **Merge Claims**.
9. **Re-read Alert State → Select My Claims** — ownership check, builds the emails.
10. **Send Alert Email** — Gmail SMTP.
11. **Resolve Claims → Record Results → Raise Failures**.

## 5. ServiceNow API integration

```
GET https://YOUR_INSTANCE.service-now.com/api/now/table/incident
    ?sysparm_query=stateNOT IN6,7,8^ORDERBYnumber
    &sysparm_fields=sys_id,number,priority,state,assigned_to,short_description,sys_updated_on
    &sysparm_display_value=all
    &sysparm_limit=200          (Config.pageSize)
    &sysparm_offset=0 | 200 | 400 | …     (set by the node's pagination: $pageCount × pageSize)
```

* **Stopping rule:** a page shorter than `pageSize` ends the loop (an exact multiple costs one extra, empty request).
* **Stable order:** `ORDERBYnumber` (immutable, unique) so records don't move between pages the way they would under `ORDERBYDESCsys_updated_on`. Duplicates caused by records that still shift are removed by `sys_id`.
* **Cap:** `maxPages` (50 → 10,000 incidents at 200/page). If the cap is reached with a full last page the run **fails** instead of acting on a partial list — closing "cleared" alerts from a partial list would mis-resolve them.
* **Failure:** a failed page fails the whole node (retried 3×); nothing is evaluated from a partial read.
* Authentication uses an n8n credential with a least-privilege account. Reading needs read on `incident`; the optional work-note write-back needs write on `incident`.

## 6. Email notification design

**Subjects**

```
[CRITICAL INCIDENT] INC0010042 — Production application unavailable
[REMINDER] [CRITICAL INCIDENT] INC0010042 — …
[ESCALATION L1] [CRITICAL INCIDENT] INC0010042 — …          (to team + L1 recipient)
```

```
Hello Team,

ESCALATION LEVEL 1: this incident has not been acknowledged 31 minutes after the first alert. Please take ownership now.

- Incident: INC0010042
- Priority: 1 - Critical
- Status: New
- Assigned to: Unassigned
- Description: Production application unavailable
- Last updated: 2026-11-17 09:12:00 UTC

Please investigate this incident as soon as possible.

View incident: https://<instance>.service-now.com/nav_to.do?uri=incident.do?sys_id=…

Acknowledge (stops reminders and escalation):
https://<n8n-host>/webhook/servicenow-incident-ack?key=INC0010042%3Acritical&token=…
```

## 7. Error handling and security

| Concern | Design decision |
|---|---|
| API unavailable | the fetch is retried (3×); a persistent failure — including a failing page in the middle of pagination — fails the run with the ServiceNow error → error workflow emails the admin; **no state is changed** and nothing is sent from a partial read (an outage is never mistaken for "everything resolved") |
| Hibernating instance (HTTP 200 + HTML) | `Evaluate Rules` throws a descriptive error instead of treating it as an empty list |
| Invalid credentials | the 401 fails the HTTP node; same path as above |
| Truncated pagination | run fails; no alerts, no state change |
| Email sending fails | row marked `failed` with `last_error`; retried next run; run errors so the admin is told. **The email node deliberately has no node-level retry**: with continue-on-fail n8n retries by re-running the node with *all* its input items, so one failed alert would re-send every alert that had already succeeded (found by the test suite) |
| Duplicate emails | atomic claim + lease; residual at-least-once window documented |
| Crash mid-send | the `pending` claim is already in the database; the next run takes it over after `staleClaimMinutes` |
| Overlapping runs | lease row (CAS) + per-key CAS claim + oldest-row-wins insert check |
| Email link abuse | GET never changes state; POST needs the per-alert secret token; a reopened incident gets a new token; key/token shapes are validated and all echoed values HTML-escaped |
| Secret exposure | credentials only in n8n's credential store; exported JSON has names, never secrets |
| Unauthorized access | least-privilege ServiceNow account; ack endpoint exposes only the token-holder's alert |
| Workflow downtime | state is in the database, so a restart loses nothing |

Keep monitoring errors separate from incident alerts, so an API outage doesn't silently stop all
monitoring: the error workflow must be **published** (active) and selected under the monitor's
*Settings → Error Workflow*.

## 8. Deployment architecture

- **Local development** — run n8n on a laptop; ideal for building and testing. Limitation: scheduled runs stop when the machine or n8n process stops. Alert state survives because it is in n8n's database.
- **Cloud deployment** — self-hosted n8n on a cloud VM with persistent storage; set `WEBHOOK_URL` so the acknowledge link in emails is reachable by recipients (`Config.ackBaseUrl` must match).
- **Scaling beyond one n8n process** — move the state to Postgres (`state-store-evaluation.md` §5).

## 9. Testing and acceptance criteria

See [`test-results.md`](test-results.md) for the executed results. Coverage: API connectivity,
critical/high/stale rules, normal-incident suppression, duplicate prevention, reminders, escalation,
acknowledgement (link and auto), resolve/reopen, **pagination (450 incidents / 3 pages / exact
multiples / cap / mid-page failure)**, **concurrent executions**, **ServiceNow and SMTP failure
modes**, **crash recovery**, persistence across an n8n restart, and the error workflow.

## Final architecture summary

Three layers:

1. **Data layer** — ServiceNow incidents and the persistent alert-state table.
2. **Automation layer** — n8n scheduling, paginated REST integration, filtering, atomic alert decisions, acknowledgement, escalation, error handling.
3. **Notification layer** — Gmail SMTP for delivering incident alerts, reminders and escalations to the relevant people.
