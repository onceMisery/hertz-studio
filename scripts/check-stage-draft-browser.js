// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Real browser + isolated service; no model calls. Checks temporary presentation,
// pending 400ms persistence, version rejection and lifecycle ownership.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { uiUrl } = require('./ui-token');

async function main() {
  const fixture = await startFixture();
  process.env.VMUSIC_DATA_DIR = fixture.dataDir;
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'no-preference' });
  await fixture.connect(context);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const uiRoot = path.resolve(__dirname, '../plugin/ui');
    await page.route('**/*', route => {
      const asset = path.resolve(uiRoot, '.' + decodeURIComponent(new URL(route.request().url()).pathname));
      if (asset.startsWith(uiRoot + path.sep) && fs.existsSync(asset) && fs.statSync(asset).isFile()) {
        return route.fulfill({ path: asset });
      }
      return route.continue();
    });
    await page.goto(uiUrl(fixture.base), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#workshop .ws-targets'));
    await page.evaluate(() => Stage.setReducedMotion(false));
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('prompt'); });
    await page.locator('#ws-prompt-text').fill('十秒后切换到星云');
    await page.getByRole('button', { name: '解析', exact: true }).click();
    const timelineMessage = await page.locator('.ws-prompt-result').innerText();
    assert.match(timelineMessage, /不支持时间轴或自动切换编排/);
    assert.doesNotMatch(timelineMessage, /只认这些词/);
    await page.evaluate(() => Workshop.setTab('io'));
    const original = await page.evaluate(() => {
      // Leave a normal edit's save timer pending when the preview begins.
      CreativeStage.setPreset(CreativeStage.canonicalBaseline('orb'));
      CreativeStage.setBackground({ type: 'mesh' });
      return { preset: CreativeStage.preset(), share: CreativeStage.shareSnapshot(), library: CreativeStage.library() };
    });
    const artifact = await page.evaluate(() => CreativeDraft.artifact({ version: 1, scene: 'towers',
      patch: { 'sc.height': 9999 }, hand: { on: true }, director: false }));
    const text = JSON.stringify(artifact);
    const previewAnimations = await page.evaluate(async a => {
      const prepared = await CreativeDraft.prepare(a);
      CreativeStage.fire({ set: { 'look.bloom': 2.5 }, len: 5000, ease: 'linear' });
      const committedAnimations = CreativeStage.stats().animations;
      CreativeStage.beginPreview(prepared.preset, prepared.proposalHash);
      return { committedAnimations, previewAnimations: CreativeStage.stats().animations,
        reduced: Stage.presentation().reduced };
    }, artifact);
    assert.equal(previewAnimations.committedAnimations, 1, 'a committed cue is active before preview');
    assert.equal(previewAnimations.previewAnimations, 0, 'preview evaluates its own motion state');
    const immediateCue = await page.evaluate(() => {
      const preview = CreativeStage.preview();
      const canceled = CreativeStage.cancelPreview();
      return { preview, canceled, animations: CreativeStage.stats().animations,
        bloom: CreativeStage.runtime()['look.bloom'] };
    });
    assert.ok(immediateCue.animations > 0, 'cancel restores cue synchronously: ' + JSON.stringify(immediateCue));
    await page.waitForTimeout(180);
    const resumedCue = await page.evaluate(() => ({
      animations: CreativeStage.stats().animations,
      bloom: CreativeStage.runtime()['look.bloom'],
      reduced: Stage.presentation().reduced,
    }));
    assert.ok(resumedCue.animations > 0,
      'cancel restores committed cue animation: ' + JSON.stringify(resumedCue));
    assert.ok(resumedCue.bloom > 0.28 && resumedCue.bloom < 2.5, 'restored cue keeps advancing');
    await page.evaluate(() => CreativeStage.setPreset(CreativeStage.preset()));
    console.log('PASS preview cancellation restores committed cue animation');
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

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#0f0"/></svg>';
    const mediaPreview = await page.evaluate(async ({ artifact: a, source }) => {
      window.revokedBackgroundUrls = [];
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = url => { window.revokedBackgroundUrls.push(url); revoke(url); };
      const prepared = await CreativeDraft.prepare(a);
      CreativeStage.beginPreview(prepared.preset, prepared.proposalHash);
      // Match the UI change handler: release preview-owned URLs before creating the new one.
      CreativeStage.cancelPreview();
      const spec = Backgrounds.setLocalFile(new File([source], 'local.svg', { type: 'image/svg+xml' }));
      CreativeStage.setBackground(spec);
      return spec;
    }, { artifact, source: svg });
    try {
      await page.waitForFunction(() => {
        const image = document.querySelector('#creative-bg .creative-bg-media');
        return image && image.naturalWidth === 24;
      }, { timeout: 5000 });
    } catch {
      const mediaState = await page.evaluate(() => {
        const image = document.querySelector('#creative-bg .creative-bg-media');
        return { spec: Backgrounds.values(), exists: !!image, src: image && image.src,
          complete: image && image.complete, naturalWidth: image && image.naturalWidth,
          revoked: window.revokedBackgroundUrls,
          layer: document.getElementById('creative-bg') && document.getElementById('creative-bg').outerHTML };
      });
      throw new Error('local background image did not load: ' + JSON.stringify({ mediaState, errors }));
    }
    await page.evaluate(async a => {
      const prepared = await CreativeDraft.prepare(a);
      CreativeStage.beginPreview(prepared.preset, prepared.proposalHash);
    }, artifact);
    assert.equal(await page.evaluate(url => window.revokedBackgroundUrls.includes(url), mediaPreview.url), false,
      'preview must retain the committed local media URL');
    await page.evaluate(() => CreativeStage.cancelPreview());
    await page.waitForFunction(url => {
      const image = document.querySelector('#creative-bg .creative-bg-media');
      return image && image.src === url && image.naturalWidth === 24;
    }, mediaPreview.url);
    assert.equal(await page.evaluate(url => Backgrounds.values().url === url, mediaPreview.url), true);
    const mediaReplacement = await page.evaluate(() => CreativeDraft.artifact({
      version: 1, scene: 'orb', patch: {}, director: false,
    }));
    await page.evaluate(async a => {
      const prepared = await CreativeDraft.prepare(a);
      CreativeStage.beginPreview(prepared.preset, prepared.proposalHash);
    }, mediaReplacement);
    const mediaPreviewToken = await page.evaluate(() => CreativeStage.preview());
    await page.evaluate(token => CreativeStage.applyPreview(token.previewId, token.proposalHash), mediaPreviewToken);
    assert.equal(await page.evaluate(url => window.revokedBackgroundUrls.includes(url), mediaPreview.url), true,
      'confirming the replacement must release the old local media URL');
    assert.equal(await page.evaluate(() => Backgrounds.values().type), 'theme');
    console.log('PASS local media survives preview cancellation and is released after confirmation');

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

    const sameScene = await page.evaluate(() => {
      const current = CreativeStage.canonicalBaseline('orb');
      current.look.grade = 3;
      current.look.bloom = 0.9;
      CreativeStage.setPreset(current);
      return {
        preset: CreativeStage.preset(),
        artifact: CreativeDraft.artifact({ version: 1, scene: 'orb', patch: { 'cam.drift': 10 } }),
      };
    });
    await page.waitForFunction(expected => JSON.stringify(JSON.parse(localStorage.getItem('vmusic.creative.preset'))) === JSON.stringify(expected), sameScene.preset);
    const sameSceneText = JSON.stringify(sameScene.artifact);
    await page.locator('#ws-draft-json').fill(sameSceneText);
    await page.locator('#ws-draft-preview').click();
    await page.getByRole('button', { name: '取消预览', exact: true }).waitFor();
    const draftPreview = await page.locator('#ws-body').innerText();
    assert.match(draftPreview, /look\.grade：当前 3 → 候选 0/);
    assert.match(draftPreview, /look\.bloom：当前 0\.9 → 候选 0\.28/);
    assert.match(draftPreview, /应用会替换整份当前预置/);
    assert.deepEqual(await page.evaluate(() => CreativeStage.preset()), sameScene.preset,
      'preview must leave the edited preset unchanged until confirmation');
    await page.getByRole('button', { name: '应用到当前舞台', exact: true }).click();
    await page.waitForFunction(() => !CreativeStage.preview());
    const sameSceneExpected = await page.evaluate(async a => (await CreativeDraft.prepare(a)).preset, sameScene.artifact);
    assert.deepEqual(await page.evaluate(() => CreativeStage.preset()), sameSceneExpected,
      'confirmed create applies its full canonical candidate, including defaulted values');
    await page.getByRole('button', { name: '撤销本次应用', exact: true }).click();
    await page.waitForFunction(expected => JSON.stringify(CreativeStage.preset()) === JSON.stringify(expected), sameScene.preset);
    assert.deepEqual(await page.evaluate(() => CreativeStage.preset()), sameScene.preset,
      'confirmed imported drafts can restore the complete prior preset');
    console.log('PASS create preview lists every reset value and explains full-preset replacement');

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
