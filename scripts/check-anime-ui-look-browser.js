#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 外观族浏览器验收：量的是**解析后的计算值**，不是 CSS 文本形状。
//
// 为什么静态契约 check-anime-ui.js 不够：它扫的是源码文本，而"某一族
// 到底有没有拿到装饰"这件事，在文本层面是看不出来的。我自己踩过一次——
// 把装饰层改成按族选时写成
//     html[data-look="glass"],
//     html[data-look="cel"] .topbar { … }
// 只有第二支带后缀，于是玻璃族永远匹配不到，赛璐璐族一切正常：
// CSS 合法、页面不报错、元素齐全、截图能看、控制台干净。唯一症状是
// "玻璃族看起来没换样式"，而它恰恰是我最该验的那一族。
//
// 那个坑试过用正则断言，四版都栽在"按顶层逗号切选择器列表"上（列表里
// 既有 :is(a, b) 的函数逗号、又有跨行缩进），恒绿的断言比没有断言更糟。
// 所以真值放在这里：getComputedStyle 的 border-radius / border-width /
// backdrop-filter 是浏览器的权威答案，不受源码怎么写影响。
//
// 顺带覆盖：换族不重置点击反馈、切回无 look 的主题要摘干净、
// 两族共享的结构装饰（间距 / 圆角 / 缓动）都要继承到。
//
// 用法: PLAYWRIGHT_MODULE=<abs path> node scripts/check-anime-ui-look-browser.js

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');

const OUT = process.env.LOOK_SHOT_DIR || 'output/playwright/anime-look';

// 每套：id + 族。玻璃族三套、赛璐璐族两套，celestial 在列——
// **它必须一起验**：改动装饰层时最容易悄悄弄坏的就是原版。
const CASES = [
  { id: 'celestial', look: 'glass', blur: true },
  { id: 'starrail', look: 'glass', blur: true },
  { id: 'liyue', look: 'glass', blur: true },
  { id: 'kiminona', look: 'cel', blur: false },
  { id: 'spirited', look: 'cel', blur: false }
];

let failures = 0;
let checks = 0;
function check(cond, label, detail) {
  checks += 1;
  if (cond) return;
  failures += 1;
  console.error('  X ' + label + (detail ? '  [' + detail + ']' : ''));
}
function pass(label) { checks += 1; console.log('  · ' + label); }

/// blur 位上的值是不是 0。
///
/// 走过两版错判据才写对，结论留着：
///   1. 匹配 `/px 0 /` 字符串形状 —— 浏览器吐 "0px 0px"，规则生效也报失败；
///   2. 按逗号切层数长度 —— color(srgb r g b) 内部有空格，且省略 spread
///      时层内只有 3 段，同样误判。
/// 可靠的只有一件事：**读第 3 个长度**（offsetX offsetY blur）。
function blurOf(shadow) {
  let t = String(shadow || '')
    .replace(/rgba?\([^)]*\)/gi, ' ')
    .replace(/color\(srgb[^)]*\)/gi, ' ')
    .replace(/color-mix\([^;]*?\)(?=[^,]*$)/gi, ' ')
    .replace(/#[0-9a-f]{3,8}\b/gi, ' ');
  const lens = t.match(/-?[\d.]+px/g) || [];
  return lens.length >= 3 ? parseFloat(lens[2]) : 0;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const fixture = await startFixture();
  let browser;
  try {
    await fixture.seed();
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await fixture.connect(context);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // 不能用 networkidle：播放器有心跳，永远等不到 idle（每次都 15s 超时）。
    await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar');

    for (const c of CASES) {
      await page.evaluate(id => window.Theme.apply(id, { silent: true }), c.id);
      await page.waitForTimeout(600);

      const p = await page.evaluate(() => {
        // 注意：这个函数必须定义在 evaluate **内部**。写在 Node 作用域的话
        // page.evaluate 里的代码跑在浏览器上下文，压根看不到它 ——
        // 报出来的错是 "alphaOf is not defined"，与断言无关，很容易查岔。
        const alphaOf = (value) => {
          const s = String(value || '');
          if (/^rgba\(/.test(s)) {
            const parts = s.slice(5, -1).split(/[,\s/]+/).filter(Boolean);
            return parts.length >= 4 ? parseFloat(parts[3]) : 1;
          }
          const m = /color\(srgb[^)]*?\/([^)]*)\)/.exec(s);
          if (m) return parseFloat(m[1]);
          return s && s !== 'transparent' ? 1 : 0;
        };
        const html = document.documentElement;
        const tb = document.querySelector('.topbar');
        const btn = document.querySelector('.btn.primary');
        const cs = tb && getComputedStyle(tb);
        const bs = btn && getComputedStyle(btn);
        const root = getComputedStyle(html);
        return {
          theme: html.getAttribute('data-theme'),
          look: html.getAttribute('data-look'),
          radius: cs ? parseFloat(cs.borderTopLeftRadius) : 0,
          border: cs ? parseFloat(cs.borderTopWidth) : 0,
          backdrop: tb ? (getComputedStyle(tb).backdropFilter || 'none') : '',
          blurTok: root.getPropertyValue('--glass-blur').trim(),
          gap: root.getPropertyValue('--anime-section-gap').trim(),
          dur: root.getPropertyValue('--dur-base').trim(),
          easing: root.getPropertyValue('--ease').trim(),
          grain: parseFloat(getComputedStyle(document.body, '::after').opacity),
          panelAlpha: cs ? alphaOf(cs.backgroundColor) : 0,
          btnShadow: bs ? bs.boxShadow : '',
          btnBg: bs ? bs.backgroundColor : ''
        };
      });

      console.log('\n' + c.id + '（期望 ' + c.look + '）');
      check(p.theme === c.id, 'data-theme 切到 ' + c.id, p.theme);
      check(p.look === c.look, 'data-look 是 ' + c.look, p.look);

      // ★ 这两条就是那个静默回归的哨兵。任何一套拿不到装饰都会在这里红。
      check(p.radius >= 12, '装饰层命中本族：面板圆角 ≥12px',
        p.radius + 'px ← 这一族没拿到装饰');
      check(p.border >= 1, '装饰层命中本族：面板描边 ≥1px',
        p.border + 'px ← 这一族没拿到装饰');

      // 两族共享的结构装饰：少继承一样，就说明它被写死进了某一族。
      check(p.gap === '24px', '继承共享的 24px 区块间距', p.gap);
      check(/ease-in-out/.test(p.easing), '继承共享 ease-in-out', p.easing);
      check(p.dur === '240ms', '继承共享 240ms 基准时长', p.dur);

      if (c.blur) {
        const m = /blur\(([\d.]+)px\)/.exec(p.backdrop);
        const radius = m ? parseFloat(m[1]) : 0;
        check(radius > 0, '玻璃族保留背景模糊', radius + 'px');
        check(p.blurTok !== '0px', '玻璃族 --glass-blur 非零', p.blurTok);
      } else {
        // blur(0px) 在计算值里仍然是 blur(0px)，所以不能只判"有没有 blur 函数"，
        // 得判半径是不是 0 —— 这正是"材质改了但没生效"最容易蒙混过去的地方。
        const m = /blur\(([\d.]+)px\)/.exec(p.backdrop);
        const radius = m ? parseFloat(m[1]) : 0;
        check(p.blurTok === '0px' && radius === 0,
          '赛璐璐族模糊已关（--glass-blur 与 backdrop-filter 都要为 0）',
          'token=' + p.blurTok + ' backdrop=' + p.backdrop);
        check(p.panelAlpha > 0.9, '赛璐璐面板接近不透明（平涂）', 'alpha=' + p.panelAlpha);
        check(blurOf(p.btnShadow) === 0, '赛璐璐按钮的投影 blur 位为 0（硬边，非厚涂）',
          'blur=' + blurOf(p.btnShadow));
        check(p.grain <= 0.05, '赛璐璐噪点压到 ≤5%', String(p.grain));
      }

      await page.screenshot({ path: path.join(OUT, c.id + '.png') });
    }

    // 回退：切到没有 look 的内置主题，不能残留上一套的装饰。
    await page.evaluate(() => window.Theme.apply('emerald', { silent: true }));
    await page.waitForTimeout(400);
    const back = await page.evaluate(() => ({
      look: document.documentElement.getAttribute('data-look'),
      radius: parseFloat(getComputedStyle(document.querySelector('.topbar')).borderTopLeftRadius) || 0,
      dur: getComputedStyle(document.documentElement).getPropertyValue('--dur-base').trim()
    }));
    console.log('\n回退到 emerald（无 look 的内置主题）');
    check(back.look === 'plain', 'data-look 摘回 plain', back.look);
    check(back.dur !== '240ms', '共享结构令牌随外观一起摘掉', back.dur);

    check(errors.length === 0, '无运行时错误', errors.join(' | '));
    pass('截图已写入 ' + OUT);
  } finally {
    if (browser) await browser.close();
    // fixture 暴露的是 close()，不是 stop()（别照抄别的脚本的名字）。
    await fixture.close();
  }

  console.log('\n' + '─'.repeat(60));
  console.log(failures
    ? `外观族浏览器验收：${checks - failures}/${checks} 通过，${failures} 项失败`
    : `外观族浏览器验收：${checks}/${checks} 全部通过`);
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });