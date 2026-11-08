#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Post-implementation checks of real Windows program handles and package updates.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { packageStandalone } = require('./package-standalone-windows');
const root = path.resolve(__dirname, '..');
const binary = process.env.HERTZ_BIN || path.join(root, 'target/release/hertz-studio.exe');
const allowDebug = process.env.HERTZ_ALLOW_DEBUG_PACKAGE === '1';
const output = path.join(root, 'output/install-owner-' + Date.now());
const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const updater = path.join(root, 'scripts/windows/Update-Hertz.ps1');
const owned = new Set(), checks = [];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const mark = message => { checks.push(message); console.log('PASS ' + message); };
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(60); }
  throw new Error('Timed out: ' + label);
}
function child(file, args, extra = {}) {
  const processChild = spawn(file, args, { cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', VMUSIC_LOG: 'error', HERTZ_DESKTOP_CONFIG_DIR: path.join(output, 'desktop'), ...extra } });
  processChild.out = ''; processChild.err = ''; owned.add(processChild);
  processChild.stdout.on('data', chunk => { processChild.out += chunk; });
  processChild.stderr.on('data', chunk => { processChild.err += chunk; });
  processChild.on('error', error => { processChild.failure = error; });
  return processChild;
}
async function exited(processChild) {
  await until(() => { if (processChild.failure) throw processChild.failure; return processChild.exitCode !== null || processChild.signalCode !== null; }, 'process exits');
  owned.delete(processChild);
}
async function killed(processChild) { processChild.kill(); await exited(processChild); }
function service(executable, data) { return child(executable, ['--bind', '127.0.0.1', '--port', '0', '--data-dir', data], { VMUSIC_DATA_DIR: data }); }
async function ready(processChild, data) {
  const discovery = await until(() => {
    if (processChild.failure) throw processChild.failure;
    assert.equal(processChild.exitCode, null, processChild.err);
    try { const value = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'), 'utf8')); return value.pid === processChild.pid && value; } catch { return null; }
  }, 'real HTTP discovery', 60000);
  const api = async (endpoint, method = 'GET') => {
    const response = await fetch('http://127.0.0.1:' + discovery.port + endpoint, { method,
      headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(12000) });
    assert.equal(response.status, 200, endpoint); return response.json();
  };
  await api('/v1/health'); return { api };
}
function powershell(script, extra = {}) { return execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ErrorActionPreference="Stop"; ' + script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000, env: { ...process.env, ...extra } }).trim(); }
async function hold(file, exclusive = true) {
  const holder = child(ps, ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; $stream=[IO.FileStream]::new($env:HERTZ_HELD_FILE,[IO.FileMode]::Open,[IO.FileAccess]::' + (exclusive ? 'ReadWrite,[IO.FileShare]::None' : 'Read,[IO.FileShare]::Read') + '); Write-Output "HELD"; [Console]::ReadLine() | Out-Null; $stream.Dispose()'], { HERTZ_HELD_FILE: file });
  await until(() => { assert.equal(holder.exitCode, null, holder.err); return holder.out.includes('HELD'); }, 'external handle'); return holder;
}
async function release(holder) { holder.stdin.end('\n'); await exited(holder); assert.equal(holder.exitCode, 0, holder.err); }
function update(install, candidate, recover = false) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', updater, '-InstallDir', install,
    ...(recover ? ['-Recover'] : ['-Candidate', candidate]), ...(allowDebug ? ['-AllowDebug'] : [])];
  return JSON.parse(execFileSync(ps, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000 }));
}
function rejection(action, pattern) {
  let error; try { action(); } catch (value) { error = value; }
  assert(error, 'Expected rejection'); assert.match(String(error.stderr || error.message), pattern);
}
function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().flatMap(name => {
    const full = path.join(directory, name); return fs.statSync(full).isFile() ? [[name, hash(full)]] : [];
  }));
}
function updateManifest(directory, edit) {
  const file = path.join(directory, 'standalone-build.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')); edit(value); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
async function main() {
  assert.equal(process.platform, 'win32'); fs.mkdirSync(output, { recursive: true });
  const runtime = path.join(output, "运行 & player's files"); fs.mkdirSync(runtime);
  const runtimeExe = path.join(runtime, 'hertz-studio.exe'); fs.copyFileSync(binary, runtimeExe);
  const unused = path.join(output, 'must-not-exist');
  const description = JSON.parse(execFileSync(runtimeExe, ['--describe', '--data-dir', unused], { encoding: 'utf8', windowsHide: true }));
  assert.equal(description.capabilities.windowsInstallGuard, true);
  execFileSync(runtimeExe, ['--help'], { windowsHide: true }); execFileSync(runtimeExe, ['--version'], { windowsHide: true });
  execFileSync(runtimeExe, ['--help', '--window', '--data-dir', unused], { windowsHide: true, timeout: 10000 });
  execFileSync(runtimeExe, ['--version', '--window', '--data-dir', unused], { windowsHide: true, timeout: 10000 });
  assert(!fs.existsSync(unused)); assert.deepEqual(fs.readdirSync(runtime), ['hertz-studio.exe']);
  mark('description/help/version create neither an installation carrier nor a DataDir');

  const dataA = path.join(output, 'profile A'), dataB = path.join(output, 'profile B');
  let first = service(runtimeExe, dataA), liveA = await ready(first, dataA);
  const second = service(runtimeExe, dataB); await ready(second, dataB);
  const carrier = path.join(runtime, 'hertz-install.lock');
  const openExclusive = () => powershell('$s=[IO.FileStream]::new($env:HERTZ_HELD_FILE,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $s.Dispose()', { HERTZ_HELD_FILE: carrier });
  rejection(openExclusive, /used by another process|使用|进程/i); assert.throws(() => fs.unlinkSync(carrier));
  await liveA.api('/v1/system/shutdown', 'POST'); await exited(first); rejection(openExclusive, /used by another process|使用|进程/i);
  await killed(second); openExclusive();
  const writer = await hold(carrier);
  const blockedData = path.join(output, 'blocked profile');
  const blocked = service(runtimeExe, blockedData); await exited(blocked); assert.match(blocked.err, /install_dir_busy/); assert(!fs.existsSync(blockedData));
  JSON.parse(execFileSync(runtimeExe, ['--describe'], { encoding: 'utf8', windowsHide: true }));
  const evaluator = child(runtimeExe, ['--evaluate-stage', '--window', '--data-dir', blockedData]);
  evaluator.stdin.end('{}\n'); await exited(evaluator); assert(!fs.existsSync(blockedData));
  assert(!evaluator.err.includes('install_dir_busy')); assert(!evaluator.err.includes('native-window'));
  await killed(writer); first = service(runtimeExe, dataA); liveA = await ready(first, dataA);
  await liveA.api('/v1/system/shutdown', 'POST'); await exited(first);
  mark('two real profiles share a physical installation; writer/deletion blocked until last exit, update excludes fresh startup, crash releases both kinds of owner');

  const packaged = packageStandalone(binary, path.join(output, 'packages'), { allowDebug });
  const install = path.join(output, "安装 & user's space"), candidate = path.join(output, '新包 candidate');
  powershell('Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:HERTZ_TEST_ZIP,$env:HERTZ_TEST_INSTALL); [IO.Compression.ZipFile]::ExtractToDirectory($env:HERTZ_TEST_ZIP,$env:HERTZ_TEST_CANDIDATE)', { HERTZ_TEST_ZIP: packaged.archive, HERTZ_TEST_INSTALL: install, HERTZ_TEST_CANDIDATE: candidate });
  fs.appendFileSync(path.join(candidate, 'NOTICE'), '\nLocal update verification fixture.\n');
  updateManifest(candidate, value => { value.files.NOTICE = { size: fs.statSync(path.join(candidate, 'NOTICE')).size, sha256: hash(path.join(candidate, 'NOTICE')) }; });
  fs.writeFileSync(path.join(install, 'user-kept.txt'), 'Preserve extra user files.');
  const original = snapshot(install), originalCandidate = snapshot(candidate);
  const originalNotice = fs.readFileSync(path.join(install, 'NOTICE'));
  const installationExe = path.join(install, 'hertz-studio.exe');
  first = service(installationExe, dataA); liveA = await ready(first, dataA);
  rejection(() => update(install, candidate), /install_dir_busy/); assert.deepEqual(snapshot(install), original);
  await liveA.api('/v1/system/shutdown', 'POST'); await exited(first);
  const anotherWriter = await hold(path.join(install, 'hertz-install.lock'));
  rejection(() => update(install, candidate), /install_dir_busy/);
  const packageLaunch = () => powershell('& $env:HERTZ_TEST_LAUNCH -DataDir $env:HERTZ_TEST_DATA -Port 0 -PassThru', { HERTZ_TEST_LAUNCH: path.join(install, 'Launch-Hertz.ps1'), HERTZ_TEST_DATA: blockedData });
  rejection(packageLaunch, /Program directory is updating/); assert(!fs.existsSync(blockedData));
  await release(anotherWriter);
  mark('actual package update rejects a running service and another writer without changing any installed byte');

  const candidateManifest = fs.readFileSync(path.join(candidate, 'standalone-build.json'));
  for (const [edit, pattern] of [
    [value => { value.files.NOTICE.sha256 = '0'.repeat(64); }, /hash mismatch/],
    [value => { value.capabilities.windowsInstallGuard = false; }, /installation guard support/],
    [value => { value.buildId = '0'.repeat(64); }, /Binary descriptor mismatch/],
    [value => { value.version = '0.1.0'; }, /downgrade/],
    [value => { value.files['../outside.txt'] = value.files.NOTICE; delete value.files.NOTICE; }, /Unexpected or missing package files/],
  ]) { updateManifest(candidate, edit); rejection(() => update(install, candidate), pattern); assert.deepEqual(snapshot(install), original); fs.writeFileSync(path.join(candidate, 'standalone-build.json'), candidateManifest); }
  rejection(() => update(install, install), /separate, non-nested/);
  fs.appendFileSync(path.join(install, 'NOTICE'), '\nUser modification.'); const edited = snapshot(install);
  rejection(() => update(install, candidate), /hash mismatch/); assert.deepEqual(snapshot(install), edited);
  fs.writeFileSync(path.join(install, 'NOTICE'), originalNotice);
  const outside = await hold(path.join(install, 'NOTICE'), false);
  rejection(() => update(install, candidate), /used by another process|使用|进程/i); assert.deepEqual(snapshot(install), original); await release(outside);
  assert(!fs.existsSync(path.join(install, 'hertz-update-incomplete.json')));
  mark('corrupt candidate, old guard protocol, downgrade, traversal, nested paths, modified installation and external file occupancy all reject before replacement');

  const injection = exitProcess => '$script:noticeReplaced=$false; function Move-HertzInstallFile([string]$Source,[string]$Destination) { '
    + (exitProcess ? '' : 'if($script:noticeReplaced){$script:noticeReplaced=$false; throw "simulated replacement failure"}; ')
    + '[IO.File]::Move($Source,$Destination); if([IO.Path]::GetFileName($Source) -ceq "NOTICE" -and [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($Source)) -ceq "stage") {'
    + (exitProcess ? '[Environment]::Exit(77)' : '$script:noticeReplaced=$true') + '} }; ';
  const injectedCall = injectionScript => powershell('. $env:HERTZ_TEST_UPDATER -InstallDir $env:HERTZ_TEST_INSTALL; ' + injectionScript + 'Invoke-HertzPackageUpdate $env:HERTZ_TEST_INSTALL $env:HERTZ_TEST_CANDIDATE $false ([bool]([int]$env:HERTZ_TEST_DEBUG)) | ConvertTo-Json -Compress', { HERTZ_TEST_UPDATER: updater, HERTZ_TEST_INSTALL: install, HERTZ_TEST_CANDIDATE: candidate, HERTZ_TEST_DEBUG: allowDebug ? '1' : '0' });
  const publicationInjection = (after, code) => 'function Move-HertzInstallFile([string]$Source,[string]$Destination) { '
    + (after ? '[IO.File]::Move($Source,$Destination); if([IO.Path]::GetFileName($Destination) -ceq "hertz-update-incomplete.json") {' : 'if([IO.Path]::GetFileName($Source) -ceq "journal.json") {')
    + '[Environment]::Exit(' + code + ') }; ' + (after ? '' : '[IO.File]::Move($Source,$Destination); ') + '}; ';
  assert.throws(() => injectedCall(publicationInjection(false, 78)), error => error.status === 78);
  assert.deepEqual(snapshot(install), original); assert(!fs.existsSync(path.join(install, 'hertz-update-incomplete.json')));
  const prePublicationOrphans = new Set(fs.readdirSync(install).filter(name => name.startsWith('.hertz-update-')));
  first = service(installationExe, dataA); liveA = await ready(first, dataA); await liveA.api('/v1/system/shutdown', 'POST'); await exited(first);
  assert.throws(() => injectedCall(publicationInjection(true, 79)), error => error.status === 79);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(install, 'hertz-update-incomplete.json'), 'utf8')));
  assert.equal(update(install, undefined, true).status, 'restored'); assert.deepEqual(snapshot(install), original);
  mark('crashes before journal publication leave the original runnable; crashes immediately after publication always expose a complete recoverable journal');
  rejection(() => injectedCall(injection(false)), /simulated replacement failure/);
  assert.deepEqual(snapshot(install), original); assert(!fs.existsSync(path.join(install, 'hertz-update-incomplete.json')));
  mark('a failure after replacing NOTICE restores the complete original package and removes its incomplete marker');

  assert.throws(() => injectedCall(injection(true)), error => error.status === 77);
  const marker = path.join(install, 'hertz-update-incomplete.json'); assert(fs.existsSync(marker));
  rejection(packageLaunch, /previous update was interrupted/);
  const incomplete = service(installationExe, blockedData); await exited(incomplete); assert.match(incomplete.err, /install_recovery_required/); assert(!fs.existsSync(blockedData));
  const journalBytes = fs.readFileSync(marker), journal = JSON.parse(journalBytes);
  fs.writeFileSync(marker, JSON.stringify({ ...journal, transaction: '../outside' })); rejection(() => update(install, undefined, true), /Invalid recovery marker/); fs.writeFileSync(marker, journalBytes);
  const recoveryBlocker = await hold(path.join(install, 'NOTICE'), false);
  rejection(() => update(install, undefined, true), /used by another process|使用|进程/i); assert(fs.existsSync(marker));
  assert(fs.existsSync(path.join(install, journal.transaction, 'backup/NOTICE'))); await release(recoveryBlocker);
  assert.equal(update(install, undefined, true).status, 'restored'); assert.deepEqual(snapshot(install), original);
  mark('abrupt updater exit blocks business startup; malformed recovery paths reject, blocked recovery preserves originals, explicit retry restores the complete package');

  assert.equal(update(install, candidate).status, 'updated');
  const expected = { ...originalCandidate, 'user-kept.txt': original['user-kept.txt'] }; assert.deepEqual(snapshot(install), expected);
  assert.deepEqual(snapshot(candidate), originalCandidate); assert(!fs.readdirSync(install).some(name => name.startsWith('.hertz-update-') && !prePublicationOrphans.has(name)));
  first = service(installationExe, dataA); liveA = await ready(first, dataA);
  await liveA.api('/v1/system/shutdown', 'POST'); await exited(first); assert.deepEqual(snapshot(install), expected);
  mark('successful replacement exactly matches the pinned candidate, preserves unrelated files/source, removes transaction and restarts the actual player');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, binarySha256: hash(binary), description,
    archive: packaged.archive, archiveSha256: packaged.sha256, signatureStatus: packaged.manifest.signatureStatus,
    sourceSha256: Object.fromEntries(['crates/hertz-studio/src/install_owner.rs', 'crates/hertz-studio/src/main.rs', 'crates/hertz-studio/src/build_info.rs', 'scripts/windows/Update-Hertz.ps1', 'scripts/windows/Launch-Hertz.ps1', 'scripts/package-standalone-windows.js', 'scripts/check-install-owner-native.js'].map(file => [file, hash(path.join(root, file))])),
    limitations: ['single Windows host, null audio', 'local candidate; altered NOTICE is an update fixture, not publisher authentication', 'no NSIS, remote/signature update, database downgrade or power-loss qualification'],
  }, null, 2)); console.log('Evidence: ' + output);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { for (const processChild of owned) { try { processChild.kill(); } catch {} } });
