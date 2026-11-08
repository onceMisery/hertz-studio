// SPDX-License-Identifier: MIT
// Browser regression for group drafts, public properties and asynchronous inspection.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'crates/hertz-desktop/assets');
const output = path.join(root, 'output/playwright/wallpaper-display-settings');
let html = fs.readFileSync(path.join(assets, 'wallpaper-settings.html'), 'utf8');
for (const [key, file] of Object.entries({ DISPLAYS_CSS:'wallpaper-displays.css', DISPLAYS:'wallpaper-displays.js', SETTINGS:'wallpaper-settings.js', LIBRARY:'wallpaper-library.js', WORKS:'wallpaper-work.js', PLAYLIST:'wallpaper-playlist.js' })) html = html.replace('__' + key + '__', () => fs.readFileSync(path.join(assets, file), 'utf8'));
const presentation = { fps:30, quality:'low', brightness:1, motion:1, fit:'cover', pointer:false };
const payload = {
 revision:9, mediaPreviewAvailable:true, previewActive:false, previewLease:null, launchAtLogin:false, positionEditing:false,
 config:{ enabled:true, audioInput:{kind:'system', device:{kind:'default'}, gain:1.3, attackMs:80, releaseMs:400}, batteryPolicy:'pause', pauseOnFullscreen:true, pauseOnMaximized:false, applicationRules:[], groups:[
 {id:'alpha', mode:'single', displays:[{kind:'fixed',displayId:'screen-a'}], selection:{kind:'builtin',sceneId:'zodiac',stateVersion:1,params:{seed:2}}, presentation:{...presentation}, properties:{}},
 {id:'beta', mode:'single', displays:[{kind:'fixed',displayId:'screen-b'}], selection:{kind:'builtin',sceneId:'coast',stateVersion:1,params:{tod:.4}}, presentation:{...presentation,brightness:.55,fps:60,quality:'high'}, properties:{}}
 ]},
 lyricsConfig:{enabled:true,locked:true,layout:'double',secondary:'next',fontFamily:'Segoe UI',fontSize:32,fontWeight:600,sungColor:'#8fe3ff',unsungColor:'#ffffff',outlineColor:'#000000',outlineWidth:2,opacity:.92,width:900,anchorX:.5,anchorY:.84,monitor:null},
 scenes:[{id:'zodiac',label:'星海'},{id:'coast',label:'海岸'}],
 profile:{dataDir:'D:\\Music\\Hertz',edition:'full'},profiles:[{dataDir:'D:\\Music\\Hertz',edition:'full'}],spaceScene:'zodiac',
 monitors:[{displayId:'screen-a',name:'横屏',label:'横屏 1920 × 1080',primary:true,left:0,top:0,width:1920,height:1080,dpi:96},{displayId:'screen-b',name:'竖屏',label:'竖屏 1440 × 2560',primary:false,left:-1440,top:-420,width:1440,height:2560,dpi:144},{displayId:'screen-c',name:'副屏',primary:false,left:1920,top:0,width:1920,height:1080,dpi:120}],
 runtime:{enabled:true,locked:true,visible:true,source:'ok',userHidden:false,policy:{},diagnostics:{pauseReasons:['fullscreen']},wallpaper:{enabled:true,visible:true,hidden:false,audio:{phase:'running',requested:true,endpoints:[]},targets:[
 {groupId:'alpha',targetId:'ta',enabled:true,visible:true,pageReady:true,fps:30,quality:'low',playlist:{playlistId:'playlist-a',title:'第一组轮播',currentIndex:0,itemCount:4}},
 {groupId:'beta',targetId:'tb',enabled:true,visible:false,pageReady:false,monitorMissing:true,playlist:{playlistId:'playlist-b',title:'第二组轮播',currentIndex:1,itemCount:3,failed:true}}
 ]}}
};
const checks=[]; const errors=[];
async function checkWindowPolicies(page) {
 const policyPayload=structuredClone(payload);
 policyPayload.capabilities={layouts:['single','span','mirror'],multiDisplay:true,mirrorBuiltin:true,mirrorPackages:true,mirrorPlaylists:true};
 async function reset(value=policyPayload) {
  await page.reload();await page.setViewportSize({width:1180,height:900});
  await page.evaluate(value=>hertzWallpaperSettings.applyStatus(value),value);
  await page.locator('#tab-runtime').click();
 }
 const rulePath=index=>page.locator('.application-rule input').nth(index);
 const ruleAction=index=>page.locator('.application-rule select').nth(index);
 const removeRule=index=>page.locator('.application-rule-remove').nth(index);
 await reset();
 assert.equal(await page.locator('#pause-on-fullscreen').isChecked(),true);
 assert.equal(await page.locator('#pause-on-maximized').isChecked(),false);
 assert.equal(await page.locator('#application-rules-empty').isVisible(),true);
 await page.locator('#pause-on-fullscreen').uncheck();assert.equal(await page.locator('#apply').isEnabled(),true);
 await page.locator('#pause-on-fullscreen').check();assert.equal(await page.locator('#settings-state').getAttribute('data-dirty'),'false');
 await page.locator('#tab-wallpaper').click();
 await page.locator('#motion').fill('0.45');await page.locator('#motion').dispatchEvent('change');
 await page.locator('[data-focus-key=group-beta]').click();
 await page.locator('#brightness').fill('0.4');await page.locator('#brightness').dispatchEvent('change');
 await page.locator('#tab-runtime').click();
 await page.locator('#pause-on-fullscreen').uncheck();await page.locator('#pause-on-maximized').check();
 await page.locator('#application-rule-add').click();
 assert.equal(await rulePath(0).evaluate(node=>node===document.activeElement),true);
 assert.equal(await page.locator('#apply').isDisabled(),true);
 assert.match(await page.locator('.application-rule-error').textContent(),/完整可执行文件路径/);
 for(const invalid of ['player.exe','C:player.exe','\\Apps\\player.exe','%ProgramFiles%\\Player.exe','"C:\\Apps\\Player.exe" --fullscreen','C:\\Apps\\*.exe','C:\\Apps\\Player.exe:stream','C:\\Apps.\\Player.exe','C:\\..\\Player.exe','C:\\','\\\\server','\\\\server\\share','\\\\server\\share\\..\\Player.exe','\\\\.\\C:\\Player.exe','\\\\?\\GLOBALROOT\\Device\\Player.exe','C:\\NUL','C:\\con.exe','C:\\LPT1\\Player.exe','C:\\COM¹.exe','\uFEFFC:\\Apps\\Player.exe','C:\\'+'界'.repeat(1022)]) {
  await rulePath(0).fill(invalid);
  assert.equal(await rulePath(0).getAttribute('aria-invalid'),'true',invalid);
  assert.equal(await page.locator('#apply').isDisabled(),true,invalid);
 }
 for(const valid of ['D:\\尚未安装\\播放器.exe','C:\\Apps\\Executable Without Extension','C:\\Apps\\player.bin','C:\\Apps\\CON\uFEFF.exe','C:\\'+'界'.repeat(1021),'C:\\'+'😀'.repeat(510)+'x']) {
  await rulePath(0).fill(valid);
  assert.equal(await rulePath(0).getAttribute('aria-invalid'),'false',valid);
 }
 const firstPath=' C:/Program Files/Player/./bin/../PLAYER.exe ', secondPath='\\\\?\\UNC\\Server\\Share\\Apps\\Player.exe';
 await rulePath(0).fill(firstPath);await ruleAction(0).selectOption('stop');
 await rulePath(0).focus();await rulePath(0).evaluate(node=>node.setSelectionRange(9,14));
 await page.evaluate(value=>{for(let count=0;count<20;count++)hertzWallpaperSettings.applyStatus(value);},policyPayload);
 assert.equal(await rulePath(0).inputValue(),firstPath);
 assert.deepEqual(await rulePath(0).evaluate(node=>({focused:node===document.activeElement,start:node.selectionStart,end:node.selectionEnd})),{focused:true,start:9,end:14});
 await page.locator('#application-rule-add').click();await rulePath(1).fill('c:\\program files\\player\\player.exe');
 assert.equal(await page.locator('.application-rule input[aria-invalid=true]').count(),2);
 assert.match(await page.locator('.application-rule-error').nth(1).textContent(),/同一路径/);
 assert.equal(await page.locator('#apply').isDisabled(),true);
 await rulePath(1).fill(secondPath);
 assert.equal(await page.locator('.application-rule input[aria-invalid=true]').count(),0);
 await page.locator('#tab-wallpaper').click();await page.locator('[data-focus-key=group-alpha]').click();
 assert.equal(await page.locator('#motion').inputValue(),'0.45');
 await page.locator('[data-focus-key=group-beta]').click();assert.equal(await page.locator('#brightness').inputValue(),'0.4');
 await page.locator('#tab-runtime').click();assert.equal(await rulePath(0).inputValue(),firstPath);assert.equal(await ruleAction(0).inputValue(),'stop');
 await page.locator('.window-policy-semantics summary').click();
 for(const width of [1180,390,320]) {
  await page.setViewportSize({width,height:width===1180?900:844});
  await page.evaluate(()=>document.querySelector('main').scrollTop=0);
  const dimensions=await page.evaluate(()=>({viewport:innerWidth,body:document.body.scrollWidth,document:document.documentElement.scrollWidth,main:document.querySelector('main').scrollWidth,mainClient:document.querySelector('main').clientWidth}));
  assert.ok(dimensions.body<=width&&dimensions.document<=width&&dimensions.main<=dimensions.mainClient,JSON.stringify(dimensions));
  await page.screenshot({path:path.join(output,'window-policies-'+width+'.png')});
 }
 await page.setViewportSize({width:1180,height:900});
 await page.evaluate(()=>{const work=document.createElement('input');work.type='number';work.required=true;document.querySelector('#local-library').appendChild(work);window.gateCommand='wallpaper.draft.update';});
 assert.equal(await page.locator('#apply').isEnabled(),true,'an unrelated persistent work form does not invalidate wallpaper settings');
 await page.locator('#apply').click();await page.waitForFunction(()=>!!gates['wallpaper.draft.update']);
 assert.equal(await page.locator('#application-rule-add').isDisabled(),true);assert.equal(await rulePath(0).isDisabled(),true);assert.equal(await ruleAction(0).isDisabled(),true);
 assert.equal(await removeRule(0).isDisabled(),true);assert.equal(await page.locator('#pause-on-maximized').isDisabled(),true);assert.equal(await page.locator('#discard').isDisabled(),true);
 await page.evaluate(()=>{document.querySelector('#apply').dispatchEvent(new Event('click'));gates['wallpaper.draft.update']();delete gates['wallpaper.draft.update'];});
 await page.waitForFunction(()=>requests.some(request=>request.command==='wallpaper.apply'));
 const operations=await page.evaluate(()=>requests.filter(request=>request.command==='wallpaper.draft.update').at(-1).payload.operations);
 assert.equal(operations.filter(operation=>operation.kind==='replaceWallpaper').length,1);
 assert.deepEqual(operations[0].wallpaper.groups.map(group=>group.id),['alpha','beta']);
 assert.equal(operations[0].wallpaper.groups[0].presentation.motion,.45);assert.equal(operations[0].wallpaper.groups[1].presentation.brightness,.4);
 assert.equal(operations[0].wallpaper.pauseOnFullscreen,false);assert.equal(operations[0].wallpaper.pauseOnMaximized,true);
 assert.deepEqual(operations[0].wallpaper.applicationRules,[{executable:'c:\\program files\\player\\player.exe',action:'stop'},{executable:'\\\\server\\share\\apps\\player.exe',action:'pause'}]);
 assert.deepEqual(operations[0].wallpaper.audioInput,policyPayload.config.audioInput);assert.deepEqual(operations[1].lyrics,policyPayload.lyricsConfig);
 assert.equal(await page.evaluate(()=>requests.filter(request=>request.command==='wallpaper.apply').length),1);
 checks.push('window policies validate absolute drive/UNC paths, reserved names, UTF-16 length and alias duplicates; status feeds preserve focus and selection; one canonical replaceWallpaper preserves both groups, audio and lyrics; pending blocks duplicate Apply and policy edits');
 checks.push('window policy screenshots at 1180, 390 and 320 pixels have no document or main horizontal overflow');
 await reset();
 for(let index=0;index<32;index++) {await page.locator('#application-rule-add').click();await rulePath(index).fill('C:\\Apps\\Player-'+index+'.exe');}
 assert.equal(await page.locator('.application-rule').count(),32);assert.equal(await page.locator('#application-rule-add').isDisabled(),true);assert.equal(await page.locator('#application-rules-limit').isVisible(),true);
 await page.evaluate(()=>document.querySelector('#application-rule-add').dispatchEvent(new Event('click')));
 assert.equal(await page.locator('.application-rule').count(),32);
 await removeRule(12).click();assert.equal(await page.locator('.application-rule').count(),31);assert.equal(await rulePath(12).inputValue(),'C:\\Apps\\Player-13.exe');
 assert.equal(await page.locator('#application-rule-add').isEnabled(),true);assert.equal(await page.locator('#application-rules-limit').isVisible(),false);
 await page.locator('#discard').click();assert.equal(await page.locator('.application-rule').count(),0);assert.equal(await page.locator('#application-rules-empty').isVisible(),true);assert.equal(await page.locator('#settings-state').getAttribute('data-dirty'),'false');
 const withSavedRules=structuredClone(policyPayload);withSavedRules.config.applicationRules=[{executable:'c:\\apps\\player.exe',action:'stop'},{executable:'\\\\server\\share\\player.exe',action:'pause'}];
 await reset(withSavedRules);await removeRule(0).click();assert.equal(await rulePath(0).inputValue(),withSavedRules.config.applicationRules[1].executable);
 await page.locator('#discard').click();assert.equal(await page.locator('.application-rule').count(),2);assert.equal(await ruleAction(0).inputValue(),'stop');
 await rulePath(0).fill('C:\\Apps\\Changed.exe');
 const newer=structuredClone(withSavedRules);newer.revision=10;newer.config.pauseOnMaximized=true;
 await page.evaluate(value=>hertzWallpaperSettings.applyStatus(value),newer);
 assert.equal(await page.locator('#conflict').isVisible(),true);assert.equal(await page.locator('#apply').isDisabled(),true);assert.equal(await rulePath(0).isDisabled(),true);assert.equal(await page.locator('#application-rule-add').isDisabled(),true);
 assert.equal(await rulePath(0).inputValue(),'C:\\Apps\\Changed.exe');
 await page.locator('#discard').click();assert.equal(await page.locator('#conflict').isVisible(),false);assert.equal(await rulePath(0).inputValue(),'c:\\apps\\player.exe');assert.equal(await page.locator('#pause-on-maximized').isChecked(),true);
 checks.push('adding 32 rules enforces the limit, removal preserves row order, discard restores saved rules, and conflict retains draft text while blocking mutation until reread');
 const cleanRules=structuredClone(policyPayload);cleanRules.config.applicationRules=[{executable:'c:\\apps\\player.exe',action:'pause'}];
 await reset(cleanRules);await rulePath(0).focus();
 assert.equal(await page.locator('#settings-state').getAttribute('data-dirty'),'false');
 const focusedRule=await rulePath(0).elementHandle(), removedRules=structuredClone(cleanRules);
 removedRules.revision=10;removedRules.config.applicationRules=[];
 await page.evaluate(value=>hertzWallpaperSettings.applyStatus(value),removedRules);
 assert.equal(await page.locator('.application-rule').count(),0);assert.equal(await page.locator('#application-rules-empty').isVisible(),true);
 assert.equal(await focusedRule.evaluate(node=>node.isConnected),false);
 await page.keyboard.type('stale input');
 assert.equal(await page.locator('.application-rule').count(),0);assert.equal(await page.locator('#settings-state').getAttribute('data-dirty'),'false');
 await page.locator('#application-rule-add').click();await rulePath(0).fill('C:\\Apps\\New.exe');assert.equal(await page.locator('#apply').isEnabled(),true);
 await reset(cleanRules);await rulePath(0).focus();
 const replacedRule=structuredClone(cleanRules);replacedRule.revision=10;replacedRule.config.applicationRules=[{executable:'d:\\tools\\updated.exe',action:'stop'}];
 await page.evaluate(value=>hertzWallpaperSettings.applyStatus(value),replacedRule);
 assert.equal(await rulePath(0).inputValue(),'d:\\tools\\updated.exe');assert.equal(await ruleAction(0).inputValue(),'stop');
 assert.equal(await page.locator('#settings-state').getAttribute('data-dirty'),'false');
 checks.push('a clean focused rule follows accepted external revisions: removed rows detach before further typing and retained rows receive new path/action; genuine dirty rules remain protected by conflict handling');
 await reset();await page.locator('#tab-wallpaper').click();
 async function runtimeState(target,extraTargets=[]) {
  const status=structuredClone(policyPayload);
  status.runtime.wallpaper.targets[0]={...status.runtime.wallpaper.targets[0],...target};
  status.runtime.wallpaper.targets.push(...extraTargets);
  await page.evaluate(value=>hertzWallpaperSettings.applyStatus(value),status);
 }
 await runtimeState({visible:true,applicationRule:'pause',staticFrameRetained:true,diagnostics:{pauseReasons:['applicationRule']}});
 assert.match(await page.locator('#wallpaper-state').textContent(),/已暂停.*静态/);assert.equal(await page.locator('#wallpaper-dot').getAttribute('class'),'state-dot');assert.equal(await page.locator('#wallpaper-retry').isVisible(),false);
 await runtimeState({visible:false,pageReady:false,applicationRule:'pause',staticFrameRetained:true,handoff:{visible:true,pauseRetained:true},diagnostics:{pauseReasons:['applicationRule']}});
 assert.match(await page.locator('#wallpaper-state').textContent(),/已暂停.*静态/);assert.doesNotMatch(await page.locator('#wallpaper-detail').textContent(),/原速播放|fps|实际运行/);
 await runtimeState({visible:false,pageReady:false,applicationRule:null,staticFrameRetained:true,handoff:{visible:true,pauseRetained:true},diagnostics:{pauseReasons:['noSurface']},applyError:'原内容重新检查失败'});
 assert.match(await page.locator('#wallpaper-state').textContent(),/未能显示.*保留上一帧/);assert.doesNotMatch(await page.locator('#wallpaper-state').textContent(),/暂停/);
 assert.match(await page.locator('#wallpaper-detail').textContent(),/原内容重新检查失败/);assert.equal(await page.locator('#wallpaper-retry').isVisible(),true);assert.equal(await page.locator('#wallpaper-dot').getAttribute('class'),'state-dot');
 checks.push('a retained long-pause bitmap without an active pause reason does not mask resume failure or suppress remount retry');
 await runtimeState({visible:false,pageReady:false,applicationRule:'stop',handoff:{visible:true},diagnostics:{pauseReasons:['applicationRule','noSurface']}});
 assert.match(await page.locator('#wallpaper-state').textContent(),/已按应用规则停止/);assert.match(await page.locator('#wallpaper-detail').textContent(),/释放.*资源/);assert.equal(await page.locator('#wallpaper-retry').isVisible(),false);
 await runtimeState({visible:true,applicationRule:null,diagnostics:{pauseReasons:['maximized']}});
 assert.match(await page.locator('#wallpaper-state').textContent(),/暂停/);assert.match(await page.locator('#wallpaper-detail').textContent(),/最大化/);assert.equal(await page.locator('#wallpaper-dot').getAttribute('class'),'state-dot');
 await runtimeState({visible:true,applicationRule:null,diagnostics:{pauseReasons:[]}},[{groupId:'alpha',targetId:'ta-mirror',enabled:true,visible:false,pageReady:false,applicationRule:'stop',diagnostics:{pauseReasons:['applicationRule']}}]);
 assert.match(await page.locator('#wallpaper-state').textContent(),/部分目标已停止/);assert.match(await page.locator('#wallpaper-detail').textContent(),/1 个正在显示.*1 个已停止/);
 await runtimeState({visible:true,applicationRule:null,diagnostics:{pauseReasons:[]}});
 assert.equal(await page.locator('#wallpaper-state').textContent(),'壁纸正在运行');
 checks.push('controlled status receipts distinguish Pause, Stop, maximized, retained long-pause frames and partial mirror stop; irrelevant remount actions stay hidden; this browser fixture does not establish Win32 behavior');
}
async function checkPublicProperties(page) {
 const target={kind:'node',nodeId:'content',property:'params.light',component:null};
 const descriptors=[
  {id:'daylight',label:'日照强度',type:'number',default:.6,constraints:{min:0,max:1,step:.2},target},
  {id:'disc-ring',label:'环绕频谱',type:'boolean',default:true,constraints:{},target:{...target,property:'params.discRing'}},
  {id:'palette',label:'配色方案',type:'select',default:true,constraints:{options:[{value:true,label:'自动'},{value:2,label:'第二套'},{value:'2',label:'第二套文字值'}]},target:{...target,property:'params.palette'}},
  {id:'accent',label:'强调颜色',type:'color',default:'#8fe3ff',constraints:{},target:{...target,property:'params.color'}},
  {id:'caption',label:'画面文字',type:'text',default:'海岸',constraints:{maxLength:12},target:{...target,property:'params.caption'}},
  {id:'artwork',label:'背景资源',type:'asset',default:'cover-day',constraints:{kind:'image',options:['cover-day','cover-night']},target:{...target,property:'assetId'}}
 ];
 const value=structuredClone(payload);
 value.capabilities={layouts:['single','span','mirror'],multiDisplay:true,mirrorBuiltin:true,mirrorPackages:true,mirrorPlaylists:true,publicProperties:true};
 value.config.groups[0].selection={kind:'package',workKey:'properties-a',packageHash:'a'.repeat(64)};
 value.config.groups[1].selection={kind:'package',workKey:'properties-b',packageHash:'b'.repeat(64)};
 const input=id=>page.locator('[data-property-id="'+id+'"] [data-property-input]').first();
 const resetProperty=id=>page.locator('[data-property-reset="'+id+'"]');
 const publicRequests=()=>page.evaluate(()=>requests.filter(request=>request.command==='wallpaper.properties.inspect'));
 async function reset(next=value,settings={}) {
  await page.reload();await page.setViewportSize({width:1180,height:900});
  await page.evaluate(({value,descriptors,settings})=>{
   propertySchemas={'properties-a':descriptors,'properties-b':descriptors,'properties-list':descriptors};Object.assign(window,settings);hertzWallpaperSettings.applyStatus(value);
  },{value:next,descriptors,settings});
 }
 async function waitReady(count=6) {await page.waitForFunction(count=>document.querySelectorAll('.public-property').length===count&&document.querySelector('#public-properties').getAttribute('aria-busy')==='false',count);}
 async function releaseProperty() {await page.evaluate(()=>{const reply=gates['wallpaper.properties.inspect'];delete gates['wallpaper.properties.inspect'];reply();});}
 await reset(value,{propertyPageSize:2,gateNextPropertyPage:true});
 await page.waitForFunction(()=>!!gates['wallpaper.properties.inspect']);
 assert.equal(await page.locator('.public-property').count(),0,'partial descriptor pages never expose a partial schema');
 assert.equal(await page.locator('#settings-state').getAttribute('data-dirty'),'false');
 assert.equal(await page.locator('#public-properties-loading').isVisible(),true);
 await releaseProperty();await waitReady();await page.waitForFunction(()=>propertyPending===0&&requests.filter(request=>request.command==='wallpaper.properties.inspect').length===6);
 assert.equal(await input('daylight').inputValue(),'0.6');assert.equal(await input('disc-ring').isChecked(),true);
 assert.equal(await input('palette').inputValue(),'0');assert.equal(await input('accent').inputValue(),'#8fe3ff');
 assert.equal(await input('caption').inputValue(),'海岸');assert.equal(await input('artwork').inputValue(),'0');
 assert.equal(await page.locator('[data-property-color]').getAttribute('type'),'color');
 assert.equal(await resetProperty('daylight').isDisabled(),true);
 assert.equal(await page.locator('#settings-state').getAttribute('data-dirty'),'false');
 assert.equal(await page.evaluate(()=>requests.filter(request=>request.command==='wallpaper.draft.update').length),0,'schema/default reads never write a draft');
 const readCount=(await publicRequests()).length;
 await page.evaluate(value=>{for(let index=0;index<20;index++)hertzWallpaperSettings.applyStatus(value);},value);
 assert.equal((await publicRequests()).length,readCount,'ordinary status polling does not read public property metadata again');
 await input('daylight').fill('0.73');assert.equal(await input('daylight').evaluate(node=>node.validity.valid),true,'step is a hint, not an enforced grid');
 await input('disc-ring').uncheck();await input('palette').selectOption('1');await input('accent').fill('#abcdef');await input('caption').fill('晚风');await input('artwork').selectOption('1');
 await input('caption').focus();await input('caption').evaluate(node=>node.setSelectionRange(1,2));
 await page.evaluate(value=>hertzWallpaperSettings.applyStatus(value),value);
 assert.deepEqual(await input('caption').evaluate(node=>({focused:document.activeElement===node,start:node.selectionStart,end:node.selectionEnd,value:node.value})),{focused:true,start:1,end:2,value:'晚风'});
 await page.locator('#preview').click();await page.waitForFunction(()=>requests.some(request=>request.command==='wallpaper.preview.acquire'));
 assert.deepEqual(await page.evaluate(()=>nativeWallpaper.groups[0].properties),{daylight:.73,'disc-ring':false,palette:2,accent:'#abcdef',caption:'晚风',artwork:'cover-night'});
 assert.deepEqual(await page.evaluate(()=>nativeWallpaper.groups[1].properties),{});
 assert.deepEqual(await page.evaluate(()=>nativeWallpaper.audioInput),value.config.audioInput);
 await page.waitForFunction(()=>!document.querySelector('#preview').disabled);
 await input('palette').selectOption('2');await page.waitForFunction(()=>nativeWallpaper.groups[0].properties.palette==='2');
 assert.equal(await page.evaluate(()=>requests.filter(request=>request.command==='wallpaper.preview.update').at(-1).payload.groupId),'alpha');
 await page.locator('[data-focus-key=group-beta]').click();await input('daylight').fill('0.2');await input('disc-ring').uncheck();
 await page.locator('[data-focus-key=group-alpha]').click();assert.equal(await input('daylight').inputValue(),'0.73');assert.equal(await input('palette').inputValue(),'2');
 await resetProperty('daylight').click();assert.equal(await input('daylight').inputValue(),'0.6');assert.equal(await resetProperty('daylight').isDisabled(),true);
 await page.locator('[data-focus-key=group-beta]').click();assert.equal(await input('daylight').inputValue(),'0.2');
 await page.locator('[data-focus-key=group-alpha]').click();
 await input('daylight').fill('2');assert.equal(await page.locator('#apply').isDisabled(),true);assert.equal(await input('daylight').getAttribute('aria-invalid'),'true');assert.match(await page.locator('[data-property-id=daylight] .public-property-error').textContent(),/0 至 1/);
 await resetProperty('daylight').click();assert.equal(await page.locator('#apply').isEnabled(),true);
 await input('accent').fill('red');assert.equal(await page.locator('#apply').isDisabled(),true);await resetProperty('accent').click();
 await page.evaluate(()=>{const node=document.querySelector('[data-property-id=caption] input');node.value='字'.repeat(13);node.dispatchEvent(new Event('input',{bubbles:true}));});assert.equal(await page.locator('#apply').isDisabled(),true);await resetProperty('caption').click();
 for(const width of [1180,390,320]){
  await page.setViewportSize({width,height:900});await page.locator('#public-properties').scrollIntoViewIfNeeded();
  const dimensions=await page.evaluate(()=>({viewport:innerWidth,body:document.body.scrollWidth,document:document.documentElement.scrollWidth,main:document.querySelector('main').scrollWidth,mainClient:document.querySelector('main').clientWidth}));
  assert.ok(dimensions.body<=width&&dimensions.document<=width&&dimensions.main<=dimensions.mainClient,JSON.stringify(dimensions));
  await page.screenshot({path:path.join(output,'public-properties-'+width+'.png')});
 }
 await page.setViewportSize({width:1180,height:900});
 await page.evaluate(()=>{const unrelated=document.createElement('input');unrelated.type='number';unrelated.required=true;document.querySelector('#local-library').appendChild(unrelated);});
 assert.equal(await page.locator('#apply').isEnabled(),true,'independent work-form validity cannot block settings');
 await page.locator('#apply').click();await page.waitForFunction(()=>requests.some(request=>request.command==='wallpaper.apply'));
 const whole=await page.evaluate(()=>requests.filter(request=>request.command==='wallpaper.draft.update').at(-1).payload.operations[0].wallpaper);
 assert.deepEqual(whole.groups[0].properties,{'disc-ring':false,palette:'2',artwork:'cover-night'});assert.deepEqual(whole.groups[1].properties,{daylight:.2,'disc-ring':false});assert.deepEqual(whole.audioInput,value.config.audioInput);
 checks.push('six public-property widgets use typed values and declared bounds; defaults never become overrides; number step stays a hint; per-group Reset removes only its key; preview and Apply carry complete group drafts and global audio; ordinary status feeds preserve typing/caret; 1180/390/320px screenshots have no horizontal overflow');

 await reset();await waitReady();await input('daylight').fill('0.4');await page.locator('[data-focus-key=group-beta]').click();await input('daylight').fill('0.3');
 await page.evaluate(()=>hertzWallpaperSettings.chooseLibraryVersion({workKey:'properties-b',kind:'builtin',title:'已选作品'},{state:'installed',packageHash:'b'.repeat(64)},'beta'));
 assert.equal(await input('daylight').inputValue(),'0.3','reselecting the identical content preserves the override');
 await page.evaluate(()=>hertzWallpaperSettings.chooseLibraryVersion({workKey:'properties-new',kind:'builtin',title:'新作品'},{state:'installed',packageHash:'c'.repeat(64)},'beta'));
 assert.deepEqual(await page.evaluate(()=>nativeWallpaper.groups[1].properties),{});assert.deepEqual(await page.evaluate(()=>nativeWallpaper.groups[0].properties),{daylight:.4});
 await page.waitForFunction(()=>document.querySelector('#public-properties-status').textContent.includes('没有可调整'));
 assert.equal(await page.locator('.public-property').count(),0);
 await page.locator('[data-focus-key=group-alpha]').click();await page.locator('#scene-source').selectOption('fixed');
 assert.equal(await page.locator('#public-properties').isVisible(),false);await page.locator('#apply').click();await page.waitForFunction(()=>requests.some(request=>request.command==='wallpaper.apply'));
 assert.deepEqual(await page.evaluate(()=>nativeWallpaper.groups[0].properties),{});
 checks.push('explicit content changes clear only that group’s overrides; reselecting the same content retains values; empty and builtin selections remove stale controls');

 const unknown=structuredClone(value);unknown.config.groups[0].properties={removed:7,daylight:2};
 await reset(unknown);await waitReady(7);assert.equal(await page.locator('#settings-state').getAttribute('data-dirty'),'false');
 assert.match(await page.locator('[data-property-id=removed] .public-property-error').textContent(),/无法使用/);
 await page.locator('#enabled').uncheck();assert.equal(await page.locator('#apply').isDisabled(),true);
 await resetProperty('removed').click();assert.equal(await page.locator('#apply').isDisabled(),true);await resetProperty('daylight').click();assert.equal(await page.locator('#apply').isEnabled(),true);
 checks.push('unknown and out-of-range saved overrides stay visible with explicit Reset; neither is silently dropped or allowed through Apply');

 await reset(value,{propertyFailureCode:'version_not_found'});await page.waitForFunction(()=>document.querySelector('#public-properties-retry').hidden===false);
 assert.equal(await page.locator('.public-property').count(),0);await page.locator('#enabled').uncheck();assert.equal(await page.locator('#apply').isEnabled(),true,'empty unchanged properties do not prevent disabling damaged content');
 await page.evaluate(()=>propertyFailureCode='');await page.locator('#public-properties-retry').click();await waitReady();
 await input('daylight').fill('0.5');await page.evaluate(()=>{propertyBusyReplies=5;window.dispatchEvent(new Event('wallpaper-properties-invalidated'));});
 await page.waitForFunction(()=>document.querySelector('#public-properties-retry').hidden===false);
 assert.equal(await page.locator('#apply').isDisabled(),true);assert.equal(await page.evaluate(()=>propertyBusyReplies),0,'each of two group inspections uses a bounded three-attempt retry budget');
 const afterBusy=(await publicRequests()).length;await page.waitForTimeout(1200);assert.equal((await publicRequests()).length,afterBusy,'failed property reads stop retrying');
 await page.locator('#public-properties-retry').click();await waitReady();assert.equal(await page.locator('#apply').isEnabled(),true);
 assert.equal(await page.evaluate(()=>propertyMaxPending),1);assert.equal(new Set((await publicRequests()).map(request=>request.requestId)).size,(await publicRequests()).length);
 checks.push('failed reads show retry/empty state without stale controls; changed overrides fail closed; empty saved settings can disable damaged content; busy reads retry at most three times per group with fresh IDs and one request in flight');

 await reset(value,{gateCommand:'wallpaper.properties.inspect'});await page.waitForFunction(()=>!!gates['wallpaper.properties.inspect']);
 await page.locator('[data-focus-key=group-beta]').click();assert.equal(await page.locator('.public-property').count(),0);assert.equal(await page.locator('#public-properties-loading').isVisible(),true);
 await releaseProperty();await waitReady();assert.equal(await page.evaluate(()=>hertzWallpaperSettings.currentGroupId()),'beta');await input('daylight').fill('0.3');
 await page.evaluate(()=>{gateCommand='wallpaper.properties.inspect';window.dispatchEvent(new Event('wallpaper-properties-invalidated'));});await page.waitForFunction(()=>!!gates['wallpaper.properties.inspect']);
 await page.locator('#scene-source').selectOption('fixed');await releaseProperty();await page.waitForFunction(()=>propertyPending===0);assert.equal(await page.locator('#public-properties').isVisible(),false);
 assert.equal(await page.locator('.public-property').count(),0,'late old selection response never renders onto builtin content');
 checks.push('late public-property replies after group/selection switches cannot repaint or alter the new group');

 const single=structuredClone(value);single.config.groups[1].selection=payload.config.groups[1].selection;
 await reset(single,{propertyPageSize:2,gateNextPropertyPage:true});await page.waitForFunction(()=>!!gates['wallpaper.properties.inspect']);
 await page.evaluate(()=>propertyVersion++);await releaseProperty();await page.waitForFunction(()=>document.querySelector('#public-properties-retry').hidden===false);
 assert.equal(await page.locator('.public-property').count(),0);assert.match(await page.locator('#public-properties-status').textContent(),/列表内容已变化/);
 await page.locator('#public-properties-retry').click();await waitReady();
 await page.evaluate(()=>{propertySchemas['properties-list']=[propertySchemas['properties-a'][0]];return hertzWallpaperSettings.choosePlaylist({playlistId:'properties-list'},'alpha');});await waitReady(1);
 assert.match(await page.locator('#public-properties-status').textContent(),/每一项都相同/);
 await input('daylight').fill('0.7');await page.evaluate(()=>{propertySchemas['properties-list']=[];propertyVersion++;return hertzWallpaperSettings.requestManagement('wallpaper.playlist.save',{playlistId:'properties-list'});});
 await page.waitForFunction(()=>!!document.querySelector('[data-property-id=daylight] .public-property-error')?.textContent.includes('无法使用'));
 assert.equal(await page.locator('[data-property-input]').count(),0);assert.equal(await page.locator('#apply').isDisabled(),true);await resetProperty('daylight').click();assert.equal(await page.locator('#apply').isEnabled(),true);
 checks.push('pagination rejects changed snapshots instead of combining schema versions; playlist intersection shows only common descriptors, and same-ID playlist saves invalidate stale descriptors and retain unknown overrides for explicit Reset');

 await reset(single);await waitReady();await input('daylight').fill('0.75');
 await page.evaluate(()=>{gateCommand='wallpaper.properties.inspect';window.dispatchEvent(new Event('wallpaper-properties-invalidated'));});await page.waitForFunction(()=>!!gates['wallpaper.properties.inspect']);
 const external=structuredClone(single);external.revision=10;external.config.groups[0].properties={daylight:.9};
 await page.evaluate(value=>hertzWallpaperSettings.applyStatus(value),external);await releaseProperty();await waitReady();
 assert.equal(await input('daylight').inputValue(),'0.75');assert.equal(await input('daylight').isDisabled(),true);assert.equal(await page.locator('#apply').isDisabled(),true);assert.equal(await page.locator('#conflict').isVisible(),true);
 await page.locator('#discard').click();await waitReady();assert.equal(await input('daylight').inputValue(),'0.9');assert.equal(await page.locator('#settings-state').getAttribute('data-dirty'),'false');
 await page.evaluate(()=>{gateCommand='wallpaper.properties.inspect';window.dispatchEvent(new Event('wallpaper-properties-invalidated'));});await page.waitForFunction(()=>!!gates['wallpaper.properties.inspect']);
 const newProfile=structuredClone(external);newProfile.revision=11;newProfile.profile.dataDir='D:\\Music\\PropertiesOther';newProfile.profiles=[newProfile.profile];newProfile.message='已切换来源';newProfile.config.groups[0].selection=payload.config.groups[0].selection;newProfile.config.groups[0].properties={};
 await page.evaluate(value=>hertzWallpaperSettings.applyStatus(value),newProfile);await releaseProperty();await page.waitForFunction(()=>propertyPending===0);
 assert.equal(await page.locator('#public-properties').isVisible(),false);assert.equal(await page.locator('.public-property').count(),0);assert.equal(await page.evaluate(()=>propertyMaxPending),1);
 checks.push('conflicting external revisions retain edited values with Apply disabled; Discard adopts saved overrides; previous-profile responses cannot restore controls after source replacement');
}
(async()=>{
 fs.mkdirSync(output,{recursive:true});
 const server=http.createServer((req,res)=>{if(req.url.startsWith('/scene-thumbnails/')){res.setHeader('Content-Type','image/jpeg');return res.end(fs.readFileSync(path.join(assets,'scene-thumbnails',path.basename(req.url))));}res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1180,height:900},reducedMotion:'reduce'});
 page.on('pageerror', e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.requests=[]; window.gates={}; window.currentNativeDraft=null; window.fixtureLease=0;
  window.layoutPending=0;window.layoutMaxPending=0;window.layoutFailures=0;window.layoutDenied=false;
  window.layoutPendingReplies=0;window.layoutBusyReplies=0;
  window.propertySchemas={};window.propertyVersion=1;window.propertyPageSize=32;window.propertyPending=0;window.propertyMaxPending=0;window.propertyBusyReplies=0;window.propertyFailureCode='';
  window.capabilities={layouts:['single']};
  window.ipc={postMessage(text){
   const req=JSON.parse(text);requests.push(req);if(req.protocol!==2)return;
   if(req.command==='wallpaper.layout.inspect'){layoutPending++;layoutMaxPending=Math.max(layoutMaxPending,layoutPending);}
   if(req.command==='wallpaper.properties.inspect'){propertyPending++;propertyMaxPending=Math.max(propertyMaxPending,propertyPending);}
   const answer=()=>{
    let result={};
    if(req.command==='wallpaper.layout.inspect'){
     layoutPending--;
     if(layoutBusyReplies>0){layoutBusyReplies--;queueMicrotask(()=>hertzWallpaperSettings.applyManagement({protocol:2,requestId:req.requestId,ok:false,error:{code:'budget_busy',message:'已有检查仍在读取文件'}}));return;}
     if(layoutPendingReplies>0){layoutPendingReplies--;queueMicrotask(()=>hertzWallpaperSettings.applyManagement({protocol:2,requestId:req.requestId,ok:true,result:{pending:true}}));return;}
     if(layoutFailures>0){layoutFailures--;queueMicrotask(()=>hertzWallpaperSettings.applyManagement({protocol:2,requestId:req.requestId,ok:false,error:{code:'query_timeout',message:'检查超时'}}));return;}
     const selection=req.payload.selection,integrated=['builtin','followHertz'].includes(selection.kind),video=selection.kind==='package'&&selection.workKey.startsWith('video');
     const maxMembers=video?2:4,mirrorEligible=!integrated&&!layoutDenied&&req.payload.members<=maxMembers;
     result={layouts:mirrorEligible?['single','span','mirror']:['single','span'],mirrorEligible,maxMembers,...(!mirrorEligible?{reason:integrated?'内置场景仅支持单屏或跨屏':layoutDenied?'列表中有尚未就绪的版本':'视频镜像最多支持 2 个显示器'}:{})};
    }
    if(req.command==='wallpaper.capabilities')result=capabilities;
    if(req.command==='wallpaper.properties.inspect'){
     propertyPending--;
     const fail=(code,message)=>queueMicrotask(()=>hertzWallpaperSettings.applyManagement({protocol:2,requestId:req.requestId,ok:false,error:{code,message}}));
     if(propertyBusyReplies>0){propertyBusyReplies--;fail('budget_busy','当前读取繁忙');return;}
     if(propertyFailureCode){fail(propertyFailureCode,'作品内容暂不可用');return;}
     const snapshot=String(propertyVersion).padStart(64,'0'),cursor=req.payload.cursor?JSON.parse(req.payload.cursor):null;
     if(cursor&&cursor.snapshot!==snapshot){fail('properties_changed','列表内容已变化，请重新读取');return;}
     const selection=req.payload.selection,properties=propertySchemas[selection.workKey||selection.playlistId]||[],start=cursor?cursor.offset:0;
     const end=Math.min(properties.length,start+Math.min(req.payload.limit,propertyPageSize));
     result={properties:properties.slice(start,end),snapshot,nextCursor:end<properties.length?JSON.stringify({offset:end,snapshot}):null};
     if(window.gateNextPropertyPage&&result.nextCursor){window.gateNextPropertyPage=false;window.gateCommand='wallpaper.properties.inspect';}
    }
    if(req.command==='wallpaper.draft.create')result=currentNativeDraft={draftId:'settings-draft',draftRevision:1,baseRevision:window.fixtureRevision||9};
    if(req.command==='wallpaper.draft.update'){result=currentNativeDraft={...currentNativeDraft,draftRevision:currentNativeDraft.draftRevision+1};window.nativeWallpaper=req.payload.operations[0].wallpaper;}
    if(req.command==='wallpaper.draft.discard'){currentNativeDraft=null;result={discarded:true};}
    if(req.command==='wallpaper.preview.acquire')result={leaseId:'lease-'+(++fixtureLease)};
    if(req.command==='wallpaper.preview.update')result={leaseId:req.payload.leaseId};
    if(req.command==='wallpaper.preview.release'){hertzWallpaperSettings.unmountPreview();result={released:true};}
    if(req.command==='wallpaper.preview.renew')result={leaseId:req.payload.leaseId};
    if(req.command==='wallpaper.playlist.save')result={...req.payload,playlistId:'playlist-new',title:req.payload.title,revision:1};
    if(req.command==='wallpaper.playlist.list')result={playlists:[],nextCursor:null};
    if(req.command==='wallpaper.library.list')result={works:[],nextCursor:null};
    if(req.command==='wallpaper.library.get')result={work:{workKey:req.payload.workKey,title:'海边影像',kind:'video'},versions:[{packageHash:'a'.repeat(64),version:2,state:'installed'}]};
    if(req.command==='wallpaper.library.poster')result={poster:null};
    if(req.command==='wallpaper.status')result={activeJob:null,capabilities:{previewMedia:true}};
    if(req.command==='wallpaper.apply')result={saved:true,configRevision:10};
    queueMicrotask(()=>hertzWallpaperSettings.applyManagement({protocol:2,requestId:req.requestId,ok:true,result}));
   };
   if(window.gateCommand===req.command){window.gateCommand=null;window.gates[req.command]=answer;}else answer();
  }};
 });
 try{
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(value=>hertzWallpaperSettings.applyStatus(value),payload);
  await page.waitForFunction(()=>document.querySelector('.hd-notice')?.textContent.includes('尚未开放'));
  assert.equal(await page.locator('[data-focus-key=add-group]').isDisabled(),true);
  assert.equal(await page.locator('[data-focus-key=mode]').isDisabled(),true);
  assert.equal(await page.locator('#monitor').count(),0);
  await page.locator('[data-focus-key=group-beta]').click();
  assert.equal(await page.locator('#scene-fixed').inputValue(),'coast');
  assert.equal(await page.locator('#brightness').inputValue(),'0.55');
  assert.equal(await page.locator('#settings-state').getAttribute('data-dirty'),'false');
  assert.equal(await page.locator('#wallpaper-state').textContent(),'目标显示器未连接');
  assert.match(await page.locator('#playlist-runtime').textContent(),/第二组轮播/);
  await page.locator('#playlist-editor > summary').click();
  await page.locator('#playlist-retry').click();
  assert.deepEqual(await page.evaluate(()=>requests.filter(r=>r.command==='wallpaper.playlist.next').at(-1).payload),{playlistId:'playlist-b',groupId:'beta',retry:true});
  checks.push('actual single-only capability response locks group writes; selecting beta stays clean and shows beta runtime/playlist');
  await page.evaluate(value=>hertzWallpaperSettings.applyStatus({...value,capabilities:window.capabilities={layouts:['single','mirror','span'],multiDisplay:true,mirrorBuiltin:true,mirrorPackages:true,mirrorPlaylists:true}}),payload);
  await page.locator('#brightness').fill('0.4'); await page.locator('#brightness').dispatchEvent('change');
  await page.locator('[data-focus-key=group-alpha]').click();
  assert.equal(await page.locator('#brightness').inputValue(),'1');
  await page.locator('#motion').fill('0.3');await page.locator('#motion').dispatchEvent('change');
  await page.locator('[data-focus-key=group-beta]').click();
  assert.equal(await page.locator('#brightness').inputValue(),'0.4');
  await page.locator('#preview').click();
  await page.waitForFunction(()=>requests.some(r=>r.command==='wallpaper.preview.acquire'));
  await page.waitForFunction(()=>document.querySelector('#preview').textContent==='结束预览'&&!document.querySelector('#preview').disabled);
  let native=await page.evaluate(()=>({wallpaper:nativeWallpaper,preview:requests.filter(r=>r.command==='wallpaper.preview.acquire').at(-1).payload}));
  assert.deepEqual(native.wallpaper.groups.map(g=>g.id),['alpha','beta']);
  assert.equal(native.wallpaper.groups[0].presentation.motion,.3);assert.equal(native.wallpaper.groups[1].presentation.brightness,.4);assert.equal(native.preview.groupId,'beta');
  await page.locator('#brightness').fill('0.35'); await page.locator('#brightness').dispatchEvent('change'); await page.waitForFunction(()=>requests.some(r=>r.command==='wallpaper.preview.update')); assert.equal(await page.evaluate(()=>requests.filter(r=>r.command==='wallpaper.preview.update').at(-1).payload.groupId),'beta'); await page.waitForFunction(()=>!document.querySelector('#preview').disabled); const lease=await page.evaluate(()=>'lease-'+fixtureLease);
  await page.locator('[data-focus-key=group-alpha]').click();
  await page.waitForFunction(lease=>requests.some(r=>r.command==='wallpaper.preview.release'&&r.payload.leaseId===lease),lease);
  assert.equal(await page.locator('#preview').textContent(),'开始预览');
  checks.push('separate group edits preserve original group order in one replaceWallpaper; preview acquire identifies beta and switching alpha releases its only lease');
  await page.evaluate(()=>window.gateCommand='wallpaper.preview.acquire');
  await page.locator('#preview').click();
  await page.waitForFunction(()=>!!gates['wallpaper.preview.acquire']);
  await page.locator('[data-focus-key=group-beta]').click();
  await page.evaluate(()=>{gates['wallpaper.preview.acquire']();delete gates['wallpaper.preview.acquire'];});
  await page.waitForFunction(()=>!document.querySelector('#preview').disabled);
  assert.equal(await page.locator('#preview').textContent(),'开始预览');
  assert.ok(await page.evaluate(()=>requests.some(r=>r.command==='wallpaper.preview.release'&&r.payload.leaseId==='lease-2')));
  checks.push('acquire receipt arriving after group switch is released without adopting the stale preview');
  await page.evaluate(async()=>hertzWallpaperSettings.chooseLibraryVersion({workKey:'video-1',title:'海边影像',kind:'video'},{state:'installed',version:2,packageHash:'a'.repeat(64)}));
  native=await page.evaluate(()=>nativeWallpaper);
  assert.equal(native.groups[1].selection.workKey,'video-1');assert.equal(native.groups[0].selection.sceneId,'zodiac');assert.deepEqual(native.audioInput,payload.config.audioInput);
  assert.equal(await page.locator('#music').isEnabled(),true);assert.equal(await page.locator('#audio-device').isEnabled(),true);assert.equal(await page.locator('#audio-options').isVisible(),true);
  await page.locator('[data-focus-key=group-alpha]').click();
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('wallpaper-playlist-add',{detail:{work:{workKey:'video-1',title:'海边影像'},version:{packageHash:'a'.repeat(64),version:2}}})));
  await page.evaluate(()=>window.gateCommand='wallpaper.playlist.save');
  await page.locator('#playlist-choose').click();
  await page.waitForFunction(()=>!!gates['wallpaper.playlist.save']);
  await page.locator('[data-focus-key=group-beta]').click();
  await page.evaluate(()=>{gates['wallpaper.playlist.save']();delete gates['wallpaper.playlist.save'];});
  await page.waitForFunction(()=>window.nativeWallpaper.groups[0].selection.kind==='playlist');
  native=await page.evaluate(()=>nativeWallpaper);
  assert.equal(native.groups[0].selection.kind,'playlist');assert.equal(native.groups[1].selection.workKey,'video-1');assert.equal(await page.evaluate(()=>hertzWallpaperSettings.currentGroupId()),'beta');
  checks.push('media selection keeps global system audio enabled; playlist async save captures original group across a switch');
  await page.locator('[data-focus-key=add-group]').click();
  const added=await page.evaluate(()=>hertzWallpaperSettings.currentGroupId());
  assert.ok(!['alpha','beta'].includes(added));
  assert.match(await page.locator('#wallpaper-state').textContent(),/尚未应用/);assert.equal(await page.locator('#playlist-runtime').textContent(),'');
  assert.equal(await page.locator('.hd-group').count(),3);
  await page.locator('[data-focus-key=remove-group]').click();
  assert.equal(await page.locator('.hd-group').count(),2);
  assert.equal(await page.evaluate(()=>hertzWallpaperSettings.currentGroupId()),'alpha');
  checks.push('new group becomes selected without runtime leakage; removing it preserves the remaining groups');
  await page.locator('#playlist-editor > summary').click();
  await page.evaluate(()=>document.querySelector('main').scrollTop=0); await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
  for(const width of [390,320]){
   await page.setViewportSize({width,height:844});
   await page.evaluate(()=>document.querySelector('main').scrollTop=0);
   const size=await page.evaluate(()=>({viewport:innerWidth,body:document.body.scrollWidth,document:document.documentElement.scrollWidth,main:document.querySelector('main').scrollWidth,mainClient:document.querySelector('main').clientWidth}));
   await page.screenshot({path:path.join(output,'mobile-'+width+'.png')}); if(size.main>size.mainClient) console.log(await page.locator('#panel-wallpaper *').evaluateAll(nodes=>nodes.map(n=>({tag:n.tagName,id:n.id,class:n.className,left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,width:n.getBoundingClientRect().width})).filter(n=>n.right>innerWidth))); assert.ok(size.document<=width&&size.body<=width&&size.main<=size.mainClient,JSON.stringify(size));
   await page.screenshot({path:path.join(output,'mobile-'+width+'.png')});
  }
  checks.push('390px and 320px mobile viewports have no document or main horizontal overflow');
  await page.locator('#apply').click(); await page.waitForFunction(()=>requests.some(r=>r.command==='wallpaper.apply')); const applied=await page.evaluate(()=>requests.filter(r=>r.command==='wallpaper.draft.update').at(-1).payload.operations); assert.equal(applied.filter(op=>op.kind==='replaceWallpaper').length,1); assert.deepEqual(applied[0].wallpaper.groups.map(g=>g.id),['alpha','beta']); assert.equal(applied[0].wallpaper.groups[0].selection.playlistId,'playlist-new'); assert.equal(applied[0].wallpaper.groups[1].selection.workKey,'video-1'); assert.deepEqual(applied[0].wallpaper.audioInput,payload.config.audioInput); checks.push('Apply sends the whole two-group wallpaper in one replaceWallpaper operation and ignores independent work form validity'); assert.deepEqual(errors,[]);
  await page.reload();await page.setViewportSize({width:1180,height:900});
  const inspectCapabilities={layouts:['single','span','mirror'],multiDisplay:true,mirrorInspection:true,mirrorBuiltin:false,mirrorPackages:false,mirrorPlaylists:false};
  const inspectPayload=structuredClone(payload);inspectPayload.capabilities=inspectCapabilities;
  inspectPayload.config.groups[0].selection={kind:'package',workKey:'image-a',packageHash:'a'.repeat(64)};
  const mirrorOption=()=>page.locator('[data-focus-key=mode] option[value=mirror]');
  const requestsForLayout=()=>page.evaluate(()=>requests.filter(r=>r.command==='wallpaper.layout.inspect'));
  await page.evaluate(value=>{window.gateCommand='wallpaper.layout.inspect';hertzWallpaperSettings.applyStatus(value);},inspectPayload);
  await page.waitForFunction(()=>!!gates['wallpaper.layout.inspect']);
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),true);
  assert.match(await page.locator('.hd-capability-note').textContent(),/正在检查/);
  assert.equal((await requestsForLayout()).length,1,'only one group inspection can be in flight');
  await page.evaluate(()=>{gates['wallpaper.layout.inspect']();delete gates['wallpaper.layout.inspect'];});
  await page.waitForFunction(()=>requests.filter(r=>r.command==='wallpaper.layout.inspect').length===2&&layoutPending===0);
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),false,'installed image result enables this group mirror');
  await page.locator('[data-focus-key=group-beta]').click();
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),true);
  assert.match(await page.locator('.hd-capability-note').textContent(),/内置场景/);
  const inspectedCount=(await requestsForLayout()).length;
  await page.evaluate(value=>{for(let i=0;i<30;i++)hertzWallpaperSettings.applyStatus(value);},inspectPayload);
  await page.waitForTimeout(50);
  assert.equal((await requestsForLayout()).length,inspectedCount,'unchanged runtime/status feeds do not trigger inspection');
  assert.equal(await page.evaluate(()=>layoutMaxPending),1);
  checks.push('inspection enables only the eligible group; pending and built-in content stay disabled; repeated status feeds do not inspect again');

  await page.locator('[data-focus-key=group-alpha]').click();
  await page.evaluate(()=>{window.gateCommand='wallpaper.layout.inspect';return hertzWallpaperSettings.chooseLibraryVersion({workKey:'video-new',kind:'video',title:'视频'},{state:'installed',version:1,packageHash:'b'.repeat(64)},'alpha');});
  await page.waitForFunction(()=>!!gates['wallpaper.layout.inspect']);
  await page.locator('#scene-source').selectOption('fixed');
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),true);
  await page.evaluate(()=>{gates['wallpaper.layout.inspect']();delete gates['wallpaper.layout.inspect'];});
  await page.waitForFunction(()=>layoutPending===0&&!!document.querySelector('.hd-capability-note')?.textContent.includes('内置场景'));
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),true,'old eligible media reply cannot authorize newer builtin selection');
  checks.push('late eligible inspection cannot authorize a replacement selection');

  await page.evaluate(()=>hertzWallpaperSettings.chooseLibraryVersion({workKey:'video-two',kind:'video',title:'双屏视频'},{state:'installed',version:1,packageHash:'c'.repeat(64)},'alpha'));
  await page.waitForFunction(()=>!document.querySelector('[data-focus-key=mode] option[value=mirror]').disabled);
  await page.evaluate(()=>window.gateCommand='wallpaper.layout.inspect');
  await page.locator('[data-focus-key=mode]').selectOption('mirror');
  await page.waitForFunction(()=>!!gates['wallpaper.layout.inspect']);
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),true);assert.equal(await page.locator('#apply').isDisabled(),true);
  await page.evaluate(()=>{gates['wallpaper.layout.inspect']();delete gates['wallpaper.layout.inspect'];});
  await page.waitForFunction(()=>!document.querySelector('[data-focus-key=mode] option[value=mirror]').disabled);
  assert.equal(await page.locator('#apply').isDisabled(),false);
  await page.locator('[data-focus-key=group-beta]').click();await page.locator('[data-focus-key=remove-group]').click();
  await page.evaluate(()=>window.gateCommand='wallpaper.layout.inspect');
  await page.locator('[data-focus-key=add-member]').click();
  await page.waitForFunction(()=>!!gates['wallpaper.layout.inspect']);
  assert.equal(await page.locator('#apply').isDisabled(),true);
  await page.evaluate(()=>{gates['wallpaper.layout.inspect']();delete gates['wallpaper.layout.inspect'];});
  await page.waitForFunction(()=>!!document.querySelector('.hd-capability-note')?.textContent.includes('最多支持 2'));
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),true);assert.equal(await page.locator('#apply').isDisabled(),true);
  assert.equal((await requestsForLayout()).at(-1).payload.members,3);
  await page.locator('[data-focus-key=remove-member-2]').click();
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),false,'verified two-member cache is usable after removing the third display');
  checks.push('member-count changes close mirror until inspected; three-video-member denial blocks Apply; returning to verified two members reuses cache');

  await page.evaluate(()=>{window.gateCommand='wallpaper.layout.inspect';window.dispatchEvent(new Event('wallpaper-layout-invalidated'));});
  await page.waitForFunction(()=>!!gates['wallpaper.layout.inspect']);
  await page.locator('[data-focus-key=add-member]').click();
  await page.evaluate(()=>{const old=gates['wallpaper.layout.inspect'];delete gates['wallpaper.layout.inspect'];window.gateCommand='wallpaper.layout.inspect';old();});
  await page.waitForFunction(()=>!!gates['wallpaper.layout.inspect']);
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),true,'late two-member permission cannot authorize the current three-member draft');
  assert.match(await page.locator('.hd-capability-note').textContent(),/正在检查/);
  await page.evaluate(()=>{gates['wallpaper.layout.inspect']();delete gates['wallpaper.layout.inspect'];});
  await page.waitForFunction(()=>!!document.querySelector('.hd-capability-note')?.textContent.includes('最多支持 2'));
  await page.locator('[data-focus-key=remove-member-2]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-focus-key=mode] option[value=mirror]').disabled);
  checks.push('a late reply for two displays cannot authorize a changed three-display group');

  const beforeLongInspection=(await requestsForLayout()).length;
  await page.evaluate(()=>{layoutPendingReplies=6;window.dispatchEvent(new Event('wallpaper-layout-invalidated'));});
  await page.waitForFunction(()=>layoutPendingReplies<=2);
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),true,'pending never grants mirror permission');
  assert.equal(await page.locator('#apply').isDisabled(),true);
  assert.match(await page.locator('.hd-capability-note').textContent(),/正在检查/);
  await page.waitForFunction(()=>!document.querySelector('[data-focus-key=mode] option[value=mirror]').disabled);
  assert.equal((await requestsForLayout()).length-beforeLongInspection,7,'pending polls continue beyond three receipts until the same scan completes');
  assert.equal(await page.evaluate(()=>layoutMaxPending),1);
  checks.push('long asynchronous inspection stays closed through six pending replies, then enables mirror with one bounded request at a time');

  await page.evaluate(()=>{layoutBusyReplies=5;window.dispatchEvent(new Event('wallpaper-layout-invalidated'));});
  await page.waitForFunction(()=>layoutBusyReplies<=1);
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),true);
  assert.match(await page.locator('.hd-capability-note').textContent(),/等待当前检查/);
  await page.waitForFunction(()=>!document.querySelector('[data-focus-key=mode] option[value=mirror]').disabled);
  checks.push('a previous draft retaining the native reader slot does not exhaust inspection retries; the current draft recovers after five busy replies');

  await page.evaluate(()=>{window.layoutFailures=5;window.dispatchEvent(new Event('wallpaper-layout-invalidated'));});
  await page.waitForFunction(()=>!!document.querySelector('.hd-capability-note')?.textContent.includes('未能确认镜像支持'));
  const attemptsAfterFailure=(await requestsForLayout()).length;
  assert.equal(await page.evaluate(()=>layoutFailures),2,'transient failure has exactly three attempts');
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),true);
  await page.waitForTimeout(1600);
  assert.equal((await requestsForLayout()).length,attemptsAfterFailure,'failed inspection has no permanent retry loop');
  await page.evaluate(()=>{layoutFailures=0;window.dispatchEvent(new Event('wallpaper-library-changed'));});
  await page.waitForFunction(()=>!document.querySelector('[data-focus-key=mode] option[value=mirror]').disabled);
  checks.push('transient failures retry three times then stay closed with an inline reason; library invalidation permits recovery');

  await page.evaluate(()=>hertzWallpaperSettings.choosePlaylist({playlistId:'mutable-list'},'alpha'));
  await page.waitForFunction(()=>!document.querySelector('[data-focus-key=mode] option[value=mirror]').disabled);
  await page.evaluate(()=>{layoutDenied=true;return hertzWallpaperSettings.requestManagement('wallpaper.playlist.save',{playlistId:'mutable-list',items:[]});});
  await page.waitForFunction(()=>!!document.querySelector('.hd-capability-note')?.textContent.includes('尚未就绪'));
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),true,'successful playlist save invalidates same playlist-id cache');
  checks.push('saving a playlist invalidates previous eligibility even when playlist selection identity is unchanged');

  await page.evaluate(()=>{layoutDenied=false;window.gateCommand='wallpaper.layout.inspect';window.dispatchEvent(new Event('wallpaper-layout-invalidated'));});
  await page.waitForFunction(()=>!!gates['wallpaper.layout.inspect']);
  const newProfilePayload=structuredClone(inspectPayload);newProfilePayload.revision=10;newProfilePayload.profile.dataDir='D:\\Music\\Other';newProfilePayload.profiles=[newProfilePayload.profile];newProfilePayload.message='已切换来源';newProfilePayload.config.groups[0].selection={kind:'builtin',sceneId:'zodiac',stateVersion:1,params:{}};
  await page.evaluate(value=>{window.fixtureRevision=value.revision;hertzWallpaperSettings.applyStatus(value);},newProfilePayload);
  await page.evaluate(()=>{gates['wallpaper.layout.inspect']();delete gates['wallpaper.layout.inspect'];});
  await page.waitForFunction(()=>layoutPending===0&&!!document.querySelector('.hd-capability-note')?.textContent.includes('内置场景'));
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),true,'a response from the previous profile cannot authorize the replacement draft');
  assert.equal(await page.evaluate(()=>layoutMaxPending),1);
  checks.push('profile/revision change invalidates queued and cached inspections; old-profile results cannot enable the replacement draft');
  await page.evaluate(()=>{window.gateCommand='wallpaper.layout.inspect';return hertzWallpaperSettings.chooseLibraryVersion({workKey:'image-discarded',kind:'image',title:'待放弃作品'},{state:'installed',version:1,packageHash:'d'.repeat(64)},'alpha');});
  await page.waitForFunction(()=>!!gates['wallpaper.layout.inspect']);
  await page.locator('#discard').click();
  await page.evaluate(()=>{gates['wallpaper.layout.inspect']();delete gates['wallpaper.layout.inspect'];});
  await page.waitForFunction(()=>layoutPending===0&&!!document.querySelector('.hd-capability-note')?.textContent.includes('内置场景'));
  assert.equal(await mirrorOption().evaluate(option=>option.disabled),true);
  checks.push('discarded draft response cannot restore mirror eligibility onto the saved selection');
  await page.reload();
  const savedMirror=structuredClone(inspectPayload);
  savedMirror.config.groups[0].mode='mirror';
  savedMirror.config.groups[0].displays.push({kind:'fixed',displayId:'screen-c'});
  await page.evaluate(value=>hertzWallpaperSettings.applyStatus(value),savedMirror);
  await page.waitForFunction(()=>!document.querySelector('[data-focus-key=mode] option[value=mirror]').disabled);
  await page.evaluate(()=>{layoutDenied=true;window.dispatchEvent(new Event('wallpaper-layout-invalidated'));});
  await page.waitForFunction(()=>!!document.querySelector('.hd-capability-note')?.textContent.includes('尚未就绪'));
  await page.locator('#enabled').uncheck();
  assert.equal(await page.locator('#apply').isDisabled(),false,'damaged saved content does not prevent disabling unchanged mirror intent');
  await page.locator('#apply').click();
  await page.waitForFunction(()=>requests.some(r=>r.command==='wallpaper.apply'));
  await page.waitForFunction(()=>document.querySelector('#settings-state').getAttribute('data-dirty')==='false');
  await page.evaluate(()=>window.fixtureRevision=10);
  assert.equal(await page.evaluate(()=>nativeWallpaper.enabled),false);
  await page.evaluate(()=>hertzWallpaperSettings.chooseLibraryVersion({workKey:'image-new-disabled',kind:'image',title:'新内容'},{state:'installed',version:1,packageHash:'e'.repeat(64)},'alpha'));
  await page.waitForFunction(()=>!!document.querySelector('.hd-capability-note')?.textContent.includes('尚未就绪'));
  assert.equal(await page.locator('#apply').isDisabled(),true,'disabled new mirror content still needs eligibility');
  checks.push('an unchanged saved mirror can be disabled while inspection fails; changing its content while disabled still blocks Apply');
  await page.screenshot({path:path.join(output,'mirror-inspection.png'),fullPage:true});
  await checkWindowPolicies(page);
  await checkPublicProperties(page);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({checks,errors},null,2));
  console.log(JSON.stringify({checks,errors,output},null,2));
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
