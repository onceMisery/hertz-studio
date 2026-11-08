#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real SQLite fixtures and HTTP/SDK/offline processes in private test profiles.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const suffix = process.platform === 'win32' ? '.exe' : '';
const binary = process.env.HERTZ_BIN || path.join(root, 'target/debug/hertz-studio' + suffix);
const plugin = process.env.HERTZ_PLUGIN_BIN || path.join(path.dirname(binary), 'dbx-plugin-hertz' + suffix);
const output = path.join(root, 'output/database-upgrade-' + Date.now());
const marker = 'database-upgrade-incomplete.json';
const owned = new Set(), checks = [];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const mark = message => { checks.push(message); console.log('PASS ' + message); };
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(15); }
  throw new Error('Timed out: ' + label);
}
function launch(file, args, data, extra = {}) {
  const child = spawn(file, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, VMUSIC_DATA_DIR: data, DBX_PLUGIN_DATA_DIR: data, VMUSIC_BACKEND: 'null',
      VMUSIC_SECRETS: 'memory', VMUSIC_LOG: 'error', PYTHONUTF8: '1', HERTZ_DESKTOP_CONFIG_DIR: path.join(output, 'desktop'), ...extra } });
  child.out = ''; child.err = ''; owned.add(child);
  child.stdout.on('data', chunk => { child.out += chunk.toString(); });
  child.stderr.on('data', chunk => { child.err += chunk.toString(); });
  child.on('error', error => { child.failure = error; });
  return child;
}
async function exited(child, expected) {
  await until(() => { if (child.failure) throw child.failure; return child.exitCode !== null || child.signalCode !== null; }, 'process exit');
  owned.delete(child);
  if (expected !== undefined) assert.equal(child.exitCode, expected, child.err);
  return child;
}
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exited(child);
}
function service(data) { return launch(binary, ['--bind', '127.0.0.1', '--port', '0', '--data-dir', data], data); }
async function ready(child, data) {
  const doc = await until(() => {
    assert.equal(child.exitCode, null, child.err);
    try { const value = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'), 'utf8')); return value.pid === child.pid && value; } catch { return null; }
  }, 'HTTP discovery', 60000);
  const api = async (endpoint, method = 'GET', body, status = 200) => {
    const response = await fetch('http://127.0.0.1:' + doc.port + endpoint, { method,
      headers: { Authorization: 'Bearer ' + doc.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  await api('/v1/health'); return api;
}
async function cli(data, args, expected = 0) {
  return exited(launch(binary, [...args, '--data-dir', data], data), expected);
}
async function reject(child, error, nonzero = true) {
  await exited(child);
  if (nonzero) assert.notEqual(child.exitCode, 0, child.out);
  else { assert.equal(child.exitCode, 0); assert.equal(child.out, '', 'DBX rejected bootstrap must not start SDK output'); }
  assert.match(child.err, error);
}
function python(request, writer = false) {
  const child = launch(process.env.PYTHON_BIN || 'python', [path.join(__dirname, 'database-upgrade-fixture.py')], request.data);
  child.stdin.write(JSON.stringify({ root, ...request }) + '\n');
  if (!writer) child.stdin.end();
  return child;
}
async function sql(data, sql, action = 'query', image) {
  const child = await exited(python({ data, sql, action, image }), 0); return JSON.parse(child.out);
}
async function fixture(name, count = 28, alteration) {
  const data = path.join(output, name); await exited(python({ data, count, alteration, action: 'fixture' }), 0);
  assert(fs.existsSync(path.join(data, 'vmusic.db')), 'fixture must exist at the exact requested path');
  return data;
}
async function backups(data) { return JSON.parse((await cli(data, ['--list-upgrade-backups'])).out).snapshots; }
function asset(data, name, bytes) {
  const target = path.join(data, 'stage-media/objects', name, 'source'); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); return target;
}
function cleanBootstrap(data) {
  for (const name of ['config.toml', 'token', 'vmusicd.json', 'webview', 'cache']) assert(!fs.existsSync(path.join(data, name)), name + ' appeared before admission');
}
async function rpc(child, method, params, id) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return until(() => {
    assert.equal(child.exitCode, null, child.err);
    for (const line of child.out.split('\n')) { try { const value = JSON.parse(line); if (value.id === id) return value; } catch {} }
  }, 'DBX ' + method);
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const describe = JSON.parse((await exited(launch(binary, ['--describe'], output), 0)).out);
  assert.equal(describe.databaseSchemaVersion, 29);
  assert.match((await exited(launch(binary, ['--help'], output), 0)).out, /--recover-upgrade/);
  const data = await fixture('资料 profile');
  const original = asset(data, 'original', 'before media');
  fs.mkdirSync(path.join(data, 'stage-media/objects/empty'), { recursive: true });
  const writer = python({ data, action: 'writer' }, true);
  await until(() => writer.out.includes('ready'), 'committed WAL');
  const child = service(data), api = await ready(child, data);
  writer.stdin.end('\n'); await exited(writer, 0);
  const occupied = launch(binary, ['--recover-upgrade', '--data-dir', data], data);
  await reject(occupied, /data_dir_busy/);
  await api('/v1/system/shutdown', 'POST', {}, 200); await exited(child, 0);
  let snapshots = await backups(data); assert.equal(snapshots.length, 1);
  const initial = snapshots[0], directory = path.join(data, 'upgrade-backups', initial.id);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'snapshot.json'), 'utf8'));
  assert.equal(initial.currentSchema, 28); assert.equal(manifest.sourceDir.toLowerCase().replace(/^\\\\\?\\/, ''), data.toLowerCase());
  assert.deepEqual(await sql(data, "SELECT value FROM settings WHERE key='wal_only'", 'query', path.join(directory, 'database.db')), [['"committed"']]);
  assert.deepEqual(await sql(data, 'SELECT MAX(version) FROM _sqlx_migrations'), [[29]]);
  assert.equal(fs.readFileSync(path.join(directory, 'resources/0/original/source'), 'utf8'), 'before media');
  assert(!fs.existsSync(path.join(data, marker)));
  const next = service(data); const nextApi = await ready(next, data); await nextApi('/v1/system/shutdown', 'POST', {}, 200); await exited(next, 0);
  assert.equal((await backups(data)).length, 1);
  mark('28→29 real service upgrade includes committed WAL, all tables and original media; current schema restart does not duplicate snapshots; live maintenance is locked');

  const broken = await fixture('partial failure', 27, 'CREATE TABLE stage_media_assets(incompatible TEXT);');
  asset(broken, 'original', 'unchanged');
  await reject(service(broken), /database_upgrade_failed/);
  assert.deepEqual(await sql(broken, 'SELECT MAX(version) FROM _sqlx_migrations'), [[27]]);
  assert.deepEqual(await sql(broken, "SELECT count(*) FROM sqlite_master WHERE name='reader_feeds'"), [[0]]);
  assert.deepEqual(await sql(broken, "SELECT title FROM tracks WHERE id='fixture-track'"), [['Before']]);
  assert.equal(fs.readFileSync(path.join(broken, 'stage-media/objects/original/source'), 'utf8'), 'unchanged');
  assert(!fs.existsSync(path.join(broken, marker)));
  mark('migration 28 commits and 29 fails; automatic recovery restores the complete version-27 database and media');

  for (const [name, alteration, error] of [
    ['future', "INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(999,'future',1,X'00',0)", /database_version_too_new/],
    ['dirty', 'UPDATE _sqlx_migrations SET success=0 WHERE version=1', /database_migration_incomplete/],
    ['checksum', "UPDATE _sqlx_migrations SET checksum=X'00' WHERE version=1", /database_migration_mismatch/],
    ['prefix', 'DELETE FROM _sqlx_migrations WHERE version=2', /database_migration_mismatch/],
    ['corrupt', null, /database|SQLite|file is not a database/]
  ]) {
    const invalid = await fixture(name, 28, alteration);
    if (name === 'corrupt') fs.writeFileSync(path.join(invalid, 'vmusic.db'), 'invalid sqlite fixture');
    const before = sha(path.join(invalid, 'vmusic.db'));
    await reject(service(invalid), error); cleanBootstrap(invalid);
    assert.equal(sha(path.join(invalid, 'vmusic.db')), before);
    await reject(launch(plugin, [], invalid), error, false); cleanBootstrap(invalid);
    assert.equal(sha(path.join(invalid, 'vmusic.db')), before);
  }
  mark('future, dirty, checksum, missing-prefix and corrupt databases reject in standalone and DBX before configuration/token/audio setup; source bytes stay unchanged');

  await sql(data, "UPDATE settings SET value='\"after\"' WHERE key='fixture'; UPDATE tracks SET title='After' WHERE id='fixture-track';", 'execute');
  fs.unlinkSync(original); asset(data, 'later', 'later media');
  await reject(launch(binary, ['--restore-upgrade-backup', initial.id, '--data-dir', data], data), /database_restore_confirmation/);
  const restored = JSON.parse((await cli(data, ['--restore-upgrade-backup', initial.id, '--accept-data-loss'])).out);
  assert.deepEqual(await sql(data, 'SELECT MAX(version) FROM _sqlx_migrations'), [[28]]);
  assert.deepEqual(await sql(data, "SELECT title FROM tracks WHERE id='fixture-track'"), [['Before']]);
  assert.equal(fs.readFileSync(original, 'utf8'), 'before media'); assert(fs.existsSync(path.join(data, 'stage-media/objects/empty')));
  assert(!fs.existsSync(path.join(data, 'stage-media/objects/later')));
  await cli(data, ['--restore-upgrade-backup', restored.rescueSnapshotId, '--accept-data-loss']);
  assert.deepEqual(await sql(data, "SELECT title FROM tracks WHERE id='fixture-track'"), [['After']]);
  assert(!fs.existsSync(original)); assert.equal(fs.readFileSync(path.join(data, 'stage-media/objects/later/source'), 'utf8'), 'later media');
  mark('explicit history restore saves a rescue image, recovers deleted original/empty directories and business rows; rescue restores all later state');

  const beforeTamper = sha(path.join(data, 'vmusic.db'));
  await reject(launch(binary, ['--restore-upgrade-backup', '../outside', '--accept-data-loss', '--data-dir', data], data), /database_backup_id/);
  const manifestPath = path.join(directory, 'snapshot.json'), rawManifest = fs.readFileSync(manifestPath);
  const changed = JSON.parse(rawManifest); changed.sourceDir = path.join(output, 'other'); fs.writeFileSync(manifestPath, JSON.stringify(changed));
  await reject(launch(binary, ['--restore-upgrade-backup', initial.id, '--accept-data-loss', '--data-dir', data], data), /database_backup_profile/);
  fs.writeFileSync(manifestPath, rawManifest);
  const media = path.join(directory, 'resources/0/original/source'); fs.writeFileSync(media, 'altered');
  await reject(launch(binary, ['--restore-upgrade-backup', initial.id, '--accept-data-loss', '--data-dir', data], data), /database_backup_hash/);
  fs.writeFileSync(media, 'before media');
  for (const name of ['database.db-wal', 'database.db-shm', 'database.db-journal', 'unexpected']) {
    const extra = path.join(directory, name); fs.writeFileSync(extra, 'unregistered');
    await reject(launch(binary, ['--restore-upgrade-backup', initial.id, '--accept-data-loss', '--data-dir', data], data), /database_backup_manifest/);
    fs.unlinkSync(extra);
  }
  if (process.platform === 'win32') {
    const resources = path.join(directory, 'resources'), preserved = path.join(directory, 'resources-held');
    fs.renameSync(resources, preserved); fs.symlinkSync(preserved, resources, 'junction');
    await reject(launch(binary, ['--restore-upgrade-backup', initial.id, '--accept-data-loss', '--data-dir', data], data), /database_backup_path/);
    fs.unlinkSync(resources); fs.renameSync(preserved, resources);
  }
  assert.equal(sha(path.join(data, 'vmusic.db')), beforeTamper); assert(!fs.existsSync(path.join(data, marker)));
  mark('traversal, wrong profile, altered resource bytes, SQLite sidecars/root extras and ancestor junctions reject before current data replacement');

  const invalidId = 'upgrade-' + crypto.randomBytes(16).toString('hex');
  const invalidBackup = path.join(data, 'upgrade-backups', invalidId);
  fs.cpSync(directory, invalidBackup, { recursive: true });
  fs.writeFileSync(path.join(invalidBackup, 'snapshot.json'), '{}');
  const listed = await backups(data);
  assert(listed.find(entry => entry.id === invalidId).verificationError);
  assert(!listed.find(entry => entry.id === initial.id).verificationError);
  mark('one corrupt snapshot is reported by ID while healthy recovery and rescue points remain listable');

  if (process.platform === 'win32') {
    const linked = await fixture('linked SQLite sidecars');
    const outside = path.join(output, 'sidecar-target'); fs.mkdirSync(outside);
    const sourceHash = sha(path.join(linked, 'vmusic.db'));
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const entry = path.join(linked, 'vmusic.db' + suffix); fs.symlinkSync(outside, entry, 'junction');
      await reject(service(linked), /database_backup_path/); cleanBootstrap(linked);
      fs.unlinkSync(entry); assert.equal(sha(path.join(linked, 'vmusic.db')), sourceHash);
    }
    assert.deepEqual(fs.readdirSync(outside), []);
    mark('linked SQLite WAL/SHM/journal are rejected before configuration and cannot touch their external targets');
  }

  const blocked = await fixture('blocked backup');
  fs.writeFileSync(path.join(blocked, 'upgrade-backups'), 'not a directory');
  const blockedHash = sha(path.join(blocked, 'vmusic.db'));
  await reject(service(blocked), /database_backup_path/);
  assert.equal(sha(path.join(blocked, 'vmusic.db')), blockedHash);
  mark('snapshot creation failure prevents migrations and preserves original database bytes');

  const interrupted = await fixture('interrupted'); asset(interrupted, 'original', 'recover media');
  const blocker = python({ data: interrupted, action: 'writer', block: true }, true);
  await until(() => blocker.out.includes('ready'), 'write transaction');
  const upgrading = service(interrupted);
  const journal = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(interrupted, marker), 'utf8')); } catch { return null; } }, 'published complete upgrade marker');
  await stop(upgrading); blocker.stdin.end('\n'); await exited(blocker, 0);
  fs.unlinkSync(path.join(interrupted, 'config.toml')); fs.unlinkSync(path.join(interrupted, 'token'));
  await reject(service(interrupted), /database_recovery_required/); cleanBootstrap(interrupted);
  await cli(interrupted, ['--recover-upgrade']);
  assert(!fs.existsSync(path.join(interrupted, marker))); assert.deepEqual(await sql(interrupted, 'SELECT MAX(version) FROM _sqlx_migrations'), [[28]]);
  assert.equal(fs.readFileSync(path.join(interrupted, 'stage-media/objects/original/source'), 'utf8'), 'recover media');
  assert.equal((await backups(interrupted))[0].id, journal.backup);
  cleanBootstrap(interrupted);
  mark('real process killed after complete marker publication is refused at next admission; explicit offline recovery restores version 28 and media without config/token');

  // A failed restore leaves a complete marker. Retrying can restart from a
  // database already displaced by an earlier interrupted recovery attempt.
  const interruptedDb = path.join(interrupted, 'vmusic.db'), held = path.join(interrupted, 'held.db');
  fs.renameSync(interruptedDb, held); fs.writeFileSync(path.join(interrupted, marker), JSON.stringify(journal));
  const objects = path.join(interrupted, 'stage-media/objects'), heldObjects = path.join(interrupted, 'objects-held');
  fs.renameSync(objects, heldObjects); fs.writeFileSync(objects, 'blocked destination');
  await reject(launch(binary, ['--recover-upgrade', '--data-dir', interrupted], interrupted), /database_recovery_path/);
  assert(fs.existsSync(path.join(interrupted, marker))); assert(fs.existsSync(held));
  fs.unlinkSync(objects); fs.renameSync(heldObjects, objects);
  await cli(interrupted, ['--recover-upgrade']);
  assert.deepEqual(await sql(interrupted, 'SELECT MAX(version) FROM _sqlx_migrations'), [[28]]);
  assert(fs.existsSync(held));
  mark('recovery retry tolerates an already-displaced current database and preserves displaced state');

  if (process.platform === 'win32') {
    const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const holder = launch(ps, ['-NoProfile', '-NonInteractive', '-Command',
      "$heldStream = [System.IO.File]::Open($env:HERTZ_CHECK_HELD, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); Write-Output 'ready'; [Console]::ReadLine() | Out-Null; $heldStream.Dispose()"], interrupted,
      { HERTZ_CHECK_HELD: path.join(interrupted, 'stage-media/objects/original/source') });
    await until(() => holder.out.includes('ready'), 'external resource occupancy');
    fs.writeFileSync(path.join(interrupted, marker), JSON.stringify(journal));
    await reject(launch(binary, ['--recover-upgrade', '--data-dir', interrupted], interrupted), /database|拒绝|进程|os error/);
    assert(fs.existsSync(path.join(interrupted, marker)));
    assert(!fs.existsSync(interruptedDb), 'blocked resource move must occur after DB displacement');
    const work = path.join(interrupted, 'upgrade-backups');
    assert(fs.readdirSync(work).some(name => name.startsWith('.restore-') && fs.existsSync(path.join(work, name, 'before-vmusic.db'))));
    await reject(service(interrupted), /database_recovery_required/);
    holder.stdin.end('\n'); await exited(holder, 0);
    await cli(interrupted, ['--recover-upgrade']);
    assert(!fs.existsSync(path.join(interrupted, marker)));
    assert.deepEqual(await sql(interrupted, 'SELECT MAX(version) FROM _sqlx_migrations'), [[28]]);
    assert.equal(fs.readFileSync(path.join(interrupted, 'stage-media/objects/original/source'), 'utf8'), 'recover media');
    mark('real external occupancy blocks resource replacement after DB displacement; complete marker prevents startup, retained files survive and retry succeeds');
  }

  const pluginData = await fixture('dbx'); const sidecar = launch(plugin, [], pluginData);
  const initialized = await rpc(sidecar, 'plugin/initialize', { host: { hostApiVersion: '1.4.0', protocolVersions: [1], features: [] } }, 1);
  assert.equal(initialized.result.protocolVersion, 1);
  assert.equal((await rpc(sidecar, 'v1/health', { op: 'GET' }, 2)).result.status, 200);
  assert(!fs.existsSync(path.join(pluginData, 'vmusicd.json'))); assert(!fs.existsSync(path.join(pluginData, 'webview')));
  await reject(launch(binary, ['--recover-upgrade', '--data-dir', pluginData], pluginData), /data_dir_busy/);
  sidecar.stdin.end(); await exited(sidecar, 0);
  assert.equal((await backups(pluginData)).length, 1);
  mark('DBX upgrades through the same storage owner, keeps SDK stdio and no HTTP/WebView, locks maintenance and releases on EOF');

  await reject(launch(binary, ['--list-upgrade-backups'], output), /explicit --data-dir/);
  await reject(launch(binary, ['--list-upgrade-backups', '--data-dir', path.join(output, 'missing')], output), /existing explicit DataDir/);
  await reject(launch(binary, ['--recover-upgrade', '--window', '--data-dir', data], data), /unsupported offline maintenance option/);
  mark('offline CLI requires explicit existing profile and rejects service/window options');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, binarySha256: sha(binary), pluginSha256: sha(plugin),
    sourceSha256: Object.fromEntries(['crates/hertz-sqlite-lifecycle/src/lib.rs', 'crates/hertz-sqlite-lifecycle/Cargo.toml', 'crates/vmusic-store/src/upgrade.rs', 'crates/hertz-studio/src/bootstrap.rs', 'crates/hertz-studio/src/database_maintenance.rs', 'scripts/check-database-upgrade.js', 'scripts/database-upgrade-fixture.py'].map(file => [file, sha(path.join(root, file))])),
    limitations: ['null audio', 'private fixture profiles', 'single Windows machine', 'process interruption is not physical power-loss qualification', 'independent wallpaper database is outside this suite'] }, null, 2));
  console.log('Evidence: ' + output);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { for (const child of owned) await stop(child).catch(() => {}); });
