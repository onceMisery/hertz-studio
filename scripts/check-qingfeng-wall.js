// 一次性：往播放队列里灌一批曲目，然后跑队列拼接页的密排/展开/关灯实测。
// 为什么单独写：check-qingfeng-browser.js 跑的是空队列分支，
// 海报墙最该验的三件事（密排缝、方角、展开卡）全在非空分支里。
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.QF_BASE || 'http://127.0.0.1:7891';
const DATA_DIR = process.env.QF_DATA_DIR || path.join(os.tmpdir(), 'qf-data2');
const TOKEN = fs.readFileSync(path.join(DATA_DIR, 'token'), 'utf8').trim();
const OUT = path.resolve(__dirname, '..', 'output', 'qingfeng-verify');
fs.mkdirSync(OUT, { recursive: true });
const { clickPoster, clickFirstPoster } = require('./qf-wall-helpers.js');

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ok  ' + label + (extra ? '  (' + extra + ')' : ''));
  else { failures += 1; console.error('  X   ' + label + (extra ? '  (' + extra + ')' : '')); }
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(m.text());
  });

  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.Skins.apply('qingfeng'));
  await page.waitForTimeout(600);

  // 直接注入队列快照：走真实播放路径需要真实音频文件，
  // 这里要验的是墙的排版与交互，不是解码。
  //
  // 注入点是 **source-request**（不是旧的 queue-request）：墙现在按当前
  // tab 取源，队列那一列走的也是 source-request，只是 kind==='queue'。
  // 挂在 queue-request 上注入会完全不生效 —— 实测「注入64 项」而墙上0 张，
  // 而页面不报错（事件没人监听而已）。
  //
  // 注入的项必须带 sourceKey/queueItem：播放分派靠这两个字段走路，
  // 与真实 queueSnapshot() 的产物保持同一形状。
  const injected = await page.evaluate(() => {
    const fake = [];
    for (let i = 0; i < 64; i += 1) {
      fake.push({
        id: `probe-${i}`,
        index: i,
        badge: String(i + 1).padStart(2, '0'),
        title: `曲目 ${i + 1} · 拼接测试`,
        artist: ['棱镜 / 东野圭吾', '窦唯', 'Radiohead', '坂本龙一'][i % 4],
        duration: 180000 + i * 7300,
        cover: '',
        current: i === 3,
        playing: i === 3,
        progress: 0.42,
        sourceKey: 'queue',
        queueItem: true,
      });
    }
    window.__qfProbeQueue = fake;
    // 拦截取源结果：把 source.items 换成假数据，其余字段（key/label/kind）
    // 保持 app.js 给的原样 —— 墙上要显示的来源名与按钮组都由它们决定。
    //
    // 必须用冒泡阶段且在 app.js 之后注册 —— app.js 的监听器先写 detail.source，
    // 捕获阶段会排在它前面，结果是被覆盖掉，注入白做。
    document.addEventListener('qf:panel', (e) => {
      const d = e.detail;
      if (!d || d.action !== 'source-request') return;
      if (!d.source || d.source.key !== 'queue') return;
      d.source = { key: 'queue', label: d.source.label, kind: 'queue',
        items: window.__qfProbeQueue, emptyHint: d.source.emptyHint };
    });
    return fake.length;
  });
  console.log(`注入队列：${injected} 项\n`);

  // **先切到播放队列视图**：墙取的是**当前 tab** 的源（队列拼接是每个 tab
  // 都有的），停在默认视图上注入 queue 的数据不会被取到 ——
  // 实测「注入 64 项」而墙上0 张，页面不报错，只是源对不上。
  await page.evaluate(() => {
    const item = document.querySelector('.rail-item[data-view="queue"]');
    if (item) item.click();
  });
  await page.waitForTimeout(500);

  console.log('打开海报墙');
  await page.click('.qf-nav-icon');
  // 入场波：在波的中段读（约 250ms）—— 卡片带着 is-landing 与逐级递增的
  // 延时（左上角先落）；波播完后类还在但动画已结束，读了等于没读。
  await page.waitForTimeout(250);
  const wave = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.qf-poster.is-landing'));
    const delays = cards.map((n) => parseFloat(getComputedStyle(n).animationDelay) || 0);
    const midFlight = cards.filter((n) => Number(getComputedStyle(n).opacity) < 0.999).length;
    return { landing: cards.length, staggered: delays.filter((d) => d > 0.05).length, midFlight };
  });
  ok(wave.landing > 0, '开墙有入场波（卡片带 is-landing）', `landing=${wave.landing}`);
  ok(wave.staggered > 0, '入场波按距离逐级展开（延时不为零）', `staggered=${wave.staggered}`);
  ok(wave.midFlight > 0, '波中段确有卡片还没落定（动画真的在播）', `midFlight=${wave.midFlight}`);
  // 入场波窗口约 1.1s（延时 0.34s + 着落 0.72s），等波播完再量几何 ——
  // 着落期间卡片带着 translateY/scale 变换，getBoundingClientRect 是歪的。
  await page.waitForTimeout(1250);

  const wall = await page.evaluate(() => ({
    posters: document.querySelectorAll('.qf-poster').length,
    count: window.__qfSkin.posterCount(),
    empty: !!document.querySelector('.qf-lattice-empty:not([hidden])'),
  }));
  ok(wall.posters > 0 && !wall.empty, '渲染出海报', `posters=${wall.posters} count=${wall.count}`);

  // 密排：块内必须被卡片精确覆盖（允许 GAP 宽的缝，不允许更大的洞）。
  // 块的完整矩形按相机矩阵**算出来**（不是从挂载卡的包围盒取 —— 展开卡
  // 不在块中心，包围盒必然偏），只测完整落在扩边视口内的块：裁剪区比
  // 视口四周各多 500px，这样的块所有卡一定都挂着。之前按「同一行相邻
  // 卡片的间距」量 —— 大小混排的模板里同一 top 高度上两张卡中间隔着
  // 别行的大卡，量出来几百 px 的假缝。
  const coverage = await page.evaluate(() => {
    const world = document.querySelector('.qf-lattice-world');
    const m = new DOMMatrixReadOnly(getComputedStyle(world).transform);
    const s = m.a;
    const PITCH = 136, COLS = 12, ROWS = 8;
    const toScreen = (wx, wy) => ({ x: wx * s + m.e, y: wy * s + m.f });
    const ps = Array.from(document.querySelectorAll('.qf-poster'));
    const byBlock = new Map();
    for (const n of ps) {
      const key = (n.dataset.qfKey || '').split(':').slice(0, 2).join(':');
      if (!byBlock.has(key)) byBlock.set(key, []);
      byBlock.get(key).push(n.getBoundingClientRect());
    }
    const MARGIN = 400; // < OVERSCAN(500)：块完整落在视口+400px 内则全部卡片已挂载
    const STEP = 14;
    const PAD = 12; // ≈ GAP(8 世界 px) × 0.76 缩放 + 余量
    let blocks = 0;
    let holes = 0;
    for (const key of byBlock.keys()) {
      const [bxs, bys] = key.split(':').map(Number);
      const p0 = toScreen(bxs * COLS * PITCH, bys * ROWS * PITCH);
      const p1 = toScreen((bxs + 1) * COLS * PITCH, (bys + 1) * ROWS * PITCH);
      if (p0.x < -MARGIN || p0.y < -MARGIN || p1.x > window.innerWidth + MARGIN
        || p1.y > window.innerHeight + MARGIN) continue;
      blocks += 1;
      const rects = byBlock.get(key);
      for (let y = p0.y; y <= p1.y; y += STEP) {
        for (let x = p0.x; x <= p1.x; x += STEP) {
          const covered = rects.some((r) =>
            x >= r.left - PAD && x <= r.right + PAD && y >= r.top - PAD && y <= r.bottom + PAD);
          if (!covered) holes += 1;
        }
      }
    }
    return { blocks, holes };
  });
  ok(coverage.blocks >= 1 && coverage.holes === 0,
    '块内密排覆盖完整（无背景色洞）',
    `${coverage.blocks} 个完整块，${coverage.holes} 个采样洞`);
  // 墙要铺满视口：渲染实例里必须有相当一部分落在屏幕内（其余是 overscan 缓冲）
  const span = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('.qf-poster')).map((n) => n.getBoundingClientRect());
    const vis = all.filter((r) => r.right > 0 && r.left < window.innerWidth && r.bottom > 0 && r.top < window.innerHeight);
    const minL = Math.min(...all.map((r) => r.left));
    const maxR = Math.max(...all.map((r) => r.right));
    return { visible: vis.length, w: Math.round(maxR - minL) };
  });
  ok(span.visible >= 8, '墙铺满视口', `${span.visible} 张可见`);
  ok(span.w > 1440, '墙在宽度方向溢出（可循环平移）', `span.w=${span.w}`);

  // 墙是全屏沉浸的：底层的悬浮主菜单 / 播放胶囊 / 头像组必须收掉。
  // 它们都是 fixed/z-index 浮在 .app 之上，不收就叠在海报墙上 ——
  // 实测截图里顶栏搜索框与播放胶囊正好压在大卡上，糊掉最显眼的位置。
  const overlay = await page.evaluate(() => {
    const vis = (sel) => {
      const n = document.querySelector(sel);
      return n ? getComputedStyle(n).display !== 'none' : false;
    };
    return {
      topbar: vis('.topbar'), nav: vis('.qf-nav'), bar: vis('.bar'),
      acct: vis('.qf-account'), set: vis('.qf-settings-btn'),
    };
  });
  ok(!overlay.topbar && !overlay.nav && !overlay.bar && !overlay.acct && !overlay.set,
    '墙开着时底层浮件全部收起（不叠在海报上）', JSON.stringify(overlay));

  // 墙必须自己铺底色：底下压着业务视图，全透明会把曲库页透出来，
  // 墙就读作一层半透明贴纸而不是独立页面。
  const bg = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.qf-lattice'));
    const m = /color-mix\(in srgb, rgb?\([^)]*\) ([\d.]+)%/.exec(cs.backgroundColor)
      || /rgba?\([^)]*?,\s*([\d.]+)\)$/.exec(cs.backgroundColor);
    return { color: cs.backgroundColor, alpha: m ? Number(m[1]) : null, blur: cs.backdropFilter };
  });
  ok(bg.alpha === null || bg.alpha >= 90,
    '墙铺了足够不透明的底色（业务视图不透出来）', `alpha=${bg.alpha}% ${bg.color}`);
  ok(/blur/.test(bg.blur || ''), '墙底做了模糊（透出壁纸时仍读作浮层）', bg.blur);

  // 展开卡的字不能撑出卡外（字号必须跟卡片宽度走，不是跟视口走）
  const overflow = await page.evaluate(() => {
    const e = document.querySelector('.qf-poster.is-expanded');
    if (!e) return null;
    const copy = e.querySelector('.qf-poster-copy');
    const s = copy.querySelector('strong');
    const fs = parseFloat(getComputedStyle(s).fontSize);
    return { cardW: Math.round(e.getBoundingClientRect().width), fontPx: Math.round(fs), ratio: fs / e.getBoundingClientRect().width };
  });
  ok(overflow && overflow.ratio < 0.16,
    '展开卡字号跟卡片宽度走（不撑出卡外）',
    overflow ? `字号 ${overflow.fontPx}px / 卡宽 ${overflow.cardW}px = ${(overflow.ratio * 100).toFixed(1)}%` : 'n/a');

  // 方角是这套视觉最强的识别特征
  const radius = await page.$eval('.qf-poster', (n) => getComputedStyle(n).borderTopLeftRadius);
  ok(parseFloat(radius) === 0, '海报保持方角', `radius=${radius}`);

  await page.screenshot({ path: path.join(OUT, '03-lattice.png') });

  console.log('\n点开一张');
  // 挑要点的卡，有两条硬约束：
  //
  // 1. **排除已展开的那张**。开墙时若源里有 current 项，墙会自动把它展开
  //（614×614，比任何普通格都大），而「视口内最大的一张」恰好就是它——
  // 点下去走的是「点已展开的卡片 = 收起」那条分支，断言表现为
  // 「点开了但没有 is-expanded」。要验的是「点未展开的 → 展开」。
  // 2. **只要求中心点在视口内**，不要求四边都在。展开卡占住视口中心后，
  // 密排的 lattice 里没有「四边完整可见」的其它卡了（实测 key=null）。
  //
  // 取多个候选交给 clickFirstPoster 挨个试：卡与卡之间没有空白，
  // 中心点可能被展开卡盖住，那张要跳过而不是当成缺陷。
  const targets = await page.evaluate(() => {
    const cx0 = window.innerWidth / 2;
    const cy0 = window.innerHeight / 2;
    return Array.from(document.querySelectorAll('.qf-poster'))
      .filter((n) => {
        if (n.classList.contains('is-expanded')) return false;
        const r = n.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight
          && Math.abs(x - cx0) + Math.abs(y - cy0) > 120; // 离视口中心远一点，别贴着展开卡
      })
      .sort((a, b) => {
        const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
        return (rb.width * rb.height) - (ra.width * ra.height);
      })
      .slice(0, 8)
      .map((n) => n.dataset.qfKey);
  });
  const alreadyExpanded = await page.evaluate(() => document.querySelectorAll('.qf-poster.is-expanded').length);
  ok(targets.length > 0, '视口内有可点的海报（不含已展开的那张）',
    `候选=${targets.length} 已展开=${alreadyExpanded}`);
  const clicked = await clickFirstPoster(page, targets.map((k) => `.qf-poster[data-qf-key="${k}"]`));
  console.log(`  （点的是 ${clicked.selector}，命中 ${clicked.hit}）`);
  await page.waitForTimeout(1000);
  const exp = await page.evaluate(() => {
    const e = document.querySelector('.qf-poster.is-expanded');
    if (!e) return { found: false };
    const r = e.getBoundingClientRect();
    const q = (s) => e.querySelector(s);
    return {
      found: true,
      w: Math.round(r.width),
      h: Math.round(r.height),
      // 相机是否把展开卡**居中**带进视口（不是"部分可见"就算）。
      // 判据：卡片中心落在视口中心附近，且四边都在视口内。
      cx: Math.round(r.left + r.width / 2),
      cy: Math.round(r.top + r.height / 2),
      vw: window.innerWidth,
      vh: window.innerHeight,
      inView: r.left >= -2 && r.right <= window.innerWidth + 2
        && r.top >= -2 && r.bottom <= window.innerHeight + 2,
      hasPlay: !!q('.qf-chrome-play'),
      hasChrome: !!q('.qf-chrome'),
      hasBadge: !!q('.qf-poster-badge'),
      // 曲名在 .qf-poster-copy strong 里（没有 .qf-poster-title 这个类）
      title: (q('.qf-poster-copy strong') || {}).textContent || '',
      artist: (q('.qf-poster-copy small') || {}).textContent || '',
      isCurrent: e.classList.contains('is-current'),
      currentCount: document.querySelectorAll('.qf-poster.is-current').length,
      litCount: document.querySelectorAll('.qf-poster:not(.is-current)').length,
      // 同时展开的张数。开墙时 current 那张已被展开，再点一张若不先收，
      // 墙上会同时铺着两张 6×6 —— 而且下面这些断言 querySelector 取到的
      // 是第一张（旧卡），红得莫名其妙。
      expandedCount: document.querySelectorAll('.qf-poster.is-expanded').length,
      // 展开档：世界坐标尺寸（内联样式，未经相机缩放）× 缩放 = 屏幕尺寸
      gear: {
        w: Math.round((parseFloat(e.style.width) + 8) * 0.76),
        h: Math.round((parseFloat(e.style.height) + 8) * 0.76),
        ow: e.dataset.qfRect ? JSON.parse(e.dataset.qfRect).w : 0,
        oh: e.dataset.qfRect ? JSON.parse(e.dataset.qfRect).h : 0,
      },
    };
  });
  ok(exp.found, '点海报展开成大卡');
  ok(exp.expandedCount === 1, '任一时刻只有一张展开档', `${exp.expandedCount} 张`);
  ok(exp.w > 260, '展开卡显著大于普通格', `${exp.w}×${exp.h}`);
  ok(exp.inView, '相机把展开卡完整带进视口',
    `rect=(${Math.round(exp.cx - exp.w / 2)},${Math.round(exp.cy - exp.h / 2)}) ${exp.w}×${exp.h}`
    + ` 视口 ${exp.vw}×${exp.vh}`);
  ok(Math.abs(exp.cx - exp.vw / 2) < exp.w * 0.35,
    '展开卡被相机带到视口中部', `cx=${exp.cx} vw/2=${Math.round(exp.vw / 2)}`);
  ok(exp.hasPlay && exp.hasChrome, '展开卡带播放控件');
  ok(exp.hasBadge, '展开卡带序号徽章');
  ok(!!exp.title && !!exp.artist, '展开卡带曲名与艺人', `${exp.title} / ${exp.artist}`);
  // 展开档必须是 6×6 固定档（参考项目 blockTemplates.ts 的 EXPANSION_SPAN）。
  // 不设档的话，1×8 那种竖条展开后仍是一条窄带 —— 曲名压住播放控件。
  ok(exp.gear && Math.abs(exp.gear.w - exp.gear.h) < 24 && exp.gear.w > 540,
    '展开卡是 6×6 固定档（不是原格子尺寸）',
    exp.gear ? `${exp.gear.w}×${exp.gear.h}（原格 ${exp.gear.ow}×${exp.gear.oh}）` : 'n/a');

  // 展开是「整块让位重排」，不是「大卡压住邻居」：
  //   1) 展开卡与任何其它卡的矩形交叠面积必须≈0（folia 的块内重新咬合）；
  //   2) 同块的邻居必须真的挪过窝（当前内联矩形 ≠ 建卡时的原始格位），
  //      否则就是退化成叠罗汉。
  const reflow = await page.evaluate(() => {
    const e = document.querySelector('.qf-poster.is-expanded');
    if (!e) return null;
    const er = e.getBoundingClientRect();
    const blockKey = (e.dataset.qfKey || '').split(':').slice(0, 2).join(':');
    let overlapPx = 0;
    let movedNeighbors = 0;
    let neighbors = 0;
    for (const n of document.querySelectorAll('.qf-poster')) {
      if (n === e) continue;
      const r = n.getBoundingClientRect();
      const ox = Math.min(er.right, r.right) - Math.max(er.left, r.left);
      const oy = Math.min(er.bottom, r.bottom) - Math.max(er.top, r.top);
      if (ox > 2 && oy > 2) overlapPx = Math.max(overlapPx, Math.round(ox * oy));
      if ((n.dataset.qfKey || '').split(':').slice(0, 2).join(':') === blockKey) {
        neighbors += 1;
        const base = JSON.parse(n.dataset.qfRect || '{}');
        const now = { x: parseFloat(n.style.left), y: parseFloat(n.style.top) };
        if (Math.abs(base.x - now.x) > 1 || Math.abs(base.y - now.y) > 1) movedNeighbors += 1;
      }
    }
    return { overlapPx, movedNeighbors, neighbors };
  });
  ok(reflow && reflow.overlapPx === 0, '展开卡不压住任何邻居（让位重排生效）',
    reflow ? `最大交叠 ${reflow.overlapPx}px²` : 'n/a');
  ok(reflow && reflow.movedNeighbors > 0,
    '同块邻居真的挪了窝（不是原格位叠在展开卡底下）',
    reflow ? `${reflow.movedNeighbors}/${reflow.neighbors} 张移位` : 'n/a');

  // 曲名与控件条不许重叠：两片都锚在卡底（copy 靠 flex-end，
  // controls 是 bottom:28px 绝对定位），不各让一条就叠在一起。
  // 只有量真实几何才看得出 —— 截图里曲名正压在暂停键上，DOM 完好。
  const collide = await page.evaluate(() => {
    const e = document.querySelector('.qf-poster.is-expanded');
    const ctl = e.querySelector('.qf-poster-controls');
    const strong = e.querySelector('.qf-poster-copy strong');
    if (!ctl || !strong) return null;
    const a = strong.getBoundingClientRect();
    const b = ctl.getBoundingClientRect();
    const overlap = !(a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right);
    return { overlap, titleBottom: Math.round(a.bottom), ctlTop: Math.round(b.top) };
  });
  ok(collide && !collide.overlap, '曲名与播放控件不重叠',
    collide ? `曲名底 ${collide.titleBottom} / 控件顶 ${collide.ctlTop}` : 'n/a');
  // 正在播放那张：createPoster 用 is-current（没有 is-playing 这个类）。
  // 墙是循环铺满的（folia 同构），同一项的每个实例都标 is-current ——
  // 关灯模式靠它留亮所有「正在播放」位，所以断言「至少一张」而不是「恰好一张」。
  ok(exp.currentCount >= 1, '有海报打了「正在播放」标记（含循环实例）', `${exp.currentCount} 张`);
  await page.screenshot({ path: path.join(OUT, '04-lattice-expanded.png') });

  console.log('\n关灯 + 键盘');
  const tools = await page.$$('.qf-tools-btn');
  ok(tools.length >= 3, '右下角有工具按钮组', `${tools.length} 个`);
  const lightsBefore = await page.$eval('.qf-lattice', (n) => n.className);
  await page.click('.qf-tools-btn >> nth=0');
  await page.waitForTimeout(600);
  const lightsAfter = await page.$eval('.qf-lattice', (n) => n.className);
  ok(lightsBefore !== lightsAfter, '关灯切换生效', `${lightsBefore} → ${lightsAfter}`);
  await page.screenshot({ path: path.join(OUT, '05-lattice-lightsout.png') });

  // 方向键移动焦点
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  const focused = await page.evaluate(() => {
    const f = document.querySelector('.qf-poster.is-focused');
    return f ? { found: true, w: Math.round(f.getBoundingClientRect().width) } : { found: false };
  });
  ok(focused.found, '方向键移动焦点');
  await page.screenshot({ path: path.join(OUT, '06-lattice-focus.png') });

  await page.keyboard.press('Escape');
  // 退场波：root 要等反向波播完（延时 0.34s + 飞回 0.28s）才藏、海报才回收，
  // isWallOpen/body 标记则是立即摘的 —— 所以这里等足 1s 再断言回收。
  await page.waitForTimeout(1000);
  ok(await page.evaluate(() => !window.__qfSkin.isWallOpen()), 'Esc 退出海报墙');
  ok(await page.evaluate(() => !document.body.classList.contains('qf-lattice-open')), 'body 标记已摘');
  ok(await page.evaluate(() => document.querySelectorAll('.qf-poster').length === 0), '海报实例已回收');

  console.log('\n设置浮层（非空队列下再开一次，确认不受影响）');
  await page.click('.qf-settings-btn');
  await page.waitForTimeout(800);
  ok(await page.evaluate(() => {
    const m = document.querySelector('.qf-modal');
    return m && !m.hidden && getComputedStyle(m).zIndex >= 200;
  }), '设置浮层正常打开');
  await page.screenshot({ path: path.join(OUT, '07-settings.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  // 关键回归：关掉设置后底层必须还能点（qf-modal-open 漏摘的回归点）
  const clickable = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, 300);
    return !!el && el.closest('.app') !== null;
  });
  ok(clickable, '关掉设置后底层恢复可点（body 隔离标记已摘）');

  const real = errors.filter((e) => !/favicon|ERR_ABORTED/i.test(e));
  ok(real.length === 0, '全流程无 JS 报错', real.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n' + '─'.repeat(56));
  console.log(`截图目录：${OUT}`);
  if (failures) { console.error(`队列拼接非空态实测：${failures} 项失败`); process.exit(1); }
  console.log('队列拼接非空态实测：全部通过');
})().catch((e) => { console.error(e); process.exit(1); });
