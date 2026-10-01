#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Exercise the production HTTP request helper with abortable response bodies.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../crates/hertz-studio/web/app.js'), 'utf8');
const helper = source.slice(source.indexOf('const REQUEST_TIMEOUT'), source.indexOf('// 后端错误契约'));
function setup(fetch) {
  const timers = new Map(); let seq = 0;
  const box = { AbortController, fetch, TOKEN: 'fixture',
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  vm.createContext(box);
  vm.runInContext(helper + '\nthis.invoke = request;', box);
  return { box, timers };
}
async function run() {
  let calls = 0;
  const pending = setup(async (_url, options) => {
    calls++;
    return { ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })));
    }) };
  });
  const abort = new AbortController();
  const request = pending.box.invoke('/search', { signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.timers.size, 1, 'timeout remains active while reading JSON');
  abort.abort();
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(calls, 1, 'explicit cancellation must not retry');
  assert.equal(pending.timers.size, 0, 'cancel cleans timeout');

  let attempts = 0;
  const retry = setup(async () => {
    if (++attempts === 1) throw new TypeError('network');
    return { ok: true, status: 200, json: async () => ({ tracks: [] }) };
  });
  const recovered = retry.box.invoke('/search');
  await new Promise(resolve => setImmediate(resolve));
  const backoff = [...retry.timers.values()].find(t => t.ms === 300);
  assert.ok(backoff, 'transient reads still retry'); backoff.fn();
  assert.deepEqual(await recovered, { tracks: [] });
  assert.equal(attempts, 2);
  console.log('Transport cancellation, response-body timeout and transient retry checks passed');
}
const watchdog = setTimeout(() => { console.error('Transport test did not settle'); process.exit(1); }, 3000);
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
