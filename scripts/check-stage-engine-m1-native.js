// SPDX-License-Identifier: MIT
// Actual embedded Wry/WebView2 candidate, current OS display settings and real time.
// This checks migrated subsets; incomplete allocation/device coverage keeps M1 open.
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), net = require('node:net');
const { spawn, execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const binary = path.resolve(process.env.HERTZ_BIN || '');
assert.ok(process.env.HERTZ_BIN && fs.statSync(binary).isFile(), 'Pin HERTZ_BIN to an isolated current candidate');
const edition = process.env.HERTZ_EDITION || 'standard';
assert.ok(['standard', 'full'].includes(edition));
const output = path.join(root, 'output/a09-m1-20261108/native-' + edition + '-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, { recursive: true });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const save = (name, value) => fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2) + '\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), edition, binary, binarySha256: hash(fs.readFileSync(binary)),
  scope: 'Actual isolated Wry/WebView2 embedded candidate on current Windows display. Reachable Creative/Stage3D/Space combinations; hidden legacy 2D sidebar owners remain module-test scope. No weak-device/4K, complete coverage or frozen policy claim.',
  checks: [], errors: [], samples: [], embeddedAssets: [] };
const manifestFile = path.join(path.dirname(binary), 'candidate.json');
if (fs.existsSync(manifestFile)) {
  report.artifactManifest = JSON.parse(fs.readFileSync(manifestFile));
  assert.equal(report.artifactManifest.binarySha256, report.binarySha256, 'frozen candidate binary');
  assert.equal(report.artifactManifest.edition, edition, 'frozen candidate edition');
  for (const [file, expected] of Object.entries(report.artifactManifest.sourceSha256)) {
    assert.equal(hash(fs.readFileSync(path.join(root, file))), expected, 'current candidate source ' + file);
  }
}
let child, browser, page, discovery, failedSpawn;
async function until(read, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (failedSpawn) throw failedSpawn;
    if (child && child.exitCode !== null) throw new Error('Owned native candidate exited: ' + child.exitCode);
    const value = await read(); if (value) return value;
    await delay(150);
  }
  throw new Error('Timed out: ' + label);
}
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function api(endpoint, method = 'GET', body) {
  const response = await fetch('http://127.0.0.1:' + discovery.port + endpoint, { method,
    headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); assert.ok(response.ok, endpoint + ': ' + response.status); return value;
}
function native(action) {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    path.join(root, 'scripts/main-window-geometry-fixture.ps1'), '-OwnerPid', String(child.pid), '-Action', action],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim());
}
async function processes() {
  const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    path.join(root, 'scripts/stage-engine-m1-process-observer.ps1'), '-OwnerPid', String(child.pid)],
  { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return JSON.parse(stdout.trim());
}
async function check(name, run) {
  try { const evidence = await run(); report.checks.push({ name, passed: true, evidence }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: error.stack }); console.error('FAIL ' + name + ': ' + error.message); }
  save('report', report);
}
async function start() {
  const cdp = await port(), data = path.join(output, 'data');
  const log = fs.openSync(path.join(output, 'host.log'), 'a');
  child = spawn(binary, ['--window', '--bind', '127.0.0.1', '--port', '0', '--data-dir', data], {
    cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env,
      VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', HERTZ_DESKTOP_CONFIG_DIR: path.join(output, 'desktop'),
      WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + cdp }
  });
  fs.closeSync(log); child.on('error', error => { failedSpawn = error; }); report.pid = child.pid;
  discovery = await until(() => {
    try { const d = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'))); return d.pid === child.pid && d; } catch { return null; }
  }, 'owned isolated server');
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + cdp + '/json/version')).ok; } catch { return false; } }, 'native WebView2 debugger');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdp);
  page = await until(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://127.0.0.1:' + discovery.port)), 'owned Wry page');
  page.on('pageerror', error => { report.errors.push(error.stack); console.error('PAGE ERROR ' + error.message); });
  await page.waitForFunction(() => !!window.Stage?.resources?.() && !!window.Space3D && window.WindowLifecycle?.isNative());
  native('maximize'); native('focus');
  await page.waitForFunction(() => !Stage.isDocumentHidden() && innerWidth > 500);
  report.window = native('read'); report.userAgent = await page.evaluate(() => navigator.userAgent);
  report.display = await page.evaluate(() => ({ dpr: devicePixelRatio, viewport: [innerWidth, innerHeight],
    screen: [screen.width, screen.height], available: [screen.availWidth, screen.availHeight], hidden: document.hidden,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    documentHiddenOverridden: Object.prototype.hasOwnProperty.call(document, 'hidden') }));
  assert.equal(report.display.documentHiddenOverridden, false, 'original browser visibility property remains intact');
  report.health = await api('/v1/health'); assert.equal(report.health.backend, 'null');
  save('startup', { ...report, health: { ...report.health }, serverPort: discovery.port });
}
async function embedded() {
  const helper = path.join(output, 'edition-ui.exe'), expectedUi = path.join(output, 'expected-ui');
  execFileSync('rustc', ['--edition=2021', path.join(root, 'build-support/edition-ui.rs'), '-o', helper], { windowsHide: true });
  execFileSync(helper, [path.join(root, 'plugin/ui'), expectedUi, edition], { windowsHide: true });
  require('./minify-ui').minifyUi(expectedUi);
  report.buildOwners = Object.fromEntries(['build-support/edition-ui.rs', 'scripts/minify-ui.js', 'crates/hertz-studio/build.rs']
    .map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
  const files = ['app.js', 'stage-json-source.js', 'stage-persistence.js', 'stage-resource-budget.js', 'stage-resource-policy.js', 'stage-image-source.js', 'stage.js', 'stage-particles.js',
    'stage-particles-gl.js', 'stage-fluid.js', 'stage3d.js', 'creative-stage.js', 'creative-gl.js', 'space3d.js',
    'vendor/stage-runtime.js', 'vendor/space-stage.js', 'vendor/stage-fluid.js', 'vendor/pixi.min.js',
    'lyric-glyph-gl.js', 'lyric-glyph-atlas.js', 'stanza/stanza-glyph.js', 'stanza/stanza-sonnet.js', 'stanza/stanza-tempera.js', 'video-export.js',
    'backgrounds.js', 'bgwall.js', 'handdrawn.js', 'stage-media.js', 'stage-anime-svg.js', 'stage-freecam.js',
    'stage-shelf.js', 'space-home.js', 'player-transitions.js'];
  for (const file of files) {
    const expected = fs.readFileSync(path.join(expectedUi, file));
    const response = await fetch('http://127.0.0.1:' + discovery.port + '/' + file);
    const bytes = Buffer.from(await response.arrayBuffer());
    const row = { file, status: response.status, sourceSha256: hash(fs.readFileSync(path.join(root, 'plugin/ui', file))),
      expectedSha256: hash(expected), embeddedSha256: hash(bytes), bytes: bytes.length };
    report.embeddedAssets.push(row); assert.equal(response.status, 200, file); assert.equal(row.embeddedSha256, row.expectedSha256, 'current embedded ' + file);
  }
  return report.embeddedAssets;
}
async function playback() {
  const music = path.join(output, 'music'); fs.mkdirSync(music);
  const rate = 8000, seconds = 900, wav = Buffer.alloc(44 + rate * seconds * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < rate * seconds; i++) wav.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 220 / rate) * 1600), 44 + i * 2);
  fs.writeFileSync(path.join(music, 'M1 native fixture.wav'), wav);
  await api('/v1/library/scan', 'POST', { root: music });
  const track = await until(async () => (await api('/v1/tracks?limit=20')).tracks[0], 'isolated real audio fixture');
  await api('/v1/player/load', 'POST', { track_id: track.id });
  await until(async () => (await api('/v1/state')).playing, 'original audio actor playing');
  await page.waitForFunction(() => Stage.presentation().playing);
  await page.evaluate(() => {
    const h = window.__m1Native = { collecting: false, samples: [], contexts: [], awaitingGate: null, firstGate: null };
    const originalMark = HertzPerf.markSince;
    HertzPerf.markSince = function (name, startedAt) {
      const now = performance.now();
      if (h.collecting && name.startsWith('gate.') && h.samples.length < 100000) h.samples.push({ name, at: now, costMs: now - startedAt });
      if (h.awaitingGate === name && !Stage.isDocumentHidden() && Stage.presentation().playing) { h.firstGate = h.read(); h.awaitingGate = null; }
      return originalMark.apply(this, arguments);
    };
    const originalGet = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      const gl = originalGet.call(this, kind, ...args);
      if (gl && /webgl/.test(kind)) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        h.contexts.push({ kind, width: this.width, height: this.height, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) });
      }
      return gl;
    };
    h.read = () => ({ now: performance.now(), hidden: Stage.isDocumentHidden(), browserDocumentHidden: document.hidden,
      nativePresentation: { version: __hertzWindowHost.presentationVersion, documentId: __hertzWindowHost.documentId,
        hidden: __hertzWindowHost.presentationHidden }, ledger: Stage.resources().snapshot(true),
      layout: { stage: document.getElementById('stage').getBoundingClientRect().toJSON(),
        display: getComputedStyle(document.getElementById('stage')).display, bodyClass: document.body.className,
        idle: document.body.dataset.stageIdle, appSnapshot: typeof state === 'undefined' ? null : state.snapshot,
        frame: Stage.frameState() },
      gates: Stage.gateRates(), displayHz: Stage.displayHz(), particles: StageParticles.stats(), fluid: StageFluid.stats(),
      creative: CreativeStage.stats(), stage3d: Stage3D.stats(), space: Space3D.stats(), contexts: h.contexts.slice() });
  });
  report.documentBaseline = await page.evaluate(() => Stage.resources().snapshot(true));
  return { trackId: track.id, durationMs: track.duration_ms, nullOutput: true };
}
async function setMode(mode) {
  native('maximize'); native('focus');
  await page.waitForFunction(() => !Stage.isDocumentHidden());
  await page.evaluate(mode => {
    Space3D.close(); Stage3D.close(); CreativeStage.attachStage(null); CreativeStage.attach(false);
    StageControl.set({ fluidEnabled: false }); document.body.classList.add('stage-open');
    if (mode === 'canvas' || mode === 'gl' || mode === 'fluid') {
      StageParticles.init(); StageParticles.attach(mode === 'canvas' ? 'standard' : 'enhanced');
      if (mode === 'fluid') StageControl.set({ fluidEnabled: true, fluidStrength: 100 });
    } else if (mode === 'creative') {
      CreativeStage.init(); Stage3D.configure({ sceneSource: 'creative', lyrics: false }); Stage3D.open();
    } else if (mode === 'raw') {
      Stage3D.configure({ sceneSource: 'immersive', lyrics: false }); Stage3D.open('aurora');
    } else if (mode === 'space') {
      Space3D.configure({ sceneSource: 'coast', qualityMode: 'high', lyrics: false }); Space3D.open('coast'); Space3D.enterStage();
    }
    Stage.kick();
  }, mode);
  await delay(7000);
  const target = await page.evaluate(mode => {
    const intended = ({ canvas: 'particles', gl: 'particles', fluid: 'stage-fluid', creative: 'creative', raw: 'stage3d', space: 'space3d' })[mode];
    return { gate: Stage.gateRates().find(gate => gate.name === intended), state: __m1Native.read() };
  }, mode);
  save('preflight-' + mode, target);
  assert.ok(target.gate?.target > 0, 'intended host has a runnable visible production gate');
}
function summarize(rows, spanMs) {
  const names = [...new Set(rows.map(row => row.name))];
  const percentile = (values, p) => values.length ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))] : null;
  return names.map(name => {
    const samples = rows.filter(row => row.name === name), costs = samples.map(row => row.costMs).sort((a, b) => a - b);
    const intervals = samples.slice(1).map((row, i) => row.at - samples[i].at).sort((a, b) => a - b);
    return { name, executedFrames: samples.length, actualFps: samples.length * 1000 / spanMs,
      cpuMedianMs: percentile(costs, .5), cpuP95Ms: percentile(costs, .95), intervalMedianMs: percentile(intervals, .5), intervalP95Ms: percentile(intervals, .95) };
  });
}
async function soak(mode) {
  await setMode(mode);
  const windowBefore = native('read');
  const processBefore = await processes();
  const before = await page.evaluate(() => { __m1Native.samples = []; __m1Native.collecting = true; return __m1Native.read(); });
  const reads = [];
  for (let i = 0; i < 4; i++) {
    await delay(15000); reads.push({ page: await page.evaluate(() => __m1Native.read()), window: native('read'), processes: await processes() });
    console.log('SAMPLE ' + mode + ' ' + (i + 1) + '/4');
  }
  const after = await page.evaluate(() => { __m1Native.collecting = false; return { ...__m1Native.read(), rawSamples: __m1Native.samples }; });
  const windowAfter = native('read');
  const finalPresentation = await page.evaluate(() => ({ hidden: Stage.isDocumentHidden(), nativeHidden: __hertzWindowHost.presentationHidden, now: performance.now() }));
  const elapsed = after.now - before.now, summary = summarize(after.rawSamples, elapsed);
  const result = { mode, before, windowBefore, processBefore, reads, after, windowAfter, finalPresentation, elapsedMs: elapsed, summary };
  save('soak-' + mode, result); report.samples.push({ mode, elapsedMs: elapsed, summary, hidden: after.hidden, contexts: after.contexts });
  assert.ok(elapsed >= 60000); assert.equal(before.hidden, false); assert.equal(after.hidden, false);
  for (const windowSample of [windowBefore, ...reads.map(read => read.window), windowAfter]) {
    assert.equal(windowSample.minimized, false, 'every visible sample belongs to a non-minimized HWND');
    assert.equal(windowSample.visible, true, 'every visible sample belongs to a visible HWND');
    assert.equal(windowSample.handle, windowBefore.handle, 'same owned HWND throughout the visible sample');
  }
  assert.equal(finalPresentation.hidden, false, 'native read bracket retains visible Stage projection');
  const gate = ({ canvas: 'particles', gl: 'particles', fluid: 'stage-fluid', creative: 'creative', raw: 'stage3d', space: 'space3d' })[mode];
  assert.ok(summary.some(row => row.name === 'gate.' + gate && row.executedFrames > 60), 'real intended host gate executed during the sample: ' + gate);
  if (mode === 'canvas') assert.equal(after.particles.actualBackend, 'canvas2d');
  if (mode === 'gl' || mode === 'fluid') assert.equal(after.particles.actualBackend, 'webgl');
  if (mode === 'fluid') assert.ok(after.fluid.frames > before.fluid.frames);
  if (mode === 'creative') assert.ok(after.creative.sceneTimeMs > before.creative.sceneTimeMs);
  if (mode === 'raw') assert.ok(after.stage3d.sceneTimeMs > before.stage3d.sceneTimeMs);
  if (mode === 'space') assert.ok(after.space.renderer.frameCount > before.space.renderer.frameCount);
  assert.equal(after.ledger.violations.length, 0, 'declared allocation violations');
  await page.screenshot({ path: path.join(output, mode + '.png') });
  return { mode, elapsedMs: elapsed, summary, report: path.join(output, 'soak-' + mode + '.json') };
}
const gateFor = mode => ({ canvas: 'particles', gl: 'particles', fluid: 'stage-fluid', creative: 'creative', raw: 'stage3d', space: 'space3d' })[mode];
function phase(mode, sample) {
  if (mode === 'canvas' || mode === 'gl') return sample.particles.frame.sceneTimeMs;
  if (mode === 'fluid') return sample.fluid.sceneTimeMs;
  if (mode === 'creative') return sample.creative.sceneTimeMs;
  if (mode === 'raw') return sample.stage3d.sceneTimeMs;
  return sample.space.sceneTimeMs;
}
async function lifecycle(mode, hiddenSeconds = 60) {
  await api('/v1/player/pause', 'POST', {}); await page.waitForFunction(() => !Stage.presentation().playing); await delay(600);
  const paused = await page.evaluate(() => __m1Native.read()); await delay(800);
  const staticFrame = await page.evaluate(() => __m1Native.read());
  assert.equal(phase(mode, staticFrame), phase(mode, paused), 'paused geometry');
  await api('/v1/player/seek', 'POST', { position_ms: 45000 }); await delay(700);
  const sought = await page.evaluate(() => ({ ...__m1Native.read(), positionMs: Stage.position() }));
  assert.equal(phase(mode, sought), phase(mode, paused), 'seek does not advance paused geometry');
  assert.ok(Math.abs(sought.positionMs - 45000) < 1500);
  await page.evaluate(name => { __m1Native.awaitingGate = 'gate.' + name; __m1Native.firstGate = null; }, gateFor(mode));
  await api('/v1/player/play', 'POST', {});
  await page.waitForFunction(() => !!__m1Native.firstGate);
  const resumed = await page.evaluate(() => __m1Native.firstGate);
  assert.equal(phase(mode, resumed), phase(mode, paused), 'first resumed gate delta zero');
  await delay(500);
  native('minimize'); await page.waitForFunction(() => Stage.isDocumentHidden(), null, { polling: 100 }); await delay(500);
  const hidden = await page.evaluate(() => __m1Native.read()), hiddenProcesses = await processes();
  assert.equal(hidden.nativePresentation.version, 1);
  assert.equal(hidden.nativePresentation.hidden, true, 'native host reports actual parent suspension');
  assert.equal(hidden.layout.frame.documentHidden, true, 'borrowed Stage projection uses the same suspension');
  for (let i = 0; i < 4; i++) { await delay(hiddenSeconds * 250); console.log('HIDDEN ' + mode + ' ' + (i + 1) + '/4'); }
  const held = await page.evaluate(() => __m1Native.read()), heldProcesses = await processes();
  assert.ok(held.now - hidden.now >= hiddenSeconds * 1000, 'actual hidden observation duration');
  assert.equal(phase(mode, held), phase(mode, hidden), 'real native minimized geometry freeze');
  assert.deepEqual(held.ledger.held, hidden.ledger.held, 'hidden retained allocations remain charged');
  await page.evaluate(name => { __m1Native.awaitingGate = 'gate.' + name; __m1Native.firstGate = null; }, gateFor(mode));
  native('maximize'); native('focus'); await page.waitForFunction(() => !Stage.isDocumentHidden() && !!__m1Native.firstGate);
  const restored = await page.evaluate(() => __m1Native.firstGate);
  assert.equal(restored.nativePresentation.hidden, false);
  assert.equal(restored.layout.frame.documentHidden, false);
  assert.equal(phase(mode, restored), phase(mode, hidden), 'first native restore gate delta zero');
  const result = { mode, paused, staticFrame, sought, resumed, hidden, hiddenProcesses, held, heldProcesses, restored };
  save('lifecycle-' + mode, result); return { mode, phaseMs: phase(mode, restored), hiddenElapsedMs: held.now - hidden.now };
}
async function retire() {
  await api('/v1/player/pause', 'POST', {});
  const before = await page.evaluate(() => __m1Native.read());
  await page.evaluate(() => {
    Space3D.close(); Stage3D.destroy(); CreativeStage.destroy(); StageFluid.destroy(); StageParticles.destroy();
    Backgrounds.destroy(); HandDrawn.destroy(); if (window.BgWall) BgWall.dispose(); Stage.destroy();
  });
  const stable = [];
  for (let i = 0; i < 4; i++) { await delay(5000); stable.push({ ledger: await page.evaluate(() => Stage.resources().snapshot(true)), processes: await processes() }); }
  save('retirement', { before, stable, note: 'Controlled API release and driver/process cache observations are distinct.' });
  const final = stable.at(-1).ledger;
  const baselineIds = new Set(report.documentBaseline.entries.map(entry => entry.resourceId));
  assert.ok(final.entries.every(entry => baselineIds.has(entry.resourceId)), 'no new renderer/resource lifetime survives retirement');
  assert.ok(Object.keys(final.held).every(key => final.held[key] <= report.documentBaseline.held[key]), 'held resource vector returns within the declared pre-attach document baseline');
  for (const key of ['gpuContexts', 'canvases', 'drawingBufferPixels', 'programs', 'renderTargetDeclaredBytes', 'textureDeclaredBytes', 'bufferDeclaredBytes', 'decodeReservedBytes', 'decoderLeases']) assert.equal(final.held[key], 0, 'retired ' + key);
  assert.equal(final.pending.ownedCpuBytes, 0);
  return { final, observationSamples: stable.length, documentWorkspace: 'Only previously identified fixed module workspace may remain until the document itself exits.' };
}
async function main() {
  console.log(output);
  try {
    await start();
    await check('current edition-specific embedded assets match current source', embedded);
    if (!report.checks[0].passed) return;
    await check('real isolated audio actor and original production metrics', playback);
    if (!report.checks[1].passed) return;
    await check('actual native CAS persistence keeps one snapshot source and protected borrows', async () => {
      await page.evaluate(() => CreativeStage.hydrated());
      const before = await page.evaluate(() => Stage.resources().snapshot(true));
      assert.equal(before.entries.filter(entry => entry.owner === 'stage-persistence').length, 1);
      assert.equal(await page.evaluate(() => StagePersistence.status().hydrated), true);
      const state = await page.evaluate(async () => {
        CreativeStage.renamePreset('M1 native JSON owner'); await CreativeStage.flushPersistence();
        const saved = CreativeStage.savePreset('M1 native library owner'); await CreativeStage.flushLibrary();
        await CreativeStage.reloadPersistence();
        const reloaded = CreativeStage.library(); CreativeStage.loadPresetById(saved.id);
        CreativeStage.removePreset(saved.id); await CreativeStage.flushLibrary();
        const removed = Stage.resources().snapshot(true), stillCurrent = CreativeStage.preset().name;
        CreativeStage.setPreset({ scene: 'towers', name: 'M1 native JSON owner' }); await CreativeStage.flushPersistence();
        return { name: CreativeStage.preset().name, status: StagePersistence.status(), ledger: Stage.resources().snapshot(true),
          savedId: saved.id, reloadedIds: reloaded.map(item => item.id), stillCurrent, removed, library: CreativeStage.library() };
      });
      assert.equal(state.name, 'M1 native JSON owner'); assert.equal(state.status.current.error, null);
      assert(state.reloadedIds.includes(state.savedId)); assert.equal(state.library.length, 0);
      assert.equal(state.stillCurrent, 'M1 native library owner');
      const borrowedMetadata = state.removed.entries.filter(entry => entry.owner === 'creative-library' && /borrowing/.test(entry.basis.source));
      assert.equal(borrowedMetadata.length, 1); assert.equal(borrowedMetadata[0].leases, 1);
      assert.equal(state.ledger.entries.filter(entry => entry.owner === 'creative-library').length, 1);
      const sources = state.ledger.entries.filter(entry => entry.owner === 'stage-persistence');
      assert.equal(sources.length, 1); assert(sources[0].leases >= 1); assert.equal(state.ledger.violations.length, 0);
      return { before, state };
    });
    if (process.argv.includes('--inspect')) {
      await setMode(process.env.M1_NATIVE_MODES || 'canvas');
      save('inspection', await page.evaluate(() => __m1Native.read()));
      await page.screenshot({ path: path.join(output, 'inspection.png') }); return;
    }
    if (process.argv.includes('--visibility-probe')) {
      await setMode('creative');
      await check('quick actual native controller visibility and pause/seek/resume probe (one second hidden)', () => lifecycle('creative', 1));
      await check('controlled owner retirement and separate OS recovery observations', retire); return;
    }
    const modes = process.env.M1_NATIVE_MODES ? process.env.M1_NATIVE_MODES.split(',') : ['creative', 'raw', 'space'];
    for (const mode of modes) {
      await check('current native real-time 60-second combination ' + mode, () => soak(mode));
      if (process.argv.includes('--lifecycle')) await check('actual native pause/seek/minimized 60-second lifecycle ' + mode, () => lifecycle(mode));
    }
    await check('controlled owner retirement and separate OS recovery observations', retire);
  } catch (error) { report.errors.push(error.stack); console.error(error.stack); }
  finally {
    report.finishedAt = new Date().toISOString();
    report.passed = report.errors.length === 0 && report.checks.length > 0 && report.checks.every(row => row.passed);
    save('report', report);
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (browser) await browser.close().catch(() => {});
    process.exitCode = report.passed ? 0 : 1;
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, errors: report.errors.length, output }));
  }
}
main();
