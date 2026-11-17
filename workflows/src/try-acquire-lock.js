// Decides whether this run may try to take the run lease.
//
// The lease is a row (dedup_key "__run_lock__") in the alert-state Data Table, so it is shared by
// every execution - scheduled, manual, or running on another worker. Workflow static data cannot do
// that: it is only written back when an execution ends, so two overlapping runs overwrite each other.
//
// The lease is time-boxed, never explicitly released, so a crashed run can never leave the workflow
// permanently locked: the lease simply expires after `runLockMinutes`.
const cfg = $('Config').first().json;
const row = $input.all().map((i) => i.json).find((r) => r && r.dedup_key === '__run_lock__');

if (!row) {
  throw new Error(
    'Run-lock row not found in Data Table "servicenow_alert_state". ' +
      'Run the "ServiceNow Monitor - Setup" workflow once, then retry.'
  );
}

const now = Date.now();
const claimedAt = row.claimed_at ? new Date(row.claimed_at).getTime() : 0;
const leaseMs = Number(cfg.runLockMinutes) * 60 * 1000;

if (row.claim_id && claimedAt + leaseMs > now) {
  return []; // another run holds the lease - skip this cycle quietly
}

// Propose taking the lease. "Take Lock" applies it as a compare-and-swap on `version`, so if two
// runs get here at the same moment only one update matches and the other gets nothing back.
return [
  {
    json: {
      dedup_key: '__run_lock__',
      status: 'lock',
      claim_id: cfg.runId,
      claimed_at: new Date(now).toISOString(),
      version: Number(row.version || 0) + 1,
    },
  },
];
