// SPDX-License-Identifier: MIT
// Exercise the actual standalone mini-player module with a deterministic DOM,
// image decoder, IPC sink and clock. No desktop processes or mouse input.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../crates/hertz-desktop/assets/mini-player.js'), 'utf8');
const assetPath = url => url.split('?')[0];

function harness(initialAssets, initialSpec = null) {
  const assets = new Map(Object.entries(initialAssets));
  const messages = [], assignments = [], decoded = [], requests = [];
  const timers = new Map(), rafs = new Map();
  let sequence = 0, spec = initialSpec, nextManifest = null;
  class Element {
    constructor(id) {
      this.id = id; this.listeners = new Map(); this.attrs = new Map(); this.dataset = {};
      this.style = { setProperty() {} };
      const classes = new Set();
      this.classList = { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)), contains: n => classes.has(n),
        toggle: (n, on) => on ? classes.add(n) : classes.delete(n) };
    }
    addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]); }
    removeEventListener() {}
    dispatch(name, event = {}) { for (const fn of this.listeners.get(name) || []) fn(event); }
    dispatchEvent(event) { this.dispatch(event.type, event); }
    setAttribute(name, value) { this.attrs.set(name, value); }
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
    removeAttribute(name) { this.attrs.delete(name); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
  }
  class MockImage extends Element {
    constructor(id) { super(id); this.naturalWidth = 0; this.naturalHeight = 0; }
    set src(url) {
      this.attrs.set('src', url);
      if (this.id) assignments.push(url); else decoded.push(url);
      this.asset = url.startsWith('data:') ? { size: [56, 56] } : assets.get(assetPath(url));
      const loaded = this.asset;
      queueMicrotask(() => {
        if (this.getAttribute('src') !== url) return;
        this.naturalWidth = loaded && !loaded.corrupt ? loaded.size[0] : 0;
        this.naturalHeight = loaded && !loaded.corrupt ? loaded.size[1] : 0;
        if (this.naturalWidth) { this.onload?.(); this.dispatch('load'); }
        else { this.onerror?.(); this.dispatch('error'); }
      });
    }
    get src() { return this.getAttribute('src'); }
  }
  const nodes = new Map(['capsule', 'flash', 'title', 'subtitle', 'play', 'prev', 'next', 'cover-img']
    .map(id => [id, new Element(id)]));
  const art = new MockImage('pet-art'); nodes.set('pet-art', art);
  const body = new Element('body'), window = new Element('window');
  window.ipc = { postMessage: json => messages.push(JSON.parse(json)) };
  const document = new Element('document');
  Object.assign(document, { body, documentElement: new Element('html'), getElementById: id => nodes.get(id),
    querySelectorAll: () => [art], createElement: () => {
      const canvas = {};
      canvas.getContext = () => ({ clearRect() {}, drawImage(image) { canvas.image = image; }, getImageData() {
        const bytes = new Uint8ClampedArray(canvas.width * canvas.height * 4);
        const minX = canvas.image.asset?.minX || 0;
        for (let y = 0; y < canvas.height; y++) for (let x = minX; x < canvas.width; x++) bytes[(y * canvas.width + x) * 4 + 3] = 255;
        return { data: bytes };
      } }); return canvas;
    } });
  const context = { document, window, Image: MockImage, matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id), requestAnimationFrame: fn => { const id = ++sequence; rafs.set(id, fn); return id; },
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method });
      if (assetPath(url) === 'mini-skin/pet.json') {
        const pending = nextManifest; nextManifest = null;
        if (pending) return pending;
        const value = spec;
        return { ok: !!value, json: async () => value };
      }
      return { ok: assets.has(assetPath(url)) };
    }, Event: class Event { constructor(type) { this.type = type; } }, Date, console };
  vm.runInNewContext(source, context, { filename: 'mini-player.js' });
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { api: window.hertzMini, assets, messages, assignments, decoded, requests, nodes, art, body, timers,
    settle, setSpec: value => { spec = value; }, deferManifest: promise => { nextManifest = promise; },
    tick() { const first = timers.entries().next().value; assert.ok(first, 'animation timer remains live'); timers.delete(first[0]); first[1].fn(); return first[1].delay; },
    flushRegions() { const batch = [...rafs.values()]; rafs.clear(); batch.forEach(fn => fn()); },
    contextMenu() { window.dispatch('contextmenu', { preventDefault() {} }); } };
}
const image = (width = 72, height = 96, extra = {}) => ({ size: [width, height], ...extra });
const lastSize = h => h.messages.filter(m => m.cmd === 'pet-size').at(-1);
const active = h => assetPath(h.art.src);

(async () => {
  const numbered = harness({ 'mini-skin/playing-1.jpeg': image(96, 180), 'mini-skin/playing-2.jpeg': image(96, 180) });
  numbered.api.applyConfig({ pet: true }); numbered.api.applySnapshot({ playing: true });
  await numbered.settle();
  assert.equal(active(numbered), 'mini-skin/playing-1.jpeg');
  assert.deepEqual(lastSize(numbered), { cmd: 'pet-size', width: 96, height: 160 });
  assert.equal(numbered.tick(), 250);
  assert.equal(active(numbered), 'mini-skin/playing-2.jpeg');
  const assignmentCount = numbered.assignments.length;
  numbered.api.applySnapshot({ playing: true }); numbered.api.applySnapshot({ playing: true });
  assert.equal(numbered.assignments.length, assignmentCount, 'same-state snapshots preserve frame timing');
  numbered.tick(); assert.equal(active(numbered), 'mini-skin/playing-1.jpeg');

  const custom = harness({ 'mini-skin/idle.gif': image(72, 96), 'mini-skin/playing.png': image(), 'mini-skin/tap-1.png': image(), 'mini-skin/tap-2.png': image() },
    { size: [128, 64], states: { idle: { frames: ['idle.gif'] }, playing: { frames: ['playing.png'], fps: 5 }, tap: { frames: ['tap-1.png', 'tap-2.png'], fps: 10 } } });
  custom.api.applyConfig({ pet: true }); await custom.settle();
  assert.equal(lastSize(custom).width, 128, 'manifest dimensions take priority');
  const oldURL = custom.art.src, oldDecodeCount = custom.decoded.length;
  custom.flushRegions();
  assert.equal(custom.messages.at(-1).regions[0][0], 12.5);
  for (let i = 0; i < 3; i++) { custom.tick(); custom.api.applySnapshot({ playing: false }); }
  assert.equal(custom.art.src, oldURL);
  assert.equal(custom.assignments.length, 1, 'single-frame GIF is not reset by ticks or snapshots');
  custom.assets.set('mini-skin/idle.gif', image(72, 96, { minX: 36 }));
  await custom.api.reloadSkin(); await custom.settle(); custom.flushRegions();
  assert.notEqual(custom.art.src, oldURL, 'same-name overwrite gets a distinct decoded URL');
  assert.ok(custom.decoded.length > oldDecodeCount);
  assert.equal(custom.messages.at(-1).regions[0][0], 50, 'alpha hit region follows replaced content');
  custom.api.applySnapshot({ playing: true });
  assert.equal(active(custom), 'mini-skin/playing.png'); assert.equal(custom.tick(), 200, 'manifest fps preserved');
  custom.nodes.get('next').dispatch('click', { stopPropagation() {} });
  assert.equal(active(custom), 'mini-skin/tap-1.png');
  custom.api.applySnapshot({ playing: true }); assert.equal(active(custom), 'mini-skin/tap-1.png');
  assert.equal(custom.tick(), 100); assert.equal(active(custom), 'mini-skin/tap-2.png');
  custom.tick(); assert.equal(active(custom), 'mini-skin/playing.png', 'one-shot returns to current playback state');

  const fallbackTap = harness({ 'mini-skin/idle.png': image(), 'mini-skin/playing.png': image() },
    { states: { idle: { frames: ['idle.png'], loop: true }, playing: { frames: ['playing.png'], loop: true } } });
  fallbackTap.api.applyConfig({ pet: true }); fallbackTap.api.applySnapshot({ playing: true }); await fallbackTap.settle();
  fallbackTap.nodes.get('next').dispatch('click', { stopPropagation() {} });
  assert.equal(active(fallbackTap), 'mini-skin/idle.png', 'missing tap uses user idle');
  fallbackTap.tick();
  assert.equal(active(fallbackTap), 'mini-skin/playing.png', 'one-shot finishes even when fallback idle loops');
  for (let i = 0; i < 10; i++) fallbackTap.tick();
  assert.equal(active(fallbackTap), 'mini-skin/playing.png', 'normal playing state keeps looping');

  for (const badFrame of [undefined, image(72, 96, { corrupt: true })]) {
    const badAssets = { 'mini-skin/idle.png': image(), 'mini-skin/first.png': image() };
    if (badFrame) badAssets['mini-skin/bad.png'] = badFrame;
    const broken = harness(badAssets, { states: { idle: { frames: ['idle.png'] }, playing: { frames: ['first.png', 'bad.png'] } } });
    broken.api.applyConfig({ pet: true }); broken.api.applySnapshot({ playing: true }); await broken.settle();
    assert.equal(active(broken), 'mini-skin/idle.png', 'missing/corrupt explicit animation falls back as a state');
    assert.ok(!broken.assignments.some(url => assetPath(url) === 'mini-skin/first.png'), 'partial animation is not reordered');
    assert.equal(broken.body.getAttribute('data-art-failed'), null);
  }

  const fallback = harness({ 'mini-skin/idle.png': image(), 'mini-skin/playing.png': image() },
    { states: { idle: { frames: ['idle.png'] }, playing: { frames: ['playing.png'] } } });
  fallback.api.applyConfig({ pet: true }); fallback.api.applySnapshot({ playing: true }); await fallback.settle();
  fallback.art.dispatch('error'); await fallback.settle(); assert.equal(active(fallback), 'mini-skin/idle.png');
  fallback.art.dispatch('error'); await fallback.settle(); assert.ok(fallback.art.src.startsWith('data:'), 'default requested state follows user idle');
  const defaultPlaying = fallback.art.src;
  fallback.art.dispatch('error'); await fallback.settle(); assert.notEqual(fallback.art.src, defaultPlaying, 'default idle is final image fallback');
  fallback.art.dispatch('error'); assert.equal(fallback.body.getAttribute('data-art-failed'), '');
  assert.equal(fallback.timers.size, 0, 'glyph fallback does not retry failed URLs');
  assert.equal(new Set(fallback.assignments).size, fallback.assignments.length);

  let releaseOld;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  custom.deferManifest(oldResponse);
  const oldLoad = custom.api.reloadSkin();
  custom.setSpec({ size: [150, 151], states: { idle: { frames: ['idle.gif'] } } });
  await custom.api.reloadSkin(); await custom.settle();
  const newestURL = custom.art.src;
  releaseOld({ ok: true, json: async () => ({ size: [49, 50], states: { idle: { frames: ['idle.gif'] } } }) });
  await oldLoad; await custom.settle();
  assert.equal(custom.art.src, newestURL, 'late old reload cannot replace newer skin');
  assert.equal(lastSize(custom).width, 150);
  custom.contextMenu(); assert.equal(custom.messages.at(-1).cmd, 'context-menu');
  custom.nodes.get('capsule').dispatch('pointerenter');
  assert.ok(custom.body.classList.contains('hovering'));
  const sizeBeforeReset = lastSize(custom);
  custom.api.resetInteraction();
  assert.ok(!custom.body.classList.contains('hovering'), 'source switches clear prior hover state');
  assert.deepEqual(lastSize(custom), sizeBeforeReset, 'source switch reset keeps loaded skin dimensions');
  custom.api.applyConfig({ locked: true });
  const menuCount = custom.messages.filter(m => m.cmd === 'context-menu').length;
  custom.contextMenu(); assert.equal(custom.messages.filter(m => m.cmd === 'context-menu').length, menuCount);
  console.log('PASS desktop mini assets: numbered/jpeg, dimensions, decode fallback, reload races, alpha refresh, frame timing, one-shot and native menu IPC');
})().catch(error => { console.error(error); process.exitCode = 1; });

