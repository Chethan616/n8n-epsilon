// Compares the alerts that apply NOW (Evaluate Rules) with the stored alert state (Load Alert State)
// and emits one "patch row" per write that has to happen. Every patch carries the NEW `version`;
// the Data Table update node only applies it if the stored row still has `version - 1`
// (compare-and-swap), which is what makes a claim atomic when two runs race.
//
// Patch rows come in three flavours (all written by the same CAS update):
//   claim        status 'pending' + claim_id = this run  -> an email will be sent for it
//   housekeeping resolve cleared alerts, apply auto-acknowledgements
//   new row      version 1 -> routed to an INSERT instead of an update
//
// Nothing to do  ->  returns [] and the run ends.
const cfg = $('Config').first().json;
const ev = $('Evaluate Rules').first().json;
const now = Date.now();
const nowIso = new Date(now).toISOString();
const MIN = 60 * 1000;
const claimId = cfg.runId;

const urgentMs = Number(cfg.reminderMinutesUrgent) * MIN; // critical / high
const staleReminderMs = Number(cfg.reminderHours) * 60 * MIN; // stale
const staleClaimMs = Number(cfg.staleClaimMinutes) * MIN;
const escalateTypes = String(cfg.escalateTypes || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const levels = [1, 2]
  .map((n) => ({
    level: n,
    afterMs: Number(cfg['escalateL' + n + 'Minutes']) * MIN,
    to: String(cfg['escalateL' + n + 'Recipient'] || '').trim(),
  }))
  .filter((l) => l.to && Number.isFinite(l.afterMs) && l.afterMs > 0);

const ts = (v) => (v ? new Date(v).getTime() : 0);

function newToken() {
  try {
    return require('crypto').randomBytes(24).toString('hex'); // only if the runner allows it
  } catch (e) {
    let s = '';
    for (let i = 0; i < 4; i++) s += Math.random().toString(16).slice(2, 12).padEnd(10, '0');
    return s + now.toString(16);
  }
}

// ---- existing state, one row per key (if duplicates ever exist, the OLDEST row wins) ----------
const byKey = new Map();
for (const item of $input.all()) {
  const r = item.json;
  if (!r || !r.dedup_key || r.dedup_key === '__run_lock__') continue;
  const prev = byKey.get(r.dedup_key);
  if (!prev || Number(r.id) < Number(prev.id)) byKey.set(r.dedup_key, r);
}

// ---- notification policy ------------------------------------------------------------------
// For a row that has been notified at least once and is NOT acknowledged: what is due now?
function dueFor(row, a) {
  const first = ts(row.first_notified_at);
  const last = ts(row.last_notified_at) || first;
  const lvl = Number(row.escalation_level || 0);

  if (escalateTypes.includes(a.alertType)) {
    const next = levels.find((l) => l.level === lvl + 1);
    if (next && now - first >= next.afterMs) return { kind: 'escalation', level: next.level };
  }
  const interval = a.alertType === 'stale' ? staleReminderMs : urgentMs;
  if (now - last >= interval) return { kind: 'reminder', level: lvl };
  return null;
}

// A previous attempt failed or was abandoned: deliver now, regardless of the interval.
function retryKind(row, a) {
  if (!row.first_notified_at) return { kind: 'alert', level: 0 };
  const d = dueFor(row, a);
  if (d && d.kind === 'escalation') return d;
  return { kind: 'reminder', level: Number(row.escalation_level || 0) };
}

const housekeeping = [];
const claims = [];

function claimPatch(row, a, k, extra = {}) {
  return {
    dedup_key: a.dedupKey,
    incident_number: a.number,
    alert_type: a.alertType,
    incident_state: a.stateValue,
    payload: JSON.stringify(a.payload),
    status: 'pending',
    claim_id: claimId,
    claimed_at: nowIso,
    claim_kind: k.kind,
    claim_level: k.level,
    attempts: Number(row.attempts || 0) + 1,
    last_error: null,
    version: Number(row.version) + 1,
    ...extra,
  };
}

// ---- 1. alerts that apply now ----------------------------------------------------------------
for (const a of ev.alerts) {
  const row = byKey.get(a.dedupKey);

  if (!row) {
    claims.push({
      dedup_key: a.dedupKey,
      incident_number: a.number,
      alert_type: a.alertType,
      incident_state: a.stateValue,
      payload: JSON.stringify(a.payload),
      status: 'pending',
      claim_id: claimId,
      claimed_at: nowIso,
      claim_kind: 'alert',
      claim_level: 0,
      reminder_count: 0,
      escalation_level: 0,
      attempts: 1,
      ack_token: newToken(),
      version: 1, // version 1 = brand-new row -> INSERT
    });
    continue;
  }

  const acked = Boolean(row.acked_at);
  const everNotified = Boolean(row.first_notified_at);

  switch (row.status) {
    case 'resolved':
      // The condition came back (reopened / re-escalated): start a completely fresh cycle with a
      // new acknowledgement token, so an old email link cannot acknowledge the new occurrence.
      claims.push(
        claimPatch(row, a, { kind: 'alert', level: 0 }, {
          first_notified_at: null,
          last_notified_at: null,
          resolved_at: null,
          acked_at: null,
          acked_by: null,
          ack_source: null,
          ack_token: newToken(),
          reminder_count: 0,
          escalation_level: 0,
          attempts: 1,
        })
      );
      break;

    case 'pending':
      // Another run is mid-send - unless it died. A claim older than the threshold is abandoned,
      // so take it over directly (recover + claim in one compare-and-swap).
      if (now - ts(row.claimed_at) >= staleClaimMs) {
        if (acked && everNotified) {
          housekeeping.push({ dedup_key: a.dedupKey, status: 'sent', last_error: 'stale claim recovered', version: Number(row.version) + 1 });
        } else {
          claims.push(claimPatch(row, a, retryKind(row, a), { last_error: 'stale claim recovered' }));
        }
      }
      break;

    case 'failed':
      if (acked && everNotified) {
        // acknowledged while a reminder was failing: nothing left to retry
        housekeeping.push({ dedup_key: a.dedupKey, status: 'sent', version: Number(row.version) + 1 });
      } else {
        claims.push(claimPatch(row, a, retryKind(row, a)));
      }
      break;

    case 'sent': {
      if (acked) break; // acknowledged: no reminders, no escalation
      if (a.autoAck) {
        housekeeping.push({
          dedup_key: a.dedupKey,
          acked_at: nowIso,
          acked_by: 'ServiceNow (In Progress)',
          ack_source: 'servicenow',
          version: Number(row.version) + 1,
        });
        break;
      }
      const due = dueFor(row, a);
      if (due) claims.push(claimPatch(row, a, due));
      break;
    }

    default:
      break; // unknown status: leave it alone
  }
}

// ---- 2. close alerts whose condition no longer holds ------------------------------------------
// Resolved, downgraded, or updated-so-no-longer-stale. A later recurrence starts a fresh cycle.
const active = new Set(ev.alerts.map((a) => a.dedupKey));
for (const [key, row] of byKey) {
  if (active.has(key) || row.status === 'resolved') continue;
  const inFlight = row.status === 'pending' && now - ts(row.claimed_at) < staleClaimMs;
  if (inFlight) continue;
  housekeeping.push({ dedup_key: key, status: 'resolved', resolved_at: nowIso, version: Number(row.version) + 1 });
}

return [...housekeeping, ...claims].map((json) => ({ json }));
