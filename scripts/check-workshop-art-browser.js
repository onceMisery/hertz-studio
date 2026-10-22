// SPDX-License-Identifier: MIT
// Real CSS animation and production Workshop lifecycle; no service or GPU stage needed.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output/playwright/workshop-art');

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent('<body><button id="workshop-btn">工坊</button><div id="stage3d"></div>' +
      '<aside id="workshop" class="ws-panel" hidden><p class="ws-sub"></p><button id="ws-close">关闭</button>' +
      '<div id="ws-stage-status"><strong></strong><span></span></div><div id="ws-tabs"></div>' +
      '<div id="ws-body" class="ws-body"></div><div id="ws-toast" hidden></div></aside></body>');
    await page.addStyleTag({ path: path.join(root, 'plugin/ui/creative-anime.css') });
    await page.addStyleTag({ content: 'body{margin:0;background:#152320;color:#dce4df;font:14px system-ui}#workshop{width:840px;margin:24px auto}#ws-body{height:820px;overflow:auto;padding:16px}.ws-anime-gallery{margin-top:0}button{font:inherit}#ws-tabs{display:flex;gap:8px}#ws-stage-status{padding:8px}.ws-guide,.sc-grid,.ws-scene-grid{min-height:240px}.ws-scene-art{max-width:100%}' });
    await page.evaluate(() => {
      window.Stage = { gate() {}, kick() {}, position: () => 0 };
      let active = false, prefs = { sceneSource: 'immersive' };
      window.Stage3D = { preferences: () => prefs, configure: next => Object.assign(prefs, next),
        save() {}, stages: () => [], isActive: () => active, open: () => { active = true; }, onVisualChange() {} };
    });
    for (const file of ['creative-gl.js', 'creative-anime.js', 'creative-stage.js', 'workshop.js']) {
      await page.addScriptTag({ path: path.join(root, 'plugin/ui', file) });
    }
    await page.evaluate(() => { CreativeStage.init(); Workshop.init(); Workshop.setTab('scene'); Workshop.open(); Workshop.setTab('scene'); });
    const artCount = await page.locator('.ws-anime-preview').count();
    if (!artCount) {
      assert.equal(await page.locator('.ws-anime-gallery').count(), 0,
        'a disabled gallery does not leave partial illustration UI');
      assert.deepEqual(errors, [], 'no browser errors');
      console.log('SKIP anime gallery animation checks: the gallery is disabled in this Workshop build');
      return;
    }
    assert.equal(artCount, 4, 'enabled gallery renders all four illustrations');
    assert.equal(await page.evaluate(() => Workshop.isEditingAdvanced()), true, 'advanced editing reports its actual target');
    const card = page.locator('.ws-anime-card').first();
    const cardBounds = await card.boundingBox();
    await card.hover();
    await page.waitForTimeout(300);
    assert.deepEqual(await card.boundingBox(), cardBounds, 'hover never moves or resizes the picture');
    const moving = () => page.evaluate(() => [...document.querySelectorAll('.ws-anime-preview')].map(el =>
      el.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length));
    await page.waitForFunction(() => [...document.querySelectorAll('.ws-anime-preview')].every(el =>
      el.getAnimations({ subtree: true }).some(a => a.playState === 'running')));
    const initial = await moving();
    await page.evaluate(() => { document.querySelector('#ws-body').scrollTop = 10000; });
    await page.waitForFunction(() => [...document.querySelectorAll('.ws-anime-preview')].every(el => el.dataset.motion === 'paused'));
    assert.deepEqual(await moving(), [0, 0, 0, 0], 'offscreen illustration animations must pause');
    await page.evaluate(() => { document.querySelector('#ws-body').scrollTop = 0; });
    await page.waitForFunction(() => [...document.querySelectorAll('.ws-anime-preview')].every(el =>
      el.getAnimations({ subtree: true }).some(a => a.playState === 'running')));
    await page.locator('.ws-anime-motion-toggle').click();
    assert.deepEqual(await moving(), [0, 0, 0, 0], 'explicit pause freezes all illustrations');
    await page.locator('.ws-anime-motion-toggle').click();
    await page.evaluate(() => { document.querySelector('#ws-body').scrollTop = 0; });
    await page.waitForFunction(() => [...document.querySelectorAll('.ws-anime-preview')].every(el => el.dataset.motion === 'running'));
    const changes = await page.evaluate(async () => {
      const nodes = [...document.querySelectorAll('.ws-anime-preview')];
      const sample = el => [...el.querySelectorAll('*')].map(n => getComputedStyle(n).transform + '/' + getComputedStyle(n).opacity).join('|');
      const before = nodes.map(sample);
      await new Promise(resolve => setTimeout(resolve, 500));
      return nodes.map((el, i) => before[i] !== sample(el));
    });
    assert.deepEqual(changes, [true, true, true, true], 'every composition changes without hover or audio');
    await page.locator('.ws-anime-gallery').focus();
    await page.keyboard.press('Space');
    assert.deepEqual(await moving(), [0, 0, 0, 0], 'space pauses when the gallery has focus');
    const phaseBefore = await page.evaluate(async () => { const a = document.querySelector('.cx-rail-train').getAnimations()[0]; await a.ready; return a.currentTime; });
    await page.keyboard.press('ArrowRight');
    const speed = await page.evaluate(async () => {
      const animation = document.querySelector('.cx-rail-train').getAnimations()[0];
      await animation.ready;
      return { rate: animation.playbackRate, phase: animation.currentTime };
    });
    assert.equal(speed.rate, 1.25, 'right arrow speeds up the illustrations');
    assert.ok(Math.abs(speed.phase - phaseBefore) < 2, 'changing speed while paused preserves the phase');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Space');
    await page.evaluate(() => { document.querySelector('#ws-body').scrollTop = 0; });
    await page.locator('.ws-anime-gallery').screenshot({ path: path.join(out, 'gallery.png') });
    for (const mode of ['system', 'body', 'html']) {
      if (mode === 'system') await page.emulateMedia({ reducedMotion: 'reduce' });
      else await page.evaluate(mode => mode === 'body' ? document.body.classList.add('reduce-motion') : document.documentElement.setAttribute('data-rm', 'ui'), mode);
      assert.deepEqual(await moving(), [0, 0, 0, 0], mode + ' reduced motion respected');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.evaluate(() => { document.body.classList.remove('reduce-motion'); document.documentElement.removeAttribute('data-rm'); });
    }
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.deepEqual(await moving(), [0, 0, 0, 0], 'hidden document pauses artwork');
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await page.locator('#ws-scene-anime-rail').click();
    assert.equal(await page.evaluate(() => CreativeStage.scene()), 'anime-rail', 'real scene selection preserved');
    await page.evaluate(() => {
      window.oldArt = [...document.querySelectorAll('.ws-anime-preview')];
      Workshop.setTab('params');
    });
    assert.equal(await page.locator('.ws-anime-preview').count(), 0, 'tab navigation releases old artwork');
    assert.equal(await page.evaluate(() => oldArt.some(el => el.isConnected)), false);
    await page.evaluate(() => { Workshop.setTab('scene'); Workshop.close(); });
    assert.equal(await page.evaluate(() => Workshop.isEditingAdvanced()), false, 'closing the editor releases fixed composition for 3D scenes');
    assert.deepEqual(await moving(), [0, 0, 0, 0], 'closing the workshop stops all illustration work');
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('scene'); });
    const layouts = [];
    for (const width of [840, 400, 360, 320]) {
      await page.setViewportSize({ width: Math.max(360, width), height: 1080 });
      await page.evaluate(width => { document.querySelector('#workshop').style.width = width + 'px'; }, width);
      const layout = await page.evaluate(() => {
        const el = document.querySelector('.ws-anime-grid');
        return { width: el.clientWidth, scroll: el.scrollWidth, cards: [...el.children].map(c => Math.round(c.getBoundingClientRect().width)) };
      });
      assert.ok(layout.scroll <= layout.width + 1, 'gallery fits ' + width + 'px container');
      layouts.push({ container: width, ...layout });
      if (width === 360) await page.locator('.ws-anime-gallery').screenshot({ path: path.join(out, 'mobile.png') });
    }
    assert.deepEqual(errors, [], 'no browser errors');
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ initial, changes, layouts, errors }, null, 2));
    console.log('PASS four moving illustrations, visibility lifecycle, pause, reduced motion, selection and responsive layout');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
