'use strict';
// Runs a REAL n8n (the one installed on this machine) in an isolated profile and drives the
// shipped workflows through webhooks. Nothing here touches ~/.n8n.
//
// What differs between a "test copy" and the shipped workflow (everything else is byte-identical):
//   - the Schedule Trigger is swapped for a Webhook (so a test can fire a run on demand)
//   - the Config node is swapped for a Code node returning the same defaults, optionally overridden
//     per run via ?cfg={...} (so one running n8n can exercise many configurations)
//   - credential ids point at the mock ServiceNow / SMTP sink
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const N8N_DIR = process.env.N8N_DIR || path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'n8n');
const N8N_BIN = path.join(N8N_DIR, 'bin', 'n8n');
const MODS = path.join(N8N_DIR, 'node_modules');
const sqlite3 = require(path.join(MODS, 'sqlite3'));
const flatted = require(path.join(MODS, 'flatted'));
const ROOT = path.resolve(__dirname, '..', '..');
const KEY = 'e2e-test-encryption-key-0001';
const TABLE = 'servicenow_alert_state';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

class N8nHarness {
  constructor({ name = 'e2e', port = 5688, brokerPort = 5788, keepHome = false } = {}) {
    this.port = port;
    this.brokerPort = brokerPort;
    this.home = path.join(os.tmpdir(), `n8n-epsilon-${name}`);
    this.keepHome = keepHome;
    this.proc = null;
    this.logFile = path.join(this.home, 'n8n.log');
    this.dbFile = path.join(this.home, '.n8n', 'database.sqlite');
    this.base = `http://127.0.0.1:${port}`;
  }

  env() {
    return {
      ...process.env,
      N8N_USER_FOLDER: this.home,
      N8N_ENCRYPTION_KEY: KEY,
      N8N_PORT: String(this.port),
      N8N_RUNNERS_BROKER_PORT: String(this.brokerPort),
      N8N_DIAGNOSTICS_ENABLED: 'false',
      N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
      N8N_PERSONALIZATION_ENABLED: 'false',
      N8N_TEMPLATES_ENABLED: 'false',
      N8N_HIRING_BANNER_ENABLED: 'false',
      N8N_SECURE_COOKIE: 'false',
      N8N_LOG_LEVEL: 'info',
      EXECUTIONS_DATA_SAVE_ON_ERROR: 'all',
      EXECUTIONS_DATA_SAVE_ON_SUCCESS: 'all',
      WEBHOOK_URL: `${this.base}/`,
    };
  }

  cli(args) {
    const r = spawnSync(process.execPath, [N8N_BIN, ...args], { env: this.env(), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`n8n ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  }

  // ---- workflow preparation ---------------------------------------------------------------
  loadWorkflow(file) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', file), 'utf8'));
  }

  static configDefaults(wf) {
    const cfg = {};
    const set = wf.nodes.find((n) => n.name === 'Config');
    for (const a of set.parameters.assignments.assignments) cfg[a.name] = a.value;
    delete cfg.runId; // computed per execution
    return cfg;
  }

  static setCredIds(wf, ids) {
    for (const n of wf.nodes) {
      for (const [type, ref] of Object.entries(n.credentials || {})) ref.id = ids[type];
    }
  }

  buildTestWorkflows({ snowUrl, smtpPort }) {
    const ids = { httpBasicAuth: 'cred-snow', smtp: 'cred-smtp' };
    const out = {};

    // monitor
    const mon = this.loadWorkflow('servicenow-incident-monitor.json');
    mon.id = 'monitor';
    const defaults = {
      ...N8nHarness.configDefaults(mon),
      instanceUrl: snowUrl,
      recipient: 'team@example.com',
      fromEmail: 'alerts@example.com',
      escalateL1Recipient: 'manager@example.com',
      escalateL2Recipient: 'director@example.com',
      ackBaseUrl: `${this.base}/webhook/servicenow-incident-ack`,
    };
    const trigIdx = mon.nodes.findIndex((n) => n.name === 'Every 5 Minutes');
    mon.nodes[trigIdx] = {
      parameters: { httpMethod: 'GET', path: 'test-monitor', responseMode: 'onReceived', options: {} },
      id: 'test-trigger', name: 'Every 5 Minutes', type: 'n8n-nodes-base.webhook', typeVersion: 2.1,
      position: mon.nodes[trigIdx].position, webhookId: 'aaaaaaaa-1111-4111-8111-000000000001',
    };
    const cfgIdx = mon.nodes.findIndex((n) => n.name === 'Config');
    mon.nodes[cfgIdx] = {
      parameters: {
        jsCode:
          `const defaults = ${JSON.stringify(defaults)};\n` +
          `const q = $input.first().json.query || {};\n` +
          `const over = q.cfg ? JSON.parse(q.cfg) : {};\n` +
          `return [{ json: { ...defaults, ...over, runId: String($execution.id) + '-' + Math.random().toString(36).slice(2, 8) } }];`,
      },
      id: 'test-config', name: 'Config', type: 'n8n-nodes-base.code', typeVersion: 2, position: mon.nodes[cfgIdx].position,
    };
    N8nHarness.setCredIds(mon, ids);
    mon.settings = { ...mon.settings, errorWorkflow: 'errhandler' };
    out.monitor = mon;

    // Variant with the run lease removed (Take Lock -> pass-through) so the per-key claim can be
    // tested ON ITS OWN under true concurrency. The lease itself is covered by the 'monitor' copy.
    const nolock = JSON.parse(JSON.stringify(mon));
    nolock.id = 'monitor_nolock';
    nolock.name = 'ServiceNow Incident Monitor (lease removed for testing)';
    const tr = nolock.nodes.find((n) => n.name === 'Every 5 Minutes');
    tr.parameters.path = 'test-monitor-nolock';
    tr.webhookId = 'aaaaaaaa-1111-4111-8111-000000000003';
    const tl = nolock.nodes.findIndex((n) => n.name === 'Take Lock');
    nolock.nodes[tl] = { parameters: { jsCode: 'return $input.all();' }, id: 'test-no-lock', name: 'Take Lock', type: 'n8n-nodes-base.code', typeVersion: 2, position: nolock.nodes[tl].position };
    out.monitor_nolock = nolock;

    // ack (shipped, only credentials + config values)
    const ack = this.loadWorkflow('servicenow-incident-ack.json');
    ack.id = 'ack';
    const ackCfg = ack.nodes.find((n) => n.name === 'Config');
    for (const a of ackCfg.parameters.assignments.assignments) {
      if (a.name === 'instanceUrl') a.value = snowUrl;
      if (a.name === 'writeBack') a.value = true;
    }
    N8nHarness.setCredIds(ack, ids);
    out.ack = ack;

    // setup: webhook instead of manual trigger
    const setup = this.loadWorkflow('servicenow-monitor-setup.json');
    setup.id = 'setup';
    const mIdx = setup.nodes.findIndex((n) => n.type === 'n8n-nodes-base.manualTrigger');
    const mName = setup.nodes[mIdx].name;
    setup.nodes[mIdx] = {
      parameters: { httpMethod: 'GET', path: 'test-setup', responseMode: 'onReceived', options: {} },
      id: 'test-setup-trigger', name: mName, type: 'n8n-nodes-base.webhook', typeVersion: 2.1,
      position: setup.nodes[mIdx].position, webhookId: 'aaaaaaaa-1111-4111-8111-000000000002',
    };
    out.setup = setup;

    // error handler
    const err = this.loadWorkflow('error-handler.json');
    err.id = 'errhandler';
    N8nHarness.setCredIds(err, ids);
    const mail = err.nodes.find((n) => n.name === 'Email Administrator');
    mail.parameters.fromEmail = 'alerts@example.com';
    mail.parameters.toEmail = 'admin@example.com';
    out.errhandler = err;

    return out;
  }

  prepare({ snowUrl, smtpPort }) {
    fs.rmSync(this.home, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.home, 'wf'), { recursive: true });
    const wfs = this.buildTestWorkflows({ snowUrl, smtpPort });
    for (const [k, wf] of Object.entries(wfs)) {
      fs.writeFileSync(path.join(this.home, 'wf', `${k}.json`), JSON.stringify(wf, null, 2));
    }
    const creds = [
      { id: 'cred-snow', name: 'ServiceNow Basic Auth', type: 'httpBasicAuth', data: { user: 'snuser', password: 'snpass' } },
      { id: 'cred-smtp', name: 'Gmail SMTP', type: 'smtp', data: { host: '127.0.0.1', port: smtpPort, secure: false, user: '', password: '', disableStartTls: true } },
    ];
    fs.writeFileSync(path.join(this.home, 'creds.json'), JSON.stringify(creds, null, 2));
    this.cli(['import:credentials', `--input=${path.join(this.home, 'creds.json')}`]);
    this.cli(['import:workflow', '--separate', `--input=${path.join(this.home, 'wf')}`]);
    for (const id of ['errhandler', 'monitor', 'monitor_nolock', 'ack', 'setup']) this.cli(['publish:workflow', `--id=${id}`]);
  }

  // ---- process lifecycle ------------------------------------------------------------------
  async start() {
    fs.mkdirSync(this.home, { recursive: true });
    const log = fs.openSync(this.logFile, 'a');
    this.proc = spawn(process.execPath, [N8N_BIN, 'start'], { env: this.env(), stdio: ['ignore', log, log], windowsHide: true });
    this.proc.on('exit', () => { this.proc = null; });
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (await this.healthy()) break;
      await sleep(500);
    }
    // webhooks of active workflows register just after the health endpoint comes up
    await this.waitForWebhooks();
  }

  healthy() {
    return new Promise((resolve) => {
      const req = http.get(`${this.base}/healthz`, (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    });
  }

  async waitForWebhooks() {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const log = fs.existsSync(this.logFile) ? fs.readFileSync(this.logFile, 'utf8') : '';
      if (/Editor is now accessible/.test(log)) { await sleep(2500); return; }
      await sleep(500);
    }
    throw new Error('n8n did not become ready');
  }

  kill() {
    if (!this.proc) return;
    spawnSync('taskkill', ['/PID', String(this.proc.pid), '/T', '/F']);
    this.proc = null;
  }

  async stop() {
    this.kill();
    await sleep(1500);
    if (!this.keepHome) { try { fs.rmSync(this.home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  }

  async restart() {
    this.kill();
    await sleep(1500);
    fs.writeFileSync(this.logFile, '');
    await this.start();
  }

  // ---- http -------------------------------------------------------------------------------
  request(method, pathAndQuery, { body, headers } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(this.base + pathAndQuery, { method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async fire(webhookPath, cfg) {
    const q = cfg ? `?cfg=${encodeURIComponent(JSON.stringify(cfg))}` : '';
    for (let i = 0; i < 40; i++) {
      const r = await this.request('GET', `/webhook/${webhookPath}${q}`);
      if (r.status !== 404) return r;
      await sleep(500);
    }
    throw new Error(`webhook ${webhookPath} never became available`);
  }

  // ---- database ---------------------------------------------------------------------------
  db(mode = sqlite3.OPEN_READWRITE) {
    return new Promise((resolve, reject) => {
      const d = new sqlite3.Database(this.dbFile, mode, (e) => (e ? reject(e) : resolve(d)));
    });
  }
  async all(sql, params = []) {
    const d = await this.db();
    d.configure('busyTimeout', 8000);
    try { return await new Promise((res, rej) => d.all(sql, params, (e, r) => (e ? rej(e) : res(r)))); } finally { d.close(); }
  }
  async run(sql, params = []) {
    const d = await this.db();
    d.configure('busyTimeout', 8000);
    try { return await new Promise((res, rej) => d.run(sql, params, function (e) { return e ? rej(e) : res(this.changes); })); } finally { d.close(); }
  }

  async tableName() {
    const t = await this.all('SELECT id FROM data_table WHERE name = ?', [TABLE]);
    return t.length ? `data_table_user_${t[0].id}` : null;
  }
  async rows() {
    const t = await this.tableName();
    return t ? this.all(`SELECT * FROM ${t} ORDER BY id`) : [];
  }
  async alerts() { return (await this.rows()).filter((r) => r.dedup_key !== '__run_lock__'); }
  async row(key) { return (await this.rows()).find((r) => r.dedup_key === key); }
  async lock() { return (await this.rows()).find((r) => r.dedup_key === '__run_lock__'); }

  /** Shift a row's timestamps into the past, e.g. backdate('INC1:critical', { first_notified_at: 31 }) = 31 min ago. */
  async backdate(key, minutesAgo) {
    const t = await this.tableName();
    const sets = []; const params = [];
    for (const [col, min] of Object.entries(minutesAgo)) { sets.push(`${col} = ?`); params.push(sqlTime(Date.now() - min * 60000)); }
    params.push(key);
    return this.run(`UPDATE ${t} SET ${sets.join(', ')} WHERE dedup_key = ?`, params);
  }
  async resetState() {
    const t = await this.tableName();
    if (!t) return;
    await this.run(`DELETE FROM ${t} WHERE dedup_key != '__run_lock__'`);
    await this.run(`UPDATE ${t} SET claim_id = NULL, claimed_at = '1970-01-01 00:00:00.000', version = version + 1 WHERE dedup_key = '__run_lock__'`);
  }

  // ---- executions -------------------------------------------------------------------------
  async executions(workflowId) {
    const rows = await this.all(
      `SELECT e.id, e.workflowId, e.status, e.startedAt, e.stoppedAt FROM execution_entity e
       ${workflowId ? 'WHERE e.workflowId = ?' : ''} ORDER BY e.id`, workflowId ? [workflowId] : []);
    return rows;
  }
  async executionDetail(id) {
    const r = await this.all('SELECT data FROM execution_data WHERE executionId = ?', [id]);
    if (!r.length) return { error: null, nodes: [] };
    const d = flatted.parse(r[0].data);
    const rd = d.resultData || {};
    return {
      error: rd.error ? rd.error.message : null,
      lastNode: rd.lastNodeExecuted,
      nodes: Object.keys(rd.runData || {}),
      runData: rd.runData || {},
    };
  }

  async waitForExecutions(workflowId, count, { timeoutMs = 90000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ex = (await this.executions(workflowId)).filter((e) => ['success', 'error', 'crashed', 'canceled'].includes(e.status));
      if (ex.length >= count) return ex;
      await sleep(400);
    }
    throw new Error(`timed out waiting for ${count} finished executions of ${workflowId}`);
  }

  /** Fire the monitor `times` simultaneously and wait for every resulting execution to finish.
   *  variant 'nolock' uses the copy whose run lease is removed. */
  async runMonitor(cfg, times = 1, variant = 'monitor') {
    const wf = variant === 'nolock' ? 'monitor_nolock' : 'monitor';
    const hook = variant === 'nolock' ? 'test-monitor-nolock' : 'test-monitor';
    const known = (await this.executions(wf)).map((e) => e.id);
    await Promise.all(Array.from({ length: times }, () => this.fire(hook, cfg)));
    const all = await this.waitForExecutions(wf, known.length + times);
    const mine = all.filter((e) => !known.includes(e.id));
    const detailed = [];
    for (const e of mine) detailed.push({ ...e, ...(await this.executionDetail(e.id)) });
    await sleep(300); // let the last DB write land
    return times === 1 ? detailed[0] : detailed;
  }
}

module.exports = { N8nHarness, sleep, sqlTime, N8N_BIN };
