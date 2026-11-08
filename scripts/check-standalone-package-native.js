#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { packageStandalone, validateDescriptionProtocol } = require('./package-standalone-windows');
const root = path.resolve(__dirname, '..');
const binary = process.env.HERTZ_BIN || path.join(root, 'target/release/hertz-studio.exe');
const output = path.join(root, 'output/playwright/standalone-package-' + Date.now());
const extracted = path.join(output, '播放器 & portable files');
const data = path.join(output, "资料 & profile's space");
const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const checks = [];
let browser, ownedPid, discovery;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const mark = text => { checks.push(text); console.log('PASS ' + text); };
async function until(read, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(150); }
  throw new Error('Timed out: ' + label);
}
function powershell(script, env = {}) {
  return execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env },
  }).trim();
}
async function api(endpoint, method = 'GET', body) {
  const response = await fetch('http://127.0.0.1:' + discovery.port + endpoint, { method,
    headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
}
function verifyFiles(manifest) {
  for (const [file, expected] of Object.entries(manifest.files)) {
    assert.equal(path.basename(file), file);
    const actual = path.join(extracted, file);
    assert.equal(fs.statSync(actual).size, expected.size, file);
    assert.equal(hash(actual), expected.sha256, file);
  }
  assert.deepEqual(fs.readdirSync(extracted).sort(), [...Object.keys(manifest.files), 'standalone-build.json'].sort());
}
async function main() {
  assert.equal(process.platform, 'win32'); fs.mkdirSync(output, { recursive: true });
  validateDescriptionProtocol(fs.readFileSync(binary));
  const unused = path.join(output, 'must-not-create');
  const description = JSON.parse(execFileSync(binary, ['--describe', '--window', '--data-dir', unused, '--port', '0'], {
    windowsHide: true, encoding: 'utf8', timeout: 10000,
  }));
  assert.equal(description.capabilities.nativeWindow, true); assert(!fs.existsSync(unused));
  const again = JSON.parse(execFileSync(binary, ['--describe', '--mcp-stdio', '--data-dir', unused], {
    windowsHide: true, encoding: 'utf8', timeout: 10000,
  }));
  assert.deepEqual(again, description); assert(!fs.existsSync(unused));
  mark('real --describe precedes window/MCP/service startup, is stable and creates no DataDir');

  const packaged = packageStandalone(binary, path.join(output, 'packages'), { allowDebug: process.env.HERTZ_ALLOW_DEBUG_PACKAGE === '1' });
  assert.equal(hash(packaged.archive), packaged.sha256);
  const before = fs.readdirSync(path.dirname(packaged.archive)).sort();
  assert.throws(() => packageStandalone(binary, path.dirname(packaged.archive), { allowDebug: process.env.HERTZ_ALLOW_DEBUG_PACKAGE === '1' }), /EEXIST/);
  assert.equal(hash(packaged.archive), packaged.sha256);
  assert.deepEqual(fs.readdirSync(path.dirname(packaged.archive)).sort(), before);
  powershell('Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:HERTZ_TEST_ZIP, $env:HERTZ_TEST_CONTENT)', {
    HERTZ_TEST_ZIP: packaged.archive, HERTZ_TEST_CONTENT: extracted,
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'standalone-build.json'), 'utf8'));
  verifyFiles(manifest);
  const altered = structuredClone(manifest); altered.files['hertz-studio.exe'].sha256 = '0'.repeat(64);
  assert.throws(() => verifyFiles(altered), /hertz-studio.exe/);
  assert.equal(manifest.files['hertz-studio.exe'].sha256, hash(binary));
  mark('ZIP files match the exact binary identity/hashes; modified manifest and duplicate output are rejected without overwriting the first candidate');

  const cdp = 19864;
  const childEnv = { ...process.env, PATH: path.join(process.env.SystemRoot, 'System32'),
    VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', VMUSIC_DATA_DIR: data, VMUSIC_PORT: '0', HERTZ_DESKTOP_CONFIG_DIR: path.join(output, 'desktop'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + cdp + ' --no-proxy-server' };
  // Environment variable names are case-insensitive on Windows.
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'path' && key !== 'PATH') delete childEnv[key];
  const launchArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(extracted, 'Launch-Hertz.ps1'),
    '-DataDir', data, '-Port', '0', '-PassThru'];
  execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', '& $env:HERTZ_TEST_ENTRY; exit $LASTEXITCODE'], {
    cwd: extracted, windowsHide: true, encoding: 'utf8', timeout: 15000,
    env: { ...childEnv, HERTZ_TEST_ENTRY: path.join(extracted, 'Hertz Studio.cmd') },
  });
  discovery = await until(() => {
    try { const value = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'), 'utf8')); return Number.isInteger(value.pid) && value.pid > 0 && value; } catch { return null; }
  }, 'packaged service');
  ownedPid = discovery.pid;
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + cdp + '/json/version')).ok; } catch { return false; } }, 'packaged WebView');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdp);
  const page = await until(() => browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes(':' + discovery.port)), 'package main page');
  await page.waitForFunction(() => window.WindowLifecycle?.isNative() && window.HertzSystemMedia?.ownsSession());
  assert.equal((await api('/v1/window/state')).backgroundPlayback, true);
  assert.equal((await api('/v1/window/media-state')).available, true);
  await page.screenshot({ path: path.join(output, 'packaged-window.png') });
  assert(!fs.existsSync(path.join(extracted, 'data')));
  verifyFiles(manifest);
  mark('actual packaged CMD opens real WebView2 from a Chinese/space/ampersand path with no Cargo/Node PATH and an isolated profile');

  const relaunch = JSON.parse(execFileSync(ps, launchArgs.map((value, index) => index > 0 && launchArgs[index - 1] === '-Port' ? String(discovery.port) : value), {
    cwd: extracted, windowsHide: true, encoding: 'utf8', timeout: 15000, env: childEnv,
  }));
  await until(() => { try { process.kill(relaunch.pid, 0); return false; } catch { return true; } }, 'duplicate launcher exits');
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'), 'utf8')).pid, ownedPid);
  assert.equal((await api('/v1/window/state')).available, true);
  mark('second package launch exits and keeps the original native service/window');
  await api('/v1/system/shutdown', 'POST', {});
  await until(() => { try { process.kill(ownedPid, 0); return false; } catch { return true; } }, 'packaged process exits');
  ownedPid = null;
  assert(!fs.existsSync(path.join(data, 'vmusicd.json')));
  verifyFiles(manifest);
  mark('normal package shutdown removes discovery; program files remain byte-identical');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, archive: packaged.archive, archiveSha256: packaged.sha256,
    manifest, limitations: ['isolated existing Windows/WebView2 installation, not a clean OS or offline runtime install', 'no NSIS install, update, signature or rollback qualification', 'null audio'],
  }, null, 2));
  console.log('Evidence: ' + output);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (ownedPid) { try { process.kill(ownedPid); } catch {} }
  if (browser) await browser.close().catch(() => {});
});
