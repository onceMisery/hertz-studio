// SPDX-License-Identifier: MIT
// Rendered editor/bridge checks; real persistence/compiler checks live in WorkDrafts.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), assets = path.join(root, 'crates/hertz-desktop/assets');
const output = path.resolve(process.env.HERTZ_WORK_LAYERS_OUTPUT || path.join(root, 'output/composition-hierarchy-20261119/browser'));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'crates/hertz-wallpaper/contracts/composition.json'), 'utf8')).definitions;
let html = fs.readFileSync(path.join(assets, 'wallpaper-settings.html'), 'utf8').replace(/<script>[\s\S]*?<\/script>/g, '');
html = html.replace('__AI_CSS__', fs.readFileSync(path.join(assets, 'wallpaper-ai.css'), 'utf8') + '\n' + fs.readFileSync(path.join(assets, 'wallpaper-work-layers.css'), 'utf8'));
const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); });
const checks = [], errors = [];
(async () => {
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(catalog => {
      const copy = value => JSON.parse(JSON.stringify(value));
      const group = (id, children = [], space = '2d') => ({ id, type: 'group', stateVersion: 1, assets: {}, children, properties: { space, opacity: 0.5, ...(space === '2d' ? { width: 128, height: 128, anchorX: 0, anchorY: 0 } : {}) } });
      const leaf = id => ({ id, type: 'particles', stateVersion: 1, assets: {}, children: [], properties: { count: 8, width: 64, height: 64, anchorX: 0, anchorY: 0, opacity: 0.6 } });
      const state = window.layerFixture = { revision: 1, saved: 1, title: '层级作品', requests: [], loseNext: false, conflictNext: false,
        document: { documentVersion: 1, canvas: { width: 640, height: 360, colorSpace: 'srgb', background: '#101010' },
          nodes: [group('outer', ['inner', 'leaf-a']), leaf('leaf-a'), group('inner', ['leaf-b']), leaf('leaf-b'), group('other'), group('spatial', [], '3d')],
          effects: [{ id: 'adjust', type: 'colorAdjust', stateVersion: 1, target: { kind: 'output' }, assets: {}, properties: {} },
            { id: 'glow', type: 'glow', stateVersion: 1, target: { kind: 'output' }, assets: {}, properties: {} }],
          timeline: { durationSeconds: 10, loop: true, tracks: [] }, bindings: [] } };
      state.makeGroup = group;
      const receipt = () => ({ kind: 'work', draftId: 'work-' + '1'.repeat(32), draftRevision: state.revision, savedRevision: state.saved,
        title: state.title, description: '', sceneId: '', stateVersion: 0, contentKind: 'composition', resourceCount: 0 });
      const failure = code => Object.assign(new Error(code), { code });
      function apply(operation) {
        if (['moveNode', 'reorderNodes', 'reorderEffects'].includes(operation.kind)) window.hertzWallpaperWorkStructure.apply(state.document, operation);
        else if (operation.kind === 'setNodeProperty') state.document.nodes.find(node => node.id === operation.nodeId).properties[operation.property] = copy(operation.value);
        else if (operation.kind === 'replaceMetadata') state.title = operation.title;
        else {
          const match = /^(set|remove)(Node|Effect|Track|Binding)$/.exec(operation.kind);
          if (!match) throw new Error('Unexpected operation ' + operation.kind);
          const name = match[2].toLowerCase(), items = name === 'track' ? state.document.timeline.tracks : state.document[name + 's'];
          const item = operation[name], index = items.findIndex(value => value.id === (item ? item.id : operation.id));
          if (match[1] === 'remove') items.splice(index, 1);
          else if (index >= 0) items[index] = copy(item);
          else items.push(copy(item));
        }
      }
      window.hertzWallpaperSettings = { previewWork: async value => { state.preview = copy(value); }, releasePreview: async () => {},
        async requestManagement(command, payload) {
          state.requests.push(copy({ command, payload })); let result;
          if (command === 'wallpaper.draft.get') result = receipt();
          else if (command === 'wallpaper.draft.list') result = { drafts: [receipt()], nextCursor: null };
          else if (command === 'wallpaper.draft.catalog') result = { composition: { definitions: catalog } };
          else if (command === 'wallpaper.draft.parameters') result = { params: {}, nextCursor: null };
          else if (command === 'wallpaper.draft.properties') result = { properties: [], nextCursor: null };
          else if (command === 'wallpaper.draft.composition') result = { items: copy(payload.section === 'canvas' ? [state.document.canvas] : payload.section === 'resources' ? [] : payload.section === 'tracks' ? state.document.timeline.tracks : state.document[payload.section]),
            nextCursor: null, durationSeconds: state.document.timeline.durationSeconds, loop: state.document.timeline.loop };
          else if (command === 'wallpaper.draft.update') {
            if (state.conflictNext) { state.conflictNext = false; state.title = '另一页面的修改'; state.revision++; throw failure('draft_conflict'); }
            if (payload.draftRevision !== state.revision) throw failure('draft_conflict');
            payload.operations.forEach(apply); state.revision++; result = receipt();
            if (state.loseNext) { state.loseNext = false; throw failure('receipt_timeout'); }
          } else if (command === 'wallpaper.draft.save') {
            if (payload.draftRevision !== state.revision) throw failure('draft_conflict');
            state.saved = state.revision; result = receipt();
          } else throw new Error('Unexpected command ' + command);
          return { result: copy(result) };
        }
      };
      document.querySelectorAll('[role="tabpanel"]').forEach(panel => { panel.hidden = false; });
    }, catalog);
    for (const file of ['wallpaper-work-structure.js', 'wallpaper-work-layers.js', 'wallpaper-work-composition.js', 'wallpaper-work.js']) await page.addScriptTag({ path: path.join(assets, file) });
    await page.evaluate(() => window.hertzWallpaperWork.openDraft('work-' + '1'.repeat(32)));
    const ids = () => page.locator('#work-composition-layers > li').evaluateAll(rows => rows.map(row => row.dataset.layerId));
    const select = id => page.locator('#work-composition-layers > li[data-layer-id="' + id + '"] button').click();
    const flush = () => page.evaluate(() => window.hertzWallpaperWork.flush());
    const children = id => page.evaluate(id => layerFixture.document.nodes.find(node => node.id === id).children, id);
    assert.deepEqual(await ids(), ['outer', 'inner', 'leaf-b', 'leaf-a', 'other', 'spatial']);
    await select('leaf-a');
    assert.equal(await page.locator('#work-composition-parent option[value="spatial"]').count(), 0);
    await page.locator('#work-composition-parent').selectOption('inner'); await flush();
    assert.deepEqual(await children('inner'), ['leaf-b', 'leaf-a']); assert.deepEqual(await children('outer'), ['inner']);
    assert.equal(await page.evaluate(() => layerFixture.requests.filter(request => request.command === 'wallpaper.draft.update').flatMap(request => request.payload.operations).some(operation => operation.kind === 'moveNode')), true);
    checks.push('nested layer selection and atomic reparenting persist through the original draft bridge');

    await select('outer');
    await page.locator('[data-composition-property="x"]').fill('40');
    await page.locator('[data-composition-property="scaleX"]').fill('2'); await flush();
    const inherited = await page.locator('[data-composition-layer="leaf-a"]').evaluate(rect => ({
      parent: rect.parentElement.parentElement.dataset.compositionGroup,
      outer: rect.closest('[data-composition-group="outer"]').transform.baseVal.consolidate().matrix.a,
      x: rect.closest('[data-composition-group="outer"]').transform.baseVal.consolidate().matrix.e
    }));
    assert.deepEqual(inherited, { parent: 'inner', outer: 2, x: 40 });
    await select('leaf-a');
    const diagram = page.locator('[data-composition-layer="leaf-a"]'); await diagram.scrollIntoViewIfNeeded();
    const box = await diagram.boundingBox(), localScale = await diagram.evaluate(rect => rect.parentElement.parentElement.getScreenCTM().a);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 3 }); await page.mouse.up(); await flush();
    const dragged = await page.evaluate(() => layerFixture.document.nodes.find(node => node.id === 'leaf-a').properties.x);
    assert.ok(Math.abs(dragged - 20 / localScale) < 0.01, JSON.stringify({ dragged, localScale }));
    checks.push('position sketch inherits group transforms and pointer dragging uses local parent coordinates');

    await page.evaluate(() => { window.layerRow = document.querySelector('[data-layer-id="leaf-a"]'); });
    await page.locator('#work-composition-back').focus(); await page.keyboard.press('Enter'); await flush();
    assert.deepEqual(await children('inner'), ['leaf-a', 'leaf-b']);
    assert.equal(await page.evaluate(() => layerRow === document.querySelector('[data-layer-id="leaf-a"]')), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'work-composition-back');
    await page.locator('#work-undo').click(); await flush(); assert.deepEqual(await children('inner'), ['leaf-b', 'leaf-a']);
    await page.locator('#work-redo').click(); await flush(); assert.deepEqual(await children('inner'), ['leaf-a', 'leaf-b']);
    await page.locator('#work-reload').click(); assert.deepEqual(await ids(), ['outer', 'inner', 'leaf-a', 'leaf-b', 'other', 'spatial']);
    checks.push('sibling order, undo/redo and reload retain exact children and keyboard focus');

    await select('other'); await page.locator('#work-composition-back').click(); await flush();
    assert.deepEqual(await ids(), ['other', 'outer', 'inner', 'leaf-a', 'leaf-b', 'spatial']);
    await page.evaluate(() => { window.rootRow = document.querySelector('[data-layer-id="other"]'); Object.defineProperty(document.getElementById('work-composition-layers'), 'moveBefore', { value: undefined, configurable: true }); });
    await select('other');
    await page.locator('#work-composition-forward').focus(); await page.keyboard.press('Space'); await flush();
    assert.deepEqual(await ids(), ['outer', 'inner', 'leaf-a', 'leaf-b', 'other', 'spatial']);
    assert.equal(await page.evaluate(() => rootRow === document.querySelector('[data-layer-id="other"]')), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'work-composition-forward');
    checks.push('root order saves without replacing child data; insertion fallback preserves DOM identity and focus');

    await page.locator('#work-section-effects').check(); await page.locator('#work-composition-item').selectOption('glow');
    await page.locator('#work-composition-back').click(); await flush();
    assert.deepEqual(await page.evaluate(() => layerFixture.document.effects.map(effect => effect.id)), ['glow', 'adjust']);
    await page.locator('#work-undo').click(); await flush();
    assert.deepEqual(await page.evaluate(() => layerFixture.document.effects.map(effect => effect.id)), ['adjust', 'glow']);
    await page.locator('#work-redo').click(); await flush();
    checks.push('effect-chain order has explicit execution controls and survives undo/redo');

    await page.locator('#work-section-nodes').check();
    await page.locator('#work-composition-type').selectOption('group:3d');
    await page.locator('#work-composition').getByRole('button', { name: '添加', exact: true }).click(); await flush();
    assert.equal(await page.locator('[data-composition-space]').innerText(), '3D 图层组');
    assert.equal(await page.locator('#work-composition-parent option[value="outer"]').count(), 0);
    await page.locator('#work-composition-type').selectOption('group:2d');
    await page.locator('#work-composition').getByRole('button', { name: '添加', exact: true }).click(); await flush();
    assert.equal(await page.locator('[data-composition-space]').innerText(), '2D 图层组');
    assert.equal(await page.locator('#work-composition-parent option[value="spatial"]').count(), 0);
    await select('outer');
    assert.equal(await page.locator('#work-composition-parent option[value="inner"]').count(), 0);
    const countBefore = await page.evaluate(() => layerFixture.requests.length);
    await page.evaluate(() => { const input = document.getElementById('work-composition-parent'), option = document.createElement('option'); option.value = 'inner'; input.append(option); input.value = 'inner'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.match(await page.locator('#work-message').innerText(), /自己|子组/);
    assert.equal(await page.evaluate(() => layerFixture.requests.length), countBefore);
    checks.push('explicit 2D/3D group creation and cycle/space controls preserve valid input');

    await select('inner'); await page.locator('#work-composition-parent').selectOption('');
    await select('outer'); await page.locator('#work-composition-parent').selectOption('inner'); await flush();
    assert.deepEqual(await children('inner'), ['leaf-a', 'leaf-b', 'outer']);
    assert.deepEqual(await children('outer'), []);
    checks.push('quick reversal of nested groups produces a valid sequence of structural edits');

    await select('other'); await page.evaluate(() => { layerFixture.loseNext = true; layerFixture.beforeLoss = layerFixture.requests.length; });
    await page.locator('#work-composition-forward').click(); await flush();
    assert.equal(await page.evaluate(() => layerFixture.requests.slice(layerFixture.beforeLoss).filter(request => request.command === 'wallpaper.draft.update').length), 1);
    assert.equal(await page.evaluate(() => layerFixture.requests.slice(layerFixture.beforeLoss).some(request => request.command === 'wallpaper.draft.get')), true);
    assert.match(await page.locator('#work-message').innerText(), /已保存/);
    await page.evaluate(() => { layerFixture.conflictNext = true; layerFixture.beforeConflict = layerFixture.requests.length; });
    await page.locator('#work-composition-back').click();
    await assert.rejects(flush(), /本地编辑已保留/);
    assert.equal(await page.evaluate(() => layerFixture.requests.slice(layerFixture.beforeConflict).filter(request => request.command === 'wallpaper.draft.update').length), 1);
    assert.equal(await page.locator('#work-title').inputValue(), '层级作品');
    await page.locator('#work-reload').click(); assert.equal(await page.locator('#work-title').inputValue(), '另一页面的修改');
    checks.push('lost receipts query the saved order once; a conflict preserves local edits without replay');

    await page.evaluate(() => {
      layerFixture.document.nodes = Array.from({ length: 9 }, (_, index) => layerFixture.makeGroup('deep-' + index, index < 7 ? ['deep-' + (index + 1)] : []));
      layerFixture.document.nodes.push(layerFixture.makeGroup('spatial', [], '3d')); layerFixture.document.effects = [];
      layerFixture.document.nodes[8].id = 'node-' + 'a'.repeat(59);
    });
    await page.locator('#work-reload').click();
    await select('node-' + 'a'.repeat(59));
    assert.equal(await page.locator('#work-composition-parent option[value="deep-7"]').count(), 0);
    assert.equal(await page.locator('#work-composition-parent option[value="deep-6"]').count(), 1);
    for (const width of [1120, 520, 360, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await page.locator('.work-layer-fields').evaluate(node => ({ width: node.getBoundingClientRect().width, scroll: node.scrollWidth, client: node.clientWidth,
        controls: [...node.querySelectorAll('select,button')].filter(control => control.getClientRects().length).map(control => ({ left: control.getBoundingClientRect().left, right: control.getBoundingClientRect().right, height: control.getBoundingClientRect().height })) }));
      assert.ok(geometry.scroll <= geometry.client + 1, JSON.stringify({ width, geometry }));
      assert.ok(geometry.controls.every(control => control.left >= -1 && control.right <= width + 1 && control.height >= 24), JSON.stringify({ width, geometry }));
      await page.locator('#work-composition-layers').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, 'layers-' + width + '.png') });
      await page.locator('#work-composition-parent').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, 'controls-' + width + '.png') });
    }
    checks.push('eight-level boundary, long IDs and 1120/520/360/320px controls remain usable');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, viewportWidths: [1120, 520, 360, 320] }, null, 2) + '\n');
    console.log(JSON.stringify({ passed: checks.length, checks, output }, null, 2));
  } finally {
    if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ checks, errors, error: error.stack }, null, 2) + '\n'); console.error(error); process.exitCode = 1; });
