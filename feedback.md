# Reviewer feedback and what we changed

Project: **ServiceNow Incident Monitoring and Alerts** (n8n)

This page explains in plain words what the reviewers said, what each point means, what we changed, and how we checked it.
For full technical detail see [`docs/feedback-response.md`](docs/feedback-response.md).

---

## What the reviewers said

**What went well**

- Good understanding of the ServiceNow REST API.
- Monitoring for critical, high-priority and stale incidents.
- Reminder intervals can be configured.
- The "claim before send" idea for avoiding duplicate emails was a good design decision.
- We thought about failure recovery, run locks and error handling.

**Areas for improvement**

1. Use a **database** instead of n8n static data to store alert state.
2. **Test** concurrent runs and different failure scenarios.
3. Add **pagination** so the workflow can read more than 200 incidents.
4. Add **acknowledgement and escalation** for incidents.

**Overall:** the project shows a good grasp of reliability. The next step is to test it under different conditions and make it production-ready.

---

## 1. Use a database instead of static data: done

**What it means**

The workflow has to remember which alerts it has already sent, so it doesn't email the same incident twice.
The first version kept this in n8n's *static data*, a small notepad attached to the workflow.

**Why that was a problem**

- n8n only saves the notepad **when a run finishes**. If n8n crashes mid-run, everything written during that run is lost.
  *Example:* the run marks INC001 as "sending now", then n8n crashes. The note was never saved, so the next run doesn't know an email may have gone out.
- If two runs overlap, the run that finishes last **overwrites the whole notepad**.
  *Example:* run A records INC001 and run B records INC002. B finishes last, so A's record of INC001 disappears and INC001 gets emailed again.
- It isn't saved at all when you test from the editor, and you can't open it to see what's inside.

**What we did**

- Alert state now lives in an **n8n Data Table** called `servicenow_alert_state`. It's a real table you can open in n8n's "Data tables" tab.
- Each incident and alert type gets one row, for example `INC0010042:critical`, with columns like `status` (pending / sent / failed / resolved), `reminder_count` and `escalation_level`.
- Each write is saved immediately, not at the end of the run, so a crash no longer loses it.
- Each row has a `version` number. A run can only change a row if the version is still what it read.
  *Example:* runs A and B both see INC001 at version 3. A updates it to version 4 first. B's update asks for "version 3", finds no match, and B sends nothing. Only one email goes out.
- A new **Setup** workflow, run once, creates the table.
- We compared static data, Data Tables and Postgres in [`docs/state-store-evaluation.md`](docs/state-store-evaluation.md). Data Tables won because they need no extra server, and Postgres is the documented upgrade path.

---

## 2. Test concurrent runs and failure scenarios: done (against mocks)

**What it means**

Prove the workflow still behaves when things go wrong or several runs happen at once, rather than only checking the "everything works" case.

**What we did**

We built a test kit in [`tests/`](tests/) that runs the **real workflows in a real n8n**, against:

- a **fake ServiceNow** that we can tell to fail on purpose, and
- a **fake mail server** that records every email that actually arrives.

**Results:** 55 unit tests pass, and 25 end-to-end scenarios pass (last full run 17 Nov 2026).

Examples of what is tested:

| Situation | What should happen | Result |
|---|---|---|
| 2 runs start at the same moment | Only one does the work | Pass |
| 3 runs at once with 5 reminders due (lock switched off on purpose) | 5 emails, not 15 | Pass |
| ServiceNow returns one error (500) | Retry, then succeed | Pass |
| ServiceNow is down | Run fails, admin gets an email, nothing is changed | Pass |
| Wrong password (401) | Run fails, nothing is sent | Pass |
| ServiceNow instance asleep (returns a web page instead of data) | Clear error, existing alerts are not closed by mistake | Pass |
| Mail server rejects one email out of several | Only that one is retried, the others aren't re-sent | Pass |
| n8n killed while an email is being sent | Alert is still delivered after restart | Pass |
| n8n killed right after the email went out but before it was recorded | One duplicate email (expected, see "still open") | Pass |

**Bugs the tests found (all fixed):**

- One rejected email made n8n **re-send the whole batch**, so people got duplicates. The email node now sends and records each email separately.
- An error on page 2 of the ServiceNow results was treated as if it were data. It now fails properly and is retried.
- The acknowledgement link returned "not found" for valid links. The unit tests missed this; the real-n8n test caught it.

Full list: [`docs/test-results.md`](docs/test-results.md).

---

## 3. Pagination beyond 200 records: done

**What it means**

ServiceNow returns at most `sysparm_limit` records per request, and we had it set to 200.
With 450 open incidents, the old workflow only ever saw the first 200, so incidents 201–450 never got alerts.

**What we did**

- The HTTP node now asks for page after page:
  `sysparm_offset = 0`, then `200`, then `400`, and so on, until a page comes back with fewer than 200 records.
- Results are sorted by incident number, so pages don't shift between requests.
- `pageSize` (default 200) and `maxPages` (default 50) are settings in the Config node.
- **Safety rule:** if it reaches `maxPages` and the last page was still full, the run **stops with an error** instead of carrying on with a partial list.
  *Why:* with a partial list, incidents on the missing pages would look "fixed", and their alerts would be closed by mistake.

**Checked with:** 450 incidents across 3 pages, exactly 400 incidents (ending on an empty page), a page size of 50 (10 requests), hitting the page cap, and a failure on page 2.

---

## 4. Acknowledgement and escalation: done

**What it means**

- **Acknowledgement:** someone says "I've seen this, I'm on it", so the reminders stop.
- **Escalation:** if nobody responds to a critical incident in time, tell someone more senior.

**What we did**

*Acknowledge*

- Every alert email has an **"Acknowledge" link**. It is handled by the new workflow `servicenow-incident-ack.json`.
- Opening the link only shows a confirmation page. You have to click the button to actually acknowledge.
  *Why:* email security scanners open links automatically, and they shouldn't be able to acknowledge alerts.
- Once acknowledged, reminders and escalation stop. It can also write a **work note back to the ServiceNow incident**.
- Each alert has its own secret token in the link, so links can't be guessed.
- **Auto-acknowledge:** if the incident is *In Progress* and has an assignee, it counts as acknowledged automatically (`autoAckOnProgress`).

*Escalate*

- A **critical** alert that is still unacknowledged:
  - after **30 min**: also email the L1 contact (`escalateL1Minutes`, `escalateL1Recipient`)
  - after **60 min**: also email the L2 contact (`escalateL2Minutes`, `escalateL2Recipient`)
  - after that: only the normal reminders continue.
- Acknowledging or resolving the incident stops all of it.

*Example timeline for INC0010042 (P1, nobody responds):*

| Time | What happens |
|---|---|
| 09:00 | Alert email to the team |
| 09:10, 09:20 | Reminders (every 10 min for urgent alerts) |
| 09:30 | Escalation email to L1 |
| 10:00 | Escalation email to L2 |
| 10:05 | Someone clicks Acknowledge, so all emails stop and a work note is added in ServiceNow |

*Also fixed:* when an incident is resolved, its alert is now marked `resolved`. If the incident is reopened later, it starts a fresh alert cycle with a new acknowledgement link. This was planned before but never built.

**Checked with:** acknowledgement (GET only shows the page, POST acknowledges, wrong token is rejected, work note written), escalation L1 then L2, auto-acknowledge, and resolve then reopen.

---

## Still open (stated honestly)

- **Not yet tested against the live ServiceNow PDI or real Gmail.** All tests use the fake ServiceNow and the fake mail server.
- **A duplicate is possible in one narrow case:** n8n crashes in the moment after an email was sent but before it was recorded. We chose "maybe one duplicate" over "maybe a missed alert". Plain email can't guarantee exactly-once delivery.
- **Data Tables have no "unique" rule** for a column. The run lock normally prevents duplicate rows; if they ever happen, the oldest row wins. Postgres would close this gap.
- Old `resolved` rows are not cleaned up automatically.

---

## Where to look

| What | File |
|---|---|
| Workflows to import | [`workflows/`](workflows/) (setup, monitor, ack, error handler) |
| Settings and setup steps | [`workflows/README.md`](workflows/README.md) |
| Design | [`docs/architecture.md`](docs/architecture.md) |
| Why a Data Table | [`docs/state-store-evaluation.md`](docs/state-store-evaluation.md) |
| Test results | [`docs/test-results.md`](docs/test-results.md) |
| Detailed feedback response | [`docs/feedback-response.md`](docs/feedback-response.md) |
