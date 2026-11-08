// SPDX-License-Identifier: MIT
// Author UI regression: actual registry targets, typed CAS deltas and bounded batches.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'crates/hertz-desktop/assets');
const output = path.join(root, 'output/playwright/wallpaper-work-properties');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'crates/hertz-wallpaper/contracts/catalog.json'), 'utf8'));
const coast = catalog.scenes.find(scene => scene.id === 'coast');
const large = { id: 'transport-fixture', stateVersion: 1, params: Object.fromEntries(Array.from({ length: 64 }, (_, index) => ['value' + index, { type: 'number', label: '参数 ' + index, default: 0, min: 0, max: 1, step: 0.01 }])) };
const checks = [], errors = [];
let html = fs.readFileSync(path.join(assets, 'wallpaper-settings.html'), 'utf8').replace(/<script>[\s\S]*?<\/script>/g, '');
html = html.replace('__DISPLAYS_CSS__', '');
const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); });
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(({ coast, large }) => {
      const copy = value => JSON.parse(JSON.stringify(value));
      const state = window.workFixture = { schema: coast, schemas: { coast, 'transport-fixture': large }, drafts: {}, requests: [], counter: 0, gate: null, failNext: false };
      const receipt = draft => ({ draftId: draft.id, draftRevision: draft.revision, savedRevision: draft.saved, workKey: draft.id, title: draft.document.title, description: draft.document.description, sceneId: draft.document.sceneId, stateVersion: 1, paramCount: Object.keys(draft.document.params).length, propertyCount: draft.document.properties.length });
      window.hertzWallpaperSettings = {
        currentBuiltin: () => ({ title: state.schema.id === 'coast' ? '海岸作品' : '传输边界测试', sceneId: state.schema.id, stateVersion: 1, params: Object.fromEntries(Object.entries(state.schema.params).map(([id, spec]) => [id, spec.default])) }),
        previewWork: async () => {}, releasePreview: async () => {},
        async requestManagement(command, payload) {
          state.requests.push(copy({ command, payload }));
          const error = (code, message) => { const error = new Error(message); error.code = code; throw error; };
          let draft = payload?.draftId ? state.drafts[payload.draftId] : null, result;
          if (draft && payload.draftRevision && payload.draftRevision !== draft.revision) error('draft_conflict', '修订冲突');
          if (command === 'wallpaper.draft.create') {
            const id = 'work-' + String(++state.counter).padStart(32, '0');
            draft = state.drafts[id] = { id, revision: 1, saved: null, document: { description: '', properties: [], ...copy(payload.document) } }; result = receipt(draft);
          } else if (command === 'wallpaper.draft.list') result = { drafts: Object.values(state.drafts).map(draft => receipt(draft)), nextCursor: null };
          else if (command === 'wallpaper.draft.get') result = receipt(draft);
          else if (command === 'wallpaper.draft.schema') result = state.schemas[payload.sceneId];
          else if (command === 'wallpaper.draft.parameters') result = { params: draft.document.params, nextCursor: null, draftRevision: draft.revision };
          else if (command === 'wallpaper.draft.properties') {
            const all = draft.document.properties.filter(property => !payload.cursor || property.id > payload.cursor);
            const properties = all.slice(0, 3); result = { properties, nextCursor: all.length > 3 ? properties.at(-1).id : null, draftRevision: draft.revision };
          } else if (command === 'wallpaper.draft.update') {
            if (state.failNext) { state.failNext = false; draft.revision++; error('draft_conflict', '修订冲突'); }
            for (const operation of payload.operations) {
              if (operation.kind === 'replaceMetadata') { draft.document.title = operation.title; draft.document.description = operation.description; }
              else if (operation.kind === 'setParam') draft.document.params[operation.id] = operation.value;
              else if (operation.kind === 'setProperty') { draft.document.properties = draft.document.properties.filter(property => property.id !== operation.property.id); draft.document.properties.push(operation.property); }
              else if (operation.kind === 'removeProperty') draft.document.properties = draft.document.properties.filter(property => property.id !== operation.id);
              else error('unexpected_operation', operation.kind);
            }
            draft.document.properties.sort((left, right) => left.id < right.id ? -1 : 1); draft.revision++; result = receipt(draft);
          } else if (command === 'wallpaper.draft.save') { draft.saved = draft.revision; result = receipt(draft); }
          else if (command === 'wallpaper.draft.publish') result = { version: 1 };
          else error('unexpected_command', command);
          if (state.gate === command) { state.gate = null; await new Promise(resolve => { state.release = resolve; }); }
          return { result: copy(result) };
        }
      };
    }, { coast, large });
    await page.addScriptTag({ path: path.join(assets, 'wallpaper-work.js') });
    await page.locator('#work-editor > summary').click();
    await page.locator('#work-new').click();
    await page.waitForFunction(() => document.querySelector('#work-message').textContent.includes('作品已保存') && !document.querySelector('#work-new').disabled);
    assert.equal(await page.locator('[data-work-public]').count(), Object.keys(coast.params).length);
    assert.equal(await page.locator('#work-params input[type="color"]').count(), 0);
    await page.locator('[data-work-public="discRing"]').check();
    await page.locator('[data-work-public="tod"]').check();
    await page.locator('[data-work-public-label="tod"]').fill('一天中的时段');
    await page.locator('[data-work-param="tod"]').fill('0.45');
    await page.waitForFunction(() => document.querySelector('#work-message').textContent.includes('作品已保存'));
    let saved = await page.evaluate(() => Object.values(workFixture.drafts)[0]);
    assert.equal(saved.saved, saved.revision);
    assert.equal(saved.document.properties.find(property => property.id === 'disc-ring').target.property, 'discRing');
    assert.equal(saved.document.properties.find(property => property.id === 'tod').default, 0.45);
    checks.push('real registry controls expose exact targets with deterministic public IDs and autosave typed defaults');
    await page.locator('[data-work-public-label="tod"]').fill('');
    await page.locator('#work-save').click();
    await page.waitForFunction(() => document.querySelector('#work-message').classList.contains('error'));
    assert.equal((await page.evaluate(() => Object.values(workFixture.drafts)[0])).revision, saved.revision);
    await page.locator('[data-work-public="tod"]').uncheck();
    await page.locator('#work-save').click();
    await page.waitForFunction(() => document.querySelector('#work-message').textContent.includes('作品已保存'));
    assert.equal((await page.evaluate(() => Object.values(workFixture.drafts)[0])).document.properties.some(property => property.id === 'tod'), false);
    checks.push('invalid labels block save and removing exposure clears hidden-field validity');
    await page.locator('[data-work-public="discRing"]').uncheck();
    await page.locator('[data-work-public="tod"]').check();
    await page.locator('[data-work-public-label="tod"]').fill('一天中的时段');
    await page.locator('#work-save').click();
    await page.waitForFunction(() => document.querySelector('#work-message').textContent.includes('作品已保存'));
    await page.evaluate(() => workFixture.gate = 'wallpaper.draft.properties');
    await page.locator('#work-reload').click();
    await page.waitForFunction(() => !!workFixture.release);
    assert.equal(await page.locator('[data-work-public="tod"]').isDisabled(), true);
    assert.equal(await page.locator('[data-work-public-label="tod"]').isDisabled(), true);
    await page.evaluate(() => { workFixture.release(); delete workFixture.release; });
    await page.waitForFunction(() => !document.querySelector('#work-save').disabled);
    assert.equal(await page.locator('[data-work-public-label="tod"]').inputValue(), '一天中的时段');
    await page.locator('[data-work-public-label="tod"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'author-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-work-public-label="tod"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'author-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    checks.push('property reads lock editing and reload restores exposure without narrow-screen overflow');
    await page.evaluate(() => {
      const draft = Object.values(workFixture.drafts)[0], property = draft.document.properties.find(property => property.id === 'tod');
      property.constraints = { min: 0.3, max: 0.6, step: 0.1 };
      property.default = 0.45; draft.revision++; draft.saved = draft.revision;
    });
    await page.locator('#work-reload').click();
    await page.waitForFunction(() => !document.querySelector('#work-save').disabled);
    assert.equal(await page.locator('[data-work-param="tod"]').getAttribute('min'), '0.3');
    assert.equal(await page.locator('[data-work-param="tod"]').getAttribute('max'), '0.6');
    assert.equal(await page.locator('[data-work-param="tod"]').evaluate(input => input.checkValidity()), true, 'step is a hint, not a discrete native restriction');
    await page.locator('[data-work-param="tod"]').fill('0.8');
    assert.equal(await page.locator('[data-work-param="tod"]').evaluate(input => input.checkValidity()), false);
    await page.locator('[data-work-public="tod"]').uncheck();
    assert.equal(await page.locator('[data-work-param="tod"]').getAttribute('min'), String(coast.params.tod.min));
    assert.equal(await page.locator('[data-work-param="tod"]').getAttribute('max'), String(coast.params.tod.max));
    await page.locator('#work-save').click();
    await page.waitForFunction(() => document.querySelector('#work-message').textContent.includes('作品已保存'));
    checks.push('reopened narrowed public ranges constrain author controls and removing exposure restores registry bounds without step-grid rejection');
    await page.evaluate(() => {
      const draft = Object.values(workFixture.drafts)[0];
      draft.document.properties = [{ id: 'disc-ring', label: '自定义标识', type: 'number', default: 0.45, constraints: { min: 0, max: 1, step: 0.01 }, target: { kind: 'node', nodeId: 'content', property: 'tod', component: null } }];
      draft.revision++; draft.saved = draft.revision;
    });
    await page.locator('#work-reload').click();
    await page.waitForFunction(() => !document.querySelector('#work-save').disabled);
    await page.locator('[data-work-public="discRing"]').click();
    assert.equal(await page.locator('[data-work-public="discRing"]').isChecked(), false);
    assert.match(await page.locator('#work-message').textContent(), /相同标识/);
    assert.equal((await page.evaluate(() => Object.values(workFixture.drafts)[0])).document.properties.length, 1);
    checks.push('public-ID collisions on authored reopen preserve the original target and block ambiguous exposure');
    await page.evaluate(() => workFixture.schema = workFixture.schemas['transport-fixture']);
    await page.locator('#work-new').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-work-public]').length === 64 && !document.querySelector('#work-save').disabled);
    const before = await page.evaluate(() => workFixture.requests.length);
    await page.evaluate(() => {
      document.querySelectorAll('[data-work-public]').forEach(input => input.click());
      document.querySelectorAll('[data-work-public-label]').forEach(input => { input.value = '公开参数'.repeat(30); input.dispatchEvent(new Event('input', { bubbles: true })); });
    });
    await page.locator('#work-save').click();
    await page.waitForFunction(() => document.querySelector('#work-message').textContent.includes('作品已保存'));
    const requests = await page.evaluate(before => workFixture.requests.slice(before), before);
    const updates = requests.filter(request => request.command === 'wallpaper.draft.update');
    assert.ok(updates.length >= 3, '64 large property definitions require byte-bounded batches');
    updates.forEach(request => { assert.ok(request.payload.operations.length <= 32); assert.ok(Buffer.byteLength(JSON.stringify({ protocol: 2, requestId: 'x'.repeat(128), ...request })) < 16 * 1024); });
    assert.equal((await page.evaluate(() => Object.values(workFixture.drafts)[1])).document.properties.length, 64);
    await page.locator('#work-reload').click();
    await page.waitForFunction(() => !document.querySelector('#work-save').disabled);
    assert.equal(await page.locator('[data-work-public]:checked').count(), 64);
    checks.push('64 definitions save through byte- and operation-bounded CAS batches and reload across paginated queries');
    await page.evaluate(() => workFixture.failNext = true);
    await page.locator('#work-title').fill('冲突后保留的本地标题');
    await page.locator('#work-save').click();
    await page.waitForFunction(() => document.querySelector('#work-message').textContent.includes('作品已在其他位置修改'));
    assert.equal(await page.locator('#work-title').inputValue(), '冲突后保留的本地标题');
    assert.notEqual((await page.evaluate(() => Object.values(workFixture.drafts)[1])).document.title, '冲突后保留的本地标题');
    checks.push('stale revisions preserve local input without overwriting the native document');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log(JSON.stringify({ checks, errors, output }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
