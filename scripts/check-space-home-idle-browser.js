#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real home chrome, focus, pointer and touch behavior against local UI sources.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { readAssets } = require('./ui-assets');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/space-home-idle');

async function main() {
  const fixture = await startFixture();
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const assets = new Map(readAssets().map(asset => [asset.path, asset]));
    const errors = [];
    async function openHome(options = {}) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
      await fixture.connect(context);
      await context.route(fixture.base + '/**', async route => {
        const url = new URL(route.request().url());
        const asset = assets.get(url.pathname);
        if (asset) return route.fulfill({ status: 200,
          contentType: asset.mime === 'JS' ? 'application/javascript' : 'text/css',
          body: fs.readFileSync(asset.file) });
        if (url.pathname === '/') {
          const response = await route.fetch();
          const token = (await response.text()).match(/window\.__VMUSIC_TOKEN__\s*=\s*("[^"]+")/);
          assert.ok(token, 'authenticated fixture HTML');
          return route.fulfill({ response, body: fs.readFileSync(path.join(root, 'plugin/ui/index.html'), 'utf8')
            .replace('__VMUSIC_TOKEN_VALUE__', JSON.parse(token[1])) });
        }
        return route.continue();
      });
      const page = await context.newPage();
      // 软栅格化下一次往返就能排到上千毫秒，默认的 30 秒撑不住这里的点击和等待
      // （同 check-space-playback-browser.js 给 3D 检查的处理）。
      page.setDefaultTimeout(90000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('space3d').dataset.spReady === '1');
      await page.evaluate(() => Space3D.open());
      // 入场星门的收拢要等三维场景的第一帧。这个夹具强制 --use-angle=swiftshader，
      // 本机实测那一帧在主线程上一个任务里跑掉 25–28 秒（同 3D 检查给 90 秒的惯例），
      // 默认的 30 秒会在软栅格化下随机红。
      await page.waitForFunction(
        () => Space3D.stats().page === 'home' && document.getElementById('sp-warp').hidden,
        null, { timeout: 90000 });
      return page;
    }
    const page = await openHome();
    const hidden = () => page.locator('#space3d').evaluate(node => node.classList.contains('sp-home-idle'));
    const waitHidden = () => page.waitForFunction(() => document.getElementById('space3d').classList.contains('sp-home-idle'));
    // 指针事件走 CDP 输入通道，在软栅格化下会排在渲染队列后面；Node 侧睡完再读，量到的
    // 可能是「移动还没生效」的瞬间。要验移动的效果，先等它真的落进 DOM。
    const settled = (value) => page.waitForFunction(v => document.getElementById('space3d')
      .classList.contains('sp-home-idle') === v, value, { timeout: 90000 });
    // 收起时的 visibility 是 .space-home 上 .35s 的离散过渡（218f4e2 把它加进了 transition），
    // 半程才翻面；固定 sleep 是在猜时长，直接等计算值真的 hidden。
    const fadedOut = () => page.waitForFunction(() => getComputedStyle(document.getElementById('sp-home'))
      .visibility === 'hidden', null, { timeout: 90000 });
    // 「移动把卡片请回来」也一次量完（class 与 inert 在 homeIdle() 里同一次写）：
    // 拆成 settled→hidden→inert 三次往返时，后两次读到的可能已经是 3 秒定时器再次到点的状态。
    const restoreLands = () => page.evaluate(() => new Promise(resolve => {
      const root = document.getElementById('space3d');
      const up = () => !root.classList.contains('sp-home-idle') && document.getElementById('sp-home').inert === false;
      if (up()) return resolve(true);
      const observer = new MutationObserver(() => {
        if (!up()) return;
        observer.disconnect();
        resolve(true);
      });
      observer.observe(root, { attributes: true, attributeFilter: ['class'] });
      setTimeout(() => resolve(up()), 20000);
    }));
    fs.mkdirSync(output, { recursive: true });
    await page.mouse.move(700, 90);
    await page.screenshot({ path: path.join(output, 'visible.png') });
    // 原来这里是「睡 1800ms 再移动、再睡 1700ms，然后断言卡片还在」。那 1700 < 3000 只在
    // 「移动之前卡片已经收起过」时才证明重置：本机软栅格化下 screenshot 一次要 3–4 秒，
    // 3 秒定时器就在这次截图里到点，于是断言实际量到的是截图耗时，快一轮就红一轮。
    // 先等它真的收起，再移动，量的才是「移动把延时重新起表」。
    await waitHidden();
    await page.mouse.move(710, 90);
    // 「移动重置延时」必须在页面内一次量完：先等移动真的把卡片请回来，再从那一刻起页内睡
    // 1.7 秒（3 秒延时的余量）。拆成 Node 侧的 settled→sleep→hidden 三次往返时，
    // 软栅格化下单次 evaluate 就能排到上千毫秒之后，实测读到的会是 poke 后 3001ms 的状态，
    // 量的成了往返延迟而不是产品行为。
    const restarted = await page.evaluate(() => new Promise(resolve => {
      const root = document.getElementById('space3d');
      const up = () => !root.classList.contains('sp-home-idle');
      const watchdog = setTimeout(() => resolve(false), 20000);
      const done = value => { clearTimeout(watchdog); resolve(value); };
      const hold = () => setTimeout(() => done(up()), 1700);
      if (up()) return hold();
      const observer = new MutationObserver(() => {
        if (!up()) return;
        observer.disconnect();
        hold();
      });
      observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    }));
    assert.equal(restarted, true, 'movement restarts the idle delay');
    await waitHidden();
    await fadedOut();
    assert.equal(await page.locator('#sp-home').evaluate(node => node.inert), true, 'hidden cards cannot receive focus or clicks');
    assert.equal(await page.locator('#sp-home').isVisible(), false);
    assert.equal(await page.locator('#sh-query').isVisible(), true, 'search remains visible');
    assert.equal(await page.locator('#sp-page-toggle').isVisible(), true, 'navigation remains visible');
    await page.screenshot({ path: path.join(output, 'idle.png') });
    await page.mouse.move(720, 90);
    assert.equal(await restoreLands(), true, 'movement restores cards');
    await page.mouse.move(-5, -5);
    await settled(true);
    assert.equal(await hidden(), true, 'leaving the viewport immediately hides cards');
    await page.mouse.move(730, 90);
    assert.equal(await restoreLands(), true, 'reentry restores cards');
    // 「换一条」在语料请求整段禁用（space-home.js:545 fetch 前 disabled=true，finally 才放开）。
    // 直接在 disabled 上等点击会先等满 30 秒、期间卡片又按闲置淡出，报出来的是点击超时，
    // 看不出真正卡住的是语料没回填。
    await page.waitForFunction(() => {
      const next = document.querySelector('.sh-quote-next');
      return !!next && !next.disabled;
    }, null, { timeout: 90000 });
    await page.mouse.move(730, 91);
    await page.locator('.sh-quote-next').click();
    await waitHidden();
    await page.waitForTimeout(500);
    assert.equal(await hidden(), true, 'mouse focus losing access during hiding does not reveal cards again');
    await page.mouse.move(735, 90);
    // 库面板那颗按钮在 #sp-home 里面，卡片还收起着（visibility:hidden + pointer-events:none）
    // 时点击永远等不到可操作；先让「移动唤回卡片」真的落进 DOM。
    assert.equal(await restoreLands(), true, 'movement after the fade restores the cards');
    await page.locator('.sh-action-library').click();
    await page.waitForTimeout(3400);
    assert.equal(await hidden(), false, 'an open library panel prevents hiding');
    assert.equal(await page.locator('.sh-panel-layer').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    await page.locator('.sh-action-library').focus();
    await page.waitForTimeout(3400);
    assert.equal(await hidden(), false, 'keyboard focus keeps cards available');

    await page.mouse.click(740, 90);
    await waitHidden();
    // 这三处读的都是「动作那一刻」的状态，所以判据必须在页面内当场取：evaluate 往返落在
    // 软栅格化下可能晚于 3 秒定时器到点，读到的会是切换之后又自己收起的假红。
    const switched = await page.evaluate(() => {
      const pending = Space3D.enterStage();
      const cleared = () => !document.getElementById('space3d').classList.contains('sp-home-idle');
      const atSwitch = cleared();
      return Promise.resolve(pending).then(() => atSwitch);
    });
    assert.equal(switched, true, 'switching pages clears home idle');
    const backHome = await page.evaluate(() => {
      Space3D.goHome();
      return document.getElementById('sp-home').inert === false;
    });
    assert.equal(backHome, true, '回到首页时卡片立刻重新可聚焦');
    const reopened = await page.evaluate(() => {
      Space3D.close(); Space3D.open();
      return !document.getElementById('space3d').classList.contains('sp-home-idle');
    });
    assert.equal(reopened, true, 'reopening starts with visible cards');

    const touch = await openHome({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await touch.waitForTimeout(3400);
    assert.equal(await touch.locator('#space3d').evaluate(node => node.classList.contains('sp-home-idle')), false,
      'touch users retain access without mouse movement');
    await touch.locator('.sh-action-library').tap();
    assert.equal(await touch.locator('.sh-panel-layer').isVisible(), true);
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log('Space home idle: delay reset, fade, inert, leave/reentry, panels, keyboard, navigation and touch passed');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
