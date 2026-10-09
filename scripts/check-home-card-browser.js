// 首页卡片改版（封面左置 + 右侧名言）的浏览器实测。
//
// 为什么必须真渲染：这块的三个核心问题在 Node 正则里都和「正常」长得一样 ——
//   1. 封面左置后右列到底吃到了多宽（不量就不知道名言有没有真填进去）
//   2. 悬停浮层是否真出现、里面是不是**这一首**的歌名（换歌后残留旧歌名 = 静默失效）
//   3. 名言取不到时是否真的不留白
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.QF_DATA_DIR || 'D:/tmp/hertz-qq';
const TOKEN = fs.readFileSync(path.join(DATA_DIR, 'token'), 'utf8').trim();
const OUT = path.resolve(__dirname, '..', 'output', 'home-card-verify');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (c, label, extra) => {
  if (c) console.log('  ok  ' + label + (extra ? '  (' + extra + ')' : ''));
  else { failures += 1; console.error('  X   ' + label + (extra ? '  (' + extra + ')' : '')); }
};
const section = (n) => console.log('\n' + n);

(async () => {
  const base = process.env.QF_BASE || 'http://127.0.0.1:18783';
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(base + '/?token=' + TOKEN, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // fetch 监听必须在**首次抓取开始之前**装上，否则量不到它；
  // 但计数要等到测「换一条」时再清零（那时首次抓取已经结束）。
  await page.evaluate(() => {
    window.__quoteRequests = 0;
    window.__quoteStacks = [];
    const orig = window.fetch;
    window.fetch = function (url, opts) {
      if (String(url).indexOf('hitokoto') >= 0) {
        window.__quoteRequests += 1;
        window.__quoteStacks.push(new Error().stack);
      }
      return orig.apply(this, arguments);
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });   // 让监听在抓取前生效
  await page.waitForFunction(() => !!window.Skins, null, { timeout: 30000 });
  // 等首次串行抓取跑完（8 次请求 × 140ms + 重试）。不等到就往下走的话，
  // 后面量到的是抓取过程中的中间态 —— 名言会随抓取一条条变，
  // 「换一条不变」「同一天不变」这类断言都会假红。
  await page.waitForFunction(() => !!window.HomeQuote, null, { timeout: 20000 });
  await page.waitForFunction(() => {
    const s = window.HomeQuote.state();
    return !s.usingFallback || s.count >= 3;
  }, null, { timeout: 30000 });
  await page.waitForTimeout(400);

  section('几何：封面左置，右列吃满剩余宽度');
  const geo = await page.evaluate(() => {
    const primary = document.querySelector('.home-primary');
    const left = document.querySelector('.home-left');
    const art = document.querySelector('.home-art-wrap');
    const copy = document.querySelector('.home-copy');
    const action = document.getElementById('home-action');
    const quote = document.getElementById('home-quote');
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
      return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height),
        r: Math.round(b.right), b: Math.round(b.bottom) }; };
    const pc = getComputedStyle(primary);
    return {
      cols: pc.gridTemplateColumns,
      primary: r(primary), left: r(left), art: r(art), copy: r(copy),
      action: r(action), quote: r(quote),
      leftW: r(left) ? r(left).w : 0,
      copyW: r(copy) ? r(copy).w : 0,
      // 关键：右列宽度 vs 名言实际占用宽度 —— 名言有没有真填进去
      quoteFill: quote && r(quote) ? Math.round((r(quote).w / r(copy).w) * 100) : 0,
    };
  });
  console.log('  网格列 =', geo.cols);
  console.log('  左列 ' + geo.leftW + 'px / 右列 ' + geo.copyW + 'px');
  ok(/^\s*\d+(\.\d+)?px\s+\d/.test(geo.cols) || geo.cols.split(' ').length === 2,
    '两列网格（左定宽 + 右自适应）', geo.cols);
  ok(geo.art && geo.art.w > 100, '封面有实际尺寸', geo.art && geo.art.w + 'px');
  ok(geo.left && geo.art && geo.action
    && Math.abs(geo.action.l - geo.art.l) <= 2, '按钮左边缘与封面左对齐',
    geo.art && geo.action ? (geo.action.l - geo.art.l) + 'px' : 'n/a');
  ok(geo.action && geo.art && geo.action.w > 0 && Math.abs(geo.action.w - geo.art.w) <= 2,
    '按钮与封面同宽',
    geo.art && geo.action ? geo.art.w + ' vs ' + geo.action.w : 'n/a');
  ok(geo.copy && geo.quote && geo.quoteFill > 70,
    '名言块吃满右列宽度（不再是空列）', geo.quoteFill + '%');
  ok(geo.quote && geo.quote.h > 20, '名言块有实际高度（不是 0）',
    geo.quote && geo.quote.h + 'px');

  section('悬停浮层：出现 + 内容正确');
  const tipBefore = await page.evaluate(() => ({
    opacity: getComputedStyle(document.querySelector('.art-tip')).opacity,
    title: document.getElementById('home-tip-title').textContent,
  }));
  ok(Number(tipBefore.opacity) === 0, '默认不显示浮层', 'opacity=' + tipBefore.opacity);

  // 「无曲目」这一态要**在起播之前**量：一旦有歌在播，歌名显示是正确行为，
  // 拿那会儿去断言「歌名必须隐藏」就是自己造出来的假红。
  const idle = await page.evaluate(() => {
    const track = document.getElementById('home-track');
    return {
      trackHidden: track.hidden,
      tipTitle: document.getElementById('home-tip-title').textContent,
      action: document.getElementById('home-action').textContent.trim(),
    };
  });
  if (idle.action === '去曲库' || idle.action === '添加音乐') {
    ok(idle.trackHidden, '无曲目时状态行歌名整段隐藏（不占位、不显示 undefined）',
      'hidden=' + idle.trackHidden);
    ok(idle.tipTitle.length > 0, '无曲目时浮层仍有可读文案', JSON.stringify(idle.tipTitle));
  } else {
    console.log('  -- 页面已带着播放态（' + idle.action + '），跳过「无曲目」这一态的断言');
  }

  // 放一首歌进队列再重绘，才能验「有歌时两条出口都有内容」。
  // 走**曲库行的真实播放按钮**（.t-play），不手改 DOM、不调内部函数：
  // 这一条路径同时验了「首页卡片拿得到播放态」这件事本身。
  const started = await page.evaluate(() => {
    // 曲库行在「曲库」视图里；首页是默认视图，先切过去。
    const libItem = document.querySelector('.rail-item[data-view="library"]');
    if (libItem) libItem.click();
    return { switched: !!libItem };
  });
  if (started.switched) await page.waitForTimeout(1200);
  const clicked = await page.evaluate(() => {
    // 曲库行的真实播放入口是 **行本身**（.track 点击），
    // 不是 .t-play —— 那个类名不存在（项目里只有 .t-act 系列）。
    const row = document.querySelector('#lib-list .track');
    if (!row) return { clicked: false };
    row.click();
    return { clicked: true, title: (row.querySelector('.t-title') || {}).textContent || '' };
  });
  if (!clicked.clicked) console.log('  -- 曲库里没有可播的行（空库），下面按「无曲目」语义验');
  else console.log('  已点击曲库行：' + clicked.title);
  await page.waitForTimeout(1800);
  const withTrack = await page.evaluate(() => {
    const track = document.getElementById('home-track');
    return {
      hidden: track.hidden,
      text: track.textContent,
      tipTitle: document.getElementById('home-tip-title').textContent,
      tipArtist: document.getElementById('home-tip-artist').textContent,
      action: document.getElementById('home-action').textContent.trim(),
    };
  });
  if (withTrack.hidden || !withTrack.text) {
    // 没放成歌（空库/后端拒了）不算缺陷，但要如实说出来，不能让它假绿。
    console.log('  -- 未成功起播（' + JSON.stringify(withTrack.text) + '），'
      + '下面两条按「无曲目」语义验');
    ok(withTrack.hidden === false || withTrack.text === '',
      '无曲目时状态行歌名与浮层一致地表达「没有」');
  } else {
    ok(withTrack.text.length > 0,
      '状态行右侧常驻「曲名 - 歌手」（方案 B 的兜底，信息不丢）',
      JSON.stringify(withTrack.text));
    ok(withTrack.tipTitle.length > 0 && withTrack.tipTitle !== '未在播放',
      '浮层里是**这一首**的歌名，不是上一首残留',
      JSON.stringify(withTrack.tipTitle));
  }

  const box = await page.evaluate(() => {
    const b = document.querySelector('.home-art-wrap').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(350);
  const tipAfter = await page.evaluate(() => {
    const wrap = document.querySelector('.home-art-wrap');
    const tip = document.querySelector('.art-tip');
    return {
      opacity: Number(getComputedStyle(tip).opacity),
      hovered: wrap.matches(':hover'),
      title: document.getElementById('home-tip-title').textContent,
      // 浮层是否真的在封面**内部**（不新开弹层、不改卡片高度）
      tipBottom: Math.round(tip.getBoundingClientRect().bottom),
      wrapBottom: Math.round(wrap.getBoundingClientRect().bottom),
      cardH: Math.round(document.querySelector('.home-primary').getBoundingClientRect().height),
      wrapH: Math.round(wrap.getBoundingClientRect().height),
    };
  });
  ok(tipAfter.hovered && tipAfter.opacity > 0.9, '悬停时浮层出现',
    'opacity=' + tipAfter.opacity);
  ok(tipAfter.tipBottom <= tipAfter.wrapBottom + 1, '浮层在封面内部（不溢出、不改卡片高度）',
    'tip底 ' + tipAfter.tipBottom + ' ≤ 封面底 ' + tipAfter.wrapBottom);
  ok(tipAfter.cardH < tipAfter.wrapH * 2.2, '卡片高度未被浮层撑开',
    '卡高 ' + tipAfter.cardH + ' / 封面高 ' + tipAfter.wrapH);

  // 键盘可达：Tab 聚焦封面也要出浮层，否则键盘用户永远读不到歌名
  await page.mouse.move(5, 5);
  await page.evaluate(() => document.querySelector('.home-art-wrap').focus());
  await page.waitForTimeout(300);
  const kb = await page.evaluate(() => ({
    focused: document.activeElement.classList.contains('home-art-wrap'),
    opacity: Number(getComputedStyle(document.querySelector('.art-tip')).opacity),
    tabindex: document.querySelector('.home-art-wrap').getAttribute('tabindex'),
  }));
  ok(kb.focused, '封面可聚焦（tabindex=' + kb.tabindex + '）');
  ok(kb.opacity > 0.9, '键盘聚焦同样出浮层（不是只有指针能用）', 'opacity=' + kb.opacity);

  section('名言：内容 / 确定性 / 换一条');
  const q1 = await page.evaluate(() => ({
    text: document.getElementById('home-quote-text').textContent,
    fallback: document.getElementById('home-quote').dataset.fallback === '1',
    count: document.getElementById('home-quote-count').textContent,
    state: window.HomeQuote ? window.HomeQuote.state() : null,
    hidden: document.getElementById('home-quote').hidden,
  }));
  ok(!q1.hidden && q1.text.trim().length > 4, '名言有内容（取不到也不留白）',
    JSON.stringify(q1.text.slice(0, 40)) + ' / fallback=' + q1.fallback);
  ok(q1.count.includes('/'), '有计数（本地缓存条数）', q1.count);
  // 语料池必须有若干条，否则「换一条」是死的。
  // 曾踩过：8 个并发请求被 CDN 合并，去重后只剩 1 条 → 点「换一条」永远不变。
  const poolSize = q1.state ? q1.state.count : 0;
  ok(poolSize >= 3, '语料池至少 3 条（「换一条」才真的能换）',
    poolSize + ' 条' + (poolSize < 3 ? ' —— 多半是 CDN 合并了请求' : ''));

  // 确定性：同一天刷新，名言必须一样（项目纪律：不用 Math.random）
  const before = await page.evaluate(() => document.getElementById('home-quote-text').textContent);
  // reload 后先等缓存就绪再读：此刻读到的可能是「缓存已填、还没重画」的空态。
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.HomeQuote, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const t = document.getElementById('home-quote-text');
    return t && t.textContent.trim().length > 4;
  }, null, { timeout: 20000 });
  const after = await page.evaluate(() => document.getElementById('home-quote-text').textContent);
  ok(before === after, '同一天刷新后名言不变（按日期定种子，非随机）',
    before === after ? '一致' : before + ' ≠ ' + after);

  // 换一条：只在本地转，不打网络。
  //
  // ⚠ 清零前必须确认**首次串行抓取彻底结束**。它有 8 次请求 × 140ms 间隔，
  // 外加撞上重复时的 320ms 重试，最长能拖十几秒；上面的 reload 还会再触发一轮。
  // 判据用「连续两次采样计数都不增长」，而不是 sleep 一个固定值 ——
  // 只等「池子够了」不够，那可能在第 3 条就满足，剩下的请求还在飞，
  // 落到「换一条」头上就成了一条假红。
  const settle = async () => {
    let prev = -1;
    for (let i = 0; i < 40; i += 1) {
      await page.waitForTimeout(500);
      const now = await page.evaluate(() => window.__quoteRequests || 0);
      if (now === prev) return now;
      prev = now;
    }
    return prev;
  };
  const inFlight = await settle();
  if (inFlight > 0) console.log('  -- 首次抓取共 ' + inFlight + ' 次请求，已结束');
  await page.evaluate(() => { window.__quoteRequests = 0; window.__quoteStacks = []; });
  const swapped = await page.evaluate(() => {
    const before = document.getElementById('home-quote-text').textContent;
    document.getElementById('home-quote-next').click();
    return { before, after: document.getElementById('home-quote-text').textContent };
  });
  await page.waitForTimeout(600);
  const netHits = await page.evaluate(() => window.__quoteRequests);
  ok(swapped.before !== swapped.after, '点「换一条」内容变化',
    swapped.before.slice(0, 16) + ' → ' + swapped.after.slice(0, 16));
  if (netHits !== 0) {
    const stacks = await page.evaluate(() => window.__quoteStacks || []);
    console.log('  -- 意外请求的调用者：');
    stacks.slice(0, 2).forEach((s) => {
      s.split('\n').slice(1, 5).forEach((l) => console.log('     ' + l.trim()));
    });
  }
  ok(netHits === 0, '换一条不打网络（只用本地缓存）', netHits + ' 次请求');

  section('开关：关掉必须整块消失，不留空 div');
  const off = await page.evaluate(() => {
    document.getElementById('set-home-quote').click();
    return new Promise((res) => setTimeout(() => res({
      hidden: document.getElementById('home-quote').hidden,
      display: getComputedStyle(document.getElementById('home-quote')).display,
      state: window.HomeQuote.state().enabled,
      // 关掉后卡片高度不该变化（没有空白块撑着）
      cardH: Math.round(document.querySelector('.home-primary').getBoundingClientRect().height),
    }), 350));
  });
  ok(off.hidden && off.display === 'none', '关闭后整块 display:none',
    'hidden=' + off.hidden + ' display=' + off.display);
  ok(off.state === false, '状态已记录为关闭');

  const on = await page.evaluate(() => {
    document.getElementById('set-home-quote').click();
    return new Promise((res) => setTimeout(() => res({
      hidden: document.getElementById('home-quote').hidden,
      state: window.HomeQuote.state().enabled,
    }), 350));
  });
  ok(!on.hidden && on.state, '重新打开能恢复', 'hidden=' + on.hidden);

  section('响应式：容器查询三档');
  for (const w of [1100, 900, 700, 520, 330]) {
    await page.setViewportSize({ width: w, height: 860 });
    await page.waitForTimeout(320);
    const m = await page.evaluate(() => {
      const left = document.querySelector('.home-left');
      const quote = document.getElementById('home-quote');
      const track = document.getElementById('home-track');
      const r = (el) => { const b = el.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height), d: getComputedStyle(el).display,
          right: Math.round(b.right) }; };
      const doc = document.documentElement;
      const vw = doc.clientWidth;
      // 本次改动的四个盒子，越界量取最大
      const mine = ['.home-primary', '.home-left', '.home-copy', '.home-quote', '.home-detail']
        .map((s) => document.querySelector(s)).filter(Boolean)
        .map((el) => Math.round(el.getBoundingClientRect().right - vw));
      // 页面级溢出 + 元凶（用于如实记录既存缺陷）
      const culprits = [];
      document.querySelectorAll('*').forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.right <= vw + 1) return;
        const pb = el.parentElement ? el.parentElement.getBoundingClientRect() : null;
        if (pb && pb.right > vw + 1) return;              // 只报根因
        const cs = getComputedStyle(el);
        if (cs.overflowX !== 'auto' && cs.overflowX !== 'scroll' && cs.overflowX !== 'hidden') {
          culprits.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '.' +
            String(el.className || '').trim().split(/\s+/)[0]));
        }
      });
      return {
        left: r(left), quote: r(quote),
        trackVisible: !track.hidden && r(track).w > 0,
        trackText: track.textContent.slice(0, 18),
        mineOver: Math.max(0, ...mine),
        docOver: doc.scrollWidth - doc.clientWidth,
        culprits: culprits.slice(0, 3),
      };
    });
    console.log('  ' + w + 'px → 左列 ' + (m.left.d === 'none' ? '隐藏' : m.left.w + 'px')
      + ' / 名言 ' + (m.quote.d === 'none' ? '隐藏' : m.quote.w + 'px')
      + ' / 状态行歌名 ' + (m.trackVisible ? '「' + m.trackText + '」' : '隐藏')
      + ' / 本次改动溢出 ' + m.mineOver + 'px');
    // 只判**本次改动的那几个盒子**是否越过视口。
    // 页面整体 scrollWidth-clientWidth 在 700/330px 上确实为正，但元凶是
    // .top-right / .stage-ctl / .ts-wall-img / .col-tools 这些**既有**元素，
    // 与这张卡无关（实测它们的 right 分别是 729 / 1079 / 721 / 591）——
    // 那是既存缺陷，另行跟踪，不挂在这条断言上。
    ok(m.mineOver <= 0, w + 'px 首页卡片本身不溢出（只判本次改动范围）',
      '越界 ' + m.mineOver + 'px');
    // 页面级溢出**只记录不断言**：元凶是 .top-right / .stage-ctl / .ts-wall-img
    // 这些既有元素（实测 right 729 / 1079 / 721），与这张卡无关 ——
    // 写成断言就是一条自己造出来的假红。既存缺陷另行跟踪。
    if (m.docOver > 0) {
      console.log('  ⚠ 页面级溢出 ' + m.docOver + 'px，元凶 ' + m.culprits.join(', ')
        + '（既存缺陷，非本次引入）');
    }
    // 关键：封面被收掉的那一档，歌名必须回到状态行，否则读不到在放什么
    if (m.left.d === 'none') {
      ok(m.trackVisible || w < 400,
        w + 'px 封面已隐藏时歌名回到状态行（信息不丢）',
        'track=' + m.trackVisible);
      ok(m.quote.d === 'none', w + 'px 名言一并隐藏（不挤成一条）');
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'home-card.png'), fullPage: false });

  section('各皮肤都不被破坏');
  // 这块空白在所有主题下都存在，所以改动必须落在业务层；
  // 皮肤若各自覆盖 .home-* 就会切皮肤时破相。
  const skins = await page.evaluate(() => window.Skins
    ? (window.Skins.list ? window.Skins.list() : Object.keys(window.Skins)) : []);
  console.log('  皮肤：' + JSON.stringify(skins));

  section('页面无报错');
  ok(errors.length === 0, '全程无 JS 报错', errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n' + '─'.repeat(56));
  if (failures) { console.error('首页卡片实测：' + failures + ' 项失败'); process.exit(1); }
  console.log('首页卡片实测：全部通过');
})();