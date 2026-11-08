// SPDX-License-Identifier: MIT
// AI-01: real isolated installed catalog, trusted settings IPC and original journal.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const nativeRequest = require('./desktop-native-management-client');
const root = path.resolve(__dirname, '..');
const binary = process.env.HERTZ_DESKTOP_BIN;
if (!binary || !fs.existsSync(binary)) throw new Error('Set HERTZ_DESKTOP_BIN to a copied isolated candidate.');
const output = path.resolve(process.env.HERTZ_AI_OUTPUT || path.join(root, 'output/a06-ai-20261108/native-' + Date.now()));
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, page, seq = 0;
const checks = [], errors = [];
async function until(fn, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error(label);
}
async function api(command, payload = {}, expectedRevision) {
  return page.evaluate(async input => {
    try { return await hertzWallpaperSettings.requestManagement(input.command, input.payload, input.id, input.expectedRevision); }
    catch (error) { return error.receipt || { ok: false, error: { code: error.code, message: error.message } }; }
  }, { command, payload, expectedRevision, id: 'ai-native-' + (++seq) });
}
const stored = () => JSON.parse(fs.readFileSync(path.join(output, 'config.json')));
const wallpaper = value => (value.activeProfile ? value.profiles.find(entry => JSON.stringify(entry.profile) === JSON.stringify(value.activeProfile)) : value.unboundDomain).wallpaper;
const lyrics = value => (value.activeProfile ? value.profiles.find(entry => JSON.stringify(entry.profile) === JSON.stringify(value.activeProfile)) : value.unboundDomain).lyrics;
async function publish(title) {
  const draft = (await api('wallpaper.draft.create', { kind: 'work', document: { title, sceneId: 'coast', stateVersion: 1, params: {} } })).result;
  assert.ok(draft, title);
  const saved = (await api('wallpaper.draft.save', { draftId: draft.draftId, draftRevision: draft.draftRevision })).result;
  const result = await api('wallpaper.draft.publish', { draftId: saved.draftId, draftRevision: saved.draftRevision });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.result;
}
async function query(brief) {
  const current = contextRevision();
  return api('wallpaper.ai.recommend', { brief }, current);
}
function contextRevision() { return stored().revision; }
async function start() {
  // A read-only guard protects any unrelated standalone host and its global pipe.
  try { await nativeRequest(pipe, { command: 'status' }); throw new Error('Existing standalone desktop host; leave it untouched.'); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  fs.mkdirSync(output, { recursive: true });
  const port = Number(process.env.DESKTOP_CDP_PORT || 19728);
  child = spawn(binary, ['--settings'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, HERTZ_DESKTOP_CONFIG_DIR: output, WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
  } });
  const log = fs.createWriteStream(path.join(output, 'owned-native.log')); child.stdout.pipe(log); child.stderr.pipe(log);
  await until(async () => { if (child.exitCode !== null) throw new Error('Owned host exited ' + child.exitCode); try { return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch { return false; } }, 'owned CDP startup');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(item => item.url().includes('/settings.html')), 'owned native settings page');
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#enabled:enabled');
  await page.evaluate(() => {
    window.aiEvidence = { receipts: [], progress: [] };
    const request = hertzWallpaperSettings.requestManagement;
    hertzWallpaperSettings.requestManagement = async function (...args) {
      try { const result = await request.apply(this, args); aiEvidence.receipts.push({ command: args[0], ...structuredClone(result) }); return result; }
      catch (error) { aiEvidence.receipts.push({ command: args[0], ...structuredClone(error.receipt || { error: { code: error.code, message: error.message } }) }); throw error; }
    };
    const progress = hertzWallpaperAI.applyProgress;
    hertzWallpaperAI.applyProgress = value => { aiEvidence.progress.push(structuredClone(value)); progress(value); };
  });
}
async function main() {
  try {
    await start();
    const first = await publish('AI 静夜'), second = await publish('AI 重名'), third = await publish('AI 重名');
    await page.locator('#wallpaper-ai > summary').click(); await page.waitForSelector('#ai-query:enabled');
    const discovered = await query('AI'); assert.equal(discovered.ok, true, JSON.stringify(discovered)); assert.equal(discovered.result.actions.length, 3);
    assert.ok(discovered.result.actions.some(action => action.workKey === first.workKey));
    assert.ok(discovered.result.actions.every(action => !('executionTicket' in action) && !('token' in action)));
    const ambiguous = await query('切换到「AI 重名」'); assert.equal(ambiguous.result.ambiguous, true); assert.equal(ambiguous.result.actions.length, 2);
    assert.notEqual(second.workKey, third.workKey); checks.push('actual installed native catalog, displayed reasons and same-title ambiguity without execution');

    const before = stored();
    await page.locator('#ai-brief').fill('切换到「AI 静夜」'); await page.locator('#ai-query').click();
    await until(() => wallpaper(stored()).groups[0].selection.workKey === first.workKey, 'explicit native switch committed');
    assert.equal(stored().revision, before.revision + 1); assert.deepEqual(lyrics(stored()), lyrics(before));
    await until(async () => await page.evaluate(work => aiEvidence.progress.some(progress => progress.phase === 'saved' && progress.saved && progress.workKey === work.workKey && progress.packageHash === work.packageHash), first), 'exact disabled switch saved phase');
    const phases = await page.evaluate(() => aiEvidence.progress);
    const accepted = phases.find(progress => progress.phase === 'accepted'); assert.ok(accepted);
    const savedIndex = phases.findIndex(progress => progress.requestId === accepted.requestId && progress.phase === 'saved' && progress.saved);
    assert.ok(savedIndex > phases.indexOf(accepted));
    assert.equal(phases[savedIndex].workKey, first.workKey); assert.equal(phases[savedIndex].packageHash, first.packageHash);
    await until(async () => await page.evaluate(requestId => aiEvidence.progress.some(progress => progress.requestId === requestId && progress.phase === 'paused' && progress.saved), accepted.requestId), 'disabled saved switch reports paused');
    const journal = await api('wallpaper.operations.get', { requestId: accepted.requestId, command: 'wallpaper.ai.recommend' });
    assert.equal(journal.ok, true, JSON.stringify(journal)); assert.equal(journal.result.saved, true);
    checks.push('complete explicit request directly accepted, saved by original Config journal and queried by original request ID');

    await page.locator('#enabled').check(); await page.locator('#apply').click();
    await until(async () => { const state = await nativeRequest(pipe, { command: 'status' }); return state.wallpaper.firstFrameReady; }, 'actual native first frame');
    const baseline = stored();
    const selected = (await query('AI 重名')).result.actions[0];
    const stale = await api('wallpaper.ai.confirm', { actionId: selected.actionId }, baseline.revision - 1);
    assert.equal(stale.ok, false); assert.equal(stale.error.code, 'config_conflict'); assert.deepEqual(stored(), baseline);
    await api('wallpaper.ai.invalidate');
    const invalidated = await api('wallpaper.ai.confirm', { actionId: selected.actionId }, baseline.revision);
    assert.equal(invalidated.ok, false); assert.equal(invalidated.error.code, 'ai_action_stale');
    checks.push('CAS and explicit native selection invalidation reject stale displayed actions without a configuration write');

    const external = await nativeRequest(pipe, { protocol: 2, requestId: 'ai-native-external', command: 'wallpaper.ai.recommend', expectedRevision: baseline.revision,
      payload: { brief: '切换到「AI 重名」', approved: true, explicit: true, isTrusted: true } });
    assert.equal(external.ok, false); assert.equal(external.error.code, 'settings_session_required');
    checks.push('ordinary management approved/explicit/isTrusted flags cannot enter the trusted settings authority');

    const refreshed = await query('AI 重名'); const action = refreshed.result.actions[0];
    const uiDraft = (await api('wallpaper.draft.create', { kind: 'settings' })).result;
    const draftLyrics = structuredClone(lyrics(baseline)); draftLyrics.fontSize = 63;
    const changed = await api('wallpaper.draft.update', { draftId: uiDraft.draftId, draftRevision: uiDraft.draftRevision, operations: [{ kind: 'replaceLyrics', lyrics: draftLyrics }] });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    const freshAction = (await query('AI 重名')).result.actions.find(item => item.workKey === action.workKey);
    const switched = await api('wallpaper.ai.confirm', { actionId: freshAction.actionId }, baseline.revision);
    assert.equal(switched.ok, true, JSON.stringify(switched)); assert.deepEqual(lyrics(stored()), lyrics(baseline));
    const draftConflict = await api('wallpaper.apply', { draftId: uiDraft.draftId, draftRevision: changed.result.draftRevision }, baseline.revision);
    assert.equal(draftConflict.ok, false); assert.equal(draftConflict.error.code, 'conflict');
    assert.equal(wallpaper(stored()).groups[0].selection.workKey, action.workKey);
    checks.push('native unconfirmed lyrics draft stays out of AI commit and its old CAS cannot overwrite the new wallpaper');

    const none = await api('wallpaper.ai.target', { groupId: null }); assert.equal(none.ok, false); assert.equal(none.error.code, 'target_required');
    const noTarget = await query('切换到「AI 静夜」'); assert.equal(noTarget.ok, false); assert.equal(noTarget.error.code, 'target_required');
    checks.push('missing target remains explicitly unavailable and cannot be expanded to primary/all screens');

    await api('wallpaper.ai.target', { groupId: 'main' });
    await page.waitForSelector('#ai-query:enabled');
    const progressCount = await page.evaluate(() => aiEvidence.progress.length);
    await page.locator('#ai-brief').fill('切换到「AI 静夜」'); await page.locator('#ai-query').click();
    await until(() => wallpaper(stored()).groups[0].selection.workKey === first.workKey, 'enabled explicit switch committed');
    const terminal = await until(async () => await page.evaluate(({ start, work }) => {
      const phases = aiEvidence.progress.slice(start), accepted = phases.find(progress => progress.phase === 'accepted');
      if (!accepted || !phases.some(progress => progress.requestId === accepted.requestId && progress.phase === 'saved' && progress.saved && progress.workKey === work.workKey && progress.packageHash === work.packageHash)) return null;
      if (!phases.some(progress => progress.requestId === accepted.requestId && progress.phase === 'running' && progress.saved)) return null;
      return { requestId: accepted.requestId, phases, runtime: structuredClone(hertzWallpaperSettings.currentRuntime()) };
    }, { start: progressCount, work: first }), 'enabled exact switch reaches real first-frame running phase');
    assert.equal(terminal.runtime.firstFrameReady, true); assert.equal(terminal.runtime.visible, true);
    assert.equal(terminal.runtime.appliedSelection.workKey, first.workKey); assert.equal(terminal.runtime.appliedSelection.packageHash, first.packageHash);
    checks.push('accepted then saved binds exact work/hash; disabled switch is paused and enabled switch reports running only with matching native first frame');

    await page.waitForSelector('#ai-query:enabled');
    await page.locator('#ai-brief').fill('AI'); await page.locator('#ai-query').click();
    await until(async () => await page.locator('#ai-results > li').count() === 3, 'displayed recommendation rows');
    const screenshot = path.join(output, 'native-offline-panel.png'); await page.locator('#wallpaper-ai').screenshot({ path: screenshot });
    fs.writeFileSync(path.join(output, 'ipc-evidence.json'), JSON.stringify(await page.evaluate(() => aiEvidence), null, 2));
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, binary, binarySha256: hash(fs.readFileSync(binary)), ownedPid: child.pid, checks, errors, screenshot }, null, 2));
    process.stdout.write(JSON.stringify({ passed: true, output, checks }, null, 2) + '\n');
  } catch (error) {
    fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: false, error: error.stack, checks, errors }, null, 2));
    if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'ipc-evidence.json'), JSON.stringify(await page.evaluate(() => aiEvidence).catch(() => null), null, 2)); }
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child && child.exitCode === null) { child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned process exit', 5000); }
  }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
