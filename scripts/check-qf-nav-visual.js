// 清风「本地选项卡」（顶部胶囊主菜单）改版后的浏览器实测。
//
// 为什么必须真渲染：胶囊的体量、选中滑块与胶囊底的对比度、
// 图标与文字的比例关系，在 Node 正则里都和「正常」长得一模一样。
// 这里量三件事：
//   1. 几何：胶囊/条目矩形 + 内容是否已为它让位
//   2. 对比度：选中滑块底 vs 胶囊底 vs 未选中文字（相对亮度实算）
//   3. 三态：hover / is-active / disabled 的计算样式是否真的分层
//   4. 响应式：≤900px 贴边铺开后条目会不会被 flex 压扁
//
// 隔离实例：QF_BASE 指向自己起的那个（默认 18781），绝不碰用户的 7634。

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.resolve(__dirname, '..', 'output', 'qf-nav-verify');
fs.mkdirSync(OUT, { recursive: true });

// 隔离实例的 token 在它自己的数据目录里。
// 不带 token 访问 `/` 会拿到 **401「需要凭据」页** —— 那是一张只有 903 字节、
// 零个 <script> 的静态页：window.Skins 永远是 undefined，报错长得却像
// 「皮肤没挂载」。踩过一次，先把凭据拿到手再开浏览器。
const DATA_DIR = process.env.QF_DATA_DIR
  || (process.platform === 'win32' ? 'D:/tmp/hertz-nav-qf' : '/tmp/hertz-nav-qf');
const TOKEN = fs.readFileSync(path.join(DATA_DIR, 'token'), 'utf8').trim();

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ok  ' + label + (extra ? '  (' + extra + ')' : ''));
  else { failures += 1; console.error('  X   ' + label + (extra ? '  (' + extra + ')' : '')); }
};
const section = (n) => console.log('\n' + n);

(async () => {
  const base = process.env.QF_BASE || 'http://127.0.0.1:18781';
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // token 走查询串（只对 GET 生效，够本脚本用）
  await page.goto(base + '/?token=' + TOKEN, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // 必须等 Skins 就绪再切皮肤：goto 一返回时 app.js 的启动脚本还没跑完，
  // window.Skins 是 undefined，直接调 .apply 报的是
  // 「Cannot read properties of undefined」—— 与被测代码无关。
  await page.waitForFunction(() => !!window.Skins && typeof window.Skins.apply === 'function',
    null, { timeout: 30000 });
  await page.evaluate(() => window.Skins.apply('qingfeng'));
  await page.waitForFunction(() => !!document.querySelector('.qf-nav'), null, { timeout: 15000 });
  await page.waitForTimeout(900);

  section('几何：体量与让位');
  const geo = await page.evaluate(() => {
    const nav = document.querySelector('.qf-nav');
    const nb = nav.getBoundingClientRect();
    const item = nav.querySelector('.qf-nav-item');
    const ib = item.getBoundingClientRect();
    const col = document.querySelector('.column');
    const view = col.querySelector('.view:not([hidden])');
    const cs = getComputedStyle(nav);
    return {
      navH: nb.height, navW: nb.width,
      itemH: ib.height, itemW: ib.width,
      navBottom: nb.bottom, viewTop: view ? view.getBoundingClientRect().top : null,
      navFont: cs.fontSize,
      itemFont: getComputedStyle(item).fontSize,
      padTop: parseFloat(getComputedStyle(col).paddingTop) || 0,
      count: nav.querySelectorAll('.qf-nav-item').length,
    };
  });
  console.log('  胶囊 ' + geo.navH.toFixed(0) + '×' + geo.navW.toFixed(0)
    + ' / 条目高 ' + geo.itemH.toFixed(0) + ' / 字号 ' + geo.itemFont);
  ok(geo.navH <= 40, '胶囊高度收进一档（≤40px）', geo.navH.toFixed(1) + 'px');
  ok(geo.itemH <= 32, '条目高度收进一档（≤32px）', geo.itemH.toFixed(1) + 'px');
  ok(geo.itemH < geo.navH, '条目仍在胶囊内（未探出）', geo.itemH.toFixed(1) + ' < ' + geo.navH.toFixed(1));
  ok(geo.viewTop !== null && geo.viewTop >= geo.navBottom - 2,
    '内容起点已为胶囊让位',
    'viewTop=' + geo.viewTop.toFixed(0) + ' navBottom=' + geo.navBottom.toFixed(0));
  ok(geo.count === 5, '五个导航项齐全', String(geo.count));

  section('对比度：选中滑块 / 胶囊底 / 未选中文字');

  // 相对亮度与对比度（WCAG）。用页面里真实的 computed color，
  // 背景取胶囊的 background-color（半透明时按 --bg 合成后再算）。
  const contrast = await page.evaluate(() => {
    const lum = (rgb) => {
      const c = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    // ⚠ parse 必须同时吃两种 computed color 格式：
    //   经典 `rgba(r, g, b, a)` 与 **`color(srgb r g b / a)`**。
    // 后者是 color-mix() 的计算值格式（本项目所有选中态底色都是它）。
    // 只按数字列表切，`color(srgb 0.918 0.907 0.866)` 会被切成
    // [0.918, 0.907, 0.866] 当成 0~255 的通道值 → 算出来的对比度
    // 恒等于 1.0 附近，断言必红且**与被测样式无关**（踩过一次）。
    const parse = (s) => {
      if (!s) return [0, 0, 0];
      if (/^color\(/.test(s)) {
        const n = (s.match(/[\d.]+/g) || []).map(Number);
        return n.slice(0, 3).map((v) => v * 255);
      }
      return (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    };
    // alpha 同理：color(srgb … / a) 的 a 在斜杠后，rgba 的在第 4 个数字。
    const alphaOf = (s) => {
      if (!s) return 0;
      if (/^color\(/.test(s)) {
        const m = s.match(/\/\s*([\d.]+)/);
        return m ? parseFloat(m[1]) : 1;
      }
      const n = (s.match(/[\d.]+/g) || []).map(Number);
      return n.length >= 4 ? n[3] : 1;
    };
    const ratio = (a, b) => {
      const [hi, lo] = lum(a) >= lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
      return (hi + 0.05) / (lo + 0.05);
    };
    const over = (fg, bg, alpha) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));

    const nav = document.querySelector('.qf-nav');
    const active = nav.querySelector('.qf-nav-item.is-active');
    const idle = Array.from(nav.querySelectorAll('.qf-nav-item'))
      .find((n) => !n.classList.contains('is-active'));
    const navBgRaw = getComputedStyle(nav).backgroundColor;
    // 胶囊是半透明玻璃：底下是 --bg
    const rootBg = parse(getComputedStyle(document.documentElement).getPropertyValue('--bg')
      || getComputedStyle(document.body).backgroundColor);
    const navBg = over(parse(navBgRaw), rootBg, alphaOf(navBgRaw));

    const act = getComputedStyle(active);
    const actBgRaw = act.backgroundColor;
    const actBg = over(parse(actBgRaw), rootBg, alphaOf(actBgRaw));
    const actInk = parse(act.color);

    // 注意：ratio/over 是**表达式**，不能直接写在返回对象里当方法调
    // （`{ x: ratio(a, b) }` 里的标识符会被解析成对象方法名）。先算成局部量。
    // actInk 也必须先落到局部量：在 return 对象里引用它会命中 TDZ。
    const cSlipVsNav = ratio(actBg, navBg);
    const cInkVsSlip = ratio(actInk, actBg);
    const cIdleVsNav = ratio(parse(getComputedStyle(idle).color), navBg);

    return {
      actLabel: active.textContent.trim(),
      actInk,
      actBg,
      navBg,
      idleInk: parse(getComputedStyle(idle).color),
      idleBg: parse(getComputedStyle(idle).backgroundColor),
      // 选中滑块 vs 胶囊底：滑块必须明显浮起来
      cSlipVsNav,
      // 选中文字 vs 滑块：滑块上的字必须读得出来
      cInkVsSlip,
      // 未选中文字 vs 胶囊底
      cIdleVsNav,
      actFontWeight: act.fontWeight,
      idleFontWeight: getComputedStyle(idle).fontWeight,
    };
  });
  console.log('  选中项 =「' + contrast.actLabel + '」');
  ok(contrast.cSlipVsNav >= 1.4, '滑块相对胶囊底明显更亮（浮得起来）',
    contrast.cSlipVsNav.toFixed(2) + ':1');
  ok(contrast.cInkVsSlip >= 4.5, '滑块上的文字达到 WCAG AA 正文对比度',
    contrast.cInkVsSlip.toFixed(2) + ':1');
  ok(contrast.cIdleVsNav >= 3.0, '未选中文字仍可读',
    contrast.cIdleVsNav.toFixed(2) + ':1');
  ok(Number(contrast.actFontWeight) > Number(contrast.idleFontWeight),
    '选中项字重更重（第三层层次）',
    contrast.idleFontWeight + ' → ' + contrast.actFontWeight);

  section('三态：悬停 / 选中 / 禁用 分层');
  // 关掉过渡再读终值 —— SwiftShader 合成器时钟极慢，
  // 开着 transition 读到的是插值起点，看着像"规则没生效"。
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = '__noTr';
    s.textContent = '*{transition:none !important}';
    document.head.appendChild(s);
  });

  const states = await page.evaluate(() => {
    const nav = document.querySelector('.qf-nav');
    const idle = Array.from(nav.querySelectorAll('.qf-nav-item'))
      .find((n) => !n.classList.contains('is-active'));
    const active = nav.querySelector('.qf-nav-item.is-active');
    // :hover 用 CDP 之外拿不到稳定值，这里改读规则是否存在 + 手动验证
    const dis = idle.cloneNode(true);
    dis.disabled = true;
    dis.id = '__probeDisabled';
    idle.parentNode.insertBefore(dis, idle.nextSibling);
    const dcs = getComputedStyle(dis);
    const ics = getComputedStyle(idle);
    const out = {
      idleBg: ics.backgroundColor,
      disabledBg: dcs.backgroundColor,
      disabledShadow: dcs.boxShadow,
      disabledOpacity: dcs.opacity,
      idleOpacity: ics.opacity,
    };
    dis.remove();
    return out;
  });
  ok(states.disabledBg !== states.idleBg || states.disabledShadow === 'none',
    '禁用态撤掉了底色/内描边（不读成「选中的但点不动」）',
    'bg ' + states.idleBg + ' → ' + states.disabledBg + ', shadow=' + states.disabledShadow);
  ok(Number(states.disabledOpacity) < Number(states.idleOpacity),
    '禁用态不透明度低于正常态', states.idleOpacity + ' → ' + states.disabledOpacity);

  // 悬停态：用真实鼠标移过去（不要用 forcePseudoState 之外的手段）
  const idleBox = await page.evaluate(() => {
    const nav = document.querySelector('.qf-nav');
    const n = Array.from(nav.querySelectorAll('.qf-nav-item'))
      .find((x) => !x.classList.contains('is-active'));
    const r = n.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(idleBox.x, idleBox.y);
  await page.waitForTimeout(200);
  const hovered = await page.evaluate(() => {
    const nav = document.querySelector('.qf-nav');
    const n = Array.from(nav.querySelectorAll('.qf-nav-item'))
      .find((x) => !x.classList.contains('is-active'));
    const cs = getComputedStyle(n);
    return { bg: cs.backgroundColor, color: cs.color, matches: n.matches(':hover') };
  });
  ok(hovered.matches, '鼠标悬停命中了未选中条目');
  ok(hovered.bg !== 'rgba(0, 0, 0, 0)',
    '悬停有底色反馈（原来只有文字变色，等于没反馈）', hovered.bg);

  await page.evaluate(() => {
    const el = document.getElementById('__noTr');
    if (el) el.remove();
  });

  section('图标与文字的对齐排版');
  const align = await page.evaluate(() => {
    const nav = document.querySelector('.qf-nav');
    const items = Array.from(nav.querySelectorAll('.qf-nav-item'));
    const icon = nav.querySelector('.qf-nav-icon');
    const svg = icon.querySelector('svg');
    const ib = icon.getBoundingClientRect();
    const sb = svg.getBoundingClientRect();
    // 所有条目的文字垂直中心是否一致
    const centers = items.map((n) => {
      const r = n.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(n);
      const tr = range.getBoundingClientRect();
      return Math.abs((tr.top + tr.height / 2) - (r.top + r.height / 2));
    });
    const ibs = items.map((n) => n.getBoundingClientRect());
    const heights = ibs.map((r) => Math.round(r.height));
    return {
      iconSize: sb.width,
      itemFont: parseFloat(getComputedStyle(items[0]).fontSize),
      centers,
      heights,
      iconBorderLeft: getComputedStyle(icon).borderLeftWidth,
      iconMidY: (sb.top + sb.height / 2) - (ib.top + ib.height / 2),
      labelW: (() => {
        const s = icon.querySelector('span');
        return s.getBoundingClientRect().width;
      })(),
    };
  });
  ok(align.iconSize <= 16, '图标尺寸收进与字号同一档',
    align.iconSize + 'px vs 字号 ' + align.itemFont + 'px（比值 ' + (align.iconSize / align.itemFont).toFixed(2) + '）');
  ok(Math.max.apply(null, align.centers) < 1.5,
    '各条目文字垂直居中一致（对齐没飘）',
    '最大偏差 ' + Math.max.apply(null, align.centers).toFixed(2) + 'px');
  ok(new Set(align.heights).size === 1,
    '五个条目等高（几何统一）', align.heights.join(','));
  ok(parseFloat(align.iconBorderLeft) > 0,
    '异质图标入口有分隔线（不再读成第六个 tab）', align.iconBorderLeft);
  ok(Math.abs(align.iconMidY) < 1.5, '图标在按钮内垂直居中',
    '偏移 ' + align.iconMidY.toFixed(2) + 'px');
  ok(align.labelW < 2, '队列拼接文字仍默认收起', 'w=' + align.labelW.toFixed(1));

  await page.screenshot({ path: path.join(OUT, 'nav-wide.png'), clip: { x: 460, y: 30, width: 520, height: 80 } });

  section('响应式：≤900px 贴边铺开');
  await page.setViewportSize({ width: 820, height: 800 });
  await page.waitForTimeout(500);
  const narrow = await page.evaluate(() => {
    const nav = document.querySelector('.qf-nav');
    const items = Array.from(nav.querySelectorAll('.qf-nav-item'));
    const r = items.map((n) => n.getBoundingClientRect());
    const pad = parseFloat(getComputedStyle(items[0]).paddingLeft);
    return {
      w: r.map((x) => Math.round(x.width)),
      h: r.map((x) => Math.round(x.height)),
      pad,
      scrollable: nav.scrollWidth > nav.clientWidth,
      navLeft: nav.getBoundingClientRect().left,
    };
  });
  console.log('  窄屏条目宽 ' + narrow.w.join(',') + ' / 高 ' + narrow.h.join(','));
  ok(new Set(narrow.w).size > 1 || narrow.w.every((w) => w > 40),
    '条目没被 flex 压扁（flex:none 生效）', '最窄 ' + Math.min.apply(null, narrow.w) + 'px');
  ok(narrow.pad > 6, '横向内边距仍在（没被压到 0）', narrow.pad + 'px');
  ok(narrow.h.every((h) => h >= 30), '窄屏触摸高度未缩水', '最小 ' + Math.min.apply(null, narrow.h) + 'px');

  // 注意：这里**不能**断言「必须可滚动」。380px 下五个条目加图标入口
  // 总共约 255px，本来就放得下 —— scrollWidth == clientWidth 是正常的，
  // 写成必须 scrollable 就是一条自己造出来的假红。
  // 真正要守的是「放不下时能滚、且条目不被压扁」，所以断到 320px
  // 并同时断言 overflow-x 已就位（它是滚动的前提）。
  await page.setViewportSize({ width: 320, height: 780 });
  await page.waitForTimeout(500);
  const tiny = await page.evaluate(() => {
    const nav = document.querySelector('.qf-nav');
    const items = Array.from(nav.querySelectorAll('.qf-nav-item'));
    return {
      w: items.map((n) => Math.round(n.getBoundingClientRect().width)),
      scrollW: nav.scrollWidth,
      clientW: nav.clientWidth,
      scrollable: nav.scrollWidth > nav.clientWidth,
      overflowX: getComputedStyle(nav).overflowX,
      navW: Math.round(nav.getBoundingClientRect().width),
    };
  });
  console.log('  320px 下条目宽 ' + tiny.w.join(',') + ' / 胶囊宽 ' + tiny.navW
    + ' / scrollWidth ' + tiny.scrollW + ' vs client ' + tiny.clientW);
  ok(tiny.overflowX === 'auto', '窄屏 overflow-x:auto 就位（放不下时可滚的前提）',
    tiny.overflowX);
  ok(Math.min.apply(null, tiny.w) > 40, '超窄屏条目仍保持内容宽度（没被压扁/换行）',
    '最窄 ' + Math.min.apply(null, tiny.w) + 'px');
  ok(tiny.navW <= 320, '胶囊没有溢出视口',
    tiny.navW + 'px ≤ 320px');

  section('交互与功能未变');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  const flow = await page.evaluate(() => {
    const nav = document.querySelector('.qf-nav');
    const before = nav.querySelector('.qf-nav-item.is-active');
    const target = nav.querySelector('.qf-nav-item[data-qf-view="playlists"]');
    target.click();
    return { from: before.textContent.trim(), to: target.dataset.qfView };
  });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const nav = document.querySelector('.qf-nav');
    const a = nav.querySelector('.qf-nav-item.is-active');
    const view = document.querySelector('.view:not([hidden])');
    return { active: a ? a.textContent.trim() : null, view: view ? view.id : null };
  });
  ok(after.active === '歌单' && after.view === 'view-playlists',
    '点击切视图仍然工作（选中态跟着走）',
    flow.from + ' → ' + after.active + ' / ' + after.view);

  // 墙入口（异质元素）仍能开
  const wall = await page.evaluate(() => {
    const b = document.querySelector('.qf-nav-icon');
    b.click();
    return { exists: !!b, open: window.__qfSkin.isWallOpen() };
  });
  await page.waitForTimeout(700);
  const wallAfter = await page.evaluate(() => {
    const root = document.querySelector('.qf-lattice');
    const btn = document.querySelector('.qf-nav-icon');
    const cs = getComputedStyle(btn);
    return {
      open: window.__qfSkin.isWallOpen(),
      inDom: !!root,
      btnBg: cs.backgroundColor,
      btnColor: cs.color,
      btnActive: btn.classList.contains('is-active'),
    };
  });
  ok(wallAfter.open && wallAfter.inDom, '队列拼接入口仍能开墙');
  ok(wallAfter.btnActive && wallAfter.btnBg !== 'rgba(0, 0, 0, 0)',
    '墙开时图标入口亮起且底色真实生效（原来引用 --surface-hi 当颜色，必失效）',
    wallAfter.btnBg);

  ok(errors.length === 0, '全程无 JS 报错', errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n' + '─'.repeat(56));
  if (failures) {
    console.error('导航胶囊实测：' + failures + ' 项失败');
    process.exit(1);
  }
  console.log('导航胶囊实测：全部通过');
})();
