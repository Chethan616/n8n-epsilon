// Builds the HTML page shown after the POST. Reached either straight from "Apply Ack"
// (nothing to write / rejected) or after the table update.
const plan = $('Apply Ack').first().json;
const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ok = plan.ok;
let status = plan.status;
let message = plan.message;

if (plan.write) {
  // After "Save Acknowledgement": the compare-and-swap returns the row only if it still matched.
  const saved = $('Save Acknowledgement').all().some((i) => i.json && i.json.dedup_key === plan.dedup_key && i.json.acked_at);
  if (!saved) {
    ok = false;
    status = 409;
    message = 'The alert changed while you were acknowledging it. Please click the link in the email again.';
  }
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? 'Acknowledged' : 'Not acknowledged'}</title>
<style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#f5f6f8;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.1);padding:28px 32px;max-width:440px;width:90%}
h1{font-size:20px;margin:0 0 8px;color:${ok ? '#1e8449' : '#c0392b'}}p{color:#444;line-height:1.45}</style></head>
<body><div class="card"><h1>${ok ? 'Acknowledged' : 'Not acknowledged'}</h1><p>${esc(message)}</p></div></body></html>`;

return [{ json: { html, status } }];
