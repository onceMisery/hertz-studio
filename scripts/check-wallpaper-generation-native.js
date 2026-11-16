// SPDX-License-Identifier: MIT
// Owned Windows service/desktop fixtures. No live provider or user process changes.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
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
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [];
let child, desktopChild, browser, mainBrowser, officialBrowser, page;
async function until(read, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(100); }
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
  if (standalone) {
    const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
    try { await nativeRequest(pipe, { command: 'status' }); throw new Error('Existing standalone desktop host; leave it untouched.'); }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
    assert.ok(fs.existsSync(desktopBinary));
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
    assert.equal((await api('/v1/health')).backend, 'null');
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
    await page.evaluate(() => {
      window.generationTrace = [];
      document.addEventListener('visibilitychange', () => window.generationTrace.push({ visibility:document.visibilityState }));
      const request = hertzWallpaperSettings.requestManagement;
      hertzWallpaperSettings.requestManagement = async function(command, ...args) {
        const entry = { command }; window.generationTrace.push(entry);
        try { const receipt = await request.call(this, command, ...args); entry.done = true; return receipt; }
        catch (error) { entry.error = error.code; throw error; }
      };
    });
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
    await page.locator('#wallpaper-generation > summary').click();
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
    await page.locator('#generation-brief').fill('柔和夜色，宁静频谱'); await page.locator('#generation-quote').click();
    await page.waitForSelector('#generation-confirm:enabled'); assert.match(await page.locator('#generation-price-text').innerText(), /免费/);
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
    assert.ok(denied.some(text => text.includes('default=7'))); assert.ok(denied.some(text => text.includes('coast') || text.includes('内置场景')));
    assert.ok(denied.some(text => text.includes('免费') && text.includes('90 秒')));
    await page.waitForFunction(() => window.generationConfirmationReceipt?.error?.code === 'generation_cancelled');
    assert.deepEqual(await api('/v1/ai/jobs'), before); pass('real native confirmation defaults to No and refusal creates no task');
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
    await until(async () => /候选已生成/.test(await page.locator('#generation-job').innerText()), 'retained submitted task');
    const status = await nativeStatus(); assert.ok(status.job.jobId); assert.equal(status.submissionPending, false);
    assert.ok(!JSON.stringify(status).includes('bearer')); pass('close during submitted receipt and reopen retains native job');
    let polling = 0;
    await page.exposeFunction('generationPollObserved', () => { polling++; });
    await page.evaluate(() => { const request = hertzWallpaperSettings.requestManagement; hertzWallpaperSettings.requestManagement = function (command, ...args) {
      if (command === 'wallpaper.ai.status' || command === 'wallpaper.ai.generate.job') window.generationPollObserved(); return request.call(this, command, ...args);
    }; });
    await page.locator('#tab-lyrics').click(); await delay(300); const paused = polling; await delay(4500); assert.equal(polling, paused);
    await page.locator('#tab-wallpaper').click(); await until(() => polling > paused, 'polling resumes'); pass('hidden settings tab stops polling and visible tab resumes');
    await page.locator('#wallpaper-generation > summary').click();
    await nativeStatus();
    assert.equal((await native('disconnect')).ok, true);
    assert.equal((await nativeStatus()).connected, false);
    assert.ok((await api('/v1/ai/grants')).grants.every(row => row.delivery_mode !== 'native_session' || row.revoked));
    pass('explicit disconnect revokes native session');
    assert.deepEqual(errors, []); await page.screenshot({ path: path.join(output, 'generation.png'), fullPage: true });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, mode: standalone ? 'standalone' : 'embedded', checks, errors }, null, 2));
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    const diagnostic = page && !page.isClosed() ? await page.evaluate(() => ({ visibility:document.visibilityState, trace:window.generationTrace,
      status:document.querySelector('#generation-status')?.textContent, busy:document.querySelector('#wallpaper-generation')?.getAttribute('aria-busy') })).catch(() => null) : null;
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed:false, mode:standalone?'standalone':'embedded', checks, errors, diagnostic, failure:String(error.message) }, null, 2));
    throw error;
  } finally {
    if (officialBrowser) await officialBrowser.close();if (browser) await browser.close();if(mainBrowser)await mainBrowser.close(); await stopOwned(desktopChild); await stopOwned(child);
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
