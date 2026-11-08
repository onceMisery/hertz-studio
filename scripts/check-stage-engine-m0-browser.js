'use strict';
// Post-implementation checks against the production Stage, Onset and renderers.
// Virtual time is used only for contracts. The samples section uses native time.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
const web = path.join(root, 'plugin/ui');
const sources = ['stage-resource-budget.js', 'stage-resource-policy.js', 'stage.js', 'onset.js', 'stage-particles.js', 'stage-particles-gl.js', 'perf-probe.js', 'stage.css'];
const out = path.join(root, 'output/playwright/m0-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const digest = () => Object.fromEntries(sources.map(file => [file,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(web, file))).digest('hex')]));
const report = { startedAt: new Date().toISOString(), sourceSha256: digest(),
  verificationSourceSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  scope: 'Windows Chrome headless; production modules in a minimal DOM. Controlled contract time and native CPU submission samples are separate. Full application/service journey is a separate check.',
  checks: [], errors: [], evidence: {} };
let browser;

async function check(name, fn) {
  try { const evidence = await fn(); report.checks.push({ name, status: 'passed', evidence }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, status: 'failed', message: error.message, stack: error.stack }); console.error('FAIL ' + name + ': ' + error.message); }
}

async function pageFor({ virtual = true, noWaapi = false, dpr = 2, cores = 8, viewport = { width: 1360, height: 820 } } = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: dpr });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.setContent('<style>html,body{margin:0;background:#151719;color:#eee}#stage{width:640px;height:480px;position:relative;overflow:hidden;margin:24px}.stage-lyrics{height:80px;position:absolute;top:200px;width:100%}.stage-particles{position:absolute;left:0;top:0}.stage-ripple{position:absolute;border:1px solid #fff;border-radius:50%;pointer-events:none}</style><div id="stage"><div id="lyrics" class="stage-lyrics"></div></div>');
  await page.evaluate(({ virtual, noWaapi, cores }) => {
    const h = window.harness = { virtual, time: 100, hidden: false, id: 0, pending: new Map(),
      requested: 0, cancelled: 0, particleTicks: [], gateTicks: [], notifications: [], borrowedIdentity: true,
      nativeNow: performance.now.bind(performance), observerAdds: 0, observerRemoves: 0, observers: [] };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h.hidden });
    Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: cores });
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
    if (virtual) {
      performance.now = () => h.time;
      window.requestAnimationFrame = cb => { h.requested++; h.pending.set(++h.id, cb); return h.id; };
      window.cancelAnimationFrame = id => { h.cancelled++; h.pending.delete(id); };
      h.advance = async (count, dt = 1000 / 60) => {
        for (let i = 0; i < count; i++) {
          h.time += dt;
          const callbacks = [...h.pending.values()]; h.pending.clear();
          callbacks.forEach(cb => cb(h.time));
          await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        }
      };
    }
    if (noWaapi) Element.prototype.animate = undefined;
    for (const name of ['ResizeObserver', 'MutationObserver']) {
      const Observer = window[name];
      window[name] = class extends Observer {
        constructor(cb) { super(cb); this.harnessDisconnected = false; this.harnessObserver = { name, callback: cb.name, stack: new Error().stack, disconnected: false }; this.harnessOwned = !this.harnessObserver.stack.includes('InjectedScript'); if (this.harnessOwned) { h.observerAdds++; h.observers.push(this.harnessObserver); } }
        disconnect() { if (this.harnessOwned && !this.harnessDisconnected) h.observerRemoves++; this.harnessDisconnected = true; this.harnessObserver.disconnected = true; super.disconnect(); }
      };
    }
  }, { virtual, noWaapi, cores });
  for (const file of ['perf-probe.js', 'onset.js', 'stage-resource-budget.js', 'stage-resource-policy.js', 'stage.js', 'stage-particles-gl.js', 'stage-particles.js']) {
    if (file === 'stage-particles.js') await page.evaluate(() => {
      const create = Onset.create;
      Onset.create = (...args) => { const detector = create(...args), onBeat = detector.onBeat; detector.onBeat = callback => { if (!harness.emitParticleBeat) harness.emitParticleBeat = callback; onBeat(callback); }; return detector; };
    });
    await page.addScriptTag({ path: path.join(web, file) });
  }
  await page.evaluate(() => {
    const h = harness, realGate = Stage.gate;
    // Observe the callback boundary without replacing Stage or its scheduler.
    Stage.gate = (name, fps, tick) => realGate(name, fps, (dt, frame) => {
      if (h.lastBorrowed && h.lastBorrowed !== frame) h.borrowedIdentity = false;
      h.lastBorrowed = frame;
      const copy = { name, dt, frameId: frame.frameId, sampledAtMs: frame.sampledAtMs,
        spectrumRevision: frame.spectrumRevision, spectrumReceivedAtMs: frame.spectrumReceivedAtMs,
        spectrumAvailable: frame.spectrumAvailable, reduced: frame.reduced, tier: frame.tier };
      h.gateTicks.push(copy);
      if (name === 'particles') h.particleTick = tick;
      tick(dt, frame);
      if (name === 'particles') h.particleTicks.push(StageParticles.stats());
    });
    Stage.init();
    Stage.onFrameState(s => h.notifications.push({ playing: s.playing, reduced: s.reduced,
      stageVisible: s.stageVisible, documentHidden: s.documentHidden, mediaEpoch: s.mediaEpoch,
      discontinuity: s.positionDiscontinuityRevision, frameId: s.frameId }));
    Stage.setTrack({ id: 'm0-a', duration_ms: 240000 });
    h.snapshot = (playing, position = Stage.position(), seek = false, track = 'm0-a') =>
      Stage.setSnapshot({ playing, position_ms: position, duration_ms: 240000, track_id: track }, { seek });
    h.hiddenTo = value => { h.hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
    h.cloneAudio = () => { const f = StageParticles.audioFeatures(); return { available: f.available,
      beats: f.beats, pulse: f.pulse, energy: f.energy, sampledAt: f.sampledAt,
      instanceId: f.instanceId, spectrumRevision: f.spectrumRevision, bands: [...f.agg], rise: [...f.groupRise] }; };
    h.pixels = () => {
      const canvas = document.querySelector('.stage-particles');
      const gl = StageParticles.renderer() === 'webgl' ? canvas.getContext('webgl2') : null;
      let pixels;
      if (gl) { pixels = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels); }
      else pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let alpha = 0, hash = 2166136261;
      for (let i = 0; i < pixels.length; i++) { if ((i & 3) === 3) alpha += pixels[i]; hash = Math.imul(hash ^ pixels[i], 16777619) >>> 0; }
      return { alpha, hash, width: canvas.width, height: canvas.height };
    };
  });
  // Permit the native observers to deliver their initial geometry notification.
  await page.waitForTimeout(30);
  return page;
}

async function advance(page, count = 10, dt = 1000 / 60) {
  await page.evaluate(async ({ count, dt }) => harness.advance(count, dt), { count, dt });
}
async function stats(page) { return page.evaluate(() => StageParticles.stats()); }
async function mount(page, mode, playing = false) {
  await page.evaluate(({ mode, playing }) => { harness.snapshot(playing, 0); StageParticles.init(); StageParticles.attach(mode); }, { mode, playing });
  await page.waitForTimeout(30); await advance(page, mode === 'enhanced' && playing ? 150 : 12);
}

async function producer(hz) {
  const page = await pageFor();
  try {
    await page.evaluate(() => harness.snapshot(true, 0));
    await advance(page, 60, 1000 / hz);
    await page.evaluate(() => { harness.gateTicks.length = 0; for (const fps of [15, 20, 30]) Stage.gate('m0-' + fps, () => fps, () => {}); Stage.gate('legacy', () => 15, dt => { harness.legacyDt = dt; }); });
    await advance(page, hz, 1000 / hz);
    const data = await page.evaluate(() => ({ hz: Stage.displayHz(), rates: Stage.gateRates(), ticks: harness.gateTicks, identity: harness.borrowedIdentity, legacy: harness.legacyDt }));
    assert.equal(data.hz, hz);
    for (const fps of [15, 20, 30]) {
      const ticks = data.ticks.filter(t => t.name === 'm0-' + fps);
      assert.equal(ticks.length, fps, hz + 'Hz exact ' + fps + ' gate count');
      for (let i = 0; i < ticks.length; i++) {
        assert.ok(Math.abs(ticks[i].dt - 1000 / fps) < 1e-7, 'gate receives accumulated dt');
        if (i) assert.equal(ticks[i].frameId - ticks[i - 1].frameId, hz / fps, 'integer main-frame separation');
      }
    }
    const byFrame = new Map();
    for (const tick of data.ticks) { const old = byFrame.get(tick.frameId); if (old) assert.deepEqual([tick.sampledAtMs, tick.spectrumRevision, tick.tier], [old.sampledAtMs, old.spectrumRevision, old.tier]); else byFrame.set(tick.frameId, tick); }
    assert.ok(data.identity && data.legacy > 0, 'shared preallocated frame and legacy callback');
    const longFrameDt = await page.evaluate(async () => { Stage.gate('long-frame', () => 120, dt => { harness.longDt = dt; }); await harness.advance(1, 1000); return harness.longDt; });
    assert.equal(longFrameDt, 200, 'producer clamps a long main-frame interval to 200ms');
    return { hz: data.hz, rates: data.rates, counts: [15, 20, 30].map(fps => data.ticks.filter(t => t.name === 'm0-' + fps).length), legacyDt: data.legacy, longFrameDt };
  } finally { await page.evaluate(() => Stage.destroy()); await page.close(); }
}

async function frameInputs() {
  const page = await pageFor();
  try {
    const result = await page.evaluate(async () => {
      const h = harness; h.time = 0; h.snapshot(false, 1000); const base = Stage.frameState();
      const same = new Float64Array(64).fill(0.2); Stage.setSpectrum(same); const atZero = Stage.frameState();
      h.time = 599.999; const before600 = Stage.frameState(); h.time = 600; const at600 = Stage.frameState();
      Stage.setSpectrum(same); const reused = Stage.frameState(); Stage.setSpectrum([]); const empty = Stage.frameState();
      const a = Stage.frameState(); h.snapshot(false, 1000); const repeated = Stage.frameState();
      h.snapshot(true, 1000); const play = Stage.frameState(); h.snapshot(false, 1000); const pause = Stage.frameState();
      h.snapshot(false, 1100); const pausedMove = Stage.frameState(); h.snapshot(false, 1100, true); const explicitSame = Stage.frameState();
      h.snapshot(true, 1100); h.snapshot(true, 1901); const correction = Stage.frameState();
      Stage.setSpectrum(same); h.snapshot(true, 1901, false, 'm0-b'); const track = Stage.frameState();
      h.time = 1000; h.snapshot(true, 0, false, 'm0-b'); Stage.setSpectrum(same);
      const old = Stage.frameState(); let mutated = false; h.gateTicks.length = 0;
      Stage.gate('first', () => 60, () => { if (!mutated) { mutated = true; Stage.setSpectrum(same); Stage.setReducedMotion(true); } });
      Stage.gate('second', () => 60, () => {});
      await h.advance(2);
      return { base, atZero, before600, at600, reused, empty, a, repeated, play, pause, pausedMove, explicitSame, correction, track, old, ticks: h.gateTicks, notifications: h.notifications };
    });
    assert.equal(result.atZero.spectrumReceivedAtMs, 0, 'time zero is a valid input timestamp');
    assert.ok(result.atZero.spectrumAvailable && result.before600.spectrumAvailable);
    assert.ok(!result.at600.spectrumAvailable && result.at600.spectrum === null && result.at600.spectrumReceivedAtMs === null);
    assert.equal(result.reused.spectrumRevision, result.atZero.spectrumRevision + 1, 'reused array is a new receive');
    assert.ok(!result.empty.spectrumAvailable && result.empty.spectrum === null);
    assert.equal(result.repeated.positionAnchorRevision, result.a.positionAnchorRevision + 1);
    for (const state of [result.repeated, result.play, result.pause]) assert.equal(state.positionDiscontinuityRevision, result.a.positionDiscontinuityRevision, 'repeat pause/play transitions are ordinary anchors');
    assert.equal(result.pausedMove.positionDiscontinuityRevision, result.a.positionDiscontinuityRevision + 1);
    assert.equal(result.explicitSame.positionDiscontinuityRevision, result.pausedMove.positionDiscontinuityRevision + 1);
    assert.equal(result.correction.positionDiscontinuityRevision, result.explicitSame.positionDiscontinuityRevision + 1);
    assert.ok(result.track.mediaEpoch > result.correction.mediaEpoch && !result.track.spectrumAvailable);
    const first = result.ticks.filter(t => t.name === 'first'), second = result.ticks.filter(t => t.name === 'second');
    assert.equal(first[0].spectrumRevision, second[0].spectrumRevision, 'mid-batch controls cannot rewrite borrowed input');
    assert.equal(second[0].reduced, false); assert.equal(second[1].reduced, true);
    assert.equal(second[1].spectrumRevision, second[0].spectrumRevision + 1);
    return result;
  } finally { await page.evaluate(() => Stage.destroy()); await page.close(); }
}

async function backendContract(mode) {
  const page = await pageFor();
  try {
    await mount(page, mode, true);
    assert.equal((await stats(page)).renderer, mode === 'enhanced' ? 'webgl' : 'canvas2d');
    const initial = await stats(page);
    // Reading pixels happens in the same synchronous gate submit (GL may discard
    // its default drawing buffer between tasks).
    await page.evaluate(() => { Stage.gate('pixel-probe', () => 12, () => { harness.lastPixels = harness.pixels(); }); });
    await advance(page, 15);
    const pixelsBefore = await page.evaluate(() => harness.lastPixels);
    await advance(page, 30);
    const pixelsAfter = await page.evaluate(() => harness.lastPixels);
    assert.ok(pixelsBefore.alpha > 0 && pixelsAfter.alpha > 0, 'production backend draws real pixels');
    assert.notEqual(pixelsBefore.hash, pixelsAfter.hash, 'activity changes actual pixels');
    await page.screenshot({ path: path.join(out, mode + '-active.png') });
    await page.evaluate(() => { Stage.removeGate('pixel-probe'); harness.snapshot(false); });
    await advance(page, 15); const paused = await stats(page);
    assert.equal(paused.fps, 0, 'pause settles to gate zero');
    await page.evaluate(async () => { const before = StageParticles.stats(); for (let i = 0; i < 100; i++) StageParticles.stats(); harness.querySame = JSON.stringify(before) === JSON.stringify(StageParticles.stats()); await harness.advance(60, 1000); });
    let frozen = await stats(page);
    assert.equal(frozen.frame.sceneTimeMs, paused.frame.sceneTimeMs, '60 second pause freezes phase');
    assert.ok(await page.evaluate(() => harness.querySame), 'stats are read only');
    // Static changes coalesce while the main loop is stopped.
    await page.evaluate(() => { harness.staticStart = harness.particleTicks.length; StageParticles.set({ strength: 140, dustDrift: 170 }); document.dispatchEvent(new Event('stage:retint')); harness.snapshot(false, 9000, true); });
    await advance(page, 15); const staticFrame = await stats(page);
    assert.equal(staticFrame.frame.sceneTimeMs, paused.frame.sceneTimeMs); assert.equal(staticFrame.frame.geometryDeltaMs, 0);
    assert.equal(staticFrame.frame.strength, 1.4); assert.equal(staticFrame.frame.drift, 1.7); assert.equal(staticFrame.frame.mediaPositionMs, 9000);
    assert.equal(staticFrame.fps, 0);
    assert.equal(await page.evaluate(() => harness.particleTicks.length - harness.staticStart), 1, 'coalesced controls submit once');
    await page.evaluate(() => harness.snapshot(false, 2000, true)); await advance(page, 15); const backwardSeek = await stats(page);
    assert.equal(backwardSeek.frame.sceneTimeMs, staticFrame.frame.sceneTimeMs); assert.equal(backwardSeek.frame.mediaPositionMs, 2000);
    assert.equal(backwardSeek.frame.positionDiscontinuityRevision, staticFrame.frame.positionDiscontinuityRevision + 1);
    await page.evaluate(() => { harness.particleTicks.length = 0; harness.snapshot(true, 9000); }); await advance(page, 12);
    const resumeTicks = await page.evaluate(() => harness.particleTicks);
    assert.equal(resumeTicks[0].frame.geometryDeltaMs, 0, 'resume first delta is zero');
    assert.ok(resumeTicks.some(t => t.frame.geometryDeltaMs > 0));
    // Duplicate frame ids and invalid/oversized dt travel through the production
    // particle callback captured at Stage.gate; the main scheduler remains real.
    const dt = await page.evaluate(() => {
      const h = harness, frame = { ...Stage.frameState(), frameId: Stage.frameState().frameId + 10000 };
      h.particleTick(16, frame); const once = StageParticles.stats(); h.particleTick(90, frame); const twice = StageParticles.stats();
      h.particleTick(Infinity, { ...frame, frameId: frame.frameId + 1 }); const infinity = StageParticles.stats();
      h.particleTick(1000, { ...frame, frameId: frame.frameId + 2 }); const capped = StageParticles.stats();
      return { once: once.frame.sceneTimeMs, twice: twice.frame.sceneTimeMs, infinity: infinity.frame.geometryDeltaMs, capped: capped.frame.geometryDeltaMs };
    });
    assert.equal(dt.once, dt.twice); assert.equal(dt.infinity, 0); assert.equal(dt.capped, 100);
    // Overlapping freeze reasons remain effective as each reason is removed.
    await page.evaluate(() => { harness.snapshot(false); Stage.setReducedMotion(true); harness.hiddenTo(true); document.body.classList.add('space3d-open', 'creative-on'); });
    const overlap = await stats(page);
    await page.evaluate(() => harness.hiddenTo(false)); await advance(page, 10);
    assert.equal((await stats(page)).frame.sceneTimeMs, overlap.frame.sceneTimeMs);
    await page.evaluate(() => { document.body.classList.remove('space3d-open', 'creative-on'); }); await advance(page, 12);
    assert.equal((await stats(page)).frame.sceneTimeMs, overlap.frame.sceneTimeMs);
    await page.evaluate(() => Stage.setReducedMotion(false)); await advance(page, 12);
    assert.equal((await stats(page)).fps, 0, 'still paused after removing other reasons');
    await page.evaluate(() => { harness.particleTicks.length = 0; harness.snapshot(true); }); await advance(page, 15);
    assert.equal(await page.evaluate(() => harness.particleTicks[0].frame.geometryDeltaMs), 0);
    // Each CSS overlay separately withdraws drawing eligibility.
    const overlays = [];
    for (const cls of ['s3d-open', 'space3d-open', 'creative-3d', 'creative-on']) {
      await page.evaluate(cls => document.body.classList.add(cls), cls); await advance(page, 10); const hidden = await stats(page);
      assert.equal(hidden.fps, 0, cls + ' freezes');
      await page.evaluate(cls => { harness.particleTicks.length = 0; document.body.classList.remove(cls); }, cls); await advance(page, 15);
      assert.equal(await page.evaluate(() => harness.particleTicks[0].frame.geometryDeltaMs), 0, cls + ' restores from delta zero');
      overlays.push(cls);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForFunction(() => Stage.frameState().reduced && harness.notifications.at(-1).reduced, null, { polling: 10 }); await advance(page, 15); const systemReduced = await stats(page);
    assert.equal(systemReduced.fps, 0); assert.equal(systemReduced.frame.geometryDeltaMs, 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.waitForFunction(() => !Stage.frameState().reduced && !harness.notifications.at(-1).reduced, null, { polling: 10 }); await advance(page, 15);
    await page.setViewportSize({ width: 900, height: 820 }); await page.waitForTimeout(120); await advance(page, 15);
    assert.equal((await stats(page)).fps, 0, 'closed narrow drawer freezes');
    await page.evaluate(() => document.body.classList.add('stage-open')); await advance(page, 15);
    assert.ok((await stats(page)).fps > 0, 'class observer wakes the closed drawer');
    await page.evaluate(() => { harness.snapshot(false); document.body.classList.add('space3d-open'); StageParticles.set({ strength: 160 }); }); await advance(page, 12);
    assert.ok((await stats(page)).dirty); assert.equal((await stats(page)).fps, 0);
    await page.evaluate(() => document.body.classList.remove('space3d-open')); await advance(page, 12);
    assert.equal((await stats(page)).frame.strength, 1.6); assert.equal((await stats(page)).fps, 0);
    // Zero-size resource boundary, then a real ResizeObserver restore.
    await page.evaluate(() => { document.querySelector('#stage').style.width = '0px'; }); await page.waitForTimeout(50); await advance(page, 12);
    assert.equal((await stats(page)).fps, 0); assert.ok((await stats(page)).dirty);
    await page.evaluate(() => { document.querySelector('#stage').style.width = '640px'; }); await page.waitForTimeout(50); await advance(page, 12);
    assert.equal((await stats(page)).dirty, false); assert.equal((await stats(page)).fps, 0);
    const activeResources = (await stats(page)).resources;
    await page.evaluate(() => { StageParticles.destroy(); Stage.destroy(); }); const destroyed = await stats(page);
    assert.equal(destroyed.count, 0); assert.equal(destroyed.dpr, 0);
    for (const key of ['canvases', 'rippleNodes', 'gate', 'resizeObservers', 'classObservers', 'stateSubscriptions', 'rippleAnimations']) assert.equal(destroyed.resources[key], 0, key + ' released');
    for (const key of ['contexts', 'shaders', 'programs', 'buffers', 'vaos', 'listeners', 'typedArrayBytes', 'bufferBytes', 'surfacePixels']) assert.equal(destroyed.resources.renderer[key], 0, key + ' renderer released');
    const observation = await page.evaluate(() => ({ pending: harness.pending.size, adds: harness.observerAdds, removes: harness.observerRemoves, observers: harness.observers }));
    assert.equal(observation.pending, 0); assert.equal(observation.adds, observation.removes, JSON.stringify(observation.observers.filter(o => !o.disconnected)));
    return { initial, pixelsBefore, pixelsAfter, paused, staticFrame, backwardSeek, dt, overlays, activeResources, destroyed, observation };
  } finally { await page.evaluate(() => { StageParticles.destroy(); Stage.destroy(); }); await page.close(); }
}

async function audioAndRipples(noWaapi) {
  const page = await pageFor({ noWaapi });
  try {
    await mount(page, 'standard', true);
    const evidence = await page.evaluate(async () => {
      const h = harness; h.signal = new Float64Array(64);
      h.send = async value => { h.signal.fill(value); Stage.setSpectrum(h.signal); await h.advance(6); return h.cloneAudio(); };
      const prime = await h.send(0.1); const low = await h.send(0.05);
      // Enough monotonic separation from the detector's refractory origin.
      const beat = await h.send(1); const ringsAtBeat = StageParticles.stats().ripples;
      const rev = Stage.frameState().spectrumRevision; await h.advance(24); const repeated = h.cloneAudio();
      const animation = document.querySelector('.stage-ripple.is-live')?.getAnimations?.()[0];
      const beforePause = { stats: StageParticles.stats(), currentTime: animation ? animation.currentTime : null, playState: animation ? animation.playState : null };
      h.snapshot(false); await h.advance(15); await h.advance(60, 1000);
      const paused = { stats: StageParticles.stats(), currentTime: animation ? animation.currentTime : null };
      // Hidden/paused ownership must not clear Stage's input for other consumers.
      Stage.setSpectrum(h.signal); const stageBefore = Stage.frameState(); h.hiddenTo(true); const stageHidden = Stage.frameState(); h.hiddenTo(false);
      h.snapshot(true); await h.advance(12); const oldAfterResume = h.cloneAudio();
      const reprime = await h.send(1); const beforeEmpty = h.cloneAudio(); Stage.setSpectrum([]); await h.advance(6); const empty = h.cloneAudio();
      await h.send(0.05); await h.send(1); const beforeSeek = StageParticles.stats(); h.snapshot(true, 5000, true); await h.advance(6); const seek = StageParticles.stats();
      const seekPrime = await h.send(1);
      const received = Stage.frameState().spectrumReceivedAtMs;
      h.time = received + 600; await h.advance(6); const stale = h.cloneAudio();
      return { prime, low, beat, ringsAtBeat, rev, repeated, beforePause, paused, stageBefore, stageHidden, oldAfterResume, reprime, beforeEmpty, empty, beforeSeek, seek, seekPrime, stale };
    });
    assert.ok(evidence.prime.available && evidence.prime.beats === 0 && evidence.prime.pulse === 0, 'first input primes without beat');
    assert.ok(evidence.beat.beats > 0 && evidence.ringsAtBeat > 0, 'new valid revision produces actual Onset/ripple');
    assert.equal(evidence.repeated.beats, evidence.beat.beats, 'reused revision cannot republish a beat');
    assert.equal(evidence.paused.stats.frame.sceneTimeMs, evidence.beforePause.stats.frame.sceneTimeMs);
    assert.equal(evidence.paused.stats.ripples, evidence.beforePause.stats.ripples, 'pause preserves presented rings for 60s');
    if (!noWaapi) { assert.equal(evidence.beforePause.playState, 'paused'); assert.equal(evidence.paused.currentTime, evidence.beforePause.currentTime); }
    assert.equal(evidence.stageHidden.spectrumRevision, evidence.stageBefore.spectrumRevision); assert.ok(evidence.stageHidden.spectrumAvailable);
    assert.ok(!evidence.oldAfterResume.available, 'input received before resume is rejected');
    assert.equal(evidence.reprime.beats, evidence.beat.beats); assert.equal(evidence.reprime.pulse, 0);
    assert.ok(!evidence.empty.available && evidence.empty.energy === 0 && evidence.empty.pulse === 0 && evidence.empty.bands.every(v => v === 0) && evidence.empty.rise.every(v => v === 0), 'empty input immediately exposes neutral output');
    assert.equal(evidence.seek.ripples, 0); assert.equal(evidence.seekPrime.pulse, 0);
    assert.ok(!evidence.stale.available && evidence.stale.pulse === 0 && evidence.stale.energy === 0 && evidence.stale.bands.every(v => v === 0), 'stale input is immediately neutral');
    assert.ok(evidence.seekPrime.beats >= evidence.beforeEmpty.beats, 'published beat counter never goes backward within instance');
    // Ripples alone retain the clock and expire at exactly their scene-time age.
    const expire = await page.evaluate(async () => {
      const h = harness; StageParticles.set({ dust: false, ripples: true }); await h.send(0); await h.advance(18); await h.send(1);
      const el = document.querySelector('.stage-ripple.is-live'); if (!el) throw new Error('ripple-only probe needs a real beat');
      const born = el.__rippleBorn; h.snapshot(false); await h.advance(15); h.time += 60000; const wall = StageParticles.stats();
      h.snapshot(true); await h.advance(12); let iterations = 0;
      while (el.classList.contains('is-live') && ++iterations < 120) await h.advance(1);
      const end = StageParticles.stats(); return { born, wall, end, age: end.frame.sceneTimeMs - born, iterations };
    });
    assert.ok(expire.wall.ripples > 0); assert.ok(expire.age >= 1600 && expire.age < 1701, 'scene time owns expiry without dust or WAAPI');
    assert.equal(expire.end.ripples, 0);
    // A synthetic call to the original subscribed beat callback isolates pool
    // reuse and queued receipt ownership; real Onset behavior is tested above.
    const pool = await page.evaluate(async () => {
      const h = harness; StageParticles.set({ dust: false, ripples: true }); await h.advance(12);
      h.emitParticleBeat(); const node = document.querySelector('.stage-ripple.is-live');
      const oldReceipt = node.__rippleAnimation?.onfinish, token = node.__rippleToken;
      for (let i = 0; i < 12; i++) h.emitParticleBeat();
      const reused = node.__rippleToken > token, before = StageParticles.stats().ripples;
      if (oldReceipt) oldReceipt(); const after = StageParticles.stats().ripples;
      StageParticles.set({ ripples: false }); const disabled = StageParticles.stats().ripples;
      return { reused, before, after, disabled, syntheticSubscribedCallback: true };
    });
    assert.ok(pool.reused); assert.equal(pool.before, 12); assert.equal(pool.after, 12); assert.equal(pool.disabled, 0);
    await page.evaluate(() => { StageParticles.set({ dust: false, ripples: false }); }); await advance(page, 15);
    assert.equal((await stats(page)).fps, 0, 'all effects off settles');
    return { noWaapi, evidence, expire, pool };
  } finally { await page.evaluate(() => { StageParticles.destroy(); Stage.destroy(); }); await page.close(); }
}

async function contextLoss(state) {
  const page = await pageFor();
  try {
    await mount(page, 'enhanced', state === 'playing');
    if (state === 'hidden') { await page.evaluate(() => harness.hiddenTo(true)); }
    const before = await stats(page);
    const result = await page.evaluate(async () => {
      const canvas = document.querySelector('.stage-particles'), gl = canvas.getContext('webgl2');
      const extension = gl.getExtension('WEBGL_lose_context'); if (!extension) throw new Error('actual context-loss extension unavailable');
      await new Promise(resolve => { canvas.addEventListener('webglcontextlost', resolve, { once: true }); extension.loseContext(); });
      await Promise.resolve();
      const immediate = StageParticles.stats();
      canvas.dispatchEvent(new Event('webglcontextrestored')); canvas.dispatchEvent(new Event('webglcontextlost'));
      const oldEvents = StageParticles.stats();
      return { immediate, oldEvents, hasCanvas: !!document.querySelector('.stage-particles').getContext('2d') };
    });
    assert.equal(result.immediate.renderer, state === 'hidden' ? 'none' : 'canvas2d', 'loss clears old resources immediately; hidden replacement waits for an effective display gate');
    assert.equal(result.hasCanvas, state !== 'hidden');
    assert.equal(result.immediate.frame.sceneTimeMs, before.frame.sceneTimeMs);
    assert.equal(result.oldEvents.backendGeneration, result.immediate.backendGeneration, 'old context events cannot replace new backend');
    if (state === 'hidden') assert.equal(result.immediate.fps, 0);
    await page.evaluate(() => { harness.hiddenTo(false); harness.snapshot(true); harness.particleTicks.length = 0; }); await advance(page, 15);
    assert.equal((await stats(page)).renderer, 'canvas2d');
    assert.equal(await page.evaluate(() => harness.particleTicks[0].frame.geometryDeltaMs), 0, 'handoff first delta zero');
    return { state, before, ...result, after: await stats(page) };
  } finally { await page.evaluate(() => { StageParticles.destroy(); Stage.destroy(); }); await page.close(); }
}

async function failureTransactions() {
  const page = await pageFor();
  try {
    const probes = await page.evaluate(() => {
      const proto = WebGL2RenderingContext.prototype;
      const results = [];
      for (const phase of ['context', 'shader', 'link', 'buffer', 'vao', 'upload', 'warmup']) {
        const canvas = document.createElement('canvas'), view = { canvas, w: 100, h: 100, cx: 50, cy: 50, fade0: -1, fade1: -1 };
        const changes = [], patch = (obj, key, fn) => { const old = obj[key]; changes.push(() => { obj[key] = old; }); obj[key] = fn(old); };
        let calls = 0;
        if (phase === 'context') patch(canvas, 'getContext', () => () => null);
        if (phase === 'shader') patch(proto, 'getShaderParameter', old => function (...args) { return ++calls === 2 ? false : old.apply(this, args); });
        if (phase === 'link') patch(proto, 'getProgramParameter', old => function (...args) { return args[1] === this.LINK_STATUS ? false : old.apply(this, args); });
        if (phase === 'buffer') patch(proto, 'createBuffer', () => () => null);
        if (phase === 'vao') patch(proto, 'createVertexArray', () => () => null);
        if (phase === 'upload') patch(proto, 'bufferData', () => () => { throw new Error('injected upload failure'); });
        if (phase === 'warmup') patch(proto, 'drawArrays', () => () => { throw new Error('injected warmup failure'); });
        const renderer = ParticleGL.create({ resources: Stage.resources().port('particle-fault-fixture') }); let mounted, warm;
        try { mounted = renderer.mount(view); if (mounted) { renderer.resize(view, { tier: 0, dpr: 1 }); renderer.setCount(4); warm = renderer.warmUp(view, { strength: 1 }); } }
        finally { changes.reverse().forEach(restore => restore()); }
        const failed = renderer.resources(); renderer.dispose(); renderer.dispose(); const disposed = renderer.resources();
        results.push({ phase, mounted, warm, failed, disposed });
      }
      // Production owner must also expose both backend failures as unavailable.
      const getContext = HTMLCanvasElement.prototype.getContext;
      StageParticles.init();
      HTMLCanvasElement.prototype.getContext = () => null;
      try { StageParticles.attach('enhanced'); results.push({ phase: 'both-unavailable', stats: StageParticles.stats() }); }
      finally { HTMLCanvasElement.prototype.getContext = getContext; StageParticles.destroy(); }
      // Canvas sprite partial creation, separate from surface context failure.
      StageParticles.init(); let spriteCalls = 0;
      HTMLCanvasElement.prototype.getContext = function (...args) { if (this.width === 32 && this.height === 32 && ++spriteCalls === 2) return null; return getContext.apply(this, args); };
      try { StageParticles.attach('standard'); results.push({ phase: 'sprite', stats: StageParticles.stats() }); }
      finally { HTMLCanvasElement.prototype.getContext = getContext; StageParticles.destroy(); }
      return results;
    });
    for (const probe of probes) {
      if (probe.disposed) {
        assert.ok(probe.failed.failures > 0, probe.phase + ' injected path must fail');
        for (const key of ['contexts', 'shaders', 'programs', 'buffers', 'vaos', 'listeners', 'typedArrayBytes', 'bufferBytes', 'surfacePixels']) assert.equal(probe.disposed[key], 0, probe.phase + ' releases ' + key);
      } else { assert.equal(probe.stats.actualBackend, 'none'); assert.equal(probe.stats.effectiveMode, 'unavailable'); assert.equal(probe.stats.fps, 0); assert.ok(probe.stats.reason); }
    }
    return probes;
  } finally { await page.evaluate(() => { StageParticles.destroy(); Stage.destroy(); }); await page.close(); }
}

async function qualityMatrix(mode) {
  const result = [];
  for (const tier of [0, 1, 2]) {
    const page = await pageFor({ cores: tier === 0 ? 2 : 8,
      viewport: tier === 2 ? { width: 1280, height: 720 } : { width: 1360, height: 820 } });
    try {
      await mount(page, mode, false);
      const s = await stats(page), caps = mode === 'standard' ? [36, 72, 120] : [120, 220, 360], dprs = mode === 'standard' ? [1, 1.3, 1.6] : [1, 1.15, 1.35];
      assert.equal(s.tier, tier, 'real Stage environment selects tier');
      const area = Math.round((640 * 480) / (460 * 780) * 8) / 8;
      assert.equal(s.count, Math.round(caps[tier] * area)); assert.equal(s.dpr, dprs[tier]);
      assert.equal(s.frame.tier, tier); assert.equal(s.frame.count, s.count); assert.equal(s.frame.dpr, s.dpr);
      await page.evaluate(() => { harness.snapshot(true); StageParticles.set({ dust: false, ripples: true }); }); await advance(page, 12);
      await page.evaluate(() => harness.emitParticleBeat());
      const rate = await page.evaluate(() => Stage.gateRates().find(g => g.name === 'particles'));
      assert.equal(rate.target, [15, 20, 30][tier]); assert.equal(rate.divisor, 60 / rate.target);
      result.push({ tier, count: s.count, dpr: s.dpr, rate, peak: s.resources.peak });
    } finally { await page.evaluate(() => { StageParticles.destroy(); Stage.destroy(); }); await page.close(); }
  }
  return { mode, result };
}

async function runtimeFailure() {
  const page = await pageFor();
  try {
    await mount(page, 'enhanced', true);
    const evidence = await page.evaluate(async () => {
      const h = harness, oldDraw = WebGL2RenderingContext.prototype.drawArrays;
      const unavailableEvents = [];
      document.addEventListener('stage:degrade', event => { if (event.detail.to === 'unavailable') unavailableEvents.push({ ...event.detail }); });
      const before = StageParticles.stats(); h.particleTicks.length = 0;
      WebGL2RenderingContext.prototype.drawArrays = () => { throw new Error('injected production draw failure'); };
      try { await h.advance(12); } finally { WebGL2RenderingContext.prototype.drawArrays = oldDraw; }
      const after = StageParticles.stats(), ticks = h.particleTicks;
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (...args) { return getContext.apply(this, args); };
      // The fallback Canvas is real. Its runtime failure must stop its gate.
      const oldCanvasDraw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = () => { throw new Error('injected Canvas production failure'); };
      try { await h.advance(12); } finally { CanvasRenderingContext2D.prototype.drawImage = oldCanvasDraw; HTMLCanvasElement.prototype.getContext = getContext; }
      const unavailable = StageParticles.stats(); const requested = h.requested;
      await h.advance(30); const stable = { stats: StageParticles.stats(), requestedDelta: h.requested - requested };
      return { before, after, ticks, unavailable, stable, unavailableEvents };
    });
    assert.equal(evidence.after.renderer, 'canvas2d');
    const generations = evidence.ticks.filter(t => t.frame.actualBackend === 'canvas2d');
    assert.ok(generations.length > 0); assert.equal(generations[0].frame.geometryDeltaMs, 0, 'runtime fallback resumes at next frame delta0');
    assert.equal(evidence.unavailable.actualBackend, 'none'); assert.equal(evidence.unavailable.effectiveMode, 'unavailable'); assert.equal(evidence.unavailable.fps, 0);
    assert.equal(evidence.unavailableEvents.length, 1, 'Canvas runtime failure publishes one unavailable event');
    assert.deepEqual(evidence.unavailableEvents[0], { reason: evidence.unavailable.reason, from: 'standard', to: 'unavailable', ok: false });
    assert.equal(evidence.stable.stats.backendGeneration, evidence.unavailable.backendGeneration, 'dirty does not retry unavailable backend');
    return evidence;
  } finally { await page.evaluate(() => { StageParticles.destroy(); Stage.destroy(); }); await page.close(); }
}

async function interruptedPreparation(mode) {
  const results = [];
  for (const reason of ['density', 'size']) {
    const page = await pageFor();
    try {
      const evidence = await page.evaluate(async ({ mode, reason }) => {
        const h = harness; h.snapshot(false, 0); StageParticles.init(); StageParticles.attach(mode);
        const before = StageParticles.stats();
        if (reason === 'density') StageParticles.set({ density: 200 });
        else {
          document.querySelector('#stage').style.width = '480px'; document.querySelector('#stage').style.height = '360px';
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        const interrupted = StageParticles.stats(); await h.advance(15);
        return { mode, reason, before, interrupted, submitted: StageParticles.stats(), controlledInterruptedCase: true };
      }, { mode, reason });
      assert.equal(evidence.before.metrics.firstFrameStatus, 'pending'); assert.equal(evidence.before.metrics.warmUpStatus, 'submitted');
      assert.equal(evidence.before.metrics.warmUpCount, mode === 'standard' ? 63 : 193);
      assert.equal(evidence.before.metrics.warmUpWidth, 640); assert.equal(evidence.before.metrics.warmUpHeight, 480);
      assert.ok(evidence.interrupted.metrics.firstFrameInterruptions > 0, 'pending preparation is recorded as interrupted');
      assert.equal(evidence.interrupted.metrics.warmUpStatus, 'deferred');
      const current = evidence.submitted;
      assert.equal(current.metrics.firstFrameStatus, 'submitted'); assert.equal(current.metrics.warmUpStatus, 'submitted');
      assert.ok(current.metrics.firstFrameInterruptions > 0);
      assert.equal(current.metrics.warmUpCount, current.count, 'rewarm uses the production count');
      assert.equal(current.metrics.warmUpDpr, current.dpr, 'rewarm uses the production DPR');
      if (reason === 'density') {
        assert.equal(current.count, mode === 'standard' ? 126 : 385);
        assert.equal(current.metrics.warmUpWidth, 640); assert.equal(current.metrics.warmUpHeight, 480);
      } else {
        assert.equal(current.count, mode === 'standard' ? 36 : 110);
        assert.equal(current.metrics.warmUpWidth, 480); assert.equal(current.metrics.warmUpHeight, 360);
      }
      if (mode === 'enhanced') assert.equal(current.resources.renderer.warmUp.count, current.count);
      results.push(evidence);
    } finally { await page.evaluate(() => { StageParticles.destroy(); Stage.destroy(); }); await page.close(); }
  }
  return { mode, validNativeSamplesExcluded: true, results };
}

async function partialPoolFailure() {
  const page = await pageFor();
  try {
    const results = await page.evaluate(() => {
      const host = document.querySelector('#stage'), append = host.appendChild;
      const results = [];
      for (const failAt of [1, 4, 12]) {
        let appends = 0;
        host.appendChild = function (node) {
          const result = append.call(this, node);
          if (node.classList?.contains('stage-ripple') && ++appends === failAt) throw new Error('injected partial ripple append failure');
          return result;
        };
        let initialized;
        try { initialized = StageParticles.init(); } finally { host.appendChild = append; }
        results.push({ failAt, returnedNull: initialized === null,
          canvas: host.querySelectorAll('.stage-particles').length, ripples: host.querySelectorAll('.stage-ripple').length,
          particleGates: Stage.gateRates().filter(g => g.name === 'particles').length, stats: StageParticles.stats() });
      }
      const recovered = !!StageParticles.init(); StageParticles.attach('standard');
      results.push({ recovered, canvas: host.querySelectorAll('.stage-particles').length, ripples: host.querySelectorAll('.stage-ripple').length });
      return results;
    });
    for (const result of results.filter(r => r.failAt)) {
      assert.ok(result.returnedNull); assert.equal(result.canvas, 0); assert.equal(result.ripples, 0); assert.equal(result.particleGates, 0);
      for (const key of ['canvases', 'rippleNodes', 'gate', 'resizeObservers', 'classObservers', 'stateSubscriptions']) assert.equal(result.stats.resources[key], 0);
    }
    assert.ok(results.at(-1).recovered); assert.equal(results.at(-1).canvas, 1); assert.equal(results.at(-1).ripples, 12);
    return { injectionOccursAfterRealAppend: true, results };
  } finally { await page.evaluate(() => { StageParticles.destroy(); Stage.destroy(); }); await page.close(); }
}

async function probeContracts() {
  const results = [];
  for (const phase of ['baseline', 'webgl']) for (const reason of ['pause', 'hidden', 'seek', 'density', 'size']) {
    const page = await pageFor();
    try {
      await mount(page, 'enhanced', false);
      const evidence = await page.evaluate(async ({ phase, reason }) => {
        const h = harness; h.snapshot(true); let iterations = 0;
        while (StageParticles.stats().probe.status !== phase && ++iterations < 150) await h.advance(1);
        const before = StageParticles.stats();
        if (before.probe.status !== phase) throw new Error('did not reach requested A/B window: ' + phase);
        if (phase === 'baseline') { await h.advance(10); h.baselineFrozen = StageParticles.stats().frame.sceneTimeMs === before.frame.sceneTimeMs; }
        if (reason === 'pause') h.snapshot(false);
        if (reason === 'hidden') h.hiddenTo(true);
        if (reason === 'seek') h.snapshot(true, 9000, true);
        if (reason === 'density') StageParticles.set({ density: 50 });
        if (reason === 'size') {
          document.querySelector('#stage').style.width = '480px';
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        const interrupted = StageParticles.stats();
        // Keep the cancelled round unable to begin a fresh active measurement.
        h.snapshot(false); await h.advance(70);
        return { phase, reason, before, interrupted, settled: StageParticles.stats(), baselineFrozen: h.baselineFrozen };
      }, { phase, reason });
      assert.equal(evidence.interrupted.probe.status, 'interrupted');
      assert.equal(evidence.settled.probe.status, 'interrupted', 'old probe receipt cannot validate cancelled window');
      if (phase === 'baseline') assert.ok(evidence.baselineFrozen, 'baseline freezes scene time');
      assert.equal(evidence.settled.countScale, 1, 'invalid sample cannot reduce budget');
      results.push(evidence);
    } finally { await page.evaluate(() => { StageParticles.destroy(); Stage.destroy(); }); await page.close(); }
  }
  // Turn diagnostics off: cost protection still measures the actual draw window.
  const page = await pageFor();
  try {
    await page.evaluate(() => { HertzPerf.state.enabled = false; }); await mount(page, 'enhanced', true);
    const disabled = await stats(page); assert.equal(disabled.probe.status, 'valid'); assert.ok(disabled.probe.draws > 0);
    assert.equal(disabled.metrics.attachCpuMs, null); results.push({ diagnosticsDisabled: true, stats: disabled });
  } finally { await page.evaluate(() => { StageParticles.destroy(); Stage.destroy(); }); await page.close(); }
  return results;
}

async function probeProtectionThresholds() {
  const results = [];
  for (const measuredHz of [60, 48, 36]) {
    const page = await pageFor();
    try {
      await mount(page, 'enhanced', false);
      const result = await page.evaluate(async measuredHz => {
        const h = harness; h.snapshot(true); let steps = 0;
        while (StageParticles.stats().probe.status !== 'baseline' && ++steps < 100) await h.advance(1);
        while (StageParticles.stats().probe.status === 'baseline' && ++steps < 200) await h.advance(1);
        const startGl = StageParticles.stats();
        while (StageParticles.stats().probe.status === 'webgl' && ++steps < 300) await h.advance(1, 1000 / measuredHz);
        const result = StageParticles.stats(); await h.advance(10, 1000 / measuredHz);
        return { measuredHz, startGl, result, submitted: StageParticles.stats() };
      }, measuredHz);
      assert.equal(result.startGl.probe.status, 'webgl');
      if (measuredHz === 60) { assert.equal(result.result.probe.status, 'valid'); assert.ok(result.result.probe.loss <= 0.12); assert.equal(result.result.countScale, 1); assert.equal(result.result.renderer, 'webgl'); }
      if (measuredHz === 48) { assert.equal(result.result.probe.status, 'valid'); assert.ok(result.result.probe.loss > 0.12 && result.result.probe.loss <= 0.30); assert.equal(result.result.countScale, 0.5); assert.equal(result.result.renderer, 'webgl'); assert.ok(result.submitted.count < result.startGl.count); }
      if (measuredHz === 36) { assert.equal(result.result.renderer, 'canvas2d'); assert.ok(result.result.reason.includes('帧率下降')); }
      results.push(result);
    } finally { await page.evaluate(() => { StageParticles.destroy(); Stage.destroy(); }); await page.close(); }
  }
  return { controlledRefreshDuringGLWindow: true, results };
}

function distribution(values) { const sorted = values.slice().sort((a, b) => a - b); return { samples: sorted.length, median: (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2, maximum: sorted.at(-1), minimum: sorted[0] }; }
async function nativeSamples(mode) {
  const page = await pageFor({ virtual: false });
  try {
    const samples = [];
    for (const kind of ['cold', 'warm']) for (let round = 0; round < 10; round++) {
      const sample = await page.evaluate(async ({ kind, round, mode }) => {
        const h = harness;
        const wait = condition => new Promise((resolve, reject) => {
          const started = performance.now();
          const poll = () => { if (condition()) resolve(); else if (performance.now() - started > 3000) reject(new Error('native first-frame wait timed out')); else requestAnimationFrame(poll); }; poll();
        });
        h.snapshot(false, 0); StageParticles.set({ dust: true, ripples: true, density: 100, strength: 100, dustDrift: 100 });
        let initCpuMs = null;
        const initialize = () => { const started = performance.now(); StageParticles.init(); initCpuMs = performance.now() - started; };
        if (kind === 'warm') {
          // Prime browser shader/canvas caches with a completed visible lifecycle.
          // M1 forbids new allocation/submit behind an occluding space host.
          initialize();
          StageParticles.attach(mode); Stage.kick();
          await wait(() => StageParticles.stats().metrics.firstFrameStatus === 'submitted');
          StageParticles.destroy();
        }
        const requestAt = performance.now();
        initialize(); StageParticles.attach(mode);
        Stage.kick();
        await wait(() => StageParticles.stats().metrics.firstFrameStatus === 'submitted');
        const submittedAt = performance.now(), active = StageParticles.stats();
        h.hiddenTo(true); const hidden = StageParticles.stats(); await new Promise(resolve => setTimeout(resolve, 30)); const retained = StageParticles.stats(); h.hiddenTo(false);
        await new Promise(resolve => setTimeout(resolve, 30));
        StageParticles.destroy(); const destroyed = StageParticles.stats();
        return { kind, round, requestAt, initCpuMs, observedFirstFrameWaitMs: submittedAt - requestAt,
          nativeClock: true, warmBasis: kind === 'warm' ? 'completed visible prior lifecycle; browser caches' : 'unprimed lifecycle',
          actualBackend: active.actualBackend, count: active.count, tier: active.tier, dpr: active.dpr,
          cssSize: [640, 480], metrics: active.metrics, active: active.resources, hidden: hidden.resources, retained: retained.resources, destroyed: destroyed.resources };
      }, { kind, round, mode });
      samples.push(sample);
      sample.measurementStartDifferenceMs = sample.observedFirstFrameWaitMs - sample.metrics.firstFrameLatencyMs;
      assert.equal(sample.actualBackend, mode === 'enhanced' ? 'webgl' : 'canvas2d', 'natural measurement must keep requested backend');
      assert.equal(sample.metrics.warmUpStatus, 'submitted'); assert.ok(sample.metrics.warmUpDrawCalls > 0);
      assert.equal(sample.metrics.firstFrameInterruptions, 0, 'valid native samples exclude interrupted preparations');
      assert.equal(sample.metrics.warmUpCount, sample.count); assert.equal(sample.metrics.warmUpDpr, sample.dpr);
      assert.deepEqual([sample.metrics.warmUpWidth, sample.metrics.warmUpHeight], sample.cssSize);
      for (const key of ['attachCpuMs', 'warmUpSubmitCpuMs', 'firstFrameSubmitCpuMs', 'firstFrameLatencyMs']) assert.ok(Number.isFinite(sample.metrics[key]) && sample.metrics[key] >= 0, 'native sample ' + key);
      assert.deepEqual(sample.hidden.renderer, sample.retained.renderer, 'hidden resources remain stable');
      for (const key of ['contexts', 'buffers', 'shaders', 'programs', 'vaos', 'listeners', 'typedArrayBytes', 'bufferBytes', 'surfacePixels']) assert.equal(sample.destroyed.renderer[key], 0, 'sample destroy baseline ' + key);
      for (const key of ['canvases', 'rippleNodes', 'gate', 'resizeObservers', 'classObservers', 'stateSubscriptions', 'rippleAnimations']) assert.equal(sample.destroyed[key], 0);
    }
    const distributions = {};
    for (const kind of ['cold', 'warm']) {
      const selected = samples.filter(s => s.kind === kind); distributions[kind] = {};
      for (const key of ['attachCpuMs', 'warmUpSubmitCpuMs', 'firstFrameSubmitCpuMs', 'firstFrameLatencyMs']) distributions[kind][key] = distribution(selected.map(s => s.metrics[key]));
      distributions[kind].observedFirstFrameWaitMs = distribution(selected.map(s => s.observedFirstFrameWaitMs));
      distributions[kind].initCpuMs = distribution(selected.map(s => s.initCpuMs));
      const peaks = {}; for (const sample of selected) for (const [key, value] of Object.entries(sample.active.peak)) if (typeof value === 'number') peaks[key] = Math.max(peaks[key] || 0, value);
      distributions[kind].localApiResourcePeak = peaks;
      assert.ok(selected.every(s => s.count === selected[0].count && s.dpr === selected[0].dpr && s.tier === selected[0].tier), 'samples retain same target budget');
      for (const key of ['contexts', 'buffers', 'shaders', 'programs', 'vaos', 'listeners', 'typedArrayBytes', 'bufferBytes', 'surfacePixels']) assert.ok(selected.every(s => s.active.renderer[key] === selected[0].active.renderer[key]), 'live resource footprint remains constant across ' + kind + ' lifecycles: ' + key);
    }
    fs.writeFileSync(path.join(out, mode + '-native-samples.json'), JSON.stringify({ mode, samples, distributions,
      note: 'CPU submission and observed scheduler wait; no GPU completion or driver-cache purge claim. API resource counts/bytes and RGBA surface estimates are not physical VRAM.' }, null, 2));
    return { mode, distributions, samplesFile: mode + '-native-samples.json', completeLifecycles: samples.length };
  } finally { await page.evaluate(() => { StageParticles.destroy(); Stage.destroy(); }); await page.close(); }
}

async function main() {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await pageFor();
    report.environment = await page.evaluate(() => {
      const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl2'), debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const result = { userAgent: navigator.userAgent, platform: navigator.platform, devicePixelRatio,
        browserViewport: [innerWidth, innerHeight], coresControlledForContract: navigator.hardwareConcurrency,
        glVersion: gl && gl.getParameter(gl.VERSION), glRenderer: gl && gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
        glVendor: gl && gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR), waapi: typeof Element.prototype.animate === 'function' };
      if (gl) gl.getExtension('WEBGL_lose_context')?.loseContext(); return result;
    });
    await page.evaluate(() => Stage.destroy()); await page.close(); report.environment.browserVersion = browser.version(); report.environment.node = process.version;
    await check('real Stage gates at 60Hz', () => producer(60));
    await check('real Stage gates at 120Hz', () => producer(120));
    await check('receive times, revisions, same-batch input', frameInputs);
    for (const mode of ['standard', 'enhanced']) await check(mode + ' real frames, freeze, dirty, pixels, destroy', () => backendContract(mode));
    for (const mode of ['standard', 'enhanced']) await check(mode + ' real Stage tier/count/DPR budgets', () => qualityMatrix(mode));
    for (const noWaapi of [false, true]) await check('audio ownership and ' + (noWaapi ? 'no WAAPI' : 'WAAPI') + ' scene-time ripples', () => audioAndRipples(noWaapi));
    for (const state of ['playing', 'paused', 'hidden']) await check('actual WebGL loss while ' + state, () => contextLoss(state));
    await check('real API failure transaction injection', failureTransactions);
    await check('runtime GL draw fallback and Canvas unavailable', runtimeFailure);
    for (const mode of ['standard', 'enhanced']) await check(mode + ' interrupted first-frame count/size rewarm', () => interruptedPreparation(mode));
    await check('partial ripple pool DOM failure cleanup', partialPoolFailure);
    await check('A/B baseline/window cancellation and diagnostics disabled', probeContracts);
    await check('A/B retained 12 percent and 30 percent protection thresholds', probeProtectionThresholds);
    for (const mode of ['standard', 'enhanced']) await check(mode + ' native cold/warm 10 each and lifecycle resources', () => nativeSamples(mode));
    await check('no uncaught page errors', async () => { assert.deepEqual(report.errors, []); return { count: report.errors.length }; });
    await check('unchanged production source bytes during verification', async () => { assert.deepEqual(digest(), report.sourceSha256); return report.sourceSha256; });
  } finally { await browser.close(); report.finishedAt = new Date().toISOString(); report.sourceSha256AtFinish = digest(); report.sourceChangedDuringRun = JSON.stringify(report.sourceSha256) !== JSON.stringify(report.sourceSha256AtFinish); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log('Evidence: ' + out); }
  if (report.checks.some(c => c.status === 'failed')) process.exitCode = 1;
}
main().catch(error => { console.error(error); report.fatal = error.stack; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); process.exitCode = 1; });
