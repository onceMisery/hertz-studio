// SPDX-License-Identifier: MIT
// Owned Windows WebView2 File-object integration; --ole adds controlled real OLE FileDrop, not Explorer qualification.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const binary = path.resolve(process.env.HERTZ_BIN || path.join(root,'target/debug/hertz-studio.exe'));
const output = path.join(root,'output/playwright/native-music-import-'+Date.now()), data = path.join(output,'data');
const music = path.join(output,'music'), nested=path.join(music,'nested');
const ole = process.argv.includes('--ole');
const hash = file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const checks=[],errors=[],receipts=[];
let child,browser,page,discovery,candidateHash,sourceHashes,graceful=false;
let cdp;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,label,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(value)return value;await delay(100);}throw Error('Timed out: '+label);}
const mark=text=>{checks.push(text);console.log('PASS '+text);};
function wav(file){const size=1600,b=Buffer.alloc(44+size);b.write('RIFF');b.writeUInt32LE(36+size,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size,40);fs.writeFileSync(file,b);}
async function api(endpoint,method='GET',body,expected=200){const response=await fetch('http://127.0.0.1:'+discovery.port+endpoint,{method,headers:{Authorization:'Bearer '+discovery.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const text=await response.text();assert.equal(response.status,expected,endpoint+': '+text);return JSON.parse(text);}
function activePort(){for(const relative of ['DevToolsActivePort','EBWebView/DevToolsActivePort']){try{const port=Number(fs.readFileSync(path.join(data,'webview/main',relative),'utf8').split(/\r?\n/)[0]);if(port>0)return port;}catch{}}return null;}
async function settled(){return until(async()=>{const status=await api('/v1/library/status');return !status.running&&status.phase&&status;},'scan settled');}
async function tracks(){const response=await api('/v1/tracks?limit=500');return response.tracks||response.items||response;}
async function setFiles(selector,files){const {root:document}=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:document.nodeId,selector});await cdp.send('DOM.setFileInputFiles',{nodeId,files});}
async function choose(files){await setFiles('#native-music-files',files);await until(async()=>!(await page.locator('#native-music-pick').isDisabled()),'import UI receipt');const note=await page.locator('#native-music-note').textContent();assert.match(note,/已开始收录/);return settled();}
async function send(label,overrides={},mode='file'){
  const result=await page.evaluate(async({label,overrides,mode})=>{
    const input=document.getElementById('native-probe-file');
    const files=mode==='constructed'?[new File(['memory'],'invented.wav')]:mode==='none'?[]:Array.from(input.files);
    const request={kind:'import-files',documentId:__hertzWindowHost.documentId,requestId:crypto.randomUUID(),...overrides};
    const receipt=await new Promise(resolve=>{
      const handler=event=>{if(event.detail?.requestId!==request.requestId)return;clearTimeout(timer);window.removeEventListener('hertz-native-import-result',handler);resolve(event.detail);};
      const timer=setTimeout(()=>{window.removeEventListener('hertz-native-import-result',handler);resolve({status:'ignored'});},1200);
      window.addEventListener('hertz-native-import-result',handler);
      try{chrome.webview.postMessageWithAdditionalObjects(JSON.stringify(request),files);}
      catch(error){clearTimeout(timer);window.removeEventListener('hertz-native-import-result',handler);resolve({status:'failed',error:error.message,apiRejected:true});}
    });
    return {label,requestId:request.requestId,...receipt};
  },{label,overrides,mode});receipts.push(result);return result;
}
async function main(){
  assert.equal(process.platform,'win32');assert.ok(fs.existsSync(binary));
  fs.mkdirSync(nested,{recursive:true});fs.mkdirSync(data,{recursive:true});
  candidateHash=hash(binary);
  const files=['crates/hertz-studio/src/scan.rs','crates/hertz-studio/src/scan/selected.rs','crates/hertz-studio/src/main.rs','crates/hertz-studio/src/window.rs','crates/hertz-studio/src/window/file_import.rs','plugin/ui/native-music-import.js','plugin/ui/native-music-import.css','plugin/ui/app.js','plugin/ui/index.html','crates/hertz-studio/src/assets.rs'];
  sourceHashes=Object.fromEntries(files.map(file=>[file,hash(path.join(root,file))]));
  wav(path.join(music,'chosen.wav'));wav(path.join(music,'sibling.wav'));wav(path.join(nested,'nested.wav'));fs.writeFileSync(path.join(music,'notes.txt'),'not music');
  const log=fs.openSync(path.join(output,'host.log'),'a');
  child=spawn(binary,['--window','--bind','127.0.0.1','--port','0','--data-dir',data],{cwd:root,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,VMUSIC_BACKEND:'null',VMUSIC_SECRETS:'memory',HERTZ_DESKTOP_CONFIG_DIR:path.join(output,'desktop'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=0'}});fs.closeSync(log);
  discovery=await until(()=>{if(child.exitCode!==null)throw Error('Owned host exited '+child.exitCode);try{const value=JSON.parse(fs.readFileSync(path.join(data,'vmusicd.json')));return value.pid===child.pid&&value;}catch{return null;}},'native startup',60000);
  const port=await until(activePort,'main WebView CDP');
  await until(async()=>{try{return(await fetch('http://127.0.0.1:'+port+'/json/version')).ok;}catch{return false;}},'CDP endpoint');
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true});
  page=await until(()=>browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().startsWith('http://127.0.0.1:'+discovery.port)),'main page');
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(20000);
  cdp=await browser.contexts()[0].newCDPSession(page);
  await page.waitForFunction(()=>window.__hertzWindowHost?.fileImportVersion===1&&document.getElementById('conn').textContent==='服务已连接');
  await page.evaluate(()=>{document.getElementById('scan-panel').hidden=false;window.__nativeImportReceipts=[];window.addEventListener('hertz-native-import-result',event=>__nativeImportReceipts.push(event.detail));const input=document.createElement('input');input.type='file';input.multiple=true;input.id='native-probe-file';input.hidden=true;document.body.appendChild(input);});
  mark('real native main confirms File-object capability and embedded import assets');
  let status=await choose([path.join(music,'chosen.wav')]);
  assert.equal(status.added,1);assert.equal(status.removed,0);assert.equal(status.root,null);
  let rows=await tracks();assert.equal(rows.length,1);assert.ok(rows[0].path.endsWith('chosen.wav'));
  const firstId=rows[0].id;
  await choose([path.join(music,'chosen.wav')]);rows=await tracks();assert.equal(rows.length,1);assert.equal(rows[0].id,firstId);
  mark('OS-backed file picker imports exactly one song and reimport preserves its identity');
  await setFiles('#native-probe-file',[path.join(music,'sibling.wav')]);
  assert.equal((await send('constructed',{},'constructed')).status,'failed');
  assert.equal((await send('missing-objects',{},'none')).status,'failed');
  assert.equal((await send('json-path',{paths:[path.join(music,'sibling.wav')]})).status,'ignored');
  assert.equal((await send('wrong-document',{documentId:crypto.randomUUID()})).status,'ignored');
  assert.equal((await tracks()).length,1);
  mark('constructed files, absent objects, JSON paths and wrong documents cannot import filesystem paths');
  // CDP supplies the real OS-backed directory File to a normal input, without recursively replacing it with child files.
  await setFiles('#native-probe-file',[music]);
  const selected=await page.locator('#native-probe-file').evaluate(input=>Array.from(input.files,file=>({name:file.name,size:file.size})));
  assert.equal(selected.length,1);assert.equal(selected[0].name,path.basename(music));
  assert.equal((await send('directory')).status,'accepted');status=await settled();
  assert.equal(status.total,3);assert.equal(status.removed,0);assert.equal((await tracks()).length,3);
  mark('real WebView2 directory File retains its root path and recursively imports through the existing scan owner');
  fs.unlinkSync(path.join(music,'sibling.wav'));wav(path.join(music,'picked-later.wav'));
  status=await choose([path.join(music,'picked-later.wav')]);assert.equal(status.removed,0);assert.equal((await tracks()).length,4);
  mark('later exact import preserves an absent unselected song instead of pruning the directory');
  fs.writeFileSync(path.join(music,'broken.flac'),'corrupt music');
  status=await choose([path.join(music,'broken.flac')]);assert.equal(status.failed,1);assert.equal(status.phase,'failed');
  await until(async()=>/失败 1/.test(await page.locator('#scan-label').textContent()),'rootless selected scan result text');
  assert.equal(await page.locator('#scan-errors').isVisible(),true);
  await page.screenshot({path:path.join(output,'actual-native-import-errors.png')});
  mark('metadata failure appears in actual rootless scan results and inline failure details');
  await api('/v1/library/scan','POST',{root:music});
  await until(async()=>!((await api('/v1/library/status')).running),'complete root scan');
  // Existing complete-root scans keep their deletion behavior after the selected-mode extension.
  assert.equal((await tracks()).length,3); // complete-root scan removes the missing sibling; failed metadata never creates a track.
  mark('existing complete-root scans retain their deliberate stale-track pruning behavior');
  if(ole){
    const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
    const geometry=JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'main-window-geometry-fixture.ps1'),'-OwnerPid',String(child.pid)],{encoding:'utf8',windowsHide:true,timeout:15000}));
    const focus=async()=>JSON.parse(await new Promise((resolve,reject)=>execFile(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'native-main-window-pointer-fixture.ps1'),'-OwnerPid',String(child.pid),'-Handle',String(geometry.handle),'-WaitMilliseconds','180000'],{encoding:'utf8',windowsHide:true,timeout:195000},(error,stdout)=>error?reject(error):resolve(stdout))));
    const drag=async file=>{
      console.log('Awaiting exact owned main-window pointer admission; system dialogs require user handling');
      const focused=await focus();assert.equal(focused.foreground,geometry.handle);
      const result=JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-Sta','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'native-music-drag-fixture.ps1'),'-OwnerPid',String(child.pid),'-Handle',String(geometry.handle),'-Path',file],{encoding:'utf8',windowsHide:true,timeout:20000}));
      assert.equal(result.effect,'Copy');receipts.push({label:'actual-ole-drag',...result});
      return until(async()=>{const rows=await tracks();return rows.find(row=>row.path===file)&&rows;},'actual OLE drop is indexed');
    };
    const dropped=path.join(music,'actual-drop.wav');wav(dropped);
    await drag(dropped);await settled();
    mark('actual Windows OLE FileDrop from an owned source imports the dropped music file');
    const folder=path.join(output,'actual-drop-folder');fs.mkdirSync(folder);const folderFile=path.join(folder,'folder-song.wav');wav(folderFile);
    const result=JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-Sta','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'native-music-drag-fixture.ps1'),'-OwnerPid',String(child.pid),'-Handle',String(geometry.handle),'-Path',folder],{encoding:'utf8',windowsHide:true,timeout:20000}));
    assert.equal(result.effect,'Copy');receipts.push({label:'actual-ole-directory',...result});
    await until(async()=>(await tracks()).find(row=>row.path===folderFile),'actual directory OLE drop is indexed');await settled();
    mark('actual Windows OLE directory FileDrop retains the selected root and recursively indexes its music');
  }
  assert.equal(hash(binary),candidateHash);for(const [file,sha]of Object.entries(sourceHashes))assert.equal(hash(path.join(root,file)),sha,'source stable: '+file);
  assert.deepEqual(errors,[]);
  await api('/v1/player/pause','POST',{});await api('/v1/system/shutdown','POST',{},202);
  await until(()=>child.exitCode!==null,'owned graceful exit',30000);assert.equal(child.exitCode,0);assert.equal(fs.existsSync(path.join(data,'vmusicd.json')),false);graceful=true;
  mark('owned native host shuts down normally and removes discovery');
}
async function cleanup(){if(child&&child.exitCode===null){child.kill();await until(()=>child.exitCode!==null||child.signalCode!==null,'owned cleanup',10000);}await browser?.close().catch(()=>{});}
main().then(async()=>{await cleanup();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,binary,binarySha256:candidateHash,sourceSha256:sourceHashes,pid:child.pid,exitCode:child.exitCode,graceful,checks,errors,receipts,ole,qualificationScope:ole?'actual WebView2 object import and real Windows OLE FileDrop from a controlled owned source; Explorer itself and other shells remain unqualified':'actual WebView2 OS-backed file/directory object import; no Explorer OLE drag or OS foreground qualification'},null,2));console.log(output);}).catch(async error=>{console.error(error);if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'failure.png'),timeout:5000}).catch(()=>{});await cleanup().catch(e=>errors.push(e.message));fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:false,error:error.stack,binary,binarySha256:candidateHash,sourceSha256:sourceHashes,pid:child?.pid,exitCode:child?.exitCode,graceful,checks,errors,receipts,ole},null,2));console.error(output);process.exitCode=1;});
