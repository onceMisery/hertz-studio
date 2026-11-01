#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// P1-01 包合同端到端检查（设计 §21.1 scripts/check-wallpaper-package.js）：
// 用 §6.1 文档 fixture 组装真实 .hwpkg（Store/Deflate），驱动
// hertz-wallpaper 的 example 校验器做往返，再分别变异哈希、长度和 MIME——
// 三种变异均必须失败；另覆盖路径穿越、未声明文件、缺失文件、重复键与压缩弹。
// 校验逻辑只存在于 Rust 一侧，本脚本不复制规则。
'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/wallpaper-package');
const FIXTURE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const FIXTURE_SHA256 = 'abc58d5127d7cdf313beb9ec8ee839860a9c6bfbc48c8b8eb6a3f7d8bb63de6f';

// --- 最小 ZIP 写入器（Store/Deflate，无目录条目）---
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();
function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function dosTime(date) {
  return [(date.getUTCMinutes() << 5) | (date.getUTCSeconds() / 2), ((date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() / 2)) & 0xffff];
}
function buildZip(entries, { deflate = false } = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const payload = deflate ? zlib.deflateRawSync(bytes, { level: 9 }) : bytes;
    const method = deflate ? 8 : 0;
    const crc = crc32(bytes);
    const time = Buffer.from([0, 0, 0x21, 0]); // 固定 DOS 时间：输出确定性
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10); header.writeUInt16LE(0, 12); // time/date
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBytes, payload);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8); dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12); dir.writeUInt16LE(0, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(bytes.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(0, 38); // 无额外字段
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, nameBytes]));
    offset += header.length + nameBytes.length + payload.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, eocd]);
}

function manifestJson(sha, bytes) {
  return JSON.stringify({
    formatVersion: 1,
    workId: 'c17ed10a-5c55-4a52-85dc-7509f9e88aae',
    version: 1,
    title: '静夜',
    description: '静态图片壁纸',
    content: { kind: 'image', asset: 'background' },
    assets: [{ id: 'background', kind: 'image', source: 'assets/background.png', variants: [] }],
    files: [{ path: 'assets/background.png', bytes, sha256: sha, mime: 'image/png' }],
    properties: [],
    permissions: { audioSpectrum: false, pointer: false },
    license: { code: 'none', assets: 'CC0-1.0', attribution: '' },
  }, null, 1);
}

function main() {
  const png = Buffer.from(FIXTURE_PNG_B64, 'base64');
  assert.equal(png.length, 70);
  assert.equal(createHash('sha256').update(png).digest('hex'), FIXTURE_SHA256, '文档 fixture 哈希必须自洽');
  const sha = FIXTURE_SHA256;
  fs.mkdirSync(output, { recursive: true });
  const binary = path.join(root, 'target/debug/examples/validate_package.exe');
  execFileSync('cargo', ['build', '-q', '-p', 'hertz-wallpaper', '--example', 'validate_package'], { cwd: root });

  const cases = [];
  const add = (name, buffer, expect) => {
    const file = path.join(output, name + '.hwpkg');
    fs.writeFileSync(file, buffer);
    cases.push({ name, file, expect });
  };
  const entries = () => [
    ['manifest.json', Buffer.from(manifestJson(sha, png.length))],
    ['assets/background.png', png],
  ];
  // 有效往返（Store / Deflate）。
  add('valid-store', buildZip(entries()), { ok: true });
  add('valid-deflate', buildZip(entries(), { deflate: true }), { ok: true });
  // 三种文档指定变异：哈希、长度、MIME。
  add('mutate-hash', buildZip([
    ['manifest.json', Buffer.from(manifestJson(sha.replace(/^a/, 'b'), png.length))],
    ['assets/background.png', png],
  ]), { ok: false, code: 'hash_mismatch' });
  add('mutate-length', buildZip([
    ['manifest.json', Buffer.from(manifestJson(sha, png.length + 1))],
    ['assets/background.png', png],
  ]), { ok: false, code: 'size_mismatch' });
  add('mutate-mime', buildZip([
    ['manifest.json', Buffer.from(manifestJson(sha, png.length).replace('image/png', 'IMAGE/PNG'))],
    ['assets/background.png', png],
  ]), { ok: false, code: 'invalid_mime' });
  // C09 家族。
  add('traversal', buildZip([
    ['manifest.json', Buffer.from(manifestJson(sha, png.length).replaceAll('assets/background.png', 'assets/../evil.png'))],
    ['assets/../evil.png', png],
  ]), { ok: false, code: 'invalid_path' });
  add('undeclared', buildZip([...entries(), ['assets/extra.bin', Buffer.from('x')]]), { ok: false, code: 'undeclared_file' });
  add('missing', buildZip([['manifest.json', Buffer.from(manifestJson(sha, png.length))]]), { ok: false, code: 'missing_file' });
  const dupManifest = '{"formatVersion":1,"formatVersion":1}';
  add('duplicate-key', buildZip([['manifest.json', Buffer.from(dupManifest)]]), { ok: false, code: 'duplicate_key' });
  // 压缩弹：全零负载 Deflate 远超 100:1。
  const bomb = Buffer.alloc(8192);
  const bombSha = createHash('sha256').update(bomb).digest('hex');
  add('ratio-bomb', buildZip([
    ['manifest.json', Buffer.from(manifestJson(bombSha, bomb.length))],
    ['assets/background.png', bomb],
  ], { deflate: true }), { ok: false, code: 'ratio_exceeded' });

  for (const item of cases) {
    const stdout = execFileSync(binary, [item.file], { encoding: 'utf8' });
    const verdict = JSON.parse(stdout);
    if (item.expect.ok) {
      assert.equal(verdict.ok, true, `${item.name} 应通过：${stdout}`);
    } else {
      assert.equal(verdict.ok, false, `${item.name} 应被拒绝：${stdout}`);
      assert.equal(verdict.code, item.expect.code, `${item.name} 错误码不符：${stdout}`);
    }
    console.log(`${verdict.ok ? 'PASS ' : 'REJECT'} ${item.name}${verdict.code ? ' -> ' + verdict.code : ''}`);
  }
  console.log(`check-wallpaper-package passed: ${cases.length} cases (fixture sha256 ${sha.slice(0, 12)}…)`);
}

main();
