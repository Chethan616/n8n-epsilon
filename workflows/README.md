# Workflows

| File | Purpose |
|---|---|
| `servicenow-incident-monitor.json` | Main workflow: poll ServiceNow every 5 min, evaluate rules, dedup, send Gmail alert |
| `error-handler.json` | Error workflow: emails the administrator when the monitor fails |

Both exports contain **credential names only** (no secrets). After importing into n8n:

1. Create credentials and select them on the nodes:
   - **ServiceNow Basic Auth** — an *HTTP Basic Auth* credential (ServiceNow username/password) on `Get ServiceNow Incidents`.
   - **Gmail SMTP** — an *SMTP* credential on `Send Alert Email` and `Email Administrator`: host `smtp.gmail.com`, port `465`, SSL on, user = your Workspace address, password = a Google App Password.
2. Edit the `Config` node: `instanceUrl`, `recipient`, `fromEmail`, `staleHours`, `reminderHours`, `alertHigh`.
3. Edit `Email Administrator` in the error handler (from/to), then in the monitor's *Settings → Error Workflow* select `ServiceNow Monitor - Error Handler`.
4. Activate the monitor workflow.

## How it works

`Every 5 Minutes` → `Config` → `Get ServiceNow Incidents` (Table API, unresolved only, 3 retries) → `Split Incidents` → `Evaluate Rules` → `Filter Already Notified` → `Send Alert Email` (3 retries) → `Save Alert State`

- **Evaluate Rules** — P1 → `critical`; P2 → `high` (toggle with `alertHigh`); unresolved and not updated for `staleHours` → `stale`. Resolved/Closed/Canceled (states 6/7/8) are ignored. One incident can raise more than one alert type.
- **Filter Already Notified** — dedup key is `<number>:<alertType>`. An alert is sent again only if the incident's state changed, or (stale only) `reminderHours` have passed.
- **Save Alert State** — records a key only after its email actually sent. If any email fails, the successful ones are still recorded, the failed ones retry next run, and the node raises an error so the error workflow notifies the admin.

## Notes

- Alert state is kept in n8n workflow static data, which survives restarts but is only saved by *active* (production) runs — manual test runs don't persist it.
- The query returns up to 200 unresolved incidents per run.
- Only use sample data; never commit exports containing real credentials or production incident data.
