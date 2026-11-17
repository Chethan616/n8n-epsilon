"""Builds feedback.pptx - "what changed after the review, and what was already fine".

    python scripts/build-feedback-deck.py

Uses the master/layouts/theme of n8n-epsilon-detailed.pptx so it looks like the same deck family.
Numbers shown on the slides come from RESULTS below (kept in sync with tests/last-run.json).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from pptx_lib import (  # noqa: E402
    LAYOUT_CLOSE, LAYOUT_CONTENT, LAYOUT_TITLE, MONO, SANS, SERIF, Slide, para, run, write_deck,
)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TEMPLATE = os.path.join(ROOT, "n8n-epsilon-detailed.pptx")
OUT = os.path.join(ROOT, "feedback.pptx")

# ---- facts shown on the slides --------------------------------------------------------------
last = json.load(open(os.path.join(ROOT, "tests", "last-run.json"), encoding="utf-8"))
E2E_TOTAL = len(last["results"])
E2E_PASS = sum(1 for r in last["results"] if r["ok"])
UNIT_TOTAL = 55  # node --test tests/unit  (see docs/test-results.md)


def content(eyebrow, title):
    s = Slide(LAYOUT_CONTENT)
    s.placeholder("body", 100, eyebrow, 13, "accent2", bold=True, face=SANS, spc=200)
    s.placeholder("title", 101, title, 30, "tx1")
    s.slide_number()
    return s


def bullets(items, size=13.5, color="accent6", gap=7):
    return [para(run(t, size, color), bullet=True, indent_in=0.22, line=112, space_after=gap, end_size=size) for t in items]


def card_title(s, x, y, w, text, color):
    s.text(x, y, w, 0.35, [para(run(text, 12.5, color, True, spc=150), end_size=12.5)], anchor="ctr")


slides = []

# 1 ---------------------------------------------------------------------------------------------
s = Slide(LAYOUT_TITLE, "Title")
s.text(0.9, 1.7, 10, 0.4, [para(run("EPSILON · PUBLICIS GROUPE AUTOMATION ASSIGNMENT", 14, "accent1", True, spc=200), end_size=14)], anchor="ctr")
s.placeholder("title", 100, "Reviewer feedback: what changed", 44, "bg1")
s.placeholder("body", 101, "ServiceNow Incident Monitoring & Alerts — how we answered each review point, and what we kept because it was already right.", 18, "AEB8C9", bold=False, face=SANS)
s.text(0.9, 6.0, 10, 0.4, [para(run("Sanjna J  ·  Manikonda Chethan Krishna", 14, "AEB8C9"), end_size=14)], anchor="ctr")
slides.append(s)

# 2 ---------------------------------------------------------------------------------------------
s = content("FEEDBACK RECEIVED", "What the reviewers said")
s.card(0.6, 1.75, 5.95, 3.55, "accent3")
card_title(s, 0.9, 1.95, 5.4, "WHAT WENT WELL  ·  KEPT", "accent3")
s.text(0.9, 2.4, 5.4, 2.8, bullets([
    "Good grasp of ServiceNow REST API integration",
    "Monitoring for critical, high-priority and stale incidents",
    "Configurable reminder intervals for unresolved incidents",
    "Claim-before-send to prevent duplicate notifications — \"a particularly good design decision\"",
    "Failure recovery, execution locks and error handling considered",
], 13.5))
s.card(6.78, 1.75, 5.95, 3.55, "accent1")
card_title(s, 7.08, 1.95, 5.4, "AREAS FOR IMPROVEMENT  ·  CHANGED", "accent1")
s.text(7.08, 2.4, 5.4, 2.8, bullets([
    "Use a database instead of n8n static data for alert state",
    "Test concurrent executions and different failure scenarios",
    "Implement API pagination — go beyond the 200-record limit",
    "Support incident acknowledgement and escalation workflows",
], 13.5))
s.rect(0.6, 5.55, 12.13, 0.85, fill="lt2", radius=3, line="accent5",
       paragraphs=[para(run("Reviewers' overall note: ", 13, "tx1", True) + run("validate the implementation under different execution conditions and make it more robust and production-ready.", 13, "accent6"), line=110, end_size=13)],
       inset=0.2)
slides.append(s)

# 3 ---------------------------------------------------------------------------------------------
s = content("AT A GLANCE", "Four review points, four changes")
s.table(0.6, 1.75, [2.6, 5.0, 4.53], [
    ["Review point", "What changed", "Proof"],
    ["Use a database, not static data", "Alert state now lives in an n8n Data Table. Every write is a version-guarded compare-and-swap.", "n8n only saves static data at the END of a run — a crash loses the claim"],
    ["Test concurrency and failures", f"{UNIT_TOTAL} unit tests + {E2E_TOTAL} end-to-end scenarios on a real n8n, incl. 3 racing runs and a hard kill mid-send", f"{E2E_PASS}/{E2E_TOTAL} scenarios pass; every failure mode ends in 'retry' or 'one duplicate' — never a miss"],
    ["Pagination beyond 200 records", "Offset paging, configurable page size, and a cap that FAILS the run instead of using a partial list", "450 incidents → 3 pages; alerts found on pages 2 and 3"],
    ["Acknowledgement and escalation", "Scanner-safe email link, auto-ack when In Progress + assigned, 2-level escalation to other people", "Escalates L1 at 30 min, L2 at 60 min; ack stops it"],
], row_h=[0.45, 0.95, 0.95, 0.95, 0.95], size=11.5, first_col_bold=True)
s.text(0.6, 6.2, 12.1, 0.4, [para(run("Monitor workflow grew from 11 to 20 nodes; two new workflows (Ack, Setup) were added; logic now lives in readable source files and is unit-tested.", 11.5, "accent4", italic=True), end_size=11.5)])
slides.append(s)

# 4 ---------------------------------------------------------------------------------------------
s = content("1 · DATABASE", "Why static data was not enough")
cards = [
    ("accent1", "SAVED TOO LATE", "n8n writes static data only when an execution ENDS. The \"pending\" claim sits in memory — if n8n dies after the claim, it is never stored, so recovery has nothing to find."),
    ("accent2", "LAST WRITER WINS", "Each run writes back its whole snapshot. With two overlapping runs the later one erases the earlier one's claim — and the other run sends a duplicate."),
    ("accent3", "NOT ATOMIC, NOT VISIBLE", "The run lock was read-then-write, so two runs can both pass. Manual test runs never save it, and it is one opaque JSON blob nobody can query."),
]
for i, (acc, head, body) in enumerate(cards):
    x = 0.6 + i * 4.1
    s.card(x, 1.8, 3.93, 2.95, acc)
    s.text(x + 0.3, 2.05, 3.4, 0.35, [para(run(head, 12.5, acc, True, spc=150), end_size=12.5)], anchor="ctr")
    s.text(x + 0.3, 2.55, 3.4, 2.1, [para(run(body, 13.5, "accent6"), line=118, end_size=13.5)])
s.text(0.6, 5.05, 12.1, 0.9, [
    para(run("Checked against the installed n8n source ", 12.5, "tx1", True) + run("(execution-lifecycle-hooks.js): static data is saved in the workflowExecuteAfter hook only, replaced as a whole, and skipped for manual runs.", 12.5, "accent6"), line=115, end_size=12.5)])
slides.append(s)

# 5 ---------------------------------------------------------------------------------------------
s = content("1 · DATABASE", "Decision: n8n Data Table now, Postgres next")
s.table(0.6, 1.75, [3.4, 2.9, 2.9, 2.93], [
    ["", "Static data (before)", "Data Table (chosen)", "Postgres"],
    ["Survives a crash after the claim", ("No", "accent1", True), ("Yes", "accent3", True), ("Yes", "accent3", True)],
    ["Shared by overlapping runs", ("No — last writer wins", "accent1", True), ("Yes", "accent3", True), ("Yes", "accent3", True)],
    ["Atomic claim of an existing row", ("No", "accent1", True), ("Yes — one UPDATE … WHERE version", "accent3", True), ("Yes", "accent3", True)],
    ["Unique key / atomic insert", ("No", "accent1", True), ("No — mitigated, see tests", "accent1", True), ("Yes", "accent3", True)],
    ["Extra infrastructure", "None", "None", "A database server"],
    ["Works from the editor / test runs", ("No", "accent1", True), ("Yes", "accent3", True), ("Yes", "accent3", True)],
], row_h=0.5, size=11.5, first_col_bold=True)
s.rect(0.6, 5.5, 12.13, 0.85, fill="lt2", radius=3, line="accent5",
       paragraphs=[para(run("Why not Postgres now? ", 12.5, "tx1", True) + run("It was already the plan to use Data Tables, they need no new infrastructure, and the whole path could be run and tested on our machines. The Postgres INSERT … ON CONFLICT version is written up in docs/state-store-evaluation.md for multi-worker setups.", 12.5, "accent6"), line=112, end_size=12.5)],
       inset=0.2)
slides.append(s)

# 6 ---------------------------------------------------------------------------------------------
s = content("1 · DATABASE", "The claim is a compare-and-swap")
# two runs racing for the same row
s.text(0.6, 1.7, 12.1, 0.4, [para(run("Both runs read the row at version 3 and want to send the reminder:", 13.5, "accent6"), end_size=13.5)], anchor="ctr")
s.rect(4.9, 2.3, 3.5, 0.95, fill="tx2", radius=6,
       paragraphs=[para(run("servicenow_alert_state", 12, "bg1", True, face=MONO), align="ctr", end_size=12), para(run("INC0010042:critical · version 3", 11.5, "AEB8C9", face=MONO), align="ctr", end_size=11.5)])
for x, name, win in ((0.6, "RUN A", True), (8.9, "RUN B", False)):
    acc = "accent3" if win else "accent1"
    s.card(x, 3.55, 3.83, 2.35, acc)
    s.text(x + 0.25, 3.7, 3.4, 0.35, [para(run(name, 12.5, acc, True, spc=150), end_size=12.5)], anchor="ctr")
    s.text(x + 0.25, 4.1, 3.4, 0.7, [para(run("UPDATE … SET status='pending', version=4\nWHERE key=… AND version=3".split("\n")[0], 10.5, "tx1", face=MONO), end_size=10.5),
                                      para(run("WHERE key=… AND version=3", 10.5, "tx1", face=MONO), end_size=10.5)])
    s.text(x + 0.25, 4.95, 3.4, 0.8, [para(run("1 row updated → this run owns the claim, sends the email." if win else "0 rows updated → version is already 4. Stand down, send nothing.", 13, acc, True), line=110, end_size=13)])
s.line(2.5, 3.55, 5.1, 3.25, "accent3", 2, arrow=True)
s.line(10.8, 3.55, 8.2, 3.25, "accent1", 2, arrow=True, dash="dash")
s.text(0.6, 6.0, 12.1, 0.4, [para(run("The same trick guards the run lease and acknowledgements — an ack bumps the version, so an in-flight claim of that row loses.", 12, "accent4", italic=True), end_size=12)])
slides.append(s)

# 7 ---------------------------------------------------------------------------------------------
s = content("2 · RELIABILITY TESTING", "Tested on the real stack, with failures injected")
s.card(0.6, 1.75, 6.3, 4.4, "accent2")
card_title(s, 0.9, 1.95, 5.8, "HOW IT IS TESTED", "accent2")
s.text(0.9, 2.4, 5.8, 3.7, bullets([
    "Real n8n 2.45.7 in an isolated profile, with its own database",
    "The shipped workflow nodes, unchanged — only the trigger and Config source are swapped",
    "Mock ServiceNow API: paging, 5xx, 401, HTML-200, delays, race barrier",
    "SMTP sink records what was actually delivered; can reject or hang",
    "taskkill of n8n while an email is in flight",
], 13))
for i, (num, label, acc) in enumerate([(str(UNIT_TOTAL), "unit tests · every Code node", "accent2"), (f"{E2E_PASS}/{E2E_TOTAL}", "end-to-end scenarios pass", "accent3")]):
    y = 1.75 + i * 2.25
    s.card(7.15, y, 5.58, 2.05, acc)
    s.text(7.4, y + 0.25, 5.1, 1.0, [para(run(num, 44, acc, True, face=SERIF), end_size=44)], anchor="ctr")
    s.text(7.4, y + 1.25, 5.1, 0.5, [para(run(label, 14, "accent6"), end_size=14)], anchor="ctr")
slides.append(s)

# 8 ---------------------------------------------------------------------------------------------
s = content("2 · RELIABILITY TESTING", "Concurrency and failure scenarios: results")
rows = [["Scenario injected", "What the test asserts"]]
rows += [
    ["2 runs start together (lease on)", "Exactly one proceeds; the other exits cleanly; each alert sent once"],
    ["3 runs race for 5 due reminders (lease removed)", "5 emails, not 15 — one winner per row"],
    ["3 runs INSERT the same new keys", "Oldest row wins → still one email per alert"],
    ["ServiceNow: one 500 / outage / 401 / HTML-200", "Retried, or the run fails with NO state change; admin is emailed"],
    ["Failure on page 2 of 3", "Whole fetch retried; if it persists, nothing is sent from a partial read"],
    ["SMTP rejects the email", "Row marked failed + error kept; next run delivers it once"],
    ["n8n killed WHILE the email is in flight", "Claim survives; recovered; delivered exactly once"],
    ["n8n killed AFTER delivery, before 'sent' saved", "One duplicate (documented at-least-once) — never a miss"],
]
s.table(0.6, 1.75, [5.2, 6.93], rows, row_h=0.46, size=11.5, first_col_bold=True)
s.text(0.6, 6.2, 12.1, 0.4, [para(run(f"{E2E_PASS} of {E2E_TOTAL} scenarios passed in the last run — full list in docs/test-results.md.", 12, "accent4", italic=True), end_size=12)])
slides.append(s)

# 9 ---------------------------------------------------------------------------------------------
s = content("2 · RELIABILITY TESTING", "What the tests found")
finds = [
    ("accent1", "Retry re-sent the whole batch", "n8n's retryOnFail re-runs the email node with ALL items, so one failed alert re-sent the ones that had succeeded. Retry removed; failed rows retry next cycle."),
    ("accent1", "A page-2 error looked like data", "In paginated mode a 5xx came back as a 'page' (our completion check crashed). Check made safe; the run now fails with the real ServiceNow error."),
    ("accent1", "Ack link returned 404", "The Ack workflow read its request from the wrong node. 55 unit tests passed; only the real-n8n run caught it."),
    ("accent2", "Lease off was not 'no lock'", "The compare-and-swap on the lock row still serialised runs, so the claim test uses a copy with the lease removed."),
    ("accent3", "Inactive error workflow", "n8n will not call an error workflow that is not published. Setup docs now say so."),
    ("accent3", "No crypto in Code nodes", "Token generation falls back safely when require('crypto') is blocked by the task runner."),
]
for i, (acc, head, body) in enumerate(finds):
    x = 0.6 + (i % 3) * 4.1
    y = 1.75 + (i // 3) * 2.2
    s.card(x, y, 3.93, 2.05, acc)
    s.text(x + 0.25, y + 0.18, 3.45, 0.4, [para(run(head, 13, acc, True), end_size=13)], anchor="ctr")
    s.text(x + 0.25, y + 0.65, 3.45, 1.35, [para(run(body, 11.5, "accent6"), line=112, end_size=11.5)])
s.text(0.6, 6.2, 12.1, 0.4, [para(run("Also found and kept as documented limits: Data Tables have no unique constraint (mitigated by oldest-row-wins) and SMTP cannot be exactly-once.", 12, "accent4", italic=True), end_size=12)])
slides.append(s)

# 10 --------------------------------------------------------------------------------------------
s = content("3 · PAGINATION", "Every open incident, not just the first 200")
s.card(0.6, 1.75, 5.95, 1.75, "accent1")
card_title(s, 0.9, 1.92, 5.4, "BEFORE", "accent1")
s.text(0.9, 2.35, 5.4, 1.05, [para(run("One GET with sysparm_limit=200. Incident #201 and beyond were never evaluated — and nothing said so.", 13.5, "accent6"), line=118, end_size=13.5)])
s.card(6.78, 1.75, 5.95, 1.75, "accent3")
card_title(s, 7.08, 1.92, 5.4, "AFTER", "accent3")
s.text(7.08, 2.35, 5.4, 1.05, [para(run("sysparm_offset = page × pageSize, ORDERBYnumber for a stable order, stop at the first short page. pageSize and maxPages are config.", 13.5, "accent6"), line=118, end_size=13.5)])
s.table(0.6, 3.8, [5.2, 6.93], [
    ["Test", "Result"],
    ["450 incidents, P1 on pages 1 / 2 / 3", "3 requests (offset 0, 200, 400); all three alerts sent"],
    ["Exactly 400 incidents", "Ends on an empty third page; nothing lost"],
    ["pageSize = 50", "10 requests for 450 incidents — config is honoured"],
    ["Page cap reached with a full last page", "Run FAILS; no alerts, no state change (a partial list must never close alerts)"],
], row_h=0.42, size=11.5, first_col_bold=True)
slides.append(s)

# 11 --------------------------------------------------------------------------------------------
s = content("4 · ACKNOWLEDGEMENT & ESCALATION", "An alert nobody owns gets louder")
# timeline
s.line(1.4, 2.55, 12.3, 2.55, "accent5", 3)
marks = [(1.4, "T+0", "Alert", "accent2"), (4.2, "T+10 min", "Reminder, then every 10", "accent4"), (7.0, "T+30 min", "Escalation L1 → on-call manager", "accent1"), (10.2, "T+60 min", "Escalation L2 → director", "accent1")]
for x, t, label, acc in marks:
    s.rect(x - 0.12, 2.43, 0.24, 0.24, fill=acc, shape="ellipse")
    s.text(x - 0.5, 1.85, 2.4, 0.4, [para(run(t, 12.5, acc, True), end_size=12.5)], anchor="ctr")
    s.text(x - 0.5, 2.8, 2.7, 0.7, [para(run(label, 12, "accent6"), line=110, end_size=12)])
s.card(0.6, 3.75, 5.95, 2.4, "accent3")
card_title(s, 0.9, 3.92, 5.4, "HOW SOMEONE ACKNOWLEDGES", "accent3")
s.text(0.9, 4.35, 5.4, 1.75, bullets([
    "Click the link in the email → confirm page → POST. A GET never acknowledges, so mail scanners cannot",
    "Or simply take the incident: In Progress + assigned counts as acknowledged",
    "Stops reminders AND escalation; optional work note written to ServiceNow",
], 12.5, gap=5))
s.card(6.78, 3.75, 5.95, 2.4, "accent2")
card_title(s, 7.08, 3.92, 5.4, "SAFETY RULES", "accent2")
s.text(7.08, 4.35, 5.4, 1.75, bullets([
    "Each alert has its own secret token; wrong token → 404",
    "A reopened incident gets a NEW token and a fresh cycle",
    "Acknowledging bumps the row version, so a concurrent send loses its claim",
    "Tested: L1, L2, then plain reminders; ack and auto-ack stop everything",
], 12.5, gap=5))
slides.append(s)

# 12 --------------------------------------------------------------------------------------------
s = content("WHAT STAYED", "What was already right — and is now stronger")
s.table(0.6, 1.75, [3.9, 8.23], [
    ["Reviewers liked", "What it is now"],
    ["Claim-before-send design", "Same idea, but now a real atomic claim that is committed immediately, survives a crash, and is race-tested"],
    ["Failure recovery", "A crashed claim is taken over in ONE compare-and-swap after staleClaimMinutes; tested with kill mid-send"],
    ["Execution locks", "A lease row shared across executions (before: per-snapshot static data); expires by time so it can never stick"],
    ["Configurable reminders", "Unchanged knobs, plus acknowledgement-aware reminders and escalation levels"],
    ["Error handling", "Persistent API/SMTP failures fail the run, mark rows failed, and email the admin — verified end to end"],
], row_h=[0.45, 0.85, 0.85, 0.85, 0.85, 0.85], size=12, first_col_bold=True)
slides.append(s)

# 13 --------------------------------------------------------------------------------------------
s = content("HONEST LIMITS", "What is not solved yet")
lim = [
    ("accent1", "AT-LEAST-ONCE, NOT EXACTLY-ONCE", "Kill n8n after SMTP accepted the mail but before 'sent' is stored and the next run re-sends. A duplicate is possible; a miss is not. Reproduced in a test."),
    ("accent2", "DATA TABLE HAS NO UNIQUE KEY", "Two runs inserting the same new key is possible only if the lease fails; the oldest row then wins before sending. Postgres removes it entirely."),
    ("accent3", "NOT YET RUN LIVE", "Tests used a mock ServiceNow and an SMTP sink. The live PDI (auth) and real Gmail delivery are still on the to-do list."),
]
for i, (acc, head, body) in enumerate(lim):
    x = 0.6 + i * 4.1
    s.card(x, 1.8, 3.93, 3.0, acc)
    s.text(x + 0.3, 2.05, 3.4, 0.6, [para(run(head, 12, acc, True, spc=100), end_size=12)], anchor="ctr")
    s.text(x + 0.3, 2.8, 3.4, 2.4, [para(run(body, 13, "accent6"), line=118, end_size=13)])
s.text(0.6, 5.1, 12.1, 0.8, [para(run("Next: ", 13, "tx1", True) + run("live run with Gmail + the PDI, Postgres for multi-worker setups, a retention job for resolved rows.", 13, "accent6"), end_size=13)])
slides.append(s)

# 14 --------------------------------------------------------------------------------------------
s = Slide(LAYOUT_CLOSE, "Close")
s.placeholder("title", 100, "Thank you", 54, "bg1")
s.text(0.9, 2.6, 10, 0.5, [para(run("github.com/Chethan616/n8n-epsilon", 18, "accent1", True), end_size=18)], anchor="ctr")
s.text(0.9, 3.3, 10, 0.9, [para(run("docs/feedback-response.md  ·  docs/state-store-evaluation.md  ·  docs/test-results.md", 14, "AEB8C9"), end_size=14)])
slides.append(s)

write_deck(TEMPLATE, OUT, slides, title="Reviewer feedback: what changed", author="Sanjna J, Manikonda Chethan Krishna")
print("wrote", OUT, f"({len(slides)} slides)")
