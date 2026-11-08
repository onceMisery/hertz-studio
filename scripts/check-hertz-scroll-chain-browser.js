#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// Hertz 整列滚动链：在线曲库 / 每日推荐的**真实滚轮**能否到达 #column。
//
// 为什么必须有这一条：这两个视图的内容体在 style.css 里是
// `flex:1 / min-height:0 / overflow-y:auto / overscroll-behavior:contain`，
// 而 hertz 皮肤把 .view 改成 height:auto —— 内容体拿不到确定高度，
// 于是被内容撑满（自身 scrollHeight === clientHeight，压根不滚），
// 却仍以 scroll container 的身份用 contain 截断滚轮向 #column 的传递。
// 症状是「列表在、数据在、就是滚不动」，而直接给 #column.scrollTop 赋值
// 的旧断言全绿：它绕过了整条滚轮链。所以这里只认 page.mouse.wheel。
//
// HERTZ_SCROLL_URL=<isolated service> VMUSIC_DATA_DIR=<isolated data>
// HERTZ_SOURCE_ASSETS=1 用当前 checkout 的前端资源覆盖内嵌资源。
'use strict';

const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiUrl } = require('./ui-token');

const URL = process.env.HERTZ_SCROLL_URL || process.env.SETTINGS_NAV_URL || 'http://127.0.0.1:7634/';
const SHOTS = path.join(__dirname, '..', 'output', 'hertz-scroll-chain-check');
const ROWS = 30;

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

// 注入的行不依赖后端数据：要验的是几何，不是"今天推了几首 / 在线搜到几首"。
// 另挂一个 view 直属锚点：online.js 会在滚动时重渲染 #online-body，注入的
// 行可能被冲掉；锚点挂在 view 根（列表之后），业务渲染碰不到它，用它量
// 「滚轮把下方内容拉了上来」和「页面底部内容可达」才不会假红。
const FIXTURE = (viewId, hostSel, kind) => `
  (function () {
    var view = document.getElementById('view-' + ${JSON.stringify(viewId)});
    var host = view && view.querySelector(${JSON.stringify(hostSel)});
    if (!host) return false;
    host.querySelectorAll('.probe-row').forEach(function (n) { n.remove(); });
    for (var i = 1; i <= ${ROWS}; i++) {
      var row = document.createElement('div');
      row.className = ${JSON.stringify(kind)} + ' probe-row';
      row.style.cssText = 'height:72px;min-height:72px;flex:0 0 72px';
      row.innerHTML = '<span>第 ' + i + ' 首 · 曲名</span>';
      host.appendChild(row);
    }
    view.querySelectorAll('.probe-anchor').forEach(function (n) { n.remove(); });
    var anchor = document.createElement('div');
    anchor.className = 'probe-anchor';
    anchor.style.cssText = 'height:72px;min-height:72px;flex:0 0 72px;box-sizing:border-box;background:rgba(120,160,255,.12)';
    anchor.textContent = '末尾锚点';
    view.appendChild(anchor);
    // 返回行数，注入当下就判：online.js 会在滚动时重渲染 #online-body，
    // 等 measure 那一步再数行数会偶发读到 0（不是产品缺陷）。
    return host.querySelectorAll('.probe-row').length;
  })();
`;

const FREEZE = `
  (function () {
    if (document.getElementById('__hscFreeze')) return;
    var s = document.createElement('style');
    s.id = '__hscFreeze';
    s.textContent = '*{transition:none !important;animation:none !important}';
    document.head.appendChild(s);
  })();
`;

const VIEWS = [
  { id: 'online', host: '#online-body', row: 'track online-row', inner: '.online-scroll' },
  { id: 'daily', host: '#dv-body', row: 'dv-row', inner: '.dv-body' },
];

async function frames(page) {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function gotoView(page, id) {
  await page.evaluate(() => {
    document.querySelectorAll('.probe-row, .probe-anchor').forEach(n => n.remove());
  });
  await page.evaluate((v) => {
    const item = document.querySelector('.rail-item[data-view="' + v + '"]');
    if (item) { if (typeof item.onclick === 'function') item.onclick(); else item.click(); }
    else if (window.setView) window.setView(v);
  }, id);
  await page.waitForSelector('#view-' + id + ':not([hidden])', { timeout: 8000 });
  await frames(page);
}

async function measure(page, view, width) {
  // 上一轮为了验末行改过 scrollTop；不复位的话 view 的 rect 会落在视口上方，
  // 鼠标落点被 clamp 到顶栏，滚轮自然打不到 #column —— 这是脚本假红。
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach(el => { el.scrollTop = 0; });
  });
  await frames(page);
  const before = await page.evaluate((v) => {
    const col = document.getElementById('column');
    const inner = document.querySelector(v.inner);
    const el = document.getElementById('view-' + v.id);
    const anchor = el.querySelector('.probe-anchor');
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(innerWidth - 8, r.left + Math.min(r.width / 2, 380)));
    const y = Math.max(8, Math.min(innerHeight - 8, r.top + Math.min(r.height / 2, 200)));
    const hit = document.elementFromPoint(x, y);
    return {
      colOverflow: getComputedStyle(col).overflowY,
      colCan: col.scrollHeight > col.clientHeight + 1,
      colWidth: col.clientWidth, colScrollWidth: col.scrollWidth,
      innerOverflow: inner ? getComputedStyle(inner).overflowY : null,
      innerOsy: inner ? getComputedStyle(inner).overscrollBehaviorY : null,
      innerCan: inner ? inner.scrollHeight > inner.clientHeight + 1 : null,
      innerWidthPx: inner ? inner.clientWidth : null,
      innerScrollWidth: inner ? inner.scrollWidth : null,
      innerOffenders: inner ? [...inner.querySelectorAll('*')].filter(n => {
        const nr = n.getBoundingClientRect(), ir = inner.getBoundingClientRect();
        return nr.width > 0 && (nr.right > ir.right + 1 || nr.left < ir.left - 1);
      }).slice(0, 4).map(n => n.tagName.toLowerCase() + '.' +
        (typeof n.className === 'string' ? n.className : '').trim().split(/\s+/).slice(0, 2).join('.')) : [],
      anchorTop: anchor ? Math.round(anchor.getBoundingClientRect().top) : null,
      rows: document.querySelectorAll('#view-' + v.id + ' .probe-row').length,
      point: { x, y, inView: !!(hit && el.contains(hit)) },
    };
  }, view);

  await page.evaluate(() => { document.getElementById('column').scrollTop = 0; });
  await page.mouse.move(before.point.x, before.point.y);
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(320);

  const after = await page.evaluate((v) => {
    const col = document.getElementById('column');
    const el = document.getElementById('view-' + v.id);
    const anchor = el.querySelector('.probe-anchor');
    // 先读滚轮的结果：下面为了验底部可达会再改一次 scrollTop，混在一起会把
    // 「滚不动」伪装成「滚得动」（直接赋值 scrollTop 正是旧断言的漏洞）。
    const scrolled = col.scrollTop;
    const anchorTop = anchor ? Math.round(anchor.getBoundingClientRect().top) : null;
    const box = col.getBoundingClientRect();
    // 把列表之后的锚点摆到视口中部，再看它是不是真能被命中（不是被裁掉/被盖住）。
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      col.scrollTop += r.top - (box.top + box.height / 2);
    }
    const ar = anchor ? anchor.getBoundingClientRect() : null;
    const hit = ar ? document.elementFromPoint(
      Math.max(8, Math.min(innerWidth - 8, ar.left + Math.min(ar.width / 2, 200))),
      Math.max(8, Math.min(innerHeight - 8, ar.top + ar.height / 2))) : null;
    return {
      scrolled: scrolled,
      anchorTop: anchorTop,
      bottomReachable: !!(hit && anchor && anchor.contains(hit) && ar &&
        ar.top >= box.top - 1 && ar.bottom <= Math.min(box.bottom, innerHeight) + 1),
      anchorRect: ar ? [Math.round(ar.top), Math.round(ar.bottom)] : null,
      colBottom: Math.round(box.bottom),
    };
  }, view);

  return { before, after };
}

(async () => {
  require('node:fs').mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    if (process.env.HERTZ_SOURCE_ASSETS === '1') {
      await require('./ui-source-assets').routeSourceAssets(page, {
        base: URL.replace(/\/$/, ''), dataDir: process.env.VMUSIC_DATA_DIR,
      });
    }
    await page.goto(uiUrl(URL), { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Skins && window.Theme, null, { timeout: 15000 });
    // 皮肤 mount 是异步的：太早 apply 会去 unmount 一个还没装好的实例。
    await page.waitForTimeout(1200);
    const skin = await page.evaluate(() => document.documentElement.getAttribute('data-skin'));
    if (skin !== 'hertz') await page.evaluate(() => window.Skins.apply('hertz'));
    await page.waitForTimeout(400);
    await page.evaluate(FREEZE);

    for (const view of VIEWS) {
      section(view.id === 'online' ? '在线曲库：整列滚动链' : '每日推荐：整列滚动链');
      for (const width of [1440, 1024, 390, 320]) {
        await page.setViewportSize({ width, height: width < 900 ? 844 : 900 });
        await gotoView(page, view.id);
        const injected = await page.evaluate(FIXTURE(view.id, view.host, view.row));
        await frames(page);
        const m = await measure(page, view, width);
        const label = width + 'px';
        ok(injected === ROWS, label + ' fixture fills the list', String(injected));
        ok(m.before.colOverflow === 'auto' && m.before.colCan,
          label + ' #column is the one real scroll owner', JSON.stringify(m.before));
        // overflow:visible 的元素 scrollHeight 照样会报内容尺寸，所以不能用
        // scrollHeight > clientHeight 判断它是不是滚动容器；只认计算值。
        ok(m.before.innerOverflow === 'visible' && m.before.innerOsy !== 'contain',
          label + ' inner body no longer claims a scroll port / swallows the wheel',
          m.before.innerOverflow + '/' + m.before.innerOsy);
        ok(m.before.point.inView, label + ' wheel lands inside the view', JSON.stringify(m.before.point));
        ok(m.after.scrolled > 0, label + ' real wheel moves #column', JSON.stringify(m.after));
        ok(m.before.anchorTop !== null && m.after.anchorTop !== null &&
           m.before.anchorTop - m.after.anchorTop > 100,
          label + ' wheel pulls content below the fold into view',
          m.before.anchorTop + ' -> ' + m.after.anchorTop);
        ok(m.after.bottomReachable, label + ' content after the list is visible and hit-testable', JSON.stringify(m.after));
        ok(m.before.colScrollWidth <= m.before.colWidth + 1,
          label + ' no horizontal overflow', m.before.colScrollWidth + '/' + m.before.colWidth);
        // overflow:visible 之后内层不再自己裁横向内容，窄屏必须仍然不横溢
        // （旧的 check-search-browser 只验这一条 .online-scroll 的量）。
        ok(m.before.innerScrollWidth !== null &&
           m.before.innerScrollWidth <= m.before.innerWidthPx + 1,
          label + ' [' + view.id + '] inner body has no horizontal overflow',
          m.before.innerScrollWidth + '/' + m.before.innerWidthPx + ' ' + JSON.stringify(m.before.innerOffenders));
        await page.screenshot({ path: path.join(SHOTS, `${view.id}-${width}.png`) });
      }
    }
    ok(errors.length === 0, '全程无页面 JS 报错', errors.slice(0, 3).join(' | '));
  } catch (e) {
    failures += 1;
    checks += 1;
    console.log(`\n  X   脚本异常：${e && e.message}`);
    try { await page.screenshot({ path: path.join(SHOTS, 'error.png') }); } catch (_) { /* 忽略 */ }
  } finally {
    await browser.close();
  }
  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`Hertz 整列滚动链：${checks} 项，${failures} 项失败`);
  process.exit(failures ? 1 : 0);
})();
