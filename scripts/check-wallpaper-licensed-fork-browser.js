// SPDX-License-Identifier: MIT
// Real library/editor UI with a deterministic bridge; native rights and byte
// closure checks are in work_drafts_fork_tests.rs.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), assets = path.join(root, 'crates/hertz-desktop/assets');
const output = path.join(root, 'output/offline-design-completion/licensed-fork/browser');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'crates/hertz-wallpaper/contracts/composition.json'), 'utf8')).definitions;
const coast = JSON.parse(fs.readFileSync(path.join(root, 'crates/hertz-wallpaper/contracts/catalog.json'), 'utf8')).scenes.find(scene => scene.id === 'coast');
const html = fs.readFileSync(path.join(assets, 'wallpaper-settings.html'), 'utf8')
  .replace(/<script>[\s\S]*?<\/script>/g, '')
  .replace('__DISPLAYS_CSS__', '')
  .replace('__AI_CSS__', fs.readFileSync(path.join(assets, 'wallpaper-work-layers.css'), 'utf8'));
const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); });
const checks = [], errors = [];
(async () => {
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(({ catalog, coast }) => {
      const copy = value => JSON.parse(JSON.stringify(value));
      const scene = { documentVersion: 1, canvas: { width: 640, height: 360, colorSpace: 'srgb', background: '#101010' }, nodes: [], effects: [], timeline: { durationSeconds: 1, loop: true, tracks: [] }, bindings: [] };
      const state = window.forkFixture = { requests: [], counter: 0, drafts: {}, works: [
        { workKey: 'foreign-composition', title: '许可组合 <img src=x>', kind: 'composition', sourceId: 'local', hash: 'a'.repeat(64) },
        { workKey: 'own-composition', title: '我的组合', kind: 'composition', sourceId: 'local', hash: 'b'.repeat(64), authored: true },
        { workKey: 'unknown-builtin', title: '许可不明的场景', kind: 'builtin', sourceId: 'local', hash: 'c'.repeat(64) },
        { workKey: 'foreign-web', title: '网页作品', kind: 'web', sourceId: 'local', hash: 'd'.repeat(64) }
      ] };
      const receipt = draft => ({ kind: 'work', draftId: draft.id, draftRevision: draft.revision, savedRevision: draft.saved, workKey: draft.workKey, title: draft.title, description: draft.description, sceneId: draft.composition ? '' : 'coast', stateVersion: draft.composition ? 0 : 1, contentKind: draft.composition ? 'composition' : 'builtin' });
      window.hertzWallpaperSettings = {
        canChooseLibraryVersion: () => true, readPoster: async () => null, invalidatePosters: () => {},
        releasePreview: async () => {}, previewWork: async () => {},
        async requestManagement(command, payload) {
          state.requests.push(copy({ command, payload }));
          let result, draft = state.drafts[payload?.draftId];
          if (command === 'wallpaper.library.list') result = { works: copy(state.works), nextCursor: null };
          else if (command === 'wallpaper.library.get') {
            const work = state.works.find(work => work.workKey === payload.workKey);
            result = { versions: [{ version: 1, state: 'installed', packageHash: work.hash, locallyAuthored: !!work.authored }] };
          } else if (command === 'wallpaper.status') result = {};
          else if (command === 'wallpaper.draft.create') {
            const source = state.works.find(work => work.workKey === payload.workKey);
            if (source.workKey === 'unknown-builtin') throw Object.assign(new Error('此版本的改编许可未明确或不支持改编，无法另存为新作品；原作品仍可使用和导出'), { code: 'derivative_license_required' });
            const id = 'work-' + String(++state.counter).padStart(32, '0');
            draft = state.drafts[id] = { id, revision: 1, saved: null, workKey: payload.kind === 'fork' ? 'copy-' + id : source.workKey, title: source.title + (payload.kind === 'fork' ? '（副本）' : ''), description: '', composition: copy(scene), source: copy(source) };
            result = receipt(draft);
          } else if (command === 'wallpaper.draft.list') result = { drafts: Object.values(state.drafts).map(receipt), nextCursor: null };
          else if (command === 'wallpaper.draft.get') result = receipt(draft);
          else if (command === 'wallpaper.draft.catalog') result = { composition: { definitions: catalog } };
          else if (command === 'wallpaper.draft.schema') result = coast;
          else if (command === 'wallpaper.draft.parameters') result = { params: {}, nextCursor: null };
          else if (command === 'wallpaper.draft.properties') result = { properties: [], nextCursor: null };
          else if (command === 'wallpaper.draft.composition') result = { items: copy(payload.section === 'canvas' ? [draft.composition.canvas] : payload.section === 'resources' ? [] : payload.section === 'tracks' ? draft.composition.timeline.tracks : draft.composition[payload.section]), nextCursor: null, durationSeconds: 1, loop: true };
          else if (command === 'wallpaper.draft.update') {
            assertRevision();
            for (const operation of payload.operations) {
              if (operation.kind !== 'replaceMetadata') throw new Error('Unexpected edit: ' + operation.kind);
              draft.title = operation.title; draft.description = operation.description;
            }
            draft.revision++; result = receipt(draft);
          } else if (command === 'wallpaper.draft.save') { assertRevision(); draft.saved = draft.revision; result = receipt(draft); }
          else if (command === 'wallpaper.draft.publish') { assertRevision(); result = { workKey: draft.workKey, version: 1, packageHash: 'e'.repeat(64) }; }
          else throw new Error('Unexpected command: ' + command);
          function assertRevision() { if (draft.revision !== payload.draftRevision) throw new Error('draft_conflict'); }
          return { result: copy(result) };
        }
      };
      document.querySelectorAll('[role="tabpanel"]').forEach(panel => { panel.hidden = false; });
    }, { catalog, coast });
    for (const file of ['wallpaper-work-structure.js', 'wallpaper-work-layers.js', 'wallpaper-work-composition.js', 'wallpaper-work.js', 'wallpaper-library.js']) await page.addScriptTag({ path: path.join(assets, file) });
    await page.locator('#local-library > summary').click();
    const works = page.locator('#library-works > li');
    await works.first().waitFor();
    for (let index = 0; index < 4; index++) await works.nth(index).getByRole('button', { name: '查看版本', exact: true }).click();
    assert.equal(await works.nth(0).getByRole('button', { name: '编辑此版本', exact: true }).count(), 0);
    assert.equal(await works.nth(1).getByRole('button', { name: '编辑此版本', exact: true }).count(), 1);
    assert.equal(await works.nth(3).getByRole('button', { name: '另存为新作品', exact: true }).count(), 0);
    assert.equal(await works.nth(0).getByRole('button', { name: '另存为新作品', exact: true }).getAttribute('type'), 'button');
    assert.equal(await page.locator('#library-works img').count(), 0);
    checks.push('only exact authored composition versions expose edit; supported foreign versions expose explicit save-as; Web is excluded');
    const fork = works.nth(0).getByRole('button', { name: '另存为新作品', exact: true });
    await fork.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#work-message').textContent.includes('独立的新作品草稿') && !document.querySelector('#work-save').disabled);
    const created = await page.evaluate(() => forkFixture.requests.find(request => request.command === 'wallpaper.draft.create'));
    assert.deepEqual(created.payload, { kind: 'fork', workKey: 'foreign-composition', packageHash: 'a'.repeat(64) });
    assert.equal(await page.locator('#work-message').getAttribute('role'), 'status');
    assert.equal(await page.locator('#work-title').inputValue(), '许可组合 <img src=x>（副本）');
    assert.equal(await page.locator('#work-title').evaluate(input => document.activeElement === input), true);
    await page.screenshot({ path: path.join(output, 'fork-editor.png') });
    checks.push('keyboard save-as sends the exact installed identity and a narrow fork intent; result announces retained source and opens composition editor');
    await page.locator('#work-title').fill('我的改编作品');
    await page.locator('#work-save').click();
    await page.waitForFunction(() => document.querySelector('#work-message').textContent.includes('作品已保存'));
    await page.locator('#work-publish').click();
    await page.waitForFunction(() => document.querySelector('#work-message').textContent.includes('已生成版本'));
    assert.equal(await page.evaluate(() => forkFixture.works[0].title), '许可组合 <img src=x>');
    const requests = await page.evaluate(() => forkFixture.requests);
    assert.equal(requests.some(request => /settings|apply|select/.test(request.command)), false);
    assert.equal(requests.filter(request => request.command === 'wallpaper.draft.update').flatMap(request => request.payload.operations).some(operation => 'provenance' in operation), false);
    checks.push('editing and publishing use original CAS/save path without submitting provenance or applying wallpaper');
    // Publication refreshes the library, so reopen the target version.
    await works.nth(2).getByRole('button', { name: '查看版本', exact: true }).click();
    const count = await page.evaluate(() => Object.keys(forkFixture.drafts).length);
    await works.nth(2).getByRole('button', { name: '另存为新作品', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#library-message').textContent.includes('改编许可'));
    assert.equal(await page.evaluate(() => Object.keys(forkFixture.drafts).length), count);
    assert.equal(await page.locator('#work-title').inputValue(), '我的改编作品');
    checks.push('license refusal preserves the open draft and shows an actionable library error without a rights checkbox bypass');
    for (const width of [1120, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await works.nth(2).scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(output, 'fork-' + width + '.png') });
    }
    checks.push('library actions fit 1120/390/320px viewports');
    assert.deepEqual(errors, []);
    const report = { ok: true, checks, errors };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
