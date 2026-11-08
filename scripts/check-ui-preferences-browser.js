// SPDX-License-Identifier: MIT
// Real HTTP origins + real allow-scripts-only DBX iframe. No backend build required.
// Stage/recording and native download receipts below are controlled UI failure
// boundaries, not native OS file-dialog or real stage-persistence acceptance.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createStageApi, checkLatePersistence, checkWorkshop } = require('./ui-preference-persistence-browser-fixture');
const root = path.resolve(__dirname, '..');
const ui = path.join(root, 'plugin/ui');
const output = path.join(root, 'output/playwright');
const read = name => fs.readFileSync(path.join(ui, name), 'utf8');
const index = read('index.html');
const app = read('app.js');
const slice = (source, first, last) => {
  const start = source.indexOf(first), end = source.indexOf(last, start);
  assert.ok(start >= 0 && end > start, `production fixture anchors: ${first}`);
  return source.slice(start, end);
};
const settingId = index.indexOf('id="ui-preferences-setting"');
assert.ok(settingId >= 0, 'production preference setting exists');
const settingStart = index.lastIndexOf('<', settingId);
const groupStart = index.lastIndexOf('      <div class="set-group">', settingStart);
const groupEnd = index.indexOf('\n      </div>', settingStart);
assert.ok(groupStart >= 0 && groupEnd > settingStart, 'production backup/preference settings group');
const setting = index.slice(groupStart, groupEnd) + '\n      </div>';
const dialog = slice(index, '<dialog id="ui-preferences-dialog"', '</dialog>') + '</dialog>';
// Keep app owner choices/constants/validation in the production source. A
// changed application contract changes this fixture without a copied validator.
const views = slice(app, '  views: {', '\n  },') + '\n  },';
const constants = ['DEFAULT_VIEW_KEY', 'PL_VIEW_KEY', 'PL_VIEW_V2_KEY'].map(name => {
  const found = app.match(new RegExp(`const ${name} = [^;]+;`));
  assert.ok(found, `production owner constant ${name}`);
  return found[0];
}).join('\n');
const bindings = slice(app, '  if (window.UiPreferences && window.UiPreferenceSettings) {', '\n  if (ui.backupExport)');
assert.ok(bindings.includes('defaultViewTransfer(value)') && bindings.includes('playlistTransfer(value)'));
const css = ['design/design-base.css', 'fonts/brand.css', 'components/button.css', 'components/form.css',
  'style.css', 'skins/skin.hertz.css', 'ui-preferences.css'];
const modules = ['host.js', 'design/design-themes.js', 'themes.js', 'skins/skins.js', 'theme-studio.js',
  'stage-control.js', 'ui-preferences.js', 'ui-preference-settings.js'];
const secret = 'synthetic-never-a-real-credential';

const portable = {
  'vmusic.theme.v2': 'celestial',
  'vmusic.theme.custom.v1': { bg: '#111218', accent: '#bbaaff', accent2: '#76aadd' },
  'vmusic.skin': 'hertz', 'vmusic.defaultView': 'reader', 'vmusic.playlists.mode': 'list',
  'vmusic.daily.mode': 'local', 'vmusic.daily.collapsed': true,
  'vmusic.dailyview.layout': 'card', 'vmusic.dailyview.mode': 'local',
  'hertz-reader-preferences': { size: 21, font: 'serif', theme: 'dark' },
  'vmusic.stage.mode': 'scatter',
  'vmusic.stage.control': { stagePreset: 'venue', bokeh: 5, fluidEnabled: true },
  'vmusic.qf-wall': true, 'vmusic.qf-wall-follow': false,
  'vmusic.qf-wall-vignette': true, 'vmusic.qf-wall-tint': true,
  'vmusic.qf-wall-tint-color': '#aabbcc', 'vmusic.qf-wall-tint-intensity': 43,
};
const expectedMarkers = {
  'vmusic.theme.mineral-default': '1', 'vmusic.skin.default': 'hertz',
  'vmusic.playlists.viewV2': '1', 'vmusic.stage.control.v': '2',
};
const documentOf = values => ({ kind: 'hertz-ui-preferences', schemaVersion: 1,
  preferences: Object.entries(values).map(([key, value]) => ({ key, schemaVersion: 1, value })) });
const seed = {
  ...Object.fromEntries(Object.entries(portable).map(([key, value]) => [key,
    typeof value === 'object' ? JSON.stringify(value) : typeof value === 'boolean' ? (value ? '1' : '0') : String(value)])),
  ...expectedMarkers,
  'vmusic.token': secret, 'online.account': secret, 'room.history': secret,
  'vmusic.search.history': secret, 'online.cache': secret, 'obs.media': secret,
  'vmusic.creative.library': secret, 'vmusic.creative.current': secret,
  'vmusic.native.window': secret, 'vmusic.capsule': secret,
  'vmusic.timer.deadline': secret, 'vmusic.theme.wallpaper.v1': secret,
};
const oldSeed = { 'vmusic.theme.v2': 'hertz-dark', 'vmusic.skin': 'hertz', ...expectedMarkers,
  'vmusic.defaultView': 'home', 'vmusic.playlists.mode': 'shelf',
  'vmusic.daily.mode': '<img src=x onerror="window.previewInjected=1">', 'unrelated.preference': 'keep-me',
  'vmusic.token': secret };

function runtime(options) {
  const state = window.fixture = {
    stageLog: [], writes: [], holds: {}, recording: false, persistenceHydrated: true,
    failures: {}, failKey: '', failCount: 0, restoredView: null, ready: false,
    hold(name) { this.holds[name] = {}; this.holds[name].promise = new Promise((resolve, reject) => Object.assign(this.holds[name], { resolve, reject })); },
    release(name, error) { const gate = this.holds[name]; delete this.holds[name]; if (gate) error ? gate.reject(new Error(error)) : gate.resolve(); },
    async boundary(name) {
      this.stageLog.push(name);
      if (this.holds[name]) await this.holds[name].promise;
      if (this.failures[name]) throw new Error(this.failures[name]);
    },
  };
  // UI admission boundaries are deliberately independent of production stage
  // internals; native/DBX storage remains the actual production host owner.
  window.CreativeStage = {
    hydrated: () => state.boundary('hydrate'),
    flushPersistence: () => state.boundary('current'),
    flushLibrary: () => state.boundary('library'),
  };
  window.StagePersistence = { status: () => ({ hydrated: state.persistenceHydrated }) };
  window.VideoExport = { isRecording: () => state.recording };
  if (options.dbx) {
    let sequence = 0;
    const pending = new Map();
    const rpc = (method, args) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject });
      parent.postMessage({ channel: 'ui-preferences-fixture', id, method, args }, '*');
    });
    window.addEventListener('message', event => {
      if (event.source !== parent || event.data?.channel !== 'ui-preferences-fixture-reply') return;
      const job = pending.get(event.data.id); if (!job) return;
      pending.delete(event.data.id);
      event.data.error ? job.reject(new Error(event.data.error)) : job.resolve(event.data.value);
    });
    window.dbxPlugin = { ready: Promise.resolve(), context: { surface: 'tab' },
      storage: { get: key => rpc('get', { key }), set: (key, value) => rpc('set', { key, value }) },
      saveFile: (meta, bytes) => rpc('saveFile', { meta, bytes: Array.from(bytes) }) };
  } else {
    const originalSet = Storage.prototype.setItem;
    const originalRemove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage) {
        state.writes.push({ key, value: String(value) });
        if (state.failKey === key && state.failCount > 0) { state.failCount--; throw new DOMException('fixture storage write failure', 'QuotaExceededError'); }
      }
      return originalSet.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      if (this === localStorage) state.writes.push({ key, value: null });
      return originalRemove.call(this, key);
    };
    if (options.native) {
      window.__hertzWindowHost = { downloadVersion: 1, async saveTextFile(fileName, contentType, text) {
        state.download = { fileName, contentType, text };
        await state.boundary('nativeSave');
        return state.receipt || { status: 'saved' };
      } };
    }
  }
}

function parentRuntime(initial) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const fixture = window.dbxFixture = { snapshot: clone(initial), requests: [], loads: 0, held: {},
    hold: {}, failures: {}, files: [], activeWrites: 0, maxActiveWrites: 0,
    release(method, error) {
      this.hold[method] = false;
      const jobs = this.held[method] || []; delete this.held[method];
      jobs.forEach(job => error ? job.reject(new Error(error)) : job.resolve());
    },
  };
  const iframe = document.getElementById('dbx-frame');
  iframe.addEventListener('load', () => fixture.loads++);
  window.addEventListener('message', async event => {
    const data = event.data;
    if (event.source !== iframe.contentWindow || data?.channel !== 'ui-preferences-fixture') return;
    fixture.requests.push(clone({ method: data.method, args: data.args }));
    try {
      if (data.method === 'set') {
        fixture.activeWrites++;
        fixture.maxActiveWrites = Math.max(fixture.maxActiveWrites, fixture.activeWrites);
      }
      if (fixture.hold[data.method]) await new Promise((resolve, reject) => {
        (fixture.held[data.method] ||= []).push({ resolve, reject });
      });
      if (fixture.failures[data.method] > 0) {
        fixture.failures[data.method]--;
        throw new Error('fixture DBX ' + data.method + ' failure');
      }
      let value;
      if (data.method === 'get') value = clone(fixture.snapshot);
      else if (data.method === 'set') fixture.snapshot = clone(data.args.value);
      else if (data.method === 'saveFile') fixture.files.push(clone(data.args));
      else throw new Error('unexpected SDK request');
      event.source.postMessage({ channel: 'ui-preferences-fixture-reply', id: data.id, value }, '*');
    } catch (error) {
      event.source.postMessage({ channel: 'ui-preferences-fixture-reply', id: data.id, error: error.message }, '*');
    } finally { if (data.method === 'set') fixture.activeWrites--; }
  });
}

const html = options => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Hertz UI preference fixture</title>
${css.map(name => `<link rel="stylesheet" href="/assets/${name}"${name.includes('skin.hertz') ? ' data-skin-css="hertz"' : ''}>`).join('\n')}
<script>(${runtime.toString()})(${JSON.stringify(options)});</script></head><body class="hz-sidebar-hidden">
<main class="app"><nav id="rail"></nav><div class="hz-workspace"><section class="column" id="column"><div id="view-settings" class="view">${setting}</div></section></div></main>
${dialog}${modules.map(name => `<script src="/assets/${name}"></script>`).join('\n')}
<script>const $ = id => document.getElementById(id); const ui = {${views}}; ${constants}
(async () => { await hertzHost.hydrate(); Theme.init(); ThemeStudio.initPalette(); Skins.init(); StageControl.init();
${bindings}
fixture.restoredView = localStorage.getItem(DEFAULT_VIEW_KEY); fixture.ready = true;
})();</script></body></html>`;

async function startServer() {
  const cases = new Map();
  const stage = createStageApi();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture');
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (stage.handle(request, response, url)) return;
    if (url.pathname === '/preference.html') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html({ dbx: url.searchParams.has('dbx'), native: url.searchParams.has('native') }));
    } else if (url.pathname.startsWith('/host/')) {
      const config = cases.get(url.pathname); if (!config) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      // The child genuinely has an opaque origin: no allow-same-origin,
      // allow-downloads or allow-forms permissions are added to the iframe.
      response.end(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><iframe id="dbx-frame" sandbox="allow-scripts" style="border:0;width:100vw;height:100vh"></iframe>
<script>(${parentRuntime.toString()})(${JSON.stringify(config.seed)}); Object.assign(dbxFixture.hold,${JSON.stringify(config.hold || {})});Object.assign(dbxFixture.failures,${JSON.stringify(config.failures || {})});document.getElementById('dbx-frame').src='/preference.html?dbx=1';</script></body></html>`);
    } else if (url.pathname.startsWith('/assets/')) {
      const filename = path.resolve(ui, '.' + url.pathname.slice('/assets'.length));
      if (!filename.startsWith(ui + path.sep) || !fs.existsSync(filename)) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', filename.endsWith('.js') ? 'application/javascript; charset=utf-8'
        : filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream');
      response.end(fs.readFileSync(filename));
    } else response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, cases, stage,
    close: () => new Promise(resolve => server.close(resolve)) };
}

async function storage(frame) {
  return frame.evaluate(() => Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => {
    const key = localStorage.key(i); return [key, localStorage.getItem(key)];
  })));
}
async function ready(frame) { await frame.waitForFunction(() => window.fixture?.ready === true); }
async function render(frame) { await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function upload(frame, text) {
  await frame.locator('#ui-preferences-file').setInputFiles({ name: 'preferences.json', mimeType: 'application/json', buffer: Buffer.from(text) });
}
async function preview(frame, text) {
  await upload(frame, text);
  await frame.locator('#ui-preferences-dialog').waitFor({ state: 'visible' });
  await frame.waitForFunction(() => !document.getElementById('ui-preferences-apply').disabled);
}
async function cancel(frame, escape = false) {
  escape ? await frame.locator('#ui-preferences-cancel').press('Escape') : await frame.locator('#ui-preferences-cancel').click();
  await frame.locator('#ui-preferences-dialog').waitFor({ state: 'hidden' });
  await frame.waitForFunction(() => document.activeElement?.id === 'ui-preferences-import');
  assert.equal(await frame.evaluate(() => document.activeElement?.id), 'ui-preferences-import', 'cancel restores import-button focus');
}
async function idle(frame) { await frame.waitForFunction(() => !document.getElementById('ui-preferences-export').disabled); }
async function noReload(frame, token) { assert.equal(await frame.evaluate(() => fixture.instance), token, 'failure/wait must retain the current document'); }
async function mark(frame) {
  const token = Math.random().toString(36);
  await frame.evaluate(token => { fixture.instance = token; }, token); return token;
}
async function nativePage(context, server, initial, native = false) {
  const page = await context.newPage();
  await page.addInitScript(initial => {
    if (sessionStorage.getItem('preference-fixture-seeded') !== '1') {
      localStorage.clear(); Object.entries(initial).forEach(([key, value]) => localStorage.setItem(key, value));
      sessionStorage.setItem('preference-fixture-seeded', '1');
    }
  }, initial);
  await page.goto(server.base + '/preference.html' + (native ? '?native=1' : ''));
  await ready(page); return page;
}
async function dbxPage(context, server, name, config = {}) {
  server.cases.set('/host/' + name, { seed: oldSeed, ...config });
  const page = await context.newPage(); await page.goto(server.base + '/host/' + name);
  const iframe = await page.waitForSelector('#dbx-frame'); const frame = await iframe.contentFrame();
  assert.ok(frame); await frame.waitForFunction(() => !!window.hertzHost);
  assert.equal(await frame.evaluate(() => self.origin), 'null', 'DBX iframe has a real opaque origin');
  assert.equal(await page.locator('#dbx-frame').getAttribute('sandbox'), 'allow-scripts');
  return { page, frame };
}

async function checkOrigins(context, a, b, report) {
  const source = await nativePage(context, a, seed);
  const destination = await nativePage(context, b, oldSeed);
  try {
    assert.notEqual(new URL(source.url()).origin, new URL(destination.url()).origin);
    const sourceBefore = await storage(source);
    const download = source.waitForEvent('download');
    await source.locator('#ui-preferences-export').click();
    const file = await download;
    assert.equal(file.suggestedFilename(), 'hertz-ui-preferences.json');
    const exportPath = path.join(output, 'ui-preferences-export.json'); await file.saveAs(exportPath);
    const text = fs.readFileSync(exportPath, 'utf8'), exported = JSON.parse(text);
    assert.deepEqual(exported, documentOf(portable));
    assert.equal(exported.preferences.length, 18);
    assert.ok(!text.includes(secret));
    assert.ok(exported.preferences.every(item => !Object.hasOwn(expectedMarkers, item.key)), 'markers cannot be supplied by the file');
    assert.deepEqual(await storage(source), sourceBefore, 'export does not modify storage');
    assert.match(await source.locator('#ui-preferences-status').innerText(), /已发起.*宿主/);
    const before = await storage(destination), token = await mark(destination);
    await preview(destination, text);
    assert.equal(await destination.locator('#ui-preferences-rows tr').count(), 18);
    assert.ok((await destination.locator('#ui-preferences-rows').innerText()).includes(oldSeed['vmusic.daily.mode']));
    assert.equal(await destination.locator('#ui-preferences-rows img').count(), 0);
    assert.equal(await destination.evaluate(() => window.previewInjected), undefined, 'current values use literal textContent');
    assert.deepEqual(await storage(destination), before, 'preview does not modify preference files/storage');
    assert.deepEqual(await destination.evaluate(() => fixture.stageLog), []);
    for (const width of [1440, 720, 360]) {
      await destination.setViewportSize({ width, height: 960 }); await render(destination);
      const screenshot = path.join(output, `ui-preferences-preview-${width}.png`);
      await destination.screenshot({ path: screenshot });
      const geometry = await destination.locator('#ui-preferences-dialog').evaluate(element => {
        const rect = element.getBoundingClientRect();
        const buttons = ['ui-preferences-cancel', 'ui-preferences-apply'].map(id => {
          const node = document.getElementById(id), box = node.getBoundingClientRect();
          return { id, left: box.left, right: box.right, bottom: box.bottom, text: node.textContent.trim() };
        });
        const table = document.querySelector('.ui-preference-table-wrap');
        return { left: rect.left, right: rect.right, width: innerWidth, client: element.clientWidth,
          scroll: element.scrollWidth, tableClient: table.clientWidth, tableScroll: table.scrollWidth,
          documentClient: document.documentElement.clientWidth, documentScroll: document.documentElement.scrollWidth, buttons };
      });
      assert.ok(geometry.left >= 0 && geometry.right <= width + 1, 'preview dialog fits the viewport');
      assert.ok(geometry.scroll <= geometry.client + 1, 'only the table wrapper may scroll horizontally');
      assert.ok(geometry.buttons.every(button => button.left >= geometry.left && button.right <= geometry.right + 1));
      assert.ok(geometry.documentScroll <= geometry.documentClient + 1, 'page does not overflow horizontally');
      if (width <= 600) assert.ok(geometry.tableScroll <= geometry.tableClient + 1, 'narrow preview values stack without horizontal overflow');
      const typography = await destination.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const rgba = value => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data, n => n / 255); };
        const over = (foreground, background) => foreground.slice(0, 3).map((n, i) => n * foreground[3] + background[i] * (1 - foreground[3])).concat(1);
        const luminance = color => color.slice(0, 3).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
        const background = node => {
          const base = node.parentElement ? background(node.parentElement) : [0, 0, 0, 1];
          return over(rgba(getComputedStyle(node).backgroundColor), base);
        };
        return ['#ui-preferences-setting-title', '.ui-preference-setting-copy .hint', '.ui-preference-setting-footnote',
          '#ui-preferences-title', '#ui-preferences-description', '#ui-preferences-rows pre', '#ui-preferences-cancel', '#ui-preferences-apply'].map(selector => {
          const node = document.querySelector(selector), style = getComputedStyle(node), bg = background(node);
          const fg = over(rgba(style.color), bg), light = luminance(fg), dark = luminance(bg);
          return { selector, fontSize: parseFloat(style.fontSize), lineHeight: style.lineHeight, color: style.color,
            background: bg, contrast: (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05) };
        });
      });
      assert.ok(typography.every(item => item.contrast >= 4.5), 'normal preference text meets 4.5:1 contrast');
      assert.ok(typography.find(item => item.selector === '#ui-preferences-description').fontSize >= 14);
      assert.ok(typography.find(item => item.selector === '#ui-preferences-rows pre').fontSize >= 13);
      assert.ok(typography.filter(item => /cancel|apply/.test(item.selector)).every(item => item.fontSize >= 13));
      report.screenshots.push({ path: screenshot, geometry, typography });
    }
    await cancel(destination);
    assert.deepEqual(await storage(destination), before); await noReload(destination, token);
    for (const width of [1440, 720, 360]) {
      await destination.setViewportSize({ width, height: 960 }); await render(destination);
      const screenshot = path.join(output, `ui-preferences-setting-${width}.png`);
      await destination.screenshot({ path: screenshot });
      const geometry = await destination.locator('#ui-preferences-setting').evaluate(element => {
        const box = element.getBoundingClientRect();
        const column = document.getElementById('column');
        return { left: box.left, right: box.right, client: element.clientWidth, scroll: element.scrollWidth,
          columnClient: column.clientWidth, columnScroll: column.scrollWidth,
          buttons: Array.from(element.querySelectorAll('button'), button => {
            const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right, height: rect.height };
          }) };
      });
      assert.ok(geometry.left >= 0 && geometry.right <= width + 1);
      assert.ok(geometry.scroll <= geometry.client + 1 && geometry.columnScroll <= geometry.columnClient + 1);
      assert.ok(geometry.buttons.every(button => button.left >= geometry.left && button.right <= geometry.right + 1));
      report.screenshots.push({ path: screenshot, geometry });
    }
    await preview(destination, text); await cancel(destination, true);
    assert.deepEqual(await storage(destination), before);
    await destination.setViewportSize({ width: 1440, height: 960 });
    await preview(destination, text);
    const reload = destination.waitForEvent('framenavigated', { predicate: frame => frame === destination.mainFrame() });
    await destination.locator('#ui-preferences-apply').click(); await reload; await ready(destination);
    const saved = await storage(destination);
    for (const [key, value] of Object.entries(seed)) {
      if (Object.hasOwn(portable, key) || Object.hasOwn(expectedMarkers, key)) assert.equal(saved[key], value, key);
    }
    assert.equal(saved['unrelated.preference'], 'keep-me');
    assert.equal(saved['vmusic.token'], secret);
    assert.equal(await destination.evaluate(() => Theme.current().id), 'celestial', 'owner marker prevents old-default theme migration');
    assert.equal(await destination.evaluate(() => Skins.currentId()), 'hertz');
    assert.equal(await destination.evaluate(() => fixture.restoredView), 'reader');
    assert.equal(await destination.evaluate(() => StageControl.values().bokeh), 5);
    assert.equal(await destination.evaluate(() => StageControl.values().fluidEnabled), true);
    report.checks.push('two actual HTTP origins: download, 18-item preview/cancel, literal text, apply/reload and owner markers');
    return text;
  } finally { await source.close(); await destination.close(); }
}

async function checkRejectedDocuments(context, server, text, report) {
  const page = await nativePage(context, server, oldSeed);
  try {
    const original = JSON.parse(text);
    const changed = mutate => { const copy = structuredClone(original); mutate(copy); return JSON.stringify(copy); };
    const inputs = [
      ['unknown kind', changed(value => { value.kind = 'hertz-backup'; })],
      ['unknown document version', changed(value => { value.schemaVersion = 999; })],
      ['unknown key', changed(value => { value.preferences[0].key = 'vmusic.token'; })],
      ['owner marker', changed(value => { value.preferences[0].key = 'vmusic.skin.default'; })],
      ['unknown item version', changed(value => { value.preferences[0].schemaVersion = 2; })],
      ['duplicate', changed(value => { value.preferences.push(value.preferences[0]); })],
      ['33 items', changed(value => { value.preferences = Array(33).fill(value.preferences[0]); })],
      ['boolean coercion', changed(value => { value.preferences.find(item => item.key === 'vmusic.qf-wall').value = '1'; })],
      ['stage unknown key', changed(value => { value.preferences.find(item => item.key === 'vmusic.stage.control').value.evil = true; })],
      ['stage wrong type', changed(value => { value.preferences.find(item => item.key === 'vmusic.stage.control').value.bokeh = '5'; })],
      ['reader out of range', changed(value => { value.preferences.find(item => item.key === 'hertz-reader-preferences').value.size = 24; })],
      ['custom light background', changed(value => { value.preferences.find(item => item.key === 'vmusic.theme.custom.v1').value.bg = '#ffffff'; })],
      ['prototype', text.replace('"kind":', '"__proto__":{"polluted":true},"kind":')],
      ['constructor', text.replace('"kind":', '"constructor":{"polluted":true},"kind":')],
      ['over 64 KiB', text + ' '.repeat(65537)],
      ['invalid JSON', '{'],
      ['empty document', JSON.stringify(documentOf({}))],
    ];
    const before = await storage(page), token = await mark(page);
    for (const [name, invalid] of inputs) {
      await upload(page, invalid); await idle(page);
      assert.match(await page.locator('#ui-preferences-status').innerText(), /偏好导入失败/, name);
      assert.equal(await page.locator('#ui-preferences-dialog').isVisible(), false, name);
      assert.deepEqual(await storage(page), before, `${name} has no writes`); await noReload(page, token);
    }
    assert.equal(await page.evaluate(() => Object.prototype.polluted), undefined);
    assert.deepEqual(await page.evaluate(() => fixture.stageLog), []);
    const tampered = await page.evaluate(text => {
      const parsed = UiPreferences.parse(text);
      parsed.entries[0].storageValue = 'credential'; parsed.entries.push({ key: 'vmusic.token', storageValue: 'injected' });
      const planned = UiPreferences.writes(parsed);
      parsed.document.preferences[0].key = 'vmusic.token';
      let rejected = false; try { UiPreferences.writes(parsed); } catch (_) { rejected = true; }
      return { planned, rejected };
    }, text);
    assert.ok(tampered.rejected && !tampered.planned.some(entry => entry.key === 'vmusic.token'));
    report.checks.push(`${inputs.length} hostile/unsupported files rejected without writes; preview fields are never trusted for writes`);
  } finally { await page.close(); }
}

async function checkCustomPalette(context, a, b, report) {
  const source = await nativePage(context, a, seed);
  const destination = await nativePage(context, b, { ...oldSeed, 'vmusic.daily.mode': 'online' });
  const luminance = hex => {
    const rgb = hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    return rgb.reduce((sum, channel, i) => sum + channel * [.2126, .7152, .0722][i], 0);
  };
  try {
    const produced = await source.evaluate(() => {
      const result = ThemeStudio.applyCustom({ bg: '#5e2982', accent: '#bbaaff', accent2: '#76aadd' });
      return { result, saved: JSON.parse(localStorage.getItem('vmusic.theme.custom.v1')), id: ThemeStudio.customThemeId() };
    });
    assert.equal(produced.result.clamped, true);
    assert.ok(luminance(produced.saved.bg) <= .04, 'real applyCustom producer keeps final RGB bytes within the dark-background cap');
    for (const variant of ['produced', 'legacy']) {
      if (variant === 'legacy') {
        await source.evaluate(() => {
          localStorage.setItem('vmusic.theme.custom.v1', JSON.stringify({ bg: '#50236e', accent: '#bbaaff', accent2: '#76aadd' }));
        });
      }
      const before = await storage(source);
      const download = source.waitForEvent('download'); await source.locator('#ui-preferences-export').click();
      const file = await download, exportPath = path.join(output, `ui-preferences-custom-${variant}.json`);
      await file.saveAs(exportPath); await idle(source);
      const text = fs.readFileSync(exportPath, 'utf8');
      const checked = await source.evaluate(text => {
        const parsed = UiPreferences.parse(text);
        return { document: parsed.document, writes: UiPreferences.writes(parsed) };
      }, text);
      const colors = checked.document.preferences.find(entry => entry.key === 'vmusic.theme.custom.v1').value;
      assert.ok(luminance(colors.bg) <= .04, `${variant} portable colors meet the dark-background cap`);
      assert.equal(checked.writes.find(entry => entry.key === 'vmusic.theme.custom.v1').value, JSON.stringify(colors));
      assert.deepEqual(await storage(source), before, 'export/parse do not rewrite the source palette');
      if (variant === 'produced') assert.deepEqual(colors, produced.saved);
      else assert.notEqual(colors.bg, '#50236e', 'legacy half-byte rounding is normalized by the real color owner');
      await preview(destination, text);
      const reload = destination.waitForEvent('framenavigated', { predicate: frame => frame === destination.mainFrame() });
      await destination.locator('#ui-preferences-apply').click(); await reload; await ready(destination);
      assert.deepEqual(await destination.evaluate(() => JSON.parse(localStorage.getItem('vmusic.theme.custom.v1'))), colors);
      assert.equal(await destination.evaluate(() => Theme.current().id), produced.id, 'custom owner restores the palette after actual reload');
      assert.equal(await destination.evaluate(() => ThemeStudio.state.bg), colors.bg);
    }
    const token = await mark(destination), before = await storage(destination);
    await upload(destination, JSON.stringify(documentOf({ 'vmusic.theme.custom.v1': { bg: '#ffffff', accent: '#bbaaff', accent2: '#76aadd' } })));
    await idle(destination);
    assert.match(await destination.locator('#ui-preferences-status').innerText(), /偏好导入失败.*暗底亮度/);
    assert.deepEqual(await storage(destination), before); await noReload(destination, token);
    report.checks.push('real ThemeStudio.applyCustom quantized palette + legacy #50236e: browser export/parse/writes/import/reload normalize safely; #ffffff stays rejected');
  } finally { await source.close(); await destination.close(); }
}

async function checkUiBoundaries(context, server, text, report) {
  const page = await nativePage(context, server, { ...oldSeed, 'vmusic.daily.mode': 'online' }, true);
  try {
    for (const receipt of ['saved', 'cancelled']) {
      await page.evaluate(receipt => { fixture.stageLog = []; fixture.receipt = { status: receipt }; fixture.hold('nativeSave'); }, receipt);
      await page.locator('#ui-preferences-export').click();
      await page.waitForFunction(() => fixture.stageLog.includes('nativeSave'));
      assert.equal(await page.locator('#ui-preferences-export').isDisabled(), true);
      assert.ok(!(await page.locator('#ui-preferences-status').innerText()).includes('已保存'));
      await page.evaluate(() => fixture.release('nativeSave')); await idle(page);
      assert.match(await page.locator('#ui-preferences-status').innerText(), receipt === 'saved' ? /已保存/ : /已取消保存/);
    }
    await page.evaluate(() => { fixture.failures.nativeSave = '<img src=x onerror="window.failureInjected=1">'; });
    await page.locator('#ui-preferences-export').click(); await idle(page);
    assert.match(await page.locator('#ui-preferences-status').innerText(), /偏好导出失败.*<img/);
    assert.equal(await page.locator('#ui-preferences-status img').count(), 0);
    assert.equal(await page.evaluate(() => window.failureInjected), undefined);
    await page.evaluate(() => { delete fixture.failures.nativeSave; fixture.stageLog = []; });
    const before = await storage(page), token = await mark(page);
    for (const name of ['recording', 'hydrate', 'not-hydrated', 'current', 'library']) {
      await preview(page, text);
      await page.evaluate(name => {
        fixture.stageLog = []; fixture.recording = name === 'recording'; fixture.persistenceHydrated = name !== 'not-hydrated';
        fixture.failures = ['hydrate', 'current', 'library'].includes(name) ? { [name]: name + ' fixture failure' } : {};
      }, name);
      await page.locator('#ui-preferences-apply').click(); await idle(page);
      assert.match(await page.locator('#ui-preferences-dialog-status').innerText(), /应用失败/, name);
      assert.deepEqual(await storage(page), before, `${name} must not write preferences`); await noReload(page, token);
      const calls = await page.evaluate(() => fixture.stageLog);
      if (name === 'recording') assert.deepEqual(calls, []);
      if (name === 'current' || name === 'library') assert.deepEqual(calls, ['hydrate', 'current', 'library'], 'both stage saves settle');
      await cancel(page);
    }
    await page.evaluate(() => { fixture.recording = false; fixture.persistenceHydrated = true; fixture.failures = {}; fixture.stageLog = []; fixture.hold('hydrate'); });
    await preview(page, text); await page.locator('#ui-preferences-apply').click();
    await page.waitForFunction(() => fixture.stageLog.includes('hydrate'));
    assert.deepEqual(await storage(page), before); await noReload(page, token);
    assert.equal(await page.locator('#ui-preferences-cancel').isDisabled(), true);
    await page.locator('#ui-preferences-dialog').press('Escape');
    assert.equal(await page.locator('#ui-preferences-dialog').isVisible(), true, 'busy modal blocks Escape');
    await page.evaluate(() => { fixture.recording = true; fixture.release('hydrate'); }); await idle(page);
    assert.match(await page.locator('#ui-preferences-dialog-status').innerText(), /正在录制/);
    assert.deepEqual(await storage(page), before); await noReload(page, token); await cancel(page);
    // Real browser localStorage failure after a successful earlier write. The
    // injected failure targets Storage.prototype; actual previous values/removal
    // are still exercised by the production batch owner.
    await page.evaluate(() => { fixture.recording = false; fixture.failKey = 'vmusic.theme.custom.v1'; fixture.failCount = 1; });
    await preview(page, text); await page.locator('#ui-preferences-apply').click(); await idle(page);
    assert.match(await page.locator('#ui-preferences-dialog-status').innerText(), /应用失败.*storage write failure/);
    assert.deepEqual(await storage(page), before, 'native/browser batch failure restores earlier target keys'); await noReload(page, token);
    await cancel(page);
    // Also restore a newly added target by removing it, while a later target fails.
    const rollbackDocument = JSON.stringify(documentOf({ 'vmusic.qf-wall': true, 'vmusic.defaultView': 'reader' }));
    await page.evaluate(() => { fixture.failKey = 'vmusic.defaultView'; fixture.failCount = 1; });
    await preview(page, rollbackDocument); await page.locator('#ui-preferences-apply').click(); await idle(page);
    assert.deepEqual(await storage(page), before, 'rollback removes a target that did not exist before'); await noReload(page, token);
    report.checks.push('UI admission: recording/hydration/current/library failure and busy Escape; native save receipt delay/cancel/failure; real browser Storage rollback');
  } finally { await page.close(); }
}

async function checkDbx(context, server, text, report) {
  const delayed = await dbxPage(context, server, 'delayed', { hold: { get: true } });
  try {
    await delayed.page.waitForFunction(() => dbxFixture.requests.some(item => item.method === 'get'));
    await delayed.frame.locator('#ui-preferences-export').click();
    assert.equal(await delayed.frame.evaluate(() => document.getElementById('ui-preferences-export').onclick), null,
      'production app binding runs after host startup hydration');
    assert.equal(await delayed.page.evaluate(() => dbxFixture.files.length), 0, 'export waits for actual parent hydration');
    await delayed.page.evaluate(() => dbxFixture.release('get')); await ready(delayed.frame);
    // oldSeed deliberately contains an invalid current value, so export should
    // fail validation. Replace it with a known value and flush the real shim.
    await delayed.frame.locator('#ui-preferences-export').click(); await idle(delayed.frame);
    assert.match(await delayed.frame.locator('#ui-preferences-status').innerText(), /偏好导出失败/);
    await delayed.frame.evaluate(() => { localStorage.setItem('vmusic.daily.mode', 'online'); return hertzHost.flushStorage(); });
    await delayed.page.evaluate(() => { dbxFixture.hold.saveFile = true; });
    await delayed.frame.locator('#ui-preferences-export').click();
    await delayed.page.waitForFunction(() => dbxFixture.held.saveFile?.length === 1);
    assert.equal(await delayed.frame.locator('#ui-preferences-export').isDisabled(), true);
    assert.ok(!(await delayed.frame.locator('#ui-preferences-status').innerText()).includes('已保存'));
    await delayed.page.evaluate(() => dbxFixture.release('saveFile')); await idle(delayed.frame);
    assert.match(await delayed.frame.locator('#ui-preferences-status').innerText(), /已发起.*宿主/);
    const sdkFile = await delayed.page.evaluate(() => dbxFixture.files[0]);
    assert.equal(sdkFile.meta.fileName, 'hertz-ui-preferences.json');
    assert.equal(sdkFile.meta.contentType, 'application/json');
    assert.ok(!Buffer.from(sdkFile.bytes).toString('utf8').includes(secret));
    await delayed.page.evaluate(() => { dbxFixture.failures.saveFile = 1; });
    await delayed.frame.locator('#ui-preferences-export').click(); await idle(delayed.frame);
    assert.match(await delayed.frame.locator('#ui-preferences-status').innerText(), /偏好导出失败.*DBX saveFile failure/);
    const before = await storage(delayed.frame), token = await mark(delayed.frame);
    const parentBefore = await delayed.page.evaluate(() => dbxFixture.snapshot);
    await preview(delayed.frame, text); await cancel(delayed.frame);
    assert.deepEqual(await storage(delayed.frame), before);
    assert.deepEqual(await delayed.page.evaluate(() => dbxFixture.snapshot), parentBefore);
    // Delay hydration/current/library and then parent persistence independently.
    await delayed.frame.evaluate(() => { fixture.stageLog = []; fixture.hold('hydrate'); fixture.hold('current'); fixture.hold('library'); });
    await preview(delayed.frame, text); await delayed.frame.locator('#ui-preferences-apply').click();
    await delayed.frame.waitForFunction(() => fixture.stageLog.includes('hydrate'));
    await noReload(delayed.frame, token); assert.deepEqual(await storage(delayed.frame), before);
    await delayed.frame.evaluate(() => fixture.release('hydrate'));
    await delayed.frame.waitForFunction(() => fixture.stageLog.includes('library'));
    await delayed.frame.evaluate(() => fixture.release('current'));
    await noReload(delayed.frame, token); assert.deepEqual(await storage(delayed.frame), before);
    await delayed.page.evaluate(() => { dbxFixture.hold.set = true; });
    await delayed.frame.evaluate(() => fixture.release('library'));
    await delayed.page.waitForFunction(() => dbxFixture.held.set?.length === 1);
    await noReload(delayed.frame, token);
    assert.deepEqual(await delayed.page.evaluate(() => dbxFixture.snapshot), parentBefore, 'pending SDK write has not persisted');
    assert.equal(await delayed.frame.locator('#ui-preferences-apply').isDisabled(), true);
    const loads = await delayed.page.evaluate(() => dbxFixture.loads);
    await render(delayed.frame);
    assert.equal(await delayed.page.evaluate(() => dbxFixture.loads), loads, 'no iframe reload before asynchronous DBX write completion');
    await delayed.page.evaluate(() => dbxFixture.release('set'));
    await delayed.page.waitForFunction(old => dbxFixture.loads > old, loads); await ready(delayed.frame);
    const saved = await storage(delayed.frame), parentSaved = await delayed.page.evaluate(() => dbxFixture.snapshot);
    for (const [key, value] of Object.entries(seed)) if (Object.hasOwn(portable, key) || Object.hasOwn(expectedMarkers, key)) {
      assert.equal(saved[key], value, key); assert.equal(parentSaved[key], value, key);
    }
    assert.equal(await delayed.frame.evaluate(() => Theme.current().id), 'celestial');
    assert.equal(await delayed.frame.evaluate(() => StageControl.values().bokeh), 5);
    assert.equal(await delayed.page.evaluate(() => dbxFixture.maxActiveWrites), 1, 'SDK snapshots remain serialized');
    // A mutation during an in-flight snapshot must be persisted by a following
    // snapshot; overlapping writes cannot replace it with an older blob.
    await delayed.page.evaluate(() => { dbxFixture.hold.set = true; });
    await delayed.frame.evaluate(() => {
      localStorage.setItem('unrelated.preference', 'revision-one');
      fixture.flushOne = hertzHost.flushStorage();
    });
    await delayed.page.waitForFunction(() => dbxFixture.held.set?.length === 1);
    await delayed.frame.evaluate(() => { localStorage.setItem('unrelated.preference', 'revision-two'); fixture.flushTwo = hertzHost.flushStorage(); });
    await delayed.page.evaluate(() => dbxFixture.release('set'));
    await delayed.frame.evaluate(() => Promise.all([fixture.flushOne, fixture.flushTwo]));
    assert.equal(await delayed.page.evaluate(() => dbxFixture.snapshot['unrelated.preference']), 'revision-two');
    assert.equal(await delayed.page.evaluate(() => dbxFixture.maxActiveWrites), 1);
  } finally { await delayed.page.close(); }

  const failed = await dbxPage(context, server, 'failed-write'); await ready(failed.frame);
  try {
    const before = await storage(failed.frame), token = await mark(failed.frame);
    await preview(failed.frame, text);
    await failed.page.evaluate(() => { dbxFixture.hold.set = true; });
    await failed.frame.locator('#ui-preferences-apply').click();
    await failed.page.waitForFunction(() => dbxFixture.held.set?.length === 1);
    // A concurrent, unrelated producer must survive target-only rollback.
    await failed.frame.evaluate(() => {
      localStorage.setItem('unrelated.preference', 'newer-unrelated');
      localStorage.setItem('vmusic.defaultView', 'settings');
    });
    await failed.page.evaluate(() => dbxFixture.release('set', 'fixture DBX set failure'));
    await idle(failed.frame);
    assert.match(await failed.frame.locator('#ui-preferences-dialog-status').innerText(), /应用失败.*DBX set failure/);
    const expected = { ...before, 'unrelated.preference': 'newer-unrelated', 'vmusic.defaultView': 'settings' };
    assert.deepEqual(await storage(failed.frame), expected, 'DBX failure restores only target preferences');
    assert.deepEqual(await failed.page.evaluate(() => dbxFixture.snapshot), expected, 'rollback itself waits for parent acknowledgement');
    await noReload(failed.frame, token);
  } finally { await failed.page.close(); }

  const recording = await dbxPage(context, server, 'recording-during-write'); await ready(recording.frame);
  try {
    const token = await mark(recording.frame);
    await preview(recording.frame, text);
    await recording.page.evaluate(() => { dbxFixture.hold.set = true; });
    await recording.frame.locator('#ui-preferences-apply').click();
    await recording.page.waitForFunction(() => dbxFixture.held.set?.length === 1);
    await recording.frame.evaluate(() => { fixture.recording = true; });
    await recording.page.evaluate(() => dbxFixture.release('set')); await idle(recording.frame);
    await noReload(recording.frame, token);
    assert.match(await recording.frame.locator('#ui-preferences-dialog-status').innerText(), /偏好已保存.*结束录制.*重新加载/);
    assert.equal(await recording.frame.locator('#ui-preferences-apply').isDisabled(), true);
    assert.equal(await recording.page.evaluate(() => dbxFixture.snapshot['vmusic.defaultView']), 'reader');
    assert.equal(await recording.frame.evaluate(() => Theme.current().id), 'hertz-dark', 'completed preferences wait for manual reload during recording');
    await cancel(recording.frame);
    assert.match(await recording.frame.locator('#ui-preferences-status').innerText(), /偏好已保存.*下次重新加载/,
      'late-recording completion remains visible after closing the preview');
  } finally { await recording.page.close(); }

  const readFailed = await dbxPage(context, server, 'failed-read', { seed, failures: { get: 1 } });
  await ready(readFailed.frame);
  try {
    const token = await mark(readFailed.frame);
    await readFailed.frame.locator('#ui-preferences-export').click(); await idle(readFailed.frame);
    assert.match(await readFailed.frame.locator('#ui-preferences-status').innerText(), /偏好导出失败.*重新加载/);
    await upload(readFailed.frame, text); await idle(readFailed.frame);
    assert.match(await readFailed.frame.locator('#ui-preferences-status').innerText(), /偏好导入失败.*重新加载/);
    const result = await readFailed.frame.evaluate(async () => {
      localStorage.setItem('vmusic.theme.v2', 'hertz-dark');
      try { await hertzHost.flushStorage(); return 'unexpected success'; } catch (error) { return error.message; }
    });
    assert.match(result, /重新加载/);
    assert.deepEqual(await readFailed.page.evaluate(() => dbxFixture.snapshot), seed, 'read failure cannot overwrite unread historical host blob');
    assert.equal(await readFailed.page.evaluate(() => dbxFixture.requests.filter(item => item.method === 'set').length), 0);
    assert.equal(await readFailed.page.evaluate(() => dbxFixture.requests.filter(item => item.method === 'get').length), 1, 'read failure is latched until reload');
    await noReload(readFailed.frame, token);
    const loads = await readFailed.page.evaluate(() => dbxFixture.loads);
    await readFailed.frame.evaluate(() => location.reload());
    await readFailed.page.waitForFunction(old => dbxFixture.loads > old, loads); await ready(readFailed.frame);
    assert.deepEqual(await storage(readFailed.frame), seed, 'fresh iframe can hydrate historical values after failed read');
  } finally { await readFailed.page.close(); }
  report.checks.push('actual sandbox DBX SDK parent RPC: hydration/export delay/failure, stage delay, acknowledged import reload, serialized snapshots, target-only rollback preserving newer changes, late recording blocks reload, and failed-read latch');
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const a = await startServer(), b = await startServer();
  const report = { checks: [], screenshots: [], pageErrors: [], renderExceptions: [],
    scope: 'Real Chromium HTTP origins and opaque sandbox iframe; controlled stage/recording and native-save UI boundaries; no native OS save dialog or service persistence qualification.' };
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce', acceptDownloads: true });
    context.on('page', page => page.on('pageerror', error => report.pageErrors.push(error.message)));
    const text = await checkOrigins(context, a, b, report);
    await checkRejectedDocuments(context, a, text, report);
    await checkCustomPalette(context, a, b, report);
    // Use a clean origin/context: each fixture keeps real origin storage intact
    // across reload and must not inherit another test's completed migration.
    await context.close();
    const failures = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    failures.on('page', page => page.on('pageerror', error => report.pageErrors.push(error.message)));
    await checkUiBoundaries(failures, a, text, report); await failures.close();
    const dbx = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    dbx.on('page', page => page.on('pageerror', error => report.pageErrors.push(error.message)));
    await checkDbx(dbx, a, text, report);
    const helpers = { dbxPage, ready, preview, idle, mark, noReload, storage };
    await checkLatePersistence(dbx, a, text, report, helpers);
    await checkWorkshop(dbx, a, text, report, helpers);
    await dbx.close();
    assert.deepEqual(report.pageErrors, [], 'production modules must render without uncaught errors');
    console.log('UI preferences browser: ' + report.checks.length + ' groups passed; real HTTP origins + opaque DBX iframe; 18 items, 17 rejection cases, persistence and UI failure boundaries.');
    console.log(report.screenshots.map(item => item.path).join('\n'));
  } catch (error) {
    report.renderExceptions.push(error.stack || String(error)); throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'ui-preferences-browser-evidence.json'), JSON.stringify(report, null, 2));
    if (browser) await browser.close(); await Promise.all([a.close(), b.close()]);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
