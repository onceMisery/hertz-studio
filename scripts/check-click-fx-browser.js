// SPDX-License-Identifier: MIT
// 点击特效必须**按主题**分叉：每套主题声明自己的 fx 原型，换主题 =
// 换手感。这条链路任何一环接错都是静默的（特效不触发 / 粒子隐形 /
// 两套主题共用一个原型），所以浏览器侧量的是点击瞬间的**计算样式**：
//   · <html data-fx> 真的落了主题声明的值（apply → 属性）；
//   · 粒子或 burst 节点上跑的动画名 = fx-<原型>（属性 → CSS 原型）；
//   · 粒子型与节点型二选一（注册表 count=0 的原型不该再冒粒子）；
//   · 样例主题的动画名两两不同（"不同主题特效不同"的验收硬要求）。
//
// 期望值不硬编码在测试里：每套主题该是什么原型，从 window.Theme.list()
// 现场读 —— 测的是 themes.js 的声明到引擎再到 CSS 的**整条接线**，
// 而不是测试自己跟自己对答案。
'use strict';
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');

let failures = 0, checks = 0;
function check(c, label, detail) {
  checks += 1;
  if (c) return;
  failures += 1;
  console.error('  X ' + label + (detail ? '  [' + detail + ']' : ''));
}

// 覆盖两类原型：粒子型（shard/stardust/comet/ember/nova/firework/pixel/
// petal/firefly）与节点型（ripple/pill/tide）。
const SAMPLE = ['mineral', 'celestial', 'kiminona', 'spirited', 'starrail', 'liyue',
  'mono', 'codeide', 'sakura', 'forest', 'ios-light', 'chaoxi-day'];

// 在 capture 阶段同步取样：粒子的计算样式必须在**点击那一刻**读，
// 动画只有 200–800ms，等 evaluate 回来就已经结束、节点已被移除。
// 这套做法抄自 check-anime-ui-browser.js 的 installParticleObserver ——
// 不要自己发明（page.mouse.click + 事后 evaluate 会恒读到 0）。
async function installProbe(page) {
  await page.evaluate(() => {
    window.__clicks = [];
    document.addEventListener('click', event => {
      const control = event.target.closest && event.target.closest('#top-more-btn');
      if (!control) return;
      const layer = document.querySelector('.anime-interactions-layer');
      const node = layer && layer.querySelector('.anime-interactions-burst');
      const particle = layer && layer.querySelector('.anime-interactions-particle');
      const csNode = node ? getComputedStyle(node) : null;
      const cs = particle ? getComputedStyle(particle) : null;
      window.__clicks.push({
        fx: document.documentElement.getAttribute('data-fx'),
        particles: layer ? layer.querySelectorAll('.anime-interactions-particle').length : 0,
        anim: cs ? cs.animationName : (csNode ? csNode.animationName : ''),
        dur: cs ? cs.animationDuration : (csNode ? csNode.animationDuration : ''),
        onNode: !cs && !!csNode
      });
    }, { capture: true, passive: true });
  });
}

async function clickAndProbe(page) {
  // 必须先 clear：anime-interactions.js 有 MIN_GAP 90ms 节流 + 上一次
  // 动画的节点清理，不清会读到"没有反馈"。
  //
  // ⚠ 目标必须选**可见**的按钮：#top-more-btn 恒在顶栏、且就在 CONTROLS
  // 列表里（踩过的坑：无曲库 fixture 里 .btn.primary 宽度为 0，会被
  // onClick 的 rect 门槛过滤掉，看起来像"反馈坏了"）。
  await page.evaluate(() => { if (window.AnimeInteractions) window.AnimeInteractions.clear(); window.__clicks.length = 0; });
  await page.locator('#top-more-btn').click();
  await page.waitForFunction(() => window.__clicks.length > 0, null, { timeout: 3000 }).catch(() => {});
  const sample = await page.evaluate(() => window.__clicks[0] || { particles: 0, anim: '', fx: '' });
  // #top-more-btn 的业务行为是拉开更多工具菜单；不收起，下一轮的真实点击会被
  // 菜单盖住（Playwright 命中检测一直重试直到超时，且不报产品错）。
  // 与 check-anime-ui-browser.js 的 selectTheme 同款：点完按 Escape。
  await page.keyboard.press('Escape');
  return sample;
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

    const observed = {};
    for (const id of SAMPLE) {
      const fx = await page.evaluate(t => {
        const theme = window.Theme.list().find(x => x.id === t);
        if (!theme) return null;
        window.Theme.apply(t, { silent: true });
        return theme.fx;
      }, id);
      check(!!fx, id + ' 在 Theme.list() 里带 fx 声明', String(fx));
      if (!fx) continue;
      // 换主题会终止旧反馈；留出一拍让上一轮粒子清完、这一轮属性落稳。
      await page.waitForTimeout(650);
      const probe = await clickAndProbe(page);
      observed[id] = probe.anim;
      console.log(id + '（fx=' + fx + '）：' + JSON.stringify(probe));
      check(probe.fx === fx, id + ' 的 data-fx 落到 <html>', 'expect=' + fx + ' got=' + probe.fx);
      check(probe.anim === 'fx-' + fx, id + ' 点击动画是 fx-' + fx,
        'expect=fx-' + fx + ' got=' + probe.anim);
      // 粒子型必须有粒子、节点型必须没有 —— 两者恰好其一。
      check((probe.particles > 0) !== probe.onNode,
        id + ' 的原型形态与注册表一致（粒子型有粒子 / 节点型画在 burst 上）',
        'particles=' + probe.particles + ' onNode=' + probe.onNode);
      await page.waitForTimeout(500);
    }

    console.log('\n样例主题的动画名两两不同：');
    const anims = Object.values(observed);
    check(new Set(anims).size === SAMPLE.length,
      '样例主题的点击动画互不相同（不同主题特效不同）', JSON.stringify(observed));
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
  console.log('\n' + '─'.repeat(56));
  console.log(failures ? `点击特效按主题：${checks - failures}/${checks}，${failures} 项失败`
    : `点击特效按主题：${checks}/${checks} 全部通过`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
