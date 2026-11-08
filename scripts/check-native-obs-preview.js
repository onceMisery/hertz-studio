// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const native = fs.readFileSync(path.join(root, 'crates/hertz-studio/src/window.rs'), 'utf8')
  .match(/const HOST_SCRIPT: &str = r#"([\s\S]*?)"#;/)[1];
const app = fs.readFileSync(path.join(root, 'plugin/ui/app.js'), 'utf8');
const actionStart = app.indexOf('if (ui.overlayOpen) {');
const action = app.slice(actionStart, app.indexOf('// 素材通道', actionStart));
const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let count = 0;
function bootNative() {
  const events = new Map(), timers = new Map(), messages = [];
  let timerId = 0, throwIpc = false;
  const window = { addEventListener: (name, handler) => events.set(name, handler), dispatchEvent: event => events.get(event.type)?.(event),
    ipc: { postMessage: raw => { if (throwIpc) throw new Error('IPC unavailable'); messages.push(JSON.parse(raw)); } } };
  const transitions = [];
  const document = { readyState: 'complete', hidden: false, documentElement: { dataset: {} },
    dispatchEvent: event => transitions.push({ type: event.type, browserHidden: document.hidden }) };
  vm.runInNewContext(native, { window, document, crypto: crypto.webcrypto, URL, Blob, Map, Uint8Array,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    getComputedStyle: () => ({ getPropertyValue: () => '#181817' }),
    MutationObserver: class { observe() {} },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id) });
  return { host: window.__hertzWindowHost, messages, transitions, document,
    confirmed: value => events.get('hertz-native-host-confirmed')({ detail: value }),
    receipt: value => events.get('hertz-native-obs-preview-result')({ detail: value }),
    expire: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); },
    setBroken: value => { throwIpc = value; } };
}
function bootAction(host, pendingKey) {
  const calls = [], tab = { location: {}, close: () => calls.push('close') }, ui = { overlayOpen: {} };
  const window = { __hertzWindowHost: host, open: (url, target) => { calls.push(['window.open', url, target]); return tab; } };
  vm.runInNewContext(action, { window, ui, ensureOverlayKey: () => pendingKey.promise,
    overlayUrlWithKey: () => 'http://127.0.0.1:49123/overlay?key=read-only&style=line',
    toast: (...args) => calls.push(['toast', ...args]), errText: (prefix, error) => prefix + ': ' + error.message });
  return { click: ui.overlayOpen.onclick, calls, tab };
}
async function check(name, run) { await run(); count++; console.log('PASS ' + name); }
(async () => {
  await check('native presentation state is versioned, idempotent and independent of browser hidden', async () => {
    const t = bootNative();
    assert.equal(t.host.presentationVersion, 1); assert.equal(t.host.presentationHidden, true);
    t.host.presentationChanged('true'); t.host.presentationChanged(false);
    assert.equal(t.transitions.length, 0, 'invalid/repeated state produces no transition');
    t.host.presentationChanged(true);
    assert.equal(t.host.presentationHidden, false); assert.equal(t.document.hidden, false);
    t.host.presentationChanged(true);
    assert.equal(t.transitions.length, 1, 'repeat restoration produces no notification');
    t.host.presentationChanged(false);
    assert.equal(t.host.presentationHidden, true); assert.equal(t.document.hidden, false);
    assert.equal(t.transitions.length, 2);
    assert.ok(t.transitions.every(event => event.type === 'visibilitychange' && event.browserHidden === false));
    assert.throws(() => { t.host.presentationHidden = false; }, TypeError, 'host fact is exposed through a read-only getter');
  });
  await check('lifecycle readiness is replayed after native confirms this live document', async () => {
    const t = bootNative(); t.host.lifecycleReady(); const before = t.messages.length;
    t.confirmed({ documentId: crypto.randomUUID() }); assert.equal(t.messages.length, before);
    t.confirmed({ documentId: t.host.documentId }); assert.equal(t.messages.at(-1).kind, 'lifecycle-ready');
    assert.equal(t.messages.length, before + 1);
  });
  await check('native open resolves only for the current document and matching request', async () => {
    const t = bootNative(); let done = false;
    const opening = t.host.openObsPreview('http://127.0.0.1:49123/overlay?key=read-only').then(() => { done = true; });
    const request = t.messages.at(-1); assert.equal(request.kind, 'obs-preview');
    t.receipt({ ...request, documentId: crypto.randomUUID(), status: 'opened' });
    t.receipt({ ...request, requestId: crypto.randomUUID(), status: 'opened' });
    await tick(); assert.equal(done, false);
    t.receipt({ ...request, status: 'opened' }); await opening; assert.equal(done, true);
  });
  await check('one pending open, timeout retry and old receipt cannot finish the replacement', async () => {
    const t = bootNative();
    const first = t.host.openObsPreview('first'), firstRejected = assert.rejects(first, /超时/);
    const old = t.messages.at(-1);
    await assert.rejects(t.host.openObsPreview('second'), /正在打开/); t.expire(); await firstRejected;
    let done = false; const second = t.host.openObsPreview('second').then(() => { done = true; });
    t.receipt({ ...old, status: 'opened' }); await tick(); assert.equal(done, false);
    t.receipt({ ...t.messages.at(-1), status: 'opened' }); await second;
  });
  await check('native creation failure and IPC failure reject without poisoning later opens', async () => {
    const t = bootNative(); const pending = t.host.openObsPreview('valid'); const rejected = assert.rejects(pending, /未能打开/);
    t.receipt({ ...t.messages.at(-1), status: 'failed' }); await rejected;
    t.setBroken(true); await assert.rejects(t.host.openObsPreview('valid'), /IPC unavailable/); t.setBroken(false);
    const retry = t.host.openObsPreview('valid'); t.receipt({ ...t.messages.at(-1), status: 'opened' }); await retry;
    await assert.rejects(t.host.openObsPreview('x'.repeat(385)), /地址无效/);
  });
  await check('actual native settings action awaits key and uses the native receipt without window.open', async () => {
    const key = gate(), receipt = gate(), opened = [], t = bootAction({ kind: 'window-host', obsPreviewVersion: 1,
      openObsPreview: url => { opened.push(url); return receipt.promise; } }, key);
    let done = false; const click = t.click().then(() => { done = true; }); await tick();
    assert.equal(opened.length, 0); assert.equal(t.calls.length, 0); key.resolve(); await tick();
    assert.equal(opened.length, 1); assert.equal(done, false); receipt.resolve(); await click; assert.equal(t.calls.length, 0);
  });
  await check('ordinary browser keeps synchronous about:blank reservation and delayed navigation', async () => {
    const key = gate(), t = bootAction(undefined, key); const click = t.click();
    assert.deepEqual(t.calls[0], ['window.open', '', '_blank']); assert.equal(t.tab.location.href, undefined);
    key.resolve(); await click; assert.equal(t.tab.location.href, 'http://127.0.0.1:49123/overlay?key=read-only&style=line');
  });
  await check('native missing capability and key failure show errors without a browser popup fallback', async () => {
    const key = gate(), t = bootAction({ kind: 'window-host' }, key); await t.click();
    assert.equal(t.calls.length, 1); assert.equal(t.calls[0][0], 'toast');
    const failed = gate(), t2 = bootAction({ kind: 'window-host', obsPreviewVersion: 1, openObsPreview: () => { throw new Error('must not open'); } }, failed);
    const click = t2.click(); failed.reject(new Error('key unavailable')); await click;
    assert.equal(t2.calls.length, 1); assert.match(t2.calls[0][1], /key unavailable/);
  });
  console.log('Native OBS preview: ' + count + ' groups passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
