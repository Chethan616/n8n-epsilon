#!/usr/bin/env node
'use strict';
/*
 * End-to-end reliability tests for the ServiceNow Incident Monitor.
 *
 * Runs the REAL workflows in a REAL n8n (isolated profile, own database) against a mock ServiceNow
 * and an SMTP sink, and injects the failures the review asked about: concurrent executions, API
 * outages, SMTP failures, truncated pagination, and a hard kill of n8n in the middle of a send.
 *
 *   node run-e2e.js                run everything
 *   node run-e2e.js --only crash   run scenarios whose name contains "crash"
 *   node run-e2e.js --keep         keep the n8n profile + log for debugging
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { N8nHarness, sleep } = require('./lib/n8n-harness');
const { MockServiceNow } = require('./lib/mock-servicenow');
const { SmtpSink } = require('./lib/smtp-sink');

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const keep = args.includes('--keep');

const mock = new MockServiceNow();
const sink = new SmtpSink();
const n8n = new N8nHarness({ keepHome: keep });
const NO_LEASE = { runLockMinutes: 0 }; // so back-to-back test runs are not skipped by the run lease
const num = (i) => 'INC' + String(i).padStart(7, '0');
const inc = (i, o = {}) => mock.incident({ number: num(i), ...o });
const key = (i, t = 'critical') => `${num(i)}:${t}`;

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

async function waitFor(fn, { timeoutMs = 30000, every = 300, label = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const nodeJson = (detail, name, run = 0) => {
  const r = detail.runData[name] && detail.runData[name][run];
  return r && r.data && r.data.main && r.data.main[0] && r.data.main[0][0] ? r.data.main[0][0].json : null;
};
const ackLink = (msg) => /(http\S*servicenow-incident-ack\?key=\S+)/.exec(msg.text)[1];

async function reset() {
  mock.set([]); mock.clearFaults(); mock.barrier = null; mock.requests = []; mock.patches = []; mock.pass = 'snpass';
  sink.reset();
  await n8n.resetState();
}

// =============================================================================================
scenario('setup workflow creates the table + run lock, and is safe to re-run', async () => {
  await n8n.fire('test-setup');
  await n8n.waitForExecutions('setup', 1);
  await n8n.fire('test-setup');
  const ex = await n8n.waitForExecutions('setup', 2);
  assert.ok(ex.every((e) => e.status === 'success'), 'both setup runs succeed');
  const rows = await n8n.rows();
  assert.equal(rows.filter((r) => r.dedup_key === '__run_lock__').length, 1, 'exactly one lock row');
});

scenario('baseline: critical / high / stale alert exactly once; normal + resolved incidents are ignored', async () => {
  mock.set([
    inc(1, { priority: 1 }), inc(2, { priority: 2 }), inc(3, { priority: 3 }),
    inc(4, { priority: 3, ageHours: 30 }), inc(5, { priority: 1, state: 6 }),
  ]);
  const r1 = await n8n.runMonitor(NO_LEASE);
  assert.equal(r1.status, 'success', r1.error);
  assert.deepEqual(sink.subjects().map((s) => s.split(' — ')[0]).sort(),
    ['[CRITICAL INCIDENT] ' + num(1), '[HIGH PRIORITY INCIDENT] ' + num(2), '[STALE INCIDENT REMINDER] ' + num(4)].sort());
  const rows = await n8n.alerts();
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.status === 'sent' && r.attempts === 1 && r.ack_token && r.ack_token.length >= 32));
  const r2 = await n8n.runMonitor(NO_LEASE);
  assert.equal(r2.status, 'success', r2.error);
  assert.equal(sink.messages.length, 3, 'second run must not re-send');
});

scenario('alert state survives an n8n restart (no duplicate after restart)', async () => {
  mock.set([inc(1, { priority: 1 })]);
  await n8n.runMonitor(NO_LEASE);
  assert.equal(sink.messages.length, 1);
  await n8n.restart();
  const r = await n8n.runMonitor(NO_LEASE);
  assert.equal(r.status, 'success', r.error);
  assert.equal(sink.messages.length, 1, 'state came back from the database after the restart');
});

scenario('idle cycle: no incidents -> success, no email, only the lock row exists', async () => {
  const r = await n8n.runMonitor(NO_LEASE);
  assert.equal(r.status, 'success', r.error);
  assert.equal(sink.messages.length, 0);
  assert.equal((await n8n.alerts()).length, 0);
});

// ---- pagination -----------------------------------------------------------------------------
const bulk = (n, p1At) => Array.from({ length: n }, (_, i) => inc(i + 1, { priority: p1At.includes(i + 1) ? 1 : 3 }));

scenario('pagination: incidents beyond the old 200-record limit are alerted (450 incidents, 3 pages)', async () => {
  mock.set(bulk(450, [5, 205, 405]));
  const r = await n8n.runMonitor(NO_LEASE);
  assert.equal(r.status, 'success', r.error);
  assert.deepEqual(mock.requests.map((q) => q.offset), ['0', '200', '400']);
  assert.ok(mock.requests.every((q) => q.limit === '200'));
  const ev = nodeJson(r, 'Evaluate Rules');
  assert.equal(ev.incidentCount, 450);
  assert.equal(ev.pageCount, 3);
  assert.deepEqual(sink.subjects().map((s) => /INC\d+/.exec(s)[0]).sort(), [num(5), num(205), num(405)]);
});

scenario('pagination: an exact multiple of the page size (400) ends on an empty page, nothing lost', async () => {
  mock.set(bulk(400, [200, 400]));
  const r = await n8n.runMonitor(NO_LEASE);
  assert.equal(r.status, 'success', r.error);
  assert.deepEqual(mock.requests.map((q) => q.offset), ['0', '200', '400']);
  assert.equal(nodeJson(r, 'Evaluate Rules').incidentCount, 400);
  assert.equal(sink.messages.length, 2);
});

scenario('pagination: page size is configurable (50 -> 10 requests for 450 incidents)', async () => {
  mock.set(bulk(450, [450]));
  const r = await n8n.runMonitor({ ...NO_LEASE, pageSize: 50 });
  assert.equal(r.status, 'success', r.error);
  assert.equal(mock.requests.length, 10);
  assert.equal(nodeJson(r, 'Evaluate Rules').incidentCount, 450);
  assert.equal(sink.messages.length, 1);
});

scenario('pagination: hitting the page cap REFUSES to act on a partial list (no alerts, no state change)', async () => {
  mock.set(bulk(450, [5, 205, 405]));
  const r = await n8n.runMonitor({ ...NO_LEASE, maxPages: 2 });
  assert.equal(r.status, 'error');
  assert.match(r.error, /Pagination cap reached/);
  assert.equal(sink.count(/INCIDENT/), 0, 'no incident alerts from a truncated list');
  assert.equal((await n8n.alerts()).length, 0);
});

// ---- reminders / acknowledgement / escalation -------------------------------------------------
scenario('reminder fires after the interval, exactly once per interval', async () => {
  mock.set([inc(1, { priority: 1 })]);
  await n8n.runMonitor(NO_LEASE);
  await n8n.backdate(key(1), { first_notified_at: 11, last_notified_at: 11 });
  await n8n.runMonitor(NO_LEASE);
  assert.equal(sink.count(/^\[REMINDER\] \[CRITICAL INCIDENT\]/), 1);
  assert.equal((await n8n.row(key(1))).reminder_count, 1);
  await n8n.runMonitor(NO_LEASE);
  assert.equal(sink.count(/REMINDER/), 1, 'no second reminder inside the interval');
});

scenario('acknowledgement: GET only shows a form; POST acknowledges, stops reminders, writes a ServiceNow work note', async () => {
  mock.set([inc(1, { priority: 1 })]);
  await n8n.runMonitor(NO_LEASE);
  const link = ackLink(sink.messages[0]);
  const u = new URL(link);

  const get = await n8n.request('GET', u.pathname + u.search);
  assert.equal(get.status, 200);
  assert.match(get.body, /<form/);
  assert.equal((await n8n.row(key(1))).acked_at, null, 'a GET (e.g. an email link scanner) must not acknowledge');

  const badTok = await n8n.request('POST', u.pathname, { body: `key=${encodeURIComponent(key(1))}&token=${'0'.repeat(48)}&name=x`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(badTok.status, 404);

  const post = await n8n.request('POST', u.pathname, { body: `key=${encodeURIComponent(key(1))}&token=${u.searchParams.get('token')}&name=Sam`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(post.status, 200);
  assert.match(post.body, /acknowledged by Sam/i);
  const row = await n8n.row(key(1));
  assert.ok(row.acked_at); assert.equal(row.acked_by, 'Sam'); assert.equal(row.ack_source, 'email-link');
  assert.equal(mock.patches.length, 1);
  assert.match(mock.patches[0].body.work_notes, /acknowledged via n8n by Sam/);

  const again = await n8n.request('POST', u.pathname, { body: `key=${encodeURIComponent(key(1))}&token=${u.searchParams.get('token')}&name=Other`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.match(again.body, /already acknowledged by Sam/i);
  assert.equal(mock.patches.length, 1, 'idempotent: no second work note');

  await n8n.backdate(key(1), { first_notified_at: 120, last_notified_at: 60 });
  await n8n.runMonitor(NO_LEASE);
  assert.equal(sink.messages.length, 1, 'acknowledged -> no reminder, no escalation');
});

scenario('escalation: unacknowledged critical escalates L1 (30 min) then L2 (60 min), then only reminders', async () => {
  mock.set([inc(1, { priority: 1 })]);
  await n8n.runMonitor(NO_LEASE);

  await n8n.backdate(key(1), { first_notified_at: 31, last_notified_at: 11 });
  await n8n.runMonitor(NO_LEASE);
  const l1 = sink.messages.find((m) => /^\[ESCALATION L1\]/.test(m.subject));
  assert.ok(l1, 'L1 escalation sent');
  assert.deepEqual(l1.to.sort(), ['manager@example.com', 'team@example.com']);
  assert.equal((await n8n.row(key(1))).escalation_level, 1);

  await n8n.backdate(key(1), { first_notified_at: 61, last_notified_at: 11 });
  await n8n.runMonitor(NO_LEASE);
  const l2 = sink.messages.find((m) => /^\[ESCALATION L2\]/.test(m.subject));
  assert.ok(l2, 'L2 escalation sent');
  assert.deepEqual(l2.to.sort(), ['director@example.com', 'team@example.com']);

  await n8n.backdate(key(1), { last_notified_at: 11 });
  await n8n.runMonitor(NO_LEASE);
  assert.equal(sink.count(/ESCALATION/), 2, 'no third escalation level');
  assert.equal(sink.count(/^\[REMINDER\]/), 1, 'plain reminders continue after the last level');
});

scenario('auto-acknowledge: In Progress + assigned stops reminders (new alert, and an existing one)', async () => {
  mock.set([inc(1, { priority: 1, state: 2, assigned: 'Alice' }), inc(2, { priority: 1 })]);
  await n8n.runMonitor(NO_LEASE);
  assert.equal(sink.messages.length, 2, 'the initial alert is still sent for both');
  const r1 = await n8n.row(key(1));
  assert.equal(r1.ack_source, 'servicenow'); assert.ok(r1.acked_at);
  assert.equal((await n8n.row(key(2))).acked_at, null);

  mock.upsert({ number: num(2), state: '2', assigned: 'Bob' });
  await n8n.runMonitor(NO_LEASE);
  assert.equal((await n8n.row(key(2))).ack_source, 'servicenow');
  await n8n.backdate(key(1), { first_notified_at: 120, last_notified_at: 60 });
  await n8n.backdate(key(2), { first_notified_at: 120, last_notified_at: 60 });
  await n8n.runMonitor(NO_LEASE);
  assert.equal(sink.messages.length, 2, 'no reminders for acknowledged alerts');
});

scenario('resolve + reopen: closing stops reminders; a reopened incident starts a fresh cycle with a new ack token', async () => {
  mock.set([inc(1, { priority: 1 })]);
  await n8n.runMonitor(NO_LEASE);
  const token1 = (await n8n.row(key(1))).ack_token;

  mock.upsert({ number: num(1), state: '6' });
  await n8n.runMonitor(NO_LEASE);
  assert.equal((await n8n.row(key(1))).status, 'resolved');
  assert.equal(sink.messages.length, 1, 'no email on resolve');

  mock.upsert({ number: num(1), state: '2', assigned: '' });
  await n8n.runMonitor(NO_LEASE);
  const row = await n8n.row(key(1));
  assert.equal(sink.messages.length, 2, 'reopened -> fresh alert');
  assert.equal(row.status, 'sent'); assert.equal(row.reminder_count, 0);
  assert.notEqual(row.ack_token, token1, 'the old email link cannot acknowledge the new occurrence');
  assert.equal((await n8n.rows()).filter((r) => r.dedup_key === key(1)).length, 1, 'same row reused, no duplicates');

  mock.upsert({ number: num(1), priority: '3' }); // downgraded: critical no longer applies
  await n8n.runMonitor(NO_LEASE);
  assert.equal((await n8n.row(key(1))).status, 'resolved');
});

// ---- concurrency ----------------------------------------------------------------------------
scenario('concurrency / lease: two simultaneous runs -> exactly one proceeds; a third inside the lease is skipped', async () => {
  mock.set([inc(1, { priority: 1 }), inc(2, { priority: 2 }), inc(3, { priority: 3, ageHours: 30 })]);
  const runs = await n8n.runMonitor({}, 2); // default 4-minute lease
  const proceeded = runs.filter((r) => r.nodes.includes('Evaluate Rules'));
  assert.equal(proceeded.length, 1, 'one run owns the lease');
  assert.ok(runs.every((r) => r.status === 'success'), 'the loser exits cleanly, not with an error');
  assert.equal(sink.messages.length, 3, 'each alert sent exactly once');

  const third = await n8n.runMonitor({});
  assert.ok(!third.nodes.includes('Evaluate Rules'), 'skipped inside the lease window');

  await n8n.backdate('__run_lock__', { claimed_at: 5 }); // crashed run: lease expired
  const fourth = await n8n.runMonitor({});
  assert.ok(fourth.nodes.includes('Evaluate Rules'), 'an expired lease is taken over');
  assert.equal(sink.messages.length, 3);
});

scenario('concurrency / claim CAS alone (lease REMOVED): 3 simultaneous runs, 5 due reminders -> 5 emails, not 15', async () => {
  mock.set([1, 2, 3, 4, 5].map((i) => inc(i, { priority: 1 })));
  await n8n.runMonitor(NO_LEASE);
  assert.equal(sink.messages.length, 5);
  for (const i of [1, 2, 3, 4, 5]) await n8n.backdate(key(i), { first_notified_at: 11, last_notified_at: 11 });
  mock.requests = [];
  mock.holdUntil(3); // all three runs fetch, then plan + claim at the same moment
  const runs = await n8n.runMonitor(NO_LEASE, 3, 'nolock');
  assert.equal(mock.requests.length, 3, 'all three runs really overlapped');
  assert.equal(sink.count(/^\[REMINDER\]/), 5, 'every reminder claimed by exactly one run');
  for (const i of [1, 2, 3, 4, 5]) assert.equal((await n8n.row(key(i))).reminder_count, 1);
  assert.ok(runs.every((r) => r.status === 'success'), 'losing a claim is not an error: ' + runs.map((r) => r.error).join('|'));
});

scenario('concurrency / brand-new keys (lease REMOVED): 3 simultaneous runs INSERT the same keys -> still 5 emails', async () => {
  mock.set([1, 2, 3, 4, 5].map((i) => inc(i, { priority: 1 })));
  mock.holdUntil(3);
  const runs = await n8n.runMonitor(NO_LEASE, 3, 'nolock');
  assert.equal(sink.count(/CRITICAL INCIDENT/), 5, 'oldest-row-wins: one email per alert key');
  const rows = await n8n.alerts();
  const dupes = rows.length - 5;
  console.log(`      (${rows.length} rows stored, ${dupes} harmless duplicate row(s) from the lost insert races)`);
  assert.ok(runs.every((r) => r.status === 'success'), runs.map((r) => r.error).join('|'));
  await n8n.runMonitor(NO_LEASE);
  assert.equal(sink.count(/CRITICAL INCIDENT/), 5, 'a later run does not re-send because of the extra rows');
});

// ---- failure scenarios ------------------------------------------------------------------------
scenario('failure / ServiceNow: one transient 500 is retried and the run still succeeds', async () => {
  mock.set([inc(1, { priority: 1 })]);
  mock.fail('status', 1, 500);
  const r = await n8n.runMonitor(NO_LEASE);
  assert.equal(r.status, 'success', r.error);
  assert.equal(mock.requests.length, 2);
  assert.equal(sink.messages.length, 1);
});

scenario('failure / ServiceNow: persistent outage -> run errors, admin is emailed, NO partial state change', async () => {
  mock.set([inc(1, { priority: 1 })]);
  await n8n.runMonitor(NO_LEASE); // a sent row exists
  sink.reset();
  mock.fail('status', 100, 503);
  const r = await n8n.runMonitor(NO_LEASE);
  assert.equal(r.status, 'error');
  assert.equal(r.lastNode, 'Get ServiceNow Incidents', 'the HTTP node itself fails (after its 3 retries)');
  assert.match(r.error, /Service unavailable|503/);
  assert.equal((await n8n.row(key(1))).status, 'sent', 'an outage must not be mistaken for "everything resolved"');
  const admin = await waitFor(() => sink.messages.find((m) => /^\[n8n\] ServiceNow Incident Monitor failed/.test(m.subject)), { label: 'admin email from the error workflow' });
  assert.deepEqual(admin.to, ['admin@example.com']);
  mock.clearFaults();
  const ok = await n8n.runMonitor(NO_LEASE);
  assert.equal(ok.status, 'success', ok.error);
});

scenario('failure / ServiceNow: bad credentials (401) -> run errors, nothing sent, nothing closed', async () => {
  mock.set([inc(1, { priority: 1 })]);
  await n8n.runMonitor(NO_LEASE);
  sink.reset();
  mock.pass = 'wrong-password';
  const r = await n8n.runMonitor(NO_LEASE);
  assert.equal(r.status, 'error');
  assert.equal((await n8n.row(key(1))).status, 'sent');
  mock.pass = 'snpass';
});

scenario('failure / ServiceNow: HTTP 200 HTML (hibernating instance) -> clear error, existing alerts NOT closed', async () => {
  mock.set([inc(1, { priority: 1 })]);
  await n8n.runMonitor(NO_LEASE);
  mock.fail('html200', 100);
  const r = await n8n.runMonitor(NO_LEASE);
  assert.equal(r.status, 'error');
  assert.match(r.error, /no "result" array/);
  assert.equal((await n8n.row(key(1))).status, 'sent');
});

scenario('failure / pagination: a failure on page 2 is retried as a whole; a persistent one produces no partial alerts', async () => {
  mock.set(bulk(450, [5, 205, 405]));
  mock.fail('status', 1, 500, 1); // page 1 ok, page 2 fails once
  const ok = await n8n.runMonitor(NO_LEASE);
  assert.equal(ok.status, 'success', ok.error);
  assert.equal(sink.messages.length, 3, 'complete list after the retry');

  await n8n.resetState(); sink.reset(); mock.clearFaults(); mock.requests = [];
  mock.fail('status', 100, 500, 1);
  const bad = await n8n.runMonitor(NO_LEASE);
  assert.equal(bad.status, 'error');
  assert.equal(sink.count(/INCIDENT\]/), 0, 'page 1 had a P1, but nothing is sent from a partial read');
  assert.equal((await n8n.alerts()).length, 0);
});

scenario('failure / SMTP rejects -> row marked failed with the error; next run retries and sends exactly once', async () => {
  mock.set([inc(1, { priority: 1 })]);
  sink.mode = 'reject';
  const r = await n8n.runMonitor(NO_LEASE);
  assert.equal(r.status, 'error');
  assert.match(r.error, /1 alert email\(s\) failed to send/);
  const row = await n8n.row(key(1));
  assert.equal(row.status, 'failed');
  assert.match(row.last_error, /550/);
  assert.equal(sink.count(/CRITICAL/), 0);

  sink.mode = 'ok';
  const retry = await n8n.runMonitor(NO_LEASE);
  assert.equal(retry.status, 'success', retry.error);
  assert.equal(sink.count(/CRITICAL/), 1, 'delivered once after recovery');
  const after = await n8n.row(key(1));
  assert.equal(after.status, 'sent'); assert.equal(after.last_error, null); assert.equal(after.attempts, 2);
});

scenario('failure / one bad email among several: successes are recorded, only the failure is retried', async () => {
  mock.set([inc(1, { priority: 1 }), inc(2, { priority: 1 })]);
  sink.rejectCount = 1; // the first message of the batch is rejected, the second is accepted
  const r = await n8n.runMonitor(NO_LEASE);
  assert.equal(r.status, 'error', 'a failed send must surface to the error workflow');
  const rows = await n8n.alerts();
  const sent = rows.filter((x) => x.status === 'sent').length;
  const failed = rows.filter((x) => x.status === 'failed').length;
  assert.equal(sent, 1, 'the delivered alert is recorded as sent');
  assert.equal(failed, 1, 'the rejected alert is recorded as failed');
  // (the failed run also makes the error workflow mail the admin, so count only the incident alerts)
  assert.equal(sink.count(/INCIDENT\]/), 1, 'recorded-sent equals actually delivered: no re-send of the batch');
  const retry = await n8n.runMonitor(NO_LEASE);
  assert.equal(retry.status, 'success', retry.error);
  assert.equal(sink.count(/INCIDENT\]/), 2, 'both alerts delivered exactly once in total');
  assert.deepEqual(new Set(sink.messages.filter((m) => /INCIDENT\]/.test(m.subject)).map((m) => /INC\d+/.exec(m.subject)[0])).size, 2, 'two different incidents, no duplicates');
});

// ---- crash scenarios ----------------------------------------------------------------------------
scenario('crash: n8n killed WHILE the email is in flight -> claim recovered, alert delivered (never lost)', async () => {
  mock.set([inc(1, { priority: 1 })]);
  sink.mode = 'hang';
  await n8n.fire('test-monitor', NO_LEASE);
  await waitFor(async () => sink.attempts >= 1 && (await n8n.row(key(1))) && (await n8n.row(key(1))).status === 'pending', { label: 'claim written and send started' });
  n8n.kill();
  sink.mode = 'ok';
  assert.equal(sink.messages.length, 0, 'nothing was delivered before the crash');
  const pending = await n8n.row(key(1));
  assert.equal(pending.status, 'pending', 'the claim survived the crash');

  await n8n.restart();
  const r = await n8n.runMonitor({ runLockMinutes: 0, staleClaimMinutes: 0 });
  assert.equal(r.status, 'success', r.error);
  assert.equal(sink.count(/CRITICAL/), 1, 'delivered exactly once after recovery');
  const row = await n8n.row(key(1));
  assert.equal(row.status, 'sent'); assert.equal(row.attempts, 2); assert.equal(row.last_error, null);
});

scenario('crash: n8n killed AFTER the email was delivered but before it was recorded -> one duplicate (documented at-least-once)', async () => {
  mock.set([inc(1, { priority: 1 })]);
  sink.onData = async () => { n8n.kill(); }; // die after the SMTP server has the message, before 'sent' is stored
  await n8n.fire('test-monitor', NO_LEASE);
  await waitFor(() => sink.messages.length >= 1, { label: 'message delivered' });
  sink.onData = null;
  await sleep(500);
  assert.equal((await n8n.row(key(1))).status, 'pending', 'send was never recorded');

  await n8n.restart();
  const r = await n8n.runMonitor({ runLockMinutes: 0, staleClaimMinutes: 0 });
  assert.equal(r.status, 'success', r.error);
  assert.equal(sink.count(/CRITICAL/), 2, 'at-least-once: the alert is re-sent, never lost');
  assert.equal((await n8n.row(key(1))).status, 'sent');
});

// =============================================================================================
async function main() {
  const snowPort = await mock.start();
  const smtpPort = await sink.start();
  n8n.prepare({ snowUrl: `http://127.0.0.1:${snowPort}`, smtpPort });
  await n8n.start();

  const results = [];
  let failed = 0;
  for (const s of scenarios) {
    const isSetup = s === scenarios[0]; // always run first: it creates the table the rest depend on
    if (only && !isSetup && !s.name.toLowerCase().includes(only.toLowerCase())) continue;
    if (!isSetup) await reset();
    const t0 = Date.now();
    try {
      await s.fn();
      results.push({ name: s.name, ok: true, ms: Date.now() - t0 });
      console.log(`  PASS  ${s.name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      failed += 1;
      results.push({ name: s.name, ok: false, ms: Date.now() - t0, error: e.message });
      console.log(`  FAIL  ${s.name}\n        ${String(e.message).split('\n').join('\n        ')}`);
    }
  }

  fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
  await n8n.stop();
  await mock.stop();
  await sink.stop();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('harness error:', e);
  try { n8n.kill(); } catch (x) { /* ignore */ }
  process.exit(2);
});
