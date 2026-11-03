// SPDX-License-Identifier: MIT
// Ordinary WebView2 library controls, against a private copy of an existing media fixture.
// node scripts/check-wallpaper-library-native.js <presentation fixture directory>
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const requestManagement = require('./desktop-native-management-client');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/wallpaper-library-native-' + Date.now());
const binary = path.join(root, 'target/debug/hertz-desktop.exe');
const configFile = path.join(output, 'config.json');
const port = Number(process.env.DESKTOP_CDP_PORT || 19438);
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const checks = [], errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stored = () => JSON.parse(fs.readFileSync(configFile));
let child, browser, settings, sequence = 0, launches = 0, fixture;

async function until(check, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(80); }
  throw new Error(label);
}
async function native(request) {
  for (let attempt = 0;; attempt++) {
    try { return await requestManagement(pipe, request); }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) || attempt >= 20) throw error; await delay(50); }
  }
}
const status = () => native({ command: 'status' });
async function formal(command, payload = {}) {
  return native({ protocol: 2, requestId: 'library-native-' + (++sequence), command, payload });
}
const pages = () => browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed());
const workRow = kind => settings.locator('#library-works > li').filter({ has: settings.getByText('Presentation ' + kind, { exact: true }) });
const originalHash = kind => hash(fs.readFileSync(path.join(output, 'packages', fixture[kind].packageHash, 'original.hwpkg')));
async function start() {
  // A killed WebView2 subprocess may briefly retain its old endpoint during teardown.
  const cdpPort = port + launches++;
  child = spawn(binary, ['--settings'], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
    ...process.env, HERTZ_DESKTOP_CONFIG_DIR: output, WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + cdpPort,
  } });
  await until(async () => { if (child.exitCode !== null) throw new Error('owned host exited ' + child.exitCode); try { return (await fetch('http://127.0.0.1:' + cdpPort + '/json/version')).ok; } catch { return false; } }, 'CDP startup');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdpPort);
  settings = await until(() => pages().find(page => page.url().includes('/settings.html')), 'settings page');
  settings.on('pageerror', error => errors.push(error.message));
  await settings.waitForSelector('#enabled:enabled');
  await settings.evaluate(() => {
    window.libraryReceipts = [];
    const request = hertzWallpaperSettings.requestManagement;
    hertzWallpaperSettings.requestManagement = async (command, ...args) => {
      try { const receipt = await request(command, ...args); libraryReceipts.push({ command, ...structuredClone(receipt) }); return receipt; }
      catch (error) { libraryReceipts.push({ command, ...structuredClone(error.receipt) }); throw error; }
    };
  });
  await settings.locator('#local-library > summary').click();
  await settings.locator('#library-refresh:enabled').waitFor();
  await until(async () => (await status()).wallpaper.firstFrameReady, 'native builtin ready');
}
async function stop() {
  if (child && child.exitCode === null) { child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned host exit', 5000); }
  if (browser) await browser.close().catch(() => {});
  child = browser = settings = null;
}
async function detail(kind) {
  const row = workRow(kind);
  if (await row.getByRole('button', { name: '查看版本', exact: true }).count()) await row.getByRole('button', { name: '查看版本', exact: true }).click();
  await row.getByRole('button', { name: '选择此版本', exact: true }).waitFor();
  return row;
}
async function deleteClick(kind, version, accept = true) {
  const row = version ? await detail(kind) : workRow(kind);
  const command = version ? 'wallpaper.library.deleteVersion' : 'wallpaper.library.deleteWork';
  const count = await settings.evaluate(() => libraryReceipts.length);
  const dialog = settings.waitForEvent('dialog');
  const clicking = row.getByRole('button', { name: version ? '删除版本' : '删除作品', exact: true }).click();
  const confirmation = await dialog;
  assert.equal(confirmation.type(), 'confirm');
  assert.match(confirmation.message(), new RegExp('Presentation ' + kind));
  if (accept) await confirmation.accept(); else await confirmation.dismiss();
  await clicking;
  if (!accept) {
    await delay(200);
    assert.equal(await settings.evaluate(({ count, command }) => libraryReceipts.slice(count).filter(receipt => receipt.command === command).length, { count, command }), 0);
    return null;
  }
  return until(() => settings.evaluate(({ count, command }) => libraryReceipts.slice(count).find(receipt => receipt.command === command), { count, command }), 'library delete receipt');
}
async function refused(kind, version, label) {
  const before = fs.readFileSync(configFile, 'utf8'), bytes = originalHash(kind);
  const receipt = await deleteClick(kind, version);
  assert.equal(receipt.ok, false, label + ': ' + JSON.stringify(receipt));
  assert.equal(receipt.error.code, 'asset_in_use', label);
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  assert.equal(originalHash(kind), bytes);
  const record = await formal('wallpaper.library.get', { workKey: fixture[kind].workKey });
  assert.equal(record.ok, true); assert.equal(record.result.versions[0].state, 'installed');
  checks.push({ case: label, receipt });
}
function seed() {
  const source = path.resolve(process.argv[2] || '');
  assert.ok(source.startsWith(path.join(root, 'output') + path.sep), 'use an existing test fixture inside output');
  fixture = JSON.parse(fs.readFileSync(path.join(source, 'fixture.json')));
  assert.ok(fixture.image && fixture.video);
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(path.join(source, 'packages'), path.join(output, 'packages'), { recursive: true });
  // SQLite backup includes a source WAL and never modifies the source database.
  execFileSync(process.env.PYTHON || 'python', ['-c', 'import sqlite3,sys; src=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); dst=sqlite3.connect(sys.argv[2]); src.backup(dst); dst.close(); src.close()', path.join(source, 'wallpaper.db'), path.join(output, 'wallpaper.db')], { windowsHide: true });
  const original = JSON.parse(fs.readFileSync(path.join(source, 'config.json')));
  const domain = structuredClone(original.unboundDomain || original.profiles[0]);
  delete domain.profile;
  domain.lyrics.enabled = false; domain.mini = { ...(domain.mini || {}), reopen: false };
  domain.wallpaper.enabled = true; domain.wallpaper.audioInput = { kind: 'none' };
  domain.wallpaper.groups[0].selection = { kind: 'builtin', sceneId: 'zodiac', stateVersion: 1, params: {} };
  const profiles = ['image', 'video'].map(kind => {
    const dormant = structuredClone(domain);
    dormant.wallpaper.enabled = false;
    dormant.wallpaper.groups[0].selection = { kind: 'package', ...fixture[kind] };
    return { ...dormant, profile: { kind: 'standalone', dataDir: path.join(output, 'dormant-' + kind), edition: 'full' } };
  });
  fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 5, revision: 1, launchAtLogin: false, activeProfile: null, profiles, unboundDomain: domain, lastCommit: null }));
  fs.writeFileSync(path.join(output, 'fixture-origin.json'), JSON.stringify({ source, fixture, originalSourcesPresent: false }, null, 2));
}
async function run() {
  seed(); await start();
  await refused('image', false, 'dormant profile protects disabled image selection');
  await refused('video', true, 'dormant profile protects fixed video version');
  await stop();
  const unbound = stored(), baseline = structuredClone(unbound.unboundDomain);
  unbound.activeProfile = unbound.profiles[0].profile;
  unbound.profiles[0].wallpaper = structuredClone(baseline.wallpaper);
  unbound.unboundDomain.wallpaper.enabled = false;
  unbound.unboundDomain.wallpaper.groups[0].selection = { kind: 'package', ...fixture.image };
  fs.writeFileSync(configFile, JSON.stringify(unbound));
  await start();
  await refused('image', true, 'saved unbound domain remains protected while a profile is active');
  await stop();
  // A separate fixture phase removes dormant references before testing live UI lifetimes.
  const config = stored(); config.profiles = []; config.activeProfile = null; config.unboundDomain = baseline;
  fs.writeFileSync(configFile, JSON.stringify(config));
  await start();
  await workRow('image').getByRole('button', { name: '☆ 收藏', exact: true }).click();
  await workRow('image').getByRole('button', { name: '★ 已收藏', exact: true }).waitFor();
  await settings.locator('#library-favorites-only').check();
  await until(async () => await settings.locator('#library-works > li').count() === 1, 'favorites filter');
  await settings.screenshot({ path: path.join(output, 'favorite.png') });
  await stop(); await start();
  await workRow('image').getByRole('button', { name: '★ 已收藏', exact: true }).waitFor();
  await settings.locator('#library-favorites-only').check();
  await until(async () => await settings.locator('#library-works > li').count() === 1, 'persisted favorite');
  await workRow('image').getByRole('button', { name: '★ 已收藏', exact: true }).click();
  await settings.locator('#library-empty').waitFor({ state: 'visible' });
  await settings.locator('#library-favorites-only').uncheck();
  await until(async () => await settings.locator('#library-works > li').count() === 2, 'restore unfiltered list');
  checks.push({ case: 'favorite persists across restart and removal updates filtered view' });
  await deleteClick('image', false, false);
  assert.equal((await formal('wallpaper.library.get', { workKey: fixture.image.workKey })).ok, true);
  assert.equal(originalHash('image'), fixture.image.packageHash);
  checks.push({ case: 'cancel confirmation leaves installed bytes and rows intact' });
  await (await detail('image')).getByRole('button', { name: '选择此版本', exact: true }).click();
  await refused('image', true, 'unapplied version selection protects its native draft');
  const pipeDelete = await formal('wallpaper.library.deleteWork', { workKey: fixture.image.workKey });
  assert.equal(pipeDelete.error?.code, 'asset_in_use', 'another client cannot delete the settings draft');
  await settings.locator('#preview').click();
  await until(async () => (await status()).wallpaper.mediaPreview?.firstFrameReady, 'real image preview');
  await refused('image', false, 'independent preview protects the selected work');
  await settings.screenshot({ path: path.join(output, 'reference-protection.png') });
  await settings.locator('#apply').click();
  await until(async () => { const state = await status(); return state.wallpaper.appliedSelection?.packageHash === fixture.image.packageHash && state.wallpaper.firstFrameReady && !state.wallpaper.previewActive; }, 'image applied');
  await refused('image', true, 'saved active desktop protects exact version');
  await stop(); await start();
  await refused('image', false, 'saved selection remains protected after restart');
  await settings.locator('#scene-source').selectOption('fixed');
  await settings.locator('#scene-fixed').selectOption('zodiac');
  await settings.locator('#apply').click();
  await until(async () => { const state = await status(); return state.wallpaper.appliedSelection?.kind === 'builtin' && state.wallpaper.firstFrameReady && state.wallpaper.retiringControllers === 0; }, 'builtin replaces image and drains old controller');
  const deletedImage = await deleteClick('image', true);
  assert.equal(deletedImage.ok, true, JSON.stringify(deletedImage));
  assert.equal(fs.existsSync(path.join(output, 'packages', fixture.image.packageHash)), false);
  assert.equal(originalHash('video'), fixture.video.packageHash);
  checks.push({ case: 'last unreferenced version removes only its package and work', receipt: deletedImage });
  const deletedVideo = await deleteClick('video', false);
  assert.equal(deletedVideo.ok, true, JSON.stringify(deletedVideo));
  assert.equal(fs.existsSync(path.join(output, 'packages', fixture.video.packageHash)), false);
  await settings.locator('#library-empty').waitFor({ state: 'visible' });
  await stop(); await start();
  const list = await formal('wallpaper.library.list'); assert.deepEqual(list.result.works, []);
  const resources = await formal('wallpaper.status'); assert.equal(resources.result.decoderSlots, 0); assert.equal(resources.result.prepareTasks, 0);
  checks.push({ case: 'work deletion survives recovery without resurrecting rows', receipt: deletedVideo, resources: resources.result });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'library-report.json'), JSON.stringify({ ordinaryBuild: true, binarySha256: hash(fs.readFileSync(binary)), checks, errors, limitations: ['Existing test packages copied through SQLite backup; native file dialog not exercised', 'No OS crash injected during deletion'] }, null, 2));
  console.log('native library checks passed: ' + checks.length + ' groups\n' + output);
}
async function runDeletionCrash() {
  seed();
  const config=stored();config.profiles=[];
  fs.writeFileSync(configFile,JSON.stringify(config));
  const saved=hash(fs.readFileSync(configFile));
  const removed=path.join(output,'packages',fixture.image.packageHash);
  assert.ok(path.resolve(removed).startsWith(path.resolve(output)+path.sep));
  await start();
  const initialized=await formal('wallpaper.library.get',{workKey:fixture.image.workKey});
  assert.equal(initialized.result.versions[0].state,'installed');
  const otherHash=originalHash('video');
  const dbFile=path.join(output,'wallpaper.db');
  // The real delete reaches its filesystem step, then waits for this private SQL writer.
  const locker=spawn(process.env.PYTHON||'python',['-u','-c','import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("BEGIN IMMEDIATE"); print("locked",flush=True); sys.stdin.read(); db.rollback(); db.close()',dbFile],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let lockOutput='',lockError='';
  locker.stdout.on('data',data=>{lockOutput+=data;});locker.stderr.on('data',data=>{lockError+=data;});
  let settled=false, response;
  try {
    await until(()=>{if(locker.exitCode!==null)throw new Error('SQL lock helper exited: '+lockError);return lockOutput.includes('locked');},'SQL writer held');
    response=formal('wallpaper.library.deleteWork',{workKey:fixture.image.workKey})
      .then(value=>{settled=true;return value;},error=>{settled=true;return {transportError:error.code||String(error)};});
    await until(()=>!fs.existsSync(removed),'real deletion removed the package before the row transaction',4000);
    assert.equal(settled,false,'no success receipt before database commit');
    const crashedPid=child.pid;
    await stop();
    const interrupted=await response;
    assert.ok(interrupted.transportError,'terminating the owned host interrupts the uncommitted response');
    const retainedRows=JSON.parse(execFileSync(process.env.PYTHON||'python',['-c','import sqlite3,json,sys; db=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(db.execute("SELECT p.state,v.version FROM versions v JOIN packages p USING(package_hash) WHERE v.work_key=?",(sys.argv[2],)).fetchall())); db.close()',dbFile,fixture.image.workKey],{encoding:'utf8',windowsHide:true}));
    assert.deepEqual(retainedRows,[['installed',1]],'the exact interruption point retains the original rows');
    assert.equal(originalHash('video'),otherHash);assert.equal(hash(fs.readFileSync(configFile)),saved);
    checks.push({case:'process-terminated-after-package-removal-before-row-commit',crashedPid,interrupted,retainedRows});
  } finally {
    locker.stdin.end();
    await until(()=>locker.exitCode!==null||locker.signalCode!==null,'SQL lock helper exits',5000).catch(error=>{locker.kill();throw error;});
  }
  await start();
  const recovered=await formal('wallpaper.library.get',{workKey:fixture.image.workKey});
  assert.equal(recovered.ok,true);assert.equal(recovered.result.versions[0].state,'unavailable');
  assert.equal(fs.existsSync(removed),false);assert.equal(originalHash('video'),otherHash);
  assert.equal(hash(fs.readFileSync(configFile)),saved);
  checks.push({case:'restart-marks-interrupted-deletion-unavailable-without-resurrection',record:recovered.result});
  const deleted=await formal('wallpaper.library.deleteWork',{workKey:fixture.image.workKey});
  assert.equal(deleted.ok,true);assert.equal(deleted.result.deleted,true);
  await stop();await start();
  const absent=await formal('wallpaper.library.get',{workKey:fixture.image.workKey});
  assert.equal(absent.error.code,'work_not_found');assert.equal(fs.existsSync(removed),false);
  assert.equal(originalHash('video'),otherHash);assert.equal(hash(fs.readFileSync(configFile)),saved);
  const resources=await formal('wallpaper.status');assert.equal(resources.result.decoderSlots,0);assert.equal(resources.result.prepareTasks,0);
  checks.push({case:'explicit-delete-retry-finishes-and-survives-another-restart',receipt:deleted,resources:resources.result});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'library-crash-report.json'),JSON.stringify({ordinaryBuild:true,binarySha256:hash(fs.readFileSync(binary)),checks,errors,limitations:['A real owned process was terminated at a SQL-blocked deletion checkpoint; not power loss or an OS crash','Native file dialog not exercised']},null,2));
  console.log('native library deletion crash checks passed: '+output);
}
(async () => {
  assert.equal(process.platform, 'win32');
  assert.equal(execFileSync('powershell.exe', ['-NoProfile', '-Command', '@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', windowsHide: true }).trim(), '0', 'protect existing desktop instances');
  try { if(process.argv.includes('--crash'))await runDeletionCrash();else await run(); }
  catch (error) {
    if (fs.existsSync(output)) fs.writeFileSync(path.join(output, 'library-failure.json'), JSON.stringify({ error: error.stack, checks, errors, state: await status().catch(() => null) }, null, 2));
    throw error;
  } finally { await stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
