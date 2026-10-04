// 清风皮肤的浏览器实测（一次性验收脚本，非契约）。
// 用系统 Chrome 走 channel:'chrome'——本机没装 playwright 自带的 chromium。
//
// 为什么必须量真实布局：海报墙的「密排缝」、浮层的「顶出视口」、
// 胶囊的「被自动隐藏甩下去」这三类问题，Node 正则里和「正常」长得一模一样，
// 只有真渲染出来才看得出。

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.QF_BASE || 'http://127.0.0.1:7891';
// 跨平台路径：Windows 上 '/tmp' 不是 temp 目录（Node 会解析成盘符根下的 \tmp），
// 而 Git Bash 的 /tmp 指向 %LOCALAPPDATA%\Temp。先按环境变量取，
// 否则 Windows 走 os.tmpdir()，POSIX 才认字面量 /tmp。
const DATA_DIR = process.env.QF_DATA_DIR
  || (process.platform === 'win32' ? path.join(os.tmpdir(), 'qf-data2') : '/tmp/qf-data2');
const TOKEN = fs.readFileSync(path.join(DATA_DIR, 'token'), 'utf8').trim();
const OUT = process.env.QF_OUT || path.resolve(__dirname, '..', 'output', 'qingfeng-verify');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ok  ' + label + (extra ? '  (' + extra + ')' : ''));
  else { failures += 1; console.error('  X   ' + label + (extra ? '  (' + extra + ')' : '')); }
};
const section = (n) => console.log('\n' + n);
const { clickPoster } = require('./qf-wall-helpers.js');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  // 401 是既有正常行为：online-login.js 的 loadAccounts() 对每个源并发探测
  // 账号态，「未登录/失败一律按未登录」，catch 里已吞掉、不弹错。
  // 浏览器仍会把 network 401 记成 console error —— 那不是 JS 报错。
  // 只收真正的脚本异常（pageerror）与非 401 的 console error。
  const isExpected401 = (t) => /status of 401/.test(t);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !isExpected401(m.text())) errors.push(m.text());
  });

  const url = `${BASE}/?token=${TOKEN}`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  section('启动：默认皮肤与无报错');
  const bootSkin = await page.getAttribute('html', 'data-skin');
  ok(bootSkin === 'classic' || bootSkin === null, `启动落在默认皮肤（${bootSkin}）`);
  ok(errors.length === 0, '启动无 JS 报错', errors.slice(0, 2).join(' | '));

  section('切到清风');
  await page.evaluate(() => window.Skins.apply('qingfeng'));
  await page.waitForTimeout(600);
  ok(await page.getAttribute('html', 'data-skin') === 'qingfeng', 'data-skin 写成 qingfeng');
  ok(await page.evaluate(() => window.__qfSkin.isMounted()), '重编排层已挂载');
  // 只有目标那份 CSS 生效
  const sheetState = await page.evaluate(() =>
    Array.from(document.querySelectorAll('link[data-skin-css],style[data-skin-css]'))
      .map((n) => [n.getAttribute('data-skin-css'), n.disabled]));
  ok(sheetState.filter(([, dis]) => dis === false).length === 1
    && sheetState.find(([id, dis]) => dis === false)[0] === 'qingfeng',
    '只有 qingfeng 那份 CSS 启用', JSON.stringify(sheetState));

  section('首页骨架');
  const nav = await page.$$eval('.qf-nav-item', (ns) => ns.map((n) => n.textContent.trim()));
  ok(JSON.stringify(nav) === JSON.stringify(['歌单', '电台', '专辑', '收藏', '本地']),
    '主菜单依次为 歌单/电台/专辑/收藏/本地', nav.join(','));
  ok(await page.$('.qf-nav-icon') !== null, '队列拼接入口图标在菜单里');
  // 图标入口默认收起文字
  const iconLabelW = await page.$eval('.qf-nav-icon span', (n) => n.getBoundingClientRect().width);
  ok(iconLabelW < 2, '队列拼接入口文字默认收起', `w=${iconLabelW.toFixed(1)}`);
  ok(await page.$('.qf-settings-btn') !== null, '左上角设置按钮存在');
  ok(await page.$('.qf-account-arrow') !== null, '右下角箭头按钮存在');
  // 头像搬的是业务那颗登录按钮（带 id，不是假壳子）
  const acct = await page.$eval('.qf-account', (n) => n.querySelector('#online-account-btn') !== null);
  ok(acct, '右下角搬的是业务登录按钮本体');
  // 播放胶囊在底部居中
  const bar = await page.$eval('.bar', (n) => {
    const r = n.getBoundingClientRect();
    return { cx: r.left + r.width / 2, bottom: window.innerHeight - r.bottom, w: r.width, vw: window.innerWidth };
  });
  ok(Math.abs(bar.cx - bar.vw / 2) < 40, '播放胶囊水平居中', `cx=${bar.cx.toFixed(0)} vw/2=${(bar.vw / 2).toFixed(0)}`);
  ok(bar.w <= bar.vw * 0.62, '播放胶囊宽度受限（不是全宽条）', `w=${bar.w.toFixed(0)}`);

  // 胶囊内五块（曲名/控制/进度/模式/音量）不许互相压扁。
  // flex 收缩是无声的：560px 宽时进度条塌成 27px、音量滑块挤成一条线，
  // DOM 完好、页面不报错，只是挤成一团 —— 只有量真实宽度看得出。
  const barIn = await page.$eval('.bar', (n) => {
    const kids = Array.from(n.children)
      .filter((c) => getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().width > 0)
      .map((c) => {
        const r = c.getBoundingClientRect();
        return { cls: c.className || c.id, l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) };
      });
    const overlaps = [];
    for (let i = 0; i < kids.length; i += 1) {
      for (let j = i + 1; j < kids.length; j += 1) {
        if (kids[i].r > kids[j].l && kids[i].l < kids[j].r) {
          overlaps.push(`${kids[i].cls} ✕ ${kids[j].cls}`);
        }
      }
    }
    const prog = kids.find((k) => /bar-progress/.test(k.cls));
    const vol = document.querySelector('#volume');
    return { kids, overlaps, progW: prog ? prog.w : 0, volW: vol ? Math.round(vol.getBoundingClientRect().width) : 0 };
  });
  ok(barIn.overlaps.length === 0, '胶囊内各块不重叠', barIn.overlaps.join(' | ') || `${barIn.kids.length} 块`);
  ok(barIn.progW >= 110, '进度条没被 flex 压扁', `w=${barIn.progW}px`);
  ok(barIn.volW >= 60, '音量滑块没被压扁', `w=${barIn.volW}px`);
  // 胶囊是 fixed，必须真的脱离栅格：否则 left/bottom 整份被忽略，
  // 只剩 translateX(-50%) 生效，胶囊会被左移半个身位。
  ok(await page.$eval('.bar', (n) => getComputedStyle(n).position === 'fixed'),
    '播放胶囊脱离栅格（position: fixed）');
  // 顶部让位：量「内容起点」而不是 .column 的 border-box 顶 ——
  // 让位是靠 .column 的 padding-top 做的，盒子顶本来就在胶囊之下，
  // 拿盒子顶去比会假红。
  const clear = await page.evaluate(() => {
    const navEl = document.querySelector('.qf-nav');
    const col = document.querySelector('.column');
    const view = col.querySelector('.view:not([hidden])');
    const padTop = parseFloat(getComputedStyle(col).paddingTop) || 0;
    return {
      navBottom: navEl.getBoundingClientRect().bottom,
      colTop: col.getBoundingClientRect().top,
      padTop,
      viewTop: view ? view.getBoundingClientRect().top : null,
    };
  });
  ok(clear.viewTop !== null && clear.viewTop >= clear.navBottom - 2,
    '内容起点已为悬浮菜单让位',
    `viewTop=${clear.viewTop && clear.viewTop.toFixed(0)} navBottom=${clear.navBottom.toFixed(0)}`
    + ` (colTop=${clear.colTop.toFixed(0)} + pad ${clear.padTop})`);

  section('侧栏已隐藏、原节点保留');
  const rail = await page.$eval('.rail', (n) => {
    const cs = getComputedStyle(n);
    return {
      display: cs.display,
      inDom: document.contains(n),
      // 6 个业务视图 + 「设置」共 7 项。断言写成 6 会在业务加一项时假红，
      // 所以这里只钉「项数与挂载前一致」，真值从 rail 自己读。
      items: n.querySelectorAll('.rail-item').length,
    };
  });
  ok(rail.display === 'none', '左侧 rail 隐藏');
  ok(rail.inDom && rail.items >= 7, 'rail 节点保留（程序化点击仍可用）', `${rail.items} 项`);

  await page.screenshot({ path: path.join(OUT, '01-home.png') });

  section('歌单页');
  await page.click('.qf-nav-item[data-qf-view="playlists"]');
  await page.waitForTimeout(700);
  ok(await page.$eval('#view-playlists', (n) => !n.hidden), '切到了歌单视图');
  ok(await page.$eval('.qf-nav-item[data-qf-view="playlists"]', (n) => n.classList.contains('is-active')),
    '歌单在主菜单里高亮');
  await page.screenshot({ path: path.join(OUT, '02-playlists.png') });

  section('队列拼接（海报墙）');
  // **切到在线曲库再开墙**：这一段验的是「点一张**曲** → 展开成大卡 + 播放控件」。
  // 墙上放什么由当前 tab 决定（队列拼接是每个 tab 都有的），所以场景必须挑对 ——
  // 停在歌单视图时墙上是一张张**歌单**，点开是进第二层而不是展开，
  // 拿展开卡的断言去测它必然全红，而且红得毫无意义。
  // 在线曲库有真实曲目，是唯一能验「展开 + 控件」的来源。
  await page.click('.qf-nav-item[data-qf-view="online"]');
  await page.waitForTimeout(700);
  await page.click('.qf-nav-icon');
  await page.waitForTimeout(900);
  const wall = await page.evaluate(() => {
    const root = document.querySelector('.qf-lattice');
    return {
      open: !!root && !root.hidden,
      mounted: window.__qfSkin.isWallOpen(),
      posters: document.querySelectorAll('.qf-poster').length,
      emptyShown: root ? !root.querySelector('.qf-lattice-empty').hidden : null,
      bodyLocked: document.body.classList.contains('qf-lattice-open'),
    };
  });
  ok(wall.open && wall.mounted, '海报墙已打开');
  ok(wall.bodyLocked, 'body 标记已打（供 CSS 隔离底层）');
  // 队列为空时走空态；非空时必须有海报
  ok(wall.emptyShown ? wall.posters === 0 : wall.posters > 0,
    '队列空→显空态；非空→渲染海报', `posters=${wall.posters} empty=${wall.emptyShown}`);

  if (wall.posters > 0) {
    // 密排：相邻卡片的间距应等于 CSS 的 GAP（8px × 相机缩放），
    // 出现背景色的缝说明 JS 的 CELL/GAP 与 CSS 不一致。
    const gapInfo = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('.qf-poster'))
        .map((n) => n.getBoundingClientRect())
        .filter((r) => r.width > 40)
        .sort((a, b) => a.top - b.top || a.left - b.left);
      if (cells.length < 2) return null;
      // 取同一行内相邻两张的水平间距
      let best = null;
      for (let i = 1; i < cells.length; i += 1) {
        const a = cells[i - 1]; const b = cells[i];
        if (Math.abs(a.top - b.top) < 4 && b.left > a.left) {
          const d = b.left - (a.left + a.width);
          if (d >= -1 && d < 40 && (best === null || d < best)) best = d;
        }
      }
      return best === null ? { gap: null } : { gap: +best.toFixed(1) };
    });
    ok(gapInfo && gapInfo.gap !== null && gapInfo.gap >= 0 && gapInfo.gap < 14,
      '密排缝隙正常（无背景色漏缝）', `gap=${gapInfo && gapInfo.gap}px`);
    // 卡片必须是方角（这套视觉的识别特征）
    const radius = await page.$eval('.qf-poster', (n) => getComputedStyle(n).borderTopLeftRadius);
    ok(parseFloat(radius) === 0, '海报保持方角', `radius=${radius}`);

    // 开墙后「聚焦的那张」必须落在视口内。
    //
    // 这条是本轮修的一个真实回归的钉子：无「正在播放」时开墙退到第一张，
    // 而密排下第一张的格位完全可能在视口外 —— 页面上表现为一片空白，
    // 不报任何错。下面两处点击都改成点 is-focused，正是靠这条断言保证
    // 它们点在视口内那张（直接点 .qf-poster 会解析到视口外那张而超时）。
    const focusInView = await page.evaluate(() => {
      const f = document.querySelector('.qf-poster.is-focused');
      if (!f) return { has: false };
      const r = f.getBoundingClientRect();
      return {
        has: true,
        inView: r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight,
        rect: [Math.round(r.left), Math.round(r.top)],
      };
    });
    ok(focusInView.has && focusInView.inView,
      '开墙后聚焦的那张在视口内（否则用户看到一片空白）', JSON.stringify(focusInView));

    // 点一张展开（见 clickPoster 的注释：不能用 page.click，滚动会改相机坐标）
    await clickPoster(page, '.qf-poster.is-focused');
    await page.waitForTimeout(700);
    const exp = await page.evaluate(() => {
      const e = document.querySelector('.qf-poster.is-expanded');
      return e ? {
        found: true,
        hasControls: !!e.querySelector('.qf-poster-controls'),
        hasChrome: !!e.querySelector('.qf-chrome'),
        w: e.getBoundingClientRect().width,
        inView: e.getBoundingClientRect().left > -50
          && e.getBoundingClientRect().right < window.innerWidth + 50,
      } : { found: false };
    });
    ok(exp.found, '点海报展开成大卡');
    ok(exp.hasControls && exp.hasChrome, '展开卡带播放控件');
    ok(exp.w > 260, '展开卡显著大于普通格', `w=${exp.w && exp.w.toFixed(0)}`);
    ok(exp.inView, '相机把展开卡带进视口');
    await page.screenshot({ path: path.join(OUT, '03-lattice-expanded.png') });

    // 墙内播放控件存在且可点
    ok(await page.$('.qf-chrome-play') !== null, '展开卡有播放键');
    // 关灯
    const lights = await page.$$('.qf-tools-btn');
    ok(lights.length >= 3, '右下角有工具按钮组', `${lights.length} 个`);
    await page.click('.qf-tools-btn.is-on, .qf-tools-btn >> nth=0');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, '04-lattice-lights.png') });

    // 键盘：Esc 退出
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    ok(await page.evaluate(() => !window.__qfSkin.isWallOpen()), 'Esc 退出海报墙');
    ok(await page.evaluate(() => !document.body.classList.contains('qf-lattice-open')),
      '退出后 body 标记已摘');
  } else {
    await page.screenshot({ path: path.join(OUT, '03-lattice-empty.png') });
    // 空态下也走一遍开关与退出
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => !window.__qfSkin.isWallOpen()), '空态下 Esc 也能退出');
  }

  // -------------------------------------------------------------------
  // 墙是**每个 tab 都有的**，展示那个 tab 的内容（不是只有播放队列有）。
  //
  // 这段是本需求的核心，所以必须**逐个 tab 走过去**看墙上的来源标签与项数，
  // 只验「墙能打开」等于没验 —— 打开是旧行为早就有的。
  //
  // 数据侧不伪造：直接读各视图**此刻真实持有的**数据（曲库/在线/收藏/歌单
  // 都是本地或登录态下已有的），再断言墙上的项数与之一致。
  // 一致不了就是取源接错了，页面上看不出来。
  // -------------------------------------------------------------------
  section('每个 tab 的墙取到自己的内容');

  // 逐个 tab：切过去 → 开墙 → 读来源标签 + 海报数。
  // 用 qf:panel 直接问 app.js「这个 tab 的源有几项」，与墙上渲染出的海报数比对。
  const TABS = [
    { view: 'playlists', key: 'playlists', label: '歌单' },
    { view: 'online', key: 'online', label: '在线曲库' },
    { view: 'library', key: 'library', label: '本地曲库' },
    { view: 'favorites', key: 'favorites', label: '我的收藏' },
    { view: 'queue', key: 'queue', label: '播放队列' },
  ];

  // 入口按钮在每个 tab 下应有的文案，与 skin.qingfeng.js 的 WALL_TAB_LABELS 对齐。
  // 写成期望表而不是「不等于队列拼接」：播放队列 tab 本来就叫这个名字。
  const EXPECT_BTN_TEXT = {
    playlists: '歌单墙',
    online: '电台拼接',
    library: '曲库拼接',
    favorites: '收藏墙',
    queue: '队列拼接',
  };

  const perTab = [];
  for (const tab of TABS) {
    // 切到这个 tab（走 rail 的程序化点击，与用户点导航同一条链路）
    await page.evaluate((v) => {
      const item = document.querySelector('.rail-item[data-view="' + v + '"]');
      if (item) item.click();
    }, tab.view);
    await page.waitForTimeout(450);

    // 开墙
    await page.evaluate(() => {
      const btn = document.querySelector('.qf-nav-icon');
      if (btn && !window.__qfSkin.isWallOpen()) btn.click();
    });
    await page.waitForTimeout(650);

    const got = await page.evaluate(() => {
      const root = document.querySelector('.qf-lattice');
      const tag = root ? root.querySelector('.qf-lattice-tag') : null;
      return {
        open: window.__qfSkin.isWallOpen(),
        tagHidden: tag ? tag.hidden : null,
        label: tag ? (tag.querySelector('strong') || {}).textContent : '',
        count: tag ? (tag.querySelector('span') || {}).textContent : '',
        posters: document.querySelectorAll('.qf-poster').length,
        emptyShown: root ? !root.querySelector('.qf-lattice-empty').hidden : null,
        // 墙内部态：这一列真正有几项。**不数 DOM 海报** —— 那是虚拟化后的
        // 裁剪结果（只渲染视口 + OVERSCAN 内的），与源里的项数本就不等。
        info: window.__qfSkin.wallInfo(),
        btnText: (document.querySelector('.qf-nav-icon-text') || {}).textContent || '',
      };
    });

    // 问 app.js 这个 tab 的源里有几项（与墙上应当一致）
    const src = await page.evaluate(() => {
      const d = { action: 'source-request' };
      document.dispatchEvent(new CustomEvent('qf:panel', { detail: d }));
      return d.source;
    });

    perTab.push({ tab, got, src });
    ok(got.open, `${tab.label} tab 的墙能打开`);
    ok(got.tagHidden === false, `${tab.label} 的墙标明来源`, `label="${got.label}"`);
    ok(got.label === src.label,
      `${tab.label} 的墙上来源名与 app.js 给的一致`, `墙="${got.label}" app="${src.label}"`);
    // 入口文案要跟着 tab 变，但**不能一律断言「不等于队列拼接」** ——
    // 播放队列 tab 的入口本来就叫「队列拼接」，那样判会把它自己判红。
    // 判据改成「与该tab 应有的文案一致」，逐个给期望值。
    ok(got.btnText === EXPECT_BTN_TEXT[tab.key],
      `${tab.label} 的入口按钮文案跟着 tab 变`, `期望="${EXPECT_BTN_TEXT[tab.key]}" 实得="${got.btnText}"`);
    // **核心断言**：墙内部态的来源 key 与项数，必须与 app.js 给的那份一致。
    // 标签对了但内容是别的 tab 的，就是取源接错了 —— 只看标签抓不到这个。
    ok(got.info.sourceKey === src.key && got.info.count === src.items.length,
      `${tab.label} 的墙内容与该视图一致`,
      `key 墙=${got.info.sourceKey} app=${src.key} / 项数 墙=${got.info.count} app=${src.items.length}`);

    // 关墙
    await page.evaluate(() => {
      const btn = document.querySelector('.qf-nav-icon');
      if (btn && window.__qfSkin.isWallOpen()) btn.click();
    });
    await page.waitForTimeout(350);
  }

  // 留两张带来源标签的墙：第一层（歌单）与队列那列，
  // 便于肉眼确认「墙上标的来源跟当前 tab 一致」这件事。
  for (const [view, name] of [['playlists', '10-wall-source-playlists'], ['queue', '11-wall-source-queue']]) {
    await page.evaluate((v) => {
      const i = document.querySelector('.rail-item[data-view="' + v + '"]');
      if (i) i.click();
    }, view);
    await page.waitForTimeout(450);
    await page.evaluate(() => {
      const b = document.querySelector('.qf-nav-icon');
      if (b && !window.__qfSkin.isWallOpen()) b.click();
    });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
  }

  // 六个 tab 的来源名互不相同 —— 全返回同一个名字就等于没按 tab 取源。
  const labels = perTab.map((x) => x.src.label);
  ok(new Set(labels).size === labels.length,
    '各 tab 的来源名互不相同（真的在按 tab 取源）', labels.join(' / '));

  // 除播放队列外的五个 tab，入口文案都必须与队列不同 ——
  // 固定叫「队列拼接」会让人以为在所有 tab 下看的都是播放队列。
  // 播放队列自己那个 tab 反而**应该**叫「队列拼接」，所以它不在这条里。
  const nonQueue = perTab.filter((x) => x.tab.key !== 'queue');
  ok(nonQueue.every((x) => x.got.btnText && x.got.btnText !== '队列拼接'),
    '非队列 tab 的入口文案都不叫「队列拼接」',
    nonQueue.map((x) => `${x.tab.key}=${x.got.btnText}`).join(' / '));
  const queueTab = perTab.find((x) => x.tab.key === 'queue');
  ok(queueTab && queueTab.got.btnText === '队列拼接',
    '播放队列 tab 的入口就叫「队列拼接」', queueTab && queueTab.got.btnText);

  // 歌单那一列必须是 playlist 类：点开进第二层，不是直接播。
  const plTab = perTab.find((x) => x.tab.key === 'playlists');
  if (plTab && plTab.src.items.length) {
    await page.evaluate(() => {
      const item = document.querySelector('.rail-item[data-view="playlists"]');
      if (item) item.click();
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const btn = document.querySelector('.qf-nav-icon');
      if (btn && !window.__qfSkin.isWallOpen()) btn.click();
    });
    await page.waitForTimeout(650);
    // 点聚焦的那张（歌单海报），走clickPoster 而不是 page.click ——
    // 后者会滚动 field 容器，相机随之偏移，事件落到 .qf-lattice-field 上，
    // 点开了个寂寞还不报错（实测栽在这）。
    await clickPoster(page, '.qf-poster.is-focused');
    await page.waitForTimeout(1200);
    const drill = await page.evaluate(() => {
      const tag = document.querySelector('.qf-lattice-tag');
      const back = tag ? tag.querySelector('.qf-lattice-back') : null;
      return {
        hasBack: !!(back && !back.hidden),
        openBtn: !!document.querySelector('.qf-chrome-play.is-labelled'),
        info: window.__qfSkin.wallInfo(),
      };
    });
ok(drill.hasBack, '歌单点开后进了第二层（左上角出现返回键）');
  ok(!!drill.info.drill, '墙的运行态确认进了第二层', JSON.stringify(drill.info.drill));
  // 第二层的项不该再带 isPlaylist —— 否则点开又进第三层。
  // 判据是「第二层的展开卡上没有『打开歌单』按钮」：那个按钮只给歌单项。
  ok(!drill.openBtn,
    '第二层里没有「打开歌单」按钮（那是第一层才有的，否则会进第三层）');
  await page.screenshot({ path: path.join(OUT, '03-lattice-drill.png') });
    // Esc 分层退：先退回歌单列表，墙还开着
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const afterEsc = await page.evaluate(() => ({
      stillOpen: window.__qfSkin.isWallOpen(),
      hasBack: !!document.querySelector('.qf-lattice-back:not([hidden])'),
    }));
    ok(afterEsc.stillOpen && !afterEsc.hasBack,
      '第二层按 Esc 退回歌单列表而不是直接关墙', JSON.stringify(afterEsc));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  // 墙开着切 tab：换源，不关墙。
  await page.evaluate(() => {
    const item = document.querySelector('.rail-item[data-view="library"]');
    if (item) item.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const btn = document.querySelector('.qf-nav-icon');
    if (btn && !window.__qfSkin.isWallOpen()) btn.click();
  });
  await page.waitForTimeout(600);
  const beforeSwitch = await page.evaluate(() => ({
    open: window.__qfSkin.isWallOpen(),
    info: window.__qfSkin.wallInfo(),
  }));
  await page.evaluate(() => {
    const item = document.querySelector('.rail-item[data-view="favorites"]');
    if (item) item.click();
  });
  await page.waitForTimeout(800);
  const afterSwitch = await page.evaluate(() => ({
    open: window.__qfSkin.isWallOpen(),
    info: window.__qfSkin.wallInfo(),
  }));
  ok(beforeSwitch.open && afterSwitch.open,
    '墙开着切 tab 时不关掉（每个 tab 都能用队列拼接）',
    `${beforeSwitch.info.label} → ${afterSwitch.info.label}`);
  // 换源的关键判据：sourceKey 必须真的变了。只比 label 不够 ——
  // 两个来源碰巧同名（比如以后两个 tab 都叫「精选」）就会误判成没换。
  ok(afterSwitch.info.sourceKey === 'favorites' && beforeSwitch.info.sourceKey === 'library',
    '切 tab 后墙的来源真的换了',
    `${beforeSwitch.info.sourceKey} → ${afterSwitch.info.sourceKey}`);
  ok(!afterSwitch.info.drill, '切 tab 后不在第二层（上一 tab 的歌单不串味）');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  section('设置浮层');
  await page.click('.qf-settings-btn');
  await page.waitForTimeout(700);
  const sheet = await page.evaluate(() => {
    const root = document.querySelector('.qf-modal');
    if (!root) return { found: false };
    const card = root.querySelector('.qf-modal-card');
    const nav = root.querySelector('.qf-set-nav');
    const pane = root.querySelector('.qf-set-pane');
    const r = card.getBoundingClientRect();
    return {
      found: true,
      open: !root.hidden,
      z: Number(getComputedStyle(root).zIndex),
      navLinks: nav ? nav.querySelectorAll('.qf-set-link').length : 0,
      hasPane: !!pane,
      // 设置视图本体被搬进来了
      settingsInSheet: !!pane && !!pane.querySelector('#view-settings'),
      settingsNotHidden: !!pane && !pane.querySelector('#view-settings').hidden,
      fitsViewport: r.height <= window.innerHeight + 2 && r.top >= -2,
      navScrolls: nav ? getComputedStyle(nav).overflowY : null,
      navHasMinH0: nav ? getComputedStyle(nav).minHeight : null,
      groupsVisible: pane ? pane.querySelectorAll('.set-group:not([hidden])').length : 0,
    };
  });
  ok(sheet.found && sheet.open, '设置浮层已打开');
  ok(sheet.z >= 200, `浮层层级够高（z=${sheet.z}）`);
  ok(sheet.navLinks > 0, '左栏有分类条目', `${sheet.navLinks} 条`);
  ok(sheet.settingsInSheet, '设置视图本体被搬进浮层右栏');
  ok(sheet.settingsNotHidden, '搬进来后没有被 hidden 藏掉');
  ok(sheet.fitsViewport, '浮层没有超出视口');
  ok(sheet.navScrolls === 'auto', '左栏自己裁切（不把浮层顶高）', `overflow-y=${sheet.navScrolls}`);
  ok(sheet.navHasMinH0 === '0px', '左栏 min-height:0', sheet.navHasMinH0);
  // 打开时也只该露出当前分类那一组。同样不能用 > 0 —— 「多了」正是这次的缺陷。
  ok(sheet.groupsVisible === 1, '右栏只有当前分类那一组可见', `${sheet.groupsVisible} 组`);

  // 分类切换
  if (sheet.navLinks > 1) {
    await page.click('.qf-set-link >> nth=1');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('.qf-set-pane .set-group')];
      const vis = groups.filter((g) => !g.hidden);
      return {
        active: document.querySelectorAll('.qf-set-link.is-active').length,
        visible: vis.length,
        // 目标组 = 右栏标题指的那一组（分组标题与左栏条目文案同源）
        titles: vis.map((g) => (g.querySelector('.set-title') || {}).textContent),
        headText: (document.querySelector('.qf-set-pane-head h2') || {}).textContent,
      };
    });
    ok(after.active === 1, '切分类后只有一个选中项', `${after.active} 个`);
    ok(after.visible > 0, '切分类后右栏有内容', `${after.visible} 组`);
    ok(!!after.headText, '右栏标题跟着换', after.headText);
    // 关键断言：切分类后**有且仅有**目标那一组可见。
    // 之前这里是 `visible > 0`，而 releaseGroups 写成了「全部 hidden = false」，
    // 结果 13 个分组一起显示 —— 断言全绿、页面不报错，左栏选中项与右栏标题
    // 也都是对的，只有内容是错的。> 0 这类下界断言对「多了」类缺陷完全无效。
    ok(after.visible === 1,
      '切分类后右栏只有目标那一组可见', `实际 ${after.visible} 组：${after.titles.join(' / ') || '无'}`);
  }
  await page.screenshot({ path: path.join(OUT, '05-settings.png') });

  // Esc 关闭
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  ok(await page.evaluate(() => {
    const m = document.querySelector('.qf-modal');
    return m && m.hidden;
  }), 'Esc 关闭设置浮层');
  ok(await page.evaluate(() => {
    const v = document.getElementById('view-settings');
    return !document.body.classList.contains('qf-modal-open') && v.hidden;
  }), '关闭后 body 标记已摘、设置视图收回隐藏（不留空白）');

  section('切走皮肤：必须干净还原');
  await page.evaluate(() => window.Skins.apply('classic'));
  await page.waitForTimeout(700);
  const restored = await page.evaluate(() => ({
    mounted: window.__qfSkin.isMounted(),
    nav: document.querySelectorAll('.qf-nav').length,
    modal: document.querySelectorAll('.qf-modal').length,
    lattice: document.querySelectorAll('.qf-lattice').length,
    account: document.querySelectorAll('.qf-account').length,
    settingsBtn: document.querySelectorAll('.qf-settings-btn').length,
    anchors: document.querySelectorAll('.qf-anchor').length,
    settingsInColumn: document.getElementById('column')
      .contains(document.getElementById('view-settings')),
    settingsHidden: document.getElementById('view-settings').hidden,
    // 全部设置分组都要恢复可见（漏一个 = 换回别的皮肤后「设置里少了几项」）
    groupsHidden: Array.from(document.querySelectorAll('#view-settings .set-group'))
      .filter((g) => g.hidden).length,
    accountInTopbar: document.querySelector('.topbar')
      .contains(document.getElementById('online-account-btn')),
  }));
  ok(!restored.mounted, '重编排层已卸载');
  ok(restored.nav === 0 && restored.modal === 0 && restored.lattice === 0
    && restored.account === 0 && restored.settingsBtn === 0, '自建节点全部拆除');
  ok(restored.anchors === 0, '锚点全部清理（没有残留空 span）');
  ok(restored.settingsInColumn, '设置视图已搬回中栏原位');
  ok(restored.groupsHidden === 0, '全部设置分组恢复可见',
    `${restored.groupsHidden} 组仍是 hidden`);
  ok(restored.accountInTopbar, '登录按钮已搬回顶栏原位');
  // rail 恢复可见
  ok(await page.$eval('.rail', (n) => getComputedStyle(n).display !== 'none'),
    '左侧 rail 恢复可见');
  await page.screenshot({ path: path.join(OUT, '06-restored-classic.png') });

  section('与其他皮肤并存');
  for (const id of ['sheen', 'workbench', 'liunian', 'ios', 'qingfeng']) {
    await page.evaluate((s) => window.Skins.apply(s), id);
    await page.waitForTimeout(350);
    const st = await page.evaluate(() => {
      const enabled = Array.from(document.querySelectorAll('link[data-skin-css],style[data-skin-css]'))
        .filter((n) => n.disabled === false).map((n) => n.getAttribute('data-skin-css'));
      return { skin: document.documentElement.getAttribute('data-skin'), enabled };
    });
    ok(st.skin === id && st.enabled.length === 1 && st.enabled[0] === id,
      `${id}: 只有自己那一份 CSS 生效`, st.enabled.join(','));
  }

  section('运行期无报错');
  const realErrors = errors.filter((e) => !/favicon|ERR_ABORTED/i.test(e));
  ok(realErrors.length === 0, '全流程无 JS 报错', realErrors.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n' + '─'.repeat(60));
  console.log(`截图目录：${OUT}`);
  if (failures) {
    console.error(`清风浏览器实测：${failures} 项失败`);
    process.exit(1);
  }
  console.log('清风浏览器实测：全部通过');
})().catch((e) => { console.error(e); process.exit(1); });
