#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sharp = require(process.env.SHARP_MODULE || 'sharp');
const {uiUrl} = require('./ui-token');
const {readAssets} = require('./ui-assets');
const root=path.resolve(__dirname,'..'),base=process.env.SPACE_BASE || 'http://127.0.0.1:18789';
const output=path.join(root,'output/playwright/space-spatial-ui'),source=process.argv.includes('--source');
async function main(){
  fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const errors=[],calls=[],assets=new Map(readAssets().map(asset=>[asset.path,asset]));
  const evidence={source,auth:'local fixtures',baselinePerformance:'unmeasured'};
  let page;
  try{
    const context=await browser.newContext({viewport:{width:1440,height:900}});let settings,rejectQr=false;
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());if(url.origin!==base)return route.continue();
      if(url.pathname==='/v1/settings'){
        if(!settings){const response=await route.fetch();settings=await response.json();settings.space3d={sceneSource:'coast',qualityMode:'low',playerAutoHide:true};}
        if(request.method()!=='GET')Object.assign(settings,request.postDataJSON());return route.fulfill({json:settings});
      }
      if(url.pathname==='/v1/online/sources')return route.fulfill({json:{sources:['netease','qq'].map(id=>({id,label:id==='qq'?'QQ 音乐':'网易云',name:id,caps:['search','qr_login','cookie_login']}))}});
      if(url.pathname==='/v1/online/account')return route.fulfill({status:401,json:{error:'auth_required'}});
      if(url.pathname==='/v1/online/qr/start'){
        calls.push({action:'start',...request.postDataJSON()});await new Promise(resolve=>setTimeout(resolve,250));
        if(rejectQr)return route.fulfill({status:503,json:{error:'QR unavailable'}});
        return route.fulfill({json:{ticket:'fixture-'+calls.length,qr_image:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="white"/><path d="M20 20h50v50H20zm90 0h50v50h-50zM20 110h50v50H20z" fill="black"/></svg>',poll_ms:60000}});
      }
      if(url.pathname==='/v1/online/qr/cancel'){calls.push({action:'cancel',...request.postDataJSON()});return route.fulfill({json:{ok:true}});}
      if(url.pathname==='/v1/online/qr/poll')return route.fulfill({json:{state:'waiting'}});
      if(url.pathname==='/v1/recommend/daily/online')return route.fulfill({json:{tracks:Array.from({length:6},(_,i)=>({id:'daily-'+i,title:'夜曲 · Live in concert '+i,artist:'推荐歌手',album:'现场专辑',source:i%2?'qq':'netease'})),total:6}});
      if(url.pathname==='/v1/online/search'||(url.pathname==='/v1/tracks'&&url.searchParams.get('q'))){
        const provider=url.searchParams.get('source')||'local',q=url.searchParams.get('q');
        if(provider==='qq')await new Promise(resolve=>setTimeout(resolve,1500));
        if(q==='Empty')return route.fulfill({json:{tracks:[],total:0}});
        if(q==='Failure')return route.fulfill({status:503,json:{error:'Search unavailable'}});
        return route.fulfill({json:{tracks:[{id:'fixture-'+provider,title:'Spatial '+provider,artist:'Browser fixture',album:'Spatial Album '+provider,source:provider}],total:1}});
      }
      if(source&&assets.has(url.pathname)){const asset=assets.get(url.pathname);return route.fulfill({contentType:asset.mime==='JS'?'application/javascript':'text/css',body:fs.readFileSync(asset.file)});}
      if(source&&url.pathname==='/'){
        const response=await route.fetch(),html=await response.text(),token=html.match(/window\.__VMUSIC_TOKEN__\s*=\s*("[^"]+")/);
        return route.fulfill({response,body:fs.readFileSync(path.join(root,'plugin/ui/index.html'),'utf8').replace('__VMUSIC_TOKEN_VALUE__',JSON.parse(token[1]))});
      }
      return route.continue();
    });
    page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(uiUrl(base),{waitUntil:'domcontentloaded'});await page.locator('#space3d-entry').click();
    await page.waitForFunction(()=>Space3D.stats().renderer?.state==='ready'&&Space3D.stats().renderer.frameCount>0);
    await page.evaluate(()=>{window.backgroundCanvas=document.querySelector('#sp-canvas canvas');});
    assert.equal(await page.locator('.sh-header h1').count(),0,'duplicate heading removed');
    const image=await page.locator('#sp-canvas canvas').screenshot();const pixels=await sharp(image).stats();
    assert.ok(pixels.channels.slice(0,3).some(channel=>channel.stdev>10),'world canvas contains visible scene');evidence.canvas=pixels.channels.slice(0,3).map(channel=>({mean:channel.mean,stdev:channel.stdev}));
    await page.locator('#sp-player-handle').click();await page.waitForTimeout(450);await page.screenshot({path:path.join(output,'desktop-home.png')});
    const review=await page.locator('.sh-daily-review').boundingBox(),date=await page.locator('.sh-date').boundingBox();
    assert.ok(date.y-review.y<=34,'date starts near the top without an empty media region');
    assert.ok(review.height<360,'text-only review card sizes to content');
    assert.ok(await page.locator('#sp-bar button').count()<=9,'player exposes only primary controls');
    const playBounds=await page.locator('#sp-play').boundingBox();assert.equal(playBounds.width,playBounds.height,'play control stays circular');
    evidence.homeLayouts=[];
    for(const [width,height] of [[1087,897],[1024,768],[1280,720],[1440,900],[1920,1080]]){
      await page.setViewportSize({width,height});await page.locator('#sp-player-handle').click();
      await page.waitForFunction(()=>!document.querySelector('#space3d').classList.contains('sp-player-hidden'));
      const layout=await page.evaluate(()=>{
        const home=document.querySelector('#sp-home'),rect=selector=>document.querySelector(selector).getBoundingClientRect().toJSON();
        return {width:innerWidth,height:innerHeight,scrollHeight:home.scrollHeight,clientHeight:home.clientHeight,scrollbar:getComputedStyle(home).scrollbarWidth,
          review:rect('.sh-daily-review'),recent:rect('.sh-recent'),discovery:rect('.sh-discovery'),player:rect('#sp-bar')};
      });
      assert.ok(layout.scrollHeight<=layout.clientHeight+1,'home fits one screen at '+width+'x'+height+': '+JSON.stringify(layout));
      assert.equal(layout.scrollbar,'none','home hides scrollbars');
      assert.equal(layout.recent.x,layout.review.x,'recent preview fills the left column');
      assert.ok(Math.max(layout.recent.bottom,layout.discovery.bottom)<=height-110,'home previews stay above player area');
      await page.mouse.move(layout.player.x+20,layout.player.y+20);
      evidence.homeLayouts.push(layout);await page.screenshot({path:path.join(output,'home-layout-'+width+'x'+height+'.png')});
    }
    await page.setViewportSize({width:1440,height:900});await page.locator('#sp-player-handle').click();await page.locator('#sp-play').focus();
    await page.locator('#sp-collapse').click();assert.equal(await page.locator('#sp-bar').evaluate(node=>node.inert),true);
    await page.screenshot({path:path.join(output,'desktop-player-hidden.png')});
    await page.mouse.move(720,898);await page.waitForFunction(()=>!document.querySelector('#sp-bar').inert);
    await page.locator('#sp-more').click();await page.locator('#sp-autohide').click();assert.equal(await page.evaluate(()=>Space3D.preferences().playerAutoHide),false);
    await page.locator('#sp-playlist-toggle').click();assert.deepEqual(await page.evaluate(()=>Space3D.stats().panels),['sp-playlist']);
    await page.locator('#sp-more').click();assert.deepEqual(await page.evaluate(()=>Space3D.stats().panels),['sp-player-options'],'More replaces queue');
    await page.locator('#sp-volume-toggle').click();assert.deepEqual(await page.evaluate(()=>Space3D.stats().panels),['sp-volume-panel'],'volume replaces More');
    await page.locator('#sp-volume').fill('51');assert.deepEqual(await page.evaluate(()=>Space3D.stats().panels),['sp-volume-panel'],'editing volume keeps its panel open');
    await page.mouse.click(15,450);assert.deepEqual(await page.evaluate(()=>Space3D.stats().panels),[],'background dismisses volume');
    await page.locator('#sp-more').click();await page.locator('#sp-fab').click();
    assert.deepEqual(await page.evaluate(()=>Space3D.stats().panels),['sp-sheet'],'settings replaces More');
    await page.keyboard.press('Escape');assert.equal(await page.locator('#sp-more').evaluate(node=>node===document.activeElement),true,'Escape restores visible More trigger');
    await page.locator('.sh-action-library').click();await page.locator('#sp-more').click();
    assert.equal(await page.locator('.sh-panel-layer').isVisible(),false,'More replaces library without a second click');
    await page.keyboard.press('Control+k');assert.deepEqual(await page.evaluate(()=>Space3D.stats().panels),[],'search replaces player surfaces');
    await page.locator('#sp-playlist-toggle').click();assert.equal(await page.locator('.sh-panel-layer').isVisible(),false,'queue replaces search');
    await page.keyboard.press('Escape');await page.mouse.move(15,450);await page.mouse.down();
    assert.ok(await page.locator('.sp-click-ring').count()>0,'pointer click has visible animation feedback');await page.mouse.up();
    await page.waitForFunction(()=>document.querySelectorAll('.sp-click-ring').length===0,null,{timeout:5000});
    await page.emulateMedia({reducedMotion:'reduce'});await page.mouse.click(15,450);
    assert.equal(await page.locator('.sp-click-ring').count(),0,'reduced motion skips click animation');await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('#sp-page-toggle').click();await page.locator('#sp-page-toggle').click();
    assert.equal(await page.evaluate(()=>backgroundCanvas===document.querySelector('#sp-canvas canvas')),true,'home-stage roundtrip retains canvas identity');
    await page.keyboard.press('Control+k');await page.locator('#sh-query').fill('Spatial');await page.locator('#sh-query').press('Enter');
    await page.waitForFunction(()=>document.querySelector('.sh-panel-body .sh-track')&&document.querySelector('.sh-panel-body').getAttribute('aria-busy')==='true');
    assert.equal(await page.locator('.sh-panel-layer.is-search').isVisible(),true,'search opens a visible floating layer before all sources return');
    await page.waitForFunction(()=>document.querySelectorAll('.sh-panel-body .sh-track').length===3);
    await page.waitForFunction(()=>document.querySelector('.sh-panel-body').getAttribute('aria-busy')==='false');
    await page.getByRole('tab',{name:'QQ 音乐',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.sh-panel-body .sh-track').length===1);
    assert.equal(await page.locator('.sh-panel-body .sh-track-source').textContent(),'QQ 音乐');
    assert.equal(await page.locator('.sh-panel-body .sh-track-album').textContent(),'Spatial Album qq');
    assert.equal(await page.locator('.sh-panel-body .sh-track-main').evaluate(node=>getComputedStyle(node).color===getComputedStyle(document.querySelector('.sh-panel-layer')).color),true,'results inherit readable foreground instead of browser button text');
    await page.locator('#sh-query').fill('Empty');await page.locator('#sh-query').press('Enter');
    await page.getByText('没有找到匹配的音乐',{exact:true}).waitFor();
    await page.locator('#sh-query').fill('Failure');await page.locator('#sh-query').press('Enter');await page.locator('.sh-retry').waitFor();
    await page.locator('#sh-query').fill('Spatial');await page.locator('#sh-query').press('Enter');await page.locator('.sh-panel-body .sh-track').waitFor();
    await page.screenshot({path:path.join(output,'desktop-search.png')});
    for(const width of [320,390,768]){
      await page.setViewportSize({width,height:844});
      const bounds=await page.locator('.sh-panel').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width,'search layer fits '+width+'px');
      assert.equal(await page.locator('.sh-panel').evaluate(node=>node.scrollWidth>node.clientWidth),false,'search content fits narrow screens');
      assert.equal(await page.locator('.sh-track-album').last().isVisible(),true,'album stays visible in search');
      await page.screenshot({path:path.join(output,'search-'+width+'.png')});
    }
    await page.setViewportSize({width:1440,height:900});
    await page.keyboard.press('Escape');await page.locator('.sh-action-daily').click();await page.locator('.sh-panel-body .sh-track').first().waitFor();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.sh-panel')).opacity==='1');
    for(const width of [320,390,768,1087]){
      await page.setViewportSize({width,height:844});
      const layout=await page.locator('.sh-panel').evaluate(node=>{const r=node.getBoundingClientRect(),row=node.querySelector('.sh-track'),t=row.querySelector('strong');return {x:r.x,right:r.right,overflow:node.scrollWidth>node.clientWidth,rowHeight:row.getBoundingClientRect().height,color:getComputedStyle(t).color,foreground:getComputedStyle(node).color,source:row.querySelector('.sh-track-source').textContent};});
      assert.ok(layout.x>=0&&layout.right<=width&&!layout.overflow,'recommendations fit '+width+'px');
      assert.ok(layout.rowHeight<=54,'compact recommendation rows at '+width+'px');assert.equal(layout.color,layout.foreground);assert.ok(layout.source);
      assert.ok((await page.locator('.sh-panel').boundingBox()).height<500,'recommendation panel sizes to its short list');
      await page.screenshot({path:path.join(output,'recommendations-'+width+'.png')});
    }
    await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:900});
    await page.locator('#sp-page-toggle').click();assert.equal(await page.evaluate(()=>Space3D.stats().page),'stage','search dismissal does not block navigation');
    await page.keyboard.press('Control+k');assert.equal(await page.evaluate(()=>Space3D.stats().page),'stage','stage search keeps current view');
    await page.locator('#sh-query').fill('');await page.locator('#sh-query').press('Enter');
    await page.locator('.sh-panel-tools button').last().focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.sh-panel-layer').isVisible(),false,'Escape from empty search returns focus without reopening history');
    assert.equal(await page.evaluate(()=>Space3D.stats().page),'stage','closing stage search preserves the stage');
    await page.locator('#sp-account').click();await page.waitForSelector('.qr-space .qr-source');
    await page.waitForFunction(()=>document.querySelector('.qs-connection')?.textContent.includes('已接入'));
    await page.waitForFunction(()=>document.querySelector('.qs-signal')?.getAttribute('d'));
    assert.equal(await page.locator('.qs-signal').getAttribute('d'),await page.locator('.qs-link').getAttribute('d'),'flow follows the connected curve');
    const dash=await page.locator('.qs-signal').evaluate(node=>getComputedStyle(node).strokeDashoffset);
    await page.waitForFunction(previous=>getComputedStyle(document.querySelector('.qs-signal')).strokeDashoffset!==previous,dash,{timeout:5000});
    await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.qs-signal').isVisible(),false,'reduced motion hides flowing signal');
    await page.emulateMedia({reducedMotion:'no-preference'});
    assert.equal(calls.filter(call=>call.action==='start').length,0,'connecting a platform waits for explicit login');
    const port=page.locator('.qr-source[data-source="qq"] .qs-out'),hub=page.locator('.qs-hub');
    const from=await port.boundingBox(),to=await hub.boundingBox();await page.mouse.move(from.x+6,from.y+6);await page.mouse.down();await page.mouse.move(to.x+30,to.y+30,{steps:12});
    assert.equal(await page.locator('.qs-graph').evaluate(node=>node.classList.contains('is-drop-target')),true,'drag highlights the connection target');await page.mouse.up();
    assert.equal(await page.locator('.qr-source[data-source="qq"]').evaluate(node=>node.classList.contains('active')),true,'dragging port connects selected source');
    await page.getByRole('button',{name:'Cookie',exact:true}).click();assert.equal(await page.locator('#qr-cookie-input').isVisible(),true);
    await page.locator('#qr-cookie-input').evaluate(node=>{node.style.height='800px';});
    for(const [width,height] of [[1087,897],[390,600]]){
      await page.setViewportSize({width,height});
      const scroll=page.locator('.qs-scroll'),close=page.locator('#qr-close');
      await scroll.evaluate(node=>{node.scrollTop=0;});
      const before=await close.boundingBox(),content=await scroll.boundingBox();
      assert.ok(before.y+before.height<=content.y,'close button sits above the scrolling content');
      assert.ok(await scroll.evaluate(node=>node.scrollHeight>node.clientHeight),'Cookie content actually overflows at '+width+'x'+height);
      await scroll.evaluate(node=>{node.scrollTop=node.scrollHeight;});
      const after=await close.boundingBox();assert.equal(after.y,before.y,'scrolling keeps close button fixed');
      assert.equal(await close.evaluate(node=>{const r=node.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===node;}),true,'close button remains clickable after scroll');
      await close.hover();await page.waitForTimeout(300);
      assert.notEqual(await close.evaluate(node=>getComputedStyle(node).transform),'none','close button rotates on hover');
      await page.emulateMedia({reducedMotion:'reduce'});
      assert.equal(await close.evaluate(node=>getComputedStyle(node).transform),'none','close rotation respects reduced motion');
      await page.emulateMedia({reducedMotion:'no-preference'});await page.mouse.move(1,1);
      await page.screenshot({path:path.join(output,'login-scroll-'+width+'x'+height+'.png')});
      await scroll.evaluate(node=>{node.scrollTop=0;});
    }
    await page.locator('#qr-cookie-input').evaluate(node=>{node.style.removeProperty('height');});
    await page.setViewportSize({width:1440,height:900});
    await page.screenshot({path:path.join(output,'desktop-login-cookie.png')});
    await page.getByRole('button',{name:'扫码',exact:true}).click();await page.locator('.qs-connect').click();await page.waitForSelector('#qr-canvas :is(svg,img)');
    await page.screenshot({path:path.join(output,'desktop-login-qr.png')});
    await page.keyboard.press('Escape');assert.equal(await page.locator('#qr-modal').isVisible(),false);assert.equal(await page.evaluate(()=>Space3D.stats().page),'stage');
    assert.equal(await page.locator('#sp-page-toggle').evaluate(node=>!!node.closest('[inert]')),false,'closing login restores chrome');
    rejectQr=true;await page.locator('#sp-account').click();await page.waitForFunction(()=>document.querySelector('.qs-connection')?.textContent.includes('已接入'));
    await page.locator('.qs-connect').click();await page.waitForFunction(()=>document.querySelector('.qs-modes [data-mode="cookie"]').getAttribute('aria-pressed')==='true');
    assert.equal(await page.locator('#qr-cookie-input').isVisible(),true,'failed QR reveals the actual Cookie form');
    await page.locator('.qs-actions button').first().focus();await page.keyboard.press('Tab');
    assert.equal(await page.locator('#qr-close').evaluate(node=>node===document.activeElement),true,'login traps keyboard focus');
    await page.keyboard.press('Escape');
    await page.locator('#sp-console-toggle').click();
    assert.equal(await page.locator('#sp-source option[value="lyric-sonnet"]').count(),0,'stage list excludes lyric effects');
    assert.equal(await page.locator('#sp-lyric-style option').count(),5,'lyrics have their own complete selector');
    await page.locator('#sp-source').selectOption('zodiac');await page.waitForFunction(()=>Space3D.stats().renderer?.id==='zodiac'&&Space3D.stats().renderer.state==='ready');
    await page.locator('#sp-tab-lyrics').click();await page.locator('#sp-lyric-style').selectOption('lyric-sonnet');
    await page.waitForFunction(()=>Space3D.stats().renderer?.lyricId==='lyric-sonnet');
    await page.locator('#sp-lyric-param-textWidth').fill('9');
    assert.equal(await page.evaluate(()=>Space3D.preferences().sceneStates['lyric-sonnet'].params.textWidth),9);
    assert.equal(await page.evaluate(()=>Space3D.stats().renderer.id),'zodiac','lyrics retain selected world');
    await page.locator('#sp-lyrics-toggle').uncheck();await page.waitForFunction(()=>Space3D.stats().renderer?.lyricId===null);
    assert.equal(await page.evaluate(()=>Space3D.preferences().lyricStyle),'lyric-sonnet','hiding lyrics retains style');
    await page.locator('#sp-lyrics-toggle').check();await page.waitForFunction(()=>Space3D.stats().renderer?.lyricId==='lyric-sonnet');
    assert.equal(await page.locator('#sp-lyric-param-textWidth').inputValue(),'9','reenabling keeps lyric parameters');
    await page.locator('#sp-tab-stage').click();await page.locator('#sp-source').selectOption('coast');
    await page.waitForFunction(()=>Space3D.stats().renderer?.id==='coast'&&Space3D.stats().renderer.state==='ready');
    assert.equal(await page.evaluate(()=>Space3D.stats().renderer.lyricId),'lyric-sonnet','world changes retain lyrics');
    await page.locator('#sp-tab-stage').focus();await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#sp-tab-lyrics').getAttribute('aria-selected'),'true','tabs support arrow navigation');
    await page.waitForTimeout(400);await page.screenshot({path:path.join(output,'desktop-console-lyrics.png')});
    await page.keyboard.press('Escape');
    assert.equal(settings.space3d.lyricStyle,'lyric-sonnet','composition reaches settings storage');
    await page.reload();await page.waitForFunction(()=>window.Space3D&&Space3D.preferences().lyricStyle==='lyric-sonnet');
    await page.evaluate(()=>{Space3D.open();return Space3D.enterStage();});await page.waitForFunction(()=>Space3D.stats().renderer?.state==='ready'&&Space3D.stats().renderer.lyricId==='lyric-sonnet');
    assert.equal(await page.evaluate(()=>Space3D.preferences().sceneStates['lyric-sonnet'].params.textWidth),9,'composition persists after reload');
    await page.evaluate(()=>Space3D.configure({...Space3D.preferences(),sceneSource:'lyric-cadenza',lyricStyle:undefined}));
    await page.waitForFunction(()=>Space3D.stats().renderer?.id==='coast'&&Space3D.stats().renderer.lyricId==='lyric-cadenza');
    assert.equal(await page.evaluate(()=>Space3D.preferences().lyricStyle),'lyric-cadenza','legacy lyric scene migrates to a composition');
    assert.equal(await page.locator('#space3d button[aria-label*="全屏"],#sp-free-camera').count(),0,'space exposes only immersive mode and removes free camera');
    evidence.stageTools=[];
    for(const [width,height] of [[320,844],[390,844],[1087,897],[1440,900]]){
      await page.setViewportSize({width,height});await page.locator('#sp-player-handle').click();await page.waitForTimeout(450);
      const tools=await page.locator('#sp-stage-tools').boundingBox(),bar=await page.locator('#sp-bar').boundingBox();
      assert.ok(tools.x>width/2&&tools.y>height/2,'stage controls sit at the bottom right at '+width);
      assert.ok(tools.x+tools.width<=width&&tools.y+tools.height<=bar.y-8,'stage controls clear the player at '+width);
      await page.locator('#sp-console-toggle').click();assert.equal(await page.locator('#sp-sheet').evaluate(node=>node.inert),false,'relocated console opens');
      await page.locator('#sp-tab-camera').click();assert.equal(await page.locator('#sp-reset-camera').isVisible(),true,'camera reset remains available');
      await page.locator('#sp-reset-camera').click();await page.keyboard.press('Escape');
      assert.equal(await page.locator('#sp-console-toggle').evaluate(node=>node===document.activeElement),true,'console restores focus to its relocated trigger');
      evidence.stageTools.push({width,height,tools,bar});
      await page.waitForTimeout(450);
      await page.screenshot({path:path.join(output,'stage-controls-'+width+'.png')});
    }
    await page.setViewportSize({width:1440,height:900});
    await page.locator('#sp-stage-immersive').click();
    await page.mouse.move(720,899);await page.waitForTimeout(350);
    assert.equal(await page.locator('#sp-player-handle').isVisible(),false,'immersive hides player handle');
    assert.equal(await page.locator('#sh-query').isVisible(),false,'immersive hides search');
    assert.equal(await page.locator('#space3d').evaluate(root=>Array.from(root.querySelectorAll('button,input,select')).some(node=>node.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}))),false,'immersive hides every control');
    assert.equal(await page.locator('#sp-bar').evaluate(node=>node.inert),true,'hidden player cannot receive focus');
    await page.keyboard.press('Control+k');assert.equal(await page.evaluate(()=>!!window.Palette&&Palette.isOpen()),false,'immersive search shortcut cannot open underlying palette');
    assert.equal(await page.locator('#sh-query').isVisible(),false,'search remains hidden after its shortcut');
    await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('#space3d button,#space3d input,#space3d select')),false,'Tab cannot focus hidden chrome');
    assert.equal(await page.evaluate(()=>!!document.fullscreenElement),false,'immersive mode does not enter native fullscreen');
    await page.screenshot({path:path.join(output,'desktop-immersive.png')});
    await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>Space3D.stats().page),'stage');
    await page.waitForFunction(()=>!document.querySelector('#space3d').classList.contains('sp-immersive'));
    assert.equal(await page.locator('#sp-stage-immersive').isVisible(),true,'Escape restores stage controls');
    await page.locator('#sp-stage-immersive').click();await page.mouse.dblclick(720,450);
    assert.equal(await page.locator('#sp-stage-immersive').isVisible(),true,'double click restores immersive chrome');
    await page.locator('#sp-stage-immersive').focus();await page.keyboard.press('f');
    assert.equal(await page.locator('#space3d').evaluate(node=>node.classList.contains('sp-immersive')),true,'F enters immersive mode');
    assert.equal(await page.evaluate(()=>!!document.fullscreenElement),false,'F does not request native fullscreen');
    await page.keyboard.press('f');assert.equal(await page.locator('#sp-stage-immersive').isVisible(),true,'F restores chrome');
    await page.keyboard.press('r');assert.equal(await page.evaluate(()=>Space3D.stats().freeCam),false,'removed free camera has no hidden shortcut');
    await page.locator('#sp-more').click();await page.waitForTimeout(250);await page.screenshot({path:path.join(output,'desktop-more.png')});
    await page.locator('#sp-immersive').click();assert.equal(await page.locator('#sp-page-toggle').isVisible(),false);
    await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>Space3D.stats().page),'stage');assert.equal(await page.locator('#sp-page-toggle').isVisible(),true);
    await page.locator('#sp-page-toggle').click();await page.setViewportSize({width:390,height:844});await page.waitForTimeout(450);
    await page.screenshot({path:path.join(output,'mobile-home.png')});
    const bounds=await page.locator('#sp-bar').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390,'mobile player stays in viewport: '+JSON.stringify(bounds));
    for(const width of [320,390,768,1024,1440]){
      await page.setViewportSize({width,height:844});await page.locator('#sp-player-handle').click();
      const overflow=await page.locator('#sp-bar').evaluate(bar=>bar.scrollWidth>bar.clientWidth);
      assert.equal(overflow,false,'player content fits '+width+'px viewport');
      const boxes=await page.locator('#sp-bar button').evaluateAll(buttons=>buttons.map(button=>button.getBoundingClientRect().toJSON()));
      for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)assert.ok(Math.min(boxes[i].right,boxes[j].right)-Math.max(boxes[i].left,boxes[j].left)<=1||Math.min(boxes[i].bottom,boxes[j].bottom)-Math.max(boxes[i].top,boxes[j].top)<=1,'player buttons do not overlap at '+width+'px');
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('#sp-account').click();await page.waitForFunction(()=>document.querySelector('.qs-connection')?.textContent.includes('已接入'));
    await page.getByRole('button',{name:'Cookie',exact:true}).click();await page.waitForTimeout(400);await page.screenshot({path:path.join(output,'mobile-login.png')});
    assert.equal(await page.locator('.qr-space .qr-card').evaluate(node=>node.scrollWidth>node.clientWidth),false,'mobile login has no horizontal overflow');
    await page.keyboard.press('Escape');await page.locator('#sp-page-toggle').click();await page.waitForTimeout(450);await page.screenshot({path:path.join(output,'mobile-stage.png')});
    await page.locator('#sp-console-toggle').click();await page.locator('#sp-tab-lyrics').click();
    const consoleBounds=await page.locator('#sp-sheet').boundingBox();assert.ok(consoleBounds.x>=0&&consoleBounds.x+consoleBounds.width<=390,'mobile console fits viewport');
    await page.locator('.sp-console-scroll').evaluate(node=>{node.scrollTop=node.scrollHeight;});
    assert.equal(await page.locator('#sp-sheet-close').evaluate(node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'console close stays outside scrolling body');
    await page.screenshot({path:path.join(output,'mobile-console-lyrics.png')});await page.locator('#sp-sheet-close').click();
    await page.locator('#sp-stage-immersive').click();await page.mouse.move(195,842);
    assert.equal(await page.locator('#sp-player-handle').isVisible(),false,'mobile immersive hides all reveal controls');
    await page.screenshot({path:path.join(output,'mobile-immersive.png')});await page.mouse.dblclick(195,400);
    assert.equal(await page.locator('#sp-stage-immersive').isVisible(),true,'mobile double tap restores controls');
    await page.locator('#sp-return-2d').click();assert.equal(await page.locator('#sp-canvas canvas').count(),0,'closing the space disposes its renderer');
    assert.deepEqual(errors,[]);evidence.calls=calls;evidence.checks='canvas pixels and identity, aggregate/provider search, compact player, date spacing, exclusive panels and outside dismissal, click feedback/reduced motion, node drag, QR/Cookie, Escape, immersive, 320-1440px layout';
    fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));console.log('Spatial UI browser checks passed ('+(source?'source':'embedded')+')');
  }catch(error){
    console.error(error);
    if(page){
      await page.screenshot({path:path.join(output,'failure.png')});
      if(!await page.evaluate(()=>!!window.Space3D)){console.log('Space3D unavailable after navigation',errors);throw error;}
      const state=await page.evaluate(()=>({page:Space3D.stats().page,renderer:Space3D.stats().renderer,preferences:Space3D.preferences(),homeHidden:document.querySelector('#sp-home').hidden,modalHidden:document.querySelector('#qr-modal').hidden,status:document.querySelector('#qr-status').textContent,ports:Array.from(document.querySelectorAll('.qs-port')).map(node=>({html:node.outerHTML,rect:node.getBoundingClientRect().toJSON()}))}));
      state.layout=await page.evaluate(()=>({scrollX,innerWidth,root:document.querySelector('#space3d').getBoundingClientRect().toJSON(),body:document.body.getBoundingClientRect().toJSON(),bar:document.querySelector('#sp-bar').getBoundingClientRect().toJSON(),rootStyle:{position:getComputedStyle(document.querySelector('#space3d')).position,transform:getComputedStyle(document.querySelector('#space3d')).transform},fullscreen:!!document.fullscreenElement}));
      console.log(JSON.stringify(state,null,2),errors,calls);
    }
    throw error;
  }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
