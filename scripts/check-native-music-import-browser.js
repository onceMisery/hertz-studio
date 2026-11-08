// SPDX-License-Identifier: MIT
// Production import UI/host script and queue DnD in Chromium; native paths are a separate check.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), uiRoot = path.join(root, 'plugin/ui');
const output = path.join(root, 'output/playwright/native-music-import-browser-' + Date.now());
const read = name => fs.readFileSync(path.join(uiRoot, name), 'utf8');
const index = read('index.html'), start = index.indexOf('        <div id="native-music-import"');
const fragment = index.slice(start, index.indexOf('\n        <div class="scan-row">', start));
const native = fs.readFileSync(path.join(root, 'crates/hertz-studio/src/window.rs'), 'utf8').match(/const HOST_SCRIPT: &str = r#"([\s\S]*?)"#;/)[1];
const app = read('app.js'), queue = app.slice(app.indexOf('function renderQueue() {'), app.indexOf('\n// 换曲不改队列内容'));
const revealStart=app.indexOf("  window.addEventListener('hertz-native-import-requested'");
const reveal=app.slice(revealStart,app.indexOf("  $('empty-scan-btn')",revealStart));
const checks = [], errors = [];
const mark = text => { checks.push(text); console.log('PASS ' + text); };
let server, browser;
async function main() {
  fs.mkdirSync(output, { recursive: true });
  server = http.createServer((request, response) => {
    if (request.url === '/native-music-import.css') { response.setHeader('Content-Type', 'text/css'); response.end(read('native-music-import.css')); return; }
    const mode = new URL(request.url, 'http://localhost').searchParams.get('mode');
    const script = mode === 'native' ? `<script>
      window.__requests=[]; window.__imports=0;
      window.chrome={webview:{postMessageWithAdditionalObjects:(raw,files)=>__requests.push({message:JSON.parse(raw),names:Array.from(files,f=>f.name)})}};
      window.ipc={postMessage:raw=>{const message=JSON.parse(raw);if(message.kind==='host-ready')setTimeout(()=>window.dispatchEvent(new CustomEvent('hertz-native-host-confirmed',{detail:{documentId:message.documentId}})),0);}};
      window.addEventListener('hertz-native-import-started',()=>__imports++);
    </script><script>${native}</script>` : mode === 'dbx' ? `<script>window.hertzHost={isDbx:true};window.__hertzWindowHost={fileImportVersion:1,importFiles:()=>{throw Error('DBX cannot import')}};</script>` : '';
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/native-music-import.css"><style>
      :root{--bg:#141413;--panel:#1f1f1c;--text:#e9e7de;--muted:#a3a298;--line:#3b3b35;--accent:#b0bca1;--danger:#e4a99c;--radius:12px}
      html[data-theme=light]{--bg:#f3f2ec;--panel:#faf9f4;--text:#262622;--muted:#66675c;--line:#d4d4ca;--accent:#637751;--danger:#9c4137}
      body{font:14px/1.5 Segoe UI,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:24px;box-sizing:border-box}
      .btn{font:inherit;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:10px 14px;cursor:pointer}.btn:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
      .q-row{padding:12px;margin:8px 0;border-bottom:1px solid var(--line);cursor:grab}.q-main{padding:0 12px}.q-sub{padding-left:12px;color:var(--muted)}
      h1{font-size:24px;font-weight:600;margin:0 0 24px}.hint{color:var(--muted)}
      </style>${script}</head><body><h1>音乐收录</h1>${fragment}<p class="hint">持续同步目录与扫描进度沿用现有曲库入口</p>
      <div id="queue-count"></div><span id="queue-badge"></span><div id="queue"></div>
      <script>${read('native-music-import.js')}</script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  page.on('pageerror', error => errors.push(error.message));
  const url = mode => 'http://127.0.0.1:' + server.address().port + '/?mode=' + mode;
  for (const mode of ['browser', 'dbx']) {
    await page.goto(url(mode)); assert.equal(await page.locator('#native-music-import').isVisible(), false);
  }
  mark('browser and DBX hide native import controls');
  await page.goto(url('native'));
  await page.locator('#native-music-import').waitFor({ state: 'visible' });
  await page.addScriptTag({content:`window.__view='queue';window.setView=name=>__view=name;window.refreshScanStatus=()=>{};window.ui={scanPanel:document.getElementById('native-music-import')};${reveal}`});
  await page.evaluate(()=>{ui.scanPanel.hidden=true;});
  await page.evaluate(() => {
    for (const type of ['dragenter','dragover','drop']) {
      const transfer = new DataTransfer(); transfer.setData('text/plain', 'queue-track');
      const event = new DragEvent(type, { bubbles:true,cancelable:true,dataTransfer:transfer }); document.body.dispatchEvent(event);
      if (event.defaultPrevented) throw Error('Internal/text drag was intercepted');
    }
  });
  assert.equal(await page.evaluate(() => __requests.length), 0);
  mark('text and internal drags do not grant file import or get intercepted');
  await page.evaluate(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['test'], '松林.wav'));
    document.body.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  });
  assert.equal(await page.locator('html').evaluate(node=>node.classList.contains('native-music-dragging')), true);
  await page.screenshot({path:path.join(output,'dark-drag.png')});
  await page.evaluate(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['test'], '松林.wav'));
    document.body.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  });
  assert.equal(await page.locator('#native-music-pick').isDisabled(), true);
  assert.equal(await page.evaluate(()=>__view),'library');
  assert.equal(await page.locator('#native-music-import').isVisible(),true);
  assert.deepEqual(await page.evaluate(()=>__requests[0].names), ['松林.wav']);
  await page.evaluate(() => {
    const request = __requests[0].message;
    window.dispatchEvent(new CustomEvent('hertz-native-import-result',{detail:{...request,documentId:crypto.randomUUID(),status:'accepted'}}));
  });
  assert.equal(await page.locator('#native-music-pick').isDisabled(), true);
  await page.evaluate(() => {
    const transfer=new DataTransfer();transfer.items.add(new File(['test'],'repeat.wav'));
    document.body.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  });
  assert.equal(await page.evaluate(()=>__requests.length), 1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('hertz-native-import-result',{detail:{...__requests[0].message,status:'failed',error:'已有扫描正在进行'}})));
  await page.waitForFunction(()=>!document.getElementById('native-music-pick').disabled);
  assert.match(await page.locator('#native-music-note').textContent(), /已有扫描/);
  mark('file drop shows pending; duplicates and wrong-document receipts stay bounded; native errors are inline');
  await page.locator('#native-music-files').setInputFiles({name:'暮色.flac',mimeType:'audio/flac',buffer:Buffer.from('fixture')});
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('hertz-native-import-result',{detail:{...__requests.at(-1).message,status:'accepted'}})));
  await page.waitForFunction(()=>__imports===1);
  assert.equal(await page.locator('#native-music-files').inputValue(), '');
  mark('file picker uses the same object flow and accepted receipts show the existing scan results');
  await page.addScriptTag({content:`
    window.state={queue:['a','b','c'],snapshot:{track_id:null},byId:new Map(['a','b','c'].map(id=>[id,{id,title:'曲目 '+id,artist:'收录测试',duration_ms:12000}]))};
    Object.assign(window.ui,{queueCount:document.getElementById('queue-count'),queueBadge:document.getElementById('queue-badge'),queueList:document.getElementById('queue')});
    window.pushStageQueue=()=>{};window.missingQueueIds=()=>[];window.paintArt=()=>{};window.fmt=()=> '0:12';window.applyQueue=list=>state.queue=list;
    ${queue}
    renderQueue();`});
  await page.locator('.q-row').nth(0).dragTo(page.locator('.q-row').nth(2));
  assert.deepEqual(await page.evaluate(()=>state.queue), ['b','c','a']);
  assert.equal(await page.evaluate(()=>__requests.length), 2);
  mark('actual Chromium pointer dragging preserves production queue reordering');
  await page.locator('.q-row').nth(1).evaluate(row=>{
    const transfer=new DataTransfer();transfer.items.add(new File(['fixture'],'queue-drop.wav'));
    row.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  });
  assert.deepEqual(await page.evaluate(()=>state.queue),['b','c','a']);
  assert.equal(await page.evaluate(()=>__requests.length),3);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('hertz-native-import-result',{detail:{...__requests.at(-1).message,status:'accepted'}})));
  await page.waitForFunction(()=>__imports===2);
  mark('external File drop over a queue row imports once and leaves the queue order intact');
  for (const theme of ['dark','light']) for (const width of [1120,375]) {
    await page.setViewportSize({width,height:760});
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const bounds=await page.locator('#native-music-pick').boundingBox(); assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
    await page.screenshot({path:path.join(output,theme+'-'+width+'.png')});
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('#native-music-import').evaluate(node=>getComputedStyle(node).transitionDuration),'0s');
  mark('dark/light desktop and 375px layouts fit; reduced motion disables movement');
  assert.deepEqual(errors,[]);
}
main().then(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,checks,errors,limitations:['Chromium UI fixture; native filesystem authority and Explorer OLE are separate']},null,2));console.log(output);}).catch(async error=>{console.error(error);await browser?.close();server?.close();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:false,checks,errors,error:error.stack},null,2));process.exitCode=1;});
