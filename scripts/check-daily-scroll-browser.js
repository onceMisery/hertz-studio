#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 每日推荐滚动链 + iOS 齿轮隐藏 + 浮光行节奏（浏览器验收，需 Playwright + 服务）。
//
//   SETTINGS_NAV_URL=http://127.0.0.1:18790/ \
//   NODE_PATH=<装有 playwright 的 node_modules 路径> \
//   node scripts/check-daily-scroll-browser.js
//
// NODE_PATH 要指到**装 playwright 的那个 node_modules**。若 playwright 是
// 装在隔离的托管 workspace 里（而非全局），全局 require 会失败，
// 此时把 NODE_PATH 指到那个 workspace 的 node_modules。
//
// 为什么必须浏览器：这三条的失败模式全是**静默**的 ——
//   · .dv-body 少一条 overflow-y，页面不报错、不少元素，只是矮了一截，
//     很容易读成"今天就推了 10 首"；
//   · iOS 齿轮用 visibility 隐藏，按钮仍占位、仍在 Tab 序里，
//     截图上"好像少了一个"，量几何才分得开；
//   · .dv-row 的行距差 10px，正则断言与"正常"完全同形。
// 三者在纯 Node 契约里都和通过长得一模一样，只能靠真实布局分出来。

'use strict';

const { chromium } = require('playwright');
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
  // 不点 rail：流年把侧栏收成胶囊、浮光把导航换成顶部胶囊，
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
    document.documentElement.setAttribute('data-skin', skin);
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
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await page.goto(uiUrl(URL), { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Skins && window.Theme, null, { timeout: 15000 });

    // ---------------------------------------------------------- 滚动链
    section('每日推荐：内容体自己滚（classic 下的基线行为）');
    await setSkin(page, 'classic');
    await gotoDaily(page);

    const body = await geom(page, '#dv-body');
    ok(!!body, '#dv-body 存在');
    ok(body.display !== 'none', '#dv-body 可见', `display=${body && body.display}`);

    // 这条是本次修复的核心：内容必然溢出容器（30 行 vs 一屏）。
    ok(body.canScroll, '#dv-body 内容溢出容器（否则下面几条全是假通过）',
      `scrollHeight=${body.scrollHeight} clientHeight=${body.clientHeight}`);

    // 三件套的实际生效值
    ok(body.flex === '1 1 0%' || /flex:\s*1/.test(body.flex), '#dv-body 的 flex 真的生效', `flex=${body.flex}`);
    ok(body.minHeight === '0px', '#dv-body 的 min-height:0 真的生效', `min-height=${body.minHeight}`);
    ok(body.overflowY === 'auto', '#dv-body 的 overflow-y:auto 真的生效', `overflow-y=${body.overflowY}`);

    // 真的能滚：滚到底，最后一行必须进视口。
    const scrolled = await page.evaluate(async () => {
      const el = document.getElementById('dv-body');
      el.scrollTop = el.scrollHeight;
      await new Promise((r) => setTimeout(r, 120));
      const rows = el.querySelectorAll('.dv-row');
      const last = rows[rows.length - 1].getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return {
        scrollTop: Math.round(el.scrollTop),
        rows: rows.length,
        lastBottom: Math.round(last.bottom),
        boxBottom: Math.round(box.bottom),
        // 最后一行下沿应当落进容器内（留 2px 容差）
        lastVisible: last.bottom <= box.bottom + 2,
      };
    });
    ok(scrolled.scrollTop > 0, '滚得动（scrollTop 真的变了）', `scrollTop=${scrolled.scrollTop}`);
    ok(scrolled.rows === ROWS, `渲染了 ${ROWS} 行`, `rows=${scrolled.rows}`);
    ok(scrolled.lastVisible, '滚到底时最后一行在容器内（内容没被 .column 裁掉）',
      `lastBottom=${scrolled.lastBottom} boxBottom=${scrolled.boxBottom}`);

    // 容器不能长出视口（min-height:0 漏掉时 .column 会被撑高）
    const inViewport = await page.evaluate(() => {
      const r = document.getElementById('dv-body').getBoundingClientRect();
      return { bottom: Math.round(r.bottom), vh: window.innerHeight };
    });
    ok(inViewport.bottom <= inViewport.vh + 2, '#dv-body 没有长出视口',
      `bottom=${inViewport.bottom} vh=${inViewport.vh}`);

    await page.screenshot({ path: `${SHOTS}/daily-classic-bottom.png` });

    // 滚回顶再看一眼头部没被吸走
    await page.evaluate(() => { document.getElementById('dv-body').scrollTop = 0; });
    await page.screenshot({ path: `${SHOTS}/daily-classic-top.png` });

    // ------------------------------------------------ 浮光的行节奏
    section('浮光：.dv-row 跟上低密度名单');
    await setSkin(page, 'sheen');
    await gotoDaily(page);

    const sheenRow = await geom(page, '.dv-row');
    ok(!!sheenRow, '浮光下 .dv-row 存在');

    // 与 sheen 自己声明的令牌比，而不是与一个写死的 px 比 ——
    // 皮肤令牌以后还会调，钉 px 会立刻假失败。
    const skinTokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const row = document.querySelector('.dv-row');
      const rs = getComputedStyle(row);
      return {
        rowPy: cs.getPropertyValue('--skin-row-py').trim(),
        gap: cs.getPropertyValue('--skin-gap').trim(),
        padTop: parseFloat(rs.paddingTop),
        padBottom: parseFloat(rs.paddingBottom),
        lineHeight: rs.lineHeight,
        fontSize: parseFloat(rs.fontSize),
        radius: rs.borderRadius,
        gapApplied: parseFloat(getComputedStyle(document.getElementById('dv-body')).rowGap),
        // 基线间距：--sp-2 是 8px，--skin-gap 是 18px。若二者相等说明令牌没接上。
        sp2: cs.getPropertyValue('--sp-2').trim(),
      };
    });
    ok(parseFloat(skinTokens.padTop) > parseFloat(skinTokens.sp2),
      `.dv-row 上下内距跟着 --skin-row-py 走（${skinTokens.padTop}px > 基线 ${skinTokens.sp2}）`,
      JSON.stringify(skinTokens));
    ok(skinTokens.gapApplied > parseFloat(skinTokens.sp2),
      `.dv-body 行距跟着 --skin-gap 走（${skinTokens.gapApplied}px > 基线 ${skinTokens.sp2}）`);
    ok(parseFloat(skinTokens.radius) > 4,
      `.dv-row 有圆角（${skinTokens.radius}），不是直角灰块`);
    // 行高要真的比字号宽（浮光 1.55），否则"低密度"只是内距在撑
    ok(skinTokens.lineHeight !== 'normal',
      `.dv-row 行高被显式定过（${skinTokens.lineHeight}），由行容器统一`);

    // 浮光下滚动仍然成立（皮肤不能把基线修好的东西弄坏）
    const sheenScroll = await page.evaluate(async () => {
      const el = document.getElementById('dv-body');
      const before = el.scrollHeight;
      el.scrollTop = el.scrollHeight;
      await new Promise((r) => setTimeout(r, 120));
      return { before, after: Math.round(el.scrollTop) };
    });
    ok(sheenScroll.after > 0, '浮光下仍能滚到底', JSON.stringify(sheenScroll));

    await page.screenshot({ path: `${SHOTS}/daily-sheen-top.png` });

    // ------------------------------------------------ iOS 齿轮
    section('iOS：顶栏齿轮摘掉，侧栏仍可达设置');
    await setSkin(page, 'ios');

    const entry = await page.evaluate(() => {
      const el = document.getElementById('settings-entry');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // 取它后面那个兄弟的位置：按钮若还占位，后面元素会被顶偏
      let next = el.nextElementSibling;
      while (next && getComputedStyle(next).display === 'none') next = next.nextElementSibling;
      const nr = next ? next.getBoundingClientRect() : null;
      return {
        display: cs.display, visibility: cs.visibility,
        width: Math.round(r.width), height: Math.round(r.height),
        onclick: typeof el.onclick === 'function',
        nextLeft: nr ? Math.round(nr.left) : null,
        // Tab 序：不可见元素不该还能被聚焦到
        focusable: (() => { el.focus(); return document.activeElement === el; })(),
      };
    });
    ok(!!entry, '#settings-entry 仍在 DOM 里（功能没被删，只是不显示）');
    ok(entry.display === 'none', `#settings-entry 在 iOS 下 display:none（实际 ${entry.display}）`);
    ok(entry.visibility !== 'hidden' || entry.display === 'none',
      '不是用 visibility 藏的');
    ok(entry.width === 0 && entry.height === 0, '几何为零（不占位，没把后面的图标顶偏）',
      `${entry.width}×${entry.height}`);
    ok(entry.focusable === false, '不在 Tab 序里（focus 后 activeElement 不是它）');
    ok(entry.onclick === true, 'onclick 仍绑定（快捷键等路径仍能开设置）');

    // 侧栏必须有设置入口，否则摘掉齿轮就等于把设置藏没了
    const railOk = await page.evaluate(() => {
      const item = document.querySelector('.rail-item[data-view="settings"]');
      if (!item) return { found: false };
      const r = item.getBoundingClientRect();
      return { found: true, w: Math.round(r.width), h: Math.round(r.height), text: item.textContent.trim() };
    });
    ok(railOk.found, '侧栏仍有 data-view="settings" 入口');
    ok(railOk.w > 0 && railOk.h > 0, '侧栏设置入口可见可点',
      `${railOk.w}×${railOk.h} "${railOk.text}"`);

    // 切回别的皮肤，齿轮必须回来（不能把 display:none 焊死）
    await setSkin(page, 'classic');
    const backAgain = await page.evaluate(() => getComputedStyle(document.getElementById('settings-entry')).display);
    ok(backAgain !== 'none', `切回 classic 后齿轮恢复（display=${backAgain}）`);

    // ------------------------------------------------ 改名
    section('OS风：显示名改了，持久化键没动');
    const names = await page.evaluate(() => {
      window.Skins.apply('ios');
      const list = window.Skins.list ? window.Skins.list() : [];
      return {
        catalog: list.map((d) => ({ id: d.id, name: d.name })),
        current: document.documentElement.getAttribute('data-skin'),
        stored: localStorage.getItem('vmusic.skin'),
      };
    });
    const iosEntry = names.catalog.find((d) => d.id === 'ios');
    ok(!!iosEntry, "目录里仍以 id 'ios' 登记");
    ok(iosEntry && iosEntry.name === 'OS风', `显示名是 'OS风'（实际 '${iosEntry && iosEntry.name}'）`);
    ok(!names.catalog.some((d) => d.name === 'iOS'), "目录里不再有叫 'iOS' 的皮肤");
    ok(names.current === 'ios', "data-skin 仍是 'ios'");
    ok(names.stored !== 'OS风' && names.stored !== 'ios风',
      `localStorage 键仍是 id 而非显示名（存的是 '${names.stored}'）`);

    await setSkin(page, 'ios');
    await page.screenshot({ path: `${SHOTS}/ios-no-settings-entry.png` });

    // ------------------------------------------------ 其它皮肤没被带坏
    section('回归：其余皮肤下每日推荐仍能滚');
    for (const skin of ['workbench', 'liunian', 'qingfeng', 'sheen']) {
      await setSkin(page, skin);
      await gotoDaily(page);
      const r = await page.evaluate(async () => {
        const el = document.getElementById('dv-body');
        el.scrollTop = el.scrollHeight;
        await new Promise((r2) => setTimeout(r2, 100));
        const rows = el.querySelectorAll('.dv-row');
        const last = rows[rows.length - 1].getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return {
          overflowY: getComputedStyle(el).overflowY,
          canScroll: el.scrollHeight > el.clientHeight,
          scrolled: el.scrollTop > 0,
          lastVisible: last.bottom <= box.bottom + 2,
          count: rows.length,
        };
      });
      ok(r.overflowY === 'auto', `${skin}：overflow-y 仍是 auto`);
      ok(r.scrolled, `${skin}：滚得动`);
      ok(r.lastVisible, `${skin}：最后一行没被裁掉`);
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
  console.log(`每日推荐滚动 / iOS 齿轮 / OS风改名：${checks} 项，${failures} 项失败`);
  process.exit(failures ? 1 : 0);
})();
