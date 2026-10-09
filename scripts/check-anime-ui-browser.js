// SPDX-License-Identifier: MIT
// Browser acceptance for the celestial UI, against a rebuilt isolated null service.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');

const root = path.resolve(__dirname, '..');
const out = path.resolve(root, process.env.ANIME_SHOT_DIR || 'output/playwright/anime-ui');
const finalCssOnly = process.env.ANIME_FINAL_CSS_ONLY === '1';
const report = { checks: [], geometry: [], initialGeometry: [], particles: [], assets: [], pageErrors: [], consoleErrors: [], failedAssets: [], networkErrors: [], expectedResponses: [], unexpectedResponses: [], libraryRequests: [] };
report.scope = finalCssOnly ? 'final CSS checks; full business evidence remains in report.json' : 'full acceptance';
const pass = label => { report.checks.push(label); console.log('PASS ' + label); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(probe, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await probe();
    if (value) return value;
    await wait(100);
  }
  throw new Error('Timed out: ' + label);
}

function writeWav(file, track) {
  const chunk = (id, data) => {
    const header = Buffer.alloc(8);
    header.write(id);
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
  };
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(8000, 4);
  format.writeUInt32LE(16000, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);
  const info = Object.entries({ INAM: track.title, IART: track.artist, IPRD: track.album })
    .map(([id, value]) => chunk(id, Buffer.from(value + '\0', 'utf8')));
  fs.writeFileSync(file, chunk('RIFF', Buffer.concat([
    Buffer.from('WAVE'), chunk('fmt ', format), chunk('LIST', Buffer.concat([Buffer.from('INFO'), ...info])),
    chunk('data', Buffer.alloc(16000 * track.seconds)),
  ])));
}

async function seedLibrary(fixture) {
  const music = path.join(path.dirname(fixture.dataDir), 'music');
  const catalog = [
    { title: '晴空与你', artist: '青空日记', album: '云端来信', folder: 'sky', seconds: 228 },
    { title: '夏日风铃', artist: '青空日记', album: '云端来信', folder: 'sky', seconds: 196 },
    { title: '把心事写进云里', artist: '青空日记', album: '云端来信', folder: 'sky', seconds: 243 },
    { title: '星河漫游', artist: '月岛电台', album: '星光放映室', folder: 'stars', seconds: 212 },
    { title: '凌晨两点的月亮', artist: '月岛电台', album: '星光放映室', folder: 'stars', seconds: 187 },
    { title: '遥远的回声', artist: '月岛电台', album: '星光放映室', folder: 'stars', seconds: 235 },
    { title: '樱花落在琴键上', artist: '花间来信', album: '春日序曲', folder: 'spring', seconds: 205 },
    { title: '下一站，春天', artist: '花间来信', album: '春日序曲', folder: 'spring', seconds: 219 },
  ];
  for (const [index, track] of catalog.entries()) {
    const folder = path.join(music, track.folder);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, String(index + 1).padStart(2, '0') + '.wav');
    writeWav(file, track);
    fs.writeFileSync(file.replace(/\.wav$/, '.lrc'),
      '[00:00.00]晚风吹过你的眼睛\n[00:05.00]把星光画进这一页\n[00:10.00]听见远方温柔的回声\n[00:17.00]让每一颗星都有颜色\n[00:24.00]我们沿着星光继续向前走\n');
  }
  await fixture.api('/v1/library/roots', 'POST', { path: music, enabled: true });
  await fixture.api('/v1/library/scan', 'POST', { root: music });
  await until(async () => {
    const status = await fixture.api('/v1/library/status');
    return !status.running && status.total >= catalog.length;
  }, 'eight local tracks scanned');
  const tracks = (await fixture.api('/v1/tracks?limit=100')).tracks;
  assert.equal(tracks.length, catalog.length, 'fixture contains exactly eight local tracks');
  const ordered = catalog.map(expected => {
    const track = tracks.find(t => t.title === expected.title);
    assert.ok(track, 'scanner reads title ' + expected.title);
    assert.equal(track.artist, expected.artist);
    assert.equal(track.album, expected.album);
    return track;
  });
  await fixture.api('/v1/settings', 'PUT', { cover_follow: false, reduce_motion: false, render_mode: 'standard', home_quote: false });
  await fixture.api('/v1/player/volume', 'POST', { volume: 0 });
  await fixture.api('/v1/player/load', 'POST', { track_id: ordered[0].id, queue: ordered.map(t => t.id) });
  await fixture.api('/v1/player/pause', 'POST', {});
  await fixture.api('/v1/player/seek', 'POST', { position_ms: 18000 });
  report.fixture = ordered.map(({ id, title, artist, album, has_cover, duration_ms }) => ({ id, title, artist, album, has_cover, duration_ms }));
  return ordered;
}

async function ready(page, trackId) {
  await page.waitForFunction(id => window.Theme && window.ThemeStudio && window.Skins && window.Workshop &&
    window.AnimeInteractions && document.querySelector('#conn.ok') && Stage.presentation().track?.id === id, trackId);
  await page.evaluate(() => document.fonts.ready);
}

async function addCovers(context, fixture, tracks) {
  const covers = ['morning-01.jpg', 'evening-16.jpg', 'night-12.jpg'];
  // The fixture cookie authenticates the HTML entry only; write APIs require
  // this isolated service's generated bearer token. Never include it in reports.
  const { token } = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'vmusicd.json'), 'utf8'));
  for (const [index, track] of tracks.entries()) {
    const cover = covers[index < 3 ? 0 : index < 6 ? 1 : 2];
    const response = await context.request.post(fixture.base + '/v1/tracks/' + encodeURIComponent(track.id) + '/cover', {
      headers: { 'Content-Type': 'image/jpeg', Authorization: 'Bearer ' + token },
      data: fs.readFileSync(path.join(root, 'plugin/ui/wallpapers', cover)),
    });
    assert.equal(response.status(), 200, 'local fixture cover upload for ' + track.title);
    assert.equal((await response.json()).ok, true);
  }
  const scanned = (await fixture.api('/v1/tracks?limit=100')).tracks;
  assert.ok(scanned.every(track => track.has_cover), 'all eight local tracks have real cover art');
  report.fixture.forEach(track => { track.has_cover = true; });
}

async function settle(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // A breakpoint turns the sidebar stage into a drawer with a 340ms
    // transform transition. Measure its resting position, not an intermediate frame.
    const animations = [...document.querySelectorAll('#stage, #playback-bar, .topbar, .app')]
      .flatMap(el => el.getAnimations()).filter(a => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(animations.map(a => a.finished.catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
}

async function navigate(page, view) {
  await page.locator('.rail-item[data-view="' + view + '"]').click();
  await page.locator('#view-' + view).waitFor({ state: 'visible' });
  await settle(page);
}

async function selectTheme(page, id) {
  const name = await page.evaluate(value => Theme.list().find(t => t.id === value)?.name, id);
  assert.ok(name, 'theme remains available: ' + id);
  await page.locator('#theme-btn').click();
  await page.locator('#theme-menu').waitFor({ state: 'visible' });
  await page.locator('#theme-menu').getByRole('option', { name, exact: true }).click();
  await page.waitForFunction(value => Theme.current().id === value, id);
  assert.equal(await page.evaluate(() => localStorage.getItem('vmusic.theme.v2')), id);
}

async function installParticleObserver(page) {
  await page.evaluate(() => {
    window.__animeClicks = [];
    document.addEventListener('click', event => {
      const control = event.target.closest?.('button, [role="button"]');
      if (!control) return;
      const layer = document.querySelector('.anime-interactions-layer');
      const burst = layer?.lastElementChild;
      const particle = burst?.firstElementChild;
      const r = control.getBoundingClientRect();
      __animeClicks.push({ id: control.id || control.dataset.view || control.dataset.style || control.dataset.id,
        detail: event.detail, particles: layer?.querySelectorAll('.anime-interactions-particle').length || 0,
        bursts: layer?.childElementCount || 0, hidden: layer?.getAttribute('aria-hidden'),
        pointerEvents: layer && getComputedStyle(layer).pointerEvents,
        duration: particle && getComputedStyle(particle).animationDuration,
        x: burst && parseFloat(burst.style.left), y: burst && parseFloat(burst.style.top),
        centerX: r.x + r.width / 2, centerY: r.y + r.height / 2 });
    }, { capture: true, passive: true });
  });
}

async function prepareParticleClick(page) {
  await page.evaluate(() => { AnimeInteractions.clear(); __animeClicks.length = 0; });
}

async function readParticleClick(page, id, label, expected) {
  const sample = await page.evaluate(value => __animeClicks.find(c => c.id === value), id);
  assert.ok(sample, label + ' native click observed');
  assert.equal(sample.particles, expected, label + ' particle count');
  if (expected) {
    assert.equal(sample.bursts, 1, label + ' produces one burst');
    assert.equal(sample.hidden, 'true', label + ' stays decorative');
    assert.equal(sample.pointerEvents, 'none', label + ' cannot intercept the next action');
    assert.equal(sample.duration, '0.28s', label + ' has a short bounded animation');
  }
  report.particles.push({ label, ...sample });
  await page.locator('.anime-interactions-layer').waitFor({ state: 'detached' });
  return sample;
}

async function auditMenu(page, button, menu, width) {
  await page.locator('#' + button).click();
  await page.locator('#' + menu).waitFor({ state: 'visible' });
  await page.locator('#' + menu).evaluate(async el => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    await Promise.all(el.getAnimations().map(a => a.finished.catch(() => {})));
  });
  const bounds = await page.locator('#' + menu).evaluate(el => {
    const r = el.getBoundingClientRect(), first = el.querySelector('button');
    const b = first.getBoundingClientRect();
    return { left: r.left, right: r.right, bottom: r.bottom,
      hit: first.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)) };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.bottom <= 1000 && bounds.hit,
    width + ' ' + menu + ' is contained and clickable: ' + JSON.stringify(bounds));
  await page.keyboard.press('Escape');
  if (await page.locator('#' + menu).isVisible()) await page.locator('#' + button).click();
}

async function auditDaily(page, width) {
  const list = page.locator('#daily-list');
  await page.waitForFunction(() => document.querySelectorAll('#daily-list .daily-card').length === 8);
  const layout = await list.evaluate(el => {
    const card = el.querySelector('.daily-card'), css = getComputedStyle(el);
    const svg = document.querySelector('#daily-toggle svg').getBoundingClientRect();
    return { client: el.clientWidth, scroll: el.scrollWidth, gap: css.gap, overflow: css.overflowX,
      cardWidth: card.getBoundingClientRect().width, icon: { width: svg.width, height: svg.height } };
  });
  assert.equal(layout.gap, '24px');
  assert.equal(layout.overflow, 'auto');
  assert.ok(Math.abs(layout.cardWidth - 180) < 1 && layout.scroll > layout.client, width + ' recommendations use 180px cards with native horizontal overflow');
  assert.ok(layout.icon.width >= 18 && layout.icon.height >= 18, width + ' recommendation toggle icon is visible');
  await list.locator('.daily-card').first().focus();
  for (let i = 1; i < 8; i++) await page.keyboard.press('Tab');
  // Native focus scrolling and CSS scroll snap can finish after the key event.
  // Keep the final visibility assertion below even if this bounded wait expires.
  await page.waitForFunction(() => {
    const list = document.getElementById('daily-list'), r = list.lastElementChild.getBoundingClientRect(), box = list.getBoundingClientRect();
    return r.left >= box.left - 1 && r.right <= box.right + 1;
  }, null, { timeout: 2000 }).catch(() => {});
  const focus = await list.evaluate(el => {
    const last = el.lastElementChild, r = last.getBoundingClientRect(), box = el.getBoundingClientRect();
    return { last: document.activeElement === last, scroll: el.scrollLeft, left: r.left, right: r.right, boxLeft: box.left, boxRight: box.right };
  });
  assert.ok(focus.last && focus.scroll > 0 && focus.left >= focus.boxLeft - 1 && focus.right <= focus.boxRight + 1,
    width + ' native Tab reveals the last recommendation: ' + JSON.stringify(focus));
  await page.locator('#daily-toggle').click();
  assert.equal(await page.locator('#daily-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await list.isVisible(), false);
  await page.locator('#daily-toggle').click();
  assert.equal(await page.locator('#daily-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await list.isVisible(), true);
  await list.evaluate(el => { el.scrollLeft = 0; });
  report.geometry.push({ daily: true, width, ...layout, focus });
}

async function auditLayout(page, width) {
  await page.setViewportSize({ width, height: 1000 });
  await navigate(page, 'library');
  await page.evaluate(() => { document.getElementById('column').scrollTop = 0; document.getElementById('view-library').scrollTop = 0; window.scrollTo(0, 0); });
  await page.mouse.move(0, 999);
  await settle(page);
  const value = await page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const ids = ['capsule-entry', 'stage3d-entry', 'settings-entry', 'theme-btn', 'skin-btn', 'top-more-btn', 'online-account-btn', 'playpause', 'next', 'progress'];
    return { width: innerWidth, document: { client: document.scrollingElement.clientWidth, scroll: document.scrollingElement.scrollWidth },
      topbar: rect(document.querySelector('.topbar')), app: rect(document.querySelector('.app')),
      search: rect(document.getElementById('search')), bar: rect(document.getElementById('playback-bar')),
      containers: ['column', 'view-library', 'lib-list'].map(id => { const el = document.getElementById(id); return { id, client: el.clientWidth, scroll: el.scrollWidth }; }),
      controls: ids.map(id => {
        const el = document.getElementById(id), r = rect(el);
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { id, ...r, hit: !!hit && el.contains(hit) };
      }) };
  });
  report.geometry.push(value);
  assert.ok(value.document.scroll <= width + 1, width + ' document has no horizontal overflow');
  assert.ok(value.app.y >= value.topbar.bottom - 1, width + ' content starts below the header');
  assert.ok(value.search.width >= 100 && value.search.x >= 0 && value.search.right <= width, width + ' search remains usable');
  for (const container of value.containers) assert.ok(container.scroll <= container.client + 1,
    width + ' ' + container.id + ' has no horizontal overflow: ' + JSON.stringify(container));
  for (const control of value.controls) {
    assert.ok(control.width >= (control.id === 'progress' ? 50 : 28) && control.height >= (control.id === 'progress' ? 8 : 30)
      && control.x >= -1 && control.right <= width + 1 && control.hit,
    width + ' ' + control.id + ' is reachable: ' + JSON.stringify(control));
    await page.locator('#' + control.id).click({ trial: true });
  }
  await page.screenshot({ path: path.join(out, 'celestial-' + width + '.png') });
  for (const [button, menu] of [['theme-btn', 'theme-menu'], ['skin-btn', 'skin-menu'], ['top-more-btn', 'top-more-menu']]) {
    await auditMenu(page, button, menu, width);
  }
  await page.locator('#lib-list .track').first().scrollIntoViewIfNeeded();
  await page.locator('#lib-list .track').first().click({ trial: true, position: { x: 80, y: 20 } });
  await page.screenshot({ path: path.join(out, 'library-' + width + '.png') });
  if (width === 1440 || width === 320) await auditDaily(page, width);
  await navigate(page, 'queue');
  await page.locator('#queue-list .q-row').first().waitFor({ state: 'visible' });
  await navigate(page, 'library');
  pass(width + 'px layout, playback controls, local rows, navigation and anchored menus');
}

async function verifyBrowserHealth(responseAudits) {
  await Promise.all(responseAudits);
  assert.deepEqual(report.pageErrors, [], 'no browser runtime errors');
  assert.deepEqual(report.unexpectedResponses, [], 'no unexpected HTTP error responses');
  report.unexpectedConsoleErrors = report.consoleErrors.filter(error => !report.expectedResponses.some(response =>
    response.route === error.route && error.message === 'Failed to load resource: the server responded with a status of '
      + response.status + (response.status === 401 ? ' (Unauthorized)' : ' (Not Found)')));
  assert.deepEqual(report.unexpectedConsoleErrors, [], 'no unexpected browser console errors');
  assert.deepEqual(report.failedAssets, [], 'no failed local UI assets');
  pass('no runtime or asset errors; only verified logged-out account and silent beatmap protocol outcomes');
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const fixture = await startFixture();
  let browser, page;
  try {
    const tracks = await seedLibrary(fixture), current = tracks[0];
    for (const file of ['themes.js', 'theme-studio.js', 'app.js', 'style.css', 'anime-ui.css', 'anime-stage.css', 'cel-ui.css',
      'anime-interactions.js', 'anime-interactions.css', 'stage3d.css', 'workshop.js', 'skins/skins.js', 'wallpapers/celestial-sky.jpg']) {
      const response = await fetch(fixture.base + '/' + file);
      assert.equal(response.status, 200, 'served asset ' + file);
      const served = Buffer.from(await response.arrayBuffer()), disk = fs.readFileSync(path.join(root, 'plugin/ui', file));
      if (/\.(js|css)$/.test(file)) assert.equal(served.toString().replace(/\r\n/g, '\n'), disk.toString().replace(/\r\n/g, '\n'), 'current embedded asset ' + file);
      else assert.ok(served.equals(disk), 'current embedded image ' + file);
      report.assets.push({ file, bytes: served.length });
    }
    pass('current celestial assets served by an isolated null backend with eight local tracks');

    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await fixture.connect(context);
    await addCovers(context, fixture, tracks);
    await context.addInitScript(() => { try { localStorage.setItem('vmusic.daily.mode', 'local'); } catch {} });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    const requests = [];
    const responseAudits = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (request.method() !== 'GET') requests.push({ method: request.method(), route: url.pathname });
      if (url.pathname === '/v1/tracks') report.libraryRequests.push(Object.fromEntries(['q', 'artist', 'album', 'sort', 'offset'].map(key => [key, url.searchParams.get(key)])));
    });
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      let route = '';
      try { route = new URL(message.location().url, fixture.base).pathname; } catch {}
      report.consoleErrors.push({ message: message.text(), route });
    });
    page.on('response', response => {
      if (response.url().startsWith(fixture.base) && response.status() >= 400) {
        const entry = { route: new URL(response.url()).pathname, status: response.status() };
        const existing = report.networkErrors.find(error => error.route === entry.route && error.status === entry.status);
        if (existing) existing.count++;
        else report.networkErrors.push({ ...entry, count: 1 });
        responseAudits.push((async () => {
          const body = await response.json().catch(() => null);
          const source = new URL(response.url()).searchParams.get('source');
          const detail = { ...entry, code: body?.error?.code, source: body?.error?.source,
            state: body?.status, reason: body?.reason };
          // These two statuses are documented application outcomes for this
          // logged-out, silent-audio fixture. Authentication failures, other
          // reasons, other endpoints and malformed bodies still fail the run.
          const expectedAccount = entry.route === '/v1/online/account' && entry.status === 401
            && detail.code === 'auth_required' && !!source && detail.source === source;
          const expectedBeatmap = entry.route === '/v1/stage/beatmap' && entry.status === 404
            && detail.state === 'unavailable' && detail.reason === 'unsupported';
          (expectedAccount || expectedBeatmap ? report.expectedResponses : report.unexpectedResponses).push(detail);
        })());
      }
      if (response.url().startsWith(fixture.base) && response.status() >= 400 && /\.(js|css|jpg|png|woff2?)(\?|$)/.test(response.url())) {
        report.failedAssets.push({ url: response.url(), status: response.status() });
      }
    });
    await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
    await ready(page, current.id);
    await page.waitForFunction(() => document.querySelectorAll('#lib-list .track').length === 8);
    report.initial = await page.evaluate(() => ({ theme: Theme.current().id, name: Theme.current().name, skin: Skins.currentId(),
      themes: Theme.list().map(t => t.id), wallpaper: ThemeStudio.state.id, pinned: ThemeStudio.state.pinned }));
    assert.equal(report.initial.theme, 'celestial');
    assert.match(report.initial.name, /^晴空绘卷(?:（默认）)?$/);
    assert.equal(report.initial.skin, 'classic');
    assert.equal(report.initial.themes[0], 'celestial');
    assert.equal(report.initial.wallpaper, 'celestial-sky.jpg');
    assert.equal(report.initial.pinned, false);
    await page.waitForFunction(() => document.querySelector('#ts-wallpaper .ts-wall-img')?.dataset.wall === 'celestial-sky.jpg');
    pass('fresh installation opens 晴空绘卷 with its local wallpaper and populated library');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await settle(page);
      report.initialGeometry.push(await page.evaluate(() => {
        const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        const stage = document.getElementById('stage'), css = getComputedStyle(stage);
        return { width: innerWidth, stage: rect(stage), transform: css.transform, transition: css.transition,
          app: rect(document.querySelector('.app')), body: rect(document.body), pageWidth: document.scrollingElement.scrollWidth };
      }));
      await page.screenshot({ path: path.join(out, 'initial-' + width + '.png') });
      console.log('SCREENSHOT ' + path.join(out, 'initial-' + width + '.png'));
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (finalCssOnly) {
      for (const width of process.env.ANIME_FINAL_NARROW_ONLY === '1' ? [320] : [1440, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await navigate(page, 'library');
        await auditDaily(page, width);
        assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1), width + ' daily rail does not overflow the document');
        pass(width + 'px recommendations: 180px cards, 24px gaps, visible toggle, native Tab and collapse/expand');
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      for (const source of ['system', 'app']) {
        if (source === 'system') await page.emulateMedia({ reducedMotion: 'reduce' });
        else { await navigate(page, 'settings'); await page.locator('#set-motion').check(); }
        await page.locator('#theme-btn').hover();
        assert.equal(await page.locator('#theme-btn').evaluate(el => getComputedStyle(el).transform), 'none', source + ' reduced motion prevents hover movement');
        if (source === 'system') await page.emulateMedia({ reducedMotion: 'no-preference' });
        else {
          await until(async () => (await fixture.api('/v1/settings')).reduce_motion === true, 'app reduced motion saved');
          await page.locator('#set-motion').uncheck();
          await until(async () => (await fixture.api('/v1/settings')).reduce_motion === false, 'app reduced motion restored');
        }
        pass(source + ' reduced motion keeps hovered buttons still');
      }
      await navigate(page, 'library');
      await page.evaluate(() => { document.getElementById('column').scrollTop = 0; document.getElementById('view-library').scrollTop = 0; });
      await settle(page);
      await page.screenshot({ path: path.join(out, 'final-desktop.png') });
      await verifyBrowserHealth(responseAudits);
      return;
    }

    for (const theme of ['mineral', 'anime-sakura']) {
      await selectTheme(page, theme);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ready(page, current.id);
      assert.equal(await page.evaluate(() => Theme.current().id), theme, theme + ' survives refresh');
      assert.equal(await page.evaluate(() => localStorage.getItem('vmusic.theme.v2')), theme);
      await page.screenshot({ path: path.join(out, 'saved-' + theme + '.png') });
    }
    await selectTheme(page, 'celestial');
    await page.evaluate(() => ThemeStudio.setWallpaper('night-12.jpg', { keepTheme: true }));
    await selectTheme(page, 'emerald');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page, current.id);
    assert.equal(await page.evaluate(() => ThemeStudio.state.id), 'night-12.jpg', 'explicit wallpaper is preserved');
    assert.equal(await page.evaluate(() => ThemeStudio.state.pinned), true);
    await selectTheme(page, 'celestial');
    await page.evaluate(() => localStorage.removeItem('vmusic.wallpaper.v1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page, current.id);
    assert.equal(await page.evaluate(() => ThemeStudio.state.id), 'celestial-sky.jpg');
    pass('built-in and delayed themes persist; explicitly pinned wallpaper survives theme changes and refresh');

    await installParticleObserver(page);
    await prepareParticleClick(page);
    let before = requests.length;
    await page.locator('#playpause').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => Stage.presentation().playing);
    const keyboard = await readParticleClick(page, 'playpause', 'keyboard play', 6);
    assert.equal(keyboard.detail, 0);
    assert.ok(Math.abs(keyboard.x - keyboard.centerX) < 1 && Math.abs(keyboard.y - keyboard.centerY) < 1, 'keyboard particles are centered on the control');
    assert.equal(requests.slice(before).filter(r => r.route === '/v1/player/play').length, 1, 'Enter sends one play request');
    await prepareParticleClick(page);
    before = requests.length;
    await page.locator('#playpause').click();
    await page.waitForFunction(() => !Stage.presentation().playing);
    await readParticleClick(page, 'playpause', 'pointer pause', 6);
    assert.equal(requests.slice(before).filter(r => r.route === '/v1/player/pause').length, 1, 'click sends one pause request');
    pass('native Enter and pointer playback emit one action, six decorative particles and bounded cleanup');

    await page.locator('#lib-artist-filter').selectOption('青空日记');
    await page.waitForFunction(() => document.querySelectorAll('#lib-list .track').length === 3);
    assert.deepEqual(await page.locator('#lib-list .t-sub').allTextContents(), Array(3).fill('青空日记'));
    await page.locator('#lib-artist-filter').selectOption('');
    await page.waitForFunction(() => document.querySelectorAll('#lib-list .track').length === 8);
    const albumMatches = await fixture.api('/v1/tracks?album=' + encodeURIComponent('春日序曲'));
    report.albumMatches = albumMatches.tracks.map(({ id, title, artist, album }) => ({ id, title, artist, album }));
    assert.equal(albumMatches.tracks.length, 2, 'service album filter finds the two tagged tracks');
    await page.locator('#lib-album-filter').selectOption('春日序曲');
    await page.waitForFunction(() => document.querySelectorAll('#lib-list .track').length === 2);
    await page.locator('#lib-album-filter').selectOption('');
    await page.waitForFunction(() => document.querySelectorAll('#lib-list .track').length === 8);
    await page.locator('#lib-sort').selectOption('album');
    await page.waitForFunction(() => document.querySelectorAll('#lib-list .track').length === 8);
    await page.locator('#lib-list .track[data-id="' + tracks[1].id + '"] .t-title').click();
    await page.waitForFunction(id => Stage.presentation().track?.id === id && Stage.presentation().playing, tracks[1].id);
    await page.locator('#playpause').click();
    await page.waitForFunction(() => !Stage.presentation().playing);
    const range = await page.locator('#progress').boundingBox();
    await page.mouse.click(range.x + range.width * .4, range.y + range.height / 2);
    await until(async () => {
      const state = await fixture.api('/v1/state');
      return state.position_ms > tracks[1].duration_ms * .3 && state.position_ms < tracks[1].duration_ms * .5;
    }, 'real player seeks from the progress control');
    await page.locator('#volume').focus();
    await page.keyboard.press('ArrowRight');
    await until(async () => (await fixture.api('/v1/state')).volume > 0, 'native keyboard volume update');
    await page.keyboard.press('Home');
    await until(async () => (await fixture.api('/v1/state')).volume === 0, 'volume returns to mute');
    pass('local artist/album filters, sorting, row playback, progress seek and keyboard volume work');

    await navigate(page, 'queue');
    await page.waitForFunction(() => document.querySelectorAll('#queue-list .q-row').length === 8);
    await page.locator('#queue-list .q-row[data-track-id="' + tracks[7].id + '"] [data-act="remove"]').click();
    await until(async () => (await fixture.api('/v1/player/queue')).queue.length === 7, 'queue removal');
    await navigate(page, 'library');
    await page.locator('#lib-list .track[data-id="' + tracks[7].id + '"] [data-act="play-next"]').click();
    await until(async () => (await fixture.api('/v1/player/queue')).queue.length === 8, 'queue insertion');
    const queue = await fixture.api('/v1/player/queue');
    assert.equal(queue.queue[queue.index + 1], tracks[7].id, 'next-play action inserts after the current song');
    for (const view of ['playlists', 'favorites', 'settings', 'library']) await navigate(page, view);
    pass('queue remove/insert preserves playback; local navigation reaches playlists, favorites and settings');

    for (const source of ['system', 'app']) {
      if (source === 'system') await page.emulateMedia({ reducedMotion: 'reduce' });
      else { await navigate(page, 'settings'); await page.locator('#set-motion').check(); }
      await prepareParticleClick(page);
      await page.locator('#theme-btn').hover();
      assert.equal(await page.locator('#theme-btn').evaluate(el => getComputedStyle(el).transform), 'none', source + ' reduced motion prevents hover movement');
      await page.locator('#theme-btn').click();
      await readParticleClick(page, 'theme-btn', source + ' reduced motion', 0);
      await page.keyboard.press('Escape');
      if (source === 'system') await page.emulateMedia({ reducedMotion: 'no-preference' });
      else {
        await until(async () => (await fixture.api('/v1/settings')).reduce_motion === true, 'reduced motion is saved');
        await page.locator('#set-motion').uncheck();
        await until(async () => (await fixture.api('/v1/settings')).reduce_motion === false, 'reduced motion is restored');
      }
    }
    await selectTheme(page, 'mineral');
    await prepareParticleClick(page);
    await page.locator('#theme-btn').click();
    await readParticleClick(page, 'theme-btn', 'legacy theme', 0);
    await page.keyboard.press('Escape');
    await selectTheme(page, 'celestial');
    pass('system and saved app reduced motion suppress particles; legacy themes keep their existing behavior');

    for (const width of [1440, 1024, 390, 320]) await auditLayout(page, width);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#skin-btn').focus();
    await page.keyboard.press('Space');
    await page.locator('#skin-menu').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.activeElement.dataset.skinId), 'classic', 'skin menu focuses the current selection');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => Skins.currentId() === 'sheen' && document.querySelector('[data-skin-css="sheen"]').sheet);
    assert.equal(await page.evaluate(() => Theme.current().id), 'celestial', 'keyboard skin selection retains theme');
    for (const skin of ['liunian', 'ios', 'qingfeng', 'classic']) {
      await page.evaluate(id => Skins.apply(id), skin);
      await page.waitForFunction(id => Skins.currentId() === id && (id === 'classic' || document.querySelector('[data-skin-css="' + id + '"]').sheet), skin);
      await settle(page);
      const state = await page.evaluate(() => ({ theme: Theme.current().id, skin: Skins.currentId(),
        width: document.scrollingElement.scrollWidth, column: document.querySelectorAll('#column').length,
        library: document.querySelectorAll('#lib-list').length, player: document.querySelectorAll('#playback-bar').length }));
      assert.equal(state.theme, 'celestial');
      assert.ok(state.width <= 1441, skin + ' has no document overflow');
      assert.equal(state.column, 1); assert.equal(state.library, 1); assert.equal(state.player, 1);
      await page.screenshot({ path: path.join(out, 'skin-' + skin + '.png') });
      if (skin === 'liunian') {
        const active = await page.locator('#lib-list .track.active').evaluate(row => ({
          background: getComputedStyle(row).backgroundColor,
          title: getComputedStyle(row.querySelector('.t-title')).color,
          subtitle: getComputedStyle(row.querySelector('.t-sub')).color,
        }));
        const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
          const s = v / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
        }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const background = luminance(active.background), subtitle = luminance(active.subtitle);
        active.subtitleContrast = (Math.max(background, subtitle) + .05) / (Math.min(background, subtitle) + .05);
        report.liunianActive = active;
        assert.ok(active.subtitleContrast >= 4.5, 'liunian active row subtitle remains readable: ' + JSON.stringify(active));
      }
      if (skin === 'ios') {
        await page.setViewportSize({ width: 390, height: 1000 });
        await settle(page);
        report.iosSearchFontSize = await page.locator('#search').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
        assert.ok(report.iosSearchFontSize >= 16, 'mobile OS skin search keeps a 16px input font');
      }
      if (skin === 'qingfeng') {
        await page.setViewportSize({ width: 320, height: 1000 });
        await settle(page);
        const geometry = await page.evaluate(() => {
          const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, width: r.width }; };
          return { width: innerWidth, pageWidth: document.scrollingElement.scrollWidth,
            topbar: rect(document.querySelector('.topbar')), brand: rect(document.querySelector('.qf-brand-group')),
            right: rect(document.querySelector('.top-right')), wordmark: getComputedStyle(document.querySelector('.brand-wordmark')).display,
            buttons: ['capsule-entry', 'theme-btn', 'skin-btn', 'top-more-btn'].map(id => {
              const el = document.getElementById(id), r = el.getBoundingClientRect();
              return { id, ...rect(el), hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
            }) };
        });
        report.geometry.push({ skin: 'qingfeng', ...geometry });
        assert.ok(geometry.pageWidth <= 321, 'qingfeng mobile has no document overflow');
        for (const button of geometry.buttons) assert.ok(button.x >= -1 && button.right <= 321 && button.hit,
          'qingfeng mobile ' + button.id + ' remains reachable: ' + JSON.stringify(button));
        await page.screenshot({ path: path.join(out, 'skin-qingfeng-320.png') });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await settle(page);
    }
    await navigate(page, 'library');
    await page.locator('#playpause').click({ trial: true });
    pass('native keyboard skin selection and alternate skin lifecycles preserve theme and singular app controls');

    const baseline = await page.evaluate(() => ({ stage: Stage3D.defaults(), creative: CreativeStage.preset() }));
    await page.locator('#stage3d-entry').click();
    await page.locator('#s3d-settings-toggle').click();
    await page.locator('#s3d-workshop').click();
    await page.locator('#workshop').waitFor({ state: 'visible' });
    await page.evaluate(() => Workshop.setTab('scene'));
    await page.locator('.ws-scene-card[data-scene="orb"]').click();
    await page.evaluate(() => Workshop.setTab('look'));
    for (const style of ['manga', 'anime']) {
      await page.locator('.ws-look-card[data-style="' + style + '"]').click();
      assert.equal(await page.locator('.ws-look-card[data-style="' + style + '"]').getAttribute('aria-pressed'), 'true');
      const look = await page.evaluate(() => CreativeStage.preset());
      assert.equal(look.hand.style, style);
      assert.ok(look.look.toon > 0);
      await page.screenshot({ path: path.join(out, 'workshop-' + style + '.png') });
    }
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await settle(page);
      const layout = await page.evaluate(() => {
        const r = el => { const box = el.getBoundingClientRect(); return { x: box.x, right: box.right, top: box.top, bottom: box.bottom }; };
        const body = document.getElementById('ws-body');
        return { width: innerWidth, document: document.scrollingElement.scrollWidth, panel: r(document.getElementById('workshop')),
          tabs: r(document.getElementById('ws-tabs')), selected: r(document.querySelector('#ws-tabs .ws-tab.on')),
          reset: r(document.getElementById('ws-defaults')), body: { client: body.clientWidth, scroll: body.scrollWidth } };
      });
      report.geometry.push({ workshop: true, ...layout });
      assert.ok(layout.document <= width + 1 && layout.panel.x >= -1 && layout.panel.right <= width + 1, width + ' workshop fits');
      assert.ok(layout.body.scroll <= layout.body.client + 1, width + ' workshop body fits');
      assert.ok(layout.selected.x >= layout.tabs.x - 1 && layout.selected.right <= layout.tabs.right + 1, width + ' active workshop tab stays visible');
      await page.locator('#ws-defaults').click({ trial: true });
      await page.screenshot({ path: path.join(out, 'workshop-' + width + '.png') });
    }
    await page.locator('.ws-look-card[data-style="manga"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => CreativeStage.preset().hand.style), 'manga');
    await page.locator('#ws-defaults').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('ws-defaults').getAttribute('aria-busy') !== 'true');
    assert.deepEqual(await page.evaluate(() => Stage3D.preferences()), baseline.stage);
    assert.deepEqual(await page.evaluate(() => CreativeStage.preset()), baseline.creative);
    assert.equal(await page.evaluate(() => Theme.current().id), 'celestial');
    await page.locator('#ws-close').click();
    await page.locator('#s3d-close').click();
    pass('celestial workshop manga/anime, narrow editor, native Enter and restored stage defaults');

    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigate(page, 'library');
    await page.evaluate(() => { document.getElementById('column').scrollTop = 0; document.getElementById('view-library').scrollTop = 0; });
    await page.screenshot({ path: path.join(out, 'final-desktop.png') });
    await verifyBrowserHealth(responseAudits);
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) {
      await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
      report.visibleFailureState = await page.locator('body').innerText().then(value => value.slice(0, 3000)).catch(() => 'unavailable');
      report.failureControls = await page.evaluate(() => ({ artist: document.getElementById('lib-artist-filter')?.value,
        album: document.getElementById('lib-album-filter')?.value, rows: document.querySelectorAll('#lib-list .track').length })).catch(() => null);
    }
    throw error;
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      try {
        await fixture.close();
        report.cleanup = { browserClosed: true, fixtureClosed: true, dataDirectoryRemoved: !fs.existsSync(fixture.dataDir) };
      } finally {
        fs.writeFileSync(path.join(out, finalCssOnly ? 'final-css-report.json' : 'report.json'), JSON.stringify(report, null, 2));
      }
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
