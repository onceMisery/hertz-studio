// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), source = path.join(root, 'tools/space-stage/src');
const output = path.join(root, 'output/playwright/space-lyrics');

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], evidence = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('https://space-stage.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<body style="margin:0"><canvas style="width:100vw;height:100vh;display:block"></canvas>' });
      const file = path.resolve(source, '.' + url.pathname);
      if (!file.startsWith(source + path.sep)) return route.abort();
      return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(file, 'utf8') });
    });
    await page.goto('https://space-stage.test/');
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/stage-runtime.js') });
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/space-stage.js') });
    await page.evaluate(async () => {
      const { createSpatialLyrics } = await import('/scenes/text.js');
      const canvas = document.querySelector('canvas');
      window.gl = canvas.getContext('webgl2');
      window.host = SpaceStagePure.create(canvas, { qualityMode: 'high', deviceTier: 2 });
      const def = SpaceStagePure.catalog().find(item => item.id === 'lyric-classic');
      for (const style of ['corridor', 'wipe', 'classic', 'cadenza', 'sonnet', 'tempera']) {
        SpaceStagePure.register({ ...def, id: 'test-lyrics-' + style, aliases: [], create(ctx) { window.lyricContext = ctx; return createSpatialLyrics(ctx, style); } });
      }
      SpaceStagePure.register({ ...def, id: 'test-bright-world', aliases: [], capabilities: {}, create(ctx) {
        ctx.scene.background = new ctx.THREE.Color(0x8a9d9b);
        return { update() {}, dispose() {} };
      } });
      await host.select('test-bright-world');
      const long = '\u5728\u661f\u5149\u4e0b\u542c\u89c1\u8fd9\u5ea7\u57ce\u5e02\u7684\u56de\u58f0\uff0c\u8ba9\u97f3\u4e50\u5e26\u6211\u4eec\u8d8a\u8fc7\u8fd9\u7247\u6d77\u6d0b\uff0c\u53bb\u66f4\u8fdc\u7684\u5730\u65b9';
      window.lines = ['\u591c\u98ce\u8f7b\u8f7b\u5439\u8fc7', 'We   sing, together', long, '\u8ba9\u6bcf\u4e00\u4e2a\u5b57\u90fd\u6e05\u6670\u53ef\u89c1', 'OneSupercalifragilisticexpialidociousWord', '\u4e0b\u4e00\u523b\u4ecd\u5728\u8fdc\u65b9'].map((text, i) => ({ text, start: i * 4, end: i * 4 + 4 }));
      window.now = 0;
      window.frame = (index = 2, time = 10, options = {}) => {
        host.frame({ now: now += 16, dt: .016, dynamicDt: .016, sceneTime: 2, time, playing: true,
          lyrics: { index, lines, progress: (time - index * 4) / 4 }, ...options });
      };
      window.readRows = () => {
        lyricContext.scene.updateMatrixWorld(true); lyricContext.camera.updateMatrixWorld(true);
        const result = [];
        lyricContext.scene.traverse(mesh => {
          if (!mesh.visible || !mesh.material?.uniforms?.uText) return;
          const bounds = new lyricContext.THREE.Box3().setFromObject(mesh), points = [];
          for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) {
            const p = new lyricContext.THREE.Vector3(x, y, mesh.position.z).project(lyricContext.camera); points.push(p);
          }
          result.push({ key: mesh.userData.lyricKey, x: mesh.position.x, y: mesh.position.y,
            current: mesh.material.uniforms.uCurrent.value === 1, fill: Array.from(mesh.material.uniforms.uFill.value),
            bounds: [Math.min(...points.map(p => p.x)), Math.min(...points.map(p => p.y)), Math.max(...points.map(p => p.x)), Math.max(...points.map(p => p.y))],
            texture: [mesh.material.uniforms.uText.value.image.width, mesh.material.uniforms.uText.value.image.height] });
        }); return result;
      };
      window.pixelHash = () => {
        const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
        let hash = 2166136261; for (let i = 0; i < data.length; i += 4) hash = Math.imul(hash ^ data[i] ^ data[i + 1] ^ data[i + 2], 16777619);
        return hash >>> 0;
      };
    });
    for (const style of ['corridor', 'wipe', 'classic', 'cadenza', 'sonnet', 'tempera']) {
      for (const [width, height] of [[1440, 900], [390, 844], [320, 568]]) {
        await page.setViewportSize({ width, height });
        const rows = await page.evaluate(async ({ style, width, height }) => {
          await host.selectLyrics('test-lyrics-' + style); host.resize(width, height);
          for (let i = 0; i < 8; i++) frame();
          return readRows();
        }, { style, width, height });
        const current = rows.find(row => row.current);
        assert.ok(current, style + ' has visible active text');
        assert.ok(current.texture[1] > 420, style + ' long lyric has multiple physical rows');
        assert.ok(current.bounds[0] >= -.92 && current.bounds[2] <= .92, style + ' complete long line fits horizontally');
        assert.ok(current.bounds[1] >= -.8 && current.bounds[3] <= .8, style + ' complete long line fits vertically');
        const sorted = rows.sort((a, b) => a.bounds[1] - b.bounds[1]);
        for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i - 1].bounds[3] <= sorted[i].bounds[1], style + ' adjacent multiline masks do not overlap');
        await page.screenshot({ path: path.join(output, style + '-' + width + '.png') });
        const transitions = await page.evaluate(() => {
          const previous = readRows().find(row => row.key.startsWith('12:'));
          frame(3, 12.01); const first = readRows().find(row => row.current);
          for (let i = 0; i < 90; i++) frame(3, 12.01);
          const settled = readRows().find(row => row.current);
          frame(1, 5, { playing: false, dynamicDt: 0 }); const seek = readRows().find(row => row.current);
          const a = pixelHash(); frame(1, 5, { playing: false, dynamicDt: 0 }); const b = pixelHash();
          frame(1, 6, { playing: false, dynamicDt: 0 }); const c = pixelHash();
          return { previous, first, settled, seek, a, b, c, stats: host.stats() };
        });
        assert.equal(transitions.previous.key, transitions.first.key, 'the next lyric retains its identity');
        assert.ok(Math.abs(transitions.first.y - transitions.previous.y) < 1.2, 'line advance has no position jump');
        assert.ok(Math.abs(transitions.settled.y) < .01, 'line settles at the reading anchor');
        assert.ok(Math.abs(transitions.seek.y) < .01, 'paused seek immediately aligns lyrics');
        assert.equal(transitions.a, transitions.b, 'paused redraw is stable');
        assert.notEqual(transitions.b, transitions.c, 'paused seek updates the glyph highlight');
        assert.ok(transitions.stats.textTextures <= 7, 'text cache remains bounded');
        evidence.push({ style, width, height, rows, transitions });
      }
    }
    await page.evaluate(() => host.dispose());
    assert.deepEqual(errors, [], 'no runtime or shader errors');
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('Space lyric browser checks passed: six styles, 320/390/1440px, wrapped bounds, no overlapping rows, smooth advance, paused seek and bright-world composition.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
