// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 字形引擎 G1 浏览器检查：SDF 渲染 vs 原生 fillText。
//
//   PLAYWRIGHT_MODULE=<path> node scripts/check-glyph-browser.js
//
// 判定口径见 plugin/ui/glyph-g1.html 顶部的注释：
//   - 重心偏移 ≤ 0.35px（衡量"整体挪位"）
//   - 面积比 0.91–1.09（衡量"变胖变瘦"）
//   - IoU ≥ 0.85（综合形状）
//
// 这是 G1 的硬闸门：过不去就该停下，退回 DOM 后端加 CSS，不要往 G2 走。
// "更差的字"会摧毁所有情绪表达，这不是打折而是归零。
//
// 缺 Playwright 时退出码 2（与其余 *-browser.js 一致：不是失败，是环境不足）。

'use strict';

const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const PAGE = path.join(root, 'plugin', 'ui', 'glyph-g1.html');
const OUT = path.join(root, 'output', 'glyph-g1');

const LIMITS = { centroidPx: 0.35, areaLo: 0.91, areaHi: 1.09, iou: 0.85 };

let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch (err) {
  console.log('SKIP 未安装 Playwright（' + (err.message || '').split('\n')[0] + '）');
  console.log('    安装后重跑：npx playwright install chromium');
  process.exit(2);
}

if (!fs.existsSync(PAGE)) {
  console.error('✗ 缺少比对页 ' + path.relative(root, PAGE));
  process.exit(1);
}

(async function main() {
  let browser = null;
  try {
    browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
      headless: process.env.GLYPH_HEADED !== '1'
    });
    const page = await browser.newPage({ viewport: { width: 1100, height: 420 }, deviceScaleFactor: 1 });

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto('file:///' + PAGE.replace(/\\/g, '/'));

    // 页面在脚本末尾写 window.__glyphG1；等它出现，而不是死等固定毫秒。
    await page.waitForFunction(() => window.__glyphG1 && window.__glyphG1.verdict !== 'running',
      null, { timeout: 15000 });

    const result = await page.evaluate(() => window.__glyphG1);
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'compare.png'), fullPage: true });
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(result, null, 2));

    let fails = 0;
    console.log('\nG1 · SDF 字形 vs fillText');
    for (const g of result.glyphs || []) {
      const bad = [];
      if (Math.abs(g.dxPx) > LIMITS.centroidPx) bad.push('dx ' + g.dxPx.toFixed(2));
      if (Math.abs(g.dyPx) > LIMITS.centroidPx) bad.push('dy ' + g.dyPx.toFixed(2));
      if (g.areaRatio < LIMITS.areaLo || g.areaRatio > LIMITS.areaHi) bad.push('area ' + g.areaRatio.toFixed(3));
      if (g.iou < LIMITS.iou) bad.push('iou ' + g.iou.toFixed(3));
      const line = '  ' + g.glyph + '  iou ' + g.iou.toFixed(3) +
        '  area ' + g.areaRatio.toFixed(3) +
        '  d ' + g.dxPx.toFixed(2) + ',' + g.dyPx.toFixed(2) + 'px';
      if (bad.length) { fails += 1; console.error('✗' + line + '  ← ' + bad.join('，')); }
      else console.log('✓' + line);
    }

    if (result.verdict === 'ERROR') {
      console.error('\n✗ 引擎未能出图：' + (result.fails || []).join('；'));
      process.exit(1);
    }
    if (errors.length) {
      console.error('\n✗ 页面异常：' + errors.join('；'));
      process.exit(1);
    }
    if (fails) {
      console.error('\n✗ ' + fails + ' 个字素未达 G1 门槛');
      console.error('  按设计文档 §12：G1 不过就停，不要继续 G2。');
      process.exit(1);
    }

    console.log('\n✓ G1 通过（证据：' + path.relative(root, OUT) + '）');
    process.exit(0);
  } catch (err) {
    console.error('✗ ' + (err && err.message || err));
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();
