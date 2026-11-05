#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Hertz retained topbar menus: opening the theme chooser closes more tools;
// opening more tools closes the theme chooser; Escape/outside-click remain usable.
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');

(async () => {
  const fixture = await startFixture();
  let browser;
  try {
    await fixture.seed();
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await fixture.connect(ctx);
    const page = await ctx.newPage();
  await require('./ui-source-assets').routeSourceAssets(page, fixture);
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar');
    await page.waitForTimeout(300);

    const visible = sel => page.locator(sel).isVisible();

    // 自 e80af65 起主题色/界面皮肤按钮收进 #top-more-menu：菜单收起时按钮不可点，
    // 所以每段交互都先开更多工具菜单再点目标按钮。互斥判定口径不变。
    // ① 从更多工具菜单里开主题色菜单：更多工具必须先收（广播互斥，
    //    修复前两个叠着开）。
    await page.click('#top-more-btn');
    await page.click('#theme-btn');
    assert.ok(await visible('#theme-menu'), '主题色菜单能打开');
    assert.equal(await visible('#top-more-menu'), false, '开主题色菜单时更多工具必须收起');

    await page.click('#top-more-btn');
    assert.ok(await visible('#top-more-menu'), '更多工具能打开');
    assert.equal(await visible('#theme-menu'), false, '开更多工具时主题色菜单收起');
    await page.click('#top-more-btn');
    assert.equal(await visible('#top-more-menu'), false, '再次点击更多工具关闭菜单');

    // ③ 原有开合路径一个都不能被广播破坏（按钮在收起的菜单里，重按 toggle
    //    已不可达，关闭路径只剩 Escape 与点外部）。
    await page.click('#top-more-btn');
    await page.click('#theme-btn');
    await page.keyboard.press('Escape');
    assert.equal(await visible('#theme-menu'), false, 'Escape 照常收起主题色菜单');
    await page.click('#top-more-btn');
    await page.click('#theme-btn');
    await page.mouse.click(400, 500); // 点外部照常收
    assert.equal(await visible('#theme-menu'), false, '点外部照常收起主题菜单');

    assert.equal(errors.length, 0, '页面无运行时错误：' + errors.join(' | '));
    console.log('check-topbar-popup-browser: all green');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
