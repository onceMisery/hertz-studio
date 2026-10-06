#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 每日推荐折叠按钮 + 曲库勾选框可见性（浏览器验收，需 Playwright + 一个在跑的服务）。
//
//   DAILY_UI_URL=http://127.0.0.1:18776/ VMUSIC_DATA_DIR=D:/tmp/hertz-mix \
//     NODE_PATH=<装有 playwright 的 node_modules 路径> \
//     node scripts/check-daily-collapse-browser.js
//
// 令牌走 scripts/ui-token.js（`/` 已收紧，不再把令牌注入无凭据的响应）。
//
// 为什么必须浏览器 —— 这两条的失败模式**在纯 Node 契约里与"通过"完全同形**：
//
//   · 折叠按钮是 `.daily-tools` 这个 flex 行里新加的一个成员。窗口一窄它可能被
//     压成一条看不见的残影，或者反过来把左边的标题文案挤成竖排（一个字符一行）。
//     前者量不到（按钮的 rect 会是 0 宽），后者读 CSS 数值也读不出来 —— 只有真实
//     布局分得开。
//   · 勾选框"跟着鼠标跑掉"是 opacity 与 :hover / :focus-within 的组合效果。
//     离线夹具能算出 opacity 是 0，但"这条规则在五套皮肤下都成立、且没有把每一行
//     都点亮"只有真机跑得出来。
//
// 两件事都锚在"用户能感知的那一个"上：按钮看得见且点得动、勾选框在鼠标离开后
// 仍然画得出来（用 elementFromPoint 验它真的在最上层）。

'use strict';

const { chromium } = require('playwright');
const path = require('node:path');
const { uiUrl } = require('./ui-token');

const URL = process.env.DAILY_UI_URL || 'http://127.0.0.1:7634/';
const SHOTS = path.join(__dirname, '..', 'output', 'daily-collapse-check');

let checks = 0;
let failures = 0;
const ok = (cond, label, extra) => {
  checks += 1;
  if (cond) console.log(`  ok  ${label}${extra === undefined ? '' : `   [${extra}]`}`);
  else {
    failures += 1;
    console.log(`  X   ${label}${extra === undefined ? '' : `   [${extra}]`}`);
  }
};
const section = (t) => console.log(`\n${t}`);

// 量几何前先掐掉过渡/动画：否则读到的是动画中间值，不是终态。
//
// ⚠️ 但**按下时的缩放不能冻结**。曲库行有 `.track:active { transform: scale(--press-scale) }`
// （0.97），行宽 1040px 时右边缘的内容会左移约 15.6px。真机上这条 transition 是
// 240ms，一次点击只走完四分之一（约 4px），鼠标抬起时仍压在勾选框上；
// 而 `transition:none` 会让它**瞬间**走完 —— 于是 20px 的勾选框整个让开，
// 抬起时命中的是父容器 `.t-actions`，mousedown/mouseup 的目标不同，
// click 事件的目标就被归到它们的共同祖先上，原生复选框的默认动作不触发。
// 症状是"坐标量得一点不差、elementFromPoint 也对着勾选框，就是点不动"。
// 所以勾选那一组不冻结，改用显式等待让 opacity 过渡走完。
const FREEZE = `
  (function () {
    if (document.getElementById('__collapseFreeze')) return;
    var s = document.createElement('style');
    s.id = '__collapseFreeze';
    s.textContent = '*{transition:none !important;animation:none !important}';
    document.head.appendChild(s);
  })();
`;

/// 撤掉冻结（勾选那一组要用真实的按压过渡）。
///
/// ⚠️ 必须摘**全部**同名节点，不能 `getElementById(...).remove()` 只摘一个：
/// 这个函数被每组各调一次，每调一次就多注入一份；按 id 只摘第一份时，剩下的
/// 那几份照样 `!important` 生效 —— 而症状极具误导性：勾选框的坐标量得一点不差、
/// elementFromPoint 也对着它，就是点不动。实测踩过（见下面 checkRowCheckbox 里
/// 那段"按下时行被缩放"的说明）。
const unfreeze = (page) => page.evaluate(() => {
  document.querySelectorAll('#__collapseFreeze').forEach((s) => s.remove());
});

/// 一帧之后再取数：布局要等一帧才落定（SwiftShader 下 rAF 尤其慢）。
const settle = (page) => page.evaluate(
  () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function setSkin(page, id) {
  await page.evaluate((skin) => { window.Skins.apply(skin); }, id);
  await settle(page);
}

async function gotoLibrary(page) {
  // 不点 rail：流年把侧栏收成胶囊、浮光把导航换成顶部胶囊，
  // `.rail-item[data-view=library]` 在那两套皮肤下存在却被 Playwright 判不可见。
  // 直接调它自己的 onclick，走的仍是业务路径（app.js 里就是 setView(...)）。
  await page.evaluate(() => {
    const item = document.querySelector('.rail-item[data-view="library"]');
    if (item && typeof item.onclick === 'function') item.onclick();
    else if (typeof setView === 'function') setView('library');
  });
  await page.waitForSelector('#view-library:not([hidden])', { timeout: 8000 });
  await page.evaluate(FREEZE);
  await settle(page);
}

/// 每日推荐条与折叠按钮的当前状态。所有判据都从这里取数，避免各处 selector 漂移。
const stripState = (page) => page.evaluate(() => {
  const strip = document.getElementById('daily-strip');
  const list = document.getElementById('daily-list');
  const head = document.querySelector('.daily-head');
  const copy = document.querySelector('.daily-head .daily-copy');
  const tools = document.querySelector('.daily-head .daily-tools');
  const btn = document.getElementById('daily-toggle');
  const refresh = document.getElementById('daily-refresh');
  if (!strip || !btn) return { missing: true };
  const br = btn.getBoundingClientRect();
  const cr = copy ? copy.getBoundingClientRect() : null;
  const tr = tools.getBoundingClientRect();
  const cs = getComputedStyle(btn);
  // 命中测试：按钮中心点必须归属于按钮自己（被别的节点盖住时也点不动）
  const at = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
  const icon = btn.querySelector('svg');
  const ir = icon ? icon.getBoundingClientRect() : null;
  return {
    missing: false,
    stripH: Math.round(strip.getBoundingClientRect().height),
    stripPadTop: parseFloat(getComputedStyle(strip).paddingTop),
    listDisplay: getComputedStyle(list).display,
    listH: Math.round(list.getBoundingClientRect().height),
    headH: Math.round(head.getBoundingClientRect().height),
    copyW: cr ? Math.round(cr.width) : 0,
    copyH: cr ? Math.round(cr.height) : 0,
    toolsScrollW: tools.scrollWidth,
    toolsClientW: tools.clientWidth,
    btnW: Math.round(br.width),
    btnH: Math.round(br.height),
    btnDisplay: cs.display,
    btnVisibility: cs.visibility,
    btnOpacity: cs.opacity,
    iconW: ir ? Math.round(ir.width) : 0,
    iconH: ir ? Math.round(ir.height) : 0,
    hitsSelf: !!(at && (at === btn || btn.contains(at))),
    expanded: btn.getAttribute('aria-expanded'),
    label: btn.getAttribute('aria-label'),
    inTools: !!(tools && tools.contains(btn)),
    inStrip: !!(strip && strip.contains(btn)),
    refreshVisible: refresh ? refresh.getBoundingClientRect().height > 0 : false,
  };
});

/// 真机点一次折叠按钮。返回 '' 表示点成功，否则是失败名 —— 「按钮不见了」这种
/// 坏法应当变成一条红的断言，而不是把整个脚本挂死成"环境有问题"。
async function clickToggle(page) {
  try { await page.click('#daily-toggle', { timeout: 4000 }); return ''; }
  catch (e) { return e.name; }
}

/// 每日推荐条在**某套皮肤**下的通用判据：按钮拿得到、不溢出、文案没被挤成竖排、
/// 且真的能收起与展开。逐皮肤跑这一组，是因为皮肤的布局全是 `[data-skin=...]`
/// 包起来的：classic 上成立不代表别的皮肤上成立 —— 而这次报障的诉求恰恰是
/// "除清风外每套皮肤都要有这个按钮"。
async function checkSkin(page, skin, label) {
  await setSkin(page, skin);
  await gotoLibrary(page);
  const s = await stripState(page);

  ok(!s.missing, `${label}：每日推荐条与折叠按钮都在`);
  if (s.missing) return null;

  ok(s.btnW > 0 && s.btnH > 0 && s.btnDisplay !== 'none' && s.btnVisibility !== 'hidden'
    && Number(s.btnOpacity) > 0.9,
  `${label}：折叠按钮可见且有实际尺寸`, `${s.btnW}×${s.btnH} display=${s.btnDisplay} opacity=${s.btnOpacity}`);
  ok(s.inTools && s.inStrip, `${label}：按钮挂在标题行的工具栏里（不是掉到别处）`);
  ok(s.hitsSelf, `${label}：按钮中心点命中的是自己（没被别的节点盖住）`);
  ok(s.iconW > 0 && s.iconH > 0, `${label}：chevron 图标真的画出来了`, `${s.iconW}×${s.iconH}`);
  // 工具栏是 flex：装不下时子项会被压窄，按钮自己 flex:none 挡得住，
  // 但整行溢出会把它推到容器外 —— 两个都量。
  ok(s.toolsScrollW <= s.toolsClientW + 1,
    `${label}：工具栏装得下全部按钮（没有横向溢出）`,
    `scrollW=${s.toolsScrollW} clientW=${s.toolsClientW}`);
  // 「文案被压成竖排」的判据：宽远小于高。多一个按钮不该把标题挤成一条竖线。
  ok(s.copyW > s.copyH, `${label}：标题文案没被挤成竖排`, `${s.copyW}×${s.copyH}`);

  // 点得动 + 收起的是卡片区（标题行留下）
  const before = s;
  const err1 = await clickToggle(page);
  await settle(page);
  const shut = await stripState(page);
  ok(!err1, `${label}：折叠按钮点得动`, err1 || 'ok');
  ok(shut.listDisplay === 'none' && shut.listH === 0,
    `${label}：卡片区真的收起了`, `display=${shut.listDisplay} listH=${shut.listH}`);
  ok(shut.stripH > 0 && shut.stripH < before.stripH,
    `${label}：条变矮但仍在（标题行没被一起收掉）`, `${before.stripH} → ${shut.stripH}`);
  ok(shut.headH > 0 && shut.refreshVisible && shut.btnH > 0,
    `${label}：标题行 / 刷新 / 折叠按钮都留在原地`,
    `headH=${shut.headH} refresh=${shut.refreshVisible} btn=${shut.btnH}`);
  ok(shut.expanded === 'false' && /展开/.test(shut.label || ''),
    `${label}：aria-expanded 与无障碍名翻到"展开"`, `${shut.expanded} / ${shut.label}`);

  const err2 = await clickToggle(page);
  await settle(page);
  const back = await stripState(page);
  ok(!err2 && back.listDisplay !== 'none' && back.expanded === 'true',
    `${label}：再点一次能展开回来`, `${err2 || 'ok'} display=${back.listDisplay}`);
  ok(Math.abs(back.stripH - before.stripH) <= 1,
    `${label}：展开后高度与收起前一致（折叠不留残余内距）`,
    `${before.stripH} vs ${back.stripH}`);

  await page.screenshot({ path: path.join(SHOTS, `daily-${skin}.png`) });
  return back;
}

/// 曲库行的勾选框：选中之后，鼠标移到下一首歌时它的勾选框**必须还在**。
/// 这就是报障的复现路径（"选下一首歌的时候选中的勾选框没展示"）。
async function checkRowCheckbox(page) {
  await setSkin(page, 'classic');
  await gotoLibrary(page);
  // 这一组要的是**真实按压行为**，所以把冻结撤掉（理由见 FREEZE 上面那段）。
  // 代价是读 opacity 前要等过渡走完（0.2s），下面每次点击后都显式等 350ms。
  await unfreeze(page);

  // 先把每日推荐收起来。两件事一起办：
  //   · 顺带在真机上再验一次折叠按钮（离线契约与逐皮肤那组之外的一次独立确认）；
  //   · 更实际的是**给列表腾出空间** —— 推荐条展开时高约 480px，曲库行会被挤到
  //     视口下半部，而批量栏是 `position: sticky; bottom: 72px`，会浮上来把
  //     头几行压住（实测 elementFromPoint 落在 .lib-batch 上），
  //     那样后面的命中判据量到的是浮层而不是勾选框。
  const stripNow = await stripState(page);
  if (stripNow.listDisplay !== 'none') {
    const e = await clickToggle(page);
    await page.waitForTimeout(350);
    ok(!e, '（前置）收起每日推荐，把纵向空间让给曲库列表', e || 'ok');
  }
  const stripAfter = await stripState(page);
  ok(stripAfter.listDisplay === 'none', '（前置）推荐条已收起', `display=${stripAfter.listDisplay}`);

  // 用**真实的渲染路径**造 3 行：给 state 灌数据再调 renderLibrary()，
  // 于是走的仍是 createTrackRow / updateTrackRow 那一套，
  // 不是脚本自己拼一份同名 DOM（那样测的是仿制品）。
  const injected = await page.evaluate(() => {
    const mk = (i) => ({
      id: 'probe-' + i, title: '验收曲目 ' + i, artist: '验收艺人', album: '验收专辑',
      duration_ms: 200000 + i * 1000, has_cover: false,
      sample_rate: 44100, bitrate: null,
    });
    state.tracks = [mk(1), mk(2), mk(3)];
    state.total = 3;
    state.byId = new Map(state.tracks.map((t) => [t.id, t]));
    state.selected.clear();
    renderLibrary();
    return document.querySelectorAll('#lib-list .track').length;
  });
  ok(injected === 3, '造出 3 行曲库行（走真实渲染路径）', `rows=${injected}`);
  if (injected !== 3) return;

  // 前置：冻结真的撤干净了。
  //
  // 曲库行有 `.track:active { transform: scale(0.97) }`（行宽 1040 时右端内容左移
  // 约 16px）。真机上这条 transition 是 240ms，一次点击只走完一小截，鼠标抬起时
  // 仍压在勾选框上；而 `transition:none !important` 会让它**瞬间**走完 ——
  // mousedown 命中 INPUT、mouseup 已经落在隔壁那颗图标按钮的 <svg> 上，
  // click 的目标于是被归到两者的共同祖先 `.t-actions`（`e.target.closest('.t-select')`
  // 为空，原生复选框的默认动作也不触发）。症状是"坐标一点不差、就是点不动"。
  // 所以这条前置不能省：它正是那类"改了脚本、断言全红"的假故障的探测器。
  const guard = await page.evaluate(() => {
    const row = document.querySelector('#lib-list .track');
    const cs = getComputedStyle(row);
    return {
      freezeLeft: document.querySelectorAll('#__collapseFreeze').length,
      duration: cs.transitionDuration,
    };
  });
  ok(guard.freezeLeft === 0 && !/^(0s,\s*)+0s$/.test(guard.duration.replace(/\s/g, ' ')),
    '（前置）动画冻结已撤干净，按压过渡是真实的',
    `冻结节点=${guard.freezeLeft} transitionDuration=${guard.duration}`);

  // 命中点自己算，再交给 page.mouse：locator.click 会 scrollIntoViewIfNeeded，
  // 滚一下行就挪位了（这个仓库踩过不止一次）。
  const boxCenter = (i) => page.evaluate((idx) => {
    const box = document.querySelectorAll('#lib-list .track')[idx].querySelector('.t-select');
    const r = box.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, i);

  const readRows = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#lib-list .track')];
    return rows.map((row) => {
      const box = row.querySelector('.t-select');
      const acts = row.querySelector('.t-actions');
      const r = box.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        checked: box.checked,
        selected: row.classList.contains('is-selected'),
        opacity: Number(getComputedStyle(acts).opacity),
        tickOpacity: Number(getComputedStyle(box, '::after').opacity),
        boxW: Math.round(r.width),
        boxBottom: Math.round(r.bottom),
        // 命中归属：中心点是不是这个勾选框（画得出来才点得到）
        hitsSelf: !!(at && (at === box || box.contains(at))),
        hover: row.matches(':hover'),
        focusWithin: row.matches(':focus-within'),
      };
    });
  });

  const before = await readRows();
  ok(before.length === 3 && before.every((r) => !r.selected && r.opacity < 0.1),
    '（前置）未勾选时三行的操作区都是收起的',
    before.map((r) => r.opacity).join('/'));

  // 记下真实点击落到谁身上、以及那一刻的几何。坐标算对了却"没反应"时，
  // 这是唯一的线索 —— 最典型的过错是**按下时行被 :active 缩放**：
  // mousedown 命中勾选框、mouseup 时它已经让开，click 的目标被归到共同祖先
  // `.t-actions` 上，原生复选框的默认动作于是不触发（脚本量到的坐标却毫无问题）。
  await page.evaluate(() => {
    window.__rowClickLog = [];
    const snap = (tag, e) => {
      const row = e.target.closest ? e.target.closest('.track') : null;
      const box = row ? row.querySelector('.t-select') : null;
      const br = box ? box.getBoundingClientRect() : null;
      const a = document.elementFromPoint(e.clientX, e.clientY);
      window.__rowClickLog.push([
        tag, e.target.tagName + '.' + (e.target.className || ''),
        'sel=' + !!(e.target.closest && e.target.closest('.t-select')),
        `@${Math.round(e.clientX)},${Math.round(e.clientY)}`,
        'box=' + (br ? [Math.round(br.left), Math.round(br.top), Math.round(br.right), Math.round(br.bottom)].join('/') : '-'),
        'rowTf=' + (row ? getComputedStyle(row).transform : '-'),
        'at=' + (a ? a.tagName + '.' + (a.className || '') : '-'),
      ].join(' '));
    };
    document.addEventListener('mousedown', (e) => snap('down', e), true);
    document.addEventListener('mouseup', (e) => snap('up', e), true);
    document.addEventListener('click', (e) => snap('click', e), true);
  });

  // 勾第一首。鼠标自然停在第一行上 —— 此刻它是靠 hover 显形的，还不算数。
  const c1 = await boxCenter(0);
  await page.mouse.click(c1.x, c1.y);
  await page.waitForTimeout(350);

  // ⭐ 报障的那一步：去勾第二首。第一行随之失去 hover 与焦点。
  const c2 = await boxCenter(1);
  await page.mouse.click(c2.x, c2.y);
  await page.waitForTimeout(350);

  const after = await readRows();
  const clickLog = await page.evaluate(() => window.__rowClickLog);
  // 前置：批量栏浮出来后不能压住被测的那两行（否则后面量的是浮层）。
  const barTop = await page.evaluate(() => {
    const bar = document.getElementById('lib-batch-bar');
    if (!bar || bar.hidden) return null;
    return Math.round(bar.getBoundingClientRect().top);
  });

  ok(after[0].checked && after[0].selected, '第一首确实被勾上了（state 与行上都记着）',
    `checked=${after[0].checked} is-selected=${after[0].selected} 点击=${JSON.stringify(clickLog)}`);
  ok(after[1].checked && after[1].selected, '第二首也被勾上了',
    `checked=${after[1].checked} 点击=${JSON.stringify(clickLog)}`);
  ok(!after[0].hover && !after[0].focusWithin,
    '（前置）此刻鼠标与焦点都在第二行，第一行两样都没有',
    `hover=${after[0].hover} focusWithin=${after[0].focusWithin}`);
  ok(after[0].opacity > 0.9,
    '⭐ 选下一首时，上一首的勾选框仍然展示（不再跟着鼠标跑掉）',
    `opacity=${after[0].opacity}`);
  ok(after[1].opacity > 0.9, '第二首（鼠标所在行）的勾选框也展示');
  ok(after[0].hitsSelf && after[0].boxW > 0,
    '第一首的勾选框在最上层且点得到（不是透明地被盖住）',
    `hitsSelf=${after[0].hitsSelf} w=${after[0].boxW}`);
  ok(barTop === null || barTop >= after[1].boxBottom,
    '（前置）浮出的批量栏在选中行下方，没压住被测的那两行',
    `barTop=${barTop} 第二首下沿=${after[1].boxBottom}`);
  // 只给已选行点灯，其余行照旧收起 —— 否则等于"每一行都常亮"，勾没勾分不出来。
  ok(after[2].opacity < 0.1 && !after[2].selected,
    '未勾选的第三行仍保持收起（不是把每一行都点亮）', `opacity=${after[2].opacity}`);
  // 对勾的**有效可见度**：::after 自己是 1，祖先透明时渲染乘积仍是 0。
  ok(after[0].tickOpacity * after[0].opacity > 0.9,
    '对勾的有效可见度 = 伪元素 × 操作区（祖先透明会把它一起抹掉）',
    `${after[0].tickOpacity} × ${after[0].opacity}`);

  await page.screenshot({ path: path.join(SHOTS, 'lib-rows-selected.png') });

  // 取消选择：两处一起摘干净
  const cleared = await page.evaluate(() => {
    clearSelection();
    const rows = [...document.querySelectorAll('#lib-list .track')];
    return {
      left: rows.filter((r) => r.classList.contains('is-selected')).length,
      checked: rows.filter((r) => r.querySelector('.t-select').checked).length,
      selected: state.selected.size,
    };
  });
  ok(cleared.left === 0 && cleared.checked === 0 && cleared.selected === 0,
    '取消选择后三处一起归零', JSON.stringify(cleared));
}

(async () => {
  const fs = require('node:fs');
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await page.goto(uiUrl(URL), { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Skins && window.Daily, null, { timeout: 15000 });

    // ---------------------------------------------------------------- 基线
    section('经典：折叠按钮的基本行为');
    await setSkin(page, 'classic');
    await gotoLibrary(page);
    const openBox = await stripState(page);
    ok(!openBox.missing, '每日推荐条与折叠按钮都在');
    ok(openBox.listDisplay !== 'none' && openBox.expanded === 'true', '初始是展开态',
      `display=${openBox.listDisplay} aria-expanded=${openBox.expanded}`);

    // 收起 → 刷新 → 仍收起（本机偏好）
    const err = await clickToggle(page);
    await settle(page);
    const shutBox = await stripState(page);
    ok(!err && shutBox.listDisplay === 'none', '收起后卡片区不显示', err || `display=${shutBox.listDisplay}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Skins && window.Daily, null, { timeout: 15000 });
    await gotoLibrary(page);
    const afterReload = await stripState(page);
    ok(afterReload.listDisplay === 'none' && afterReload.expanded === 'false',
      '刷新后仍是收起态（不必每次回来重新收一遍）',
      `display=${afterReload.listDisplay} aria-expanded=${afterReload.expanded}`);
    // 归位，免得后面的组从"已收起"起步
    await clickToggle(page);
    await settle(page);
    const restored = await stripState(page);
    ok(restored.listDisplay !== 'none', '再点一次展开（收起态不是单向的）',
      `display=${restored.listDisplay}`);

    // ------------------------------------------------------- 逐皮肤
    section('五套皮肤都要拿得到这颗按钮');
    for (const [id, label] of [
      ['classic', '经典'], ['sheen', '浮光'], ['workbench', '工作台'],
      ['liunian', '流年'], ['ios', 'OS风'], ['qingfeng', '清风'],
    ]) {
      await checkSkin(page, id, label);
    }

    // ------------------------------------------------------- 窄视口
    // 折叠按钮是这一行里第 5 个控件；窗口一窄它最先被牺牲。969×800 是
    // 「三列还撑着、但内容栏已经很紧」的一档。
    section('窄窗口：按钮不能被压掉、文案不能竖排');
    await page.setViewportSize({ width: 969, height: 800 });
    for (const [id, label] of [['classic', '经典'], ['ios', 'OS风'], ['qingfeng', '清风']]) {
      await setSkin(page, id);
      await gotoLibrary(page);
      const s = await stripState(page);
      ok(!s.missing && s.btnW > 0 && s.hitsSelf,
        `${label}@969：折叠按钮仍可见可点`, s.missing ? '按钮不存在' : `${s.btnW}×${s.btnH} hitsSelf=${s.hitsSelf}`);
      ok(s.copyW > s.copyH, `${label}@969：标题文案没被挤成竖排`, `${s.copyW}×${s.copyH}`);
      ok(s.toolsScrollW <= s.toolsClientW + 1, `${label}@969：工具栏不横向溢出`,
        `scrollW=${s.toolsScrollW} clientW=${s.toolsClientW}`);
      await page.screenshot({ path: path.join(SHOTS, `daily-${id}-narrow.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // ------------------------------------------------------- 勾选框
    section('曲库行：选下一首时，上一首的勾选框要还在');
    await checkRowCheckbox(page);

    ok(errors.length === 0, '全程无页面 JS 报错', errors.slice(0, 3).join(' | ') || '无');
  } catch (e) {
    failures += 1;
    checks += 1;
    console.log(`\n  X   脚本异常：${e && e.message}`);
    try { await page.screenshot({ path: path.join(SHOTS, 'error.png') }); } catch (_) { /* 忽略 */ }
  } finally {
    await browser.close();
  }

  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`每日推荐折叠 / 勾选框可见性：${checks} 项，${failures} 项失败`);
  console.log(`截图：${SHOTS}`);
  process.exit(failures ? 1 : 0);
})();
