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
  const env = { console, TextEncoder, TextDecoder, Uint8Array, Blob, ReadableStream, TransformStream,
    btoa, atob, CompressionStream, DecompressionStream,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem() { return null; }, setItem() {} }, performance: { now: () => 0 },
    document: { hidden: false, getElementById() { return null; }, addEventListener() {},
      dispatchEvent() {}, body: { classList: { contains() { return false; } } } },
    Stage: { gate() {}, kick() {}, position: () => 0, tier: () => 2 }, CustomEvent: class {} };
  env.window = env;
  vm.createContext(env);
  for (const file of FILES) vm.runInContext(sources[file], env, { filename: file, timeout: 5000 });
  // Painting, event delivery and storage are outside this metadata/codec check.
  env.Backgrounds.apply = () => {};
  env.HandDrawn.apply = () => {};
  env.CreativeStage.init();
  return env;
}
async function main() {
  const fixtureBytes = fs.readFileSync(path.join(DIR, 'fixtures.json'));
  const packed = fs.readFileSync(path.join(DIR, 'sources.json.gz'));
  const sourceBytes = zlib.gunzipSync(packed, { maxOutputLength: 2 * 1024 * 1024 });
  const fixture = JSON.parse(fixtureBytes), sources = JSON.parse(sourceBytes);
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json')));
  assert.equal(hash(fixtureBytes), manifest.fixturesHash);
  assert.equal(hash(packed), manifest.compressedSourcesHash);
  assert.equal(hash(sourceBytes), manifest.sourcesHash);
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.sourceRef, 'b8aff4a89dc3f1e43981d2227838e497e65ea9b2');
  assert.equal(fixture.sourceRef, manifest.sourceRef);
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
    const historical = old.CreativeStage.applyIntent(row.intent);
    assert.equal(historical.ok, true, label);
    assert.deepEqual(plain(historical.preset), row.expected, label + ' recorded historical behavior');
    assert.deepEqual(plain(historical.applied), row.applied);
    assert.deepEqual(plain(historical.ignored), row.ignored);
    assert.equal(await old.CreativeShareCode.encode(historical.preset, { compress: false }), row.shareCode);
    const before = plain(current.CreativeStage.preset());
    const output = current.CreativeStage.materializeIntent(row.base, row.intent);
    assert.equal(output.ok, true, label);
    assert.deepEqual(plain(output.preset), row.expected, label + ' current materialization');
    assert.deepEqual(plain(output.applied), row.applied);
    assert.deepEqual(plain(output.ignored), row.ignored);
    assert.deepEqual(plain(current.CreativeStage.preset()), before, label + ' pure materialization');
    assert.deepEqual(plain(await current.CreativeShareCode.decode(row.shareCode)), row.expected,
      label + ' fixed historical share import');
    current.CreativeStage.setPreset(row.base);
    const applied = current.CreativeStage.applyIntent(row.intent);
    assert.equal(applied.ok, true);
    assert.deepEqual(plain(applied.preset), row.expected, label + ' existing rule entry');
  }
  console.log('Historical stage fixtures: 10 scenes / 20 switch+edit cases; source replay, pure materialization, rule entry and fixed share import passed' +
    (process.argv.includes('--git') ? '; Git source identities verified' : ''));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
