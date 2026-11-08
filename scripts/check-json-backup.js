#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real standalone HTTP and DBX SDK JSON round trips in owned profiles only.
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
const output = path.join(root, 'output/json-backup-' + Date.now());
const owned = new Set(), checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pass = message => { checks.push(message); console.log('PASS ' + message); };
async function until(read, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(20); }
  throw new Error('Timed out: ' + label);
}
function launch(file, args, data) {
  const child = spawn(file, args, { cwd: root, windowsHide: true, stdio: ['pipe','pipe','pipe'],
    env: { ...process.env, VMUSIC_DATA_DIR: data, DBX_PLUGIN_DATA_DIR: data,
      VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', VMUSIC_LOG: 'error', PYTHONUTF8: '1',
      HERTZ_DESKTOP_CONFIG_DIR: path.join(output, 'desktop') } });
  owned.add(child); child.out = ''; child.err = '';
  child.stdout.on('data', chunk => { child.out += chunk; });
  child.stderr.on('data', chunk => { child.err += chunk; });
  child.on('error', error => { child.failure = error; });
  return child;
}
async function exited(child, expected = 0) {
  await until(() => { if (child.failure) throw child.failure; return child.exitCode !== null || child.signalCode !== null; }, 'owned process exit');
  owned.delete(child); assert.equal(child.exitCode, expected, child.err); return child;
}
async function python(data, action, sql) {
  const child = launch(process.env.PYTHON_BIN || 'python', [path.join(__dirname, 'database-upgrade-fixture.py')], data);
  child.stdin.end(JSON.stringify({ root, data, action, sql,
    count: fs.readdirSync(path.join(root, 'migrations')).filter(file => file.endsWith('.sql')).length }) + '\n');
  return JSON.parse((await exited(child)).out);
}
async function fixture(name) {
  const data = path.join(output, name); await python(data, 'fixture'); return data;
}
async function http(data) {
  const child = launch(binary, ['--bind','127.0.0.1','--port','0','--data-dir',data], data);
  const discovery = await until(() => {
    assert.equal(child.exitCode, null, child.err);
    try { const value = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'), 'utf8')); return value.pid === child.pid && value; } catch { return null; }
  }, 'HTTP discovery');
  const request = async (endpoint, op = 'GET', body) => {
    const response = await fetch('http://127.0.0.1:' + discovery.port + endpoint, { method: op,
      headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/v1/health')).status, 200);
  return { child, request, stop: async () => { assert.equal((await request('/v1/system/shutdown','POST',{})).status,200); await exited(child); } };
}
let sequence = 0;
async function rpc(child, method, params) {
  const id = ++sequence; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const reply = await until(() => {
    assert.equal(child.exitCode, null, child.err);
    for (const line of child.out.split('\n')) { try { const value = JSON.parse(line); if (value.id === id) return value; } catch {} }
  }, 'SDK ' + method);
  assert(!reply.error, JSON.stringify(reply.error)); return reply.result;
}
async function sdk(data) {
  const child = launch(plugin, [], data);
  assert.equal((await rpc(child, 'plugin/initialize', { host: { hostApiVersion:'1.4.0', protocolVersions:[1], features:[] } })).protocolVersion,1);
  const request = (endpoint, op = 'GET', body) => rpc(child, endpoint.replace(/^\//,''), { op, body });
  assert.equal((await request('/v1/health')).status,200);
  return { child, request, stop: async () => { child.stdin.end(); await exited(child); } };
}
const secretPrefixes = ['online_cred_','online_cookie_','online_device_','remote_cred_'];
async function seed(data) {
  await python(data, 'execute', `BEGIN IMMEDIATE;
    INSERT INTO playlists(id,name,created_at,updated_at) VALUES
      ('a','First',1,1),('b','Second',2,2),('c','Empty',3,3),('d','First',4,4);
    INSERT INTO playlist_tracks(playlist_id,track_id,position,source,title,artist,album,duration_ms,cover) VALUES
      ('a','shared',1,'online','Snapshot A','Artist A','Album A',100,'https://example.com/a.jpg'),
      ('b','shared',0,'online','Snapshot B','Artist B','Album B',200,'https://example.com/b.jpg');
    INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES ('a','fixture-track',0);
    INSERT INTO favorites(id,kind,source,ref_id,title,added_at,updated_at)
      VALUES ('track:online:shared','track','online','shared','Favorite',1,1);
    INSERT INTO settings(key,value,updated_at) VALUES
      ('backup_generation','"coherent"',1),('online_cred_fixture','"private-cookie"',1),
      ('online_cookie_fixture','"private-cookie"',1),('online_device_fixture','"private-device"',1),
      ('remote_cred_fixture','"private-remote"',1);
    INSERT INTO scan_roots(path,enabled) VALUES ('D:/music',1),('D:/offline',0);
    COMMIT;`);
  const keys = await python(data, 'query', "SELECT key FROM settings WHERE key IN ('online_cred_fixture','online_cookie_fixture','online_device_fixture','remote_cred_fixture')");
  assert.equal(keys.length,4,'credential-exclusion fixture remains present at export time');
}
function verifyBackup(backup, source) {
  assert.equal(backup.version,1);
  const first = backup.playlists.filter(item => item.name === 'First');
  assert.equal(first.length,source ? 2 : 1);
  assert.deepEqual(first[0].tracks.map(track => track.track_id),['fixture-track','shared']);
  assert.equal(first[0].tracks[0].source,null);
  const a = first[0].tracks[1], b = backup.playlists.find(item => item.name === 'Second').tracks[0];
  for (const [track,tag,duration] of [[a,'A',100],[b,'B',200]]) {
    assert.equal(track.title,'Snapshot '+tag); assert.equal(track.artist,'Artist '+tag);
    assert.equal(track.album,'Album '+tag); assert.equal(track.duration_ms,duration);
    assert.equal(track.cover,'https://example.com/'+tag.toLowerCase()+'.jpg');
  }
  assert.deepEqual(backup.playlists.find(item => item.name === 'Empty').tracks,[]);
  if (source) assert.deepEqual(first[1].tracks,[]);
  assert.equal(backup.favorites[0].title,'Favorite');
  assert.equal(backup.settings.backup_generation,'coherent');
  assert.deepEqual(backup.scan_roots,[['D:/music',true],['D:/offline',false]]);
  assert(!Object.keys(backup.settings).some(key => secretPrefixes.some(prefix => key.startsWith(prefix))));
  assert(!JSON.stringify(backup).includes('private-cookie'));
}
const stable = backup => ({ ...backup, exported_at: 0 });
async function roundTrip(source, target, label) {
  const exported = await source.request('/v1/backup'); assert.equal(exported.status,200);
  verifyBackup(exported.body,true);
  pass(label+' export retains empty/same-name playlists, membership metadata, v1 tuple roots and excludes all four credential prefixes');
  const restored = await target.request('/v1/backup/restore','POST',exported.body);
  assert.equal(restored.status,200,JSON.stringify(restored.body));
  assert.equal(restored.body.playlists_created,3); assert.equal(restored.body.playlists_merged,1);
  assert.equal(restored.body.tracks_added,3); assert.equal(restored.body.favorites_added,1);
  assert.equal(restored.body.roots_applied,2);
  verifyBackup((await target.request('/v1/backup')).body,false);
  const again = await target.request('/v1/backup/restore','POST',exported.body);
  assert.equal(again.status,200); assert.equal(again.body.tracks_added,0); assert.equal(again.body.favorites_added,0);
  pass(label+' restore accepts actual serialized v1 output, preserves per-playlist snapshots and keeps name-based merge/idempotence');
  const before = (await target.request('/v1/backup')).body;
  const bad = structuredClone(exported.body); bad.version = 99; bad.settings.invalid_probe = true;
  assert((await target.request('/v1/backup/restore','POST',bad)).status >= 400);
  assert.deepEqual(stable((await target.request('/v1/backup')).body),stable(before));
  pass(label+' unsupported version rejects without applying any business data');
}
async function main() {
  fs.mkdirSync(output,{recursive:true});
  const sourceData = await fixture('HTTP source'), targetData = await fixture('HTTP target');
  const source = await http(sourceData), target = await http(targetData);
  await seed(sourceData); await roundTrip(source,target,'HTTP');
  await source.stop(); await target.stop();
  const sdkData = await fixture('SDK source'), sdkTargetData = await fixture('SDK target');
  const sdkSource = await sdk(sdkData), sdkTarget = await sdk(sdkTargetData);
  await seed(sdkData); await roundTrip(sdkSource,sdkTarget,'DBX SDK');
  for (const data of [sdkData,sdkTargetData]) {
    assert(!fs.existsSync(path.join(data,'vmusicd.json')));
    assert(!fs.existsSync(path.join(data,'webview')));
  }
  await sdkSource.stop(); await sdkTarget.stop();
  pass('SDK keeps JSON-RPC stdio without HTTP/WebView and EOF closes both owned services');
  const sourceFiles = ['crates/vmusic-store/src/backup.rs','crates/vmusic-store/src/settings.rs',
    'crates/hertz-studio/src/rpc/maintenance.rs','crates/hertz-studio/src/routes.rs',
    'plugin/backend/src/main.rs','scripts/check-json-backup.js','scripts/database-upgrade-fixture.py'];
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({checks,binarySha256:sha(binary),pluginSha256:sha(plugin),
    sourceSha256:Object.fromEntries(sourceFiles.map(file => [file,sha(path.join(root,file))])),
    limitations:['private owned profiles','null audio','WAL concurrent generation verified separately in Rust storage test']},null,2));
  console.log('Evidence: '+output);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const child of owned) { if (child.exitCode === null && child.signalCode === null) child.kill();
    await until(() => child.exitCode !== null || child.signalCode !== null,'fixture cleanup').catch(() => {}); }
});
