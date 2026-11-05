// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 隔离原生宿主验证（§5.1）：真实 Windows 注册占用、注入按键与定向消息到解锁定位、
// 退出释放、重启自动注册、启动冲突保留偏好与重试恢复。注入按键走完整系统路径，
// 不冒充物理键盘输入；物理键盘验收仍需实机操作。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile, execFileSync } = require('node:child_process');
const execFileAsync = require('node:util').promisify(execFile);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/recovery-hotkey-native-' + Date.now());
const profileDir = path.join(output, 'profile');
const profile = { dataDir: profileDir, edition: 'full' };
const port = Number(process.env.DESKTOP_CDP_PORT || 19433);
const binary = process.env.HERTZ_DESKTOP_BIN || path.join(root, 'target/debug/hertz-desktop.exe');
fs.mkdirSync(profileDir, { recursive: true });

// v2 旧配置：无 recoveryHotkey 字段，同时覆盖迁移路径与默认空。
const lyrics = {
  enabled: true, locked: true, layout: 'double', secondary: 'next', theme: 'dark', surface: 'glass', align: 'center',
  bilingual: true, karaoke: false, readabilityBoost: false, fontFamily: 'Segoe UI', fontSize: 30, fontWeight: 600,
  sungColor: '#ffffff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 0, opacity: 1, width: 550, anchorX: .5, anchorY: .3, monitor: null,
};
const wallpaper = { enabled: false, fps: 30, musicResponse: true, monitor: null, source: 'fixed', scene: 'coast' };

const PowerShell = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class HK {
  [DllImport("user32.dll", SetLastError=true)] public static extern uint RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit, Size = 40)]
  public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
}
'@
function MakeInput($vk, $keyup) {
  $i = New-Object HK+INPUT
  $i.type = 1
  $ki = New-Object HK+KEYBDINPUT
  $ki.wVk = $vk
  if ($keyup) { $ki.dwFlags = 2 }
  $i.ki = $ki
  $i
}
function Probe($name, $mods, $vk) {
  $token = [HK]::RegisterHotKey([IntPtr]::Zero, 0xBEEF, $mods, $vk)
  $free = $token -ne 0
  if ($free) { [void][HK]::UnregisterHotKey([IntPtr]::Zero, 0xBEEF) }
  @{ name = $name; free = $free } | ConvertTo-Json -Compress
}
function InjectKey($vk) {
  $seq = @((MakeInput 0x11 $false), (MakeInput 0x12 $false), (MakeInput $vk $false), (MakeInput $vk $true), (MakeInput 0x12 $true), (MakeInput 0x11 $true))
  $array = [HK+INPUT[]]::new(6)
  for ($i = 0; $i -lt 6; $i++) { $array[$i] = $seq[$i] }
  $sent = [HK]::SendInput(6, $array, [System.Runtime.InteropServices.Marshal]::SizeOf([type][HK+INPUT]))
  @{ sent = $sent } | ConvertTo-Json -Compress
}
function FireDirected($mods, $vk) {
  # PowerShell 的 $null 会被封送成空串而非 NULL 指针；标题与类名相同，用精确匹配。
  $hwnd = [HK]::FindWindow('HertzDesktopHotkey', 'HertzDesktopHotkey')
  if ($hwnd -eq [IntPtr]::Zero) { throw 'hotkey window not found' }
  $fired = $false
  foreach ($id in 0x4851, 0x4852) {
    # WM_HOTKEY=0x0312；lparam 低 16 位修饰键、高 16 位主键。未知 id 由宿主自行忽略。
    $fired = $fired -or [HK]::PostMessage($hwnd, 0x0312, [IntPtr]$id, [IntPtr](($mods -bor ($vk -shl 16))))
  }
  @{ fired = $fired } | ConvertTo-Json -Compress
}
`;
async function powershell(script) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PowerShell + '\n' + script], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}
const VK = { L: 0x4C };
const MOD = { CTRL: 2, ALT: 1 };

const pipePath = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
function command(command, value) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    let body = '';
    socket.setTimeout(4000);
    socket.on('connect', () => socket.write(JSON.stringify({ command, value })));
    socket.on('data', chunk => { body += chunk; try { const result = JSON.parse(body); socket.destroy(); resolve(result); } catch { } });
    socket.on('error', reject);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('pipe timeout')); });
  });
}

function savedHotkey() {
  const value = JSON.parse(fs.readFileSync(path.join(output, 'config.json'), 'utf8'));
  fs.appendFileSync(path.join(output, 'config-observations.jsonl'), JSON.stringify({ at: new Date().toISOString(), revision: value.revision, recoveryHotkey: value.recoveryHotkey ?? null }) + '\n');
  return value.recoveryHotkey ?? null;
}

async function waitFor(fn, timeout, label) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeout) {
    try {
      const result = await fn();
      if (result) return result;
      last = 'condition false';
    } catch (error) { last = error.message || String(error); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(label + ' timeout: ' + last);
}

async function startHost(extraArgs = []) {
  const child = spawn(binary, extraArgs, { cwd: root, windowsHide: true, env: { ...process.env, HERTZ_DESKTOP_CONFIG_DIR: output, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port }, stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let browser = null;
  for (let i = 0; i < 75; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; } catch { }
    if (child.exitCode !== null) throw new Error('Host exited ' + child.exitCode);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(browser, 'CDP connection established');
  const settings = await waitFor(async () => {
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      if (await page.evaluate(() => !!document.getElementById('hotkey-edit')).catch(() => false)) return page;
    }
    return null;
  }, 45000, 'settings page');
  // connectOverCDP 的外部上下文默认无超时；不设上限会把失败拖成永久挂起。
  settings.setDefaultTimeout(20000);
  await waitFor(() => settings.evaluate(() => document.getElementById('hotkey-edit').disabled === false), 45000, 'settings ready');
  // 快捷键入口在“运行设置”页签里，先切过去。
  await settings.click('#tab-runtime');
  await waitFor(() => settings.evaluate(() => document.getElementById('hotkey-capture') !== null && !document.getElementById('panel-runtime').hidden), 10000, 'runtime tab');
  return { child, exited, browser, settings };
}

async function quitHost(session) {
  for (const page of session.browser.contexts().flatMap(context => context.pages())) {
    if (page === session.settings) continue;
    if (await page.evaluate(() => !!window.hertzLyrics).catch(() => false)) {
      await page.evaluate(() => window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }))).catch(() => { });
      break;
    }
  }
  const timer = setTimeout(() => session.child.kill(), 8000);
  const code = await session.exited;
  clearTimeout(timer);
  await session.browser.close().catch(() => { });
  return code;
}

// 设置页录入：进入录入态后按键并保存。
async function captureAndSave(page, keys, comboLabel) {
  await page.click('#hotkey-edit');
  await page.waitForFunction(() => document.getElementById('hotkey-capture').hidden === false);
  for (const step of keys) {
    if (step.down) { await page.keyboard.down(step.down); continue; }
    if (step.up) { await page.keyboard.up(step.up); continue; }
    await page.keyboard.press(step.press);
  }
  await page.waitForFunction(label => document.getElementById('hotkey-record').textContent === '已选择 ' + label, comboLabel);
  await page.click('#hotkey-save');
  await page.waitForFunction(() => document.getElementById('hotkey-capture').hidden === true);
}

async function main() {
  assert.equal(execFileSync('powershell.exe', ['-NoProfile', '-Command', '@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', windowsHide: true }).trim(), '0', 'Native checks require no existing desktop instance');
  fs.writeFileSync(path.join(profileDir, 'vmusicd.json'), JSON.stringify({ pid: process.pid, port: 0, version: '0.3.0', protocol_version: 1, edition: 'full', server_instance_id: 'recovery-hotkey-native', desktop_lyrics_protocol: 1 }));
  fs.writeFileSync(path.join(profileDir, 'desktop-lyrics-key'), 'a'.repeat(64));
  fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify({ schemaVersion: 2, revision: 1, launchAtLogin: false, activeProfile: profile, profiles: [{ profile, lyrics, wallpaper }] }));
  const evidence = [];
  const probe = combo => powershell(`Probe '${combo}' (${MOD.CTRL} -bor ${MOD.ALT}) ${VK.L}`);

  console.log('[stage] 1: set + occupancy + injected keystroke + directed message');
  // ---- 第一段：默认空 → 录入 → 真实占用 → 注入按键与定向消息到解锁定位 ----
  let session = await startHost(['--settings']);
  {
    const page = session.settings;
    assert.equal(await page.locator('#hotkey-saved').textContent(), '未设置', 'startup default empty');
    await captureAndSave(page, [{ down: 'Control' }, { down: 'Alt' }, { press: 'KeyL' }, { up: 'Alt' }, { up: 'Control' }], 'Ctrl+Alt+L');
    await waitFor(async () => (await page.locator('#hotkey-actual').textContent()).includes('当前生效：Ctrl+Alt+L'), 8000, 'registered status');
    assert.equal(savedHotkey(), 'Ctrl+Alt+L', 'preference persisted');
    assert.equal((await probe('Ctrl+Alt+L')).free, false, 'Windows actually holds Ctrl+Alt+L for the host');
    evidence.push({ stage: 'set', occupied: true });

    // 注入按键走完整系统路径：OS 检测 → WM_HOTKEY → 解锁并定位。起点为锁定态。
    assert.equal((await command('status')).locked, true, 'lyrics locked before hotkey');
    const injected = await powershell(`InjectKey ${VK.L}`);
    assert.equal(injected.sent, 6, 'SendInput delivered all 6 events');
    await waitFor(async () => (await command('status')).locked === false, 8000, 'injected keystroke unlocks and locates');
    evidence.push({ stage: 'injected-keystroke', ok: true, note: 'injected input; physical keyboard acceptance stays a manual check' });

    // 定向消息路径（非物理输入证据，单独标注）。
    await command('lock');
    await waitFor(async () => (await command('status')).locked === true, 8000, 'relocked');
    await powershell(`FireDirected (${MOD.CTRL} -bor ${MOD.ALT}) ${VK.L}`);
    await waitFor(async () => (await command('status')).locked === false, 8000, 'directed WM_HOTKEY unlocks');
    evidence.push({ stage: 'directed-message', ok: true, note: 'directed PostMessage; not a physical keystroke claim' });
  }
  assert.equal(await quitHost(session), 0, 'clean quit');
  assert.equal((await probe('Ctrl+Alt+L')).free, true, 'quit releases the registration');

  console.log('[stage] 2: restart auto-register');
  // ---- 第二段：重启自动注册（持久化） ----
  session = await startHost(['--settings']);
  {
    const page = session.settings;
    assert.equal(await page.locator('#hotkey-saved').textContent(), 'Ctrl+Alt+L', 'preference survives restart');
    await waitFor(async () => (await page.locator('#hotkey-actual').textContent()).includes('当前生效：Ctrl+Alt+L'), 8000, 'auto-registered at startup');
    assert.equal((await probe('Ctrl+Alt+L')).free, false, 'startup re-registered without user action');
    evidence.push({ stage: 'restart-auto-register', ok: true });
  }
  assert.equal(await quitHost(session), 0, 'clean quit before conflict stage');

  console.log('[stage] 3: startup conflict + retry');
  // ---- 第三段：启动注册冲突——保留偏好、报告真实状态、清障后同键重试只补注册 ----
  const squatter = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PowerShell + `\n[void][HK]::RegisterHotKey([IntPtr]::Zero, 0xBEEF, (${MOD.CTRL} -bor ${MOD.ALT}), ${VK.L})\nStart-Sleep -Seconds 45`], { windowsHide: true, stdio: 'ignore' });
  try {
    await new Promise(resolve => setTimeout(resolve, 1500));
    session = await startHost(['--settings']);
    const page = session.settings;
    assert.equal(await page.locator('#hotkey-saved').textContent(), 'Ctrl+Alt+L', 'conflict keeps saved preference');
    const actual = await page.locator('#hotkey-actual').textContent();
    assert.match(actual, /当前未生效/, 'startup failure reports not-registered');
    assert.match(actual, /无法注册|已被占用/, 'startup failure reports the real reason');
    evidence.push({ stage: 'startup-conflict', actual });
    await execFileAsync('taskkill', ['/PID', String(squatter.pid), '/F', '/T']).catch(() => { });
    await waitFor(async () => (await probe('Ctrl+Alt+L')).free === true, 12000, 'squatter released');
    await captureAndSave(page, [{ down: 'Control' }, { down: 'Alt' }, { press: 'KeyL' }, { up: 'Alt' }, { up: 'Control' }], 'Ctrl+Alt+L');
    await waitFor(async () => (await page.locator('#hotkey-actual').textContent()).includes('当前生效：Ctrl+Alt+L'), 8000, 'retry recovers registration');
    assert.equal(savedHotkey(), 'Ctrl+Alt+L', 'same-key retry only repairs registration');
    evidence.push({ stage: 'retry-after-conflict', ok: true });
  } finally {
    if (squatter.exitCode === null) squatter.kill();
  }
  assert.equal(await quitHost(session), 0, 'clean quit at end');
  assert.equal((await probe('Ctrl+Alt+L')).free, true, 'final quit releases everything');

  fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ binary, stages: evidence, verificationPassed: true }, null, 2));
  console.log('check-recovery-hotkey-native: all stages passed. Evidence: ' + output);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
