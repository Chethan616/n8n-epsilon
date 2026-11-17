#!/usr/bin/env node
/*
 * Assembles the importable n8n workflow JSON files from the readable Code-node sources in
 * workflows/src/. The .js files are the single source of truth for logic; the JSON is generated.
 *
 *   node scripts/build-workflows.js
 *
 * Output (credential NAMES only - never secrets):
 *   workflows/servicenow-incident-monitor.json   main monitor (every 5 min)
 *   workflows/servicenow-incident-ack.json       acknowledgement webhook
 *   workflows/servicenow-monitor-setup.json      one-time setup (table + run lock)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'workflows', 'src');
const OUT = path.join(ROOT, 'workflows');

const src = (name) => fs.readFileSync(path.join(SRC, `${name}.js`), 'utf8').replace(/\r\n/g, '\n');
const TABLE = 'servicenow_alert_state';
const DT_ID = { __rl: true, mode: 'name', value: TABLE };
const DT_TYPE = 'n8n-nodes-base.dataTable';
const AUTO_MAP = { mappingMode: 'autoMapInputData', value: null, matchingColumns: [], schema: [] };

// Columns of the alert-state table (timestamps are real `date` columns).
const COLUMNS = [
  ['dedup_key', 'string'], ['incident_number', 'string'], ['alert_type', 'string'], ['status', 'string'],
  ['incident_state', 'string'], ['payload', 'string'],
  ['claim_id', 'string'], ['claim_kind', 'string'], ['claim_level', 'number'], ['claimed_at', 'date'],
  ['first_notified_at', 'date'], ['last_notified_at', 'date'], ['resolved_at', 'date'],
  ['reminder_count', 'number'], ['escalation_level', 'number'], ['attempts', 'number'], ['version', 'number'],
  ['ack_token', 'string'], ['acked_at', 'date'], ['acked_by', 'string'], ['ack_source', 'string'],
  ['last_error', 'string'],
].map(([name, type]) => ({ name, type }));

const at = (col, row = 0) => [col * 220, row * 200];

function node(id, name, type, typeVersion, parameters, position, extra = {}) {
  return { parameters, id, name, type, typeVersion, position, ...extra };
}
const code = (id, name, file, position, extra) =>
  node(id, name, 'n8n-nodes-base.code', 2, { jsCode: src(file) }, position, extra);

const cond = (keyName, keyValue) => ({ keyName, condition: 'eq', keyValue });
const dtGet = (id, name, position, conditions, extra = {}) =>
  node(id, name, DT_TYPE, 1.1, {
    resource: 'row', operation: 'get', dataTableId: DT_ID,
    matchType: conditions ? 'allConditions' : 'anyCondition',
    ...(conditions ? { filters: { conditions } } : {}),
    returnAll: true, options: {},
  }, position, extra);
const dtUpdate = (id, name, position, conditions, extra = {}) =>
  node(id, name, DT_TYPE, 1.1, {
    resource: 'row', operation: 'update', dataTableId: DT_ID,
    matchType: 'allConditions', filters: { conditions }, columns: AUTO_MAP, options: {},
  }, position, extra);
const dtInsert = (id, name, position, extra = {}) =>
  node(id, name, DT_TYPE, 1.1, {
    resource: 'row', operation: 'insert', dataTableId: DT_ID, columns: AUTO_MAP,
  }, position, extra);

const set = (id, name, position, fields) =>
  node(id, name, 'n8n-nodes-base.set', 3.4, {
    assignments: {
      assignments: fields.map(([n, value, type], i) => ({ id: `${id}-${i}`, name: n, value, type })),
    },
    options: {},
  }, position);

function connect(connections, from, to, fromIndex = 0, toIndex = 0) {
  connections[from] = connections[from] || { main: [] };
  const main = connections[from].main;
  while (main.length <= fromIndex) main.push([]);
  main[fromIndex].push({ node: to, type: 'main', index: toIndex });
}
function chain(connections, names) {
  for (let i = 0; i < names.length - 1; i++) connect(connections, names[i], names[i + 1]);
}

const SMTP = { smtp: { id: '', name: 'Gmail SMTP' } };
const SNOW = { httpBasicAuth: { id: '', name: 'ServiceNow Basic Auth' } };

// =================================================================================================
// 1. Monitor
// =================================================================================================
function buildMonitor() {
  const PAGE = "Number($('Config').first().json.pageSize)";
  const nodes = [
    node('n1', 'Every 5 Minutes', 'n8n-nodes-base.scheduleTrigger', 1.2,
      { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } }, at(0)),

    set('n2', 'Config', at(1), [
      ['instanceUrl', 'https://dev421307.service-now.com', 'string'],
      ['recipient', 'team@yourdomain.com', 'string'],
      ['fromEmail', 'your-workspace-account@yourdomain.com', 'string'],
      ['staleHours', 24, 'number'],
      ['reminderHours', 24, 'number'],
      ['alertHigh', true, 'boolean'],
      ['reminderMinutesUrgent', 10, 'number'],
      ['staleClaimMinutes', 10, 'number'],
      ['runLockMinutes', 4, 'number'],
      ['pageSize', 200, 'number'],
      ['maxPages', 50, 'number'],
      ['autoAckOnProgress', true, 'boolean'],
      ['ackBaseUrl', 'http://localhost:5678/webhook/servicenow-incident-ack', 'string'],
      ['escalateTypes', 'critical', 'string'],
      ['escalateL1Minutes', 30, 'number'],
      ['escalateL1Recipient', 'oncall-manager@yourdomain.com', 'string'],
      ['escalateL2Minutes', 60, 'number'],
      ['escalateL2Recipient', 'engineering-director@yourdomain.com', 'string'],
      ['runId', "={{ $execution.id + '-' + Math.random().toString(36).slice(2, 8) }}", 'string'],
    ]),

    // --- run lease (compare-and-swap on a table row) ---
    dtGet('n3', 'Read Lock', at(2), [cond('dedup_key', '__run_lock__')], { alwaysOutputData: true }),
    code('n4', 'Try Acquire Lock', 'try-acquire-lock', at(3)),
    dtUpdate('n5', 'Take Lock', at(4), [cond('dedup_key', '={{ $json.dedup_key }}'), cond('version', '={{ $json.version - 1 }}')]),
    code('n6', 'Verify Lock', 'verify-lock', at(5)),

    // --- fetch every page of open incidents ---
    node('n7', 'Get ServiceNow Incidents', 'n8n-nodes-base.httpRequest', 4.2, {
      url: "={{ $('Config').first().json.instanceUrl }}/api/now/table/incident",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBasicAuth',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'sysparm_query', value: 'stateNOT IN6,7,8^ORDERBYnumber' },
          { name: 'sysparm_fields', value: 'sys_id,number,priority,state,assigned_to,short_description,sys_updated_on' },
          { name: 'sysparm_display_value', value: 'all' },
          { name: 'sysparm_limit', value: "={{ $('Config').first().json.pageSize }}" },
          { name: 'sysparm_offset', value: '0' },
        ],
      },
      options: {
        pagination: {
          pagination: {
            paginationMode: 'updateAParameterInEachRequest',
            parameters: {
              parameters: [{ type: 'qs', name: 'sysparm_offset', value: `={{ $pageCount * ${PAGE} }}` }],
            },
            paginationCompleteWhen: 'other',
            // Never dereference `result` unguarded: on a 5xx/HTML body it is undefined, the expression would throw,
            // and n8n would swallow the error body as a "page". With the guard the loop ends cleanly on a
            // non-list body (Evaluate Rules then raises a clear error) and n8n itself fails non-2xx pages.
            completeExpression: `={{ !Array.isArray($response.body.result) || $response.body.result.length < ${PAGE} }}`,
            limitPagesFetched: true,
            maxRequests: "={{ Number($('Config').first().json.maxPages) }}",
            requestInterval: 0,
          },
        },
      },
    }, at(6), { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000, credentials: SNOW }),

    code('n8', 'Evaluate Rules', 'evaluate-rules', at(7)),

    // --- decide + claim ---
    dtGet('n9', 'Load Alert State', at(8), null, { alwaysOutputData: true }),
    code('n10', 'Plan Actions', 'plan-actions', at(9)),
    node('n11', 'Route New vs Existing', 'n8n-nodes-base.if', 2.2, {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ id: 'is-new', leftValue: '={{ $json.version }}', rightValue: 1, operator: { type: 'number', operation: 'equals' } }],
        combinator: 'and',
      },
      options: {},
    }, at(10)),
    dtInsert('n12', 'Insert New Alert Rows', at(11, -1)),
    dtUpdate('n13', 'Claim Existing Rows', at(11, 1), [cond('dedup_key', '={{ $json.dedup_key }}'), cond('version', '={{ $json.version - 1 }}')]),
    node('n14', 'Merge Claims', 'n8n-nodes-base.merge', 3, { mode: 'append' }, at(12)),
    dtGet('n15', 'Re-read Alert State', at(13), null, { alwaysOutputData: true, executeOnce: true }),
    code('n16', 'Select My Claims', 'select-my-claims', at(14)),

    // --- send, record, report ---
    node('n17', 'Send Alert Email', 'n8n-nodes-base.emailSend', 2.1, {
      fromEmail: "={{ $('Config').first().json.fromEmail }}",
      toEmail: '={{ $json.to }}',
      subject: '={{ $json.subject }}',
      emailFormat: 'text',
      text: '={{ $json.text }}',
      options: {},
    }, at(15), {
      // NO retryOnFail here: with continue-on-fail, n8n retries by re-running the node with ALL input items,
      // so one failed address would re-send every alert that already succeeded. A failed item is recorded
      // as 'failed' by Resolve Claims and retried individually on the next cycle instead.
      onError: 'continueRegularOutput', credentials: SMTP,
    }),
    code('n18', 'Resolve Claims', 'resolve-claims', at(16)),
    dtUpdate('n19', 'Record Results', at(17), [cond('dedup_key', '={{ $json.dedup_key }}'), cond('claim_id', '={{ $json.claim_id }}'), cond('status', 'pending')]),
    code('n20', 'Raise Failures', 'raise-failures', at(18)),
  ];

  const c = {};
  chain(c, ['Every 5 Minutes', 'Config', 'Read Lock', 'Try Acquire Lock', 'Take Lock', 'Verify Lock',
    'Get ServiceNow Incidents', 'Evaluate Rules', 'Load Alert State', 'Plan Actions', 'Route New vs Existing']);
  connect(c, 'Route New vs Existing', 'Insert New Alert Rows', 0);
  connect(c, 'Route New vs Existing', 'Claim Existing Rows', 1);
  connect(c, 'Insert New Alert Rows', 'Merge Claims', 0, 0);
  connect(c, 'Claim Existing Rows', 'Merge Claims', 0, 1);
  chain(c, ['Merge Claims', 'Re-read Alert State', 'Select My Claims', 'Send Alert Email', 'Resolve Claims', 'Record Results', 'Raise Failures']);

  return { name: 'ServiceNow Incident Monitor', nodes, connections: c, settings: { executionOrder: 'v1' } };
}

// =================================================================================================
// 2. Acknowledgement webhook
// =================================================================================================
function buildAck() {
  const respond = (id, name, position, codeExpr = '={{ $json.status }}') =>
    node(id, name, 'n8n-nodes-base.respondToWebhook', 1.4, {
      respondWith: 'text',
      responseBody: '={{ $json.html }}',
      options: {
        responseCode: codeExpr,
        responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] },
      },
    }, position);
  const webhook = (id, name, method, webhookId, position) =>
    node(id, name, 'n8n-nodes-base.webhook', 2.1,
      { httpMethod: method, path: 'servicenow-incident-ack', responseMode: 'responseNode', options: {} },
      position, { webhookId });
  const ifNode = (id, name, expr, position) =>
    node(id, name, 'n8n-nodes-base.if', 2.2, {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ id: `${id}-c`, leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    }, position);

  const nodes = [
    // GET: confirmation page only (safe against email link scanners)
    webhook('a1', 'Ack Link Opened (GET)', 'GET', '5d1f0c52-8a0e-4b1e-9c11-0a1b2c3d4e01', at(0, 0)),
    code('a2', 'Build Confirmation Page', 'ack-form-page', at(1, 0)),
    respond('a3', 'Show Confirmation Page', at(2, 0)),

    // POST: the actual acknowledgement
    webhook('a4', 'Ack Submitted (POST)', 'POST', '5d1f0c52-8a0e-4b1e-9c11-0a1b2c3d4e02', at(0, 1)),
    set('a5', 'Config', at(1, 1), [
      ['instanceUrl', 'https://dev421307.service-now.com', 'string'],
      ['writeBack', false, 'boolean'],
    ]),
    code('a6', 'Prepare Ack', 'prepare-ack', at(2, 1)),
    dtGet('a7', 'Find Alert Row', at(3, 1), [cond('dedup_key', '={{ $json.key }}'), cond('ack_token', '={{ $json.token }}')], { alwaysOutputData: true }),
    code('a8', 'Apply Ack', 'apply-ack', at(4, 1)),
    ifNode('a9', 'Needs Write?', '={{ $json.write }}', at(5, 1)),
    node('a10', 'Save Acknowledgement', DT_TYPE, 1.1, {
      resource: 'row', operation: 'update', dataTableId: DT_ID, matchType: 'allConditions',
      filters: { conditions: [cond('dedup_key', '={{ $json.dedup_key }}'), cond('version', '={{ $json.version - 1 }}')] },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          acked_at: '={{ $json.acked_at }}',
          acked_by: '={{ $json.acked_by }}',
          ack_source: '={{ $json.ack_source }}',
          version: '={{ $json.version }}',
        },
        matchingColumns: [], schema: [],
      },
      options: {},
    }, at(6, 0), { alwaysOutputData: true }),
    ifNode('a11', 'Write Back To ServiceNow?', "={{ $('Apply Ack').first().json.writeBack && !!$('Apply Ack').first().json.sysId }}", at(7, 0)),
    code('a12', 'Prepare Work Note', 'note-text', at(8, 0)),
    node('a13', 'Write Work Note', 'n8n-nodes-base.httpRequest', 4.2, {
      method: 'PATCH',
      url: "={{ $('Config').first().json.instanceUrl }}/api/now/table/incident/{{ $json.sysId }}",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBasicAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ work_notes: $json.note }) }}',
      options: {},
    }, at(9, 0), { onError: 'continueRegularOutput', credentials: SNOW }),
    code('a14', 'Build Response', 'build-ack-response', at(10, 1)),
    respond('a15', 'Show Result', at(11, 1)),
  ];

  const c = {};
  chain(c, ['Ack Link Opened (GET)', 'Build Confirmation Page', 'Show Confirmation Page']);
  chain(c, ['Ack Submitted (POST)', 'Config', 'Prepare Ack', 'Find Alert Row', 'Apply Ack', 'Needs Write?']);
  connect(c, 'Needs Write?', 'Save Acknowledgement', 0);
  connect(c, 'Needs Write?', 'Build Response', 1);
  connect(c, 'Save Acknowledgement', 'Write Back To ServiceNow?');
  connect(c, 'Write Back To ServiceNow?', 'Prepare Work Note', 0);
  connect(c, 'Write Back To ServiceNow?', 'Build Response', 1);
  chain(c, ['Prepare Work Note', 'Write Work Note', 'Build Response', 'Show Result']);

  return { name: 'ServiceNow Incident Ack', nodes, connections: c, settings: { executionOrder: 'v1' } };
}

// =================================================================================================
// 3. One-time setup
// =================================================================================================
function buildSetup() {
  const nodes = [
    node('s1', "When clicking 'Execute workflow'", 'n8n-nodes-base.manualTrigger', 1, {}, at(0)),
    node('s2', 'Create Alert State Table', DT_TYPE, 1.1, {
      resource: 'table', operation: 'create', tableName: TABLE,
      columns: { column: COLUMNS }, options: { createIfNotExists: true },
    }, at(1), { onError: 'continueRegularOutput' }), // "already exists" is fine - Setup is re-runnable
    dtGet('s3', 'Read Lock Row', at(2), [cond('dedup_key', '__run_lock__')], { alwaysOutputData: true }),
    code('s4', 'Prepare Lock Row', 'prepare-lock-row', at(3)),
    dtInsert('s5', 'Insert Lock Row', at(4)),
  ];
  const c = {};
  chain(c, ["When clicking 'Execute workflow'", 'Create Alert State Table', 'Read Lock Row', 'Prepare Lock Row', 'Insert Lock Row']);
  return { name: 'ServiceNow Monitor - Setup', nodes, connections: c, settings: { executionOrder: 'v1' } };
}

function write(file, wf) {
  fs.writeFileSync(path.join(OUT, file), JSON.stringify(wf, null, 2) + '\n');
  console.log(`wrote workflows/${file}  (${wf.nodes.length} nodes)`);
}

if (require.main === module) {
  write('servicenow-incident-monitor.json', buildMonitor());
  write('servicenow-incident-ack.json', buildAck());
  write('servicenow-monitor-setup.json', buildSetup());
}

module.exports = { buildMonitor, buildAck, buildSetup, COLUMNS, TABLE };
