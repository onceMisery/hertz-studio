#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real, isolated package/helper and native-document checks. No user installation.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { packageStandalone } = require('./package-standalone-windows');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const binary = process.env.HERTZ_BIN || path.join(root, 'target/debug/hertz-studio.exe');
const allowDebug = process.env.HERTZ_ALLOW_DEBUG_PACKAGE === '1';
const output = path.join(root, 'output/app-updates-native-' + Date.now());
const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const checks = [], owned = new Set(), restartedPids = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mark = text => { checks.push(text); console.log('PASS ' + text); };
let browser;
async function until(read, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(75); }
  throw new Error('Timed out: ' + label);
}
function child(file, args, extra = {}) {
  const item = spawn(file, args, { cwd: output, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory',
      HERTZ_DESKTOP_CONFIG_DIR: path.join(output, 'desktop'), ...extra } });
  item.out = ''; item.err = ''; owned.add(item);
  item.stdout.on('data', bytes => { item.out = (item.out + bytes).slice(-16000); });
  item.stderr.on('data', bytes => { item.err = (item.err + bytes).slice(-16000); });
  item.on('error', error => { item.failure = error; });
  return item;
}
async function exited(item) {
  await until(() => { if (item.failure) throw item.failure; return item.exitCode !== null || item.signalCode !== null; }, 'owned process exits');
  owned.delete(item);
}
function powershell(script, extra = {}) {
  return execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ' + script],
  { windowsHide: true, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...extra } });
}
function zip(directory, archive) {
  powershell('Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:HERTZ_FIXTURE_SOURCE,$env:HERTZ_FIXTURE_ZIP)',
    { HERTZ_FIXTURE_SOURCE: directory, HERTZ_FIXTURE_ZIP: archive });
}
function programSnapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name);
    return fs.statSync(file).isFile() ? [[name, hash(file)]] : [];
  }));
}
async function start(install, data, nativePort) {
  const item = child(path.join(install, 'hertz-studio.exe'), [
    ...(nativePort ? ['--window'] : []), '--bind', '127.0.0.1', '--port', '0', '--data-dir', data,
  ], nativePort ? { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + nativePort } : {});
  const discovery = await until(() => {
    if (item.failure) throw item.failure;
    assert.equal(item.exitCode, null, item.err);
    try { const value = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'), 'utf8')); return value.pid === item.pid && value; }
    catch { return null; }
  }, 'isolated real service discovery', 60000);
  const api = apiFor(discovery);
  await api('/v1/health');
  return { item, data, discovery, api };
}
function apiFor(discovery) {
  return async (endpoint, method = 'GET', body) => {
    const response = await fetch('http://127.0.0.1:' + discovery.port + endpoint, { method,
      headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000) });
    assert(response.ok, endpoint + ': HTTP ' + response.status);
    return response.json();
  };
}
async function stop(parent) { await parent.api('/v1/system/shutdown', 'POST', {}); await exited(parent.item); }
function handoff(install, parent, archive, change = {}, options = {}) {
  const operation = crypto.randomUUID(), token = crypto.randomUUID();
  const stage = path.join(parent.data, 'cache/updates', operation);
  const directory = path.join(stage, 'handoff-' + token);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(stage, 'Apply-Hertz-Update.ps1'), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(path.join(root, 'scripts/windows/Apply-Hertz-Update.ps1')),
  ]));
  fs.copyFileSync(path.join(root, 'scripts/windows/Update-Hertz.ps1'), path.join(stage, 'Update-Hertz.ps1'));
  const version = JSON.parse(fs.readFileSync(path.join(install, 'standalone-build.json'), 'utf8')).version;
  const packagePath = path.join(stage, `hertz-studio-${version}-x86_64-pc-windows-msvc.zip`);
  fs.copyFileSync(archive, packagePath);
  const plan = { schemaVersion: 1, token, kind: 'portable', installDir: install, stageDir: stage,
    dataDir: parent.data, packagePath, sha256: hash(packagePath), size: fs.statSync(packagePath).size,
    version, fromVersion: version, parentPid: parent.item.pid, port: parent.discovery.port, ...change };
  const planPath = path.join(directory, 'plan.json'); fs.writeFileSync(planPath, JSON.stringify(plan));
  const helper = child(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(stage, 'Apply-Hertz-Update.ps1'), '-Plan', planPath,
    ...(allowDebug ? ['-AllowDebug'] : []), ...(options.restart ? [] : ['-NoRestart']), '-Quiet'], options.env || {});
  return { stage, directory, token, helper, plan, packagePath };
}
async function helperReady(job) {
  const ready = await until(() => {
    if (job.helper.failure) throw job.helper.failure;
    assert.equal(job.helper.exitCode, null, job.helper.err);
    try { return JSON.parse(fs.readFileSync(path.join(job.directory, 'ready.json'), 'utf8')); } catch { return null; }
  }, 'helper acknowledges exact parent and private plan');
  assert.equal(ready.token, job.token);
}
function approve(job, token = job.token) {
  fs.writeFileSync(path.join(job.directory, 'apply.new'), JSON.stringify({ token }));
  fs.renameSync(path.join(job.directory, 'apply.new'), path.join(job.directory, 'apply.json'));
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function main() {
  assert.equal(process.platform, 'win32'); fs.mkdirSync(output, { recursive: true });
  const packaged = packageStandalone(binary, path.join(output, 'packages'), { allowDebug });
  const install = path.join(output, "安装 & player's program"), candidate = path.join(output, '候选包');
  powershell('Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:HERTZ_FIXTURE_ZIP,$env:HERTZ_FIXTURE_INSTALL); [IO.Compression.ZipFile]::ExtractToDirectory($env:HERTZ_FIXTURE_ZIP,$env:HERTZ_FIXTURE_CANDIDATE)',
    { HERTZ_FIXTURE_ZIP: packaged.archive, HERTZ_FIXTURE_INSTALL: install, HERTZ_FIXTURE_CANDIDATE: candidate });
  fs.writeFileSync(path.join(install, 'user-kept.txt'), 'Extra program-directory file must survive.');
  fs.appendFileSync(path.join(candidate, 'NOTICE'), '\nObservable local package-update fixture.\n');
  const manifestPath = path.join(candidate, 'standalone-build.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files.NOTICE = { size: fs.statSync(path.join(candidate, 'NOTICE')).size, sha256: hash(path.join(candidate, 'NOTICE')) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const archive = path.join(output, 'candidate.zip'); zip(candidate, archive);
  const original = programSnapshot(install), expected = { ...programSnapshot(candidate), 'user-kept.txt': original['user-kept.txt'] };
  const data = path.join(output, "资料 & user's profile"), dataB = path.join(output, 'second profile');
  fs.mkdirSync(data); const sentinel = path.join(data, 'music-kept.txt'); fs.writeFileSync(sentinel, 'Preserve personal data.');
  const personal = hash(sentinel);
  let parent = await start(install, data);
  let job = handoff(install, parent, archive, { parentPid: process.pid });
  await exited(job.helper); assert.equal(job.helper.exitCode, 1);
  assert(!fs.existsSync(path.join(job.directory, 'ready.json'))); assert.equal(parent.item.exitCode, null);
  assert.deepEqual(programSnapshot(install), original);
  mark('helper refuses a parent from outside this installation before acknowledging readiness; the player continues');

  job = handoff(install, parent, archive); await helperReady(job);
  await stop(parent); await exited(job.helper); assert.equal(job.helper.exitCode, 0);
  assert.deepEqual(programSnapshot(install), original); assert.equal(hash(sentinel), personal);
  assert(!fs.existsSync(path.join(data, 'cache/updates/last-install.json')));
  mark('a real player exiting without the approved shutdown marker never replaces program files');

  parent = await start(install, data); job = handoff(install, parent, archive); await helperReady(job);
  fs.writeFileSync(path.join(job.directory, 'cancel'), 'cancelled'); approve(job);
  await exited(job.helper); assert.equal(job.helper.exitCode, 0); assert.equal(parent.item.exitCode, null);
  await stop(parent); assert.deepEqual(programSnapshot(install), original); assert.equal(hash(sentinel), personal);
  mark('cancellation dominates a stale approval, stops only the helper and preserves the running player and personal data');

  parent = await start(install, data); job = handoff(install, parent, archive); await helperReady(job);
  const file = fs.openSync(job.packagePath, 'r+'); fs.writeSync(file, Buffer.from([0]), 0, 1, 0); fs.closeSync(file);
  approve(job); await stop(parent); await exited(job.helper); assert.equal(job.helper.exitCode, 1);
  assert.deepEqual(programSnapshot(install), original);
  let outcome = JSON.parse(fs.readFileSync(path.join(data, 'cache/updates/last-install.json'), 'utf8'));
  assert.equal(outcome.status, 'failed'); assert.match(outcome.message, /^更新未完成：/);
  assert.match(fs.readFileSync(outcome.log, 'utf8'), /Downloaded update package changed/);
  mark('changed cached package fails SHA-256 verification after approved exit, retains the old program and records a readable failure');

  const validManifest = fs.readFileSync(manifestPath); fs.appendFileSync(path.join(candidate, 'NOTICE'), 'Corrupted inner package.');
  const corrupt = path.join(output, 'corrupt-package.zip'); zip(candidate, corrupt);
  fs.writeFileSync(manifestPath, validManifest);
  parent = await start(install, data); job = handoff(install, parent, corrupt); await helperReady(job);
  approve(job); await stop(parent); await exited(job.helper); assert.equal(job.helper.exitCode, 1);
  assert.deepEqual(programSnapshot(install), original); assert.equal(hash(sentinel), personal);
  outcome = JSON.parse(fs.readFileSync(path.join(data, 'cache/updates/last-install.json'), 'utf8'));
  assert.match(fs.readFileSync(outcome.log, 'utf8'), /size mismatch|hash mismatch/);
  mark('an archive with a valid download checksum and damaged inner manifest is rejected by the existing updater before replacement');

  parent = await start(install, data); const other = await start(install, dataB);
  job = handoff(install, parent, archive); await helperReady(job); approve(job); await stop(parent);
  await exited(job.helper); assert.equal(job.helper.exitCode, 1);
  assert.equal(other.item.exitCode, null); await other.api('/v1/health');
  assert.deepEqual(programSnapshot(install), original); assert.equal(hash(sentinel), personal);
  outcome = JSON.parse(fs.readFileSync(path.join(data, 'cache/updates/last-install.json'), 'utf8'));
  assert.match(fs.readFileSync(outcome.log, 'utf8'), /Other players still use/); await stop(other);
  mark('a second real profile holds the installation owner; the helper refuses replacement without killing it');

  parent = await start(install, data); job = handoff(install, parent, archive); await helperReady(job);
  approve(job); await stop(parent); await exited(job.helper); assert.equal(job.helper.exitCode, 0, job.helper.err);
  assert.deepEqual(programSnapshot(install), expected); assert.equal(hash(sentinel), personal); assert(!fs.existsSync(job.stage));
  outcome = JSON.parse(fs.readFileSync(path.join(data, 'cache/updates/last-install.json'), 'utf8'));
  assert.equal(outcome.status, 'updated'); assert.equal(outcome.version, manifest.version); assert.match(outcome.message, /^已更新到 /);
  parent = await start(install, data); assert.equal((await parent.api('/v1/system/updates')).lastInstall.status, 'updated'); await stop(parent);
  mark('approved shutdown completes the real portable transaction, preserves profile and extra files, cleans its stage and reports success on next launch');

  // The same actual port and profile must reopen even when the inherited bind
  // would violate the native listener's loopback-only contract.
  const cdp = await freePort(); parent = await start(install, data);
  const previousPid = parent.item.pid, previousPort = parent.discovery.port;
  job = handoff(install, parent, archive, {}, { restart: true, env: {
    VMUSIC_BIND: '0.0.0.0', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + cdp,
  } });
  await helperReady(job); approve(job); await stop(parent); await exited(job.helper);
  assert.equal(job.helper.exitCode, 0, job.helper.err);
  const reopened = await until(() => {
    try { const result = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'), 'utf8')); return result.pid !== previousPid && result; }
    catch { return null; }
  }, 'helper automatically reopens the same profile', 60000);
  const reopenedExecutable = powershell('$p=[Diagnostics.Process]::GetProcessById([int]$env:HERTZ_FIXTURE_PID); try { [IO.Path]::GetFullPath($p.MainModule.FileName) } finally { $p.Dispose() }',
    { HERTZ_FIXTURE_PID: String(reopened.pid) }).trim();
  assert.equal(reopenedExecutable.toLowerCase(), path.join(install, 'hertz-studio.exe').toLowerCase());
  restartedPids.add(reopened.pid);
  assert.equal(reopened.port, previousPort); assert.equal(hash(sentinel), personal); assert(!fs.existsSync(job.stage));
  parent = { data, discovery: reopened, api: apiFor(reopened) };
  await parent.api('/v1/health');
  assert.equal((await parent.api('/v1/system/updates')).distribution, 'standalone');
  mark('helper automatically reopens the same profile and actual port with the native loopback bind despite a conflicting inherited bind');
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + cdp + '/json/version')).ok; } catch { return false; } }, 'owned WebView2 CDP');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdp);
  const page = await until(() => browser.contexts().flatMap(context => context.pages())
    .find(item => item.url().startsWith('http://127.0.0.1:' + parent.discovery.port)), 'owned native document');
  await page.waitForFunction(() => window.__hertzWindowHost?.fileImportReady && window.__hertzWindowHost?.updateVersion === 1);
  await page.waitForFunction(() => !document.getElementById('app-update-auto').disabled);
  assert.equal((await parent.api('/v1/system/updates')).checkOnStartup, false);
  const forged = crypto.randomUUID();
  await page.evaluate(requestId => {
    window.__updateReceipts = [];
    window.addEventListener('hertz-native-update-result', event => window.__updateReceipts.push(event.detail));
    window.ipc.postMessage(JSON.stringify({ kind: 'install-update', documentId: crypto.randomUUID(), requestId, operationId: crypto.randomUUID() }));
  }, forged);
  await delay(350);
  assert.equal(await page.evaluate(requestId => window.__updateReceipts.some(item => item.requestId === requestId), forged), false);
  const failure = await page.evaluate(async () => {
    try { await window.__hertzWindowHost.installUpdate(crypto.randomUUID()); return 'unexpected acceptance'; }
    catch (error) { return error.message; }
  });
  assert.match(failure, /更新包尚未准备好/);
  assert.equal((await parent.api('/v1/window/state')).phase, 'idle');
  await page.locator('.hertz-startup').waitFor({ state: 'detached', timeout: 20000 });
  await page.locator('#rail [data-view="settings"]').click();
  await page.locator('.hz-settings-nav [data-category="tools"]').click();
  await page.locator('#application-updates').waitFor({ state: 'visible' });
  assert((await page.locator('#app-update-version').innerText()).includes('独立播放器'));
  await page.locator('#application-updates').screenshot({ path: path.join(output, 'native-settings.png') });
  mark('real WebView2 ignores forged document IPC and delivers the current native document a failed installation receipt without quitting');
  await page.evaluate(() => window.__hertzWindowHost.requestQuit());
  await until(async () => {
    if (!fs.existsSync(path.join(data, 'vmusicd.json'))) return true;
    try { const approveButton = page.locator('#window-lifecycle-approve');
      if (await approveButton.isVisible() && await approveButton.isEnabled()) await approveButton.click(); } catch {}
    return false;
  }, 'native guarded cleanup');
  powershell('$p=Get-Process -Id ([int]$env:HERTZ_FIXTURE_PID) -ErrorAction SilentlyContinue; if ($null -ne $p) { try { if (-not $p.WaitForExit(45000)) { throw "Reopened fixture did not exit normally." } } finally { $p.Dispose() } }',
    { HERTZ_FIXTURE_PID: String(reopened.pid) });
  restartedPids.delete(reopened.pid); await browser.close(); browser = null;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, binarySha256: hash(binary),
    description: packaged.manifest, archiveSha256: packaged.sha256,
    sourceSha256: Object.fromEntries(['crates/hertz-studio/src/updates.rs', 'crates/hertz-studio/src/updates/windows.rs',
      'crates/hertz-studio/src/window.rs', 'crates/hertz-studio/src/window_lifecycle.rs', 'crates/hertz-studio/src/main.rs',
      'scripts/windows/Apply-Hertz-Update.ps1', 'scripts/windows/Update-Hertz.ps1', 'scripts/check-app-updates-native.js']
      .map(file => [file, hash(path.join(root, file))])),
    limitations: ['one Windows/WebView2 host; null audio', 'same-version package with changed NOTICE; numeric release selection covered by Rust',
      'actual higher-version release, NSIS and publisher signatures need release qualification'],
  }, null, 2));
  console.log('Evidence: ' + output);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  for (const item of owned) { try { item.kill(); await exited(item); } catch {} }
  for (const pid of restartedPids) { try { process.kill(pid); } catch {} }
});
