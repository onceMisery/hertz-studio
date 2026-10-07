#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Execute shipped beat consumers with deterministic transports and timers.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, 'plugin/ui', name), 'utf8');
const ticks = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function timers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn) { const id = ++seq; pending.set(id, fn); return id; },
    clearTimeout(id) { pending.delete(id); },
    size() { return pending.size; },
    async next() {
      const first = pending.entries().next().value;
      assert.ok(first, 'analyzing must schedule a bounded follow-up');
      pending.delete(first[0]); first[1](); await ticks();
    },
  };
}
function cinema() {
  const clock = timers();
  const requests = [];
  const env = { console, performance: { now: () => 0 }, document: { addEventListener() {} },
    Stage: { tier: () => 1 }, ...clock,
    VMusicTransport: { get(url) { return new Promise((resolve, reject) => requests.push({ url, resolve, reject })); } },
  };
  env.window = env;
  vm.createContext(env); vm.runInContext(read('stage-cinema.js'), env);
  return { env, clock, requests, stage: env.StageCinema };
}
function status() {
  const clock = timers(); const requests = []; const toasts = [];
  const source = read('app.js');
  const from = source.indexOf('const BEAT_STATE_TEXT =');
  const to = source.indexOf('// 渲染模式：标准', from);
  const env = { console, window: {}, ...clock,
    state: { current: { id: 'A' } },
    ui: { beatRow: { hidden: false }, beatText: { textContent: '' }, beatRetry: {} },
    toast: (text) => toasts.push(text), errText: (label) => label,
    transport: {
      get(url) { return new Promise((resolve, reject) => requests.push({ url, resolve, reject })); },
      post(url, body) { return new Promise((resolve, reject) => requests.push({ url, body, resolve, reject })); },
    },
  };
  vm.createContext(env); vm.runInContext(source.slice(from, to), env);
  return { env, clock, requests, toasts };
}

async function main() {
  {
    const { env, requests } = status();
    const a = env.loadBeatStatus(); env.state.current = { id: 'B' };
    const b = env.loadBeatStatus();
    requests[1].resolve({ current: { state: 'disk' } }); await b;
    requests[0].resolve({ current: { state: 'failed', reason: 'unsupported' } }); await a;
    assert.match(env.ui.beatText.textContent, /磁盘/, 'late A must not overwrite current B');
    env.state.current = { id: 'C' };
    const c = env.loadBeatStatus();
    assert.equal(env.ui.beatRow.hidden, true, 'previous track verdict is hidden before new response');
    requests[2].reject(new Error('offline')); await c;
    assert.equal(env.ui.beatRow.hidden, true, 'failed new request cannot resurrect old verdict');
  }
  {
    const { env, requests, clock } = status();
    const a = env.loadBeatStatus(); const b = env.loadBeatStatus();
    requests[1].resolve({ current: { state: 'disk' } }); await b;
    requests[0].resolve({ current: { state: 'analyzing' } }); await a;
    assert.match(env.ui.beatText.textContent, /磁盘/, 'same-track older response is stale too');
    assert.equal(clock.size(), 0);
  }
  {
    const { env, requests, clock } = status();
    const start = env.loadBeatStatus(); requests[0].resolve({ current: { state: 'analyzing' } }); await start;
    await clock.next(); requests[1].resolve({ current: { state: 'failed', reason: 'unsupported', attempts: 1 } }); await ticks();
    assert.match(env.ui.beatText.textContent, /格式不支持/, 'analysis failure becomes visible without a ready event');
    assert.equal(clock.size(), 0, 'terminal verdict stops polling');
  }
  {
    const { env, requests, clock } = status();
    env.loadBeatStatus();
    let count = 0;
    while (count < 30) {
      requests[count].resolve({ current: { state: 'idle' } }); await ticks(); count++;
      if (!clock.size()) break;
      await clock.next();
    }
    assert.ok(count > 1 && count < 30, 'status polling is bounded when the server keeps deferring');
  }
  {
    const { env, requests, toasts } = status();
    const retry = env.retryBeatmap(); env.state.current = { id: 'B' };
    requests[0].resolve({ status: 'unavailable', reason: 'unsupported' }); await retry;
    assert.equal(toasts.length, 0, 'retry result from A must not describe B');
  }
  {
    const { env, requests } = status();
    const refreshed = [];
    env.StageCinema = env.window.StageCinema = { refreshMap: (id) => refreshed.push(id) };
    const retry = env.retryBeatmap(); requests[0].resolve({ status: 'analyzing' }); await retry;
    assert.deepEqual(refreshed, ['A'], 'manual retry resumes demand after a previous terminal result');
  }
  {
    const { stage, requests, clock } = cinema();
    stage.onTrack('A'); requests[0].resolve({ status: 'analyzing' }); await ticks();
    await clock.next();
    assert.equal(requests.length, 2, 'deferred current song gets another demand request');
    requests[1].resolve({ beats: [{ t: 100, strength: 1, downbeat: true, intensity: 1 }] }); await ticks();
    assert.equal(stage.mode(), 'active'); assert.equal(clock.size(), 0);
  }
  {
    const { stage, requests, clock } = cinema();
    stage.onTrack('A'); requests[0].resolve({ status: 'analyzing' }); await ticks();
    stage.onTrack('B'); assert.equal(clock.size(), 0, 'switching tracks cancels waiting timer');
    requests[1].resolve({ status: 'analyzing' }); await ticks();
    stage.onTrack(null); assert.equal(clock.size(), 0, 'clearing current track cancels waiting timer');
    assert.equal(stage.mode(), 'absent');
  }
  {
    const { stage, requests, clock } = cinema();
    stage.onTrack('A');
    let count = 0;
    while (count < 30) {
      requests[count].resolve({ status: 'analyzing' }); await ticks(); count++;
      if (!clock.size()) break;
      await clock.next();
    }
    assert.ok(count > 1 && count < 30, 'waiting retries have a finite budget');
    assert.equal(stage.mode(), 'absent', 'exhausted wait falls back to onset');
    stage.onBeatmapReady({ track_id: 'A' });
    assert.equal(requests.length, count + 1, 'late ready event still resumes the current song');
    requests[count].reject(new Error('unsupported')); await ticks();
    stage.refreshMap('B'); assert.equal(requests.length, count + 1, 'manual refresh from a stale track is ignored');
    stage.refreshMap('A'); assert.equal(requests.length, count + 2, 'manual retry can restart after exhaustion');
  }
  {
    const source = read('stage3d.js');
    const begin = source.indexOf('  function chromeKeyboardFocus()');
    const end = source.indexOf('\n  function pokeChrome()', begin);
    let selector = '';
    const env = { root: { querySelector(value) { selector = value; return value.includes('.s3d-queue :focus') ? { matches: () => true } : null; } } };
    vm.createContext(env); vm.runInContext(source.slice(begin, end), env);
    assert.equal(env.chromeKeyboardFocus(), true, 'keyboard focus in an open queue protects it from auto hide');
    assert.ok(selector.includes('.s3d-queue :focus'));
  }
  console.log('Beat lifecycle: status identity, bounded recovery, retry identity and queue focus passed.');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
