// SPDX-License-Identifier: MIT
// Current Hertz layout identity, rollback and public button variants.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {startFixture}=require('./ui-browser-fixture');
const web=path.resolve(process.env.HERTZ_UI_ASSETS||path.join(__dirname,'../plugin/ui'));
const output=path.resolve(__dirname,'../output/playwright/layout');
let checks=0;
const check=(value,label)=>{assert(value,label);checks++;console.log('PASS '+label);};
(async()=>{
  const fixture=await startFixture();let browser;
  try{
    await fixture.seed();fs.mkdirSync(output,{recursive:true});
    browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    await fixture.connect(context);
    const token=fs.readFileSync(path.join(fixture.dataDir,'token'),'utf8').trim();
    await context.grantPermissions(['local-network-access'],{origin:fixture.base});
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route(fixture.base+'/**',route=>{
      const name=decodeURIComponent(new URL(route.request().url()).pathname).slice(1)||'index.html',file=path.resolve(web,name);
      if(!file.startsWith(web+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.continue();
      let body=fs.readFileSync(file);if(name==='index.html')body=body.toString().replace('__VMUSIC_TOKEN_VALUE__',token);
      const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'};
      return route.fulfill({body,contentType:mime[path.extname(file)]||'application/octet-stream'});
    });
    await page.goto(fixture.base);
    const ready=()=>page.waitForFunction(()=>window.HertzShell?.activeView()==='home'&&window.Skins?.currentId()==='hertz'&&HertzShell.isLayoutAssembled('hertz')&&document.querySelector('#view-library > .hz-library-tabs')&&document.querySelector('#view-playlists > .hz-library-tabs'));
    await ready();
    const facts=await page.evaluate(()=>{
      const shell=HertzShell,parent=document.createElement('section'),destination=document.createElement('section'),third=document.createElement('section');
      document.body.append(parent,destination,third);
      const a=document.createElement('button'),b=document.createElement('span'),c=document.createElement('span');parent.append(a,b,c);
      let clicks=0;a.addEventListener('click',()=>clicks++);
      const first=shell.beginLayout('probe-first'),second=shell.beginLayout('probe-second'),rejected=[];
      const reject=(label,run)=>{try{run();}catch{rejected.push(label);}};
      first.move(a,destination);
      reject('exclusive',()=>second.move(a,third));reject('cycle',()=>first.move(a,a));
      reject('invalid-before',()=>first.move(b,third,c));
      const append=third.appendChild;
      third.appendChild=function(node){append.call(this,node);throw new Error('insertion changed DOM then failed');};
      reject('mutating-insert',()=>first.move(b,third));third.appendChild=append;
      reject('view-root',()=>second.move(document.getElementById('view-library'),third));
      reject('active-hertz',()=>second.move(document.getElementById('home-dashboard'),third));
      const rollback=first.size()===1&&b.parentNode===parent;
      first.move(a,third);const unique=first.size()===1;a.click();shell.releaseLayout('probe-first');
      const restored=parent.children.length===3&&parent.children[0]===a&&parent.children[1]===b&&parent.children[2]===c&&clicks===1;
      second.move(a,destination);shell.releaseLayout('probe-second');
      const released=a.parentNode===parent&&!shell.isLayoutAssembled('probe-first')&&!shell.isLayoutAssembled('probe-second');
      const clean=Array.from(parent.childNodes).every(node=>node.nodeType!==8);parent.remove();destination.remove();third.remove();
      return {rejected,rollback,unique,restored,released,clean,legacy:Skins.catalog().some(item=>['classic','liunian','qingfeng','heijiao','orbit'].includes(item.id))};
    });
    for(const label of ['exclusive','cycle','invalid-before','mutating-insert','view-root','active-hertz'])check(facts.rejected.includes(label),'Reject '+label+' without committing a move');
    for(const label of ['rollback','unique','restored','released','clean'])check(facts[label],'Current layout '+label);
    check(!facts.legacy,'Retired layouts remain absent');
    for(let i=0;i<2;i++){await page.reload();await ready();check(await page.locator('#view-library > .hz-library-tabs').count()===1&&await page.locator('#view-playlists > .hz-library-tabs').count()===1,'Reload keeps one assembly for each actual library/playlist tab group');}
    for(const width of [1440,390])for(const theme of ['hertz-dark','hertz-light']){
      await page.setViewportSize({width,height:1000});
      await page.evaluate(theme=>{Theme.apply(theme,{silent:true});HertzShell.navigate('room');const probe=document.createElement('div');probe.id='button-state-probe';probe.innerHTML='<button id="state-primary" class="btn touch flat primary">Public primary</button>';document.getElementById('view-room').appendChild(probe);},theme);
      const button=page.locator('#state-primary'),read=()=>button.evaluate(el=>{const s=getComputedStyle(el);return {height:s.minHeight,weight:s.fontWeight,shadow:s.boxShadow,bg:s.backgroundColor,color:s.color,transition:s.transitionProperty};});
      await page.mouse.move(0,0);const rest=await read();await button.hover();const hover=await read();
      check(rest.height==='44px'&&rest.weight==='600'&&rest.shadow==='none',width+'/'+theme+' touch metrics survive Hertz defaults');
      check(hover.bg===rest.bg&&hover.color===rest.color&&hover.bg!==hover.color,width+'/'+theme+' primary hover preserves color pair');
      check(rest.transition==='none',width+'/'+theme+' reduced motion disables transition');
      await page.mouse.down();check(await button.evaluate(el=>getComputedStyle(el).transform!=='none'),width+'/'+theme+' press feedback');await page.mouse.up();
      await button.evaluate(el=>{el.disabled=true;});check(await button.evaluate(el=>getComputedStyle(el).cursor==='not-allowed'&&getComputedStyle(el).transform==='none'),width+'/'+theme+' disabled feedback');
      await page.locator('#button-state-probe').screenshot({path:path.join(output,width+'-'+theme+'.png')});await page.locator('#button-state-probe').evaluate(el=>el.remove());
    }
    check(errors.length===0,'No current-page JavaScript errors: '+errors.join('; '));
    console.log('Current shell layout browser checks: '+checks+' passed');
  }finally{if(browser)await browser.close();await fixture.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
