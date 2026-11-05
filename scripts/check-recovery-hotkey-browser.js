// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 运行设置“找回桌面歌词”快捷键契约：录入/取消/清除、失败反馈、脏草稿互斥、旧状态兼容、键盘可达与窄窗口。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'crates/hertz-desktop/assets');
const html = fs.readFileSync(path.join(assets, 'wallpaper-settings.html'), 'utf8').replace('__SETTINGS__', fs.readFileSync(path.join(assets, 'wallpaper-settings.js'), 'utf8')).replace('__LIBRARY__', fs.readFileSync(path.join(assets, 'wallpaper-library.js'), 'utf8'));
const base = {
  revision: 9,
  config: { enabled: false, audioInput: { kind: 'hertz', gain: 1, attackMs: 40, releaseMs: 250 }, batteryPolicy: 'pause', pauseOnFullscreen: true, pauseOnMaximized: false, applicationRules: [], groups: [{ id: 'main', mode: 'single', displays: [{ kind: 'primary' }], selection: { kind: 'followHertz', idleBuiltin: { sceneId: 'zodiac', stateVersion: 1, params: {} } }, presentation: { fps: 30, quality: 'low', brightness: 1, motion: 1, fit: 'cover', pointer: false }, properties: {} }] },
  lyricsConfig: { enabled: true, locked: true, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32, fontWeight: 600, sungColor: '#8fe3ff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 2, opacity: .92, width: 900, anchorX: .5, anchorY: .84, monitor: null },
  scenes: [{ id: 'zodiac', label: '星轨' }], profiles: [], monitors: [],
  profile: { dataDir: 'D:\\Music\\Hertz', edition: 'full' },
  launchAtLogin: false, positionEditing: false,
  runtime: { enabled: true, locked: true, visible: false, source: 'ok', userHidden: false, policy: { noContent: true }, wallpaper: { enabled: false, visible: false, hidden: false, fps: 30 }, diagnostics: { pauseReasons: ['disabled'] } },
};
function statusPayload(overrides) {
  return Object.assign({}, base, { recoveryHotkey: { saved: null, registered: [], error: null } }, overrides);
}
async function main() {
  const server = http.createServer((request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1120, height: 700 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(payload => {
      window.desktopRequests = [];
      window.hotkeySaved = null;
      window.hotkeyFailNext = false;
      window.hotkeyBase = payload;
      window.ipc = { postMessage: text => {
        const request = JSON.parse(text); window.desktopRequests.push(request);
        if (request.cmd === 'ready') queueMicrotask(() => window.hertzWallpaperSettings.applyStatus(Object.assign({}, payload)));
        if (request.cmd === 'recovery-hotkey') {
          const fail = window.hotkeyFailNext;
          window.hotkeyFailNext = false;
          const saved = fail ? window.hotkeySaved : request.hotkey || null;
          window.hotkeySaved = saved;
          const reply = Object.assign({}, window.hotkeyBase, { revision: request.expectedRevision + 1, recoveryHotkey: { saved, registered: fail ? [] : saved ? [saved] : [], error: fail ? '组合键可能已被占用：' + request.hotkey : null } });
          if (fail) reply.error = '无法注册 ' + request.hotkey + '，组合键可能已被占用';
          else reply.message = '已更新恢复快捷键';
          queueMicrotask(() => window.hertzWallpaperSettings.applyStatus(reply));
        }
      } };
    }, base);
    await page.goto('http://127.0.0.1:' + server.address().port + '/settings.html');
    await page.evaluate(payload => window.hertzWallpaperSettings.applyStatus(payload), statusPayload());
    await page.click('#tab-runtime');
    const hotkeyRequests = () => page.evaluate(() => window.desktopRequests.filter(request => request.cmd === 'recovery-hotkey'));

    // 就绪前的空态与就绪后的入口。
    await page.waitForFunction(() => document.querySelector('#settings-state').textContent === '设置已保存');
    assert.equal(await page.locator('#hotkey-saved').textContent(), '未设置');
    assert.equal(await page.locator('#hotkey-edit').textContent(), '设置快捷键');
    assert.equal(await page.locator('#hotkey-clear').isHidden(), true);
    assert.equal(await page.locator('#hotkey-edit').isEnabled(), true);

    // 录入：单独修饰键只给进度提示；单修饰+主键被拒绝；双修饰+主键通过。
    await page.click('#hotkey-edit');
    assert.equal(await page.locator('#hotkey-capture').isVisible(), true);
    assert.equal(await page.locator('#hotkey-save').isEnabled(), false);
    await page.keyboard.down('Control');
    await page.keyboard.up('Control');
    assert.match(await page.locator('#hotkey-progress').textContent(), /已按 Ctrl，请继续按主键/);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyB');
    await page.keyboard.up('Control');
    assert.match(await page.locator('#hotkey-progress').textContent(), /至少同时按住 Ctrl、Alt、Shift 中的两个/);
    assert.equal(await page.locator('#hotkey-save').isEnabled(), false);
    await page.keyboard.down('Control');
    await page.keyboard.down('Alt');
    await page.keyboard.press('KeyL');
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');
    assert.equal(await page.locator('#hotkey-record').textContent(), '已选择 Ctrl+Alt+L');
    assert.equal(await page.locator('#hotkey-save').isEnabled(), true);
    await page.click('#hotkey-save');
    await page.waitForFunction(() => document.querySelector('#hotkey-capture').hidden === true);
    assert.deepEqual(await hotkeyRequests(), [{ cmd: 'recovery-hotkey', hotkey: 'Ctrl+Alt+L', expectedRevision: 9 }]);
    assert.equal(await page.locator('#hotkey-saved').textContent(), 'Ctrl+Alt+L');
    assert.match(await page.locator('#hotkey-actual').textContent(), /当前生效：Ctrl\+Alt\+L/);
    assert.equal(await page.locator('#hotkey-edit').textContent(), '修改快捷键');
    assert.equal(await page.locator('#hotkey-clear').isVisible(), true);

    // Esc 取消与 F12 拒绝；取消不产生请求。
    await page.click('#hotkey-edit');
    await page.keyboard.press('F12');
    assert.match(await page.locator('#hotkey-progress').textContent(), /F12 由系统保留/);
    // Playwright 键位表到 F12 为止；F13 用合成事件验证同一文法。
    await page.evaluate(() => document.getElementById('hotkey-record').dispatchEvent(new KeyboardEvent('keydown', { key: 'F13', ctrlKey: true, altKey: true, bubbles: true })));
    assert.equal(await page.locator('#hotkey-record').textContent(), '已选择 Ctrl+Alt+F13');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#hotkey-capture').isHidden(), true);
    assert.equal((await hotkeyRequests()).length, 1);

    // 注册冲突：错误留在原处、录入保持打开，可换键重试。
    await page.evaluate(() => { window.hotkeyFailNext = true; });
    await page.click('#hotkey-edit');
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('F9');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await page.click('#hotkey-save');
    await page.waitForFunction(() => document.querySelector('#status').classList.contains('error'));
    assert.match(await page.locator('#status').textContent(), /无法注册 Ctrl\+Shift\+F9/);
    assert.match(await page.locator('#hotkey-actual').textContent(), /当前未生效|已被占用/);
    assert.equal(await page.locator('#hotkey-capture').isVisible(), true, '失败后保留录入，允许直接换键');
    await page.click('#hotkey-record');
    await page.keyboard.down('Control');
    await page.keyboard.down('Alt');
    await page.keyboard.press('KeyK');
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');
    await page.click('#hotkey-save');
    await page.waitForFunction(() => document.querySelector('#hotkey-saved').textContent === 'Ctrl+Alt+K');
    assert.equal(await page.locator('#hotkey-capture').isHidden(), true);
    assert.equal(await page.locator('#status').textContent(), '已更新恢复快捷键');

    // 键盘可达：聚焦入口按钮后 Enter 也能进入录入。
    await page.focus('#hotkey-edit');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#hotkey-capture').isVisible(), true);
    await page.keyboard.press('Escape');

    // 清除：请求携带 null，恢复空态。
    await page.click('#hotkey-clear');
    await page.waitForFunction(() => document.querySelector('#hotkey-saved').textContent === '未设置');
    assert.deepEqual((await hotkeyRequests()).at(-1), { cmd: 'recovery-hotkey', hotkey: null, expectedRevision: 12 });
    assert.equal(await page.locator('#hotkey-clear').isHidden(), true);

    // 脏草稿互斥：草稿未应用时禁止改动快捷键。#enabled 在隐藏的壁纸页里，用编程 click 触发 change。
    await page.evaluate(() => document.getElementById('enabled').click());
    await page.waitForFunction(() => document.querySelector('#settings-state').dataset.dirty === 'true');
    assert.equal(await page.locator('#hotkey-edit').isEnabled(), false);
    assert.equal(await page.locator('#hotkey-clear').isEnabled(), false);
    await page.click('#discard');
    await page.waitForFunction(() => document.querySelector('#hotkey-edit').disabled === false);

    // 旧宿主状态兼容：缺 recoveryHotkey 字段时不改写、不报错。
    await page.evaluate(() => window.hertzWallpaperSettings.applyStatus(Object.assign({}, window.hotkeyBase, { revision: 99 })));
    assert.equal(await page.locator('#hotkey-saved').textContent(), '未设置');
    assert.equal(errors.length, 0);

    // 窄窗口：aside 内自动换行，无横向溢出。
    await page.setViewportSize({ width: 360, height: 700 });
    await page.waitForTimeout(100);
    const narrow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      captureHidden: document.querySelector('#hotkey-capture').hidden,
      idleVisible: !document.querySelector('#hotkey-idle').hidden,
    }));
    assert.ok(narrow.scrollWidth <= narrow.clientWidth + 1, 'narrow layout must not overflow horizontally');
    assert.equal(narrow.captureHidden, true);
    assert.equal(narrow.idleVisible, true);
  } finally {
    await browser.close();
    server.close();
  }
  assert.deepEqual(errors, []);
  console.log('check-recovery-hotkey-browser: all assertions passed');
}
main().catch(error => { console.error(error); process.exit(1); });
