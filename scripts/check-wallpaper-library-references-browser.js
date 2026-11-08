// SPDX-License-Identifier: MIT
// Read-only library diagnostics: actual native-page assets with a controlled management bridge.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'crates/hertz-desktop/assets');
const output = path.join(root, 'output/playwright/wallpaper-library-references');
const html = fs.readFileSync(path.join(assets, 'wallpaper-settings.html'), 'utf8')
  .replace(/<script>[\s\S]*?<\/script>/g, '').replace('__DISPLAYS_CSS__', '');
const checks = [], errors = [];
const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    let confirmations = 0;
    page.on('dialog', async dialog => { confirmations++; await dialog.accept(); });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(() => {
      const copy = value => JSON.parse(JSON.stringify(value));
      const kinds = ['savedConfiguration', 'settingsDraft', 'desktop', 'preparing', 'retiring', 'preview', 'applying', 'playlist', 'workDraft', 'publication'];
      const state = window.libraryFixture = {
        requests: [], dirty: false, pending: false, conflict: false, chooseAllowed: true, queryError: null, deleteMode: 'blocked', gate: null,
        works: [{ workKey: 'work-coast', title: '海岸 · 雨后微光', kind: 'image', favorite: false }, { workKey: 'work-night', title: '夜航 <img src=x onerror="window.libraryInjected=true">', kind: 'image', favorite: false }],
        versions: [{ version: 3, packageHash: 'a'.repeat(64), state: 'installed' }, { version: 2, packageHash: 'b'.repeat(64), state: 'unavailable' }],
        report: { references: kinds.map((kind, index) => ({ kind, id: 'ref-' + index, label: index === 7 ? '晚间播放 <img src=x onerror="window.libraryInjected=true">' : '来源 ' + (index + 1), detail: index === 8 ? '<script>window.libraryInjected=true</script>' : '显示组：主屏幕 · 海岸作品' })), limit: 32, truncated: false }
      };
      state.initialReport = copy(state.report);
      window.hertzWallpaperSettings = {
        canChooseLibraryVersion: () => state.chooseAllowed && !state.pending && !state.conflict,
        chooseLibraryVersion: async () => true,
        invalidatePosters: () => window.dispatchEvent(new Event('wallpaper-posters-invalidated')),
        readPoster: async () => null,
        async requestManagement(command, payload) {
          state.requests.push(copy({ command, payload }));
          let result = {}, failure;
          if (command === 'wallpaper.library.list') result = { works: copy(state.works), nextCursor: null };
          else if (command === 'wallpaper.library.get') result = { versions: copy(state.versions) };
          else if (command === 'wallpaper.status') result = {};
          else if (command === 'wallpaper.library.references') {
            result = copy(state.report);
            if (state.queryError) failure = { code: state.queryError, message: '查询暂时不可用' };
          } else if (command === 'wallpaper.library.deleteWork' || command === 'wallpaper.library.deleteVersion') {
            if (state.deleteMode !== 'success') failure = { code: state.deleteMode === 'failure' ? 'storage_error' : 'asset_in_use', message: '内容仍被引用', ...(state.deleteMode === 'blocked' ? { details: copy(state.report) } : {}) };
          } else throw new Error('Unexpected fixture command: ' + command);
          if (state.gate === command) { state.gate = null; await new Promise(resolve => { state.release = resolve; }); }
          if (failure) { const error = new Error(failure.message); error.code = failure.code; error.receipt = { error: failure }; throw error; }
          if (command === 'wallpaper.library.deleteWork') state.works = state.works.filter(work => work.workKey !== payload.workKey);
          return { result };
        }
      };
    });
    await page.addScriptTag({ path: path.join(assets, 'wallpaper-library.js') });
    const works = page.locator('#library-works > li');
    const workReference = index => works.nth(index).locator('.library-work-actions .library-view-references');
    const workDelete = index => works.nth(index).locator('.library-work-actions .library-delete');
    const versionReference = index => works.first().locator('.library-version').nth(index).locator('.library-view-references');
    const versionDelete = index => works.first().locator('.library-version').nth(index).locator('.library-delete');
    const lastRequest = command => page.evaluate(command => libraryFixture.requests.filter(request => request.command === command).at(-1), command);
    const deletionCount = () => page.evaluate(() => libraryFixture.requests.filter(request => request.command.startsWith('wallpaper.library.delete')).length);
    const queryCount = () => page.evaluate(() => libraryFixture.requests.filter(request => request.command === 'wallpaper.library.references').length);
    const readyReport = () => page.waitForFunction(() => !document.querySelector('#library-references').hidden && document.querySelector('#library-references').getAttribute('aria-busy') === 'false');
    const release = () => page.evaluate(() => { libraryFixture.release(); delete libraryFixture.release; });
    const waitGate = () => page.waitForFunction(() => !!libraryFixture.release);
    await page.locator('#local-library > summary').click();
    await page.waitForFunction(() => document.querySelectorAll('#library-works > li').length === 2);
    await workReference(0).click(); await readyReport();
    assert.deepEqual((await lastRequest('wallpaper.library.references')).payload, { workKey: 'work-coast' });
    assert.equal(await page.locator('#library-references-list > li').count(), 10);
    const kindLabels = await page.locator('.library-reference-kind').allTextContents();
    assert.deepEqual(kindLabels, ['已保存配置', '设置草稿', '桌面正在使用', '正在准备', '正在释放', '预览', '正在应用', '轮播列表', '作品草稿', '正在发布']);
    assert.match(await page.locator('#library-references-title').textContent(), /全部版本/);
    assert.match(await page.locator('#library-references-list').textContent(), /<img src=x/);
    assert.match(await page.locator('#library-references-list').textContent(), /<script>/);
    assert.equal(await page.locator('#library-references-list img, #library-references-list script, #library-works img').count(), 0);
    assert.equal(await page.evaluate(() => !!window.libraryInjected), false);
    checks.push('work queries carry only workKey and render all ten persisted/runtime kinds as literal text');

    await works.first().getByRole('button', { name: '查看版本', exact: true }).click();
    await versionReference(0).click(); await readyReport();
    assert.deepEqual((await lastRequest('wallpaper.library.references')).payload, { workKey: 'work-coast', packageHash: 'a'.repeat(64) });
    assert.match(await page.locator('#library-references-title').textContent(), /版本 3/);
    assert.equal(await versionReference(1).isEnabled(), true, 'unavailable versions remain inspectable');
    let queriesBefore = await queryCount(), deletesBefore = await deletionCount();
    await versionDelete(0).click(); await readyReport();
    assert.match(await page.locator('#library-references-status').textContent(), /删除未完成/);
    assert.deepEqual((await lastRequest('wallpaper.library.deleteVersion')).payload, { workKey: 'work-coast', version: 3, packageHash: 'a'.repeat(64) });
    assert.equal(await queryCount(), queriesBefore, 'blocked delete shows receipt details immediately without querying');
    assert.equal(await deletionCount(), deletesBefore + 1);
    assert.equal(await page.locator('#library-references-list > li').count(), 10);
    checks.push('version queries target the hash; blocked version deletion renders its report directly and preserves confirmation');

    queriesBefore = await queryCount();
    await workDelete(1).click(); await readyReport();
    assert.match(await page.locator('#library-references-title').textContent(), /夜航 <img/);
    assert.match(await page.locator('#library-references-title').textContent(), /全部版本/);
    assert.equal(await queryCount(), queriesBefore);
    assert.deepEqual((await lastRequest('wallpaper.library.deleteWork')).payload, { workKey: 'work-night' });
    assert.equal(await page.locator('#library-references-title img').count(), 0);
    await page.evaluate(() => {
      libraryFixture.report = { references: Array.from({ length: 40 }, (_, index) => ({ kind: 'playlist', id: 'many-' + index, label: index ? '轮播 ' + index : '较长的轮播列表名称'.repeat(48), detail: index ? '引用海岸作品的已保存版本' : '长路径与显示组说明'.repeat(40) })), limit: 32, truncated: true };
    });
    deletesBefore = await deletionCount();
    await page.locator('#library-references-refresh').click(); await readyReport();
    assert.equal(await page.locator('#library-references-list > li').count(), 32);
    assert.equal(await page.locator('#library-references-truncated').isVisible(), true);
    assert.match(await page.locator('#library-references-truncated').textContent(), /名称较长/);
    assert.equal(await deletionCount(), deletesBefore);
    for (const width of [1180, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('#library-references-title').evaluate(node => node.scrollIntoView({ block: 'start' }));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth), true, 'no horizontal overflow at ' + width);
      assert.equal(await page.locator('#library-references-list').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'long reference content wraps at ' + width);
      await page.screenshot({ path: path.join(output, 'references-long-' + width + '.png') });
    }
    checks.push('work deletion is scoped correctly; explicit refresh is read-only, limited to 32 rows and wraps long names at 1180/390/320px');

    await page.evaluate(() => { libraryFixture.report = structuredClone(libraryFixture.initialReport); });
    await workReference(0).click(); await readyReport();
    for (const width of [1180, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('#library-references-title').evaluate(node => node.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: path.join(output, 'references-' + width + '.png') });
    }

    await page.setViewportSize({ width: 1180, height: 900 });
    await page.evaluate(() => { libraryFixture.report = { references: [], limit: 32, truncated: false }; });
    await page.locator('#library-references-refresh').click(); await readyReport();
    assert.match(await page.locator('#library-references-status').textContent(), /当前未发现引用/);
    assert.match(await page.locator('.library-reference-note').textContent(), /重新检查引用/);
    assert.equal(await deletionCount(), deletesBefore);
    await page.evaluate(() => { libraryFixture.queryError = 'query_timeout'; });
    await page.locator('#library-references-refresh').click(); await readyReport();
    assert.match(await page.locator('#library-references-status').textContent(), /读取引用失败/);
    assert.equal(await page.locator('#library-references-refresh').isEnabled(), true);
    await page.evaluate(() => { libraryFixture.queryError = null; libraryFixture.report = structuredClone(libraryFixture.initialReport); });
    await page.locator('#library-references-refresh').click(); await readyReport();
    assert.equal(await page.locator('#library-references-list > li').count(), 10);
    assert.equal(await deletionCount(), deletesBefore);
    checks.push('empty, transient-error and manual retry states never retry deletion or release referenced objects');

    await page.evaluate(() => { libraryFixture.deleteMode = 'legacy'; });
    await workDelete(0).click(); await readyReport();
    assert.match(await page.locator('#library-references-status').textContent(), /未返回引用详情/);
    await page.evaluate(() => { libraryFixture.queryError = 'unsupported_command'; });
    await page.locator('#library-references-refresh').click(); await readyReport();
    assert.match(await page.locator('#library-references-status').textContent(), /不支持查询引用/);
    await page.evaluate(() => { libraryFixture.queryError = null; libraryFixture.deleteMode = 'blocked'; libraryFixture.gate = 'wallpaper.library.references'; });
    await workReference(0).click(); await waitGate();
    assert.equal(await page.locator('#library-references').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('.library-references-loading').isVisible(), true);
    assert.equal(await page.locator('#library-references-refresh').isDisabled(), true);
    await workReference(1).click(); await readyReport();
    const newerTitle = await page.locator('#library-references-title').textContent();
    await release();
    await page.waitForFunction(() => !libraryFixture.release);
    assert.equal(await page.locator('#library-references-title').textContent(), newerTitle);
    assert.match(newerTitle, /夜航/);
    checks.push('older hosts have a usable fallback; switching targets discards a late loading query');

    for (const invalidation of ['list', 'source']) {
      await page.evaluate(() => { libraryFixture.gate = 'wallpaper.library.references'; });
      await workReference(0).click(); await waitGate();
      if (invalidation === 'list') { await page.locator('#library-refresh').click(); await page.waitForFunction(() => !document.querySelector('#library-refresh').disabled); }
      else await page.evaluate(() => window.dispatchEvent(new Event('wallpaper-library-context-changed')));
      await release();
      assert.equal(await page.locator('#library-references').isHidden(), true);
      assert.equal(await page.locator('#library-references-list > li').count(), 0);
    }
    await page.evaluate(() => { libraryFixture.gate = 'wallpaper.library.list'; });
    await page.locator('#library-refresh').click(); await waitGate();
    await workReference(0).click(); await readyReport();
    await release();
    await page.waitForFunction(() => !document.querySelector('#library-refresh').disabled);
    assert.equal(await page.locator('#library-references').isHidden(), true, 'a query during list loading is invalidated when that list arrives');
    checks.push('list refresh and source changes invalidate late queries and clear the previous report');

    await page.evaluate(() => { libraryFixture.dirty = true; libraryFixture.chooseAllowed = false; window.dispatchEvent(new Event('wallpaper-settings-controls-updated')); });
    assert.equal(await workDelete(0).isDisabled(), true);
    assert.equal(await workReference(0).isEnabled(), true);
    await workReference(0).click(); await readyReport();
    deletesBefore = await deletionCount();
    await workDelete(0).dispatchEvent('click');
    assert.equal(await deletionCount(), deletesBefore, 'guard protects programmatically dispatched delete while selection is unavailable');
    await page.evaluate(() => { libraryFixture.dirty = false; libraryFixture.chooseAllowed = true; libraryFixture.gate = 'wallpaper.library.deleteWork'; window.dispatchEvent(new Event('wallpaper-settings-controls-updated')); });
    await workDelete(0).click(); await waitGate();
    assert.equal(await workDelete(1).isDisabled(), true);
    await workDelete(0).dispatchEvent('click'); await workDelete(1).dispatchEvent('click');
    assert.equal(await deletionCount(), deletesBefore + 1, 'only one delete is in flight');
    await page.evaluate(() => { libraryFixture.pending = true; window.dispatchEvent(new Event('wallpaper-settings-controls-updated')); });
    await release(); await readyReport();
    assert.equal(await workDelete(0).isDisabled(), true, 'completion recomputes canChoose instead of blindly enabling');
    assert.equal(await workReference(0).isEnabled(), true);
    await page.evaluate(() => { libraryFixture.pending = false; window.dispatchEvent(new Event('wallpaper-settings-controls-updated')); });
    assert.equal(await workDelete(0).isEnabled(), true);
    checks.push('dirty/pending settings keep read-only diagnostics usable; deletion is guarded, deduplicated and rechecks controls on completion');

    await page.evaluate(() => { libraryFixture.gate = 'wallpaper.library.deleteWork'; });
    await workDelete(0).click(); await waitGate();
    await workReference(1).click(); await readyReport();
    await release();
    await page.waitForFunction(() => document.querySelector('.library-delete').dataset.libraryDeletePending === 'false');
    assert.match(await page.locator('#library-references-title').textContent(), /夜航/);
    assert.doesNotMatch(await page.locator('#library-references-status').textContent(), /删除未完成/);
    await page.evaluate(() => { libraryFixture.deleteMode = 'success'; libraryFixture.gate = 'wallpaper.library.deleteWork'; });
    deletesBefore = await deletionCount(); const confirmationsBefore = confirmations;
    await workDelete(0).click(); await waitGate();
    await workReference(1).click(); await readyReport();
    await page.evaluate(() => {
      libraryFixture.releaseDeletion = libraryFixture.release; delete libraryFixture.release;
      libraryFixture.gate = 'wallpaper.library.list';
    });
    await page.locator('#library-refresh').click(); await waitGate();
    const listsBeforeDeleteCompleted = await page.evaluate(() => libraryFixture.requests.filter(request => request.command === 'wallpaper.library.list').length);
    await page.evaluate(() => { libraryFixture.releaseDeletion(); delete libraryFixture.releaseDeletion; });
    await page.waitForFunction(() => document.querySelector('.library-delete').dataset.libraryDeletePending === 'false');
    assert.equal(await works.count(), 2, 'the held list request still has its pre-delete snapshot');
    await release();
    await page.waitForFunction(() => document.querySelectorAll('#library-works > li').length === 1);
    assert.match(await works.first().textContent(), /夜航/);
    assert.equal(await page.evaluate(() => libraryFixture.requests.filter(request => request.command === 'wallpaper.library.list').length), listsBeforeDeleteCompleted + 1, 'successful deletion queues another list read after an in-flight refresh');
    assert.equal(await deletionCount(), deletesBefore + 1);
    assert.equal(confirmations, confirmationsBefore + 1);
    assert.equal(await page.locator('#library-references').isHidden(), true);
    checks.push('successful deletion confirms and refreshes even after selecting another reference target, queueing a fresh list after an in-flight pre-delete read');
    await page.evaluate(() => { libraryFixture.gate = 'wallpaper.library.references'; });
    await workReference(0).click(); await waitGate();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await release();
    assert.equal(await page.locator('#library-references').isHidden(), true);
    checks.push('late blocked deletion cannot overwrite a newer target, and pagehide discards outstanding diagnostics');
    assert.ok(confirmations >= 5, 'normal destructive confirmation remains present');
    const calls = await page.evaluate(() => libraryFixture.requests.map(request => request.command));
    assert.equal(calls.some(command => /release|discard|remove|apply|save/.test(command)), false, 'diagnostics never mutate reference owners');
    assert.deepEqual(errors, []);
    const result = { ok: true, checks, screenshots: [1180, 390, 320].map(width => 'references-' + width + '.png') };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
