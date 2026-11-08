// SPDX-License-Identifier: MIT
// Production persistence and HTTP/DBX transport, real ledger, deferred responses.
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'plugin/ui');
const output = path.join(root, 'output/a09-m1-20261108/persistence-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, { recursive: true });
const app = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
const checks = [], hashes = Object.fromEntries(['app.js','stage-json-source.js','stage-persistence.js','creative-stage.js','stage.js'].map(file =>
  [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(web, file))).digest('hex')]));
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const preset = name => ({ version: 1, scene: 'orb', name, bg: { type: 'theme' } });
const initial = () => ({ state: { storeId: 'isolated', current: { revision: 0, initialized: true }, library: { revision: 0, initialized: true } }, current: preset('saved'), library: [] });
function between(start, end) { const i = app.indexOf(start), j = app.indexOf(end, i); assert(i >= 0 && j > i); return app.slice(i, j); }
function harness(options = {}) {
  let id = 0, calls = [];
  const box = { console, AbortController, DOMException, TextEncoder, TextDecoder, Uint8Array, Response,
    URLSearchParams, setTimeout, clearTimeout, queueMicrotask,
    document: { dispatchEvent() {} }, CustomEvent: class { constructor(type, value) { this.type = type; this.detail = value.detail; } },
    StageMedia: { uid: () => 'CAS-' + (++id) }, TOKEN: 'isolated', PlaybackIntent: { command() {} },
    dbxCoverUrl() {}, ensureCover() {}, dbxPlugin: options.dbx,
  };
  box.window = box; vm.createContext(box);
  for (const file of ['stage-resource-budget.js','stage-resource-policy.js','stage-json-source.js'])
    vm.runInContext(fs.readFileSync(path.join(web, file), 'utf8'), box, { filename: file });
  const policy = { ...box.StageResourcePolicy, caps: { ...box.StageResourcePolicy.caps, ...options.caps } };
  const ledger = box.StageResourceBudget.create(policy); box.Stage = { resources: () => ledger };
  let server = initial();
  const api = options.api || {
    async get() { calls.push(['get']); return plain(server); },
    async put(_, request) {
      calls.push(['put', plain(request)]);
      const receipt = { requestId: request.requestId, revision: request.expectedPresetRevision + 1 };
      server[request.target] = plain(request.payload); server.state[request.target] = { revision: receipt.revision, initialized: true, lastCommit: receipt };
      return receipt;
    }
  };
  if (options.dbx || options.fetch) {
    box.fetch = options.fetch;
    vm.runInContext(between('const REQUEST_TIMEOUT', '// 后端错误契约'), box);
    vm.runInContext(between('function splitPath', '// 封面：插件形态'), box);
    vm.runInContext(between('const ServerTransport = {', '// Transport：DBX'), box);
    vm.runInContext(between('const DbxTransport = {', '/// 插件形态的「离场」'), box);
    box.VMusicTransport = vm.runInContext(options.dbx ? 'DbxTransport' : 'ServerTransport', box);
  } else box.VMusicTransport = api;
  vm.runInContext(fs.readFileSync(path.join(web, 'stage-persistence.js'), 'utf8'), box);
  return { box, ledger, persistence: box.StagePersistence, calls, server: () => server };
}
async function check(name, fn) {
  try { const evidence = await fn(); checks.push({ name, passed: true, evidence }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, passed: false, error: error.stack }); console.error('FAIL ' + name + ': ' + error.message); }
}
async function main() {
  await check('read refuses before API and cloning refuses before JSON serialization', async () => {
    const h = harness({ caps: { ownedCpuBytes: 1024 } });
    await assert.rejects(h.persistence.load(null, null), /aggregate-budget/);
    await assert.rejects(h.persistence.save('current', preset('unsaved')), /aggregate-budget/);
    assert.equal(h.calls.length, 0); assert.equal(h.ledger.snapshot().held.ownedCpuBytes, 0);
    return h.ledger.snapshot();
  });
  await check('coalescing retains in-flight and only latest queued source', async () => {
    let complete, writes = [], snapshot = initial();
    const h = harness({ api: { async get() { return plain(snapshot); }, async put(_, body) {
      writes.push(plain(body)); if (writes.length === 1) await new Promise(resolve => { complete = resolve; });
      return { revision: body.expectedPresetRevision + 1, requestId: body.requestId };
    } } });
    await h.persistence.load(null, null); const baseline = h.ledger.snapshot();
    const first = h.persistence.save('current', preset('first')); await tick();
    const second = h.persistence.save('current', preset('second'));
    const third = h.persistence.save('current', preset('latest')); await tick();
    const held = h.ledger.snapshot(true); assert.equal(held.entries.length, baseline.resources + 4);
    complete(); await Promise.all([first, second, third]);
    assert.deepEqual(writes.map(w => w.payload.name), ['first','latest']);
    assert.equal(h.ledger.snapshot().held.ownedCpuBytes, baseline.held.ownedCpuBytes);
    h.persistence.destroy(); assert.equal(h.ledger.snapshot().resources, 0); return { writes, held };
  });
  await check('snapshot shared lease protects retired data and returns exactly once', async () => {
    const h = harness(), old = await h.persistence.load(null, null), lease = h.persistence.borrowSnapshot(old);
    const before = h.ledger.snapshot(true); await h.persistence.reload(); const retired = h.ledger.snapshot(true);
    assert.equal(retired.resources, before.resources + 1); assert.equal(old.current.name, 'saved');
    h.persistence.destroy(); assert.equal(h.ledger.snapshot().resources, 1);
    lease.release(); lease.release(); assert.equal(h.ledger.snapshot().resources, 0); return { before, retired };
  });
  await check('destroy cancels a pending read without claiming settlement', async () => {
    let complete, canceled = false;
    const h = harness({ api: { get(_, options) {
      options.signal.addEventListener('abort', () => { canceled = true; });
      return new Promise(resolve => { complete = resolve; });
    } } });
    const read = h.persistence.load(null, null); await tick(); const before = h.ledger.snapshot(true);
    h.persistence.destroy(); const waiting = h.ledger.snapshot(true);
    assert(canceled); assert.equal(waiting.held.ownedCpuBytes, before.held.ownedCpuBytes); assert(waiting.entries[0].cancelled);
    complete(initial()); await assert.rejects(read, /取消/); assert.equal(h.ledger.snapshot().resources, 0);
    return { before, waiting };
  });
  await check('destroy discards latest queue but retains unresolved original write', async () => {
    let complete, writes = 0;
    const h = harness({ api: { async get() { return initial(); }, put() { writes++; return new Promise(resolve => { complete = resolve; }); } } });
    await h.persistence.load(null, null);
    const first = h.persistence.save('current', preset('first')); await tick();
    const second = h.persistence.save('current', preset('queued')); h.persistence.destroy();
    const waiting = h.ledger.snapshot(true); assert.equal(waiting.resources, 3); assert(waiting.held.ownedCpuBytes > 0);
    complete({ revision: 1 }); await Promise.all([first, second]); assert.equal(writes, 1); assert.equal(h.ledger.snapshot().resources, 0);
    return waiting;
  });
  await check('failed save retains latest edit, receipt recovery never repeats ambiguous write', async () => {
    let server = initial(), mode = 'lost', writes = 0;
    const h = harness({ api: { async get() { return plain(server); }, async put(_, body) {
      writes++; if (mode === 'conflict') throw new Error('conflict');
      const receipt = { revision: body.expectedPresetRevision + 1, requestId: body.requestId };
      server.current = plain(body.payload); server.state.current = { revision: receipt.revision, initialized: true, lastCommit: receipt };
      if (mode === 'lost') throw new Error('lost response'); return receipt;
    } } });
    await h.persistence.load(null, null); await h.persistence.save('current', preset('committed'));
    assert.equal(writes, 1); mode = 'conflict'; await assert.rejects(h.persistence.save('current', preset('unsaved')), /conflict/);
    await assert.rejects(h.persistence.save('current', preset('latest')), /conflict/);
    mode = 'ok'; await h.persistence.retry(); assert.equal(server.current.name, 'latest'); assert.equal(writes, 3);
    h.persistence.destroy(); assert.equal(h.ledger.snapshot().resources, 0); return { writes };
  });
  await check('unexpected getters, cycles and toJSON cannot allocate before a plan', async () => {
    const h = harness(); let getterCalls = 0;
    const value = { get bad() { getterCalls++; return 'wrong'; } }, cycle = {}; cycle.self = cycle;
    for (const input of [value, cycle, { toJSON() { getterCalls++; return 'wrong'; } }])
      await assert.rejects(h.persistence.save('current', input), /estimate-unavailable/);
    assert.equal(getterCalls, 0); assert.equal(h.ledger.snapshot().resources, 0); return { getterCalls };
  });
  await check('sanitized transient URLs own an explicit copy until released', async () => {
    const h = harness(); const clean = h.persistence.sanitize({ scene: 'orb', bg: { type: 'media', url: 'blob:obsolete' } });
    assert.deepEqual(plain(clean.value.bg), { type: 'theme' }); assert(h.ledger.snapshot().held.ownedCpuBytes > 0);
    clean.release(); clean.release(); assert.equal(h.ledger.snapshot().resources, 0); return { removed: clean.removed };
  });
  await check('real HTTP wrappers reserve before request and release body-stream work', async () => {
    let h, observed = [];
    h = harness({ fetch: async (_, options) => {
      observed.push({ method: options.method || 'GET', held: h.ledger.snapshot().held.ownedCpuBytes, body: options.body });
      assert(h.ledger.snapshot().held.ownedCpuBytes > 0); assert.equal(options.jsonBudget, undefined);
      const result = options.method === 'PUT' ? { revision: 1, requestId: JSON.parse(options.body).requestId } : initial();
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    } });
    await h.persistence.load(null, null); await h.persistence.save('current', preset('HTTP'));
    h.persistence.destroy(); assert.equal(h.ledger.snapshot().resources, 0); assert.deepEqual(observed.map(o => o.method), ['GET','PUT']); return observed;
  });
  await check('real DBX wrappers preserve waitForSettlement through a canceled invoke', async () => {
    let h, complete, calls = 0;
    h = harness({ dbx: { invoke() { calls++; assert(h.ledger.snapshot().held.ownedCpuBytes > 0); return new Promise(resolve => { complete = resolve; }); } } });
    const read = h.persistence.load(null, null); await tick(); h.persistence.destroy();
    const waiting = h.ledger.snapshot(true); assert.equal(waiting.resources, 1);
    complete({ status: 200, body: initial() }); await assert.rejects(read, /Aborted/);
    assert.equal(calls, 1); assert.equal(h.ledger.snapshot().resources, 0); return waiting;
  });
  await check('declared HTTP overrun refuses before streaming and does not retry admission', async () => {
    let calls = 0;
    const h = harness({ fetch: async () => { calls++; return new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } }); } });
    await assert.rejects(h.persistence.load(null, null), /estimate-unavailable/);
    // Transport's original single transient retry remains; neither call parses the body.
    assert.equal(calls, 2); assert.equal(h.ledger.snapshot().resources, 0); return { calls };
  });
  const report = { sourceSha256: hashes, checks, passed: checks.every(c => c.passed),
    scope: 'Declared logical JSON and wire representations at original persistence/transport owners. Native DBX host and physical memory qualification remain open.' };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(path.join(output, 'report.json')); if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
