#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real HTTP + SDK stdio processes. All profiles belong to this test run.
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
const output = path.join(root, 'output/data-owner-' + Date.now());
const owned = new Set(), checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const mark = message => { checks.push(message); console.log('PASS ' + message); };
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(60); }
  throw new Error('Timed out: ' + label);
}
function launch(file, args, data, extra = {}) {
  const child = spawn(file, args, { cwd: root, windowsHide: true, stdio: ['pipe','pipe','pipe'],
    env: { ...process.env, VMUSIC_DATA_DIR: data, DBX_PLUGIN_DATA_DIR: data, VMUSIC_BACKEND: 'null',
      VMUSIC_SECRETS: 'memory', VMUSIC_LOG: 'error', HERTZ_DESKTOP_CONFIG_DIR: path.join(output, 'desktop'), ...extra } });
  child.out = ''; child.err = ''; owned.add(child);
  child.stdout.on('data', chunk => { child.out += chunk.toString(); });
  child.stderr.on('data', chunk => { child.err += chunk.toString(); });
  child.on('error', error => { child.failure = error; });
  return child;
}
function service(data, options = {}) {
  return launch(options.binary || binary, [...(options.window ? ['--window'] : []), '--bind','127.0.0.1','--port',String(options.port || 0),'--data-dir',data], data);
}
async function exit(child, label, expected) {
  await until(() => { if(child.failure)throw child.failure; return child.exitCode !== null || child.signalCode !== null; }, label, 15000);
  if (expected !== undefined) assert.equal(child.exitCode, expected, label + ': ' + child.err);
  owned.delete(child);
}
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exit(child, 'owned process shutdown');
}
async function ready(child, data) {
  const discovery = await until(() => {
    if (child.failure) throw child.failure;
    assert.equal(child.exitCode, null, child.err);
    try { const value=JSON.parse(fs.readFileSync(path.join(data,'vmusicd.json'),'utf8')); return value.pid===child.pid && value; } catch {return null;}
  }, 'service discovery', 60000);
  const api = async (endpoint, method='GET', body, status=200, auth=true) => {
    const response=await fetch('http://127.0.0.1:'+discovery.port+endpoint,{method,headers:{...(auth?{Authorization:'Bearer '+discovery.token}:{}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
    const value=await response.json(); assert.equal(response.status,status,endpoint+': '+JSON.stringify(value)); return value;
  };
  await api('/v1/health');
  return {discovery,api};
}
async function rejected(child) {
  await exit(child,'competing service rejection');
  assert.match(child.err,/data_dir_busy/);
  assert(!child.out.includes('listening on'));
}
function rpc(child, method, params, id) {
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  return until(() => {
    assert.equal(child.exitCode,null,child.err);
    for(const line of child.out.split('\n')) { try {const value=JSON.parse(line);if(value.id===id)return value;}catch{} }
    return null;
  }, 'DBX '+method);
}
async function main() {
  fs.mkdirSync(output,{recursive:true}); assert(fs.existsSync(plugin),'Build dbx-plugin-hertz with matching edition');
  const data=path.join(output,'资料 profile');
  let first=service(data), live=await ready(first,data);
  const original=fs.readFileSync(path.join(data,'vmusicd.json'));
  const token=fs.readFileSync(path.join(data,'token'));
  const config=fs.readFileSync(path.join(data,'config.toml'));
  fs.unlinkSync(path.join(data,'config.toml'));
  await rejected(service(data));
  assert(!fs.existsSync(path.join(data,'config.toml')),'contender must not create configuration');
  assert.deepEqual(fs.readFileSync(path.join(data,'vmusicd.json')),original);
  assert.deepEqual(fs.readFileSync(path.join(data,'token')),token);
  fs.writeFileSync(path.join(data,'config.toml'),'invalid = [');
  await rejected(service(data));
  fs.writeFileSync(path.join(data,'config.toml'),config);
  const describe=launch(binary,['--describe','--window','--data-dir',data],data);await exit(describe,'read-only describe',0);
  assert.equal(JSON.parse(describe.out).edition,'full');
  if (process.env.HERTZ_STANDARD_BIN) {
    await rejected(launch(process.env.HERTZ_STANDARD_BIN,['--port','0','--data-dir',data],data));
    mark('a real Standard build cannot initialize over an active Full profile');
  }
  assert.equal((await live.api('/v1/health')).status,'ok');
  mark('different-port contenders fail before config/defaults/token/discovery/HTTP initialization; primary stays usable');

  const alias=path.join(output,'alias'); fs.symlinkSync(data,alias,process.platform==='win32'?'junction':'dir');
  await rejected(service(alias));
  const otherData=path.join(output,'independent'),other=service(otherData);await ready(other,otherData);await stop(other);
  mark('physical directory aliases share one lock; separate profiles may run concurrently');

  await rejected(launch(plugin,[],data));
  assert.deepEqual(fs.readFileSync(path.join(data,'vmusicd.json')),original);
  mark('DBX cannot initialize over an active standalone profile');
  await stop(first); // Actual termination, leaving stale discovery and lock files.
  assert(fs.existsSync(path.join(data,'service-owner.lock')));
  first=service(data);live=await ready(first,data);assert.notEqual(live.discovery.server_instance_id,JSON.parse(original).server_instance_id);
  await live.api('/v1/system/shutdown','POST',{});await exit(first,'normal standalone exit',0);
  mark('OS releases locks after forced termination; stale discovery/lock files do not block restart and normal exit');

  const sidecar=launch(plugin,[],data);
  const initialized=await rpc(sidecar,'plugin/initialize',{host:{hostApiVersion:'1.4.0',protocolVersions:[1],features:[]}},1);
  assert.equal(initialized.result?.protocolVersion,1);
  const health=await rpc(sidecar,'v1/health',{op:'GET'},2); assert.equal(health.result?.status,200);
  assert.equal(health.result.body.edition,'full','run the cross-host test with Full binaries');
  assert.equal((await rpc(sidecar,'v1/window/state',{op:'GET'},20)).result?.status,404);
  assert(!fs.existsSync(path.join(data,'vmusicd.json')),'DBX must not publish an HTTP listener');
  assert(!fs.existsSync(path.join(data,'webview')),'DBX must not create a native WebView profile');
  await rejected(service(data));await rejected(launch(plugin,[],data));
  assert.equal((await rpc(sidecar,'v1/health',{op:'GET'},3)).result?.status,200);
  sidecar.stdin.end();await exit(sidecar,'DBX stdin EOF cleanup',0);
  first=service(data);live=await ready(first,data);await stop(first);
  mark('standalone and duplicate DBX cannot join a live DBX profile; SDK stays usable and EOF releases ownership');

  const invalid=path.join(output,'invalid');fs.mkdirSync(invalid);fs.writeFileSync(path.join(invalid,'config.toml'),'invalid = [');
  const bad=service(invalid);await exit(bad,'failed bootstrap');assert.match(bad.err,/invalid configuration/);
  assert(!fs.existsSync(path.join(invalid,'token')));
  fs.writeFileSync(path.join(invalid,'config.toml'),config);
  const corrupt=Buffer.from('fixture database must be preserved');
  fs.writeFileSync(path.join(invalid,'vmusic.db'),corrupt);
  const badDatabase=service(invalid);await exit(badDatabase,'failed database open');
  assert.notEqual(badDatabase.exitCode,0);
  assert.deepEqual(fs.readFileSync(path.join(invalid,'vmusic.db')),corrupt);
  fs.unlinkSync(path.join(invalid,'vmusic.db'));
  first=service(invalid);await ready(first,invalid);await stop(first);
  mark('failed configuration/database release admission and preserve existing bytes; correcting the fixture permits the next real startup');

  const raceData=path.join(output,'simultaneous');
  const racers=[service(raceData),service(raceData)];
  const winner=await until(()=>{
    try { const doc=JSON.parse(fs.readFileSync(path.join(raceData,'vmusicd.json'),'utf8'));return racers.find(child=>child.pid===doc.pid); }catch{return null;}
  },'simultaneous winner');
  const raceLive=await ready(winner,raceData);await rejected(racers.find(child=>child!==winner));
  assert.equal((await raceLive.api('/v1/health')).status,'ok');await stop(winner);
  mark('simultaneous fresh-profile startup admits exactly one real service and leaves valid configuration/discovery');

  if (process.env.HERTZ_LEGACY_BIN) {
    const legacyData=path.join(output,'legacy-active');const legacy=service(legacyData,{binary:process.env.HERTZ_LEGACY_BIN});
    await ready(legacy,legacyData);
    await rejected(service(legacyData));
    await stop(legacy);
    first=service(legacyData);await ready(first,legacyData);await stop(first);
    mark('existing pre-service-lock binary is detected by its actual AI kernel lock; new startup succeeds only after old owner exits');
  }

  const nativeData=path.join(output,'native'),native=service(nativeData,{window:true});const window=await ready(native,nativeData);
  await until(async()=> (await window.api('/v1/window/state')).backgroundPlayback,'native window ready');
  await window.api('/v1/window/focus','POST',{serverInstanceId:window.discovery.server_instance_id},401,false);
  await window.api('/v1/window/focus','POST',{serverInstanceId:crypto.randomUUID()},409);
  await window.api('/v1/window/focus','POST',{serverInstanceId:window.discovery.server_instance_id});
  const duplicate=service(nativeData,{window:true,port:1});await exit(duplicate,'different-port native focus',0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(nativeData,'vmusicd.json'),'utf8')).pid,native.pid);
  const nativeDoc=fs.readFileSync(path.join(nativeData,'vmusicd.json'));
  fs.writeFileSync(path.join(nativeData,'vmusicd.json'),JSON.stringify({...window.discovery,server_instance_id:crypto.randomUUID()}));
  const stale=service(nativeData,{window:true});await rejected(stale);
  assert.equal((await window.api('/v1/window/state')).available,true);
  fs.writeFileSync(path.join(nativeData,'vmusicd.json'),nativeDoc);
  await window.api('/v1/system/shutdown','POST',{},202);await exit(native,'native shutdown',0);
  mark('native duplicate recovers the same profile despite another requested port; authentication and instance checks reject stale/forged recovery');
  const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({checks,binarySha256:sha(binary),pluginSha256:sha(plugin),legacyBinarySha256:process.env.HERTZ_LEGACY_BIN?sha(process.env.HERTZ_LEGACY_BIN):null,
    standardBinarySha256:process.env.HERTZ_STANDARD_BIN?sha(process.env.HERTZ_STANDARD_BIN):null,
    sourceSha256:Object.fromEntries(['crates/hertz-studio/src/data_owner.rs','crates/hertz-studio/src/window_focus.rs','crates/hertz-studio/src/bootstrap.rs','crates/hertz-studio/src/config.rs','scripts/check-data-owner.js'].map(file=>[file,sha(path.join(root,file))])),
    limitations:['null audio','single Windows machine','legacy builds that never used either lock are outside cooperative admission','same-user file deletion and network filesystem lock semantics are not covered']},null,2));
  console.log('Evidence: '+output);
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{for(const child of owned)await stop(child).catch(()=>{});});
