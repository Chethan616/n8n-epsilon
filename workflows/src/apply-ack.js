// Decides the outcome of an acknowledgement request. The token is the per-alert secret stored in
// the row, so the email link only ever works for the alert it was sent for - and a re-opened
// incident gets a new token, so an old link cannot acknowledge the new occurrence.
const req = $('Prepare Ack').first().json;
const cfg = $('Config').first().json;
const rows = $input.all().map((i) => i.json);
const row = rows.find((r) => r && r.dedup_key === req.key && r.ack_token === req.token);

const fail = (status, message) => [{ json: { write: false, ok: false, status, message } }];

if (!req.valid || !row) {
  return fail(404, 'This acknowledgement link is invalid or has expired.');
}
if (row.status === 'resolved') {
  return fail(410, `Alert ${row.dedup_key} is already resolved - there is nothing to acknowledge.`);
}
if (row.acked_at) {
  return [{ json: { write: false, ok: true, status: 200, message: `Alert ${row.dedup_key} was already acknowledged by ${row.acked_by || 'someone'}.` } }];
}

let sysId = '';
try {
  sysId = (JSON.parse(row.payload || '{}') || {}).sysId || '';
} catch (e) {
  sysId = '';
}

return [
  {
    json: {
      write: true,
      ok: true,
      status: 200,
      message: `Alert ${row.dedup_key} acknowledged by ${req.name}. Reminders and escalation are stopped.`,
      dedup_key: row.dedup_key,
      version: Number(row.version) + 1, // bumping `version` makes any in-flight claim of this row lose its CAS
      acked_at: new Date().toISOString(),
      acked_by: req.name,
      ack_source: 'email-link',
      sysId,
      writeBack: Boolean(cfg.writeBack),
    },
  },
];
