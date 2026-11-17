// GET /servicenow-incident-ack?key=...&token=...
// Email scanners and link previewers issue GET requests automatically, so a GET must never
// acknowledge anything. It only renders a confirmation form; the POST below does the real work.
const q = $input.first().json.query || {};
const esc = (s) =>
  String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Acknowledge incident alert</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#f5f6f8;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.1);padding:28px 32px;max-width:420px;width:90%}
  h1{font-size:20px;margin:0 0 6px} p{color:#444;line-height:1.45} code{background:#eef;padding:2px 6px;border-radius:4px}
  input[type=text]{width:100%;box-sizing:border-box;padding:9px;margin:6px 0 14px;border:1px solid #bbb;border-radius:6px}
  button{background:#c0392b;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:15px;cursor:pointer}
</style></head><body><div class="card">
<h1>Acknowledge alert</h1>
<p>Alert <code>${esc(q.key)}</code></p>
<p>Acknowledging stops further reminders and escalation for this incident. It does not resolve the incident.</p>
<form method="POST" action="">
  <input type="hidden" name="key" value="${esc(q.key)}">
  <input type="hidden" name="token" value="${esc(q.token)}">
  <label>Your name (optional)<input type="text" name="name" maxlength="80" autocomplete="name"></label>
  <button type="submit">Acknowledge</button>
</form></div></body></html>`;

return [{ json: { html, status: 200 } }];
