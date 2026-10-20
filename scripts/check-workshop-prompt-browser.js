// SPDX-License-Identifier: MIT
// Real Workshop prompt flow; no service, model, or GPU stage needed.
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent('<body><button id="workshop-btn">工坊</button><div id="stage3d"></div>' +
      '<aside id="workshop" class="ws-panel" hidden><p class="ws-sub"></p><button id="ws-close">关闭</button>' +
      '<div id="ws-stage-status"><strong></strong><span></span></div><div id="ws-tabs"></div>' +
      '<div id="ws-body" class="ws-body"></div><div id="ws-toast" hidden></div></aside></body>');
    await page.evaluate(() => {
      window.Stage = { gate() {}, kick() {}, position: () => 0 };
      let active = false, prefs = { sceneSource: 'immersive' };
      window.Stage3D = { preferences: () => prefs, configure: next => Object.assign(prefs, next),
        save() {}, stages: () => [], isActive: () => active, open: () => { active = true; }, onVisualChange() {} };
    });
    for (const file of ['creative-gl.js', 'creative-stage.js', 'creative-prompt.js', 'workshop.js']) {
      await page.addScriptTag({ path: path.join(root, 'plugin/ui', file) });
    }
    await page.evaluate(() => { CreativeStage.init(); Workshop.init(); Workshop.open(); Workshop.setTab('prompt'); });
    await page.locator('#ws-prompt-text').waitFor();

    await page.locator('#ws-prompt-text').fill('😀'.repeat(513));
    assert.equal(await page.locator('#ws-prompt-text').evaluate(input => Array.from(input.value).length), 512,
      'the prompt input limit counts Unicode code points');
    assert.equal(await page.locator('.ws-prompt-meta .sc-value').textContent(), '512 / 512',
      'the prompt counter uses the same Unicode code point limit');

    const before = await page.evaluate(() => JSON.stringify(CreativeStage.preset()));
    await page.locator('#ws-prompt-text').fill('星云，不要蓝色');
    await page.getByRole('button', { name: '解析' }).click();
    await page.waitForFunction(() => document.querySelector('.ws-prompt-result')?.textContent.includes('未识别约束'));
    assert.equal(await page.getByRole('button', { name: '应用到当前舞台' }).isDisabled(), true,
      'unrecognized visual constraints cannot be applied');
    assert.equal(await page.evaluate(() => JSON.stringify(CreativeStage.preset())), before,
      'a rejected constraint leaves the stage untouched');

    await page.locator('#ws-prompt-text').fill('Take my last saved nebula and increase its current density by 20 percent.');
    await page.getByRole('button', { name: '解析' }).click();
    await page.waitForFunction(() => document.querySelector('.ws-prompt-result')?.textContent.includes('不支持的编辑要求'));
    assert.equal(await page.getByRole('button', { name: '应用到当前舞台' }).isDisabled(), true,
      'unsupported relative edits cannot be applied');
    assert.equal(await page.evaluate(() => JSON.stringify(CreativeStage.preset())), before,
      'a rejected relative edit leaves the stage untouched');

    await page.locator('#ws-prompt-text').fill('新建球体，半径恰好为 2.5');
    await page.getByRole('button', { name: '解析' }).click();
    await page.waitForFunction(() => document.querySelector('.ws-prompt-result')?.textContent.includes('球半径 = 2.5'));
    assert.equal(await page.getByRole('button', { name: '应用到当前舞台' }).isDisabled(), false,
      'an in-range scene parameter is applicable');
    await page.getByRole('button', { name: '应用到当前舞台' }).click();
    await page.waitForFunction(() => CreativeStage.scene() === 'orb'
      && CreativeStage.preset().sc.radius === 2.5);
    await page.getByRole('button', { name: '撤销本次应用' }).click();
    await page.waitForFunction(expected => JSON.stringify(CreativeStage.preset()) === expected, before);

    await page.locator('#ws-prompt-text').fill('星云 蓝色赛博朋克');
    await page.getByRole('button', { name: '解析' }).click();
    assert.equal(await page.getByRole('button', { name: '应用到当前舞台' }).isDisabled(), false,
      'a recognized scene remains applicable with descriptive free text');
    await page.getByRole('button', { name: '应用到当前舞台' }).click();
    await page.waitForFunction(() => CreativeStage.scene() === 'nebula');
    await page.getByRole('button', { name: '撤销本次应用' }).click();
    await page.waitForFunction(expected => JSON.stringify(CreativeStage.preset()) === expected, before);

    await page.getByRole('button', { name: '应用到当前舞台' }).click();
    await page.waitForFunction(() => CreativeStage.scene() === 'nebula');
    await page.evaluate(() => CreativeStage.setParam('cam.yaw', CreativeStage.preset().cam.yaw + 5));
    assert.equal(await page.locator('#ws-prompt-undo').isHidden(), true,
      'a later manual edit invalidates the prompt undo snapshot');
    assert.equal(await page.evaluate(() => CreativeStage.scene()), 'nebula',
      'invalidating undo preserves the newly applied scene');

    assert.deepEqual(errors, [], 'no browser errors');
    console.log('PASS prompt UI enforces Unicode limits, validates scene parameters, rejects unsupported edits, applies intent, and invalidates stale undo');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
