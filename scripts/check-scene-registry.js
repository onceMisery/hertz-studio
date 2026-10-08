// SPDX-License-Identifier: MIT
// Real registration, preset/share ownership and host lifecycle; rendering pixels has browser coverage.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ui = path.resolve(__dirname, '../plugin/ui');
const read = name => fs.readFileSync(path.join(ui, name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
let checks = 0;
function equal(actual, expected, label) { assert.deepEqual(plain(actual), plain(expected), label); checks++; }
function ok(value, label) { assert.ok(value, label); checks++; }
function rejected(fn, label) { assert.throws(fn, undefined, label); checks++; }

function creativeContext(revision) {
  const box = { console, TextEncoder, TextDecoder, Uint8Array, Blob, ReadableStream, TransformStream,
    btoa, atob, CompressionStream, DecompressionStream,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    localStorage: { getItem: () => null, setItem() {} }, performance: { now: () => 0 },
    document: { getElementById: () => null, addEventListener() {} },
    Stage: { gate() {}, kick() {}, position: () => 0 } };
  box.window = box; vm.createContext(box);
  for (const file of ['onset.js', 'creative-gl.js', 'backgrounds.js', 'handdrawn.js', 'creative-stage.js', 'creative-share-code.js', 'creative-prompt.js']) {
    const content = revision && ['creative-gl.js', 'creative-stage.js'].includes(file)
      ? execFileSync('git', ['show', revision + ':plugin/ui/' + file], { encoding: 'utf8', cwd: path.dirname(ui) }) : read(file);
    vm.runInContext(content, box, { filename: file });
  }
  box.Backgrounds.apply = box.HandDrawn.apply = () => {};
  box.CreativeStage.init();
  return box;
}

function dummyScene() {
  return { id: 'registry-probe', label: '注册场景', aliases: ['注册试演', 'registry probe'],
    params: [['amount', '强度', 0, 8, 0.1, '', 2.5]],
    camera: { 'cam.yaw': 18, 'cam.pitch': 12, 'cam.dist': 17, 'cam.height': 1.2, 'cam.fov': 62 },
    ownsLyrics: true, geom: { mode: 'TRIANGLES', verts: 3, instances: 1 }, depth: false, blend: 'add',
    uniforms: [], setup() {}, vert: 'void main(){gl_Position=vec4(0.0);}', frag: 'out vec4 frag; void main(){frag=vec4(1.0);}' };
}

async function creative() {
  const box = creativeContext(), GL = box.CreativeGL, CS = box.CreativeStage;
  const count = GL.scenes().length;
  const definition = dummyScene();
  const registered = GL.register(definition);
  ok(GL.scenes().length === count + 1 && CS.scenes().some(def => def.id === definition.id), 'new scene reaches the real catalog');
  definition.params[0][6] = 7; definition.camera['cam.dist'] = 30;
  equal(registered.defaults, { amount: 2.5 }, 'registration copies and derives defaults');
  ok(Object.isFrozen(registered) && Object.isFrozen(registered.params[0]), 'descriptor cannot bypass validation after registration');
  rejected(() => GL.register(dummyScene()), 'duplicate id rejected');
  for (const patch of [
    { params: [['amount', '无效默认值', 0, 8, 0.1, '', 9]] },
    { params: [['amount', '重复', 0, 8, 0.1, '', 2], ['amount', '重复', 0, 8, 0.1, '', 2]] },
    { camera: {} }, { ownsLyrics: 'yes' }, { setup: null }, { geom: { mode: 'TRIANGLES', verts: 0, instances: 1 } },
    { aliases: ['星云'] }, { aliases: ['quiet'] }, { defaults: { amount: 4 } }, { qualityDefs: true }, { exposureScale: NaN },
    { qualityGeom: [{ instances: 1 }, { instances: 1 }, { instances: 1 }] }
  ]) rejected(() => GL.register({ ...dummyScene(), id: 'invalid-probe', aliases: ['unclaimed probe'], ...patch }), 'invalid descriptor rejected atomically');
  ok(GL.scenes().length === count + 1, 'failed registrations leave no partial entries');
  const listed = CS.scenes().find(def => def.id === registered.id);
  listed.params[0][6] = 0;
  ok(CS.setScene(registered.id), 'runtime accepts new id without a branch');
  equal(CS.spec().scene[0], ['sc.amount', '强度', 0, 8, 0.1, '', 2.5], 'parameter panel consumes descriptor');
  equal(CS.preset().sc, { amount: 2.5 }, 'external catalog edits cannot change defaults');
  ok(CS.ownsLyrics(), 'lyric ownership follows capabilities');
  Object.entries(registered.camera).forEach(([key, value]) => equal(CS.preset().cam[key.slice(4)], value, 'entrance camera ' + key));
  CS.patch({ 'cam.dist': 4, 'sc.amount': 99 });
  equal(CS.preset().sc.amount, 8, 'new parameter clamps from descriptor');
  CS.resetView(); equal(CS.preset().cam.dist, 17, 'reset uses descriptor camera');
  CS.setPreset({ scene: registered.id, sc: { amount: -9, unknown: 1 } });
  equal(CS.preset().sc, { amount: 0 }, 'normalization uses new schema and drops unknown keys');
  CS.setParam('sc.amount', 3.5);
  const exported = CS.exportJSON();
  CS.setScene('orb'); ok(!CS.ownsLyrics(), 'ordinary scene restores lyric host capability');
  ok(CS.importJSON(exported).ok, 'JSON import accepts registered scene');
  equal(CS.exportJSON(), exported, 'full JSON preset roundtrip');
  const snapshot = CS.shareSnapshot();
  rejected(() => CS.normalizeSharePreset({ ...snapshot, scene: [registered.id] }), 'scene ids are strings, never coerced lookup keys');
  const encoded = await box.CreativeShareCode.encode(snapshot, { compress: false });
  ok(encoded.startsWith('HSCP1.J.'), 'share format stays v1');
  equal(await box.CreativeShareCode.decode(encoded), snapshot, 'registered scene share roundtrip');
  const intent = box.CreativePrompt.compile('注册试演').intent;
  equal(intent.scene, registered.id, 'prompt discovers aliases registered after compiler startup');
  CS.setScene('orb');
  ok(CS.applyIntent(intent).ok, 'compiled registered scene applies through runtime owner');
  equal(CS.preset().sc, registered.defaults, 'intent applies descriptor defaults');

  const quietBefore = box.CreativePrompt.compile('quiet');
  GL.register({ ...dummyScene(), id: 'alias-probe', aliases: ['constructor', '__proto__'] });
  for (const alias of ['constructor', '__proto__']) {
    const result = box.CreativePrompt.compile(alias);
    ok(result.ok && result.intent.scene === 'alias-probe', 'prototype-like alias compiles through real registration: ' + alias);
  }
  equal(box.CreativePrompt.compile('quiet'), quietBefore, 'new prototype-like aliases leave existing prompt compilation unchanged');

  const cameraRows = GL.cameraSpec();
  equal(CS.spec().base.find(group => group.id === 'cam').items.slice(0, cameraRows.length), cameraRows, 'registration and parameter panel share one camera contract');
  for (const [path, , min, max] of cameraRows) {
    const key = path.slice(4);
    for (const value of [min - 1, max + 1, NaN, Infinity, '12', undefined]) {
      const invalid = { ...dummyScene(), id: 'invalid-camera', aliases: [], camera: { ...dummyScene().camera, [path]: value } };
      rejected(() => GL.register(invalid), path + ' rejects invalid or out-of-contract camera defaults');
    }
    for (const [edge, value] of [['min', min], ['max', max]]) {
      const id = 'camera-' + edge + '-' + key;
      GL.register({ ...dummyScene(), id, aliases: [], camera: { ...dummyScene().camera, [path]: value } });
      CS.setScene(id);
      equal(CS.preset().cam[key], value, path + ' entrance preserves boundary ' + edge);
      CS.patch({ [path]: (min + max) / 2 }); CS.resetView();
      equal(CS.preset().cam[key], value, path + ' reset preserves boundary ' + edge);
      const saved = CS.exportJSON(); CS.setScene('orb');
      ok(CS.importJSON(saved).ok, path + ' boundary imports');
      equal(CS.exportJSON(), saved, path + ' boundary roundtrip stays identical');
      equal(CS.setPreset({ scene: id }).cam[key], value, path + ' normalization preserves boundary ' + edge);
    }
  }

  if (process.env.SCENE_BASELINE) {
    const old = creativeContext(process.env.SCENE_BASELINE).CreativeStage;
    for (const { id } of GL.scenes().slice(0, count)) {
      for (const input of [{ scene: id }, { scene: id, cam: { yaw: 78, dist: 2 }, sc: { unknown: 42 } },
        { scene: id, cam: { pitch: -999, fov: 999 }, look: { bloom: 999 }, director: false }]) {
        equal(CS.setPreset(input), old.setPreset(input), 'baseline normalization ' + id);
      }
      CS.setScene(id); old.setScene(id);
      equal(CS.preset(), old.preset(), 'baseline defaults and entrance camera ' + id);
      equal(CS.spec(), old.spec(), 'baseline parameter schema ' + id);
    }
  }
}

function node() {
  return { hidden: false, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    dataset: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, setAttribute() {},
    options: [], appendChild(item) { this.options.push(item); }, getBoundingClientRect: () => ({ width: 100, height: 100 }) };
}

function lyricHost() {
  const calls = [], instances = {}, hosts = {}, root = node();
  let destroyFailure = null;
  for (const id of ['s3d-fl-bg', 's3d-fl-sub', 's3d-fl-lyric', 's3d-fl-sonnet-stage', 's3d-lyric-visual']) hosts[id] = node();
  function renderer(id) {
    const api = { rootEl: () => api.element, element: node(), isReady: () => true };
    for (const method of ['setTheme', 'setFontScale', 'setTuning', 'setVisible', 'setPaused', 'setEco', 'update', 'frame',
      'destroy', 'setMode', 'setOpacity', 'setVignette', 'setMotion', 'setReactivity', 'setBgMode', 'resize']) {
      api[method] = value => {
        calls.push({ id, method, value });
        if (method === 'setVisible') api.element.hidden = !value;
        if (method === 'destroy' && destroyFailure === id) throw new Error('cleanup probe');
      };
    }
    instances[id] = api; return api;
  }
  let directed = 'classic';
  const box = { console, performance: { now: () => 0 }, setTimeout: () => 0, clearTimeout() {},
    addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }),
    document: { readyState: 'loading', addEventListener() {}, removeEventListener() {}, documentElement: node(), body: node(),
      getElementById: id => hosts[id] || null, querySelector: () => null, createElement: node },
    StageSettings: require(path.join(ui, 'stage-settings.js')),
    Stage: { presentation: () => ({ playing: false }), position: () => 0, tier: () => 2, lyrics: () => null, lyricOffset: () => 0, removeGate() {} },
    StanzaTheme: { resolve: () => ({ name: 'base' }), resolveSonnet: () => ({ name: 'sonnet' }), resolveTempera: () => ({ name: 'tempera' }), signature: t => t.name },
    StanzaStarborn: { init: () => ({ snapshot: () => ({ directedMode: directed }), setTransitionLock() {}, setAvoidRepeat() {},
      frame() { calls.push({ id: 'starborn', method: 'frame' }); }, reset() {} }) }
  };
  for (const [name, id] of [['StanzaBg', 'bg'], ['StanzaSubtitle', 'sub'], ['StanzaClassic', 'classic'], ['StanzaCadenza', 'cadenza'], ['StanzaSonnet', 'sonnet'], ['StanzaTempera', 'tempera']]) {
    box[name] = { init(host, seek) { calls.push({ id, method: 'init', host, seek }); return renderer(id); } };
  }
  box.window = box; vm.createContext(box);
  // Expose existing closure functions to the harness; no substitute dispatcher or lifecycle.
  vm.runInContext(read('stage3d.js').replace('  global.Stage3D = api;', `
    global.probe = { mount: function (host) { root = host; ensureStanza(); }, stanza: stanza,
      configure: applyStanzaConfig, frame: driveStanza, update: syncStanzaMeta, plane: planeFor,
      stages: STAGES, buildField: buildField, buildPrism: buildPrism,
      ownsLyrics: sceneOwnsLyrics, source: function (s) { sceneSource = s; } };
    global.Stage3D = api;`), box);
  const host = box.Stage3D, probe = box.probe;
  rejected(() => host.registerLyricRenderer({ id: 'classic' }), 'duplicate renderer rejected');
  rejected(() => host.registerLyricRenderer({ id: 'broken', label: '无效', host: 'x', create() {} }), 'missing renderer theme rejected');
  probe.mount(root);
  equal(calls.filter(c => c.method === 'init').map(c => c.id), ['bg', 'sub', 'classic', 'cadenza', 'sonnet', 'tempera'], 'each registered renderer initializes once');
  equal(calls.filter(c => c.method === 'init' && ['classic', 'cadenza', 'sonnet'].includes(c.id)).map(c => typeof c.seek), ['function', 'function', 'function'], 'seek reaches interactive renderers');
  ok(calls.find(c => c.id === 'tempera' && c.method === 'init').seek === undefined, 'Tempera keeps stage click ownership');
  equal(calls.filter(c => c.method === 'setTheme' && ['classic', 'cadenza', 'sonnet', 'tempera'].includes(c.id)).slice(0, 4).map(c => c.value.name), ['base', 'base', 'sonnet', 'tempera'], 'theme roles reach actual renderer instances');
  probe.mount(root); equal(calls.filter(c => c.method === 'init').length, 6, 'repeated ensure does not reinitialize');
  hosts['probe-host'] = node();
  host.registerLyricRenderer({ id: 'probe', label: '试演歌词', host: 'probe-host', create: () => renderer('probe'), theme: () => ({ name: 'probe' }) });
  ok(host.lyricVisuals().some(def => def.id === 'probe'), 'new renderer reaches metadata catalog');
  ok(hosts['s3d-lyric-visual'].options.some(item => item.value === 'probe'), 'new renderer reaches selector');
  probe.stanza.visual = 'probe'; probe.configure();
  equal(box.StageSettings.resolve({ visuals: host.lyricVisuals(), visual: 'probe' }).label, '试演歌词', 'settings label consumes registered metadata');
  ok(!instances.probe.element.hidden && !hosts['probe-host'].hidden, 'new renderer and host become visible');
  calls.length = 0; probe.frame(16); probe.update();
  ok(calls.some(c => c.id === 'probe' && c.method === 'frame') && calls.some(c => c.id === 'probe' && c.method === 'update'), 'frame and metadata update dispatch to new instance');
  ok(!calls.some(c => ['classic', 'cadenza', 'sonnet', 'tempera'].includes(c.id) && ['frame', 'update'].includes(c.method)), 'inactive instances do not animate');
  equal(probe.plane('unavailable').id, 'classic', 'missing renderer reports actual fallback id');
  probe.stanza.visual = 'starborn'; directed = 'sonnet'; probe.configure(); calls.length = 0; probe.frame(16);
  equal(calls.filter(c => c.method === 'frame').map(c => c.id), ['starborn', 'bg', 'sonnet'], 'director runs before the renderer, without becoming a renderer');
  box.CreativeStage = { stageActive: () => true, ownsLyrics: () => true }; probe.source('creative');
  ok(probe.ownsLyrics(), 'creative lyric ownership uses capability without id dispatch');
  probe.configure(); calls.length = 0; probe.frame(16);
  equal(calls.length, 0, 'creative-owned lyrics stop other lyric frame work');
  ok(Object.entries(instances).filter(([id]) => !['bg', 'sub'].includes(id)).every(([, api]) => api.element.hidden), 'creative-owned lyrics hide all registered layers');
  probe.source('immersive');
  ok(probe.stages.every(def => typeof def.build === 'function'), 'immersive descriptors own factories');
  ok(probe.stages.find(def => def.id === 'prism').build === probe.buildPrism && probe.stages.filter(def => def.id !== 'prism').every(def => def.build === probe.buildField), 'built-in factory bindings preserved');
  host.destroy();
  equal(calls.filter(c => c.method === 'destroy').map(c => c.id), ['bg', 'sub', 'classic', 'cadenza', 'sonnet', 'tempera', 'probe'], 'destroy releases every instance once');

  // A late factory failure must unwind background, subtitle and earlier renderers before retry.
  let failure = 'contract';
  const factoryError = new Error('factory probe');
  hosts['failure-host'] = node();
  host.registerLyricRenderer({ id: 'failure', label: '初始化失败回归', host: 'failure-host', theme: () => ({ name: 'failure' }),
    create() {
      if (failure === 'throw') throw factoryError;
      const api = renderer('failure');
      if (failure === 'contract') delete api.frame;
      return api;
    } });
  const owned = ['bg', 'sub', 'classic', 'cadenza', 'sonnet', 'tempera', 'probe'];
  calls.length = 0; destroyFailure = 'failure';
  assert.throws(() => probe.mount(root), /缺少生命周期方法 failure/, 'invalid instance cleanup cannot mask the validation error'); checks++;
  equal(calls.filter(c => c.method === 'destroy').map(c => c.id), ['failure', ...owned], 'failed initialization unwinds all created instances');
  ok(!probe.stanza.ready && probe.stanza.bg === null && probe.stanza.sub === null && probe.plane('classic').api === null, 'failed initialization retains no live references');
  host.destroy();
  equal(calls.filter(c => c.method === 'destroy').length, owned.length + 1, 'destroy after failure never double-disposes the partial attempt');
  calls.length = 0; failure = 'throw'; destroyFailure = 'cadenza';
  assert.throws(() => probe.mount(root), error => error === factoryError, 'original factory exception survives cleanup errors'); checks++;
  equal(calls.filter(c => c.method === 'destroy').map(c => c.id), owned, 'one throwing destructor does not stop other cleanup');
  ok(!probe.stanza.ready && probe.plane('probe').api === null, 'throwing factory also leaves a clean retry state');
  calls.length = 0; failure = null; destroyFailure = null;
  probe.mount(root);
  ok(probe.stanza.ready && probe.plane('failure').id === 'failure', 'retry can initialize all renderers successfully');
  equal(calls.filter(c => c.method === 'init').map(c => c.id), owned.slice(0, 6), 'retry creates exactly one new set of built-in instances');
  host.destroy(); host.destroy();
  equal(calls.filter(c => c.method === 'destroy').map(c => c.id), [...owned, 'failure'], 'successful retry disposes once, including previously failing extension');
}

(async () => {
  await creative(); lyricHost();
  console.log('Scene registry: ' + checks + ' checks passed (new scene/preset/share/prompt, renderer lifecycle, factory ownership' + (process.env.SCENE_BASELINE ? ', baseline ' + process.env.SCENE_BASELINE : '') + ')');
})().catch(error => { console.error(error); process.exitCode = 1; });
