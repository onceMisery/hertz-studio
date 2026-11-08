#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Native desktop startup and offline lifecycle in owned isolated roots only.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const native = require('./desktop-native-management-client');
const root = path.resolve(__dirname, '..');
const binary = process.env.HERTZ_BIN || path.join(root, 'target/debug/hertz-studio.exe');
const desktop = process.env.HERTZ_DESKTOP_BIN || path.join(path.dirname(binary), 'hertz-desktop.exe');
const output = path.join(root, 'output/wallpaper-upgrade-' + Date.now());
const marker = 'database-upgrade-incomplete.json';
const reset = 'wallpaper-export-reset.pending';
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const owned = new Set(), checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pass = value => { checks.push(value); console.log('PASS ' + value); };
async function until(read, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(15); }
  throw new Error('Timeout: ' + label);
}
function launch(file, args, data) {
  const child = spawn(file, args, {cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
    ...process.env, HERTZ_DESKTOP_CONFIG_DIR: data, WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview2'),
    VMUSIC_DATA_DIR: path.join(output, 'music-profile'), VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', PYTHONUTF8: '1'
  }});
  owned.add(child); child.out = ''; child.err = '';
  child.stdout.on('data', bytes => { child.out += bytes; });
  child.stderr.on('data', bytes => { child.err += bytes; });
  child.on('error', error => { child.failure = error; });
  return child;
}
async function exit(child, expected) {
  await until(() => { if (child.failure) throw child.failure; return child.exitCode !== null || child.signalCode !== null; }, 'process exit');
  owned.delete(child);
  if (expected !== undefined) assert.equal(child.exitCode, expected, child.err);
  return child;
}
async function stop(child) { if (child.exitCode === null && child.signalCode === null) child.kill(); await exit(child); }
async function reject(child, expression) {
  await exit(child); assert.notEqual(child.exitCode, 0, child.out); assert.match(child.err, expression);
}
function python(request, held = false) {
  const child = launch(process.env.PYTHON_BIN || 'python', [path.join(__dirname, 'wallpaper-upgrade-fixture.py')], request.data);
  child.stdin.write(JSON.stringify({root, ...request}) + '\n'); if (!held) child.stdin.end(); return child;
}
async function sql(data, statement, action = 'query', image) {
  return JSON.parse((await exit(python({data, sql: statement, action, ...(image ? {image} : {})}), 0)).out);
}
async function fixture(name, count = 5, alteration) {
  const data = path.join(output, name);
  await exit(python({data, count, alteration, action: 'fixture'}), 0);
  assert(fs.existsSync(path.join(data, 'wallpaper.db')), 'exact Unicode fixture path');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({schemaVersion:5, revision:1, launchAtLogin:false, activeProfile:null, profiles:[], lastCommit:null}));
  for (const directory of ['packages/original/empty', 'staging/unfinished', 'derived/generation', 'operations']) fs.mkdirSync(path.join(data, directory), {recursive:true});
  for (const file of ['packages/original/original.hwpkg', 'staging/unfinished/original.hwpkg', 'derived/generation/image']) fs.writeFileSync(path.join(data, file), 'original ' + file);
  return data;
}
async function cli(data, args, file = binary) { return exit(launch(file, [...args, '--desktop-root', data], data), 0); }
async function backups(data, file) { return JSON.parse((await cli(data, ['--wallpaper-list-upgrade-backups'], file)).out).snapshots; }
function host(data) { return launch(desktop, ['--settings', '--data-dir', path.join(output, 'music-profile')], data); }
async function ready(child) {
  return until(async () => { assert.equal(child.exitCode, null, child.err); try { const status = await native(pipe, {command:'status'}); return status.ok && status; } catch { return null; } }, 'native host ready');
}
async function quit(child) { const response = await native(pipe, {command:'quit'}); assert.equal(response.ok, true); await exit(child, 0); }
async function main() {
  assert.equal(process.platform, 'win32'); fs.mkdirSync(output, {recursive:true});
  // Do not issue management commands to a pre-existing user host.
  let occupied = false; try { await native(pipe, {command:'status'}); occupied = true; } catch {}
  assert(!occupied, 'another desktop host is running; leave it untouched and stop it before this isolated check');
  const data = await fixture('资料 profile');
  const beforeConfig = fs.readFileSync(path.join(data, 'config.json'));
  const writer = python({data, action:'writer'}, true);
  await until(() => writer.out.includes('ready'), 'legacy committed WAL');
  await reject(host(data), /desktop_legacy_busy/);
  assert.equal(fs.readFileSync(path.join(data, 'config.json')).toString(), beforeConfig.toString());
  assert(!fs.existsSync(path.join(data, 'upgrade-backups')));
  await stop(writer); // Preserve committed WAL while releasing the legacy handles.
  assert(fs.existsSync(path.join(data, 'wallpaper.db-wal')));
  const child = host(data); await ready(child);
  await reject(launch(binary, ['--wallpaper-recover-upgrade', '--desktop-root', data], data), /desktop_root_busy/);
  await quit(child);
  const initial = (await backups(data))[0], directory = path.join(data, 'upgrade-backups', initial.id);
  assert.equal(initial.currentSchema, 5);
  assert.deepEqual(await sql(data, "SELECT title FROM works WHERE work_key='fixture'", 'query', path.join(directory, 'database.db')), [['Committed WAL']]);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'snapshot.json')));
  assert.deepEqual(manifest.resources.map(resource => resource.original), ['packages','staging','derived','config.json','operations']);
  assert.equal(fs.readFileSync(path.join(directory, 'resources/3')).toString(), beforeConfig.toString());
  assert.equal(fs.readFileSync(path.join(directory, 'resources/0/original/original.hwpkg'), 'utf8'), 'original packages/original/original.hwpkg');
  assert(!fs.existsSync(path.join(data, marker)));
  assert.equal((await backups(data, desktop))[0].id, initial.id);
  pass('real native v5→v6 upgrade includes committed WAL, original/staged/derived resources and pre-config state; live host blocks maintenance; both binaries share offline commands');

  const fresh = path.join(output, 'lazy-fresh'); const lazy = host(fresh); await ready(lazy);
  assert(!fs.existsSync(path.join(fresh, 'wallpaper.db')), 'settings/capability path must keep fresh library lazy');
  await quit(lazy);
  assert.equal((await backups(fresh)).length, 0);
  pass('fresh host keeps wallpaper DB lazy and releases admission on graceful exit');

  await sql(data, "UPDATE works SET title='After'", 'execute');
  fs.writeFileSync(path.join(data, 'config.json'), 'later config');
  fs.writeFileSync(path.join(data, 'derived/generation/image'), 'later derivative');
  fs.unlinkSync(path.join(data, 'staging/unfinished/original.hwpkg'));
  const restored = JSON.parse((await cli(data, ['--wallpaper-restore-upgrade-backup', initial.id, '--accept-data-loss'])).out);
  assert.equal(fs.readFileSync(path.join(data, 'config.json')).toString(), beforeConfig.toString());
  assert(fs.existsSync(path.join(data, 'staging/unfinished/original.hwpkg')));
  assert(fs.existsSync(path.join(data, 'packages/original/empty')));
  assert.deepEqual(await sql(data, "SELECT title FROM works WHERE work_key='fixture'"), [['Committed WAL']]);
  assert(fs.existsSync(path.join(data, reset)));
  await cli(data, ['--wallpaper-restore-upgrade-backup', restored.rescueSnapshotId, '--accept-data-loss']);
  assert.deepEqual(await sql(data, "SELECT title FROM works WHERE work_key='fixture'"), [['After']]);
  assert.equal(fs.readFileSync(path.join(data, 'config.json'), 'utf8'), 'later config');
  assert.equal(fs.readFileSync(path.join(data, 'derived/generation/image'), 'utf8'), 'later derivative');
  pass('explicit history restores all resource/config state and preserves later state in a rescue snapshot; external export recovery barrier survives rollback');

  fs.unlinkSync(path.join(data, reset)); // Fixture starts a distinct invalid-request case.
  const beforeHash = hash(path.join(data, 'wallpaper.db'));
  await reject(launch(binary, ['--wallpaper-restore-upgrade-backup','../outside','--accept-data-loss','--desktop-root',data], data), /database_backup_id/);
  const manifestPath = path.join(directory, 'snapshot.json'), originalManifest = fs.readFileSync(manifestPath);
  manifest.sourceDir = path.join(output, 'other'); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await reject(launch(desktop, ['--wallpaper-restore-upgrade-backup',initial.id,'--accept-data-loss','--desktop-root',data], data), /database_backup_profile/);
  fs.writeFileSync(manifestPath, originalManifest);
  fs.writeFileSync(path.join(directory, 'resources/0/original/original.hwpkg'), 'tampered');
  await reject(launch(binary, ['--wallpaper-restore-upgrade-backup',initial.id,'--accept-data-loss','--desktop-root',data], data), /database_backup_hash/);
  assert(!fs.existsSync(path.join(data, reset))); assert(!fs.existsSync(path.join(data, marker))); assert.equal(hash(path.join(data,'wallpaper.db')), beforeHash);
  const summaries = await backups(data); assert(summaries.find(entry => entry.id === initial.id).verificationError);
  assert(summaries.some(entry => !entry.verificationError));
  pass('invalid ID, cross-profile and tampered snapshots do not revoke exports or alter current DB; list retains healthy entries');

  for (const [name, count, alteration, error] of [
    ['future',6,'UPDATE _sqlx_migrations SET version=99 WHERE version=6;',/database_version_too_new/],
    ['dirty',5,'UPDATE _sqlx_migrations SET success=0 WHERE version=5;',/database_migration_incomplete/],
    ['checksum',5,"UPDATE _sqlx_migrations SET checksum=X'00' WHERE version=5;",/database_migration_mismatch/],
    ['prefix',5,'DELETE FROM _sqlx_migrations WHERE version=3;',/database_migration_mismatch/]
  ]) {
    const invalid = await fixture(name,count,alteration), configHash = hash(path.join(invalid,'config.json'));
    await reject(host(invalid), error); assert.equal(hash(path.join(invalid,'config.json')), configHash); assert(!fs.existsSync(path.join(invalid,'webview2'))); assert(!fs.existsSync(path.join(invalid,'upgrade-backups')));
  }
  const corrupt = await fixture('corrupt'); fs.writeFileSync(path.join(corrupt,'wallpaper.db'),'not SQLite'); await reject(host(corrupt), /file is not a database/);
  pass('future/dirty/checksum/missing-prefix/corrupt databases reject before config and WebView startup');

  const broken = await fixture('partial failure',3,'CREATE TABLE export_jobs(conflict TEXT);'), brokenConfig = hash(path.join(broken,'config.json'));
  await reject(host(broken), /database_upgrade_failed/);
  assert.deepEqual(await sql(broken,'SELECT max(version) FROM _sqlx_migrations'),[[3]]);
  assert.deepEqual(await sql(broken,"SELECT count(*) FROM sqlite_master WHERE name='work_drafts'"),[[0]]);
  assert.equal(hash(path.join(broken,'config.json')),brokenConfig); assert(!fs.existsSync(path.join(broken,marker)));
  pass('real v4 commit followed by v5 failure restores v3 and resource/config state before starting UI');

  const interrupted = await fixture('interrupted');
  // A real historical restore has a full staging interval after publication.
  // Fast optimized migrations can clear their marker before fs.watch's callback
  // runs; do not count observing an already-completed migration as a crash.
  fs.writeFileSync(path.join(interrupted,'packages/original/crash-window'), Buffer.alloc(32 * 1024 * 1024, 1));
  const prepared = host(interrupted); await ready(prepared); await quit(prepared);
  const crashSnapshot = (await backups(interrupted))[0];
  let observed, upgrading;
  const watcher = fs.watch(interrupted, (event, name) => {
    if (String(name) !== marker) return;
    try { observed = JSON.parse(fs.readFileSync(path.join(interrupted,marker))); } catch { return; }
    if (upgrading) upgrading.kill();
  });
  try {
    upgrading = launch(binary,['--wallpaper-restore-upgrade-backup',crashSnapshot.id,'--accept-data-loss','--desktop-root',interrupted],interrupted);
    await exit(upgrading);
  }
  finally { watcher.close(); }
  assert(observed, 'complete published marker must be observed before killing owned process');
  assert(fs.existsSync(path.join(interrupted,marker)), 'owned process must stop before marker clearance');
  await reject(host(interrupted), /database_recovery_required/);
  await cli(interrupted,['--wallpaper-recover-upgrade']);
  assert.deepEqual(await sql(interrupted,'SELECT max(version) FROM _sqlx_migrations'),[[5]]);
  assert(!fs.existsSync(path.join(interrupted,marker)));
  // Replay the valid crash marker with DB already displaced and a bad destination.
  fs.renameSync(path.join(interrupted,'wallpaper.db'),path.join(interrupted,'held.db'));
  fs.writeFileSync(path.join(interrupted,marker),JSON.stringify(observed));
  fs.renameSync(path.join(interrupted,'staging'),path.join(interrupted,'staging-held'));
  fs.writeFileSync(path.join(interrupted,'staging'),'blocked');
  await reject(launch(binary,['--wallpaper-recover-upgrade','--desktop-root',interrupted],interrupted),/database_recovery_path/);
  assert(fs.existsSync(path.join(interrupted,marker))); assert(fs.existsSync(path.join(interrupted,'held.db')));
  fs.unlinkSync(path.join(interrupted,'staging')); fs.renameSync(path.join(interrupted,'staging-held'),path.join(interrupted,'staging'));
  await cli(interrupted,['--wallpaper-recover-upgrade'],desktop);
  assert.deepEqual(await sql(interrupted,'SELECT max(version) FROM _sqlx_migrations'),[[5]]);
  assert(fs.existsSync(path.join(interrupted,'held.db')));
  pass('real offline restore process killed after complete marker publication refuses host restart; recovery and retry preserve displaced data and complete resources');

  const report = {binary,desktop,sha256:hash(binary),desktopSha256:hash(desktop),checks,sourceSha256:{}};
  for(const file of ['crates/hertz-sqlite-lifecycle/Cargo.toml','crates/hertz-sqlite-lifecycle/src/lib.rs','crates/hertz-sqlite-lifecycle/src/tests.rs','crates/hertz-desktop/Cargo.toml','crates/hertz-desktop/src/root_owner.rs','crates/hertz-desktop/src/wallpaper_upgrade.rs','crates/hertz-desktop/src/wallpaper_upgrade/tests.rs','crates/hertz-desktop/src/wallpaper/library.rs','crates/hertz-desktop/src/wallpaper/assets.rs','crates/hertz-desktop/src/wallpaper/export_jobs.rs','crates/hertz-desktop/src/wallpaper/content_quota.rs','crates/hertz-desktop/src/config.rs','crates/hertz-desktop/src/config_journal.rs','crates/hertz-desktop/src/app.rs','crates/hertz-desktop/src/lib.rs','crates/hertz-desktop/src/main.rs','crates/hertz-studio/src/main.rs','scripts/check-wallpaper-upgrade.js','scripts/wallpaper-upgrade-fixture.py',...fs.readdirSync(path.join(root,'crates/hertz-desktop/migrations/wallpaper')).map(file=>'crates/hertz-desktop/migrations/wallpaper/'+file)]) report.sourceSha256[file]=hash(path.join(root,file));
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)); console.log('Evidence: '+path.join(output,'report.json'));
}
main().catch(error => { console.error(error.stack); process.exitCode=1; }).finally(async () => { for(const child of owned) await stop(child).catch(()=>{}); });
