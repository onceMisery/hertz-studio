// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 共享设置浮层（skins/skin-settings-sheet.js）的浏览器验收。
//
// 为什么必须用真浏览器：这层的失败模式全是**静默**的 ——
//   · 分组没归类 → 全部落进「其它」，浮层照常打开，只是分类是错的；
//   · 关闭后 hidden 摘不干净 → 切皮肤后设置页只剩一组，不报错；
//   · 拦截没接上（MutationObserver 没触发）→ 点 rail 的「设置」毫无反应；
//   · 关闭键与右栏滚动条重叠 → 只有量真实矩形才分得开。
//
// 跑法（先起服务）：
//   NODE_PATH="$W" node scripts/check-settings-sheet-browser.js
// 端口用 SETTINGS_SHEET_URL 覆盖，默认 7634。凭据走 VMUSIC_UI_TOKEN 或
// VMUSIC_DATA_DIR（scripts/ui-token.js 从数据目录的 token 文件读）。

const path = require('path');
const { chromium } = require('playwright');
const { uiUrl } = require('./ui-token');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.SETTINGS_SHEET_URL || 'http://127.0.0.1:7634';
const SHOT_DIR = path.join(ROOT, 'output', 'settings-sheet');
const WIDTH = 1440;
const HEIGHT = 900;

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  X ' + label); }
  else console.log('  ok - ' + label);
}
function eq(a, b, label) { ok(a === b, `${label}（得到 ${JSON.stringify(a)}）`); }

// 与 skin-settings-sheet.js 的 SET_SECTIONS 同序的期望值（条目顺序归分类表
// 管，不归 DOM 次序）。分组总数由这张表派生，业务新增设置只改这里。
const EXPECTED = [
  ['外观', ['界面皮肤', '外观', '主题与壁纸', '导航', '海报墙']],
  ['播放', ['音效与均衡器', '播放', '歌词', '歌词输出（OBS 浮层）', '歌词视频导出', '窗口与舞台', '创意舞台', '快捷键']],
  ['数据与在线', ['在线音源', '远程来源（WebDAV）', '在线缓存', '数据备份']],
  ['高级', ['开发者选项']],
];
const EXPECTED_LABELS = EXPECTED.reduce((a, c) => a.concat(c[1]), []);
const EXPECTED_TOTAL = EXPECTED_LABELS.length;

async function disableTransitions(page) {
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = '__noTrSheet';
    s.textContent = '*{transition:none !important;animation:none !important}';
    document.head.appendChild(s);
  });
}

async function openViaRail(page, skin) {
  await page.evaluate((id) => { window.Skins.apply(id); }, skin);
  await page.waitForFunction(() => !!window.SkinSettingsSheet && window.SkinSettingsSheet.isMounted());
  await page.click('.rail-item[data-view="settings"]');
  await page.waitForFunction(() => {
    const m = document.querySelector('.skset-modal');
    return m && !m.hidden && !!document.querySelector('.skset-modal-card .skset-link');
  });
}

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await page.goto(uiUrl(BASE), { timeout: 20000, waitUntil: 'load' });
    await page.waitForFunction(() => window.Skins && window.Theme, null, { timeout: 20000 });

    // --- 1) 入口拦截：classic 下点 rail 的「设置」必须打开共享浮层 ---
    await openViaRail(page, 'classic');
    await disableTransitions(page);

    const nav = await page.evaluate(() => ({
      links: [...document.querySelectorAll('.skset-nav .skset-link')].map((b) => ({
        key: b.dataset.sksetKey,
        label: b.textContent,
        active: b.classList.contains('is-active'),
      })),
      viewInPane: !!document.querySelector('.skset-pane #view-settings'),
      // 浮层头已有一级标题 + 说明：视图自带的「设置」col-head 在浮层内
      // 必须是 display:none（重复标题是明确的视觉缺陷）。
      colHead: (() => {
        const el = document.querySelector('.skset-pane > #view-settings > .col-head');
        return el ? getComputedStyle(el).display : '(missing)';
      })(),
    }));
    eq(nav.links.map((l) => l.label).join(' / '),
      EXPECTED_LABELS.join(' / '),
      '左栏条目覆盖全部设置分组且顺序与分类表一致');
    ok(!nav.links.some((l) => l.label === '其它'),
      `没有落到「其它」——说明 ${EXPECTED_TOTAL} 个分组全被认领了`);
    ok(nav.viewInPane, '#view-settings 已搬进浮层右栏');
    eq(nav.colHead, 'none', '浮层内不再显示重复的「设置」标题（col-head 已藏）');
    eq(nav.links.filter((l) => l.active).length, 1, '打开时左栏恰好一个选中项');

    // --- 1b) 卡片头：左上角「设置」标题 + 关闭键同行 -------------------------
    const head = await page.evaluate(() => {
      const h = document.querySelector('.skset-modal-card .skset-modal-head');
      return {
        title: h && h.querySelector('h2') ? h.querySelector('h2').textContent : '',
        closeInHead: !!(h && h.querySelector('.skset-modal-close')),
      };
    });
    eq(head.title, '设置', '卡片左上角有「设置」标题');
    ok(head.closeInHead, '关闭键与标题同排（卡片头）');

    // --- 2) 一次只显示一组：逐条点过去验可见性 ---
    for (let i = 0; i < nav.links.length; i += 1) {
      const res = await page.evaluate((idx) => {
        const btn = document.querySelectorAll('.skset-nav .skset-link')[idx];
        btn.click();
        const shown = [...document.querySelectorAll('#view-settings .set-group')]
          .filter((g) => !g.hidden)
          .map((g) => g.querySelector('.set-title').textContent.trim());
        return { label: btn.textContent, shown };
      }, i);
      eq(res.shown.join(), res.label, `点「${res.label}」右栏只显示它自己`);
    }

    // --- 3) 关闭键不压住右栏滚动条（本次修的重叠）---
    const overlap = await page.evaluate(() => {
      const close = document.querySelector('.skset-modal-close').getBoundingClientRect();
      const pane = document.querySelector('.skset-pane').getBoundingClientRect();
      const card = document.querySelector('.skset-modal-card').getBoundingClientRect();
      return {
        // 关闭键的下缘必须高于右栏（连同滚动条）的上缘
        clear: close.bottom <= pane.top + 1,
        closeInCard: close.left >= card.left && close.right <= card.right
          && close.top >= card.top && close.bottom <= card.bottom,
        gap: Math.round(pane.top - close.bottom),
      };
    });
    ok(overlap.closeInCard, '关闭键完整落在卡片内');
    ok(overlap.clear, `关闭键与右栏滚动条不再重叠（净距 ${overlap.gap}px）`);

    // --- 4) 悬停旋转：强制 hover 后读计算样式的终值 ---
    await page.hover('.skset-modal-close');
    const rot = await page.evaluate(() => getComputedStyle(document.querySelector('.skset-modal-close svg')).transform);
    ok(rot !== 'none' && /matrix/.test(rot), `悬停时叉叉旋转（transform=${rot}）`);

    // --- 5) 右栏滚动：长分组（主题与壁纸）能滚到底 ---
    const scroll = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.skset-nav .skset-link')]
        .find((b) => b.textContent === '主题与壁纸');
      btn.click();
      const pane = document.querySelector('.skset-pane');
      const before = pane.scrollTop;
      pane.scrollTop = pane.scrollHeight;
      return { moved: pane.scrollTop > before, overflow: getComputedStyle(pane).overflowY };
    });
    ok(scroll.moved, '长分组（主题与壁纸）在右栏里能滚到底');
    eq(scroll.overflow, 'auto', '滚动容器是 .skset-pane');

    // --- 5b) 真实滚轮：右栏内容上的滚轮归 .skset-pane，左栏归 .skset-nav ----
    // 此前 #view-settings 自带 overflow:auto + overscroll-behavior:contain，
    // 无溢出也以滚动容器身份占住滚轮链 —— 右栏内容上滚轮完全失灵，用户
    // 「只能拖滚动条」。这里用真鼠标滚轮（CDP 输入管线）钉住两条链路。
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.skset-nav .skset-link')]
        .find((b) => b.textContent === '主题与壁纸');
      btn.click();
      document.querySelector('.skset-pane').scrollTop = 0;
    });
    const paneBox = await page.evaluate(() => {
      const p = document.querySelector('.skset-pane').getBoundingClientRect();
      return { x: p.x + p.width / 2, y: p.y + p.height / 2 };
    });
    await page.mouse.move(paneBox.x, paneBox.y);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(120);
    const paneWheeled = await page.evaluate(() => ({
      pane: document.querySelector('.skset-pane').scrollTop,
      overflow: document.querySelector('.skset-pane').scrollHeight - document.querySelector('.skset-pane').clientHeight,
    }));
    ok(paneWheeled.overflow > 0 && paneWheeled.pane > 0,
      `右栏内容上的滚轮能滚 .skset-pane（scrollTop ${paneWheeled.pane} / 溢出 ${paneWheeled.overflow}）`);

    await page.evaluate(() => {
      document.querySelector('.skset-nav').scrollTop = 0;
      document.querySelector('.skset-pane').scrollTop = 0;
    });
    const navBox = await page.evaluate(() => {
      const n = document.querySelector('.skset-nav').getBoundingClientRect();
      return { x: n.x + n.width / 2, y: n.y + n.height / 2 };
    });
    await page.mouse.move(navBox.x, navBox.y);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(120);
    const navWheeled = await page.evaluate(() => ({
      nav: document.querySelector('.skset-nav').scrollTop,
      overflow: document.querySelector('.skset-nav').scrollHeight - document.querySelector('.skset-nav').clientHeight,
      pane: document.querySelector('.skset-pane').scrollTop,
    }));
    ok(navWheeled.overflow > 0 && navWheeled.nav > 0,
      `左栏上的滚轮能滚 .skset-nav（scrollTop ${navWheeled.nav} / 溢出 ${navWheeled.overflow}）`);
    eq(navWheeled.pane, 0, '左栏的滚轮不串动右栏');

    await page.screenshot({ path: path.join(SHOT_DIR, 'settings-sheet-classic.png') });

    // --- 6) 持久化 + 导航入口重开停在同类 ---
    // 经典皮肤把顶栏齿轮摘了（见 skin.classic.css），入口换成侧栏那条。
    const persisted = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.skset-nav .skset-link')]
        .find((b) => b.textContent === '快捷键');
      btn.click();
      return localStorage.getItem('vmusic.skset-section');
    });
    eq(persisted, 'keys', '选中分类写进了 localStorage');
    await page.click('.skset-modal-close');
    await page.waitForFunction(() => { const m = document.querySelector('.skset-modal'); return m && m.hidden; });
    await page.click('.rail-item[data-view="settings"]');
    await page.waitForFunction(() => {
      const m = document.querySelector('.skset-modal');
      return m && !m.hidden && document.querySelector('.skset-link.is-active');
    });
    const reopened = await page.evaluate(() => {
      const active = document.querySelector('.skset-link.is-active');
      return {
        label: active ? active.textContent : '',
        shown: [...document.querySelectorAll('#view-settings .set-group')]
          .filter((g) => !g.hidden).map((g) => g.querySelector('.set-title').textContent.trim()),
      };
    });
    eq(reopened.label, '快捷键', '重开浮层仍停在上次那一类');
    eq(reopened.shown.join(), '快捷键', '重开后该分组是可见的');

    // --- 7) 关闭后 app 的视图送回首页（不是停在 settings 等着 Esc 复发）---
    await page.click('.skset-modal-close');
    await page.waitForFunction(() => { const m = document.querySelector('.skset-modal'); return m && m.hidden; });
    const backHome = await page.evaluate(() => {
      const active = document.querySelector('.rail-item.active');
      const view = document.getElementById('view-settings');
      return {
        rail: active ? active.dataset.view : '',
        settingsHidden: view.hidden,
        modalHidden: document.querySelector('.skset-modal').hidden,
        bodyLocked: document.body.classList.contains('skset-modal-open'),
      };
    });
    eq(backHome.rail, 'library', '关闭浮层后 app 落回首页（防止 Esc 复发）');
    ok(backHome.settingsHidden && backHome.modalHidden && !backHome.bodyLocked,
      '关闭后浮层、视图与底层隔离标记都收干净');

    // --- 8) 可还原：切走皮肤后分组无 hidden 残留、无锚点残留 ---
    await page.evaluate(() => { window.Skins.apply('sheen'); });
    await page.waitForFunction(() => !!document.querySelector('.skset-pane #view-settings'));
    const rebuilt = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('#view-settings .set-group')];
      return {
        total: groups.length,
        hidden: groups.filter((g) => g.hidden).length,
        anchors: document.querySelectorAll('.skset-anchor').length,
      };
    });
    eq(rebuilt.total, EXPECTED_TOTAL, `切到 sheen 后 ${EXPECTED_TOTAL} 个分组都在（没被误删）`);
    // 原位锚点：视图住在浮层里，column 里应该恰好留一个锚点 ——
    // 数出两个才是真泄漏（上一次挂载的还原没跑干净）。
    eq(rebuilt.anchors, 1, '原位锚点恰好一个（不是上次挂载残留的第二个）');
    await page.evaluate(() => { window.Skins.apply('classic'); });
    await page.waitForFunction(() => {
      const groups = document.querySelectorAll('#view-settings .set-group');
      return groups.length > 0;
    });
    const restored = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('#view-settings .set-group')];
      return {
        total: groups.length,
        hidden: groups.filter((g) => g.hidden).length,
        anchors: document.querySelectorAll('.skset-anchor').length,
        viewInPane: !!document.querySelector('.skset-pane #view-settings'),
      };
    });
    eq(restored.total, EXPECTED_TOTAL, `切回 classic 后 ${EXPECTED_TOTAL} 个分组都在`);
    eq(restored.hidden, 0, '切回 classic 后没有任何分组残留 hidden（漏掉就是「设置里其它项全没了」）');
    eq(restored.anchors, 1, '切回 classic 后原位锚点恰好一个（没有累积）');
    ok(restored.viewInPane, 'classic 下设置视图重新住进共享浮层');

    // --- 9) 剩余皮肤逐个过一遍：chaoxi 在自己的
    // 生命周期里调 mount/unmount（卸载顺序要求更严：先还视图再拆浮层）。
    // 每个皮肤都完整走一遍 开 → 关 → 回首页。
    for (const skin of ['chaoxi']) {
      await openViaRail(page, skin);
      const leg = await page.evaluate(() => {
        const modal = document.querySelector('.skset-modal');
        const shown = [...document.querySelectorAll('#view-settings .set-group')]
          .filter((g) => !g.hidden).length;
        return {
          open: !!modal && !modal.hidden,
          viewInPane: !!document.querySelector('.skset-pane #view-settings'),
          shown,
        };
      });
      ok(leg.open && leg.viewInPane && leg.shown === 1,
        `${skin}：设置以共享浮层打开且只露一组（露 ${leg.shown} 组）`);
      await page.click('.skset-modal-close');
      await page.waitForFunction(() => { const m = document.querySelector('.skset-modal'); return m && m.hidden; });
      const after = await page.evaluate(() => ({
        rail: (document.querySelector('.rail-item.active') || {}).dataset?.view || '',
        bodyLocked: document.body.classList.contains('skset-modal-open'),
      }));
      eq(after.rail, 'library', `${skin}：关闭浮层后 app 落回首页`);
      ok(!after.bodyLocked, `${skin}：底层隔离标记已摘`);
    }
    await page.evaluate(() => { window.Skins.apply('classic'); });
    await page.waitForFunction(() => !!document.querySelector('.skset-pane #view-settings'));
    // 挂载期间分组保持 hidden（只露当前组）是设计行为；契约是**卸载时清干净**
    // —— 挂过 chaoxi 再回到 classic，一组都不许带着 hidden。
    const drained = await page.evaluate(() =>
      [...document.querySelectorAll('#view-settings .set-group')].filter((g) => g.hidden).length);
    eq(drained, 0, '轮换 chaoxi 后回到 classic，分组无 hidden 残留');

    await page.screenshot({ path: path.join(SHOT_DIR, 'settings-sheet-rebuilt.png') });

    eq(errors.length, 0, `全程无未捕获页面错误${errors.length ? '：' + errors.join(' | ') : ''}`);
  } finally {
    await browser.close();
  }

  console.log('\n' + '-'.repeat(56));
  console.log(`共享设置浮层（浏览器）：${checks - failures}/${checks} 通过`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
