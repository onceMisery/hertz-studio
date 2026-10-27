#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Full app navigation uses the real rebuilt service; fixture writes stay browser-local.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiUrl } = require('./ui-token');
const { readAssets } = require('./ui-assets');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'plugin/ui');
const base = process.env.SPACE_BASE || 'http://127.0.0.1:18789';
const output = path.join(root, 'output/playwright/space-home-stage');
const source = process.argv.includes('--source');
const assets = new Map(readAssets().map(a => [a.path, a]));
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  const errors = [], evidence = { source, ordinaryPc: 'unmeasured', dbx: 'unmeasured' };
  try {
    const context = await browser.newContext({ viewport: {width:1440,height:900} });
    let settings;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) return route.continue();
      if (url.pathname === '/v1/settings') {
        if (!settings) { const response=await route.fetch(); settings=await response.json(); settings.space3d={sceneSource:'anime-svg',qualityMode:'high',space3dDefaultMigrated:1}; }
        if (request.method() !== 'GET') Object.assign(settings,request.postDataJSON());
        return route.fulfill({status:200,json:settings});
      }
      if (source && assets.has(url.pathname)) { const asset=assets.get(url.pathname); return route.fulfill({status:200,contentType:asset.mime==='JS'?'application/javascript':'text/css',body:fs.readFileSync(asset.file)}); }
      if (source && url.pathname === '/') {
        const response=await route.fetch(), html=await response.text();
        const token=html.match(/window\.__VMUSIC_TOKEN__\s*=\s*("[^"]+")/);
        assert.ok(token,'authenticated original HTML');
        const local=fs.readFileSync(path.join(web,'index.html'),'utf8').replace('__VMUSIC_TOKEN_VALUE__',JSON.parse(token[1]));
        return route.fulfill({response,body:local});
      }
      return route.continue();
    });
    const page=await context.newPage(); page.on('pageerror',err=>errors.push(err.message));
    await page.goto(uiUrl(base),{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.Space3D&&document.getElementById('space3d').dataset.spReady==='1');
    await page.locator('#space3d-entry').click();
    assert.equal(await page.evaluate(()=>Space3D.stats().page),'home');
    assert.equal(await page.evaluate(()=>!document.getElementById('sp-warp').hidden),true,'entry transition covers scene setup');
    await page.waitForFunction(()=>Space3D.stats().renderer?.state==='ready');
    assert.equal(await page.locator('#sp-canvas canvas').count(),1,'home floats above the live stage');
    assert.equal(await page.evaluate(()=>Space3D.sourceId()),'coast','invalid old source normalized despite migration marker');
    await page.waitForFunction(()=>getComputedStyle(document.getElementById('space3d')).opacity==='1');
    await page.waitForFunction(()=>document.getElementById('sp-warp').hidden,null,{timeout:10000});
    await page.evaluate(()=>{
      const saved=Space3D.preferences();
      for(const [sceneSource,field,expected] of [['creative','orb','spectrum-sphere'],['immersive','orb','gravity-sphere'],
        ['immersive','terrain','coast'],['creative','scene:towers','spectrum-towers'],['creative','anime-svg','coast']]){
        Space3D.configure({...saved,sceneSource,field});
        if(Space3D.sourceId()!==expected)throw new Error('Wrong migration: '+sceneSource+'/'+field);
      }
      Space3D.configure(saved);
    });
    await page.screenshot({path:path.join(output,'desktop-home.png')});
    await page.locator('.sh-action-library').click();
    await page.waitForSelector('.sh-panel-layer:not([hidden])');
    await page.keyboard.press('Escape'); assert.equal(await page.evaluate(()=>Space3D.stats().page),'home');
    await page.locator('#sp-player-handle').click(); await page.locator('#sp-more').click(); await page.locator('#sp-fab').click();await page.locator('#sp-tab-display').click(); await page.locator('#sp-quality').selectOption('low');
    await page.keyboard.press('Escape'); assert.equal(await page.evaluate(()=>Space3D.stats().page),'home');
    // Real Stage clock, lyrics tokens, camera math and registry remain in the journey.
    await page.evaluate(()=>{
      const original=Stage.presentation, start=performance.now();
      window.fixture={playing:true,reduced:false,tier:2,position:2500};
      Stage.presentation=()=>({...original(),track:{id:'stage-journey',title:'共享舞台验证',artist:'Hertz Studio'},playing:fixture.playing,reduced:fixture.reduced,
        position:fixture.position+(fixture.playing?performance.now()-start:0),duration:120000,volume:.8});
      Stage.tier=()=>fixture.tier;Stage.spectrum=()=>new Float32Array(64).fill(.5);Stage.energy=()=>.5;
      Stage.setLyrics({lines:[{start_ms:0,end_ms:7000,text:'让声音走进三维空间',words:[{text:'让声音',start_ms:0,end_ms:3000},{text:'走进三维空间',start_ms:3000,end_ms:7000}]},
        {start_ms:7000,end_ms:14000,text:'音乐和画面共享同一时钟'}]});Stage.kick();
    });
    await page.locator('#sp-page-toggle').click();
    await page.waitForFunction(()=>Space3D.stats().renderer?.state==='ready');
    await page.waitForFunction(()=>Space3D.stats().renderer?.frameCount>0,null,{timeout:15000});
    assert.equal(await page.locator('#sp-canvas canvas').count(),1);
    assert.equal(await page.evaluate(()=>Stage.gateRates().find(g=>g.name==='lyrics').target),0,'occluded DOM lyric gate stays asleep');
    assert.equal(await page.evaluate(()=>Stage.lyrics(9000).index),1,'spatial lyric snapshot advances while DOM gate sleeps');
    assert.equal(await page.evaluate(()=>Stage.lyrics(0).index),0,'spatial lyric snapshot supports backward seeking');
    const count=await page.evaluate(()=>Space3D.stats().renderer.frameCount);
    if(!count) console.log(JSON.stringify(await page.evaluate(()=>({stats:Space3D.stats(),gates:Stage.gateRates(),playing:Stage.presentation(),hidden:document.hidden,capsule:window.HertzCapsuleOnly})),null,2),errors);
    assert.ok(count>0,'clock draws actual frames');
    const layout=await page.evaluate(()=>({canvas:document.querySelector('#sp-canvas canvas').getBoundingClientRect().toJSON(),
      subtitle:document.getElementById('sp-reading').getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight}));
    assert.equal(layout.canvas.width,layout.width,'canvas fills viewport width at reduced DPR');
    assert.equal(layout.canvas.height,layout.height,'canvas fills viewport height at reduced DPR');
    assert.ok(layout.subtitle.width>layout.width*.7,'ordinary subtitle has readable horizontal width');
    await page.screenshot({path:path.join(output,'desktop-coast.png')});
    await page.locator('#sp-player-handle').click(); await page.locator('#sp-more').click(); await page.locator('#sp-fab').click();
    await page.locator('#sp-tab-stage').click();await page.locator('#sp-source').selectOption('zodiac');
    await page.waitForFunction(()=>Space3D.stats().renderer?.id==='zodiac'&&Space3D.stats().renderer.state==='ready');
    await page.locator('#sp-tab-display').click();await page.locator('#sp-quality').selectOption('high'); await page.keyboard.press('Escape');
    await page.waitForTimeout(900); await page.screenshot({path:path.join(output,'desktop-zodiac.png')});
    assert.equal(await page.locator('#sp-canvas canvas').count(),1);
    await page.evaluate(()=>Space3D.enterStage('lyric-sonnet'));
    await page.waitForTimeout(900); await page.screenshot({path:path.join(output,'desktop-lyrics.png')});
    assert.equal(await page.locator('#sp-reading').isVisible(),false,'owned spatial text hides ordinary subtitle');
    await page.locator('#sp-page-toggle').click();
    assert.equal(await page.locator('#sp-canvas canvas').count(),1,'home preserves the shared renderer');
    assert.ok(await page.evaluate(()=>Space3D.stats().renderer),'home retains background scene');
    assert.equal(await page.evaluate(()=>Stage.presentation().playing),true,'navigation preserves playback');
    await page.keyboard.press('Control+k'); assert.equal(await page.locator('#sh-query').evaluate(el=>el===document.activeElement),true);
    await page.locator('#sh-query').fill('test'); await page.keyboard.press('x'); assert.equal(await page.evaluate(()=>Space3D.stats().page),'home','typing X does not toggle');
    await page.keyboard.press('Escape');
    await page.locator('#sp-page-toggle').click(); await page.waitForFunction(()=>Space3D.stats().renderer?.state==='ready');
    await page.evaluate(()=>{fixture.playing=false;fixture.position=3000;Stage.kick();});
    await page.waitForTimeout(1500);
    const paused=await page.evaluate(()=>Space3D.stats().renderer.frameCount); await page.waitForTimeout(600);
    assert.equal(await page.evaluate(()=>Space3D.stats().renderer.frameCount),paused,'paused scene sleeps');
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
    const hidden=await page.evaluate(()=>Space3D.stats().renderer.frameCount);await page.waitForTimeout(400);
    assert.equal(await page.evaluate(()=>Space3D.stats().renderer.frameCount),hidden,'hidden scene stops drawing');
    await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
    await page.keyboard.press('Escape'); assert.equal(await page.evaluate(()=>Space3D.stats().page),'home');
    await page.setViewportSize({width:390,height:844}); await page.screenshot({path:path.join(output,'mobile-home.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.locator('#sp-page-toggle').click();await page.waitForFunction(()=>Space3D.stats().renderer?.state==='ready');
    await page.waitForTimeout(1000);await page.screenshot({path:path.join(output,'mobile-stage.png')});
    await page.locator('#sp-player-handle').click();await page.locator('#sp-more').click();await page.locator('#sp-fab').click();await page.screenshot({path:path.join(output,'mobile-settings.png')});
    await page.keyboard.press('Escape');await page.keyboard.press('Escape');await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>Space3D.isActive()),false);
    await page.locator('#space3d-entry').click();assert.equal(await page.evaluate(()=>Space3D.stats().page),'home','reentry always home');
    evidence.final=await page.evaluate(()=>Space3D.stats());
    if(!source) for(const id of await page.evaluate(()=>SpaceStagePure.catalog().map(d=>d.id))){const response=await context.request.get(base+'/space-scene-preview/'+id+'.jpg');assert.equal(response.status(),200,id+' embedded preview');}
    await page.evaluate(()=>SpaceStagePure.register({apiVersion:1,stateVersion:1,id:'browser-extension',label:'扩展验证',category:'测试',preview:'/space-scene-preview/coast.jpg',
      camera:{radius:5,fov:45},capabilities:{},quality:{},params:{tint:{type:'color',default:'#ff8844'},caption:{type:'string',default:'Hertz',maxLength:24},
        count:{type:'select',default:1,options:[{value:1,label:'一'},{value:2,label:'二'}]},enabled:{type:'select',default:false,options:[false,true]}},
      create:ctx=>{const mesh=new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(),new ctx.THREE.MeshBasicMaterial({color:ctx.params.tint}));ctx.scene.add(mesh);return {update(){},dispose(){},setParams(params){window.extensionParams=params;mesh.material.color.set(params.tint);}};}}));
    await page.evaluate(()=>Space3D.enterStage('browser-extension'));
    await page.waitForFunction(()=>Space3D.stats().renderer?.state==='ready');
    await page.locator('#sp-player-handle').click();await page.locator('#sp-more').click();await page.locator('#sp-fab').click();
    await page.locator('#sp-tab-stage').click();assert.equal(await page.locator('#sp-param-tint').getAttribute('type'),'color');
    assert.equal(await page.locator('#sp-param-caption').getAttribute('type'),'text');
    await page.locator('#sp-param-tint').fill('#44cc88');
    await page.locator('#sp-param-tint').dispatchEvent('change');
    await page.locator('#sp-param-caption').fill('插件参数');
    await page.locator('#sp-param-caption').dispatchEvent('change');
    await page.locator('#sp-param-count').selectOption('2');
    await page.locator('#sp-param-enabled').selectOption('true');
    assert.deepEqual(await page.evaluate(()=>window.extensionParams),{tint:'#44cc88',caption:'插件参数',count:2,enabled:true});
    await page.evaluate(()=>{const prefs=Space3D.preferences();prefs.sceneStates['browser-extension'].params={tint:'#336699',caption:'恢复状态',count:1,enabled:false};Space3D.configure(prefs);});
    assert.equal(await page.locator('#sp-param-caption').inputValue(),'恢复状态','same-scene restoration refreshes parameter controls');
    await page.locator('#sp-param-count').selectOption('2');
    assert.deepEqual(await page.evaluate(()=>window.extensionParams),{tint:'#336699',caption:'恢复状态',count:2,enabled:false},'editing one restored field preserves others');
    assert.equal(await page.evaluate(()=>Space3D.stats().renderer.state),'ready','typed extension controls preserve live scene');
    await page.evaluate(()=>Space3D.goHome());
    assert.deepEqual(errors,[],'no uncaught errors');
    fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));
    console.log('Space home/stage integration: navigation, preferences, real lyric/camera/clock, pause/hidden, focus and mobile passed ('+(source?'source':'embedded')+')');
  } finally {await browser.close();}
}
main().catch(err=>{console.error(err);process.exitCode=1;});
