// Turns each claim into its outcome row: 'sent' on success, 'failed' (retried next run) on error.
// A successful send is always recorded, even when other emails in the same batch failed, so one bad
// address cannot cause duplicate retries for incidents that were notified fine.
const claims = $('Select My Claims').all();
const nowIso = new Date().toISOString();
const out = [];

$input.all().forEach((item, i) => {
  const idx = item.pairedItem && item.pairedItem.item !== undefined ? item.pairedItem.item : i;
  const c = claims[idx].json;

  if (item.json && item.json.error) {
    const e = item.json.error;
    const message = typeof e === 'string' ? e : e.message || JSON.stringify(e);
    out.push({
      json: { dedup_key: c.dedup_key, claim_id: c.claim_id, status: 'failed', last_error: String(message).slice(0, 500) },
    });
    return;
  }

  const patch = {
    dedup_key: c.dedup_key,
    claim_id: c.claim_id,
    status: 'sent',
    first_notified_at: c.first_notified_at || nowIso,
    last_notified_at: nowIso,
    last_error: null,
    reminder_count: c.reminder_count + (c.kind === 'reminder' ? 1 : 0),
    escalation_level: c.kind === 'escalation' ? c.level : c.escalation_level,
  };
  if (c.autoAck) {
    patch.acked_at = nowIso;
    patch.acked_by = 'ServiceNow (In Progress)';
    patch.ack_source = 'servicenow';
  }
  out.push({ json: patch });
});

return out;
