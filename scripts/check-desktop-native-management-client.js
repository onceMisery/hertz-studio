#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Exercise the canonical test client with isolated sockets and a deterministic clock.
'use strict';
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourcePath = path.join(__dirname, 'desktop-native-management-client.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const journeySource = fs.readFileSync(path.join(__dirname, 'check-wallpaper-font-text-native.js'), 'utf8');
const preflightStart = journeySource.indexOf('async function protectHostAndPort(');
const preflightEnd = journeySource.indexOf('\n// Observe the original objects.', preflightStart);
assert(preflightStart >= 0 && preflightEnd > preflightStart, 'test the actual font/text safety preflight');
const preflightSource = journeySource.slice(preflightStart, preflightEnd);
const EVENTS = ['connect', 'data', 'error', 'end', 'close'];
const TOTAL_MS = 4000;
const REQUEST_BYTES = 16384;
const RESPONSE_BYTES = 65536;
const error = code => Object.assign(new Error('mock ' + code), {code});

class Clock {
  constructor() { this.now = 0; this.sequence = 0; this.timers = new Map(); this.created = []; }
  setTimeout(callback, delay) {
    assert(Number.isFinite(delay) && delay >= 0, 'timer delay must be finite and nonnegative');
    const id = ++this.sequence;
    this.created.push({id, at: this.now, delay});
    this.timers.set(id, {callback, at: this.now + delay});
    return id;
  }
  clearTimeout(id) { this.timers.delete(id); }
  advance(ms) {
    const target = this.now + ms;
    let steps = 0;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > target) break;
      assert(++steps < 10000, 'clock must not enter an unbounded retry loop');
      this.now = Math.max(this.now, next[1].at);
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = target;
  }
  // Model an event loop stall: time passes before queued callbacks can run.
  jump(ms) { this.now += ms; }
}

class Socket extends EventEmitter {
  constructor(options = {}) { super(); this.options = options; this.writes = []; this.destroyCalls = 0; this.connectEvents = 0; }
  emit(event, ...args) { if (event === 'connect') this.connectEvents++; return super.emit(event, ...args); }
  write(bytes) {
    this.writes.push(bytes);
    if (this.options.writeError) throw this.options.writeError;
    if (this.options.onWrite) this.options.onWrite(this);
    return this.options.writeResult !== false;
  }
  destroy() {
    this.destroyCalls++;
    if (this.options.destroyError) throw this.options.destroyError;
    if (!this.options.deferClose) this.emit('close');
    return this;
  }
  callbacks() { return Object.fromEntries(EVENTS.map(event => [event, this.listeners(event)])); }
}

function harness(plans = []) {
  const clock = new Clock(), sockets = [], connections = [];
  const pipe = 'mock-only-management-client';
  const FakeDate = class extends Date { static now() { return clock.now; } };
  const realm = {module: {exports: {}}, Buffer, Date: FakeDate,
    require(name) {
      assert.equal(name, 'node:net', 'only the real client net boundary is replaced');
      return {connect(name) {
        assert.equal(name, pipe, 'the original API passes through the requested pipe');
        const plan = plans[connections.length] || {};
        connections.push({name, at: clock.now});
        if (plan.connectError) throw plan.connectError;
        const socket = new Socket(plan); sockets.push(socket); return socket;
      }};
    },
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock)};
  vm.runInNewContext(source, realm, {filename: sourcePath});
  const client = realm.module.exports;
  assert.equal(client.length, 2, 'keep the (pipe, payload) API');
  const state = {status: 'pending'};
  return {clock, sockets, connections, state,
    start(payload = {command: 'mock-status'}) {
      return client(pipe, payload).then(value => { state.status = 'resolved'; state.value = value; },
        reason => { state.status = 'rejected'; state.error = reason; });
    },
    get socket() { return sockets.at(-1); },
    get writes() { return sockets.flatMap(socket => socket.writes); },
    async pending() { await Promise.resolve(); assert.equal(state.status, 'pending'); },
    async rejected(code, reason) {
      await Promise.resolve(); assert.equal(state.status, 'rejected'); assert.equal(state.error.code, code);
      if (reason) assert.equal(state.error, reason, 'preserve the original transport error');
    },
    async resolved(value) {
      await Promise.resolve(); assert.equal(state.status, 'resolved');
      assert.equal(JSON.stringify(state.value), JSON.stringify(value));
    },
    clean() {
      assert.equal(clock.timers.size, 0, 'settlement must clear total and retry timers');
      assert.equal(clock.created.filter(timer => timer.delay === TOTAL_MS).length, 1, 'one total timer covers every phase');
      for (const timer of clock.created.filter(timer => timer.delay !== TOTAL_MS)) {
        assert(timer.delay > 0 && timer.delay <= 20, 'connection retry pauses stay bounded');
      }
      for (const socket of sockets) {
        assert.equal(socket.destroyCalls, 1, 'each attempt must be destroyed exactly once');
        for (const event of EVENTS) assert.equal(socket.listenerCount(event), 0, 'closed socket must release ' + event + ' listener');
      }
      if (state.status === 'rejected') {
        assert.equal(typeof state.error.beforeConnect, 'boolean', 'every rejected error states its request phase');
        assert.equal(state.error.beforeConnect, !sockets.some(socket => socket.connectEvents || socket.writes.length),
          'error phase is a request-level fact even after the active socket was cleared');
      }
    }};
}

async function preflight(reason) {
  let statusCalls = 0, fetchCalls = 0, rejected;
  const realm = {TypeError,
    async status() { statusCalls++; if (reason) throw reason; return {ok: true}; },
    AbortSignal: {timeout(ms) { assert.equal(ms, 1000); return 'mock-only-abort-signal'; }},
    async fetch(url, options) {
      fetchCalls++; assert.equal(url, 'http://127.0.0.1:19758/json/version');
      assert.equal(options.signal, 'mock-only-abort-signal');
      throw Object.assign(new TypeError('mock refused CDP'), {cause: {code: 'ECONNREFUSED'}});
    }};
  vm.runInNewContext(preflightSource, realm, {filename: 'font-text safety preflight (mock only)'});
  try { await realm.protectHostAndPort(19758); } catch (error) { rejected = error; }
  return {rejected, statusCalls, fetchCalls};
}

const checks = [];
async function check(name, run) { await run(); checks.push(name); console.log('PASS ' + name); }
async function main() {
  await check('preconnect ENOENT then EBUSY succeeds with one immutable serialized write', async () => {
    const h = harness(); let serializations = 0;
    h.start({toJSON() { serializations++; return {command: 'mock-status'}; }});
    h.socket.emit('error', error('ENOENT'));
    await h.pending(); assert.equal(h.connections.length, 1); assert.equal(h.writes.length, 0);
    h.clock.advance(10); h.socket.emit('error', error('EBUSY')); h.clock.advance(10);
    h.socket.emit('connect'); h.socket.emit('data', Buffer.from('{"ok":true}'));
    await h.resolved({ok: true}); assert.equal(h.connections.length, 3); assert.equal(serializations, 1);
    assert.deepEqual(h.writes, ['{"command":"mock-status"}']); h.clean();
  });
  for (const code of ['ENOENT', 'EBUSY', 'EPIPE']) {
    await check('connected ' + code + ' never reconnects or replays', async () => {
      const h = harness(), reason = error(code); h.start(); h.socket.emit('connect'); h.socket.emit('error', reason);
      await h.rejected(code, reason); h.clock.advance(TOTAL_MS * 2);
      assert.equal(h.connections.length, 1); assert.equal(h.writes.length, 1); h.clean();
    });
  }
  await check('write throw is caught and never replays even when it says ENOENT', async () => {
    const reason = error('ENOENT'), h = harness([{writeError: reason}]); h.start();
    assert.doesNotThrow(() => h.socket.emit('connect'));
    await h.rejected('ENOENT', reason); h.clock.advance(TOTAL_MS);
    assert.equal(h.connections.length, 1); assert.equal(h.writes.length, 1); h.clean();
  });
  await check('write backpressure does not trigger another request', async () => {
    const h = harness([{writeResult: false}]); h.start(); h.socket.emit('connect'); await h.pending();
    h.socket.emit('data', Buffer.from('{"ok":true}')); await h.resolved({ok: true});
    assert.equal(h.connections.length, 1); assert.equal(h.writes.length, 1); h.clean();
  });
  for (const code of ['ECONNREFUSED', 'EACCES', 'UNKNOWN']) {
    await check('preconnect ' + code + ' is not retryable', async () => {
      const reason = error(code), h = harness(); h.start(); h.socket.emit('error', reason);
      await h.rejected(code, reason); h.clock.advance(TOTAL_MS);
      assert.equal(h.connections.length, 1); assert.equal(h.writes.length, 0); h.clean();
    });
  }
  await check('a later unknown connect failure cannot inherit absent-host ENOENT', async () => {
    const h = harness(), reason = error('EACCES'); h.start(); h.socket.emit('error', error('ENOENT'));
    h.clock.advance(10); h.socket.emit('error', reason); await h.rejected('EACCES', reason);
    assert.equal(h.connections.length, 2); assert.equal(h.writes.length, 0); h.clean();
  });
  await check('synchronous preconnect errors use the same safe retry boundary', async () => {
    const h = harness([{connectError: error('ENOENT')}, {connectError: error('EBUSY')}]); h.start();
    h.clock.advance(20); h.socket.emit('connect'); h.socket.emit('data', Buffer.from('false'));
    await h.resolved(false); assert.equal(h.connections.length, 3); assert.equal(h.writes.length, 1); h.clean();
  });
  for (const code of ['ENOENT', 'EBUSY']) {
    await check('persistent ' + code + ' preserves preflight meaning at the single 4s deadline without writes', async () => {
      const h = harness(); h.start(); let last;
      for (let at = 0; at < TOTAL_MS; at += 10) {
        last = error(code); h.socket.emit('error', last); await h.pending(); h.clock.advance(10);
      }
      await h.rejected(code, last); assert.equal(h.clock.now, TOTAL_MS); assert.equal(h.connections.length, 400);
      assert.equal(h.connections.at(-1).at, 3990); assert.equal(h.writes.length, 0);
      h.clock.advance(TOTAL_MS); assert.equal(h.connections.length, 400); h.clean();
    });
  }
  await check('deadline preserves the last transient connect error while an attempt remains unconnected', async () => {
    const h = harness(), last = error('EBUSY'); h.start(); h.socket.emit('error', error('ENOENT'));
    h.clock.advance(10); h.socket.emit('error', last); h.clock.advance(10); h.clock.advance(3980);
    await h.rejected('EBUSY', last); assert.equal(h.connections.length, 3); assert.equal(h.writes.length, 0); h.clean();
  });
  await check('late connection consumes only the remaining total reply time', async () => {
    const h = harness(); h.start(); h.socket.emit('error', error('ENOENT')); h.clock.advance(3900);
    h.socket.emit('connect'); h.clock.advance(99); await h.pending(); h.clock.advance(1);
    await h.rejected('ERR_MANAGEMENT_TIMEOUT'); assert.equal(h.connections.length, 2); assert.equal(h.writes.length, 1); h.clean();
  });
  await check('a queued retry after the deadline cannot create another socket', async () => {
    const h = harness(), last = error('ENOENT'); h.start(); h.socket.emit('error', last);
    h.clock.jump(TOTAL_MS); h.clock.advance(0); await h.rejected('ENOENT', last);
    assert.equal(h.connections.length, 1); assert.equal(h.writes.length, 0); h.clean();
  });
  await check('an error delivered at the deadline cannot schedule a retry', async () => {
    const h = harness(), last = error('EBUSY'); h.start(); h.clock.jump(TOTAL_MS); h.socket.emit('error', last);
    await h.rejected('EBUSY', last); assert.equal(h.clock.created.length, 1);
    assert.equal(h.connections.length, 1); assert.equal(h.writes.length, 0); h.clean();
  });
  await check('a late connect event clears absence but cannot write after the deadline', async () => {
    const h = harness(); h.start(); h.socket.emit('error', error('ENOENT')); h.clock.advance(10);
    h.clock.jump(TOTAL_MS); h.socket.emit('connect'); await h.rejected('ERR_MANAGEMENT_TIMEOUT');
    assert.equal(h.connections.length, 2); assert.equal(h.writes.length, 0); h.clean();
  });
  await check('complete data delivered after the deadline cannot turn a timeout into success', async () => {
    const h = harness(); h.start(); h.socket.emit('connect'); h.clock.jump(TOTAL_MS);
    h.socket.emit('data', Buffer.from('{"ok":true}')); await h.rejected('ERR_MANAGEMENT_TIMEOUT');
    assert.equal(h.writes.length, 1); h.clean();
  });
  await check('retired sockets and captured late callbacks cannot affect a new attempt', async () => {
    const h = harness([{deferClose: true}]); h.start();
    const old = h.socket, callbacks = old.callbacks(); old.emit('error', error('ENOENT'));
    old.emit('error', error('EPIPE')); old.emit('end'); old.emit('data', Buffer.from('{"wrong":true}'));
    await h.pending(); h.clock.advance(10); old.emit('close');
    for (const event of EVENTS) {
      for (const callback of callbacks[event]) callback(event === 'data' ? Buffer.from('{"wrong":true}') : error('ENOENT'));
    }
    await h.pending(); assert.equal(h.writes.length, 0);
    h.socket.emit('connect'); h.socket.emit('data', Buffer.from('{"ok":true}')); await h.resolved({ok: true});
    for (const callback of callbacks.connect) callback();
    assert.equal(h.connections.length, 2); assert.equal(h.writes.length, 1); h.clean();
  });
  await check('late callbacks on a completed attempt cannot settle or write again', async () => {
    const h = harness(); h.start(); const callbacks = h.socket.callbacks();
    h.socket.emit('connect'); h.socket.emit('data', Buffer.from('{"ok":true}')); await h.resolved({ok: true});
    for (const event of EVENTS) for (const callback of callbacks[event]) callback(event === 'data' ? Buffer.from('false') : error('ENOENT'));
    await h.resolved({ok: true}); assert.equal(h.writes.length, 1); h.clean();
  });
  await check('fragmented UTF-8 JSON succeeds before close with exactly one write', async () => {
    const h = harness(), value = {text: 'Hertz 音乐 🎵'}; h.start(); h.socket.emit('connect');
    for (const byte of Buffer.from(JSON.stringify(value))) h.socket.emit('data', Buffer.from([byte]));
    await h.resolved(value); assert.equal(h.writes.length, 1); h.clean();
  });
  await check('the exact 16KiB UTF-8 request boundary remains accepted', async () => {
    const overhead = Buffer.byteLength(JSON.stringify({padding: ''}));
    const h = harness(); h.start({padding: 'é'.repeat((REQUEST_BYTES - overhead) / 2)});
    h.socket.emit('connect'); h.socket.emit('data', Buffer.from('{}')); await h.resolved({});
    assert.equal(Buffer.byteLength(h.writes[0]), REQUEST_BYTES); h.clean();
  });
  await check('an over-limit UTF-8 request rejects before any socket exists', async () => {
    const h = harness(); h.start({padding: 'é'.repeat(REQUEST_BYTES / 2)}); await h.rejected('ERR_MANAGEMENT_REQUEST_LIMIT');
    assert.equal(h.connections.length, 0); assert.equal(h.writes.length, 0); h.clean();
  });
  await check('the exact 64KiB response boundary remains accepted', async () => {
    const overhead = Buffer.byteLength(JSON.stringify({padding: ''}));
    const value = {padding: 'x'.repeat(RESPONSE_BYTES - overhead)}, h = harness(); h.start(); h.socket.emit('connect');
    h.socket.emit('data', Buffer.from(JSON.stringify(value))); await h.resolved(value);
    assert.equal(Buffer.byteLength(JSON.stringify(h.state.value)), RESPONSE_BYTES); h.clean();
  });
  for (const fragmented of [false, true]) {
    await check((fragmented ? 'cumulative' : 'single-chunk') + ' response above 64KiB rejects without replay', async () => {
      const h = harness(); h.start(); h.socket.emit('connect');
      const bytes = Buffer.alloc(RESPONSE_BYTES + 1, 32);
      if (fragmented) { h.socket.emit('data', bytes.subarray(0, RESPONSE_BYTES)); await h.pending(); h.socket.emit('data', bytes.subarray(RESPONSE_BYTES)); }
      else h.socket.emit('data', bytes);
      await h.rejected('ERR_MANAGEMENT_RESPONSE_LIMIT'); assert.equal(h.connections.length, 1); assert.equal(h.writes.length, 1); h.clean();
    });
  }
  for (const mode of ['silent', 'drip-feed', 'never-connect']) {
    await check(mode + ' is bounded by the original total 4s deadline', async () => {
      const h = harness(); h.start(); if (mode !== 'never-connect') h.socket.emit('connect');
      if (mode === 'drip-feed') for (let i = 0; i < 15; i++) { h.clock.advance(250); h.socket.emit('data', Buffer.from(' ')); await h.pending(); }
      h.clock.advance(3999 - h.clock.now); await h.pending(); h.clock.advance(1);
      await h.rejected('ERR_MANAGEMENT_TIMEOUT'); assert.equal(h.connections.length, 1);
      assert.equal(h.writes.length, mode === 'never-connect' ? 0 : 1); h.clean();
    });
  }
  for (const connected of [false, true]) for (const event of ['end', 'close']) {
    await check((connected ? 'connected' : 'preconnect') + ' ' + event + ' is incomplete and never retryable', async () => {
      const h = harness(); h.start(); if (connected) { h.socket.emit('connect'); h.socket.emit('data', Buffer.from('{"ok":')); }
      h.socket.emit(event); await h.rejected('ERR_MANAGEMENT_INCOMPLETE'); h.clock.advance(TOTAL_MS);
      assert.equal(h.connections.length, 1); assert.equal(h.writes.length, connected ? 1 : 0); h.clean();
    });
  }
  await check('malformed reply fails on close without another write', async () => {
    const h = harness(); h.start(); h.socket.emit('connect'); h.socket.emit('data', Buffer.from('{bad-json}'));
    await h.pending(); h.socket.emit('end'); await h.rejected('ERR_MANAGEMENT_INCOMPLETE');
    assert.equal(h.connections.length, 1); assert.equal(h.writes.length, 1); h.clean();
  });
  for (const mode of ['circular', 'bigint', 'undefined', 'throw']) {
    await check('serialization ' + mode + ' error clears its deadline without connecting', async () => {
      const h = harness(), reason = error('ERR_MOCK_SERIALIZER'); let payload;
      if (mode === 'circular') { payload = {}; payload.self = payload; }
      if (mode === 'bigint') payload = {number: 1n};
      if (mode === 'throw') payload = {toJSON() { throw reason; }};
      // Pass undefined directly, since the harness start default is a valid request.
      h.start(mode === 'undefined' ? {toJSON() { return undefined; }} : payload);
      await Promise.resolve(); assert.equal(h.state.status, 'rejected');
      if (mode === 'throw') assert.equal(h.state.error, reason); else assert.equal(h.state.error.name, 'TypeError');
      assert.equal(h.connections.length, 0); h.clean();
    });
  }
  await check('serialization time is included in the deadline before any connect', async () => {
    const h = harness(); h.start({toJSON() { h.clock.jump(TOTAL_MS); return {}; }});
    await h.rejected('ERR_MANAGEMENT_TIMEOUT'); assert.equal(h.connections.length, 0); h.clean();
  });
  await check('destroy exceptions cannot escape settlement or leave client listeners', async () => {
    const h = harness([{destroyError: error('ERR_MOCK_DESTROY')}]); h.start(); h.socket.emit('connect');
    assert.doesNotThrow(() => h.socket.emit('data', Buffer.from('{}'))); await h.resolved({}); h.clean();
  });
  await check('nonextensible transport errors retain their code and explicit connection phase', async () => {
    const reason = Object.freeze(error('EPIPE')), h = harness(); h.start(); h.socket.emit('connect'); h.socket.emit('error', reason);
    await h.rejected('EPIPE'); assert.equal(h.state.error.cause, reason); h.clean();
  });
  for (const code of ['ENOENT', 'ECONNREFUSED']) {
    for (const beforeConnect of [true, false, undefined, 'true']) {
      await check('font/text preflight ' + code + ' requires beforeConnect === true (' + JSON.stringify(beforeConnect) + ')', async () => {
        const reason = Object.assign(error(code), {beforeConnect}), result = await preflight(reason);
        assert.equal(result.statusCalls, 1);
        if (beforeConnect === true) { assert.equal(result.rejected, undefined); assert.equal(result.fetchCalls, 1); }
        else { assert.equal(result.rejected, reason); assert.equal(result.fetchCalls, 0); }
      });
    }
  }
  await check('font/text preflight refuses busy or timed-out requests even before connection', async () => {
    for (const code of ['EBUSY', 'ERR_MANAGEMENT_TIMEOUT']) {
      const reason = Object.assign(error(code), {beforeConnect: true}), result = await preflight(reason);
      assert.equal(result.rejected, reason); assert.equal(result.fetchCalls, 0);
    }
  });
  await check('font/text preflight refuses a responsive existing host before checking its port', async () => {
    const result = await preflight(); assert(result.rejected);
    assert.match(result.rejected.message, /Existing desktop host/); assert.equal(result.fetchCalls, 0);
  });
  await check('canonical phase facts allow true absence but reject connected ENOENT in actual preflight', async () => {
    const absent = harness(); absent.start(); absent.socket.emit('error', error('ENOENT')); absent.clock.advance(TOTAL_MS);
    await absent.rejected('ENOENT'); const allowed = await preflight(absent.state.error);
    assert.equal(allowed.rejected, undefined); assert.equal(allowed.fetchCalls, 1); absent.clean();
    const connected = harness(), reason = error('ENOENT'); connected.start(); connected.socket.emit('connect'); connected.socket.emit('error', reason);
    await connected.rejected('ENOENT', reason); const refused = await preflight(connected.state.error);
    assert.equal(refused.rejected, reason); assert.equal(refused.fetchCalls, 0); connected.clean();
  });
  console.log(JSON.stringify({passed: true, checks: checks.length, transport: 'mock EventEmitter sockets only; deterministic clock; no OS pipe'}));
}
main().catch(reason => { console.error(reason.stack); process.exitCode = 1; });
