#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
'use strict';
require('./ui-preference-checks.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../plugin/ui/host.js'), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let checks = 0;
function boot(options = {}) {
  const warnings = [], calls = [], timers = new Set();
  const persisted = { value: options.snapshot || {} };
  const dbx = options.native ? null : {
    storage: {
      get(key) { assert.equal(key, 'ui-local-storage'); calls.push(['get']); return options.get ? options.get() : Promise.resolve(persisted.value); },
      async set(key, value) {
        assert.equal(key, 'ui-local-storage'); const copied = JSON.parse(JSON.stringify(value)); calls.push(['set', copied]);
        if (options.set) await options.set(copied);
        persisted.value = copied;
      }
    },
    async saveFile(meta, bytes) { calls.push(['file', meta, Array.from(bytes)]); }
  };
  const context = { dbxPlugin: dbx, TextEncoder, Blob, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    console: { warn: (...args) => warnings.push(args) },
    setTimeout(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    document: { createElement: () => ({ click() { calls.push(['click']); }, remove() {} }), body: { appendChild() {} } }
  };
  context.window = context;
  if (options.native) context.localStorage = options.native;
  else Object.defineProperty(context, 'localStorage', { get() { throw new Error('opaque origin'); }, configurable: true });
  vm.createContext(context); vm.runInContext(source, context, { filename: 'host.js' });
  return { context, host: context.hertzHost, storage: context.localStorage, calls, persisted, warnings,
    close() { for (const timer of timers) clearTimeout(timer); } };
}
async function check(label, run) { await run(); checks++; console.log('PASS ' + label); }
async function main() {
  await check('one delayed hydration preserves untouched host values and pre-hydration edits', async () => {
    const gate = deferred(); const t = boot({ get: () => gate.promise });
    try {
      const read1 = t.host.hydrate(), read2 = t.host.storageReady();
      t.storage.setItem('edited', 'new');
      await delay(10); assert.equal(t.calls.filter(c => c[0] === 'get').length, 1);
      assert.equal(t.calls.filter(c => c[0] === 'set').length, 0);
      gate.resolve(JSON.parse('{"edited":"old","preserved":"yes","__proto__":"literal"}'));
      await Promise.all([read1, read2]); await t.host.flushStorage();
      assert.equal(t.storage.getItem('edited'), 'new'); assert.equal(t.storage.getItem('preserved'), 'yes');
      assert.equal(t.persisted.value.__proto__, 'literal'); assert.equal({}.literal, undefined);
    } finally { t.close(); }
  });
  await check('serialized flush waits for SDK writes and includes edits arriving during them', async () => {
    const gate = deferred(); let writes = 0;
    const t = boot({ set: async () => { if (++writes === 1) await gate.promise; } });
    try {
      await t.host.storageReady(); t.storage.setItem('key', 'one');
      let done = false; const flushing = t.host.flushStorage().then(() => { done = true; });
      await delay(10); t.storage.setItem('key', 'two'); const flushing2 = t.host.flushStorage();
      assert.equal(done, false); assert.equal(writes, 1); gate.resolve();
      await Promise.all([flushing, flushing2]); assert.equal(t.persisted.value.key, 'two'); assert.equal(writes, 2);
    } finally { t.close(); }
  });
  await check('failed SDK import restores only target keys and preserves unrelated concurrent edits', async () => {
    const gate = deferred(); let writes = 0;
    const t = boot({ snapshot: { target: 'old', other: 'original' }, set: async () => { if (++writes === 1) await gate.promise; } });
    try {
      await t.host.storageReady();
      const applying = t.host.applyStorageBatch([{ key: 'target', value: 'new' }]);
      const rejected = assert.rejects(applying, /disk failed/);
      while (!writes) await delay(1);
      t.storage.setItem('other', 'later'); gate.reject(new Error('disk failed')); await rejected;
      assert.equal(t.storage.getItem('target'), 'old'); assert.equal(t.persisted.value.target, 'old');
      assert.equal(t.persisted.value.other, 'later');
    } finally { t.close(); }
  });
  await check('failed SDK rollback remains an explicit uncertain result and can be retried', async () => {
    let broken = true; const t = boot({ snapshot: { target: 'old' }, set: async () => { if (broken) throw new Error('offline'); } });
    try {
      await t.host.storageReady(); await assert.rejects(t.host.applyStorageBatch([{ key: 'target', value: 'new' }]), /恢复尚未确认/);
      assert.equal(t.storage.getItem('target'), 'old'); broken = false;
      await t.host.applyStorageBatch([{ key: 'target', value: 'new' }]); assert.equal(t.persisted.value.target, 'new');
    } finally { t.close(); }
  });
  await check('a failed boot read cannot persist temporary defaults over the unread host snapshot', async () => {
    const t = boot({ snapshot: { target: 'personal' }, get: () => Promise.reject(new Error('read failed')) });
    try {
      await t.host.hydrate(); t.storage.setItem('target', 'default');
      await assert.rejects(t.host.storageReady(), /重新加载/); await assert.rejects(t.host.flushStorage(), /重新加载/);
      assert.equal(t.calls.filter(c => c[0] === 'set').length, 0); assert.equal(t.persisted.value.target, 'personal');
    } finally { t.close(); }
  });
  await check('native Storage quota errors roll back earlier target writes without changing other keys', async () => {
    const values = new Map([['a', 'old'], ['b', 'old'], ['other', 'personal']]); let fail = true;
    const native = { getItem: key => values.get(key) ?? null, setItem(key, value) {
      if (key === 'b' && value === 'new' && fail) { fail = false; throw new Error('quota'); } values.set(key, value);
    }, removeItem(key) { values.delete(key); } };
    const t = boot({ native });
    try {
      await assert.rejects(t.host.applyStorageBatch([{ key: 'a', value: 'new' }, { key: 'b', value: 'new' }]), /quota/);
      assert.equal(values.get('a'), 'old'); assert.equal(values.get('b'), 'old'); assert.equal(values.get('other'), 'personal');
    } finally { t.close(); }
  });
  await check('DBX text export preserves UTF-8 bytes and only reports its confirmed request', async () => {
    const t = boot();
    try {
      const text = '偏好\r\n🎵'; const receipt = await t.host.saveTextFile('prefs.json', 'application/json', text);
      assert.equal(receipt.status, 'requested'); const call = t.calls.find(c => c[0] === 'file');
      assert.equal(Buffer.from(call[2]).toString('utf8'), text); assert.equal(t.calls.some(c => c[0] === 'click'), false);
    } finally { t.close(); }
  });
  await check('native text capability waits for its exact saved or cancelled receipt', async () => {
    const t = boot(); const gate = deferred();
    try {
      t.context.__hertzWindowHost = { downloadVersion: 1, saveTextFile: () => gate.promise };
      let done = false; const saving = t.host.saveTextFile('prefs.json', 'application/json', '{}').then(r => { done = true; return r; });
      await delay(10); assert.equal(done, false); gate.resolve({ status: 'cancelled' });
      assert.equal((await saving).status, 'cancelled'); assert.equal(t.calls.some(c => c[0] === 'file'), false);
    } finally { t.close(); }
  });
  console.log('PASS ' + checks + ' UI preference host persistence and save checks');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
