# Workflows

| File | Purpose |
|---|---|
| `servicenow-incident-monitor.json` | Main workflow: poll ServiceNow every 5 min, evaluate rules, claim/send/resolve with dedup and reminders |
| `error-handler.json` | Error workflow: emails the administrator when the monitor fails |

Both exports contain **credential names only** (no secrets). After importing into n8n:

1. Create credentials and select them on the nodes:
   - **ServiceNow Basic Auth** — an *HTTP Basic Auth* credential (ServiceNow username/password) on `Get ServiceNow Incidents`.
   - **Gmail SMTP** — an *SMTP* credential on `Send Alert Email` and `Email Administrator`: host `smtp.gmail.com`, port `465`, SSL on, user = your Workspace address, password = a Google App Password.
2. Edit the `Config` node:
   - `instanceUrl`, `recipient`, `fromEmail`
   - `staleHours` (24) — how long unresolved + unupdated before an incident is "stale"
   - `reminderHours` (24) — reminder interval for `stale` alerts
   - `reminderMinutesUrgent` (10) — reminder interval for `critical`/`high` alerts while still unresolved
   - `staleClaimMinutes` (10) — how long a `pending` claim can sit before it's treated as crashed and retried
   - `runLockMinutes` (4) — TTL lock that stops two runs from overlapping; keep it below the 5-minute schedule interval
   - `alertHigh` — toggle whether priority-2 incidents alert at all
3. Edit `Email Administrator` in the error handler (from/to), then in the monitor's *Settings → Error Workflow* select `ServiceNow Monitor - Error Handler`.
4. Activate the monitor workflow.

## How it works

`Every 5 Minutes` → `Config` → `Acquire Run Lock` → `Recover Stale Claims` → `Get ServiceNow Incidents` → `Split Incidents` → `Evaluate Rules` → `Lookup Reminder Due` → `Claim Pending` → `Send Alert Email` → `Resolve Claim`

- **Evaluate Rules** — P1 → `critical`; P2 → `high` (toggle with `alertHigh`); unresolved and not updated for `staleHours` → `stale`. Resolved/Closed/Canceled (states 6/7/8) are ignored. One incident can raise more than one alert type.
- **Acquire Run Lock** — a TTL lock (`runLockMinutes`) that aborts this cycle if a previous run is still within its lock window, instead of letting two runs race to claim the same key. The lock is never explicitly released — it just expires, so a crash can't leave the workflow permanently locked.
- **Recover Stale Claims** — any alert key stuck in `pending` past `staleClaimMinutes` is treated as an abandoned/crashed send attempt and reset to `failed`, so it's retried this cycle instead of being silently stuck forever.
- **Lookup Reminder Due** — per `<incident>:<alertType>` key: no record → send; `pending` → skip (in flight); `failed` → retry; incident's state changed since last record (e.g. reopened) → re-alert; `sent` and the reminder interval has elapsed → send again, flagged `isReminder`; otherwise skip.
- **Claim Pending** — writes `status: pending` *before* the email is attempted. This is what survives a crash between send and save.
- **Send Alert Email** — reminders get a `[REMINDER]` subject prefix and different body copy.
- **Resolve Claim** — on success, `pending → sent` with `last_notified_at`. On failure, `pending → failed` (retried next cycle). A successful send is always recorded even if other emails in the same batch failed, and the node raises an error afterward so the error workflow notifies the admin.

This is **at-least-once** delivery: a narrow-window duplicate is possible, a missed critical alert is not. Plain SMTP cannot guarantee exactly-once, so the design doesn't try to.

## Notes

- Alert state is kept in n8n workflow static data, which survives restarts but is only saved by *active* (production) runs — manual test runs don't persist it.
- The query returns up to 200 unresolved incidents per run.
- Only use sample data; never commit exports containing real credentials or production incident data.

See [`../plan.md`](../plan.md) for the full design rationale and [`../docs/test-results.md`](../docs/test-results.md) for test coverage.
