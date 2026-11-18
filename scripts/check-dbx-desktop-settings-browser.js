// SPDX-License-Identifier: MIT
// Current source and generated editions in a real allow-scripts-only DBX iframe.
// Desktop surfaces are retired; normal lyrics, settings and playback remain usable.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const sources = {
  source: path.join(root, 'plugin/ui'),
  standard: path.join(root, 'output/editions/standard/plugin/ui'),
  full: path.join(root, 'output/editions/full/plugin/ui'),
};
const output = process.env.HERTZ_DESKTOP_UI_EVIDENCE_DIR
  ? path.resolve(process.env.HERTZ_DESKTOP_UI_EVIDENCE_DIR)
  : path.join(root, 'output/playwright/dbx-desktop-retirement-' + Date.now());
const retiredIds = ['dbx-desktop-settings', 'desktop-settings-group', 'desktop-lyrics-settings',
  'desktop-lyrics-dialog', 'bar-desktop-settings', 'desktop-calibration-consent', 'ai-wallpaper-pairings'];
const desktopAssets = ['desktop-settings.js', 'desktop-lyrics-settings.js', 'desktop-lyrics-settings.css',
  'wallpaper-settings.js', 'wallpaper-settings.css'];
function fixture() {
  const track = { id: 'fixture-track', title: '保留的普通歌词', artist: 'Hertz Fixture', album: 'DBX',
    source: 'local', duration_ms: 30000, format: 'wav', sample_rate: 44100, channels: 1, has_cover: false };
  const snapshot = { playing: false, buffering: false, volume: 1, position_ms: 1000, duration_ms: 30000,
    mode: 'repeat', track_id: track.id, generation: 1 };
  window.fixture = {
    requests: [], settings: { global_lyric_offset_ms: 0 },
    async request(method, params) {
      this.requests.push({ method, params: structuredClone(params) });
      if (/^v1\/(?:desktop(?:\/|-)|wallpaper\/|ai\/wallpaper\/)/.test(method)) {
        return { status: 404, body: { error: { code: 'not_found', message: 'desktop retired' } } };
      }
      let body;
      if (method === 'v1/settings') {
        if (params.op === 'PUT' || params.op === 'POST') Object.assign(this.settings, params.body);
        body = structuredClone(this.settings);
      } else if (method === 'v1/state') body = snapshot;
      else if (method === 'v1/tracks') body = { tracks: [track], total: 1 };
      else if (method === 'v1/tracks/' + track.id) body = track;
      else if (method === 'v1/tracks/' + track.id + '/lyrics') body = {
        source: 'imported', user_offset_ms: 0,
        lines: [{ start_ms: 0, end_ms: 15000, text: '保留的普通歌词' }, { start_ms: 15000, end_ms: 30000, text: '下一句歌词' }],
      };
      else if (method === 'v1/player/queue') body = { queue: [track.id], index: 0 };
      else if (method.startsWith('v1/player/')) {
        if (method === 'v1/player/play') snapshot.playing = true;
        if (method === 'v1/player/pause') snapshot.playing = false;
        body = {};
      } else if (method.startsWith('v1/recommend/daily')) body = { tracks: [], pending: [], sources: [] };
      else if (method === 'v1/room') body = { mode: 'local' };
      else if (method === 'v1/playlists' || method === 'v1/favorites') body = [];
      else if (method === 'v1/devices') body = { devices: [] };
      else if (method === 'v1/library/scan/roots') body = { roots: [] };
      else if (method === 'v1/library/scan/history') body = { runs: [] };
      else if (method === 'v1/health') body = { backend: 'fixture', version: 'fixture', protocol_version: 1 };
      else if (method === 'v1/tracks/facets') body = { facets: [] };
      else body = {};
      return { status: 200, body: structuredClone(body) };
    },
  };
  window.dbxPlugin = {
    ready: Promise.resolve(), context: { surface: 'tab' },
    storage: { get: async () => ({ 'vmusic.defaultView': 'settings', 'vmusic.skin': 'hertz' }), set: async () => {} },
    onEvent: () => () => {}, invoke: (method, params) => window.fixture.request(method, params),
  };
}
async function main() {
  assert.ok(!fs.existsSync(output), 'Evidence directory already exists: ' + output);
  fs.mkdirSync(output, { recursive: true });
  for (const edition of ['standard', 'full']) {
    assert.ok(fs.existsSync(path.join(sources[edition], 'index.html')), 'Run node scripts/check-editions.js first');
    for (const asset of desktopAssets) assert.ok(!fs.existsSync(path.join(sources[edition], asset)), edition + ': retired ' + asset);
  }
  let base;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/host') {
      const mode = url.searchParams.get('mode');
      if (!sources[mode]) { response.writeHead(400); response.end(); return; }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><style>html,body,iframe{width:100%;height:100%;border:0;margin:0}</style><iframe sandbox="allow-scripts" src="/' + mode + '/index.html"></iframe>');
      return;
    }
    const match = /^\/([^/]+)\/(.*)$/.exec(url.pathname);
    const dir = match && sources[match[1]];
    if (!dir) { response.writeHead(404); response.end(); return; }
    const file = path.resolve(dir, decodeURIComponent(match[2]));
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream');
    if (path.basename(file) === 'index.html') {
      const setup = '<head><base href="' + base + '/' + match[1] + '/"><meta http-equiv="Content-Security-Policy" content="connect-src &#39;none&#39;"><script>(' + fixture.toString() + ')();</script>';
      response.end(fs.readFileSync(file, 'utf8').replace('<head>', setup));
    } else response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  const checks = [];
  try {
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    for (const mode of Object.keys(sources)) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(base + '/host?mode=' + mode, { waitUntil: 'domcontentloaded' });
        const frame = await (await page.waitForSelector('iframe')).contentFrame();
        await frame.waitForFunction(() => document.getElementById('conn')?.textContent === '服务已连接');
        await frame.waitForFunction(() => !!document.querySelector('.hz-settings-nav'));
        assert.equal(await frame.evaluate(() => self.origin), 'null');
        assert.equal(await frame.evaluate(() => hertzHost.desktopEnabled), false);
        assert.equal(await frame.evaluate(() => state.view), 'settings');
        for (const id of retiredIds) assert.equal(await frame.locator('#' + id).count(), 0, mode + ': removed ' + id);
        assert.equal(await frame.locator('[data-ai-scope^="wallpaper:"]').count(), 0);
        assert.equal(await frame.getByRole('tab', { name: '桌面', exact: true }).count(), 0);
        const snapshot = await frame.locator('body').ariaSnapshot();
        assert.doesNotMatch(snapshot, /桌面歌词设置|壁纸设置|桌面宠物|允许从桌面打开|壁纸生成连接/);
        fs.writeFileSync(path.join(output, mode + '-settings.aria.yml'), snapshot);
        await frame.getByRole('tab', { name: '歌词', exact: true }).click();
        await frame.locator('#set-lyric-offset-up').click();
        await frame.waitForFunction(() => fixture.settings.global_lyric_offset_ms === 100);
        assert.equal(await frame.locator('#set-lyric-offset-value').textContent(), '+100ms');
        await frame.evaluate(() => HertzSkin.selectSettings('desktop'));
        assert.equal(await frame.locator('.hz-settings-nav [aria-selected="true"]').getAttribute('data-category'), 'appearance');
        await frame.getByRole('tab', { name: '播放', exact: true }).click();
        await frame.locator('body').press('Tab');
        assert.equal(await frame.evaluate(() => !!document.activeElement?.closest('[data-desktop-feature]')), false);
        await frame.evaluate(() => HertzShell.navigate('home'));
        await frame.locator('#playpause').click();
        assert.ok(await frame.evaluate(() => fixture.requests.some(row => row.method === 'v1/player/play')));
        await frame.evaluate(() => openNowPlaying());
        await frame.locator('#np-tab-lyrics').click();
        assert.equal(await frame.locator('#np-modal').isVisible(), true);
        await frame.waitForFunction(() => document.getElementById('np-lyric-lines')?.textContent.includes('保留的普通歌词'));
        await frame.evaluate(() => closeNowPlaying());
        await frame.locator('.rail-item[data-view="settings"]').click();
        await frame.evaluate(() => window.dispatchEvent(new Event('hertz-open-desktop-lyrics-settings')));
        await frame.waitForTimeout(1600);
        const desktopRequests = await frame.evaluate(() => fixture.requests.filter(row => /^v1\/(?:desktop(?:\/|-)|wallpaper\/|ai\/wallpaper\/)/.test(row.method)));
        assert.deepEqual(desktopRequests, [], mode + ': no desktop request at startup, settings, playback or idle');
        assert.deepEqual(errors, [], mode + ': no uncaught errors');
        await page.screenshot({ path: path.join(output, mode + '-settings.png'), animations: 'disabled' });
        await page.setViewportSize({ width: 560, height: 850 });
        await page.screenshot({ path: path.join(output, mode + '-narrow.png'), animations: 'disabled' });
        checks.push({ mode, opaqueSandbox: true, desktopRequests, regularLyricOffsetMs: 100, playbackInvoked: true, errors });
        console.log('PASS ' + mode + ': desktop controls/resources retired; normal lyrics and playback retained');
      } finally { await page.close(); }
    }
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ checks }, null, 2) + '\n');
    console.log(output);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
