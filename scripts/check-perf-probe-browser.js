#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
'use strict';

// Default: shipped UI/scripts in a local fixture, with only app.js startup removed.
// PERF_PROBE_URL: verify the rebuilt service's real document/assets and app startup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiUrl } = require('./ui-token');
const root = path.resolve(__dirname, '..', 'plugin', 'ui');

async function main() {
  let server;
  let browser;
  try {
    let base = process.env.PERF_PROBE_URL;
    const live = !!base;
    if (!live) {
      server = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
        const file = path.resolve(root, rel);
        if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
        try {
          let body = fs.readFileSync(file);
          if (rel === 'index.html') body = Buffer.from(body.toString().replace(/<script\b[^>]*src="app\.js"[^>]*><\/script>/, ''));
          res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
          res.end(body);
        } catch (_) { res.writeHead(404); res.end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      base = 'http://127.0.0.1:' + server.address().port;
    }
    for (const file of ['perf-probe.js', 'stage.js']) {
      const response = await fetch(base + '/' + file);
      assert.equal(response.status, 200, file + ' is served');
      assert.equal((await response.text()).replace(/\r\n/g, '\n'), fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n'), file + ' matches current source');
    }
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(live ? uiUrl(base) : base);
    await page.waitForFunction(() => window.HertzPerf && window.Stage && window.Stage3D && window.CreativeStage && window.Backgrounds);
    if (live) await page.waitForFunction(() => document.getElementById('conn').textContent === '服务已连接');
    else await page.evaluate(() => { Stage.init(); CreativeStage.init(); });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      HertzPerf.reset();
      window.__perfCalls = 0;
      Stage.gate('perf-check', () => 30, () => {
        window.__perfCalls++;
        const end = performance.now() + 1;
        while (performance.now() < end) { /* Measured synthetic work on the real scheduler. */ }
      });
    });
    await page.waitForTimeout(1400);
    const result = await page.evaluate(() => {
      const snap = HertzPerf.snapshot();
      const metric = snap.metrics['gate.perf-check'];
      return {
        sourceCount: snap.sourceCount,
        sourceNames: Object.keys(snap.sources).sort(),
        stage3dKeys: Object.keys(snap.sources.stage3d).sort(),
        measuredCalls: metric?.count,
        actualCalls: window.__perfCalls,
        costMs: metric?.totalMs,
        measuredRunsPerSecond: metric ? Math.round(metric.count * 10000 / snap.sinceResetMs) / 10 : 0,
        sampleWindowMs: snap.sinceResetMs,
        displayHz: snap.sources.stage.displayHz,
        gateBudget: snap.sources.stage.gates.find(gate => gate.name === 'perf-check'),
        gateMetrics: Object.keys(snap.metrics).sort(),
        ranked: snap.topByTotal.some(item => item.name === 'gate.perf-check'),
        sourceErrors: snap.sourceErrors || null
      };
    });
    console.log(JSON.stringify({ mode: live ? 'live-service' : 'shipped-ui-fixture', ...result }));
    assert.equal(result.sourceCount, 4);
    assert.deepEqual(result.sourceNames, ['backgrounds', 'creative', 'stage', 'stage3d']);
    assert.deepEqual(result.stage3dKeys, ['costMs', 'divisor', 'dpr', 'fps', 'hz', 'pressure', 'quality']);
    assert.equal(result.sourceErrors, null);
    assert.ok(result.actualCalls > 5, 'real scheduler ran the diagnostic gate');
    assert.equal(result.measuredCalls, result.actualCalls, 'probe counts match actual callbacks');
    assert.ok(result.costMs >= result.actualCalls * 0.8, 'probe measures callback cost');
    assert.ok(result.measuredRunsPerSecond <= 35, '30fps budget stays bounded after refresh-rate convergence');
    assert.ok(result.ranked, 'real gate appears in global cost ranking');
    await page.evaluate(() => { for (const gate of Stage.gateRates()) Stage.removeGate(gate.name); });
    await page.waitForTimeout(100);
    const stopped = await page.evaluate(() => JSON.stringify(HertzPerf.summary().metrics));
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => JSON.stringify(HertzPerf.summary().metrics)), stopped, 'stopped scheduler does not produce samples');
    assert.deepEqual(errors, [], 'no browser runtime errors');
    console.log('Performance probe: real scheduler counts/costs, four stats owners, whitelist and stop behavior passed.');
  } finally {
    if (browser) await browser.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
