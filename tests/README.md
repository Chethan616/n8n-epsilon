# Tests

Two layers, no `npm install` required (the e2e suite reuses `sqlite3`, `flatted` and `mailparser`
from the n8n install on the machine).

```
cd tests
npm run test:unit     # ~0.5 s   – every Code node, against a stand-in for the n8n runtime
npm run test:e2e      # ~6–8 min – the real workflows in a real n8n, with injected failures
```

## Unit tests (`unit/`)

Run the exact Code-node sources in [`../workflows/src/`](../workflows/src/) (the shipped workflow
JSON is generated from them) through `lib/code-node.js`, which provides `$input`, `$('Node')` and
`$execution`. They cover the decision matrix: reminders, escalation levels, acknowledgement,
stale-claim takeover, reopen-after-resolve, the pagination guard, the insert-race tie-break, the
lease, and input validation / HTML escaping of the ack endpoints.

## End-to-end tests (`run-e2e.js`)

What is real: n8n (the installed version, in an **isolated profile in `%TEMP%` — your `~/.n8n` is
never touched**), its Data Table database, the shipped workflow nodes, HTTP, SMTP delivery.
What is simulated:

| Piece | Stand-in | Why |
|---|---|---|
| ServiceNow | `lib/mock-servicenow.js` — Table API with Basic auth, `sysparm_limit/offset`, fault injection, request barrier | repeatable outages, 450-incident pagination, forced races |
| Gmail | `lib/smtp-sink.js` — SMTP server that records mail; can reject or hang | verify what was *actually delivered*, fail on demand |

Two deliberate differences between a test copy and the shipped workflow (everything else is
byte-identical): the *Schedule Trigger* is replaced by a *Webhook* so a test can start a run on
demand, and the *Config* node is replaced by a Code node returning the same defaults (optionally
overridden per run) so one n8n process can exercise many settings.

Scenarios injected: concurrent executions (with the run lease on, and with it **bypassed** to test
the compare-and-swap claim on its own), ServiceNow 5xx / 401 / HTML-200 / failure on page 2 of
pagination, SMTP rejection, a partially failing batch, and `taskkill` of n8n **while an email is in
flight** and **right after it was delivered**.

```
node run-e2e.js --only crash     # run scenarios whose name contains "crash" (setup always runs first)
node run-e2e.js --keep           # keep the n8n profile + log in %TEMP%\n8n-epsilon-e2e
```

Requirements: Node 18+, n8n installed globally (`npm i -g n8n`). Set `N8N_DIR` if it is not in
`%APPDATA%\npm\node_modules\n8n`. Ports 5688/5788 must be free.
