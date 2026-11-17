# Alert-state store: static data vs. a database

Review feedback: *"Evaluate using a database instead of n8n static data to maintain alert states."*

This document is the evaluation. **Decision: alert state now lives in an n8n Data Table
(`servicenow_alert_state`), written with compare-and-swap updates. Postgres is the documented
next step for multi-worker deployments.**

## 1. What was wrong with static data (evidence, not opinion)

The first implementation kept `sd.alerts[...]` in `$getWorkflowStaticData('global')`. It worked in
the two-run demo, but the way n8n persists static data undermines the design's own guarantees.
Verified against the installed n8n (2.45.7), `dist/execution-lifecycle/execution-lifecycle-hooks.js`:

| Property of static data | Where it comes from | Consequence for this workflow |
|---|---|---|
| **Persisted only at the *end* of an execution** | saved in the `workflowExecuteAfter` hook, nowhere else | The "claim" (`status: pending`) is only in memory until the run finishes. If n8n crashes after the claim and before the run ends, the claim is **never stored**, so there is nothing for stale-claim recovery to find. The core "claim before you send" guarantee silently does not hold. |
| **The whole blob is replaced** | `saveStaticDataById(workflowId, newStaticData)` | Two overlapping runs each write back their *entire* snapshot; the later finisher overwrites the earlier one. A claim made by run A can vanish, and run B (which never saw it) sends a duplicate. |
| **Not saved for manual executions** | `if (!isManualMode && …)` | Test runs from the editor never persist state, so a "tested" workflow behaves differently from the active one (this was already a footnote in the old workflow README). |
| **No atomic operation** | it is a plain JS object | The run lock was `if (sd.runLockedAt …) … sd.runLockedAt = now` — a read-then-write with no atomicity. Two runs can both pass. |
| **Opaque** | one JSON column on the workflow row | Cannot be queried, audited, edited, or backed up on its own; no history of who was notified when. |

## 2. Options considered

| | Workflow static data (before) | **n8n Data Table (chosen)** | Postgres / external DB |
|---|---|---|---|
| Persists mid-execution (survives a crash after the claim) | No (end of run only) | **Yes** (each node's write is committed) | Yes |
| Shared by overlapping executions | No (last writer wins) | **Yes** | Yes |
| Atomic claim | No | **Yes for existing rows** — `update … where dedup_key = ? and version = ?` is one SQL `UPDATE`; the loser gets zero rows back | **Yes, including inserts** (`INSERT … ON CONFLICT … WHERE version = ?`, unique constraint) |
| Unique constraint on the key | No | **No** (known gap, see §4) | Yes |
| Extra infrastructure | None | **None** (lives in n8n's own database) | A database server + credential |
| Visible / editable by humans | No | **Yes** (Data tables tab in the n8n UI) | Yes (any SQL client) |
| Works when test-running from the editor | No | **Yes** | Yes |
| Fits the project's constraints (student PDI, local n8n, no Docker) | Yes | **Yes** | Needs a hosted/local Postgres |

The README and `architecture.md` had always named Data Tables as the intended store; the first
implementation fell back to static data. This change makes the code match the design.

## 3. How the Data Table is used

One table, one row per `<incident>:<alertType>` plus one reserved `__run_lock__` row:

| Column | Purpose |
|---|---|
| `dedup_key` | `INC0010042:critical` (or `__run_lock__`) |
| `status` | `pending` (claimed) · `sent` · `failed` · `resolved` (· `lock`) |
| `version` | **CAS counter.** Every change writes `version + 1` *only if* the row still has `version` |
| `claim_id`, `claimed_at`, `claim_kind`, `claim_level` | who owns the in-flight send, since when, and what it is (`alert` / `reminder` / `escalation`) |
| `first_notified_at`, `last_notified_at`, `reminder_count`, `escalation_level` | drive reminders and escalation |
| `ack_token`, `acked_at`, `acked_by`, `ack_source` | acknowledgement |
| `payload` | incident details at claim time (so a recovered claim can still build its email) |
| `attempts`, `last_error`, `resolved_at`, `incident_state` | diagnostics / lifecycle |

**The claim is a compare-and-swap.** The Data Table *Update* node issues a single
`UPDATE … WHERE dedup_key = :key AND version = :seen`. If another run changed the row first, the
`WHERE` no longer matches, the node returns no rows, and this run simply has nothing to send. The
same trick implements the run lease (`__run_lock__`) and acknowledgement (which bumps `version`
so an in-flight claim of the same row loses).

## 4. Known gaps — stated plainly

1. **No unique constraint → a brand-new key can be INSERTed twice** if two runs get past the run
   lease at the same instant. Mitigation: the lease makes this impossible in normal operation, and
   if it ever happens the **oldest row wins** — each run re-reads the table before sending and the
   run whose row has the higher id drops its claim. The e2e suite exercises this with the lease
   deliberately disabled (see `test-results.md`). The loser's row is left behind as harmless
   garbage that later runs ignore.
2. **Verified on one n8n process only.** n8n applies a Data Table update as a single `UPDATE … WHERE` inside one database transaction (`data-table-rows.repository.js`), and racing three concurrent runs on one n8n (SQLite) produced exactly one winner per row. That was not tested with several workers in queue mode, where Postgres is the safer choice (below).
3. **At-least-once, not exactly-once.** If n8n dies *after* the SMTP server accepted the mail but
   *before* `sent` is recorded, the next run re-sends. No SMTP-based design can avoid this window;
   the e2e suite reproduces it on purpose and asserts "duplicate possible, miss impossible".
4. **No retention.** `resolved` rows are kept (they are what makes a reopened incident start a fresh
   cycle). Purge old ones periodically (Data tables → filter `status = resolved`) or add a cleanup
   node; at assignment scale this is a non-issue.

## 5. When to move to Postgres

Move when any of these becomes true: n8n runs in queue mode with several workers; the incident
volume makes "read all rows each cycle" slow; you need a hard unique constraint on the key; or the
state must be shared with other systems. The mapping is mechanical because every write already is
a version-guarded upsert:

```sql
INSERT INTO alert_state AS a (dedup_key, status, claim_id, claimed_at, version, ...)
VALUES ($1, 'pending', $2, now(), 1, ...)
ON CONFLICT (dedup_key) DO UPDATE
   SET status = 'pending', claim_id = EXCLUDED.claim_id, claimed_at = now(), version = a.version + 1
 WHERE a.version = $3          -- the compare-and-swap
RETURNING *;                   -- no row back = another run won
```

That single statement would remove gap 1 entirely. It was not used here because it cannot be run
or verified on the project's machines (no Docker/Postgres), and an untested production path is
worse than a tested simpler one.
