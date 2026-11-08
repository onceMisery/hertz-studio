#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real Full/native HTTP and WebView2 policy qualification. GUI runs are serial.
// HERTZ_BIN pins the candidate; PLAYWRIGHT_MODULE and optional
// PLAYWRIGHT_BROWSER_EXECUTABLE select installed browser runtimes.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const binary = path.resolve(process.env.HERTZ_BIN || path.join(root, 'target/debug/hertz-studio.exe'));
const output = path.join(root, 'output/playwright/native-http-boundary-' + Date.now());
const checks = [], failures = [], owned = new Set(), processes = [], secrets = new Set();
const inputs = ['crates/hertz-studio/src/main.rs', 'crates/hertz-studio/src/native_http.rs',
  'crates/hertz-studio/src/ws.rs', 'crates/hertz-studio/src/routes.rs', 'crates/hertz-studio/src/window.rs',
  'crates/hertz-studio/src/bootstrap.rs', 'crates/hertz-studio/Cargo.toml', 'plugin/ui/index.html',
  'plugin/ui/overlay.html', 'plugin/ui/host.js', 'plugin/ui/app.js', 'plugin/ui/stage-media.js',
  'plugin/ui/stanza/stanza-sonnet.js', 'plugin/ui/vendor/pixi.min.js', 'scripts/check-native-http-boundary.js'];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const candidateHash = hash(binary), sourceHashes = Object.fromEntries(inputs.map(file => [file, hash(path.join(root, file))]));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const mark = message => { checks.push(message); console.log('PASS ' + message); };
let browser, nativeBrowser, foreignServer, browserVersion;
async function until(read, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await pause(80); }
  throw Error('Timed out: ' + label);
}
function redact(value) {
  if (typeof value === 'string') {
    for (const secret of secrets) value = value.split(secret).join('<redacted>');
    return value.replace(/([?&](?:ticket|token|key)=)[^\s&"<>]+/g, '$1<redacted>');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  return value;
}
function start(name, native, bind, extra = {}) {
  const data = path.join(output, name); fs.mkdirSync(data, { recursive: true });
  const child = spawn(binary, [...(native ? ['--window'] : []), '--port', '0',
    ...(bind === null ? [] : ['--bind', bind]), '--data-dir', data], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      VMUSIC_BIND: '127.0.0.1', VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory',
      HERTZ_DESKTOP_CONFIG_DIR: path.join(data, 'desktop'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0', ...extra },
  });
  child.out = ''; child.err = ''; child.data = data; owned.add(child);
  child.stdout.on('data', b => { child.out += b.toString(); });
  child.stderr.on('data', b => { child.err += b.toString(); });
  child.on('error', error => { child.failure = error; });
  processes.push({ name, native, pid: child.pid, data, child });
  return child;
}
async function ready(child) {
  const discovery = await until(() => {
    if (child.failure) throw child.failure;
    assert.equal(child.exitCode, null, 'Candidate exited: ' + child.err);
    try { const d = JSON.parse(fs.readFileSync(path.join(child.data, 'vmusicd.json'))); return d.pid === child.pid && d; } catch { return null; }
  }, 'owned discovery');
  secrets.add(discovery.token);
  const origin = 'http://127.0.0.1:' + discovery.port;
  await until(async () => { try { return (await request(origin, '/v1/health')).status === 200; } catch { return false; } }, 'owned HTTP listener');
  return { child, discovery, origin, port: discovery.port };
}
function request(origin, target, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const req = http.request({ hostname: url.hostname, port: url.port || 80, path: target,
      method: options.method || 'GET', headers: options.headers || {}, timeout: 12000 }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(Error('HTTP timeout')));
    req.end(options.body);
  });
}
async function api(live, target, method = 'GET', body) {
  const result = await request(live.origin, target, { method,
    headers: { Authorization: 'Bearer ' + live.discovery.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(result.status, 200, target + ': ' + result.text);
  return JSON.parse(result.text);
}
function raw(live, target, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(live.port, '127.0.0.1'); let text = '';
    socket.setTimeout(12000, () => socket.destroy(Error('Raw HTTP timeout')));
    socket.on('error', reject); socket.on('data', chunk => { text += chunk.toString(); });
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1])));
    // Keep the TCP read side alive until Hyper sends Connection: close. A FIN
    // sent with the request can cancel dispatch before any response is emitted.
    socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\n${headers.join('\r\n')}\r\nConnection: close\r\n\r\n`));
  });
}
function ws(live, credential, origin) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key };
    if (origin !== undefined) headers.Origin = origin;
    const req = http.request({ hostname: '127.0.0.1', port: live.port, path: '/ws?' + credential, headers, timeout: 12000 });
    req.on('error', reject); req.on('timeout', () => req.destroy(Error('WS timeout')));
    req.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('upgrade', (res, socket) => {
      try { assert.equal(res.headers['sec-websocket-accept'], crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')); }
      catch (error) { socket.destroy(); reject(error); return; }
      socket.on('error', () => {}); socket.end(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
      socket.destroy(); resolve(res.statusCode);
    }); req.end();
  });
}
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await until(() => child.exitCode !== null || child.signalCode !== null, 'owned process exit', 15000);
  owned.delete(child);
}
function htmlHeaders(result) {
  assert(result.headers['content-security-policy']);
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.equal(result.headers['x-frame-options'], 'DENY');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['cache-control'], 'no-store');
  const nonce = /'nonce-([a-f0-9]{64})'/.exec(result.headers['content-security-policy'])?.[1];
  assert(nonce); assert(result.text.includes(`<script nonce="${nonce}">`)); return nonce;
}
function activePort(data) {
  for (const relative of ['DevToolsActivePort', 'EBWebView/DevToolsActivePort', 'Default/DevToolsActivePort', 'EBWebView/Default/DevToolsActivePort']) {
    try { const port = Number(fs.readFileSync(path.join(data, 'webview/main', relative), 'utf8').split(/\r?\n/)[0]); if (port > 0 && port < 65536) return port; } catch {}
  }
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  for (const [name, bind, extra, config] of [['bad-cli', '0.0.0.0', {}], ['bad-ipv6', '::1', {}],
    ['bad-env', null, { VMUSIC_BIND: '0.0.0.0' }],
    ['bad-config', null, { VMUSIC_BIND: undefined }, '[server]\nbind="0.0.0.0"\nport=0\n']]) {
    if (config) { const data = path.join(output, name); fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(path.join(data, 'config.toml'), config); }
    const child = start(name, true, bind, extra);
    await until(() => { if (child.failure) throw child.failure; return child.exitCode !== null; }, 'non-loopback native refusal');
    assert.notEqual(child.exitCode, 0); assert.match(child.err, /127\.0\.0\.1/);
    for (const file of ['token', 'vmusicd.json']) assert(!fs.existsSync(path.join(child.data, file)), 'No ' + file + ' before native bind admission');
    assert(!fs.readdirSync(child.data).some(file => /\.(db|sqlite)(-|$)/.test(file)), 'No business database before bind admission');
    owned.delete(child);
  }
  mark('Native CLI, IPv6, environment and config non-loopback binds refuse before token/database/discovery');
  const live = await ready(start('native', true, '127.0.0.1'));
  const bare = await request(live.origin, '/'); assert.equal(bare.status, 401); htmlHeaders(bare);
  assert(!bare.text.includes(live.discovery.token));
  // The native WebView owns the startup entry. Mint a distinct ticket through
  // the existing auth owner so ingress probes cannot steal its first navigation.
  const entryTicket = (await api(live, '/v1/auth/ticket', 'POST', { uses: 1 })).ticket;
  secrets.add(entryTicket);
  const entryTarget = '/?ticket=' + entryTicket;
  const wrongHost = await request(live.origin, entryTarget, { headers: { Host: 'evil.example' } }); assert.equal(wrongHost.status, 421);
  const wrongOrigin = await request(live.origin, entryTarget, { headers: { Origin: 'http://evil.example' } }); assert.equal(wrongOrigin.status, 403);
  const page = await request(live.origin, entryTarget, { headers: { Origin: live.origin } }); assert.equal(page.status, 200);
  const nonce = htmlHeaders(page); assert(page.text.includes(live.discovery.token));
  assert.equal((await request(live.origin, entryTarget)).status, 401);
  const cookie = page.headers['set-cookie'][0].split(';')[0]; secrets.add(cookie.split('=')[1]);
  const refreshed = await request(live.origin, '/', { headers: { Cookie: cookie } }); assert.equal(refreshed.status, 200);
  assert.notEqual(htmlHeaders(refreshed), nonce);
  mark('Random-port Host/Origin reject before entry ticket redemption; single-use entry and refresh/session remain valid');
  const sessionBody = JSON.stringify({ token: live.discovery.token });
  const denied = await request(live.origin, '/v1/auth/session', { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: sessionBody });
  assert.equal(denied.status, 403); assert(!denied.headers['set-cookie']);
  assert.equal((await request(live.origin, '/v1/auth/session', { method: 'POST', headers: { Origin: live.origin, 'Content-Type': 'application/json' }, body: sessionBody })).status, 204);
  assert.equal((await request(live.origin, '/v1/auth/ticket', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await request(live.origin, '/v1/auth/ticket', { method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  mark('Origin rejection issues no session; valid form works; cookie and invalid bearer do not authorize API ticket minting');
  const host = 'Host: 127.0.0.1:' + live.port;
  for (const headers of [[], [host, host], [host, 'Origin: ' + live.origin, 'Origin: ' + live.origin]]) {
    const status = await raw(live, '/v1/health', headers);
    assert([400, 403, 421].includes(status), JSON.stringify({ headers, status }));
  }
  assert.equal(await raw(live, 'http://evil.example/v1/health', [host]), 421);
  assert.equal(await raw(live, live.origin + '/v1/health', [host]), 200);
  mark('Missing/duplicate Host, duplicate Origin and conflicting absolute-form authority are rejected');
  const ticket = (await api(live, '/v1/auth/ticket', 'POST', { uses: 1 })).ticket; secrets.add(ticket);
  assert.equal(await ws(live, 'ticket=' + ticket, 'http://evil.example'), 403);
  assert.equal(await ws(live, 'ticket=' + ticket, live.origin), 101);
  assert.equal(await ws(live, 'ticket=' + ticket, live.origin), 401);
  const noOriginTicket = (await api(live, '/v1/auth/ticket', 'POST', { uses: 1 })).ticket; secrets.add(noOriginTicket);
  assert.equal(await ws(live, 'ticket=' + noOriginTicket), 101);
  assert.equal(await ws(live, 'token=wrong'), 401);
  mark('Wrong WS Origin leaves ticket redeemable; same-origin and credentialed non-browser WS work without auth downgrade');
  const key = (await api(live, '/v1/auth/overlay-key')).key; secrets.add(key);
  const overlay = await request(live.origin, '/overlay?key=' + encodeURIComponent(key)); assert.equal(overlay.status, 200); htmlHeaders(overlay);
  assert.equal((await request(live.origin, '/v1/overlay/lyric?key=' + encodeURIComponent(key))).status, 200);
  mark('OBS shell receives CSP/nonce and existing read-only key still retrieves overlay data');
  const cdp = await until(() => activePort(live.child.data), 'owned native WebView2 CDP');
  nativeBrowser = await chromium.connectOverCDP('http://127.0.0.1:' + cdp, { noDefaults: true });
  const nativePage = await until(() => nativeBrowser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith(live.origin)), 'owned native page');
  await nativePage.waitForFunction(() => document.getElementById('conn')?.textContent === '服务已连接' && window.__hertzWindowHost?.obsPreviewVersion === 1, null, { timeout: 45000 });
  await nativePage.screenshot({ path: path.join(output, 'actual-native-main.png') });
  mark('Actual native WebView2 boots full UI, native host capabilities and authenticated same-origin WS under CSP');
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_BROWSER_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_BROWSER_EXECUTABLE } : {}) });
  browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const tab = await context.newPage(); const pageErrors = []; tab.on('pageerror', error => pageErrors.push(error.message));
  let remoteImageRequests = 0, remoteConnections = 0; const remoteImageReferrers = [];
  foreignServer = http.createServer((req, res) => {
    if (req.url === '/image.svg') {
      remoteImageRequests++; remoteImageReferrers.push(req.headers.referer || null);
      res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
    } else if (req.url === '/connection') { remoteConnections++; res.end('unexpected connection'); }
    else { res.setHeader('Content-Type', 'text/html'); res.end(`<iframe src="${live.origin}/"></iframe>`); }
  });
  await new Promise(resolve => foreignServer.listen(0, '127.0.0.1', resolve));
  const foreignOrigin = 'http://127.0.0.1:' + foreignServer.address().port;
  const first = await tab.goto(live.origin + '/'); assert.equal(first.status(), 401);
  await tab.locator('#t').fill(live.discovery.token); await tab.locator('#f button').click();
  await tab.waitForFunction(() => document.getElementById('conn')?.textContent === '服务已连接', null, { timeout: 45000 });
  assert.equal(await tab.evaluate(() => window.__VMUSIC_TOKEN__.length), live.discovery.token.length);
  mark('Real browser recovery form executes its nonced script and loads complete authenticated UI');
  const blocked = await tab.evaluate(async () => {
    const violations = []; document.addEventListener('securitypolicyviolation', e => violations.push(e.effectiveDirective));
    const script = document.createElement('script'); script.textContent = 'window.__cspAttack=true'; document.body.append(script);
    const dataScript = document.createElement('script'); dataScript.src = 'data:text/javascript,window.__cspDataAttack=true'; document.body.append(dataScript);
    const image = document.createElement('img'); image.setAttribute('onerror', 'window.__cspEventAttack=true'); image.src = '/missing-policy-fixture.png'; document.body.append(image);
    await new Promise(resolve => setTimeout(resolve, 350));
    script.remove(); dataScript.remove(); image.remove();
    return { violations, script: !!window.__cspAttack, data: !!window.__cspDataAttack, event: !!window.__cspEventAttack };
  });
  assert.equal(blocked.script, false); assert.equal(blocked.data, false); assert.equal(blocked.event, false);
  assert(blocked.violations.includes('script-src-elem')); assert(blocked.violations.includes('script-src-attr'));
  mark('Actual CSP blocks nonced-less inline/data scripts and injected event attributes');
  await tab.evaluate(async () => {
    await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = '/vendor/pixi.min.js'; script.onload = resolve; script.onerror = reject; document.head.append(script); });
    const app = new PIXI.Application(); await app.init({ width: 32, height: 32, preference: 'webgl' });
    app.stage.addChild(new PIXI.Graphics().rect(0, 0, 16, 16).fill(0x709070)); app.renderer.render(app.stage); app.destroy(true);
    const url = URL.createObjectURL(new Blob(['onmessage=()=>postMessage(7)'], { type: 'application/javascript' }));
    const worker = new Worker(url); const value = await new Promise((resolve, reject) => { worker.onmessage = e => resolve(e.data); worker.onerror = reject; worker.postMessage(0); });
    worker.terminate(); URL.revokeObjectURL(url); if (value !== 7) throw Error('Worker failed');
    const node = document.createElement('div'); node.style.color = 'rgb(17, 31, 47)'; document.body.append(node);
    if (getComputedStyle(node).color !== 'rgb(17, 31, 47)') throw Error('Dynamic style failed'); node.remove();
    const imageUrl = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'], { type: 'image/svg+xml' }));
    const image = new Image(); image.src = imageUrl; await image.decode(); URL.revokeObjectURL(imageUrl);
  });
  assert.deepEqual(pageErrors, []);
  const remote = await tab.evaluate(async origin => {
    const image = new Image(); image.src = origin + '/image.svg'; await image.decode();
    const violations = []; const listener = e => violations.push(e.effectiveDirective);
    document.addEventListener('securitypolicyviolation', listener);
    let blocked = false; try { await fetch(origin + '/connection'); } catch { blocked = true; }
    await new Promise(resolve => setTimeout(resolve, 100)); document.removeEventListener('securitypolicyviolation', listener);
    return { blocked, violations };
  }, foreignOrigin);
  assert.equal(remoteImageRequests, 1); assert.equal(remoteConnections, 0);
  assert.deepEqual(remoteImageReferrers, [null], 'Remote image gets no page referrer');
  assert(remote.blocked && remote.violations.includes('connect-src'));
  mark('Pixi, Blob Worker/style/images and remote image without referrer work; foreign fetch is blocked before network access');
  const obs = await context.newPage(); await obs.goto(live.origin + '/overlay?key=' + encodeURIComponent(key));
  await obs.waitForFunction(() => window.ObsCss && document.querySelector('.view:not(.hidden)'));
  await obs.screenshot({ path: path.join(output, 'actual-overlay.png') });
  const parent = await context.newPage(), frameErrors = [];
  parent.on('console', msg => { if (/frame-ancestors|X-Frame-Options/i.test(msg.text())) frameErrors.push(msg.text()); });
  await parent.goto(foreignOrigin);
  await until(() => frameErrors.length, 'browser frame-ancestors enforcement', 15000);
  mark('Browser loads OBS with read-only key and refuses embedding native HTML in a foreign origin');
  await browser.close(); browser = null; await nativeBrowser.close(); nativeBrowser = null; await stop(live.child);
  const lan = await ready(start('ordinary-lan', false, '0.0.0.0'));
  const normal = await request(lan.origin, '/', { headers: { Host: 'configured-browser.example:' + lan.port, Authorization: 'Bearer ' + lan.discovery.token } });
  assert.equal(normal.status, 200); assert.equal(normal.headers['cache-control'], 'no-cache'); assert(!normal.headers['content-security-policy']);
  assert.equal((await request(lan.origin, '/v1/health', { headers: { Origin: 'http://configured-browser.example' } })).status, 200);
  await stop(lan.child);
  mark('Ordinary service keeps configurable LAN binding and existing browser HTML/Origin behavior');
  assert.equal(hash(binary), candidateHash); for (const [file, sha] of Object.entries(sourceHashes)) assert.equal(hash(path.join(root, file)), sha, 'Source unchanged: ' + file);
}
main().catch(error => { failures.push(redact(error.stack)); console.error(redact(error.stack)); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close().catch(() => {}); if (nativeBrowser) await nativeBrowser.close().catch(() => {});
  if (foreignServer) await new Promise(resolve => foreignServer.close(resolve));
  for (const child of [...owned]) await stop(child).catch(error => failures.push(redact(error.message)));
  fs.mkdirSync(output, { recursive: true });
  for (const row of processes) { fs.writeFileSync(path.join(row.data, 'stdout.log'), redact(row.child.out)); fs.writeFileSync(path.join(row.data, 'stderr.log'), redact(row.child.err)); }
  const report = { passed: failures.length === 0, binary, binarySha256: candidateHash, sourceSha256: sourceHashes, checks, failures,
    browserVersion, browserExecutable: process.env.PLAYWRIGHT_BROWSER_EXECUTABLE || chromium.executablePath(),
    processes: processes.map(({ child, ...row }) => ({ ...row, exitCode: child.exitCode, signalCode: child.signalCode })),
    cleanupScope: 'Only processes spawned by this script; existing programs and all test evidence retained', output };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(redact(report), null, 2));
  if (failures.length) process.exitCode = 1; console.log('Report: ' + path.join(output, 'report.json'));
});
