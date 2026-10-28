// SPDX-License-Identifier: MIT
// Isolated native management v2, explicit center binding and authenticated DBX health.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const requestManagement = require('./desktop-native-management-client');
const {spawn, execFile} = require('node:child_process');
const exec = require('node:util').promisify(execFile);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/desktop-management-native-' + Date.now());
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0,32);
const binary = path.join(root, 'target/debug/hertz-desktop.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const lyrics = {enabled:true,locked:false,layout:'triple',secondary:'next',theme:'light',surface:'glass',align:'center',bilingual:true,karaoke:true,readabilityBoost:false,fontFamily:'Segoe UI',fontSize:30,fontWeight:600,sungColor:'#ffffff',unsungColor:'#ffffff',outlineColor:'#000000',outlineWidth:0,opacity:1,width:550,anchorX:.5,anchorY:.5,monitor:null};
const wallpaper = {enabled:false,fps:30,musicResponse:true,monitor:null,source:'fixed',scene:'coast'};
const records = [];
let sequence = 0, build, browser, host, bridge;
function requestOnce(payload) { return requestManagement(pipe, payload); }
async function request(payload) {
  const deadline = Date.now() + 1000;
  for (;;) {
    try { return await requestOnce(payload); }
    catch (error) { if (!['ENOENT','EBUSY'].includes(error.code) || Date.now() >= deadline) throw error; await delay(20); }
  }
}
function legacy(command,value) { return request({command,value}); }
async function v2(command,targetProfile,value,overrides={}) {
  const payload = {managementProtocol:2,requestId:'native-'+(++sequence),requiredDesktopBuildId:build,targetProfile,command,value,...overrides};
  const response = await request(payload);
  assert.equal(response.managementProtocol,2); assert.equal(response.desktopBuildId,build);
  const validId = typeof payload.requestId === 'string' && /^[\x21-\x7e]{1,128}$/.test(payload.requestId);
  assert.equal(response.requestId,validId ? payload.requestId : null);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 8192);
  records.push({command,requestId:response.requestId,ok:response.ok,error:response.error,activeProfile:response.activeProfile,sourceConnected:response.sourceConnected,sourceScopes:response.sourceScopes,revision:response.revision});
  return response;
}
async function until(check,message,timeout=10000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) { const value=await check(); if(value)return value; await delay(100); }
  throw new Error(message);
}
async function startBridge(directory,session) {
  const fixture=path.join(root,'target/desktop-management-fixture/debug/desktop-management-bridge-fixture.exe');
  const child=spawn(fixture,[directory,build,session],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('fixture ready timeout '+errors)),10000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);reject(new Error('fixture exited '+code+' '+errors));});});
  return child;
}
async function stop(child) { if(!child||child.exitCode!==null||child.signalCode!==null)return;child.kill();await until(async()=>child.exitCode!==null||child.signalCode!==null,'fixture cleanup timeout',5000); }
async function verifyClientBounds() {
  const checks = [];
  for (const mode of ['clean-close','partial-close','silent','trickle','oversize','normal']) {
    const name = '\\\\.\\pipe\\hertz-management-client-fixture-' + process.pid + '-' + mode;
    const sockets = new Set(); let accepted = false, closed = false;
    const server = net.createServer(socket => {
      sockets.add(socket); accepted = true;
      socket.on('error', () => {});
      socket.once('close', () => { sockets.delete(socket); closed = true; });
      socket.once('data', () => {
        if (mode === 'clean-close') socket.end();
        if (mode === 'partial-close') socket.end('{"ok":');
        if (mode === 'oversize') socket.write(' '.repeat(8193));
        if (mode === 'normal') socket.write('{"ok":true}');
        if (mode === 'trickle') {
          const fragments = setInterval(() => socket.write(' '), 50);
          socket.once('close', () => clearInterval(fragments));
        }
      });
    });
    await new Promise((resolve,reject) => { server.once('error',reject); server.listen(name,resolve); });
    const started = performance.now(); let code = null;
    try {
      const result = await Promise.race([
        requestManagement(name, {command:'status'}).then(value => ({value}), error => ({error})),
        // An independent observer turns a regression back into a bounded test failure.
        new Promise(resolve => { const timer = setTimeout(() => resolve({pending:true}), 4500); server.once('close', () => clearTimeout(timer)); }),
      ]);
      assert.notEqual(result.pending, true, mode + ' must settle before the observer deadline');
      if (mode === 'normal') assert.deepEqual(result.value, {ok:true}, 'complete JSON succeeds before peer closes');
      else {
        code = result.error && result.error.code;
        const expected = mode === 'silent' || mode === 'trickle' ? 'ERR_MANAGEMENT_TIMEOUT' : mode === 'oversize' ? 'ERR_MANAGEMENT_RESPONSE_LIMIT' : 'ERR_MANAGEMENT_INCOMPLETE';
        assert.equal(code, expected, mode + ' must reject with its bounded failure');
      }
      const elapsedMs = Math.round(performance.now() - started);
      assert.ok(elapsedMs < 4500, mode + ' exceeded the absolute promise deadline');
      if (mode === 'clean-close' || mode === 'partial-close') assert.ok(elapsedMs < 1000, mode + ' must reject promptly');
      await until(async()=>accepted && closed && sockets.size === 0, mode + ' must release the real pipe socket', 1000);
      checks.push({mode,code,elapsedMs,peerSocketClosed:true});
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  }
  fs.writeFileSync(path.join(output,'client-report.json'),JSON.stringify({passed:true,transport:'real Windows named pipes',checks},null,2));
}
async function main() {
  if(process.platform!=='win32')throw new Error('Windows required');
  const {stdout:count}=await exec('powershell.exe',['-NoProfile','-Command','@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count'],{windowsHide:true});
  assert.equal(count.trim(),'0','protect existing user native instance');
  fs.mkdirSync(output,{recursive:true});
  await verifyClientBounds();
  if (process.argv.includes('--client-only')) { console.log('Native management client bounds passed. Evidence: '+output); return; }
  const describeDir=path.join(output,'describe-must-not-create');
  const description=JSON.parse((await exec(binary,['--describe'],{windowsHide:true,env:{...process.env,HERTZ_DESKTOP_CONFIG_DIR:describeDir}})).stdout);
  assert.equal(description.managementProtocol,2);assert.equal(description.bridgeProtocol,1);assert.equal(fs.existsSync(describeDir),false);
  build=description.desktopBuildId;
  await exec('cargo',['build','--manifest-path',path.join(root,'scripts/fixtures/desktop-management-bridge/Cargo.toml'),'--target-dir',path.join(root,'target/desktop-management-fixture')],{cwd:root,windowsHide:true,maxBuffer:2*1024*1024});
  const aDir=path.join(output,'standalone-a'),bDir=path.join(output,'dbx-b'),cDir=path.join(output,'dbx-c');
  [aDir,bDir,cDir].forEach(directory=>fs.mkdirSync(directory));
  const a={kind:'standalone',edition:'full',dataDir:aDir};
  const b={kind:'dbx',edition:'standard',dataDir:bDir,pluginId:'io.github.oncemisery.hertz-studio'};
  const c={...b,dataDir:cDir};
  const configFile=path.join(output,'config.json');
  fs.writeFileSync(configFile,JSON.stringify({schemaVersion:3,revision:1,launchAtLogin:false,activeProfile:a,profiles:[{profile:a,lyrics,wallpaper}]}));
  bridge=await startBridge(bDir,'00000000-0000-4000-8000-000000000021');
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  host=spawn(binary,['--settings'],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,HERTZ_DESKTOP_CONFIG_DIR:output,WEBVIEW2_USER_DATA_FOLDER:path.join(output,'webview2'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}});
  await until(async()=>{try{const response=await fetch('http://127.0.0.1:'+port+'/json/version');return response.ok;}catch(_){return false;}},'native WebView2 must start',15000);
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
  const page=await until(async()=>browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('/settings.html')),'settings page required');
  await page.waitForFunction(()=>document.getElementById('settings-state').textContent==='设置已保存');
  const profileKey=profile=>[profile.kind,profile.pluginId||'',profile.edition,profile.dataDir.replace(/\//g,'\\').toLowerCase()].join('|');
  assert.equal((await legacy('hide')).userHidden,true);assert.equal((await legacy('show')).userHidden,false);
  for(const [command,value] of [['font',41],['opacity',.8],['layout','double'],['secondary','translation']])assert.equal((await legacy(command,value)).ok,true);
  await until(async()=>{const stored=JSON.parse(fs.readFileSync(configFile));return stored.profiles[0].lyrics.fontSize===41&&stored.profiles[0].lyrics.opacity===.8&&stored.profiles[0].lyrics.layout==='double'&&stored.profiles[0].lyrics.secondary==='translation';},'legacy scalar values must persist');
  await legacy('wallpaper-settings',{profile:{edition:'standard',dataDir:cDir},tab:'runtime'});
  await page.waitForFunction(()=>Array.from(document.getElementById('profile').options).some(option=>option.value.includes('dbx-c')));
  assert.equal((await legacy('status')).profile.kind,'standalone');
  const original=fs.readFileSync(configFile,'utf8');
  for(const [overrides,error] of [
    [{managementProtocol:1},'unsupported_management_protocol'],[{managementProtocol:null},'unsupported_management_protocol'],
    [{requestId:undefined},'invalid_request_id'],[{requestId:null},'invalid_request_id'],[{requestId:''},'invalid_request_id'],[{requestId:'has space'},'invalid_request_id'],[{requestId:'x'.repeat(129)},'invalid_request_id'],
    [{requiredDesktopBuildId:undefined},'invalid_management_request'],[{targetProfile:undefined},'invalid_management_request'],[{requiredDesktopBuildId:'other-build'},'desktop_build_mismatch'],[{unknown:true},'invalid_management_request'],
    [{targetProfile:{...b,pluginId:'wrong'}},'invalid_target_profile'],[{targetProfile:{...b,unexpected:true}},'invalid_management_request'],
    [{targetProfile:{...b,dataDir:path.join(output,'missing')}},'invalid_target_profile'],
  ])assert.equal((await v2('status',b,null,overrides)).error,error);
  const missing=await request({command:'font',value:70,requestId:'partial-v2'});assert.equal(missing.error,'unsupported_management_protocol');assert.equal(missing.requestId,'partial-v2');
  for(const command of ['font','locate','profile-switch','wallpaper-toggle','show','lock'])assert.equal((await v2(command,a,command==='font'?70:null)).error,'unsupported_command');
  assert.equal((await v2('hide',b)).error,'desktop_source_mismatch');
  assert.equal((await v2('open-center',b,{profile:c})).error,'invalid_value');
  assert.equal((await v2('status',a,{profile:b})).error,'invalid_value');
  assert.equal(fs.readFileSync(configFile,'utf8'),original,'rejected envelopes must not mutate disk');
  let state=await v2('open-center',b,{tab:'runtime'});
  assert.equal(state.activeProfile.kind,'standalone');assert.equal(state.sourceConnected,false);
  await page.waitForFunction(()=>Array.from(document.getElementById('profile').options).some(option=>option.value.includes('dbx|')));
  await page.locator('#profile').selectOption(profileKey(b));
  assert.equal(await page.locator('#switch-source').isEnabled(),true,'DBX candidate can be explicitly selected');
  fs.mkdirSync(path.join(output,'config.json.tmp'));
  await page.locator('#switch-source').click();await page.waitForFunction(()=>document.getElementById('status').classList.contains('error'));
  assert.equal((await legacy('status')).activeProfile.kind,'standalone');assert.equal(fs.readFileSync(configFile,'utf8'),original);
  assert.equal(await page.locator('#switch-source').isEnabled(),true,'failed commit must allow the same candidate to retry');
  fs.rmdirSync(path.join(output,'config.json.tmp'));
  await page.locator('#switch-source').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='已切换来源');
  state=await until(async()=>{const state=await v2('status',b);return state.sourceScopes.lyrics&&state.sourceScopes.wallpaper&&state;},'authenticated empty DBX feed must become connected');
  assert.equal(state.activeProfile.kind,'dbx');assert.deepEqual(state.sourceScopes,{lyrics:true,wallpaper:true});
  assert.equal(state.enabled,false);assert.equal(state.wallpaper.enabled,false);
  assert.equal((await v2('status',a)).sourceConnected,false,'source B cannot satisfy target A');
  let stored=JSON.parse(fs.readFileSync(configFile));assert.equal(stored.profiles[0].lyrics.fontSize,41);assert.equal(stored.profiles[0].lyrics.opacity,.8);
  const boundFile=fs.readFileSync(configFile,'utf8');
  for(const command of ['font','hide','locate','wallpaper-show','profile-switch','wallpaper-apply'])assert.equal((await legacy(command,{})).error,'source_target_required');
  await legacy('wallpaper-settings',{profile:c,tab:'runtime'});
  assert.equal(await page.locator('#profile option').evaluateAll(options=>options.some(option=>option.value.startsWith('dbx|')&&option.value.includes('dbx-c'))),false,'legacy DBX open cannot nominate another DBX source');
  assert.equal(fs.readFileSync(configFile,'utf8'),boundFile);
  assert.equal((await v2('hide',a)).error,'desktop_source_mismatch');
  assert.equal((await v2('wallpaper-apply',b,{config:wallpaper})).error,'invalid_expected_revision');
  assert.equal((await v2('wallpaper-apply',b,{expectedRevision:state.revision-1,config:wallpaper})).error,'desktop_revision_conflict');
  assert.equal((await v2('wallpaper-apply',b,{expectedRevision:state.revision,config:{...wallpaper,profile:a}})).error,'invalid_value');
  assert.equal(fs.readFileSync(configFile,'utf8'),boundFile);
  assert.equal((await v2('wallpaper-hide',b)).wallpaper.hidden,true);
  assert.equal((await v2('wallpaper-show',b)).wallpaper.hidden,false);
  const applied=await v2('wallpaper-apply',b,{expectedRevision:state.revision,config:{...wallpaper,fps:15}});
  assert.equal(applied.ok,true);assert.equal(applied.revision,state.revision+1);assert.equal(applied.wallpaper.fps,15);
  assert.equal((await v2('wallpaper-apply',b,{expectedRevision:state.revision,config:wallpaper})).error,'desktop_revision_conflict');
  fs.writeFileSync(path.join(bDir,'mode.txt'),'stall');
  await delay(3200);
  assert.equal((await v2('status',b)).sourceConnected,false,'stale or failed scopes must stop reporting online');
  await stop(bridge);bridge=null;
  bridge=await startBridge(bDir,'00000000-0000-4000-8000-000000000022');
  assert.equal((await v2('status',b)).sourceConnected,false,'a new session alone cannot retain the old authenticated state');
  fs.writeFileSync(path.join(bDir,'mode.txt'),'');
  state=await until(async()=>{const state=await v2('status',b);return state.sourceConnected&&state;},'new session must authenticate before connected',12000);
  assert.equal((await v2('status',a)).sourceConnected,false);
  await page.locator('#tab-runtime').click();await page.locator('#profile').selectOption(profileKey(a));await page.locator('#switch-source').click();
  await until(async()=>(await legacy('status')).activeProfile.kind==='standalone','explicit return to standalone');
  assert.equal((await v2('status',b)).sourceConnected,false,'switching clears source B connection');
  assert.equal((await legacy('hide')).ok,true,'legacy standalone control recovers after switching back');
  await page.screenshot({path:path.join(output,'center-after-explicit-switch.png'),fullPage:true});
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,description,checks:records,scope:'isolated native WebView2 + authenticated DBX protocol fixture; excludes real DBX UI, cross-user/session and long-run D3 acceptance'},null,2));
  console.log('Native management v2 checks passed. Evidence: '+output);
}
main().catch(error=>{fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:error.stack,checks:records},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{
  if(browser)await browser.close().catch(()=>{});
  await stop(host).catch(error=>console.error(error));await stop(bridge).catch(error=>console.error(error));
});
