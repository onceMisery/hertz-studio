#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// stanza 视觉对比：固定时钟截图矩阵。用法：
//   STANZA_URL=http://localhost:5173 HERTZ_URL=http://localhost:8080 node scripts/check-stanza-visual.js
// 依赖 playwright（npx -y playwright@latest install chromium 后可用 require）。
//
// 夹具歌词（两边各导入同一 LRC，保存为测试资源；含 normal/short/micro 行、间奏、超长 CJK 句、中英混合行）：
//   [00:00.00]短
//   [00:00.05]极短快速句
//   [00:12.00]今日所见的夕阳漫天散落的星点在风里慢慢发亮
//   [00:18.00]宝贝 我 爱 你 baby I love you
//   [00:24.00]......
//   [00:30.00]最后一句安静收场
'use strict';
const fs = require('fs');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.error('未找到 playwright。请先执行：npx -y playwright@latest install chromium');
  process.exit(2);
}

const STANZA = process.env.STANZA_URL || 'http://localhost:5173';
const HERTZ = process.env.HERTZ_URL || 'http://localhost:8080';
const OUT = path.join(__dirname, '..', 'output', 'stanza-verify');
fs.mkdirSync(OUT, { recursive: true });

const MATRIX = [
  { mode: 'classic', bg: 'geometric', w: 1440, h: 900 },
  { mode: 'classic', bg: 'fluid',    w: 1440, h: 900 },
  { mode: 'classic', bg: 'solid',    w: 1440, h: 900 },
  { mode: 'cadenza', bg: 'geometric',w: 1440, h: 900 },
  { mode: 'cadenza', bg: 'fluid',    w: 1440, h: 900 },
  { mode: 'cadenza', bg: 'solid',    w: 1440, h: 900 },
  { mode: 'classic', bg: 'geometric', w: 390, h: 844 },
  { mode: 'cadenza', bg: 'geometric', w: 390, h: 844 }
];
// 夹具中两个采样时刻：12.6s（normal 长句）、0.6s（short/micro 快句）
const SAMPLES = [{ t: 12600, name: 'normal' }, { t: 600, name: 'fast' }];

async function shot(page, url, file) {
  await page.goto(url, { waitUntil: 'networkidle' });
  // 两侧测试页都约定监听该事件，把播放时钟固定到指定 ms（夹具页/调试钩子）。
  await page.evaluate((ms) => window.__pinPlayback && window.__pinPlayback(ms), 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: file });
}

(async () => {
  const browser = await chromium.launch();
  for (const m of MATRIX) {
    for (const s of SAMPLES) {
      const ctx = await browser.newContext({ viewport: { width: m.w, height: m.h } });
      const page = await ctx.newPage();
      const q = `?mode=${m.mode}&bg=${m.bg}`;
      const base = `${m.mode}-${m.bg}-${m.w}x${m.h}-${s.name}.png`;
      await shot(page, `${STANZA}/${q}&t=${s.t}`, path.join(OUT, 'stanza-' + base));
      await shot(page, `${HERTZ}/stage3d${q}&t=${s.t}`, path.join(OUT, 'hertz-' + base));
      await ctx.close();
    }
  }
  await browser.close();
  console.log('截图完成：', OUT);
  console.log('对比：npx pixelmatch 或人工 SSIM 目检；结构差异目标 <5%，SSIM >=0.95');
})().catch((e) => { console.error(e); process.exit(1); });
