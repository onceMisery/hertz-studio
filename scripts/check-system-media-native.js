// SPDX-License-Identifier: MIT
// Actual Windows SMTC session, controlled by an independent GSMTC client.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const binary = process.env.HERTZ_BIN || path.join(root, 'target/debug/hertz-studio.exe');
const probe = process.env.HERTZ_MEDIA_PROBE || path.join(path.dirname(binary), 'examples/system_media_probe.exe');
const output = path.join(root, 'output/playwright/system-media-native-' + Date.now());
const data = path.join(output, 'data');
const checks = [];
let child, browser, page, discovery, companion;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(150); }
  throw new Error('Timed out: ' + label);
}
const mark = text => { checks.push(text); console.log('PASS ' + text); };
async function api(endpoint, method = 'GET', body) {
  const response = await fetch('http://127.0.0.1:' + discovery.port + endpoint, { method,
    headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); assert(response.ok, endpoint + ': ' + JSON.stringify(value)); return value;
}
function system(title, action = 'read', position) {
  return JSON.parse(execFileSync(probe, [title, action, ...(position == null ? [] : [String(position)])], {
    windowsHide: true, encoding: 'utf8', timeout: 15000,
  }));
}
async function shown(title, predicate = () => true) {
  return until(() => { const value = system(title); return value.count === 1 && predicate(value) && value; }, 'system metadata ' + title);
}
async function command(title, action, predicate, position) {
  const before = await shown(title);
  const result = system(title, action, position);
  assert.equal(result.accepted, true, action + ' was accepted by Windows');
  await until(predicate, action + ' reached service');
  return before;
}
function wav() {
  const bytes = Buffer.alloc(44 + 8000 * 120 * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40); return bytes;
}
async function main() {
  assert.equal(process.platform, 'win32');
  fs.mkdirSync(output, { recursive: true });
  const log = fs.openSync(path.join(output, 'host.log'), 'a');
  const cdp = 19863;
  child = spawn(binary, ['--window', '--bind', '127.0.0.1', '--port', '0', '--data-dir', data], {
    cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env,
      VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', HERTZ_DESKTOP_CONFIG_DIR: path.join(output, 'desktop'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + cdp + ' --no-proxy-server',
    },
  });
  fs.closeSync(log);
  let spawnError; child.on('error', error => { spawnError = error; });
  discovery = await until(() => {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, 'owned process exited before startup');
    try { const value = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'), 'utf8')); return value.pid === child.pid && value; } catch { return null; }
  }, 'service startup', 60000);
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + cdp + '/json/version')).ok; } catch { return false; } }, 'WebView CDP');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdp);
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes(':' + discovery.port)), 'native page');
  await page.waitForFunction(() => window.HertzSystemMedia?.ownsSession());
  const ownership = await until(async () => { const value = await api('/v1/window/media-state'); return value.phase === 'ready' && value; }, 'native media ready');
  assert.equal(ownership.owned, true);
  const music = path.join(output, 'music'); fs.mkdirSync(music);
  const prefix = 'smtc-fixture-' + Date.now();
  const titles = [prefix + '-first', prefix + '-second'];
  for (const title of titles) fs.writeFileSync(path.join(music, title + '.wav'), wav());
  await api('/v1/library/scan', 'POST', { root: music });
  const tracks = await until(async () => { const value = (await api('/v1/tracks?limit=20')).tracks; return value.length === 2 && value; }, 'fixture scan');
  const first = tracks.find(track => track.title === titles[0]), second = tracks.find(track => track.title === titles[1]);
  assert(first && second);
  await api('/v1/player/load', 'POST', { track_id: first.id, queue: [first.id, second.id] });
  const initial = await shown(titles[0], value => value.status === 4 && value.durationMs === 120000);
  assert.equal(await page.evaluate(() => navigator.mediaSession.metadata), null);
  assert.equal(await page.evaluate(() => navigator.mediaSession.playbackState), 'none');
  mark('real HWND SMTC session exposes one correct track/timeline; native renderer MediaSession is empty');
  companion = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, args: ['--no-proxy-server'] });
  const companionContext = await companion.newContext();
  await companionContext.addCookies(await page.context().cookies('http://127.0.0.1:' + discovery.port));
  const companionPage = await companionContext.newPage();
  await companionPage.goto('http://127.0.0.1:' + discovery.port + '/');
  await companionPage.waitForFunction(() => window.HertzSystemMedia?.ownsSession());
  assert.equal(await companionPage.evaluate(() => navigator.mediaSession.metadata), null);
  assert.equal(await companionPage.evaluate(() => navigator.mediaSession.playbackState), 'none');
  await companion.close(); companion = null;
  mark('a separate real Chrome client observes native ownership and suppresses its MediaSession');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfJkAAAAASUVORK5CYII=', 'base64');
  const coverResponse = await fetch('http://127.0.0.1:' + discovery.port + '/v1/tracks/' + first.id + '/cover', {
    method: 'POST', headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'image/png' }, body: png,
  });
  assert(coverResponse.ok);
  await shown(titles[0], value => value.thumbnailBytes === png.length);
  const replacedPng = Buffer.concat([png, Buffer.from([0])]);
  const replaceResponse = await fetch('http://127.0.0.1:' + discovery.port + '/v1/tracks/' + first.id + '/cover', {
    method: 'POST', headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'image/png' }, body: replacedPng,
  });
  assert(replaceResponse.ok);
  await shown(titles[0], value => value.thumbnailBytes === replacedPng.length);

  const originalUrl = 'http://127.0.0.1:' + discovery.port + '/';
  await page.goto('http://127.0.0.1:' + discovery.port + '/v1/health');
  await until(async () => (await api('/v1/player/depart', 'POST', {})).viewers === 0, 'actual WebSocket departure');
  await delay(4000);
  assert.equal((await api('/v1/state')).playing, true);
  await command(titles[0], 'pause', async () => !(await api('/v1/state')).playing);
  await shown(titles[0], value => value.status === 5 && value.play);
  await command(titles[0], 'seek', async () => (await api('/v1/state')).position_ms >= 15000, 15000);
  await shown(titles[0], value => value.positionMs === 15000);
  await command(titles[0], 'play', async () => (await api('/v1/state')).playing);
  await shown(titles[0], value => value.status === 4 && value.pause);
  mark('after renderer navigation and departure grace, Windows pause/seek/play still reach the real audio actor');

  await command(titles[0], 'next', async () => (await api('/v1/state')).track_id === second.id);
  await shown(titles[1], value => value.status === 4 && value.thumbnailBytes == null);
  await command(titles[1], 'previous', async () => (await api('/v1/state')).track_id === first.id);
  await shown(titles[0]);
  mark('Windows next/previous use the service queue without a player document');
  await command(titles[0], 'stop', async () => { const value = await api('/v1/state'); return !value.playing && value.position_ms === 0; });
  await shown(titles[0], value => value.status === 5 && value.positionMs === 0);
  await command(titles[0], 'play', async () => (await api('/v1/state')).playing);
  mark('local cached cover is published and cleared on the next track; Windows stop resets progress and remains resumable');

  await api('/v1/player/pause', 'POST', {});
  await api('/v1/room', 'POST', { action: 'create', name: 'SMTC fixture', address: '127.0.0.1:0', sample_rate: 48000, local_output: true, discoverable: false });
  await until(() => system(titles[0]).count === 0, 'empty room clears local metadata');
  await api('/v1/room', 'POST', { action: 'share', track_ids: [first.id] });
  let room = await api('/v1/room');
  const resource = room.tracks.find(track => track.title === titles[0]); assert(resource);
  const peer = request => api('/v1/room', 'POST', { action: 'peer', request });
  const queued = await peer({ action: 'queue', operation_id: room.next_operation_id, expected_revision: room.revision, items: [{ instance_id: null, resource_id: resource.resource_id }] });
  fs.writeFileSync(path.join(output, 'room-queue.json'), JSON.stringify(queued, null, 2));
  room = await until(async () => { const value = await api('/v1/room'); return value.queue_count === 1 && value; }, 'room queue committed');
  const playing = await peer({ action: 'playback', operation_id: room.next_operation_id, expected_revision: room.revision, command: { action: 'play' } });
  fs.writeFileSync(path.join(output, 'room-play.json'), JSON.stringify(playing, null, 2));
  await until(async () => (await api('/v1/room')).playing, 'room playing');
  await shown(titles[0], value => value.status === 4);
  await command(titles[0], 'pause', async () => !(await api('/v1/room')).playing);
  await shown(titles[0], value => value.status === 5 && value.play);
  await command(titles[0], 'play', async () => (await api('/v1/room')).playing);
  mark('empty room clears old media; actual Windows controls use the LAN host playback owner');
  await api('/v1/room', 'POST', { action: 'leave' });

  await page.goto(originalUrl);
  await page.waitForFunction(() => window.HertzSystemMedia?.ownsSession());
  assert.equal(await page.evaluate(() => navigator.mediaSession.metadata), null);
  await api('/v1/player/pause', 'POST', {});
  await api('/v1/system/shutdown', 'POST', {});
  await until(() => child.exitCode !== null, 'graceful native exit', 20000);
  await until(() => system(titles[0]).count === 0 && system(titles[1]).count === 0, 'system media session removed');
  mark('renderer reload keeps one owner; graceful process exit removes the Windows media session');
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, ownership, initial, binarySha256: hash(binary), probeSha256: hash(probe),
    sourceSha256: Object.fromEntries(['crates/hertz-studio/src/system_media.rs', 'crates/hertz-studio/src/system_media/owner.rs', 'crates/hertz-studio/src/system_media/windows.rs', 'plugin/ui/system-media.js', 'scripts/check-system-media-native.js'].map(file => [file, hash(path.join(root, file))])),
    limitations: ['local playback uses null audio; room playback uses real Windows output with a silent WAV', 'GSMTC API is not a physical media key', 'guest permissions and reconnection need separate device qualification'],
  }, null, 2));
  console.log('Evidence: ' + output);
}
main().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (discovery && child?.exitCode === null) {
    await api('/v1/room').then(value => fs.writeFileSync(path.join(output, 'failure-room.json'), JSON.stringify(value, null, 2))).catch(() => {});
  }
}).finally(async () => {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, 'fixture cleanup', 5000).catch(() => {}); }
  if (browser) await browser.close().catch(() => {});
  if (companion) await companion.close().catch(() => {});
});
