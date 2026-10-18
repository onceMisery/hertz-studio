// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 字形引擎 G2 浏览器检查：粗细扫描、字怀检查、五种情绪效果图。
//
//   PLAYWRIGHT_MODULE=<path> node scripts/check-glyph-g2.js
//
// 产物：
//   output/glyph-g2/page.png      整页（含结果 JSON）
//   output/glyph-g2/sweep.png     粗细扫描画布
//   output/glyph-g2/emotion.png   五种情绪画布
//   output/glyph-g2/report.json   原始结果 + 页面错误
//
// 缺 Playwright 时退出码 2（与其余 *-browser.js 一致：不是失败，是环境不足）。

'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const PAGE = path.join(root, 'plugin', 'ui', 'glyph-g2.html');
const OUT = path.join(root, 'output', 'glyph-g2');

const SUPPORTED_W_MIN = 0.30;
// 0.62 以上会把「鬱」等密集字的字怀填掉，情绪场不使用。
const SUPPORTED_W_MAX = 0.62;
const EXPECTED_HOLES = { '口': 1, '回': 2 };

let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch (err) {
  console.log('SKIP 未安装 Playwright（' + (err.message || '').split('\n')[0] + '）');
  console.log('    安装后重跑：npx playwright install chromium');
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
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });

    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto(pathToFileURL(PAGE).href);
    await page.waitForFunction(
      () => window.__glyphG2 && window.__glyphG2.verdict !== 'running',
      null,
      { timeout: 60000 }
    );

    const result = await page.evaluate(() => window.__glyphG2);
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'page.png'), fullPage: true });
    await page.locator('#sweep').screenshot({ path: path.join(OUT, 'sweep.png') });
    await page.locator('#emotion').screenshot({ path: path.join(OUT, 'emotion.png') });

    const supported = (result.sweep || []).filter((s) => s.w >= SUPPORTED_W_MIN && s.w <= SUPPORTED_W_MAX);
    const problems = [];
    for (const s of supported) {
      if (!(s.area > 0)) problems.push(`${s.glyph} 在 w=${s.w} 无墨`);
      const expected = EXPECTED_HOLES[s.glyph];
      if (expected != null && s.holes !== expected) {
        problems.push(`${s.glyph} 在 w=${s.w} 字怀 ${s.holes}（应为 ${expected}）`);
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      page: path.relative(root, PAGE),
      viewport: { width: 1600, height: 1200 },
      supportedRange: { min: SUPPORTED_W_MIN, max: SUPPORTED_W_MAX },
      result,
      supportedProblems: problems,
      pageErrors,
      consoleErrors,
    };
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

    console.log('\nG2 · 粗细场与情绪场');
    if (result.calibration) {
      const c = result.calibration;
      console.log('  端点校准 thin error: ' + c.thinMeanError +
        '  thick error: ' + c.thickMeanError);
    } else {
      console.log('  校准: 缺失');
    }

    console.log('\n  粗细扫描（支持区间 ' + SUPPORTED_W_MIN + '–' + SUPPORTED_W_MAX + '）');
    for (const s of supported) {
      console.log(`  ${s.glyph}  w ${s.w.toFixed(2)}  holes ${s.holes}  area ${s.area}`);
    }

    console.log('\n  情绪场');
    for (const e of result.emotion || []) {
      console.log(`  ${e.id.padEnd(8)} baseline ${e.baselineMaxPx}px  weight span ${e.weightSpan}  shear ${e.shearDeg}°`);
    }

    if (result.fails && result.fails.length) {
      console.log('\n  页面 fails:');
      for (const f of result.fails) console.log('    - ' + f);
    }
    if (problems.length) {
      console.log('\n  支持区间问题:');
      for (const p of problems) console.log('    - ' + p);
    }
    if (pageErrors.length) console.log('\n  页面异常: ' + pageErrors.join('；'));
    if (consoleErrors.length) console.log('\n  console errors: ' + consoleErrors.join('；'));

    const failed = result.verdict !== 'PASS' || problems.length > 0 || pageErrors.length > 0;
    console.log('\n  证据: ' + path.relative(root, OUT));
    if (failed) {
      console.error('✗ G2 未通过');
      process.exit(1);
    }
    console.log('✓ G2 通过');
    process.exit(0);
  } catch (err) {
    console.error('✗ ' + (err && err.message || err));
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();
