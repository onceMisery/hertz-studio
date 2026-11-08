#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Isolated StageControl fixture: real DOM/CSS and native mouse/keyboard input.
// No application server, playback state, accounts or external network required.
// NODE_PATH=<directory containing playwright> node scripts/check-stage-control-browser.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.join(__dirname, '..');
const web = path.join(root, 'plugin/ui');
const output = path.join(root, 'output/playwright/stage-control');
const index = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const panel = index.slice(index.indexOf('<div class="stage-ctl"'), index.indexOf('<div id="ctx-menu"'));
const sprite = index.slice(index.indexOf('<svg id="icon-sprite"'), index.indexOf('</svg>') + 6);
assert.ok(panel.includes('id="sc-body"'), 'Fixture uses the current production panel');
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/design/design-base.css"><link rel="stylesheet" href="/components/form.css">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/stage.css">
<title>StageControl isolated check</title><body>
<button id="stage-control-btn" aria-controls="stage-ctl" aria-expanded="false">舞台控制</button>
${sprite}${panel}<script src="/design/design-themes.js"></script><script src="/themes.js"></script><script src="/stage-control.js"></script>
<script>Theme.init(); StageControl.init();</script></body></html>`;
const assets = new Map(['design/design-base.css', 'design/design-themes.js', 'components/form.css',
  'style.css', 'stage.css', 'themes.js', 'stage-control.js'].map(file =>
  ['/' + file, fs.readFileSync(path.join(web, file))]));
let checks = 0;
const errors = [];
function pass(label) { checks += 1; console.log('PASS ' + label); }
const values = page => page.evaluate(() => StageControl.values());
const writes = page => page.evaluate(() => window.fixtureWrites.length);
async function clearWrites(page) { await page.evaluate(() => { window.fixtureWrites.length = 0; }); }
const extraGroup = { id: 'extension', title: '扩展光场', aliases: ['custom controls'], items: [
  { key: 'extraGain', label: '扩展增益', aliases: ['gain'], min: 0, max: 10, step: 0.5, def: 1.2 },
], selects: [{ key: 'extraMode', label: '扩展模式', def: 'a', options: [['a', '模式甲'], ['b', '模式乙']] }] };

async function newPage(browser, base, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, ...options });
  await context.addInitScript(() => {
    window.fixtureWrites = [];
    window.fixtureDOMEvents = [];
    window.fixtureChanges = [];
    const save = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'vmusic.stage.control') {
        if (window.fixtureStorageFails) throw new DOMException('Fixture quota', 'QuotaExceededError');
        window.fixtureWrites.push(JSON.parse(value));
      }
      return save.call(this, key, value);
    };
    document.addEventListener('stagecontrol:change', event => window.fixtureChanges.push(event.detail));
    for (const name of ['input', 'change']) document.addEventListener(name, event => window.fixtureDOMEvents.push({ type: name, id: event.target.id }));
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  assert.equal(await page.locator('#stage-ctl').evaluate(el => el.inert), true);
  await page.locator('#stage-control-btn').click();
  assert.equal(await page.locator('#sc-search').evaluate(el => el === document.activeElement), true);
  return page;
}

async function rangePoint(page, id, value) {
  const range = page.locator('#' + id);
  await range.scrollIntoViewIfNeeded();
  const box = await range.boundingBox();
  const bounds = await range.evaluate(el => ({ min: Number(el.min), max: Number(el.max) }));
  return { x: box.x + 6 + (box.width - 12) * (value - bounds.min) / (bounds.max - bounds.min), y: box.y + box.height / 2 };
}

async function searchChecks(browser, base) {
  const page = await newPage(browser, base);
  try {
    const search = page.locator('#sc-search');
    await search.fill('文字大小');
    assert.equal(await page.locator('.sc-result').count(), 1);
    assert.match(await page.locator('.sc-result').innerText(), /歌词排版 › 歌词字号[\s\S]*100%/);
    pass('别名命中同一 schema，结果包含分组路径与当前值');
    await search.press('ArrowDown');
    assert.equal(await page.locator('.sc-result').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#sc-lyrics-lyricSize').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('#sc-lyrics-lyricSize').evaluate(el => el.closest('.sc-cell').classList.contains('is-found')), true);
    pass('搜索结果可通过方向键与 Enter 定位、聚焦并高亮原控件');
    const before = await values(page);
    await search.fill('');
    assert.deepEqual(await values(page), before);
    assert.equal(await page.locator('#sc-results').isVisible(), false);
    await search.fill('not-a-stage-parameter');
    assert.match(await page.locator('#sc-results').innerText(), /没有匹配/);
    pass('清空搜索不改变参数，空结果提供可见提示');
    await search.fill('镜头光学');
    assert.equal(await page.locator('.sc-result').count(), 5);
    await search.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.sc-result').nth(1).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.equal(await search.evaluate(el => el === document.activeElement), true);
    pass('分组命中全部参数，结果方向键可返回搜索框');
    await page.evaluate(() => {
      window.fixtureFreecam = document.getElementById('sc-cine-freecam');
      fixtureFreecam.style.display = 'none';
    });
    assert.equal(await page.evaluate(group => StageControl.addGroup(group), extraGroup), true);
    assert.equal(await page.locator('#sc-cine-freecam').evaluate(el => el === window.fixtureFreecam && el.style.display === 'none'), true);
    pass('动态分组追加不重建旧控件，保留消费者隐藏状态');
    await page.evaluate(() => { document.getElementById('sc-group-extension').hidden = true; });
    await search.fill('custom gain');
    assert.match(await page.locator('.sc-result').innerText(), /扩展光场 › 扩展增益[\s\S]*1/);
    await page.locator('.sc-result').click();
    assert.equal(await page.locator('#sc-group-extension').evaluate(el => el.hidden), false);
    assert.equal(await page.locator('#sc-extension-extraGain').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('ArrowRight');
    assert.equal((await values(page)).extraGain, 1.5);
    await page.locator('#sc-undo').click();
    assert.equal((await values(page)).extraGain, 1);
    pass('隐藏扩展组命中后展开，原控件可键盘调整与撤销');
    await search.fill('freecam');
    await page.locator('.sc-result').click();
    assert.match(await page.locator('#sc-status').innerText(), /当前不可用/);
    assert.equal(await page.locator('#sc-cine-freecam').isVisible(), false);
    pass('隐藏 freecam 不被搜索强制启用，显示不可用反馈');
    await page.locator('#sc-extension-extraGain').evaluate(el => el.remove());
    await search.fill('gain');
    await page.locator('.sc-result').click();
    assert.match(await page.locator('#sc-status').innerText(), /已移除/);
    pass('已移除控件不会静默定位失败');
    await search.focus();
    await page.keyboard.press('Escape');
    assert.equal(await search.inputValue(), '');
    assert.equal(await page.evaluate(() => StageControl.isOpen()), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => StageControl.isOpen()), false);
    assert.equal(await page.locator('#stage-ctl').evaluate(el => el.inert), true);
    assert.equal(await page.locator('#stage-control-btn').evaluate(el => el === document.activeElement), true);
    pass('Escape 先清查询再关闭，关闭后焦点返回入口且面板退出 Tab 顺序');
  } finally { await page.context().close(); }
}

async function transactionChecks(browser, base) {
  const page = await newPage(browser, base);
  try {
    const range = page.locator('#sc-lens-bokeh');
    const start = await rangePoint(page, 'sc-lens-bokeh', 3);
    const end = await rangePoint(page, 'sc-lens-bokeh', 16);
    await clearWrites(page);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    assert.equal((await values(page)).bokeh, 16);
    assert.equal(await writes(page), 0);
    assert.match(await page.locator('#sc-status').innerText(), /调整中/);
    await page.mouse.up();
    assert.equal(await writes(page), 1);
    assert.match(await page.locator('#sc-status').innerText(), /更改已保存/);
    const eventCount = await page.evaluate(() => fixtureDOMEvents.length);
    await page.locator('#sc-undo').click();
    assert.equal((await values(page)).bokeh, 3);
    assert.equal(await page.locator('#sc-undo').isDisabled(), true);
    assert.equal(await page.evaluate(() => fixtureDOMEvents.length), eventCount);
    pass('实际拖动连续预览、松手保存一次、一次撤销恢复起点且不伪造 DOM 事件');
    await range.focus();
    await clearWrites(page);
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowRight');
    assert.equal((await values(page)).bokeh, 6);
    assert.equal(await writes(page), 0);
    assert.match(await page.locator('#sc-status').innerText(), /调整中/);
    await page.keyboard.up('ArrowRight');
    assert.equal(await writes(page), 1);
    await page.keyboard.press('Control+z');
    assert.equal((await values(page)).bokeh, 3);
    assert.equal(await page.locator('#sc-undo').isDisabled(), true);
    pass('长按方向键的原生 change 事件合并为一次动作，Ctrl+Z 撤销');
    await page.evaluate(() => StageControl.set({ bokeh: 20 }));
    await clearWrites(page);
    await range.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await writes(page), 0);
    assert.equal(await page.locator('#sc-undo').isDisabled(), true);
    pass('边界上的零变化键盘调整不写存储或历史');
    await page.evaluate(() => StageControl.set({ bokeh: 3 }));
    const cancelledStart = await rangePoint(page, 'sc-lens-bokeh', 3);
    const cancelledEnd = await rangePoint(page, 'sc-lens-bokeh', 10);
    await clearWrites(page);
    await page.mouse.move(cancelledStart.x, cancelledStart.y);
    await page.mouse.down();
    await page.mouse.move(cancelledEnd.x, cancelledEnd.y, { steps: 6 });
    // Browser automation cannot cancel hardware capture; dispatch only the cancel boundary.
    await range.dispatchEvent('pointercancel');
    await page.mouse.up();
    assert.equal(await writes(page), 1);
    await page.locator('#sc-undo').click();
    assert.equal((await values(page)).bokeh, 3);
    pass('取消手势提交最后可见值且只保留一条可撤销记录');
    await range.focus();
    await page.keyboard.down('ArrowRight');
    await page.evaluate(() => StageControl.set({ bokeh: 12 }));
    await page.keyboard.up('ArrowRight');
    assert.equal(await page.locator('#sc-undo').isDisabled(), true);
    assert.equal((await values(page)).bokeh, 12);
    await page.keyboard.press('ArrowRight');
    await page.locator('#sc-undo').click();
    assert.equal((await values(page)).bokeh, 12);
    pass('进行中的调整被程序化 set 覆盖后，旧历史不能覆盖新基准');
    await range.focus();
    await page.keyboard.down('ArrowRight');
    await page.locator('#sc-search').focus();
    await page.keyboard.up('ArrowRight');
    await page.locator('#sc-undo').click();
    assert.equal((await values(page)).bokeh, 12);
    pass('失焦提交未结束的键盘事务');
  } finally { await page.context().close(); }
}

async function historyChecks(browser, base) {
  const page = await newPage(browser, base);
  try {
    const dust = page.locator('#sc-motion-dust');
    await dust.click();
    assert.equal((await values(page)).dust, false);
    await page.locator('#sc-undo').click();
    assert.equal((await values(page)).dust, true);
    await page.locator('#sc-lyrics-lyricFont [data-value="mono"]').click();
    await page.locator('#sc-undo').click();
    assert.equal((await values(page)).lyricFont, 'system');
    await page.locator('#sc-lyrics-lyricColor').fill('#123456');
    assert.equal((await values(page)).lyricColor, '#123456');
    await page.locator('.sc-color-auto').click();
    assert.equal((await values(page)).lyricColor, '');
    await page.locator('#sc-undo').click();
    assert.equal((await values(page)).lyricColor, '#123456');
    await page.locator('#sc-undo').click();
    assert.equal((await values(page)).lyricColor, '');
    pass('开关、下拉、颜色与自动颜色均进入同一撤销路径');
    await page.evaluate(() => StageControl.set({ bokeh: 9, chroma: 8, enabled: false }));
    await page.locator('#sc-reset').click();
    assert.equal((await values(page)).enabled, false);
    await page.evaluate(() => StageControl.set({ chroma: 5 }));
    await page.locator('#sc-undo').click();
    assert.deepEqual(await page.evaluate(() => { const v = StageControl.values(); return [v.bokeh, v.chroma, v.enabled]; }), [9, 5, false]);
    assert.equal(await page.locator('#sc-undo').isDisabled(), true);
    pass('恢复默认是一条多键记录，撤销保留总开关与之后的程序化设置');
    for (let i = 0; i < 45; i += 1) await dust.click();
    const undone = await page.evaluate(() => {
      let count = 0;
      while (StageControl.undo()) count += 1;
      return count;
    });
    assert.equal(undone, 40);
    assert.equal(await page.locator('#sc-undo').isDisabled(), true);
    pass('45 次真实点击最多保留最近 40 步历史');
    await page.evaluate(() => { window.fixtureStorageFails = true; });
    await dust.click();
    assert.match(await page.locator('#sc-status').innerText(), /无法保存/);
    assert.doesNotMatch(await page.locator('#sc-status').innerText(), /已保存/);
    const changed = (await values(page)).dust;
    await page.locator('#sc-undo').click();
    assert.equal((await values(page)).dust, !changed);
    assert.match(await page.locator('#sc-status').innerText(), /无法保存/);
    pass('存储失败明确提示，仍可应用与撤销，不谎称已保存');
    await page.evaluate(() => { window.fixtureStorageFails = false; });
    await dust.click();
    assert.match(await page.locator('#sc-status').innerText(), /更改已保存/);
    pass('存储恢复后正常保存并更新反馈');
  } finally { await page.context().close(); }
}

async function visualChecks(browser, base) {
  for (const theme of ['mineral', 'ios-light']) {
    for (const width of [1200, 390, 320]) {
      const page = await newPage(browser, base, { viewport: { width, height: 800 }, reducedMotion: 'reduce' });
      try {
        await page.evaluate(themeId => Theme.apply(themeId), theme);
        await page.locator('#sc-search').fill('歌词');
        const layout = await page.evaluate(() => {
          const panel = document.getElementById('stage-ctl');
          const body = document.getElementById('sc-body');
          return { panel: panel.getBoundingClientRect().width, viewport: innerWidth,
            panelOverflow: panel.scrollWidth > panel.clientWidth + 1,
            bodyOverflow: body.scrollWidth > body.clientWidth + 1,
            toolsOverflow: document.querySelector('.sc-search-row').scrollWidth > panel.clientWidth,
            bodyHeight: body.clientHeight, transition: getComputedStyle(panel).transitionDuration };
        });
        assert.ok(layout.panel <= layout.viewport && !layout.panelOverflow && !layout.bodyOverflow && !layout.toolsOverflow, JSON.stringify(layout));
        assert.ok(layout.bodyHeight > 100, JSON.stringify(layout));
        // Global style.css preserves transitionend with a 0.01ms duration.
        assert.ok(parseFloat(layout.transition) <= 0.00001, layout.transition);
        await page.locator('#sc-lyrics-lyricSize').evaluate(el => {
          const cell = el.closest('.sc-cell');
          const original = cell.scrollIntoView;
          cell.scrollIntoView = function (options) { window.fixtureScroll = options; original.call(this, options); };
        });
        await page.locator('[data-key="lyricSize"]').click();
        assert.equal(await page.evaluate(() => fixtureScroll.behavior), 'auto');
        assert.ok(await page.locator('#sc-lyrics-lyricSize').evaluate(el => parseFloat(getComputedStyle(el.closest('.sc-cell')).transitionDuration) <= 0.00001));
        const focusedVisible = await page.locator('#sc-lyrics-lyricSize').evaluate(el => {
          const control = el.getBoundingClientRect(), host = document.getElementById('sc-body').getBoundingClientRect();
          return control.top >= host.top && control.bottom <= host.bottom;
        });
        assert.equal(focusedVisible, true);
        await page.screenshot({ path: path.join(output, `${theme}-${width}.png`) });
        await page.waitForFunction(() => !document.querySelector('.sc-cell.is-found'));
        pass(`${theme} ${width}px：无横向溢出，原控件可见，减少动效定位且高亮自动清除`);
      } finally { await page.context().close(); }
    }
  }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fixture); return; }
    if (!assets.has(request.url)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
    response.end(assets.get(request.url));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    await searchChecks(browser, base);
    await transactionChecks(browser, base);
    await historyChecks(browser, base);
    await visualChecks(browser, base);
    assert.deepEqual(errors, [], 'No browser exceptions');
    pass('浏览器无未捕获异常');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, errors, fixture: 'isolated, ephemeral port; no business API' }, null, 2));
    console.log(`\n舞台控制浏览器：${checks} 项场景，全部通过。截图：${output}`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });


