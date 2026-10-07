// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const web = path.join(__dirname, '..', 'plugin', 'ui');
let checks = 0;
function ok(value, label) { assert.ok(value, label); checks += 1; }
function json(value) { return JSON.parse(JSON.stringify(value)); }
function context(capabilities = {}) {
  const ctx = { console, TextEncoder, TextDecoder, Uint8Array, Blob, ReadableStream, TransformStream,
    btoa, atob, CompressionStream, DecompressionStream, ...capabilities,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    localStorage: { getItem() { return null; }, setItem() {} },
    document: { getElementById() { return null; }, addEventListener() {} },
    performance: { now: () => 0 }, Stage: { gate() {}, kick() {}, position: () => 0 } };
  ctx.window = ctx; vm.createContext(ctx);
  for (const file of ['onset.js', 'creative-gl.js', 'backgrounds.js', 'handdrawn.js', 'creative-stage.js', 'creative-share-code.js']) {
    vm.runInContext(fs.readFileSync(path.join(web, file), 'utf8'), ctx, { filename: file });
  }
  // Pixel/DOM painting is outside the codec; effective defaults and schemas above are real modules.
  ctx.Backgrounds.apply = () => {};
  ctx.HandDrawn.apply = () => {};
  ctx.CreativeStage.init();
  return ctx;
}
function frame(bytes, mode = 'J', version = 1) {
  return 'HSCP' + version + '.' + mode + '.' + bytes.toString('base64url') + '.' + zlib.crc32(bytes).toString(16).padStart(8, '0');
}
async function rejects(codec, text, message) {
  await assert.rejects(codec.decode(text), message); checks += 1;
}
async function main() {
  const env = context(); const CS = env.CreativeStage, codec = env.CreativeShareCode;
  const initial = CS.shareSnapshot(); initial.name = '晚风 · 绘声 🎵';
  initial.cues = [{ at: 1.5, len: 800, ease: 'inout', set: { 'cam.dist': 9, 'look.bloom': 0.3 } }];
  initial.bindings = [{ target: 'cam.shake', source: 'agg.0', gain: 3 }];
  initial.bg = { type: 'mesh', opacity: 78, blur: 24, blend: 'screen', depthMode: 'parallax', hue: 130 };
  const baseline = await codec.encode(initial, { compress: false });
  ok(/^HSCP1\.J\.[A-Za-z0-9_-]+\.[a-f0-9]{8}$/.test(baseline), 'portable frame has version/mode/base64url/checksum');
  assert.deepEqual(json(await codec.decode(baseline)), json(initial)); checks += 1;
  assert.deepEqual(json(await codec.decode('我的创意预置：\n`' + baseline + '`\n请复制整段')), json(initial)); checks += 1;
  const parts = baseline.split('.');
  ok(parts[3] === zlib.crc32(Buffer.from(parts[2], 'base64url')).toString(16).padStart(8, '0'), 'CRC matches independent Node zlib implementation');
  const compact = await codec.encode(initial);
  ok(compact.startsWith('HSCP1.G.') && compact.length < baseline.length, 'gzip used when shorter');
  assert.deepEqual(json(await codec.decode(compact)), json(initial)); checks += 1;
  const noStreams = context({ CompressionStream: undefined, DecompressionStream: undefined }).CreativeShareCode;
  ok((await noStreams.encode(initial)).startsWith('HSCP1.J.'), 'no compression stream emits J');
  assert.deepEqual(json(await noStreams.decode(baseline)), json(initial)); checks += 1;
  await rejects(noStreams, compact, /不支持 gzip.*兼容码/);
  const onlyEncoder = context({ DecompressionStream: undefined }).CreativeShareCode;
  ok((await onlyEncoder.encode(initial)).startsWith('HSCP1.G.'), 'encoding does not incorrectly require decompression support');
  const onlyDecoder = context({ CompressionStream: undefined }).CreativeShareCode;
  assert.deepEqual(json(await onlyDecoder.decode(compact)), json(initial)); checks += 1;
  const brokenCompressor = context({ CompressionStream: class { constructor() { throw new Error('unsupported'); } } }).CreativeShareCode;
  ok((await brokenCompressor.encode(initial)).startsWith('HSCP1.J.'), 'unusable compression capability falls back to portable J');
  const grows = context({ CompressionStream: class { constructor() {
    return new TransformStream({ transform(chunk, controller) { controller.enqueue(chunk); }, flush(controller) { controller.enqueue(new Uint8Array(20)); } });
  } } }).CreativeShareCode;
  ok((await grows.encode(initial)).startsWith('HSCP1.J.'), 'compression must be strictly shorter');

  await rejects(codec, baseline.slice(0, -1), /完整/);
  await rejects(codec, baseline.slice(0, -8) + '00000000', /校验失败/);
  await rejects(codec, baseline.replace('HSCP1', 'HSCP2'), /版本/);
  await rejects(codec, baseline.replace('.J.', '.X.'), /格式/);
  await rejects(codec, 'HSCP1.J.!.00000000', /完整/);
  await rejects(codec, baseline + '\n' + baseline, /一份完整/);
  await rejects(codec, 'x'.repeat(180001), /过大/);
  await rejects(codec, frame(Buffer.alloc(128 * 1024 + 1)), /过大/);
  await rejects(codec, frame(Buffer.from([0xff, 0xfe])), /UTF-8/);
  await rejects(codec, frame(Buffer.from('{broken')), /JSON/);
  await rejects(codec, frame(Buffer.from('not gzip'), 'G'), /gzip.*损坏/);
  await rejects(codec, frame(zlib.gzipSync(Buffer.alloc(128 * 1024 + 1, 65)), 'G'), /解压后过大/);
  const tooSparse = json(initial); delete tooSparse.cam.dist;
  await rejects(codec, frame(Buffer.from(JSON.stringify(tooSparse))), /不完整/);
  const badVersion = json(initial); badVersion.version = 8;
  await rejects(codec, frame(Buffer.from(JSON.stringify(badVersion))), /无效参数/);
  const invalidTarget = json(initial); invalidTarget.bindings[0].target = '__proto__.polluted';
  await rejects(codec, frame(Buffer.from(JSON.stringify(invalidTarget))), /无效参数/);
  const invalidSource = json(initial); invalidSource.bindings[0].source = 'constructor';
  await rejects(codec, frame(Buffer.from(JSON.stringify(invalidSource))), /无效参数/);
  for (const grade of [1.5, 999999]) {
    const invalidGrade = json(initial); invalidGrade.look.grade = grade;
    await rejects(codec, frame(Buffer.from(JSON.stringify(invalidGrade))), /无效参数/);
    invalidGrade.look.grade = 0; invalidGrade.cues[0].set['look.grade'] = grade;
    await rejects(codec, frame(Buffer.from(JSON.stringify(invalidGrade))), /无效参数/);
  }
  for (const key of ['target', 'source']) {
    const invalidShape = json(initial); invalidShape.bindings[0][key] = [invalidShape.bindings[0][key]];
    await rejects(codec, frame(Buffer.from(JSON.stringify(invalidShape))), /无效参数/);
  }
  const tooMany = json(initial); tooMany.cues = Array.from({ length: 65 }, () => initial.cues[0]);
  await rejects(codec, frame(Buffer.from(JSON.stringify(tooMany))), /无效参数/);

  const dirty = json(initial);
  dirty.id = 'private-library-id'; dirty.thumb = 'data:image/private'; dirty.token = 'secret';
  dirty.bg = { type: 'media', url: 'blob:private', name: 'C:\\private\\song.mp4', token: 'credential' };
  dirty.hand.url = 'file:///private'; dirty.hand.credentials = { password: 'secret' };
  dirty.cues[0].set['__proto__.polluted'] = 1; dirty.cues[0].token = 'secret';
  dirty.bindings[0].authorization = 'secret';
  const clean = await codec.decode(frame(Buffer.from(JSON.stringify(dirty))));
  ok(clean.bg.type === 'theme', 'media replaced by theme without importing files or URLs');
  ok(!/private|secret|credential|polluted|authorization/.test(JSON.stringify(clean)), 'unsafe and unknown keys never survive projection');
  ok(!Object.prototype.polluted, 'no prototype mutation');
  const encodedDirty = await codec.encode(dirty, { compress: false });
  ok(!/private|secret|credential/.test(Buffer.from(encodedDirty.split('.')[2], 'base64url').toString()), 'export also strips unsafe fields');
  const oldDefault = json(await codec.decode(baseline));
  CS.setParam('cam.dist', 33);
  assert.deepEqual(json(await codec.decode(baseline)), oldDefault); checks += 1;
  ok(CS.importJSON(JSON.stringify({ scene: 'towers', cam: { dist: 12 } })).ok, 'legacy sparse JSON import remains supported');

  // Bounded decompression cancels the upstream stream as soon as the limit is hit.
  let cancelled = false, pulls = 0;
  const fakeDecompress = class { constructor() { return {
    writable: new WritableStream({ write() {} }),
    readable: new ReadableStream({ pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } }),
  }; } };
  const bounded = context({ DecompressionStream: fakeDecompress }).CreativeShareCode;
  await rejects(bounded, compact, /解压后过大/);
  ok(cancelled && pulls <= 5, 'oversized decoding cancels instead of buffering the entire stream');
  console.log('Creative share code: ' + checks + ' checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
