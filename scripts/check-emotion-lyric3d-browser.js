// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// GL 歌词图集情绪层检查：当前行按情绪取字重/配色/基线，签名随情绪变化。
//   PLAYWRIGHT_MODULE=<path> node scripts/check-emotion-lyric3d-browser.js

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.join(__dirname, '..');
const PAGE = path.join(root, 'plugin', 'ui', 'lyric3d-emotion-check.html');
const OUT = path.join(root, 'output', 'emotion-lyric3d');

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    headless: process.env.GLYPH_HEADED !== '1'
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pathToFileURL(PAGE).href);
    await page.waitForFunction(() => window.__lyric3dCheck && window.__lyric3dCheck.ready, null, { timeout: 30000 });
    const rows = {};
    for (const id of ['neutral', 'joy', 'sorrow', 'anger']) {
      const row = await page.evaluate((emotion) => window.__lyric3dCheck.select(emotion), id);
      if (!row || !row.sig) throw new Error(id + ' 无签名');
      rows[id] = row;
      await page.screenshot({ path: path.join(OUT, id + '.png'), fullPage: false });
    }
    if (rows.neutral.sig === rows.joy.sig || rows.joy.sig === rows.sorrow.sig) {
      throw new Error('情绪变化未进入图集签名');
    }
    if (rows.joy.stats.warm <= 0) throw new Error('joy 当前行没有暖色像素');
    if (rows.sorrow.stats.cool <= 0) throw new Error('sorrow 当前行没有冷色像素');
    if (rows.anger.stats.warm <= 0) throw new Error('anger 当前行没有暖色像素');
    if (rows.joy.state && rows.joy.state.weight !== 700) throw new Error('joy 字重未映射');
    if (rows.sorrow.state && rows.sorrow.state.weight !== 400) throw new Error('sorrow 字重未映射');
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), rows, pageErrors: errors
    }, null, 2));
    console.log('✓ GL 图集：neutral/joy/sorrow/anger 签名变化；当前行暖/冷色像素与字重映射正确');
    console.log('  warm/cool ' + ['joy', 'sorrow', 'anger'].map((id) => id + ' ' + rows[id].stats.warm + '/' + rows[id].stats.cool).join('  '));
    if (errors.length) throw new Error('页面异常：' + errors.join('；'));
    console.log('  证据: ' + path.relative(root, OUT));
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((err) => {
  console.error('✗ ' + (err && err.message || err));
  process.exit(1);
});
