'use strict';
// Runs one of the Code-node sources in workflows/src/ against a minimal stand-in for the n8n
// Code-node runtime ($input, $('Node'), $execution). The shipped JSON is generated from these
// exact files, so this tests the real logic, not a copy.
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..', 'workflows', 'src');
const wrap = (rows) => rows.map((json, i) => ({ json, pairedItem: { item: i } }));

/**
 * @param {string} file       source name without .js
 * @param {object} ctx
 * @param {object[]} ctx.input         rows of $input (plain json objects)
 * @param {object} ctx.nodes           { 'Node Name': [json, json, ...] } for $('Node Name')
 * @param {string} [ctx.executionId]
 * @returns {object[]} json of each returned item
 */
function runNode(file, { input = [], nodes = {}, executionId = '1' } = {}) {
  const source = fs.readFileSync(path.join(SRC, `${file}.js`), 'utf8');
  const items = wrap(input);
  const $input = { all: () => items, first: () => items[0], last: () => items[items.length - 1], item: items[0] };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`Node "${name}" hasn't been executed`);
    const list = wrap(nodes[name]);
    return { all: () => list, first: () => list[0], last: () => list[list.length - 1], item: list[0] };
  };
  const fakeRequire = (m) => {
    throw new Error(`Module '${m}' is disallowed`); // same as n8n's task runner default
  };
  const fn = new Function('$input', '$', '$execution', 'require', source);
  const out = fn($input, $, { id: executionId }, fakeRequire);
  return (out || []).map((i) => i.json);
}

module.exports = { runNode };
