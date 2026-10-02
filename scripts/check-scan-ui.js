#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Exercise the actual directory controls and late status replies without a server.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../plugin/ui/app.js'), 'utf8');
function node() {
  return {
    children: [], style: {}, attrs: {},
    append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); },
    replaceChildren() { this.children = []; },
    setAttribute(key, value) { this.attrs[key] = value; },
  };
}
const requests = [];
const mutations = [];
const timers = new Map();
const errors = node();
const ui = {
  scanRoot: {value: 'D:\\Music'}, scanBtn: node(), scanLabel: node(),
  scanRoots: node(), scanCancel: node(), scanBar: node(),
  scanErrors: {...node(), querySelector: () => errors},
};
const context = vm.createContext({
  ui, document: {createElement: node},
  toast() {}, errText: (label, error) => label + ': ' + error.message,
  setTimeout(fn) { const id = {}; timers.set(id, fn); return id; },
  clearTimeout(id) { timers.delete(id); },
  transport: {
    get: (url) => new Promise((resolve, reject) => requests.push({url, resolve, reject})),
    post: async (...args) => mutations.push(['POST', ...args]),
    put: async (...args) => mutations.push(['PUT', ...args]),
    del: async (...args) => mutations.push(['DELETE', ...args]),
  },
});
const start = source.indexOf('async function startScan()');
const end = source.indexOf('async function loadSettings()', start);
assert(start >= 0 && end > start);
vm.runInContext(source.slice(start, end), context);
const run = code => vm.runInContext(code, context);
const flush = () => new Promise(resolve => setImmediate(resolve));
const root = {path: 'D:\\Music', enabled: true, last_error: null, last_scanned_at: 1000};
(async () => {
  const stale = run('loadScanRoots()');
  const fresh = run('loadScanRoots()');
  requests[1].resolve({roots: [root]}); await fresh;
  requests[0].resolve({roots: []}); await stale;
  assert.equal(ui.scanRoots.children.length, 1, 'late roots response cannot erase newer rows');
  requests.length = 0;
  const checkbox = ui.scanRoots.children[0].children[0].children[0];
  checkbox.checked = false;
  const disable = checkbox.onchange(); await flush();
  assert.equal(mutations[0][0], 'PUT');
  assert.equal(mutations[0][2].enabled, false);
  requests.shift().resolve({roots: [{...root, enabled: false}]}); await disable;
  const remove = ui.scanRoots.children[0].children[2];
  const removed = remove.onclick(); await flush();
  assert.equal(mutations[1][1], '/v1/library/roots?path=D%3A%5CMusic');
  requests.shift().resolve({roots: []}); await removed;
  assert.equal(ui.scanRoots.children.length, 0);

  // A terminal WS event arriving during an in-flight GET must trigger another
  // read; otherwise the Cancel button could remain visible indefinitely.
  const inFlight = run('refreshScanStatus()');
  await run('finishScan()');
  assert.equal(timers.size, 1, 'terminal event is retried after current read');
  requests.shift().resolve({running: true, root: root.path, phase: 'scanning',
    done: 2, total: 5, added: 2, updated: 0, skipped: 0, removed: 0, failed: 0, errors: []});
  await inFlight;
  assert.equal(ui.scanCancel.hidden, false);
  const timer = timers.entries().next().value; timers.delete(timer[0]); timer[1]();
  requests.shift().resolve({running: false, root: root.path, phase: 'failed',
    done: 5, total: 5, added: 2, updated: 0, skipped: 2, removed: 0, failed: 1,
    errors: [{path: 'bad.wav', message: 'cannot decode'}]});
  await flush();
  requests.shift().resolve({roots: [root]}); await flush();
  assert.equal(ui.scanCancel.hidden, true);
  assert.equal(ui.scanErrors.hidden, false);
  assert.match(errors.children[0].textContent, /bad.wav.*cannot decode/);
  assert.match(ui.scanLabel.textContent, /失败 1/);
  console.log('Directory controls, stale roots and terminal scan status checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
