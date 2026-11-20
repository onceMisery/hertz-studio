// SPDX-License-Identifier: MIT
// Real Chrome workload checks, not AppContainer / G3-S qualification.
// PLAYWRIGHT_MODULE may point to an existing local Playwright installation.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const dgram = require('node:dgram');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'crates/hertz-desktop/assets/wallpaper-sandbox-renderer-probes.js'), 'utf8');
const native = fs.readFileSync(path.join(root, 'crates/hertz-desktop/src/wallpaper/worker_webview.rs'), 'utf8');
const csp = native.match(/pub const CSP: &str = "([^"]+)";/)[1];
const contract = fs.readFileSync(path.join(root, 'crates/hertz-desktop/src/wallpaper/worker_renderer_probe.rs'), 'utf8');
const caseIds = [...contract.match(/pub const NETWORK_CASES:[\s\S]*?= &\[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
const directory = path.join(root, 'output/offline-integration-20261120', `renderer-browser-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true });
const report = { softwareOnly: true, g3sQualified: false, sourceSha256: require('node:crypto').createHash('sha256').update(source).digest('hex'), checks: [] };
const listen = (server, host) => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, host, resolve);
});
const within = (promise, ms = 25000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('browser workload deadline')), ms);
  })]).finally(() => clearTimeout(timer));
};
async function main() {
  let browser;
  const observations = { tcp4: 0, tcp6: 0, udp4: 0 };
  const tcp4 = net.createServer(socket => { observations.tcp4++; socket.destroy(); });
  const tcp6 = net.createServer(socket => { observations.tcp6++; socket.destroy(); });
  const udp4 = dgram.createSocket('udp4'); udp4.on('message', () => observations.udp4++);
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/' ? 200 : 403, { 'Content-Type': 'text/html', 'Content-Security-Policy': csp });
    res.end('<!doctype html><html><head></head><body></body></html>');
  });
  try {
    await listen(server, '127.0.0.1'); await listen(tcp4, '127.0.0.1'); await listen(tcp6, '::1');
    await new Promise((resolve, reject) => { udp4.once('error', reject); udp4.bind(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    async function run(mode, setup) {
      const context = await browser.newContext({ acceptDownloads: false });
      const page = await context.newPage();
      const diagnostics = [];
      page.on('pageerror', error => { if (diagnostics.length < 40) diagnostics.push(error.message); });
      page.on('console', message => { if (message.type() === 'error' && diagnostics.length < 40) diagnostics.push(message.text()); });
      page.on('framenavigated', frame => { if (frame === page.mainFrame() && diagnostics.length < 40) diagnostics.push(`navigation: ${frame.url()}`); });
      let complete;
      const completed = new Promise(resolve => { complete = resolve; });
      const messages = [];
      await page.exposeFunction('probeMessage', raw => {
        const message = JSON.parse(raw); messages.push(message);
        if (message.type === 'rendererCompleted') complete(message.receipt);
      });
      try {
        await page.goto(base);
        await page.evaluate(() => {
          window.chrome ||= {}; window.chrome.webview = { postMessage: value => window.probeMessage(value) };
        });
        if (setup) await setup(page);
        // Route only test navigation; this is not a substitute for native event evidence.
        await context.route('**/*', route => route.abort('aborted'));
        page.on('popup', popup => popup.close().catch(() => {}));
        page.on('download', download => download.cancel().catch(() => {}));
        const targets = { tcp4: tcp4.address().port, tcp6: tcp6.address().port, udp4: udp4.address().port };
        // DevTools evaluation mirrors the paired native ExecuteScript injection;
        // no unsafe-eval allowance is added to the page's production policy.
        await page.evaluate(`void (window.probeExecution = (${source})(${JSON.stringify(mode)},${JSON.stringify(targets)}).catch(console.error))`);
        const receipt = await within(completed);
        (report.workloads ||= []).push({ mode, receipt });
        assert.equal(messages[0].type, 'probeStarted'); assert.equal(messages[0].mode, mode);
        assert.equal(messages.length, 2); assert.ok(Buffer.byteLength(JSON.stringify(messages[1])) < 8192);
        return { receipt, page, context };
      } catch (error) { report.diagnostics = diagnostics; await context.close(); throw error; }
    }
    const graphics = await run('graphicsPressure');
    try {
      assert.deepEqual(graphics.receipt, { kind: 'graphics', canvasRounds: 8, webGlRounds: 8,
        imageDecodeRounds: 8, videoDecodeRounds: 8, failure: null });
      report.checks.push({ name: 'eight actual pixel/codec/retirement rounds', passed: true, receipt: graphics.receipt });
    } finally { await graphics.context.close(); }
    const missing = await run('graphicsPressure', page => page.evaluate(() => { window.ImageDecoder = undefined; }));
    try {
      assert.equal(missing.receipt.failure, 'required codec API unavailable');
      assert.equal(missing.receipt.videoDecodeRounds, 0);
      report.checks.push({ name: 'unsupported codec cannot report success', passed: true });
    } finally { await missing.context.close(); }
    const late = await run('graphicsPressure', page => page.evaluate(() => {
      const Original = window.ImageDecoder, close = VideoFrame.prototype.close;
      window.closedProbeFrames = 0;
      VideoFrame.prototype.close = function () { window.closedProbeFrames++; return close.call(this); };
      window.ImageDecoder = class extends Original {
        async decode(...args) { const result = await super.decode(...args); await new Promise(resolve => setTimeout(resolve, 1900)); return result; }
      };
    }));
    try {
      assert.equal(late.receipt.failure, 'probe timeout');
      assert.equal(late.receipt.imageDecodeRounds, 0);
      await late.page.waitForFunction(() => window.closedProbeFrames === 1);
      report.checks.push({ name: 'late decoder output closed after timeout', passed: true });
    } finally { await late.context.close(); }
    const network = await run('rendererNetwork');
    try {
      assert.deepEqual(network.receipt.attempts.map(a => a.id), caseIds);
      for (const directive of ['connect-src', 'worker-src', 'img-src', 'frame-src', 'form-action'])
        assert.ok(network.receipt.violations.some(v => v.directive === directive), directive);
      assert.ok(network.receipt.attempts.every(a => ['rejected', 'dispatched'].includes(a.outcome)));
      assert.equal(network.receipt.rtcPhase, 'completed');
      report.checks.push({ name: 'fixed network paths and real CSP observations', passed: true, receipt: network.receipt,
        ordinaryChromeTransports: { ...observations }, scope: 'ordinary Chrome, no OS sandbox assertions' });
    } finally { await network.context.close(); }
    for (const phase of ['createOffer', 'setLocalDescription', 'gathering']) {
      const lateRtc = await run('rendererNetwork', page => page.evaluate(phase => {
        const nativeTimeout = window.setTimeout.bind(window);
        const pause = ms => new Promise(resolve => nativeTimeout(resolve, ms));
        window.rtcClosed = false; window.rtcCallsAfterClose = 0;
        window.RTCPeerConnection = class {
          createDataChannel() {}
          async createOffer() { if (phase === 'createOffer') await pause(1900); return {}; }
          async setLocalDescription() {
            if (window.rtcClosed) window.rtcCallsAfterClose++;
            if (phase === 'setLocalDescription') await pause(1900);
          }
          close() { window.rtcClosed = true; }
        };
        if (phase === 'gathering') {
          let stretched = false;
          window.setTimeout = (callback, ms, ...args) => {
            if (ms === 250 && !stretched) { stretched = true; ms = 1900; }
            return nativeTimeout(callback, ms, ...args);
          };
        }
      }, phase));
      try {
        assert.equal(lateRtc.receipt.rtcPhase, phase);
        assert.equal(lateRtc.receipt.attempts.find(a => a.id === 'rtcStun').outcome, 'timedOut');
        assert.deepEqual(await lateRtc.page.evaluate(() => [window.rtcClosed, window.rtcCallsAfterClose]), [true, 0]);
        report.checks.push({ name: `RTC timeout freezes ${phase} and retires late continuation`, passed: true });
      } finally { await lateRtc.context.close(); }
    }
    report.passed = true;
  } finally {
    await browser?.close();
    for (const listener of [server, tcp4, tcp6]) { listener.closeAllConnections?.(); await new Promise(resolve => listener.close(resolve)); }
    try { udp4.close(); } catch (_) { /* bind may have failed */ }
  }
}
main().catch(error => { report.passed = false; report.error = error.stack; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: directory, error: report.error }, null, 2));
});
