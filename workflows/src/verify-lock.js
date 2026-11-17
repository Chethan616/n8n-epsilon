// "Take Lock" is a compare-and-swap, so it only returns the row if this run's update actually
// matched. Confirm the lease holder is us; otherwise another run won the race and we stop.
const cfg = $('Config').first().json;
const won = $input.all().some((i) => i.json && i.json.claim_id === cfg.runId);
if (!won) return [];
return [{ json: { runId: cfg.runId, lockAcquiredAt: new Date().toISOString() } }];
