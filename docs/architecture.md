# ServiceNow Incident Monitoring & Alerts — Architecture

The system uses ServiceNow as the incident source, n8n as the automation engine, and Gmail SMTP for notifications. It periodically retrieves incidents, evaluates alert rules, avoids duplicate notifications, and sends emails when an incident requires attention.

The design is intentionally low-code and can run on a local machine or a cloud-hosted n8n instance.

## 1. High-level architecture

- **ServiceNow Incident Management** — incident records, priority, state, assignee, last updated
- **n8n Schedule Trigger** — starts a monitoring run every 5 minutes
- **ServiceNow REST API** — authenticated HTTP request to the Incident Table API
- **Normalize and evaluate incidents** — validate fields, check priority, detect stale incidents
- **Alert decision and deduplication** — should this incident trigger a new notification?
- **Gmail SMTP** — send the alert
- **Alert state** — record sent alerts

Execution logs and error handling apply throughout the workflow.

## 2. Component-by-component design

### A. ServiceNow — incident source

Stores the incidents to be monitored. The workflow reads the incident table (`incident`) using the ServiceNow Table API.

Important fields:

- `number` — incident ID, e.g. `INC0010042`
- `priority` — urgency level derived from the instance's rules
- `state` — current incident status
- `assigned_to` — responsible person
- `short_description` — incident summary
- `sys_updated_on` — last modification time

### B. n8n — workflow orchestration

Starts a scheduled run every five minutes and coordinates API requests, transformations, conditions, email delivery, and error handling. n8n is the automation layer; it doesn't replace ServiceNow or own the incident records.

### C. Incident processing and rules

The HTTP Request node fetches incident data. IF, Filter, and optionally Code nodes normalize fields and evaluate whether an incident meets the alert criteria. Only incidents requiring attention proceed to the alert decision stage.

### D. Deduplication and alert state

Keeps track of which incident conditions have already triggered an email, so a scheduled run doesn't resend the same alert. Uses n8n Data Tables (or another persistent store) — not just temporary workflow execution data.

### E. Gmail SMTP — notification delivery

Sends a structured email containing the incident number, priority, description, status, assignee, and a link to the incident record. Uses `smtp.gmail.com` with an App Password on a Google Workspace account. Credentials are stored in n8n's credential manager.

## 3. Alert rules and decision logic

| Rule | Condition | Action |
|---|---|---|
| Critical incident | Priority is 1 — Critical | Send an immediate alert on detection |
| High-priority incident | Priority is 2 — High | Send an alert according to the chosen policy |
| Stale incident | Unresolved and not updated for 24 hours | Send a reminder |

For stale detection, compare the current time against `sys_updated_on`. Exclude resolved/closed incidents and use the appropriate timezone.

### Deduplication logic

For each incident, track its number and alert type, e.g. `INC0010042:critical`, `INC0010042:stale`. If the same alert has already been sent, skip it. If the incident changes state or a new alert condition is triggered, evaluate it again. A reminder policy allows a repeat email after a defined interval (10 min for critical/high, 24h for stale by default) instead of suppressing the alert indefinitely — see "Claim-based send" below for how this is made crash-safe.

### Claim-based send (crash-safe dedup)

Sending the email and recording that it was sent are two separate steps, so a crash between them could otherwise cause a duplicate on the next run. To avoid that:

1. **Look up** the alert key's record. No record, a `failed` record, or an elapsed reminder interval → eligible to send. A fresh `pending` record → another attempt is already in flight → skip.
2. **Claim** — write `status: pending` *before* attempting the send. This is the record that survives a crash.
3. **Send** the email.
4. **Resolve** — success → `pending → sent`, record `last_notified_at`; failure → `pending → failed`, retried next cycle.
5. **Stale-claim recovery** — on every run, any `pending` record older than a threshold (e.g. 10 min) is treated as an abandoned/crashed attempt and reset to `failed` so it retries.
6. **Run lock** — a short TTL lock prevents two scheduled runs from overlapping and racing to claim the same key. The lock isn't explicitly released; it simply expires, so a crash can never leave it stuck.

This gives **at-least-once** delivery: a narrow-window duplicate is possible, but a missed critical alert is not — the right tradeoff for an incident monitor, since plain SMTP cannot guarantee exactly-once delivery.

## 4. Detailed n8n workflow

1. **Schedule Trigger** — interval: every 5 minutes; initiates each monitoring cycle.
2. **HTTP Request** — GET to the ServiceNow Table API; retrieves incidents with a limited field list and appropriate query filters.
3. **Split Out / processing** — one item per incident, so each can be evaluated individually.
4. **IF / Filter** — evaluate critical and stale conditions; route qualifying incidents to the alert branch, others to a skip branch.
5. **Look up alert state** — persistent storage check for whether this incident + alert type has already been notified.
6. **Send Email** — Gmail SMTP / Send Email node builds and sends the alert.
7. **Save alert state** — record incident, alert type, and send time, after a successful delivery.

The email node connects to the "qualifying, not-yet-notified" branch. State is recorded only after a successful send. For stronger reliability, also handle the case where delivery succeeds but saving the state fails, since a later retry could otherwise produce a duplicate.

## 5. ServiceNow API integration

```
GET https://YOUR_INSTANCE.service-now.com/api/now/table/incident
```

For a basic prototype, request only the needed fields:

```
sysparm_fields=number,priority,state,assigned_to,short_description,sys_updated_on
sysparm_limit=100
```

For production-style monitoring, add a query filter so the API returns only relevant unresolved incidents (filter out resolved/closed records using the instance's actual state values). Configure authentication through n8n credentials, using an API account with only the permissions needed to read incidents. Verify the API response and state values in a developer instance before implementing the rules.

## 6. Email notification design

**Subject:** `[CRITICAL INCIDENT] INC0010042 — Production application unavailable`

```
Hello Team,

A critical incident has been detected in ServiceNow.

- Incident: INC0010042
- Priority: 1 — Critical
- Status: In Progress
- Assigned to: Example User
- Description: Production application unavailable
- Last updated: Timestamp from ServiceNow

Please investigate this incident as soon as possible.

View incident: Link to the relevant ServiceNow record
```

## 7. Error handling and security

| Concern | Design decision |
|---|---|
| API unavailable | Configure retries for transient errors and log persistent failures |
| Invalid credentials | Capture authentication errors and alert the workflow administrator |
| Email sending fails | Do not mark the alert as successfully sent |
| Duplicate emails | Maintain persistent alert state |
| Large responses | Use API filters, field selection, and pagination |
| Secret exposure | Store credentials in n8n; never embed secrets in exported JSON |
| Unauthorized access | Use a least-privilege ServiceNow account |
| Workflow downtime | Keep n8n running and persistent storage available |

Keep monitoring errors separate from incident alerts, so an API outage doesn't silently stop all monitoring.

## 8. Deployment architecture

- **Local development** — run n8n on a laptop; ideal for building and testing. Limitation: scheduled runs stop when the machine or n8n process stops.
- **Cloud deployment** — run self-hosted n8n on a cloud VM with persistent storage; suitable for continuous monitoring, subject to provider availability and resource limits.

## 9. Testing and acceptance criteria

- [ ] API connectivity — n8n successfully retrieves incident records
- [ ] Critical alert — a priority-1 incident triggers an email
- [ ] Normal incident — a non-qualifying incident doesn't trigger an alert
- [ ] Stale incident — an unresolved incident past the configured threshold triggers a reminder
- [ ] Duplicate prevention — the same condition doesn't trigger an email on every run
- [ ] Error handling — API and email failures are visible in execution history
- [ ] Persistence — alert state survives an n8n restart
- [ ] Export and documentation — workflow JSON is exported without credentials and setup steps are documented

## Final architecture summary

Three layers:

1. **Data layer** — ServiceNow incidents and persistent alert state.
2. **Automation layer** — n8n scheduling, REST API integration, filtering, alert decisions, and error handling.
3. **Notification layer** — Gmail SMTP for delivering incident alerts to the relevant team.

Recommended implementation order: establish ServiceNow API connectivity first, test a single incident, configure Gmail SMTP, then add filtering, deduplication, and error handling. That gives a working end-to-end demo early rather than building every component at once.
