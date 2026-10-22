'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiUrl, uiToken } = require('./ui-token');

const root = path.resolve(__dirname, '..');
const base = process.env.PLAYER_UI_URL || 'http://127.0.0.1:18796';
const output = path.join(root, 'output/playwright/sidebar');
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; console.log('PASS ' + message); }

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: process.env.PLAYER_SOURCE_ASSETS === '1' ? ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] : [] });
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (process.env.PLAYER_SOURCE_ASSETS === '1') await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') {
        const response = await route.fetch();
        return route.fulfill({ response, contentType: 'text/html', body: fs.readFileSync(path.join(root, 'plugin/ui/index.html'), 'utf8').replaceAll('__VMUSIC_TOKEN_VALUE__', uiToken()) });
      }
      const file = path.join(root, 'plugin/ui', decodeURIComponent(url.pathname));
      if (!url.pathname.startsWith('/v1/') && fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file });
      return route.continue();
    });
    await page.goto(uiUrl(base));
    await page.waitForFunction(() => window.Skins && document.querySelector('.rail-item[data-view="queue"]').onclick);
    await page.waitForFunction(() => document.getElementById('conn').textContent === '\u670d\u52a1\u5df2\u8fde\u63a5');
    await page.locator('.rail-item[data-view="library"]').click();
    const toggle = page.locator('#rail-toggle');
    const width = () => page.locator('#rail').evaluate(el => el.getBoundingClientRect().width);
    const columnWidth = () => page.locator('#column').evaluate(el => el.getBoundingClientRect().width);
    const apply = async skin => {
      await page.evaluate(id => window.Skins.apply(id), skin);
      await page.waitForFunction(id => Array.from(document.querySelectorAll('link[data-skin-css]')).some(el => el.dataset.skinCss === id && !el.disabled && el.sheet), skin);
    };
    for (const skin of ['classic']) {
      await apply(skin);
      check(await toggle.isVisible(), skin + ' exposes sidebar toggle');
      const queue = page.locator('.rail-item[data-view="queue"]');
      const library = page.locator('.rail-item[data-view="library"]');
      const iconCenter = target => target.locator('svg').evaluate(el => { const r = el.getBoundingClientRect(); return (r.left + r.right) / 2; });
      const chromeless = el => { const cs = getComputedStyle(el); return cs.backgroundColor === 'rgba(0, 0, 0, 0)'
        && (cs.borderTopWidth === '0px' || cs.borderTopColor === 'rgba(0, 0, 0, 0)'); };
      check(await toggle.locator('span').isVisible(), skin + ' expanded toggle labels the section');
      check(Math.abs(await iconCenter(toggle) - await iconCenter(library)) <= 1, skin + ' expanded toggle sits in the navigation icon column');
      // hover 会给这行铺底色（两套皮肤都有），量基线前先把指针挪开并等过渡走完，
      // 否则读到的是上一轮点击留下的 hover 态。
      await page.mouse.move(4, 4);
      await page.waitForTimeout(350);
      check(await toggle.evaluate(chromeless), skin + ' expanded toggle carries no topbar chrome');
      const expanded = await width(), before = await columnWidth();
      check(expanded > 140 && await toggle.getAttribute('aria-expanded') === 'true', skin + ' starts expanded');
      await page.screenshot({ path: path.join(output, skin + '-expanded.png') });
      await toggle.click();
      check(await width() <= 76 && await columnWidth() > before + 80, skin + ' collapse gives space to content');
      check(await toggle.getAttribute('aria-expanded') === 'false' && await toggle.getAttribute('title') === '展开导航', skin + ' toggle describes expansion');
      check(!await toggle.locator('span').isVisible() && Math.abs(await iconCenter(toggle) - await iconCenter(queue)) <= 1, skin + ' collapsed toggle stays in the icon column');
      check(!await queue.locator('span').isVisible() && !!await queue.getAttribute('title'), skin + ' collapsed navigation keeps icon labels');
      await queue.click();
      check(await queue.evaluate(el => el.classList.contains('active')) && await page.locator('#view-queue').isVisible(), skin + ' collapsed navigation works');
      await page.evaluate(() => { const badge = document.getElementById('queue-badge'); badge.textContent = '20'; badge.hidden = false; });
      check(await queue.locator('svg').evaluate(el => {
        const rect = el.getBoundingClientRect(), rail = document.getElementById('rail').getBoundingClientRect();
        return rect.left >= rail.left && rect.right <= rail.right;
      }), skin + ' queue icon stays inside the rail');
      await page.screenshot({ path: path.join(output, skin + '-collapsed.png') });
      await page.reload();
      await page.waitForFunction(id => window.Skins?.currentId() === id && !!document.getElementById('rail-toggle')?.onclick, skin);
      await page.waitForFunction(() => document.getElementById('conn').textContent === '\u670d\u52a1\u5df2\u8fde\u63a5');
      check(await width() <= 76 && await toggle.getAttribute('aria-expanded') === 'false', skin + ' restores collapse after reload');
      await toggle.focus();
      await page.keyboard.press('Enter');
      check(await width() > 140 && await toggle.getAttribute('aria-expanded') === 'true', skin + ' expands with keyboard');
      await page.setViewportSize({ width: 1000, height: 768 });
      check(await width() > 140, skin + ' manual expansion survives narrow desktop');
      await toggle.click();
      await page.setViewportSize({ width: 1440, height: 900 });
      check(await width() <= 76, skin + ' manual collapse survives resize');
    }
    await apply('classic');
    check(await width() <= 76, 'classic remembers its own collapsed preference');
    await apply('qingfeng');
    check(!await toggle.isVisible(), 'other skins do not show the sidebar toggle');
    await apply('classic');
    check(await toggle.isVisible() && await width() <= 76, 'switching back restores sidebar state');
    check(errors.length === 0, 'no browser errors: ' + errors.join('; '));
    console.log(`${checks} sidebar checks passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
