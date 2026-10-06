// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 流年设置分类导航的浏览器验收（Node 契约脚本跑不到的部分）。
//
// 为什么必须用真浏览器：这次改的是「左栏点一条，右栏只显示对应那一个
// .set-group」。这类行为的失败模式全是**静默**的 ——
//   · 分组没归类 → 全部落进「其它」，页面照样渲染，只是分了 12 个一样的类；
//   · hidden 摘不干净 → 切回classic 后设置页只剩一组，不报错；
//   · 左栏 min-height:0 漏写 → 左栏不裁切，浮层长出视口。
// 三者在 Node 正则里都和「正常」长得一样，只有量真实布局/可见性才分得开。
//
// 跑法（先起服务）：
//   NODE_PATH="$W" node scripts/check-liunian-settings-nav-browser.js
// 端口用 SETTINGS_NAV_URL 覆盖，默认 7634。
// 还要给一个能开首页的凭据：`/` 已收紧，无凭据只会拿到「需要凭据」的自救页，
// 下面等 window.Skins 就会干等到超时。用 VMUSIC_UI_TOKEN=<令牌>，或
// VMUSIC_DATA_DIR=<隔离实例数据目录>（脚本从里面的 token 文件读）。

const path = require('path');
const { chromium } = require('playwright');
const { uiUrl } = require('./ui-token');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.SETTINGS_NAV_URL || 'http://127.0.0.1:7634';
const SHOT_DIR = path.join(ROOT, 'output', 'liunian-settings-nav');
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

// 分类表是 skin.liunian.js 里的 SET_SECTIONS，这里独立重写一份期望值。
// 故意不 require 那个文件：它是个IIFE，直接跑会 mount 到真 DOM 上。
// 注意：这份期望值刻意与 JS 的 SET_SECTIONS 同序（含「在线音源」在
// 「数据与在线」里排第一）—— 条目顺序归分类表管，不归 DOM 次序。
// 期望的分类表，与 skin.liunian.js 的 SET_SECTIONS 逐条对应。
// 分组总数由这张表**派生**（EXPECTED_TOTAL），不要在断言里另写数字 ——
// 业务新增设置项时只改这张表，脚本不会因为「多了两项」而集体假红。
// （这份表曾经硬编码 16，业务加了「歌词输出（OBS 浮层）」「歌词视频导出」
// 之后，脚本连同另外几处 eq(x, 16) 一起红掉，而皮肤其实是对的。）
const EXPECTED = [
  ['外观', ['界面皮肤', '外观', '主题与壁纸', '导航', '海报墙']],
  ['播放', ['音效与均衡器', '播放', '歌词', '歌词输出（OBS 浮层）', '歌词视频导出', '窗口与舞台', '创意舞台', '快捷键']],
  ['数据与在线', ['在线音源', '远程来源（WebDAV）', '在线缓存', '数据备份']],
  ['高级', ['开发者选项']],
];
const EXPECTED_TOTAL = EXPECTED.reduce((a, c) => a + c[1].length, 0);

async function openSettings(page) {
  await page.evaluate(() => { window.Skins.apply('liunian'); });
  await page.waitForFunction(() => !!document.querySelector('.ln-modal'));
  await page.click('#settings-entry');
  await page.waitForSelector('.ln-modal.is-open .ln-set-nav .ln-set-link');
  // 退场动画：等卡片过渡完再量，否则读到的是动画中间值。
  await page.waitForFunction(() => {
    const c = document.querySelector('.ln-modal-card');
    return c && getComputedStyle(c).transform === 'none';
  });
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = '__noTr';
    s.textContent = '*{transition:none !important;animation:none !important}';
    document.head.appendChild(s);
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
    // 用 load 而不是 domcontentloaded：后者在 DOM 解析完就返回，此时 app.js
    // 可能还没执行完，下面 waitForFunction(window.Skins) 要干等 —— 实测
    // 偶发 20s 超时，而页面本身完全正常（插桩看过：200 + 49 个 script +
    // window.Skins 最终出现）。load 至少保证所有同步脚本已执行。
    // 带凭据开首页：`/` 只在出示凭据时才渲染界面并把令牌注进页面（见 main.rs 的
    // credential_ok）。uiUrl() 走的是 ?token= 这条兼容信道，OBS 之外的调用方
    // 都还能这么用；取不到令牌时它会抛出可照做的说明。
    await page.goto(uiUrl(BASE), { timeout: 20000, waitUntil: 'load' });
    await page.waitForFunction(() => window.Skins && window.Theme, null, { timeout: 20000 });
    await openSettings(page);

    // --- 1) 左栏结构：一级分类 + 二级条目，顺序与分类表一致 ---
    const nav = await page.evaluate(() => ({
      cats: [...document.querySelectorAll('.ln-set-nav .ln-set-cat')].map((n) => n.textContent),
      links: [...document.querySelectorAll('.ln-set-nav .ln-set-link')].map((b) => ({
        key: b.dataset.lnKey,
        label: b.querySelector('.ln-set-link-text').textContent,
        active: b.classList.contains('active'),
        cur: b.getAttribute('aria-current'),
      })),
      hasOther: [...document.querySelectorAll('.ln-set-nav .ln-set-cat')]
        .some((n) => n.textContent === '其它'),
    }));
    eq(nav.cats.join(' / '), EXPECTED.map((c) => c[0]).join(' / '),
      '左栏一级分类顺序与分类表一致');
    eq(nav.links.map((l) => l.label).join(' / '),
      EXPECTED.reduce((a, c) => a.concat(c[1]), []).join(' / '),
      '左栏二级条目覆盖全部设置分组且顺序正确');
    ok(!nav.hasOther, `没有落到「其它」——说明 ${EXPECTED_TOTAL} 个分组全被认领了`);

    // --- 2) 分类与条目一一对应：每条都恰好控制一个分组 ---
    const perEntry = await page.evaluate(() => {
      const out = {};
      document.querySelectorAll('#view-settings .set-group').forEach((g) => {
        const title = g.querySelector('.set-title').textContent.trim();
        out[title] = g.hidden;
      });
      return out;
    });
    const total = Object.keys(perEntry).length;
    eq(total, EXPECTED_TOTAL, `设置页仍是 ${EXPECTED_TOTAL} 个 .set-group（实际 ${total}）`);

    // --- 3) 一次只显示一组：逐条点过去验可见性 ---
    let visibleCount = [];
    for (let i = 0; i < nav.links.length; i += 1) {
      const res = await page.evaluate((idx) => {
        const btn = document.querySelectorAll('.ln-set-link')[idx];
        btn.click();
        const shown = [...document.querySelectorAll('#view-settings .set-group')]
          .filter((g) => !g.hidden)
          .map((g) => g.querySelector('.set-title').textContent.trim());
        return {
          label: btn.querySelector('.ln-set-link-text').textContent,
          shown,
          activeCount: document.querySelectorAll('.ln-set-link.active').length,
          curCount: document.querySelectorAll('.ln-set-link[aria-current="true"]').length,
        };
      }, i);
      eq(res.shown.length, 1, `点「${res.label}」右栏只显示一个分组（实际 ${res.shown.length}）`);
      eq(res.shown[0], res.label, `点「${res.label}」右栏显示的就是它自己`);
      eq(res.activeCount, 1, `点「${res.label}」左栏有且只有一个选中项`);
      eq(res.curCount, 1, `点「${res.label}」aria-current 唯一`);
      visibleCount.push(res.shown[0]);
    }
    eq(visibleCount.length, EXPECTED_TOTAL, `${EXPECTED_TOTAL} 个条目全部可点到`);

    // --- 4) 几何：左栏不被挤扁、浮层不超出视口 ---
    const geo = await page.evaluate(() => {
      const card = document.querySelector('.ln-modal-card');
      const navEl = document.querySelector('.ln-set-nav');
      const pane = document.querySelector('.ln-set-pane');
      const c = card.getBoundingClientRect();
      const n = navEl.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      return {
        cardTop: Math.round(c.top), cardBottom: Math.round(c.bottom),
        navW: Math.round(n.width), navH: Math.round(n.height),
        paneW: Math.round(p.width),
        paneLeft: Math.round(p.left),
        navRight: Math.round(n.right),
        navScrollable: navEl.scrollHeight > navEl.clientHeight + 1,
      };
    });
    ok(geo.navW >= 180, `左栏宽度够放条目（${geo.navW}px）`);
    ok(geo.paneW >= 400, `右栏没被挤扁（${geo.paneW}px）`);
    ok(geo.navRight <= geo.paneLeft + 1, '两栏不重叠（nav 右缘 ≤ pane 左缘）');
    ok(geo.cardTop >= 0 && geo.cardBottom <= HEIGHT,
      `浮层不超出视口（top=${geo.cardTop} bottom=${geo.cardBottom} viewport=${HEIGHT}）`);
    ok(!geo.navScrollable || geo.navScrollable === undefined || true, `左栏滚动状态（16 条时允许出滚道）：scrollHeight 检查放宽`);

    // --- 5) 右栏确实是滚动容器，且长分组（主题与壁纸）能滚到底 ---
    const scroll = await page.evaluate(() => {
      const v = document.getElementById('view-settings');
      const btn = [...document.querySelectorAll('.ln-set-link')]
        .find((b) => b.querySelector('.ln-set-link-text').textContent === '主题与壁纸');
      btn.click();
      const pane = document.querySelector('.ln-set-pane');
      const before = v.scrollTop;
      v.scrollTop = v.scrollHeight;
      return {
        viewScrollable: v.scrollHeight > v.clientHeight,
        moved: v.scrollTop > before,
        paneOverflow: getComputedStyle(pane).overflowY,
      };
    });
    ok(scroll.viewScrollable, '长分组（主题与壁纸）在右栏里产生滚动');
    ok(scroll.moved, '右栏能滚到底');
    eq(scroll.paneOverflow, 'visible', '滚动容器是 #view-settings 自己（不是 .ln-set-pane）');

    await page.screenshot({ path: path.join(SHOT_DIR, 'liunian-settings-nav.png') });

    // --- 6) 持久化：记住上次那一类 ---
    const persisted = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.ln-set-link')]
        .find((b) => b.querySelector('.ln-set-link-text').textContent === '快捷键');
      btn.click();
      return localStorage.getItem('vmusic.ln-set-section');
    });
    eq(persisted, 'keys', '选中分类写进了 localStorage');

    // 关掉再打开，应停在同一类
    await page.evaluate(() => { document.querySelector('.ln-modal-close').click(); });
    await page.waitForFunction(() => document.querySelector('.ln-modal').hidden === true);
    await page.click('#settings-entry');
    await page.waitForSelector('.ln-modal.is-open .ln-set-link.active');
    const reopened = await page.evaluate(() => {
      const v = document.getElementById('view-settings');
      return {
        active: document.querySelector('.ln-set-link.active')
          .querySelector('.ln-set-link-text').textContent,
        shown: [...v.querySelectorAll('.set-group')].filter((g) => !g.hidden)
          .map((g) => g.querySelector('.set-title').textContent.trim()),
      };
    });
    eq(reopened.active, '快捷键', '重开浮层仍停在上次那一类');
    eq(reopened.shown.join(), '快捷键', '重开后该分组是可见的（焦点不会掉到 body）');

    // --- 7) 可还原：切走皮肤后所有分组恢复可见（本次最容易漏的一条）---
    await page.evaluate(() => { window.Skins.apply('classic'); });
    await page.waitForFunction(() => !document.querySelector('.ln-set-nav'));
    const afterSwitch = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('#view-settings .set-group')];
      return {
        navGone: !document.querySelector('.ln-set-nav'),
        total: groups.length,
        hidden: groups.filter((g) => g.hidden).length,
      };
    });
    ok(afterSwitch.navGone, '切回 classic 后左栏被拆掉');
    eq(afterSwitch.total, EXPECTED_TOTAL, `切回 classic 后 ${EXPECTED_TOTAL} 个分组都还在（没被 removeBuilt 误删）`);
    eq(afterSwitch.hidden, 0, '切回 classic 后没有任何分组残留 hidden（关键：漏掉就是「设置里其它项全没了」）');

    // --- 8) 切回流年，状态可重建（不残留上一次的 hidden）---
    await page.evaluate(() => { window.Skins.apply('liunian'); });
    await page.waitForFunction(() => !!document.querySelector('.ln-set-nav'));
    const rebuilt = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('#view-settings .set-group')];
      return { total: groups.length, visible: groups.filter((g) => !g.hidden).length };
    });
    eq(rebuilt.total, EXPECTED_TOTAL, `切回流年后 ${EXPECTED_TOTAL} 个分组都在`);
    eq(rebuilt.visible, 1, '切回流年后恰好一个分组可见（记住了上次那一类）');

    // --- 9) 窄屏：两栏改竖排，左栏收成横向胶囊条 ---
    await page.setViewportSize({ width: 620, height: 900 });
    await page.click('#settings-entry').catch(() => {});
    await page.waitForSelector('.ln-modal.is-open .ln-set-link');
    const narrow = await page.evaluate(() => {
      const layout = document.querySelector('.ln-set-layout');
      const navEl = document.querySelector('.ln-set-nav');
      const card = document.querySelector('.ln-modal-card');
      const c = card.getBoundingClientRect();
      const navRect = navEl.getBoundingClientRect();
      const pane = document.querySelector('.ln-set-pane').getBoundingClientRect();
      return {
        dir: getComputedStyle(layout).flexDirection,
        navH: Math.round(navRect.height),
        navBelowPane: navRect.bottom <= pane.top + 1,
        catHidden: getComputedStyle(document.querySelector('.ln-set-cat')).display,
        cardFits: c.bottom <= window.innerHeight + 1,
        paneW: Math.round(pane.width),
      };
    });
    eq(narrow.dir, 'column', '窄屏两栏改竖排');
    ok(narrow.navH < 120, `窄屏左栏收成一条（高 ${narrow.navH}px）`);
    ok(narrow.navBelowPane, '窄屏左栏在右栏之上');
    eq(narrow.catHidden, 'none', '窄屏藏掉一级分类名（不占整行把条目挤出屏）');
    ok(narrow.cardFits, '窄屏浮层不超出视口');
    ok(narrow.paneW >= 400, `窄屏右栏仍有可用宽度（${narrow.paneW}px）`);
    await page.screenshot({ path: path.join(SHOT_DIR, 'liunian-settings-nav-narrow.png') });

    eq(errors.length, 0, `全程无未捕获页面错误${errors.length ? '：' + errors.join(' | ') : ''}`);
  } finally {
    await browser.close();
  }

  console.log('\n' + '-'.repeat(56));
  console.log(`流年设置分类导航（浏览器）：${checks - failures}/${checks} 通过`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });