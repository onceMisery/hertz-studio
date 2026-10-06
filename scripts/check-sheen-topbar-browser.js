#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 浮光：胶囊并入顶栏 + 常驻搜索框摘掉 + 播放面板的底边留位（浏览器验收，
// 需 Playwright + 服务）。
//
//   SETTINGS_NAV_URL=http://127.0.0.1:18791/ \
//   NODE_PATH=<装有 playwright 的 node_modules 路径> \
//   node scripts/check-sheen-topbar-browser.js
//
// NODE_PATH 要指到**装 playwright 的那个 node_modules**。若 playwright 是
// 装在隔离的托管 workspace 里（而非全局），全局 require 会失败，
// 此时把 NODE_PATH 指到那个 workspace 的 node_modules。
//
// 为什么必须浏览器：这几条的失败模式全是**看起来正常**的——
//   · 留白：内容照样渲染，页面不报错，只是第一屏白扔三分之一。
//     CSS 里的 padding 写成 0 还是 134px，正则断言与"通过"完全同形。
//   · 搜索框：`display:none` 会让 `/` 与 Ctrl+K 的 focus() **静默失效**，
//     按键没反应、控制台干净，契约脚本（只看源码文本）永远抓不到。
//   · 播放面板：底边插进播放条、曲名被压成半截字，都是"页面不报错、
//     元素一个不少"的几何问题，只有量 getBoundingClientRect 才分得开。
// 所以这里量真实几何、并真的按一次键看焦点落在哪。

'use strict';

const { chromium } = require('playwright');
const path = require('path');
const { uiUrl } = require('./ui-token');

const URL = process.env.SETTINGS_NAV_URL || 'http://127.0.0.1:7634/';
const SHOTS = path.join(__dirname, '..', 'output', 'sheen-topbar-check');

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

async function setSkin(page, id) {
  await page.evaluate((s) => window.Skins.apply(s), id);
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.id = '__freeze';
    st.textContent = '*{transition:none !important;animation:none !important}';
    document.head.appendChild(st);
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await page.goto(uiUrl(URL), { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Skins && window.Theme, null, { timeout: 15000 });
    await setSkin(page, 'sheen');

    // ---------------------------------------------------------- 胶囊并入顶栏
    section('浮光：胶囊与顶栏同一行');

    const g = await page.evaluate(() => {
      const rail = document.getElementById('rail');
      const top = document.querySelector('.topbar');
      const r = rail.getBoundingClientRect();
      const t = top.getBoundingClientRect();
      return {
        rail: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
          left: Math.round(r.left), right: Math.round(r.right) },
        topbar: { top: Math.round(t.top), bottom: Math.round(t.bottom), h: Math.round(t.height) },
        vw: window.innerWidth,
      };
    });

    // 核心：胶囊整块落在顶栏高度之内（上下都有余量，不压边）。
    ok(g.rail.top >= g.topbar.top && g.rail.bottom <= g.topbar.bottom,
      '胶囊整块落在顶栏高度内（不是吊在顶栏下方）',
      `rail ${g.rail.top}..${g.rail.bottom} / topbar ${g.topbar.top}..${g.topbar.bottom}`);
    ok(g.rail.h <= g.topbar.h,
      `胶囊比顶栏矮（${g.rail.h} ≤ ${g.topbar.h}），上下留得出余量`);
    ok(g.rail.h > 30, '胶囊有真实高度（没被压扁）', `h=${g.rail.h}`);

    // 不与品牌块、右侧图标区重叠：胶囊左右两端都要落在顶栏内。
    const clash = await page.evaluate(() => {
      const rail = document.getElementById('rail').getBoundingClientRect();
      const brand = document.querySelector('.brand').getBoundingClientRect();
      const right = document.querySelector('.top-right').getBoundingClientRect();
      return {
        railL: Math.round(rail.left), railR: Math.round(rail.right),
        brandR: Math.round(brand.right), rightL: Math.round(right.left),
        gapLeft: Math.round(rail.left - brand.right),
        gapRight: Math.round(right.left - rail.right),
      };
    });
    ok(clash.gapLeft >= 0, `胶囊不压品牌块（左侧余 ${clash.gapLeft}px）`, JSON.stringify(clash));
    ok(clash.gapRight >= 0, `胶囊不压右侧图标区（右侧余 ${clash.gapRight}px）`, JSON.stringify(clash));

    // ---------------------------------------------------------- 留白没了
    section('浮光：内容区顶部不再有 134px 空档');

    const blank = await page.evaluate(() => {
      const view = document.getElementById('view-library');
      const cs = getComputedStyle(view);
      const top = document.querySelector('.topbar').getBoundingClientRect();
      const v = view.getBoundingClientRect();
      const head = document.querySelector('#view-library .col-head');
      const hr = head ? head.getBoundingClientRect() : null;
      return {
        padTop: parseFloat(cs.paddingTop),
        viewTop: Math.round(v.top),
        topbarBottom: Math.round(top.bottom),
        gap: Math.round(v.top - top.bottom),
        headTop: hr ? Math.round(hr.top) : null,
        // 从顶栏底边到第一个真实内容（页头）的垂直距离 = 留白
        blankToHead: hr ? Math.round(hr.top - top.bottom) : null,
      };
    });
    ok(blank.padTop === 0, `.view 的 padding-top 是 0（实际 ${blank.padTop}px）`);
    // 1px 是 .topbar 的 border-bottom（顶栏只有下边框），不是留白。
    ok(blank.gap <= 1, `内容区紧贴顶栏底边，无空档（实际 ${blank.gap}px）`);
    // 旧布局下这里是 134px；给一个宽松上限，允许页头自身的 margin-bottom。
    ok(blank.blankToHead !== null && blank.blankToHead < 48,
      `顶栏到第一个内容只有正常间距（${blank.blankToHead}px，旧布局约 134px）`);

    await page.screenshot({ path: `${SHOTS}/sheen-library.png` });

    // 换几个视图都验一遍：留白不该只在曲库页没
    for (const view of ['daily', 'playlists', 'favorites', 'online']) {
      await page.evaluate((v) => {
        const item = document.querySelector(`.rail-item[data-view="${v}"]`);
        if (typeof item.onclick === 'function') item.onclick(); else item.click();
      }, view);
      await page.waitForFunction((v) => {
        const el = document.getElementById(`view-${v}`);
        return el && !el.hidden;
      }, view, { timeout: 8000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const pad = await page.evaluate((v) => parseFloat(getComputedStyle(document.getElementById(`view-${v}`)).paddingTop), view);
      ok(pad === 0, `${view} 页 padding-top 也是 0（${pad}px）`);
    }

    // ---------------------------------------------------------- 搜索框摘掉
    section('浮光：常驻搜索框不显示');

    const search = await page.evaluate(() => {
      const el = document.querySelector('.topsearch');
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const input = document.getElementById('search');
      return {
        opacity: parseFloat(cs.opacity),
        pointerEvents: cs.pointerEvents,
        display: cs.display,
        visibility: cs.visibility,
        inDom: !!input,
        w: Math.round(r.width),
        // 是否还在布局流里（fixed = 脱流，不占顶栏中段）
        position: cs.position,
        top: Math.round(r.top),
        // 可聚焦性：opacity:0 的元素仍可 focus，这正是不用 display:none 的原因
        focusable: (() => { input.focus(); return document.activeElement === input; })(),
        markAtBoot: document.body.classList.contains('sheen-search'),
      };
    });
    ok(search.inDom, '搜索框仍在 DOM 里（功能没删）');
    ok(search.display !== 'none', '不是 display:none（那样 focus() 会静默失效）', `display=${search.display}`);
    ok(search.visibility === 'visible', '不是 visibility:hidden（同上会丢焦点）', `visibility=${search.visibility}`);
    ok(search.opacity === 0, `平时不可见（opacity=${search.opacity}）`);
    ok(search.pointerEvents === 'none', `平时点不到（pointer-events=${search.pointerEvents}）`);
    ok(search.position === 'fixed', '改成覆盖式脱流（不再占顶栏中段把胶囊挤走）');
    ok(search.focusable === true, '元素仍可被 focus —— 快捷键的基础');
    ok(search.markAtBoot === false, '启动时不带 sheen-search 标记（默认收着）');

    // 常态（未唤起）下胶囊必须完好 —— 新增的 body.sheen-search .rail 退场规则
    // 不能误伤平时。这条与唤起态那三条配对。
    const railIdle = await page.evaluate(() => {
      const rail = document.getElementById('rail');
      const cs = getComputedStyle(rail);
      return { vis: cs.visibility, opacity: parseFloat(cs.opacity), pe: cs.pointerEvents };
    });
    ok(railIdle.vis === 'visible' && railIdle.opacity === 1 && railIdle.pe !== 'none',
      `平时胶囊完好（visibility=${railIdle.vis} opacity=${railIdle.opacity} pe=${railIdle.pe}）`);

    // 搜索框与胶囊**故意**占同一块：唤起时搜索框接管那一格，而胶囊同时退场。
    // 注意别再写「z-index 62 > 61 所以盖得住」这种断言 —— 它量的是**声明值**，
    // 不是绘制结果：.topsearch 是 .topbar 的子节点，.topbar 自带
    // position:relative+z-index:40 与 backdrop-filter 形成层叠上下文，
    // 62 只在顶栏内部比较，压不过 body 层的 #rail(61)（实测按 / 毫无反应）。
    // 真正保证「盖得住」的是胶囊退场，判据放在下面的唤起态段里。
    const layer = await page.evaluate(() => {
      const s = document.querySelector('.topsearch');
      const cs = getComputedStyle(s);
      return { position: cs.position };
    });
    ok(layer.position === 'fixed', '搜索框脱流，不参与顶栏 flex 布局');
    // 平时 pointer-events:none，点不到是**对的**（收起状态就该点不到），
    // 所以"唤起时能不能点到"要放到唤起态量，见下面的 section。

    // ---------------------------------------------------------- 快捷键唤起
    section('浮光：/ 与 Ctrl+K 仍能唤起搜索');

    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('/');
    await page.waitForFunction(() => document.body.classList.contains('sheen-search'), null, { timeout: 3000 })
      .catch(() => {});
    let st = await page.evaluate(() => ({
      mark: document.body.classList.contains('sheen-search'),
      focused: document.activeElement && document.activeElement.id,
      opacity: parseFloat(getComputedStyle(document.querySelector('.topsearch')).opacity),
    }));
    ok(st.mark, '按 `/` 后 body 挂上 sheen-search 标记');
    ok(st.focused === 'search', `按 \`/\` 焦点落在搜索框（实际 '${st.focused}'）`);
    ok(st.opacity > 0.9, `搜索框显形（opacity=${st.opacity}）`);

    // 唤起态下必须真的能点到：pointer-events 恢复，且胶囊已经让场。
    //
    // 这一段的三条判据（inBox / alsoInRail / zSearch>zRail）当初全绿，
    // 最后一条 hitInRail 却判不出真凶 —— 因为它们量的都是**几何与声明**，
    // 而"谁画在谁上面"这件事由层叠上下文决定，不由这两个数决定。
    // 真正的坑：.topsearch 是 header.topbar 的子节点，.topbar 自己带
    // position:relative+z-index:40 与 backdrop-filter，**形成层叠上下文**，
    // 于是搜索框的 z-index:62 只在顶栏内部比较，压不过 body 层的 #rail(61)。
    // 结果是"按了 / 什么都没出现"且控制台干净。
    // 现在靠 Capsule 让场（body.sheen-search .rail → visibility:hidden）解决，
    // 所以判据从"比 z-index"改成"量胶囊是否真的退场了 + 命中点归谁"。
    const clickable = await page.evaluate(() => {
      const s = document.querySelector('.topsearch');
      const rail = document.getElementById('rail');
      const r = s.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      const railR = rail.getBoundingClientRect();
      const railCs = getComputedStyle(rail);
      return {
        inBox: cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom,
        // 几何上确实重叠 —— 这是"曾经被盖住"的现场证据，别删。
        alsoInRail: cx >= railR.left && cx <= railR.right && cy >= railR.top && cy <= railR.bottom,
        // 退场判据（真正的那条）：胶囊不可见、不可点。
        // 只查 opacity 不够 —— visibility:hidden 才是"连命中都不参与"的那一层，
        // 而 opacity:0 的元素仍然会吃掉命中点（这是本脚本前几版判错的原因）。
        railVis: railCs.visibility,
        railOpacity: parseFloat(railCs.opacity),
        railPE: railCs.pointerEvents,
        // 命中点归属：元素在**绘制顺序**上到底属于谁。
        // 不用 rail.contains(hit) 单独当"被抢走"的判据 —— 命中点常落在
        // 胶囊的 <span> 上（在 DOM 里确实是 .rail 后代），但那不代表胶囊
        // 画在上层。这里只问"命中的是不是搜索框自己人"。
        hitInSearch: !!(hit && hit.closest && hit.closest('.topsearch')),
        hitInRail: !!(hit && hit.closest && hit.closest('#rail')),
        pe: getComputedStyle(s).pointerEvents,
        id: hit && (hit.id || (hit.className && hit.className.baseVal) || hit.className || hit.tagName),
      };
    });
    ok(clickable.pe === 'auto', `唤起态 pointer-events 恢复为 auto（${clickable.pe}）`);
    ok(clickable.inBox, '命中点落在搜索框矩形内');
    ok(clickable.alsoInRail,
      `两个盒子在几何上确实重叠（命中点同时在胶囊矩形内=${clickable.alsoInRail}）—— 不重叠就说明没盖住`);
    // ⭐ 胶囊让场：这三条才是"盖得住"的真实证明。
    ok(clickable.railVis === 'hidden',
      `唤起时胶囊 visibility:hidden（实际 ${clickable.railVis}）—— 只靠 z-index 压不住，见下面那条`);
    ok(clickable.railPE === 'none',
      `胶囊退场后不可点（pointer-events=${clickable.railPE}）`);
    ok(clickable.railOpacity === 0,
      `胶囊退场后 opacity=0（实际 ${clickable.railOpacity}）`);
    ok(clickable.hitInSearch && !clickable.hitInRail,
      `重叠处命中的是搜索框而非胶囊（命中 '${clickable.id}'，inSearch=${clickable.hitInSearch} / inRail=${clickable.hitInRail}）`);

    // 收起来：失焦应摘掉标记
    await page.evaluate(() => document.getElementById('search').blur());
    await page.waitForTimeout(150);
    st = await page.evaluate(() => {
      const railCs = getComputedStyle(document.getElementById('rail'));
      return {
        mark: document.body.classList.contains('sheen-search'),
        opacity: parseFloat(getComputedStyle(document.querySelector('.topsearch')).opacity),
        railVis: railCs.visibility,
        railPE: railCs.pointerEvents,
      };
    });
    ok(!st.mark, '失焦后摘掉标记');
    ok(st.opacity === 0, `失焦后收回（opacity=${st.opacity}）`);
    // ⭐ 胶囊必须**回到场上**。这条与上面那条退场断言配对：胶囊让位解决的是
    // "搜索框被盖住"，但如果只顾着让位、忘了收回，那浮光下按一次 / 之后
    // 导航就永久消失了 —— 同样是"按了没反应"的静默失效，只是反方向的。
    ok(st.railVis === 'visible' && st.railPE !== 'none',
      `失焦后胶囊回到场上（visibility=${st.railVis} pointer-events=${st.railPE}）`);

    // Ctrl+K 走的**不是**搜索框：app.js 的 bindShortcuts 里这个组合键已经让给
    // 命令面板（`if (window.Palette) Palette.open(); else focusSearch(true)`）。
    // 这条断言原来写的是"Ctrl+K 也唤起搜索框"，Palette 接管之后就永远红 ——
    // 而红的样子和"功能坏了"一模一样（mark=false、focus 是 body），
    // 排查时得先分清是脚本陈旧还是真缺陷。现在按真实约定验两条路分开：
    // `/` 叫搜索框，Ctrl+K 开命令面板。
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(200);
    const palette = await page.evaluate(() => {
      const scrim = document.querySelector('.palette-scrim');
      return {
        hasPalette: !!window.Palette,
        open: !!scrim && !scrim.hidden,
        searchMark: document.body.classList.contains('sheen-search'),
      };
    });
    ok(palette.hasPalette, 'Ctrl+K 由命令面板接管（window.Palette 在）');
    ok(palette.open, 'Ctrl+K 打开命令面板');
    ok(!palette.searchMark, 'Ctrl+K 不再顺带把浮光的搜索框叫出来（两条路各走各的）');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const paletteClosed = await page.evaluate(() => {
      const scrim = document.querySelector('.palette-scrim');
      const railCs = getComputedStyle(document.getElementById('rail'));
      return { open: !!scrim && !scrim.hidden, railVis: railCs.visibility };
    });
    ok(!paletteClosed.open, 'Esc 关掉命令面板');
    ok(paletteClosed.railVis === 'visible',
      `面板与搜索都不在的平时态，浮光胶囊照旧在场（visibility=${paletteClosed.railVis}）`);

    // 收起来：Esc 应摘掉标记，胶囊回场。
    // 先用 `/` 真的把搜索叫出来 —— 否则下面两条是空转（还没唤起就无所谓收起）。
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('/');
    await page.waitForTimeout(150);
    ok(await page.evaluate(() => document.body.classList.contains('sheen-search')),
      'Esc 前先由 `/` 唤起搜索（下面两条才有对象可测）');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const afterEsc = await page.evaluate(() => {
      const railCs = getComputedStyle(document.getElementById('rail'));
      return {
        mark: document.body.classList.contains('sheen-search'),
        railVis: railCs.visibility,
      };
    });
    ok(!afterEsc.mark, 'Esc 也能收起（不会一直挂在顶栏上）');
    ok(afterEsc.railVis === 'visible', `Esc 之后胶囊同样回到场上（visibility=${afterEsc.railVis}）`);

    await page.screenshot({ path: `${SHOTS}/sheen-search-invoked.png` });

    // 搜索真的能用：输入应切到曲库并填 state
    await page.keyboard.press('/');
    await page.waitForTimeout(120);
    await page.keyboard.type('测试关键词');
    await page.waitForTimeout(500);
    const typed = await page.evaluate(() => ({
      value: document.getElementById('search').value,
      clearVisible: !document.getElementById('search-clear').hidden,
    }));
    ok(typed.value === '测试关键词', `搜索框能接收输入（'${typed.value}'）`);
    ok(typed.clearVisible, '清空按钮随之出现');
    await page.evaluate(() => { document.getElementById('search').blur(); });

    // ---------------------------------------------------------- 播放面板：底边与两行文字
    // 面板的高度被 max-height 钉死（fixed 悬浮件），于是两个后果都只能量真实
    // 盒子、量不出声明：
    //   · 底边位置 —— 播放条的真实高度不是 --bar-h（那只是它的 min-height：
    //     内距 14×2 + 内容行 50 + 边框 2 = 80px）。只按令牌让位，底边会插进
    //     播放条上沿 8px，看上去像"播放界面一直拖进播放条里"。
    //   · 谁被压扁 —— .stage 是定高 flex 列，歌词区压到 min-height:96 之后
    //     剩下的缺口会落到仅剩的可收缩项上，曲名/艺人行盒被从 33px 压到 14px。
    // 这两条在 Node 契约里都只能钉"写了某条声明"，钉不到"真的长这样"。
    section('浮光：播放面板的底边留位与曲名/艺人');

    await setSkin(page, 'sheen');
    await page.evaluate(() => {
      // 空闲时 .stage 是 display:none（body[data-stage-idle="1"]），整列量不到
      // 任何东西。判据只与布局有关，这里直接放行显示。
      const st = document.createElement('style');
      st.id = '__force-stage';
      st.textContent = 'body[data-stage-idle="1"] .stage{display:flex !important}';
      document.head.appendChild(st);
      // 注入歌词前先冻住入口：app.js 在没有在播曲目时会用 setLyrics(null)
      // 把歌词清掉（注入后约 1 秒就没了），冻住之后才量得到"有词"的面板。
      const inject = window.Stage.setLyrics.bind(window.Stage);
      window.Stage.setLyrics = function () {};
      inject({ lines: Array.from({ length: 24 }, (_, i) => ({ text: '一行歌词 ' + i, start_ms: i * 6000, t: i * 6000 })) });
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const panel = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
          display: getComputedStyle(el).display };
      };
      return {
        stage: box('.stage'), bar: box('.bar'),
        title: box('.stage-title'), artist: box('.stage-artist'), lyrics: box('.stage-lyrics'),
        trackH: Math.round(document.querySelector('.lyric-track').getBoundingClientRect().height),
        count: document.querySelectorAll('.lyric').length,
        inDom: !!document.getElementById('now-title') && !!document.getElementById('now-artist'),
      };
    });

    ok(panel.count >= 20, `面板里有歌词内容（${panel.count} 行）—— 空面板量不出"被压扁"的那一档`);
    ok(panel.trackH > panel.lyrics.h,
      `歌词内容高于歌词区（${panel.trackH} > ${panel.lyrics.h}）—— 面板确实处在被 max-height 钉住的状态`);
    ok(panel.inDom, '曲名/艺人元素仍在 DOM 里（app.js 仍按 id 写文本，只是这套皮肤不展示）');
    ok(panel.title.display === 'none' && panel.artist.display === 'none',
      `浮光面板不展示曲名/艺人（title=${panel.title.display} artist=${panel.artist.display}，旧版被压成 14px/9px 半截字）`);
    // 净空上下都要卡：小于 12px = 又贴回播放条（含重叠的负值），
    // 大于 48px = 把面板削掉了一大截，那是另一回事。
    const clearance = panel.bar.top - panel.stage.bottom;
    ok(clearance >= 12 && clearance <= 48,
      `面板底边停在播放条上方 ${clearance}px（旧版 -8px：底边插进播放条）`);
    ok(panel.lyrics.h >= 96,
      `歌词区仍在 min-height 之上（${panel.lyrics.h}px ≥ 96px）—— 面板变矮不能靠压歌词区`);

    await page.screenshot({ path: `${SHOTS}/sheen-stage-panel.png` });

    // 抽屉形态（≤1240px）是同一处错误的另外几个现场 —— 而且播放条自己也会
    // 重排：≤900px 两行（实高 117px）、≤620px 三行（163px），留位必须跟着涨。
    // 旧版一律按 `--bar-h + 24px` 让位，实测分别差 -2px / -39px / -77px。
    for (const [w, h, note] of [[1024, 768, '一行播放条'], [844, 390, '两行播放条'], [390, 844, '三行播放条']]) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const drawer = await page.evaluate(() => {
        const st = document.querySelector('.stage').getBoundingClientRect();
        const bar = document.querySelector('.bar').getBoundingClientRect();
        return { bottom: Math.round(st.bottom), barTop: Math.round(bar.top), barH: Math.round(bar.height) };
      });
      ok(drawer.barTop - drawer.bottom >= 12,
        `${w}×${h}（${note} ${drawer.barH}px）抽屉底边也停在播放条上方（净空 ${drawer.barTop - drawer.bottom}px）`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    // ---------------------------------------------------------- 其它皮肤没被带坏
    section('回归：其它皮肤的顶栏搜索框照旧');

    for (const skin of ['classic', 'workbench', 'liunian', 'qingfeng']) {
      await setSkin(page, skin);
      const r = await page.evaluate(() => {
        const cs = getComputedStyle(document.querySelector('.topsearch'));
        return { opacity: parseFloat(cs.opacity), display: cs.display, position: cs.position };
      });
      ok(r.display !== 'none' && r.opacity > 0.9,
        `${skin}：搜索框正常常驻（opacity=${r.opacity} display=${r.display}）`);
      // 其它皮肤不该带 sheen-search 的显形逻辑
      const marked = await page.evaluate(() => document.body.classList.contains('sheen-search'));
      ok(!marked, `${skin}：没有残留的 sheen-search 标记`);
      // 曲名/艺人是**浮光专属**的减法。少了 [data-skin="sheen"] 前缀（写出
      // 一条全局 `.stage-title{display:none}`）时这条会红 —— 那是"其它皮肤
      // 一起被砍功能"，在浮光的截图里看不出来。
      // liunian 自己也是摘掉的（skin.liunian.css「标题/艺术家/进度在右栏
      // 没有位置」），所以按皮肤各自的约定比，而不是一刀切"必须可见"。
      const titleShown = { classic: true, workbench: true, liunian: false, qingfeng: true }[skin];
      const shown = await page.evaluate(() => getComputedStyle(document.querySelector('.stage-title')).display);
      ok(titleShown ? shown !== 'none' : shown === 'none',
        `${skin}：曲名/艺人${titleShown ? '照旧显示' : '按它自己的设定不显示'}（display=${shown}）`);
    }

    // classic 的侧栏仍按老样子吊在顶栏下方（不能被浮光的改动带跑）。
    // 必须显式切一次：上面 for 循环虽然切过，但最后一次是 qingfeng，
    // 这里量的必须是 classic 的形状。
    await setSkin(page, 'classic');
    const classicRail = await page.evaluate(() => {
      const r = document.getElementById('rail').getBoundingClientRect();
      const tb = document.querySelector('.topbar').getBoundingClientRect();
      return {
        railTop: Math.round(r.top), railH: Math.round(r.height),
        topbarBottom: Math.round(tb.bottom),
        // 竖排侧栏高度接近整列；浮光那种横胶囊只有 ~51px
        looksVertical: r.height > 200,
      };
    });
    ok(classicRail.looksVertical,
      `classic 的侧栏是竖排长条（h=${classicRail.railH}），不是浮光那种横胶囊`);
    ok(classicRail.railTop >= classicRail.topbarBottom,
      `classic 的侧栏仍在顶栏之下（rail.top=${classicRail.railTop} ≥ ${classicRail.topbarBottom}）`);

    await setSkin(page, 'sheen');
    await page.screenshot({ path: `${SHOTS}/sheen-final.png` });

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
  console.log(`浮光顶栏布局：${checks} 项，${failures} 项失败`);
  process.exit(failures ? 1 : 0);
})();
