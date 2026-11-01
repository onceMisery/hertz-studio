#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// P1-03c 原生冒烟：预置一个有效包目录，启动真实 WebView2 宿主，
// 从壁纸页上下文 fetch wallpaper.invalid 保留域，验证拦截器 200/206/404。
// 运行前提：cargo build -p hertz-desktop；无已运行实例。
'use strict';
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/wallpaper-media-native');

// --- 最小 ZIP 写入器（与 check-wallpaper-package.js 相同模式）---
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
function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8); // Store
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, bytes);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8); dir.writeUInt16LE(0, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(bytes.length, 20);
    dir.writeUInt32LE(bytes.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, nameBytes]));
    offset += header.length + nameBytes.length + bytes.length;
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

const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64',
);
const FIXTURE_SHA = crypto.createHash('sha256').update(FIXTURE_PNG).digest('hex');

function manifestJson() {
  return JSON.stringify({
    formatVersion: 1,
    workId: 'c17ed10a-5c55-4a52-85dc-7509f9e88aae',
    version: 1,
    title: '静夜',
    description: '冒烟用静态图片壁纸',
    content: { kind: 'image', asset: 'background' },
    assets: [{ id: 'background', kind: 'image', source: 'assets/background.png', variants: [] }],
    files: [{ path: 'assets/background.png', bytes: FIXTURE_PNG.length, sha256: FIXTURE_SHA, mime: 'image/png' }],
    properties: [],
    permissions: { audioSpectrum: false, pointer: false },
    license: { code: 'none', assets: 'CC0-1.0', attribution: '' },
  });
}

async function main() {
  assert.equal(process.platform, 'win32', '需要 Windows');
  const processCheck = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    '@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(processCheck, '0', '请先关闭已运行的桌面实例');

  fs.mkdirSync(output, { recursive: true });
  const configDir = path.join(output, 'config');
  const packagesDir = path.join(configDir, 'packages');
  fs.mkdirSync(packagesDir, { recursive: true });

  // 组包 + 预置到 packages/<hash>/。
  const packageBytes = buildZip([
    ['manifest.json', Buffer.from(manifestJson())],
    ['assets/background.png', FIXTURE_PNG],
  ]);
  const packageHash = crypto.createHash('sha256').update(packageBytes).digest('hex');
  const packageDir = path.join(packagesDir, packageHash);
  fs.mkdirSync(path.join(packageDir, 'files/assets'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'original.hwpkg'), packageBytes);
  fs.writeFileSync(path.join(packageDir, 'files', 'assets', 'background.png'), FIXTURE_PNG);
  fs.writeFileSync(path.join(packageDir, 'receipt.json'), JSON.stringify({
    packageHash,
    installedAt: 1,
    entries: [{ path: 'assets/background.png', bytes: FIXTURE_PNG.length, sha256: FIXTURE_SHA, mime: 'image/png' }],
  }));

  // 隔离配置。
  const lyrics = { enabled: false, locked: true, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32, fontWeight: 600, sungColor: '#8fe3ff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 2, opacity: .92, width: 900, anchorX: .5, anchorY: .84, monitor: null };
  const wallpaper = { enabled: true, fps: 15, musicResponse: false, monitor: null, source: 'fixed', scene: 'coast' };
  const profile = { kind: 'standalone', dataDir: path.join(output, 'player'), edition: 'full' };
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    schemaVersion: 4, revision: 1, launchAtLogin: false,
    activeProfile: profile, profiles: [{ profile, lyrics, wallpaper }],
  }));

  // 启动真实宿主。
  const port = Number(process.env.DESKTOP_CDP_PORT || 19427);
  const child = spawn(path.join(root, 'target/debug/hertz-desktop.exe'), ['--wallpaper'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, HERTZ_DESKTOP_CONFIG_DIR: configDir, WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port },
    stdio: 'ignore',
  });
  let browser;
  try {
    for (let i = 0; i < 75; i += 1) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (response.ok) { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; }
      } catch {}
      if (child.exitCode !== null) throw new Error('Native host exited: ' + child.exitCode);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(browser, 'WebView2 CDP 必须启动');
    // 找壁纸页。
    let wallpaperPage;
    for (let i = 0; i < 50; i += 1) {
      wallpaperPage = browser.contexts().flatMap(context => context.pages())
        .find(page => page.url().includes('/wallpaper.html'));
      if (wallpaperPage) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(wallpaperPage, '壁纸页必须存在');
    // 等 DOM 就绪。
    await wallpaperPage.waitForFunction(
      () => window.__events ? window.__events.some(e => e === 'wallpaper_dom_ready') : document.getElementById('host') !== null,
      null, { timeout: 20000 },
    ).catch(() => {});
    await wallpaperPage.waitForTimeout(2000);

    const base = 'https://' + packageHash.slice(0, 32) + '.' + packageHash.slice(32) + '.wallpaper.invalid';
    const fetchInfo = async url => {
      const result = await wallpaperPage.evaluate(async url => {
        try {
          const response = await fetch(url);
          const buffer = await response.arrayBuffer();
          return { status: response.status, length: buffer.byteLength, ok: response.ok };
        } catch (error) {
          return { error: String(error) };
        }
      }, url);
      return result;
    };
    const fetchInfoWithRange = async (url, range) => {
      return wallpaperPage.evaluate(async ([url, range]) => {
        try {
          const response = await fetch(url, { headers: { Range: range } });
          const buffer = await response.arrayBuffer();
          return {
            status: response.status,
            length: buffer.byteLength,
            contentRange: response.headers.get('content-range'),
          };
        } catch (error) {
          return { error: String(error) };
        }
      }, [url, range]);
    };

    // ① 全文件 200。
    const full = await fetchInfo(base + '/files/assets/background.png');
    assert.equal(full.status, 200, `全文件 200：${JSON.stringify(full)}`);
    assert.equal(full.length, FIXTURE_PNG.length, `字节量匹配：${full.length}`);
    console.log(`PASS full GET 200 (${full.length}B)`);

    // ② Range 206。
    const range = await fetchInfoWithRange(base + '/files/assets/background.png', 'bytes=0-9');
    assert.equal(range.status, 206, `Range 206：${JSON.stringify(range)}`);
    assert.equal(range.length, 10);
    assert.ok(range.contentRange && range.contentRange.includes('bytes 0-9/'), `Content-Range：${range.contentRange}`);
    console.log(`PASS Range 206 (${range.length}B, ${range.contentRange})`);

    // ③ 未知文件 404。
    const notFound = await fetchInfo(base + '/files/assets/missing.png');
    assert.equal(notFound.status, 404, `未知文件 404：${JSON.stringify(notFound)}`);
    console.log('PASS 404 unknown file');

    // ④ 未知包 404。
    const unknownHash = '0'.repeat(64);
    const unknownBase = 'https://' + unknownHash.slice(0, 32) + '.' + unknownHash.slice(32) + '.wallpaper.invalid';
    const unknownPackage = await fetchInfo(unknownBase + '/files/assets/background.png');
    assert.equal(unknownPackage.status, 404, `未知包 404：${JSON.stringify(unknownPackage)}`);
    console.log('PASS 404 unknown package');

    // ⑤ original.hwpkg 不暴露。
    const hwpkg = await fetchInfo(base + '/original.hwpkg');
    assert.equal(hwpkg.status, 404, `original.hwpkg 不暴露：${JSON.stringify(hwpkg)}`);
    console.log('PASS 404 original.hwpkg');

    console.log(`wallpaper media native checks passed (hash ${packageHash.slice(0, 12)}…)`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
  }
}

main().catch(error => { console.error(error.message); process.exit(1); });
