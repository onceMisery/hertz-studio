// SPDX-License-Identifier: MIT
// Real isolated service and current source assets: wall/player handoff, native touch and lifecycle.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const root = path.resolve(__dirname,'..');
const windowHost=process.argv.includes('--window-host');
const output=path.join(root,'output/playwright/cover-wall'+(windowHost?'-window-host':''));
fs.mkdirSync(output,{recursive:true});
const checks=[];
function check(value,label){assert.ok(value,label);checks.push(label);console.log('PASS '+label);}
async function cameraState(page) {
  return page.evaluate(()=>{
    const root=document.querySelector('.qf-lattice');
    const rect=root.getBoundingClientRect();
    const matrix=new DOMMatrix(getComputedStyle(document.querySelector('.qf-lattice-world')).transform);
    return {x:matrix.m41,y:matrix.m42,scale:matrix.m11,left:rect.left,top:rect.top,width:root.clientWidth,height:root.clientHeight};
  });
}
function worldPoint(camera,x,y) {return {x:(x-camera.left-camera.x)/camera.scale,y:(y-camera.top-camera.y)/camera.scale};}
function samePoint(a,b) {return Math.abs(a.x-b.x)<.1&&Math.abs(a.y-b.y)<.1;}
async function checkWallFrame(page, label) {
  const geometry=await page.evaluate(()=>{
    const rect=selector=>document.querySelector(selector).getBoundingClientRect();
    const root=rect('.qf-lattice'),header=rect('.qf-wall-header'),poster=rect('.qf-poster.is-expanded');
    const bottom=Math.min(root.bottom-100,rect('.qf-tools').top-20,rect('.qf-queue-peek').top-20);
    const top=header.bottom+20;
    return {rootTop:root.top,rootBottom:root.bottom,height:innerHeight,
      contained:header.top>=root.top&&poster.top>=top-2&&poster.bottom<=bottom+2&&poster.left>=root.left&&poster.right<=root.right,
      centered:Math.abs(poster.left+poster.width/2-(root.left+root.width/2))<5&&Math.abs(poster.top+poster.height/2-(top+bottom)/2)<5};
  });
  check(geometry.rootTop===0&&geometry.rootBottom===geometry.height&&geometry.contained&&geometry.centered,label+' fits and centers the expanded poster inside the complete client area '+JSON.stringify(geometry));
}
async function tabTo(page, selector, reverse=false) {
  for(let i=0;i<40;i++) {
    await page.keyboard.press(reverse?'Shift+Tab':'Tab');
    const state=await page.evaluate(sel=>({match:document.activeElement.matches(sel),inside:document.querySelector('.qf-lattice').contains(document.activeElement)}),selector);
    assert.ok(state.inside,'Tab focus stays inside the open wall');
    if(state.match)return;
  }
  throw new Error('Keyboard could not reach '+selector);
}
async function keyboardWall(page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelector('.qf-lattice').hidden);
  const entry=page.getByRole('button',{name:'封面模式',exact:true});
  await entry.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1300);
  check(await page.evaluate(()=>document.activeElement.matches('.qf-poster.is-focused')&&document.querySelectorAll('.qf-poster[tabindex="0"]').length===1),'keyboard opening focuses a real poster with one Tab stop');
  for(const key of ['ArrowRight','ArrowDown','ArrowLeft','ArrowUp','ArrowRight']) {
    const before=await page.evaluate(()=>document.activeElement.dataset.qfKey);
    await page.keyboard.press(key);
    await page.waitForTimeout(500);
    check(await page.evaluate(previous=>{const n=document.activeElement;const r=n.getBoundingClientRect();return n.matches('.qf-poster.is-focused')&&n.dataset.qfKey!==previous&&r.left+r.width/2>0&&r.left+r.width/2<innerWidth&&r.top+r.height/2>0&&r.top+r.height/2<innerHeight;},before),key+' moves DOM focus to a visible neighboring poster');
  }
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  check(await page.evaluate(()=>HertzCoverWall.isOpen()&&document.activeElement.matches('.qf-poster.is-expanded.is-focused')&&document.querySelectorAll('.qf-poster.is-expanded').length===1),'Enter expands the focused poster and retains focus through reflow');
  check(await page.evaluate(()=>parseFloat(getComputedStyle(document.activeElement).outlineWidth)>0),'expanded poster has a visible keyboard focus ring');
  await page.keyboard.press('Space');
  check(await page.evaluate(()=>HertzCoverWall.isOpen()&&document.activeElement.matches('.qf-poster.is-expanded')),'Space activates a poster without closing the wall');
  await tabTo(page,'.qf-poster.is-expanded input[type="range"]');
  const rangeBefore=await page.evaluate(()=>Number(document.activeElement.value));
  const selectedBefore=await page.locator('.qf-poster.is-focused').getAttribute('data-qf-key');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  check(await page.evaluate(({value,key})=>document.activeElement.matches('.qf-poster input[type="range"]')&&Number(document.activeElement.value)===value+2&&document.querySelector('.qf-poster.is-focused').dataset.qfKey===key,{value:rangeBefore,key:selectedBefore}),'range accepts consecutive native arrows without losing focus or selecting another poster');
  await tabTo(page,'.qf-poster.is-expanded .qf-chrome-play',true);
  const playing=await page.evaluate(()=>document.body.classList.contains('is-playing'));
  await page.keyboard.press('Space');
  await page.waitForFunction(before=>document.body.classList.contains('is-playing')!==before,playing);
  check(await page.evaluate(()=>document.activeElement.matches('.qf-poster.is-expanded .qf-chrome-play')&&HertzCoverWall.isOpen()),'native play button Space toggles playback and keeps control focus');
  await tabTo(page,'.qf-wall-zoom[aria-label="放大"]');
  const scaleBefore=await page.locator('.qf-lattice').evaluate(n=>Number(n.style.getPropertyValue('--qf-scale')));
  await page.keyboard.press('Enter');
  check(await page.evaluate(scale=>document.activeElement.matches('.qf-wall-zoom')&&Number(document.querySelector('.qf-lattice').style.getPropertyValue('--qf-scale'))>scale,scaleBefore),'native zoom button Enter keeps its focus through camera rendering');
  await tabTo(page,'.qf-wall-source[data-source="favorites"]');
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  check(await page.evaluate(()=>document.activeElement.matches('.qf-wall-source[data-source="favorites"]')&&document.activeElement.getAttribute('aria-pressed')==='true'&&document.querySelectorAll('.qf-poster').length===0),'native source Space reaches the empty state without activating a poster');
  await tabTo(page,'.qf-wall-source[data-source="library"]',true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  await tabTo(page,'.qf-poster[tabindex="0"]');
  check(await page.evaluate(()=>document.activeElement.matches('.qf-poster.is-focused')),'Tab returns from source controls to the repopulated poster');
  await tabTo(page,'.qf-poster[tabindex="0"]',true);
  check(await page.evaluate(()=>document.activeElement.matches('.qf-poster.is-focused')),'Shift+Tab completes a reverse modal cycle including the poster');
  await page.keyboard.press('Escape');
  check(await entry.evaluate(n=>document.activeElement===n),'Escape restores keyboard focus to the opening button');
}
(async()=>{
  const fixture=await startFixture();
  let browser;
  try {
    await fixture.seed();
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets']});
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});
    await fixture.connect(context);
    const page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{localStorage.setItem('vmusic.defaultView','library');localStorage.setItem('vmusic.skin','hertz');localStorage.setItem('vmusic.theme','hertz-dark');});
    if(windowHost) {
      const host=fs.readFileSync(path.join(root,'crates/hertz-studio/src/window.rs'),'utf8').match(/const HOST_SCRIPT: &str = r#"([\s\S]*?)"#;/);
      assert.ok(host,'The actual native host initialization script is available');
      await page.addInitScript({content:host[1]});
    }
    const token=JSON.parse(fs.readFileSync(path.join(fixture.dataDir,'vmusicd.json'),'utf8')).token;
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      const file=path.join(root,'plugin/ui',decodeURIComponent(url.pathname));
      if(url.origin!==fixture.base)return route.continue();
      if(url.pathname==='/') return route.fulfill({contentType:'text/html; charset=utf-8',body:fs.readFileSync(path.join(root,'plugin/ui/index.html'),'utf8').replaceAll('__VMUSIC_TOKEN_VALUE__',token)});
      if(!url.pathname.startsWith('/v1/')&&file.startsWith(path.join(root,'plugin/ui')+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({path:file});
      return route.continue();
    });
    await page.goto(fixture.base);
    await page.waitForFunction(()=>window.HertzCoverWall&&window.Skins&&Skins.currentId()==='hertz'&&document.getElementById('conn').textContent==='服务已连接',null,{timeout:30000});
    await page.evaluate(()=>HertzShell.navigate('library'));
    await page.waitForFunction(()=>Skins.request('source-request').source.items.length>0);
    await page.getByRole('button',{name:'封面模式',exact:true}).click();
    await page.waitForTimeout(1300);
    check(await page.locator('.qf-poster').count()>0,'real library source renders cover-wall cards');
    check(await page.locator('.qf-poster.is-expanded').count()===1,'real playback state expands current track');
    await checkWallFrame(page,'390px');
    const camera=await page.locator('.qf-lattice-world').getAttribute('style');
    const source=await page.locator('.qf-lattice-tag strong').textContent();
    await page.getByRole('button',{name:'展开播放页',exact:true}).tap();
    await page.waitForFunction(()=>NowPlaying.isOpen());
    check(await page.evaluate(()=>HertzCoverWall.isOpen()&&document.querySelector('.qf-lattice').inert),'real NowPlaying preserves wall and owns focus');
    await page.locator('#np-close').tap();
    await page.waitForFunction(()=>!NowPlaying.isOpen());
    check(await page.evaluate(()=>HertzCoverWall.isOpen()&&!document.querySelector('.qf-lattice').inert),'closing real NowPlaying restores active wall');
    check(camera===await page.locator('.qf-lattice-world').getAttribute('style')&&source===await page.locator('.qf-lattice-tag strong').textContent(),'real player return retains source and exact camera');
    const cdp=await context.newCDPSession(page);
    const touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(p=>({id:p[0],x:p[1],y:p[2],radiusX:4,radiusY:4,force:1}))});
    const beforeDrag=await cameraState(page);
    await touch('touchStart',[[1,180,330]]);await touch('touchMove',[[1,210,350]]);await touch('touchMove',[[1,245,370]]);await touch('touchEnd',[]);
    const afterDrag=await cameraState(page);
    check(Math.abs(afterDrag.x-beforeDrag.x-65)<.1&&Math.abs(afterDrag.y-beforeDrag.y-40)<.1,'native touch drag pans by the exact client delta '+JSON.stringify({beforeDrag,afterDrag}));
    check(await page.locator('.qf-poster.is-expanded').count()===1,'native drag release preserves existing expanded card');
    const beforeZoom=await cameraState(page);
    await touch('touchStart',[[1,140,320]]);await touch('touchStart',[[1,140,320],[2,230,390]]);await touch('touchMove',[[1,100,290],[2,270,420]]);await touch('touchEnd',[]);
    const afterZoom=await cameraState(page);
    check(afterZoom.scale>beforeZoom.scale,'native two-finger gesture zooms wall');
    check(samePoint(worldPoint(beforeZoom,185,355),worldPoint(afterZoom,185,355)),'native pinch keeps the world point under the finger midpoint');
    await page.mouse.move(180,340);await page.mouse.wheel(14,24);await page.waitForTimeout(120);
    const afterWheel=await cameraState(page);
    check(Math.abs(afterWheel.x-afterZoom.x+14)<.1&&Math.abs(afterWheel.y-afterZoom.y+24)<.1,'native wheel pans by the exact wheel delta');
    await page.keyboard.down('Control');await page.mouse.wheel(0,-70);await page.keyboard.up('Control');await page.waitForTimeout(120);
    const afterWheelZoom=await cameraState(page);
    check(afterWheelZoom.scale>afterWheel.scale&&samePoint(worldPoint(afterWheel,180,340),worldPoint(afterWheelZoom,180,340)),'native Ctrl+wheel zoom keeps the world point under the cursor');
    await page.setViewportSize({width:320,height:740});await page.waitForTimeout(600);
    await checkWallFrame(page,'320px resized');
    const scroller=page.locator('.qf-wall-sources');
    const area=await scroller.boundingBox();
    await touch('touchStart',[[3,area.x+area.width-20,area.y+22]]);await touch('touchMove',[[3,area.x+160,area.y+22]]);await touch('touchMove',[[3,area.x+20,area.y+22]]);await touch('touchEnd',[]);
    await page.waitForTimeout(250);
    check(await scroller.evaluate(n=>n.scrollLeft)>0,'320px source navigation scrolls with native touch');
    await page.getByRole('button',{name:'每日推荐',exact:true}).tap();
    await page.waitForTimeout(250);
    check(await page.locator('.qf-wall-source[data-source="daily"]').getAttribute('aria-pressed')==='true','last source remains reachable on narrow touch screen');
    await page.locator('.qf-wall-source[data-source="library"]').tap();
    await page.waitForTimeout(600);
    await page.screenshot({path:path.join(output,'mobile.png')});
    await page.setViewportSize({width:1440,height:960});await page.waitForTimeout(600);
    await page.keyboard.press('Tab');
    await tabTo(page,'.qf-poster[tabindex="0"]');
    await page.keyboard.press('Enter');await page.waitForTimeout(600);
    await checkWallFrame(page,'1440px resized');
    await page.screenshot({path:path.join(output,'desktop.png')});
    await page.evaluate(()=>{for(let i=0;i<5;i++){HertzCoverWall.unmount();HertzCoverWall.mount();}HertzCoverWall.open();});
    check(await page.locator('.qf-lattice').count()===1,'real app supports five wall mount/unmount cycles');
    await page.getByRole('button',{name:'展开播放页',exact:true}).click();await page.waitForFunction(()=>NowPlaying.isOpen());await page.locator('#np-close').click();
    check(await page.evaluate(()=>HertzCoverWall.isOpen()),'player-return integration survives remounting');
    await page.waitForTimeout(600);
    const beforeFullscreen=await page.locator('.qf-lattice-world').getAttribute('style');
    await page.getByRole('button',{name:'展开播放页',exact:true}).click();
    await page.locator('#np-more').click();
    await page.locator('#np-fullscreen').click();
    await page.waitForFunction(()=>document.fullscreenElement?.id==='np-modal');
    check(await page.locator('#np-modal').evaluate(n=>{const r=n.getBoundingClientRect();return r.top===0&&r.bottom===innerHeight;}),'fullscreen player uses the complete viewport without a window inset');
    await page.locator('#np-fullscreen').click();
    await page.waitForFunction(()=>!document.fullscreenElement);
    await page.locator('#np-tools-close').click();
    await page.locator('#np-close').click();await page.waitForTimeout(100);
    check(beforeFullscreen===await page.locator('.qf-lattice-world').getAttribute('style'),'fullscreen player return preserves exact wall camera');
    await keyboardWall(page);
    check(errors.length===0,'real application has no JavaScript errors');
    fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify({checks,errors},null,2));
    console.log(JSON.stringify({count:checks.length,errors}));
  } finally {if(browser)await browser.close();await fixture.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
