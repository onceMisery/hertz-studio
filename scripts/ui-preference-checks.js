#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// Exercise the portable file boundary and actual page preference owners in VM.
// No storage enumeration, real browser profile, service or external dependencies.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const WEB = path.resolve(__dirname, '..', 'plugin', 'ui');
const read = (name) => fs.readFileSync(path.join(WEB, name), 'utf8').replace(/\r\n/g, '\n');
const app = read('app.js');
let checks = 0;

function check(label, fn) {
  fn(); checks += 1;
}

function boot(seed = {}, options = {}) {
  const storage = new Map(Object.entries(seed));
  const reads = [];
  const mutations = [];
  const attributes = new Map();
  const root = { style: { setProperty() {}, removeProperty() {} }, dataset: {},
    classList: { toggle() {}, contains() { return false; } },
    setAttribute(key, value) { attributes.set(key, value); }, getAttribute(key) { return attributes.get(key) || null; } };
  const localStorage = new Proxy({
    getItem(key) { reads.push(key); return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { mutations.push({ key, value: String(value) }); storage.set(key, String(value)); },
    removeItem(key) { mutations.push({ key, value: null }); storage.delete(key); },
    key() { throw new Error('storage enumeration forbidden'); },
    get length() { throw new Error('storage enumeration forbidden'); },
  }, { ownKeys() { throw new Error('storage enumeration forbidden'); } });
  const sandbox = { console, localStorage, TextEncoder: options.fallbackEncoder ? undefined : TextEncoder,
    document: { documentElement: root, body: {}, querySelectorAll() { return []; },
      getElementById() { return null; }, addEventListener() {}, dispatchEvent() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    addEventListener() {}, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of ['design/design-themes.js', 'themes.js', 'theme-studio.js', 'skins/skins.js', 'stage-control.js', 'ui-preferences.js']) {
    vm.runInContext(read(name), context, { filename: name });
  }
  if (options.configure !== false) {
    // Reuse the actual application callbacks and owner constants instead of
    // maintaining test-only copies of playlist/default-view behavior.
    const views = app.match(/  views: (\{[\s\S]*?\n  \}),/);
    assert.ok(views, 'application views found');
    vm.runInContext(`const $ = () => null; const ui = {views: ${views[1]}};`, context);
    for (const name of ['DEFAULT_VIEW_KEY', 'PL_VIEW_KEY', 'PL_VIEW_V2_KEY']) {
      const declaration = app.match(new RegExp(`^const ${name} = .*;$`, 'm'));
      assert.ok(declaration, name + ' found');
      vm.runInContext(declaration[0], context);
    }
    const start = app.indexOf('window.UiPreferences.configure({');
    assert.ok(start >= 0, 'application preference configuration found');
    const end = app.indexOf('\n    });', start);
    assert.ok(end > start, 'application preference configuration complete');
    vm.runInContext(app.slice(start, end + '\n    });'.length), context);
  }
  return { api: context.UiPreferences, context, storage, reads, mutations, root,
    eval(source) { return vm.runInContext(source, context); },
    clearIO() { reads.length = 0; mutations.length = 0; } };
}

function document(preferences = []) {
  return { kind: 'hertz-ui-preferences', schemaVersion: 1, preferences };
}

function item(key, value, schemaVersion = 1) { return { key, schemaVersion, value }; }
function encoded(preferences) { return JSON.stringify(document(preferences)); }
const plain = (value) => JSON.parse(JSON.stringify(value));

function rejected(host, text, code) {
  const before = [...host.storage];
  assert.throws(() => host.api.parse(text), (error) => error && error.code === code, code);
  assert.deepEqual([...host.storage], before, 'rejection does not mutate storage');
}

const colors = { bg: '#181A22', accent: '#67CDA3', accent2: '#537DE3' };
const stage = { enabled: false, intensity: 85, stagePreset: 'still', fluidEnabled: true,
  fluidStrength: 42, fluidAudio: false, fluidPointer: false, bokeh: 5, chroma: 2, grain: 8,
  density: 125, strength: 80, dustDrift: 75, dust: false, ripples: true,
  lyricSize: 115, beatAmp: 25, lyricColor: '#AABBCC', lyricFont: 'serif', cinema: false, cinePunch: 75, freecam: false };
const fixture = {
  'vmusic.theme.v2': 'celestial',
  'vmusic.theme.custom.v1': JSON.stringify(colors),
  'vmusic.skin': 'hertz',
  'vmusic.defaultView': 'reader',
  'vmusic.playlists.mode': 'shelf',
  'vmusic.daily.mode': 'local',
  'vmusic.daily.collapsed': '1',
  'vmusic.dailyview.layout': 'card',
  'vmusic.dailyview.mode': 'online',
  'hertz-reader-preferences': JSON.stringify({ size: 23, font: 'sans', theme: 'dark' }),
  'vmusic.stage.mode': 'scatter',
  'vmusic.stage.control': JSON.stringify(stage),
  'vmusic.qf-wall': '1',
  'vmusic.qf-wall-follow': '0',
  'vmusic.qf-wall-vignette': '1',
  'vmusic.qf-wall-tint': '1',
  'vmusic.qf-wall-tint-color': '#AABBCC',
  'vmusic.qf-wall-tint-intensity': '65',
};
const excluded = {
  'token': 'private-token', 'vmusic.token': 'private-token',
  'vmusic.accounts': 'private-account', 'vmusic.room.last': 'private-room',
  'vmusic.search.history': 'private-search', 'vmusic.online.cache': 'private-cache',
  'vmusic.obs.assets.v1': 'private-obs', 'vmusic.wallpaper.v1': 'private-wallpaper',
  'vmusic.capsule.minimized': '1', 'vmusic.capsule.pos': '110,220',
  'vmusic.sleep-timer-preset': '45', 'vmusic.stage.freecam.pose': 'private-camera',
  'vmusic.stage.current': 'private-stage-project', 'vmusic.stage.library': 'private-stage-library',
  'vmusic.stage.media': 'private-local-media',
  'vmusic.theme.mineral-default': 'private-marker', 'vmusic.skin.default': 'private-marker',
  'vmusic.playlists.viewV2': 'private-marker', 'vmusic.stage.control.v': 'private-marker',
};
const host = boot({ ...fixture, ...excluded });

check('file metadata is a separate versioned protocol with capacity limits', () => {
  assert.equal(host.api.kind, 'hertz-ui-preferences'); assert.equal(host.api.schemaVersion, 1);
  assert.equal(host.api.maxBytes, 65536); assert.equal(host.api.maxItems, 32);
});
let exported;
check('export reads exactly the 18 safe keys and never enumerates storage', () => {
  host.clearIO(); exported = host.api.exportDocument();
  assert.equal(exported.preferences.length, 18);
  assert.deepEqual(host.reads, Object.keys(fixture));
  assert.deepEqual(host.mutations, []);
});
check('export excludes credentials, accounts, histories, resources and internal markers', () => {
  const text = JSON.stringify(exported);
  for (const [key, value] of Object.entries(excluded)) {
    assert.equal(exported.preferences.some((entry) => entry.key === key), false, key);
    if (value.startsWith('private-')) assert.equal(text.includes(value), false, value);
  }
});
check('export converts flags, numeric strings and JSON records into typed values', () => {
  const values = new Map(exported.preferences.map((entry) => [entry.key, entry.value]));
  assert.equal(values.get('vmusic.qf-wall'), true);
  assert.equal(values.get('vmusic.qf-wall-follow'), false);
  assert.equal(values.get('vmusic.qf-wall-tint-intensity'), 65);
  assert.deepEqual(plain(values.get('hertz-reader-preferences')), { size: 23, font: 'sans', theme: 'dark' });
  assert.deepEqual(plain(values.get('vmusic.theme.custom.v1')), { bg: '#181a22', accent: '#67cda3', accent2: '#537de3' });
});
let parsed;
let planned;
check('parse and owner write planning are pure and preserve canonical storage formats', () => {
  host.clearIO(); parsed = host.api.parse(JSON.stringify(exported)); planned = host.api.writes(parsed);
  assert.deepEqual(host.mutations, []); assert.deepEqual(host.reads, []);
  assert.equal(parsed.entries.length, 18); assert.equal(planned.length, 22);
  const writes = new Map(planned.map((write) => [write.key, write.value]));
  assert.equal(writes.get('vmusic.theme.mineral-default'), '1');
  assert.equal(writes.get('vmusic.skin.default'), 'hertz');
  assert.equal(writes.get('vmusic.playlists.viewV2'), '1');
  assert.equal(writes.get('vmusic.stage.control.v'), '2');
  assert.equal(writes.get('vmusic.daily.collapsed'), '1');
  assert.equal(writes.get('vmusic.qf-wall-follow'), '0');
  assert.equal(writes.get('vmusic.qf-wall-tint-intensity'), '65');
  assert.equal(JSON.parse(writes.get('vmusic.stage.control')).lyricColor, '#aabbcc');
  assert.equal(JSON.parse(writes.get('vmusic.stage.control')).enabled, false);
});
check('fresh destination roundtrip retains unrelated destination credentials', () => {
  const target = boot({ token: 'destination-token', 'vmusic.obs.assets.v1': 'destination-obs' });
  for (const write of target.api.writes(target.api.parse(JSON.stringify(exported)))) target.storage.set(write.key, write.value);
  assert.deepEqual(plain(target.api.exportDocument()), plain(exported));
  assert.equal(target.storage.get('token'), 'destination-token');
  assert.equal(target.storage.get('vmusic.obs.assets.v1'), 'destination-obs');
});
check('owner-derived markers prevent current-version old defaults from being upgraded away', () => {
  const target = boot();
  const writes = target.api.writes(target.api.parse(encoded([
    item('vmusic.theme.v2', 'celestial'), item('vmusic.skin', 'hertz'),
    item('vmusic.playlists.mode', 'shelf'), item('vmusic.stage.control', { enabled: false, stagePreset: 'still' }),
  ])));
  for (const write of writes) target.storage.set(write.key, write.value);
  target.eval('Theme.init(); Skins.init(); StageControl.init();');
  assert.equal(target.context.Theme.current().id, 'celestial');
  assert.equal(target.context.Skins.currentId(), 'hertz');
  assert.equal(target.context.StageControl.values().enabled, false);
  assert.equal(target.storage.get('vmusic.playlists.mode'), 'shelf');
});
check('custom theme can be parsed on a fresh destination before its registration', () => {
  const target = boot();
  assert.equal(target.context.Theme.list().some((theme) => theme.id === 'custom-studio'), false);
  const result = target.api.parse(encoded([item('vmusic.theme.v2', 'custom-studio'), item('vmusic.theme.custom.v1', colors)]));
  for (const write of target.api.writes(result)) target.storage.set(write.key, write.value);
  target.eval('Theme.init(); ThemeStudio.initPalette();');
  assert.equal(target.context.Theme.current().id, 'custom-studio');
  assert.equal(target.context.ThemeStudio.state.bg, '#181a22');
});
check('custom theme without its portable three colors is rejected', () => {
  rejected(host, encoded([item('vmusic.theme.v2', 'custom-studio')]), 'missing-dependency');
});
check('existing registered anime themes remain supported through their owner', () => {
  const target = boot(); target.eval('ThemeStudio.initPalette();');
  const result = target.api.parse(encoded([item('vmusic.theme.v2', 'anime-shinobi')]));
  assert.equal(result.entries[0].storageValue, 'anime-shinobi');
});

for (const key of Object.keys(excluded)) {
  check('externally supplied excluded key is rejected: ' + key, () => rejected(host, encoded([item(key, 'not-allowed')]), 'unknown-key'));
}
for (const [label, text, code] of [
  ['unknown kind', JSON.stringify({ ...document(), kind: 'hertz-backup' }), 'unknown-kind'],
  ['old data backup', '{"version":1,"favorites":[]}', 'invalid-fields'],
  ['future document version', JSON.stringify({ ...document(), schemaVersion: 2 }), 'unknown-version'],
  ['document version with wrong type', JSON.stringify({ ...document(), schemaVersion: '1' }), 'unknown-version'],
  ['future item version', encoded([item('vmusic.qf-wall', true, 2)]), 'unknown-version'],
  ['item version with wrong type', encoded([item('vmusic.qf-wall', true, '1')]), 'unknown-version'],
  ['missing item value', JSON.stringify(document([{ key: 'vmusic.qf-wall', schemaVersion: 1 }])), 'invalid-fields'],
  ['extra item field', JSON.stringify(document([{ ...item('vmusic.qf-wall', true), storageValue: 'private' }])), 'invalid-fields'],
  ['extra document field', JSON.stringify({ ...document(), storage: {} }), 'invalid-fields'],
  ['nonarray preferences', JSON.stringify({ ...document(), preferences: {} }), 'invalid-type'],
  ['duplicate key', encoded([item('vmusic.qf-wall', true), item('vmusic.qf-wall', false)]), 'duplicate-key'],
  ['33 entries', encoded(Array.from({ length: 33 }, () => item('vmusic.qf-wall', true))), 'too-many-items'],
  ['root null', 'null', 'invalid-fields'],
  ['root array', '[]', 'invalid-fields'],
  ['item null', encoded([null]), 'invalid-fields'],
  ['malformed JSON', '{"kind":', 'invalid-json'],
  ['numeric boolean', encoded([item('vmusic.qf-wall', 1)]), 'invalid-type'],
  ['storage string boolean', encoded([item('vmusic.qf-wall', '1')]), 'invalid-type'],
  ['unknown theme', encoded([item('vmusic.theme.v2', 'unknown-theme')]), 'invalid-value'],
  ['unknown skin', encoded([item('vmusic.skin', 'qf')]), 'invalid-value'],
  ['unknown default page', encoded([item('vmusic.defaultView', 'gone')]), 'invalid-value'],
  ['unknown playlist layout', encoded([item('vmusic.playlists.mode', 'tiles')]), 'invalid-value'],
  ['unknown daily layout', encoded([item('vmusic.dailyview.layout', 'grid')]), 'invalid-value'],
  ['unknown daily source', encoded([item('vmusic.daily.mode', 'auto')]), 'invalid-value'],
  ['legacy stage mode', encoded([item('vmusic.stage.mode', 'line')]), 'invalid-value'],
  ['resource URL color', encoded([item('vmusic.qf-wall-tint-color', 'url(https://invalid.test/x)')]), 'invalid-value'],
  ['color shorthand', encoded([item('vmusic.qf-wall-tint-color', '#abc')]), 'invalid-value'],
  ['numeric value as string', encoded([item('vmusic.qf-wall-tint-intensity', '65')]), 'invalid-value'],
  ['numeric value below range', encoded([item('vmusic.qf-wall-tint-intensity', -1)]), 'invalid-value'],
  ['numeric value above range', encoded([item('vmusic.qf-wall-tint-intensity', 101)]), 'invalid-value'],
  ['numeric fraction', encoded([item('vmusic.qf-wall-tint-intensity', 10.5)]), 'invalid-value'],
  ['reader extra field', encoded([item('hertz-reader-preferences', { size: 19, font: 'serif', theme: 'light', feed: 'private' })]), 'invalid-fields'],
  ['reader size out of range', encoded([item('hertz-reader-preferences', { size: 24, font: 'serif', theme: 'light' })]), 'invalid-value'],
  ['reader font unknown', encoded([item('hertz-reader-preferences', { size: 19, font: 'url-font', theme: 'light' })]), 'invalid-value'],
  ['custom colors missing field', encoded([item('vmusic.theme.custom.v1', { bg: '#181818', accent: '#abcdef' })]), 'invalid-value'],
  ['custom colors extra field', encoded([item('vmusic.theme.custom.v1', { ...colors, css: 'private' })]), 'invalid-value'],
  ['custom colors light background', encoded([item('vmusic.theme.custom.v1', { ...colors, bg: '#ffffff' })]), 'invalid-value'],
  ['stage unknown field', encoded([item('vmusic.stage.control', { project: 'private-project' })]), 'invalid-value'],
  ['stage coerced toggle', encoded([item('vmusic.stage.control', { dust: 1 })]), 'invalid-value'],
  ['stage coerced numeric', encoded([item('vmusic.stage.control', { grain: '8' })]), 'invalid-value'],
  ['stage numeric out of range', encoded([item('vmusic.stage.control', { fluidStrength: 101 })]), 'invalid-value'],
  ['stage numeric wrong step', encoded([item('vmusic.stage.control', { density: 103 })]), 'invalid-value'],
  ['stage select unknown', encoded([item('vmusic.stage.control', { lyricFont: 'resource-font' })]), 'invalid-value'],
  ['stage nonfinite JSON number', encoded([item('vmusic.stage.control', { grain: null })]), 'invalid-value'],
]) {
  check(label, () => rejected(host, text, code));
}

for (const property of ['__proto__', 'constructor', 'prototype']) {
  check('prototype property rejected at root: ' + property, () => {
    rejected(host, `{"kind":"hertz-ui-preferences","schemaVersion":1,"preferences":[],"${property}":{"polluted":true}}`, 'unsafe-value');
  });
  check('prototype property rejected inside reader value: ' + property, () => {
    const text = `{"kind":"hertz-ui-preferences","schemaVersion":1,"preferences":[{"key":"hertz-reader-preferences","schemaVersion":1,"value":{"size":19,"font":"serif","theme":"light","${property}":{"polluted":true}}}]}`;
    rejected(host, text, 'unsafe-value');
  });
}
check('rejections leave the JavaScript prototype untouched', () => assert.equal(host.eval('({}).polluted'), undefined));
check('excessive nesting is rejected before owner processing', () => {
  let value = true; for (let i = 0; i < 8; i += 1) value = { nested: value };
  rejected(host, encoded([item('vmusic.stage.control', value)]), 'unsafe-value');
});
check('64 KiB file boundary allows exact size and rejects one more byte', () => {
  const minimal = JSON.stringify(document());
  const exact = minimal + ' '.repeat(host.api.maxBytes - Buffer.byteLength(minimal));
  assert.equal(host.api.parse(exact).entries.length, 0);
  rejected(host, exact + ' ', 'too-large');
});
check('capacity is measured in UTF-8 bytes rather than JavaScript string length', () => {
  const text = JSON.stringify({ ...document(), extra: '界'.repeat(24000) });
  assert.ok(text.length < host.api.maxBytes); assert.ok(Buffer.byteLength(text) > host.api.maxBytes);
  rejected(host, text, 'too-large');
});
check('UTF-8 fallback counts surrogate pairs and multibyte characters correctly', () => {
  const target = boot({}, { fallbackEncoder: true });
  const text = JSON.stringify({ ...document(), extra: '😀'.repeat(17000) });
  assert.ok(text.length < target.api.maxBytes);
  rejected(target, text, 'too-large');
});
check('a UTF-8 BOM is accepted within the same capacity', () => {
  assert.equal(host.api.parse('\ufeff' + JSON.stringify(document())).entries.length, 0);
});
check('preview display fields cannot inject additional writes', () => {
  const target = boot();
  const result = target.api.parse(encoded([item('vmusic.qf-wall', true)]));
  result.entries[0].key = 'token'; result.entries[0].storageValue = 'private';
  result.entries.push({ key: 'token', value: 'private' });
  assert.deepEqual(plain(target.api.writes(result)), [{ key: 'vmusic.qf-wall', value: '1' }]);
});
check('changing the preview document to an excluded key is revalidated', () => {
  const target = boot(); const result = target.api.parse(encoded([item('vmusic.qf-wall', true)]));
  result.document.preferences[0].key = 'token';
  assert.throws(() => target.api.writes(result), (error) => error.code === 'unknown-key');
});
check('mutated programmatic document prototypes are rejected', () => {
  const target = boot(); const result = target.api.parse(encoded([item('vmusic.qf-wall', true)]));
  Object.setPrototypeOf(result.document, { polluted: true });
  assert.throws(() => target.api.writes(result), (error) => error.code === 'invalid-type');
});
check('writers cannot invent unrelated storage keys or omit required migration markers', () => {
  const target = boot();
  target.eval("StageControl.preferenceTransfer = value => ({value,writes:[{key:'token',value:'private'}]});");
  rejected(target, encoded([item('vmusic.stage.control', {})]), 'owner-contract');
  target.eval("StageControl.preferenceTransfer = value => ({value,writes:[{key:'vmusic.stage.control',value:'{}'}]});");
  rejected(target, encoded([item('vmusic.stage.control', {})]), 'owner-contract');
});
check('missing callback owners are lazy failures confined to their own preferences', () => {
  const target = boot({}, { configure: false });
  assert.equal(target.api.parse(encoded([item('vmusic.qf-wall', false)])).entries.length, 1);
  rejected(target, encoded([item('vmusic.playlists.mode', 'grid')]), 'owner-not-ready');
  rejected(target, encoded([item('vmusic.defaultView', 'home')]), 'owner-not-ready');
});
check('invalid existing storage is reported without partially exporting it', () => {
  const target = boot({ ...fixture, 'vmusic.qf-wall': 'true' });
  assert.throws(() => target.api.exportDocument(), (error) => error.code === 'invalid-value');
  assert.deepEqual(target.mutations, []);
});
check('storage read failures remain visible and do not become empty successful exports', () => {
  const target = boot();
  target.context.localStorage.getItem = () => { throw new Error('storage unavailable'); };
  assert.throws(() => target.api.exportDocument(), (error) => error.code === 'storage-read-failed');
});

console.log(`PASS ${checks} UI preference schema and owner checks`);
