#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real Win32 main-window bounds + private stopped-profile SQLite seeds; never run GUI checks concurrently.
// HERTZ_BIN must pin the final Full/native candidate; HERTZ_PYTHON selects Python with stdlib sqlite3.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const binary = path.resolve(process.env.HERTZ_BIN || path.join(root, 'target/debug/hertz-studio.exe'));
const python = process.env.HERTZ_PYTHON || 'python';
const output = path.join(root, 'output/playwright/main-window-geometry-native-' + Date.now());
const fixture = path.join(__dirname, 'main-window-geometry-fixture.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const key = 'native_window_placement';
const diagnosisOnly = process.env.HERTZ_GEOMETRY_DIAGNOSIS_ONLY === '1';
const checks = [], errors = [], launches = [], servicePorts = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let child, browser, page, discovery, profile, spawnError, chromium, candidateHash, sourceHashes;
const sqliteScript = String.raw`
import json, pathlib, sqlite3, sys
mode = sys.argv[1]
if mode == 'probe':
    print(json.dumps({'sqliteVersion': sqlite3.sqlite_version}))
    sys.exit(0)
db = pathlib.Path(sys.argv[2]).resolve(strict=True)
connection = sqlite3.connect(db.as_uri() + ('?mode=ro' if mode == 'read' else '?mode=rw'), uri=True, timeout=10)
try:
    if mode == 'seed':
        payload = json.loads(sys.argv[3])
        connection.execute('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', ('native_window_placement', payload['raw'], payload['updatedAt']))
        connection.commit()
    elif mode != 'read':
        raise RuntimeError('Unknown private geometry fixture operation')
    rows = connection.execute('SELECT key,value,updated_at FROM settings WHERE key IN (?,?)', ('native_window_placement','native_geometry_unrelated')).fetchall()
    print(json.dumps({row[0]: {'raw': row[1], 'updatedAt': row[2]} for row in rows}, ensure_ascii=False))
finally:
    connection.close()
`;
function snapshot(name, value) { fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2)); }
const mark = text => { checks.push(text); console.log('PASS ' + text); };
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const value = await read(); if (value) return value;
    await delay(150);
  }
  throw new Error('Timed out: ' + label);
}
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function dbRows(profilePath = profile, mode = 'read', payload) {
  const file = path.resolve(profilePath, 'vmusic.db');
  const relative = path.relative(output, file);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'SQLite fixture stays inside its isolated output');
  assert.ok(fs.existsSync(file), 'Private fixture requires the real initialized database');
  if (mode === 'seed') {
    assert.ok(!child || child.exitCode !== null || child.signalCode !== null, 'Seed only after the owned child has exited');
    assert.equal(fs.existsSync(path.join(profilePath, 'vmusicd.json')), false, 'No live discovery may exist while seeding');
  }
  return JSON.parse(execFileSync(python, ['-c', sqliteScript, mode, file, ...(payload ? [JSON.stringify(payload)] : [])], {
    windowsHide: true, encoding: 'utf8', timeout: 15000,
  }));
}
const readRow = profilePath => dbRows(profilePath)[key] || null;
function decode(row) { try { return row && JSON.parse(row.raw); } catch { return null; } }
function near(actual, expected, tolerance = 2) {
  return !!actual && !!expected && ['x', 'y', 'width', 'height'].every(field => Math.abs(actual[field] - expected[field]) <= tolerance);
}
function within(bounds, work, tolerance = 1) {
  return bounds.x >= work.x - tolerance && bounds.y >= work.y - tolerance
    && bounds.x + bounds.width <= work.x + work.width + tolerance
    && bounds.y + bounds.height <= work.y + work.height + tolerance;
}
function assertFitted(state, label) {
  const normal = state.maximized ? state.normalScreenBounds : state.outerBounds;
  assert.ok(state.monitors.some(monitor => within(normal, monitor.workArea)), label + ': complete normal outer frame fits a current work area');
  if (state.maximized && state.extendedFrameBounds) assert.ok(within(state.extendedFrameBounds, state.monitor.workArea, 2), label + ': visible maximized frame fits its work area');
  assert.ok(state.scaleFactor > 0 && Number.isFinite(state.scaleFactor));
}
function rowMatches(row, state) {
  const value = decode(row);
  return value?.schemaVersion === 1 && value.maximized === state.maximized
    && near(value.normalBounds, state.maximized ? state.normalScreenBounds : state.outerBounds)
    && near(value.workArea, state.monitor.workArea, 0) && Math.abs(value.scaleFactor - state.scaleFactor) < 0.01;
}
function native(action = 'read', bounds) {
  assert.ok(child?.pid && launches.at(-1).mode === 'native', 'Native geometry actions require the owned native child');
  return JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture,
    '-OwnerPid', String(child.pid), '-Action', action,
    ...(launches.at(-1).mainHandle ? ['-Handle', String(launches.at(-1).mainHandle)] : []),
    ...(bounds ? ['-X', String(bounds.x), '-Y', String(bounds.y), '-Width', String(bounds.width), '-Height', String(bounds.height)] : [])], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  }));
}
async function stableNative(label, condition = () => true) {
  let previous, repeats = 0;
  return until(() => {
    const state = native();
    const comparable = JSON.stringify([state.visible, state.minimized, state.maximized, state.outerBounds, state.normalScreenBounds, state.monitor.workArea]);
    repeats = comparable === previous ? repeats + 1 : 0; previous = comparable;
    return repeats >= 2 && condition(state) && state;
  }, label);
}
async function saved(state, label) {
  const row = await until(() => { const current = readRow(); return rowMatches(current, state) && current; }, label + ' coalesced store');
  snapshot(label, { native: state, row, value: decode(row) }); return row;
}
async function unchanged(row, label) {
  await delay(1600); const actual = readRow();
  assert.deepEqual(actual, row, label + ': raw placement and updated_at stay unchanged');
  snapshot(label, { row: actual, native: native() });
}
async function api(endpoint, method = 'GET', body, expected = 200) {
  assert.ok(discovery, 'HTTP calls require the owned discovery');
  const response = await fetch('http://127.0.0.1:' + discovery.port + endpoint, { method,
    headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); assert.equal(response.status, expected, endpoint + ': ' + JSON.stringify(value)); return value;
}
async function genericRejected() {
  const before = readRow();
  const rejection = await api('/v1/settings', 'PUT', { [key]: { schemaVersion: 1 }, native_geometry_unrelated: true }, 400);
  assert.match(JSON.stringify(rejection), /主窗口|原生窗口/);
  assert.deepEqual(readRow(), before, 'Generic settings rejection preserves the owned key');
  assert.equal(dbRows().native_geometry_unrelated, undefined, 'Rejected settings batch cannot partially write unrelated keys');
  const backup = await api('/v1/backup');
  assert.equal(Object.hasOwn(backup.settings, key), false, 'Ordinary backup export excludes machine placement');
  await api('/v1/backup/restore', 'POST', { version: 1, settings: { [key]: null, native_geometry_unrelated: true } }, 400);
  assert.deepEqual(readRow(), before, 'Ordinary backup restore cannot replace the native-owned row');
  assert.equal(dbRows().native_geometry_unrelated, undefined, 'Rejected backup cannot partially restore another setting');
  return rejection;
}
async function start(name, mode = 'native') {
  assert.equal(child, null, 'Previous owned child must be stopped before the next launch');
  profile = path.join(output, 'data-' + name); spawnError = null;
  if (!servicePorts.has(name)) servicePorts.set(name, await freePort());
  const port = servicePorts.get(name), cdpPort = mode === 'native' ? await freePort() : null;
  const launch = { profile: path.basename(profile), mode, servicePort: port, cdpPort }; launches.push(launch);
  const log = fs.openSync(path.join(output, 'host-' + launches.length + '.log'), 'a');
  child = spawn(binary, [...(mode === 'native' ? ['--window'] : []), '--bind', '127.0.0.1', '--port', String(port), '--data-dir', profile], {
    cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env,
      VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', HERTZ_DESKTOP_CONFIG_DIR: path.join(output, 'desktop-' + name),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: cdpPort ? '--remote-debugging-port=' + cdpPort : '',
    },
  });
  launch.pid = child.pid; fs.closeSync(log); child.on('error', error => { spawnError = error; });
  discovery = await until(() => {
    if (child.exitCode !== null) throw new Error('Owned child exited during startup: ' + child.exitCode);
    try { const value = JSON.parse(fs.readFileSync(path.join(profile, 'vmusicd.json'), 'utf8')); return value.pid === child.pid && value; } catch { return null; }
  }, 'owned startup', 60000);
  assert.equal(discovery.port, port); assert.equal((await api('/v1/health')).backend, 'null');
  if (mode === 'native') {
    const version = await until(async () => { try { const response = await fetch('http://127.0.0.1:' + cdpPort + '/json/version'); return response.ok && await response.json(); } catch { return null; } }, 'native CDP');
    launch.webviewVersion = version.Browser;
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdpPort, { noDefaults: true });
    page = await until(() => browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('http://127.0.0.1:' + port)), 'owned native main page');
    page.setDefaultTimeout(18000); page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.__hertzWindowHost?.lifecycleVersion === 1 && window.WindowLifecycle?.isNative()
      && document.getElementById('conn').textContent === '服务已连接', null, { timeout: 45000 });
    await until(() => { try { return native().visible; } catch { return false; } }, 'owned visible native frame');
    const state = await stableNative('startup native geometry', state => state.visible && !state.minimized);
    launch.mainHandle = state.handle; snapshot('launch-' + launches.length, { launch, native: state, row: readRow() });
  }
}
async function stopCurrent() {
  if (!child) return;
  const launch = launches.at(-1);
  if (child.exitCode === null && child.signalCode === null) {
    await api('/v1/player/pause', 'POST', {});
    await until(async () => (await api('/v1/state')).playing === false, 'actor idle before owned graceful exit');
    await api('/v1/system/shutdown', 'POST', {}, launch.mode === 'native' ? 202 : 200);
    await until(() => child.exitCode !== null || child.signalCode !== null, 'owned graceful exit', 30000);
  }
  assert.equal(child.exitCode, 0, 'Owned graceful process exit succeeds');
  launch.exitCode = child.exitCode; launch.signalCode = child.signalCode; launch.graceful = true;
  assert.equal(fs.existsSync(path.join(profile, 'vmusicd.json')), false, 'Owned graceful exit removes discovery');
  launch.discoveryRemoved = true;
  if (browser) await browser.close().catch(() => {});
  child = browser = page = discovery = null;
}
async function cleanup() {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned failed-test cleanup', 10000);
    const launch = launches.at(-1); launch.exitCode = child.exitCode; launch.signalCode = child.signalCode; launch.graceful = false;
  }
  if (child) {
    const launch = launches.at(-1); launch.exitCode = child.exitCode; launch.signalCode = child.signalCode;
    launch.discoveryRemoved = !fs.existsSync(path.join(profile, 'vmusicd.json'));
  }
  if (browser) await browser.close().catch(() => {});
  child = browser = page = discovery = null;
}
async function focus() {
  await api('/v1/window/focus', 'POST', { serverInstanceId: discovery.server_instance_id });
  return stableNative('authenticated native focus', state => state.visible && !state.minimized);
}
function target(state, variation = 0) {
  const work = state.monitor.workArea, scale = state.scaleFactor;
  const frame = { width: state.outerBounds.width - state.clientBounds.width, height: state.outerBounds.height - state.clientBounds.height };
  const width = Math.min(work.width, Math.max(Math.ceil(720 * scale + frame.width), Math.round(work.width * (0.66 + variation * 0.025))));
  const height = Math.min(work.height, Math.max(Math.ceil(480 * scale + frame.height), Math.round(work.height * (0.68 + variation * 0.025))));
  return { x: work.x + Math.min(Math.round((31 + variation * 17) * scale), work.width - width),
    y: work.y + Math.min(Math.round((27 + variation * 13) * scale), work.height - height), width, height };
}
async function move(bounds, label) {
  native('bounds', bounds);
  const state = await stableNative(label, state => !state.maximized && !state.minimized && near(state.outerBounds, bounds));
  assertFitted(state, label); return state;
}
async function protectedCase(name, raw) {
  const destination = path.join(output, 'data-' + name);
  if (!fs.existsSync(path.join(destination, 'vmusic.db'))) { await start(name, 'headless'); await stopCurrent(); }
  const seeded = dbRows(destination, 'seed', { raw, updatedAt: Date.now() })[key];
  await start(name); const state = await stableNative(name + ' fallback frame'); assertFitted(state, name);
  assert.deepEqual(readRow(), seeded, 'Protected seed remains exact after startup');
  const geometry = target(state, 1); await move(geometry, name + ' native move/resize');
  native('maximize'); await stableNative(name + ' maximize', state => state.maximized);
  await unchanged(seeded, name + '-protected-native-changes'); await genericRejected();
  await stopCurrent(); assert.deepEqual(readRow(destination), seeded, 'Protected seed remains exact after graceful shutdown');
  snapshot(name + '-protected-after-exit', { row: seeded });
}
async function main() {
  assert.equal(process.platform, 'win32', 'Real geometry qualification requires Windows');
  assert.ok(fs.existsSync(binary), 'Final HERTZ_BIN must exist');
  const helper = JSON.parse(execFileSync(python, ['-c', sqliteScript, 'probe'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
  chromium = require(process.env.PLAYWRIGHT_MODULE || 'playwright').chromium;
  fs.mkdirSync(output, { recursive: true }); child = null;
  candidateHash = hash(binary);
  const sourceFiles = ['crates/hertz-studio/src/window_placement.rs', 'crates/hertz-studio/src/window/placement.rs',
    'crates/hertz-studio/src/window_lifecycle.rs', 'crates/hertz-studio/src/window_lifecycle/placement.rs',
    'crates/hertz-studio/src/window.rs', 'crates/hertz-studio/src/main.rs', 'crates/hertz-studio/src/routes.rs',
    'crates/hertz-desktop/src/app.rs', 'crates/hertz-desktop/src/wallpaper/decode_probe.rs',
    'scripts/check-main-window-geometry-native.js', 'scripts/main-window-geometry-fixture.ps1'];
  sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(path.join(root, file))]));
  snapshot('candidate', { binary, binarySha256: candidateHash, sourceSha256: sourceHashes, helper, diagnosisOnly });
  await start('main');
  const initial = await stableNative('initial fitted native frame'); assertFitted(initial, 'startup');
  await saved(initial, 'initial-startup');
  const rejection = await genericRejected(); snapshot('generic-settings-rejection', rejection);
  mark('fresh native startup fits the complete frame in a current work area; generic settings reject the native-owned key atomically');

  await move(target(initial), 'first normal move/resize');
  const normal = await move(target(initial, 1), 'last normal move/resize'); await saved(normal, 'normal-before-exit');
  const latestBounds = target(initial, 2); native('bounds', latestBounds);
  const latest = native(); assert.ok(near(latest.outerBounds, latestBounds), 'Final native move applies before shutdown');
  await stopCurrent(); const mainProfile = path.join(output, 'data-main'), flushed = readRow(mainProfile);
  assert.ok(rowMatches(flushed, latest), 'Graceful shutdown flushes the latest native geometry without a polling wait');
  await start('main'); const restarted = await stableNative('normal restart');
  assert.ok(near(restarted.outerBounds, decode(flushed).normalBounds)); assert.equal(restarted.maximized, false); assertFitted(restarted, 'normal restart');
  snapshot('normal-restarted', { native: restarted, row: readRow() });
  mark('actual normal move/resize persists the latest outer bounds and restores them after graceful restart');

  let preserved = await saved(restarted, 'normal-before-minimize');
  native('minimize'); await stableNative('real minimized frame', state => state.minimized);
  await unchanged(preserved, 'minimized-preserves-normal');
  await stopCurrent(); assert.deepEqual(readRow(mainProfile), preserved);
  await start('main'); let current = await stableNative('restart after minimized shutdown');
  assert.ok(near(current.outerBounds, decode(preserved).normalBounds)); assert.equal(current.minimized, false);
  mark('minimized geometry never replaces the normal placement, including graceful shutdown and the next visible restart');

  preserved = await saved(current, 'normal-before-hide');
  assert.equal((await api('/v1/window/state')).closeBehavior, 'hide');
  native('close'); await stableNative('real WM_CLOSE hide', state => !state.visible);
  native('bounds', target(current)); await unchanged(preserved, 'hidden-resize-preserves-normal');
  await stopCurrent(); assert.deepEqual(readRow(mainProfile), preserved);
  await start('main'); current = await stableNative('restart after hidden shutdown');
  assert.ok(near(current.outerBounds, decode(preserved).normalBounds)); assertFitted(current, 'hidden restart');
  mark('WM_CLOSE hides the main window; hidden move/resize and shutdown preserve the last visible normal bounds');

  const beforeMax = await saved(current, 'normal-before-maximize');
  native('maximize'); const maximized = await stableNative('real native maximize', state => state.maximized);
  assertFitted(maximized, 'maximized');
  assert.ok(near(maximized.normalScreenBounds, decode(beforeMax).normalBounds), 'Maximize retains the normal outer frame in screen coordinates');
  preserved = await saved(maximized, 'maximized-before-exit'); await stopCurrent();
  await start('main'); current = await stableNative('maximized restart', state => state.maximized);
  assert.ok(near(current.normalScreenBounds, decode(preserved).normalBounds)); assertFitted(current, 'maximized restart');
  mark('maximized state survives restart while WINDOWPLACEMENT normal workspace coordinates preserve the original screen outer bounds');

  preserved = await saved(current, 'maximized-before-capsule');
  await page.evaluate(() => __hertzWindowHost.capsule(true));
  const capsule = await stableNative('real native capsule', state => !state.maximized && state.outerBounds.width < 500 * state.scaleFactor);
  const capsuleWork = capsule.monitor.workArea;
  native('bounds', { x: capsuleWork.x + 40, y: capsuleWork.y + 40, width: Math.round(320 * capsule.scaleFactor), height: Math.round(64 * capsule.scaleFactor) });
  await unchanged(preserved, 'capsule-move-preserves-main');
  await page.evaluate(() => __hertzWindowHost.capsule(false));
  current = await stableNative('capsule exits to maximized main frame', state => state.maximized);
  assert.ok(near(current.normalScreenBounds, decode(preserved).normalBounds)); await saved(current, 'capsule-exited');
  await page.evaluate(() => __hertzWindowHost.capsule(true)); await stableNative('capsule before graceful exit', state => !state.maximized && state.outerBounds.width < 500 * state.scaleFactor);
  await stopCurrent(); assert.deepEqual(decode(readRow(mainProfile)), decode(preserved));
  await start('main'); current = await stableNative('main restart after capsule', state => state.maximized);
  assert.ok(near(current.normalScreenBounds, decode(preserved).normalBounds));
  mark('capsule geometry cannot overwrite main bounds or maximized state; capsule exit and graceful restart recover the main frame');

  native('restore'); current = await stableNative('normal before focus recovery', state => !state.maximized && !state.minimized);
  const far = { x: Math.max(...current.monitors.map(monitor => monitor.bounds.x + monitor.bounds.width)) + 4000,
    y: Math.min(...current.monitors.map(monitor => monitor.bounds.y)) - 3000, width: current.outerBounds.width, height: current.outerBounds.height };
  native('bounds', far); const displaced = native(); snapshot('runtime-offscreen-before-focus', displaced);
  assert.ok(!displaced.monitors.some(monitor => within(displaced.outerBounds, monitor.workArea)), 'Frame is actually offscreen before authenticated focus recovery');
  current = await focus(); assertFitted(current, 'explicit native focus'); await saved(current, 'runtime-offscreen-focus-recovered');
  native('work-area-notify'); current = await stableNative('current work-area notification'); assertFitted(current, 'current work-area notification');
  await saved(current, 'work-area-notified');
  await page.screenshot({ path: path.join(output, 'main-recovered.png') });
  mark('authenticated native focus recovers a displaced frame into a current work area; an owned work-area notification preserves the fitted frame');
  const hardware = current;
  await stopCurrent(); const headlessBefore = readRow(mainProfile);
  await start('main', 'headless'); await genericRejected(); await delay(800); assert.deepEqual(readRow(), headlessBefore);
  await stopCurrent(); assert.deepEqual(readRow(mainProfile), headlessBefore);
  mark('a browser-only service installs no native placement writer and preserves the existing placement row');

  const valid = decode(headlessBefore);
  await protectedCase('invalid', '{"schemaVersion":1,');
  await protectedCase('invalid', JSON.stringify({ ...valid, normalBounds: { ...valid.normalBounds, width: 0 } }));
  mark('malformed JSON and invalid typed geometry preserve exact raw values and timestamps through native changes and graceful exit');
  await protectedCase('future', JSON.stringify({ ...valid, schemaVersion: 2, futureOnly: 'preserve-this-state' }));
  mark('unknown future placement schema remains untouched by startup defaults, move/resize, maximize and shutdown');

  await start('offscreen', 'headless'); await stopCurrent();
  const primary = hardware.monitors.find(monitor => monitor.primary) || hardware.monitor;
  const primaryScale = primary.handle === hardware.monitor.handle ? hardware.scaleFactor : primary.scaleFactor;
  const requested = target({ ...hardware, monitor: primary, scaleFactor: primaryScale }, 1), farX = far.x, farY = far.y;
  const seeded = { schemaVersion: 1, normalBounds: { x: farX + 90, y: farY + 70, width: Math.round(requested.width / 2), height: Math.round(requested.height / 2) },
    workArea: { x: farX, y: farY, width: Math.max(1, Math.round(primary.workArea.width / 2)), height: Math.max(1, Math.round(primary.workArea.height / 2)) },
    scaleFactor: primaryScale / 2, maximized: false };
  dbRows(path.join(output, 'data-offscreen'), 'seed', { raw: JSON.stringify(seeded), updatedAt: Date.now() });
  snapshot('disconnected-screen-seed', seeded);
  await start('offscreen'); current = await stableNative('offscreen seeded restart'); assertFitted(current, 'offscreen startup');
  assert.equal(current.monitor.primary, true, 'No-overlap saved geometry falls back to the current primary monitor');
  const ratio = current.scaleFactor / seeded.scaleFactor, currentWork = current.monitor.workArea;
  assert.ok(current.outerBounds.width >= Math.min(Math.round(seeded.normalBounds.width * ratio), currentWork.width) - 2);
  assert.ok(current.outerBounds.height >= Math.min(Math.round(seeded.normalBounds.height * ratio), currentWork.height) - 2);
  assert.ok(current.outerBounds.width <= currentWork.width + 1 && current.outerBounds.height <= currentWork.height + 1);
  assert.ok(Math.abs(current.outerBounds.x - (currentWork.x + Math.min(Math.round(90 * ratio), currentWork.width - current.outerBounds.width))) <= 2);
  assert.ok(Math.abs(current.outerBounds.y - (currentWork.y + Math.min(Math.round(70 * ratio), currentWork.height - current.outerBounds.height))) <= 2);
  await saved(current, 'offscreen-dpi-work-area-recovered');
  await page.screenshot({ path: path.join(output, 'offscreen-startup-recovered.png') }); await stopCurrent();
  mark('a seeded disconnected-screen placement maps its logical DPI offsets and dimensions, selects current primary and fits the full frame into its work area');
  assert.deepEqual(errors, []); assert.equal(hash(binary), candidateHash, 'Candidate bytes stay fixed during qualification');
  for (const [file, sha] of Object.entries(sourceHashes)) assert.equal(hash(path.join(root, file)), sha, 'Source stays fixed during qualification: ' + file);
}
if (process.argv.includes('--check-helper')) {
  console.log(execFileSync(python, ['-c', sqliteScript, 'probe'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim());
} else main().then(async () => {
  await cleanup(); snapshot('report', { passed: true, cleanupDone: true, diagnosisOnly, binary, binarySha256: candidateHash, sourceSha256: sourceHashes,
    launches, checks, errors, limitations: ['one Windows/WebView2 host with null audio',
      'disconnected screen and changed DPI are private schema seeds; no physical multi-monitor or mixed-DPI hardware qualification',
      'work-area notification is sent only to the owned main window; it does not change the OS taskbar or monitor topology'] });
  console.log(JSON.stringify({ output, checks, launches: launches.length }, null, 2));
}).catch(async error => {
  fs.mkdirSync(output, { recursive: true });
  if (child && launches.at(-1)?.mode === 'native') { try { snapshot('failure-native', native()); } catch {} }
  if (profile) { try { snapshot('failure-placement', readRow()); } catch {} }
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
  await cleanup().catch(cleanupError => errors.push('cleanup: ' + cleanupError.message));
  snapshot('report', { passed: false, diagnosisOnly, error: error.stack, binary, binarySha256: candidateHash, sourceSha256: sourceHashes, launches, checks, errors });
  console.error(error); console.error(output); process.exitCode = 1;
});
