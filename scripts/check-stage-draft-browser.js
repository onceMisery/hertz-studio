// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Real browser + isolated service; no model calls. Checks temporary presentation,
// pending 400ms persistence, version rejection and lifecycle ownership.
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { uiUrl } = require('./ui-token');

async function main() {
  const fixture = await startFixture();
  process.env.VMUSIC_DATA_DIR = fixture.dataDir;
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await fixture.connect(context);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(uiUrl(fixture.base), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#workshop .ws-targets'));
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('io'); });
    const original = await page.evaluate(() => {
      // Leave a normal edit's save timer pending when the preview begins.
      CreativeStage.setPreset(CreativeStage.canonicalBaseline('orb'));
      CreativeStage.setBackground({ type: 'mesh' });
      return { preset: CreativeStage.preset(), share: CreativeStage.shareSnapshot(), library: CreativeStage.library() };
    });
    const artifact = await page.evaluate(() => CreativeDraft.artifact({ version: 1, scene: 'towers',
      patch: { 'sc.height': 9999 }, hand: { on: true }, director: false }));
    const text = JSON.stringify(artifact);
    let modelDispatches = 0;
    await page.route('**/v1/ai/**', route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const dispatch = request.method() === 'POST'
        && (pathname === '/v1/ai/jobs' || pathname === '/v1/ai/lyrics/emotion');
      if (dispatch) {
        modelDispatches += 1;
        return route.abort();
      }
      return route.continue();
    });
    async function preview() {
      await page.locator('#ws-draft-json').fill(text);
      await page.locator('#ws-draft-preview').click();
      await page.getByRole('button', { name: '取消预览', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => CreativeStage.scene()), 'towers');
    }
    // Start the edit and preview in one synchronous browser task. An async
    // prepare + Playwright actionability delay can legitimately exceed 400ms;
    // that must not accidentally test a save which fired before preview began.
    await page.evaluate(async a => {
      const prepared = await CreativeDraft.prepare(a);
      window.previewSaves = [];
      CreativeStage.onChange(kind => { if (kind === 'change') window.previewSaves.push(!!CreativeStage.preview()); });
      CreativeStage.setPreset(CreativeStage.preset());
      CreativeStage.beginPreview(prepared.preset, prepared.proposalHash);
    }, artifact);
    await page.waitForTimeout(650);
    const during = await page.evaluate(() => ({ preset: CreativeStage.preset(), share: CreativeStage.shareSnapshot(),
      library: CreativeStage.library(), saved: JSON.parse(localStorage.getItem('vmusic.creative.preset')) }));
    assert.ok(await page.evaluate(() => window.previewSaves.includes(true)), '400ms save fired during preview');
    assert.deepEqual(during.preset, original.preset);
    assert.deepEqual(during.saved, original.preset, 'pending timer saves committed state');
    assert.deepEqual(during.share, original.share, 'preview backgrounds never enter committed share snapshot');
    assert.deepEqual(during.library, original.library);
    console.log('PASS temporary rendering, pending autosave, share and library isolation');

    await page.evaluate(() => CreativeStage.cancelPreview());
    await preview();
    const activePreviewId = await page.evaluate(() => CreativeStage.preview().previewId);
    const rejectedIntent = await page.evaluate(() => CreativeStage.applyIntent({ version: 2, scene: 'towers' }));
    assert.equal(rejectedIntent.ok, false);
    assert.equal(rejectedIntent.code, 'bad_version');
    assert.equal(await page.evaluate(() => CreativeStage.preview().previewId), activePreviewId,
      'invalid intent must not discard the active temporary preview');
    console.log('PASS invalid apply preserves active preview');
    assert.match(await page.locator('#ws-body').innerText(), /已调整到支持范围/);
    await page.getByRole('button', { name: '取消预览', exact: true }).click();
    assert.equal(await page.evaluate(() => CreativeStage.scene()), 'orb');
    await preview();
    await page.evaluate(() => Workshop.setTab('params'));
    assert.equal(await page.evaluate(() => CreativeStage.preview()), null);
    await page.evaluate(() => Workshop.setTab('io'));
    await preview();
    await page.evaluate(() => Workshop.close());
    assert.equal(await page.evaluate(() => CreativeStage.preview()), null);
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('io'); });
    await preview();
    const stale = await page.evaluate(() => CreativeStage.preview());
    await page.evaluate(() => CreativeStage.setParam('look.grade', 2));
    assert.equal(await page.evaluate(token => CreativeStage.applyPreview(token.previewId, token.proposalHash).ok, stale), false);
    assert.equal(await page.evaluate(() => CreativeStage.preset().look.grade), 2);
    console.log('PASS cancel, page switch, close and ordinary-edit invalidation');

    await preview();
    // Visibility lifecycle uses the actual browser API when the page is hidden.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    // The document event handler is also exercised deterministically: Chrome's
    // headless focus policy does not consistently hide background tabs.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.hidden;
    });
    assert.equal(await page.evaluate(() => CreativeStage.preview()), null);
    console.log('PASS hidden document discards temporary layer');

    const committed = await page.evaluate(() => ({
      preset: CreativeStage.preset(),
      saved: JSON.parse(localStorage.getItem('vmusic.creative.preset')),
    }));
    await page.evaluate(async a => {
      const prepared = await CreativeDraft.prepare(a);
      CreativeStage.setPreset(CreativeStage.preset()); // Keep a committed-state save pending during unload.
      CreativeStage.beginPreview(prepared.preset, prepared.proposalHash);
      window.addEventListener('pagehide', () => {
        sessionStorage.setItem('stage-draft-pagehide-preview', JSON.stringify(CreativeStage.preview()));
      });
    }, artifact);
    assert.equal(await page.evaluate(() => CreativeStage.scene()), 'towers');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#workshop .ws-targets'));
    const afterReload = await page.evaluate(() => ({
      preview: CreativeStage.preview(),
      preset: CreativeStage.preset(),
      saved: JSON.parse(localStorage.getItem('vmusic.creative.preset')),
      pagehidePreview: JSON.parse(sessionStorage.getItem('stage-draft-pagehide-preview')),
    }));
    assert.equal(afterReload.pagehidePreview, null, 'pagehide must discard the temporary preview');
    assert.equal(afterReload.preview, null, 'reload starts without the prior in-memory preview');
    assert.deepEqual(afterReload.preset, committed.preset, 'reload restores the committed preset');
    assert.deepEqual(afterReload.saved, committed.saved, 'unconfirmed candidate must not enter localStorage');
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('io'); });
    console.log('PASS pagehide and reload discard preview without changing committed storage');

    const prior = await page.evaluate(() => CreativeStage.preset());
    await page.locator('#ws-draft-json').fill(JSON.stringify({ ...artifact, basePresetHash: 'stale' }));
    await page.locator('#ws-draft-preview').click();
    await page.waitForFunction(() => document.querySelector('#ws-body').innerText.includes('不兼容'));
    assert.deepEqual(await page.evaluate(() => CreativeStage.preset()), prior);
    assert.equal(await page.getByRole('button', { name: '应用到当前舞台', exact: true }).count(), 0);
    console.log('PASS incompatible artifact rejects without writes');

    await preview();
    const expected = await page.evaluate(async a => (await CreativeDraft.prepare(a)).preset, artifact);
    await page.getByRole('button', { name: '应用到当前舞台', exact: true }).click();
    await page.waitForFunction(() => !CreativeStage.preview());
    await page.waitForTimeout(500);
    assert.deepEqual(await page.evaluate(() => CreativeStage.preset()), expected);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('vmusic.creative.preset'))), expected);
    assert.equal(modelDispatches, 0, 'manual import must not dispatch a model request');
    assert.deepEqual(errors, []);
    console.log('PASS explicit apply persists complete draft; manual import never contacts AI');
  } finally {
    await browser.close(); await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
