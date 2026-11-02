// SPDX-License-Identifier: MIT
// Isolated native settings drafts, durable apply receipts and crash-checkpoint recovery.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const requestManagement = require('./desktop-native-management-client');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/wallpaper-config-native-' + Date.now());
const binary = path.join(root, 'target/debug/hertz-desktop.exe');
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const port = Number(process.env.DESKTOP_CDP_PORT || 19438);
const configFile = path.join(output, 'config.json');
const checks = [];
let child, browser, page, sequence = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(100); }
  throw new Error(label);
}
async function start() {
  child = spawn(binary, ['--settings'], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, HERTZ_DESKTOP_CONFIG_DIR: output, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } });
  await until(async () => { if (child.exitCode !== null) throw new Error('host exited ' + child.exitCode); try { return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch (_) { return false; } }, 'native CDP startup');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('/settings.html')), 'native settings page');
  await page.waitForSelector('#preview:enabled');
}
async function stop() {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
  if (child && child.exitCode === null) {
    child.kill();
    await until(() => child.exitCode !== null || child.signalCode !== null, 'owned host exit', 5000);
  }
  child = null;
}
function envelope(command, payload = {}, expectedRevision, requestId = 'native-config-' + (++sequence)) {
  return { protocol: 2, requestId, command, payload, ...(expectedRevision == null ? {} : { expectedRevision }) };
}
async function inPage(request) {
  return page.evaluate(async request => {
    try { return await window.hertzWallpaperSettings.requestManagement(request.command, request.payload, request.requestId, request.expectedRevision); }
    catch (error) { return error.receipt || { ok: false, error: { code: error.code, message: error.message } }; }
  }, request);
}
const formal = (command, payload, expectedRevision, requestId) => requestManagement(pipe, envelope(command, payload, expectedRevision, requestId));
const stored = () => JSON.parse(fs.readFileSync(configFile));
const domain = config => config.activeProfile ? config.profiles.find(profile => JSON.stringify(profile.profile) === JSON.stringify(config.activeProfile)) : config.unboundDomain;
const reference = result => ({ draftId: result.draftId, draftRevision: result.draftRevision });
function pendingCheckpoint(operationId) {
  const dir = path.join(output, 'operations');
  const name = fs.readdirSync(dir).find(name => name.endsWith('.json') && JSON.parse(fs.readFileSync(path.join(dir, name))).requestId === operationId);
  const recordFile = path.join(dir, name), record = JSON.parse(fs.readFileSync(recordFile));
  assert.equal(record.state, 'committed');
  const target = fs.readFileSync(configFile, 'utf8');
  assert.equal(digest(target), record.targetConfigDigest);
  record.state = 'pending'; record.candidateConfig = target;
  fs.writeFileSync(recordFile, JSON.stringify(record));
  return { recordFile, record, target };
}
async function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(execFileSync('powershell.exe', ['-NoProfile', '-Command', '@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count'], { windowsHide: true, encoding: 'utf8' }).trim(), '0', 'protect the user native instance');
  fs.mkdirSync(output, { recursive: true });
  const lyrics = { enabled: false, locked: false, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32, fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 1, opacity: 1, width: 550, anchorX: .5, anchorY: .5, monitor: null };
  const wallpaper = { enabled: false, fps: 30, musicResponse: true, monitor: null, source: 'fixed', scene: 'coast' };
  fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 4, revision: 1, launchAtLogin: false, activeProfile: null, profiles: [], unboundDomain: { lyrics, wallpaper }, lastCommit: null }));
  await start();
  const original = fs.readFileSync(configFile, 'utf8'), baseline = stored();
  assert.equal(baseline.activeProfile, null);
  assert.equal((await formal('wallpaper.draft.create', { kind: 'settings' })).error.code, 'settings_session_required');
  const create = envelope('wallpaper.draft.create', { kind: 'settings' });
  const draft = (await inPage(create)).result;
  assert.deepEqual((await inPage(create)).result, draft, 'same request reuses the original native draft');
  const changed = structuredClone(domain(baseline)); changed.wallpaper.groups[0].presentation.fps = 60; changed.lyrics.fontSize = 42;
  assert.equal((await inPage(envelope('wallpaper.draft.update', { draftId: draft.draftId, draftRevision: 99, operations: [{ kind: 'replaceLyrics', lyrics: changed.lyrics }] }))).error.code, 'draft_conflict');
  const updated = (await inPage(envelope('wallpaper.draft.update', { ...reference(draft), operations: [{ kind: 'replaceWallpaper', wallpaper: changed.wallpaper }, { kind: 'replaceLyrics', lyrics: changed.lyrics }] }))).result;
  assert.equal(fs.readFileSync(configFile, 'utf8'), original, 'typed updates are readonly for live and persisted intent');
  const preview = (await inPage(envelope('wallpaper.preview.acquire', reference(updated)))).result;
  assert.match(preview.leaseId, /^[a-f0-9]{32}$/);
  await page.waitForFunction(() => document.querySelector('#preview-renderer')?.contentDocument?.querySelector('canvas'));
  assert.equal((await formal('wallpaper.preview.renew', { leaseId: preview.leaseId })).error.code, 'settings_session_required');
  assert.equal((await inPage(envelope('wallpaper.preview.renew', { leaseId: 'wrong-owner' }))).error.code, 'preview_lease_invalid');
  assert.equal((await inPage(envelope('wallpaper.preview.update', { leaseId: preview.leaseId, ...reference(updated) }))).ok, true);
  assert.equal((await inPage(envelope('wallpaper.preview.renew', { leaseId: preview.leaseId }))).ok, true);
  assert.equal((await inPage(envelope('wallpaper.preview.release', { leaseId: preview.leaseId }))).ok, true);
  await page.waitForFunction(() => !document.querySelector('#preview-renderer'));
  assert.equal(fs.readFileSync(configFile, 'utf8'), original, 'native preview does not save');
  const apply = envelope('wallpaper.apply', reference(updated), baseline.revision);
  const receipt = await inPage(apply);
  assert.equal(receipt.ok, true); assert.equal(receipt.result.saved, true);
  assert.equal(stored().revision, baseline.revision + 1); assert.equal(domain(stored()).lyrics.fontSize, 42);
  const firstSaved = fs.readFileSync(configFile, 'utf8');
  assert.deepEqual(await requestManagement(pipe, apply), receipt, 'committed retry returns the retained receipt');
  assert.equal(fs.readFileSync(configFile, 'utf8'), firstSaved, 'duplicate apply cannot replay effects');
  assert.equal((await requestManagement(pipe, { ...apply, payload: { ...apply.payload, draftRevision: 99 } })).error.code, 'request_id_conflict');
  assert.equal((await formal('wallpaper.operations.get', { requestId: apply.requestId, command: "wallpaper.apply" })).result.saved, true);
  assert.equal(fs.existsSync(path.join(output, 'wallpaper.db')), false, 'settings-only operations do not open the content DB');
  checks.push('native owner + typed draft + preview + durable apply + replay identity');

  const next = (await inPage(envelope('wallpaper.draft.create', { kind: 'settings' }))).result;
  const newLyrics = { ...changed.lyrics, fontSize: 43 };
  const nextDraft = (await inPage(envelope('wallpaper.draft.update', { ...reference(next), operations: [{ kind: 'replaceLyrics', lyrics: newLyrics }] }))).result;
  const failedApply = envelope('wallpaper.apply', reference(nextDraft), stored().revision);
  const tmp = path.resolve(output, 'config.json.tmp');
  assert.equal(path.dirname(tmp), path.resolve(output));
  fs.mkdirSync(tmp);
  const failed = await inPage(failedApply);
  assert.equal(failed.ok, false); assert.equal(failed.error.code, 'config_write_failed');
  assert.equal(fs.readFileSync(configFile, 'utf8'), firstSaved);
  assert.equal((await formal('wallpaper.operations.get', { requestId: failedApply.requestId, command: "wallpaper.apply" })).result.saved, false);
  fs.rmdirSync(tmp);
  const finalApply = envelope('wallpaper.apply', reference(nextDraft), stored().revision);
  assert.equal((await inPage(finalApply)).result.saved, true, 'failed commit keeps its native draft');
  const finalRevision = stored().revision;
  checks.push('failed atomic replacement preserves disk/revision; retained operation is not_committed');

  // Materialize the exact durable checkpoint after config replacement but before receipt finalization.
  // This exercises real process startup against that checkpoint; it does not inject a timed OS crash.
  await stop();
  const checkpoint = pendingCheckpoint(finalApply.requestId);
  await start();
  const recovered = (await formal('wallpaper.operations.get', { requestId: finalApply.requestId, command: "wallpaper.apply" })).result;
  assert.equal(recovered.state, 'committed'); assert.equal(recovered.configRevision, finalRevision);
  assert.equal(fs.readFileSync(configFile, 'utf8'), checkpoint.target, 'recovery only finalizes the receipt');
  assert.equal(JSON.parse(fs.readFileSync(checkpoint.recordFile)).state, 'committed');
  assert.equal((await requestManagement(pipe, finalApply)).result.configRevision, finalRevision, 'retry survives loss of old settings owner and in-memory cache');
  assert.equal((await requestManagement(pipe, apply)).result.configRevision, receipt.result.configRevision, 'older receipt remains queryable after a later commit');
  checks.push('restart after config-replaced checkpoint finalizes original request and revision without rewriting config');

  await stop();
  const conflict = pendingCheckpoint(finalApply.requestId);
  const foreign = stored(); foreign.revision += 10;
  const foreignBytes = JSON.stringify(foreign, null, 2); fs.writeFileSync(configFile, foreignBytes);
  await start();
  assert.equal((await formal('wallpaper.operations.get', { requestId: finalApply.requestId, command: "wallpaper.apply" })).result.state, 'config_conflict');
  const conflictDraft = (await inPage(envelope('wallpaper.draft.create', { kind: 'settings' }))).result;
  const rejected = await inPage(envelope('wallpaper.apply', reference(conflictDraft), foreign.revision));
  assert.equal(rejected.ok, false); assert.equal(fs.readFileSync(configFile, 'utf8'), foreignBytes);
  assert.equal(JSON.parse(fs.readFileSync(conflict.recordFile)).state, 'config_conflict');
  checks.push('mismatched pending checkpoint preserves user config and refuses another commit');
  await page.screenshot({ path: path.join(output, 'native-config-conflict.png') });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks, scope: 'native WebView2 + named-pipe + real file replacement; crash states are materialized checkpoints' }, null, 2));
  console.log('native wallpaper config checks passed: ' + output);
}
main().catch(error => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, checks }, null, 2)); console.error(error); process.exitCode = 1; }).finally(stop);
