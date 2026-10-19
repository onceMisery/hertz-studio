// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 3D 歌词轨情绪层检查：独立夹具，验证当前行的场位移、配色、字重/字距。
//   PLAYWRIGHT_MODULE=<path> node scripts/check-emotion-track-browser.js

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.join(__dirname, '..');
const PAGE = path.join(root, 'plugin', 'ui', 'emotion-track-check.html');
const OUT = path.join(root, 'output', 'emotion-track');

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
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pathToFileURL(PAGE).href);
    await page.waitForFunction(() => window.__trackCheck && window.__trackCheck.ready, null, { timeout: 30000 });

    const snapshots = {};
    for (const id of ['joy', 'sorrow', 'anger']) {
      const snap = await page.evaluate((emotion) => window.__trackCheck.select(emotion), id);
      if (!snap || snap.emotion !== id || snap.active !== 'true') throw new Error(id + ' 未写入当前行');
      if (!snap.dy.length || !snap.dy.every((v) => /^-?\d+(\.\d+)?px$/.test(v))) throw new Error(id + ' --emo-dy 非法');
      if (!snap.dy.some((v) => Math.abs(parseFloat(v)) > 0.01)) throw new Error(id + ' 场位移全为 0');
      if (!snap.translate.some((v) => v && v !== 'none')) throw new Error(id + ' 无 translate');
      const weight = id === 'sorrow' ? '400' : '700';
      if (snap.weight !== weight) throw new Error(id + ' 字重 ' + snap.weight + ' != ' + weight);
      if (id === 'anger' ? !(parseFloat(snap.spacing) < 0) : !(parseFloat(snap.spacing) > 0)) {
        throw new Error(id + ' 字距异常：' + snap.spacing);
      }
      if (snap.lineColor !== rgb(snap.palette.ink)) throw new Error(id + ' 行色未映射：' + snap.lineColor);
      if (!snap.bg || snap.bg.indexOf(rgb(snap.palette.accent)) < 0) throw new Error(id + ' 活动渐变未使用强调色');
      snapshots[id] = snap;
      await page.screenshot({ path: path.join(OUT, id + '.png'), fullPage: false });
    }
    const neutral = await page.evaluate(() => window.__trackCheck.select('neutral'));
    if (!neutral || neutral.emotion || neutral.translate.some((v) => v !== 'none')) {
      throw new Error('neutral 未清除情绪：' + JSON.stringify(neutral));
    }
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), snapshots, neutral, pageErrors: errors
    }, null, 2));

    console.log('✓ 3D 歌词轨：joy/sorrow/anger 当前行场位移、translate、配色、字重/字距；neutral 清除');
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
