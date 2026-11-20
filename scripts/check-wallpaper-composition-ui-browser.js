// SPDX-License-Identifier: MIT
// Browser interaction evidence. Native filesystem/renderer qualification is separate.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'crates/hertz-desktop/assets');
const output = path.resolve(process.env.HERTZ_COMPOSITION_UI_OUTPUT || path.join(root, 'output/ai05-20261116/composition-ui'));
const composition = JSON.parse(fs.readFileSync(path.join(root, 'crates/hertz-wallpaper/contracts/composition.json'), 'utf8'));
const checks = [], errors = [];
let html = fs.readFileSync(path.join(assets, 'wallpaper-settings.html'), 'utf8').replace(/<script>[\s\S]*?<\/script>/g, '');
html = html.replace('__AI_CSS__', fs.readFileSync(path.join(assets, 'wallpaper-ai.css'), 'utf8') + '\n' + fs.readFileSync(path.join(assets, 'wallpaper-work-layers.css'), 'utf8'));
const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); });
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(({ composition }) => {
      const copy = value => JSON.parse(JSON.stringify(value));
      const state = window.compositionFixture = { requests: [], revision: 1, saved: 1, connected: true, profile: 'fixture', snapshots: 0, consumed: [],
        document: { documentVersion: 1, canvas: { width: 1920, height: 1080, colorSpace: 'srgb', background: '#101010' },
          nodes: [{ id: 'picture', type: 'image', stateVersion: 1, assets: { asset: 'asset-1' }, properties: { opacity: 1 } }],
          effects: [], timeline: { durationSeconds: 10, loop: true, tracks: [{ id: 'fade', target: { nodeId: 'picture', property: 'opacity' },
            keys: Array.from({ length: 240 }, (_, index) => ({ timeSeconds: index / 24, value: 1, easing: 'linear' })) }] }, bindings: [] } };
      const receipt = () => ({ kind: 'work', draftId: 'work-' + '1'.repeat(32), draftRevision: state.revision, savedRevision: state.saved,
        title: '组合作品', description: '', contentKind: 'composition', sceneId: '', stateVersion: 0, paramCount: 0, propertyCount: 0,
        nodeCount: state.document.nodes.length, effectCount: state.document.effects.length, trackCount: state.document.timeline.tracks.length,
        bindingCount: state.document.bindings.length, resourceCount: 1 });
      window.hertzWallpaperSettings = {
        currentAiContext: () => ({ profile: state.profile, revision: 1 }), currentRuntime: () => null,
        previewWork: async value => { state.preview = copy(value); }, releasePreview: async () => {},
        async requestManagement(command, payload) {
          state.requests.push(copy({ command, payload }));
          let result;
          if (command === 'wallpaper.ai.status') result = { connected: state.connected, job: null };
          else if (command === 'wallpaper.ai.connect') { state.connected = true; result = {}; }
          else if (command === 'wallpaper.ai.disconnect') { state.connected = false; result = {}; }
          else if (command === 'wallpaper.ai.capabilities') result = { outputs: [{ kind: 'builtin', ready: true }, { kind: 'composition', ready: true }], scenes: [{ id: 'coast', label: '海岸' }] };
          else if (command === 'wallpaper.ai.candidates') result = { candidates: state.candidates || [{ receiptId: 'preparing-fixture', kind: 'composition', state: 'preparing',
            artifact: { sha256: 'a'.repeat(64), expiresAt: Date.now() + 300000 } }] };
          else if (command === 'wallpaper.ai.candidate.delete') { state.candidates = state.candidates.filter(candidate => candidate.receiptId !== payload.receiptId); result = {}; }
          else if (command === 'wallpaper.ai.candidate.retry') { state.candidates.find(candidate => candidate.receiptId === payload.receiptId).state = 'preparing'; result = {}; }
          else if (command === 'wallpaper.ai.invalidate') result = {};
          else if (command === 'wallpaper.ai.assets.list') result = { assets: Array.from({ length: 33 }, (_, index) => ({ workKey: 'local:fixture-' + index,
            packageHash: String(index % 10).repeat(64), assetId: 'picture', label: '本地素材 ' + (index + 1), kind: 'image', width: 640, height: 480,
            rights: { eligible: true, basis: 'user-import', explanation: '用户导入素材' } })), nextCursor: null };
          else if (command === 'wallpaper.ai.asset-set.create') { state.snapshot = 'snapshot-' + ++state.snapshots; result = { assetSetId: state.snapshot, digest: 'a'.repeat(64), assetCount: payload.selections.length, expiresAt: Date.now() + 300000 }; }
          else if (command === 'wallpaper.ai.generate.quote') {
            if (state.consumed.includes(payload.output.assetSetId) || payload.output.assetSetId !== state.snapshot) throw new Error('asset_set_expired');
            result = { confirmationToken: 'confirmation', quoteId: 'quote', expiresAt: Date.now() + 300000,
              provider: 'fake', model: 'fixture', pricingMode: 'free', executionSeconds: 30, maximumWaitSeconds: 90, assetCount: 1, assetSetDigest: 'a'.repeat(64) };
          } else if (command === 'wallpaper.ai.generate.confirm') { state.consumed.push(state.snapshot); result = { jobId: 'job-' + state.snapshots, state: 'succeeded' }; }
          else if (command === 'wallpaper.draft.list') result = { drafts: [receipt()], nextCursor: null };
          else if (command === 'wallpaper.draft.get' || command === 'wallpaper.draft.save') { if (payload.draftId !== receipt().draftId) throw new Error('invalid persisted draft ID'); if (command.endsWith('.save')) state.saved = state.revision; result = receipt(); }
          else if (command === 'wallpaper.draft.catalog') result = { composition: { registryHash: composition.registryHash, definitions: composition.definitions } };
          else if (command === 'wallpaper.draft.schema') result = (payload.nodeType ? composition.definitions.nodes.find(value => value.type === payload.nodeType) : composition.definitions.effects.find(value => value.type === payload.effectType));
          else if (command === 'wallpaper.draft.parameters') result = { params: {}, nextCursor: null };
          else if (command === 'wallpaper.draft.properties') result = { properties: [], nextCursor: null };
          else if (command === 'wallpaper.draft.composition') {
            const items = payload.section === 'canvas' ? [state.document.canvas] : payload.section === 'resources' ? [{ assetId: 'asset-1', kind: 'image', label: '本地素材' }]
              : payload.section === 'tracks' ? state.document.timeline.tracks.map(track => ({ id: track.id, target: track.target, keys: [], keyCount: track.keys.length, keysPaged: true })) : state.document[payload.section];
            result = { section: payload.section, items: copy(items), nextCursor: null, draftRevision: state.revision, durationSeconds: state.document.timeline.durationSeconds, loop: true };
          } else if (command === 'wallpaper.draft.track.keys') {
            const track = state.document.timeline.tracks.find(track => track.id === payload.trackId), start = Number(payload.cursor || 0), end = Math.min(start + payload.limit, track.keys.length);
            result = { keys: copy(track.keys.slice(start, end)), nextCursor: end < track.keys.length ? String(end) : null, draftRevision: state.revision };
          } else if (command === 'wallpaper.draft.update') {
            for (const operation of payload.operations) {
              if (operation.kind === 'setNode') { state.document.nodes = state.document.nodes.filter(node => node.id !== operation.node.id); state.document.nodes.push(copy(operation.node)); }
              else if (operation.kind === 'setNodeProperty') state.document.nodes.find(node => node.id === operation.nodeId).properties[operation.property] = copy(operation.value);
              else if (operation.kind === 'setTrackKey') { const keys = state.document.timeline.tracks.find(track => track.id === operation.trackId).keys; keys[operation.index] = copy(operation.key); }
              else if (operation.kind === 'insertTrackKey') state.document.timeline.tracks.find(track => track.id === operation.trackId).keys.splice(operation.index, 0, copy(operation.key));
              else if (operation.kind === 'removeTrackKey') state.document.timeline.tracks.find(track => track.id === operation.trackId).keys.splice(operation.index, 1);
              else if (operation.kind === 'setTrackTarget') state.document.timeline.tracks.find(track => track.id === operation.trackId).target = copy(operation.target);
              else if (operation.kind === 'setTrack') { state.document.timeline.tracks = state.document.timeline.tracks.filter(track => track.id !== operation.track.id); state.document.timeline.tracks.push(copy(operation.track)); }
              else if (operation.kind === 'replaceCanvas') state.document.canvas = copy(operation.canvas);
              else if (operation.kind === 'replaceTimeline') { state.document.timeline.durationSeconds = operation.durationSeconds; state.document.timeline.loop = operation.loop; }
              else if (operation.kind === 'removeNode') state.document.nodes = state.document.nodes.filter(node => node.id !== operation.id);
              else throw new Error('unimplemented fixture operation ' + operation.kind);
            }
            state.revision++; result = receipt();
          } else throw new Error('unimplemented fixture command ' + command);
          return { result: copy(result) };
        }
      };
      document.querySelectorAll('[role="tabpanel"]').forEach(panel => { panel.hidden = false; });
    }, { composition });
    await page.addScriptTag({ path: path.join(assets, 'wallpaper-ai.js') });
    await page.locator('#wallpaper-generation > summary').click();
    await page.waitForSelector('#generation-kind-composition:enabled', { timeout: 5000 });
    const preparing = page.locator('[data-receipt-id="preparing-fixture"]');
    assert.equal(await preparing.locator('form, [data-candidate-preview]').count(), 0);
    assert.match(await preparing.innerText(), /正在准备/);
    checks.push('preparing candidates explain the wait and expose no preview or save action');
    await page.locator('#generation-kind-composition').check();
    await page.waitForSelector('[data-generation-asset]');
    const first = page.locator('[data-generation-asset]').first();
    await first.check();
    assert.equal(await first.evaluate(input => input.labels.length), 1);
    assert.equal(await page.evaluate(() => compositionFixture.requests.filter(request => request.command.includes('asset-set.create') || request.command.includes('generate.quote')).length), 0);
    checks.push('material selection has a native label and does not submit automatically');
    await page.locator('#generation-rights').check();
    await page.locator('#generation-brief').fill('用选定图片生成宁静的场景');
    await page.locator('#generation-quote').click();
    await page.waitForSelector('#generation-confirm:enabled');
    const calls = await page.evaluate(() => compositionFixture.requests);
    const selected = calls.find(request => request.command === 'wallpaper.ai.asset-set.create');
    assert.deepEqual(Object.keys(selected.payload.selections[0]).sort(), ['assetId', 'packageHash', 'workKey']);
    assert.equal(selected.payload.rightsConfirmed, true);
    assert.equal(calls.filter(request => request.command === 'wallpaper.ai.generate.confirm').length, 0);
    checks.push('quotation freezes only native selections and retains explicit generation confirmation');
    if (process.env.HERTZ_COMPOSITION_REPRO !== 'groups') {
      await page.locator('#generation-confirm').click();
      await page.waitForFunction(() => compositionFixture.consumed.length === 1);
      await page.waitForSelector('#generation-quote:enabled');
      await page.locator('#generation-quote').click();
      await page.waitForSelector('#generation-confirm:enabled', { timeout: 3000 });
      assert.equal(await page.evaluate(() => compositionFixture.snapshots), 2);
      checks.push('consecutive generation creates a new asset snapshot while preserving selected materials');
      await page.locator('#generation-disconnect').click();
      await page.waitForFunction(() => !compositionFixture.connected);
      await page.locator('#generation-connect').click();
      await page.waitForSelector('#generation-quote:enabled');
      await page.locator('#generation-quote').click();
      await page.waitForSelector('#generation-confirm:enabled', { timeout: 3000 });
      assert.equal(await page.evaluate(() => compositionFixture.snapshots), 3);
      await page.evaluate(() => { compositionFixture.profile = 'second'; compositionFixture.snapshot = null; window.dispatchEvent(new Event('wallpaper-ai-context')); });
      await page.waitForSelector('#generation-quote:enabled');
      await page.locator('#generation-quote').click();
      await page.waitForSelector('#generation-confirm:enabled', { timeout: 3000 });
      assert.equal(await page.evaluate(() => compositionFixture.snapshots), 4);
      assert.equal(await first.isChecked(), true);
      checks.push('disconnect and Profile changes renew temporary IDs without dropping material selection');
    }
    await first.uncheck();
    assert.equal(await page.locator('#generation-price').isVisible(), false);
    checks.push('changing selected resources invalidates the displayed quotation');
    for (let index = 0; index < 32; index++) await page.locator('[data-generation-asset]').nth(index).check();
    assert.equal(await page.locator('[data-generation-asset]').nth(32).isDisabled(), true);
    checks.push('selection limit preserves checked items and blocks a thirty-third resource');
    await page.addScriptTag({ path: path.join(assets, 'wallpaper-work-structure.js') });
    await page.addScriptTag({ path: path.join(assets, 'wallpaper-work-layers.js') });
    await page.addScriptTag({ path: path.join(assets, 'wallpaper-work-composition.js') });
    await page.addScriptTag({ path: path.join(assets, 'wallpaper-work.js') });
    await page.evaluate(() => window.hertzWallpaperWork.openDraft('work-' + '1'.repeat(32)));
    const opacity = page.locator('[data-composition-property="opacity"]');
    await opacity.fill('0.6');
    await page.waitForFunction(() => compositionFixture.document.nodes[0].properties.opacity === 0.6 && compositionFixture.saved === compositionFixture.revision);
    await page.locator('#work-undo').click();
    await page.waitForFunction(() => compositionFixture.document.nodes[0].properties.opacity === 1 && compositionFixture.saved === compositionFixture.revision);
    checks.push('composition edits and undo use the original draft revision and save owner');
    await page.locator('#work-section-tracks').check();
    const keyValue = page.locator('#work-composition fieldset').filter({ has: page.locator('legend') }).filter({ hasText: '关键帧 1' }).first().locator('input[type="number"]').nth(1);
    await keyValue.fill('0.75');
    await page.waitForFunction(() => compositionFixture.document.timeline.tracks[0].keys[0].value === 0.75 && compositionFixture.saved === compositionFixture.revision, null, { timeout: 5000 });
    const keyCalls = await page.evaluate(() => compositionFixture.requests.filter(request => request.command === 'wallpaper.draft.update'));
    assert.ok(keyCalls.some(request => request.payload.operations.some(operation => operation.kind === 'setTrackKey')));
    assert.ok(keyCalls.every(request => new TextEncoder().encode(JSON.stringify(request.payload)).length < 16 * 1024));
    assert.equal(await page.evaluate(() => compositionFixture.document.timeline.tracks[0].keys.length), 240);
    checks.push('long timelines read all key pages and save one edited key without replacing the track');
    await page.locator('#work-composition').getByRole('button', { name: '移除此关键帧', exact: true }).first().click();
    await page.waitForFunction(() => compositionFixture.document.timeline.tracks[0].keys.length === 239 && compositionFixture.saved === compositionFixture.revision);
    await page.locator('#work-undo').click();
    await page.waitForFunction(() => compositionFixture.document.timeline.tracks[0].keys.length === 240 && compositionFixture.document.timeline.tracks[0].keys[0].value === 0.75 && compositionFixture.saved === compositionFixture.revision);
    checks.push('deleting and undoing a long-track key preserves all remaining frames');
    await page.locator('#work-section-nodes').check();
    await page.evaluate(() => { compositionFixture.candidates = [{ receiptId: 'saved-fixture', state: 'saved', kind: 'composition', draftId: 'work-ai-preview-alias',
      savedDraftId: 'work-' + '1'.repeat(32), artifact: { sha256: 'a'.repeat(64), expiresAt: Date.now() + 300000 } }]; });
    await page.locator('#wallpaper-generation > summary').click(); await page.locator('#wallpaper-generation > summary').click();
    await page.locator('[data-candidate-edit="saved-fixture"]').click();
    await page.waitForFunction(() => compositionFixture.requests.filter(request => request.command === 'wallpaper.draft.get').at(-1)?.payload.draftId === 'work-' + '1'.repeat(32));
    await page.waitForFunction(() => document.activeElement.id === 'work-title' && document.getElementById('work-editor').open);
    checks.push('saved candidate editing opens the persisted draft instead of the preview alias');
    await page.evaluate(() => { compositionFixture.candidates = [{ receiptId: 'failed-fixture', state: 'failed', kind: 'composition', savedDraftId: 'work-' + '1'.repeat(32),
      diagnostics: { message: '预览预算不足' }, artifact: { sha256: 'a'.repeat(64), expiresAt: Date.now() + 300000 } }]; });
    await page.locator('#wallpaper-generation > summary').click(); await page.locator('#wallpaper-generation > summary').click();
    const failed = page.locator('[data-receipt-id="failed-fixture"]');
    assert.match(await failed.innerText(), /预览预算不足/);
    assert.equal(await failed.locator('[data-candidate-preview],form').count(), 0);
    assert.equal(await failed.locator('[data-candidate-edit]').count(), 1);
    await failed.locator('[data-candidate-delete]').click(); await failed.waitFor({ state: 'detached' });
    checks.push('failed candidates expose diagnostics, editing and deletion without claiming preview readiness');
    await page.evaluate(() => { compositionFixture.candidates = [{ receiptId: 'retry-fixture', state: 'failed', kind: 'composition',
      diagnostics: { message: '草稿数量已达上限，请先丢弃不需要的草稿' }, artifact: { sha256: 'a'.repeat(64), expiresAt: Date.now() + 300000 } }]; });
    await page.locator('#wallpaper-generation > summary').click(); await page.locator('#wallpaper-generation > summary').click();
    const retry = page.locator('[data-receipt-id="retry-fixture"]');
    assert.match(await retry.innerText(), /草稿数量已达上限/);
    await retry.locator('[data-candidate-retry]').click();
    await page.waitForFunction(() => compositionFixture.candidates[0].state === 'preparing');
    assert.equal(await page.evaluate(() => compositionFixture.requests.filter(request => request.command === 'wallpaper.ai.candidate.retry').length), 1);
    checks.push('failed preparation has one explicit retry without a new generation request');
    for (const space of ['3d', '2d']) {
      await page.evaluate(space => {
        compositionFixture.document.nodes = [{ id: 'group', type: 'group', stateVersion: 1, assets: {}, children: [], properties: { space, rotation: space === '3d' ? [0, 0, 0] : 0, opacity: 1 } }];
        compositionFixture.document.timeline.tracks = [{ id: 'fade', target: { nodeId: 'group', property: 'opacity', component: null }, keys: [{ timeSeconds: 0, value: 1, easing: 'linear' }] }];
      }, space);
      await page.evaluate(() => window.hertzWallpaperWork.openDraft('work-' + '1'.repeat(32)));
      await page.waitForSelector('#work-composition-item option[value="group"]', { state: 'attached' });
      assert.equal(await page.locator('select[data-composition-property="space"]').count(), 0);
      assert.equal(await page.locator('[data-composition-space]').innerText(), space === '3d' ? '3D 图层组' : '2D 图层组');
      assert.equal(await page.locator('[data-composition-property="rotation-0"]').count(), space === '3d' ? 1 : 0);
      assert.equal(await page.locator('[data-composition-property="x"]').count(), space === '2d' ? 1 : 0);
      assert.equal(await page.locator('[data-composition-property="position-0"]').count(), space === '3d' ? 1 : 0);
      const rotation = page.locator('[data-composition-property="' + (space === '3d' ? 'rotation-0' : 'rotation') + '"]');
      await rotation.fill('12');
      await page.waitForFunction(space => (space === '3d' ? compositionFixture.document.nodes[0].properties.rotation[0] : compositionFixture.document.nodes[0].properties.rotation) === 12 && compositionFixture.saved === compositionFixture.revision, space);
      await page.locator('#work-section-tracks').check();
      const targets = await page.locator('[name="target"] option').evaluateAll(options => options.map(option => JSON.parse(option.value)));
      assert.equal(targets.some(target => target.property === 'x'), space === '2d');
      assert.equal(targets.some(target => target.property === 'position'), space === '3d');
      assert.equal(targets.filter(target => target.property === 'rotation').length, space === '3d' ? 3 : 1);
      await page.locator('#work-section-nodes').check();
    }
    checks.push('2D and 3D groups edit and save valid rotation fields and expose only matching animation targets');
    for (const width of [1120, 800, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(output, 'materials-' + width + '.png'), fullPage: true });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, errors }, null, 2));
    console.log('PASS composition material browser checks: ' + checks.length);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
