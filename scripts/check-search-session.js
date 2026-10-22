// SPDX-License-Identifier: MIT
// Run production admission and DBX transport with uncancellable native calls.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ui = path.join(__dirname, '../plugin/ui');
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const box = { window: {}, URLSearchParams, AbortController, DOMException };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(ui, 'search-session.js'), 'utf8'), box);
  const app = fs.readFileSync(path.join(ui, 'app.js'), 'utf8');
  const calls = [];
  box.REQUEST_TIMEOUT = 10000;
  box.splitPath = value => ({ method: value.split('?')[0], query: {} });
  box.dbxPlugin = { invoke(method) {
    return new Promise((resolve, reject) => calls.push({ method, resolve, reject }));
  } };
  vm.runInContext(app.slice(app.indexOf('function dbxInvoke('), app.indexOf('// 封面：插件形态')), box);
  return { box, calls, coordinator: box.HertzSearch,
    transport: { get: (url, options) => box.dbxRequest(url, options) } };
}
async function main() {
  const { calls, coordinator, transport } = setup();
  const a = coordinator.create(transport), b = coordinator.create(transport);
  const a1 = a.get('/search?source=qq').catch(e => e.name);
  const a2 = a.get('/search?source=qq').catch(e => e.name);
  const b1 = b.get('/search?source=netease');
  const b2 = b.get('/search?source=migu');
  await tick();
  assert.equal(calls.length, 2, 'shared page limit is two actual calls; same source serializes');
  a.cancel();
  assert.equal(await a1, 'AbortError'); assert.equal(await a2, 'AbortError');
  await tick();
  assert.equal(calls.length, 2, 'native cancel does not release a running invoke');
  calls[0].resolve({ status: 200, body: { tracks: ['stale'] } });
  await tick();
  assert.equal(calls.length, 3, 'native completion releases the slot; canceled queue never invokes');
  calls[1].resolve({ status: 200, body: { tracks: ['valid'] } });
  calls[2].resolve({ status: 200, body: { tracks: [] } });
  assert.deepEqual(await b1, { tracks: ['valid'] }); await b2; await tick();
  b.cancel();

  const shared = coordinator.create(transport);
  const localSearch = shared.get('/v1/tracks?q=local').catch(e => e.name);
  const sourceCatalog = shared.get('/v1/online/sources', { admissionSource: 'source-catalog' }).catch(e => e.name);
  await tick();
  assert.equal(calls.length, 5, 'source catalog and local search use separate admission lanes');
  shared.cancel();
  assert.equal(await localSearch, 'AbortError');
  assert.equal(await sourceCatalog, 'AbortError');
  calls[3].resolve({ status: 200, body: { tracks: [] } });
  calls[4].resolve({ status: 200, body: { sources: [] } });
  await tick();

  const next = coordinator.create(transport);
  const failure = next.get('/search?source=qq').catch(e => coordinator.failure(e));
  await tick();
  calls[5].resolve({ status: 504, body: { error: {code:'upstream_timeout',message:'deadline',request_id:'req-42'} } });
  const info = await failure;
  assert.equal(info.code, 'upstream_timeout'); assert.equal(info.requestId, 'req-42');
  assert.equal(info.retryable, true); await tick();
  assert.equal(calls.length, 6, 'source failures do not silently retry DBX reads');
  const c = new AbortController(); c.abort();
  const { box, calls: canceledCalls } = setup();
  await assert.rejects(box.dbxInvoke('search', {}, c.signal, true), { name: 'AbortError' });
  assert.equal(canceledCalls.length, 0, 'already canceled requests never invoke');
  for (const status of [401, 403, 404]) assert.equal(coordinator.failure({status}).retryable, false);
  assert.equal(coordinator.failure({code:'provider_not_configured'}).retryable, false);
  assert.equal(coordinator.failure({status:429}).retryable, true);
  assert.equal(coordinator.failure({status:502,code:'upstream_rejected'}).label, '音源拒绝了搜索请求');
  assert.equal(coordinator.failure({status:502,code:'upstream_error'}).label, '音源连接失败，请检查网络');
  assert.equal(coordinator.failure(Object.assign(new TypeError('Failed to fetch'), {name:'TypeError'})).label,
    '音源连接失败，请检查网络');

  const capped = setup(), owner = capped.coordinator.create(capped.transport);
  const pending = Array.from({length:66}, (_, i) => owner.get('/search?source=' + i).catch(e => e.code || e.name));
  const overflow = owner.get('/search?source=overflow').catch(e => e.code);
  assert.equal(await overflow, 'search_busy', 'bounded queue rejects excess work explicitly');
  await tick(); assert.equal(capped.calls.length, 2);
  owner.cancel();
  assert.ok((await Promise.all(pending)).every(value => value === 'AbortError'));
  capped.calls.forEach(call => call.reject(new Error('late native failure')));
  await tick(); assert.equal(capped.calls.length, 2, 'late failures cannot revive canceled queue');
  console.log('Search admission: shared limit, per-source serialization, bounded queue, canceled queue, raw DBX settlement, error facts and no automatic retry passed');
}
const watchdog = setTimeout(() => { console.error('Search admission did not settle'); process.exit(1); }, 3000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
