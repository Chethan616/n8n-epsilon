'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runNode } = require('../lib/code-node');
const { MIN, iso, config, row } = require('./fixtures');

// ---- Evaluate Rules --------------------------------------------------------------------------
const inc = (number, priority, state, updatedHoursAgo = 1, assigned = '') => ({
  sys_id: { value: 'sys-' + number, display_value: 'sys-' + number },
  number: { value: number, display_value: number },
  priority: { value: String(priority), display_value: `${priority} - X` },
  state: { value: String(state), display_value: 'S' + state },
  assigned_to: assigned ? { value: 'u1', display_value: assigned } : '',
  short_description: { value: 'desc ' + number, display_value: 'desc ' + number },
  sys_updated_on: { value: new Date(Date.now() - updatedHoursAgo * 3600e3).toISOString().slice(0, 19).replace('T', ' '), display_value: '' },
});
const evaluate = (pages, cfg = {}) => runNode('evaluate-rules', { input: pages.map((result) => ({ result })), nodes: { Config: [config(cfg)] } });

test('evaluate: P1 -> critical, P2 -> high, P3 fresh -> nothing, P3 30h old -> stale', () => {
  const [r] = evaluate([[inc('A', 1, 1), inc('B', 2, 1), inc('C', 3, 1), inc('D', 3, 1, 30)]]);
  assert.deepEqual(r.alerts.map((a) => a.dedupKey).sort(), ['A:critical', 'B:high', 'D:stale']);
  assert.equal(r.incidentCount, 4);
});

test('evaluate: resolved/closed/canceled are ignored; P1 30h old raises critical AND stale', () => {
  const [r] = evaluate([[inc('A', 1, 6), inc('B', 1, 7), inc('C', 1, 8), inc('D', 1, 2, 30)]]);
  assert.deepEqual(r.alerts.map((a) => a.dedupKey).sort(), ['D:critical', 'D:stale']);
});

test('evaluate: alertHigh=false suppresses priority-2 alerts', () => {
  const [r] = evaluate([[inc('B', 2, 1)]], { alertHigh: false });
  assert.deepEqual(r.alerts, []);
});

test('evaluate: ALWAYS exactly one output item, even with zero incidents', () => {
  const out = evaluate([[]]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].alerts, []);
});

test('evaluate: merges pages and de-duplicates records that shifted between page requests', () => {
  const [r] = evaluate([[inc('A', 1, 1), inc('B', 1, 1)], [inc('B', 1, 1), inc('C', 1, 1)]], { pageSize: 2 });
  assert.deepEqual(r.alerts.map((a) => a.dedupKey).sort(), ['A:critical', 'B:critical', 'C:critical']);
  assert.equal(r.incidentCount, 3);
  assert.equal(r.pageCount, 2);
});

test('evaluate: REFUSES a truncated list (page cap hit with a full last page)', () => {
  const full = [inc('A', 1, 1), inc('B', 1, 1)];
  assert.throws(() => evaluate([full, full], { pageSize: 2, maxPages: 2 }), /Pagination cap reached/);
});

test('evaluate: hitting the cap with a short last page is fine (list is complete)', () => {
  const out = evaluate([[inc('A', 1, 1), inc('B', 1, 1)], [inc('C', 1, 1)]], { pageSize: 2, maxPages: 2 });
  assert.equal(out[0].incidentCount, 3);
});

test('evaluate: non-JSON / hibernating-instance response fails loudly', () => {
  assert.throws(
    () => runNode('evaluate-rules', { input: [{ data: '<html>Instance hibernating</html>' }], nodes: { Config: [config()] } }),
    /no "result" array/
  );
});

test('evaluate: an API error body is reported as the ServiceNow error, not as "no result array"', () => {
  assert.throws(
    () => runNode('evaluate-rules', { input: [{ error: { message: 'injected failure' }, status: 'failure' }], nodes: { Config: [config()] } }),
    /ServiceNow API error: injected failure/
  );
});

test('evaluate: In Progress + assigned -> autoAck; unassigned or disabled -> not', () => {
  assert.equal(evaluate([[inc('A', 1, 2, 1, 'Alice')]])[0].alerts[0].autoAck, true);
  assert.equal(evaluate([[inc('A', 1, 2, 1, '')]])[0].alerts[0].autoAck, false);
  assert.equal(evaluate([[inc('A', 1, 1, 1, 'Alice')]])[0].alerts[0].autoAck, false);
  assert.equal(evaluate([[inc('A', 1, 2, 1, 'Alice')]], { autoAckOnProgress: false })[0].alerts[0].autoAck, false);
});

// ---- Select My Claims ------------------------------------------------------------------------
const claimRow = (key, over = {}) => row(key, { status: 'pending', claim_id: 'run-A', claim_kind: 'alert', claim_level: 0, ...over });
const select = (claimed, fresh, cfg = {}) =>
  runNode('select-my-claims', { input: fresh, nodes: { Config: [config(cfg)], 'Merge Claims': claimed } });

test('select: builds an alert email with an acknowledgement link containing the row token', () => {
  const c = claimRow('INC1:critical', { ack_token: 'abc123tokenabc123tokenabc123token' });
  const [m] = select([c], [c]);
  assert.match(m.subject, /^\[CRITICAL INCIDENT\] INC1 — /);
  assert.equal(m.to, 'team@example.com');
  assert.match(m.text, /servicenow-incident-ack\?key=INC1%3Acritical&token=abc123tokenabc123tokenabc123token/);
  assert.match(m.text, /A critical incident has been detected/);
});

test('select: reminder gets [REMINDER] and a running count', () => {
  const c = claimRow('INC1:critical', { claim_kind: 'reminder', reminder_count: 2 });
  const [m] = select([c], [c]);
  assert.match(m.subject, /^\[REMINDER\] \[CRITICAL INCIDENT\]/);
  assert.match(m.text, /reminder #3/);
});

test('select: escalation goes to the primary recipient AND that level\'s recipient', () => {
  const c1 = claimRow('INC1:critical', { claim_kind: 'escalation', claim_level: 1 });
  const l1 = select([c1], [c1]);
  assert.equal(l1[0].to, 'team@example.com,manager@example.com');
  assert.match(l1[0].subject, /^\[ESCALATION L1\]/);
  const c2 = claimRow('INC1:critical', { claim_kind: 'escalation', claim_level: 2 });
  assert.equal(select([c2], [c2])[0].to, 'team@example.com,director@example.com');
});

test('select: ignores rows claimed by ANOTHER run, and non-pending rows', () => {
  const other = claimRow('INC1:critical', { claim_id: 'run-B' });
  const done = claimRow('INC2:critical', { status: 'sent' });
  assert.deepEqual(select([other, done], [other, done]), []);
});

test('select: a run that lost an INSERT race (higher id for the same key) drops its claim', () => {
  const winner = claimRow('INC1:critical', { id: 10, claim_id: 'run-B' });
  const mine = claimRow('INC1:critical', { id: 11, claim_id: 'run-A' });
  assert.deepEqual(select([mine], [winner, mine]), []);
  const winnerIsMe = claimRow('INC1:critical', { id: 10, claim_id: 'run-A' });
  const theirs = claimRow('INC1:critical', { id: 11, claim_id: 'run-B' });
  assert.equal(select([winnerIsMe], [winnerIsMe, theirs]).length, 1);
});

test('select: no ackBaseUrl configured -> no acknowledgement line', () => {
  const c = claimRow('INC1:critical');
  assert.doesNotMatch(select([c], [c], { ackBaseUrl: '' })[0].text, /Acknowledge/);
});

// ---- Resolve Claims / Raise Failures ---------------------------------------------------------
const claimItem = (over = {}) => ({
  dedup_key: 'INC1:critical', claim_id: 'run-A', kind: 'alert', level: 0, autoAck: false,
  reminder_count: 0, escalation_level: 0, first_notified_at: null, ...over,
});
const resolve = (claims, results) => runNode('resolve-claims', { input: results, nodes: { 'Select My Claims': claims } });

test('resolve: success -> sent with timestamps; first_notified_at is set once and kept', () => {
  const [a] = resolve([claimItem()], [{ success: true }]);
  assert.equal(a.status, 'sent');
  assert.ok(a.first_notified_at && a.last_notified_at);
  const keep = iso(50 * MIN);
  const [b] = resolve([claimItem({ kind: 'reminder', reminder_count: 1, first_notified_at: keep })], [{ success: true }]);
  assert.equal(b.first_notified_at, keep);
  assert.equal(b.reminder_count, 2);
});

test('resolve: escalation success advances escalation_level', () => {
  const [a] = resolve([claimItem({ kind: 'escalation', level: 2, escalation_level: 1 })], [{ success: true }]);
  assert.equal(a.escalation_level, 2);
});

test('resolve: send error -> failed with the error text, nothing else touched', () => {
  const [a] = resolve([claimItem()], [{ error: 'SMTP 550 rejected' }]);
  assert.equal(a.status, 'failed');
  assert.equal(a.last_error, 'SMTP 550 rejected');
  assert.equal(a.last_notified_at, undefined);
});

test('resolve: one failure among successes -> successes still recorded as sent', () => {
  const out = resolve(
    [claimItem({ dedup_key: 'A:critical' }), claimItem({ dedup_key: 'B:critical' }), claimItem({ dedup_key: 'C:critical' })],
    [{ success: true }, { error: 'boom' }, { success: true }]
  );
  assert.deepEqual(out.map((o) => o.status), ['sent', 'failed', 'sent']);
});

test('resolve: auto-ack claims are acknowledged on success', () => {
  const [a] = resolve([claimItem({ autoAck: true })], [{ success: true }]);
  assert.equal(a.ack_source, 'servicenow');
  assert.ok(a.acked_at);
});

test('raise-failures: throws (-> error workflow) if any claim failed, passes otherwise', () => {
  const failed = [{ dedup_key: 'A:critical', status: 'sent' }, { dedup_key: 'B:critical', status: 'failed', last_error: 'x' }];
  assert.throws(() => runNode('raise-failures', { nodes: { 'Resolve Claims': failed } }), /1 alert email\(s\) failed/);
  assert.equal(runNode('raise-failures', { nodes: { 'Resolve Claims': [failed[0]] } })[0].sent, 1);
});

// ---- Run lock --------------------------------------------------------------------------------
const lockRow = (over = {}) => ({ id: 1, dedup_key: '__run_lock__', status: 'lock', version: 4, claim_id: 'run-X', claimed_at: iso(1 * MIN), ...over });
const tryLock = (rows, cfg = {}) => runNode('try-acquire-lock', { input: rows, nodes: { Config: [config(cfg)] } });

test('lock: free (never taken) -> proposes version+1 held by this run', () => {
  const [p] = tryLock([lockRow({ claim_id: null, claimed_at: '1970-01-01T00:00:00.000Z' })]);
  assert.equal(p.claim_id, 'run-A');
  assert.equal(p.version, 5);
});

test('lock: held within the lease -> returns nothing (cycle skipped quietly)', () => {
  assert.deepEqual(tryLock([lockRow({ claimed_at: iso(2 * MIN) })]), []);
});

test('lock: lease expired (crashed run) -> can be taken over', () => {
  assert.equal(tryLock([lockRow({ claimed_at: iso(5 * MIN) })]).length, 1);
});

test('lock: runLockMinutes=0 disables the lease (used to test the claim CAS on its own)', () => {
  assert.equal(tryLock([lockRow({ claimed_at: iso(1000) })], { runLockMinutes: 0 }).length, 1);
});

test('lock: missing row -> clear "run Setup" error', () => {
  assert.throws(() => tryLock([{}]), /Run the "ServiceNow Monitor - Setup" workflow/);
});

test('verify-lock: continues only if the CAS returned a row held by this run', () => {
  const ok = runNode('verify-lock', { input: [{ claim_id: 'run-A' }], nodes: { Config: [config()] } });
  assert.equal(ok.length, 1);
  assert.deepEqual(runNode('verify-lock', { input: [{ claim_id: 'run-B' }], nodes: { Config: [config()] } }), []);
});

// ---- Ack workflow ----------------------------------------------------------------------------
const ackCfg = (over = {}) => ({ instanceUrl: 'https://x', writeBack: false, ...over });
// the request comes from the webhook node, not from $input (Config sits in between)
const prep = (body, query = {}) =>
  runNode('prepare-ack', { input: [{ instanceUrl: 'x', writeBack: false }], nodes: { 'Ack Submitted (POST)': [{ body, query }] } })[0];
const apply = (req, rows, cfg = {}) => runNode('apply-ack', { input: rows, nodes: { 'Prepare Ack': [req], Config: [ackCfg(cfg)] } })[0];

test('prepare-ack: validates key and token shape', () => {
  assert.equal(prep({ key: 'INC0010001:critical', token: 'a'.repeat(32) }).valid, true);
  assert.equal(prep({ key: "x'; DROP TABLE y;--", token: 'a'.repeat(32) }).valid, false);
  assert.equal(prep({ key: 'INC1:critical', token: 'short' }).valid, false);
  assert.equal(prep({ key: 'INC1:bogus', token: 'a'.repeat(32) }).valid, false);
  assert.equal(prep({}, { key: 'INC1:stale', token: 'b'.repeat(20) }).valid, true);
});

test('apply-ack: valid token on a live alert -> write plan that bumps version', () => {
  const r = row('INC1:critical', { ack_token: 'tokentokentokentoken', version: 6 });
  const out = apply({ key: 'INC1:critical', token: 'tokentokentokentoken', name: 'Sam', valid: true }, [r]);
  assert.equal(out.write, true);
  assert.equal(out.version, 7);
  assert.equal(out.acked_by, 'Sam');
  assert.equal(out.ack_source, 'email-link');
});

test('apply-ack: wrong token, unknown key, resolved, already-acked are all rejected/idempotent', () => {
  const r = row('INC1:critical', { ack_token: 'tokentokentokentoken' });
  assert.equal(apply({ key: 'INC1:critical', token: 'WRONGWRONGWRONGWRONG', name: 'x', valid: true }, [r]).status, 404);
  assert.equal(apply({ key: 'NOPE:critical', token: 'tokentokentokentoken', name: 'x', valid: true }, [r]).status, 404);
  assert.equal(apply({ key: 'INC1:critical', token: 'tokentokentokentoken', name: 'x', valid: true }, [{ ...r, status: 'resolved' }]).status, 410);
  const already = apply({ key: 'INC1:critical', token: 'tokentokentokentoken', name: 'x', valid: true }, [{ ...r, acked_at: iso(MIN), acked_by: 'Pat' }]);
  assert.equal(already.write, false);
  assert.equal(already.ok, true);
  assert.match(already.message, /already acknowledged by Pat/);
});

test('apply-ack: an invalid-shaped request never matches a row, even if the row exists', () => {
  const r = row('INC1:critical', { ack_token: 'tokentokentokentoken' });
  assert.equal(apply({ key: 'INC1:critical', token: 'tokentokentokentoken', name: 'x', valid: false }, [r]).status, 404);
});

test('ack confirmation page escapes attacker-controlled query values', () => {
  const [p] = runNode('ack-form-page', { input: [{ query: { key: '"><script>alert(1)</script>', token: '"onmouseover="x' } }] });
  assert.doesNotMatch(p.html, /<script>alert/);
  assert.match(p.html, /&lt;script&gt;/);
});
