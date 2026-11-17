'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runNode } = require('../lib/code-node');
const { MIN, iso, config, alert, row, evalResult } = require('./fixtures');

const plan = (alerts, rows, cfg = {}) =>
  runNode('plan-actions', { input: rows, nodes: { Config: [config(cfg)], 'Evaluate Rules': evalResult(alerts) } });

test('brand-new alert -> INSERT row (version 1) claimed by this run, with an ack token', () => {
  const [r] = plan([alert('INC1')], []);
  assert.equal(r.version, 1);
  assert.equal(r.status, 'pending');
  assert.equal(r.claim_id, 'run-A');
  assert.equal(r.claim_kind, 'alert');
  assert.ok(r.ack_token && r.ack_token.length >= 32);
});

test('sent, interval NOT elapsed -> nothing to do', () => {
  assert.deepEqual(plan([alert('INC1')], [row('INC1:critical', { last_notified_at: iso(3 * MIN) })]), []);
});

test('sent, reminder interval elapsed -> reminder claim with version+1 (compare-and-swap)', () => {
  const [r] = plan([alert('INC1')], [row('INC1:critical', { version: 7, first_notified_at: iso(12 * MIN), last_notified_at: iso(11 * MIN) })]);
  assert.equal(r.claim_kind, 'reminder');
  assert.equal(r.version, 8);
  assert.equal(r.status, 'pending');
});

test('stale alerts use reminderHours, not the urgent interval', () => {
  assert.deepEqual(plan([alert('INC2', 'stale')], [row('INC2:stale', { last_notified_at: iso(60 * MIN) })]), []);
  const out = plan([alert('INC2', 'stale')], [row('INC2:stale', { last_notified_at: iso(25 * 60 * MIN) })]);
  assert.equal(out[0].claim_kind, 'reminder');
});

test('acknowledged alert gets no reminder and no escalation', () => {
  const rows = [row('INC1:critical', { acked_at: iso(1 * MIN), first_notified_at: iso(120 * MIN), last_notified_at: iso(60 * MIN) })];
  assert.deepEqual(plan([alert('INC1')], rows), []);
});

test('escalation: L1 after 30 min unacked, and it wins over a due reminder', () => {
  const rows = [row('INC1:critical', { first_notified_at: iso(31 * MIN), last_notified_at: iso(11 * MIN), escalation_level: 0 })];
  const [r] = plan([alert('INC1')], rows);
  assert.equal(r.claim_kind, 'escalation');
  assert.equal(r.claim_level, 1);
});

test('escalation: L2 only after L1 is recorded and 60 min have passed', () => {
  const at45 = row('INC1:critical', { first_notified_at: iso(45 * MIN), last_notified_at: iso(2 * MIN), escalation_level: 1 });
  assert.deepEqual(plan([alert('INC1')], [at45]), []);
  const at61 = row('INC1:critical', { first_notified_at: iso(61 * MIN), last_notified_at: iso(11 * MIN), escalation_level: 1 });
  const [r] = plan([alert('INC1')], [at61]);
  assert.equal(r.claim_kind, 'escalation');
  assert.equal(r.claim_level, 2);
});

test('after the last level only plain reminders continue', () => {
  const rows = [row('INC1:critical', { first_notified_at: iso(200 * MIN), last_notified_at: iso(11 * MIN), escalation_level: 2 })];
  assert.equal(plan([alert('INC1')], rows)[0].claim_kind, 'reminder');
});

test('escalation applies only to configured alert types (high is not escalated by default)', () => {
  const rows = [row('INC3:high', { first_notified_at: iso(90 * MIN), last_notified_at: iso(5 * MIN) })];
  assert.deepEqual(plan([alert('INC3', 'high')], rows), []);
  const out = plan([alert('INC3', 'high')], rows, { escalateTypes: 'critical,high' });
  assert.equal(out[0].claim_kind, 'escalation');
});

test('escalation is disabled when no level recipient is configured', () => {
  const rows = [row('INC1:critical', { first_notified_at: iso(90 * MIN), last_notified_at: iso(5 * MIN) })];
  assert.deepEqual(plan([alert('INC1')], rows, { escalateL1Recipient: '', escalateL2Recipient: '' }), []);
});

test('failed row is retried immediately; a never-delivered first alert stays an "alert"', () => {
  const never = row('INC1:critical', { status: 'failed', first_notified_at: null, last_notified_at: null });
  assert.equal(plan([alert('INC1')], [never])[0].claim_kind, 'alert');
  const lateReminder = row('INC1:critical', { status: 'failed', last_notified_at: iso(1 * MIN) });
  assert.equal(plan([alert('INC1')], [lateReminder])[0].claim_kind, 'reminder');
});

test('fresh pending claim (another run mid-send) is left alone', () => {
  assert.deepEqual(plan([alert('INC1')], [row('INC1:critical', { status: 'pending', claimed_at: iso(2 * MIN) })]), []);
});

test('abandoned pending claim (older than staleClaimMinutes) is taken over in ONE compare-and-swap', () => {
  const [r] = plan([alert('INC1')], [row('INC1:critical', { status: 'pending', claimed_at: iso(11 * MIN), version: 4 })]);
  assert.equal(r.status, 'pending');
  assert.equal(r.claim_id, 'run-A');
  assert.equal(r.version, 5);
  assert.equal(r.last_error, 'stale claim recovered');
});

test('resolved row + alert returns -> fresh cycle: counters reset and a NEW ack token', () => {
  const old = row('INC1:critical', { status: 'resolved', reminder_count: 4, escalation_level: 2, acked_at: iso(5 * MIN), ack_token: 'old-token-xxxxxxxxxxxxxxxx' });
  const [r] = plan([alert('INC1')], [old]);
  assert.equal(r.claim_kind, 'alert');
  assert.equal(r.reminder_count, 0);
  assert.equal(r.escalation_level, 0);
  assert.equal(r.acked_at, null);
  assert.notEqual(r.ack_token, 'old-token-xxxxxxxxxxxxxxxx');
  assert.equal(r.first_notified_at, null);
});

test('alert no longer applies (resolved / downgraded) -> row closed as resolved', () => {
  const out = plan([], [row('INC1:critical'), row('INC9:stale', { status: 'failed' })]);
  assert.equal(out.length, 2);
  for (const r of out) {
    assert.equal(r.status, 'resolved');
    assert.ok(r.resolved_at);
  }
});

test('closing never touches an in-flight claim or an already-resolved row', () => {
  const out = plan([], [
    row('INC1:critical', { status: 'pending', claimed_at: iso(1 * MIN) }),
    row('INC2:critical', { status: 'resolved' }),
  ]);
  assert.deepEqual(out, []);
});

test('auto-ack: In Progress + assigned -> acknowledge the sent row, no email', () => {
  const a = alert('INC1', 'critical', { autoAck: true, stateValue: '2' });
  const out = plan([a], [row('INC1:critical', { first_notified_at: iso(60 * MIN), last_notified_at: iso(30 * MIN) })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].ack_source, 'servicenow');
  assert.ok(out[0].acked_at);
  assert.equal(out[0].status, undefined, 'must not become a claim');
});

test('an ack that lands while a reminder is failing settles the row instead of retrying', () => {
  const out = plan([alert('INC1')], [row('INC1:critical', { status: 'failed', acked_at: iso(MIN) })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'sent');
  assert.equal(out[0].claim_id, undefined);
});

test('the run-lock row is never treated as an alert', () => {
  const lock = { id: 99, dedup_key: '__run_lock__', status: 'lock', version: 5, claim_id: 'x', claimed_at: iso(MIN) };
  assert.deepEqual(plan([], [lock]), []);
});

test('duplicate rows for one key: the OLDEST row decides', () => {
  const winner = row('INC1:critical', { id: 5, status: 'sent', last_notified_at: iso(2 * MIN) });
  const loser = row('INC1:critical', { id: 9, status: 'pending', claimed_at: iso(30 * MIN) });
  assert.deepEqual(plan([alert('INC1')], [loser, winner]), []);
});

test('empty table and no alerts -> nothing', () => {
  assert.deepEqual(plan([], [{}]), []);
});

test('every patch has an integer version (needed by the CAS filter)', () => {
  const out = plan(
    [alert('INC1'), alert('INC2'), alert('INC4', 'stale')],
    [row('INC1:critical', { last_notified_at: iso(20 * MIN) }), row('INC2:critical', { status: 'failed' }), row('INC8:critical')]
  );
  assert.ok(out.length >= 3);
  for (const r of out) assert.ok(Number.isInteger(r.version) && r.version >= 1, JSON.stringify(r));
});
