# Test results

Environment: n8n 2.44.6 (npm, local), Node 24. Run against a **mock** ServiceNow Table API and a local SMTP sink (no live instance or Gmail account), using sample data only.

## Rule logic (unit-level, against fake incidents)

| Scenario | Expected | Result |
|---|---|---|
| P1, updated 1h ago | `critical` alert | Pass |
| P2, updated 1h ago | `high` alert | Pass |
| P3, updated 1h ago | no alert | Pass |
| P3, updated 30h ago | `stale` alert | Pass |
| P1, state Resolved | ignored | Pass |
| P1, updated 30h ago | `critical` **and** `stale` | Pass |
| Same `INC:critical` already sent, same state | suppressed | Pass |
| Same key already sent, state changed | re-alerted | Pass |
| `stale` sent 25h ago (reminder window 24h) | re-alerted | Pass |
| One email fails, others succeed | successes recorded, failure not recorded, node raises error | Pass |

## End-to-end n8n execution (mock ServiceNow + SMTP sink)

Mock returned 5 incidents (P1 in progress, P2 new, P3 in progress, P4 stale 30h, P1 resolved).

- Request sent with HTTP Basic auth, `sysparm_query`, `sysparm_fields`, `sysparm_display_value=all`, `sysparm_limit=200`.
- 3 emails delivered: `[CRITICAL INCIDENT] INC0010001`, `[HIGH PRIORITY INCIDENT] INC0010002`, `[STALE INCIDENT REMINDER] INC0010004`.
- P3 (fresh) and the resolved P1 produced no email.
- Execution status: success.

## Not yet tested (needs real credentials)

- [ ] Live ServiceNow dev instance (`dev421307`) connectivity with real credentials
- [ ] Real delivery through Gmail SMTP
- [ ] Persistence of alert state across an n8n restart with the workflow *active*
- [ ] Error workflow delivery to the administrator
