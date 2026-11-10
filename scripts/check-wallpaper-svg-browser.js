// SPDX-License-Identifier: MIT
// Consume actual native SVG projections and fixed PNG bytes using the shipped page.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {hash, projectionIdentity} = require('./composition-svg-fixture');
const root = path.resolve(__dirname, '..');
const directory = process.env.HERTZ_SVG_NATIVE_OUTPUT && path.resolve(process.env.HERTZ_SVG_NATIVE_OUTPUT);
assert(directory && fs.existsSync(path.join(directory, 'report.json')), 'Set the actual HERTZ_SVG_NATIVE_OUTPUT');
const native = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
assert.equal(native.nativeRun, true); assert.equal(native.sourceAfter, true); assert.equal(native.passed, true);
assert.equal(native.exit.code, 0); assert.equal(native.exit.signal, null);
const receiptFile = process.env.HERTZ_DESKTOP_BUILD_RECEIPT && path.resolve(process.env.HERTZ_DESKTOP_BUILD_RECEIPT);
function verifyNativeBindings() {
  assert(receiptFile && fs.existsSync(receiptFile), 'Set the actual HERTZ_DESKTOP_BUILD_RECEIPT used by the native journey');
  const bytes = fs.readFileSync(receiptFile), receipt = JSON.parse(bytes);
  assert.equal(hash(bytes), native.candidate.receiptSha256, 'browser receipt must be the actual native candidate receipt');
  assert.equal(receipt.buildSucceeded, true); assert.equal(receipt.sourceBuildBinding, true);
  assert.equal(receipt.binarySha256, native.candidate.binarySha256);
  assert.equal(hash(fs.readFileSync(native.candidate.binary)), receipt.binarySha256, 'copied native candidate remains exact');
  for (const [label, files] of [['native compiled sources', receipt.sourceHashes], ['native run artifacts', native.runArtifacts]]) {
    assert(files && Object.keys(files).length > 0, 'missing ' + label);
    for (const [file, digest] of Object.entries(files)) {
      const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
      assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'native input remains inside its source workspace');
      assert.equal(hash(fs.readFileSync(absolute)), digest, label + ' changed: ' + file);
    }
  }
  return {receiptFile, receiptSha256: hash(bytes), binarySha256: receipt.binarySha256,
    sourceCount: Object.keys(receipt.sourceHashes).length, runArtifactCount: Object.keys(native.runArtifacts).length};
}
function verifyNativeFrame(name) {
  const observed = native.frames.find(frame => frame.name === name);
  assert(observed?.savedArtifacts, 'native capture must bind the actual saved projection/closure/init/URI: ' + name);
  const directory = path.join(process.env.HERTZ_SVG_NATIVE_OUTPUT, 'frames', name);
  for (const file of ['projection.json', 'closure.json', 'native-init.js', 'uri.txt'])
    assert.equal(hash(fs.readFileSync(path.join(directory, file))), observed.savedArtifacts[file], 'native captured input changed: ' + name + '/' + file);
  const projection = JSON.parse(fs.readFileSync(path.join(directory, 'projection.json')));
  const identity = projectionIdentity(projection);
  assert.equal(identity.semanticKey, observed.semanticKey);
  assert.equal(identity.targetKey, observed.targetKey);
  assert.equal(projection.sessionId, observed.session.sessionId); assert.equal(projection.generation, observed.session.generation);
  const closure = JSON.parse(fs.readFileSync(path.join(directory, 'closure.json')));
  assert(closure.length === projection.resolvedAssets.length, 'native closure retains every projected payload');
  for (const entry of closure) {
    assert(/^asset-\d+\.png$/.test(entry.file), 'native closure payload stays in its captured frame');
    const bytes = fs.readFileSync(path.join(directory, entry.file));
    assert.equal(bytes.length, entry.bytes, 'native captured payload length changed: ' + name + '/' + entry.file);
    assert.equal(hash(bytes), entry.sha256, 'native captured payload changed through browser cleanup: ' + name + '/' + entry.file);
  }
}
const nativeBuildBinding = verifyNativeBindings();
const output = path.join(directory, 'browser');
assert(!fs.existsSync(output), 'Browser evidence must use a fresh output');
fs.mkdirSync(output);
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const evidence = {schemaVersion: 1, nativeReportSha256: hash(fs.readFileSync(path.join(directory, 'report.json'))),
  source: 'Actual Windows planner/candidate projection and fixed PNG bytes; shipped page in headless Chrome',
  qualification: 'Browser integration and pixels; physical GPU/device qualification belongs to the native report', nativeBuildBinding, checks: [], frames: [], errors: []};
const inputFiles = ['crates/hertz-desktop/assets/wallpaper-scene.html', 'crates/hertz-desktop/assets/wallpaper-scene.js',
  'crates/hertz-desktop/assets/wallpaper-gl-budget.js', 'plugin/ui/stage-resource-budget.js', 'plugin/ui/vendor/stage-runtime.js',
  'tools/space-stage/src/composition/plan.js', 'tools/space-stage/src/composition/nodes.js', 'scripts/check-wallpaper-svg-browser.js'];
evidence.sourceHashes = Object.fromEntries(inputFiles.map(file => [file, hash(Buffer.from(read(file)))]));
const html = read('crates/hertz-desktop/assets/wallpaper-scene.html')
  .replace('__GL_BUDGET__', () => read('plugin/ui/stage-resource-budget.js') + '\n' + read('crates/hertz-desktop/assets/wallpaper-gl-budget.js'))
  .replace('__RUNTIME__', () => read('plugin/ui/vendor/stage-runtime.js'))
  .replace('__SHIM__', () => read('plugin/ui/vendor/zodiac-stage.js'))
  .replace('__SCENE__', () => read('crates/hertz-desktop/assets/wallpaper-scene.js'));
const mark = label => {evidence.checks.push(label); console.log('PASS ' + label);};
async function main() {
  // Directly verify the production projection consumer rejects missing SVG authority.
  const {compilePlan} = await import(pathToFileURL(path.join(root, 'tools/space-stage/src/composition/plan.js')));
  verifyNativeFrame('pack-red');
  const reference = JSON.parse(fs.readFileSync(path.join(directory, 'frames/pack-red/projection.json'), 'utf8'));
  const original = compilePlan(reference); assert(original.requirements.length > 0);
  for (const change of [asset => {asset.sourceHash = '';}, asset => {asset.kind = 'vector';},
    asset => {asset.representationKind = 'vector';}, asset => {asset.mime = 'image/svg+xml';},
    asset => {asset.adapterVersion++;}, asset => {asset.decodeOptions.svgAdapterVersion = 'unreviewed';},
    asset => {const options = JSON.parse(asset.decodeOptions.svgCanonicalOptions); delete options.clipPolicy; asset.decodeOptions.svgCanonicalOptions = JSON.stringify(options);},
    asset => {asset.url = 'https://author.invalid/raw.svg';}, asset => {asset.contentKey = 'unfixed';}]) {
    const bad = structuredClone(reference); change(bad.resolvedAssets.find(asset => asset.logicalKind === 'vector'));
    assert.throws(() => compilePlan(bad), /composition-/);
  }
  mark('production projection consumer rejects raw SVG and changed fixed-representation authority');
  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  try {
    const clock = await browser.newPage();
    const intervals = await clock.evaluate(() => new Promise(resolve => {
      const samples = []; let last;
      const sample = now => {if (last !== undefined) samples.push(now - last); last = now;
        if (samples.length === 24) resolve(samples); else requestAnimationFrame(sample);}; requestAnimationFrame(sample);
    }));
    await clock.close(); const refreshHz = 1000 / intervals.toSorted((a, b) => a - b)[12]; evidence.cadence = {intervals, refreshHz};
    for (const name of ['raw-red', 'pack-red', 'pack-blue', 'pack-alias', 'author-font', 'reopened']) {
      verifyNativeFrame(name);
      const frame = path.join(directory, 'frames', name);
      const projection = JSON.parse(fs.readFileSync(path.join(frame, 'projection.json'), 'utf8'));
      const uri = fs.readFileSync(path.join(frame, 'uri.txt'), 'utf8');
      const closure = JSON.parse(fs.readFileSync(path.join(frame, 'closure.json'), 'utf8'));
      for (const entry of closure) {const bytes = fs.readFileSync(path.join(frame, entry.file)); assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);}
      let init = fs.readFileSync(path.join(frame, 'native-init.js'), 'utf8');
      init = init.replace(/"refreshHz":\d+(?:\.\d+)?/, () => '"refreshHz":' + refreshHz)
        .replace(/"frameDivisor":\d+/, () => '"frameDivisor":' + Math.ceil(refreshHz / projection.target.budgetFps));
      const page = await browser.newPage({viewport: {width: projection.target.width, height: projection.target.height}});
      const errors = [], requests = new Map();
      page.on('pageerror', error => errors.push(error.message)); page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
      await page.addInitScript(init + '\nwindow.nativeEvents=[];window.ipc={postMessage:message=>nativeEvents.push(message)};');
      await page.route('https://**.wallpaper.invalid/**', route => {
        const url = route.request().url();
        if (url === uri) return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(projection)});
        const entry = closure.find(entry => entry.url === url);
        if (!entry) return route.fulfill({status: 404, body: ''});
        requests.set(url, (requests.get(url) || 0) + 1);
        return route.fulfill({status: 200, contentType: entry.mime, headers: {'access-control-allow-origin': '*'}, body: fs.readFileSync(path.join(frame, entry.file))});
      });
      await page.route('http://hertz.localhost/', route => route.fulfill({status: 200, contentType: 'text/html', body: html}));
      await page.goto('http://hertz.localhost/');
      assert.equal(await page.evaluate(async uri => {hertzWallpaper.applyConfig({source: 'fixed', audioInput: {kind: 'none'}, motion: 1, quality: 'low'});
        const pending = hertzWallpaper.applyComposition(uri); hertzWallpaper.start(15); return await pending;}, uri), true);
      await page.waitForFunction(() => hertzWallpaper.debug().draws >= 3 && hertzWallpaper.debug().stats?.sceneStats?.ready);
      const samples = await page.evaluate(() => {
        const canvas = document.querySelector('#host canvas'), gl = canvas.getContext('webgl2');
        const pixel = (x, y) => {const bytes = new Uint8Array(4); gl.readPixels(Math.floor(canvas.width * x), Math.floor(canvas.height * (1 - y)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes); return [...bytes];};
        return {corner: pixel(.1, .1), overlay: pixel(.45, .5), debug: hertzWallpaper.debug(), budget: HertzGlBudget.stats(), fontFaces: [...document.fonts].length};
      });
      assert.equal(samples.budget.contexts, 1); assert.equal(samples.budget.error, null); assert.equal(samples.fontFaces, 0); assert.deepEqual(errors, []);
      if (['raw-red', 'pack-red', 'pack-alias'].includes(name)) assert(samples.corner[0] > 245 && samples.corner[1] < 8 && samples.corner[2] < 8, 'opaque SVG red survives the fixed PNG and final color conversion');
      if (name === 'pack-blue') {
        assert(samples.corner[0] < 8 && samples.corner[1] < 8 && samples.corner[2] > 245, 'final public blue selection appears');
        assert(Math.abs(samples.overlay[0] - 137) < 12 && samples.overlay[1] < 8 && Math.abs(samples.overlay[2] - 225) < 12, 'nested 25% SVG alpha blends once in linear light');
      }
      for (const count of requests.values()) assert.equal(count, 1, 'each fixed pooled representation loads once');
      await page.evaluate(() => hertzWallpaper.reveal()); await page.screenshot({path: path.join(output, name + '.png')});
      await page.evaluate(() => hertzWallpaper.stop()); const paused = await page.evaluate(() => hertzWallpaper.debug());
      await page.waitForTimeout(100); assert.equal((await page.evaluate(() => hertzWallpaper.debug())).draws, paused.draws);
      await page.evaluate(() => hertzWallpaper.unmount());
      await page.waitForFunction(() => HertzGlBudget.stats().contexts === 0);
      const retired = await page.evaluate(() => HertzGlBudget.stats()); assert.equal(retired.error, null);
      evidence.frames.push({name, projectionSha256: hash(fs.readFileSync(path.join(frame, 'projection.json'))), samples, requests: Object.fromEntries(requests), retired});
      await page.close();
    }
    mark('actual native PNGs preserve final slots, aliases, nested alpha, one load and one context; each page drains');
    const poolPage = await browser.newPage();
    const requirement = original.requirements.find(requirement => requirement.logicalKind === 'vector' && requirement.assetId === 'red' && requirement.width > 4);
    assert(requirement, 'actual full-size SVG representation is available for loader lifetime checks');
    const alternate = original.requirements.find(candidate => candidate.logicalKind === 'vector' && candidate.assetId === requirement.assetId
      && candidate.identity.contentKey !== requirement.identity.contentKey);
    assert(alternate, 'the same SVG source has an actual separately planned particle representation');
    assert.notEqual(alternate.identity.decodeOptions.svgCanonicalOptions, requirement.identity.decodeOptions.svgCanonicalOptions);
    const poolFrame = path.join(directory, 'frames/pack-red');
    const poolClosure = JSON.parse(fs.readFileSync(path.join(poolFrame, 'closure.json')));
    const entry = poolClosure.find(entry => entry.url === requirement.url); assert(entry);
    let loads = 0;
    await poolPage.route(requirement.url, route => {loads++; return route.fulfill({status: 200, contentType: 'image/png',
      headers: {'access-control-allow-origin': '*'}, body: fs.readFileSync(path.join(poolFrame, entry.file))});});
    const alternateEntry = poolClosure.find(entry => entry.url === alternate.url); assert(alternateEntry);
    await poolPage.route(alternate.url, route => {loads++; return route.fulfill({status: 200, contentType: 'image/png',
      headers: {'access-control-allow-origin': '*'}, body: fs.readFileSync(path.join(poolFrame, alternateEntry.file))});});
    await poolPage.route('http://hertz.localhost/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') return route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>'});
      const base = pathname.startsWith('/src/') ? path.join(root, 'tools/space-stage/src') : path.join(root, 'tools/space-stage/node_modules/three/build');
      const relative = pathname.startsWith('/src/') ? pathname.slice(5) : pathname.startsWith('/three/') ? pathname.slice(7) : '';
      const filename = path.resolve(base, relative), within = path.relative(base, filename);
      assert(within && !within.startsWith('..') && !path.isAbsolute(within) && filename.endsWith('.js'), 'only fixed runtime modules are served');
      return route.fulfill({status: 200, contentType: 'text/javascript', body: fs.readFileSync(filename)});
    });
    await poolPage.goto('http://hertz.localhost/');
    evidence.poolLifetime = await poolPage.evaluate(async ({requirement, alternate}) => {
      const THREE = await import('/three/three.module.js');
      const {createResourcePool} = await import('/src/resources/pool.js');
      const {createScope} = await import('/src/scope.js');
      const {loadResource} = await import('/src/composition/nodes.js');
      const first = createResourcePool({contextId: 'svg-loader-context-a'}), second = createResourcePool({contextId: 'svg-loader-context-b'});
      const a = createScope(), b = createScope(), c = createScope(), d = createScope(); let releases = 0, loaderCalls = 0;
      const spec = (pool, requested = requirement) => ({load: ({signal, generation}) => {loaderCalls++; return loadResource(THREE, {pool}, requested, signal, generation);},
        releaseValue(value) {releases++; value.release();}});
      const leaseA = a.lease(first.acquire(requirement.identity, {...spec(first), signal: a.signal, generation: 1}));
      const leaseB = b.lease(first.acquire(requirement.identity, {...spec(first), signal: b.signal, generation: 1}));
      const leaseC = c.lease(second.acquire(requirement.identity, {...spec(second), signal: c.signal, generation: 1}));
      const leaseD = d.lease(first.acquire(alternate.identity, {...spec(first, alternate), signal: d.signal, generation: 1}));
      await Promise.all([leaseA.ready, leaseB.ready, leaseC.ready, leaseD.ready]);
      const sharing = {sameWithinContext: leaseA.value === leaseB.value, differentAcrossContexts: leaseA.value !== leaseC.value,
        differentPreparedOptions: leaseA.value !== leaseD.value, alternateWidth: leaseD.value.texture.image.naturalWidth,
        first: first.stats(), second: second.stats()};
      d.dispose();
      a.dispose();
      const bitmap = leaseB.value.texture.image, canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0, 1, 1);
      const survivor = {pixel: [...ctx.getImageData(0, 0, 1, 1).data], releases, first: first.stats()};
      b.dispose(); c.dispose(); first.dispose(); second.dispose();
      return {sharing, survivor, loaderCalls, retired: {releases, first: first.stats(), second: second.stats()}};
    }, {requirement, alternate});
    assert.equal(evidence.poolLifetime.sharing.sameWithinContext, true); assert.equal(evidence.poolLifetime.sharing.differentAcrossContexts, true);
    assert.equal(evidence.poolLifetime.sharing.differentPreparedOptions, true); assert.equal(evidence.poolLifetime.sharing.alternateWidth, alternate.width);
    assert.equal(evidence.poolLifetime.survivor.releases, 1); assert.equal(evidence.poolLifetime.survivor.first.poolLeases, 1);
    assert(evidence.poolLifetime.survivor.pixel[0] > 245 && evidence.poolLifetime.survivor.pixel[2] < 8, 'remaining consumer still reads the real decoded SVG PNG');
    assert.equal(evidence.poolLifetime.retired.releases, 3); assert.equal(evidence.poolLifetime.retired.first.poolEntries, 0);
    assert.equal(evidence.poolLifetime.retired.second.poolEntries, 0); assert.equal(evidence.poolLifetime.loaderCalls, 3, 'same prepared options share; another target and another context each run their own actual PNG loader');
    assert(loads >= 2 && loads <= 3, 'immutable transport may use the browser cache independently of context ownership');
    evidence.poolLifetime.transportRequests = loads;
    await poolPage.close(); mark('original SVG PNG loader and scopes retain a surviving consumer, separate prepared options and context identities, and release exactly once');
  } finally {await browser.close();}
}
main().catch(error => {evidence.errors.push(error.stack); console.error(error.stack); process.exitCode = 1;}).finally(() => {
  try {
    verifyNativeBindings();
    assert.equal(hash(fs.readFileSync(path.join(directory, 'report.json'))), evidence.nativeReportSha256, 'native report changed during browser run');
    for (const frame of evidence.frames) verifyNativeFrame(frame.name);
    for (const [file, digest] of Object.entries(evidence.sourceHashes))
      assert.equal(hash(Buffer.from(read(file))), digest, 'browser source changed during run: ' + file);
    evidence.sourceAfter = true;
  } catch (error) {evidence.errors.push('Final browser binding: ' + error.stack); evidence.sourceAfter = false;}
  evidence.passed = evidence.sourceAfter === true && evidence.errors.length === 0 && evidence.frames.length === 6;
  if (!evidence.passed) process.exitCode = 1;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({output, passed: evidence.passed, checks: evidence.checks.length, errors: evidence.errors}));
});
