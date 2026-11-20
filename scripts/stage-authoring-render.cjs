// SPDX-License-Identifier: MIT
// Trusted offline renderer fixture. Only validated numeric recipe data crosses into the page.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const L = require('./stage-authoring-lib.cjs');
const PROFILES = Object.freeze([
  { name: 'low', quality: 0, width: 320, height: 180, dpr: 1 },
  { name: 'medium', quality: 1, width: 480, height: 270, dpr: 1 },
  { name: 'high', quality: 2, width: 640, height: 360, dpr: 1 },
  { name: 'high-dpr2', quality: 2, width: 320, height: 180, dpr: 2 },
]);
async function render(payload) {
  const { chromium } = require(payload.playwrightPath);
  const errors = [], deniedRequests = [];
  const browser = await chromium.launch({ executablePath: payload.browserPath, headless: true,
    env: L.cleanEnv(payload.scratch), downloadsPath: payload.scratch,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--no-first-run', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND',
      '--js-flags=--max-old-space-size=128'] });
  let context;
  const result = { browserVersion: browser.version(), profiles: [], errors, deniedRequests,
    scope: 'Fixed source renderer probe with synthetic audio and deterministic phase. No host, skin, user media or physical-device qualification.',
    sandbox: { untrustedExecutableInput: false, freshBrowserProfile: true, network: 'browser-context-offline plus request-abort and DNS denial; not OS network isolation',
      workerHeapMiB: L.LIMITS.renderHeapMiB, browserJsHeapMiB: 128,
      osCpuMemoryIoIsolation: 'pending', processTreeWallLimitMs: L.LIMITS.renderMs },
    browserClosed: false, contextClosed: false };
  try {
    context = await browser.newContext({ offline: true, serviceWorkers: 'block', acceptDownloads: false,
      viewport: { width: 700, height: 420 }, permissions: [] });
    await context.route('**/*', route => { deniedRequests.push(route.request().url().slice(0, 256)); return route.abort('blockedbyclient'); });
    const denialProbe = await context.newPage();
    let navigationRejected = false;
    try { await denialProbe.goto('http://authoring-network-probe.invalid/', { timeout: 3000 }); }
    catch { navigationRejected = true; }
    finally { await denialProbe.close(); }
    L.ensure(navigationRejected && deniedRequests.length === 1, 'browser network denial probe failed');
    result.networkDenialProbe = { navigationRejected, interceptedRequests: deniedRequests.splice(0) };
    for (const profile of PROFILES) {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.setContent('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; worker-src \'none\'; object-src \'none\'"><style>body{margin:0;background:#11161c}canvas{display:block}</style><canvas id="candidate"></canvas>');
        for (const name of ['stage-resource-budget.js', 'stage-resource-policy.js', 'creative-gl.js']) {
          await page.addScriptTag({ content: fs.readFileSync(path.join(payload.sourceRoot, 'plugin/ui', name), 'utf8') });
        }
        const evidence = await page.evaluate(async ({ preset, profile, frames }) => {
          const ledger = StageResourceBudget.create(StageResourcePolicy);
          const canvas = document.getElementById('candidate');
          canvas.width = canvas.height = 1;
          canvas.style.width = profile.width + 'px'; canvas.style.height = profile.height + 'px';
          const baseline = ledger.snapshot(), hostPort = ledger.port('authoring-canvas');
          const canvasTicket = hostPort.require({ canvases: 1 }, 'Fixed authoring canvas', 0);
          let engine = null;
          const samples = [], images = [], resourceSamples = [];
          const heldZero = value => Object.values(value).every(count => count === 0);
          function makeEngine() {
            const value = CreativeGL.create(canvas, { quality: profile.quality, resources: ledger.port('authoring-renderer') });
            if (!value) throw new Error('WebGL2 unavailable');
            if (value.resize(profile.width, profile.height, profile.dpr) === false) throw new Error('renderer surface budget refused');
            return value;
          }
          function state(frame) {
            const time = frame * 1000 / 60, radians = Math.PI / 180;
            const bands = new Float32Array(64), rises = new Float32Array(64);
            for (let i = 0; i < bands.length; i++) { bands[i] = .2 + .5 * (1 + Math.sin(i * .37 + time / 500)) / 2; rises[i] = .1; }
            const rot = preset.stage.rotY * radians, scale = preset.stage.scale, c = Math.cos(rot) * scale, s = Math.sin(rot) * scale;
            return { scene: preset.scene, quality: profile.quality, t: time, dt: 1000 / 60,
              bands, rises, agg: [.35, .4, .3, .2], pulse: .2, energy: .4, play: true, seed: preset.stage.seed,
              p: preset.sc, colors: [[.22, .7, .85], [.83, .35, .56]], post: preset.look,
              cam: { yaw: preset.cam.yaw * radians, pitch: preset.cam.pitch * radians,
                dist: preset.cam.dist, fov: preset.cam.fov, tx: 0, ty: preset.cam.height, tz: 0, roll: 0 },
              modelMatrix: new Float32Array([c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0, 0, 0, 0, 1]) };
          }
          function draw(frame, capture) {
            const start = performance.now(), response = engine.render(state(frame));
            if (!response.ok) throw new Error('render failed: ' + JSON.stringify(response));
            const gl = engine.gl; gl.finish();
            const elapsedMs = performance.now() - start;
            if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error after draw');
            if (capture) {
              const pixels = new Uint8Array(canvas.width * canvas.height * 4);
              gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
              let visible = 0, hash = 2166136261, maxColor = 0;
              for (let i = 0; i < pixels.length; i++) {
                hash = Math.imul(hash ^ pixels[i], 16777619) >>> 0;
                if ((i & 3) === 3 && pixels[i] > 0) visible++;
                if ((i & 3) !== 3) maxColor = Math.max(maxColor, pixels[i]);
              }
              if (!visible || !maxColor) throw new Error('render produced an empty image');
              images.push({ label: capture, width: canvas.width, height: canvas.height,
                visiblePixels: visible, pixelHash: hash, png: canvas.toDataURL('image/png') });
            }
            return elapsedMs;
          }
          let firstMs, warmupMs, contextLost = false, rejectedAfterLoss = false, recreated = false, renderer, warmResources;
          try {
            engine = makeEngine();
            const gl = engine.gl, info = gl.getExtension('WEBGL_debug_renderer_info');
            renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
            firstMs = draw(0, 'first');
            const warmStart = performance.now();
            if (!engine.warmUp(preset.scene)) throw new Error('shader warmup failed');
            warmupMs = performance.now() - warmStart; warmResources = ledger.snapshot();
            for (let i = 1; i <= frames; i++) {
              samples.push(draw(i, i === frames ? 'warm' : null));
              if (i % 30 === 0) resourceSamples.push(ledger.snapshot().held);
              if (i % 15 === 0) await new Promise(resolve => setTimeout(resolve, 0));
            }
            if (resourceSamples.some(sample => JSON.stringify(sample) !== JSON.stringify(warmResources.held)))
              throw new Error('resources grew after warmup');
            const lose = engine.gl.getExtension('WEBGL_lose_context');
            if (!lose) throw new Error('context-loss probe unavailable');
            const lost = new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('context-loss event timeout')), 3000);
              canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); clearTimeout(timer); resolve(); }, { once: true });
            });
            lose.loseContext(); await lost; contextLost = engine.isLost();
            rejectedAfterLoss = engine.render(state(1)).reason === 'context-lost';
            engine.dispose();
            if (engine.resources().cleanupFailed) throw new Error('renderer cleanup after loss failed');
            // A new canvas is the host recovery boundary; never revive disposed resources.
            const replacement = document.createElement('canvas'); replacement.width = replacement.height = 1;
            const recovered = CreativeGL.create(replacement, { quality: profile.quality, resources: ledger.port('authoring-recovery') });
            if (!recovered) throw new Error('context recovery failed');
            try {
              recovered.resize(profile.width, profile.height, profile.dpr);
              recreated = recovered.render(state(1)).ok; recovered.gl.finish();
            } finally { recovered.dispose(); replacement.remove(); }
            if (!recreated) throw new Error('recreated renderer did not draw');
          } finally {
            if (engine) engine.dispose();
            canvas.width = canvas.height = 0; canvas.remove();
            canvasTicket.release({ apiReleased: true, allocationEnded: true });
          }
          const after = ledger.snapshot();
          if (!heldZero(after.held) || after.violations.length || after.rejections) throw new Error('resource release or budget probe failed');
          samples.sort((a, b) => a - b);
          return { profile, passed: true, renderer, frames, firstFrameMs: firstMs, warmupMs,
            frameMs: { median: samples[Math.floor(samples.length / 2)], p95: samples[Math.floor(samples.length * .95)], max: samples.at(-1),
              meaning: 'native CPU submission plus gl.finish; not display FPS or physical GPU capacity' },
            images, resources: { baseline: baseline.held, warm: warmResources.held, stableSamples: resourceSamples,
              peak: after.peak, after: after.held, released: true, violations: after.violations, rejections: after.rejections },
            contextLost, rejectedAfterLoss, recreated, longRunQualification: 'pending; bounded 90-frame resource probe only' };
        }, { preset: payload.preset, profile, frames: L.LIMITS.frames });
        result.profiles.push(evidence);
      } finally { await page.close(); }
    }
    L.ensure(!errors.length && !deniedRequests.length, 'unexpected renderer error or resource request');
    result.passed = result.profiles.length === PROFILES.length && result.profiles.every(item => item.passed);
  } finally {
    if (context) { await context.close(); result.contextClosed = true; }
    await browser.close(); result.browserClosed = true;
  }
  result.process = { envKeys: Object.keys(process.env).sort(), maxRssKiB: process.resourceUsage().maxRSS, cpuMicroseconds: process.cpuUsage() };
  return result;
}
if (require.main === module) {
  L.scrubProcessEnv(process.cwd());
  L.stdinJson().then(render).then(result => process.stdout.write(JSON.stringify(result)))
    .catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
}
module.exports = { render, PROFILES };
