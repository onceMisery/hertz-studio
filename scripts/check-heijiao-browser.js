// SPDX-License-Identifier: MIT
// 浏览器验收：黑胶皮肤（heijiao）
//
// 契约脚本（check-skins.js）能验的是**源码里写了什么**，而这套皮肤最贵的
// 三件事全都不在源码里，必须在浏览器里量：
//
//   ① 双卡片几何（左卡 ≈ 1/3、唱片没被压扁、左卡没被 data-stage-idle 收掉）
//   ② 卡片化真的生效（曲名/专辑/音质/时长四段都在，列头已收）
//   ③ 拖转：指针拖 → 角度跟手；松手有惯性；**旋转不影响页面滚动**
//   ④ 窄屏回退：≤1100px 变纵向堆叠，封面卡排在上方
//   ⑤ prefers-reduced-motion：拖转仍在，自转与惯性关掉
//   ⑥ 队列两档（卡片 / 行列表）：切档各自的几何，以及列表档是否真落回基线
//
// ③ 里"不影响滚动"要真量：量的是滚动容器 scrollTop 在拖唱片之后有没有动，
// 不是"看起来没动"。纵向拖过唱片 → scrollTop 必须不变；横向拖 → 转。
//
// 用法：
//   node scripts/check-heijiao-browser.js
//   HERTZ_BIN=/path/to/hertz-studio node scripts/check-heijiao-browser.js
'use strict';
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');

let failures = 0, checks = 0;
function check(c, label, detail) {
  checks += 1;
  if (c) return;
  failures += 1;
  console.error('  X ' + label + (detail ? '  [' + detail + ']' : ''));
}
function section(s) { console.log('\n' + s); }

// 量 .view 与各关键区块的 rect。断言要量用户能感知的量（rect / 计算值），
// 不是 CSS 变量 —— 变量是意图，rect 是结果。
async function measure(page) {
  return page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        left: Math.round(b.left), right: Math.round(b.right),
        top: Math.round(b.top), bottom: Math.round(b.bottom),
        w: Math.round(b.width), h: Math.round(b.height),
        display: cs.display, visible: cs.display !== 'none' && cs.visibility !== 'hidden'
      };
    };
    const view = document.querySelector('#view-library') || document.querySelector('.view');
    return {
      skin: document.documentElement.getAttribute('data-skin'),
      stage: r('.stage'), column: r('.column'), disc: r('.stage .disc-wrap'),
      card: r('#lib-list .track'), head: r('.lib-head'),
      album: r('#lib-list .track .t-album'), quality: r('#lib-list .track .t-quality'),
      dur: r('#lib-list .track .t-dur'),
      vw: document.documentElement.clientWidth,
      viewScroll: view ? Math.round(view.scrollTop) : null,
      scrollH: view ? view.scrollHeight : null,
      clientH: view ? view.clientHeight : null
    };
  });
}

(async () => {
  const fixture = await startFixture();
  let browser;
  try {
    const track = await fixture.seed();
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await fixture.connect(context);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // 走真实入口切皮肤：localStorage + reload，让启动序列自己应用。
    // 直接 setAttribute('data-skin') 会被 skins.js 的状态机覆盖回去，
    // 量出来的全是 classic 的数字（这个坑在其它皮肤检查里也踩过）。
    await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar');
    await page.evaluate(() => { try { localStorage.setItem('vmusic.skin', 'heijiao'); } catch (e) {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar');
    await page.waitForTimeout(600);

    // ---------------------------------------------------------------------
    section('① 宽屏：双卡片几何（1440px）');

    // 默认视图现在是「在线曲库」，卡片断言要先切回曲库才量得到。
    await page.evaluate(() => {
      const item = document.querySelector('.rail-item[data-view="library"]');
      if (item) item.click();
    });
    await page.waitForTimeout(400);

    let m = await measure(page);
    console.log('  skin=' + m.skin + ' 左卡 ' + m.stage.w + 'px / 右面板 ' + m.column.w + 'px');

    check(m.skin === 'heijiao', '皮肤切过去了', m.skin);
    check(!!m.stage && m.stage.visible, '左卡可见');
    // 左右并排：单列塌陷时左卡在右面板上方，两个边界会重叠。
    check(m.stage.right <= m.column.left + 2,
      '左卡与右面板左右并排', '左卡 right=' + m.stage.right + ' 右面板 left=' + m.column.left);
    // 比例 1/3，放宽到 [0.2, 0.5]（这是比例不是像素，会随视口变）。
    const ratio = m.stage.w / (m.stage.w + m.column.w);
    check(ratio >= 0.2 && ratio <= 0.5,
      '左卡约占 1/3', (ratio * 100).toFixed(0) + '%');
    // 唱片没被压扁。300px 左卡下至少要有 ~200px 的唱片，
    // 低于 120px 就是"左卡存在但唱片只剩一条缝"。
    check(m.disc && m.disc.visible && m.disc.h >= 120,
      '唱片没被压扁', m.disc ? 'h=' + m.disc.h : '缺失');
    // 唱片接近方形（封面与卡片内容比例协调的第一条）。
    check(m.disc && Math.abs(m.disc.w - m.disc.h) <= 2,
      '唱片是正方形', m.disc ? m.disc.w + '×' + m.disc.h : '缺失');

    // ---------------------------------------------------------------------
    section('② 卡片化生效');

    check(m.card && m.card.visible, '曲库渲染成卡片了');
    // 列头在卡片模式下没有对应刻度，必须收起来。
    check(!m.head || !m.head.visible, '行列表头已收起', m.head ? '仍可见' : '');
    // 七列信息一个都不能少 —— 卡片化的全部意义就在这里。
    check(!!m.album && m.album.visible, '专辑仍在卡片里');
    check(!!m.quality && m.quality.visible, '音质仍在卡片里');
    check(!!m.dur && m.dur.visible, '时长仍在卡片里');
    if (m.card) {
      // 卡片是网格里的格子：高度按内容走，而不是基础样式的定高行。
      check(m.card.h > 100, '卡片按内容长高（不是定高行）', 'h=' + m.card.h);
    }
    // 滚动权唯一：.view 自己滚，卡片区不自滚。
    check(m.scrollH === null || m.clientH === null || m.scrollH >= m.clientH,
      '内容区可滚动（列表没被压扁）',
      'scrollH=' + m.scrollH + ' clientH=' + m.clientH);
    check(m.scrollH === null || m.clientH === null || m.scrollH <= m.clientH + 400,
      '没有失控的双层滚动（滚动量在合理范围）',
      'scrollH=' + m.scrollH + ' clientH=' + m.clientH);

    // ---------------------------------------------------------------------
    section('③ 唱片拖转');

    const hasDisc = await page.evaluate(() => !!(window.__heijiaoSkin && window.__heijiaoSkin.hasDisc()));
    check(hasDisc, '生命周期挂上了唱片节点');

    const box = await page.evaluate(() => {
      const el = document.querySelector('.stage .disc-wrap');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: Math.round(b.width) };
    });
    check(!!box && box.w > 100, '唱片可拖（有实际命中区）', box ? 'w=' + box.w : '缺失');

    if (box) {
      // 拖动步进必须带间隔（40ms），不能连发。
      // 速度是"最近 90ms 内的角度差 ÷ 时间差"，零间隔连发会让相邻样本
      // timeStamp 几乎相同 → dt≈0 → 算出零速 → 断言报"没有惯性"，
      // 而那其实是在量探针自己造的假手势。真人的拖动天然有几十毫秒间隔。
      const drag = async (steps, dxPer, dyPer, delay) => {
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
        for (let i = 1; i <= steps; i++) {
          await page.mouse.move(box.x + i * dxPer, box.y + i * dyPer);
          if (delay) await page.waitForTimeout(delay);
        }
      };

      // 横向拖：角度必须跟手。
      const before = await page.evaluate(() => window.__heijiaoSkin.angle());
      await drag(8, 15, 0, 40);
      const during = await page.evaluate(() => window.__heijiaoSkin.angle());
      await page.mouse.up();
      check(Math.abs(during - before) > 20,
        '横向拖 → 角度跟手转', 'Δ' + (during - before).toFixed(1) + '°');
      const styleAfter = await page.evaluate(() => {
        const el = document.querySelector('.stage .disc-wrap');
        return el ? el.style.getPropertyValue('--hj-turn') : '';
      });
      check(/deg$/.test(styleAfter.trim()), '角度真的写进了 CSS 变量', styleAfter);

      // 惯性：松手后角度应继续增长（衰减，但仍在动）。
      // 这个断言抓到过一个静默 bug：rAF 循环起不来，speed 在衰减而 angle 不动。
      const justAfter = await page.evaluate(() => window.__heijiaoSkin.angle());
      await page.waitForTimeout(250);
      const later = await page.evaluate(() => window.__heijiaoSkin.angle());
      check(Math.abs(later - justAfter) > 0.5,
        '松手后有惯性衰减', 'Δ' + (later - justAfter).toFixed(1) + '°');
      // 惯性必须最终停下：一直转下去就是"停不下来"，听感上很糟。
      await page.waitForTimeout(2600);
      const settled1 = await page.evaluate(() => window.__heijiaoSkin.angle());
      await page.waitForTimeout(400);
      const settled2 = await page.evaluate(() => window.__heijiaoSkin.angle());
      check(Math.abs(settled2 - settled1) < 0.5,
        '惯性会自己停下来（不是永远转）',
        'Δ' + (settled2 - settled1).toFixed(1) + '°');

      // 纵向拖：**不允许**影响页面滚动。这是"旋转不影响滚动"的核心断言。
      // 先把内容区滚下去一点，确保它确实能滚（否则"没动"是因为本来就滚不动）。
      await page.evaluate(() => {
        const v = document.querySelector('#view-library') || document.querySelector('.view');
        if (v) v.scrollTop = Math.min(200, Math.max(0, v.scrollHeight - v.clientHeight));
      });
      await page.waitForTimeout(200);
      const scrollBefore = await page.evaluate(() => {
        const v = document.querySelector('#view-library') || document.querySelector('.view');
        return v ? Math.round(v.scrollTop) : 0;
      });
      const preV = await page.evaluate(() => window.__heijiaoSkin.angle());
      await drag(8, 0, 18, 30);
      await page.mouse.up();
      await page.waitForTimeout(200);
      const after = await measure(page);
      check(after.viewScroll === scrollBefore,
        '纵向划过唱片不改变滚动位置',
        'before=' + scrollBefore + ' after=' + after.viewScroll);
      // 纵向不该转（方向判给滚动）。允许 ±1° 的量化噪声。
      const postV = await page.evaluate(() => window.__heijiaoSkin.angle());
      check(Math.abs(postV - preV) < 1.5,
        '纵向手势不转唱片（判给滚动）',
        'Δ' + (postV - preV).toFixed(1) + '°');

      // 键盘可达：纯键盘用户不能拿到一张死图。
      await page.evaluate(() => {
        const el = document.querySelector('.stage .disc-wrap');
        if (el) el.focus();
      });
      const kbBefore = await page.evaluate(() => window.__heijiaoSkin.angle());
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Home');
      await page.waitForTimeout(150);
      const kbAfter = await page.evaluate(() => window.__heijiaoSkin.angle());
      check(Math.abs(kbAfter) < 0.001,
        'Home 键把唱片归零', 'before=' + kbBefore.toFixed(1) + ' after=' + kbAfter.toFixed(1));
    }

    // ---------------------------------------------------------------------
    section('④ 歌词展开 / 收起');

    const toggleVisible = await page.evaluate(() => {
      const b = document.querySelector('.hj-lyric-toggle');
      return !!(b && getComputedStyle(b).display !== 'none');
    });
    check(toggleVisible, '展开歌词的按钮在');
    if (toggleVisible) {
      await page.evaluate(() => document.querySelector('.hj-lyric-toggle').click());
      await page.waitForTimeout(450);
      const openState = await page.evaluate(() => ({
        open: document.body.classList.contains('hj-lyrics-open'),
        expanded: document.querySelector('.hj-lyric-toggle').getAttribute('aria-expanded'),
        lyrics: (() => {
          const l = document.querySelector('.stage-lyrics');
          if (!l) return null;
          const b = l.getBoundingClientRect();
          return Math.round(b.height);
        })()
      }));
      check(openState.open, '点一下进入展开态');
      check(openState.expanded === 'true', 'aria-expanded 跟着翻');
      check(openState.lyrics === null || openState.lyrics > 60,
        '展开后歌词区拿到了高度', 'h=' + openState.lyrics);
      await page.evaluate(() => document.querySelector('.hj-lyric-toggle').click());
      await page.waitForTimeout(450);
      const closed = await page.evaluate(() => document.body.classList.contains('hj-lyrics-open'));
      check(!closed, '再点一下收起');
    }

    // ---------------------------------------------------------------------
    section('⑤ 窄屏回退（900px → 纵向堆叠）');

    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(500);
    m = await measure(page);
    check(m.stage && m.column, '窄屏两块都还在');
    // 堆叠：封面卡排在上方（top 小于右面板），不是并排也不是消失。
    check(m.stage.bottom <= m.column.top + 2,
      '封面卡排在内容之上（纵向堆叠）',
      '左卡 bottom=' + m.stage.bottom + ' 右面板 top=' + m.column.top);
    check(m.stage.w > 300, '堆叠后封面卡拿到整宽', 'w=' + m.stage.w);
    check(m.disc && m.disc.h >= 120, '堆叠后唱片没被压扁', m.disc ? 'h=' + m.disc.h : '缺失');
    // 卡片网格随宽度收窄，但仍要成网格（不是退回行列表）。
    const cardCount = await page.evaluate(() => {
      const list = document.querySelector('#lib-list');
      if (!list) return 0;
      return getComputedStyle(list).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
    });
    check(cardCount >= 1, '窄屏仍是网格卡片', cardCount + ' 列');

    // 手机宽度：卡片下限必须再收一档，否则每张卡只剩一个封面。
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const phone = await measure(page);
    check(phone.stage && phone.stage.visible, '手机宽度封面卡仍在');
    const phoneCard = phone.card;
    check(!phoneCard || phoneCard.w > 110, '手机宽度卡片没被压成一条', phoneCard ? 'w=' + phoneCard.w : '');
    const noHScroll = await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2);
    check(noHScroll, '手机宽度没有横向滚动条');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);

    // ---------------------------------------------------------------------
    section('⑥ prefers-reduced-motion：关自转与惯性，留拖转');

    const rmContext = await browser.newContext({
      viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce'
    });
    await fixture.connect(rmContext);
    const rmPage = await rmContext.newPage();
    rmPage.setDefaultTimeout(20000);
    // ⚠ 新 context 的 localStorage 是**空的**：皮肤得自己切一次，
    // 否则 __heijiaoSkin 根本不存在，探针读 undefined 会误报成
    // "reduced-motion 没被识别"（其实只是皮肤没加载）。
    await rmPage.goto(fixture.base, { waitUntil: 'domcontentloaded' });
    await rmPage.waitForSelector('.topbar');
    await rmPage.evaluate(() => { try { localStorage.setItem('vmusic.skin', 'heijiao'); } catch (e) {} });
    await rmPage.reload({ waitUntil: 'domcontentloaded' });
    await rmPage.waitForSelector('.topbar');
    await rmPage.waitForTimeout(600);
    const rmFlag = await rmPage.evaluate(() =>
      !!(window.__heijiaoSkin && window.__heijiaoSkin.isReducingMotion()));
    check(rmFlag, 'reduced-motion 被识别');

    if (rmFlag) {
      const rmBox = await rmPage.evaluate(() => {
        const el = document.querySelector('.stage .disc-wrap');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      if (rmBox) {
        const a0 = await rmPage.evaluate(() => window.__heijiaoSkin.angle());
        await rmPage.mouse.move(rmBox.x, rmBox.y);
        await rmPage.mouse.down();
        for (let i = 1; i <= 8; i++) {
          await rmPage.mouse.move(rmBox.x + i * 15, rmBox.y);
          await rmPage.waitForTimeout(40);
        }
        await rmPage.mouse.up();
        const a1 = await rmPage.evaluate(() => window.__heijiaoSkin.angle());
        check(Math.abs(a1 - a0) > 20, 'reduced-motion 下拖转仍在（用户主动发起的操作不该被关）',
          'Δ' + (a1 - a0).toFixed(1) + '°');
        // 惯性必须关：松手后不再继续转。
        await rmPage.waitForTimeout(500);
        const a2 = await rmPage.evaluate(() => window.__heijiaoSkin.angle());
        check(Math.abs(a2 - a1) < 0.5, 'reduced-motion 下无惯性', 'Δ' + (a2 - a1).toFixed(1) + '°');
      }
    }
    await rmContext.close();

    // ---------------------------------------------------------------------
    section('⑦ 队列两档：卡片 / 行列表');

    // 队列是这套皮肤里唯一有两档的列表（其余列表只有卡片）。按钮组是皮肤
    // 自造的，挂在队列视图的工具行上；切档只往 #queue-list 写一个状态类。
    // 这里量的不是"类有没有写上"，而是两档各自的几何 —— 尤其"列表档是否
    // 真的落回 style.css 那份基线"，那是契约脚本看不见的一半。
    const probeQueue = () => page.evaluate(() => {
      const list = document.getElementById('queue-list');
      // 就地补满十条：WS 的 state 帧会拿服务端那份队列把注入的整盘换掉
      // （online/play 与切歌都会），量之前重新喂一次才不靠运气。
      if (list.querySelectorAll('.q-row').length < 10) {
        state.queue = new Array(10).fill(state.queue[0] || state.snapshot.track_id);
        renderQueue();
      }
      const rows = list.querySelectorAll('.q-row');
      const box = (n) => {
        const b = n.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      };
      const cs = getComputedStyle(list);
      const shown = (n) => !!n && getComputedStyle(n).display !== 'none';
      const r0 = rows[0], r1 = rows[1];
      const group = document.querySelector('#view-queue .hj-q-views');
      return {
        display: cs.display, overflowY: cs.overflowY,
        flex: cs.flexGrow + ' ' + cs.flexShrink + ' ' + cs.flexBasis,
        listClass: list.className,
        r0: box(r0), r1: box(r1), listBox: box(list),
        borderTopWidth: getComputedStyle(r0).borderTopWidth,
        art: shown(r0.querySelector('.q-art')),
        grip: shown(r0.querySelector('.q-grip')),
        dur: shown(r0.querySelector('.q-dur')),
        act: shown(r0.querySelector('.t-act')),
        groupShown: shown(group),
        chips: Array.from(document.querySelectorAll('#view-queue .hj-q-views button'))
          .map((b) => b.getAttribute('data-hj-q-view') + ':' + (b.classList.contains('active') ? 'on' : 'off')),
        mode: window.__heijiaoSkin.queueMode(),
        stored: (() => { try { return localStorage.getItem('vmusic.heijiao.queue'); } catch (e) { return 'ERR'; } })(),
      };
    });
    const clickQueueView = () => page.evaluate(() => {
      const item = document.querySelector('.rail-item[data-view="queue"]');
      if (item) item.click();
    });
    const clickQueueMode = (mode) => page.evaluate((m) => {
      document.querySelector('#view-queue .hj-q-views button[data-hj-q-view="' + m + '"]').click();
    }, mode);

    await clickQueueView();
    let q = await probeQueue();
    console.log('  卡片档 行 ' + q.r0.w + '×' + q.r0.h + '  列表容器 ' + q.display);
    check(q.groupShown, '队列头部有自造的切换按钮组');
    check(q.chips.length === 2 && q.chips[0].endsWith(':on'), '默认档是卡片', q.chips.join(','));
    check(q.display === 'grid', '卡片档：容器是网格', q.display);
    check(q.r1.y === q.r0.y && q.r1.x > q.r0.x, '卡片档：前两条并排',
      'Δx=' + (q.r1.x - q.r0.x));
    check(q.r0.w < q.listBox.w / 2, '卡片档：一行放得下多张', q.r0.w + '/' + q.listBox.w);
    check(q.art && q.dur && q.act && !q.grip, '卡片档：封面在、拖拽把手收掉');
    check(q.borderTopWidth === '1px', '卡片档：行带整圈 1px 卡片边框', q.borderTopWidth);

    await clickQueueMode('list');
    q = await probeQueue();
    console.log('  列表档 行 ' + q.r0.w + '×' + q.r0.h + '  列表容器 ' + q.display);
    check(q.mode === 'list' && /hj-queue-list/.test(q.listClass), '切档写了状态类', q.listClass);
    check(q.chips[1].endsWith(':on') && q.chips[0].endsWith(':off'), '高亮跟到「列表」', q.chips.join(','));
    check(q.stored === 'list', '选择落库', String(q.stored));
    check(q.display === 'flex', '列表档：容器回到基线的纵向 flex', q.display);
    check(q.r1.y > q.r0.y + q.r0.h - 2, '列表档：行改成上下堆叠', 'Δy=' + (q.r1.y - q.r0.y));
    check(Math.abs(q.r0.w - q.listBox.w) <= 2, '列表档：每行拿到整宽', q.r0.w + '/' + q.listBox.w);
    check(!q.art && q.grip && q.dur && q.act, '列表档：封面收掉、把手回来（= 基线那份行）');
    check(q.borderTopWidth === '2px',
      '列表档：卡片那圈边框已整组关掉，只剩基线留给拖拽落点的 2px 上边',
      q.borderTopWidth);
    // 两档都不自滚：黑胶的滚动权在 .view 一个容器。列表档若跟着回退到基线的
    // overflow-y:auto + flex:1，就会在黑胶里凭空多一层滚动条 —— 这条留在
    // :not() 门控外面写，靠源码断言看不全，必须量计算值。
    check(q.overflowY === 'visible' && q.flex === '0 0 auto',
      '列表档仍不自滚（滚动权唯一在 .view）', q.overflowY + ' / flex ' + q.flex);

    await clickQueueMode('grid');
    q = await probeQueue();
    check(q.display === 'grid' && q.art && q.stored === 'grid', '切回卡片档，几何与选择都回来');

    // ---------------------------------------------------------------------
    section('⑧ 卸载干净：切走皮肤不留残角/残状态');

    // 先切到列表档再走人：状态类留在业务节点 #queue-list 上才会跨皮肤存活，
    // 卸载必须把它摘掉（停在默认档的话，这条断言是在量一个不存在的类）。
    await clickQueueMode('list');
    await page.evaluate(() => window.Skins.apply('classic'));
    await page.waitForTimeout(400);
    const cleaned = await page.evaluate(() => {
      const el = document.querySelector('.stage .disc-wrap');
      return {
        turn: el ? el.style.getPropertyValue('--hj-turn').trim() : '(节点已不在)',
        role: el ? el.getAttribute('role') : null,
        btn: !!document.querySelector('.hj-lyric-toggle'),
        bodyOpen: document.body.classList.contains('hj-lyrics-open'),
        qViews: !!document.querySelector('.hj-q-views'),
        qClass: document.getElementById('queue-list').className
      };
    });
    check(cleaned.turn === '', '切走后 --hj-turn 被摘掉', cleaned.turn || '(空)');
    check(cleaned.role === null, '切走后 slider 语义被摘掉', String(cleaned.role));
    check(!cleaned.btn, '切走后自造的按钮被摘掉');
    check(!cleaned.bodyOpen, '切走后 body 上的状态类被摘掉');
    check(!cleaned.qViews, '切走后队列的切换按钮也摘掉');
    check(!/hj-queue-list/.test(cleaned.qClass),
      '切走后队列的状态类被摘掉（#queue-list 是业务节点，留着就把选择带进别的皮肤）',
      cleaned.qClass);

    // 再切回黑胶：应当重新挂上（不是"挂一次就再也回不来"）。
    await page.evaluate(() => window.Skins.apply('heijiao'));
    await page.waitForTimeout(400);
    const remounted = await page.evaluate(() => ({
      mounted: !!(window.__heijiaoSkin && window.__heijiaoSkin.isMounted()),
      hasDisc: !!(window.__heijiaoSkin && window.__heijiaoSkin.hasDisc()),
      mode: window.__heijiaoSkin ? window.__heijiaoSkin.queueMode() : 'NO-PROBE'
    }));
    check(remounted.mounted && remounted.hasDisc, '再切回黑胶能重新挂载');
    check(remounted.mode === 'list', '再切回黑胶时队列档位从存储恢复', remounted.mode);

    // ---------------------------------------------------------------------
    section('⑨ 卡片角标：只常驻红心，其余 hover 才回来');

    // 这条量的是「一屏十张卡时右上角有多少个图标」。四枚常驻时是四十个噪点，
    // 压在封面上把封面从主角挤成配角。所以默认只留红心（收藏是卡片上唯一
    // 高频动作），其余三枚 hover / 键盘聚焦 / 已勾选时才回来。
    // 用 display 而不是 opacity 判：.t-actions 是一枚**有底色的胶囊**，
    // 半透明的子项照样占位，胶囊只会留下一段空白 —— 只有 display:none
    // 才让它真的收成一颗心（顺带断言胶囊变窄，那是"收成一颗心"的几何证据）。
    await page.evaluate(() => {
      const item = document.querySelector('.rail-item[data-view="library"]');
      if (item) item.click();
    });
    await page.waitForTimeout(400);

    const probeActs = () => page.evaluate(() => {
      const card = document.querySelector('#lib-list .track');
      if (!card) return null;
      const acts = card.querySelector('.t-actions');
      const shown = (sel) => {
        const n = acts.querySelector(sel);
        return !!n && getComputedStyle(n).display !== 'none';
      };
      const b = acts.getBoundingClientRect();
      return {
        fav: shown('[data-act="fav"]'),
        select: shown('.t-select'),
        next: shown('[data-act="play-next"]'),
        menu: shown('[data-act="menu"]'),
        w: Math.round(b.width)
      };
    });

    const idle = await probeActs();
    check(!!idle, '曲库卡片渲染出来了');
    if (idle) {
      check(idle.fav, '红心常驻（收藏是卡片上唯一高频动作）');
      check(!idle.select && !idle.next && !idle.menu,
        '勾选 / 插入下一首 / 更多 默认不显形',
        'select=' + idle.select + ' next=' + idle.next + ' menu=' + idle.menu);
      // 一颗 28px 的方钮 + 胶囊自己的内距；四枚全开时是 120px 上下。
      check(idle.w <= 46, '胶囊收成一颗心的宽度', 'w=' + idle.w);
    }

    await page.hover('#lib-list .track');
    await page.waitForTimeout(250);
    const hovered = await probeActs();
    if (hovered) {
      check(hovered.fav && hovered.select && hovered.next && hovered.menu,
        'hover 时四枚全部回来（功能一个没丢）',
        JSON.stringify(hovered));
      check(hovered.w > idle.w, 'hover 后胶囊展开', idle.w + ' → ' + hovered.w);
    }
    // 移开鼠标回到默认态：hover 是临时态，不该"一旦悬停过就永久展开"。
    await page.mouse.move(5, 5);
    await page.waitForTimeout(250);
    const back = await probeActs();
    if (back) check(!back.next && !back.menu, '移开鼠标后收回（hover 是临时态）');

    // ---------------------------------------------------------------------
    section('⑩ 日推头：副标题独占一行，工具行与日期同排');

    // 副标题（「已合并 24 首：网易云 30 首、QQ 19 首 · …」）在 2/3 宽的右栏里
    // 一长就把工具行挤下去、跟日期抢同一行，读起来是一整片字。
    // 判据是**几何**：副标题必须落在日期下方（独占一行），工具行必须仍在
    // 头部第一行、贴着头部右缘 —— 两条合起来才是"第一行只留日期 + 按钮"。
    const dh = await page.evaluate(() => {
      const b = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right),
          bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height)
        };
      };
      return {
        head: b('.daily-head'), copy: b('.daily-copy'), title: b('#daily-date'),
        sub: b('#daily-sub'), tools: b('.daily-tools')
      };
    });
    check(!!dh.head && !!dh.title && !!dh.sub && !!dh.tools, '日推头部四个零件都在',
      JSON.stringify({ head: !!dh.head, title: !!dh.title, sub: !!dh.sub, tools: !!dh.tools }));
    if (dh.head && dh.title && dh.sub && dh.tools) {
      check(dh.sub.y >= dh.title.bottom - 2,
        '副标题落到日期下面（独占一行）',
        'sub.y=' + dh.sub.y + ' title.bottom=' + dh.title.bottom);
      check(dh.sub.w >= dh.copy.w * 0.9,
        '副标题拿到整行宽度（不是被工具行挤成窄条）',
        'sub.w=' + dh.sub.w + ' copy.w=' + dh.copy.w);
      check(dh.tools.y - dh.head.y <= 20,
        '工具行仍在头部第一行（没被副标题顶下去）',
        'Δy=' + (dh.tools.y - dh.head.y));
      check(dh.head.right - dh.tools.right <= 2,
        '工具行贴着头部的右缘', 'Δ=' + (dh.head.right - dh.tools.right));
      check(dh.sub.right <= dh.head.right + 2,
        '副标题没有溢出头部', 'sub.right=' + dh.sub.right + ' head.right=' + dh.head.right);
    }

    // ---------------------------------------------------------------------
    section('⑪ 卡片文字层级与占位符');

    // 这三条的失败模式全是"页面照旧渲染、只是不好读"，Node 正则看不见：
    //   · 曲名不加重 → 顶着 168px 封面、压着两行注解，读起来像图注；
    //   · 音质是裸文字 → 与专辑名、时长三行同重，全靠位置猜哪个是哪个；
    //   · 占位音符 52% → 卡片封面是一枚占满整格的巨型音符，一排看过去是色块。
    const p2 = await page.evaluate(() => {
      const card = document.querySelector('#lib-list .track');
      if (!card) return null;
      const g = (sel, prop) => {
        const el = card.querySelector(sel);
        return el ? getComputedStyle(el)[prop] : 'MISSING';
      };
      const art = card.querySelector('.t-art');
      const after = art ? getComputedStyle(art, '::after') : null;
      const bar = document.getElementById('bar-time');
      return {
        titleSize: parseFloat(g('.t-title', 'fontSize')),
        titleWeight: parseInt(g('.t-title', 'fontWeight'), 10),
        albumColor: g('.t-album', 'color'),
        qualRadius: parseFloat(g('.t-quality', 'borderTopLeftRadius')),
        durNum: g('.t-dur', 'fontVariantNumeric'),
        maskSize: after ? (after.maskSize || after.webkitMaskSize) : null,
        barTimeNum: bar ? getComputedStyle(bar).fontVariantNumeric : 'MISSING'
      };
    });
    check(!!p2, '卡片可量');
    if (p2) {
      check(p2.titleSize >= 14, '曲名升到 14px（不再是图注）', p2.titleSize + 'px');
      check(p2.titleWeight >= 600, '曲名加重，成为卡片里唯一被强调的一行', String(p2.titleWeight));
      check(p2.albumColor !== 'MISSING' && p2.albumColor !== 'rgb(255, 255, 255)',
        '专辑名降为次级色（不与曲名抢重）', p2.albumColor);
      check(p2.qualRadius >= 8, '音质做成胶囊标签（不是又一行小字）', p2.qualRadius + 'px');
      check(p2.durNum === 'tabular-nums', '时长用等宽数字（跳秒时不抖）', p2.durNum);
      check(p2.barTimeNum === 'tabular-nums', '播放条时间用等宽数字', p2.barTimeNum);
      // 52% 是行列表小方格的尺寸，搬到 168px 的卡片封面上就是一枚巨型音符。
      check(/30%/.test(String(p2.maskSize)),
        '占位音符缩到 30%（退回"标记"而不是"图案"）', String(p2.maskSize));
    }

    // ---------------------------------------------------------------------
    section('⑫ 运行时错误');
    check(errors.length === 0, '页面无运行时错误', errors.slice(0, 3).join(' | '));

    console.log('\n' + (failures ? '失败 ' + failures : '通过') + ' / 共 ' + checks + ' 项');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
  process.exit(failures ? 1 : 0);
})();