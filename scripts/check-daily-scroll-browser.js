#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// Hertz 每日推荐滚动链：真实服务和浏览器，30行夹具证明末行可达。
// SETTINGS_NAV_URL=<isolated service> VMUSIC_DATA_DIR=<isolated data>
// HERTZ_SOURCE_ASSETS=1 enables current workspace assets; omit for embedded acceptance.

'use strict';

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiUrl } = require('./ui-token');

const URL = process.env.SETTINGS_NAV_URL || 'http://127.0.0.1:7634/';
const SHOTS = require('path').join(__dirname, '..', 'output', 'daily-scroll-check');

let checks = 0;
let failures = 0;
const ok = (cond, label, extra) => {
  checks += 1;
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.log(`  X   ${label}${extra === undefined ? '' : `  —— ${extra}`}`);
  }
};
const section = (t) => console.log(`\n${t}`);

// 每日推荐是异步拉取的：注入 fixture 前把网络与渲染的不确定性掐掉。
// 不用真数据是因为"今天推了 30 首"是后端状态，验收要的是**几何**，
// 与推了几首无关 —— 用 30 行保证内容必然溢出容器（低于这个数就不会溢出，
// 溢出与滚动这两条断言会假通过）。
const ROWS = 30;
const FIXTURE = `
  (function () {
    var host = document.getElementById('dv-body');
    if (!host) return;
    host.className = 'dv-body';
    host.innerHTML = '';
    for (var i = 1; i <= ${ROWS}; i++) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'dv-row';
      row.innerHTML =
        '<span class="dv-num">' + i + '</span>' +
        '<span class="dv-main"><span class="dv-name">第 ' + i + ' 首 · 曲名</span>' +
        '<span class="dv-sub">艺人 - 专辑</span></span>' +
        '<span class="dv-src">网易云音乐</span>';
      host.appendChild(row);
    }
    window.__dvFixtureRows = ${ROWS};
  })();
`;

// 量几何前先掐掉过渡/动画：否则读到的是动画中间值，不是终态。
const FREEZE = `
  (function () {
    var s = document.createElement('style');
    s.id = '__dvFreeze';
    s.textContent = '*{transition:none !important;animation:none !important}';
    document.head.appendChild(s);
  })();
`;

async function gotoDaily(page) {
  // 不点 rail：流年把侧栏收成胶囊、清风隐藏左侧栏，
  // `.rail-item[data-view=daily]` 在那两套皮肤下存在却被 Playwright 判不可见
  // （实测一直重试到超时）。改为直接调它自己的 onclick ——
  // app.js 里是 `b.onclick = () => setView(b.dataset.view)`，所以这条
  // 走的仍是业务路径，只跳过 Playwright 的可见性前置检查。
  // 本脚本要验的是每日推荐这个视图，不是各皮肤怎么切过来。
  await page.evaluate(() => {
    const item = document.querySelector('.rail-item[data-view="daily"]');
    if (typeof item.onclick === 'function') item.onclick();
    else item.click();
  });
  await page.waitForSelector('#view-daily:not([hidden])', { timeout: 8000 });
  await page.evaluate(FREEZE);
  await page.evaluate(FIXTURE);
  // 布局要等一帧才落定
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function setSkin(page, id) {
  await page.evaluate((skin) => {
    window.Skins.apply(skin);
  }, id);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const geom = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left),
    width: Math.round(r.width), height: Math.round(r.height),
    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
    canScroll: el.scrollHeight > el.clientHeight,
    scrollTop: el.scrollTop,
    display: getComputedStyle(el).display,
    visibility: getComputedStyle(el).visibility,
    overflowY: getComputedStyle(el).overflowY,
    flex: getComputedStyle(el).flex,
    minHeight: getComputedStyle(el).minHeight,
  };
}, sel);

(async () => {
  require('node:fs').mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  if (process.env.HERTZ_SOURCE_ASSETS === '1') await require('./ui-source-assets').routeSourceAssets(page, { base: URL.replace(/\/$/, ''), dataDir: process.env.VMUSIC_DATA_DIR });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await page.goto(uiUrl(URL), { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Skins && window.Theme, null, { timeout: 15000 });
    // 皮肤 mount 是异步的：window.Skins 存在不等于当前布局已装好。
    // 立刻 Skins.apply('hertz') 会先 unmount 一个还没 mount 完的实例，
    // 报 "Cannot set properties of undefined (setting 'hidden')"，与产品无关。
    await page.waitForTimeout(1200);

    section('Hertz 每日推荐：桌面与触屏末行可达');
    await setSkin(page, 'hertz');
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: width < 900 ? 844 : 900 });
      await gotoDaily(page);
      const scroll = await page.evaluate(async () => {
        const last = document.querySelector('#dv-body .dv-row:last-child');
        const owner = document.getElementById('column');
        owner.scrollTop = owner.scrollHeight;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const row = last.getBoundingClientRect(), box = owner.getBoundingClientRect();
        const hit = document.elementFromPoint(row.x + row.width / 2, row.y + row.height / 2);
        return { rows: document.querySelectorAll('#dv-body .dv-row').length,
          overflow: owner.scrollHeight > owner.clientHeight, scrolled: owner.scrollTop > 0,
          fits: row.left >= 0 && row.right <= innerWidth && row.top >= box.top && row.bottom <= Math.min(box.bottom, innerHeight),
          hit: !!hit && last.contains(hit) };
      });
      ok(scroll.rows === ROWS && scroll.overflow, width + 'px fixture exceeds the canonical scroll owner');
      ok(scroll.scrolled && scroll.fits && scroll.hit, width + 'px last daily row is visible and reachable', JSON.stringify(scroll));
      await page.screenshot({ path: `${SHOTS}/daily-hertz-${width}.png` });
    }

    ok(errors.length === 0, '全程无页面 JS 报错', errors.slice(0, 3).join(' | '));
  } catch (e) {
    failures += 1;
    checks += 1;
    console.log(`\n  X   脚本异常：${e && e.message}`);
    try { await page.screenshot({ path: `${SHOTS}/error.png` }); } catch (_) { /* 忽略 */ }
  } finally {
    await browser.close();
  }

  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`Hertz 每日推荐滚动：${checks} 项，${failures} 项失败`);
  process.exit(failures ? 1 : 0);
})();
