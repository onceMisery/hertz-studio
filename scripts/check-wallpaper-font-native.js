#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real FontFace/Close/Drain acceptance for the original preparation host.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {buildZip, FIXTURE_PNG} = require('./check-wallpaper-media-native');
const {loadCompositionFontFixture} = require('./composition-font-fixture');
const request = require('./desktop-native-management-client');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.HERTZ_FONT_NATIVE_OUTPUT || path.join(root, 'output/a04-p2-20261108/font-text/native-prepare-' + Date.now()));
const port = Number(process.env.DESKTOP_CDP_PORT || 19748);
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, wallpaper, nonce = 0, spawnError, baseline;
const evidence = {checks: [], results: [], limits: ['Font preparation only; overall composition text gate remains closed',
  'Current Windows device; text raster/pool/Apply and additional devices remain separate acceptance']};
const status = () => request(pipe, {command: 'status'});
async function until(read, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (spawnError) throw spawnError;
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('Owned host exited: ' + label);
    const value = await read(); if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
async function send(command) {
  const id = ++nonce;
  await wallpaper.evaluate(command => window.ipc.postMessage('wallpaper_probe_import ' + JSON.stringify(command)), {nonce: id, ...command});
  return id;
}
async function receive(id) {
  await wallpaper.waitForFunction(id => !!window.__nativeImportProbes?.[id], id, {timeout: 60000});
  const result = await wallpaper.evaluate(id => window.__nativeImportProbes[id], id);
  evidence.results.push({nonce: id, result}); return result;
}
const run = async command => receive(await send(command));
function retired(result) {
  for (const field of ['prepareTasks', 'prepareCpuBytes', 'activeStreams', 'decoderSlots']) assert.equal(result[field], 0, field);
  if (baseline) for (const field of ['cpuBytes', 'gpuBytes']) assert.equal(result[field], baseline[field], field + ' returns to builtin baseline');
}
function mark(name) { evidence.checks.push(name); process.stdout.write('PASS ' + name + '\n'); }
async function main() {
  assert.equal(process.platform, 'win32');
  assert(process.env.HERTZ_DESKTOP_BIN && process.env.HERTZ_DESKTOP_BUILD_RECEIPT, 'Set copied candidate and successful source receipt');
  const binary = path.resolve(process.env.HERTZ_DESKTOP_BIN);
  const receipt = JSON.parse(fs.readFileSync(process.env.HERTZ_DESKTOP_BUILD_RECEIPT, 'utf8'));
  assert.equal(receipt.buildSucceeded, true); assert.equal(receipt.sourceBuildBinding, true);
  assert(receipt.features.includes('wallpaper-media-probe')); assert.equal(hash(fs.readFileSync(binary)), receipt.binarySha256);
  const inputs = receipt.sourceHashes;
  for (const file of ['crates/hertz-desktop/src/wallpaper/font_prepare.rs', 'crates/hertz-desktop/assets/wallpaper-font-probe.js',
    'crates/hertz-desktop/src/wallpaper/decode_probe_harness.rs', 'scripts/check-wallpaper-font-native.js', 'Cargo.lock']) assert(inputs[file], file);
  for (const [file, sha] of Object.entries(inputs)) assert.equal(hash(fs.readFileSync(path.join(root, file))), sha, 'source changed: ' + file);
  evidence.binary = {path: binary, sha256: receipt.binarySha256, sourceCount: Object.keys(inputs).length};
  try { await status(); throw new Error('Existing desktop host; leave it untouched'); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/json/version', {signal: AbortSignal.timeout(1000)});
    assert.equal(response.ok, false, 'CDP port is already owned');
  } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
  fs.mkdirSync(path.join(output, 'probe-inputs'), {recursive: true});
  const coast = require('../crates/hertz-wallpaper/contracts/catalog.json').scenes.find(scene => scene.id === 'coast');
  const lyrics = {enabled: false, locked: true, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32,
    fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff', outlineColor: '#151719', outlineWidth: 1,
    opacity: 1, width: 550, anchorX: .5, anchorY: .5, monitor: null};
  const config = {schemaVersion: 5, revision: 1, launchAtLogin: false, activeProfile: null, profiles: [], lastCommit: null,
    unboundDomain: {lyrics, wallpaper: {enabled: true, audioInput: {kind: 'none'}, batteryPolicy: 'pause', pauseOnFullscreen: false,
      pauseOnMaximized: false, applicationRules: [], groups: [{id: 'font-prepare', mode: 'single', displays: [{kind: 'primary'}],
        selection: {kind: 'builtin', sceneId: 'coast', stateVersion: coast.stateVersion,
          params: Object.fromEntries(Object.entries(coast.params).map(([key, definition]) => [key, definition.default]))},
        presentation: {fps: 15, quality: 'low', brightness: 1, motion: 1, fit: 'contain', pointer: false}, properties: {}}]}}};
  fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify(config));
  const fixture = loadCompositionFontFixture();
  const files = [['assets/background.png', Buffer.from(FIXTURE_PNG), 'image/png'], ['assets/font.ttf', fixture.bytes, fixture.mime],
    ...fixture.packageFiles.map(file => [file.file, file.bytes, file.mime])];
  const manifest = {formatVersion: 1, workId: crypto.randomUUID(), version: 1, title: 'Hertz Studio font qualification', description: '',
    content: {kind: 'image', asset: 'background'}, assets: [{id: 'background', kind: 'image', source: 'assets/background.png', variants: []},
      {id: 'brand-font', kind: 'font', source: 'assets/font.ttf', variants: []}],
    files: files.map(([path, bytes, mime]) => ({path, bytes: bytes.length, sha256: hash(bytes), mime})), properties: [],
    permissions: {audioSpectrum: false, pointer: false}, license: {code: 'none', ...fixture.manifestLicense}};
  const archive = buildZip([['manifest.json', Buffer.from(JSON.stringify(manifest))], ...files.map(([file, bytes]) => [file, bytes])]);
  const input = path.join(output, 'probe-inputs/font-fixture.hwpkg'); fs.writeFileSync(input, archive);
  evidence.fixture = {packageHash: hash(archive), fontHash: fixture.sha256, provenance: fixture.provenance};
  const log = fs.openSync(path.join(output, 'host.log'), 'w');
  child = spawn(binary, ['--settings'], {cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: {...process.env,
    HERTZ_DESKTOP_CONFIG_DIR: output, WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port}});
  fs.closeSync(log); child.on('error', error => { spawnError = error; }); evidence.pid = child.pid;
  await until(async () => { try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); return browser; } catch { return null; } }, 'owned WebView2 CDP');
  const pages = () => browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed());
  wallpaper = await until(() => pages().find(page => page.url().endsWith('/wallpaper.html')), 'trusted wallpaper surface');
  await wallpaper.waitForFunction(() => !!window.hertzWallpaper && !!window.ipc);
  const initialTarget = await until(async () => {
    const value = await status();
    const target = value.wallpaper.targets.find(target => target.groupId === 'font-prepare');
    if (target?.applyError) throw new Error(JSON.stringify(target));
    if (!target?.firstFrameReady || !target.visible || target.candidateLoading || target.selectionPreparing
        || target.handoff || value.wallpaper.retiringControllers || value.wallpaper.retirements.length) return null;
    assert.deepEqual(target.appliedSelection, config.unboundDomain.wallpaper.groups[0].selection);
    assert.equal(target.appliedRevision, config.revision); assert.equal(target.desiredRevision, config.revision);
    return target;
  }, 'original native builtin first frame and committed session');
  const initialSession = initialTarget.session.binding.sessionId;
  wallpaper = await until(async () => {
    for (const page of pages().filter(page => page.url().endsWith('/wallpaper.html'))) {
      if (await page.evaluate(id => window.hertzWallpaper?.debug().session?.sessionId === id, initialSession)
          .catch(() => false)) return page;
    }
    return null;
  }, 'wallpaper renderer matches the committed native session');
  evidence.initialTarget = initialTarget;
  evidence.browser = browser.version();
  const imported = await run({action: 'begin', name: 'font-fixture'});
  assert.equal(imported.state, 'done', JSON.stringify(imported)); assert.equal(imported.packageHash, hash(archive)); retired(imported);
  fs.unlinkSync(input);
  mark('licensed font package installs and retains immutable bytes after the original input is removed');
  await wallpaper.waitForFunction(() => window.hertzWallpaper.debug().draws > 0);
  await until(async () => {
    const a = (await status()).wallpaper.budget;
    await delay(100);
    const b = (await status()).wallpaper.budget;
    if (a.cpuBytes !== b.cpuBytes || a.gpuBytes !== b.gpuBytes || b.prepareTasks || b.releasePending) return null;
    baseline = {cpuBytes: b.cpuBytes, gpuBytes: b.gpuBytes}; return baseline;
  }, 'stable original builtin resource baseline');
  evidence.baseline = baseline;
  const reference = {packageHash: hash(archive), assetId: 'brand-font', variantId: null};
  const prepare = (name, extra = {}) => ({action: 'prepare-font', name, reference, fontText: fixture.text, ...extra});
  const first = await run(prepare('font-native-first'));
  assert.equal(first.state, 'done', JSON.stringify(first)); retired(first); assert.equal(first.probeRuns, 1);
  assert.equal(first.preparedFont.metadata.format, 'ttf'); assert.equal(first.preparedFont.metadata.sfntBytes, fixture.byteLength);
  assert.equal(first.preparedFont.reference.packageHash, reference.packageHash);
  assert.match(first.preparedFont.url, /\/files\/assets\/font\.ttf$/); assert.equal(first.preparedFont.contentKey.length, 64);
  assert(first.preparedFont.metadata.probeText.length > 0); evidence.first = first;
  mark('actual WebView2 FontFace and glyph-alpha evidence produce a sealed font only after Close and readers drain');
  const cached = await run(prepare('font-native-cached'));
  assert.equal(cached.state, 'done', JSON.stringify(cached)); retired(cached);
  assert.equal(cached.cacheHits, 1); assert.equal(cached.probeRuns, 0);
  assert.equal(cached.preparedFont.contentKey, first.preparedFont.contentKey);
  mark('the original Library cache reuses only the same completed font and environment');
  const missing = await run(prepare('font-native-missing', {fontText: 'Hertz 中'}));
  assert.equal(missing.state, 'failed', JSON.stringify(missing)); assert.equal(missing.probeRuns, 0); retired(missing);
  assert.equal(missing.fontError.code, 'font_glyph_unavailable'); assert.equal(missing.fontError.details.nodeId, 'probe-text');
  mark('missing glyphs are rejected before a native probe, even when font qualification is cached');
  const pendingId = await send(prepare('font-native-close-held', {forceProbe: true, blockClose: true}));
  const held = await until(async () => { const value = await status(); const probe = value.wallpaper.decodeProbe;
    return probe?.fontSettled && probe.closeError && value; }, 'font Close failure retains its original reservation');
  evidence.held = held.wallpaper.decodeProbe;
  assert.equal(held.wallpaper.budget.prepareTasks, 1); assert(held.wallpaper.budget.releasePending > 0);
  const fontCpu = first.preparedFont.metadata.cpuBudgetBytes + 256 * 128 * 8;
  const fontGpu = 256 * 128 * 4;
  assert.equal(held.wallpaper.budget.cpuBytes, baseline.cpuBytes + fontCpu);
  assert.equal(held.wallpaper.budget.gpuBytes, baseline.gpuBytes + fontGpu);
  assert.equal(await wallpaper.evaluate(id => !!window.__nativeImportProbes?.[id], pendingId), false);
  const fontPage = pages().find(page => page.url().endsWith('/wallpaper-probe.html')); assert(fontPage);
  assert.match(await fontPage.title(), /字体兼容性检查/);
  await fontPage.screenshot({path: path.join(output, 'font-probe-window.png')});
  const cancelled = await run({action: 'cancel', name: 'font-native-close-held'}); assert.equal(cancelled.cancelRequested, true);
  assert.equal(await wallpaper.evaluate(id => !!window.__nativeImportProbes?.[id], pendingId), false);
  await fontPage.evaluate(probeId => window.ipc.postMessage('decode_probe_close ' + JSON.stringify({nonce: 1, probeId, blocked: false})), evidence.held.probeId);
  const settled = await receive(pendingId); assert.equal(settled.state, 'cancelled'); assert.equal(settled.fontError.code, 'cancelled'); retired(settled);
  mark('Close failure and cancellation retain the prepare slot and typed reply until the real controller exits');
  async function delayedLoad(name, deadline) {
    let probePage, cdp, continued = false;
    const paused = [];
    try {
      const id = await send(prepare(name, {forceProbe: true, holdFontReady: true}));
      probePage = await until(async () => {
        for (const page of pages().filter(page => page.url().endsWith('/wallpaper-probe.html'))) {
          if (await page.evaluate(() => window.__hertzFontProbeReadyHeld === true).catch(() => false)) return page;
        }
        return null;
      }, 'owned font controller holds its original ready handshake');
      const armed = (await status()).wallpaper.decodeProbe;
      assert.equal(armed.started, false); assert.equal(armed.outcome, null);
      // WebView2's new controllers did not register page.route interception in
      // the direct/route/direct native differential. Arm this exact target.
      cdp = await probePage.context().newCDPSession(probePage);
      cdp.on('Fetch.requestPaused', request => paused.push(request));
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', {cacheDisabled: true});
      await cdp.send('Fetch.enable', {patterns: [{urlPattern: first.preparedFont.url, requestStage: 'Request'}]});
      await probePage.evaluate(() => window.ipc.postMessage('ready'));
      const original = await until(() => paused[0], 'original granted font request reaches the delay gate');
      assert.equal(original.request.url, first.preparedFont.url); assert.equal(paused.length, 1);
      if (!deadline) assert.equal((await run({action: 'cancel', name})).cancelRequested, true);
      const expected = deadline ? 'probe_inconclusive' : 'cancelled';
      const current = await until(async () => {
        const value = await status(), probe = value.wallpaper.decodeProbe;
        return probe?.started && !probe.fontSettled && probe.outcome === expected && value;
      }, 'pending FontFace ' + expected + ' retains load and native budget', 30000);
      assert.equal(current.wallpaper.budget.prepareTasks, 1);
      assert.equal(current.wallpaper.budget.cpuBytes, baseline.cpuBytes + fontCpu);
      assert.equal(current.wallpaper.budget.gpuBytes, baseline.gpuBytes + fontGpu);
      assert.equal(await wallpaper.evaluate(id => !!window.__nativeImportProbes?.[id], id), false);
      evidence[deadline ? 'pendingDeadline' : 'pendingCancel'] = {...current.wallpaper.decodeProbe,
        requestId: original.requestId, requestUrl: original.request.url};
      // Continue the original request; no substituted bytes or extra grant owner.
      await cdp.send('Fetch.continueRequest', {requestId: original.requestId}); continued = true;
      const result = await receive(id);
      assert.equal(result.state, deadline ? 'failed' : 'cancelled');
      assert.equal(result.fontError.code, expected); assert(!result.preparedFont); retired(result);
      assert.equal(result.probeRuns, 1); assert.equal(result.cacheHits, 0);
      await until(() => probePage.isClosed(), 'delayed font controller actually exits');
      assert.equal(paused.length, 1);
    } finally {
      if (cdp && probePage && !probePage.isClosed()) {
        try {
          if (!continued && paused[0]) await cdp.send('Fetch.continueRequest', {requestId: paused[0].requestId});
          await cdp.send('Fetch.disable'); await cdp.detach();
        }
        catch (error) { if (!probePage.isClosed()) throw error; }
      }
    }
  }
  await delayedLoad('font-native-load-cancelled', false);
  mark('native cancellation holds a pending FontFace request until its actual late settlement');
  await delayedLoad('font-native-load-deadline', true);
  mark('native deadline retains pending load and rejects its late completion without font success');
  for (let index = 0; index < 50; index++) {
    const result = await run(prepare('font-native-cycle-' + index, {forceProbe: true}));
    assert.equal(result.state, 'done', JSON.stringify(result)); retired(result);
    assert.equal(result.probeRuns, 1); assert.equal(result.preparedFont.contentKey, first.preparedFont.contentKey);
  }
  assert.equal((await status()).wallpaper.decodeProbe, null);
  assert(!pages().some(page => page.url().endsWith('/wallpaper-probe.html')));
  mark('50 real font preparation controllers retire without accumulated slots, streams or temporary workspace');
  assert(pages().some(page => page.url().endsWith('/settings.html')));
  await request(pipe, {command: 'quit'});
  const end = Date.now() + 15000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < end) await delay(100);
  assert.equal(child.exitCode, 0, 'owned test host must exit naturally'); evidence.naturalExit = true;
  assert.equal(hash(fs.readFileSync(binary)), receipt.binarySha256);
  for (const [file, sha] of Object.entries(inputs)) assert.equal(hash(fs.readFileSync(path.join(root, file))), sha, 'source changed during native acceptance: ' + file);
  evidence.sourceBindingVerifiedAfterRun = true;
}
main().then(() => { evidence.passed = true; }).catch(error => {
  evidence.passed = false; evidence.error = error.stack; process.stderr.write(error.stack + '\n'); process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) { child.kill(); evidence.cleanup = 'owned failed test host terminated'; }
  fs.mkdirSync(output, {recursive: true}); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(evidence, null, 2));
  process.stdout.write(JSON.stringify({output, passed: evidence.passed, checks: evidence.checks.length}) + '\n');
});
