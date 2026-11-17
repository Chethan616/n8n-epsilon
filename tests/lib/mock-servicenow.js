'use strict';
// A small stand-in for the ServiceNow Table API (GET list with paging, PATCH work notes) with
// fault injection, so reliability scenarios can be repeated deterministically without a live PDI.
const http = require('http');

const PRIORITY = { 1: '1 - Critical', 2: '2 - High', 3: '3 - Moderate', 4: '4 - Low', 5: '5 - Planning' };
const STATE = { 1: 'New', 2: 'In Progress', 3: 'On Hold', 6: 'Resolved', 7: 'Closed', 8: 'Canceled' };
const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

class MockServiceNow {
  constructor({ user = 'snuser', pass = 'snpass' } = {}) {
    this.user = user;
    this.pass = pass;
    this.incidents = [];
    this.requests = []; // every GET /table/incident that reached the handler
    this.patches = [];
    this.faults = []; // [{ kind: 'status'|'html200'|'hang', status, times }]
    this.barrier = null; // { size, held: [] } - hold first-page requests until `size` arrive
    this.server = null;
  }

  incident({ number, priority = 3, state = 1, assigned = '', ageHours = 1, description }) {
    return {
      sys_id: `sys${number}`,
      number,
      priority: String(priority),
      state: String(state),
      assigned,
      short_description: description || `Test incident ${number}`,
      updated_ms: Date.now() - ageHours * 3600 * 1000,
    };
  }

  set(list) { this.incidents = list; }
  upsert(inc) {
    const i = this.incidents.findIndex((x) => x.number === inc.number);
    if (i >= 0) this.incidents[i] = { ...this.incidents[i], ...inc };
    else this.incidents.push(inc);
  }
  /** Make the next `times` requests fail; `skip` lets that many requests through first. */
  fail(kind, times = 1, status = 500, skip = 0) { this.faults.push({ kind, times, status, skip }); }
  clearFaults() { this.faults = []; }
  /** Hold first-page requests until `size` of them have arrived, then release them together. */
  holdUntil(size) { this.barrier = { size, held: [] }; }
  get firstPageRequests() { return this.requests.filter((r) => !r.offset || r.offset === '0'); }

  render(i) {
    return {
      sys_id: { display_value: i.sys_id, value: i.sys_id },
      number: { display_value: i.number, value: i.number },
      priority: { display_value: PRIORITY[i.priority] || i.priority, value: i.priority },
      state: { display_value: STATE[i.state] || i.state, value: i.state },
      assigned_to: i.assigned ? { display_value: i.assigned, value: `usr-${i.assigned}`, link: 'http://x/user' } : '',
      short_description: { display_value: i.short_description, value: i.short_description },
      sys_updated_on: { display_value: fmt(i.updated_ms), value: fmt(i.updated_ms) },
    };
  }

  authorized(req) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const [u, p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    return u === this.user && p === this.pass;
  }

  async handleList(req, res, url) {
    const q = Object.fromEntries(url.searchParams);
    this.requests.push({ at: Date.now(), offset: q.sysparm_offset, limit: q.sysparm_limit, query: q.sysparm_query });

    if (this.barrier && (!q.sysparm_offset || q.sysparm_offset === '0')) {
      const b = this.barrier;
      await new Promise((resolve) => {
        b.held.push(resolve);
        if (b.held.length >= b.size) { b.held.forEach((r) => r()); this.barrier = null; }
      });
    }

    let fault = this.faults.find((f) => f.times > 0);
    if (fault && fault.skip > 0) { fault.skip -= 1; fault = null; } // let the first N requests through
    if (fault) {
      fault.times -= 1;
      if (fault.kind === 'hang') return; // never answers
      if (fault.kind === 'html200') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html><body>Instance Hibernating</body></html>');
      }
      res.writeHead(fault.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'injected failure' }, status: 'failure' }));
    }

    // sysparm_query: "stateNOT IN6,7,8^ORDERBYnumber"
    const closed = /stateNOT IN([\d,]+)/.exec(q.sysparm_query || '');
    const excl = closed ? closed[1].split(',') : [];
    const all = this.incidents
      .filter((i) => !excl.includes(i.state))
      .sort((a, b) => (a.number < b.number ? -1 : 1));
    const limit = Number(q.sysparm_limit || 10000);
    const offset = Number(q.sysparm_offset || 0);
    const page = all.slice(offset, offset + limit);

    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Total-Count': String(all.length) });
    res.end(JSON.stringify({ result: page.map((i) => this.render(i)) }));
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!this.authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'User is not authenticated', detail: 'Required to provide Auth information' }, status: 'failure' }));
    }
    if (req.method === 'GET' && url.pathname === '/api/now/table/incident') return this.handleList(req, res, url);
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/now/table/incident/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        this.patches.push({ sys_id: url.pathname.split('/').pop(), body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: {} }));
      });
      return undefined;
    }
    res.writeHead(404);
    return res.end('not found');
  }

  start(port = 0) {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.listen(port, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }
  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }
}

module.exports = { MockServiceNow };
