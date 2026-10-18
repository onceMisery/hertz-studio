// SPDX-License-Identifier: MIT
// Capture all twelve figures in desktop and portrait WebGL viewports.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/zodiac-reference/after');

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const errors = [], report = [], images = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setContent('<style>body{margin:0}canvas{display:block;width:100vw;height:100vh}</style><canvas></canvas>');
    await page.evaluate(() => {
      const callbacks = new Map();
      let serial = 0, now = 1000;
      window.requestAnimationFrame = fn => { callbacks.set(++serial, fn); return serial; };
      window.cancelAnimationFrame = id => callbacks.delete(id);
      window.step = time => {
        ZodiacStagePure.setTime({ time, playing: true });
        ZodiacStagePure.setAudio({ bands: new Float32Array(64).fill(.08) });
        now += 16.67;
        const run = [...callbacks.values()]; callbacks.clear(); run.forEach(fn => fn(now));
      };
    });
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/zodiac-stage.js') });
    assert.equal(await page.evaluate(() => ZodiacStagePure.mount(document.querySelector('canvas'),
      { quality: 'high', reduced: true, interactive: true })), true);
    for (const [width, height, suffix] of [[1440,900,''], [390,844,'-mobile']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => ZodiacStagePure.resize(innerWidth, innerHeight));
      for (let i = 0; i < 12; i++) {
        const data = await page.evaluate(i => {
          for (let n = 0; n < 8; n++) step(i * 13 + 5.2);
          ZodiacStagePure.capture();
          const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl2');
          const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
          const pixels = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          let bright = 0;
          let hueX = 0, hueY = 0, colored = 0;
          const dark = [];
          for (let k = 0; k < pixels.length; k += 4) {
            if (pixels[k] > 190 && pixels[k + 1] > 190 && pixels[k + 2] > 190) bright++;
            const r = pixels[k], g = pixels[k+1], b = pixels[k+2];
            const max = Math.max(r,g,b), min = Math.min(r,g,b), delta = max-min;
            if (max > 40 && delta/max > .22) {
              let hue = max === r ? (g-b)/delta : max === g ? (b-r)/delta+2 : (r-g)/delta+4;
              hue *= Math.PI/3;
              const weight = delta/max;
              hueX += Math.cos(hue)*weight; hueY += Math.sin(hue)*weight; colored++;
            }
            const px=(k/4)%w, py=Math.floor(k/4/w);
            if(px<w*.15 && py<h*.15)dark.push([pixels[k],pixels[k+1],pixels[k+2]]);
          }
          const median = c => dark.map(p=>p[c]).sort((a,b)=>a-b)[Math.floor(dark.length/2)];
          return { png: canvas.toDataURL(), bright, colored, hue: (Math.atan2(hueY,hueX)*180/Math.PI+360)%360,
            background: [median(0),median(1),median(2)], stats: ZodiacStagePure.stats() };
        }, i);
        assert.equal(data.stats.signIndex, i);
        assert.equal(data.stats.state, 'hold');
        assert.ok(Math.abs(data.stats.dist - data.stats.distDefault) < .01,
          data.stats.sign + suffix + ': default camera must fit the viewport without distance-cap clipping');
        assert.ok(data.bright > 30, data.stats.sign + suffix + ': WebGL artwork is blank');
        // 113 = 十二座 × 9 个预建几何 + 天空 + 星场 + 星云 + 四芒星 + 流星。
        assert.equal(data.stats.geometries, 113);
        assert.ok(Math.max(...data.background)<22 && data.background[2]-data.background[0]<10,
          'Natural sky must stay near black, not a blue wash: '+data.background);
        fs.writeFileSync(path.join(output, data.stats.sign + suffix + '.png'),
          Buffer.from(data.png.split(',')[1], 'base64'));
        report.push({ sign: data.stats.sign, width, height, bright: data.bright,
          hue: data.hue, colored: data.colored, background: data.background,
          dist: data.stats.dist, distDefault: data.stats.distDefault,
          triangles: data.stats.figureTriangles, geometries: data.stats.geometries });
        if (!suffix) images.push({ cn: data.stats.signCn, png: data.png });
      }
    }
    for (const width of [1440, 390]) {
      const views = report.filter(v => v.width === width);
      // Pale silver and rose can fall below the saturation cutoff with starlight materials.
      assert.ok(views.filter(v => v.colored > 100).length >= 9,
        'Most zodiac figures must retain clearly colored starlight: ' + views.map(v => v.sign + '=' + v.colored + ' hue=' + v.hue.toFixed(1)).join(', '));
      // Whole-frame hue includes the lavender Milky Way. Isolated foreground
      // color families are checked by check-zodiac-effects-browser.cjs.
    }
    await page.mouse.move(195, 422);
    await page.mouse.wheel(0, 500);
    const zoomed = await page.evaluate(() => ZodiacStagePure.debug());
    assert.ok(zoomed.zoom > 1 && zoomed.dist > zoomed.distDefault, 'Portrait zoom-out must work');
    await page.setViewportSize({ width: 1440, height: 900 });
    const resized = await page.evaluate(() => {
      ZodiacStagePure.resize(innerWidth, innerHeight);
      return ZodiacStagePure.debug();
    });
    assert.equal(resized.zoom, zoomed.zoom, 'Resize must preserve user zoom');
    await page.mouse.dblclick(720, 450);
    const reset = await page.evaluate(() => ZodiacStagePure.debug());
    assert.equal(reset.zoom, 1);
    assert.ok(Math.abs(reset.dist - reset.distDefault) < .01, 'Double-click must reset framing');
    await page.evaluate(() => ZodiacStagePure.unmount());
    await page.setViewportSize({ width: 1440, height: 1016 });
    await page.setContent('<style>body{margin:0;background:#030405;color:#dce7f5;font:14px system-ui}'
      + 'main{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:8px}'
      + 'figure{margin:0}img{display:block;width:100%;aspect-ratio:1.6}figcaption{padding:4px 8px}</style>'
      + '<main>' + images.map(i => '<figure><img src="' + i.png + '"><figcaption>'
        + i.cn + '</figcaption></figure>').join('') + '</main>');
    await page.screenshot({ path: path.join(output, 'contact-sheet.jpg'), fullPage: true });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ views: report, errors }, null, 2));
    assert.deepEqual(errors, []);
    console.log('PASS 24 artwork captures: visible starlight, natural sky, framing, bounded GPU resources, no shader errors');
    console.log(path.join(output, 'contact-sheet.jpg'));
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
