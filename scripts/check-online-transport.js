#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Exercise production connection bootstrap, DBX event ownership and HTTP requests.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../plugin/ui/app.js'), 'utf8');
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
  // Run the actual connection bootstrap: HTTP needs a fresh ticket on every
  // handshake, while non-HTTP transports must reach their own event bridge.
  const bootstrap = source.slice(source.indexOf('let socket = null;'), source.indexOf('// 事件总线'));
  for (const kind of ['server', 'dbx', 'demo']) {
    const calls = []; let ticket = 0;
    const box = { handleEvent() {},
      transport: { kind, connect(_handler, credential) {
        calls.push(['connect', credential]); return { close() { calls.push(['close']); } };
      } },
      async issueTicket() { calls.push(['ticket']); return { ticket: 'one-use-' + (++ticket) }; },
      scheduleReconnect() { calls.push(['retry']); }, encodeURIComponent };
    vm.createContext(box); vm.runInContext(bootstrap + '\nthis.open = openSocket;', box);
    await box.open(); await box.open();
    assert.deepEqual(calls, kind === 'server'
      ? [['ticket'], ['connect', 'ticket=one-use-1'], ['close'], ['ticket'], ['connect', 'ticket=one-use-2']]
      : [['connect', undefined], ['close'], ['connect', undefined]], kind + ' connection ownership');
    if (kind === 'server') {
      calls.length = 0; box.issueTicket = async () => null; await box.open();
      assert.deepEqual(calls, [['close'], ['retry']], 'failed HTTP ticket never opens a socket');
    }
  }

  // Run the real DBX implementation as well as the generic bootstrap stubs.
  // A reconnect must retire the old listener and ignore its late completion;
  // a failure on the active subscription must still reach the retry owner,
  // and a recovered subscription must refresh the open AI task panel.
  const connectionSource = source.slice(source.indexOf('function onConnectionChange(ok)'), source.indexOf('function scheduleReconnect()'));
  const dbxSource = source.slice(source.indexOf('const DbxTransport = {'), source.indexOf('const REQUEST_TIMEOUT'));

  const initialRecovery = [];
  const firstConnection = {
    state: { connected: false },
    ui: { conn: { textContent: '', className: '' }, offlineBanner: { hidden: true } },
    window: { Workshop: { onAiTask() { initialRecovery.push('aiTasks'); } } },
    Workshop: { onAiTask() { initialRecovery.push('aiTasks'); } },
    refreshAll() { initialRecovery.push('fullRefresh'); },
    restoreQueue() { initialRecovery.push('queue'); },
    refreshLibraryInPlace() { initialRecovery.push('library'); },
    loadPlaylists() { initialRecovery.push('playlists'); },
  };
  vm.createContext(firstConnection);
  vm.runInContext('let retries = 0; let missedWhileOffline = false; let hasConnected = false;\n'
    + connectionSource + '\nthis.connectionChanged = onConnectionChange;', firstConnection);
  firstConnection.connectionChanged(true);
  assert.deepEqual(initialRecovery, ['queue', 'library', 'playlists', 'aiTasks'],
    'first event connection reconciles event-backed data without reloading settings');
  firstConnection.connectionChanged(false);
  firstConnection.connectionChanged(true);
  assert.deepEqual(initialRecovery,
    ['queue', 'library', 'playlists', 'aiTasks', 'fullRefresh', 'aiTasks'],
    'later reconnect keeps the full state refresh path');

  const subscriptions = [], requests = [], messages = [], recoveryReads = [];
  const workshop = { onAiTask() { recoveryReads.push('aiTasks'); } };
  let reconnects = 0, removals = 0;
  const dbx = {
    DBX_EVENT_METHOD: 'studio/event', DBX_SUBSCRIBE_METHOD: 'studio/events/subscribe',
    Workshop: workshop,
    state: { connected: false },
    ui: { conn: { textContent: '', className: '' }, offlineBanner: { hidden: true } },
    refreshAll() { recoveryReads.push('refreshAll'); },
    restoreQueue() { recoveryReads.push('queue'); },
    refreshLibraryInPlace() { recoveryReads.push('library'); },
    loadPlaylists() { recoveryReads.push('playlists'); },
    dbxCoverUrl() {}, ensureCover() {}, console: { warn() {} },
    window: { dbxPlugin: {
      onEvent(listener) {
        subscriptions.push(listener);
        return () => { removals++; };
      },
      invoke(method, args) {
        assert.equal(method, 'studio/events/subscribe');
        assert.equal(Object.keys(args).length, 0);
        return new Promise((resolve, reject) => requests.push({ resolve, reject }));
      },
    }, Workshop: workshop },
    issueTicket() { throw new Error('DBX must not request an HTTP ticket'); },
    handleEvent(event) { messages.push(event.type); },
    scheduleReconnect() { reconnects++; },
  };
  vm.createContext(dbx);
  vm.runInContext('let retries = 0; let missedWhileOffline = false; let hasConnected = false;\n' + connectionSource + dbxSource
    + '\nconst transport = DbxTransport;\n' + bootstrap
    + '\nthis.open = openSocket; this.close = () => socket.close();', dbx);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await dbx.open();
  assert.equal(requests.length, 1, 'DBX bootstrap invokes the real subscription');
  subscriptions[0]({ method: 'other/event', params: { type: 'ignored' } });
  subscriptions[0]({ method: 'studio/event', params: { type: 'state' } });
  assert.deepEqual(messages, ['state'], 'only studio events reach the application');
  await dbx.open();
  assert.equal(removals, 1, 'reconnect unsubscribes the old listener');
  requests[0].reject(new Error('retired subscription'));
  await settle();
  subscriptions[0]({ method: 'studio/event', params: { type: 'stale' } });
  assert.deepEqual(messages, ['state'], 'late events from a closed subscription are ignored');
  assert.equal(reconnects, 0, 'late subscription failures cannot schedule another reconnect');
  requests[1].reject(new Error('active subscription'));
  await settle();
  assert.equal(reconnects, 1, 'active subscription failure schedules a retry');
  assert.equal(dbx.state.connected, false);
  assert.equal(dbx.ui.offlineBanner.hidden, false);
  await dbx.open();
  requests[2].resolve({});
  await settle();
  assert.equal(dbx.state.connected, true, 'successful retry restores connected status');
  assert.equal(dbx.ui.offlineBanner.hidden, true);
  assert.deepEqual(recoveryReads, ['refreshAll', 'aiTasks'], 'DBX recovery refreshes the open task panel');
  subscriptions[2]({ method: 'studio/event', params: { type: 'spectrum' } });
  subscriptions[2]({ method: 'studio/event', params: { type: 'queue_changed' } });
  assert.deepEqual(messages, ['state', 'spectrum', 'queue_changed']);
  const beforeClose = removals;
  dbx.close(); dbx.close();
  assert.equal(removals, beforeClose + 1, 'close releases the active listener exactly once');
  subscriptions[2]({ method: 'studio/event', params: { type: 'closed' } });
  assert.deepEqual(messages, ['state', 'spectrum', 'queue_changed']);

  const eventHandlerSource = source.slice(
    source.indexOf('function handleEvent(msg)'),
    source.indexOf('function fmt(ms)'));
  let queueReads = 0;
  const eventHandler = {
    window: { HertzCapsuleOnly: false },
    restoreQueue() { queueReads++; return Promise.resolve(); },
  };
  vm.createContext(eventHandler);
  vm.runInContext(eventHandlerSource + '\nthis.routeEvent = handleEvent;', eventHandler);
  eventHandler.routeEvent({ type: 'queue_changed' });
  assert.equal(queueReads, 1, 'queue invalidation reloads the authoritative queue');

  const librarySource = source.slice(source.indexOf('let libraryEpoch = 0;'), source.indexOf('async function libraryTrackIds()'));
  const trackPages = [];
  const library = {
    state: {
      loading: false, q: '', sort: 'title', libFilter: { artist: '', album: '' },
      tracks: [], total: 0, offset: 0, rows: new Set(), byId: new Map(),
    },
    ui: { libSentinel: { disabled: false, textContent: '', hidden: false }, libList: { innerHTML: '' } },
    transport: { get(path) { return new Promise(resolve => trackPages.push({ path, resolve })); } },
    renderLibrary() {}, toast() {}, errText(_prefix, error) { return String(error); },
  };
  vm.createContext(library);
  vm.runInContext('const PAGE = 24; let activeRowMark = null;\n' + librarySource
    + '\nthis.startInitialLoad = () => loadTracks(true); this.reconcileLibrary = () => refreshLibraryInPlace();', library);
  const initialLoad = library.startInitialLoad();
  assert.equal(trackPages.length, 1, 'startup starts the first library snapshot');
  await library.reconcileLibrary();
  assert.equal(trackPages.length, 1, 'reconciliation waits for the in-flight startup snapshot');
  trackPages[0].resolve({ total: 0, tracks: [] });
  await initialLoad;
  assert.equal(trackPages.length, 2, 'a fresh snapshot starts after the startup query settles');
  trackPages[1].resolve({ total: 1, tracks: [{ id: 'after-subscribe' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(library.state.tracks.length, 1, 'the post-subscription snapshot replaces stale startup data');
  assert.equal(library.state.tracks[0].id, 'after-subscribe');

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
  // §8.3 workbench close: the host may tear the webview down right after the
  // notice (tab close sends it with a 0 ms budget), so the hook must fire the
  // pause RPC and let the SDK ack without waiting for the response.
  const dbxRequestSource = source.slice(source.indexOf('function splitPath'), source.indexOf('const DbxTransport = {'));
  const closeCalls = [], closeListeners = [];
  const closeBox = {
    REQUEST_TIMEOUT: 15000, URLSearchParams, DOMException, AbortController, setTimeout, clearTimeout,
    dbxCoverUrl() {}, ensureCover() {}, console: { warn() {} },
    window: { dbxPlugin: {
      workbench: { onClose(listener) { closeListeners.push(listener); return () => {}; } },
      // Never resolves: proves the ack does not wait for the RPC to come back.
      invoke(method, params) { closeCalls.push({ method, params }); return new Promise(() => {}); },
    } },
  };
  vm.createContext(closeBox);
  vm.runInContext(dbxRequestSource + dbxSource + '\nthis.bindHook = bindDbxCloseHook;', closeBox);
  assert.equal(closeBox.bindHook(), true, 'dbx SDK exposes workbench.onClose');
  assert.equal(closeListeners.length, 1, 'one close listener per surface');
  let acked = false;
  closeListeners[0]().then(() => { acked = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acked, true, 'close listener must settle without waiting for the pause RPC');
  assert.equal(closeCalls.length, 1, 'close sends exactly one request');
  assert.equal(closeCalls[0].method, 'v1/player/pause', 'close pauses playback');
  assert.equal(closeCalls[0].params.op, 'POST');

  console.log('Transport bootstrap, real DBX subscription lifecycle, HTTP cancellation, response-body timeout and transient retry checks passed');
}
const watchdog = setTimeout(() => { console.error('Transport test did not settle'); process.exit(1); }, 3000);
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
