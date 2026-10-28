// SPDX-License-Identifier: MIT
// Real sandbox clicks and production online row geometry; no network or audio.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ui = path.resolve(__dirname, '../plugin/ui');
const read = file => fs.readFileSync(path.join(ui, file), 'utf8');
async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent('<iframe sandbox="allow-scripts" style="width:100%;height:760px" srcdoc="<body></body>"></iframe>');
    const frame = page.frames().find(item => item !== page.mainFrame());
    await frame.addScriptTag({ content: read('host.js') });
    await frame.evaluate(() => {
      window.counts = { native: 0, search: 0, chat: 0 };
      document.body.innerHTML = '<form id="native"><input><button>原生提交</button></form><form id="search"><input aria-label="搜索词" required><button><span>搜索</span></button></form><form id="chat"><textarea aria-label="弹幕"></textarea><button>发送弹幕</button></form>';
      document.querySelector('#native').onsubmit = event => { event.preventDefault(); counts.native++; };
      for (const name of ['search', 'chat']) hertzHost.onSubmit(document.getElementById(name), () => counts[name]++);
    });
    await frame.getByRole('button', { name: '原生提交', exact: true }).click();
    assert.equal(await frame.evaluate(() => counts.native), 0, 'sandbox blocks native submit events');
    await frame.getByRole('button', { name: '搜索', exact: true }).click();
    assert.equal(await frame.evaluate(() => counts.search), 0, 'required constraint remains enforced');
    const query = frame.getByRole('textbox', { name: '搜索词', exact: true });
    await query.fill('夜航');
    await frame.getByText('搜索', { exact: true }).click();
    await query.press('Enter');
    assert.equal(await frame.evaluate(() => counts.search), 2, 'nested icon click and Enter submit exactly once each');
    const chat = frame.getByRole('textbox', { name: '弹幕', exact: true });
    await chat.fill('第一行'); await chat.press('Enter');
    assert.equal(await frame.evaluate(() => counts.chat), 0, 'textarea Enter remains a newline');
    await frame.getByRole('button', { name: '发送弹幕', exact: true }).click();
    assert.equal(await frame.evaluate(() => counts.chat), 1);

    await page.setContent('<section id="view-online"><div id="rows"></div></section>');
    for (const file of ['style.css', 'online.css', 'skins/skin.orbit.css']) await page.addStyleTag({ content: read(file) });
    await page.addScriptTag({ content: read('online.js') });
    await page.evaluate(() => {
      document.documentElement.dataset.skin = 'orbit';
      window.HertzRoom = { addOnline: async () => {} };
      window.Favorites = { attachHeart(parent) { const button = document.createElement('button'); button.className = 't-act'; button.textContent = '♡'; parent.prepend(button); } };
      Online.bind({ state: {}, fmt: () => '4:35', paintArt() {}, addToPlaylistMenu() {} });
      document.getElementById('rows').append(Online.row({ source: 'netease', id: '287719', title: '开始懂了', artist: '孙燕姿', album: '我要的幸福', duration_ms: 275000, playable: true }, () => {}));
    });
    for (const width of [1970, 1280, 1240, 1024, 900, 700, 560, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator('.online-row').hover();
      const geometry = await page.locator('.online-row').evaluate(row => {
        const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        const duration = rect(row.querySelector('.t-dur')), buttons = [...row.querySelectorAll('.t-actions button')].map(rect);
        const overlaps = (a, b) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
        return { buttons: buttons.length, safe: buttons.every((a, i) => a.width >= 28 && a.height >= 28 && a.x >= 0 && a.right <= innerWidth && !overlaps(a, duration) && buttons.slice(i + 1).every(b => !overlaps(a, b))) };
      });
      assert.equal(geometry.buttons, 4);
      assert.ok(geometry.safe, 'online controls fit without overlapping duration at width ' + width);
    }
    const output = path.resolve(__dirname, '../output/playwright/dbx-ui'); fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'online-row-390.png') });
    console.log('PASS DBX sandbox: click/Enter/validation/newlines; online row controls and duration at eight widths');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
