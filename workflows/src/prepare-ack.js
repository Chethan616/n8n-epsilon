// POST body: key, token, name (form-encoded). Validate the shape before it touches the table.
// Read the webhook request by node name: `Config` sits between the webhook and this node.
const item = $('Ack Submitted (POST)').first().json;
const b = item.body || {};
const q = item.query || {};
const key = String(b.key !== undefined ? b.key : q.key || '').trim();
const token = String(b.token !== undefined ? b.token : q.token || '').trim();
const name = String(b.name || '').trim().slice(0, 80) || 'email link';

const validKey = /^[A-Za-z0-9_-]{3,40}:(critical|high|stale)$/.test(key);
const validToken = /^[A-Za-z0-9-]{16,100}$/.test(token);
return [{ json: { key, token, name, valid: validKey && validToken } }];
