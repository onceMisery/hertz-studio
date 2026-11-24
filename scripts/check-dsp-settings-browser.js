// SPDX-License-Identifier: MIT
// Post-change regression of production DSP controls in a real browser.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const ui = path.join(root, 'plugin/ui');
const index = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
const start = index.indexOf('<form class="set-group" id="dsp-settings"');
const end = index.indexOf('</form>', start);
assert.ok(start >= 0 && end > start);
const form = index.slice(start, end + 7);
const css = ['design/design-base.css', 'components/button.css', 'components/form.css', 'style.css', 'skins/skin.hertz.css', 'audio-quality.css'];
const html = `<!doctype html><html lang="zh-CN" data-skin="hertz"><head><meta charset="utf-8">
${css.map(file => `<link rel="stylesheet" href="/${file}">`).join('')}
<style>body{display:block;overflow:auto;padding:16px}main{max-width:900px;margin:auto}</style></head>
<body><main>${form}</main><script src="/dsp-settings.js"></script><script>
window.fixture = { gets:0, posts:0, pendingGet:null, pendingPost:null, blockGet:false, blockPost:false, failPost:false, hidden:false,
 cfg:{revision:'0',requested:{schema_version:2,revision:'0',eq:{enabled:false,bands:[60,150,400,1000,2400,6000].map(f=>({frequency_hz:f,q:1.2,gain_db:0}))},preamp_db:0,limiter:'soft',loudness_source:'file_tags',target_lufs:-18,impulse_id:null,tone:{crossfeed:false,crossfeed_amount:0.25,loudness_compensation:false,saturation:false,drive:0.15,mix:0.1},headroom_mode:'off',loudness_mode:'off',crossfade_ms:0},application_state:'deferred',applied_revision:null,output:null,effective:null,issues:[]},
 clone(value){return JSON.parse(JSON.stringify(value));},
 transport:{
  get(){const f=fixture; f.gets++; const value=f.clone(f.cfg); if(f.blockGet){f.blockGet=false;return new Promise(resolve=>f.pendingGet=()=>resolve(value));} return Promise.resolve(value);},
  post(url,body){const f=fixture; f.posts++; if(body.expected_revision!==f.cfg.revision) return Promise.reject(new Error('audio_quality_conflict')); Object.assign(f.cfg.requested,body.patch);if(f.cfg.requested.impulse_id==='')f.cfg.requested.impulse_id=null; f.cfg.revision=String(Number(f.cfg.revision)+1); f.cfg.requested.revision=f.cfg.revision; const value=f.clone(f.cfg);
   if(f.failPost){f.failPost=false;return Promise.reject(new Error('synthetic lost reply'));}
   if(f.blockPost){f.blockPost=false;return new Promise(resolve=>f.pendingPost=()=>resolve(value));}return Promise.resolve(value);}
 }};
window.Stage={isDocumentHidden(){return fixture.hidden;}};
window.controller=HertzDspSettings.init({transport:fixture.transport,toast(){}});
controller.load();</script></body></html>`;

async function main() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return; }
    const file = path.resolve(ui, '.' + url.pathname);
    if (!file.startsWith(ui + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH, headless:true });
    const page = await browser.newPage({viewport:{width:1000,height:800}});
    const errors=[]; page.on('pageerror', error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>document.querySelector('#dsp-status').textContent.includes('等待本机'));
    await page.locator('#dsp-preamp').fill('-4');
    await page.evaluate(()=>{fixture.blockPost=true;});
    await page.getByRole('button',{name:'保存音效'}).click();
    assert.equal(await page.locator('#dsp-save').isDisabled(),true);
    await page.evaluate(()=>document.querySelector('#dsp-settings').dispatchEvent(new Event('submit',{cancelable:true})));
    assert.equal(await page.evaluate(()=>fixture.posts),1);
    await page.locator('#dsp-preamp').fill('-7');
    await page.evaluate(()=>fixture.pendingPost());
    await page.waitForFunction(()=>!document.querySelector('#dsp-save').disabled);
    assert.equal(await page.locator('#dsp-preamp').inputValue(),'-7');
    assert.match(await page.locator('#dsp-status').textContent(),/未保存/);
    console.log('PASS valid submit blocks duplicate POST and preserves newer edits');

    await page.getByRole('button',{name:'保存音效'}).click();
    await page.waitForFunction(()=>!document.querySelector('#dsp-save').disabled);
    await page.evaluate(()=>{fixture.blockGet=true;controller.load();});
    await page.waitForFunction(()=>!!fixture.pendingGet);
    await page.locator('#dsp-preamp').fill('-2');
    await page.getByRole('button',{name:'保存音效'}).click();
    await page.waitForFunction(()=>!document.querySelector('#dsp-save').disabled);
    await page.evaluate(()=>fixture.pendingGet());
    assert.equal(await page.locator('#dsp-preamp').inputValue(),'-2');
    console.log('PASS stale GET cannot overwrite a newer save');

    await page.evaluate(()=>{
      controller.destroy();
      fixture.cfg.requested.preamp_db=-9;
      let first=true;
      const original=fixture.transport.get;
      fixture.transport.get=function(){if(first){first=false;return Promise.reject(new Error('initial read unavailable'));}return original();};
      controller=HertzDspSettings.init({transport:fixture.transport,toast(){}});
      controller.load();
    });
    await page.waitForFunction(()=>document.querySelector('#dsp-preamp').value==='-9');
    console.log('PASS initial GET failure retries and fills saved values before reporting readiness');

    await page.evaluate(()=>{fixture.failPost=true;});
    await page.locator('#dsp-preamp').fill('-5');
    const posts=await page.evaluate(()=>fixture.posts);
    await page.getByRole('button',{name:'保存音效'}).click();
    await page.waitForFunction(()=>document.querySelector('#dsp-status').textContent.includes('未确认'));
    await page.waitForFunction(()=>!document.querySelector('#dsp-status').textContent.includes('未确认'));
    assert.equal(await page.evaluate(()=>fixture.posts),posts+1);
    assert.equal(await page.locator('#dsp-preamp').inputValue(),'-5');
    console.log('PASS lost POST receipt reconciles with GET without resubmitting');

    await page.evaluate(()=>{fixture.cfg.application_state='failed';fixture.cfg.issues=[{message:'synthetic device failure'}];controller.load();});
    await page.waitForFunction(()=>document.querySelector('#dsp-status').textContent.includes('应用失败'));
    await page.evaluate(()=>{fixture.hidden=true;document.dispatchEvent(new Event('visibilitychange'));});
    const reads=await page.evaluate(()=>fixture.gets);
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(()=>fixture.gets),reads);
    await page.evaluate(()=>{fixture.hidden=false;fixture.cfg.application_state='applied';fixture.cfg.applied_revision=fixture.cfg.revision;fixture.cfg.effective={eq:{active:true}};document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForFunction(()=>document.querySelector('#dsp-status').textContent.includes('已应用到播放输出'));
    console.log('PASS failed adoption remains visible; hidden page stops polling and resume refreshes');

    await page.locator('#dsp-preamp').fill('100');
    const invalidPosts=await page.evaluate(()=>fixture.posts);
    await page.getByRole('button',{name:'保存音效'}).click();
    assert.equal(await page.evaluate(()=>fixture.posts),invalidPosts);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'dsp-preamp');
    await page.locator('#dsp-preamp').fill('-3');
    await page.locator('#dsp-preamp').press('Enter');
    await page.waitForFunction(n=>fixture.posts===n+1,invalidPosts);
    console.log('PASS native constraint validation and keyboard submit');

    await page.locator('#dsp-settings summary').first().click();
    await page.locator('#dsp-frequency-0').fill('80');
    await page.locator('#dsp-q-0').fill('3');
    await page.locator('#dsp-gain-0').fill('4');
    await page.locator('#dsp-eq-enabled').check();
    await page.evaluate(()=>{fixture.cfg.revision=String(Number(fixture.cfg.revision)+1);fixture.cfg.requested.revision=fixture.cfg.revision;});
    await page.getByRole('button',{name:'保存音效'}).click();
    await page.waitForFunction(()=>!document.querySelector('#dsp-save').disabled);
    assert.equal(await page.locator('#dsp-frequency-0').inputValue(),'80');
    await page.locator('#dsp-rebase').click();
    await page.waitForFunction(()=>document.querySelector('#dsp-status').textContent.includes('最新保存版本'));
    await page.getByRole('button',{name:'保存音效'}).click();
    await page.waitForFunction(()=>!document.querySelector('#dsp-save').disabled);
    assert.equal(await page.evaluate(()=>fixture.cfg.requested.eq.bands[0].frequency_hz),80);
    assert.equal(await page.evaluate(()=>fixture.cfg.requested.eq.bands[0].q),3);
    console.log('PASS parameter editing and explicit conflict rebase preserve draft');

    await page.locator('#dsp-settings summary').nth(1).click();
    await page.evaluate(()=>{
      const message='校正 IR/FIR 与过采样饱和当前仅支持 44.1/48 kHz；请关闭这些处理或选择受支持的输出采样率';
      fixture.cfg.capabilities={saturation:{available:false,message},impulse:{available:false,message},true_peak:{available:true}};
      controller.load();
    });
    await page.waitForFunction(()=>document.querySelector('#dsp-saturation-status').textContent.includes('仅支持 44.1/48'));
    assert.equal(await page.locator('#dsp-saturation').isDisabled(),false);
    assert.equal(await page.locator('#dsp-saturation').getAttribute('aria-describedby'),'dsp-saturation-status');
    await page.locator('#dsp-limiter').selectOption('true_peak');
    await page.locator('#dsp-saturation').check();
    await page.locator('#dsp-impulse').fill('a'.repeat(64));
    const restrictedPosts=await page.evaluate(()=>fixture.posts);
    await page.getByRole('button',{name:'保存音效'}).click();
    assert.equal(await page.evaluate(()=>fixture.posts),restrictedPosts);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'dsp-saturation');
    assert.equal(await page.locator('#dsp-impulse').inputValue(),'a'.repeat(64));
    await page.locator('#dsp-saturation').uncheck();
    await page.getByRole('button',{name:'保存音效'}).click();
    assert.equal(await page.evaluate(()=>fixture.posts),restrictedPosts);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'dsp-impulse');
    console.log('PASS unavailable effects explain qualification, focus errors and preserve draft');

    await page.evaluate(()=>{
      fixture.cfg.capabilities.saturation={available:true};fixture.cfg.capabilities.impulse={available:true};
      controller.load();
    });
    await page.waitForFunction(()=>!document.querySelector('#dsp-impulse').validity.customError);
    await page.getByRole('button',{name:'保存音效'}).click();
    await page.waitForFunction(n=>fixture.posts===n+1,restrictedPosts);
    await page.waitForFunction(()=>!document.querySelector('#dsp-save').disabled);
    assert.equal(await page.evaluate(()=>fixture.cfg.requested.impulse_id),'a'.repeat(64));
    await page.evaluate(()=>{
      const message='当前输出暂不支持校正 IR/FIR 与过采样饱和，仅支持 44.1/48 kHz';
      fixture.cfg.capabilities.saturation={available:false,message};fixture.cfg.capabilities.impulse={available:false,message};
      controller.load();
    });
    await page.waitForFunction(()=>document.querySelector('#dsp-impulse-status').textContent.includes('当前输出暂不支持'));
    assert.equal(await page.locator('#dsp-impulse').inputValue(),'a'.repeat(64));
    await page.locator('#dsp-impulse').fill('');
    await page.getByRole('button',{name:'保存音效'}).click();
    await page.waitForFunction(()=>fixture.cfg.requested.impulse_id===null&&!document.querySelector('#dsp-save').disabled);
    assert.equal(await page.evaluate(()=>fixture.cfg.requested.limiter),'true_peak');
    assert.equal(await page.evaluate(()=>fixture.cfg.requested.eq.bands[0].frequency_hz),80);
    console.log('PASS supported output refresh clears stale errors and heavy effects can be disabled');

    for(const width of [390,800]) {
      await page.setViewportSize({width,height:900});
      for(const zoom of [1,2]) {
        await page.evaluate(z=>{document.documentElement.style.zoom=String(z);},zoom);
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2);
        assert.equal(overflow,false,`form overflow at ${width}px / ${zoom}`);
      }
    }
    await page.evaluate(()=>document.documentElement.style.zoom='1');
    const output=path.join(root,'output/playwright');fs.mkdirSync(output,{recursive:true});
    await page.screenshot({path:path.join(output,'dsp-settings.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS 390px, 200% scaling and clean browser execution');
  } finally { if(browser) await browser.close(); await new Promise(resolve=>server.close(resolve)); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
