#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// 全量遍历：23 套内置主题 × 4 套可选皮肤 = 92 个组合，逐组合量关键几何。
// （星轨由单独的脚本覆盖；这里用 localStorage + reload 起皮肤，写它只会报「切不过去」。）
//
// 为什么必须全量：只验晴空族那五套会漏掉「某套皮肤 + 其他主题」——
// 用户就是这么发现漏的。而这类 bug 的特点是**只出现在特定组合**：单看主题
// 或单看皮肤都正常，凑一起才炸。所以任何"抽样验过"都不算验过。
//
// 判定口径：
//   ① 黑胶的通栏导航条必须**实底**（合成后有效不透明度 ≥ 0.9）
//   ② 黑胶的顶栏是扁平通栏（圆角 0），内容卡是圆角内缩卡
//   ③ 面板/播放条/顶栏不能塌陷、不能横向溢出视口
//   ④ 页面无运行时错误
//
// ⚠ 判"实不实"必须算**合成后的有效不透明度**，不是看 background-image
// 是否为 none。这一点我写错过两版，两版都报出与真 bug 一模一样的假警报：
//   ① 用 `bgImage === 'none'` 判 → 而修复恰恰**引入**了 linear-gradient 遮罩，
//      于是修好之后探针反报"被玻璃渐变覆盖"，41 个组合全红。
//   ② 只用 /rgba?\(/ 提色标 → 而 color-mix() 的计算值是 color(srgb r g b / a)，
//      色标列表空 → 合成退化成"只有底色"，又报 18 个没实底。
// 症状与真 bug 一模一样，只能靠打印中间值才发现。所以下面 stopsOf 认两种语法。
//
// 输出只报异常组合 —— 161 行全绿没人看。
'use strict';
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');

const THEMES = ['mineral', 'celestial', 'kiminona', 'spirited', 'starrail', 'liyue',
  'starblue', 'emerald', 'midnight-neon', 'mono', 'aero', 'codeide', 'sakura',
  'crimson', 'paper-ink', 'forest', 'porcelain', 'snow-dawn', 'acid', 'liunian',
  'ios-light', 'chaoxi-night', 'chaoxi-day'];
// 回落到 classic —— 这里靠写 localStorage + reload 起皮肤，写上它只会报
// 「皮肤切不过去」。组合矩阵只跑界面上真能选到的那几套。
const SKINS = ['classic', 'liunian', 'qingfeng', 'heijiao'];

const issues = [];
let combos = 0;

(async () => {
  const fixture = await startFixture();
  let browser;
  try {
    await fixture.seed();
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await fixture.connect(ctx);
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar');

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    for (const skin of SKINS) {
      await page.evaluate(s => { try { localStorage.setItem('vmusic.skin', s); } catch (e) {} }, skin);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.topbar');
      await page.waitForTimeout(300);
      const actualSkin = await page.evaluate(() => document.documentElement.getAttribute('data-skin'));
      if (actualSkin !== skin) {
        issues.push({ skin, why: '皮肤切不过去（存的是 ' + skin + '，实际 ' + actualSkin + '）' });
        continue;
      }

      for (const theme of THEMES) {
        combos += 1;
        await page.evaluate(t => window.Theme.apply(t, { silent: true }), theme);
        await page.waitForTimeout(140);

        const m = await page.evaluate(() => {
          const parse = (str) => {
            const mm = /rgba?\(([^)]+)\)/.exec(String(str || ''));
            if (mm) { const q = mm[1].split(/[,\s/]+/).filter(Boolean).map(Number); return [q[0], q[1], q[2], q.length > 3 ? q[3] : 1]; }
            const c = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(String(str || ''));
            if (c) return [+c[1] * 255, +c[2] * 255, +c[3] * 255, c[4] === undefined ? 1 : +c[4]];
            return null;
          };
          // 提色标要认**两种**语法。早先只 match rgba?()，而 color-mix() 的
          // 计算值是 color(srgb r g b / a) —— 于是色标列表是空的，合成结果
          // 退化成"只有底色"，把已经修好的 18 个组合又报成没实底。
          // 症状与真 bug 一模一样，只能靠打印中间值才发现。
          const stopsOf = (img) => {
            const out = [];
            const re = /rgba?\([^)]+\)|color\(srgb[^)]+\)/g;
            let mm;
            while ((mm = re.exec(img))) { const v = parse(mm[0]); if (v) out.push(v); }
            return out;
          };
          // ★ 判"实不实"要算**合成后的有效不透明度**，不能看 background-image
          // 是否为 none。早先判据是 bgImage === 'none'，而修复恰恰**引入**了一层
          // linear-gradient 遮罩 → 修好之后探针反而报"被玻璃渐变覆盖"，41 个
          // 组合全红。判据对着症状写、没对着机制写，就会这样。
          const effAlpha = (cs) => {
            const base = parse(cs.backgroundColor) || [0, 0, 0, 0];
            const img = cs.backgroundImage;
            if (!img || img === 'none') return base[3];
            const stops = stopsOf(img);
            if (!stops.length) return base[3];
            let top = stops[0];
            for (const st of stops) if (st[3] > top[3]) top = st;
            return top[3] + base[3] * (1 - top[3]);
          };
          const box = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const b = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
              w: Math.round(b.width), h: Math.round(b.height),
              left: Math.round(b.left), right: Math.round(b.right),
              radius: parseFloat(cs.borderTopLeftRadius) || 0,
              alpha: effAlpha(cs),
              visible: cs.display !== 'none' && cs.visibility !== 'hidden'
            };
          };
          return {
            topbar: box('.topbar'), rail: box('.rail'), column: box('.column'),
            app: box('.app'), bar: box('.bar'), track: box('.track'),
            stage: box('.stage'), disc: box('.stage .disc-wrap'),
            vw: document.documentElement.clientWidth,
            appCols: getComputedStyle(document.querySelector('.app') || document.body)
              .gridTemplateColumns
          };
        });

        const tag = skin + ' × ' + theme;
        // ③ 几何塌陷 / 溢出
        if (m.column && m.column.visible && (m.column.w < 40 || m.column.h < 40))
          issues.push({ tag, why: '内容面板塌陷 ' + m.column.w + '×' + m.column.h });
        if (m.topbar && m.topbar.visible && m.topbar.w < 200)
          issues.push({ tag, why: '顶栏塌陷 w=' + m.topbar.w });
        if (m.bar && m.bar.visible && m.bar.h < 20)
          issues.push({ tag, why: '播放条塌陷 h=' + m.bar.h });
        for (const k of ['topbar', 'rail', 'column', 'bar']) {
          const b = m[k];
          if (b && b.visible && (b.left < -2 || b.right > m.vw + 2))
            issues.push({ tag, why: k + ' 横向溢出 [' + b.left + ',' + b.right + '] 视口 ' + m.vw });
        }
        // ④ 黑胶专属：通栏导航要实底、顶栏要扁平，另加「双卡片比例」与「左卡不塌」
        if (skin === 'heijiao') {
          if (m.rail && m.rail.visible && m.rail.alpha < 0.9)
            issues.push({ tag, why: '导航条没实底 alpha=' + m.rail.alpha });
          if (m.topbar && m.topbar.radius > 0)
            issues.push({ tag, why: '顶栏是浮起卡片（圆角 ' + m.topbar.radius + '），应为扁平通栏' });
          // 左卡是常驻的：style.css 里 body[data-stage-idle="1"] .stage 有
          // display:none，而它是 (0,2,1) —— 皮肤必须用更高特异性拉回来。
          // 漏掉的表现是"空闲几秒后左卡凭空消失、栅格塌成一列"，且不报错。
          if (!m.stage || !m.stage.visible)
            issues.push({ tag, why: '左卡不见了（data-stage-idle 把它 display:none 了）' });
          // 唱片不能在左卡里被压成一条缝。300px 是设计下限：
          // 低于它就说明卡片被压扁了（与单列皮肤栽过的 .lib-list 12px 同一类）。
          if (m.disc && m.disc.visible && m.disc.h < 120)
            issues.push({ tag, why: '唱片被压扁 h=' + m.disc.h });
          // 宽屏下必须是两轨（1/3 + 2/3）。
          //
          // ⚠ 判据不能读 gridTemplateColumns 的**字符串**再 split：
          // 计算值可能带函数（minmax/min-content…），按空格拆出来的段数
          // 与轨道数没有对应关系 —— 拆出来是 3 段不代表有 3 条轨道。
          // 量真实几何才对：左卡与右面板**左右并排**（左卡右边界不越过
          // 右面板左边界），这是用户能直接看出来的形态。
          // 塌成单列时左卡在右面板上方，两个边界会重叠，这条立刻抓到。
          if (m.vw > 1100 && m.stage && m.column && m.stage.visible && m.column.visible) {
            if (m.stage.right > m.column.left + 2)
              issues.push({ tag, why: '宽屏不是左右并排（左卡 right=' + m.stage.right +
                ' 右面板 left=' + m.column.left + '）' });
            // 左卡约占中部 1/3。放宽到 [0.2, 0.5]：这是比例，不是像素，
            // 量到的绝对值会随视口变。
            const ratio = m.stage.w / (m.stage.w + m.column.w);
            if (ratio < 0.2 || ratio > 0.5)
              issues.push({ tag, why: '左卡比例失衡 ' + (ratio * 100).toFixed(0) + '%（设计是 1/3）' });
          }
        }
      }
    }

    console.log('遍历组合：' + combos + '（主题 × 皮肤）');
    if (errors.length) issues.push({ tag: '运行时', why: '页面报错：' + errors.slice(0, 3).join(' | ') });

    if (!issues.length) {
      console.log('\n全部通过，未发现异常组合。');
    } else {
      // 同一个根因往往命中多个组合，按 why 归类，才看得出"哪一类问题"
      const byWhy = new Map();
      for (const i of issues) {
        const key = i.why.replace(/[\d.]+/g, 'N').replace(/\[N,N\]/g, '[N,N]');
        if (!byWhy.has(key)) byWhy.set(key, []);
        byWhy.get(key).push(i.tag);
      }
      console.log('\n发现 ' + issues.length + ' 个异常，归为 ' + byWhy.size + ' 类：');
      for (const [why, tags] of byWhy) {
        console.log('\n  ▸ ' + why);
        console.log('    命中 ' + tags.length + ' 个组合：' + tags.slice(0, 30).join(', ') +
          (tags.length > 30 ? ' …' : ''));
      }
    }
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
  process.exit(issues.length ? 1 : 0);
})();