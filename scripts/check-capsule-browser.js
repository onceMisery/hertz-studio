// SPDX-License-Identifier: MIT
// Source-only layout regression; no running service or native DBX host required.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = path.resolve(__dirname, '../plugin/ui');
const output = path.resolve(__dirname, '../output/playwright/capsule');
const skins = ['orbit', 'classic', 'sheen', 'liunian', 'qingfeng', 'chaoxi', 'heijiao'];
const source = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const html = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
const app = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
const fit = app.slice(app.indexOf('function fitFloatingWindowToCapsule()'), app.indexOf('/// 最小化 / 展开。'));

function contrast(foreground, background) {
  const luminance = color => {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => {
      n /= 255;
      return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
    });
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const engine = process.env.CAPSULE_BROWSER || 'chromium';
  const launchOptions = { headless: true };
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  const browser = await playwright[engine].launch(launchOptions);
  const evidence = [];
  try {
    for (const scale of [1, 2]) {
      const context = await browser.newContext({ viewport: { width: 268, height: 55 }, deviceScaleFactor: scale });
      const page = await context.newPage();
      await page.route('http://capsule.test/**', route => {
        const file = path.resolve(web, '.' + new URL(route.request().url()).pathname);
        if (route.request().url() === 'http://capsule.test/') return route.fulfill({ contentType: 'text/html', body: html });
        if (!file.startsWith(web + path.sep) || !fs.existsSync(file)) return route.abort();
        return route.fulfill({ path: file });
      });
      await page.goto('http://capsule.test/');
      await page.addScriptTag({ path: path.join(web, 'themes.js') });
      await page.evaluate(fit => {
        window.ui = { capsule: document.getElementById('capsule') };
        window.dbxPlugin = { floating: { setSize: (width, height) => {
          window.requestedSize = { width, height };
          return Promise.resolve();
        } } };
        (0, eval)(fit);
        document.getElementById('capsule-title').textContent = '完整显示的歌曲标题';
        document.getElementById('capsule-artist').textContent = 'Laufey · From The Start';
      }, fit);
      for (const skin of skins) {
        for (const theme of ['mineral', 'orbit-fog']) {
          const label = `${engine}/${skin}/${theme}/dpr${scale}`;
          await page.setViewportSize({ width: 268, height: 55 });
          await page.evaluate(({ skin, theme }) => {
            document.documentElement.dataset.skin = skin;
            document.querySelectorAll('[data-skin-css]').forEach(link => { link.disabled = link.dataset.skinCss !== skin; });
            Theme.apply(theme);
            document.body.classList.remove('is-floating-capsule');
            document.documentElement.classList.add('hertz-floating-preboot');
          }, { skin, theme });
          assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).padding), '0px', label + ' preboot has no skin padding');
          await page.evaluate(() => {
            document.body.classList.add('is-floating-capsule', 'is-playing');
            ui.capsule.hidden = false;
            fitFloatingWindowToCapsule();
          });
          await page.setViewportSize(await page.evaluate(() => requestedSize));
          const layout = await page.evaluate(() => {
            const capsule = ui.capsule.getBoundingClientRect();
            const selectors = ['.capsule-art', '.capsule-label', '.capsule-line-title', '.capsule-line-artist', '.capsule-btn'];
            const children = selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(el => ({
              selector, rect: el.getBoundingClientRect().toJSON(), color: getComputedStyle(el).color,
            })));
            return { rect: capsule.toJSON(), viewport: { width: innerWidth, height: innerHeight }, children,
              background: getComputedStyle(ui.capsule).backgroundColor,
              bodyBackground: getComputedStyle(document.body).backgroundColor };
          });
          evidence.push({ label, ...layout });
          assert.equal(layout.rect.x, 0, label + ' starts at left edge');
          assert.equal(layout.rect.y, 0, label + ' starts at top edge');
          assert.ok(layout.rect.right <= layout.viewport.width && layout.rect.bottom <= layout.viewport.height, label + ' entire card fits native requested size');
          assert.equal(layout.background, layout.bodyBackground, label + ' card and window share background');
          for (const child of layout.children) {
            assert.ok(child.rect.x >= 0 && child.rect.y >= 0 && child.rect.right <= layout.viewport.width && child.rect.bottom <= layout.viewport.height,
              label + ' fits ' + child.selector);
            if (child.selector !== '.capsule-art' && child.selector !== '.capsule-btn') {
              assert.ok(contrast(child.color, layout.background) >= 4.5, label + ' readable ' + child.selector);
            }
          }
          if (skin === 'orbit' && scale === 2) await page.screenshot({ path: path.join(output, `${engine}-${theme}.png`) });
          // Active mode must also be independent of the temporary preboot marker.
          await page.evaluate(() => document.documentElement.classList.remove('hertz-floating-preboot'));
          assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).padding), '0px', label + ' active mode has no skin padding');
          console.log('PASS ' + label);
        }
      }
      await context.close();
    }
    fs.writeFileSync(path.join(output, `${engine}-evidence.json`), JSON.stringify(evidence, null, 2));
    console.log(`Capsule: ${evidence.length} layouts passed.`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
