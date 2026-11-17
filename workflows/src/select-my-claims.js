// Keeps only the claims THIS run owns and builds the email for each one.
//
// Ownership is re-checked against a fresh read of the table: if a lease failure ever let two runs
// INSERT the same brand-new key (Data Tables have no unique constraint), the row with the lowest id
// wins and the loser drops its claim here, before anything is sent.
const cfg = $('Config').first().json;
const fresh = $input.all().map((i) => i.json);

const oldestId = new Map();
for (const r of fresh) {
  if (!r || !r.dedup_key) continue;
  const cur = oldestId.get(r.dedup_key);
  if (cur === undefined || Number(r.id) < cur) oldestId.set(r.dedup_key, Number(r.id));
}

const TAG = {
  critical: '[CRITICAL INCIDENT]',
  high: '[HIGH PRIORITY INCIDENT]',
  stale: '[STALE INCIDENT REMINDER]',
};
const INTRO = {
  critical: 'A critical incident has been detected in ServiceNow.',
  high: 'A high-priority incident has been detected in ServiceNow.',
  stale: 'An incident has not been updated and is still unresolved.',
};

const seen = new Set();
const out = [];
for (const item of $('Merge Claims').all()) {
  const r = item.json;
  if (!r || r.status !== 'pending' || r.claim_id !== cfg.runId) continue;
  if (seen.has(r.dedup_key)) continue;
  if (oldestId.get(r.dedup_key) !== Number(r.id)) continue; // lost an insert race
  seen.add(r.dedup_key);

  let p = {};
  try {
    p = JSON.parse(r.payload || '{}');
  } catch (e) {
    p = {};
  }
  const kind = r.claim_kind || 'alert';
  const level = Number(r.claim_level || 0);
  const count = Number(r.reminder_count || 0);
  const minutesOpen = r.first_notified_at
    ? Math.round((Date.now() - new Date(r.first_notified_at).getTime()) / 60000)
    : 0;

  const to = [cfg.recipient];
  if (kind === 'escalation') {
    const extra = String(cfg['escalateL' + level + 'Recipient'] || '').trim();
    if (extra) to.push(extra);
  }

  const prefix = kind === 'escalation' ? `[ESCALATION L${level}] ` : kind === 'reminder' ? '[REMINDER] ' : '';
  const subject = `${prefix}${TAG[r.alert_type] || '[INCIDENT]'} ${p.number} — ${p.description}`;

  let intro = INTRO[r.alert_type] || 'An incident needs attention.';
  if (kind === 'reminder') {
    intro = `This incident is still unresolved and has not been acknowledged — reminder #${count + 1}.`;
  } else if (kind === 'escalation') {
    intro =
      `ESCALATION LEVEL ${level}: this incident has not been acknowledged ${minutesOpen} minutes ` +
      'after the first alert. Please take ownership now.';
  }

  const ackLine = cfg.ackBaseUrl
    ? `\nAcknowledge (stops reminders and escalation):\n${cfg.ackBaseUrl}?key=${encodeURIComponent(r.dedup_key)}&token=${r.ack_token}\n`
    : '';

  const text =
    `Hello Team,\n\n${intro}\n\n` +
    `- Incident: ${p.number}\n- Priority: ${p.priority}\n- Status: ${p.state}\n` +
    `- Assigned to: ${p.assignedTo}\n- Description: ${p.description}\n- Last updated: ${p.lastUpdated}\n\n` +
    'Please investigate this incident as soon as possible.\n\n' +
    `View incident: ${p.link}\n${ackLine}`;

  out.push({
    json: {
      dedup_key: r.dedup_key,
      claim_id: r.claim_id,
      kind,
      level,
      autoAck: Boolean(p.autoAck),
      to: to.join(','),
      subject,
      text,
      reminder_count: count,
      escalation_level: Number(r.escalation_level || 0),
      first_notified_at: r.first_notified_at || null,
    },
  });
}
return out;
