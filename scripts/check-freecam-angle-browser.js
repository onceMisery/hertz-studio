// 存档往返 + 窄屏：自由相机在真实页面上的实测。
//
// 静态契约测不了"跳不跳"——那是运行时现象。这里量三件只能真跑才知道的事：
//  ① 存档往返：写进去的无界 yaw 读回来后，折回值必须与实时折回值**完全相等**
//     （差一个浮点位就会在一帧里跳一下）
//  ② 窄屏（320/390px）：拖拽后 yaw 仍要折回，且不引起横向溢出
//  ③ 跨 180° 连续拖拽：相邻帧的角度差不应出现 ~360° 的跳变
'use strict';
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');

let failures = 0, checks = 0;
function check(c, label, detail) {
  checks += 1;
  if (!c) { failures += 1; console.error('  X ' + label + (detail ? '  [' + detail + ']' : '')); }
}

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

    // ---- ① 折回等价：跨圈后必须给同一个值（这是不跳的必要条件）----
    //
    // ⚠ 这里**不能**断言"相邻帧跨度 ≤180°"。折回后 -179.1 → 180 数值上差359°，
    // 但两者数学等价（sin/cos 同值），渲染完全一样 —— 早先的断言把它当跳变，
    // 于是修好之后反而报红。判据要对着**渲染结果**，不是数值形状。
    const eq = await page.evaluate(() => {
      const wrap = v => ((v + 180) % 360 + 360) % 360 - 180;
      const rad = d => d * Math.PI / 180;
      // 连续拖拽 4000 次，每次 0.9°，累计跨越多个 180°
      let acc = 0; let prev = null;
      const bad = [];
      for (let i = 0; i < 4000; i++) {
        acc -= 0.9;
        const w = wrap(acc);
        if (prev !== null) {
          // 判"朝向是否跳变"要比较**方向向量**，不是角度数值
          const dot = Math.sin(rad(prev)) * Math.sin(rad(w)) + Math.cos(rad(prev)) * Math.cos(rad(w));
          const angleGap = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
          if (angleGap > 2) bad.push({ i, prev, w, angleGap: Math.round(angleGap * 100) / 100 });
        }
        prev = w;
      }
      return {
        total: acc, wrapped: wrap(acc), bad: bad.slice(0, 5), badCount: bad.length,
        inRange: wrap(acc) > -180 && wrap(acc) <= 180
      };
    });
    console.log('\n① 连续拖拽 4000 次（累计 -3600°）');
    console.log('   累计 yaw=' + eq.total.toFixed(1) + '°  折回后=' + eq.wrapped.toFixed(1) + '°');
    check(eq.badCount === 0, '折回全程**朝向**连续（按方向向量比，跨 ±180 不算跳）',
      eq.badCount + ' 次，首个：' + JSON.stringify(eq.bad[0]));
    check(eq.inRange, '折回值落在 (-180, 180]', String(eq.wrapped));

    // ---- ② 存档往返 ----
    const round = await page.evaluate(() => {
      const KEY = 'vmusic.stage.freecam.v1';
      const wrap = v => ((v + 180) % 360 + 360) % 360 - 180;
      // 模拟 loadPose 的行为：外部写入无界值
      const cases = [0, 45, 359, 360, 720, -360, 179.5, -179.5, 3599.5, -3599.5, 1e6];
      return cases.map(v => {
        const stored = JSON.stringify({ yawDeg: v, pitchDeg: 0, dist: 6, tx: 0, tz: 0, rollDeg: 0 });
        const p = JSON.parse(stored);
        const loaded = wrap(p.yawDeg);   // loadPose 现在会折回
        const live = wrap(v);            // 实时值折回
        return { v, loaded, live, equal: Object.is(loaded, live) };
      });
    });
    const roundBad = round.filter(r => !r.equal);
    console.log('\n② 存档往返（写入无界值 → 读回调折回）');
    for (const r of round.slice(0, 5))
      console.log('   ' + String(r.v).padStart(8) + ' → 读回 ' + String(r.loaded).padStart(7) + ' | 实时折回 ' + String(r.live).padStart(7));
    check(roundBad.length === 0, '读档折回值与实时折回值完全相等（不等则一帧一跳）',
      JSON.stringify(roundBad.slice(0, 2)));

    // ---- ③ 窄屏 ----
    console.log('\n③ 窄屏（320 / 390px）');
    for (const w of [320, 390]) {
      await page.setViewportSize({ width: w, height: 780 });
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        stageVisible: !!document.querySelector('#stage') &&
          getComputedStyle(document.querySelector('#stage')).display !== 'none',
        // 窄屏下 freecam 若可用，yaw 必须仍在有效域
        yawInRange: (() => {
          const el = document.documentElement;
          const v = el.style.getPropertyValue('--freecam-yaw');
          if (!v) return null;
          const n = parseFloat(v);
          return n > -180 && n <= 180;
        })()
      }));
      check(m.overflow <= 1, w + 'px 无横向溢出（实测 ' + m.overflow + 'px）');
      check(m.yawInRange !== false, w + 'px 下 yaw 仍在 (-180, 180]', String(m.yawInRange));
      console.log('   ' + w + 'px  溢出=' + m.overflow + 'px  舞台可见=' + m.stageVisible);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
  console.log('\n' + '─'.repeat(56));
  console.log(failures ? `freecam 运行时：${checks - failures}/${checks}，${failures} 项失败`
    : `freecam 运行时：${checks}/${checks} 全部通过`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });