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
      });
    }
    window.__qfProbeQueue = fake;
    // 拦截 requestQueue 的数据源：把 emit 的 detail 换成假数据。
    // 必须用冒泡阶段且在 app.js 之后注册 —— app.js 的监听器也会写
    // detail.queue（真实快照），谁后跑谁赢。捕获阶段会排在它前面，
    // 结果是被它覆盖掉，注入白做。
    document.addEventListener('qf:panel', (e) => {
      if (e.detail && e.detail.action === 'queue-request') e.detail.queue = window.__qfProbeQueue;
    });
    return fake.length;
  });
  console.log(`注入队列：${injected} 项\n`);

  console.log('打开海报墙');
  await page.click('.qf-nav-icon');
  await page.waitForTimeout(1200);

  const wall = await page.evaluate(() => ({
    posters: document.querySelectorAll('.qf-poster').length,
    count: window.__qfSkin.posterCount(),
    empty: !!document.querySelector('.qf-lattice-empty:not([hidden])'),
  }));
  ok(wall.posters > 0 && !wall.empty, '渲染出海报', `posters=${wall.posters} count=${wall.count}`);

  // 密排：相邻卡片的缝隙应等于 GAP×相机缩放（0~16px）。
  // 两个坑：
  //  1) 模板块是**大小混排**（folia-major 同构：3×2 / 6×4 / 1×8 都有），
  //     所以相邻两张可能属于不同块、中间隔着整块。必须按 data-qf-key 分组，
  //     只在同块内量，否则量到的是「块间距」几百上千 px。
  //  2) 卡片尺寸由 JS 内联（world 是 absolute + 无尺寸，自身 rect 恒为 0），
  //     所以「墙面尺寸」只能按海报的并集量，不能量 world。
  const wall2 = await page.evaluate(() => {
    const ps = Array.from(document.querySelectorAll('.qf-poster'));
    const byBlock = new Map();
    for (const n of ps) {
      const key = (n.dataset.qfKey || '').split(':').slice(0, 2).join(':');
      if (!byBlock.has(key)) byBlock.set(key, []);
      byBlock.get(key).push(n.getBoundingClientRect());
    }
    const gaps = [];
    for (const rects of byBlock.values()) {
      rects.sort((a, b) => a.top - b.top || a.left - b.left);
      for (let i = 1; i < rects.length; i += 1) {
        const a = rects[i - 1]; const b = rects[i];
        if (Math.abs(a.top - b.top) < 4 && b.left > a.left) {
          gaps.push(b.left - (a.left + a.width));
        }
      }
    }
    const all = ps.map((n) => n.getBoundingClientRect());
    const minL = Math.min(...all.map((r) => r.left));
    const maxR = Math.max(...all.map((r) => r.right));
    const minT = Math.min(...all.map((r) => r.top));
    const maxB = Math.max(...all.map((r) => r.bottom));
    const cam = getComputedStyle(document.querySelector('.qf-lattice-world')).transform;
    return {
      gaps: gaps.length ? { min: +Math.min(...gaps).toFixed(1), max: +Math.max(...gaps).toFixed(1), n: gaps.length } : null,
      blocks: byBlock.size,
      span: { w: Math.round(maxR - minL), h: Math.round(maxB - minT) },
      visible: ps.filter((n) => {
        const r = n.getBoundingClientRect();
        return r.right > 0 && r.left < window.innerWidth && r.bottom > 0 && r.top < window.innerHeight;
      }).length,
      cam,
    };
  });
  ok(wall2.gaps && wall2.gaps.min >= 0 && wall2.gaps.max < 16,
    '块内密排缝隙正常（无背景色漏缝）',
    wall2.gaps ? `${wall2.gaps.n} 条缝，${wall2.gaps.min}~${wall2.gaps.max}px（${wall2.blocks} 块）` : 'no rows');
  // 墙要铺满视口：渲染实例里必须有相当一部分落在屏幕内（其余是 overscan 缓冲）
  ok(wall2.visible >= 8, '墙铺满视口', `${wall2.visible} 张可见 / 跨度 ${wall2.span.w}×${wall2.span.h}`);
  ok(wall2.span.w > 1440, '墙在宽度方向溢出（可循环平移）', `span.w=${wall2.span.w}`);

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
  // 点「视口内最大的一张」：墙开了相机偏移后，第 N 张 DOM 节点完全可能在
  // 屏幕外（DOM 顺序 ≠ 视觉顺序），按 nth 点会 timeout。
  const target = await page.evaluate(() => {
    const inView = Array.from(document.querySelectorAll('.qf-poster'))
      .filter((n) => {
        const r = n.getBoundingClientRect();
        return r.left > 0 && r.top > 0 && r.right < window.innerWidth && r.bottom < window.innerHeight;
      })
      .sort((a, b) => {
        const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
        return (rb.width * rb.height) - (ra.width * ra.height);
      });
    return inView.length ? inView[0].dataset.qfKey : null;
  });
  ok(!!target, '视口内有可点的海报', `key=${target}`);
  await page.click(`.qf-poster[data-qf-key="${target}"]`);
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
  // 正在播放那张：createPoster 用 is-current（没有 is-playing 这个类）
  ok(exp.currentCount === 1, '有且只有一张打了「正在播放」标记', `${exp.currentCount} 张`);
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
  await page.waitForTimeout(600);
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
