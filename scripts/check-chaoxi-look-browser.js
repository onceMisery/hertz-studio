// SPDX-License-Identifier: MIT
// 潮汐皮肤 × 晴空外观族：顶栏必须保持扁平通栏，不能是浮起卡片。
// 量潮汐皮肤下「顶栏 / 导航」与「内容卡 / 播放条」的水平对齐。
//
// 用户的原话是"顶部两个卡片和下面的卡片没对齐"。这两处对齐在 CSS 上是
// 两组不同的量，混起来看会得出错误结论：
//   · logo 左缘 / 右侧按钮右缘↔ 页标题左缘 / 工具行右缘  →由 padding-inline 对齐
//   · 面板外框左右  ↔  内容卡左右                      → 满宽顶栏 vs 内缩内容卡
// 第二组才是"卡片没对齐"：顶栏被晴空画成浮起卡片后，满宽卡片比内缩的
// .column 左右各探出一个 --skin-pad。
//
// 断言要量 rect，不能量 CSS 变量：变量是意图，rect 是结果。
'use strict';
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');

const THEMES = process.env.LOOK_THEMES
  ? process.env.LOOK_THEMES.split(',')
  : ['celestial', 'starrail', 'liyue', 'kiminona', 'spirited'];

let failures = 0, checks = 0;
function check(c, label, detail) {
  checks += 1;
  if (c) return;
  failures += 1;
  console.error('  X ' + label + (detail ? '  [' + detail + ']' : ''));
}

(async () => {
  const fixture = await startFixture();
  let browser;
  try {
    await fixture.seed();
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await fixture.connect(context);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar');
    // 不能直接 setAttribute('data-skin')：skins.js 有自己的状态机，会把
    // 外部改的属性覆盖回去 —— 实测 skin 仍是 classic、--skin-pad 为空，
    // 量出来的全是"经典皮肤"的数字，结论会完全跑偏。
    // 走真实入口：localStorage + reload，让启动序列自己应用。
    await page.evaluate(() => { try { localStorage.setItem('vmusic.skin', 'chaoxi'); } catch (e) {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar');
    await page.waitForTimeout(500);

    for (const id of THEMES) {
      await page.evaluate(t => window.Theme.apply(t, { silent: true }), id);
      await page.waitForTimeout(500);

      const m = await page.evaluate(() => {
        const r = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return {
            left: Math.round(b.left), right: Math.round(b.right),
            top: Math.round(b.top), bottom: Math.round(b.bottom),
            radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0,
            border: getComputedStyle(el).borderBottomWidth
          };
        };
        const tb = document.querySelector('.topbar');
        return {
          topbar: r('.topbar'), rail: r('.rail'),
          column: r('.column'), view: r('.view'), bar: r('.bar'),
          brand: r('.brand'), colTools: r('.col-tools'),
          skin: document.documentElement.getAttribute('data-skin'),
          pad: getComputedStyle(document.documentElement).getPropertyValue('--skin-pad').trim()
        };
      });

      console.log('\n' + id + '（skin=' + m.skin + ' pad=' + m.pad + '）');
      if (!m.topbar || !m.column) { console.log('  （节点缺失，跳过）'); continue; }
      console.log('  topbar L' + m.topbar.left + ' R' + m.topbar.right +
        ' 圆角' + m.topbar.radius + ' 边' + m.topbar.border +
        ' | column L' + m.column.left + ' R' + m.column.right +
        ' 圆角' + m.column.radius);

      // 潮汐的设计：顶栏/导航是**满宽扁平条**，内容卡/播放条内缩 --skin-pad。
      // 所以顶栏满宽本身是对的；错的是它被画成"浮起卡片"——左右探出的
      // 圆角+描边让它读成另一张卡，与下面的卡不在一条基线上。
      // 判据：顶栏的圆角必须是 0（扁平通栏），边框只在底部。
      check(m.topbar.radius === 0, '顶栏是扁平通栏（圆角 0），不是浮起卡片',
        m.topbar.radius + 'px');
      check(m.topbar.border === '0px' || m.topbar.border === '1px',
        '顶栏只保留一条下边框', m.topbar.border);
      if (m.rail) {
        check(m.rail.radius === 0, '导航条是扁平通栏', m.rail.radius + 'px');
      }
      // 内容卡保持圆角内缩（这是潮汐的设计，不该被一起抹平）
      check(m.column.radius > 0, '内容卡仍是圆角内缩（潮汐的设计）',
        m.column.radius + 'px');

      // ★ 导航条必须有**实底**。
      // 这条是用户第二次验收时提的：晴空绘卷下云会从导航条上透上来。
      // 根因是特异性 —— 装饰层 `html:is([data-look=…]) .rail` (0,2,1) 压过了
      // 皮肤层 `[data-skin="chaoxi"] .rail` (0,2,0)，于是潮汐写的
      // `background: var(--skin-surface)` 被整条盖掉，background-color 归透明。
      //
      // 为什么之前没量出来：暗壁纸（深空的夜景）看同样的代码毫无异常，
      // 亮壁纸（晴空绘卷的云）才现形 —— 一个 bug 在两套主题下表现完全不同，
      // 于是很容易被当成"这是配色问题"。所以这里对**每一套**都断言。
      const rail = await page.evaluate(() => {
        const el = document.querySelector('.rail');
        if (!el) return null;
        const cs = getComputedStyle(el);
        const alphaOf = (v) => {
          const s = String(v || '');
          if (/^rgba\(/.test(s)) {
            const p = s.slice(5, -1).split(/[,\s/]+/).filter(Boolean);
            return p.length >= 4 ? parseFloat(p[3]) : 1;
          }
          const m = /color\(srgb[^)]*?\/([^)]*)\)/.exec(s);
          if (m) return parseFloat(m[1]);
          return s && s !== 'transparent' ? 1 : 0;
        };
        // 合成后的有效不透明度。导航条现在是「遮罩渐变 + 底色」两层，
        // 只看 backgroundColor 会把遮罩层漏掉 —— 而那层才是补到实底的关键。
        // ⚠ 色标要认两种语法：color-mix() 的计算值是 color(srgb r g b / a)，
        // 不是 rgba()。只 match rgba?() 会提不到色标，退化成"只有底色"。
        const stopsOf = (img) => {
          const out = [];
          const re = /rgba?\([^)]+\)|color\(srgb[^)]+\)/g;
          let mm;
          while ((mm = re.exec(img))) out.push(alphaOf(mm[0]));
          return out;
        };
        const base = alphaOf(cs.backgroundColor);
        const img = cs.backgroundImage;
        let eff = base;
        if (img && img !== 'none') {
          const stops = stopsOf(img);
          if (stops.length) {
            const top = Math.max.apply(null, stops);
            eff = top + base * (1 - top);
          }
        }
        return {
          color: cs.backgroundColor,
          image: cs.backgroundImage,
          alpha: Math.round(eff * 1000) / 1000,
          baseAlpha: base,
          backdrop: cs.backdropFilter || 'none'
        };
      });
      console.log('  导航条底色 ' + (rail ? rail.color + ' alpha=' + rail.alpha : '缺失'));
      check(rail && rail.alpha >= 0.9, '导航条是实底（壁纸/滚动内容不透上来）',
        rail ? 'alpha=' + rail.alpha + ' color=' + rail.color : 'no .rail');
      // ⚠ 这条**不能**再判 `image === 'none'`。修复本身引入了一层
      // linear-gradient 遮罩（把--glass-bg-strong 的 .78 补到实底），
      // 于是"有 image"恰恰是修好的标志。早先那版判据在这里报 5 项失败，
      // 症状与真 bug 一模一样 —— 同一个错误犯到第三次：
      // ① 用 bgImage 判 → 修复引入渐变后误报"被覆盖"（41 项）
      // ② 只用 /rgba?\(/ 提色标 → 认不出 color(srgb … / a)，退化成"只有底色"（18 项）
      // ③ 现在这一版
      // 判据必须对着**机制**（合成后够不够实），不能对着症状（有没有 image）。
      check(rail && rail.alpha >= 0.9,
        '导航条合成后够实（遮罩 + 底色 ≥ 0.9）',
        rail ? 'alpha=' + rail.alpha + ' image=' + rail.image.slice(0, 30) : '-');
      check(rail && /blur/.test(rail.backdrop),
        '导航条保留模糊（它负责把底下滚动内容化成色块）', rail ? rail.backdrop : '-');
    }
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
  console.log('\n' + '─'.repeat(56));
  console.log(failures ? `潮汐对齐：${checks - failures}/${checks}，${failures} 项失败`
    : `潮汐对齐：${checks}/${checks} 全部通过`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });