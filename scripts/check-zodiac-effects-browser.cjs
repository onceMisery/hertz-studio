// SPDX-License-Identifier: MIT
// Isolate sky breathing and particle recipes with a fixed WebGL camera.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { build } = require('../tools/zodiac-stage/node_modules/esbuild');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/zodiac-effects');

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const bundle = await build({
    stdin: { contents: "import * as THREE from 'three'; import {createWorld} from './src/world.js'; import {buildConstellation,CONSTELLATION} from './src/zodiac.js'; window.effects={THREE,createWorld,buildConstellation,CONSTELLATION};",
      resolveDir: path.join(root, 'tools/zodiac-stage') },
    bundle: true, format: 'iife', write: false, minify: true,
  });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const errors = [], shots = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setContent('<style>body{margin:0;background:#030405}canvas{display:block}</style><canvas></canvas>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      const { THREE, createWorld } = effects;
      const scene = new THREE.Scene();
      const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('canvas'), antialias: true, preserveDrawingBuffer: true });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.setSize(1440, 900);
      const camera = new THREE.PerspectiveCamera(42, 1440 / 900, .1, 300);
      const world = createWorld(THREE, scene, { quality: 'high' });
      world.setSign(4);
      window.draw = (time, context = {}, yaw = 0, surfaceEmission = null) => {
        camera.position.set(Math.sin(yaw) * 10, 0, Math.cos(yaw) * 10);
        camera.lookAt(0, 0, 0);
        world.update(time, { state: 'hold', k: 1, cameraPos: camera.position, ...context });
        if (context.particlesOnly) {
          scene.traverse(o => {
            if (o.renderOrder === -10 && o.material?.uniforms?.uTwinkle) o.material.uniforms.uTwinkle.value = 0;
          });
        }
        if (context.runnersOnly) {
          scene.traverse(o => {
            if (o.renderOrder === 12) o.material.uniforms.uTwinkle.value = 0;
          });
        }
        // Remove scene rotation so pixel differences measure shader motion only.
        scene.children.forEach(o => { if (o.isGroup) o.rotation.set(0, 0, 0); });
        scene.children.forEach(o => { if (o.isMesh && o.material.uniforms?.uTime) o.material.uniforms.uTime.value = 0; });
        const surfaceColors = [];
        if (surfaceEmission !== null) scene.traverse(o => {
          if (o.isMesh && o.renderOrder === -90) for (const name of ['uColor', 'uRim']) {
            const color = o.material.uniforms[name].value;
            surfaceColors.push([color, color.clone()]); color.multiplyScalar(surfaceEmission);
          }
        });
        renderer.render(scene, camera);
        const gl = renderer.getContext(), pixels = new Uint8Array(1440 * 900 * 4);
        gl.readPixels(0, 0, 1440, 900, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        surfaceColors.forEach(([color, original]) => color.copy(original));
        return pixels;
      };
      window.compare = (a, b) => {
        let changed = 0, total = 0, bright = 0;
        for (let k = 0; k < a.length; k += 4) {
          const delta = Math.abs(a[k]-b[k])+Math.abs(a[k+1]-b[k+1])+Math.abs(a[k+2]-b[k+2]);
          total += delta;
          if (delta > 9) changed++;
          if (Math.max(a[k],a[k+1],a[k+2]) > 30) bright++;
        }
        return { changed, total, bright };
      };
      window.world = world;
      window.scene = scene;
      window.dustFrame = (time, reduced = false) => {
        const visible = [];
        scene.traverse(o => {
          if (o.isMesh || o.isPoints) {
            visible.push([o,o.visible]);
            o.visible = o.renderOrder === -10;
          }
        });
        const pixels = draw(time, { reduced, particlesOnly: true });
        visible.forEach(([o,value]) => { o.visible = value; });
        return pixels;
      };
    });
    const breathing = await page.evaluate(() => {
      const context = { state: 'disperse', k: 1 };
      const a = draw(0, context), b = draw(4, context);
      const normal = compare(a, b), stable = compare(b, draw(4, context));
      const reduced = compare(draw(0, { ...context, reduced: true }), draw(4, { ...context, reduced: true }));
      return { normal, stable, reduced };
    });
    assert.ok(breathing.normal.bright > 100, 'Background stars must render');
    assert.ok(breathing.normal.changed > 100, 'Fixed-camera stars must breathe over time');
    assert.equal(breathing.stable.total, 0, 'Frozen time must freeze star breathing');
    assert.ok(breathing.reduced.total < breathing.normal.total * .6, 'Reduced motion must soften breathing');
    const colors = await page.evaluate(() => {
      // The application supplies its theme accent even when all signs share it.
      world.setPalette({ accent: '#276eff' });
      const background = draw(4, { state: 'disperse', k: 1 });
      const skyObjects = [];
      scene.traverse(o => { if (o.renderOrder <= -880 && (o.isMesh || o.isPoints)) skyObjects.push(o); });
      const out = [];
      for (let i = 0; i < 12; i++) {
        world.setSign(i);
        const skyDelta = compare(background, draw(4, { state: 'disperse', k: 1 })).total;
        skyObjects.forEach(o => { o.visible = false; });
        const pixels = draw(5.2), rgb = [0, 0, 0], hueBands = Array(12).fill(0);
        skyObjects.forEach(o => { o.visible = true; });
        for (let k = 0; k < pixels.length; k += 4) {
          const max = Math.max(pixels[k],pixels[k+1],pixels[k+2]);
          const min = Math.min(pixels[k],pixels[k+1],pixels[k+2]);
          if (max > 40 && (max-min)/max > .22) {
            for (let c = 0; c < 3; c++) rgb[c] += pixels[k+c];
            const r = pixels[k], g = pixels[k+1], b = pixels[k+2], d = max-min;
            const h = ((max === r ? (g-b)/d : max === g ? (b-r)/d+2 : (r-g)/d+4)+6)%6;
            hueBands[Math.floor(h*2)]++;
          }
        }
        const total = rgb.reduce((a,b)=>a+b,0);
        const max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min;
        let hue = max === rgb[0] ? (rgb[1]-rgb[2])/delta : max === rgb[1]
          ? (rgb[2]-rgb[0])/delta+2 : (rgb[0]-rgb[1])/delta+4;
        hue = (hue * 60 + 360) % 360;
        out.push({ sign: world.stats().sign, rgb: rgb.map(v=>v/total), hue, hueBands, skyDelta });
      }
      world.setSign(4);
      return out;
    });
    assert.ok(colors.every(c => c.skyDelta === 0), 'Sign colors must not tint the natural sky');
    assert.ok(new Set(colors.map(c=>c.rgb.map(v=>v.toFixed(2)).join(','))).size >= 8,
      'A shared application theme must preserve independent sign colors');
    // Each figure now mixes silk-like cool/warm streams. An average RGB hue
    // cannot describe a multicolor figure; measure its visible hue populations.
    const colorFor = sign => colors.find(c=>c.sign===sign).hueBands;
    assert.ok(['aries','leo'].every(sign => colorFor(sign).slice(0, 3).reduce((a,b)=>a+b,0) > 100),
      'Coral and amber remain visible within the multicolor particles');
    assert.ok(colorFor('taurus').slice(2, 6).reduce((a,b)=>a+b,0) > 100, 'Jade remains visible');
    assert.ok(colorFor('sagittarius').slice(8, 12).reduce((a,b)=>a+b,0) > 100, 'Violet remains visible');
    assert.ok(colors.every(c => c.hueBands.filter(n=>n>25).length >= 2), 'Every sign contains multiple visible hues');
    assert.ok(new Set(colors.flatMap(c=>c.hueBands.flatMap((n,i)=>n>25?[i]:[]))).size >= 8,
      'Zodiac particles span at least eight visible hue bands');
    const galaxy = await page.evaluate(() => {
      const pixels = draw(4, { state: 'disperse', k: 1 });
      let stars = 0, dust = 0, dark = 0;
      for (let k = 0; k < pixels.length; k += 4) {
        const r = pixels[k], g = pixels[k+1], b = pixels[k+2];
        if (Math.max(r,g,b) > 40 && Math.max(r,g,b)-Math.min(r,g,b) < 35) stars++;
        if (r > 8 && b > g*1.2 && r > g*1.15 && b < 60) dust++;
        if (Math.max(r,g,b) < 12) dark++;
      }
      const sky = scene.children.find(o => o.isMesh && o.renderOrder === -1000);
      const texture = sky.material.uniforms.uGalaxy.value;
      let peak = 0, warm = 0, cool = 0;
      const data = texture.image.data;
      for (let i = 0; i < data.length; i += 4) {
        peak = Math.max(peak, data[i], data[i + 1], data[i + 2]);
        if (data[i] > 40 && data[i] > data[i + 2] * 1.05) warm++;
        if (data[i + 2] > 25 && data[i + 2] > data[i] * 1.2) cool++;
      }
      let disposed = false;
      texture.addEventListener('dispose', () => { disposed = true; });
      window.galaxyDisposed = () => disposed;
      return { stars, dust, dark, pixels: pixels.length/4, width: texture.image.width, peak, warm, cool };
    });
    assert.ok(galaxy.stars > 2000, 'Milky Way must have dense photographic pinpoints: ' + JSON.stringify(galaxy));
    assert.ok(galaxy.dust > 10000 && galaxy.dust < galaxy.pixels*.5, 'Lavender dust must remain localized');
    assert.ok(galaxy.dark > galaxy.pixels*.5, 'Most of the sky must remain near black: ' + JSON.stringify(galaxy));
    assert.equal(galaxy.width, 2048, 'High quality must use a detailed, pre-baked dust texture');
    assert.ok(galaxy.peak > 90, 'The galactic core must have localized highlights, not a flat dim wash');
    assert.ok(galaxy.warm > 1000 && galaxy.cool > 10000, 'Warm core and cool dust must both occupy visible areas');
    const starlight = await page.evaluate(() => {
      const full = draw(5.2);
      let surface;
      scene.traverse(o => { if (o.isMesh && o.renderOrder === -90) surface = o; });
      // Keep absorption unchanged so the difference measures emission, not the sky behind it.
      const emission = draw(5.2, {}, 0, 0);
      surface.visible = false;
      const dustOnly = draw(5.2);
      surface.visible = true;
      let energy = 0, hidden = 0;
      for (let k = 0; k < full.length; k += 4) {
        energy += full[k] + full[k+1] + full[k+2];
        const free = dustOnly[k] + dustOnly[k+1] + dustOnly[k+2];
        if (free - (full[k] + full[k+1] + full[k+2]) > 12) hidden += 1;
      }
      const a = dustFrame(5.2), b = dustFrame(6.2);
      const flow = compare(a,b);
      const frozen = compare(b,dustFrame(6.2));
      const reducedFlow = compare(dustFrame(5.2,true),dustFrame(6.2,true));
      return { surfaceFraction: compare(full, emission).total / energy, hidden,
        occluded: compare(full, dustOnly).total / energy, flow, frozen, reducedFlow };
    });
    assert.ok(starlight.surfaceFraction < .10,
      'Starlight figures must be carried by particles and stars, not a solid surface: ' + JSON.stringify(starlight));
    assert.ok(starlight.hidden > 1500,
      'The volume must hide the light behind it, or it is only a glowing decal: ' + JSON.stringify(starlight));
    assert.ok(starlight.flow.changed > 100, 'Particle flow must remain visible with fixed camera and no star twinkle');
    assert.equal(starlight.frozen.total, 0, 'Frozen playback time must freeze the star-dust flow');
    assert.ok(starlight.reducedFlow.total < starlight.flow.total * .6,
      'Reduced motion must soften the star-dust flow');
    const sweep = await page.evaluate(() => {
      const samples = [];
      for (let frame = 0; frame < 16; frame++) {
        const pixels = dustFrame(5.2 + frame * (Math.PI * 2 / 3.1 / 16));
        const strips = new Array(24).fill(0);
        for (let k = 0; k < pixels.length; k += 4) {
          strips[Math.floor(((k / 4) % 1440) / 60)] += pixels[k] + pixels[k+1] + pixels[k+2];
        }
        samples.push(strips);
      }
      const contrasts = [], peaks = [];
      for (let strip = 0; strip < 24; strip++) {
        const values = samples.map(s => s[strip]);
        const lo = Math.min(...values), hi = Math.max(...values);
        if (lo > 1000) {
          contrasts.push(hi / lo);
          peaks.push(values.indexOf(hi));
        }
      }
      contrasts.sort((a,b) => a-b);
      return { medianContrast: contrasts[Math.floor(contrasts.length / 2)],
        peakPhases: new Set(peaks).size, strips: contrasts.length };
    });
    assert.ok(sweep.strips >= 8 && sweep.medianContrast > 2.1,
      'Approved A must have a visible narrow sweep, not slight global shimmer: ' + JSON.stringify(sweep));
    assert.ok(sweep.peakPhases >= 5, 'Bright sweep must travel through different parts of the figure');
    const runners = await page.evaluate(() => {
      let stars;
      scene.traverse(o => { if (o.isPoints && o.renderOrder === 12) stars = o; });
      const marker = stars.geometry.getAttribute('aRunner');
      const count = marker ? Array.from(marker.array).filter(v => v > 0).length : 0;
      const expected = world.stats().constellationSegments;
      const aligned = [];
      for (let sign = 0; sign < 12; sign++) {
        world.setSign(sign);
        const line = effects.buildConstellation(sign);
        const pos = stars.geometry.getAttribute('position').array;
        const target = stars.geometry.getAttribute('aTarget');
        const flags = stars.geometry.getAttribute('aRunner');
        aligned.push(!!target && !!flags && effects.CONSTELLATION[sign].lines.every(([a,b],k) => {
          const slot = 18 + k;
          return flags.array[slot] === k + 1 && [line.x[a],line.y[a],line.z[a]].every((v,c) => v === pos[slot*3+c])
            && [line.x[b],line.y[b],line.z[b]].every((v,c) => v === target.array[slot*3+c]);
        }));
      }
      world.setSign(4);
      const frame = (time, context = {}) => {
        const visible = [];
        scene.traverse(o => {
          if (o.isMesh || o.isPoints) {
            visible.push([o,o.visible]);
            o.visible = o === stars;
          }
        });
        const range = { ...stars.geometry.drawRange };
        stars.geometry.setDrawRange(18, expected);
        const pixels = draw(time, { runnersOnly: true, ...context });
        stars.geometry.setDrawRange(range.start, range.count);
        visible.forEach(([o,value]) => { o.visible = value; });
        return pixels;
      };
      const a = frame(5.2), b = frame(6.2);
      return { count, expected, aligned, flow: compare(a,b), frozen: compare(b,frame(6.2)),
        reduced: compare(frame(5.2,{reduced:true}),frame(6.2,{reduced:true})),
        hidden: compare(frame(1,{state:'gather',k:0}),frame(2,{state:'disperse',k:1})) };
    });
    assert.equal(runners.count, runners.expected, 'Every authored star link must carry an A-style moving light');
    assert.ok(runners.aligned.every(Boolean), 'Moving lights must follow authored link endpoints for all twelve signs');
    assert.ok(runners.flow.bright > 25 && runners.flow.changed > 25, 'Link lights must visibly move without star twinkle');
    assert.equal(runners.frozen.total, 0, 'Frozen playback must freeze link lights');
    assert.ok(runners.reduced.total < runners.flow.total * .6, 'Reduced motion must soften link lights');
    assert.equal(runners.hidden.bright, 0, 'Link lights must vanish outside the visible figure lifecycle');
    await page.evaluate(() => { world.setFieldVisible(false); });
    const recipes = [];
    for (const state of ['gather', 'disperse']) {
      const hashes = new Set();
      for (let cycle = 0; cycle < 8; cycle++) {
        const data = await page.evaluate(({ state, cycle }) => {
          const pixels = draw(1.4, { state, cycle, k: .4 });
          let hash = 2166136261, lit = 0;
          for (let k = 0; k < pixels.length; k += 4) {
            hash = Math.imul(hash ^ pixels[k], 16777619);
            hash = Math.imul(hash ^ pixels[k+1], 16777619);
            if (pixels[k+2] > 40) lit++;
          }
          return { hash: hash >>> 0, lit, png: document.querySelector('canvas').toDataURL(), recipe: world.stats().transition };
        }, { state, cycle });
        assert.ok(data.lit > 200, state + cycle + ': moving particles must render');
        hashes.add(data.hash);
        const name = state + '-' + cycle;
        fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data.png.split(',')[1], 'base64'));
        shots.push({ name, png: data.png });
        recipes.push({ state, cycle, hash: data.hash, lit: data.lit, recipe: data.recipe });
      }
      assert.equal(hashes.size, 8, state + ': all eight recipes must produce distinct pixels');
    }
    await page.evaluate(() => { world.setFieldVisible(true); });
    for (const [name, yaw] of [['front', 0], ['side', .85]]) {
      const png = await page.evaluate(yaw => { draw(5.2, {}, yaw); return document.querySelector('canvas').toDataURL(); }, yaw);
      fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(png.split(',')[1], 'base64'));
      shots.push({ name, png });
    }
    await page.evaluate(() => world.dispose());
    assert.equal(await page.evaluate(() => galaxyDisposed()), true, 'Unmount must dispose the baked galaxy texture');
    await page.setContent('<style>body{margin:0;background:#030405;color:#eee;font:14px system-ui}main{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:8px}figure{margin:0}img{display:block;width:100%}figcaption{padding:4px}</style><main>'
      + shots.map(s => '<figure><img src="' + s.png + '"><figcaption>' + s.name + '</figcaption></figure>').join('') + '</main>');
    await page.screenshot({ path: path.join(output, 'contact-sheet.jpg'), fullPage: true });
    assert.deepEqual(errors, [], 'No WebGL or shader errors');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ breathing, galaxy, colors, starlight, sweep, runners, recipes, errors }, null, 2));
    console.log(JSON.stringify({ sweep, runners }));
    console.log(JSON.stringify(breathing));
    console.log('PASS breathing, twelve independent colors under shared theme, unchanged sky, motion variants and side captures');
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
