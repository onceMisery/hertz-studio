// SPDX-License-Identifier: MIT
// Exercise the real scene registry, preset owner, prompt compiler and share codec.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ui = path.resolve(__dirname, '../plugin/ui');
const plain = value => JSON.parse(JSON.stringify(value));
const saved = new Map();
const box = {
  console, TextEncoder, TextDecoder, Uint8Array, Blob, ReadableStream, TransformStream,
  btoa, atob, CompressionStream, DecompressionStream,
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) },
  performance: { now: () => 0 },
  document: { getElementById: () => null, addEventListener() {} },
  Stage: { gate() {}, kick() {}, position: () => 0 }
};
box.window = box;
vm.createContext(box);
for (const file of ['onset.js', 'creative-gl.js', 'creative-anime.js', 'backgrounds.js',
  'handdrawn.js', 'creative-stage.js', 'creative-share-code.js', 'creative-prompt.js']) {
  const location = path.join(ui, file);
  if (file === 'creative-anime.js' && !fs.existsSync(location)) continue;
  vm.runInContext(fs.readFileSync(location, 'utf8'), box, { filename: file });
}
box.Backgrounds.apply = box.HandDrawn.apply = () => {};
box.CreativeStage.init();

async function main() {
  const CS = box.CreativeStage, GL = box.CreativeGL;
  const scenes = CS.scenes().filter(scene => scene.presentation?.family === 'anime');
  assert.equal(scenes.length, 4, 'four illustrated scenes are available through the production catalog');
  const invalidPaint = { ...GL.sceneById(scenes[0].id), id: 'bad-paint-mode', aliases: [], toneMapped: 'false' };
  delete invalidPaint.defaults;
  assert.throws(() => GL.register(invalidPaint), 'invalid color mapping flag is rejected');
  const old = CS.preset();
  let checks = 2;
  for (const scene of scenes) {
    assert.equal(CS.setScene(scene.id), true, scene.label + ' selects through the existing preset owner');
    const before = plain(CS.preset());
    assert.equal(CS.ownsLyrics(), false, scene.label + ' leaves lyrics to the existing host');
    assert.equal(GL.sceneById(scene.id).depth, false, scene.label + ' uses a flat drawing surface');
    assert.ok(scene.presentation.art.startsWith('<svg'), scene.label + ' has a local navigation illustration');
    assert.ok(Object.isFrozen(GL.sceneById(scene.id).presentation), 'display metadata is immutable at registration');
    scene.presentation.family = 'changed';
    assert.equal(GL.sceneById(scene.id).presentation.family, 'anime', 'catalog consumers cannot mutate registered metadata');
    checks += 6;

    function frameAt(rotation, yaw) {
      let frame;
      const c = Math.cos(rotation), s = Math.sin(rotation);
      GL.sceneById(scene.id).setup({ uniform3f() {}, uniform4f(_, ...value) { frame = value; } }, { uFrame: 'frame' }, {
        p: GL.sceneById(scene.id).defaults,
        cam: { yaw, pitch: 0, dist: 20, fov: 55, tx: 0, ty: 0, tz: 0 },
        modelMatrix: [c,0,-s,0,0,1,0,0,s,0,c,0,0,0,0,1]
      });
      return frame;
    }
    assert.ok(Math.abs(frameAt(Math.PI - .0001, 0)[0] - frameAt(Math.PI + .0001, 0)[0]) < .1,
      scene.label + ' keeps the panorama continuous when model rotation crosses 180 degrees');
    assert.ok(Math.abs(frameAt(0, Math.PI - .0001)[0] - frameAt(0, -Math.PI + .0001)[0]) < .1,
      scene.label + ' keeps the panorama continuous when camera yaw wraps');
    checks += 2;

    for (const row of scene.params) {
      CS.setParam('sc.' + row[0], row[3] + 100);
      assert.equal(CS.preset().sc[row[0]], row[3], 'editing clamps ' + row[0]);
      CS.setParam('sc.' + row[0], row[2]);
      assert.equal(CS.preset().sc[row[0]], row[2], 'minimum remains valid ' + row[0]);
      checks += 2;
    }
    CS.setPreset(before);
    CS.setStyle('off');
    const snapshot = plain(CS.shareSnapshot());
    const code = await box.CreativeShareCode.encode(snapshot, { compress: false });
    assert.deepEqual(plain(await box.CreativeShareCode.decode(code)), snapshot, scene.label + ' shares through v1');
    const exported = CS.exportJSON();
    CS.setScene('orb');
    assert.ok(CS.importJSON(exported).ok, scene.label + ' imports through the existing JSON format');
    assert.equal(CS.exportJSON(), exported, scene.label + ' roundtrips the full composition');

    const intent = box.CreativePrompt.compile(scene.aliases[0]);
    assert.ok(intent.ok && intent.intent.scene === scene.id, scene.label + ' is discoverable by its Chinese name');
    CS.setScene('orb');
    const applied = CS.applyIntent(intent.intent);
    assert.ok(applied.ok, scene.label + ' prompt applies atomically: ' + JSON.stringify(applied));
    assert.equal(CS.preset().scene, scene.id);
    const art = CS.savePreset(scene.label);
    CS.resetSettings();
    assert.equal(CS.preset().scene, old.scene, 'restore uses the established stage default');
    assert.ok(CS.library().some(item => item.id === art.id), 'restore preserves saved artwork');
    CS.loadPresetById(art.id);
    assert.equal(CS.preset().scene, scene.id, 'saved artwork reloads after restore');
    CS.patch({ 'cam.dist': 4, 'cam.pitch': 50 });
    CS.resetView();
    assert.equal(CS.preset().cam.dist, scene.camera['cam.dist'], 'camera reset reads the registered view');
    checks += 10;
  }
  CS.setPreset(old);
  console.log('PASS ' + checks + ' anime scene registration, editing, sharing, prompt and restore checks');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
