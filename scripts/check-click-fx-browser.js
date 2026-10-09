// SPDX-License-Identifier: MIT
// 点击反馈必须按外观族分叉：只换配色不换手感，等于两族共用一套交互。
// 赛璐璐族的点击反馈必须与玻璃族**不同** —— 只换配色不换手感，
// 等于两族共用一套交互，族的划分就只剩静态材质。
//
// 量的是点击瞬间粒子的**计算样式**（圆角 / 动画名 / 动画时长），
// 不是 CSS 文本：这里要证明的是"跑起来不一样"。
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

// 在 capture 阶段同步取样：粒子的计算样式必须在**点击那一刻**读，
// 动画只有 240/280ms，等 evaluate 回来就已经结束、节点已被移除。
// 这套做法抄自 check-anime-ui-browser.js 的 installParticleObserver ——
// 不要自己发明（我先试了 page.mouse.click + 事后 evaluate，
// particles 恒为 0，看起来像"反馈坏了"，实际是采样时机错了）。
async function installProbe(page) {
  await page.evaluate(() => {
    window.__clicks = [];
    document.addEventListener('click', event => {
      const control = event.target.closest && event.target.closest('#theme-btn');
      if (!control) return;
      const layer = document.querySelector('.anime-interactions-layer');
      const particle = layer && layer.querySelector('.anime-interactions-particle');
      const cs = particle ? getComputedStyle(particle) : null;
      const keyframes = [];
      for (const s of document.styleSheets) {
        let rules;
        try { rules = [...s.cssRules]; } catch (e) { continue; }
        for (const r of rules) {
          if (r.type === CSSRule.KEYFRAMES_RULE && r.name) {
            keyframes.push({ name: r.name, rotates: /rotate\(/.test(r.cssText) });
          }
        }
      }
      window.__clicks.push({
        particles: layer ? layer.querySelectorAll('.anime-interactions-particle').length : 0,
        radius: cs ? parseFloat(cs.borderTopLeftRadius) : -1,
        anim: cs ? cs.animationName : '',
        dur: cs ? cs.animationDuration : '',
        shadow: cs ? cs.boxShadow : '',
        keyframes
      });
    }, { capture: true, passive: true });
  });
}

async function clickAndProbe(page) {
  // 必须先 clear：anime-interactions.js 有 MIN_GAP 90ms 节流 + 上一次
  // 动画的节点清理，不清会读到"没有反馈"。
  //
  // ⚠ 目标必须选**可见**的按钮。踩过的坑：一开始点 `.btn.primary`，
  // 而它在无曲库的 fixture 里宽度为 0，被 onClick 的
  // `rect.width <= 0` 门槛过滤掉 —— 于是 layer 恒为 null，
  // 看起来像"点击反馈坏了"，其实是自己选了个看不见的按钮。
  // #theme-btn 恒在顶栏、且就在 CONTROLS 列表里，最稳。
  await page.evaluate(() => { if (window.AnimeInteractions) window.AnimeInteractions.clear(); window.__clicks.length = 0; });
  await page.locator('#theme-btn').click();
  await page.waitForFunction(() => window.__clicks.length > 0, null, { timeout: 3000 }).catch(() => {});
  return page.evaluate(() => window.__clicks[0] || { particles: 0 });
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
    await installProbe(page);

    const probes = {};
    for (const id of ['starrail', 'kiminona']) {
      await page.evaluate(t => window.Theme.apply(t, { silent: true }), id);
      await page.waitForTimeout(600);
      probes[id] = await clickAndProbe(page);
      await page.waitForTimeout(500);
    }
    const g = probes.starrail, c = probes.kiminona;
    console.log('玻璃族（starrail）：' + JSON.stringify(g));
    console.log('赛璐璐（kiminona）：' + JSON.stringify(c));

    check(g && g.particles > 0, '玻璃族有点击粒子', g && String(g.particles));
    check(c && c.particles > 0, '赛璐璐族有点击粒子', c && String(c.particles));

    console.log('\n两族差异：');
    if (g && c) {
      check(c.radius === 0, '赛璐璐碎片是直角（玻璃族是 1px 圆角）',
        'cel=' + c.radius + ' glass=' + g.radius);
      check(c.anim !== g.anim, '赛璐璐用另一套关键帧（玻璃是旋转星屑）',
        'cel=' + c.anim + ' glass=' + g.anim);
      check(!/rotate\(/.test((c.keyframes.find(k => k.name === c.anim) || {}).rotates || ''),
        '赛璐璐的碎片**不旋转**（旋转柔光是玻璃的语言）');
      check((c.keyframes.find(k => k.name === c.anim) || {}).rotates === false,
        '赛璐璐关键帧里确实没有 rotate()');
      check(/none/.test(c.shadow) && !/none/.test(g.shadow),
        '赛璐璐碎片无辉光（边界靠实色不靠发光）', 'cel=' + c.shadow.slice(0, 30));
      check(c.dur !== g.dur, '两族的迸开时长不同', 'cel=' + c.dur + ' glass=' + g.dur);
    }
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
  console.log('\n' + '─'.repeat(56));
  console.log(failures ? `点击反馈分族：${checks - failures}/${checks}，${failures} 项失败`
    : `点击反馈分族：${checks}/${checks} 全部通过`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });