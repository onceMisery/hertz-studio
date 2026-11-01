// SPDX-License-Identifier: MIT
// 小窗播放（桌面宠物）原生集成：真实 exe、窄凭据 fixture、宠物态命中穿透、
// 悬停展开、拖拽吸附、回主窗口与封面注入。真机行为断言，非单测。
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
// 1×1 橙色 PNG（封面 fixture）。
const coverBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mOsZf9/DwAEHwJY6dvMqAAAAABJRU5ErkJggg==', 'base64');
const snapshot = {
  protocol: 1, seq: 0,
  server: { session, edition: 'full', version: '0.3.0' },
  generation: '1', positionMs: 17000, durationMs: 35000,
  playing: false, buffering: false,
  track: { id: 'fixture-track', title: '原生宠物测试', artist: 'fixture', album: null, durationMs: 35000, coverKey: 'fixture', online: false },
  main: { visible: true, sinceMs: 0 },
  timing: 'presentation_applied',
};
const actions = [];
const requests = [];
// 管理管道：v2 命令走这条命名管道（与歌词原生检查同一把钥匙格式）。
const pipePath = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
function pipeCommand(command, value) {
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
const server = http.createServer((request, response) => {
  requests.push(request.url.slice(0, 60));
  if (request.headers.authorization !== 'Desktop ' + key) { response.statusCode = 401; response.end('{}'); return; }
  if (request.url.startsWith('/v1/desktop-mini/snapshot')) { snapshot.seq++; response.end(JSON.stringify(snapshot)); return; }
  if (request.url.startsWith('/v1/desktop-mini/cover')) { response.setHeader('Content-Type', 'image/png'); response.end(coverBytes); return; }
  if (request.url === '/v1/desktop-mini/control' && request.method === 'POST') {
    let body = ''; request.on('data', chunk => body += chunk); request.on('end', () => {
      const action = JSON.parse(body); actions.push(action);
      if (action.action === 'play' || action.action === 'toggle') snapshot.playing = true;
      if (action.action === 'pause') snapshot.playing = false;
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
  // WebView2 的用户数据目录全局共享：上次异常退出留下的孤儿浏览器进程会吞掉
  // 本进程的 CDP 启动参数（新 WebView 直接加入旧浏览器进程）。先清场。
  require('node:child_process').execSync(
    'powershell.exe -NoProfile -Command "Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force"',
    { windowsHide: true });
  for (let i = 0; i < 25; i++) {
    const count = require('node:child_process').execSync(
      'powershell.exe -NoProfile -Command "@(Get-Process msedgewebview2 -ErrorAction SilentlyContinue).Count"',
      { encoding: 'utf8', windowsHide: true }).trim();
    if (count === '0') break;
    await new Promise(r => setTimeout(r, 200));
  }
  fs.mkdirSync(profileDir, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profileDir, 'vmusicd.json'), JSON.stringify({
    pid: process.pid, port: server.address().port, version: '0.3.0', protocol_version: 1,
    edition: 'full', server_instance_id: session,
    desktop_lyrics_protocol: 1, wallpaper_protocol: 1, desktop_mini_protocol: 1,
  }));
  fs.writeFileSync(path.join(profileDir, 'desktop-mini-key'), key);
  // 用户自定义皮肤：pet.json 声明尺寸与 playing 双帧；idle 不声明 →
  // 兜底链应回退到内置默认（验证素材缺失路径）。
  // 素材目录是组件配置根下的 pet/（config::base_dir 随 HERTZ_DESKTOP_CONFIG_DIR）。
  const petDir = path.join(output, 'pet');
  fs.mkdirSync(petDir, { recursive: true });
  const skinFrame = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR42mOsZf9/DwAGYgJY6dvMqAEAtwT/UvDbUaMAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(petDir, 'playing-1.png'), skinFrame);
  fs.writeFileSync(path.join(petDir, 'playing-2.png'), skinFrame);
  fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify({
    name: 'fixture 宠物', size: [64, 48],
    states: { playing: { fps: 2, frames: ['playing-1.png', 'playing-2.png'] } },
  }));
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
    profiles: [{ profile, lyrics, wallpaper, mini }],
  }));
  const binary = process.env.HERTZ_DESKTOP_BIN || path.join(root, 'target/debug/hertz-desktop.exe');
  // 每次运行一个独立 CDP 端口：残留的旧浏览器进程占住固定端口时，
  // 连上去只会看到上一轮的僵尸页面（踩过：等了 10s 的 pet-art 永远不出现）。
  const cdpPort = 19517 + (process.pid % 800);
  const child = spawn(binary, [], {
    cwd: root, windowsHide: true,
    env: { ...process.env, HERTZ_DESKTOP_CONFIG_DIR: output, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + cdpPort },
    stdio: 'ignore',
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let browser, passed = false;
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
    // 收起 + 拖拽到右缘 → 吸附 Docked Right 并落盘（DragEnd 才写配置）。
    await page.evaluate(() => document.getElementById('capsule').dispatchEvent(new PointerEvent('pointerleave', { bubbles: false })));
    await page.waitForFunction(() => innerWidth < 100, null, { timeout: 4000 });
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
    // 素材热重载：覆盖 pet.json（更大的尺寸）→ 宿主 tick 签名变化 → 页面
    // reloadSkin → pet-size 上报 → 窗体自动跟随，全程无需重开窗口。
    fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify({
      name: 'fixture 宠物', size: [88, 72],
      states: { playing: { fps: 2, frames: ['playing-1.png', 'playing-2.png'] } },
    }));
    await page.waitForFunction(width => Math.abs(innerWidth - width) < 2, 88, { timeout: 6000 });
    const hotSrc = await page.evaluate(() => document.getElementById('pet-art').getAttribute('src'));
    assert.ok(hotSrc.startsWith('mini-skin/playing-'), 'hot reload keeps playing frames: ' + hotSrc);
    // 点击形象 → restore → fixture 收到 restore 播控，小窗隐藏。
    await page.evaluate(() => document.getElementById('capsule').dispatchEvent(new PointerEvent('pointerenter', { bubbles: false })));
    await page.waitForFunction(() => innerWidth > 200, null, { timeout: 4000 });
    await page.evaluate(() => document.getElementById('title').click());
    await page.waitForTimeout(700);
    assert.equal(actions.some(action => action.action === 'restore'), true, 'restore reaches fixture control');
    const frame6 = await frame();
    assert.equal(frame6.visible, false, 'mini hides after restore');
    // 管理管道：web 设置页的开关路径。status 应答带 mini 节；mini-toggle 进/出。
    const status1 = await pipeCommand('status');
    assert.equal(status1.ok, true, 'status via pipe ok');
    assert.equal(status1.mini && status1.mini.visible, false, 'status reports mini hidden after restore');
    assert.equal(status1.mini && status1.mini.supported, true, 'status reports mini supported (standalone)');
    const toggle1 = await pipeCommand('mini-toggle');
    assert.equal(toggle1.ok, true, 'mini-toggle shows the window');
    await page.waitForFunction(() => innerWidth > 0, null, { timeout: 4000 });
    const status2 = await pipeCommand('status');
    assert.equal(status2.mini && status2.mini.visible, true, 'status reports mini visible after toggle');
    const toggle2 = await pipeCommand('mini-toggle');
    assert.equal(toggle2.ok, true, 'mini-toggle quits the window');
    await page.waitForTimeout(500);
    const status3 = await pipeCommand('status');
    assert.equal(status3.mini && status3.mini.visible, false, 'status reports mini hidden after second toggle');
    assert.deepEqual(errors, [], 'no page errors');
    passed = true;
    console.log('Mini/pet native checks passed: reopen by config, pet-size window, user skin frames with idle fallback, opaque hit regions, hover expand/collapse, cover via custom protocol, drag dock right with persistence, restore broadcast, management pipe mini-toggle/status, skin hot reload. Evidence: ' + output);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (browser) await browser.close();
    server.close();
    fs.writeFileSync(path.join(output, 'cleanup.json'), JSON.stringify({ verificationPassed: passed, pid: child.pid, exitCode: child.exitCode }, null, 2));
    void exited;
  }
}
main().catch(e => { console.error(e); server.close(); process.exitCode = 1; });
