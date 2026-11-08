// SPDX-License-Identifier: MIT
// Windows main window + embedded desktop lifecycle. Build full,native-window first.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/desktop-embedded-' + Date.now());
const data = path.join(output, 'data'), desktop = path.join(output, 'desktop');
const binary = path.resolve(process.env.HERTZ_BIN || path.join(root, 'target/debug/hertz-studio.exe'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await delay(100); }
  throw new Error('Timed out: ' + label);
}
async function main() {
  assert.equal(process.platform, 'win32', 'Requires Windows and WebView2');
  assert.ok(fs.existsSync(binary), 'Build hertz-studio with full,native-window first');
  fs.mkdirSync(output, { recursive: true });
  const probe = path.join(output, 'windows.ps1');
  fs.writeFileSync(probe, `param([int]$TargetPid)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class EmbeddedWindows {
  public delegate bool Callback(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  public class Info { public long Handle; public uint ProcessId; public uint ThreadId; public string Title; public bool Visible; }
  public static Info[] Read(uint target) {
    var result = new List<Info>();
    EnumWindows((hwnd, param) => {
      uint pid; uint thread = GetWindowThreadProcessId(hwnd, out pid);
      if (pid == target) {
        var text = new StringBuilder(256); GetWindowText(hwnd, text, text.Capacity);
        if (text.Length > 0) result.Add(new Info { Handle=hwnd.ToInt64(), ProcessId=pid, ThreadId=thread, Title=text.ToString(), Visible=IsWindowVisible(hwnd) });
      }
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
}
'@
ConvertTo-Json -Compress -InputObject @([EmbeddedWindows]::Read([uint32]$TargetPid))
`, 'utf8');
  const outLog = fs.openSync(path.join(output, 'service.log'), 'w'), errLog = fs.openSync(path.join(output, 'service.err'), 'w');
  const child = spawn(binary, ['--window', '--port', '0', '--bind', '127.0.0.1', '--data-dir', data], {
    cwd: root, windowsHide: true, stdio: ['ignore', outLog, errLog],
    env: { ...process.env, VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', HERTZ_DESKTOP_CONFIG_DIR: desktop },
  });
  let spawnError, api;
  child.on('error', error => { spawnError = error; });
  const evidence = { checks: [], cycles: [], output };
  const windows = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', probe, '-TargetPid', String(child.pid)], { windowsHide: true, encoding: 'utf8' }).trim());
  function pass(message) { evidence.checks.push(message); console.log('PASS ' + message); }
  try {
    const discovery = await until(() => {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, 'Main process remains alive');
      try { const info = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'), 'utf8')); return info.pid === child.pid && info; } catch { return null; }
    }, 'isolated service discovery', 20000);
    const base = 'http://127.0.0.1:' + discovery.port;
    api = async (endpoint, body, expected = 200) => {
      const response = await fetch(base + endpoint, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(55000),
      });
      const result = await response.json();
      assert.equal(response.status, expected, endpoint + ': ' + JSON.stringify(result));
      return result;
    };
    assert.equal((await api('/v1/health')).backend, 'null');
    const wallpaperMaintenance = () => spawnSync(binary,
      ['--wallpaper-list-upgrade-backups', '--desktop-root', desktop],
      { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    const mainWindow = await until(() => windows().find(window => window.Title === 'HertzStudio Music Player' && window.Visible), 'native main window');
    pass('Isolated native main window uses its own player and desktop data');
    assert.equal((await api('/v1/desktop/control', { command: 'status' }, 503)).error.code, 'desktop_not_running');
    for (let cycle = 1; cycle <= 3; cycle++) {
      const started = Date.now();
      assert.equal((await api('/v1/desktop/wallpaper/launch', {})).started, true);
      const elapsed = Date.now() - started;
      assert.equal((await api('/v1/desktop/control', { command: 'status' })).wallpaper.settingsOpen, true);
      const blockedMaintenance = wallpaperMaintenance();
      assert.notEqual(blockedMaintenance.status, 0);
      assert.match(blockedMaintenance.stderr, /desktop_root_busy/);
      const owned = windows(), lyrics = owned.find(window => window.Title === 'Hertz 桌面歌词');
      const settings = owned.find(window => window.Title === '桌面歌词与壁纸' && window.Visible);
      assert.ok(lyrics && settings, 'Both desktop windows exist: ' + JSON.stringify(owned));
      assert.equal(lyrics.ProcessId, child.pid); assert.equal(settings.ProcessId, child.pid);
      assert.notEqual(lyrics.ThreadId, mainWindow.ThreadId, 'Exercises two real Tao threads in one process');
      assert.equal(settings.ThreadId, lyrics.ThreadId);
      assert.ok(owned.some(window => window.Handle === mainWindow.Handle && window.Visible));
      const replies = await Promise.all(Array.from({ length: 16 }, () => api('/v1/desktop/control', { command: 'status' })));
      const canonicalData = fs.realpathSync.native(data);
      assert.ok(replies.every(reply => reply.ok
        && reply.activeProfile.kind === 'standalone'
        && fs.realpathSync.native(reply.activeProfile.dataDir) === canonicalData),
      'Concurrent events retain the same canonical standalone profile');
      assert.equal((await api('/v1/desktop/control', { command: 'wallpaper-settings', value: { tab: 'lyrics' } })).ok, true);
      assert.equal(windows().filter(window => window.Title === '桌面歌词与壁纸').length, 1, 'Reopening reuses settings');
      evidence.cycles.push({ cycle, startupMs: elapsed, windows: owned });
      await api('/v1/desktop/control', { command: 'quit' });
      await until(async () => {
        const response = await fetch(base + '/v1/desktop/control', {
          method: 'POST', headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'status' }), signal: AbortSignal.timeout(5000),
        });
        return response.status === 503;
      }, 'desktop host stops');
      await until(() => {
        const result = wallpaperMaintenance();
        if (result.status === 0) { assert(Array.isArray(JSON.parse(result.stdout).snapshots)); return true; }
        assert.match(result.stderr, /desktop_root_busy|desktop_legacy_busy|config_busy|budget_busy/);
        return false;
      }, 'desktop root released after real host and SQLite exit');
      assert.equal((await api('/v1/health')).backend, 'null');
      const remaining = windows();
      assert.ok(!remaining.some(window => window.Title === '桌面歌词与壁纸' || window.Title === 'Hertz 桌面歌词'));
      assert.ok(remaining.some(window => window.Handle === mainWindow.Handle));
      pass('Cycle ' + cycle + ': same PID, 16 concurrent commands, live root blocks maintenance and shutdown releases it while preserving the main window (' + elapsed + 'ms startup)');
    }
    const log = fs.readFileSync(path.join(desktop, 'desktop.log'), 'utf8');
    assert.ok(!/ignore stale wallpaper feed generation=\d{5,}|panicked|embedded desktop host failed/i.test(log));
    const children = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${child.pid} -and $_.Name -eq 'hertz-desktop.exe' }).Count`], { windowsHide: true, encoding: 'utf8' }).trim();
    assert.equal(children, '0');
    pass('No external hertz-desktop.exe is started');
    await api('/v1/system/shutdown', {}, 202);
    await until(() => child.exitCode !== null, 'graceful player shutdown');
    assert.equal(child.exitCode, 0);
    pass('Player exits cleanly after desktop restarts');
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(evidence, null, 2));
    console.log('Native embedded check: ' + evidence.checks.length + ' groups passed; ' + output);
  } finally {
    if (child.exitCode === null && !spawnError) {
      if (api) await api('/v1/system/shutdown', {}, 202).catch(() => {});
      await delay(300); if (child.exitCode === null) child.kill();
    }
    fs.closeSync(outLog); fs.closeSync(errLog);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
