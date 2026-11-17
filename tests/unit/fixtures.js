'use strict';
const MIN = 60 * 1000;
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const config = (over = {}) => ({
  instanceUrl: 'https://dev.service-now.com',
  recipient: 'team@example.com',
  fromEmail: 'alerts@example.com',
  staleHours: 24, reminderHours: 24, alertHigh: true,
  reminderMinutesUrgent: 10, staleClaimMinutes: 10, runLockMinutes: 4,
  pageSize: 200, maxPages: 50, autoAckOnProgress: true,
  ackBaseUrl: 'http://n8n.local/webhook/servicenow-incident-ack',
  escalateTypes: 'critical',
  escalateL1Minutes: 30, escalateL1Recipient: 'manager@example.com',
  escalateL2Minutes: 60, escalateL2Recipient: 'director@example.com',
  runId: 'run-A',
  ...over,
});

// an alert as produced by "Evaluate Rules"
const alert = (number, alertType = 'critical', over = {}) => ({
  number, alertType, dedupKey: `${number}:${alertType}`, stateValue: '1', autoAck: false,
  payload: {
    number, sysId: `sys-${number}`, priority: '1 - Critical', state: 'New', assignedTo: 'Unassigned',
    description: `Problem with ${number}`, lastUpdated: '2026-01-01 10:00:00 UTC', link: `https://x/${number}`, autoAck: false,
  },
  ...over,
});

// a stored row as returned by the Data Table node
let nextId = 1;
const row = (key, over = {}) => {
  const [number, alert_type] = key.split(':');
  return {
    id: nextId++, dedup_key: key, incident_number: number, alert_type, status: 'sent', version: 3, attempts: 1,
    reminder_count: 0, escalation_level: 0, claim_id: 'old-run', claim_kind: 'alert', claim_level: 0,
    claimed_at: iso(60 * MIN), first_notified_at: iso(5 * MIN), last_notified_at: iso(5 * MIN),
    acked_at: null, ack_token: 'tok-' + key, payload: JSON.stringify(alert(number, alert_type).payload),
    ...over,
  };
};

const evalResult = (alerts) => [{ alerts }];

module.exports = { MIN, NOW, iso, config, alert, row, evalResult };
