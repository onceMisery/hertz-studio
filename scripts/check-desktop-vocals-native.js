// SPDX-License-Identifier: MIT
// Owned Windows/WebView2 A10 journey. Never changes OS DPI/work areas or user processes.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const execFileAsync = require('node:util').promisify(execFile);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { agents, line, doc } = require('./check-desktop-vocals-browser');
const root = path.resolve(__dirname, '..');
const identityRegressionOnly = process.argv.includes('--cleanup-identity-regression');
const closeSmokeOnly = process.argv.includes('--close-smoke');
const output = path.join(root, 'output/playwright/desktop-vocals-' + (identityRegressionOnly ? 'cleanup-regression-' : 'native-') + Date.now());
const profileDir = path.join(output, 'profile'), configPath = path.join(output, 'config.json');
const profile = { dataDir: profileDir, edition: 'full' };
const key = crypto.randomBytes(32).toString('hex');
const pipePath = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const report = { scope: 'Actual owned Windows/WebView2; HTTP fixture; no injected page snapshots or geometry.',
  checks: [], frames: [], resourceSamples: [], cycles: [], unverified: [], output, diagnosticOnly: closeSmokeOnly, passed: false };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const writeJson = (name, value) => fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2));
const mark = text => { report.checks.push(text); console.log('PASS ' + text); };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const p95 = values => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : null;
let child, page, browser, cdp, sourceDocument, spawnError, owned = false, traceStarted = false, screencastStarted = false;
let revoked = false, playing = false, clockAt = Date.now(), basePosition = 2000, generation = 1;
let session = 'native-vocals-' + crypto.randomBytes(8).toString('hex'), seq = 0;
const requests = [], actions = [], errors = [], ownedPidHistory = new Set(), ownedIdentities = new Map(), castFrames = [];
const position = () => Math.min(299000, basePosition + (playing ? Date.now() - clockAt : 0));
function seek(positionMs, play = playing) { basePosition = positionMs; clockAt = Date.now(); playing = play; generation++; }
function discovery(port) {
  fs.writeFileSync(path.join(profileDir, 'vmusicd.json'), JSON.stringify({ pid: process.pid, port, version: 'a10-native-fixture',
    protocol_version: 1, edition: 'full', server_instance_id: session, desktop_lyrics_protocol: 1 }));
}
function publish(document, positionMs = 2000) { sourceDocument = structuredClone(document); seek(positionMs, false); }
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (revoked || request.headers.authorization !== 'Desktop ' + key) { response.writeHead(401); response.end('{}'); return; }
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/v1/desktop-lyrics/snapshot') {
    response.end(JSON.stringify({ protocol: 1, seq: ++seq, server: { session, edition: 'full', version: 'a10-native-fixture' },
      generation: String(generation), positionMs: Math.round(position()), durationMs: 300000, playing, buffering: false,
      track: { id: 'native-vocal-fixture', title: '作者标注原生验证' }, lyrics: { status: 'ready', documentKey: sourceDocument.documentKey },
      vocalSchemaVersions: [1], timing: 'presentation_applied' })); return;
  }
  if (url.pathname === '/v1/desktop-lyrics/document') {
    requests.push({ key: url.searchParams.get('key'), capability: url.searchParams.get('vocalSchemaVersion'), session, at: Date.now() });
    if (url.searchParams.get('vocalSchemaVersion') !== '1') {
      response.writeHead(422); response.end(JSON.stringify({ error: { code: 'desktop_vocals_unsupported', message: '当前桌面歌词组件不支持此歌词，请更新组件' } })); return;
    }
    response.end(JSON.stringify(sourceDocument)); return;
  }
  if (url.pathname === '/v1/desktop-lyrics/control' && request.method === 'POST') {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      const action = JSON.parse(body); actions.push(action);
      if (action.session !== session || action.trackId !== 'native-vocal-fixture') { response.writeHead(409); response.end('{}'); return; }
      if (action.action === 'seek') seek(action.positionMs);
      else seek(position(), action.action === 'play');
      response.end('{"ok":true}');
    }); return;
  }
  response.writeHead(404); response.end('{}');
});
function pipeAttempt(command, value, connect, name, connectBudget, requestBudget) {
  return new Promise((resolve, reject) => {
    const socket = connect(name); let body = '', connected = false, sent = false, settled = false;
    const fail = error => { if (settled) return; settled = true; error.pipeConnected = connected; error.requestSent = sent; socket.destroy(); reject(error); };
    socket.setTimeout(connectBudget);
    socket.on('connect', () => {
      connected = true; socket.setTimeout(requestBudget); sent = true;
      socket.write(JSON.stringify({ command, ...(value === undefined ? {} : { value }) }));
    });
    socket.on('data', chunk => { body += chunk; try { const result = JSON.parse(body); settled = true; socket.destroy(); resolve(result); } catch (_) {} });
    socket.on('error', fail);
    socket.on('end', () => fail(Object.assign(new Error('Desktop pipe closed before a complete reply'), { code: 'ECONNRESET' })));
    socket.on('timeout', () => fail(Object.assign(new Error('Desktop pipe timeout'), { code: 'ETIMEDOUT' })));
  });
}
async function pipe(command, value, options = {}) {
  // Matches management::request_until: only FILE_NOT_FOUND/PIPE_BUSY before
  // connection are retryable. Any connected/send/reply failure is ambiguous.
  const connect = options.connect || (name => net.connect(name)), pause = options.pause || delay;
  const deadline = Date.now() + (options.connectTimeout || 1000), start = Date.now(); let attempts = 0;
  for (;;) {
    attempts++;
    try {
      const reply = await pipeAttempt(command, value, connect, options.name || pipePath,
        Math.max(1, deadline - Date.now()), options.requestTimeout || 2000);
      (report.managementConnections ||= []).push({ command, attempts, elapsedMs: Date.now() - start, completed: true });
      return reply;
    } catch (error) {
      if (!error.pipeConnected && !error.requestSent && ['ENOENT', 'EBUSY'].includes(error.code) && Date.now() < deadline) {
        await pause(Math.min(10, Math.max(1, deadline - Date.now()))); continue;
      }
      (report.managementConnections ||= []).push({ command, attempts, elapsedMs: Date.now() - start,
        completed: false, code: error.code, connected: error.pipeConnected, requestSent: error.requestSent });
      throw error;
    }
  }
}
function pipeOccupied() {
  return new Promise(resolve => {
    const socket = net.connect(pipePath); socket.setTimeout(600);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', error => { socket.destroy(); resolve(!['ENOENT', 'ECONNREFUSED'].includes(error.code)); });
    socket.on('timeout', () => { socket.destroy(); resolve(true); });
  });
}
async function until(read, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child && child.exitCode !== null) throw new Error('Owned host exited before ' + label + ': ' + child.exitCode);
    const value = await read(); if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
async function freePort() {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
const processExitStateScript = `function Get-ProcessExitState([int]$processId){
 $processHandle=$null
 try{$processHandle=[Diagnostics.Process]::GetProcessById($processId);return $processHandle.HasExited}
 catch{if($_.Exception.GetBaseException() -is [ArgumentException]){return $true};return $null}
 finally{if($processHandle){$processHandle.Dispose()}}
}
`;
const probeScript = `param([int]$TargetPid=0,[string]$KnownPids='',[switch]$CollectGpu)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
${processExitStateScript}
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class VocalNativeProbe {
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback c,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder t,int n);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h,uint flags);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr h,ref MonitorInfo m);
 [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr OpenMutex(uint access,bool inherit,string name);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")] static extern bool GetSystemTimes(out FileTime idle,out FileTime kernel,out FileTime user);
 [DllImport("psapi.dll")] static extern bool GetPerformanceInfo(ref PerformanceInfo value,uint size);
 public struct FileTime { public uint low,high; public ulong Value { get { return ((ulong)high<<32)|low; } } }
 [StructLayout(LayoutKind.Sequential)] public struct PerformanceInfo { public uint cb; public UIntPtr commitTotal,commitLimit,commitPeak,physicalTotal,physicalAvailable,systemCache,kernelTotal,kernelPaged,kernelNonpaged,pageSize; public uint handles,processes,threads; }
 public static object Machine() { FileTime idle,kernel,user; if(!GetSystemTimes(out idle,out kernel,out user))throw new System.ComponentModel.Win32Exception();var p=new PerformanceInfo{cb=(uint)Marshal.SizeOf(typeof(PerformanceInfo))};if(!GetPerformanceInfo(ref p,p.cb))throw new System.ComponentModel.Win32Exception();return new { idle100ns=idle.Value,kernel100ns=kernel.Value,user100ns=user.Value,commitBytes=p.commitTotal.ToUInt64()*p.pageSize.ToUInt64(),commitLimitBytes=p.commitLimit.ToUInt64()*p.pageSize.ToUInt64() }; }
 public struct Rect { public int left,top,right,bottom; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct MonitorInfo { public int cbSize; public Rect monitor,work; public uint flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)]public string device; }
 public class WindowInfo { public long handle; public uint pid,dpi; public string title,monitor; public bool visible; public Rect rect,workArea; }
 public static bool SingletonExists() { var h=OpenMutex(0x00100000,false,@"Local\\HertzDesktop.Singleton"); if(h==IntPtr.Zero)return false; CloseHandle(h);return true; }
 public static WindowInfo[] Windows(uint target) { SetProcessDpiAwarenessContext(new IntPtr(-4));var list=new List<WindowInfo>();EnumWindows((h,p)=>{uint pid;GetWindowThreadProcessId(h,out pid);if(pid==target){var t=new StringBuilder(256);GetWindowText(h,t,256);if(t.Length>0){Rect r;GetWindowRect(h,out r);var m=new MonitorInfo{cbSize=Marshal.SizeOf(typeof(MonitorInfo))};GetMonitorInfo(MonitorFromWindow(h,2),ref m);list.Add(new WindowInfo{handle=h.ToInt64(),pid=pid,dpi=GetDpiForWindow(h),title=t.ToString(),visible=IsWindowVisible(h),rect=r,workArea=m.work,monitor=m.device});}}return true;},IntPtr.Zero);return list.ToArray(); }
}
'@
$all=@(Get-CimInstance Win32_Process)
$ids=New-Object 'System.Collections.Generic.HashSet[int]'
if($TargetPid -gt 0){[void]$ids.Add($TargetPid)}
foreach($idText in ($KnownPids -split ',')){if($idText -match '^\\d+$'){[void]$ids.Add([int]$idText)}}
do{$changed=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$changed=$true}}}while($changed)
$processes=@($all|Where-Object{$ids.Contains([int]$_.ProcessId)}|ForEach-Object{@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;name=$_.Name;createdUtc=$_.CreationDate.ToUniversalTime().ToString('o');executable=$_.ExecutablePath;commandLine=$_.CommandLine;kernel100ns=$_.KernelModeTime;user100ns=$_.UserModeTime;workingSetBytes=$_.WorkingSetSize;commitKB=$_.PageFileUsage;osHasExited=(Get-ProcessExitState ([int]$_.ProcessId))}})
$gpu=@();$machineGpu=@();$gpuError=$null
if($CollectGpu){try{$gpuSamples=@((Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop).CounterSamples);$machineGpu=@($gpuSamples|ForEach-Object{@{engine=$_.InstanceName;utilization=$_.CookedValue}});$gpu=@($gpuSamples|Where-Object{$match=[regex]::Match($_.InstanceName,'pid_(\\d+)_');$match.Success -and $ids.Contains([int]$match.Groups[1].Value)}|ForEach-Object{@{engine=$_.InstanceName;utilization=$_.CookedValue}})}catch{$gpuError=$_.Exception.Message}}
$system=$null
if($TargetPid -eq 0){$system=@{cpu=@(Get-CimInstance Win32_Processor|Select-Object Name,NumberOfLogicalProcessors);display=@(Get-CimInstance Win32_VideoController|Select-Object Name,DriverVersion,CurrentRefreshRate);os=(Get-CimInstance Win32_OperatingSystem|Select-Object Caption,Version)}}
@{singleton=[VocalNativeProbe]::SingletonExists();windows=@([VocalNativeProbe]::Windows([uint32]$TargetPid));processes=$processes;gpu=$gpu;machine=[VocalNativeProbe]::Machine();machineGpu=$machineGpu;gpuCollected=[bool]$CollectGpu;gpuError=$gpuError;system=$system}|ConvertTo-Json -Depth 8 -Compress
`;
async function nativeProbe(label) {
  // Geometry and exit checks need process/window identity, not slow system-wide
  // GPU counter enumeration. Keep GPU samples on the actual resource journey.
  const gpuArgs = /single-baseline-|four-slot-stable-|after-100-seeks/.test(label) ? ['-CollectGpu'] : [];
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(output, 'probe.ps1'),
    '-TargetPid', String(child?.pid || 0), '-KnownPids', [...ownedPidHistory].join(','), ...gpuArgs], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const sample = JSON.parse(stdout.trim());
  const candidates = new Map(sample.processes.map(process => [process.pid, process]));
  const same = (a, b) => a && b && a.pid === b.pid && a.createdUtc === b.createdUtc && a.name === b.name
    && String(a.executable).toLowerCase() === String(b.executable).toLowerCase();
  const verified = process => {
    if (process.pid === 6428) return false;
    const old = ownedIdentities.get(process.pid);
    if (old) return same(old, process);
    if (process.pid === child?.pid) return String(process.executable).toLowerCase() === report.binary.path.toLowerCase();
    const parent = candidates.get(process.parent);
    return parent && verified(parent);
  };
  const ignored = sample.processes.filter(process => !verified(process));
  if (ignored.length) report.ignoredProcessIdentities = [...(report.ignoredProcessIdentities || []), ...ignored];
  sample.exitedProcesses = sample.processes.filter(process => verified(process) && process.osHasExited === true);
  sample.processes = sample.processes.filter(process => verified(process) && process.osHasExited !== true);
  for (const process of sample.processes) { ownedPidHistory.add(process.pid); ownedIdentities.set(process.pid, process); }
  sample.label = label; sample.at = Date.now(); report.resourceSamples.push(sample);
  if (child) {
    const window = sample.windows.find(window => window.pid === child.pid && window.title === 'Hertz 桌面歌词');
    if (window) report.frames.push({ label, ...window });
  }
  writeJson('resources', report.resourceSamples); return sample;
}
async function ownedCommand(command, value) {
  assert.ok(owned && child.exitCode === null && child.signalCode === null, 'Only a verified live owned host may receive mutation');
  const current = await pipe('status');
  assert.equal(path.resolve(current.profile?.dataDir || current.activeProfile?.dataDir || '').toLowerCase(), profileDir.toLowerCase(), 'Shared pipe still belongs to the owned isolated profile');
  return command === 'status' ? current : pipe(command, value);
}
const bodyTexts = () => page.locator('.vocal-slot.main > .lyric-text').allTextContents();
async function awaitKey(key) { await page.waitForFunction(key => hertzLyrics.diagnostics().documentKey === key, key); }
async function awaitAnchor() { await page.waitForFunction(value => window.nativeVocalTest?.lastSnapshot?.generation === value, String(generation)); }
async function awaitAnchorPaint() {
  await awaitAnchor();
  await page.waitForFunction(({ generation, key }) => nativeVocalTest.anchors.some(anchor => anchor.generation === generation && anchor.key === key && anchor.accepted),
    { generation: String(generation), key: sourceDocument.documentKey });
}
async function appearance(target, value) {
  await page.evaluate(({ target, value }) => window.ipc.postMessage(JSON.stringify({ cmd: 'appearance', target,
    ...(typeof value === 'number' ? { value } : { text: String(value) }) })), { target, value });
  if (target === 'fontSize') await page.waitForFunction(value => document.getElementById('font-size').value === String(value), value);
  else await page.waitForFunction(({ target, value }) => document.querySelector('[data-toggle="' + target + '"]')?.getAttribute('aria-pressed') === String(value), { target, value });
}
async function clickToolbar(targetPage, selector) {
  // The native overlay shows controls only while the pointer is inside. The
  // shell stays visible through interludes, unlike the hidden lyric viewport.
  await targetPage.mouse.move(-8, -8);
  await targetPage.locator('#shell').hover();
  await targetPage.waitForFunction(selector => {
    const toolbar = document.getElementById('toolbar'), button = document.querySelector(selector);
    if (!button || button.disabled) return false;
    const style = getComputedStyle(toolbar), box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return style.pointerEvents === 'auto' && Number(style.opacity) >= .99 && hit && button.contains(hit);
  }, selector);
  const hit = await targetPage.locator(selector).evaluate(button => {
    const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { id: button.id, target: hit?.id || hit?.tagName, hitTestPassed: !!hit && button.contains(hit),
      width: innerWidth, height: innerHeight, shellEmpty: document.getElementById('shell').classList.contains('is-empty') };
  });
  assert.equal(hit.hitTestPassed, true, selector + ' receives real pointer input after shell hover');
  (report.toolbarInteractions ||= []).push(hit);
  await targetPage.locator(selector).click();
}
async function counters(label) {
  await cdp.send('HeapProfiler.collectGarbage');
  const value = await cdp.send('Memory.getDOMCounters');
  const usage = await cdp.send('Runtime.getHeapUsage');
  const visible = await page.evaluate(() => ({ ...hertzLyrics.diagnostics(), elements: document.querySelectorAll('#stage *').length,
    width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
  const sample = { label, at: Date.now(), ...value, heap: usage, visible }; report.cycles.push(sample); return sample;
}
async function observeCapacity(label) {
  const probe = await nativeProbe(label), window = probe.windows.find(window => window.title === 'Hertz 桌面歌词');
  assert.ok(window);
  const pageGeometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
    h: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vocal-slot-height')),
    panelHeight: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-height')) || 0,
    slots: document.querySelectorAll('.vocal-slot').length, notice: document.getElementById('notice').textContent,
    warning: document.getElementById('vocal-capacity').textContent,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, theme: document.body.dataset.theme }));
  const availableDip = (window.workArea.bottom - window.workArea.top) / (window.dpi / 96);
  const capacity = Math.min(4, Math.max(0, Math.floor((availableDip - pageGeometry.panelHeight - 94 - 24) / pageGeometry.h)));
  assert.equal(pageGeometry.slots, Math.min(sourceDocument.lines.length, capacity));
  if (capacity === 0) assert.equal(pageGeometry.notice, '空间不足，请调整字号或屏幕设置');
  else assert.ok(Math.abs(pageGeometry.height - (118 + capacity * pageGeometry.h + pageGeometry.panelHeight)) <= 2);
  assert.ok(window.rect.top >= window.workArea.top && window.rect.bottom <= window.workArea.bottom);
  const observation = { label, window, pageGeometry, availableDip, capacity };
  (report.capacityObservations ||= []).push(observation); return observation;
}
async function endTrace() {
  if (!traceStarted || !cdp) return;
  const completion = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end'); const { stream } = await completion;
  const file = path.join(output, 'webview-trace.json'), fd = fs.openSync(file, 'w');
  try { let eof = false; while (!eof) { const part = await cdp.send('IO.read', { handle: stream }); fs.writeSync(fd, part.base64Encoded ? Buffer.from(part.data, 'base64') : part.data); eof = part.eof; } }
  finally { fs.closeSync(fd); await cdp.send('IO.close', { handle: stream }); traceStarted = false; }
  report.trace = file;
}
async function startScreencast() {
  fs.mkdirSync(path.join(output, 'screencast'), { recursive: true });
  cdp.on('Page.screencastFrame', async event => {
    try {
      if (castFrames.length < 600) {
        const file = 'screencast/frame-' + String(castFrames.length).padStart(4, '0') + '.jpg';
        fs.writeFileSync(path.join(output, file), Buffer.from(event.data, 'base64'));
        castFrames.push({ file, metadata: event.metadata });
      }
      await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    } catch (error) { report.screencastError ||= error.message; }
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: 900, maxHeight: 1100, everyNthFrame: 2 });
  screencastStarted = true;
}
async function endScreencast() {
  if (!screencastStarted || !cdp) return;
  await cdp.send('Page.stopScreencast'); screencastStarted = false;
  writeJson('screencast-index', castFrames);
  fs.writeFileSync(path.join(output, 'screencast-index.js'), 'window.A10RecordedFrames=' + JSON.stringify(castFrames) + ';');
  fs.writeFileSync(path.join(output, 'screencast-replay.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>原生 WebView2 录制回放</title>
<style>body{margin:20px;background:#24262b;color:#f4f3f1;font:14px system-ui}img{display:block;max-width:100%;height:80vh;object-fit:contain;object-position:top left}button,input{margin:12px 8px 12px 0}input{width:60%}</style>
<p>真实 WebView2 帧录制；原生窗口坐标、工作区和 DPI 见 report.json。播放 / 暂停后可拖动逐帧检查。</p><img id="frame"><button id="play">播放</button><input id="seek" type="range" min="0"><span id="time"></span>
<script src="screencast-index.js"></script><script>const frames=window.A10RecordedFrames,seek=document.getElementById('seek'),img=document.getElementById('frame');let index=0,playing=false,timer=0;seek.max=Math.max(0,frames.length-1);function show(){if(!frames[index])return;img.src=frames[index].file;seek.value=index;document.getElementById('time').textContent=(index+1)+' / '+frames.length;}function step(){if(!playing)return;const wait=index+1<frames.length?Math.max(20,1000*((frames[index+1].metadata.timestamp||0)-(frames[index].metadata.timestamp||0))):0;if(!wait){playing=false;return;}timer=setTimeout(()=>{index++;show();step();},wait);}document.getElementById('play').onclick=()=>{playing=!playing;clearTimeout(timer);if(index===frames.length-1)index=0;show();step();};seek.oninput=()=>{playing=false;clearTimeout(timer);index=Number(seek.value);show();};show();</script></html>`);
  report.screencast = { replay: path.join(output, 'screencast-replay.html'), frames: castFrames.length,
    scope: 'Real CDP WebView viewport frames, including interval/configuration/panel transitions; native Win32 placement is recorded separately.' };
}
const identityReaderScript = `$identities=ConvertFrom-Json -InputObject (Get-Content -LiteralPath $IdentityFile -Raw)
if($null -eq $identities){$identities=@()}elseif($identities -isnot [Array]){$identities=@($identities)}
`;
const cleanupScript = `param([string]$IdentityFile,[int]$RootPid,[switch]$InspectOnly)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
${identityReaderScript}
$byPid=@{};foreach($entry in $identities){$byPid[[int]$entry.pid]=$entry}
if($InspectOnly){$entries=@(foreach($entry in $identities){@{pid=[int]$entry.pid;entryType=$entry.GetType().FullName;pidType=$entry.pid.GetType().FullName;name=$entry.name}});@{count=$identities.Count;entries=$entries;stopCalls=0;powerShellVersion=$PSVersionTable.PSVersion.ToString()}|ConvertTo-Json -Depth 5 -Compress;return}
function Same-Identity($actual,$expected){return $actual -and $expected -and [int]$actual.ProcessId -eq [int]$expected.pid -and $actual.CreationDate.ToUniversalTime().ToString('o') -eq $expected.createdUtc -and $actual.Name -eq $expected.name -and $actual.ExecutablePath -eq $expected.executable}
function Owned-Chain($entry){$seen=New-Object 'System.Collections.Generic.HashSet[int]';while($entry -and $seen.Add([int]$entry.pid)){if([int]$entry.pid -eq 6428){return $false};if([int]$entry.pid -eq $RootPid){return $true};$parent=$byPid[[int]$entry.parent];if(-not $parent){return $false};$actualParent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$parent.pid);if($actualParent -and -not (Same-Identity $actualParent $parent)){return $false};$entry=$parent};return $false}
$results=@();foreach($entry in $identities|Where-Object{[int]$_.pid -ne $RootPid}|Sort-Object pid -Descending){
 $actual=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$entry.pid)
 if(-not $actual){$results+=@{pid=[int]$entry.pid;state='already_gone'};continue}
 if([int]$entry.pid -eq 6428 -or $entry.name -ne 'msedgewebview2.exe' -or -not (Same-Identity $actual $entry) -or -not (Owned-Chain $entry)){$results+=@{pid=[int]$entry.pid;state='identity_rejected'};continue}
 try{$ownedProcess=[Diagnostics.Process]::GetProcessById([int]$entry.pid);$started=$ownedProcess.StartTime.ToUniversalTime();$expected=[DateTime]::Parse($entry.createdUtc).ToUniversalTime();if([Math]::Abs(($started-$expected).TotalMilliseconds) -gt 2 -or $ownedProcess.MainModule.FileName -ne $entry.executable){throw 'Opened process handle identity differs'};$ownedProcess.Kill();$results+=@{pid=[int]$entry.pid;state='stopped_verified_owned_descendant'}}catch{$results+=@{pid=[int]$entry.pid;state='stop_failed';message=$_.Exception.Message}}
}
ConvertTo-Json -InputObject @($results) -Depth 5 -Compress
`;
const releaseProbeScript = `param([string]$IdentityFile)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
${identityReaderScript}
${processExitStateScript}
$all=@(Get-CimInstance Win32_Process);$processes=@();$rejected=@();$exited=@()
foreach($entry in $identities){
 if([int]$entry.pid -eq 6428){continue}
 $current=$all|Where-Object{[int]$_.ProcessId -eq [int]$entry.pid}|Select-Object -First 1
 if(-not $current){continue}
 if($current.CreationDate.ToUniversalTime().ToString('o') -eq $entry.createdUtc -and $current.Name -eq $entry.name -and $current.ExecutablePath -eq $entry.executable){
  $osHasExited=$null;$osExitCode=$null;$osQueryError=$null;$processHandle=$null
  try{$processHandle=[Diagnostics.Process]::GetProcessById([int]$entry.pid);$osHasExited=$processHandle.HasExited;if($osHasExited){$osExitCode=$processHandle.ExitCode}}catch{$osQueryError=$_.Exception.Message}finally{if($processHandle){$processHandle.Dispose()}}
  if($osHasExited -eq $true){$exited+=@{pid=[int]$entry.pid;createdUtc=$entry.createdUtc;osHasExited=$true};continue}
  $processes+=@{pid=[int]$entry.pid;createdUtc=$entry.createdUtc;name=$entry.name;executable=$entry.executable;osHasExited=$osHasExited;osExitCode=$osExitCode;osQueryError=$osQueryError}
 }
 else{$rejected+=@{pid=[int]$entry.pid;state='reused_identity_untouched'}}
}
@{processes=@($processes);rejected=@($rejected);exited=@($exited)}|ConvertTo-Json -Depth 5 -Compress
`;
async function runCleanupHelper(scriptPath, args, timeout = 20000) {
  try {
    const { stdout, stderr } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', scriptPath, ...args],
      { encoding: 'utf8', windowsHide: true, timeout });
    if (stderr.trim()) { report.cleanupHelperStderr = stderr.slice(0, 4000); throw new Error('Cleanup helper wrote stderr: ' + stderr.slice(0, 1000)); }
    return JSON.parse(stdout.trim());
  } catch (error) {
    if (error.stderr) report.cleanupHelperStderr = String(error.stderr).slice(0, 4000);
    throw error;
  }
}
async function runCleanupIdentityRegression() {
  assert.equal(process.platform, 'win32', 'Requires actual Windows PowerShell');
  fs.mkdirSync(output, { recursive: true });
  const helperPath = path.join(output, 'cleanup-identity-reader.ps1'); fs.writeFileSync(helperPath, cleanupScript);
  const fixturePath = process.env.HERTZ_CLEANUP_IDENTITY_FIXTURE;
  const nonempty = fixturePath ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) :
    [{ pid: 2147483001, name: 'hertz-desktop.exe' }, { pid: 2147483002, name: 'msedgewebview2.exe' }];
  assert.ok(Array.isArray(nonempty) && nonempty.length, 'Regression requires a nonempty JSON identity array');
  const evidence = { mode: 'Read-only InspectOnly; no process queries or stops', fixture: fixturePath || 'synthetic', tests: [] };
  for (const [name, input, expected] of [['nonempty', nonempty, nonempty], ['single', nonempty[0], [nonempty[0]]], ['empty', [], []]]) {
    const identityPath = path.join(output, name + '-identities.json'); fs.writeFileSync(identityPath, JSON.stringify(input));
    const result = await runCleanupHelper(helperPath, ['-IdentityFile', identityPath, '-RootPid', '0', '-InspectOnly']);
    assert.match(result.powerShellVersion, /^5\.1\./, 'Regression exercises Windows PowerShell 5.1');
    assert.equal(result.count, expected.length); assert.equal(result.stopCalls, 0);
    assert.ok(Array.isArray(result.entries)); assert.equal(result.entries.length, expected.length);
    assert.deepEqual(result.entries.map(entry => entry.pid), expected.map(entry => entry.pid));
    for (const entry of result.entries) {
      assert.equal(entry.entryType, 'System.Management.Automation.PSCustomObject');
      assert.equal(entry.pidType, 'System.Int32');
    }
    evidence.tests.push({ name, ...result });
  }
  for (const [name, text] of [['malformed-pid', '[{"pid":"invalid-pid","name":"fixture"}]'], ['malformed-json', '[{']]) {
    const identityPath = path.join(output, name + '-identities.json'); fs.writeFileSync(identityPath, text);
    let failure;
    try { await runCleanupHelper(helperPath, ['-IdentityFile', identityPath, '-RootPid', '0', '-InspectOnly']); } catch (error) { failure = error; }
    assert.ok(failure, name + ' must fail'); assert.equal(failure.code, 1);
    assert.ok(String(failure.stderr || '').trim(), name + ' must retain terminating PowerShell stderr');
    evidence.tests.push({ name, exitCode: failure.code, stderr: String(failure.stderr).slice(0, 4000), stopCalls: 0 });
    delete report.cleanupHelperStderr; // This expected error is retained in its regression evidence.
  }
  evidence.passed = true; writeJson('identity-reader-regression', evidence);
  console.log('PowerShell 5.1 read-only identity regression passed: ' + output);
  return evidence;
}
async function awaitNaturalDescendantRelease() {
  writeJson('owned-process-identities', [...ownedIdentities.values()]);
  const scriptPath = path.join(output, 'probe-owned-release.ps1'); fs.writeFileSync(scriptPath, releaseProbeScript);
  // The contract requires verified release, not disappearance from a stale CIM
  // list within eight seconds. Bound natural teardown at 30 seconds, retaining
  // actual elapsed time and OS exit signals; any forced cleanup still fails.
  const diagnosticBudget = closeSmokeOnly ? Number(process.argv.find(arg => arg.startsWith('--diagnostic-release-budget='))?.split('=')[1] || 30000) : 30000;
  assert.ok(Number.isFinite(diagnosticBudget) && diagnosticBudget >= 8000 && diagnosticBudget <= 30000);
  const started = Date.now(), deadline = started + diagnosticBudget; let sample = { processes: [], rejected: [] };
  report.naturalReleasePolls = []; report.naturalReleaseBudgetMs = diagnosticBudget;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try { sample = await runCleanupHelper(scriptPath, ['-IdentityFile', path.join(output, 'owned-process-identities.json')], remaining); }
    catch (error) {
      if (error.killed === true && !String(error.stderr || '').trim() && Date.now() >= deadline) {
        report.naturalReleaseDeadlineTimeout = { elapsedMs: Date.now() - started, signal: error.signal, killed: true };
        break; // Budget exhausted; verified cleanup and the final native probe still run.
      }
      throw error;
    }
    report.naturalReleasePolls.push({ elapsedMs: Date.now() - started, ...sample });
    if (!sample.processes.length) break;
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  report.naturalReleaseFinishedMs = Date.now() - started;
  return sample.processes.map(process => process.pid);
}
async function cleanupVerifiedDescendants() {
  writeJson('owned-process-identities', [...ownedIdentities.values()]);
  fs.writeFileSync(path.join(output, 'cleanup-owned-processes.ps1'), cleanupScript);
  report.verifiedDescendantCleanup = await runCleanupHelper(path.join(output, 'cleanup-owned-processes.ps1'),
    ['-IdentityFile', path.join(output, 'owned-process-identities.json'), '-RootPid', String(child.pid)]);
  return report.verifiedDescendantCleanup.some(entry => entry.state === 'stopped_verified_owned_descendant');
}
async function main() {
  assert.equal(process.platform, 'win32', 'Requires actual Windows/WebView2');
  assert.ok(process.env.HERTZ_DESKTOP_BIN, 'Set HERTZ_DESKTOP_BIN to the exact freshly built candidate');
  const binary = path.resolve(process.env.HERTZ_DESKTOP_BIN); assert.ok(fs.existsSync(binary));
  fs.mkdirSync(profileDir, { recursive: true }); fs.writeFileSync(path.join(output, 'probe.ps1'), probeScript);
  report.binary = { path: binary, sha256: hash(binary) };
  report.sources = ['crates/hertz-desktop/assets/desktop-lyrics.js', 'crates/hertz-desktop/assets/desktop-lyrics.css',
    'crates/hertz-desktop/src/app.rs', 'crates/hertz-desktop/src/config.rs', 'crates/hertz-desktop/src/feed.rs'].map(file => ({ file, sha256: hash(path.join(root, file)) }));
  const existing = await nativeProbe('preflight');
  assert.equal(existing.singleton, false, 'Fixed desktop singleton already exists; leave its owner running');
  assert.equal(await pipeOccupied(), false, 'An existing desktop owner occupies the shared pipe; refuse to launch or mutate it');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); discovery(server.address().port);
  fs.writeFileSync(path.join(profileDir, 'desktop-lyrics-key'), key);
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, revision: 1, launchAtLogin: false, activeProfile: profile,
    profiles: [{ profile, lyrics: { enabled: true, locked: false, layout: 'triple', secondary: 'next', showVocals: true,
      theme: 'dark', surface: 'solid', align: 'left', bilingual: true, karaoke: true, readabilityBoost: false,
      fontFamily: 'Segoe UI', fontSize: 30, fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff',
      outlineColor: '#000000', outlineWidth: 0, opacity: 1, width: 550, anchorX: .5, anchorY: .3, monitor: null },
      wallpaper: { enabled: false, fps: 15, musicResponse: false, monitor: null, source: 'fixed', scene: 'coast',
        brightness: .75, motion: .3, batteryPolicy: 'pause', quality: 'low' } }] }));
  publish(doc('native-intervals', [line(0, { startMs: 0, endMs: 10000, text: '持续主唱A', translation: 'Continuing lead A' }),
    line(1, { startMs: 2000, endMs: 4000, text: '短伴唱B', vocal: { agentIds: ['b'], role: 'backing' } })]), 1999);
  const port = await freePort(), log = fs.openSync(path.join(output, 'host.log'), 'w');
  child = spawn(binary, [], { cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env,
    HERTZ_DESKTOP_CONFIG_DIR: output, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } });
  fs.closeSync(log); child.on('error', error => { spawnError = error; });
  assert.notEqual(child.pid, 6428); report.hostPid = child.pid; report.cdpPort = port;
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1000) })).ok; } catch (_) { return false; } }, 'owned CDP endpoint');
  const windows = await nativeProbe('owned-start');
  assert.ok(windows.windows.some(window => window.pid === child.pid && window.title === 'Hertz 桌面歌词'), 'CDP is paired with the spawned native lyrics window');
  owned = true;
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  page = await until(() => browser.contexts().flatMap(context => context.pages())[0], 'owned lyrics page');
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.hertzLyrics && hertzLyrics.diagnostics().vocalMode);
  cdp = await page.context().newCDPSession(page); report.webview = await cdp.send('Browser.getVersion');
  await page.evaluate(() => {
    const test = window.nativeVocalTest = { frames: [], anchors: [], documents: [], lastSnapshot: null, enabled: true, writes: 0, phase: 'boundaries', phaseAt: performance.now() };
    const frame = window.requestAnimationFrame, set = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) { if (test.enabled && name === '--p') test.writes++; return set.call(this, name, value, priority); };
    window.requestAnimationFrame = callback => frame.call(window, now => {
      const before = performance.now(), writes = test.writes; callback(now);
      if (test.enabled && test.writes > writes) test.frames.push({ phase: test.phase, start: before, durationMs: performance.now() - before, writes: test.writes - writes });
    });
    const snapshot = hertzLyrics.applySnapshot;
    hertzLyrics.applySnapshot = function (value) {
      const before = performance.now(), phase = test.phase; snapshot(value); test.lastSnapshot = value;
      if (!value || !test.enabled) return;
      const executionMs = performance.now() - before;
      frame.call(window, () => frame.call(window, () => {
        if (test.enabled && phase === test.phase) test.anchors.push({ phase, start: before, generation: value.generation, seq: value.seq, executionMs, localToPaintMs: performance.now() - before,
          key: value.lyrics?.documentKey, accepted: hertzLyrics.diagnostics().documentKey === value.lyrics?.documentKey });
      }));
    };
    const applyDocument = hertzLyrics.applyDocument;
    hertzLyrics.applyDocument = function(value) {
      const before = performance.now(), phase = test.phase; applyDocument(value);
      if (!value || !test.enabled) return;
      const executionMs = performance.now() - before, accepted = hertzLyrics.diagnostics().documentKey === value.documentKey;
      frame.call(window, () => frame.call(window, () => {
        if (test.enabled && phase === test.phase) test.documents.push({ phase, start: before, key: value.documentKey, executionMs, localToPaintMs: performance.now() - before,
          accepted: accepted && hertzLyrics.diagnostics().documentKey === value.documentKey });
      }));
    };
    test.reset = phase => { test.phase = phase; test.phaseAt = performance.now(); test.frames = []; test.anchors = []; test.documents = []; };
    test.dispose = () => { test.enabled = false; hertzLyrics.applySnapshot = snapshot; hertzLyrics.applyDocument = applyDocument; window.requestAnimationFrame = frame; CSSStyleDeclaration.prototype.setProperty = set; };
  });
  await startScreencast();
  await awaitKey('native-intervals');
  await page.evaluate(() => { window.continuingBody = document.querySelector('.vocal-slot.main'); });
  const intervalHeight = await page.evaluate(() => innerHeight);
  report.intervalBoundaries = [];
  for (const positionMs of [1999, 2000, 3999, 4000, 10000]) {
    seek(positionMs, false); await awaitAnchorPaint();
    const expected = positionMs < 2000 || positionMs >= 4000 && positionMs < 10000 ? ['持续主唱A'] : positionMs < 4000 ? ['持续主唱A', '短伴唱B'] : [];
    const actual = await bodyTexts(); assert.deepEqual(actual, expected);
    assert.equal(await page.evaluate(() => innerHeight), intervalHeight);
    if (positionMs < 10000) assert.equal(await page.evaluate(() => document.querySelector('.vocal-slot.main') === continuingBody), true);
    report.intervalBoundaries.push({ positionMs, expected, actual });
  }
  const controlsBefore = actions.length;
  await clickToolbar(page, '#previous');
  await until(() => actions.length > controlsBefore && actions.at(-1).action === 'seek', 'owned authenticated phrase seek');
  assert.equal(actions.at(-1).positionMs, 0); assert.equal(actions.at(-1).session, session);
  await awaitAnchorPaint();
  await clickToolbar(page, '#play'); await until(() => playing, 'owned authenticated play'); await awaitAnchorPaint();
  await page.waitForFunction(() => !document.getElementById('play').disabled);
  await clickToolbar(page, '#play'); await until(() => !playing, 'owned authenticated pause'); await awaitAnchorPaint();
  assert.ok(requests.every(request => request.capability === '1')); mark('V01 real negotiated WebView2 intervals preserve long lead and stable document height');
  if (closeSmokeOnly) {
    report.unverified.push('Diagnostic close smoke only; no full capacity/performance qualification. Current filesystem style may differ from the archived diagnostic binary.');
    report.passed = true; return;
  }

  publish(doc('native-five', Array.from({ length: 5 }, (_, index) => line(index, { vocal: { agentIds: ['a'], role: 'lead' } }))));
  await awaitKey('native-five');
  const nativeWindow = (await nativeProbe('four-slot-budget')).windows.find(window => window.title === 'Hertz 桌面歌词');
  const pageGeometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    h: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vocal-slot-height')), slots: document.querySelectorAll('.vocal-slot').length }));
  const availableDip = (nativeWindow.workArea.bottom - nativeWindow.workArea.top) / (nativeWindow.dpi / 96);
  const capacity = Math.min(4, Math.max(0, Math.floor((availableDip - 94 - 24) / pageGeometry.h)));
  assert.equal(pageGeometry.slots, capacity);
  assert.equal(await page.locator('#vocal-capacity').textContent(), [capacity < 4 ? '空间不足' : '', '还有' + (5 - capacity) + '行'].filter(Boolean).join(' · '));
  assert.ok(nativeWindow.rect.top >= nativeWindow.workArea.top && nativeWindow.rect.bottom <= nativeWindow.workArea.bottom);
  report.actualDisplay = { ...nativeWindow, pageGeometry, availableDip, capacity };
  if (capacity !== 4) report.unverified.push('This actual work area cannot demonstrate K=4 at 30 DIP; observed K=' + capacity);
  for (const dpi of [96, 144, 192]) if (dpi !== nativeWindow.dpi) report.unverified.push('Real system DPI ' + dpi + ' unavailable in this run; no browser-scale substitute');
  await page.screenshot({ path: path.join(output, 'five-bodies.png') });
  await appearance('showVocals', false);
  assert.equal(await page.locator('.vocal-slot.main').count(), 1); assert.equal(await page.locator('.vocal-slot.sub').count(), 1);
  assert.equal(await page.locator('#vocal-capacity').isVisible(), false);
  await appearance('bilingual', false); assert.equal(await page.locator('.vocal-slot').count(), 1);
  await appearance('bilingual', true); await appearance('showVocals', true);
  await clickToolbar(page, '#lock');
  await page.waitForFunction(() => document.body.classList.contains('locked'));
  assert.equal((await ownedCommand('status')).locked, true);
  await ownedCommand('locate'); await page.waitForFunction(() => !document.body.classList.contains('locked'));
  report.unverified.push('Physical Explorer tray icon/menu click remains manual; the existing owned locate recovery handler is exercised');
  for (const font of [18, 30, 72]) {
    await appearance('fontSize', font);
    await page.evaluate(() => window.ipc.postMessage(JSON.stringify({ cmd: 'width', value: -2400 })));
    await page.waitForTimeout(400);
    const observation = await observeCapacity('narrow-font-' + font);
    await page.screenshot({ path: path.join(output, 'narrow-font-' + font + '.png') });
    const window = observation.window;
    assert.ok(window.rect.bottom <= window.workArea.bottom && window.rect.top >= window.workArea.top);
  }
  await clickToolbar(page, '#style-open');
  await page.waitForFunction(() => document.body.classList.contains('options-open') && parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-height')) > 0);
  await observeCapacity('large-font-expanded-settings');
  await page.locator('[data-setting="theme"][data-value="light"]').click();
  await page.waitForFunction(() => document.body.dataset.theme === 'light');
  await observeCapacity('light-expanded-settings'); await page.screenshot({ path: path.join(output, 'light-expanded-settings.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await observeCapacity('reduced-motion-expanded-settings');
  assert.equal(reduced.pageGeometry.reducedMotion, true);
  assert.equal(await page.locator('.vocal-slot').first().evaluate(node => getComputedStyle(node).animationName), 'none');
  report.mediaOverride = 'Reduced motion is a CDP media override in real WebView2; OS preference/DPI/work area are unchanged.';
  await page.screenshot({ path: path.join(output, 'reduced-motion-expanded-settings.png') });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('[data-setting="theme"][data-value="dark"]').click();
  await page.waitForFunction(() => document.body.dataset.theme === 'dark');
  await page.locator('#options-done').click();
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-height')) === 0);
  await observeCapacity('large-font-settings-collapsed');
  await appearance('fontSize', 30);
  await page.evaluate(() => window.ipc.postMessage(JSON.stringify({ cmd: 'width', value: 310 })));
  await endScreencast();
  mark('V08 native capacity, body omission, saved showVocals/bilingual, font/width and owned locked recovery');

  const dense = index => line(index, { startMs: 0, endMs: 120000, text: '.'.repeat(64), translation: undefined,
    vocal: { agentIds: [agents[index].id], role: index === 3 ? 'backing' : 'lead' },
    words: Array.from({ length: 64 }, (_, word) => ({ text: '.', startMs: word * 1800, endMs: (word + 1) * 1800 })) });
  publish(doc('native-dense', Array.from({ length: 4 }, (_, index) => dense(index))), 0);
  await awaitKey('native-dense'); await appearance('showVocals', false); seek(0, true); await awaitAnchor();
  await nativeProbe('single-baseline-start'); await delay(10000); await nativeProbe('single-baseline-end');
  seek(0, false); await awaitAnchor(); await appearance('showVocals', true);
  const beforeCycles = await counters('four-slot-warm-baseline');
  assert.ok(beforeCycles.visible.words <= 256 && beforeCycles.visible.elements <= 800);
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing', transferMode: 'ReturnAsStream' }); traceStarted = true;
  seek(0, true); await awaitAnchorPaint(); await page.waitForFunction(() => hertzLyrics.diagnostics().running);
  await page.evaluate(() => nativeVocalTest.reset('steady'));
  const steadyStarted = Date.now();
  await nativeProbe('four-slot-stable-start');
  for (let seconds = 10; seconds <= 60; seconds += 10) {
    await delay(Math.max(0, steadyStarted + seconds * 1000 - Date.now())); await nativeProbe('four-slot-stable-' + seconds);
    console.log('Native A10 steady sweep ' + seconds + '/60 seconds');
  }
  const steadyElapsedSeconds = (Date.now() - steadyStarted) / 1000;
  seek(position(), false); await awaitAnchorPaint();
  const steady = await page.evaluate(() => ({ frames: nativeVocalTest.frames.filter(frame => frame.start <= nativeVocalTest.phaseAt + 60000),
    anchors: nativeVocalTest.anchors.filter(anchor => anchor.accepted && anchor.start <= nativeVocalTest.phaseAt + 60000),
    diagnostics: hertzLyrics.diagnostics(), elements: document.querySelectorAll('#stage *').length }));
  writeJson('steady-sweep', steady);
  report.performance = { steadySeconds: 60, captureElapsedSeconds: steadyElapsedSeconds, measuredFrames: steady.frames.length, jsFrameP95Ms: p95(steady.frames.map(frame => frame.durationMs)),
    localAnchorToPaintP95Ms: p95(steady.anchors.map(anchor => anchor.localToPaintMs)),
    method: 'Timers around actual RAF callbacks that write real word progress; native applySnapshot arrival to double-RAF paint. Transport polling is excluded.' };
  assert.ok(steady.frames.length >= 450, 'A full 60-second sweep produced regular real word updates');
  assert.ok(report.performance.jsFrameP95Ms <= 8); assert.ok(report.performance.localAnchorToPaintP95Ms <= 100);
  await endTrace();
  await page.evaluate(() => nativeVocalTest.reset('controlled-cycles'));
  const expectedUpdates = [], replacementKeys = [];
  for (let index = 0; index < 100; index++) {
    const positionMs = (index * 7919) % 110000;
    if (index % 10 === 9) {
      const replacement = doc('native-cycle-' + index, Array.from({ length: 4 }, (_, row) => dense(row)));
      replacement.lines[0].words[0].text = String(index);
      replacement.lines[0].text = replacement.lines[0].words.map(word => word.text).join('');
      publish(replacement, positionMs); replacementKeys.push(replacement.documentKey);
    } else seek(positionMs, false);
    expectedUpdates.push({ generation: String(generation), key: sourceDocument.documentKey, positionMs });
    await awaitAnchorPaint();
    if (index % 10 === 9) await page.waitForFunction(key => nativeVocalTest.documents.some(document => document.key === key && document.accepted), sourceDocument.documentKey);
    if (index % 10 === 9) {
      await appearance('showVocals', false); await appearance('showVocals', true);
      const observation = await counters('seek-' + (index + 1));
      assert.ok(observation.visible.slots <= 4 && observation.visible.words <= 256 && observation.visible.elements <= 800);
      console.log('Native A10 controlled source seeks/replacements ' + (index + 1) + '/100');
    }
  }
  const afterCycles = await counters('after-100-seeks');
  assert.ok(afterCycles.nodes <= beforeCycles.nodes + 32, 'No retained lyric DOM grows across 100 seek/config cycles');
  assert.ok(afterCycles.jsEventListeners <= beforeCycles.jsEventListeners + 8, 'Listener count remains bounded');
  assert.equal(await page.evaluate(() => hertzLyrics.diagnostics().running), false, 'Paused renderer has no continuous RAF');
  await nativeProbe('after-100-seeks'); await page.screenshot({ path: path.join(output, 'dense-after-seeks.png') });
  const measuredUpdates = await page.evaluate(() => ({ anchors: nativeVocalTest.anchors, documents: nativeVocalTest.documents }));
  const seekSamples = expectedUpdates.map(update => measuredUpdates.anchors.find(anchor => anchor.accepted && anchor.generation === update.generation && anchor.key === update.key));
  const documentSamples = replacementKeys.map(key => measuredUpdates.documents.find(document => document.accepted && document.key === key));
  assert.ok(seekSamples.every(Boolean) && seekSamples.length === 100, 'All 100 fresh source anchors receive a local paint measurement');
  assert.ok(documentSamples.every(Boolean) && documentSamples.length === 10, 'All 10 genuine document arrivals receive a separate measurement');
  report.controlledPerformance = { sourcePositionUpdates: seekSamples.length, documentReplacements: documentSamples.length,
    seekLocalToPaintP95Ms: p95(seekSamples.map(sample => sample.localToPaintMs)),
    documentLocalToPaintP95Ms: p95(documentSamples.map(sample => sample.localToPaintMs)),
    seekExecutionP95Ms: p95(seekSamples.map(sample => sample.executionMs)), documentExecutionP95Ms: p95(documentSamples.map(sample => sample.executionMs)),
    method: 'Separate first accepted fresh generation/key and applyDocument-arrival samples to double-RAF paint; excludes source polling and network transport.' };
  assert.ok(report.controlledPerformance.seekLocalToPaintP95Ms <= 100, 'Fresh seeks satisfy the local 100 ms target');
  assert.ok(report.controlledPerformance.documentLocalToPaintP95Ms <= 100, 'Fresh document arrivals satisfy the local 100 ms target');
  writeJson('seek-anchors', { expectedUpdates, seekSamples, documentSamples, raw: measuredUpdates, performance: report.controlledPerformance });
  mark('V09/V13 60-second actual sweep, separately measured 100 fresh anchors/10 document replacements, bounded DOM/listeners');

  const previousKey = sourceDocument.documentKey;
  session = 'restarted-' + crypto.randomBytes(8).toString('hex'); discovery(server.address().port);
  publish(doc(previousKey, [line(0, { vocal: { agentIds: ['unknown-source-id'], role: 'lead' } })]));
  await page.waitForFunction(() => document.getElementById('notice').textContent === '歌词内容无效，请在播放器中重新导入');
  assert.equal(await page.locator('.vocal-slot').count(), 0); assert.equal(await page.locator('#play').isDisabled(), false);
  const rejectedCount = requests.filter(request => request.key === previousKey && request.session === session).length;
  await delay(1700);
  assert.equal(requests.filter(request => request.key === previousKey && request.session === session).length, rejectedCount, 'Permanent same-key new-session rejection is not downloaded each snapshot');
  const unknown = doc('native-unknown-schema', [line(0)]); unknown.vocalSchemaVersion = 77; publish(unknown);
  await page.waitForFunction(() => document.getElementById('notice').textContent === '当前桌面歌词组件不支持此歌词，请更新组件');
  assert.equal(await page.locator('.word').count(), 0);
  revoked = true; await page.waitForFunction(() => !hertzLyrics.diagnostics().documentKey);
  assert.equal(await page.locator('.vocal-slot').count(), 0);
  revoked = false; publish(doc('native-recovered', [line(0)])); await awaitKey('native-recovered');
  assert.equal(await page.locator('.vocal-slot.main').count(), 1);
  await page.waitForTimeout(500);
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')).profiles.find(value => value.profile.dataDir === profileDir).lyrics;
  assert.equal(saved.showVocals, true); assert.equal(saved.bilingual, true); assert.equal(saved.layout, 'triple');
  assert.deepEqual(errors, []); report.requests = requests; report.actions = actions; report.errors = errors;
  await page.evaluate(() => nativeVocalTest.dispose());
  report.unverified.push('Real K=0/1/2/3 requires genuine current font/panel/work-area conditions; this run records observed capacities only');
  report.unverified.push('Whole-machine increment, minimum DBX host matrix and long-run release qualification remain separate');
  mark('Real same-key/new-session invalid rejection, schema rejection, no permanent refetch, auth clearing/recovery and saved preferences');
  report.passed = true;
}
async function cleanup() {
  let quitRequested = false, forced = false, shutdownPids = [];
  if (owned && child && child.exitCode === null && child.signalCode === null) {
    await endTrace().catch(() => {});
    await endScreencast().catch(() => {});
    await nativeProbe('before-owned-close').catch(error => { report.cleanupProbeError = error.message; });
    if (page) {
      try {
        if (await page.evaluate(() => document.body.classList.contains('locked'))) await ownedCommand('unlock');
      } catch (error) { report.cleanupUnlockError = error.message; }
      // Quit is tied to this verified CDP page and must still be attempted if a
      // read-only pipe check failed. The shared pipe never receives quit.
      try { await page.evaluate(() => { window.nativeVocalTest?.dispose(); window.ipc.postMessage(JSON.stringify({ cmd: 'quit' })); }); quitRequested = true; }
      catch (error) { report.cleanupQuitError = error.message; }
    }
    const deadline = Date.now() + 8000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
    if (child.exitCode === null && child.signalCode === null) {
      const proof = await nativeProbe('before-forced-owned-host');
      assert.ok(proof.processes.some(process => process.pid === child.pid && ownedIdentities.has(process.pid)), 'Force only the still-identical owned child');
      forced = true; child.kill(); await delay(500);
    }
  } else if (child && child.exitCode === null && child.signalCode === null) {
    // Failed singleton/CDP setup never addresses the shared pipe or an unrelated WebView.
    forced = true; child.kill(); await delay(500);
  }
  if (browser) await browser.close().catch(() => {});
  if (owned) {
    try {
      // DevTools was holding the owned WebView connection in the failed run.
      // Check final release after disconnecting it, with full process identity.
      shutdownPids = await awaitNaturalDescendantRelease();
      if (shutdownPids.length) {
        report.unreleasedBeforeVerifiedCleanup = shutdownPids;
        forced = await cleanupVerifiedDescendants() || forced;
        await delay(1000);
      }
      const final = await nativeProbe('after-natural-or-verified-descendant-release'); shutdownPids = final.processes.map(process => process.pid);
    } catch (error) { report.cleanupProbeError = error.message; }
  }
  await new Promise(resolve => server.listening ? server.close(resolve) : resolve());
  report.cleanup = { pid: child?.pid ?? null, ownedVerified: owned, quitRequested, forced, exitCode: child?.exitCode ?? null,
    signal: child?.signalCode ?? null, remainingOwnedPids: shutdownPids, userPid6428Touched: false };
  if (report.passed) {
    assert.ok(!report.cleanupProbeError, 'Final process-release probe completed');
    assert.equal(quitRequested, true); assert.equal(forced, false); assert.equal(child.exitCode, 0);
    assert.deepEqual(shutdownPids, [], 'Owned host and dedicated WebView descendants released after window close');
  }
}
if (require.main === module) {
  if (identityRegressionOnly) runCleanupIdentityRegression().catch(error => { process.exitCode = 1; console.error(error); });
  else main().catch(error => { report.error = error.stack; report.passed = false; process.exitCode = 1; console.error(error); })
    .then(async () => { try { await cleanup(); } catch (error) { report.passed = false; report.cleanupError = error.stack; process.exitCode = 1; console.error(error); }
      if (fs.existsSync(output)) writeJson('report', report);
      if (report.passed) console.log((closeSmokeOnly ? 'Diagnostic native close smoke passed: ' : 'Desktop vocals native journey passed at actual recorded DPI. Remaining matrix items are explicit: ') + output); });
}
module.exports = { probeScript, cleanupScript, releaseProbeScript, pipe, clickToolbar, runCleanupIdentityRegression };
