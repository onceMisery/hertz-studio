#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, 'plugin/ui', file), 'utf8');
const html = read('index.html');
const start = html.indexOf('<section class="home-dashboard"');
const markup = html.slice(start, html.indexOf('</section>', start) + 10);
const sprite = html.slice(html.indexOf('<svg'), html.indexOf('</svg>') + 6);
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent(sprite + '<main id="fixture" style="width:900px;margin:24px;max-width:calc(100% - 48px)">' + markup + '</main>');
    await page.addStyleTag({ content: read('style.css') });
    await page.addStyleTag({ content: read('home-dashboard.css') });
    await page.addScriptTag({ content: read('home-dashboard.js') });
    await page.evaluate(() => {
      window.testState = { current: { id: 'current', title: '晚风吹过旧街角', artist: '林间回声', cover: 'first' }, playing: false, queueLength: 3, intent: 0 };
      window.actions = []; window.coverRequests = []; window.historyRequests = [];
      HomeDashboard.bind({
        read: () => testState,
        readRecent: () => new Promise(resolve => historyRequests.push(resolve)),
        resume: () => { actions.push('resume'); testState = { ...testState, playing: true }; },
        playRecent: track => actions.push(['recent', track.id]), navigate: key => actions.push(key), notify: text => actions.push(['error', text]),
        cover: track => new Promise(resolve => coverRequests.push({ id: track.id, resolve })),
        applyCover: (img, url) => { if (url) img.src = url; else img.removeAttribute('src'); }
      });
      window.actionNode = document.getElementById('home-action');
    });
    assert.equal(await page.locator('#home-action').textContent(), '继续播放');
    assert.deepEqual(await page.evaluate(() => actions), []);
    await page.locator('#home-action').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#home-action').textContent(), '查看队列');
    assert.equal(await page.evaluate(() => document.activeElement === actionNode), true, 'button focus survives state update');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => actions), ['resume', 'queue']);
    await page.locator('#home-daily').click(); await page.locator('#home-recent').click();
    assert.deepEqual(await page.evaluate(() => actions.slice(-2)), ['daily', 'recent']);
    const layouts = [];
    for (const [width, light, large] of [[900, false, false], [460, true, false], [280, false, false], [320, true, true]]) {
      await page.evaluate(({ width, light, large }) => {
        document.getElementById('fixture').style.width = width + 'px';
        const style = document.documentElement.style;
        for (const [key, value] of Object.entries(light ? { '--bg': '#fafafa', '--panel-solid': '#ffffff', '--panel-2': '#f1f1f1', '--text': '#202020', '--muted': '#595959', '--line': '#dddddd', '--line-strong': '#aaaaaa', '--accent': '#242424', '--accent-ink': '#ffffff' }
          : { '--bg': '#0a0a0a', '--panel-solid': '#121213', '--panel-2': '#19191a', '--text': '#e8ecef', '--muted': '#a0a6af', '--line': '#26272b', '--line-strong': '#42444a', '--accent': '#ffffff', '--accent-ink': '#0a0a0a' })) style.setProperty(key, value);
        for (const [key, value] of Object.entries({ '--fs-base': large ? '28px' : '14px', '--fs-lg': large ? '32px' : '16px', '--fs-2xl': large ? '40px' : '20px' })) style.setProperty(key, value);
      }, { width, light, large });
      const result = await page.locator('#home-dashboard').evaluate(node => {
        const r = node.getBoundingClientRect();
        return { width: r.width, height: r.height, scrollWidth: node.scrollWidth,
          columns: getComputedStyle(node.querySelector('.home-layout')).gridTemplateColumns.split(' ').length,
          buttonsFit: [...node.querySelectorAll('button')].filter(b => !b.hidden).every(b => { const br = b.getBoundingClientRect(); return br.right <= r.right + 1 && br.left >= r.left - 1 && br.height >= 32; }) };
      });
      assert.ok(result.scrollWidth <= result.width + 1, 'no horizontal overflow at ' + width);
      assert.ok(result.buttonsFit, 'controls remain within the container at ' + width);
      assert.equal(result.columns, width > 560 ? 2 : 1);
      if (!large) assert.ok(result.height < 420, 'task entry stays compact at ' + width);
      layouts.push({ width, light, large, ...result });
    }
    await page.evaluate(() => { testState = { current: null, playing: false, queueLength: 0, intent: 1 }; HomeDashboard.onViewEnter(); });
    await page.evaluate(() => historyRequests.shift()(null));
    assert.equal(await page.locator('#home-action').textContent(), '添加音乐');
    await page.locator('#home-action').click(); assert.equal(await page.evaluate(() => actions.at(-1)), 'add');
    await page.evaluate(() => {
      testState = { current: { id: 'new', title: '新的选择', artist: '晚到封面不能覆盖', cover: 'second' }, playing: false, queueLength: 1, intent: 2 };
      HomeDashboard.update();
      coverRequests.find(x => x.id === 'new').resolve('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
      coverRequests.find(x => x.id === 'current').resolve('old-image');
    });
    await page.waitForTimeout(30);
    assert.ok((await page.locator('#home-art').getAttribute('src')).startsWith('data:'), 'late previous cover discarded');
    assert.equal(await page.evaluate(() => document.getElementById('home-action') === actionNode), true);
    assert.deepEqual(errors, []);
    const out = path.join(root, 'output/playwright/home-dashboard'); fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, 'narrow-large-type.png') });
    await page.evaluate(() => {
      document.getElementById('fixture').style.width = '900px';
      for (const [key, value] of Object.entries({ '--fs-base': '14px', '--fs-lg': '16px', '--fs-2xl': '20px' })) document.documentElement.style.setProperty(key, value);
    });
    await page.screenshot({ path: path.join(out, 'wide-light.png') });
    console.log(JSON.stringify(layouts));
    console.log('Home dashboard Chrome: current/recent/empty actions, stable focused DOM, late cover, light/dark and 280–900px containers with enlarged type passed.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
