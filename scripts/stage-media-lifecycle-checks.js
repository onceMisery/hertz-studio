// SPDX-License-Identifier: MIT
// Real browser/real native lease checks, called by the isolated persistence journey.
'use strict';
const assert = require('node:assert/strict');

async function lifecycleChecks({ page, image, video, api, restart }) {
  const checks = [];
  async function frame() {
    return page.evaluate(() => {
      const value = Backgrounds.sourceFrame(), element = value.source;
      return { ready: value.ready, tag: element?.tagName, src: element?.src, position: element?.currentTime, paused: element?.paused };
    });
  }
  async function replaced(previous) {
    await page.waitForFunction(src => {
      const value = Backgrounds.sourceFrame();
      return value.ready && value.source.tagName === 'VIDEO' && value.source.src !== src;
    }, previous.src, { timeout: 30000 });
    await page.evaluate(() => Backgrounds.ready());
    const next = await frame();
    assert.equal(next.paused, true, 'restoration retains the host pause policy');
    assert.ok(Math.abs(next.position - previous.position) < 0.15, 'restoration retains video position');
    assert.equal(await page.locator('#creative-bg video').count(), 1, 'only one video element owns the decoder');
    return next;
  }
  await page.evaluate(async () => {
    Backgrounds.setStageState({ paused: true });
    const el = Backgrounds.sourceFrame().source;
    await new Promise(resolve => { el.addEventListener('seeked', resolve, { once: true }); el.currentTime = el.duration * 0.6; });
  });
  const before = await frame(), persisted = await api('/v1/stage/presets');
  // An actual revoked native URL forces a fresh lease. No virtual time is needed.
  await page.evaluate(async () => {
    const leaseId = new URL(Backgrounds.sourceFrame().source.src).pathname.split('/').pop();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await VMusicTransport.post('/v1/stage/media', { action: 'lease.release', leaseId });
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const renewed = await replaced(before);
  assert.deepEqual((await api('/v1/stage/presets')).current, persisted.current, 'resource recovery never saves a new preset');
  checks.push('expired native lease reacquired with position and pause policy');

  // The same page remains mounted while its real service loses all runtime leases.
  await page.evaluate(() => {
    window.stageMediaConnection = true;
    document.addEventListener('service:connection', event => { window.stageMediaConnection = event.detail.connected; });
  });
  await restart();
  await page.waitForFunction(() => window.stageMediaConnection === true, {}, { timeout: 30000 });
  await replaced(renewed);
  assert.deepEqual((await api('/v1/stage/presets')).state.current, persisted.state.current, 'service restart only restores runtime state');
  checks.push('live page recovers after service restart without a reload');

  await page.evaluate(async spec => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    CreativeStage.setBackground(spec); await CreativeStage.flushPersistence();
    if (document.querySelector('#creative-bg video, #creative-bg img')) throw Error('hidden switch retained a decoder');
    let selected = false;
    try { await Backgrounds.selectMedia(spec); selected = true; } catch (error) { if (error.name !== 'AbortError') throw error; }
    if (selected) throw Error('hidden selection was confirmed without a browser probe');
    delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
    await Backgrounds.ready();
    if (Backgrounds.sourceFrame().source.tagName !== 'IMG') throw Error('visibility restored the previous video instead of the selected image');
  }, image);
  await page.evaluate(async spec => {
    const selected = await Backgrounds.selectMedia(spec);
    CreativeStage.setBackground(selected); await CreativeStage.flushPersistence(); Backgrounds.commitSelection();
  }, video);
  checks.push('hidden background changes defer decoding and restore the latest selection');

  await page.evaluate(async () => {
    const previous = Backgrounds.values();
    for (const id of ['a', 'b']) {
      try { await Backgrounds.selectMedia({ ...previous, assetRef: { ...previous.assetRef, assetId: id.repeat(64) } }); throw Error('invalid candidate accepted'); }
      catch (error) { if (error.message === 'invalid candidate accepted') throw error; }
    }
    const restored = await Backgrounds.recoverMedia();
    if (restored.assetRef.assetId !== previous.assetRef.assetId || !Backgrounds.sourceFrame().ready) throw Error('second failed candidate overwrote the rollback selection');
    Backgrounds.beginTemporaryApply(); Backgrounds.apply({ type: 'theme' });
    Backgrounds.cancelTemporaryApply(); await Backgrounds.ready();
    if (Backgrounds.values().assetRef.assetId !== previous.assetRef.assetId || !Backgrounds.sourceFrame().ready) throw Error('temporary preview failed to restore media');
  });
  checks.push('repeated failed candidates and temporary previews preserve the previous background');

  const occluded = await frame();
  await page.evaluate(async () => {
    // Match Stage3D's real event ordering: notify before updating body classes.
    document.dispatchEvent(new CustomEvent('stage:visibility', { detail: { open: true } }));
    document.body.classList.add('s3d-open');
    await Promise.resolve();
    if (!Backgrounds.sourceFrame().source.paused) throw Error('covered background kept playing');
    const leaseId = new URL(Backgrounds.sourceFrame().source.src).pathname.split('/').pop();
    await VMusicTransport.post('/v1/stage/media', { action: 'lease.release', leaseId });
    document.dispatchEvent(new CustomEvent('stage:visibility', { detail: { open: false } }));
    document.body.classList.remove('s3d-open');
  });
  await replaced(occluded);
  checks.push('returning from an occluding stage validates the lease after the host transition');

  // Delay the acquisition receipt after the server has created its lease, then
  // select a different background. Cancellation must not wait for that receipt.
  await page.evaluate(spec => {
    const acquire = StageMedia.acquire;
    window.delayedLease = null;
    StageMedia.acquire = async function (...args) {
      const lease = await acquire(...args);
      await new Promise(resolve => { window.delayedLease = { lease, resolve }; });
      return lease;
    };
    window.selectionResult = null;
    window.delayedSelection = Backgrounds.selectMedia(spec).then(
      () => { window.selectionResult = 'applied'; },
      error => { window.selectionResult = error.name; }
    ).finally(() => { StageMedia.acquire = acquire; });
  }, image);
  await page.waitForFunction(() => window.delayedLease);
  const frozen = await frame();
  assert.equal(frozen.tag, 'CANVAS'); assert.equal(frozen.ready, true, 'old frame survives while a candidate loads');
  assert.ok(await page.evaluate(() => Math.max(Backgrounds.sourceFrame().width, Backgrounds.sourceFrame().height) <= 1024), 'handoff frame allocation is bounded');
  await page.evaluate(async () => { CreativeStage.setBackground({ type: 'theme' }); await CreativeStage.flushPersistence(); });
  await page.waitForFunction(() => window.selectionResult, {}, { timeout: 2000 });
  assert.equal(await page.evaluate(() => window.selectionResult), 'AbortError');
  await page.evaluate(async () => {
    window.delayedLease.resolve(); await window.delayedSelection;
    await new Promise(resolve => setTimeout(resolve, 100));
    const response = await fetch(window.delayedLease.lease.url);
    if (response.status !== 401) throw Error('late native lease was not released');
    Backgrounds.commitSelection();
  });
  assert.equal(await page.locator('#creative-bg video, #creative-bg img, #creative-bg canvas.creative-bg-media').count(), 0);
  checks.push('cancelled acquisition settles promptly and releases a late native lease');

  // Hold play() after real decoder startup; settling that old promise later must
  // never seek/restart a detached element or apply the stale selection.
  await page.evaluate(spec => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const element = this;
      return play.call(element).then(() => new Promise(resolve => {
        window.delayedPlay = { element, resolve };
      }));
    };
    window.delayedPlay = null; window.probeResult = null;
    window.probeSelection = Backgrounds.selectMedia(spec).then(
      () => { window.probeResult = 'applied'; }, error => { window.probeResult = error.name; }
    ).finally(() => { HTMLMediaElement.prototype.play = play; });
  }, video);
  await page.waitForFunction(() => window.delayedPlay);
  await page.evaluate(() => { Backgrounds.cancelMediaSelection(); Backgrounds.apply({ type: 'theme' }); });
  await page.waitForFunction(() => window.probeResult, {}, { timeout: 2000 });
  assert.equal(await page.evaluate(() => window.probeResult), 'AbortError');
  await page.evaluate(async () => {
    const { element, resolve } = window.delayedPlay;
    resolve(); await window.probeSelection; await new Promise(done => setTimeout(done, 50));
    element.dispatchEvent(new Event('loadeddata')); element.dispatchEvent(new Event('seeked'));
    if (element.getAttribute('src') !== null || !element.paused || element.isConnected) throw Error('cancelled decoder remained live');
    if (Backgrounds.values().type !== 'theme') throw Error('late probe restored a stale background');
    Backgrounds.commitSelection();
  });
  checks.push('cancelled play probe cannot seek or restart its retired decoder');

  await page.evaluate(spec => {
    const importFile = StageMedia.importFile;
    StageMedia.importFile = () => new Promise(resolve => { window.completeImport = () => resolve(spec); });
    window.importResult = null;
    window.pendingImport = Backgrounds.setLocalFile({ name: 'already-installed.jpg' }).then(
      () => { window.importResult = 'applied'; }, error => { window.importResult = error.message; }
    ).finally(() => { StageMedia.importFile = importFile; });
    CreativeStage.renamePreset('changed during upload');
  }, image);
  await page.evaluate(async () => { window.completeImport(); await window.pendingImport; await CreativeStage.flushPersistence(); });
  assert.match(await page.evaluate(() => window.importResult), /导入期间舞台已修改/);
  assert.equal((await api('/v1/stage/presets')).current.bg.type, 'theme');
  checks.push('an upload cannot overwrite a newer preset revision');

  // Restore the durable video before the remaining independent save-conflict checks.
  await page.evaluate(async spec => {
    const selected = await Backgrounds.selectMedia(spec);
    CreativeStage.setBackground(selected); await CreativeStage.flushPersistence(); Backgrounds.commitSelection();
    Backgrounds.setStageState(null);
  }, video);
  console.log('Stage media lifecycle: ' + checks.length + ' real browser scenarios passed');
  return checks;
}

module.exports = { lifecycleChecks };
