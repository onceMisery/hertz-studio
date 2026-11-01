// SPDX-License-Identifier: MIT
// 小窗播放（桌面宠物）原生集成：真实 exe、窄凭据 fixture、宠物态命中穿透、
// 悬停展开、回主窗口与封面注入。鼠标拖拽仅 HERTZ_MINI_TEST_DRAG=1 时运行。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/desktop-mini-native-' + Date.now());
const profileDir = path.join(output, 'profile');
const profile = { kind: 'standalone', dataDir: profileDir.replace(/\\/g, '/'), edition: 'full' };
const session = 'desktop-mini-native';
const key = 'b'.repeat(64);
const secondSession = 'desktop-mini-native-second';
const secondKey = 'c'.repeat(64);
// Generate valid RGBA PNGs locally; handwritten compressed fixtures can hide CRC/decode errors.
function png(width, height) {
  function chunk(type, data) {
    const content = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); content.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    pixels.set([255, 128, 32, 255], offset);
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', require('node:zlib').deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const coverBytes = png(1, 1);
const fixtureTitle = `Mini restore fixture ${process.pid}-${Date.now()} · hertz-studio`;
const snapshot = {
  protocol: 1, seq: 0,
  server: { session, edition: 'full', version: '0.3.0' },
  generation: '1', positionMs: 17000, durationMs: 35000,
  playing: false, buffering: false,
  track: { id: 'fixture-track', title: '原生宠物测试', artist: 'fixture', album: null, durationMs: 35000, coverKey: 'fixture', online: false },
  main: { visible: true, sinceMs: 0, windowTitle: fixtureTitle },
  timing: 'presentation_applied',
};
const secondSnapshot = {
  ...structuredClone(snapshot), playing: true,
  server: { ...snapshot.server, session: secondSession },
  track: { ...snapshot.track, id: 'fixture-track-second', title: '第二来源宠物测试' },
};
const actions = [];
const controlSources = [];
const requests = [];
// 管理管道：v2 命令走这条命名管道（与歌词原生检查同一把钥匙格式）。
const pipePath = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
function pipeCommandOnce(command, value) {
  return new Promise((resolve, reject) => {
    const socket = require('node:net').connect(pipePath);
    let body = '';
    socket.setTimeout(4000);
    socket.on('connect', () => socket.write(JSON.stringify({ command, value })));
    socket.on('data', chunk => { body += chunk; try { const result = JSON.parse(body); socket.destroy(); resolve(result); } catch { } });
    socket.on('error', reject);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('pipe timeout')); });
  });
}
async function pipeCommand(command, value) {
  // The serial named-pipe listener briefly disappears between accepted clients.
  for (let attempt = 0; ; attempt++) {
    try { return await pipeCommandOnce(command, value); }
    catch (error) {
      if (error.code !== 'ENOENT' || attempt >= 19) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}
const server = http.createServer((request, response) => {
  requests.push(request.url.slice(0, 60));
  if (request.url === '/restore-fixture') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<title>${fixtureTitle}</title><p>Owned native restore fixture</p>`); return;
  }
  const sourceSnapshot = request.headers.authorization === 'Desktop ' + key ? snapshot
    : request.headers.authorization === 'Desktop ' + secondKey ? secondSnapshot : null;
  if (!sourceSnapshot) { response.statusCode = 401; response.end('{}'); return; }
  if (request.url.startsWith('/v1/desktop-mini/snapshot')) { sourceSnapshot.seq++; response.end(JSON.stringify(sourceSnapshot)); return; }
  if (request.url.startsWith('/v1/desktop-mini/cover')) { response.setHeader('Content-Type', 'image/png'); response.end(coverBytes); return; }
  if (request.url === '/v1/desktop-mini/control' && request.method === 'POST') {
    let body = ''; request.on('data', chunk => body += chunk); request.on('end', () => {
      const action = JSON.parse(body); actions.push(action);
      controlSources.push({ credentialSession: sourceSnapshot.server.session, payload: action });
      if (action.session !== sourceSnapshot.server.session) { response.statusCode = 409; response.end('{"error":"wrong source session"}'); return; }
      // Native restore runs before HTTP control. A deliberate failure makes the
      // default-browser fallback unreachable even if Windows denies foreground.
      if (action.action === 'restore') { response.statusCode = 503; response.end('{"error":"fixture restore failure"}'); return; }
      if (action.action === 'play' || action.action === 'toggle') sourceSnapshot.playing = true;
      if (action.action === 'pause') sourceSnapshot.playing = false;
      response.end('{"ok":true}');
    }); return;
  }
  response.statusCode = 404; response.end('{}');
});

// Win32 探针：找窗、读帧与 DPI、发 WM_NCHITTEST。命中返回 1=HTCLIENT、-1=HTTRANSPARENT。
const psFrame = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MiniFrame {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c,string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
}
'@
[void][MiniFrame]::SetProcessDpiAwarenessContext([IntPtr](-4))
$hwnd=[MiniFrame]::FindWindow([NullString]::Value,'Hertz 小窗')
if($hwnd -eq [IntPtr]::Zero){throw 'mini window not found'}
$window=New-Object MiniFrame+Rect
[void][MiniFrame]::GetWindowRect($hwnd,[ref]$window)
$dpi=[MiniFrame]::GetDpiForWindow($hwnd)
$visible=[MiniFrame]::IsWindowVisible($hwnd)
function HitTest([int]$x,[int]$y){
  $l=[IntPtr](([long]([Int16]$x) -band 0xFFFF) -bor (([long]([Int16]$y) -shl 16) -band 0xFFFF0000))
  [int][MiniFrame]::SendMessage($hwnd,0x0084,[IntPtr]::Zero,$l)
}
@{window=$window;dpi=$dpi;visible=$visible;
  hitCenter=(HitTest ([int](($window.left+$window.right)/2)) ([int](($window.top+$window.bottom)/2)));
  hitCorner=(HitTest ($window.left+2) ($window.top+2))}|ConvertTo-Json -Compress
`;
// 注入鼠标的拖拽：SendInput 绝对坐标。拖拽线程轮询 GetCursorPos+VK_LBUTTON，
// 注入事件对两者都可见，走的是真实拖拽链路。
const psDragHead = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MiniDrag {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n,INPUT[] inputs,int size);
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public IntPtr extraInfo; }
  public const uint MOVE=0x0001,LEFTDOWN=0x0002,LEFTUP=0x0004,ABSOLUTE=0x8000;
  public static void Mouse(int x,int y,uint flags){
    var input=new INPUT(); input.type=0; input.mi=new MOUSEINPUT{dx=x,dy=y,dwFlags=flags|ABSOLUTE};
    SendInput(1,new INPUT[]{input},Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
[void][MiniDrag]::SetProcessDpiAwarenessContext([IntPtr](-4))
`;
async function frame() {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psFrame], { encoding: 'utf8', windowsHide: true });
  return JSON.parse(stdout.trim().split('\n').pop());
}
async function fixtureWindow() {
  const title64 = Buffer.from(fixtureTitle, 'utf16le').toString('base64');
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FixtureWindow {
  public delegate bool Callback(IntPtr h,IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback f,IntPtr l);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static IntPtr[] Find(string title) {
    var windows=new System.Collections.Generic.List<IntPtr>();
    EnumWindows((h,l)=>{var text=new StringBuilder(1024);var cls=new StringBuilder(256);
      GetWindowText(h,text,1024);GetClassName(h,cls,256);
      if(cls.ToString()=="Chrome_WidgetWin_1" && text.ToString().StartsWith(title)) windows.Add(h);
      return true;},IntPtr.Zero);
    return windows.ToArray();
  }
}
'@
$title=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${title64}'))
$windows=@([FixtureWindow]::Find($title))
if($windows.Count -ne 1){throw 'expected exactly one owned fixture window'}
@{minimized=[FixtureWindow]::IsIconic($windows[0]);foreground=($windows[0] -eq [FixtureWindow]::GetForegroundWindow())}|ConvertTo-Json -Compress
`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return JSON.parse(stdout.trim().split('\n').pop());
}
async function drag(sx, sy, ex, ey, screen) {
  const toAbs = (value, span) => Math.round(value * 65535 / span);
  // 24 步小步移动：页面要越过 4px 阈值并 setPointerCapture，一步跨千里的
  // 注入会让指针在捕获建立前就飞出窗口，拖拽永远开始不了（真实鼠标是连续的）。
  const steps = 24;
  const moves = [];
  for (let index = 1; index <= steps; index += 1) {
    const x = Math.round(sx + ((ex - sx) * index) / steps);
    const y = Math.round(sy + ((ey - sy) * index) / steps);
    moves.push(`[MiniDrag]::Mouse(${toAbs(x, screen.width)},${toAbs(y, screen.height)},1)`);
    moves.push('Start-Sleep -Milliseconds 25');
  }
  const script = psDragHead + `
[MiniDrag]::Mouse(${toAbs(sx, screen.width)},${toAbs(sy, screen.height)},1)
Start-Sleep -Milliseconds 120
[MiniDrag]::Mouse(${toAbs(sx, screen.width)},${toAbs(sy, screen.height)},2)
Start-Sleep -Milliseconds 80
${moves.join('\n')}
[MiniDrag]::Mouse(${toAbs(ex, screen.width)},${toAbs(ey, screen.height)},4)
'OK'`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
}
async function main() {
  assert.equal(require('node:child_process').execSync(
    'powershell.exe -NoProfile -Command "@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count"',
    { encoding: 'utf8', windowsHide: true }).trim(), '0', 'native check requires no running desktop instance');
  fs.mkdirSync(profileDir, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profileDir, 'vmusicd.json'), JSON.stringify({
    pid: process.pid, port: server.address().port, version: '0.3.0', protocol_version: 1,
    edition: 'full', server_instance_id: session,
    desktop_lyrics_protocol: 1, wallpaper_protocol: 1, desktop_mini_protocol: 1,
  }));
  fs.writeFileSync(path.join(profileDir, 'desktop-mini-key'), key);
  const secondProfileDir = path.join(output, 'profile-second');
  fs.mkdirSync(secondProfileDir, { recursive: true });
  for (const filename of ['vmusicd.json', 'desktop-mini-key']) {
    fs.copyFileSync(path.join(profileDir, filename), path.join(secondProfileDir, filename));
  }
  const secondDiscovery = JSON.parse(fs.readFileSync(path.join(secondProfileDir, 'vmusicd.json'), 'utf8'));
  secondDiscovery.server_instance_id = secondSession;
  fs.writeFileSync(path.join(secondProfileDir, 'vmusicd.json'), JSON.stringify(secondDiscovery));
  fs.writeFileSync(path.join(secondProfileDir, 'desktop-mini-key'), secondKey);
  const secondProfile = { ...profile, dataDir: secondProfileDir.replace(/\\/g, '/') };
  // 用户自定义皮肤：pet.json 声明尺寸与 playing 双帧；idle 不声明 →
  // 兜底链应回退到内置默认（验证素材缺失路径）。
  // 素材目录是组件配置根下的 pet/（config::base_dir 随 HERTZ_DESKTOP_CONFIG_DIR）。
  const petDir = path.join(output, 'pet');
  const skinFrame = png(8, 8);
  const skinManifest = {
    name: 'fixture 宠物', size: [64, 48],
    states: { playing: { fps: 2, frames: ['playing-1.png', 'playing-2.png'] } },
  };
  const mini = {
    reopen: true, pet: true, locked: false, alwaysOnTop: true, edgeHide: false,
    autoOnMainHidden: false, scale: 1, opacity: 1,
    geometry: { monitor: null, dock: 'none', along: 0.5, x: 160, y: 160, width: 268, height: 56 },
  };
  // lyrics/wallpaper 域是必填结构（deny_unknown_fields 且无 default 的字段多），
  // fixture 用一份完整的默认域；只把 enabled 关掉，别让歌词/壁纸窗喧宾夺主。
  const lyrics = {
    enabled: false, locked: false, layout: 'single', secondary: 'next', theme: 'auto',
    surface: 'bare', align: 'center', bilingual: false, karaoke: true, readabilityBoost: false,
    fontFamily: 'Segoe UI', fontSize: 30, fontWeight: 600, sungColor: '#ffffff',
    unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 0, opacity: 1,
    width: 550, anchorX: 0.5, anchorY: 0.84, monitor: null,
  };
  const wallpaper = { enabled: false, fps: 30, musicResponse: true, monitor: null, source: 'follow', scene: 'zodiac' };
  fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify({
    schemaVersion: 4, revision: 1, launchAtLogin: false, activeProfile: profile,
    profiles: [{ profile, lyrics, wallpaper, mini }, { profile: secondProfile, lyrics, wallpaper, mini }],
  }));
  const binary = process.env.HERTZ_DESKTOP_BIN || path.join(root, 'target/debug/hertz-desktop.exe');
  // 每次运行一个独立 CDP 端口：残留的旧浏览器进程占住固定端口时，
  // 连上去只会看到上一轮的僵尸页面（踩过：等了 10s 的 pet-art 永远不出现）。
  const cdpPort = 19517 + (process.pid % 800);
  const child = spawn(binary, [], {
    cwd: root, windowsHide: true,
    env: { ...process.env, HERTZ_DESKTOP_CONFIG_DIR: output,
      WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + cdpPort },
    stdio: 'ignore',
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let browser, fixtureBrowser, passed = false, restoreEvidence;
  try {
    for (let i = 0; i < 80; i++) {
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdpPort); break; } catch { }
      if (child.exitCode !== null) throw new Error('host exited ' + child.exitCode);
      await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(browser, 'CDP connected');
    // 小窗页面：含 window.hertzMini 出口的那一个（歌词窗同样连着 CDP）。
    let page;
    for (let i = 0; i < 40 && !page; i++) {
      const pages = browser.contexts().flatMap(context => context.pages());
      for (const candidate of pages) {
        if (!candidate.url().includes('mini-player.html')) continue;
        if (await candidate.evaluate(() => typeof window.hertzMini === 'object' && !!window.hertzMini).catch(() => false)) { page = candidate; break; }
      }
      if (!page) await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(page, 'mini page found over CDP');
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => document.getElementById('pet-art') && document.getElementById('pet-art').naturalWidth > 0, null, { timeout: 10000 });
    const art = await page.evaluate(() => ({
      src: (document.getElementById('pet-art').getAttribute('src') || '').slice(0, 40),
      natural: document.getElementById('pet-art').naturalWidth,
    }));
    // 初始未播放：pet.json 没声明 idle → 兜底链回退内置默认（data-URL SVG）。
    assert.ok(art.src.startsWith('data:image/svg'), 'missing idle falls back to built-in, got ' + art.src);
    await page.waitForFunction(() => Math.abs(innerWidth - 56) < 2, null, { timeout: 6000 });
    // Start with no pet directory, then create it while the native window lives.
    fs.mkdirSync(petDir, { recursive: true });
    fs.writeFileSync(path.join(petDir, 'playing-1.png'), skinFrame);
    fs.writeFileSync(path.join(petDir, 'playing-2.png'), skinFrame);
    fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify(skinManifest));
    await page.waitForFunction(() => Math.abs(innerWidth - 64) < 2, null, { timeout: 6000 });
    // 宠物收起态：窗体 = 皮肤尺寸 × DPI，几何来自配置（160,160），reopen 生效。
    const frame1 = await frame();
    const scale = frame1.dpi / 96;
    assert.equal(frame1.visible, true, 'mini window visible after reopen');
    assert.equal(frame1.window.right - frame1.window.left, Math.round(64 * scale), 'pet collapsed width follows pet.json size');
    assert.equal(frame1.window.bottom - frame1.window.top, Math.round(48 * scale), 'pet collapsed height follows pet.json size');
    // x/y 记的是物理像素，宽高才是逻辑 DIP（mini.rs MiniGeometry 契约）。
    assert.equal(frame1.window.left, 160, 'geometry x restored (physical)');
    assert.equal(frame1.window.top, 160, 'geometry y restored (physical)');
    // 宠物命中穿透：不透明包围盒之外 HTTRANSPARENT（-1），形象本体 HTCLIENT（1）。
    assert.equal(frame1.hitCorner, -1, 'transparent corner passes through');
    assert.equal(frame1.hitCenter, 1, 'pet body is HTCLIENT');
    // 悬停展开：页面 pointerenter → pet-hover → native 窗体变胶囊尺寸。
    await page.evaluate(() => document.getElementById('capsule').dispatchEvent(new PointerEvent('pointerenter', { bubbles: false })));
    await page.waitForFunction(() => innerWidth > 200, null, { timeout: 4000 });
    const frame2 = await frame();
    assert.equal(frame2.window.right - frame2.window.left, Math.round(268 * scale), 'hover expands to capsule width');
    assert.equal(frame2.window.bottom - frame2.window.top, Math.round(56 * scale), 'hover capsule height');
    // 展开态整块 data-hit：中心 HTCLIENT、角落也是 HTCLIENT（胶囊没有透明区）。
    assert.equal(frame2.hitCenter, 1, 'expanded capsule center is HTCLIENT');
    assert.equal(frame2.hitCorner, 1, 'expanded capsule corner is HTCLIENT');
    // 播放状态切换：fixture 翻 playing → 素材切到 playing 帧（引擎兜底链之上的状态映射）。
    const before = await page.evaluate(() => document.getElementById('pet-art').getAttribute('src'));
    snapshot.playing = true;
    await page.waitForFunction(url => document.getElementById('pet-art').getAttribute('src') !== url, before, { timeout: 6000 });
    const playingSrc = await page.evaluate(() => document.getElementById('pet-art').getAttribute('src'));
    assert.ok(playingSrc.startsWith('mini-skin/playing-'), 'playing state uses user skin frames: ' + playingSrc);
    // 封面注入：coverKey 命中后页面收到 mini-cover URL 并真的解码出来。
    await page.waitForFunction(() => {
      const img = document.getElementById('cover-img');
      return img && !img.hidden && img.naturalWidth > 0;
    }, null, { timeout: 8000 });
    const coverUrl = await page.evaluate(() => document.getElementById('cover-img').getAttribute('src'));
    assert.ok(coverUrl.startsWith('mini-cover?v='), 'cover served via custom protocol: ' + coverUrl);
    // Same-name frame replacement must bypass the browser's cached image.
    fs.writeFileSync(path.join(petDir, 'playing-1.png'), png(12, 12));
    fs.writeFileSync(path.join(petDir, 'playing-2.png'), png(12, 12));
    await page.waitForFunction(() => document.getElementById('pet-art').naturalWidth === 12, null, { timeout: 8000 });
    // 收起 + 可选真鼠标拖拽（默认不注入任何全局鼠标事件）。
    await page.evaluate(() => document.getElementById('capsule').dispatchEvent(new PointerEvent('pointerleave', { bubbles: false })));
    await page.waitForFunction(() => innerWidth < 100, null, { timeout: 4000 });
    if (process.env.HERTZ_MINI_TEST_DRAG === '1') {
    await page.waitForTimeout(500);
    const frame3 = await frame();
    const cx = Math.round((frame3.window.left + frame3.window.right) / 2);
    const cy = Math.round((frame3.window.top + frame3.window.bottom) / 2);
    // 物理屏幕尺寸从页面拿：screen(逻辑) × devicePixelRatio，免去 PS 引号嵌套。
    const screen = await page.evaluate(() => ({
      width: screen.width * devicePixelRatio,
      height: screen.height * devicePixelRatio,
    }));
    await drag(cx, cy, screen.width - 8, cy, screen);
    await page.waitForTimeout(900);
    const frame4 = await frame();
    assert.ok(Math.abs(frame4.window.right - screen.width) <= 2, 'dragged to right edge');
    // 拖拽途中光标一直悬在宠物上，悬停展开是真实行为；松手后把光标移开，
    // 宠物应收回皮肤尺寸（仍贴右缘）。
    await drag(screen.width - 40, cy, Math.round(screen.width / 2), Math.round(screen.height / 2), screen);
    await page.waitForFunction(() => innerWidth < 100, null, { timeout: 4000 });
    const frame5 = await frame();
    assert.equal(frame5.window.right - frame5.window.left, Math.round(64 * scale), 'dock keeps pet size after hover leaves');
    assert.equal(frame5.window.bottom - frame5.window.top, Math.round(48 * scale), 'dock keeps pet height');
    assert.ok(Math.abs(frame5.window.right - screen.width) <= 2, 'still docked right');
    const saved = JSON.parse(fs.readFileSync(path.join(output, 'config.json'), 'utf8'));
    assert.equal(saved.profiles[0].mini.geometry.dock, 'right', 'dock persisted on drag end');
    }
    // 素材热重载：覆盖 pet.json（更大的尺寸）→ 宿主 tick 签名变化 → 页面
    // reloadSkin → pet-size 上报 → 窗体自动跟随，全程无需重开窗口。
    fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify({
      name: 'fixture 宠物', size: [88, 72],
      states: { playing: { fps: 2, frames: ['playing-1.png', 'playing-2.png'] } },
    }));
    await page.waitForFunction(width => Math.abs(innerWidth - width) < 2, 88, { timeout: 6000 });
    const hotSrc = await page.evaluate(() => document.getElementById('pet-art').getAttribute('src'));
    assert.ok(hotSrc.startsWith('mini-skin/playing-'), 'hot reload keeps playing frames: ' + hotSrc);
    // Distinct credentials, sessions and tracks expose a stopped old feed thread
    // or controls still routed through the previous profile after switching.
    for (const [nextProfile, expectedSnapshot] of [[secondProfile, secondSnapshot], [profile, snapshot]]) {
      await page.evaluate(() => document.getElementById('capsule').dispatchEvent(new PointerEvent('pointerenter', { bubbles: false })));
      await page.waitForFunction(() => innerWidth > 200, null, { timeout: 4000 });
      await page.waitForTimeout(800); // allow deferred geometry/config writes to settle
      const status = await pipeCommand('status');
      const switched = await pipeCommand('profile-switch', { expectedRevision: status.revision, profile: nextProfile });
      assert.equal(switched.ok, true, 'source switch succeeds: ' + JSON.stringify(switched));
      await page.waitForFunction(() => Math.abs(innerWidth - 88) < 2, null, { timeout: 6000 });
      const sourceFrame = await frame();
      assert.equal(sourceFrame.visible, true, 'mini reopened for switched source');
      assert.equal(sourceFrame.window.right - sourceFrame.window.left, Math.round(88 * scale), 'source switch preserves native pet width and clears hover');
      assert.equal(sourceFrame.window.bottom - sourceFrame.window.top, Math.round(72 * scale), 'source switch preserves native pet height');
      await page.waitForFunction(title => document.getElementById('title').textContent === title, expectedSnapshot.track.title, { timeout: 8000 });
      await page.waitForFunction(() => document.getElementById('pet-art').naturalWidth === 12 && document.getElementById('cover-img').naturalWidth > 0, null, { timeout: 8000 });
      const controlCount = controlSources.length;
      await page.evaluate(() => document.getElementById('play').click());
      for (let attempt = 0; attempt < 80 && controlSources.length === controlCount; attempt++) await page.waitForTimeout(50);
      assert.equal(controlSources.length, controlCount + 1, 'playback control received after source switch');
      const control = controlSources[controlCount];
      assert.equal(control.credentialSession, expectedSnapshot.server.session, 'playback control uses current source credential');
      assert.equal(control.payload.session, expectedSnapshot.server.session, 'playback control carries current source session');
    }
    // Restore an owned real browser window; never target the user's browser.
    // Windows already supplies Edge for WebView2; Playwright uses a fresh
    // temporary browser profile rather than the user's regular Edge session.
    fixtureBrowser = await chromium.launch({ headless: false, channel: process.env.HERTZ_MINI_TEST_BROWSER_CHANNEL || 'msedge' });
    const fixturePage = await fixtureBrowser.newPage();
    await fixturePage.goto(`http://127.0.0.1:${server.address().port}/restore-fixture`);
    const fixtureCdp = await fixturePage.context().newCDPSession(fixturePage);
    const { windowId } = await fixtureCdp.send('Browser.getWindowForTarget');
    await fixtureCdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    assert.equal((await fixtureCdp.send('Browser.getWindowBounds', { windowId })).bounds.windowState, 'minimized', 'owned browser fixture minimized');
    assert.equal((await fixtureWindow()).minimized, true, 'Win32 confirms only owned browser fixture minimized');
    // HTTP503 prevents native fallback opening a default browser, regardless of
    // SetForegroundWindow restrictions. The page reports hidden throughout.
    snapshot.main.visible = false;
    await page.waitForTimeout(2400);
    await page.evaluate(() => document.getElementById('capsule').dispatchEvent(new PointerEvent('pointerenter', { bubbles: false })));
    await page.waitForFunction(() => innerWidth > 200, null, { timeout: 4000 });
    await page.evaluate(() => document.getElementById('title').click());
    await page.waitForTimeout(700);
    assert.equal(actions.some(action => action.action === 'restore'), true, 'restore reaches fixture control');
    const restoredBounds = (await fixtureCdp.send('Browser.getWindowBounds', { windowId })).bounds;
    restoreEvidence = { minimizedBefore: true, windowStateAfter: restoredBounds.windowState, ...await fixtureWindow() };
    // Synthetic page clicks do not grant foreground rights on every Windows
    // desktop. Record Win32 facts separately from the deterministic assertions;
    // CDP's reported normal bounds alone do not prove OS restoration.
    const frame6 = await frame();
    assert.equal(frame6.visible, true, 'failed restore control retains mini window');
    // 管理管道：web 设置页的开关路径。status 应答带 mini 节；mini-toggle 进/出。
    const status1 = await pipeCommand('status');
    assert.equal(status1.ok, true, 'status via pipe ok');
    assert.equal(status1.mini && status1.mini.visible, true, 'status reports mini retained after failed restore');
    assert.equal(status1.mini && status1.mini.supported, true, 'status reports mini supported (standalone)');
    const toggle1 = await pipeCommand('mini-toggle');
    assert.equal(toggle1.ok, true, 'mini-toggle hides the window');
    await page.waitForTimeout(500);
    const status2 = await pipeCommand('status');
    assert.equal(status2.mini && status2.mini.visible, false, 'status reports mini hidden after toggle');
    const toggle2 = await pipeCommand('mini-toggle');
    assert.equal(toggle2.ok, true, 'mini-toggle shows the window');
    await page.waitForTimeout(500);
    const status3 = await pipeCommand('status');
    assert.equal(status3.mini && status3.mini.visible, true, 'status reports mini visible after second toggle');
    // A failed restore followed by hide/show must permit a fresh restore.
    const restoreCount = actions.filter(action => action.action === 'restore').length;
    await fixtureCdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await page.evaluate(() => document.getElementById('title').click());
    for (let attempt = 0; attempt < 40 && actions.filter(action => action.action === 'restore').length === restoreCount; attempt++) {
      await page.waitForTimeout(50);
    }
    assert.equal(actions.filter(action => action.action === 'restore').length, restoreCount + 1, 'restore accepted after failed request and hide/show');
    await page.waitForTimeout(300);
    assert.equal((await frame()).visible, true, 'retry failure also retains mini');
    assert.deepEqual(errors, [], 'no page errors');
    passed = true;
    console.log('Mini/pet native checks passed: reopen, missing pet directory creation, decoded skin/fallback, opaque hit regions, hover, initial cover, same-name asset reload, source switch/back uses distinct feed credentials/sessions and keeps pet size, failed-control retention/retry, management pipe, manifest reload. Owned browser Win32 outcome: restored=' + !restoreEvidence.minimized + ', foreground=' + restoreEvidence.foreground + '. Global mouse drag: ' + (process.env.HERTZ_MINI_TEST_DRAG === '1' ? 'enabled' : 'skipped') + '. Restore success/hide is not asserted because HTTP503 disables browser fallback. Evidence: ' + output);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (browser) await browser.close();
    if (fixtureBrowser) await fixtureBrowser.close();
    await exited;
    server.close();
    fs.writeFileSync(path.join(output, 'cleanup.json'), JSON.stringify({ verificationPassed: passed, pid: child.pid, exitCode: child.exitCode, restoreEvidence }, null, 2));
  }
}
main().catch(e => { console.error(e); server.close(); process.exitCode = 1; });
