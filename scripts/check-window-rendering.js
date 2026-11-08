#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, 'plugin/ui', file), 'utf8').replace(/\r\n/g, '\n');
const app = read('app.js');
const stage = read('stage.js');
function grab(source, name, indent = '') {
  const start = source.indexOf(indent + 'function ' + name + '(');
  assert(start >= 0, name + ' exists');
  const end = source.indexOf('\n' + indent + '}\n', start);
  assert(end > start, name + ' has a complete body');
  return source.slice(start, end + indent.length + 3);
}

// Run the real event handler, spectrum renderer and gate registration together.
let visible = true;
const painted = [], gates = new Map();
const state = { spectrum: [], peaks: new Array(64).fill(0) };
const spectrum = {
  width: 256, height: 64,
  getClientRects: () => visible ? [{}] : [],
  getContext: () => ({
    clearRect() { painted.push(state.spectrum.slice()); },
    createLinearGradient: () => ({ addColorStop() {} }),
    fillRect() {},
  }),
};
const renderer = {
  state, ui: { spectrum }, window: {}, console,
  document: { hidden: false, addEventListener() {} },
  Stage: { init() {}, setSpectrum() {}, kick() {}, gate(name, fps, tick) { gates.set(name, { fps, tick }); } },
  onStageControl() {},
};
vm.createContext(renderer);
vm.runInContext(app.slice(app.indexOf('const spectrumCtx ='), app.indexOf('// 队列视图'))
  + '\n' + grab(app, 'handleEvent') + '\n' + grab(app, 'initStage') + '\ninitStage();', renderer);
const spectrumGate = gates.get('spectrum');
assert(spectrumGate, 'spectrum uses the shared frame scheduler');
for (let i = 0; i < 1000; i++) renderer.handleEvent({ type: 'spectrum', bands: [i / 1000] });
assert.equal(painted.length, 0, 'event bursts never synchronously paint Canvas');
assert.equal(spectrumGate.fps(), 30);
renderer.document.hidden = true;
assert.equal(spectrumGate.fps(), 0);
spectrumGate.tick();
assert.equal(painted.length, 0, 'a queued tick cannot draw after minimization');
renderer.document.hidden = false;
visible = false;
assert.equal(spectrumGate.fps(), 0, 'CSS-hidden spectrum has no frame budget');
spectrumGate.tick();
assert.equal(painted.length, 0);
visible = true;
spectrumGate.tick();
assert.deepEqual(painted, [[0.999]], 'restore draws only the newest spectrum, without replaying backlog');
assert.equal(spectrumGate.fps(), 0, 'a consumed spectrum does not keep scheduling frames');

let scheduled = 0, cancelled = 0;
const frameDurations = [];
const lifecycle = {
  window: { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1 },
  document: { hidden: false }, navigator: { hardwareConcurrency: 10, deviceMemory: 16 },
  Math, tier: 2, rafId: 0, hidden: false, lastFrameAt: 123, lastDt: 0,
  stageDestroyed: false, stageFrame: { frameId: 0 }, frameBatch: false, frameStatePending: false,
  fillFrameRecord(record) { return record; }, notifyFrameState() {},
  fps: { done: true, since: 123 }, hzSamples: [16, 17], displayHz: 60,
  gates: [{ skip: 2, wait: 85 }], playing: false, energy: 0,
  requestAnimationFrame() { return ++scheduled; },
  cancelAnimationFrame() { cancelled++; },
  setLowFx(on) { lifecycle.lowfx = on; }, refresh() {},
  now: () => 600000, clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
  runGates(dt) { frameDurations.push(dt); }, sampleDisplayHz() {}, sampleFrameRate() {},
  anyGateWants: () => false,
};
vm.createContext(lifecycle);
vm.runInContext(['detectTier', 'refreshViewport', 'setHidden', 'frame', 'schedule']
  .map(name => grab(stage, name, '  ')).join('\n'), lifecycle);
assert.equal(lifecycle.detectTier(), 2, 'small 1x window retains high tier');
lifecycle.window.devicePixelRatio = 2;
assert.equal(lifecycle.detectTier(), 2, 'small Retina window stays within pixel budget');
lifecycle.window.innerWidth = 1728;
lifecycle.window.innerHeight = 1117;
assert.equal(lifecycle.detectTier(), 1, 'Retina fullscreen accounts for DPR on both axes');
lifecycle.refreshViewport();
assert.equal(lifecycle.tier, 1, 'fullscreen reevaluates the startup tier');
assert.equal(lifecycle.fps.done, false, 'fullscreen reopens the measured frame-rate probe');
assert.equal(lifecycle.hzSamples.length, 0);
assert.equal(lifecycle.displayHz, 0, 'another display cannot retain the old refresh estimate');
lifecycle.window.innerWidth = 2560;
lifecycle.window.innerHeight = 1440;
lifecycle.refreshViewport();
assert.equal(lifecycle.tier, 0, 'large Retina surface gets the existing eco effects');
assert.equal(lifecycle.lowfx, true);
lifecycle.window.devicePixelRatio = 1;
lifecycle.refreshViewport();
assert.equal(lifecycle.tier, 0, 'resizing cannot cause repeated quality upgrades');
lifecycle.setHidden(true);
assert.equal(cancelled, 1);
assert.equal(lifecycle.gates[0].wait, 0, 'hidden time is not accumulated into gate dt');
assert.equal(lifecycle.gates[0].skip, 0);
lifecycle.tier = 2;
lifecycle.window.devicePixelRatio = 2;
lifecycle.refreshViewport();
assert.equal(lifecycle.tier, 2, 'minimized resize does not perform a layout or change tier');
lifecycle.frame();
assert.equal(frameDurations.length, 0, 'late native WebView callback runs no gates while hidden');
lifecycle.setHidden(false);
lifecycle.frame();
assert.deepEqual(frameDurations, [16.7], 'restore starts a fresh frame instead of catching up hidden time');
lifecycle.document.hidden = true;
lifecycle.frame();
assert.equal(frameDurations.length, 1, 'document visibility also guards callbacks before its listener runs');
console.log('Window rendering: spectrum bursts, hidden views, Retina fullscreen budgets and restore timing passed');
