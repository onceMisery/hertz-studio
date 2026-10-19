// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 心象 cadenza 情绪层检查：当前行场位移、配色、字重/字距，清除后恢复。
//   PLAYWRIGHT_MODULE=<path> node scripts/check-emotion-cadenza-browser.js

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.join(__dirname, '..');
const PAGE = path.join(root, 'plugin', 'ui', 'cadenza-emotion-check.html');
const OUT = path.join(root, 'output', 'emotion-cadenza');

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgb(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ')';
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    headless: process.env.GLYPH_HEADED !== '1'
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pathToFileURL(PAGE).href);
    await page.waitForFunction(() => window.__cadenzaCheck && window.__cadenzaCheck.ready, null, { timeout: 30000 });
    const snapshots = {};
    for (const id of ['joy', 'sorrow', 'anger']) {
      const snap = await page.evaluate((emotion) => window.__cadenzaCheck.select(emotion), id);
      if (!snap || snap.emotion !== id || !snap.count) throw new Error(id + ' 未写入 cadenza');
      if (!snap.dy.some((v) => Math.abs(parseFloat(v)) > 0.01)) throw new Error(id + ' 场位移全为 0');
      if (!snap.translate.some((v) => v && v !== 'none')) throw new Error(id + ' 无 translate');
      const weight = id === 'sorrow' ? '400' : '700';
      if (snap.weight !== weight) throw new Error(id + ' 字重 ' + snap.weight + ' != ' + weight);
      if (id === 'anger' ? !(parseFloat(snap.spacing) < 0) : !(parseFloat(snap.spacing) > 0)) {
        throw new Error(id + ' 字距异常：' + snap.spacing);
      }
      if (snap.activeColor !== rgb(snap.palette.accent)) throw new Error(id + ' 活动色未映射');
      if (snap.waitingColor !== rgb(snap.palette.ink)) throw new Error(id + ' 等待色未映射');
      snapshots[id] = snap;
      await page.screenshot({ path: path.join(OUT, id + '.png'), fullPage: false });
    }
    const neutral = await page.evaluate(() => window.__cadenzaCheck.select('neutral'));
    if (neutral) throw new Error('neutral 未清除 cadenza 情绪：' + JSON.stringify(neutral));
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), snapshots, neutral, pageErrors: errors
    }, null, 2));
    console.log('✓ 心象 cadenza：joy/sorrow/anger 场位移、translate、配色、字重/字距；neutral 清除');
    console.log('  weights ' + [snapshots.joy.weight, snapshots.sorrow.weight, snapshots.anger.weight].join('/') +
      '  spacing ' + [snapshots.joy.spacing, snapshots.sorrow.spacing, snapshots.anger.spacing].join('/'));
    if (errors.length) throw new Error('页面异常：' + errors.join('；'));
    console.log('  证据: ' + path.relative(root, OUT));
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((err) => {
  console.error('✗ ' + (err && err.message || err));
  process.exit(1);
});
