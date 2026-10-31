// SPDX-License-Identifier: MIT
// Production UI in a real allow-scripts-only iframe. API replies are controlled fixtures.
// --settings-default isolates saved settings startup, skin handoff and Escape admission.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), ui = path.join(root, 'plugin/ui');
// Independent reviewers can keep their evidence separate from the implementer's run.
const output = process.env.HERTZ_DESKTOP_UI_EVIDENCE_DIR
  ? path.resolve(process.env.HERTZ_DESKTOP_UI_EVIDENCE_DIR)
  : path.join(root, 'output/playwright/dbx-desktop-settings');
const read = file => fs.readFileSync(path.join(ui, file), 'utf8');
const baseCaps = {
  supported: true, reason: 'management-ready', error: null,
  source: { kind: 'dbx', edition: 'standard', dataDir: 'D:\\DBX-fixture', pluginId: 'io.github.oncemisery.hertz-studio' },
  transport: 'named-pipe', buildId: 'fixture-plugin', requiredDesktopBuildId: 'fixture-desktop', launchMode: 'manual',
  component: { state: 'ready', origin: 'running', error: null },
  authorization: { scopes: [], revision: null, gate: false, listenerReady: false, persistentRevoked: false, cleanupIncomplete: false, scopeErrors: [], error: null },
  managementProtocol: 2, bridgeProtocol: 1, launchRequested: false, managementReady: true, sourceConnected: false,
  sourceScopes: { lyrics: false, wallpaper: false },
};
const clone = value => JSON.parse(JSON.stringify(value));
function capability(change = {}) { return { ...clone(baseCaps), ...change }; }
function consent(change = {}) { return capability({ authorization: { ...baseCaps.authorization, scopes: ['lyrics', 'wallpaper'], revision: 7, gate: true, listenerReady: true, ...change } }); }
function revoked(change = {}) { return capability({ managementReady: false, authorization: { ...baseCaps.authorization, persistentRevoked: true, ...change } }); }
function fixture(preferences = {}) {
  window.fixture = {
    requests: [], desktopReply: null, held: {}, hold: '',
    async request(method, params) {
      this.requests.push({ method, params: structuredClone(params) });
      if (method.startsWith('v1/desktop/')) {
        if (this.hold === method) return new Promise(resolve => { this.held[method] = resolve; });
        return structuredClone(this.desktopReply);
      }
      const body = method.startsWith('v1/recommend/daily') ? { tracks: [], pending: [], sources: [] }
        : method === 'v1/room' ? { mode: 'local' } : method === 'v1/settings' ? {} : method === 'v1/state'
        ? { playing: false, buffering: false, volume: 1, position_ms: 0, duration_ms: 0, mode: 'repeat', track_id: null }
        : method === 'v1/tracks' ? { tracks: [], total: 0 } : method === 'v1/player/queue' ? { queue: [], index: -1 }
          : method === 'v1/playlists' || method === 'v1/favorites' ? []
            : method === 'v1/devices' ? { devices: [] } : method === 'v1/library/scan/roots' ? { roots: [] }
              : method === 'v1/library/scan/history' ? { runs: [] } : method === 'v1/health' ? { backend: 'fixture', version: 'fixture', protocol_version: 1 }
                : method === 'v1/tracks/facets' ? { facets: [] } : {};
      return { status: 200, body };
    },
  };
  window.dbxPlugin = {
    ready: Promise.resolve(), context: { surface: 'tab' },
    storage: { get: async () => preferences, set: async () => {} },
    onEvent: () => () => {}, invoke: (method, params) => window.fixture.request(method, params),
  };
}
const indexHtml = read('index.html');
const fixtureHtml = preferences => indexHtml.replace('<head>', '<head><script>(' + fixture.toString() + ')(' + JSON.stringify(preferences) + ');</script>');

// Targeted production-app regression for a supported saved default. No source slicing.
async function checkSettingsDefault(browser, baseUrl) {
  const skins = ['classic', 'liunian', 'qingfeng', 'heijiao', 'orbit'], evidence = [];
  for (const initialSkin of skins) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(baseUrl + '/host?startupSkin=' + initialSkin, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const iframe = await page.waitForSelector('iframe'), frame = await iframe.contentFrame();
      assert.ok(frame);
      await frame.waitForURL(/\/index\.html(?:\?|$)/, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await frame.waitForFunction(() => document.getElementById('conn')?.textContent === '服务已连接', null, { timeout: 20000 });
      const requests = () => frame.evaluate(() => fixture.requests.filter(request => request.method.startsWith('v1/desktop/')));
      // Let real skin observers and their rendering work settle; no production timer gate.
      const renderBoundary = () => frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await renderBoundary();
      assert.equal(await frame.evaluate(() => self.origin), 'null');
      assert.equal(await frame.evaluate(() => localStorage.getItem('vmusic.defaultView')), 'settings');
      assert.equal(await frame.evaluate(() => state.view), 'settings', 'saved view landing is preserved');
      assert.equal(await frame.evaluate(() => Skins.currentId()), initialSkin);
      assert.deepEqual(await requests(), [], initialSkin + ' restored settings startup never detects');

      const mounts = [];
      for (const skin of skins) {
        await frame.evaluate(skin => Skins.apply(skin), skin);
        await renderBoundary();
        assert.equal(await frame.evaluate(() => state.view), 'settings', 'skin handoff keeps the saved landing');
        assert.deepEqual(await requests(), [], initialSkin + ' → ' + skin + ' programmatic settings handoff never detects');
        mounts.push(skin);
      }
      await frame.evaluate(skin => Skins.apply(skin), initialSkin);
      await renderBoundary();
      assert.deepEqual(await requests(), []);
      await frame.locator('body').press('Escape');
      await renderBoundary();
      assert.deepEqual(await requests(), [], 'Escape while restored settings is active does not inspect desktop');
      await frame.evaluate(caps => { fixture.desktopReply = { status: 200, body: caps }; }, capability());
      const close = async () => {
        await frame.waitForFunction(() => !document.querySelector('.skset-modal.is-closing, .qf-modal.is-closing, .ln-modal.is-closing'));
        const button = frame.locator('.skset-modal:not([hidden]) .skset-modal-close, .qf-modal:not([hidden]) .qf-modal-close, .ln-modal:not([hidden]) .ln-modal-close').first();
        if (await button.count()) {
          await button.click();
          await frame.waitForFunction(() => [...document.querySelectorAll('.skset-modal, .qf-modal, .ln-modal')].every(modal => modal.hidden));
        }
        await renderBoundary();
      };
      await close();
      assert.deepEqual(await requests(), [], 'closing a restored settings sheet does not inspect desktop');
      await frame.locator('body').press('Escape');
      await renderBoundary();
      assert.deepEqual(await requests(), [], 'global Escape on the restored view does not inspect desktop');
      await close();
      const entry = initialSkin === 'qingfeng' ? '.qf-settings-btn' : initialSkin === 'liunian' ? '.ln-nav-item[data-ln-view="settings"]' : '.rail-item[data-view="settings"]';
      const open = async expectedCount => {
        if (initialSkin === 'heijiao') await frame.locator('.hj-nav-handle').hover();
        await frame.locator(entry).click();
        await frame.waitForFunction(expected => fixture.requests.filter(request => request.method === 'v1/desktop/capabilities').length === expected && !document.getElementById('dbx-desktop-refresh')?.disabled, expectedCount);
        await renderBoundary();
        assert.equal((await requests()).length, expectedCount, 'one explicit refresh per real open');
      };
      await open(1);
      await close();
      await open(2);
      await close();
      await frame.locator('#bar-desktop-settings').click();
      await frame.waitForFunction(() => document.activeElement?.id === 'dbx-desktop-settings' && !document.getElementById('dbx-desktop-refresh')?.disabled);
      await renderBoundary();
      assert.equal((await requests()).length, 3, 'explicit bar action still detects once after restored settings');
      assert.equal(await frame.locator('#dbx-desktop-settings').isVisible(), true);
      assert.ok((await requests()).every(request => request.method === 'v1/desktop/capabilities'), 'no automatic connect/disconnect/launch');
      assert.deepEqual(errors, []);
      evidence.push({ initialSkin, savedDefaultView: 'settings', restoredView: 'settings', mounts, startupAndMountDesktopRequests: 0, userOpenReopenBarDesktopRequests: await requests(), errors });
      console.log('PASS saved settings default:', initialSkin, 'startup + 5 skin mounts: 0 desktop requests; real open/reopen/bar: 3');
    } finally { await page.close(); }
  }
  fs.writeFileSync(path.join(output, 'settings-default-evidence.json'), JSON.stringify(evidence, null, 2));
}

async function checkStandalone(browser) {
  const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
  try {
    const app = read('app.js');
    const bindings = app.slice(app.indexOf('  // DBX 的统一桌面区只注册事件'), app.indexOf('  ui.setLyricOffsetDown.onclick'));
    assert.ok(bindings.includes('const wallpaperControl'), 'exercise the original production desktop binding block');
    const source = read('index.html'), groupEnd = source.lastIndexOf('<div class="set-row">', source.indexOf('<label>全局时间偏移'));
    const group = source.slice(source.indexOf('      <!-- 歌词：'), groupEnd);
    await page.setContent('<meta charset="utf-8"><body>' + group + '</div><button id="bar-desktop-settings">桌面入口</button>');
    await page.addStyleTag({ content: read('style.css') });
    await page.evaluate(() => {
      window.hertzHost = { isDbx: false };
      window.$ = id => document.getElementById(id);
      window.ui = Object.fromEntries(['barDesktopSettings', 'setDesktopLyricsRow', 'setDesktopLyricsOpen', 'setDesktopLyricsLocate', 'setWallpaperRow', 'setWallpaperSettings', 'setWallpaperToggle', 'setWallpaperNote'].map(key => [key, $(key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()))]));
      window.legacyRequests = []; window.legacyToasts = []; window.failNextControl = false;
      window.toast = text => legacyToasts.push(text); window.errText = (text, error) => text + error.message;
      window.transport = { async post(endpoint, body) {
        legacyRequests.push({ endpoint, body: JSON.parse(JSON.stringify(body)) });
        if (failNextControl && endpoint === '/v1/desktop/control') { failNextControl = false; throw Object.assign(new Error('not running'), { code: 'desktop_not_running' }); }
        return { ok: true, wallpaper: { enabled: true, hidden: true } };
      } };
    });
    await page.addScriptTag({ content: read('desktop-settings.js') });
    await page.addScriptTag({ content: bindings });
    assert.equal(await page.locator('#dbx-desktop-settings').isVisible(), false, 'Standalone optional DBX section stays hidden');
    assert.equal(await page.locator('#set-desktop-lyrics-row').isVisible(), true);
    assert.equal(await page.locator('#set-wallpaper-row').isVisible(), true);
    await page.locator('#set-desktop-lyrics-open').click();
    await page.locator('#set-desktop-lyrics-locate').click();
    await page.locator('#set-wallpaper-settings').click();
    await page.locator('#set-wallpaper-toggle').click();
    await page.locator('#bar-desktop-settings').click();
    assert.deepEqual(await page.evaluate(() => legacyRequests), [
      { endpoint: '/v1/desktop/control', body: { command: 'wallpaper-settings', value: { tab: 'lyrics' } } },
      { endpoint: '/v1/desktop/lyrics/control', body: { command: 'locate' } },
      { endpoint: '/v1/desktop/control', body: { command: 'wallpaper-settings', value: { tab: 'wallpaper' } } },
      { endpoint: '/v1/desktop/control', body: { command: 'wallpaper-toggle' } },
      { endpoint: '/v1/desktop/control', body: { command: 'wallpaper-settings', value: { tab: 'wallpaper' } } },
    ]);
    await page.evaluate(() => { failNextControl = true; legacyRequests.length = 0; });
    await page.locator('#set-wallpaper-settings').click();
    await page.waitForFunction(() => legacyRequests.length === 3);
    assert.deepEqual(await page.evaluate(() => legacyRequests), [
      { endpoint: '/v1/desktop/control', body: { command: 'wallpaper-settings', value: { tab: 'wallpaper' } } },
      { endpoint: '/v1/desktop/wallpaper/launch', body: {} },
      { endpoint: '/v1/desktop/control', body: { command: 'wallpaper-settings', value: { tab: 'wallpaper' } } },
    ], 'Standalone retains legacy missing-host launch/followup instead of capability detection');
    console.log('PASS Standalone original lyrics/settings/locate/toggle/bar and missing-host launch/followup');
  } finally { await page.close(); }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost'), pathname = requestUrl.pathname;
    const skin = requestUrl.searchParams.get('startupSkin');
    const startupSkin = ['classic', 'liunian', 'qingfeng', 'heijiao', 'orbit'].includes(skin) ? skin : null;
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (pathname === '/host') { response.setHeader('Content-Type', 'text/html'); return response.end('<body style="margin:0"><iframe title="DBX" sandbox="allow-scripts" src="/index.html' + (startupSkin ? '?startupSkin=' + startupSkin : '') + '" style="border:0;width:100vw;height:100vh"></iframe>'); }
    if (pathname === '/index.html') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(fixtureHtml(startupSkin ? { 'vmusic.defaultView': 'settings', 'vmusic.skin': startupSkin, 'vmusic.skin.default': 'orbit' } : {})); }
    const file = path.resolve(ui, '.' + pathname);
    if (!file.startsWith(ui + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); return response.end(); }
    response.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-webgl'] });
  if (process.argv.includes('--settings-default')) {
    try { await checkSettingsDefault(browser, 'http://127.0.0.1:' + server.address().port); }
    finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
    return;
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
  try {
    await page.goto('http://127.0.0.1:' + server.address().port + '/host', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const iframe = await page.waitForSelector('iframe');
    const frame = await iframe.contentFrame();
    assert.ok(frame, 'DBX iframe is attached');
    // Parent DOMContentLoaded does not imply that a child has left about:blank.
    await frame.waitForURL(/\/index\.html$/, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await frame.waitForFunction(() => document.getElementById('conn')?.textContent === '服务已连接', null, { timeout: 20000 }).catch(async error => {
      throw new Error(error.message + '\n' + await frame.locator('body').innerText() + '\n' + errors.join('\n'));
    });
    assert.equal(await frame.evaluate(() => location.origin), 'http://127.0.0.1:' + server.address().port);
    assert.equal(await frame.evaluate(() => self.origin), 'null', 'effective document origin is opaque');
    assert.equal(await frame.evaluate(() => { try { return !!parent.document; } catch (_) { return false; } }), false, 'sandbox prevents same-URL parent DOM access');
    assert.equal(await frame.evaluate(() => { try { return !!window.localStorage; } catch (_) { return false; } }), true, 'host storage shim works in opaque sandbox');
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
    const requests = () => frame.evaluate(() => fixture.requests.filter(r => r.method.startsWith('v1/desktop/')));
    const count = async method => (await requests()).filter(r => r.method === method).length;
    const reply = async value => frame.evaluate(value => { fixture.desktopReply = value; }, value);
    const detect = async caps => {
      await reply({ status: 200, body: caps });
      await frame.locator('#dbx-desktop-refresh').click();
      await frame.waitForFunction(() => !document.getElementById('dbx-desktop-refresh').disabled);
    };
    const text = () => frame.locator('#dbx-desktop-settings').innerText();
    const closeSheet = async () => {
      const button = frame.locator('.skset-modal:not([hidden]) .skset-modal-close, .qf-modal:not([hidden]) .qf-modal-close, .ln-modal:not([hidden]) .ln-modal-close').first();
      if (await button.count()) await button.click();
      await frame.waitForTimeout(250);
    };
    assert.equal((await requests()).length, 0, 'bootstrap and initial settings load do not inspect desktop');
    await frame.evaluate(async () => { await loadSettings(); await refreshAll(); });
    assert.equal((await requests()).length, 0, 'loadSettings/refreshAll remain pure with respect to desktop');
    assert.equal(await frame.locator('#set-desktop-lyrics-row').isVisible(), false);
    assert.equal(await frame.locator('#set-wallpaper-row').isVisible(), false);

    const skins = await frame.evaluate(() => Skins.catalog().map(skin => skin.id));
    assert.deepEqual(skins, ['classic', 'liunian', 'qingfeng', 'heijiao', 'orbit']);
    for (const skin of skins) {
      await frame.evaluate(skin => Skins.apply(skin), skin);
      await frame.waitForTimeout(100);
      const before = await count('v1/desktop/capabilities');
      await reply({ status: 200, body: capability() });
      if (skin === 'heijiao') await frame.locator('.hj-nav-handle').hover();
      const opener = skin === 'qingfeng' ? '.qf-settings-btn' : skin === 'liunian' ? '.ln-nav-item[data-ln-view="settings"]' : '.rail-item[data-view="settings"]';
      const entry = opener;
      await frame.locator(entry).click();
      await frame.waitForFunction(() => !document.getElementById('dbx-desktop-refresh').disabled);
      assert.equal(await count('v1/desktop/capabilities'), before + 1, skin + ' real settings opening detects exactly once');
      const lyricNav = frame.locator('.skset-link[data-skset-key="lyrics"], .qf-set-link[data-qf-key="lyrics"], .ln-set-link[data-ln-key="lyrics"]');
      await lyricNav.click();
      assert.equal(await frame.locator('#dbx-desktop-settings').isVisible(), true, skin + ' unified section visible');
      assert.equal(await count('v1/desktop/connect'), 0, 'opening settings never grants consent');
      await page.screenshot({ path: path.join(output, skin + '.png'), animations: 'disabled' });
      await closeSheet();
      if (skin === 'heijiao') await frame.locator('.hj-nav-handle').hover();
      await frame.locator(entry).click();
      await frame.waitForFunction(() => !document.getElementById('dbx-desktop-refresh').disabled);
      assert.equal(await count('v1/desktop/capabilities'), before + 2, skin + ' close and reopen detects again');
      await closeSheet();
      if (skin === 'liunian') {
        const captureBefore = await count('v1/desktop/capabilities');
        await frame.locator('#settings-entry').click();
        await frame.waitForFunction(() => !document.getElementById('dbx-desktop-refresh').disabled);
        assert.equal(await count('v1/desktop/capabilities'), captureBefore + 1, 'liunian captured topbar entry detects once');
        await closeSheet();
      }
      const barBefore = await count('v1/desktop/capabilities');
      await frame.locator('#bar-desktop-settings').click();
      await frame.waitForFunction(() => document.activeElement.id === 'dbx-desktop-settings');
      assert.equal(await frame.locator('#dbx-desktop-settings').isVisible(), true, skin + ' desktop bar opens and focuses section');
      assert.equal(await count('v1/desktop/capabilities'), barBefore + 1, skin + ' desktop bar and settings event coalesce');
      assert.equal(await count('v1/desktop/connect'), 0, 'desktop bar does not authorize');
      await page.screenshot({ path: path.join(output, skin + '-desktop.png'), animations: 'disabled' });
      console.log('PASS skin openings/reopen/bar:', skin);
      await closeSheet();
    }
    // Flow/state fixtures below use the same fully loaded app and actual sandbox buttons.
    await frame.evaluate(() => Skins.apply('classic'));
    await reply({ status: 200, body: capability() });
    await frame.locator('#bar-desktop-settings').click();
    await frame.waitForFunction(() => document.activeElement.id === 'dbx-desktop-settings');
    await detect(capability({ supported: false, reason: 'unsupported-target', component: { state: 'unknown', origin: null, error: null }, managementReady: false }));
    assert.match(await text(), /不支持 ARM64/);
    assert.equal(await frame.locator('#dbx-desktop-connect').isDisabled(), true);
    await reply({ status: 404, body: { error: { code: 'not_found', message: 'missing endpoint' } } });
    await frame.locator('#dbx-desktop-refresh').click();
    await frame.waitForFunction(() => !document.getElementById('dbx-desktop-refresh').disabled);
    assert.match(await text(), /后端不支持桌面连接/);
    for (const [state, reason, expected] of [['missing', 'component-missing', /未找到桌面组件/], ['unknown', 'component-unknown', /无法确认组件是否安装/], ['incompatible', 'component-incompatible', /构建不匹配/], ['ready', 'start-required', /请先手动启动/]]) {
      await detect(capability({ component: { state, origin: state === 'ready' ? 'installed' : null, error: state === 'unknown' ? { code: 'desktop_access_denied', message: 'fixture read denied' } : null }, reason, managementReady: false }));
      assert.match(await text(), expected);
      assert.equal(await frame.locator('#dbx-desktop-connect').isDisabled(), true);
    }
    await frame.locator('.dbx-desktop-guide summary').click();
    await frame.locator('#dbx-desktop-copy-guide').click();
    assert.match(await frame.locator('#dbx-desktop-copy-result').innerText(), /已复制|已选中/);
    assert.equal(await frame.locator('#dbx-desktop-guide-url').innerText(), 'https://github.com/onceMisery/hertz-studio/blob/main/docs/desktop-component-install.md');
    assert.match(await text(), /%LOCALAPPDATA%\\Hertz\\Desktop\\bin\\/);
    assert.equal((await page.context().pages()).length, 1, 'guide does not require popup permission');
    await detect(capability());
    assert.match(await text(), /运行中组件/);
    assert.equal(await frame.locator('#dbx-desktop-connect').isEnabled(), true);
    // Partial business failure must reconcile consent before reporting the error.
    await reply({ status: 200, body: { ok: false, centerOpened: false, error: { code: 'desktop_timeout', message: 'fixture center timeout' }, capabilities: consent() } });
    await frame.locator('#dbx-desktop-connect').click();
    await frame.waitForFunction(() => !document.getElementById('dbx-desktop-open').hidden);
    assert.match(await text(), /授权修订\n7/);
    assert.match(await frame.locator('#dbx-desktop-result').innerText(), /fixture center timeout/);
    assert.equal(await frame.locator('#dbx-desktop-revoke').isEnabled(), true);
    await reply({ status: 200, body: { ok: false, centerOpened: true, error: { code: 'desktop_timeout', message: 'fixture final status timeout' }, capabilities: { ...consent(), managementReady: false } } });
    await frame.locator('#dbx-desktop-open').click();
    await frame.waitForFunction(() => /fixture final status timeout/.test(document.getElementById('dbx-desktop-result').textContent));
    assert.match(await frame.locator('#dbx-desktop-result').innerText(), /原生中心已打开，但本次连接未完成确认/);
    assert.equal(await frame.locator('#dbx-desktop-revoke').isEnabled(), true);
    await detect(consent({ scopes: ['lyrics'], gate: false, listenerReady: false, scopeErrors: [{ scope: 'wallpaper', error: { code: 'desktop_listener_failed', message: 'fixture listener failed' } }] }));
    assert.match(await text(), /fixture listener failed/);
    assert.match(await text(), /未就绪/);
    assert.equal(await frame.locator('#dbx-desktop-connect').isVisible(), true);
    await detect(consent());
    await reply({ status: 200, body: { ok: true, centerOpened: true, error: null, capabilities: consent() } });
    await frame.locator('#dbx-desktop-open').click();
    await frame.waitForFunction(() => !document.getElementById('dbx-desktop-open').disabled);
    assert.match(await frame.locator('#dbx-desktop-result').innerText(), /原生中心已打开/);
    assert.equal(await frame.locator('#dbx-desktop-result').getAttribute('data-error'), 'false', 'disabled surfaces/unconfirmed source are not connect failure');
    const live = { ...consent(), sourceConnected: true, sourceScopes: { lyrics: true, wallpaper: false } };
    await detect(live);
    assert.match(await text(), /本次检测已确认（\d/);
    assert.match(await text(), /壁纸 未确认/);
    const beforeIdle = (await requests()).length;
    await frame.waitForTimeout(3300);
    assert.equal((await requests()).length, beforeIdle, 'live proof does not create polling');
    assert.match(await text(), /此页不自动刷新/);
    await detect(consent());
    assert.doesNotMatch(await frame.locator('#dbx-desktop-facts').innerText(), /本次检测已确认（/);

    // Revoke wins over late connect and refresh, and repeated click stays local.
    await frame.evaluate(() => { fixture.hold = 'v1/desktop/connect'; });
    const connectCount = await count('v1/desktop/connect');
    await frame.locator('#dbx-desktop-open').dblclick();
    assert.equal(await count('v1/desktop/connect'), connectCount + 1);
    assert.equal(await frame.locator('#dbx-desktop-revoke').isEnabled(), true);
    await reply({ status: 200, body: { ok: true, centerOpened: false, error: null, capabilities: revoked() } });
    await frame.locator('#dbx-desktop-revoke').click();
    await frame.waitForFunction(() => /授权已撤销/.test(document.getElementById('dbx-desktop-result').textContent));
    await frame.evaluate(caps => { fixture.hold = ''; fixture.held['v1/desktop/connect']({ status: 200, body: { ok: true, centerOpened: true, error: null, capabilities: caps } }); }, live);
    await frame.waitForTimeout(100);
    assert.match(await frame.locator('#dbx-desktop-result').innerText(), /授权已撤销/);
    assert.match(await frame.locator('#dbx-desktop-facts').innerText(), /当前数据通道\n已关闭/);
    assert.doesNotMatch(await text(), /本次检测已确认（/);
    await detect(consent());
    await frame.evaluate(() => { fixture.hold = 'v1/desktop/capabilities'; });
    await frame.locator('#dbx-desktop-refresh').click();
    await reply({ status: 200, body: { ok: true, centerOpened: false, error: null, capabilities: revoked() } });
    await frame.locator('#dbx-desktop-revoke').click();
    await frame.waitForFunction(() => /授权已撤销/.test(document.getElementById('dbx-desktop-result').textContent));
    await frame.evaluate(caps => { fixture.hold = ''; fixture.held['v1/desktop/capabilities']({ status: 200, body: caps }); }, live);
    await frame.waitForTimeout(100);
    assert.match(await frame.locator('#dbx-desktop-result').innerText(), /授权已撤销/);

    await detect(consent());
    await reply({ status: 503, body: { error: { code: 'desktop_unavailable', message: 'fixture transport failed' } } });
    await frame.locator('#dbx-desktop-open').click();
    await frame.waitForFunction(() => /fixture transport failed/.test(document.getElementById('dbx-desktop-result').textContent));
    assert.match(await frame.locator('#dbx-desktop-facts').innerText(), /本次操作未确认/);
    assert.equal(await frame.locator('#dbx-desktop-revoke').isEnabled(), true, 'unknown connect outcome remains revocable');
    await frame.locator('#dbx-desktop-revoke').click();
    await frame.waitForFunction(() => /未能确认撤销结果/.test(document.getElementById('dbx-desktop-result').textContent));
    assert.equal(await frame.locator('#dbx-desktop-revoke').isEnabled(), true, 'unknown revoke outcome remains retryable');

    await detect(consent());
    await reply({ status: 200, body: { ok: false, centerOpened: false, error: { code: 'desktop_revocation_incomplete', message: 'fixture persistence failure' }, capabilities: revoked({ persistentRevoked: false, scopes: ['lyrics', 'wallpaper'], revision: 7 }) } });
    await frame.locator('#dbx-desktop-revoke').click();
    await frame.waitForFunction(() => /重启可能恢复/.test(document.getElementById('dbx-desktop-result').textContent));
    assert.equal(await frame.locator('#dbx-desktop-revoke').isEnabled(), true);
    await reply({ status: 200, body: { ok: true, centerOpened: false, error: null, capabilities: revoked({ cleanupIncomplete: true }) } });
    await frame.locator('#dbx-desktop-revoke').click();
    await frame.waitForFunction(() => /授权已撤销；部分授权文件清理/.test(document.getElementById('dbx-desktop-result').textContent));
    assert.equal(await frame.locator('#dbx-desktop-revoke').innerText(), '重试撤销与清理');
    await page.setViewportSize({ width: 560, height: 850 });
    await frame.locator('#dbx-desktop-settings').scrollIntoViewIfNeeded();
    assert.ok(await frame.locator('#dbx-desktop-settings').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'section fits narrow settings pane');
    await page.screenshot({ path: path.join(output, 'cleanup-narrow.png'), animations: 'disabled' });
    await frame.locator('.dbx-desktop-guide summary').click();
    await frame.locator('#dbx-desktop-settings').evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.screenshot({ path: path.join(output, 'cleanup-narrow-top.png'), animations: 'disabled' });
    for (const request of await requests()) {
      if (request.method === 'v1/desktop/capabilities') assert.deepEqual(request.params, { op: 'GET', query: { refresh: 'true' } });
      if (request.method === 'v1/desktop/connect') assert.deepEqual(request.params, { op: 'POST', query: {}, body: { tab: 'runtime' } });
      if (request.method === 'v1/desktop/disconnect') assert.deepEqual(request.params, { op: 'POST', query: {}, body: {} });
    }
    assert.deepEqual(errors, [], 'no uncaught errors in actual shipped app');
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ skins, sandbox: 'allow-scripts', requests: await requests(), errors }, null, 2));
    await checkStandalone(browser);
    console.log('PASS DBX desktop settings: opaque sandbox, all 5 skins real openings/reopen/bar focus, explicit consent, component/auth/source states, partial failures, revoke races, no startup/polling, guide fallback and narrow layout.');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
