// SPDX-License-Identifier: MIT
// Windows main-window wallpaper settings, real embedded host and private disk configuration.
// Requires a fresh full,native-window hertz-studio build, Playwright and WebView2.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/inline-wallpaper-native-' + Date.now());
const data = path.join(output, 'data'), desktop = path.join(output, 'desktop');
const binary = path.resolve(process.env.HERTZ_BIN || path.join(root, 'target/debug/hertz-studio.exe'));
const configPath = path.join(desktop, 'config.json'), failedWritePath = path.join(desktop, 'config.json.tmp');
const checks = [], errors = [], launches = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, page, editor, discovery, spawnError;
const mark = message => { checks.push(message); console.log('PASS ' + message); };
function writeJson(name, value) { fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2)); }
async function until(read, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const value = await read(); if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function api(endpoint, method = 'GET', body, expected = 200) {
  const response = await fetch('http://127.0.0.1:' + discovery.port + endpoint, { method,
    headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(55000) });
  const reply = await response.json();
  assert.equal(response.status, expected, endpoint + ': ' + JSON.stringify(reply));
  return reply;
}
const command = (command, value) => api('/v1/desktop/control', 'POST', { command, ...(value === undefined ? {} : { value }) });
const read = owner => command('lyrics-settings', owner ? { owner } : {});
const windows = screenshot => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/inline-wallpaper-windows.ps1'),
  ...(screenshot ? ['-ScreenshotPath', path.join(output, screenshot + '.png')] : []),
  '-TargetPid', String(child.pid)], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim());
function stored() { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
function domain(config) {
  const canonical = value => path.resolve(value.replace(/^\\\\\?\\/, '')).toLowerCase();
  const found = config.profiles.find(item => canonical(item.profile.dataDir) === canonical(data));
  assert.ok(found, 'Owned player profile is stored separately'); return found;
}
function assertNoSettingsWindow() {
  const owned = windows();
  assert.ok(owned.some(window => window.Title === 'HertzStudio Music Player' && window.ProcessId === child.pid));
  assert.ok(!owned.some(window => window.Title === '桌面歌词与壁纸' && !window.Child), 'Wallpaper editor must be a main-window child');
  return owned;
}
async function start() {
  const port = await freePort(); spawnError = null;
  const log = fs.openSync(path.join(output, 'host-' + (launches.length + 1) + '.log'), 'a');
  child = spawn(binary, ['--window', '--bind', '127.0.0.1', '--port', '0', '--data-dir', data], {
    cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env,
      VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', HERTZ_DESKTOP_CONFIG_DIR: desktop,
      WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
    },
  });
  fs.closeSync(log); child.on('error', error => { spawnError = error; });
  launches.push({ pid: child.pid, cdpPort: port });
  discovery = await until(() => {
    if (child.exitCode !== null) throw new Error('Owned player exited: ' + child.exitCode);
    try { const value = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'), 'utf8')); return value.pid === child.pid && value; } catch { return null; }
  }, 'owned native service startup', 60000);
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch { return false; } }, 'owned native CDP');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(p => p.url().startsWith('http://127.0.0.1:' + discovery.port)), 'native main WebView');
  page.setDefaultTimeout(18000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.__hertzWindowHost && window.HertzDesktopLyricsSettings && document.getElementById('conn').textContent === '服务已连接', null, { timeout: 45000 });
  assert.equal((await api('/v1/health')).backend, 'null');
}
async function openInline() {
  await page.evaluate(() => window.dispatchEvent(new Event('hertz-open-desktop-lyrics-settings')));
  await page.locator('#desktop-lyrics-settings').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('dls-controls').disabled && !document.getElementById('dls-refresh').disabled);
  await page.waitForFunction(() => document.querySelector('#desktop-lyrics-settings > legend').getBoundingClientRect().top
    >= document.querySelector('.hz-settings-nav').getBoundingClientRect().bottom);
}
async function settle() { await page.waitForFunction(() => !document.getElementById('dls-refresh').disabled); }
async function shutdown() {
  await api('/v1/system/shutdown', 'POST', {}, 202);
  await until(() => child.exitCode !== null || child.signalCode !== null, 'owned player graceful shutdown', 30000);
  assert.equal(child.exitCode, 0, 'Owned player exited successfully');
  if (browser) await browser.close().catch(() => {});
  browser = page = child = null;
}
async function cleanup() {
  if (fs.existsSync(failedWritePath) && fs.statSync(failedWritePath).isDirectory()) {
    assert.equal(path.dirname(path.resolve(failedWritePath)), path.resolve(desktop));
    fs.rmdirSync(failedWritePath); // Empty, explicitly named fixture fault; no recursive removal.
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    await api('/v1/system/shutdown', 'POST', {}, 202).catch(() => {});
    await delay(500);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await until(() => child.exitCode !== null || child.signalCode !== null, 'owned process cleanup', 5000);
  }
  if (browser) await browser.close().catch(() => {});
  browser = page = child = null;
}
async function main() {
  assert.equal(process.platform, 'win32');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(desktop);
  if (!process.argv.includes('--surface-only')) {
    const exe = fs.readFileSync(binary), pe = exe.readUInt32LE(0x3c);
    assert.equal(exe.readUInt16LE(pe + 24 + 68), 2, 'Installed native player must use the Windows GUI subsystem');
    mark('Native PE uses GUI subsystem; launching from Explorer cannot allocate a console');
  }
  await start();
  await page.evaluate(() => { HertzShell.navigate('settings'); HertzSkin.selectSettings('lyrics'); });
  await page.locator('#set-wallpaper-settings').click();
  await page.locator('#wallpaper-settings-workspace').waitFor({ state: 'visible', timeout: 12000 });
  editor = await until(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/settings.html')), 'embedded settings WebView');
  editor.setDefaultTimeout(15000);
  editor.on('pageerror', error => errors.push(error.message));
  await editor.waitForFunction(() => document.getElementById('settings-state').textContent !== '读取中');
  await until(async () => (await editor.locator('#enabled').isEnabled()), 'settings ready');
  await editor.evaluate(() => {
    window.__surfaceProbe = [];
    const post = window.chrome.webview.postMessage.bind(window.chrome.webview);
    window.chrome.webview.postMessage = value => { window.__surfaceProbe.push(JSON.parse(value)); post(value); };
  });
  assertNoSettingsWindow();
  const before = await command('wallpaper-status');
  assert.equal((await read()).lyricsConfig.enabled, false, 'Opening wallpaper settings preserves disabled lyrics');
  const ownedWindows = windows('native-workspace'); writeJson('windows-editor', ownedWindows);
  const mainWindow = ownedWindows.find(w => w.Title === 'HertzStudio Music Player' && !w.Child);
  const settingsWindow = ownedWindows.find(w => w.Title === '桌面歌词与壁纸' && w.Child);
  assert.equal(settingsWindow.Parent, mainWindow.Handle, 'Editor HWND belongs to the main player');
  assert.equal(settingsWindow.Visible, true);
  const viewport = await page.evaluate(() => { const rect = document.getElementById('column').getBoundingClientRect(); return { bottom: Math.round(rect.bottom * devicePixelRatio) }; });
  assert.ok(settingsWindow.Bounds.Bottom <= mainWindow.Client.Top + viewport.bottom, 'Editor is clipped above the main player controls');
  await editor.screenshot({ path: path.join(output, 'embedded-editor.png') });
  await page.screenshot({ path: path.join(output, 'main-workspace.png') });
  mark('Player wallpaper entry mounts the complete existing editor without a top-level settings window');
  await page.evaluate(() => {
    window.__quitFixtureFlush = CreativeStage.flushPersistence;
    CreativeStage.flushPersistence = () => Promise.reject(new Error('Fixture save failure'));
    window.__hertzWindowHost.requestQuit();
  });
  await page.locator('#window-lifecycle-dialog').waitFor({ state: 'visible' });
  await until(() => !windows().some(w => w.Title === '桌面歌词与壁纸' && w.Visible), 'quit confirmation is unobstructed');
  windows('native-quit-confirmation');
  await page.locator('#window-lifecycle-cancel').click();
  await page.evaluate(() => { CreativeStage.flushPersistence = window.__quitFixtureFlush; });
  await until(() => windows().some(w => w.Title === '桌面歌词与壁纸' && w.Child && w.Visible), 'cancel restores editor');
  mark('Main quit confirmation remains accessible and cancelling restores the editor');
  const oldMotion = await editor.locator('#motion').inputValue();
  await editor.locator('#motion').fill('0.4'); await editor.locator('#motion').dispatchEvent('change');
  await editor.locator('#discard').click();
  assert.equal(await editor.locator('#motion').inputValue(), oldMotion);
  mark('Cancel restores the saved wallpaper values');
  await editor.locator('#motion').fill('0.4'); await editor.locator('#motion').dispatchEvent('change');
  await editor.locator('#apply').click();
  await until(async () => /设置已保存/.test(await editor.locator('#status').innerText()), 'confirmed save');
  assert.equal(await editor.locator('#apply').isDisabled(), true);
  assert.equal(domain(stored()).wallpaper.groups[0].presentation.motion, 0.4);
  mark('Apply saves through the original settings transaction and updates editor state');
  const saved = fs.readFileSync(configPath);
  fs.mkdirSync(failedWritePath);
  try {
    await editor.locator('#motion').fill('0.6'); await editor.locator('#motion').dispatchEvent('change');
    await editor.locator('#apply').click();
    await until(async () => (await editor.locator('#status').getAttribute('class')) === 'error', 'write failure');
    assert.equal(await editor.locator('#motion').inputValue(), '0.6');
    assert.deepEqual(fs.readFileSync(configPath), saved);
  } finally { fs.rmdirSync(failedWritePath); }
  await editor.locator('#discard').click();
  mark('Disk failure preserves both the existing configuration and editable draft');
  await editor.locator('details:has(#audio-gain) > summary').click();
  await editor.locator('#audio-gain').fill('');
  await editor.locator('#audio-gain').dispatchEvent('change');
  assert.equal(await editor.locator('#apply').isDisabled(), true);
  assert.equal(await editor.locator('#audio-gain').getAttribute('aria-invalid'), 'true');
  assert.deepEqual(fs.readFileSync(configPath), saved);
  await editor.locator('#discard').click();
  mark('Invalid audio configuration is identified inline and cannot be saved');
  await editor.locator('#motion').fill('0.6'); await editor.locator('#motion').dispatchEvent('change');
  const currentLyrics = await read();
  const external = await command('lyrics-apply', { expectedRevision: currentLyrics.revision, lyrics: { ...currentLyrics.lyricsConfig, fontSize: 31 } });
  assert.equal(external.ok, true);
  await until(async () => editor.locator('#conflict').isVisible(), 'shared configuration revision conflict');
  assert.equal(await editor.locator('#motion').inputValue(), '0.6');
  assert.equal(await editor.locator('#apply').isDisabled(), true);
  await editor.locator('#discard').click();
  assert.equal(await editor.locator('#motion').inputValue(), '0.4');
  mark('External configuration changes preserve the draft and block stale Apply until reread');
  await editor.locator('#tab-lyrics').click();
  await editor.locator('#position-begin').click();
  await editor.locator('#position-session').waitFor({ state: 'visible' });
  await editor.evaluate(() => {
    window.dispatchEvent(new Event('resize'));
    window.ipc.postMessage(JSON.stringify({ cmd: 'status' }));
  });
  await delay(250);
  assert.notEqual(await editor.locator('#status').getAttribute('class'), 'error', 'Presentation updates remain allowed during position editing');
  assert.equal((await command('wallpaper-status')).positionEditing, true);
  await editor.locator('#position-cancel').click();
  await editor.locator('#position-session').waitFor({ state: 'hidden' });
  assert.equal((await read()).lyricsConfig.enabled, false, 'Cancelling position editing restores saved disabled lyrics');
  await editor.locator('#tab-wallpaper').click();
  mark('Editor geometry updates do not interrupt the existing lyrics position editing transaction');
  await editor.locator('#preview').click();
  await until(async () => (await editor.locator('#preview').innerText()) === '结束预览', 'preview UI', 10000);
  await delay(1000);
  assert.equal(await editor.locator('#preview').innerText(), '结束预览', 'Preview retains its owner after presentation');
  const previewState = await command('wallpaper-status'); writeJson('preview-state', previewState);
  assert.ok(previewState.wallpaper.mediaPreview.width <= 640 && previewState.wallpaper.mediaPreview.height <= 360, 'Preview keeps the original physical target budget');
  await until(async () => (await command('wallpaper-status')).wallpaper.mediaPreview?.firstFrameReady, 'actual native preview first frame', 15000);
  const previousPreview = (await command('wallpaper-status')).wallpaper.mediaPreview;
  const renderer = await until(async () => {
    for (const candidate of browser.contexts().flatMap(context => context.pages())) {
      if (await candidate.evaluate(generation => window.__hertzWallpaperBinding?.generation === generation, previousPreview.generation).catch(() => false)) return candidate;
    }
  }, 'current preview renderer');
  await renderer.evaluate(() => {
    window.__capturePost = window.chrome.webview.postMessage.bind(window.chrome.webview);
    window.chrome.webview.postMessage = value => {
      if (value.startsWith('wallpaper_capture ')) { window.__heldCapture = value; return; }
      window.__capturePost(value);
    };
  });
  await editor.locator('#motion').fill('0.5'); await editor.locator('#motion').dispatchEvent('change');
  await renderer.waitForFunction(() => !!window.__heldCapture);
  const previewScroll = await editor.evaluate(() => {
    const main = document.querySelector('main'), previous = main.scrollTop;
    main.scrollTop = main.scrollHeight; return previous;
  });
  await until(() => !windows().some(w => w.Title === '壁纸预览' && w.Visible), 'preview hidden before delayed capture');
  await renderer.evaluate(() => window.__capturePost(window.__heldCapture));
  const hiddenHandoff = await until(async () => {
    const handoff = (await command('wallpaper-status')).wallpaper.mediaPreview?.handoff;
    return handoff?.captured && handoff;
  }, 'retained preview after delayed capture');
  assert.equal(hiddenHandoff.visible, false, 'A delayed retained frame cannot reappear over scrolled editor content');
  await editor.evaluate(top => { document.querySelector('main').scrollTop = top; }, previewScroll);
  mark('A delayed preview capture preserves the current editor visibility');
  await until(async () => {
    const current = (await command('wallpaper-status')).wallpaper.mediaPreview;
    return current && current.generation !== previousPreview.generation && current.firstFrameReady && !current.error && !current.handoff;
  }, 'replacement preview first frame', 15000);
  mark('Running preview updates retain the original bounded handoff and reach a new real frame');
  assert.ok(!windows().some(w => !w.Child && (w.Title === '壁纸预览' || w.Title === '桌面歌词与壁纸')));
  const previewWindows = windows('native-preview'); writeJson('windows-preview', previewWindows);
  const finalPreview = previewWindows.find(w => w.Title === '壁纸预览' && w.Child && w.Visible);
  assert.ok(finalPreview, 'Native preview HWND is visible inside the editor');
  assert.equal(finalPreview.Alpha, 255, 'Native real-frame gate reveals the actual preview');
  assert.deepEqual(finalPreview.OccludingSiblings, [], 'Editor WebView must not cover the rendered preview');
  const parentEditor = previewWindows.find(w => w.Title === '桌面歌词与壁纸' && w.Child);
  assert.equal(finalPreview.Parent, parentEditor.Handle);
  assert.ok(finalPreview.Bounds.Left >= parentEditor.Bounds.Left && finalPreview.Bounds.Right <= parentEditor.Bounds.Right
    && finalPreview.Bounds.Top >= parentEditor.Bounds.Top && finalPreview.Bounds.Bottom <= parentEditor.Bounds.Bottom, 'Preview is clipped inside the editor');
  await until(async () => !/正在更新预览/.test(await editor.locator('#preview-placeholder-title').innerText()), 'editor retires the preview loading state', 5000);
  assert.equal(await editor.locator('#preview-kind').innerText(), '当前草稿预览');
  await page.evaluate(() => Theme.apply('hertz-light'));
  await editor.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.evaluate(() => Theme.apply('hertz-dark'));
  await editor.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.deepEqual(windows().find(w => w.Title === '壁纸预览' && w.Child && w.Visible).OccludingSiblings, [], 'Main presentation changes preserve preview visibility');
  windows('native-preview');
  writeJson('preview-ready', await command('wallpaper-status'));
  await editor.screenshot({ path: path.join(output, 'embedded-preview.png') });
  await editor.locator('#preview').click();
  mark('Preview remains inside the settings editor without a top-level preview window');
  await editor.locator('#motion').fill('0.6'); await editor.locator('#motion').dispatchEvent('change');
  await editor.locator('#preview').click();
  await until(async () => (await editor.locator('#preview').innerText()) === '结束预览', 'preview before navigation');
  await page.evaluate(() => HertzShell.navigate('home'));
  await until(() => !windows().some(w => (w.Title === '桌面歌词与壁纸' || w.Title === '壁纸预览') && w.Visible), 'hidden editor and retired preview');
  await page.evaluate(() => HertzWallpaperSettings.open('wallpaper'));
  await until(() => windows().some(w => w.Title === '桌面歌词与壁纸' && w.Child && w.Visible), 'editor returns');
  assert.equal(await editor.locator('#motion').inputValue(), '0.6');
  await editor.locator('#discard').click();
  mark('Leaving the page releases preview and hides the editor while preserving its unsaved draft');
  await page.evaluate(() => Theme.apply('hertz-light'));
  await editor.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  windows('native-light');
  await page.evaluate(() => Theme.apply('hertz-dark'));
  await editor.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  mark('Embedded editor follows the main player light and dark themes');
  await command('wallpaper-settings', { tab: 'runtime' });
  await editor.locator('#panel-runtime').waitFor({ state: 'visible' });
  assertNoSettingsWindow();
  mark('Legacy wallpaper-settings commands navigate the embedded editor');
  assert.equal((await command('open-center', { tab: 'wallpaper' })).ok, true);
  await editor.locator('#panel-wallpaper').waitFor({ state: 'visible' });
  assertNoSettingsWindow();
  await editor.locator('#tab-wallpaper').click();
  await editor.locator('#motion').fill('0.6'); await editor.locator('#motion').dispatchEvent('change');
  await editor.locator('#close').click();
  await editor.locator('#close-confirm').waitFor({ state: 'visible' });
  await editor.locator('#continue-editing').click();
  assert.equal(await editor.locator('#motion').inputValue(), '0.6');
  await editor.locator('#discard').click();
  mark('Closing with unsaved changes offers inline confirmation and can continue editing');
  await editor.locator('#close').click();
  await page.locator('#wallpaper-settings-workspace').waitFor({ state: 'hidden' });
  await command('wallpaper-settings', { tab: 'runtime' });
  editor = await until(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/settings.html') && !p.isClosed()), 'legacy reopened editor');
  await editor.locator('#panel-runtime').waitFor({ state: 'visible' });
  await editor.locator('#close').click();
  await page.locator('#wallpaper-settings-workspace').waitFor({ state: 'hidden' });
  mark('Legacy navigation preserves its requested tab after closing the editor');
  await page.locator('#set-wallpaper-settings').click();
  const reopened = await until(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/settings.html') && !p.isClosed()), 'reopened editor');
  await until(async () => (await reopened.locator('#motion').inputValue()) === '0.4', 'saved value after reopening');
  assertNoSettingsWindow();
  await page.reload();
  await page.waitForFunction(() => window.HertzWallpaperSettings && window.__hertzWindowHost);
  assertNoSettingsWindow();
  assert.deepEqual(errors, []);
  mark('Close/reopen/reload retires the old view while retaining saved configuration');
  await shutdown();
}
main().then(async () => {
  await cleanup(); writeJson('report', { passed: true, cleanupDone: true, checks, errors, launches,
    binarySha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    scope: 'Real Wry/WebView2 main window and embedded desktop host, private config/data, null audio; no physical monitor drag or mixed-DPI qualification.' });
  console.log('Inline wallpaper native: ' + checks.length + ' groups; ' + output);
}).catch(async error => {
  if (editor && !editor.isClosed()) {
    await editor.screenshot({ path: path.join(output, 'editor-failure.png'), timeout: 5000 }).catch(() => {});
    writeJson('editor-diagnostics', await editor.evaluate(() => ({ status: document.getElementById('status').innerText, commands: window.__surfaceProbe })).catch(() => null));
  }
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
  await cleanup().catch(() => {});
  fs.mkdirSync(output, { recursive: true }); writeJson('report', { passed: false, checks, errors, launches, error: error.stack });
  console.error(error); console.error(output); process.exitCode = 1;
});
