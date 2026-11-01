#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 真实 ImportJobs → staging Broker → 独立可见 WebView2 → Close/流退出 → 发布。
// cargo build -p hertz-desktop --features wallpaper-media-probe
'use strict';
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { buildZip, FIXTURE_PNG } = require('./check-wallpaper-media-native');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/wallpaper-import-native-' + Date.now());
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function closeOwnedProbeWindow(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const script = `
$ProgressPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeProbeClose {
  public delegate bool Callback(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  public static bool Close(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, data) => {
      uint owner; GetWindowThreadProcessId(hwnd, out owner);
      var text = new StringBuilder(128); GetWindowText(hwnd, text, text.Capacity);
      if (owner == pid && text.ToString() == "Hertz · 媒体兼容性检查") { found = hwnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found != IntPtr.Zero && PostMessage(found, 0x0010, IntPtr.Zero, IntPtr.Zero);
  }
}
'@
[NativeProbeClose]::Close(${pid})
`;
  const result = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
  assert.equal(result, 'True', '只关闭当前测试 PID 的独立探测窗口');
}

function makePackage(kind, bytes, ordinal, imageFormat = 'png') {
  const file = 'assets/background.' + (kind === 'image' ? imageFormat : 'webm');
  const manifest = {
    formatVersion: 1, workId: `c17ed10a-5c55-4a52-85dc-${String(ordinal).padStart(12, '0')}`, version: 1,
    title: '真实解码回归 ' + ordinal, description: '', content: { kind, asset: 'background' },
    assets: [{ id: 'background', kind, source: file, variants: [] }],
    files: [{ path: file, bytes: bytes.length, sha256: digest(bytes), mime: kind === 'image' ? 'image/' + imageFormat : 'video/webm' }],
    properties: [], permissions: { audioSpectrum: false, pointer: false },
    license: { code: 'none', assets: 'CC0-1.0', attribution: '' },
  };
  return buildZip([['manifest.json', Buffer.from(JSON.stringify(manifest))], [file, bytes]]);
}

function corruptFrames(bytes) {
  const result = Buffer.from(bytes);
  // VP8 keyframe 的帧头和压缩数据；保留 EBML/轨道/时间戳结构供第一道检查通过。
  const signature = Buffer.from([0x9d, 0x01, 0x2a, 0x40, 0x00, 0x30, 0x00]);
  const index = result.indexOf(signature);
  assert.ok(index > 0, 'fixture 必须有 VP8 keyframe signature');
  result.fill(0xff, index - 3, index + signature.length + 12);
  return result;
}

function corruptAfter(bytes, seconds) {
  const result = Buffer.from(bytes);
  let changed = 0;
  function vint(offset, id) {
    let width = 1;
    while (width <= 8 && !(result[offset] & (0x80 >> (width - 1)))) width++;
    assert.ok(width <= 8);
    let value = id ? result[offset] : result[offset] & (0xff >> width);
    for (let i = 1; i < width; i++) value = value * 256 + result[offset + i];
    return [value, width];
  }
  function walk(start, limit) {
    let timecode = 0;
    for (let offset = start; offset < limit;) {
      const [id, idBytes] = vint(offset, true);
      const [size, sizeBytes] = vint(offset + idBytes, false);
      const data = offset + idBytes + sizeBytes;
      const end = Math.min(data + size, limit);
      assert.ok(end > offset);
      if (id === 0x18538067 || id === 0x1f43b675) walk(data, end);
      if (id === 0xe7) {
        timecode = 0;
        for (let i = data; i < end; i++) timecode = timecode * 256 + result[i];
      }
      if (id === 0xa3) {
        const [, trackBytes] = vint(data, false);
        const timestamp = timecode + result.readInt16BE(data + trackBytes);
        if (timestamp / 1000 >= seconds) {
          result.fill(0xff, data + trackBytes + 3, end);
          changed++;
        }
      }
      offset = end;
    }
  }
  walk(0, result.length);
  assert.ok(changed > 0, '必须修改实际视频帧 payload');
  return result;
}

function derivedReceipts(configDir) {
  const found = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === 'receipt.json') found.push({ file, ...JSON.parse(fs.readFileSync(file, 'utf8')) });
    }
  }
  walk(path.join(configDir, 'derived'));
  return found;
}

function verifyDerived(receipt) {
  assert.equal(receipt.pipeline, 'image-srgb-v1');
  for (const name of ['render', 'thumbnail']) {
    const bytes = fs.readFileSync(path.join(path.dirname(receipt.file), name + '.png'));
    assert.equal(digest(bytes), receipt[name].sha256);
    assert.equal(bytes.length, receipt[name].bytes);
    assert.equal(bytes.readUInt32BE(16), receipt[name].width);
    assert.equal(bytes.readUInt32BE(20), receipt[name].height);
    const chunks = [];
    for (let offset = 8; offset < bytes.length;) {
      chunks.push(bytes.toString('ascii', offset + 4, offset + 8));
      offset += bytes.readUInt32BE(offset) + 12;
    }
    assert.ok(chunks.includes('sRGB'));
    for (const forbidden of ['eXIf', 'iCCP', 'tEXt', 'zTXt', 'iTXt']) assert.ok(!chunks.includes(forbidden));
  }
}

async function main() {
  assert.equal(process.platform, 'win32');
  const count = execFileSync('powershell.exe', ['-NoProfile', '-Command', '@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(count, '0', '请先关闭已运行的桌面实例');
  const configDir = path.join(output, 'config');
  const inputs = path.join(configDir, 'probe-inputs');
  fs.mkdirSync(inputs, { recursive: true });
  const video = fs.readFileSync(path.join(root, 'scripts/fixtures/wallpaper-vp8.webm'));
  // 保留 IHDR、完整块边界与 IEND；IDAT 没有可解码的 zlib 像素流。
  const emptyIdat = Buffer.alloc(12);
  emptyIdat.write('IDAT', 4);
  emptyIdat.writeUInt32BE(0x35af061e, 8); // 正确 CRC，失败必须来自缺失的像素流。
  const corruptImage = Buffer.concat([FIXTURE_PNG.subarray(0, 33), emptyIdat, FIXTURE_PNG.subarray(-12)]);
  const cases = {
    image: makePackage('image', FIXTURE_PNG, 1),
    video: makePackage('video', video, 2),
    'bad-image': makePackage('image', corruptImage, 3),
    'bad-video': makePackage('video', corruptFrames(video), 4),
    'bad-middle': makePackage('video', corruptAfter(video, 0.75), 8),
    'bad-tail': makePackage('video', corruptAfter(video, 1.6), 9),
    timeout: makePackage('video', video, 5),
    cancel: makePackage('video', video, 6),
    'cancel-window': makePackage('video', video, 13),
    busy: makePackage('video', video, 7),
  };
  for (const [name, bytes] of Object.entries(cases)) fs.writeFileSync(path.join(inputs, name + '.hwpkg'), bytes);
  const profile = { kind: 'standalone', dataDir: path.join(output, 'player'), edition: 'full' };
  const lyrics = { enabled: false, locked: true, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32, fontWeight: 600, sungColor: '#8fe3ff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 2, opacity: .92, width: 900, anchorX: .5, anchorY: .84, monitor: null };
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    schemaVersion: 4, revision: 1, launchAtLogin: false, activeProfile: profile,
    profiles: [{ profile, lyrics, wallpaper: { enabled: true, fps: 15, musicResponse: false, monitor: null, source: 'fixed', scene: 'coast' } }],
  }));
  const port = Number(process.env.DESKTOP_CDP_PORT || 19428);
  const child = spawn(path.join(root, 'target/debug/hertz-desktop.exe'), ['--wallpaper', '--settings'], {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, HERTZ_DESKTOP_CONFIG_DIR: configDir, WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port },
  });
  let browser;
  const evidence = { output, results: [], probes: [] };
  try {
    for (let i = 0; i < 75; i++) {
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; } catch {}
      assert.equal(child.exitCode, null, '宿主不能退出');
      await delay(200);
    }
    assert.ok(browser, 'WebView2 CDP 必须启动');
    evidence.browser = browser.version();
    const pages = () => browser.contexts().flatMap(context => context.pages());
    let wallpaper;
    for (let i = 0; i < 75; i++) {
      wallpaper = pages().find(page => page.url().endsWith('/wallpaper.html'));
      if (wallpaper) break;
      await delay(100);
    }
    assert.ok(wallpaper);
    let settings;
    for (let i = 0; i < 100; i++) {
      settings = pages().find(page => page.url().endsWith('/settings.html'));
      if (settings) break;
      await delay(100);
    }
    assert.ok(settings, '原设置中心必须存在，用于验证媒体容器独立关闭');
    await wallpaper.waitForFunction(() => !!window.hertzWallpaper && !!window.ipc);
    const encoded = await wallpaper.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 3; canvas.height = 2;
      const context = canvas.getContext('2d');
      context.fillStyle = '#3180aa'; context.fillRect(0, 0, 3, 2);
      const result = ['jpeg', 'webp'].map(format => canvas.toDataURL('image/' + format).split(',')[1]);
      canvas.width = 5000; canvas.height = 1000;
      const gradient = context.createLinearGradient(0, 0, 5000, 1000);
      gradient.addColorStop(0, '#3180aa'); gradient.addColorStop(1, '#aabb33');
      context.fillStyle = gradient; context.fillRect(0, 0, 5000, 1000);
      result.push(canvas.toDataURL('image/png').split(',')[1]);
      return result;
    });
    const jpeg = Buffer.from(encoded[0], 'base64');
    cases.jpeg = makePackage('image', jpeg, 10, 'jpeg');
    cases.webp = makePackage('image', Buffer.from(encoded[1], 'base64'), 11, 'webp');
    cases.wide = makePackage('image', Buffer.from(encoded[2], 'base64'), 16);
    // 标准 TIFF EXIF Orientation=6；编码 3×2，浏览器显示必须为 2×3。
    const exif = Buffer.alloc(32);
    exif.write('Exif\0\0II', 0, 'binary'); exif.writeUInt16LE(42, 8); exif.writeUInt32LE(8, 10);
    exif.writeUInt16LE(1, 14); exif.writeUInt16LE(0x0112, 16); exif.writeUInt16LE(3, 18);
    exif.writeUInt32LE(1, 20); exif.writeUInt16LE(6, 24);
    const rotated = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, 0, 34]), exif, jpeg.subarray(2)]);
    cases.rotated = makePackage('image', rotated, 12, 'jpeg');
    exif.writeUInt16LE(2, 24);
    const mirrored = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, 0, 34]), exif, jpeg.subarray(2)]);
    cases.mirrored = makePackage('image', mirrored, 14, 'jpeg');
    exif.writeUInt16LE(5, 24);
    const transposed = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, 0, 34]), exif, jpeg.subarray(2)]);
    cases.transposed = makePackage('image', transposed, 15, 'jpeg');
    for (const name of ['jpeg', 'webp', 'rotated', 'mirrored', 'transposed', 'wide']) fs.writeFileSync(path.join(inputs, name + '.hwpkg'), cases[name]);
    for (const context of browser.contexts()) context.on('page', page => {
      const log = { url: '', messages: [] };
      evidence.probes.push(log);
      page.on('console', message => log.messages.push(message.text()));
      page.on('pageerror', error => log.messages.push(String(error)));
      page.on('domcontentloaded', () => { log.url = page.url(); });
    });
    let nonce = 0;
    async function send(action, name, suppressFrames = false) {
      const id = ++nonce;
      await wallpaper.evaluate(command => window.ipc.postMessage('wallpaper_probe_import ' + JSON.stringify(command)), { nonce: id, action, name, suppressFrames });
      return id;
    }
    async function result(id) {
      await wallpaper.waitForFunction(id => !!window.__nativeImportProbes?.[id], id, { timeout: 25000 });
      return wallpaper.evaluate(id => window.__nativeImportProbes[id], id);
    }
    async function begin(name, expected, suppressFrames = false, afterStart = null) {
      const started = Date.now();
      const id = await send('begin', name, suppressFrames);
      if (afterStart) await afterStart();
      const value = await result(id);
      evidence.results.push({ name, elapsedMs: Date.now() - started, ...value });
      assert.equal(value.state, expected, JSON.stringify(value));
      assert.equal(value.prepareTasks, 0, '回执必须等准备槽归还');
      assert.equal(value.prepareCpuBytes, 0, '原图工作区必须先归还');
      assert.equal(value.activeStreams, 0, '回执必须等所有真实流退出');
      assert.ok(!pages().some(page => page.url().includes('/wallpaper-probe.html')), '独立 controller 必须先关闭');
      assert.ok(!fs.existsSync(path.join(configDir, 'staging', name)), '所有终态均清 staging');
      const installed = fs.existsSync(path.join(configDir, 'packages', digest(cases[name])));
      assert.equal(installed, expected === 'done', '失败或取消不能发布');
      assert.equal(child.exitCode, null, '关闭探测不能关闭主程序');
      assert.equal(settings.isClosed(), false, '关闭探测不能关闭设置中心');
      await settings.evaluate(() => document.title);
      await wallpaper.evaluate(() => window.hertzWallpaper.debug());
      console.log(`PASS ${name}: ${value.state} ${value.error || ''}`);
      return value;
    }
    const img = await begin('image', 'done');
    assert.equal(img.decoderSlots, 0);
    const firstDerived = derivedReceipts(configDir);
    assert.equal(firstDerived.length, 1);
    verifyDerived(firstDerived[0]);
    await begin('image', 'done'); // 去重也重新验证当前环境的实际解码。
    assert.deepEqual(derivedReceipts(configDir), firstDerived, '重复导入复用同一不可变代际');
    fs.writeFileSync(path.join(path.dirname(firstDerived[0].file), 'render.png'), 'corrupt');
    await begin('image', 'done');
    const repaired = derivedReceipts(configDir).find(receipt => receipt.file !== firstDerived[0].file);
    assert.ok(repaired, '损坏缓存应生成新代际');
    verifyDerived(repaired);
    for (const name of ['jpeg', 'webp', 'rotated', 'mirrored', 'transposed', 'wide']) await begin(name, 'done');
    const receipts = derivedReceipts(configDir).filter(receipt => receipt.file !== firstDerived[0].file);
    for (const receipt of receipts) verifyDerived(receipt);
    const orientations = receipts.filter(receipt => receipt.orientation !== 1);
    assert.deepEqual(orientations.map(receipt => receipt.orientation).sort(), [2, 5, 6]);
    for (const receipt of orientations) assert.deepEqual([receipt.render.width, receipt.render.height], receipt.orientation >= 5 ? [2, 3] : [3, 2]);
    const wide = receipts.find(receipt => receipt.sourceWidth === 5000);
    assert.ok(wide);
    assert.deepEqual([wide.render.width, wide.render.height], [4096, 819]);
    assert.deepEqual([wide.thumbnail.width, wide.thumbnail.height], [512, 102]);
    evidence.derived = receipts;
    const vid = await begin('video', 'done');
    assert.equal(vid.decoderSlots, 0);
    const badImage = await begin('bad-image', 'failed');
    assert.match(badImage.error, /^decode_failed:/, '必须通过结构检查后在像素解码失败');
    const badVideo = await begin('bad-video', 'failed');
    assert.match(badVideo.error, /^(decode_failed|probe_inconclusive):/, '不能仅因结构拒绝冒充真实坏帧检查');
    for (const name of ['bad-middle', 'bad-tail']) {
      const bad = await begin(name, 'failed');
      assert.match(bad.error, /^(decode_failed|probe_inconclusive):/);
    }
    const timeout = await begin('timeout', 'failed', true);
    assert.match(timeout.error, /^probe_inconclusive:/);
    assert.ok(evidence.results.at(-1).elapsedMs >= 14500 && evidence.results.at(-1).elapsedMs < 22000, '真实无帧探测必须受 15s 时限约束');
    await begin('cancel', 'cancelled', true, async () => {
      let probe;
      for (let i = 0; i < 100; i++) {
        probe = pages().find(page => page.url().includes('/wallpaper-probe.html'));
        if (probe) break;
        await delay(50);
      }
      assert.ok(probe);
      evidence.visibleProbe = await probe.evaluate(() => ({ visibility: document.visibilityState, hidden: document.hidden, bounds: document.getElementById('media').getBoundingClientRect().toJSON() }));
      assert.equal(evidence.visibleProbe.hidden, false);
      assert.ok(evidence.visibleProbe.bounds.width > 0 && evidence.visibleProbe.bounds.height > 0);
      await probe.screenshot({ path: path.join(output, 'visible-probe.png') });
      const denied = await result(await send('begin', 'video'));
      assert.equal(denied.error, 'budget_busy', '取消实际退出前不能接受第二个导入');
      await result(await send('cancel', 'cancel'));
    });
    await begin('cancel-window', 'cancelled', true, async () => {
      for (let i = 0; i < 100; i++) {
        if (pages().some(page => page.url().includes('/wallpaper-probe.html'))) break;
        await delay(50);
      }
      closeOwnedProbeWindow(child.pid);
    });
    await result(await send('hold', 'budget'));
    const busy = await begin('busy', 'failed');
    assert.match(busy.error, /^budget_busy: decoder_slots:/);
    assert.equal(busy.decoderSlots, 2, '探测不得动其它 owner 的配额');
    await result(await send('release', 'budget'));
    await begin('busy', 'done');
    console.log('wallpaper import native checks passed');
  } finally {
    if (fs.existsSync(path.join(configDir, 'desktop.log'))) evidence.nativeProbeLog = fs.readFileSync(path.join(configDir, 'desktop.log'), 'utf8').split(/\r?\n/).filter(line => line.includes('decode probe'));
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('Evidence ' + path.join(output, 'evidence.json'));
    if (browser) await browser.close().catch(() => {});
    child.kill();
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
