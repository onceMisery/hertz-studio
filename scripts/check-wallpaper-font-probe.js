#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Verify the shipped font probe's async cleanup with a controlled FontFace.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../crates/hertz-desktop/assets/wallpaper-font-probe.js'), 'utf8');

function harness({alpha = true, loadedStatus = 'loaded', check = true} = {}) {
  const messages = [], faces = new Set(), removed = [], canvases = [];
  let settle, reject, loads = 0, draws = 0, checks = 0;
  const loading = new Promise((resolve, fail) => { settle = resolve; reject = fail; });
  class FontFace {
    constructor(family, url) { this.family = family; this.url = url; this.status = 'unloaded'; }
    async load() { loads++; this.status = 'loading'; await loading; this.status = loadedStatus; return this; }
  }
  const document = {
    fonts: {add: font => faces.add(font), delete: font => { removed.push(font); return faces.delete(font); },
      check: () => { checks++; return check; }},
    getElementById: () => ({append: canvas => { canvas.attached = true; }}),
    createElement: tag => {
      assert.equal(tag, 'canvas');
      const canvas = {width: 0, height: 0, removed: false, remove() { this.removed = true; },
        getContext: () => ({fillText() { draws++; }, getImageData() {
          const data = new Uint8ClampedArray(256 * 128 * 4);
          if (alpha) data[3] = 255;
          return {data};
        }})};
      canvases.push(canvas); return canvas;
    },
  };
  const window = {ipc: {postMessage: value => messages.push(value)}};
  vm.runInNewContext(source, {window, document, FontFace, Uint8ClampedArray}, {filename: 'wallpaper-font-probe.js'});
  assert.deepEqual(messages, ['ready']);
  const config = {kind: 'font', url: 'https://' + 'a'.repeat(32) + '.' + 'b'.repeat(32) + '.wallpaper.invalid/files/font.ttf',
    metadata: {sfntBytes: 8336, probeText: 'Hertz Studio'}};
  return {run: value => window.hertzDecodeProbe.run(value || config), stop: () => window.hertzDecodeProbe.stop(),
    config, settle, reject, messages, faces, removed, canvases,
    stats: () => ({loads, draws, checks}), report: () => JSON.parse(messages.at(-1))};
}

async function main() {
  const cases = [];
  async function test(name, verify) { await verify(); cases.push(name); }
  await test('a loaded Face draws bounded pixels and cleans before the settled report', async () => {
    const h = harness(), running = h.run();
    assert.equal(h.messages.length, 1); assert.equal(h.stats().loads, 1);
    h.settle(); await running;
    assert.equal(h.report().ok, true); assert.equal(h.report().alphaPixels, 1);
    assert.equal(h.report().fontStatus, 'loaded'); assert.equal(h.report().settled, true);
    assert.equal(h.faces.size, 0); assert.equal(h.canvases[0].width, 0);
    assert.equal(h.canvases[0].height, 0); assert.equal(h.canvases[0].removed, true);
    assert.equal(h.stats().draws, 1);
  });
  await test('cancel keeps the pending load until it settles, without publishing late success', async () => {
    const h = harness(), running = h.run(); h.stop(); h.stop();
    assert.equal(h.messages.length, 1); assert.equal(h.removed.length, 0);
    assert.equal(h.canvases.length, 0); h.settle(); await running;
    assert.equal(h.report().ok, false); assert.equal(h.report().settled, true);
    assert.equal(h.stats().draws, 0); assert.equal(h.removed.length, 1); assert.equal(h.faces.size, 0);
  });
  await test('rejected loads clean the Face and provide a settled failure', async () => {
    const h = harness(), running = h.run(); h.reject(new Error('font decoder rejection')); await running;
    assert.equal(h.report().ok, false); assert.equal(h.report().code, 'font_decode_failed');
    assert.equal(h.report().settled, true); assert.equal(h.stats().draws, 0);
    assert.equal(h.removed.length, 1); assert.equal(h.canvases.length, 0);
  });
  for (const options of [{alpha: false}, {loadedStatus: 'error'}, {check: false}]) {
    await test('invalid glyph evidence is rejected: ' + JSON.stringify(options), async () => {
      const h = harness(options), running = h.run(); h.settle(); await running;
      assert.equal(h.report().ok, false); assert.equal(h.report().code, 'font_decode_failed');
      assert.equal(h.faces.size, 0); assert(h.canvases.every(canvas => canvas.removed && !canvas.width && !canvas.height));
    });
  }
  await test('a probe controller accepts only one load', async () => {
    const h = harness(), running = h.run(); await h.run();
    assert.equal(h.stats().loads, 1); h.settle(); await running; await h.run();
    h.stop(); assert.equal(h.stats().loads, 1); assert.equal(h.messages.length, 2);
  });
  await test('invalid input never starts FontFace or canvas allocation', async () => {
    for (const change of [value => { value.kind = 'video'; }, value => { value.url = 'https://example.com/font.ttf'; },
      value => { value.metadata.sfntBytes = 0; }, value => { value.metadata.sfntBytes = 16777217; },
      value => { value.metadata.probeText = ''; }, value => { value.metadata.probeText = 'H'.repeat(65); }]) {
      const h = harness(); change(h.config); await h.run();
      assert.equal(h.report().ok, false); assert.equal(h.stats().loads, 0); assert.equal(h.canvases.length, 0);
    }
  });
  for (const name of cases) process.stdout.write('PASS ' + name + '\n');
  process.stdout.write(cases.length + ' font probe cases passed; native Close/Drain and actual FontFace remain separate evidence.\n');
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
