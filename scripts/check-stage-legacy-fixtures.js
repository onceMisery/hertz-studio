// SPDX-License-Identifier: MIT
// Frozen pre-materializer behavior and share frames, replayed against real modules.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'evals/stage/legacy-v1');
const FILES = ['onset.js', 'creative-gl.js', 'backgrounds.js', 'handdrawn.js',
  'creative-anime.js', 'creative-stage.js', 'creative-share-code.js'];
const plain = value => JSON.parse(JSON.stringify(value));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function context(sources) {
  const applyCalls = { backgrounds: [], handdrawn: [] };
  const env = { console, TextEncoder, TextDecoder, Uint8Array, Blob, ReadableStream, TransformStream,
    btoa, atob, CompressionStream, DecompressionStream,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem() { return null; }, setItem() {} }, performance: { now: () => 0 },
    document: { hidden: false, getElementById() { return null; }, addEventListener() {},
      dispatchEvent() {}, body: { classList: { contains() { return false; } } } },
    Stage: { gate() {}, kick() {}, position: () => 0, tier: () => 2 }, CustomEvent: class {} };
  env.window = env;
  env.applyCalls = applyCalls;
  vm.createContext(env);
  for (const file of FILES) vm.runInContext(sources[file], env, { filename: file, timeout: 5000 });
  env.Backgrounds.apply = value => applyCalls.backgrounds.push(plain(value));
  env.HandDrawn.apply = value => applyCalls.handdrawn.push(plain(value));
  env.CreativeStage.init();
  applyCalls.backgrounds.length = 0;
  applyCalls.handdrawn.length = 0;
  return env;
}
function clearApplyCalls(env) {
  env.applyCalls.backgrounds.length = 0;
  env.applyCalls.handdrawn.length = 0;
}
async function main() {
  const fixtureBytes = fs.readFileSync(path.join(DIR, 'fixtures.json'));
  const compressedFramesBytes = fs.readFileSync(path.join(DIR, 'compressed-frames.json'));
  const packed = fs.readFileSync(path.join(DIR, 'sources.json.gz'));
  const sourceBytes = zlib.gunzipSync(packed, { maxOutputLength: 2 * 1024 * 1024 });
  const fixture = JSON.parse(fixtureBytes), sources = JSON.parse(sourceBytes);
  const compressedFrames = JSON.parse(compressedFramesBytes);
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json')));
  assert.equal(hash(fixtureBytes), manifest.fixturesHash);
  assert.equal(hash(compressedFramesBytes), manifest.compressedFramesHash);
  assert.equal(hash(packed), manifest.compressedSourcesHash);
  assert.equal(hash(sourceBytes), manifest.sourcesHash);
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.sourceRef, 'b8aff4a89dc3f1e43981d2227838e497e65ea9b2');
  assert.equal(fixture.sourceRef, manifest.sourceRef);
  assert.equal(compressedFrames.schemaVersion, 1);
  assert.equal(compressedFrames.sourceRef, fixture.sourceRef);
  assert.deepEqual(Object.keys(sources), FILES);
  for (const file of FILES) {
    assert.equal(hash(Buffer.from(sources[file])), fixture.sourceHashes[file], file);
    if (process.argv.includes('--git')) {
      const bytes = execFileSync('git', ['show', fixture.sourceRef + ':plugin/ui/' + file],
        { cwd: ROOT, maxBuffer: 2 * 1024 * 1024 });
      assert.equal(hash(bytes), fixture.sourceHashes[file], 'Historical Git identity: ' + file);
    }
  }
  const old = context(sources);
  const current = context(Object.fromEntries(FILES.map(file =>
    [file, fs.readFileSync(path.join(ROOT, 'plugin/ui', file), 'utf8')])));
  const sceneIds = plain(old.CreativeGL.scenes().map(scene => scene.id));
  assert.equal(sceneIds.length, 10);
  assert.deepEqual([...new Set(fixture.rows.map(row => row.scene))], sceneIds);
  assert.equal(fixture.rows.length, 20);
  assert.equal(new Set(fixture.rows.map(row => row.scene + '/' + row.mode)).size, 20);
  for (const scene of sceneIds) assert.deepEqual(fixture.rows.filter(r => r.scene === scene).map(r => r.mode), ['switch', 'edit']);
  for (const row of fixture.rows) {
    const label = row.scene + '/' + row.mode;
    old.CreativeStage.setPreset(row.base);
    clearApplyCalls(old);
    const historical = old.CreativeStage.applyIntent(row.intent);
    assert.equal(historical.ok, true, label);
    assert.deepEqual(plain(historical.preset), row.expected, label + ' recorded historical behavior');
    assert.deepEqual(plain(historical.applied), row.applied);
    assert.deepEqual(plain(historical.ignored), row.ignored);
    assert.deepEqual(plain(old.applyCalls), {
      backgrounds: [], handdrawn: [row.expected.hand],
    }, label + ' historical runtime application');
    assert.equal(await old.CreativeShareCode.encode(historical.preset, { compress: false }), row.shareCode);
    const before = plain(current.CreativeStage.preset());
    clearApplyCalls(current);
    const output = current.CreativeStage.materializeIntent(row.base, row.intent);
    assert.equal(output.ok, true, label);
    assert.deepEqual(plain(output.preset), row.expected, label + ' current materialization');
    assert.deepEqual(plain(output.applied), row.applied);
    assert.deepEqual(plain(output.ignored), row.ignored);
    assert.deepEqual(plain(current.CreativeStage.preset()), before, label + ' pure materialization');
    assert.deepEqual(plain(current.applyCalls), { backgrounds: [], handdrawn: [] },
      label + ' materialization has no presentation side effects');
    assert.deepEqual(plain(await current.CreativeShareCode.decode(row.shareCode)), row.expected,
      label + ' fixed historical share import');
    current.CreativeStage.setPreset(row.base);
    clearApplyCalls(current);
    const applied = current.CreativeStage.applyIntent(row.intent);
    assert.equal(applied.ok, true);
    assert.deepEqual(plain(applied.preset), row.expected, label + ' existing rule entry');
    assert.deepEqual(plain(current.applyCalls), plain(old.applyCalls),
      label + ' current runtime application matches historical calls');
  }
  const compressedCase = 'towers/switch';
  const compressedRow = fixture.rows.find(row => row.scene + '/' + row.mode === compressedCase);
  const compressedFrame = compressedFrames.frames[compressedCase];
  assert.ok(compressedRow && typeof compressedFrame === 'string');
  assert.ok(compressedFrame.startsWith('HSCP1.G.'), 'fixed historical compressed frame');
  assert.deepEqual(plain(await old.CreativeShareCode.decode(compressedFrame)), compressedRow.expected,
    'archived codec decodes fixed compressed frame');
  assert.deepEqual(plain(await current.CreativeShareCode.decode(compressedFrame)), compressedRow.expected,
    'current codec imports fixed historical compressed frame');
  const archivedCompressed = await old.CreativeShareCode.encode(compressedRow.expected);
  assert.ok(archivedCompressed.startsWith('HSCP1.G.'), 'archived encoder emits compressed frame');
  assert.deepEqual(plain(await current.CreativeShareCode.decode(archivedCompressed)), compressedRow.expected,
    'current codec decodes archived encoder output');
  const currentCompressed = await current.CreativeShareCode.encode(compressedRow.expected);
  assert.ok(currentCompressed.startsWith('HSCP1.G.'), 'current encoder emits compressed frame');
  assert.deepEqual(plain(await old.CreativeShareCode.decode(currentCompressed)), compressedRow.expected,
    'archived codec decodes current encoder output');
  console.log('Historical stage fixtures: 10 scenes / 20 switch+edit cases + 1 fixed gzip frame; source replay, pure materialization, rule entry and bidirectional share codec compatibility passed' +
    (process.argv.includes('--git') ? '; Git source identities verified' : ''));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
