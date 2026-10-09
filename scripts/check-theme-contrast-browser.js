// 在真实页面上量对比度，而不是只算令牌值。
//
// 为什么必须真跑：令牌表里写着 text=#f6ece0、bg=#1e1410，不代表用户
// 看到的正文就是这个组合 —— 正文可能落在面板上、卡片上、输入框里，
// 或者被半透明叠层盖过。**唯一可信的是页面上实际渲染出来的像素色。**
//
// 判据用 WCAG 2.x 的定义独立实现，不复用 theme-studio.js 那份（避免自证）。
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

async function main() {
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

    for (const id of ['spirited', 'liyue']) {
      await page.evaluate(t => window.Theme.apply(t, { silent: true }), id);
      await page.waitForTimeout(600);

      // 在页面里量：取元素与其最近的有底色祖先，算实际呈现的对比度。
      const report = await page.evaluate(() => {
        const srgb = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
        const parse = (s) => {
          const m = /rgba?\(([^)]+)\)/.exec(String(s || ''));
          if (m) { const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
          const c = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(String(s || ''));
          if (c) return [+c[1] * 255, +c[2] * 255, +c[3] * 255, c[4] === undefined ? 1 : +c[4]];
          return null;
        };
        const L = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
        // 渐变取"端点里较暗的那一档"作为代表色。
        //
        // ⚠ 早先的版本一遇到 background-image 就 return null，结果每个目标
        // 都判成"算不出"→ 0 项断言跑过→ 报"全部通过"。**恒绿的断言比没有
        // 断言更糟**：它让人以为这块验过了。这里取暗端是保守取法 ——
        // 用较亮的那档去算会低估对比度、报出假警报，用较暗的算等于
        // 拿最不利情况做门槛。
        const gradient = (img) => {
          // ⚠ 色标要认**两种**语法。早先只match rgba?\()，而 color-mix()
          // 与很多现代 color() 的计算值是 color(srgb r g b / a) —— 提不到色标
          // 就返回 null，按钮那一项于是判成"算不出"。这是同一个解析错误的
          // 第四版：① 只看 background-image 就放弃 → 0 断言假绿；
          //        ②/③ 提色标时只认 rgba?() → 漏掉 color(srgb…)。
          const stops = [];
          const re = /rgba?\([^)]+\)|color\(srgb[^)]+\)/g;
          let mm;
          while ((mm = re.exec(String(img)))) {
            const c = parse(mm[0]);
            if (c && c[3] > 0.05) stops.push(c);
          }
          if (!stops.length) return null;
          return stops.reduce((a, b) => (L(b) < L(a) ? b : a));
        };
        // 逐层往上合成，得到"最终看到的颜色"
        const effective = (el) => {
          const layers = [];
          for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
            const cs = getComputedStyle(n);
            const g = cs.backgroundImage && cs.backgroundImage !== 'none'
              ? gradient(cs.backgroundImage) : null;
            if (g) layers.push(g);
            else {
              const bg = parse(cs.backgroundColor);
              // ⚠ parse 对不带 alpha 的 rgb() 只返回 3 个元素，此时 bg[3]
              // 是 undefined —— 而 `undefined > 0` 是 false，于是这一层被
              // **静默丢弃**。症状是"这个元素算不出底色"：.btn.primary 的
              // 底色明明是不透明纯色 rgb(232,161,60)，却整层不算。
              // 用 != null 判存在、|| 1 补alpha，两个坑一起堵。
              if (bg && (bg[3] === undefined || bg[3] > 0)) {
                layers.push(bg.length >= 4 ? bg : [bg[0], bg[1], bg[2], 1]);
              }
            }
          }
          layers.push([0, 0, 0, 1]);
          let out = layers[layers.length - 1];
          for (let i = layers.length - 2; i >= 0; i--) {
            const t = layers[i][3];
            out = [0, 1, 2].map(k => layers[i][k] * t + out[k] * (1 - t)).concat(1);
          }
          return out;
        };
        const ratio = (f, b) => { const a = lum(f), c = lum(b); return (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05); };
        const textOf = (el) => parse(getComputedStyle(el).color);

        const targets = [
          ['曲库标题', '.col-title', 4.5],
          ['每日推荐标题', '.daily-kicker', 4.5],
          ['每日推荐副标题', '.daily-sub', 4.5],
          ['列表艺人/专辑', '.t-sub', 4.5],
          ['时长', '.t-dur', 4.5],
          ['导航文字', '.rail-item', 4.5],
          ['搜索占位符', '.topsearch input', 4.5],
          ['分组标题', '.lib-head', 4.5],
          ['按钮文字', '.btn', 4.5]
        ];
        const out = [];
        for (const [label, sel, min] of targets) {
          const el = document.querySelector(sel);
          if (!el) { out.push({ label, missing: true }); continue; }
          const fg = textOf(el), bg = effective(el);
          if (!fg || !bg) { out.push({ label, unmeasurable: true }); continue; }
          const r = ratio([fg[0], fg[1], fg[2]], [bg[0], bg[1], bg[2]]);
          out.push({ label, min, r: Math.round(r * 100) / 100,
            fg: 'rgb(' + fg.slice(0, 3).map(Math.round) + ')',
            bg: 'rgb(' + bg.slice(0, 3).map(Math.round) + ')' });
        }
        return out;
      });

      console.log('\n=== ' + id + '（页面上实际渲染的对比度）');
      let measured = 0;
      for (const r of report) {
        if (r.missing) { console.log('  X ' + r.label + '：节点不存在（选择器过期了）'); failures += 1; continue; }
        if (r.unmeasurable) {
          console.log('  X ' + r.label + '：算不出（背后是渐变/图）');
          failures += 1;
          continue;
        }
        measured += 1;
        check(r.r >= r.min, r.label + ' ≥' + r.min, r.r + ':1  ' + r.fg + ' on ' + r.bg);
        console.log('  ' + (r.r >= r.min ? 'ok  ' : 'FAIL') + r.label.padEnd(14) +
          String(r.r).padStart(6) + ':1   ' + r.fg + ' on ' + r.bg);
      }
      // 防"全部跳过 → 0 断言 → 报全部通过"这种假绿。
      // 一套主题至少要量到 6 个元素，否则等于什么都没验。
      check(measured >= 6, id + ' 至少量到 6 个元素的真实对比度（实得 ' + measured + '）');

      await page.screenshot({ path: path.join(__dirname, '..', 'output', 'theme-shots', 'new-' + id + '.png') });
    }
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
  console.log('\n' + '─'.repeat(56));
  console.log(failures ? `实页对比度：${checks - failures}/${checks}，${failures} 项失败`
    : `实页对比度：${checks}/${checks} 全部通过`);
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });