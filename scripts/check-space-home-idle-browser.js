#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real home chrome, focus, pointer and touch behavior against local UI sources.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { readAssets } = require('./ui-assets');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/space-home-idle');

async function main() {
  const fixture = await startFixture();
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const assets = new Map(readAssets().map(asset => [asset.path, asset]));
    const errors = [];
    async function openHome(options = {}) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
      await fixture.connect(context);
      await context.route(fixture.base + '/**', async route => {
        const url = new URL(route.request().url());
        const asset = assets.get(url.pathname);
        if (asset) return route.fulfill({ status: 200,
          contentType: asset.mime === 'JS' ? 'application/javascript' : 'text/css',
          body: fs.readFileSync(asset.file) });
        if (url.pathname === '/') {
          const response = await route.fetch();
          const token = (await response.text()).match(/window\.__VMUSIC_TOKEN__\s*=\s*("[^"]+")/);
          assert.ok(token, 'authenticated fixture HTML');
          return route.fulfill({ response, body: fs.readFileSync(path.join(root, 'plugin/ui/index.html'), 'utf8')
            .replace('__VMUSIC_TOKEN_VALUE__', JSON.parse(token[1])) });
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('space3d').dataset.spReady === '1');
      await page.evaluate(() => Space3D.open());
      await page.waitForFunction(() => Space3D.stats().page === 'home' && document.getElementById('sp-warp').hidden);
      return page;
    }
    const page = await openHome();
    const hidden = () => page.locator('#space3d').evaluate(node => node.classList.contains('sp-home-idle'));
    const waitHidden = () => page.waitForFunction(() => document.getElementById('space3d').classList.contains('sp-home-idle'));
    fs.mkdirSync(output, { recursive: true });
    await page.mouse.move(700, 90);
    await page.screenshot({ path: path.join(output, 'visible.png') });
    await page.waitForTimeout(1800);
    await page.mouse.move(710, 90);
    await page.waitForTimeout(1700);
    assert.equal(await hidden(), false, 'movement restarts the idle delay');
    await waitHidden();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#sp-home').evaluate(node => node.inert), true, 'hidden cards cannot receive focus or clicks');
    assert.equal(await page.locator('#sp-home').isVisible(), false);
    assert.equal(await page.locator('#sh-query').isVisible(), true, 'search remains visible');
    assert.equal(await page.locator('#sp-page-toggle').isVisible(), true, 'navigation remains visible');
    await page.screenshot({ path: path.join(output, 'idle.png') });
    await page.mouse.move(720, 90);
    assert.equal(await hidden(), false, 'movement restores cards');
    assert.equal(await page.locator('#sp-home').evaluate(node => node.inert), false);
    await page.mouse.move(-5, -5);
    assert.equal(await hidden(), true, 'leaving the viewport immediately hides cards');
    await page.mouse.move(730, 90);
    assert.equal(await hidden(), false, 'reentry restores cards');
    await page.locator('.sh-quote-next').click();
    await waitHidden();
    await page.waitForTimeout(500);
    assert.equal(await hidden(), true, 'mouse focus losing access during hiding does not reveal cards again');
    await page.mouse.move(735, 90);

    await page.locator('.sh-action-library').click();
    await page.waitForTimeout(3400);
    assert.equal(await hidden(), false, 'an open library panel prevents hiding');
    assert.equal(await page.locator('.sh-panel-layer').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    await page.locator('.sh-action-library').focus();
    await page.waitForTimeout(3400);
    assert.equal(await hidden(), false, 'keyboard focus keeps cards available');

    await page.mouse.click(740, 90);
    await waitHidden();
    await page.evaluate(() => Space3D.enterStage());
    assert.equal(await hidden(), false, 'switching pages clears home idle');
    await page.evaluate(() => Space3D.goHome());
    assert.equal(await page.locator('#sp-home').evaluate(node => node.inert), false);
    await page.evaluate(() => Space3D.close());
    await page.evaluate(() => Space3D.open());
    assert.equal(await hidden(), false, 'reopening starts with visible cards');

    const touch = await openHome({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await touch.waitForTimeout(3400);
    assert.equal(await touch.locator('#space3d').evaluate(node => node.classList.contains('sp-home-idle')), false,
      'touch users retain access without mouse movement');
    await touch.locator('.sh-action-library').tap();
    assert.equal(await touch.locator('.sh-panel-layer').isVisible(), true);
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log('Space home idle: delay reset, fade, inert, leave/reentry, panels, keyboard, navigation and touch passed');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
