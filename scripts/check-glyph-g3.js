// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 字形引擎 G3 浏览器检查：真实 StanzaGlyph 渲染五种情绪场。
//
//   PLAYWRIGHT_MODULE=<path> node scripts/check-glyph-g3.js
//
// 产物：
//   output/glyph-g3/effects.png    五情绪总览
//   output/glyph-g3/g3-<id>.png   单行特写
//   output/glyph-g3/report.json   情绪场参数与页面错误
//
// 缺 Playwright 时退出码 2。

'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const PAGE = path.join(root, 'plugin', 'ui', 'glyph-g3.html');
const OUT = path.join(root, 'output', 'glyph-g3');

let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch (err) {
  console.log('SKIP 未安装 Playwright（' + (err.message || '').split('\n')[0] + '）');
  process.exit(2);
}

if (!fs.existsSync(PAGE)) {
  console.error('✗ 缺少检查页 ' + path.relative(root, PAGE));
  process.exit(1);
}

(async function main() {
  let browser = null;
  try {
    browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
      headless: process.env.GLYPH_HEADED !== '1',
      args: ['--enable-unsafe-swiftshader']
    });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto(pathToFileURL(PAGE).href);
    await page.waitForFunction(
      () => window.__glyphG3 && window.__glyphG3.verdict !== 'running',
      null,
      { timeout: 30000 }
    );

    const result = await page.evaluate(() => window.__glyphG3);
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'effects.png'), fullPage: true });
    const shots = [];
    for (const row of result.rows || []) {
      const file = path.join(OUT, 'g3-' + row.id + '.png');
      await page.locator('#g3-stage-' + row.id).screenshot({ path: file });
      shots.push({ id: row.id, file: path.relative(root, file), bytes: fs.statSync(file).size });
    }

    const report = {
      generatedAt: new Date().toISOString(),
      page: path.relative(root, PAGE),
      result,
      screenshots: shots,
      pageErrors,
      consoleErrors
    };
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

    console.log('\nG3 · 情绪场 × 字形引擎');
    for (const row of result.rows || []) {
      console.log(`  ${row.id.padEnd(8)} anchor ${row.anchor.toFixed(3)}  baseline ${row.baselineMaxPx}px  weight ${row.weightSpan}  shearTan ${row.shearTan}`);
    }
    if (pageErrors.length) console.log('\n  页面异常: ' + pageErrors.join('；'));
    if (consoleErrors.length) console.log('\n  console errors: ' + consoleErrors.join('；'));
    console.log('\n  证据: ' + path.relative(root, OUT));

    const rowsOk = Array.isArray(result.rows) && result.rows.length === 5;
    const shotsOk = shots.every((s) => s.bytes > 1024);
    if (result.verdict !== 'PASS' || !rowsOk || !shotsOk || pageErrors.length) {
      console.error('✗ G3 未通过');
      process.exit(1);
    }
    console.log('✓ G3 通过');
    process.exit(0);
  } catch (err) {
    console.error('✗ ' + (err && err.message || err));
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();
