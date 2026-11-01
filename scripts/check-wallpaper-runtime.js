// SPDX-License-Identifier: MIT
// Deterministic regression checks for scheduler integration and late media callbacks.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../crates/hertz-desktop/assets/wallpaper-scene.js'), 'utf8');
const url = 'https://' + 'a'.repeat(32) + '.' + 'b'.repeat(32) + '.wallpaper.invalid/files/assets/bg.webm';

function fixture() {
  let nextId = 1, now = 0, selections = 0;
  const rafs = new Map(), timers = new Map(), events = [], elements = [], frames = [];
  const host = { style: {}, appendChild() {} };
  function element(kind) {
    const listeners = new Map();
    let resolveDecode;
    const el = {
      kind, style: {}, paused: true, loads: 0, removed: false, src: '',
      addEventListener(name, callback) { listeners.set(name, callback); },
      removeEventListener(name) { listeners.delete(name); },
      setAttribute() {}, removeAttribute(name) { if (name === 'src') this.src = ''; },
      remove() { this.removed = true; },
      play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; }, load() { this.loads++; },
      requestVideoFrameCallback(callback) { this.frameReady = callback; },
      decode() { return new Promise(resolve => { resolveDecode = resolve; }); },
      finishDecode() { resolveDecode(); }, emit(name) { listeners.get(name)?.(); },
    };
    elements.push(el);
    return el;
  }
  const runtime = {
    catalog: () => [{ id: 'coast', camera: {} }],
    create: () => ({
      select: async id => { selections++; return { id }; },
      frame: frame => { frames.push(frame); return true; },
      dispose() {}, setServices() {}, resize() {}, setRig() {}, stats: () => ({}),
    }),
  };
  const window = { HertzStageRuntime: { SpaceStagePure: runtime }, ipc: { postMessage: message => events.push(message) } };
  window.parent = window;
  const context = {
    window, document: { getElementById: () => host, createElement: element },
    innerWidth: 960, innerHeight: 540, performance: { now: () => now }, addEventListener() {},
    requestAnimationFrame: callback => { const id = nextId++; rafs.set(id, callback); return id; },
    cancelAnimationFrame: id => rafs.delete(id),
    setTimeout: callback => { const id = nextId++; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => nextId++, clearInterval() {},
  };
  vm.runInNewContext(source, context);
  return {
    api: window.hertzWallpaper, events, frames, elements, timers,
    get selections() { return selections; },
    tick(stamp) { now = stamp; const callbacks = [...rafs.values()]; rafs.clear(); callbacks.forEach(callback => callback(now)); },
  };
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }
async function main() {
  for (const fps of [15, 30, 60]) {
    const f = fixture();
    f.api.applyConfig({ source: 'fixed', scene: 'coast', motion: 1 });
    f.api.start(fps); await flush();
    for (let i = 1; i <= 60; i++) f.tick(i * 1000 / 60);
    const seconds = f.frames.reduce((total, frame) => total + frame.dynamicDt, 0);
    assert.ok(Math.abs(seconds - 59 / 60) < .001, `${fps} fps must integrate all elapsed time: ${seconds}`);
    f.api.stop(); const count = f.frames.length;
    f.tick(100000); assert.equal(f.frames.length, count);
    f.api.start(fps);
    for (let i = 1; i <= 4; i++) f.tick(100000 + i * 1000 / 60);
    assert.ok(f.frames.at(-1).dynamicDt < .1, 'resume must not catch up paused time');
    const selections = f.selections;
    f.api.applyConfig({ source: 'fixed', scene: 'coast', quality: 'high' }); await flush();
    assert.equal(f.selections, selections + 1, 'quality change must reach the renderer');
    f.api.unmount();
  }

  const f = fixture();
  f.api.start(); await flush();
  assert.equal(f.api.applyMedia({ kind: 'video', url }), true);
  const video = f.elements.at(-1);
  video.emit('error');
  assert.equal(f.api.debug().media.state, 'failed');
  assert.equal(video.paused, true); assert.equal(video.src, ''); assert.equal(video.loads, 1);
  const readyEvents = f.events.filter(event => event === 'wallpaper_ready').length;
  video.frameReady(); await flush();
  assert.equal(f.api.debug().media.state, 'failed', 'late frame must not resurrect failed media');
  assert.equal(f.events.filter(event => event === 'wallpaper_ready').length, readyEvents);

  f.api.applyMedia({ kind: 'image', url });
  const image = f.elements.at(-1);
  [...f.timers.values()].forEach(callback => callback());
  assert.equal(f.api.debug().media.state, 'failed', 'image decode needs a bounded deadline');
  image.finishDecode(); await flush();
  assert.equal(f.api.debug().media.state, 'failed', 'late decode must not report ready');
  assert.equal(f.api.applyMedia({ kind: 'image', url: url.replace('/assets/', '/assets/../') }), false);
  f.api.applyMedia(null); await flush();
  assert.equal(f.api.debug().backend, 'space', 'clearing media must restore the scene');
  f.api.unmount();
  console.log('wallpaper runtime checks passed: 15/30/60 fps integration, resume, quality, failure release and late callbacks');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
