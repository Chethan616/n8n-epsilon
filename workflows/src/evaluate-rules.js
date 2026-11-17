// Turns the (paginated) ServiceNow response into the list of alerts that currently apply.
// Always returns exactly ONE item so the rest of the run still executes when there are no alerts
// (that is when "close cleared alerts" matters most).
const cfg = $('Config').first().json;
const staleMs = Number(cfg.staleHours) * 3600 * 1000;
const pageSize = Number(cfg.pageSize);
const maxPages = Number(cfg.maxPages);
const now = Date.now();
const val = (f) => (f && typeof f === 'object' ? f.value : f);
const disp = (f) => (f && typeof f === 'object' ? f.display_value || f.value : f);
const CLOSED_STATES = ['6', '7', '8']; // Resolved, Closed, Canceled

// ---- 1. Collect every page --------------------------------------------------------------
const pages = $input.all();
const incidents = [];
const seen = new Set();
let lastPageLength = 0;

for (const page of pages) {
  const result = page.json && page.json.result;
  if (!Array.isArray(result)) {
    // an API error body, e.g. {"error": {"message": ...}, "status": "failure"}
    const apiError = page.json && page.json.error;
    if (apiError) {
      const msg = typeof apiError === 'string' ? apiError : apiError.message || JSON.stringify(apiError);
      throw new Error(`ServiceNow API error: ${msg}`);
    }
    // e.g. a hibernating instance returns an HTML page with HTTP 200
    throw new Error(
      'Unexpected ServiceNow response: no "result" array. The instance may be hibernating, ' +
        'or the account may be blocked by Basic Auth restrictions.'
    );
  }
  lastPageLength = result.length;
  for (const r of result) {
    const id = val(r.sys_id) || val(r.number);
    if (seen.has(id)) continue; // offset paging can overlap if records move between requests
    seen.add(id);
    incidents.push(r);
  }
}

// ---- 2. Refuse to act on a truncated list -----------------------------------------------
// Closing "cleared" alerts is only safe if we saw EVERY open incident. If we hit the page cap with
// a full last page there may be more, so fail loudly (the error workflow emails the admin).
if (pages.length >= maxPages && lastPageLength >= pageSize) {
  throw new Error(
    `Pagination cap reached (${maxPages} pages x ${pageSize} records) and more incidents may exist. ` +
      'Refusing to evaluate a partial incident list. Raise maxPages or narrow the query.'
  );
}

// ---- 3. Apply the alert rules -----------------------------------------------------------
const alerts = [];
for (const r of incidents) {
  const stateValue = String(val(r.state));
  if (CLOSED_STATES.includes(stateValue)) continue;

  const number = val(r.number);
  const priority = String(val(r.priority));
  const updatedMs = new Date(String(val(r.sys_updated_on)).replace(' ', 'T') + 'Z').getTime();
  const assignedTo = disp(r.assigned_to) || '';

  const types = [];
  if (priority === '1') types.push('critical');
  if (priority === '2' && cfg.alertHigh) types.push('high');
  if (Number.isFinite(updatedMs) && now - updatedMs >= staleMs) types.push('stale');

  // Someone has picked it up: In Progress (2) and assigned. Treated as an implicit acknowledgement.
  const autoAck = Boolean(cfg.autoAckOnProgress) && stateValue === '2' && assignedTo !== '';

  for (const alertType of types) {
    alerts.push({
      number,
      alertType,
      dedupKey: `${number}:${alertType}`,
      stateValue,
      autoAck,
      payload: {
        number,
        sysId: val(r.sys_id),
        priority: disp(r.priority),
        state: disp(r.state),
        assignedTo: assignedTo || 'Unassigned',
        description: disp(r.short_description),
        lastUpdated: `${val(r.sys_updated_on)} UTC`,
        link: `${cfg.instanceUrl}/nav_to.do?uri=incident.do?sys_id=${val(r.sys_id)}`,
        autoAck,
      },
    });
  }
}

return [
  {
    json: {
      alerts,
      incidentCount: incidents.length,
      pageCount: pages.length,
    },
  },
];
