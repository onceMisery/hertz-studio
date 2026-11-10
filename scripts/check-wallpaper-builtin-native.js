// SPDX-License-Identifier: MIT
// Real Windows builtin+2D+font+video journey through original native owners.
// Requires a copied debug candidate with wallpaper-media-probe and its receipt.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { buildZip } = require('./check-wallpaper-media-native');
const nativeRequest = require('./desktop-native-management-client');
const {loadCompositionFontFixture}=require('./composition-font-fixture');
const windowInspector=require('./native-wallpaper-windows');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.HERTZ_BUILTIN_NATIVE_OUTPUT || path.join(root, 'output/playwright/builtin-native-' + Date.now()));
const binary = path.resolve(process.env.HERTZ_DESKTOP_BIN || '');
const configFile = path.join(output, 'config.json');
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const port = Number(process.env.DESKTOP_CDP_PORT || 19892);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [], evidence = {};
let child, browser, settings, seq = 0, spawnError, natural=false;
const stored = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const pages = () => browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed());
const status = () => nativeRequest(pipe, { command: 'status' });
const draftRef = draft => ({ draftId: draft.draftId, draftRevision: draft.draftRevision });
const mark = label => { checks.push(label); console.log('PASS ' + label); };
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
async function api(command, payload = {}, expectedRevision, allowFailure=false) {
  const receipt = await settings.evaluate(async input => {
    try { return await hertzWallpaperSettings.requestManagement(input.command, input.payload, input.requestId, input.expectedRevision); }
    catch (error) { return error.receipt || { ok: false, error: { code: error.code, message: error.message } }; }
  }, { command, payload, expectedRevision, requestId: 'composition-native-' + (++seq) });
  if(!allowFailure)assert.equal(receipt.ok, true, command + ': ' + JSON.stringify(receipt));
  return allowFailure?receipt:receipt.result;
}
async function commit(wallpaper) {
  const baseRevision = stored().revision;
  let draft = await api('wallpaper.draft.create', { kind: 'settings' });
  draft = await api('wallpaper.draft.update', { ...draftRef(draft), operations: [{ kind: 'replaceWallpaper', wallpaper }] });
  const operation = await api('wallpaper.apply', draftRef(draft), draft.baseRevision);
  assert.equal(operation.saved, true); assert.equal(operation.state, 'committed');
  assert.equal(operation.configRevision, baseRevision + 1); assert.equal(stored().revision, baseRevision + 1);
  return operation;
}
async function running(selection, expectedRevision = stored().revision) {
  return until(async () => {
    const state = await status(), targets = state.wallpaper.targets;
    evidence.lastNativeState = state.wallpaper;
    assert.ok(Array.isArray(targets));
    if (targets.some(target => target.applyError)) throw new Error(JSON.stringify(targets));
    const target = targets.find(target => target.groupId === 'native-composition');
    return target?.firstFrameReady && target.visible && target.session?.frameKind === 'gl'
      && isDeepStrictEqual(target.appliedSelection, selection)
      && target.appliedRevision === expectedRevision && target.desiredRevision === expectedRevision
      && !target.handoff && !target.candidateLoading && !target.selectionPreparing
      && state.wallpaper.retiringControllers === 0 && state.wallpaper.retirements.length === 0 && state;
  }, 'real native composition first frame');
}
async function renderer(state) {
  const id = state.wallpaper.targets.find(target => target.groupId === 'native-composition').session.binding.sessionId;
  return until(async () => {
    for (const page of pages().filter(page => page.url().includes('/wallpaper.html'))) {
      if (await page.evaluate(id => window.hertzWallpaper?.debug().session?.sessionId === id, id).catch(() => false)) return page;
    }
    return null;
  }, 'owned renderer bound to native session');
}
function inspectWindows() {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(output, 'windows.ps1'), '-OwnerPid', String(child.pid)],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }));
}
async function start(reopen=false) {
  assert.equal(process.platform, 'win32');
  assert.ok(process.env.HERTZ_DESKTOP_BIN && fs.existsSync(binary), 'Set a copied candidate HERTZ_DESKTOP_BIN');
  assert.ok(process.env.HERTZ_DESKTOP_BUILD_RECEIPT, 'Set its HERTZ_DESKTOP_BUILD_RECEIPT');
  const receipt = JSON.parse(fs.readFileSync(process.env.HERTZ_DESKTOP_BUILD_RECEIPT, 'utf8'));
  assert.equal(receipt.sourceBuildBinding, true);
  assert.equal(hash(fs.readFileSync(binary)), receipt.binarySha256);
  const inputs = receipt.sourceHashes || receipt.buildInputs;
  assert.ok(inputs && Object.keys(inputs).length > 0);
  for (const [file, sha] of Object.entries(inputs)) assert.equal(hash(fs.readFileSync(path.join(root, file))), sha, 'build input changed: ' + file);
  evidence.binary = { path: binary, sha256: receipt.binarySha256, sourceCount: Object.keys(inputs).length };
  try { await nativeRequest(pipe, { command: 'status' }); throw new Error('Existing desktop host; leave it untouched.'); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  try { const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1000) }); assert.equal(response.ok, false, 'CDP port belongs to another browser'); }
  catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
  fs.mkdirSync(path.join(output, 'probe-inputs'), { recursive: true });
  // Fixtures use the published canonical defaults, as native Config does.
  // Exact selection comparison still rejects a different work or revision.
  const coast = require('../crates/hertz-wallpaper/contracts/catalog.json').scenes.find(scene => scene.id === 'coast');
  assert.ok(coast);
  const coastParams = Object.fromEntries(Object.entries(coast.params).map(([key, definition]) => [key, definition.default]));
  const wallpaper = { enabled: true, audioInput: { kind: 'none' }, batteryPolicy: 'pause', pauseOnFullscreen: false,
    pauseOnMaximized: false, applicationRules: [], groups: [{ id: 'native-composition', mode: 'single', displays: [{ kind: 'primary' }],
      selection: { kind: 'builtin', sceneId: 'coast', stateVersion: coast.stateVersion, params: coastParams },
      presentation: { fps: 30, quality: 'low', brightness: 1, motion: 1, fit: 'contain', pointer: false }, properties: {} }] };
  const lyrics = { enabled: false, locked: true, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32,
    fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 1,
    opacity: 1, width: 550, anchorX: .5, anchorY: .5, monitor: null };
  if(!reopen)fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 5, revision: 1, launchAtLogin: false, activeProfile: null,
    profiles: [], unboundDomain: { wallpaper, lyrics }, lastCommit: null }));
  fs.writeFileSync(path.join(output,'windows.ps1'),windowInspector,'utf8');
  const log = fs.openSync(path.join(output, 'host.log'), 'a');
  child = spawn(binary, ['--settings'], { cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env,
    HERTZ_DESKTOP_CONFIG_DIR: output, WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } });
  fs.closeSync(log); child.on('error', error => { spawnError = error; }); evidence.pid = child.pid;
  evidence.launches ||= [];evidence.launches.push({pid:child.pid,reopen});
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch { return false; } }, 'owned WebView2 startup');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  for (const context of browser.contexts()) { const watch = page => page.on('pageerror', error => errors.push({ url: page.url(), message: error.message })); context.on('page', watch); context.pages().forEach(watch); }
  settings = await until(() => pages().find(page => page.url().includes('/settings.html')), 'owned settings');
  await settings.waitForSelector('#enabled:enabled');
  return wallpaper;
}
async function main() {
  const wallpaper = await start();
  let state = await running(wallpaper.groups[0].selection);
  const initialPage = await renderer(state);
  const png = Buffer.from(await settings.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d'); context.fillStyle = '#7d3d25'; context.fillRect(0, 0, 320, 180);
    context.fillStyle = '#dbae5c'; context.fillRect(20, 20, 80, 80); return canvas.toDataURL().split(',')[1];
  }), 'base64');
  const movie = fs.readFileSync(path.join(root, 'scripts/fixtures/wallpaper-vp8.webm'));
  const font=loadCompositionFontFixture();
  const node = (id, type, assets, properties) => ({ id, type, stateVersion: 1, assets, properties });
  const document = { documentVersion: 1, canvas: { width: 320, height: 180, colorSpace: 'srgb', background: '#000000' },
    nodes: [node('scene','builtinScene',{}, {sceneId:'spectrum-towers',stateVersion:1,params:{director:true,cue:'bridge',dust:.35,discRing:true}}),
      node('background', 'image', { asset: 'background' }, { x: 40, y: 40, width: 80, height: 60,opacity:.5 }),
      node('movie-left', 'video', { asset: 'movie' }, { x: 112, y: 90, width: 96, height: 72, loopStartMs: 0, loopEndMs: 1000 }),
      node('caption','text',{fontAsset:'font'},{x:0,y:0,width:320,height:60,anchorX:0,anchorY:0,text:'Hertz',fontSize:32,color:'#ffffff'}),
      node('particles','particles',{}, {x:240,y:100,width:60,height:60,count:24,seed:19,lifetimeSeconds:2,speed:24,spread:50})],
    timeline: { durationSeconds: 4, loop: true, tracks: [] }, bindings: [], effects: [] };
  const workId = crypto.randomUUID(), entries = [['composition.json', Buffer.from(JSON.stringify(document)), 'application/json'],
    ['assets/background.png', png, 'image/png'], ['assets/movie.webm', movie, 'video/webm'],['assets/font.ttf',font.bytes,font.mime],
    ...font.packageFiles.map(file=>[file.file,file.bytes,file.mime])];
  const manifest = { formatVersion: 1, workId, version: 1, title: 'Windows composition fixture', description: 'Same-domain media, fitting and native retirement',
    content: { kind: 'composition', document: 'composition.json' },
    assets: [{ id: 'background', kind: 'image', source: 'assets/background.png', variants: [] }, { id: 'movie', kind: 'video', source: 'assets/movie.webm', variants: [] },
      {id:'font',kind:'font',source:'assets/font.ttf',variants:[]}],
    files: entries.map(([path, bytes, mime]) => ({ path, bytes: bytes.length, sha256: hash(bytes), mime })),
    properties:[{id:'caption-color',label:'文字颜色',type:'color',default:'#ffffff',constraints:{},target:{kind:'node',nodeId:'caption',property:'color',component:null}}],
    permissions: { audioSpectrum: false, pointer: false }, license: { code: 'none',...font.manifestLicense } };
  const bytes = buildZip([['manifest.json', Buffer.from(JSON.stringify(manifest))], ...entries.map(([file, bytes]) => [file, bytes])]);
  const input = path.join(output, 'probe-inputs/composition.hwpkg'); fs.writeFileSync(input, bytes);
  await initialPage.evaluate(() => window.ipc.postMessage('wallpaper_probe_import ' + JSON.stringify({ nonce: 1, action: 'begin', name: 'composition' })));
  await initialPage.waitForFunction(() => !!window.__nativeImportProbes?.[1], null, { timeout: 60000 });
  const imported = await initialPage.evaluate(() => window.__nativeImportProbes[1]); evidence.import = imported;
  assert.equal(imported.state, 'done', JSON.stringify(imported)); assert.equal(imported.packageHash, hash(bytes));
  assert.equal(imported.prepareTasks, 0); assert.equal(imported.prepareCpuBytes, 0);
  const selection = { kind: 'package', workKey: 'local-' + workId, packageHash: imported.packageHash };
  const detail = await api('wallpaper.library.get', { workKey: selection.workKey });
  assert.ok(detail.versions.some(version => version.packageHash === selection.packageHash)); fs.unlinkSync(input);
  mark('actual composition package imports through native preparation and original installed library');
  wallpaper.groups[0].selection = selection;
  wallpaper.groups[0].presentation.quality='high';
  const revisionBeforePreview=stored().revision;
  let previewDraft=await api('wallpaper.draft.create',{kind:'settings'});
  previewDraft=await api('wallpaper.draft.update',{...draftRef(previewDraft),operations:[{kind:'replaceWallpaper',wallpaper}]});
  const lease=await api('wallpaper.preview.acquire',{...draftRef(previewDraft),groupId:'native-composition'});
  const preview=await until(async()=>{const value=(await status()).wallpaper.mediaPreview;
    if(value?.error)throw new Error(JSON.stringify(value));return value?.firstFrameReady&&value?.binding&&value;},'native builtin preview first frame');
  const previewPage=await until(async()=>{for(const page of pages())if(await page.evaluate(id=>hertzWallpaper?.debug().session?.sessionId===id,preview.binding.sessionId).catch(()=>false))return page;return null;},'native preview page');
  const previewDebug=await previewPage.evaluate(()=>hertzWallpaper.debug());
  const previewProjection=await previewPage.evaluate(async()=>await (await fetch(__hertzWallpaperGlAllocation.compositionUrl)).json());
  assert.equal(previewProjection.builtinTarget.actualQuality,'low');assert.equal(previewProjection.builtinTarget.requestedQuality,'high');
  assert.equal(previewProjection.builtinTarget.targetFacts.requestedFps,30);assert(previewProjection.target.budgetFps<=15);
  assert.equal(previewDebug.stats.sceneStats.linearOutputPasses,1);assert.equal(previewDebug.stats.sceneStats.videoClocks.length,1);
  assert.equal(stored().revision,revisionBeforePreview);await previewPage.screenshot({path:path.join(output,'preview.png')});
  evidence.preview={lease,preview,debug:previewDebug,projection:previewProjection};
  await api('wallpaper.preview.release',{leaseId:lease.leaseId});
  await until(async()=>!(await status()).wallpaper.previewActive&&previewPage.isClosed(),'native preview release');
  await api('wallpaper.draft.discard',draftRef(previewDraft));
  mark('independent native preview keeps requested high/30fps and admits low/15fps without committing settings');
  let previousSession = state.wallpaper.targets.find(target => target.groupId === 'native-composition').session.binding.sessionId;
  for (const fit of ['contain', 'cover', 'stretch']) {
    wallpaper.groups[0].presentation.fit = fit; const operation = await commit(wallpaper);
    state = await running(selection, operation.configRevision); const page = await renderer(state);
    await page.waitForFunction(() => hertzWallpaper.debug().draws >= 3 && hertzWallpaper.debug().stats?.sceneStats?.ready);
    const debug = await page.evaluate(() => hertzWallpaper.debug());
    assert.equal(debug.backend, 'space'); assert.equal(debug.scene, 'composition'); assert.equal(debug.error, null);
    assert.equal(debug.glBudget.contexts, 1); assert.equal(debug.glBudget.error, null);
    assert.notEqual(debug.session.sessionId, previousSession, 'changed target plan must not borrow the old session first frame');
    previousSession = debug.session.sessionId;
    const projection = await page.evaluate(async () => {
      const response = await fetch(window.__hertzWallpaperGlAllocation.compositionUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error('Current native projection unavailable');
      return response.json();
    });
    assert.equal(projection.sessionId, debug.session.sessionId); assert.equal(projection.generation, debug.session.generation);
    assert.equal(projection.target.fit, fit, 'exact current native target must use the just-committed fit');
    assert.equal(debug.stats.sceneStats.nodes, 5); assert.equal(debug.stats.sceneStats.videoClocks.length, 1, 'one real video decoder');
    assert.equal(debug.stats.sceneStats.builtin.sceneId,'spectrum-towers');assert.equal(projection.builtinTarget.requestedQuality,'high');
    assert.equal(projection.builtinTarget.actualQuality,'low');assert.equal(projection.builtinTarget.finalParams.cue,'bridge');
    assert.equal(debug.stats.sceneStats.builtin.depthBytes,projection.target.width*projection.target.height*4);
    assert.equal(projection.pageLimits.renderTargetDeclaredBytes,projection.target.width*projection.target.height*20);
    assert.equal(await page.evaluate(()=>document.fonts.size),1);
    assert.equal(debug.stats.sceneStats.linearOutputPasses, 1); assert.equal(state.wallpaper.budget.decoderSlots, 1);
    const windows = inspectWindows(); assert.equal(windows.length, 1);
    assert.equal(windows[0].pid, child.pid); assert.equal(windows[0].parentClass, 'WorkerW'); assert.equal(windows[0].visible, true);
    await page.screenshot({ path: path.join(output, 'native-' + fit + '.png') });
    evidence[fit] = { operation, status: state, debug, projection, windows };
    mark(fit + ': real native first frame, one WorkerW surface/context and one shared video clock');
  }
  const page = await renderer(state);
  await page.evaluate(() => hertzWallpaper.stop());
  await delay(200); const paused = await page.evaluate(() => hertzWallpaper.debug()); await delay(350);
  const still = await page.evaluate(() => hertzWallpaper.debug());
  assert.equal(paused.stats.sceneStats.videoClocks.length, 1);
  assert(paused.stats.sceneStats.videoClocks.every(video => video.paused && !video.seeking && video.seekReady));
  assert.equal(still.draws, paused.draws); assert.equal(still.sceneTime, paused.sceneTime);
  assert.deepEqual(still.stats.sceneStats.videoClocks, paused.stats.sceneStats.videoClocks);
  await page.evaluate(() => hertzWallpaper.start(15));
  await page.waitForFunction(draws => hertzWallpaper.debug().draws > draws, paused.draws);
  evidence.pause = { paused, still, resumed: await page.evaluate(() => hertzWallpaper.debug()) };
  mark('original page stop freezes draws, canonical time and shared media; restart resumes');
  const colorInput=settings.locator('input[type="text"][data-property-input="caption-color"]');await colorInput.waitFor();
  const resetRevision=stored().revision;await colorInput.fill('red');assert.equal(await settings.locator('#apply').isDisabled(),true);
  await settings.locator('[data-property-reset="caption-color"]').click();
  assert.equal(await settings.locator('#settings-state').getAttribute('data-dirty'),'false');
  assert.equal(await settings.locator('#apply').isDisabled(),true);assert.equal(await settings.locator('#discard').isDisabled(),true);
  assert.match(await settings.locator('#status').textContent(),/设置已保存/);assert.doesNotMatch(await settings.locator('#status').textContent(),/草稿尚未应用/);
  const runtimeTarget=evidence.stretch.status.wallpaper.targets.find(target=>target.groupId==='native-composition');
  await settings.waitForFunction(({quality,fps})=>{const text=document.querySelector('#wallpaper-detail').textContent;
    return text.includes('画质 '+quality)&&text.includes('帧率上限 '+fps+' fps');},
    {quality:runtimeTarget.glLimits.quality,fps:runtimeTarget.diagnostics.fps.effectiveBudget});
  assert.match(await settings.locator('#wallpaper-detail').textContent(),/设置 30 fps.*high/);
  assert.equal(stored().revision,resetRevision);await settings.screenshot({path:path.join(output,'color-reset-saved-native.png'),fullPage:true});
  evidence.reset={revision:resetRevision,header:await settings.locator('#settings-state').textContent(),footer:await settings.locator('#status').textContent(),runtimeDetail:await settings.locator('#wallpaper-detail').textContent()};
  mark('actual new native candidate resets invalid color consistently and labels admitted quality/FPS separately from saved settings without committing');
  const configBeforeReopen=hash(fs.readFileSync(configFile));await naturalExit();await delay(500);await start(true);
  assert.equal(hash(fs.readFileSync(configFile)),configBeforeReopen);state=await running(selection);
  const reopened=await renderer(state);const reopenedDebug=await reopened.evaluate(()=>hertzWallpaper.debug());
  assert.equal(reopenedDebug.stats.sceneStats.builtin.sceneId,'spectrum-towers');evidence.reopened={state,debug:reopenedDebug};
  mark('natural exit and fresh owned process reopen the immutable builtin/font/video composition');
  const invalid=structuredClone(wallpaper);invalid.groups[0].properties={};
  // A public override exercises final values through the original management
  // validation; a separate unsupported package exercises source predicates.
  const badDocument=structuredClone(document);badDocument.nodes[0].properties.params.ripples=1;
  const badWork=crypto.randomUUID(),badEntries=entries.map(entry=>entry[0]==='composition.json'?[entry[0],Buffer.from(JSON.stringify(badDocument)),entry[2]]:entry);
  const badManifest={...manifest,workId:badWork,files:badEntries.map(([path,bytes,mime])=>({path,bytes:bytes.length,sha256:hash(bytes),mime}))};
  const badBytes=buildZip([['manifest.json',Buffer.from(JSON.stringify(badManifest))],...badEntries.map(([path,bytes])=>[path,bytes])]);
  fs.writeFileSync(path.join(output,'probe-inputs/unsupported.hwpkg'),badBytes);
  await reopened.evaluate(()=>window.ipc.postMessage('wallpaper_probe_import '+JSON.stringify({nonce:2,action:'begin',name:'unsupported'})));
  await reopened.waitForFunction(()=>!!window.__nativeImportProbes?.[2],null,{timeout:60000});
  const badImport=await reopened.evaluate(()=>window.__nativeImportProbes[2]);assert.equal(badImport.state,'done');
  invalid.groups[0].selection={kind:'package',workKey:'local-'+badWork,packageHash:hash(badBytes)};
  const beforeReject=hash(fs.readFileSync(configFile));let badDraft=await api('wallpaper.draft.create',{kind:'settings'});
  badDraft=await api('wallpaper.draft.update',{...draftRef(badDraft),operations:[{kind:'replaceWallpaper',wallpaper:invalid}]});
  const rejection=await api('wallpaper.apply',draftRef(badDraft),badDraft.baseRevision,true);
  assert.equal(rejection.ok,false);assert.match(JSON.stringify(rejection),/ripples|builtin/);assert.equal(hash(fs.readFileSync(configFile)),beforeReject);
  await running(selection);evidence.rejection=rejection;await api('wallpaper.draft.discard',draftRef(badDraft));
  mark('nonzero source predicate is rejected while committed selection and current successful surface remain');
  wallpaper.enabled = false; await commit(wallpaper);
  evidence.retired = await until(async () => {
    const current = await status(), budget = current.wallpaper.budget;
    const keys = ['targets', 'contexts', 'decoderSlots', 'cpuBytes', 'gpuBytes', 'prepareTasks', 'prepareCpuBytes', 'releasePending',
      'sessionReservations', 'resourceAllocations', 'resourceReleasePending', 'textureUploadBytesPerSecond'];
    return current.wallpaper.retiringControllers === 0 && current.wallpaper.retirements.length === 0 && keys.every(key => budget[key] === 0) && current;
  }, 'all native composition resources drain');
  await until(() => !pages().some(page => page.url().includes('/wallpaper.html')), 'owned composition WebView closes');
  assert.deepEqual(inspectWindows(), []); assert.deepEqual(errors, []);
  mark('disable closes real composition HWND/WebView and drains native decoder, CPU/GPU and upload-rate allocations');
  await naturalExit();
  const receipt=JSON.parse(fs.readFileSync(process.env.HERTZ_DESKTOP_BUILD_RECEIPT));
  for(const [file,sha]of Object.entries(receipt.sourceHashes))assert.equal(hash(fs.readFileSync(path.join(root,file))),sha,'source changed during native journey: '+file);
  evidence.sourceAfter=true;
}
async function naturalExit(){
  assert(child&&child.exitCode===null&&child.signalCode===null);
  const quit=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(output,'windows.ps1'),
    '-OwnerPid',String(child.pid),'-Mode','Quit','-PipeName',pipe.slice('\\\\.\\pipe\\'.length)],{encoding:'utf8',windowsHide:true,timeout:15000}));
  assert.equal(quit.serverPid,child.pid);
  if(child.exitCode===null)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('owned natural exit timeout')),20000);
    child.once('exit',()=>{clearTimeout(timer);resolve();});});
  assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);natural=true;
  evidence.launches.at(-1).exit={code:child.exitCode,signal:child.signalCode,quit};
  await browser.close();browser=settings=null;
}
main().catch(async error => {
  errors.push(error.stack); process.exitCode = 1;
  if (browser) evidence.pageDiagnostics = await Promise.all(pages().map(async page => ({ url: page.url(),
    state: await page.evaluate(() => window.hertzWallpaper?.debug()).catch(error => ({ error: error.message })) })));
  if (settings) await settings.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill(); } catch (error) { errors.push('Owned host termination failed: ' + error.message); }
    const end = Date.now() + 5000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < end) await delay(100);
    if (child.exitCode === null && child.signalCode === null) errors.push('Owned host exit was not confirmed within five seconds');
  }
  if (errors.length) process.exitCode = 1;
  evidence.exit = child ? { code: child.exitCode, signal: child.signalCode, natural, cleanup: natural?'owned same-connection natural quit':'owned failure cleanup' } : null;
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: errors.length === 0, checks, errors, evidence,
    limits: ['Current Windows debug candidate and existing probe import only', 'Controlled original page stop; OS policy, monitor/refresh changes, pressure and long-duration qualification separate',
      'Native/editor seek, other sources, GLB/KTX2/effects/timeline/binding/editor and additional devices remain open'] }, null, 2));
  console.log(JSON.stringify({ output, checks: checks.length, errors }));
});
