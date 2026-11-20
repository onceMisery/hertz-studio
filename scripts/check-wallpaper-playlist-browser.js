// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), assets = path.join(root, 'crates/hertz-desktop/assets');
const output = path.resolve(process.env.HERTZ_PLAYLIST_OUTPUT || path.join(root, 'output/playlist-incremental-20261119/browser'));
let html = fs.readFileSync(path.join(assets, 'wallpaper-settings.html'), 'utf8').replace(/<script>[\s\S]*?<\/script>/g, '');
const server = http.createServer((_, response) => { response.setHeader('Content-Type', 'text/html;charset=utf-8'); response.end(html); });
const checks = [], errors = [];
(async () => {
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(() => {
      const copy = value => JSON.parse(JSON.stringify(value));
      const failure = (code, known = true) => Object.assign(new Error(code), { code, ...(known ? { receipt: { ok: false, error: { code } } } : {}) });
      const fixed = index => ({ workKey: 'work-' + index, packageHash: String(index).padStart(64, '0') });
      const state = window.playlistFixture = { requests: [], lists: {}, receipts: {}, lose: false, pending: false, conflict: false, failAfter: null, writes: 0, fixed,
        seed(count) { this.lists.large = { playlistId: 'large', revision: 1, title: '千项固定壁纸', mode: 'sequential', intervalSeconds: 60, items: Array.from({ length: count }, (_, i) => fixed(i)) }; } };
      const receipt = value => ({ playlistId: value.playlistId, revision: value.revision, title: value.title, mode: value.mode, intervalSeconds: value.intervalSeconds, itemCount: value.items.length });
      window.hertzWallpaperSettings = { currentRuntime: () => null, currentGroupId: () => 'primary', canChooseLibraryVersion: () => true,
        async choosePlaylist(value, groupId) { state.chosen = { value, groupId }; return true; },
        async requestManagement(command, payload, id) {
          state.requests.push(copy({ command, payload, id })); let result;
          if (command === 'wallpaper.playlist.list') result = { playlists: Object.values(state.lists).map(receipt), nextCursor: null };
          else if (command === 'wallpaper.playlist.page') {
            const value = state.lists[payload.playlistId]; if (!value) throw failure('playlist_not_found');
            if (payload.expectedPlaylistRevision && payload.expectedPlaylistRevision !== value.revision) throw failure('playlist_conflict');
            const end = Math.min(value.items.length, payload.offset + payload.limit);
            result = { ...receipt(value), items: value.items.slice(payload.offset, end), offset: payload.offset, nextOffset: end < value.items.length ? end : null };
          } else if (command === 'wallpaper.playlist.update') {
            if (state.pending) throw failure('receipt_timeout', false);
            if (state.failAfter !== null && state.writes >= state.failAfter) { state.failAfter = null; throw failure('budget_busy'); }
            let value = state.lists[payload.playlistId];
            if (state.conflict) { state.conflict = false; if (value) { value.revision++; value.title = '另一窗口的编辑'; } throw failure('playlist_conflict'); }
            if ((value?.revision || 0) !== payload.expectedPlaylistRevision) throw failure('playlist_conflict');
            value = copy(value || { playlistId: payload.playlistId, revision: 0, items: [] });
            assertBound(payload.operations.length <= 32, 'bounded batch');
            payload.operations.forEach(edit => {
              if (edit.kind === 'insert') value.items.splice(edit.index, 0, edit.item);
              else if (edit.kind === 'remove') value.items.splice(edit.index, 1);
              else value.items.splice(edit.to, 0, value.items.splice(edit.from, 1)[0]);
              assertBound(value.items.length <= 1000, 'bounded intermediate list');
            });
            assertBound(value.items.length > 0, 'nonempty batch');
            Object.assign(value, { title: payload.title, mode: payload.mode, intervalSeconds: payload.intervalSeconds, revision: value.revision + 1 });
            state.lists[payload.playlistId] = value; state.writes++; result = receipt(value); state.receipts[id] = { ok: true, result };
            if (state.lose) { state.lose = false; if (state.forget) state.receipts = {}; throw failure('receipt_timeout', false); }
          } else if (command === 'wallpaper.operations.get') {
            if (state.pending) throw failure('operation_pending');
            if (!state.receipts[payload.requestId]) throw failure('operation_unknown');
            result = state.receipts[payload.requestId];
          } else if (command === 'wallpaper.playlist.next') result = {};
          else throw new Error('Unexpected ' + command);
          return { result: copy(result) };
        }
      };
      function assertBound(condition, text) { if (!condition) throw new Error(text); }
      document.querySelectorAll('[role="tabpanel"]').forEach(panel => { panel.hidden = false; });
      document.getElementById('local-library').after(Object.assign(document.createElement('div'), { id: 'work-editor' }));
      state.seed(1000);
    });
    for (const file of ['wallpaper-playlist-editor.js', 'wallpaper-playlist.js']) await page.addScriptTag({ path: path.join(assets, file) });
    await page.locator('#playlist-editor summary').click();
    await page.locator('#playlist-select').selectOption('large'); await page.locator('#playlist-open').click();
    await page.waitForFunction(() => document.querySelector('#playlist-page-label').textContent.includes('共 1000 项'));
    assert.equal(await page.locator('#playlist-items > li').count(), 32);
    assert.equal(await page.evaluate(() => playlistFixture.requests.filter(r => r.command === 'wallpaper.playlist.page').length), 32);
    checks.push('1000-item revision-bound read, 32-row DOM');
    await page.locator('#playlist-items > li').first().locator('input').fill('1000');
    await page.locator('#playlist-items > li').first().getByRole('button', { name: '移到', exact: true }).click();
    assert.match(await page.locator('#playlist-page-label').textContent(), /第 32 \/ 32/);
    assert.match(await page.locator('#playlist-items > li').last().textContent(), /1000\./);
    await page.locator('#playlist-save').click(); await page.waitForFunction(() => playlistFixture.lists.large.items[999].workKey === 'work-0');
    await page.locator('#playlist-open').click(); await page.waitForFunction(() => !document.querySelector('#playlist-open').disabled);
    assert.equal(await page.evaluate(() => playlistFixture.lists.large.items[0].workKey), 'work-1');
    checks.push('cross-page move, bounded save and reopen');
    const row = page.locator('#playlist-items > li').nth(1), up = row.getByRole('button', { name: '上移', exact: true });
    await row.evaluate(row => { window.originalPlaylistRow = row; }); await up.focus(); await up.press('Enter');
    assert.equal(await page.evaluate(() => originalPlaylistRow === document.querySelector('#playlist-items > li')), true);
    assert.equal(await page.evaluate(() => originalPlaylistRow.contains(document.activeElement)), true);
    checks.push('same DOM identity and keyboard focus after reorder');
    await page.evaluate(() => { playlistFixture.lose = true; playlistFixture.forget = true; });
    await page.locator('#playlist-save').click(); await page.locator('#playlist-recover').waitFor({ state: 'visible' });
    const writes = await page.evaluate(() => playlistFixture.writes);
    await page.locator('#playlist-recover').click(); await page.locator('#playlist-recover').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => playlistFixture.writes), writes);
    checks.push('lost write receipt reconciles paginated exact snapshot without replay');
    await page.evaluate(() => { playlistFixture.conflict = true; }); await page.locator('#playlist-title').fill('本地输入必须保留');
    await page.locator('#playlist-save').click(); await page.locator('#playlist-reread').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#playlist-title').inputValue(), '本地输入必须保留');
    assert.equal(await page.locator('#playlist-save').isDisabled(), true);
    await page.locator('#playlist-reread').click(); await page.waitForFunction(() => document.querySelector('#playlist-title').value === '另一窗口的编辑');
    checks.push('CAS conflict retains local input until explicit reload');
    await page.locator('#playlist-new').click();
    await page.evaluate(() => {
      for (let i = 0; i < 70; i++) window.dispatchEvent(new CustomEvent('wallpaper-playlist-add', { detail: { work: { workKey: 'work-' + i, title: '壁纸 ' + i }, version: { packageHash: String(i).padStart(64, '0'), version: 1 } } }));
      playlistFixture.failAfter = playlistFixture.writes + 1;
    });
    await page.locator('#playlist-save').click(); await page.waitForFunction(() => document.querySelector('#playlist-message').textContent.includes('其余编辑保留'));
    assert.equal(await page.evaluate(() => Object.values(playlistFixture.lists).find(v => v.playlistId !== 'large').items.length), 32);
    assert.match(await page.locator('#playlist-page-label').textContent(), /70 项/);
    await page.locator('#playlist-save').click(); await page.waitForFunction(() => Object.values(playlistFixture.lists).some(v => v.items.length === 70));
    assert.equal(await page.evaluate(() => Object.keys(playlistFixture.lists).length), 2);
    checks.push('partial batch failure retains remainder and resumes without duplicate list');
    await page.locator('#playlist-title').fill(''); await page.locator('#playlist-save').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'playlist-title');
    await page.locator('#playlist-title').fill('有效名称');
    await page.evaluate(() => { playlistFixture.pending = true; }); await page.locator('#playlist-save').click(); await page.locator('#playlist-recover').waitFor({ state: 'visible' });
    const beforeRecovery = await page.evaluate(() => playlistFixture.requests.filter(r => r.command === 'wallpaper.playlist.update').length);
    await page.locator('#playlist-recover').click(); assert.equal(await page.locator('#playlist-save').isDisabled(), true);
    await page.evaluate(() => { playlistFixture.pending = false; }); await page.locator('#playlist-recover').click(); await page.locator('#playlist-recover').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => playlistFixture.requests.filter(r => r.command === 'wallpaper.playlist.update').length), beforeRecovery);
    await page.locator('#playlist-save').click(); await page.waitForFunction(() => document.querySelector('#playlist-message').textContent.startsWith('轮播列表已保存'));
    checks.push('validation focus, pending operation blocks writes, absent commit requires explicit save');
    for (const width of [1120, 520, 360, 320]) {
      await page.setViewportSize({ width, height: 900 }); await page.locator('#playlist-editor').scrollIntoViewIfNeeded();
      const overflow = await page.locator('#playlist-editor').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
      assert.ok(overflow.scroll <= overflow.width + 2, JSON.stringify({ width, overflow }));
      await page.screenshot({ path: path.join(output, 'playlist-' + width + '.png') });
    }
    checks.push('1120/520/360/320px layout and screenshots');
    assert.deepEqual(errors, []); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log('PASS', checks.length, 'playlist browser scenarios');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
