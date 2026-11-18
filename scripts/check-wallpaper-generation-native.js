// SPDX-License-Identifier: MIT
// Owned Windows service/desktop fixtures. Live calls require an explicit isolated configuration.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { buildZip } = require('./check-wallpaper-media-native');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const nativeRequest = require('./desktop-native-management-client');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.HERTZ_GENERATION_OUTPUT || path.join(root, 'output/playwright/wallpaper-generation-' + Date.now()));
const binary = path.resolve(process.env.HERTZ_BIN || path.join(root, 'target/debug/hertz-studio.exe'));
const desktopBinary = path.resolve(process.env.HERTZ_DESKTOP_BIN || path.join(root, 'target/debug/hertz-desktop.exe'));
const standalone = process.env.HERTZ_GENERATION_STANDALONE === '1';
const ollamaFixture = process.env.HERTZ_GENERATION_OLLAMA_FIXTURE === '1';
const imageFixture = process.env.HERTZ_GENERATION_IMAGE_FIXTURE === '1';
const compositionFixture = process.env.HERTZ_GENERATION_COMPOSITION_FIXTURE === '1';
const externalFixture = process.env.HERTZ_GENERATION_EXTERNAL_FIXTURE === '1';
const compatibleLive = process.env.HERTZ_GENERATION_OPENAI_COMPATIBLE === '1';
const compatible = compatibleLive ? require('./wallpaper-compatible-checks').configuration() : null;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [];
let child, desktopChild, browser, mainBrowser, officialBrowser, page, providerFixture, externalChecks;
async function until(read, label, timeout = 30000, interval = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(interval); }
  throw new Error('Timed out: ' + label);
}
async function freePort() {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
function pass(label) { checks.push(label); console.log('PASS ' + label); }
async function stopOwned(process) {
  if (process && process.exitCode === null) {
    process.kill(); await until(() => process.exitCode !== null || process.signalCode !== null, 'owned process exit', 15000);
  }
}
async function main() {
  assert.equal(process.platform, 'win32'); assert.ok(fs.existsSync(binary));
  if (externalFixture) assert.equal(ollamaFixture || imageFixture || compositionFixture, false, 'External SDK acceptance uses the independent free builtin fixture');
  if (compatibleLive) assert.equal(externalFixture || ollamaFixture || imageFixture, false, 'Live text acceptance uses its own explicit provider');
  fs.mkdirSync(output, { recursive: true });
  const probe = path.join(output, 'consent.ps1');
  fs.writeFileSync(probe, `\uFEFFparam([uint32]$TargetPid,[int]$Button)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class GenerationConsent {
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback c,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h,Callback c,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr h,int id);
 [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 public static string Text(IntPtr h) {var s=new StringBuilder(8192);GetWindowText(h,s,s.Capacity);return s.ToString();}
 public static IntPtr Find(uint target) {IntPtr found=IntPtr.Zero;EnumWindows((h,p)=>{uint pid;GetWindowThreadProcessId(h,out pid);if(pid==target&&Text(h)=="Hertz 壁纸生成"){found=h;return false;}return true;},IntPtr.Zero);return found;}
 public static string[] ReadAndClick(IntPtr h,int button) {var text=new List<string>();EnumChildWindows(h,(c,p)=>{var t=Text(c);if(t.Length>0)text.Add(t);return true;},IntPtr.Zero);text.Add("default="+(SendMessage(h,0x0400,IntPtr.Zero,IntPtr.Zero).ToInt64()&65535));SendMessage(GetDlgItem(h,button),0x00F5,IntPtr.Zero,IntPtr.Zero);return text.ToArray();}
}
'@
$end=[DateTime]::UtcNow.AddSeconds(20)
do {$window=[GenerationConsent]::Find($TargetPid);if($window -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 50}while([DateTime]::UtcNow -lt $end)
if($window -eq [IntPtr]::Zero){throw 'Owned generation consent window missing'}
ConvertTo-Json -Compress -InputObject @([GenerationConsent]::ReadAndClick($window,$Button))
`, 'utf8');
  const data = path.join(output, 'data'), desktop = path.join(output, 'desktop');
  const env = { ...process.env, VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory',
    HERTZ_DESKTOP_CONFIG_DIR: desktop, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0' };
  delete env.HERTZ_SUBAPI_KEY;
  if (standalone) {
    const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
    try { await nativeRequest(pipe, { command: 'status' }); throw new Error('Existing standalone desktop host; leave it untouched.'); }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
    assert.ok(fs.existsSync(desktopBinary));
  }
  if (ollamaFixture) {
    providerFixture = await require('./wallpaper-ollama-fixture')();
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'config.toml'), '[ai]\nprovider = "ollama"\nmodel = "test-local"\norigin = "' + providerFixture.origin + '"\n');
  }
  if (imageFixture) {
    assert.equal(ollamaFixture, false, 'image fixture has an independent provider configuration');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'config.toml'), '[ai.image]\nprovider = "fake"\nmodel = "fixture-image-v1"\n');
  }
  if (compatibleLive) {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'config.toml'), '[ai]\nprovider = "openai-compatible"\norigin = ' + JSON.stringify(compatible.origin) + '\nmodel = ' + JSON.stringify(compatible.model) + '\n');
  }
  child = spawn(binary, [...(standalone ? [] : ['--window']), '--bind', '127.0.0.1', '--port', '0', '--data-dir', data], {
    cwd: root, windowsHide: true, stdio: 'ignore', env,
  });
  try {
    const discovery = await until(() => { assert.equal(child.exitCode, null); try {
      const value = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'), 'utf8')); return value.pid === child.pid && value;
    } catch { return null; } }, 'isolated discovery');
    const base = 'http://127.0.0.1:' + discovery.port;
    async function api(route, method = 'GET', body) {
      const response = await fetch(base + route, { method, headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(40000) });
      const result = await response.json(); assert.equal(response.status, 200, route + ': ' + JSON.stringify(result)); return result;
    }
    const management = (command, payload = {}) => page.evaluate(async ({ command, payload }) => (await hertzWallpaperSettings.requestManagement(command, payload)).result, { command, payload });
    async function chooseFile(command, payload, filePath) {
      const pending = management(command, payload); pending.catch(() => {});
      const ownerPid = standalone ? desktopChild.pid : child.pid;
      const dialog = async (action = 'read', handle, file) => JSON.parse((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/main-window-files-dialog-fixture.ps1'),
        '-OwnerPid', String(ownerPid), '-Action', action, ...(handle ? ['-Handle', String(handle)] : []), ...(file ? ['-SavePath', file] : [])], { windowsHide: true, timeout: 15000, encoding: 'utf8' })).stdout.trim());
      let selected;
      try {
        selected = await until(async () => (await dialog()).find(window => window.visible && window.kind === '#32770' && window.controls.some(control => control.kind === 'Edit')), 'owned native file selection', 20000);
        await dialog('fill', selected.handle, filePath); await dialog('save', selected.handle);
        return await pending;
      } catch (error) { if (selected) await dialog('cancel', selected.handle).catch(() => {}); throw error; }
    }
    async function waitJob(jobId) {
      return until(async () => {
        const job = await management('wallpaper.jobs.get', { jobId });
        if (['failed', 'cancelled'].includes(job.state)) throw new Error(JSON.stringify(job));
        return job.state === 'done' && job;
      }, 'native file job', 60000, 2100);
    }
    async function importFile(file) {
      const selected = await chooseFile('wallpaper.file.pick', {}, file);
      assert.match(selected.fileToken, /^[0-9a-f]{32}$/);
      const accepted = await management('wallpaper.import.begin', { fileToken: selected.fileToken });
      return waitJob(accepted.jobId);
    }
    assert.equal((await api('/v1/health')).backend, 'null');
    if (compatibleLive) await require('./wallpaper-compatible-checks').storeCredential(api, compatible);
    await api('/v1/settings', 'PUT', { ai_generation_consent: true });
    if (standalone) desktopChild = spawn(desktopBinary, ['--settings', '--data-dir', data], { cwd: root, windowsHide: true, stdio: 'ignore', env });
    const readPort=file=>{try{const port=Number(fs.readFileSync(file,'utf8').split('\n')[0]);return port>0&&port<=65535&&port;}catch{return null;}};
    if (!standalone) {
      const mainPort=await until(()=>readPort(path.join(data,'webview/main/EBWebView/DevToolsActivePort')),'owned main CDP');
      mainBrowser=await chromium.connectOverCDP('http://127.0.0.1:'+mainPort);
      const main=await until(()=>mainBrowser.contexts().flatMap(context=>context.pages()).find(page=>page.url().startsWith(base)),'native main page');
      await main.waitForFunction(()=>window.HertzWallpaperSettings && typeof window.HertzWallpaperSettings.open==='function');
      await api('/v1/desktop/wallpaper/launch', 'POST', {});
    }
    const cdpPort=await until(()=>readPort(path.join(desktop,'webview2/EBWebView/DevToolsActivePort')),'owned desktop CDP');
    browser=await chromium.connectOverCDP('http://127.0.0.1:'+cdpPort);
    page = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('/settings.html')), 'native settings');
    page.on('pageerror', error => errors.push(error.message)); await page.waitForSelector('#generation-connect', { state: 'attached' });
    async function observeGenerationPage() { await page.evaluate(() => {
      window.generationTrace = [];
      const apply = hertzWallpaperSettings.applyStatus;
      hertzWallpaperSettings.applyStatus = function (payload) { window.generationMediaPreview = payload.mediaPreview; return apply.call(this, payload); };
      document.addEventListener('visibilitychange', () => window.generationTrace.push({ visibility:document.visibilityState }));
      const request = hertzWallpaperSettings.requestManagement;
      hertzWallpaperSettings.requestManagement = async function(command, ...args) {
        const entry = { command }; window.generationTrace.push(entry);
        try { const receipt = await request.call(this, command, ...args); entry.done = true; return receipt; }
        catch (error) { entry.error = error.code; throw error; }
      };
    }); }
    await observeGenerationPage();
    const native = (command, payload = {}) => page.evaluate(async ({ command, payload }) => {
      try { return await hertzWallpaperSettings.requestManagement('wallpaper.ai.' + command, payload); }
      catch (error) { return error.receipt || { ok: false, error: { code: error.code, message: error.message } }; }
    }, { command, payload });
    const nativeStatus = () => until(async () => {
      const receipt = await native('status');
      if (!receipt.ok && receipt.error?.code === 'ai_busy') return null;
      assert.equal(receipt.ok, true, JSON.stringify(receipt.error));
      return receipt.result;
    }, 'native status snapshot');
    const savedParameters = draftId => page.evaluate(async draftId => {
      const draft = (await hertzWallpaperSettings.requestManagement('wallpaper.draft.get', { draftId })).result;
      return (await hertzWallpaperSettings.requestManagement('wallpaper.draft.parameters', { draftId, draftRevision: draft.draftRevision, limit: 32 })).result.params;
    }, draftId);
    await page.waitForFunction(() => {
      const context = hertzWallpaperSettings.currentAiContext();
      return context.revision != null && !!context.groupId;
    });
    const desktopBefore = await page.evaluate(() => ({
      context: hertzWallpaperSettings.currentAiContext(),
      builtin: hertzWallpaperSettings.currentBuiltin(),
    }));
    await page.locator('#wallpaper-generation > summary').click();
    if (externalFixture) {
      externalChecks = await require('./wallpaper-external-sdk-checks').createExternalChecks({
        root, output, binary, dataDir: data, page, api, native, nativeStatus, management, execute, until, delay, probe,
        ownerPid: standalone ? desktopChild.pid : child.pid, standalone, pass,
      });
      await externalChecks.beforePairing();
      await observeGenerationPage();
    }
    await page.locator('#generation-connect').click();
    const pairing = await until(async () => (await api('/v1/ai/wallpaper/pairings')).pending[0], 'pending pairing');
    assert.equal(pairing.nativePid, standalone ? desktopChild.pid : child.pid);
    officialBrowser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
    const officialContext=await officialBrowser.newContext({viewport:{width:1440,height:1000}});
    await officialContext.addCookies([{name:'vmusic_session',value:discovery.token,url:base,httpOnly:true,sameSite:'Strict'}]);
    const official=await officialContext.newPage();official.on('pageerror',error=>errors.push(error.message));
    await official.goto(base,{waitUntil:'domcontentloaded'});await official.waitForFunction(()=>window.AiGrantSettings && document.querySelector('#ai-wallpaper-pairings'));
    await official.keyboard.press('4');await official.locator('#view-settings').waitFor({state:'visible'});
    await official.locator('.hz-settings-nav [data-category="connection"]').click();
    await official.locator('#ai-wallpaper-pairings > summary').click();
    const consent = new Promise((resolve, reject) => official.once('dialog', async dialog => {
      try {
        assert.equal(dialog.type(), 'confirm');
        assert.match(dialog.message(), /允许此桌面组件使用壁纸生成/);
        await dialog.accept(); resolve();
      } catch (error) { reject(error); }
    }));
    await official.getByRole('button',{name:'允许本次生成连接',exact:true}).click();
    await consent;
    await page.waitForSelector('#generation-brief:enabled');
    pass((standalone ? 'independent pipe' : 'embedded HostHandle') + ' real pairing and restricted generation connection');
    let sourcePackage;
    if (compositionFixture) {
      assert.equal(imageFixture || ollamaFixture, false);
      const png = Buffer.from(await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
        const context = canvas.getContext('2d'); context.fillStyle = '#4b6d73'; context.fillRect(0, 0, 320, 180); return canvas.toDataURL().split(',')[1]; }), 'base64');
      const workId = crypto.randomUUID(), manifest = { formatVersion: 1, workId, version: 1, title: '组合素材 · 署名验收', description: '',
        content: { kind: 'image', asset: 'background' }, assets: [{ id: 'background', kind: 'image', source: 'assets/background.png', variants: [] }],
        files: [{ path: 'assets/background.png', bytes: png.length, sha256: hash(png), mime: 'image/png' }], properties: [],
        permissions: { audioSpectrum: false, pointer: false }, license: { code: 'none', assets: 'CC-BY-4.0', attribution: 'Hertz composition fixture author' } };
      const bytes = buildZip([['manifest.json', Buffer.from(JSON.stringify(manifest))], ['assets/background.png', png]]);
      const file = path.join(output, 'selected-source.hwpkg'); fs.writeFileSync(file, bytes);
      const imported = await importFile(file); assert.equal(imported.packageHash, hash(bytes));
      sourcePackage = { workKey: 'local-' + workId, packageHash: imported.packageHash, pngSha256: hash(png), attribution: manifest.license.attribution };
      await page.locator('#generation-kind-composition').check();
      await page.waitForSelector('[data-generation-asset]');
      await page.locator('[data-generation-asset]').first().check(); await page.locator('#generation-rights').check();
      const unchangedJobs = await api('/v1/ai/jobs'); assert.equal((unchangedJobs.jobs || []).length, 0);
      pass('native file import and explicit licensed material selection do not generate a job');
    }
    if (imageFixture) {
      const beforeChoice = await api('/v1/ai/jobs');
      await page.locator('#generation-kind-image').check();
      await page.locator('#generation-size-1').check();
      await page.waitForFunction(() => !document.querySelector('#generation-image-fields').hidden);
      assert.equal(await page.locator('#generation-scene').isVisible(), false);
      assert.match(await page.locator('#generation-type-info').innerText(), /离线图片测试/);
      assert.deepEqual(await api('/v1/ai/jobs'), beforeChoice, 'choosing type and dimensions cannot submit a job');
      for (const width of [1120, 800, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const controls = await page.locator('#generation-kinds,#generation-sizes,#generation-qualities').evaluateAll(fields => fields.map(field => ({
          legend: field.querySelector('legend')?.textContent,
          clipped: field.scrollWidth > field.clientWidth + 1,
          labels: [...field.querySelectorAll('input')].every(input => input.labels?.length === 1),
        })));
        assert.ok(controls.every(field => field.legend && field.labels && !field.clipped), JSON.stringify(controls));
      }
      await page.setViewportSize({ width: 1120, height: 900 });
      await page.screenshot({ path: path.join(output, 'image-options.png'), fullPage: true });
      pass('image options are labelled, responsive and require explicit quotation');
    }
    await page.locator('#generation-brief').fill(compatibleLive && compositionFixture
      ? '使用选中的图片素材作为唯一图像节点，铺满1920x1080画布，opacity为0.8；夜色安静，不添加文本、模型或动画。'
      : '柔和夜色，宁静频谱'); await page.locator('#generation-quote').click();
    await page.waitForSelector('#generation-confirm:enabled'); assert.match(await page.locator('#generation-price-text').innerText(), compatibleLive ? /费用未知.*token/ : ollamaFixture || imageFixture ? /0 micro-USD/ : /免费/);
    if (imageFixture) assert.match(await page.locator('#generation-price-text').innerText(), /图片张数最多 1.*执行最多 180 秒.*最多 240 秒/);
    if (providerFixture) assert.equal(providerFixture.calls(), 0, 'quotation must not call Ollama');
    const before = await api('/v1/ai/jobs');
    await page.evaluate(() => {
      const request = hertzWallpaperSettings.requestManagement;
      hertzWallpaperSettings.requestManagement = async function (command, ...args) {
        try {
          const result = await request.call(this, command, ...args);
          if (command === 'wallpaper.ai.generate.confirm') window.generationConfirmationReceipt = result;
          return result;
        } catch (error) {
          if (command === 'wallpaper.ai.generate.confirm') window.generationConfirmationReceipt = error.receipt;
          throw error;
        }
      };
    });
    await page.locator('#generation-confirm').click();
    const denied = JSON.parse((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', probe, '-TargetPid', String(standalone ? desktopChild.pid : child.pid), '-Button', '7'], { windowsHide: true, timeout: 25000, encoding: 'utf8' })).stdout.trim());
    assert.ok(denied.some(text => text.includes('default=7'))); assert.ok(denied.some(text => imageFixture ? text.includes('1536') && text.includes('1024') : compositionFixture ? text.includes('组合') : text.includes('coast') || text.includes('内置场景')));
    assert.ok(denied.some(text => text.includes(compatibleLive ? '费用未知' : ollamaFixture || imageFixture ? '0 micro-USD' : '免费') && text.includes(imageFixture ? '240 秒' : '90 秒')));
    await page.waitForFunction(() => window.generationConfirmationReceipt?.error?.code === 'generation_cancelled');
    assert.deepEqual(await api('/v1/ai/jobs'), before); pass('real native confirmation defaults to No and refusal creates no task');
    if (providerFixture) assert.equal(providerFixture.calls(), 0, 'refusal must not call Ollama');
    assert.equal((await nativeStatus()).job,null);
    // Native dialog visibility can invalidate the first quote. Request a new
    // explicit quote before the separately confirmed Yes operation.
    await page.waitForSelector('#generation-quote:enabled');
    await page.locator('#generation-quote').click();
    await page.waitForSelector('#generation-confirm:enabled');
    // Delay only delivery to the page after the native operation has completed.
    await page.evaluate(() => {
      const request = hertzWallpaperSettings.requestManagement;
      hertzWallpaperSettings.requestManagement = async function (command, ...args) {
        const result = await request.call(this, command, ...args);
        if (command === 'wallpaper.ai.generate.confirm') { window.heldGenerationReceipt = true; await new Promise(resolve => { window.releaseGenerationReceipt = resolve; }); }
        return result;
      };
    });
    await page.locator('#generation-confirm').click();
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', probe, '-TargetPid', String(standalone ? desktopChild.pid : child.pid), '-Button', '6'], { windowsHide: true, timeout: 25000, encoding: 'utf8' });
    await page.waitForFunction(() => window.heldGenerationReceipt);
    await page.locator('#wallpaper-generation > summary').click(); await page.evaluate(() => window.releaseGenerationReceipt());
    await page.locator('#wallpaper-generation > summary').click();
    await until(async () => {
      const current = await nativeStatus();
      if (current.job && ['failed', 'cancelled', 'interrupted'].includes(current.job.state))
        throw new Error('Confirmed generation ended: ' + current.job.state + '/' + (current.job.failureCode || 'unknown'));
      return /候选已生成/.test(await page.locator('#generation-job').innerText());
    }, 'retained submitted task', 45000, 2100);
    const status = await nativeStatus(); assert.ok(status.job.jobId); assert.equal(status.submissionPending, false);
    assert.ok(!JSON.stringify(status).includes('bearer')); pass('close during submitted receipt and reopen retains native job');
    await page.locator('#generation-receive').click();
    await until(async () => (await native('candidates')).result?.candidates?.some(item => item.state === 'previewReady'), 'received immutable candidate', 60000, 2100);
    await page.waitForSelector('[data-candidate-preview]');
    const candidates = (await native('candidates')).result.candidates;
    const candidate = candidates.find(item => item.state === 'previewReady'); assert.ok(candidate);
    assert.equal(candidate.kind, compositionFixture ? 'composition' : imageFixture ? 'image' : 'builtin');
    if (imageFixture) {
      assert.equal(candidate.sceneId, null); assert.equal(candidate.artifact.mime, 'image/png');
      assert.ok(candidate.candidateBytes >= candidate.artifact.bytes);
      await page.locator('#generation-candidates figure img').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => {
        const image = document.querySelector('#generation-candidates figure img');
        return image?.complete && image.naturalWidth > 0 && image.src.startsWith('data:image/png;base64,');
      });
      await page.screenshot({ path: path.join(output, 'image-candidate.png'), fullPage: true });
    } else if (!compositionFixture) {
      assert.ok(candidate.sceneId);
      await page.locator('#generation-candidates figure img').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => {
        const image = document.querySelector('#generation-candidates figure img');
        return image?.complete && image.naturalWidth > 0;
      });
    }
    const receivedAgain = await native('receive', { jobId: status.job.jobId }); assert.ok(receivedAgain.result.jobId);
    await until(async () => {
      const result = await page.evaluate(async jobId => (await hertzWallpaperSettings.requestManagement('wallpaper.jobs.get', { jobId })).result, receivedAgain.result.jobId);
      return result.state === 'done';
    }, 'idempotent local receive', 30000, 2100);
    assert.equal((await native('candidates')).result.candidates.filter(item => item.receiptId === candidate.receiptId).length, 1);
    pass('receive and repeated receive retain one artifact identity');
    await page.locator('[data-candidate-preview]').click();
    await page.waitForSelector('#generation-stop-preview', { state: 'visible' });
    await until(async () => /正在预览候选/.test(await page.locator('#generation-status').innerText()), 'candidate preview');
    await until(() => page.evaluate(() => window.generationMediaPreview?.firstFrameReady), 'real candidate first frame');
    if (imageFixture || compositionFixture) {
      const first = await page.evaluate(() => window.generationMediaPreview);
      await delay(1500);
      const settled = await page.evaluate(() => window.generationMediaPreview);
      fs.writeFileSync(path.join(output, compositionFixture ? 'composition-preview.json' : 'image-preview.json'), JSON.stringify({ first, settled }, null, 2));
      assert.equal(settled?.firstFrameReady, true, 'image remains visible after native follow ticks');
      assert.equal(settled.kind, 'media', 'native diagnostics report the actual image content');
      assert.equal(settled.generation, first.generation, 'follow state cannot replace the image candidate');
      assert.equal(settled.runtimeBuiltin, null, 'image candidate keeps the media renderer');
      if (compositionFixture) assert.ok(settled.glAllocation, 'composition uses its original renderer and GL allocation');
      else { assert.ok(settled.mediaAllocation, 'image candidate retains its native media allocation'); assert.equal(settled.glAllocation, null, 'image candidate does not allocate a builtin scene'); }
    }
    await page.locator('#generation-stop-preview').click();
    await page.waitForSelector('#generation-stop-preview', { state: 'hidden' });
    await until(() => page.evaluate(() => !window.generationMediaPreview), 'real preview controller exit'); pass('candidate uses original preview and explicit close');
    const form = page.locator('#generation-candidates form').first();
    const savedTitle = compositionFixture ? 'AI 组合 · 交付验收' : imageFixture ? 'AI 图片 · 交付验收' : 'AI 海岸 · 交付验收';
    await form.locator('input').fill(savedTitle); await form.locator('button[type=submit]').click();
    const saveRetries = [];
    await until(async () => {
      const current = (await native('candidates')).result?.candidates?.find(item => item.receiptId === candidate.receiptId);
      if (current?.state === 'saved') return true;
      if (current?.state === 'saving') {
        const resumed = await native('candidate.save', { receiptId: candidate.receiptId, title: savedTitle });
        saveRetries.push({ state: resumed.result?.state, error: resumed.error });
        if (!resumed.ok && !['budget_busy', 'draft_busy', 'operation_pending'].includes(resumed.error?.code)) throw new Error(JSON.stringify(resumed));
      }
      return false;
    }, 'saved immutable package', 60000, 2100);
    fs.writeFileSync(path.join(output, 'save-retries.json'), JSON.stringify(saveRetries, null, 2));
    const saved = (await native('candidates')).result.candidates.find(item => item.receiptId === candidate.receiptId);
    assert.ok(saved.workKey); assert.match(saved.packageHash, /^[a-f0-9]{64}$/);
    if (imageFixture || compositionFixture) {
      assert.equal(saved.title, savedTitle);
      fs.writeFileSync(path.join(output, 'saved-candidate.json'), JSON.stringify(saved, null, 2));
    }
    if (providerFixture) {
      const params = await savedParameters(saved.savedDraftId);
      assert.equal(params.tod, 0.72);
      assert.equal(params.reduced, true);
      fs.writeFileSync(path.join(output, 'saved-candidate.json'), JSON.stringify(saved, null, 2));
    }
    assert.equal((await native('candidate.save', { receiptId: candidate.receiptId, title: 'repeat' })).result.packageHash, saved.packageHash);
    assert.deepEqual(await page.evaluate(() => ({
      context: hertzWallpaperSettings.currentAiContext(),
      builtin: hertzWallpaperSettings.currentBuiltin(),
    })), desktopBefore);
    assert.equal(await page.evaluate(() => generationTrace.some(entry => entry.command === 'wallpaper.apply')), false);
    pass('generation, preview and saving preserve the desktop settings');
    await page.reload(); await page.waitForSelector('#generation-connect', { state: 'attached' });
    await page.locator('#wallpaper-generation > summary').click();
    await until(async () => (await page.locator('#generation-candidates').innerText()).includes(saved.packageHash.slice(0, 12)), 'saved receipt after reopening native page');
    if (providerFixture) {
      const params = await savedParameters(saved.savedDraftId);
      assert.equal(params.tod, 0.72);
      assert.equal(params.reduced, true);
    }
    pass('explicit save and reopen retain the original real package');
    if (compositionFixture) {
      await page.locator('[data-candidate-edit]').click();
      await page.locator('[data-composition-property="opacity"]').fill('0.6');
      await until(async () => /作品已保存/.test(await page.locator('#work-message').innerText()), 'composition edit saved');
      await page.locator('#work-undo').click();
      await page.locator('#work-save').click();
      await until(async () => /作品已保存/.test(await page.locator('#work-message').innerText()), 'composition undo saved');
      const draft = await management('wallpaper.draft.get', { draftId: saved.savedDraftId });
      assert.equal(draft.contentKind, 'composition'); assert.equal(draft.savedRevision, draft.draftRevision);
      const published = await management('wallpaper.draft.publish', { draftId: draft.draftId, draftRevision: draft.draftRevision });
      const destination = path.join(output, 'composition-export.hwpkg');
      const selected = await chooseFile('wallpaper.export.pick', { packageHash: published.packageHash }, destination);
      const started = await management('wallpaper.export.begin', { packageHash: published.packageHash, outputToken: selected.outputToken }); await waitJob(started.jobId);
      const bytes = fs.readFileSync(destination); assert.equal(hash(bytes), published.packageHash);
      const sourceArchive = path.join(output, 'selected-source.hwpkg');
      assert.equal(hash(fs.readFileSync(sourceArchive)), sourcePackage.packageHash);
      const inspectArchive = [
        'import json,zipfile,hashlib,sys',
        'with zipfile.ZipFile(sys.argv[1]) as z:',
        ' manifest=json.loads(z.read("manifest.json"))',
        ' pointer=manifest["license"]["attribution"]',
        ' prefix="Attribution and asset licenses: "',
        ' assert pointer.startswith(prefix), "Composition attribution must declare its inventory path"',
        ' inventory_path=pointer[len(prefix):]',
        ' assert inventory_path in {entry["path"] for entry in manifest["files"]}, "Inventory must be declared by the manifest"',
        ' files={name:z.read(name) for name in z.namelist() if name!="manifest.json"}',
        ' facts={"manifest":manifest,"files":{name:hashlib.sha256(raw).hexdigest() for name,raw in files.items()},"fileBytes":{name:len(raw) for name,raw in files.items()},"inventoryPath":inventory_path,"inventory":json.loads(files[inventory_path])}',
        'with zipfile.ZipFile(sys.argv[2]) as z:',
        ' facts["sourceManifest"]=json.loads(z.read("manifest.json"))',
        'print(json.dumps(facts))',
      ].join('\n');
      const archiveFacts = JSON.parse((await execute('C:/Users/miracle/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe', ['-c',
        inspectArchive, destination, sourceArchive], { windowsHide: true, timeout: 15000, encoding: 'utf8' })).stdout);
      assert.equal(archiveFacts.manifest.content.kind, 'composition');
      assert.deepEqual(Object.keys(archiveFacts.files).sort(), archiveFacts.manifest.files.map(entry => entry.path).sort());
      for (const entry of archiveFacts.manifest.files) {
        assert.equal(archiveFacts.files[entry.path], entry.sha256, 'exported file retains its exact manifest hash: ' + entry.path);
        assert.equal(archiveFacts.fileBytes[entry.path], entry.bytes, 'exported file retains its exact manifest length: ' + entry.path);
      }
      assert.ok(Object.values(archiveFacts.files).includes(sourcePackage.pngSha256), 'saved package contains the selected original bytes');
      assert.equal(archiveFacts.sourceManifest.license.attribution, sourcePackage.attribution);
      assert.equal(archiveFacts.manifest.license.attribution, 'Attribution and asset licenses: ' + archiveFacts.inventoryPath);
      const inventory = archiveFacts.inventory;
      assert.equal(inventory.kind, 'hertzAttribution'); assert.equal(inventory.formatVersion, 2);
      assert.ok(Array.isArray(inventory.sources)); assert.ok(Array.isArray(inventory.inventories));
      const originals = inventory.sources.filter(source => source.sourcePackageHash === sourcePackage.packageHash);
      assert.ok(originals.length > 0, 'saved inventory retains the selected immutable source package');
      for (const source of originals) {
        assert.equal(source.license, archiveFacts.sourceManifest.license.assets, 'saved inventory preserves the exact original asset license');
        assert.equal(source.attribution, sourcePackage.attribution, 'saved inventory preserves the exact original attribution');
      }
      const byId = new Map();
      for (const item of inventory.inventories) {
        assert.match(item.id, /^[a-f0-9]{64}$/); assert.match(item.rawSha256, /^[a-f0-9]{64}$/); assert.match(item.sourcePackageHash, /^[a-f0-9]{64}$/);
        assert.equal(typeof item.originalPath, 'string'); assert.equal(typeof item.raw, 'string'); assert.ok(Array.isArray(item.references));
        assert.equal(hash(Buffer.from(item.raw, 'utf8')), item.rawSha256, 'inventory preserves its exact raw attribution JSON');
        assert.equal(hash(Buffer.from(JSON.stringify(['hertz-attribution-v2', item.sourcePackageHash, item.originalPath, item.rawSha256]), 'utf8')), item.id, 'inventory identity binds its original package, path and raw bytes');
        assert.equal(byId.has(item.id), false, 'inventory identities must be unique');
        JSON.parse(item.raw); byId.set(item.id, item);
      }
      for (const item of inventory.inventories) for (const reference of item.references) {
        const target = byId.get(reference.id); assert.ok(target, 'inventory retains every closure reference');
        assert.equal(target.originalPath, reference.path); assert.equal(target.sourcePackageHash, item.sourcePackageHash);
      }
      for (const source of inventory.sources) {
        assert.match(source.sourcePackageHash, /^[a-f0-9]{64}$/);
        assert.equal(typeof source.license, 'string'); assert.equal(typeof source.attribution, 'string');
        if (source.priorInventory !== null) assert.ok(byId.has(source.priorInventory), 'source retains its original attribution inventory');
      }
      const imported = await importFile(destination); assert.equal(imported.packageHash, published.packageHash);
      fs.writeFileSync(path.join(output, 'composition-roundtrip.json'), JSON.stringify({ sourcePackage, saved, draft, published, archiveFacts, exportedSha256: hash(bytes), imported }, null, 2));
      pass('composition edits, undo, native export and reimport preserve the real immutable package');
    }
    let polling = 0;
    await page.exposeFunction('generationPollObserved', () => { polling++; });
    await page.evaluate(() => { const request = hertzWallpaperSettings.requestManagement; hertzWallpaperSettings.requestManagement = function (command, ...args) {
      if (command === 'wallpaper.ai.status' || command === 'wallpaper.ai.generate.job') window.generationPollObserved(); return request.call(this, command, ...args);
    }; });
    await page.locator('#tab-lyrics').click(); await delay(300); const paused = polling; await delay(4500); assert.equal(polling, paused);
    await page.locator('#tab-wallpaper').click(); await until(() => polling > paused, 'polling resumes'); pass('hidden settings tab stops polling and visible tab resumes');
    await page.locator('#wallpaper-generation > summary').click();
    await nativeStatus();
    if (externalChecks) await externalChecks.run(saved);
    assert.equal((await native('disconnect')).ok, true);
    assert.equal((await nativeStatus()).connected, false);
    assert.ok((await api('/v1/ai/grants')).grants.every(row => row.delivery_mode !== 'native_session' || row.revoked));
    pass('explicit disconnect revokes native session');
    if (providerFixture) {
      providerFixture.verify();
      pass('local Ollama schema, independent output limit and one confirmed provider request');
    }
    if (compatibleLive) {
      require('./wallpaper-compatible-checks').verifyUsage(data, output, status.job.jobId, compatible, compositionFixture);
      const removed = await api('/v1/ai/provider-credential', 'DELETE');
      assert.equal(removed.configured, false);
      pass('live Responses candidate saved with one token-only usage entry and isolated credential removed');
    }
    assert.deepEqual(errors, []); await page.screenshot({ path: path.join(output, 'generation.png'), fullPage: true });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, mode: standalone ? 'standalone' : 'embedded', provider: compatibleLive ? 'openai-compatible' : compositionFixture ? 'fake-composition' : imageFixture ? 'fake-image' : ollamaFixture ? 'ollama-fixture' : 'fake', checks, errors }, null, 2));
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    const diagnostic = page && !page.isClosed() ? await page.evaluate(() => ({ visibility:document.visibilityState, trace:window.generationTrace,
      status:document.querySelector('#generation-status')?.textContent, busy:document.querySelector('#wallpaper-generation')?.getAttribute('aria-busy'),
      mediaPreview:window.generationMediaPreview })).catch(() => null) : null;
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed:false, mode:standalone?'standalone':'embedded', checks, errors, diagnostic, failure:String(error.message) }, null, 2));
    throw error;
  } finally {
    let externalCleanupError;
    if (externalChecks) { try { await externalChecks.close(); } catch (error) { externalCleanupError = error; } }
    if (officialBrowser) await officialBrowser.close();if (browser) await browser.close();if(mainBrowser)await mainBrowser.close(); await stopOwned(desktopChild); await stopOwned(child);
    if (providerFixture) await providerFixture.close();
    if (externalCleanupError) throw externalCleanupError;
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
