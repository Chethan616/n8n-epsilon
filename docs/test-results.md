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

## Claim-based dedup & reminder logic (unit-level)

| Scenario | Expected | Result |
|---|---|---|
| Run lock acquired, second acquire within TTL | throws, cycle skipped | Pass |
| Run lock older than TTL | acquires normally | Pass |
| Claim stuck `pending` past `staleClaimMinutes` | reset to `failed` (retryable) | Pass |
| Fresh `pending` claim | left untouched (in flight) | Pass |
| No prior record | eligible, not a reminder | Pass |
| `sent`, reminder interval not elapsed | skipped | Pass |
| `sent`, reminder interval elapsed | eligible, flagged `isReminder` | Pass |
| `failed` record | eligible (retry) | Pass |
| Incident's state changed since last record (e.g. reopened) | eligible, re-alerted even inside the interval | Pass |
| Claim Pending | writes `status: pending` for every eligible item before send | Pass |
| Resolve Claim — all sends succeed | all marked `sent` with `last_notified_at` | Pass |
| Resolve Claim — one send fails among several | successes marked `sent`, failure marked `failed`, node raises an error (surfaces to error workflow) | Pass |
| Two consecutive cycles sharing state | cycle 2 sends nothing new immediately after cycle 1 | Pass |

## End-to-end n8n execution (mock ServiceNow + SMTP sink)

Mock returned 5 incidents (P1 in progress, P2 new, P3 in progress, P4 stale 30h, P1 resolved).

**Run 1:**
- Request sent with HTTP Basic auth, `sysparm_query`, `sysparm_fields`, `sysparm_display_value=all`, `sysparm_limit=200`.
- 3 emails delivered: `[CRITICAL INCIDENT] INC0010001`, `[HIGH PRIORITY INCIDENT] INC0010002`, `[STALE INCIDENT REMINDER] INC0010004`.
- P3 (fresh) and the resolved P1 produced no email.
- Claim → Send → Resolve all completed; static data persisted back to the workflow.

**Run 2 (immediately after, same static data):**
- Execution status: success.
- 0 new emails — all three keys were correctly recognized as already `sent` with their reminder interval not yet elapsed.
- Total emails across both runs: 3 (not 6), confirming the claim-based dedup holds across separate executions, not just within one.

## Not yet tested (needs real credentials)

- [ ] Live ServiceNow dev instance (`dev421307`) connectivity with real credentials — instance was hibernating at last check
- [ ] Real delivery through Gmail SMTP
- [ ] Persistence of alert state across an n8n restart with the workflow *active*
- [ ] Error workflow delivery to the administrator
- [ ] Reminder actually firing after the real interval elapses (tested logically via unit tests with simulated timestamps, not via a live multi-hour run)
