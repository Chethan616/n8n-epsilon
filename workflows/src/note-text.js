// Work note written back to the ServiceNow incident (optional - needs write access on `incident`).
const p = $('Apply Ack').first().json;
return [{ json: { sysId: p.sysId, note: `Alert ${p.dedup_key} acknowledged via n8n by ${p.acked_by} at ${p.acked_at}.` } }];
