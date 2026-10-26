// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 舞台控制舱「真3D 语境」的浏览器契约。静态检查（check-stage-control.js）
// 钉得住机制，钉不住这一类故障：inert 元素照常绘制、整体退出命中测试，
// z-index 提到多高都点不进去且不报任何错——只有真实点击能裁决。所以这里
// 全部用真实鼠标事件，不用 elementFromPoint（它对带 backdrop-filter 的
// 合成层会说谎：面板明明画在最上层，命中栈里却没有它）。
//
//   node scripts/check-stage-control-3d-browser.js
//   HERTZ_BIN=path/to/hertz-studio node scripts/check-stage-control-3d-browser.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { uiUrl } = require('./ui-token');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/stage-control-3d');
const errors = [];
let passed = 0;
const pass = (name) => { passed += 1; console.log('PASS ' + name); };

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const fixture = await startFixture();
  process.env.VMUSIC_DATA_DIR = fixture.dataDir;
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    headless: process.env.SC_HEADED !== '1',
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await fixture.connect(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // fixture 的部分子资源仍走未带令牌的路径，与本契约无关。
    if (m.type() === 'error' && !/401/.test(m.text())) errors.push('console: ' + m.text());
  });

  try {
    await page.goto(uiUrl(fixture.base));
    await page.waitForFunction(() => window.Stage3D && window.StageControl
      && document.getElementById('conn').textContent === '服务已连接');
    await page.evaluate(() => Stage3D.open());
    await page.waitForFunction(() => Stage3D.isActive());
    await page.waitForTimeout(500);

    // —— 语境自动跟随：三维舞台 + 沉浸声场 → 真3D ——
    await page.evaluate(() => StageControl.open());
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => StageControl.context()), '3d', '真3D 语境');
    pass('三维舞台上开舱自动进真3D 语境');

    // —— 真实点击：舱体在 3D 舞台上可交互（inert 陷阱的守卫） ——
    const zodiacBtn = page.locator('#sc-3d-body .sc-seg-btn', { hasText: '星座' });
    await zodiacBtn.scrollIntoViewIfNeeded();
    await zodiacBtn.click();
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => Stage3D.preferences().sceneSource), 'zodiac',
      '真实点击切换舞台来源');
    assert.ok(await page.evaluate(() =>
      !![...document.querySelectorAll('#sc-3d-body button')].find((b) => b.textContent === '背景星云')),
      '来源专属重织出星座控件');
    pass('舱体在三维舞台之上可交互（没有被 inert 静音）');

    // —— 药丸写回 ——
    await page.locator('#sc-3d-body .sc-pill', { hasText: '显示歌词' }).click();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => Stage3D.preferences().lyrics), false, '药丸写布尔');
    pass('药丸开关真实点击写回偏好');

    // —— 滑块：真实拖动写回，写回值落在 clamp 域内 ——
    const box = await page.locator('#sc-3d-reactivity').boundingBox();
    assert.ok(box, '律动滑块可见可点');
    const before = await page.evaluate(() => Stage3D.preferences().reactivity);
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
    await page.mouse.down();
    // 约 40ms/步：零间隔连发会让相邻事件同戳，消费方拿到 dt≈0 的假手势
    await page.mouse.move(box.x + box.width * 0.28, box.y + box.height / 2, { steps: 8, delay: 40 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => Stage3D.preferences().reactivity);
    assert.ok(Math.abs(after - before) > 0.2, `滑块拖动写回（${before} → ${after}）`);
    assert.ok(after > 0 && after < 2, '写回值在 clamp 域内');
    pass('滑块真实拖动写回偏好表');

    // —— 语境跟随舞台：没有手动互切，退出三维就回二维 ——
    assert.equal(await page.evaluate(() => !!document.getElementById('sc-context-3d')), false,
      '舱内没有手动「三维舞台」分段');
    await page.evaluate(() => Stage3D.close());
    await page.waitForFunction(() => !Stage3D.isActive());
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => StageControl.context()), 'flat',
      '退出三维后舱自动回到二维语境');
    const flat = await page.evaluate(() => ({
      pills: document.querySelectorAll('#sc-body .sc-pill').length,
      oldSwitch: document.querySelectorAll('.sc-switch').length,
      presets: [...document.querySelectorAll('#sc-body .sc-seg-btn')].map((b) => b.textContent.trim()),
    }));
    assert.ok(flat.pills >= 5, '开关已换成药丸');
    assert.equal(flat.oldSwitch, 0, '旧小开关无残留');
    assert.ok(flat.presets.includes('第一现场 · 舞台') && flat.presets.includes('纸雕剧场'),
      '二维首屏仍有二维舞台场景');
    await page.screenshot({ path: path.join(output, 'flat-context.png') });
    pass('二维语境：场景预设与药丸都在，三维来源不出现');

    await page.evaluate(() => Stage3D.open());
    await page.waitForFunction(() => Stage3D.isActive());
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => StageControl.context()), '3d',
      '重新进入三维后舱自动回到三维语境');
    await page.screenshot({ path: path.join(output, '3d-context.png') });
  } finally {
    if (errors.length) console.log('页面错误：\n' + errors.join('\n'));
    await browser.close();
    await fixture.close();
  }
  assert.equal(errors.length, 0, '无页面错误');
  console.log(`\n舞台控制真3D 浏览器契约：${passed} 项通过`);
}

main().catch((e) => { console.error(e); process.exit(1); });
