// SPDX-License-Identifier: MIT
// Renderer regression with a native IPC fixture; never touches the user's player/config.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'crates/hertz-desktop/assets');
const output = path.join(root, 'output/playwright/desktop-lyrics');
const config = {
  enabled:true, locked:false, layout:'triple', secondary:'next', theme:'dark', surface:'glass', align:'center',
  bilingual:true, karaoke:true, readabilityBoost:false, fontFamily:'Segoe UI', fontSize:30, fontWeight:600,
  sungColor:'#ffffff', unsungColor:'#ffffff', outlineColor:'#000000', outlineWidth:0, opacity:1, frameCap:30, panelMaxHeight:360,
};
const lines = [
  ['也许你不会懂', 'Perhaps you will never know'],
  ['从你说爱我以后', 'Ever since you said you loved me'],
  ['我的天空 星星都亮了', 'Every star in my sky began to shine'],
  ['想把你写成一首歌', 'I want to write you into a song'],
  ['想养一只猫', 'And raise a little cat'],
  ['想要回到每个场景', 'To return to every moment'],
  ['拨慢时钟', 'And slow the hands of time'],
].map(([text, translation], i) => ({startMs:i*5000, endMs:i*5000+4500, text, translation, romanization:'xiang ba ni xie cheng yi shou ge',
  words:[...text].map((text,j,chars)=>({text,startMs:i*5000+j*4500/chars.length,endMs:i*5000+(j+1)*4500/chars.length}))}));
function fixture() {
  window.commands = [];
  window.fixture = {
    config: INITIAL_CONFIG,
    document: {protocol:1, documentKey:'fixture', lines:structuredClone(INITIAL_LINES)},
    snapshot: {protocol:1,seq:0,server:{session:'fixture'},generation:'1',positionMs:17000,durationMs:35000,playing:false,buffering:false,track:{id:'fixture-track'},lyrics:{status:'ready',documentKey:'fixture'}},
    polling:true,
    send() { this.snapshot.seq++; window.hertzLyrics.applySnapshot(structuredClone(this.snapshot)); },
    load() { this.send(); window.hertzLyrics.applyDocument(structuredClone(this.document)); },
  };
  window.ipc = { postMessage(text) {
    const request = JSON.parse(text); window.commands.push(request);
    const f = window.fixture;
    setTimeout(() => {
      if (request.cmd === 'ready') { window.hertzLyrics.applyConfig(f.config); window.hertzLyrics.setSource({state:'ok'}); f.load(); }
      if (request.cmd === 'panel' || ['appearance','layout','secondary'].includes(request.cmd)) {
        if (request.cmd === 'appearance') f.config[request.target] = request.value ?? (request.text === 'true' ? true : request.text === 'false' ? false : request.text);
        if (request.cmd === 'layout' || request.cmd === 'secondary') f.config[request.cmd] = request.text;
        if (request.cmd !== 'panel') window.hertzLyrics.applyConfig(f.config);
        if (request.cmd === 'panel') f.panel = request.value;
        const count = {single:1,double:2,triple:3}[f.config.layout];
        parent.postMessage({height:f.config.fontSize*(innerWidth<=360?(f.config.bilingual?4.5:3.25):(f.config.bilingual?2.55:2))*count+108+(f.panel||0)}, '*');
      }
      if (['play','pause','seek'].includes(request.cmd)) {
        if(request.cmd === 'seek') f.snapshot.positionMs = request.value;
        else f.snapshot.playing = request.cmd === 'play';
        f.snapshot.generation = String(Number(f.snapshot.generation)+1); f.send(); window.hertzLyrics.controlDone();
      }
    }, 0);
  }};
  setInterval(() => { if(window.fixture.polling) window.fixture.send(); }, 500);
}
const lyricsHtml = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>' + fs.readFileSync(path.join(assets, 'desktop-lyrics.css'),'utf8') + '</style><body>'
  + fs.readFileSync(path.join(assets, 'desktop-lyrics.html'),'utf8') + '<script>const INITIAL_CONFIG='+JSON.stringify(config)+';const INITIAL_LINES='+JSON.stringify(lines)+';('+fixture.toString()+')();</script><script>'
  + fs.readFileSync(path.join(assets,'desktop-lyrics.js'),'utf8') + '</script></body></html>';
const wrapper = `<!doctype html><html><meta charset="utf-8"><style>
body{margin:0;height:100vh;overflow:hidden;background:radial-gradient(ellipse at 20% 24%,#2b3fb0,transparent 60%),radial-gradient(ellipse at 78% 16%,#5a2a8c,transparent 60%),radial-gradient(ellipse at 66% 86%,#0e5e6b,transparent 64%),#0b1020}
body.light{background:radial-gradient(ellipse at 18% 22%,#ffcfa8,transparent 62%),radial-gradient(ellipse at 62% 88%,#bfd9ff,transparent 64%),#f4f1ec}
iframe{border:0;position:absolute;left:50%;top:80px;transform:translateX(-50%);width:550px;height:337.5px}
</style><iframe src="/lyrics" title="桌面歌词"></iframe><script>addEventListener('message',e=>{if(e.data.height)document.querySelector('iframe').style.height=e.data.height+'px'});</script></html>`;
const server = http.createServer((request,response)=>{
  response.setHeader('Content-Type','text/html; charset=utf-8');
  response.end(request.url === '/lyrics' ? lyricsHtml : wrapper);
});
async function main() {
  await new Promise(resolve=>server.listen(process.argv.includes('--serve')?18796:0,'127.0.0.1',resolve));
  const url = 'http://127.0.0.1:'+server.address().port;
  if(process.argv.includes('--serve')) { console.log(url); return; }
  const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:1080},colorScheme:'dark'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    fs.mkdirSync(output,{recursive:true});
    await page.goto(url);
    const frame = page.frames().find(f=>f.url().endsWith('/lyrics'));
    await frame.waitForSelector('.lyric-group[data-distance="0"]');
    const current = frame.locator('.lyric-group[data-distance="0"]');
    assert.equal(await current.locator('.base').allTextContents().then(a=>a.join('')),lines[3].text);
    assert.ok(await frame.locator('.lyric-group').count()<=7,'DOM stays bounded');
    await page.mouse.move(10,10);
    await page.waitForTimeout(400);
    assert.equal(await frame.locator('#toolbar').evaluate(e=>getComputedStyle(e).opacity),'0');
    await page.screenshot({path:path.join(output,'dark-rest.png')});
    await page.locator('iframe').screenshot({path:path.join(output,'dark-lyrics.png')});
    await current.hover();
    await frame.locator('#style-open').click();
    await frame.waitForFunction(()=>document.body.classList.contains('options-open'));
    await frame.locator('[data-setting="theme"][data-value="light"]').click();
    await frame.waitForFunction(()=>document.body.dataset.theme==='light');
    await page.evaluate(()=>document.body.classList.add('light'));
    await page.screenshot({path:path.join(output,'light-settings.png')});
    await frame.locator('[data-setting="theme"][data-value="auto"]').click();
    await frame.waitForFunction(()=>document.body.dataset.theme==='dark');
    await page.emulateMedia({colorScheme:'light'});
    await frame.waitForFunction(()=>document.body.dataset.theme==='light');
    await frame.locator('[data-setting="surface"][data-value="bare"]').click();
    await frame.waitForFunction(()=>document.body.dataset.surface==='bare');
    assert.equal(await frame.locator('.pane').evaluate(e=>getComputedStyle(e).backdropFilter),'none');
    await frame.locator('[data-setting="layout"][data-value="double"]').click();
    await frame.waitForFunction(()=>document.body.dataset.layout==='double');
    await frame.waitForFunction(()=>{
      const viewport=document.getElementById('viewport').getBoundingClientRect();
      const next=document.querySelector('.lyric-group[data-distance="1"] .sub').getBoundingClientRect();
      return next.top>=viewport.top && next.bottom<=viewport.bottom-10;
    });
    await frame.locator('[data-setting="layout"][data-value="single"]').click();
    await frame.waitForFunction(()=>document.body.dataset.layout==='single');
    await frame.locator('[data-setting="align"][data-value="left"]').click();
    await frame.waitForFunction(()=>getComputedStyle(document.querySelector('.lyric-group')).textAlign==='left');
    await frame.locator('[data-toggle="bilingual"]').click();
    await frame.waitForFunction(()=>document.body.dataset.bilingual==='false');
    assert.equal(await current.locator('.sub').isVisible(),false);
    await frame.locator('[data-toggle="karaoke"]').click();
    await frame.waitForFunction(()=>document.querySelectorAll('.word').length===0);
    await frame.locator('#options-done').click();
    await frame.waitForFunction(()=>document.getElementById('options-panel').hidden);
    // Ordinary LRC must never invent character timings.
    await frame.evaluate(()=>{fixture.document.lines.forEach(line=>line.words=[]);fixture.load();});
    assert.equal(await current.locator('.word').count(),0);
    // Pause freezes the fill, and known gaps show an interlude rather than old lyrics.
    await frame.evaluate(()=>{fixture.config.karaoke=true;hertzLyrics.applyConfig(fixture.config);fixture.document.lines=structuredClone(INITIAL_LINES);fixture.load();});
    await frame.evaluate(()=>{fixture.snapshot.positionMs=19700;fixture.snapshot.generation='9';fixture.send();});
    assert.equal(await current.locator('.main').innerText(),'· · ·');
    await frame.evaluate(()=>{fixture.snapshot.positionMs=17000;fixture.snapshot.generation='10';fixture.send();});
    const mask = await current.locator('.word').first().getAttribute('style');
    await page.waitForTimeout(200);
    assert.equal(await current.locator('.word').first().getAttribute('style'),mask);
    // Toolbar commands use real phrase starts and do not optimistically change playback.
    await current.hover();await frame.locator('#next').click();
    await frame.waitForFunction(()=>fixture.snapshot.positionMs===20000);
    assert.equal(await frame.evaluate(()=>commands.filter(c=>c.cmd==='seek').at(-1).value),20000);
    await frame.locator('#play').click();await frame.waitForFunction(()=>fixture.snapshot.playing);
    await frame.locator('#play').click();await frame.waitForFunction(()=>!fixture.snapshot.playing);
    // Disconnect, same-key song switches, stale anchors and lock must clear/disable safely.
    await frame.evaluate(()=>{fixture.polling=false;fixture.snapshot.track.id='new';fixture.send();});
    assert.equal(await frame.locator('.lyric-group').count(),0);
    await frame.evaluate(()=>fixture.load());
    await page.waitForTimeout(2100);
    assert.equal(await frame.locator('.lyric-group').count(),0);
    assert.equal(await frame.locator('#play').isDisabled(),true);
    await frame.evaluate(()=>{fixture.polling=true;fixture.load();hertzLyrics.setLocked(true);});
    assert.equal(await frame.locator('#toolbar').isVisible(),false);
    assert.equal(await frame.locator('#options-panel').isVisible(),false);
    // Text is never interpreted as HTML, even after a document replacement.
    await frame.evaluate(()=>{hertzLyrics.setLocked(false);fixture.document.lines[4].text='<img src=x onerror=alert(1)>';fixture.document.lines[4].words=[];fixture.snapshot.positionMs=21000;fixture.load();});
    assert.equal(await frame.locator('#stage img').count(),0);
    assert.match(await current.locator('.main').innerText(),/<img/);
    // Dense narrow/high-DPI text remains inside its two-line slot and settings remain usable.
    await page.setViewportSize({width:500,height:900});
    await page.locator('iframe').evaluate(e=>{e.style.width='280px';});
    await frame.evaluate(()=>{fixture.config.fontSize=46;fixture.config.layout='triple';fixture.config.bilingual=true;fixture.config.surface='solid';fixture.config.align='center';fixture.config.panelMaxHeight=180;hertzLyrics.applyConfig(fixture.config);});
    await current.hover();await frame.locator('#style-open').click();
    const panel=await frame.locator('#options-panel').boundingBox();
    assert.ok(panel.width<=248);assert.ok(panel.height<=180);
    await frame.locator('#options-done').click();
    await page.screenshot({path:path.join(output,'narrow.png')});
    assert.deepEqual(errors,[]);
    console.log('Desktop lyrics browser checks passed. Screenshots: '+output);
  } finally {await browser.close();server.close();}
}
if(require.main===module) main().catch(error=>{console.error(error);server.close();process.exitCode=1;});
module.exports = { config, lines };
