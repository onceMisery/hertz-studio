// SPDX-License-Identifier: MIT
// Zodiac observatory integration: HUD content, star hover/pin, parallax,
// console parameter wiring and lifecycle visibility. Runs against disk assets.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { readAssets } = require('./ui-assets');
const { uiUrl } = require('./ui-token');

const root = path.resolve(__dirname, '..'), web = path.join(root, 'plugin/ui');
const output = path.join(root, 'output/playwright/zodiac-observatory');

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const assets = new Map(readAssets().map(asset => [asset.path, asset]));
  const fixture = await startFixture();
  process.env.VMUSIC_DATA_DIR = fixture.dataDir;
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  const errors = [], report = {};
  try {
    const context = await browser.newContext({ viewport: { width: 1707, height: 898 }, deviceScaleFactor: 1 });
    await fixture.connect(context);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== fixture.base) return route.continue();
      if (url.pathname === '/') {
        const response = await route.fetch(), html = await response.text();
        const token = html.match(/window\.__VMUSIC_TOKEN__\s*=\s*("[^"]+")/);
        if (!token) return route.fulfill({ response, body: html });
        return route.fulfill({ response, body: fs.readFileSync(path.join(web, 'index.html'), 'utf8')
          .replace('__VMUSIC_TOKEN_VALUE__', JSON.parse(token[1])) });
      }
      if (assets.has(url.pathname)) {
        const asset = assets.get(url.pathname);
        return route.fulfill({ status: 200, contentType: asset.mime === 'JS' ? 'application/javascript' : asset.mime === 'CSS' ? 'text/css' : undefined,
          body: fs.readFileSync(asset.file) });
      }
      if (url.pathname.startsWith('/space-scene-preview/')) return route.fulfill({ status: 200, contentType: 'image/jpeg',
        body: fs.readFileSync(path.join(web, url.pathname)) });
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(uiUrl(fixture.base), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Space3D && document.getElementById('space3d').dataset.spReady === '1');
    await page.evaluate(() => {
      const original = Stage.presentation.bind(Stage);
      Stage.presentation = () => ({ ...original(), track: { id: 'zodiac-observatory', title: 'Starlight', artist: 'Hertz Studio' },
        playing: true, position: 7000, duration: 240000, cover: '' });
      Stage.spectrum = () => new Float32Array(64).fill(.12);
      Space3D.configure({ ...Space3D.preferences(), sceneSource: 'zodiac', lyrics: false, cinema: false });
      Space3D.open('zodiac');
    });
    await page.waitForFunction(() => Space3D.stats().renderer?.state === 'ready');
    await page.evaluate(() => Space3D.enterStage('zodiac'));
    await page.waitForFunction(() => Space3D.stats().page === 'stage' && Space3D.stats().renderer?.id === 'zodiac');
    await page.waitForFunction(() => {
      const primary = Space3D.stats().renderer?.sceneStats?.primary;
      return primary && primary.state === 'hold' && primary.figureAlpha > .9;
    }, null, { timeout: 15000 });
    await page.waitForTimeout(180);
    await page.screenshot({ path: path.join(output, 'shower.png') });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(output, 'stage.png') });
    const ready = await page.evaluate(() => {
      const hud = document.getElementById('sp-zodiac-hud');
      const primary = Space3D.stats().renderer.sceneStats.primary;
      return { visible: !hud.hidden, name: document.getElementById('sp-zodiac-name').textContent,
        latin: document.getElementById('sp-zodiac-latin').textContent, meta: document.getElementById('sp-zodiac-meta').textContent,
        ticks: document.querySelectorAll('#sp-zodiac-ticks i').length,
        activeTicks: document.querySelectorAll('#sp-zodiac-ticks i.is-on').length, primary };
    });
    report.ready = { visible: ready.visible, name: ready.name, meta: ready.meta, ticks: ready.ticks, activeTicks: ready.activeTicks };
    assert.equal(ready.visible, true, 'zodiac HUD is visible on the stage');
    assert.equal(ready.name, ready.primary.signCn, 'HUD follows the rendered sign');
    assert.equal(ready.ticks, 12, 'HUD shows twelve zodiac ticks');
    assert.equal(ready.activeTicks, 1, 'exactly one tick is current');
    assert.ok(ready.primary.stars.length >= 6, 'sign exposes projected star positions');
    const target = ready.primary.stars.slice().sort((a, b) => b.magnitude - a.magnitude)[0];
    await page.mouse.move(target.px, target.py);
    await page.waitForFunction(index => {
      const card = document.getElementById('sp-zodiac-star');
      return !card.hidden && Space3D.stats().renderer.sceneStats.primary.hover === index;
    }, target.index, { timeout: 5000 });
    const hover = await page.evaluate(() => {
      const card = document.getElementById('sp-zodiac-star');
      return { hidden: card.hidden, name: document.getElementById('sp-zodiac-star-name').textContent,
        meta: document.getElementById('sp-zodiac-star-meta').textContent, pinned: card.classList.contains('is-pinned'),
        left: card.style.left, top: card.style.top };
    });
    report.hover = hover;
    assert.equal(hover.hidden, false, 'hover opens the star card');
    assert.equal(hover.name, '主星 ' + String(target.index + 1).padStart(2, '0'), 'star card names the hovered star');
    assert.match(hover.meta, /亮度 .* 连线 /, 'star card exposes magnitude and link count');
    assert.equal(hover.pinned, false, 'hover is not pinned');
    await page.screenshot({ path: path.join(output, 'hover.png') });
    await page.waitForTimeout(450);
    const currentTarget = await page.evaluate(index => Space3D.stats().renderer.sceneStats.primary.stars.find(star => star.index === index), target.index);
    await page.mouse.move(currentTarget.px, currentTarget.py);
    await page.waitForTimeout(250);
    await page.mouse.click(currentTarget.px, currentTarget.py);
    await page.waitForFunction(() => document.getElementById('sp-zodiac-star').classList.contains('is-pinned'));
    const pinned = await page.evaluate(() => ({ pinned: document.getElementById('sp-zodiac-star').classList.contains('is-pinned'),
      name: document.getElementById('sp-zodiac-star-name').textContent }));
    report.pinned = pinned;
    assert.equal(pinned.pinned, true, 'click pins the star card');
    await page.mouse.move(100, 700);
    await page.waitForTimeout(2900);
    assert.equal(await page.evaluate(() => document.getElementById('sp-zodiac-star').hidden), true, 'pinned card expires');

    const parallax = await (async () => {
      await page.mouse.move(850, 500);
      await page.waitForTimeout(700);
      const a = await page.evaluate(() => Space3D.stats().renderer.sceneStats.primary.stars[0].px);
      await page.mouse.move(1500, 500);
      await page.waitForTimeout(700);
      const b = await page.evaluate(() => Space3D.stats().renderer.sceneStats.primary.stars[0].px);
      await page.mouse.move(850, 500);
      await page.waitForTimeout(500);
      return { a, b, delta: Math.abs(b - a) };
    })();
    report.parallax = parallax;
    assert.ok(parallax.delta > 1, 'pointer movement shifts the figure against the sky');

    await page.locator('#sp-console-toggle').click();
    await page.waitForFunction(() => !document.getElementById('sp-sheet').hidden && document.getElementById('sp-sheet').classList.contains('sp-show'));
    const consoleBlock = await page.evaluate(() => ({
      hidden: document.getElementById('sp-zodiac-console').hidden,
      name: document.getElementById('sp-zodiac-console-name').textContent,
      currentSign: Space3D.stats().renderer.sceneStats.primary.signCn,
      meta: document.getElementById('sp-zodiac-console-meta').textContent,
      meteors: !!document.getElementById('sp-param-meteors')
    }));
    report.console = consoleBlock;
    assert.equal(consoleBlock.hidden, false, 'console shows the zodiac dossier');
    assert.equal(consoleBlock.name, consoleBlock.currentSign, 'console dossier follows the currently rendered sign');
    assert.equal(consoleBlock.meteors, true, 'console exposes the meteor density control');
    await page.screenshot({ path: path.join(output, 'console.png') });
    await page.evaluate(() => { const input = document.getElementById('sp-param-meteors'); input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => Space3D.stats().renderer.sceneStats.primary.meteorDensity === 0);
    await page.evaluate(() => { const input = document.getElementById('sp-param-meteors'); input.value = '1'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => Space3D.stats().renderer.sceneStats.primary.meteorDensity === 1);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('sp-sheet').classList.contains('sp-show'));

    await page.evaluate(() => Space3D.goHome());
    await page.waitForFunction(() => Space3D.stats().page === 'home');
    assert.equal(await page.evaluate(() => document.getElementById('sp-zodiac-hud').hidden), true, 'home hides the HUD');
    await page.evaluate(() => Space3D.enterStage('zodiac'));
    await page.waitForFunction(() => Space3D.stats().renderer?.state === 'ready');
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.getElementById('sp-zodiac-hud').hidden), false, 'returning to zodiac restores the HUD');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const primary = Space3D.stats().renderer?.sceneStats?.primary;
      return primary && primary.state === 'hold' && primary.figureAlpha > .9;
    }, null, { timeout: 15000 });
    await page.waitForTimeout(600);
    const mobile = await page.evaluate(() => {
      const hud = document.getElementById('sp-zodiac-hud'), rect = hud.getBoundingClientRect();
      return { visible: !hud.hidden, width: rect.width, top: rect.top, right: rect.right,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    report.mobile = mobile;
    assert.equal(mobile.visible, true, 'mobile keeps the zodiac title');
    assert.ok(mobile.width > 40 && mobile.top < 160 && mobile.right <= 390, 'mobile HUD stays inside the viewport');
    assert.equal(mobile.overflow, false, 'mobile stage has no horizontal overflow');
    await page.screenshot({ path: path.join(output, 'mobile.png') });
    await page.setViewportSize({ width: 1707, height: 898 });
    await page.waitForTimeout(300);
    await page.evaluate(() => Space3D.setSource('coast'));
    await page.waitForFunction(() => Space3D.stats().renderer?.state === 'ready' && Space3D.sourceId() === 'coast');
    assert.equal(await page.evaluate(() => document.getElementById('sp-zodiac-hud').hidden), true, 'other scenes hide the HUD');
    assert.deepEqual(errors, [], 'no page or shader errors');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ report, errors }, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log('PASS zodiac observatory HUD, hover/pin, parallax, console and visibility');
  } finally {
    await browser.close();
    await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
