// SPDX-License-Identifier: MIT
// Production receiver/controller + original detail markup in an isolated browser fixture.
// Transport and Stage are fixtures; this does not claim OS/native/DBX host focus evidence.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), ui = path.join(root, 'plugin/ui'), assets = path.join(root, 'crates/hertz-desktop/assets');
const output = path.join(root, 'output/a10-calibration-20261108/browser');
const app = fs.readFileSync(path.join(ui, 'app.js'), 'utf8'), index = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
function fn(name) {
  const start = app.indexOf('function ' + name + '('); assert.ok(start >= 0, name);
  const brace = app.indexOf('{', start); let depth = 0;
  for (let n = brace; n < app.length; n++) { if (app[n] === '{') depth++; if (app[n] === '}' && !--depth) return app.slice(start, n + 1); }
  throw Error('Unclosed source function ' + name);
}
const detail = index.slice(index.indexOf('<div id="np-scrim"'), index.indexOf('<!-- 演示后端'));
const receiverStart=app.indexOf('const np = {');
const receiver = app.slice(receiverStart, app.indexOf('// 胶囊播放器',receiverStart));
assert.ok(receiver.includes('const calibrationUi ='));
const startup = 'async ' + fn('startApp') + '\nasync ' + fn('startFloatingCapsule');
const css = ['design/design-base.css', 'components/button.css', 'style.css', 'now-playing.css'].map(file => fs.readFileSync(path.join(ui, file), 'utf8')).join('\n');
const head = `<html lang="zh-CN" data-skin="hertz"><meta charset="utf-8"><style>${css}</style><body>
<div id="bar-art"></div><input id="volume" value="80"><div id="ctx-menu" hidden></div><div id="queue-list"></div>
<label><input type="checkbox" id="desktop-calibration-consent">允许从桌面打开播放器校准</label><p id="desktop-calibration-consent-note"></p><div id="desktop-calibration-revoke-actions" hidden><button id="desktop-calibration-revoke-retry">重试撤销校准授权</button></div>${detail}`;
const setup = `
const $ = id => document.getElementById(id);
const state = { connected:true, current:{id:'first',title:'当前歌曲'}, snapshot:{track_id:'first',generation:1,playing:false,position_ms:0,duration_ms:5000} };
const ui = {volume:$('volume')};
window.fixture = { calls:[], pending:null, claimed:false, gate:true, delay:0, done:null, waiter:null, registration:0, receivers:{}, marker:'cc85b861-64ae-4e25-9364-e2dd02c7f063',
  doc:{source:'imported',user_offset_ms:500,lines:[{start_ms:0,end_ms:5000,text:'校准当前歌曲'}]}, dbx:false, floating:false,
  enqueue(id='request',remaining=4500) { this.pending={version:1,requestId:id,bindingId:'fixture-binding',requestSequence:1,remainingMs:remaining,session:'fixture-session',trackId:state.current.id,generation:String(state.snapshot.generation)};this.remaining=remaining;this.claimed=false;this.done=null; },
  changeTrack() { state.current={id:'second',title:'下一首'};state.snapshot={...state.snapshot,track_id:'second',generation:2};document.dispatchEvent(new CustomEvent('playback:snapshot',{detail:state.snapshot})); },
  releaseDoc() {if(this.waiter){this.waiter(this.doc);this.waiter=null;}},
};
let transport = {
  async get(url) {fixture.calls.push({method:'GET',url});if(url.includes('calibration-authorization')){if(fixture.holdConsent)return new Promise(resolve=>fixture.consentWaiter=resolve);return{authorized:fixture.gate};}if(url.includes('/lyrics')){if(fixture.delay)return new Promise(resolve=>fixture.waiter=resolve);return structuredClone(fixture.doc);}throw Error('unexpected get '+url);},
  async post(url,body){fixture.calls.push({method:'POST',url,body:structuredClone(body)});
    if(url.includes('calibration-authorization')){fixture.gate=body.enabled;if(fixture.failConsent)throw Error('本次校准已停用，但持久撤销未完成，请重试撤销');return{authorized:fixture.gate};}
    if(url!='/v1/desktop/calibration-ui')throw Error('Unexpected mutation '+url);
    if(body.op==='register'){
      if(fixture.requiredMarker&&body.handoff&&body.handoff!==fixture.requiredMarker)throw Error('wrong handoff');
      const id='receiver-'+(++fixture.registration);fixture.receivers[id]=body.handoff||'';
      const reply={receiverId:id,session:'fixture-session'};
      if(body.handoff&&body.handoff===fixture.registerHold){fixture.registerHold=null;return await new Promise((resolve,reject)=>fixture.registerWaiter={receiverId:id,resolve:()=>resolve(reply),reject:()=>reject(Error('old registration failed'))});}
      return reply;
    }
    if(body.op==='renew'||body.op==='unregister')return{renewed:true};
    if(body.op==='claim'){
      if(!fixture.pending||fixture.claimed||fixture.requiredMarker&&(fixture.receivers[body.receiverId]!==fixture.requiredMarker||body.handoff!==fixture.requiredMarker))return{intent:null};
      fixture.claimed=true;const reply={intent:structuredClone(fixture.pending),remainingMs:fixture.remaining};
      if(fixture.claimHold){fixture.claimHold=false;return await new Promise(resolve=>fixture.claimWaiter=()=>resolve(reply));}
      if(fixture.claimDelay)await new Promise(resolve=>setTimeout(resolve,fixture.claimDelay));return reply;
    }
    if(!fixture.gate||!fixture.pending||body.requestId!==fixture.pending.requestId||state.current.id!==fixture.pending.trackId)throw Error('expired intent');
    if(body.op==='validate'){if(fixture.validateDelay){const delay=fixture.validateDelay;fixture.validateDelay=0;await new Promise(resolve=>setTimeout(resolve,delay));}return{valid:true,remainingMs:fixture.validateRemaining||fixture.remaining};}
    if(body.op==='handoff')return{handoff:fixture.marker};
    if(body.op==='complete'){fixture.done=structuredClone(body);fixture.pending=null;return{state:body.result};}
    throw Error('Unexpected UI op '+body.op);
  },put(){throw Error('Offset write forbidden in UI handoff');}
};
window.Online={loadLyricDoc:()=>transport.get('/v1/tracks/online/lyrics')};
const Stage={kick(){},coverUrl(){return'';},gate(){},lyrics(){return null;},presentation(){return{position:0,track:state.current};}};
function renderPlaybackProgress(){}function assignCover(node,url,apply){apply(url);}function refreshLyrics(){throw Error('Duplicate detail lyric load');}
function setView(){throw Error('Unexpected source/navigation fallback');}function playerWorkbench(){return'fixture.player';}
async function chooseTransport(){return transport;}
function initMainVisibility(){}function initShell(){}function bindDbxCloseHook(){}
function initCapsuleControls(){}function bindMediaSession(){}function openSocket(){}
function toast(){}function errText(error){return String(error);}
async function refreshFloatingCapsule(){fixture.calls.push({method:'STARTUP',name:'floating-snapshot-ready'});}
window.Online.bind=()=>{};
`;
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const checks = [], errors = [], mark = value => { checks.push(value); console.log('PASS ' + value); };
  let page;
  async function player(options = {}) {
    if (page) await page.close();
    page = await browser.newPage({ viewport: { width: 1000, height: 800 } }); page.on('pageerror', e => errors.push(e.message));
    await page.setContent(`${head}<script>${setup}${receiver}${fn('syncNpLyrics')}${fn('syncNpTrack')}${startup}</script><script>${fs.readFileSync(path.join(ui, 'now-playing.js'), 'utf8')}</script></body></html>`);
    await page.evaluate(async options => {
      fixture.dbx = !!options.dbx; fixture.floating = !!options.floating;
      transport.kind = fixture.dbx ? 'dbx' : 'server';
      if (fixture.dbx) { window.hertzHost = { isDbx:true,async hydrate(){} }; window.HertzCapsuleOnly=fixture.floating; window.dbxPlugin={context:{},onInit(fn){fixture.initContext=fn;fn(this.context);},onContext(fn){fixture.contextListener=fn;},openWorkbench:async(...args)=>{fixture.calls.push({method:'BRIDGE',args});}}; }
      if(options.online)state.current={id:'online:netease:510',title:'在线歌曲',source:'netease',onlineId:'510'};
      if(options.vocal)fixture.doc.lines[0].vocal={agentIds:['a'],role:'lead'};
      fixture.holdConsent=!!options.holdConsent;
      NowPlaying.init({queue:()=>[],seeking:()=>false,favoriteState:()=>({disabled:false,on:false}),modeState:()=>({label:'列表循环',icon:'#i-repeat'}),closeTop(){},favorite(){},mode(){},mute(){},notice(){},closeLyricImport(){}});
      if(fixture.floating) await startApp();
      else calibrationUi.init();
    }, options);
    await page.waitForFunction(() => fixture.registration > 0);
    return page;
  }
  try {
    for (const options of [{}, { online:true }, { vocal:true }, { dbx:true }]) {
      await player(options); await page.evaluate(() => fixture.enqueue());
      await page.waitForFunction(() => fixture.done !== null, null, { timeout: 6000 }).catch(async e=>{
        await page.screenshot({path:path.join(output,'failure.png')});
        throw Error(JSON.stringify({errors,calls:await page.evaluate(()=>fixture.calls),modal:await page.locator('#np-modal').isVisible()})+' '+e.message);
      });
      const done = await page.evaluate(() => ({result:fixture.done,focus:document.activeElement.id,visible:document.visibilityState,hasFocus:document.hasFocus(),writes:fixture.calls.filter(c=>c.method==='PUT'||c.url&&/player\/|lyrics\/offset/.test(c.url)),bridge:fixture.calls.filter(c=>c.method==='BRIDGE')}));
      assert.equal(done.result.result, 'shown'); assert.equal(done.focus, 'np-lyric-offset-down'); assert.equal(done.visible, 'visible'); assert.equal(done.hasFocus, true); assert.deepEqual(done.writes, []);
      assert.equal(await page.locator('#np-tools').isVisible(), true); assert.equal(await page.locator('#np-lyric-offset').isVisible(), true);
      if(options.dbx)assert.deepEqual(done.bridge[0].args, ['fixture.player',{}, {target:'tab'}]);
      mark('Original detail and offset focus: '+JSON.stringify(options));
    }
    await page.screenshot({ path: path.join(output, 'player-calibration.png') });
    await player({ dbx:true, floating:true });
    assert.equal(await page.evaluate(() => fixture.calls.some(c=>c.method==='STARTUP'&&c.name==='floating-snapshot-ready')),true);
    assert.equal(await page.evaluate(() => fixture.calls.find(c=>c.body?.op==='register').body.kind),'floating');
    mark('Production startApp floating branch initializes the calibration receiver after its source snapshot');
    await page.evaluate(() => fixture.enqueue());
    await page.waitForFunction(() => fixture.calls.some(c=>c.method==='BRIDGE'));
    assert.equal(await page.locator('#np-modal').isVisible(), false); assert.equal(await page.evaluate(() => fixture.done), null);
    assert.equal(await page.evaluate(() => fixture.calls.filter(c=>c.method==='BRIDGE').length), 1);
    assert.deepEqual(await page.evaluate(() => fixture.calls.find(c=>c.method==='BRIDGE').args), ['fixture.player', {hertzCalibrationHandoff:'cc85b861-64ae-4e25-9364-e2dd02c7f063'}, {target:'tab'}]);
    mark('Floating DBX page forwards once through the existing workbench bridge and cannot confirm shown');
    await player({dbx:true});
    await page.evaluate(() => { fixture.requiredMarker=fixture.marker;fixture.enqueue('target'); });
    await page.waitForTimeout(850);
    assert.equal(await page.locator('#np-modal').isVisible(), false);
    await page.evaluate(() => fixture.contextListener({hertzCalibrationHandoff:'1a85b861-64ae-4e25-9364-e2dd02c7f063'}));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#np-modal').isVisible(), false);
    await page.evaluate(() => fixture.contextListener({hertzCalibrationHandoff:fixture.marker}));
    await page.waitForFunction(() => fixture.done !== null, null, {timeout:6000});
    assert.equal(await page.evaluate(() => fixture.done.result), 'shown');
    assert.ok(await page.evaluate(() => fixture.calls.some(c=>c.body?.op==='register'&&c.body.handoff===fixture.marker)&&fixture.calls.some(c=>c.body?.op==='claim'&&c.body.handoff===fixture.marker)));
    mark('Only the target receiving the SDK workbench context marker registers and claims the handoff');
    for (const oldResult of ['reject','resolve']) {
      await player({dbx:true});
      await page.evaluate(() => {
        const oldMarker='1a85b861-64ae-4e25-9364-e2dd02c7f063';
        fixture.requiredMarker=oldMarker;fixture.registerHold=oldMarker;
        fixture.contextListener({hertzCalibrationHandoff:oldMarker});
      });
      await page.waitForFunction(() => !!fixture.registerWaiter);
      await page.evaluate(() => {fixture.requiredMarker=fixture.marker;fixture.enqueue('new-context-B');fixture.contextListener({hertzCalibrationHandoff:fixture.marker});});
      await page.waitForFunction(() => fixture.done?.requestId==='new-context-B',null,{timeout:6000});
      await page.evaluate(oldResult => fixture.registerWaiter[oldResult](),oldResult);
      await page.waitForTimeout(850);
      const result=await page.evaluate(() => ({done:fixture.done,markers:fixture.calls.filter(c=>c.body?.op==='register').map(c=>c.body.handoff),oldReceiver:fixture.registerWaiter.receiverId,unregistered:fixture.calls.filter(c=>c.body?.op==='unregister').map(c=>c.body.receiverId)}));
      assert.equal(result.done.result,'shown');
      assert.deepEqual(result.markers,['','1a85b861-64ae-4e25-9364-e2dd02c7f063','cc85b861-64ae-4e25-9364-e2dd02c7f063']);
      if(oldResult==='resolve')assert.ok(result.unregistered.includes(result.oldReceiver));
      mark('Old registration '+oldResult+' cannot clear a newer SDK context or receiver');
    }
    await player({dbx:true});
    await page.evaluate(() => {
      fixture.requiredMarker='1a85b861-64ae-4e25-9364-e2dd02c7f063';fixture.claimHold=true;fixture.enqueue('old-context-A');
      fixture.contextListener({hertzCalibrationHandoff:fixture.requiredMarker});
    });
    await page.waitForFunction(() => !!fixture.claimWaiter);
    await page.evaluate(() => {fixture.requiredMarker=fixture.marker;fixture.enqueue('new-context-B');fixture.contextListener({hertzCalibrationHandoff:fixture.marker});});
    await page.waitForFunction(() => fixture.done?.requestId==='new-context-B',null,{timeout:6000});
    await page.evaluate(() => fixture.claimWaiter());
    await page.waitForTimeout(850);
    assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c=>c.body?.op==='register').map(c=>c.body.handoff)),['','1a85b861-64ae-4e25-9364-e2dd02c7f063','cc85b861-64ae-4e25-9364-e2dd02c7f063']);
    assert.equal(await page.evaluate(() => fixture.calls.some(c=>c.body?.op==='validate'&&c.body.requestId==='old-context-A')),false);
    assert.equal(await page.evaluate(() => fixture.done.requestId),'new-context-B');
    mark('Old claim success cannot reactivate an intent or clear the newer receiver');
    for (const hop of ['claim','validate']) {
      await player();
      await page.evaluate(hop => {fixture.enqueue('late-reply',hop==='claim'?60:4500);if(hop==='claim')fixture.claimDelay=120;else{fixture.validateDelay=120;fixture.validateRemaining=60;}},hop);
      await page.waitForFunction(() => fixture.claimed);
      await page.waitForTimeout(180);
      assert.equal(await page.locator('#np-modal').isVisible(),false);
      assert.equal(await page.evaluate(() => fixture.done),null);
      mark('Delayed '+hop+' reply cannot reset the remaining UI deadline');
    }
    for (const action of ['track', 'revoke', 'cancel', 'timeout']) {
      await player(); await page.evaluate(action => { fixture.delay=1;fixture.enqueue('late',action==='timeout'?60:4500); }, action);
      await page.waitForFunction(() => fixture.waiter !== null);
      await page.evaluate(action => {if(action==='track')fixture.changeTrack();if(action==='revoke')fixture.gate=false;if(action==='cancel')closeNowPlaying();}, action);
      if(action==='timeout')await page.waitForTimeout(90);
      await page.evaluate(() => fixture.releaseDoc()); await page.waitForTimeout(100);
      assert.equal(await page.locator('#np-modal').isVisible(), false); assert.equal(await page.evaluate(() => fixture.done), null);
      mark('Late detail load cannot navigate/focus after '+action);
    }
    await player(); await page.locator('#desktop-calibration-consent').uncheck();
    assert.equal(await page.evaluate(() => fixture.gate), false);
    await page.locator('#desktop-calibration-consent').check(); assert.equal(await page.evaluate(() => fixture.gate), true);
    mark('Original-player UI scope requires an explicit checkbox action and can be revoked');
    await page.evaluate(() => { fixture.failConsent=true; });
    await page.locator('#desktop-calibration-consent').uncheck();
    await page.waitForFunction(() => !document.getElementById('desktop-calibration-revoke-actions').hidden);
    assert.equal(await page.locator('#desktop-calibration-consent').isDisabled(), true);
    assert.equal(await page.locator('#desktop-calibration-consent').isChecked(), false);
    await page.evaluate(() => { fixture.failConsent=false; });
    await page.locator('#desktop-calibration-revoke-retry').click();
    await page.waitForFunction(() => document.getElementById('desktop-calibration-revoke-actions').hidden);
    assert.equal(await page.locator('#desktop-calibration-consent').isDisabled(), false);
    assert.equal(await page.evaluate(() => fixture.calls.filter(c=>c.url?.includes('calibration-authorization')&&c.method==='POST').slice(-2).every(c=>c.body.enabled===false)), true);
    mark('Failed revoke exposes a separate retry that cannot accidentally enable consent');
    await player({holdConsent:true});
    await page.waitForFunction(() => !!fixture.consentWaiter);
    await page.locator('#desktop-calibration-consent').check();
    await page.evaluate(() => fixture.consentWaiter({authorized:false}));
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#desktop-calibration-consent').isChecked(), true);
    assert.match(await page.locator('#desktop-calibration-consent-note').textContent(), /已允许/);
    mark('Late startup consent read cannot overwrite a newer explicit grant');
    await page.close(); page = await browser.newPage({ viewport: { width: 320, height: 560 } });page.on('pageerror',e=>errors.push(e.message));
    await page.setContent(`<html><meta charset="utf-8"><style>${fs.readFileSync(path.join(assets,'desktop-lyrics.css'),'utf8')}</style><body>${fs.readFileSync(path.join(assets,'desktop-lyrics.html'),'utf8')}<script>window.commands=[];window.ipc={postMessage:text=>commands.push(JSON.parse(text))};</script><script>${fs.readFileSync(path.join(assets,'desktop-lyrics.js'),'utf8')}</script></body></html>`);
    await page.evaluate(() => {
      window.snapshot={protocol:1,seq:1,server:{session:'source'},generation:'1',positionMs:500,durationMs:5000,playing:false,buffering:false,track:{id:'first'},lyrics:{status:'ready',documentKey:'doc'},lyricsCalibration:{version:1,available:true,reason:''}};
      hertzLyrics.applyConfig({enabled:true,locked:false,fontSize:72,panelMaxHeight:210});hertzLyrics.applySnapshot(snapshot);hertzLyrics.applyDocument({protocol:1,documentKey:'doc',lines:[{startMs:0,endMs:5000,text:'当前歌词'}]});hertzLyrics.setOptions(true);
    });
    await page.locator('#calibrate').scrollIntoViewIfNeeded(); await page.locator('#calibrate').click();
    assert.equal(await page.locator('#calibrate').isDisabled(), true); assert.equal(await page.locator('#calibrate').textContent(), '正在打开');
    assert.equal(await page.evaluate(() => commands.filter(c=>c.cmd==='calibrate').length), 1);
    await page.evaluate(() => hertzLyrics.calibrationDone({state:'timeout'}));
    assert.match(await page.locator('#calibration-help').textContent(), /未确认/); assert.match(await page.locator('#calibrate').textContent(), /重试/);
    await page.locator('#calibrate').click(); await page.evaluate(() => {snapshot={...snapshot,seq:2,generation:'2',track:{id:'second'}};hertzLyrics.applySnapshot(snapshot);});
    assert.ok(await page.evaluate(() => commands.some(c=>c.cmd==='calibration-cancel')));
    await page.evaluate(() => {hertzLyrics.calibrationDone({state:'permission-required'});hertzLyrics.setLocked(true);});
    assert.equal(await page.locator('#options-panel').isVisible(), false); assert.equal(await page.locator('#calibrate').isDisabled(), true);
    assert.equal(await page.evaluate(() => commands.filter(c=>['play','pause','seek'].includes(c.cmd)).length), 0);
    mark('Desktop button loading/retry/cancellation/lock and narrow large-font scrolling preserve native-only intent');
    await page.evaluate(() => {hertzLyrics.setLocked(false);hertzLyrics.setOptions(true);});await page.locator('#calibrate').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(output,'desktop-narrow.png')});
    assert.deepEqual(errors, []);
    const sources = ['plugin/ui/app.js','plugin/ui/index.html','plugin/ui/now-playing.js','crates/hertz-desktop/assets/desktop-lyrics.js','crates/hertz-desktop/assets/desktop-lyrics.html','crates/hertz-desktop/assets/desktop-lyrics.css','crates/hertz-studio/src/lyrics_calibration.rs','crates/hertz-desktop/src/calibration.rs','crates/hertz-desktop-ipc/src/monotonic.rs','crates/hertz-desktop-ipc/src/lib.rs','crates/hertz-desktop-ipc/Cargo.toml'];
    const report={checks,errors,scope:'Production JS/markup with fixture transport; no OS/native or actual DBX host focus claim',sourceHashes:Object.fromEntries(sources.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]))};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  } finally { await browser.close(); }
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
