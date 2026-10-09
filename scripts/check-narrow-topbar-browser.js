// SPDX-License-Identifier: MIT
// Real layout/click regression. Build first, then run with Playwright on NODE_PATH.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');

const OUT = process.env.SKIN_SHOT_DIR || 'output/playwright/narrow-topbar';
const WIDTHS = [320, 330, 390, 620, 621, 700, 1440];
const BUTTONS = ['capsule-entry', 'stage3d-entry', 'settings-entry', 'theme-btn', 'skin-btn', 'top-more-btn', 'online-account-btn'];
const results = [];
let failures = 0;
function check(condition, label, details) {
  if (!condition) { failures++; console.error('FAIL ' + label + ' ' + JSON.stringify(details)); }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const fixture = await startFixture();
  let browser;
  try {
    await fixture.seed();
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await fixture.connect(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Skins && document.querySelector('#conn.ok'));
    await page.evaluate(() => document.fonts.ready);
    const skins = await page.evaluate(() => Skins.list().map(s => s.id));
    for (const skin of skins) {
      await page.evaluate(id => Skins.apply(id), skin);
      await page.waitForFunction(id => id === 'classic' || !!document.querySelector('link[data-skin-css="' + id + '"]').sheet, skin);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.mouse.move(0, 899);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const geometry = await page.evaluate(ids => {
          const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height }; };
          const doc = document.scrollingElement;
          window.scrollTo(10000, 0);
          const scrollX = window.scrollX;
          window.scrollTo(0, 0);
          return { client: doc.clientWidth, scroll: doc.scrollWidth, scrollX,
            topbar: rect(document.querySelector('.topbar')), app: rect(document.querySelector('.app')),
            search: rect(document.getElementById('search')),
            buttons: ids.map(id => {
              const e = document.getElementById(id), r = rect(e);
              const hit = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2);
              return { id, ...r, hit: !!hit && e.contains(hit) };
            }),
          };
        }, BUTTONS);
        const label = skin + '/' + width;
        results.push({ skin, width, ...geometry });
        check(geometry.scroll <= geometry.client && geometry.scrollX === 0, label + ' page overflow', geometry);
        check(geometry.app.y >= geometry.topbar.bottom - 1, label + ' content below header', geometry);
        for (const b of geometry.buttons) {
          // Qingfeng exposes these actions through its own toolbar/menu.
          if (b.w === 0 && (skin === 'qingfeng' || (skin === 'ios' && b.id === 'settings-entry') ||
            (skin === 'sheen' && b.id === 'skin-btn' && width <= 1100))) continue;
          check(b.w >= 30 && b.h >= 32 && b.x >= 0 && b.right <= width && b.hit,
            label + ' button reachable', b);
        }
        if (!['qingfeng', 'sheen'].includes(skin)) {
          check(geometry.search.w >= 100, label + ' usable search width', geometry.search);
          if (width <= 620) check(geometry.search.y >= Math.max(...geometry.buttons.map(b => b.bottom)),
            label + ' search in second row', geometry);
        }
        // Trial clicks check the browser's actual pointer actionability without firing
        // fullscreen/capsule actions, which would change the page under test.
        for (const b of geometry.buttons.filter(b => b.hit && b.w > 0)) {
          await page.locator('#' + b.id).click({ trial: true, timeout: 3000 });
        }
        for (const [button, menu] of [['theme-btn', 'theme-menu'], ['skin-btn', 'skin-menu'], ['top-more-btn', 'top-more-menu']]) {
          if (!geometry.buttons.find(b => b.id === button && b.hit)) continue;
          await page.locator('#' + button).click();
          await page.locator('#' + menu).waitFor({ state: 'visible' });
          await page.locator('#' + menu).evaluate(async e => {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            await Promise.all(e.getAnimations().map(a => a.finished.catch(() => {})));
          });
          const bounds = await page.locator('#' + menu).evaluate(e => {
            const r = e.getBoundingClientRect();
            const item = e.querySelector('button, [role="option"], [role="menuitem"]');
            const b = item && item.getBoundingClientRect();
            return { x: r.x, right: r.right, bottom: r.bottom, inlineLeft: e.style.left,
              hit: b && item.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)) };
          });
          check(bounds.x >= 0 && bounds.right <= width && bounds.bottom <= 900 && bounds.hit,
            label + ' menu reachable ' + menu, bounds);
          await page.keyboard.press('Escape');
          if (await page.locator('#' + menu).isVisible()) await page.locator('#' + button).click();
        }
        if (skin !== 'qingfeng') {
          await page.locator('#search').blur();
          await page.keyboard.press('/');
          await page.locator('#search').waitFor({ state: 'visible' });
          const search = await page.locator('#search').evaluate(e => ({ focused: document.activeElement === e, width: e.getBoundingClientRect().width }));
          check(search.focused && search.width >= 100, label + ' search shortcut', search);
          await page.locator('#search').click();
          await page.locator('.ts-menu').waitFor({ state: 'visible' });
          const menu = await page.locator('.ts-menu').evaluate(e => {
            const r = e.getBoundingClientRect(), input = document.getElementById('search').getBoundingClientRect();
            return { x: r.x, right: r.right, top: r.top, inputBottom: input.bottom };
          });
          check(menu.x >= 0 && menu.right <= width && menu.top >= menu.inputBottom,
            label + ' search popup anchored', menu);
          await page.keyboard.press('Escape');
          await page.locator('#search').blur();
          await page.mouse.click(1, 1);
        }
        if ([320, 390, 1440].includes(width)) await page.screenshot({ path: path.join(OUT, skin + '-' + width + '.png'), animations: 'disabled' });
        console.log(label + ': overflow=' + (geometry.scroll - geometry.client) + 'px');
      }
    }
    check(errors.length === 0, 'no page errors', errors);
    fs.writeFileSync(path.join(OUT, 'geometry.json'), JSON.stringify({ results, errors, failures }, null, 2));
    console.log(results.length + ' skin/width cases; ' + failures + ' failures');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
