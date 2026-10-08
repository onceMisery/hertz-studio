'use strict';
// Real WebGL rendering and transform feedback; no service or music library required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output/playwright/creative-scenes', process.env.SCENE_CAPTURE || 'after');

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<style>body{margin:0;background:#090e11;color:#c8ded6;font:16px system-ui}main{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#1c2929}section{position:relative;background:#090e11}canvas{display:block;width:720px;height:320px}span{position:absolute;left:24px;top:18px;font-size:14px;letter-spacing:2px}</style><main></main>');
    for (const name of ['creative-gl.js', 'lyric3d.js', 'creative-stage.js']) {
      await page.addScriptTag({ path: path.join(root, 'plugin/ui', name) });
    }
    const captures = await page.evaluate(() => {
      CreativeStage.init();
      const lines = ['晚风吹过你的眼睛', '把星光画进这一页', '听见远方温柔的回声', '让每一颗星都有颜色', '我们沿着星光继续向前走', '等一场细雨落在心间', '让所有回忆慢慢浮现', '当月光越过了山野', '明天依然与你相见'].map(text => ({ text }));
      window.checkStates = [];
      const metrics = [];
      for (const def of CreativeGL.scenes()) {
        CreativeStage.setScene(def.id);
        const preset = CreativeStage.preset();
        CreativeStage.patch({ 'cam.yaw': 45, 'cam.pitch': 40, 'cam.dist': 6, 'cam.height': 3, 'cam.fov': 90 });
        CreativeStage.resetView();
        for (const key of ['yaw', 'pitch', 'dist', 'height', 'fov']) {
          if (CreativeStage.preset().cam[key] !== preset.cam[key]) throw new Error(def.id + ': reset must restore scene camera ' + key);
        }
        if (JSON.stringify(preset.sc) !== JSON.stringify(def.defaults)) {
          for (const key of Object.keys(def.defaults)) if (preset.sc[key] !== def.defaults[key]) throw new Error(def.id + ': inconsistent default ' + key);
        }
        const section = document.createElement('section'), canvas = document.createElement('canvas');
        section.append(canvas); const label = document.createElement('span'); label.textContent = def.label; section.append(label);
        document.querySelector('main').append(section);
        const engine = CreativeGL.create(canvas); engine.resize(720, 320, 1);
        const state = { scene: def.id, quality: 2, t: 42000, dt: 16, play: true, seed: .42,
          p: preset.sc, bands: Array.from({ length: 64 }, (_, i) => .32 + .38 * Math.pow(Math.sin(i * .34 + .8), 2)),
          rises: Array.from({ length: 64 }, (_, i) => .12 * Math.pow(Math.cos(i * .4), 8)),
          agg: [.64, .48, .38, .26], energy: .55, pulse: .4, colors: [[.66, .86, .78], [.38, .57, .76]],
          lyric: { index: 4, lines }, post: preset.look,
          cam: { yaw: preset.cam.yaw * Math.PI / 180, pitch: preset.cam.pitch * Math.PI / 180,
            fov: preset.cam.fov, dist: preset.cam.dist, tx: 0, ty: preset.cam.height, tz: 0 } };
        const result = engine.render(state);
        if (!result.ok) throw new Error(def.id + ': ' + JSON.stringify(result));
        const gl = canvas.getContext('webgl2'); const pixels = new Uint8Array(720 * 320 * 4);
        gl.readPixels(0, 0, 720, 320, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let bright = 0, visible = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
          if (max > 18) visible++;
          if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 225) bright++;
        }
        metrics.push({ scene: def.id, visible: visible / (720 * 320), white: bright / (720 * 320) });
        checkStates.push({ engine, canvas, state });
      }
      return metrics;
    });
    await page.screenshot({ path: path.join(out, 'scenes.png') });
    // Individual desktop and portrait captures use identical source/energy.
    for (const [width, height] of [[1200, 800], [480, 800]]) {
      await page.setViewportSize({ width, height });
      for (let i = 0; i < 6; i++) {
        const id = await page.evaluate(({ i, width, height }) => {
          document.querySelector('main').style.display = 'block';
          document.querySelectorAll('section').forEach((el, j) => { el.hidden = i !== j; });
          const item = checkStates[i]; item.canvas.style.width = width + 'px'; item.canvas.style.height = height + 'px';
          item.engine.resize(width, height, 1); item.engine.render(item.state);
          return item.state.scene;
        }, { i, width, height });
        await page.screenshot({ path: path.join(out, id + '-' + width + '.png') });
      }
    }
    const stress = await page.evaluate(() => {
      const results = [];
      for (const item of checkStates) {
        item.engine.resize(720, 480, 1);
        for (const quality of [0, 1, 2]) for (const energy of [0, 1]) {
          const state = { ...item.state, t: 600000, quality, bands: new Array(64).fill(energy), rises: new Array(64).fill(energy * .6),
            agg: new Array(4).fill(energy), energy, pulse: energy, colors: [[.82, .84, .82], [.68, .74, .78]] };
          const result = item.engine.render(state);
          if (!result.ok) throw new Error(JSON.stringify(result));
          const gl = item.canvas.getContext('webgl2'), pixels = new Uint8Array(720 * 480 * 4);
          gl.readPixels(0, 0, 720, 480, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          let bright = 0, visible = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 18) visible++;
            if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 120) bright++;
          }
          results.push({ scene: state.scene, quality, energy, visible: visible / (720 * 480), bright: bright / (720 * 480), error: gl.getError() });
        }
      }
      return results;
    });
    const geometry = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      function vertices(id, params, time, quality = 2) {
        const def = CreativeGL.sceneById(id), src = CreativeGL.sceneSource(id);
        function compile(type, code) {
          const s = gl.createShader(type); gl.shaderSource(s, code); gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
          return s;
        }
        const program = gl.createProgram();
        const vs = compile(gl.VERTEX_SHADER, '#version 300 es\n' + (def.qualityDefs ? def.qualityDefs(quality) : '') + src.common + src.decl + src.vert);
        const fs = compile(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;out vec4 frag;void main(){frag=vec4(1.);}');
        gl.attachShader(program, vs); gl.attachShader(program, fs);
        gl.transformFeedbackVaryings(program, ['gl_Position'], gl.INTERLEAVED_ATTRIBS); gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        gl.useProgram(program);
        const u = name => gl.getUniformLocation(program, name);
        gl.uniformMatrix4fv(u('uViewProj'), false, identity); gl.uniformMatrix4fv(u('uModel'), false, identity);
        gl.uniform1f(u('uTime'), time); gl.uniform1f(u('uPulse'), 1);
        const uniforms = Object.fromEntries(def.uniforms.map(name => [name, u(name)]));
        def.setup(gl, uniforms, { p: params, quality });
        const geom = def.qualityGeom ? def.qualityGeom[quality] : def.geom;
        const count = geom.verts * geom.instances;
        const buffer = gl.createBuffer(); gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, buffer);
        gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, count * 16, gl.STREAM_READ);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
        gl.enable(gl.RASTERIZER_DISCARD); gl.beginTransformFeedback(gl.TRIANGLES);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, geom.verts, geom.instances);
        gl.endTransformFeedback(); gl.disable(gl.RASTERIZER_DISCARD);
        const positions = new Float32Array(count * 4); gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, positions);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null); gl.deleteBuffer(buffer);
        gl.deleteProgram(program); gl.deleteShader(vs); gl.deleteShader(fs);
        return positions;
      }
      let minGap = Infinity, maxTerrainDrift = 0;
      for (const width of [8, 16, 20, 32]) for (const spacing of [1, 2.5, 9]) for (const t of [0, 1, 1000]) {
        const p = { ...CreativeGL.sceneById('lyric').defaults, pwidth: width, spacing, bob: 2 };
        const pos = vertices('lyric', p, t);
        const ranges = [];
        for (let cell = 0; cell < 9; cell++) {
          const ys = [], zs = [];
          for (let v = 0; v < 6; v++) { ys.push(pos[(cell * 6 + v) * 4 + 1]); zs.push(pos[(cell * 6 + v) * 4 + 2]); }
          const mid = (Math.max(...ys) + Math.min(...ys)) / 2;
          // Atlas glyphs and their small shadow fit inside the central half of a strip.
          const halfGlyph = (Math.max(...ys) - Math.min(...ys)) * .25;
          const depth = 20 - zs[0];
          ranges.push([(mid - halfGlyph) / depth, (mid + halfGlyph) / depth]);
        }
        for (let i = 1; i < ranges.length; i++) minGap = Math.min(minGap, ranges[i - 1][0] - ranges[i][1]);
      }
      for (const q of [0, 1, 2]) {
        const p = CreativeGL.sceneById('terrain').defaults;
        const before = vertices('terrain', p, 0, q), after = vertices('terrain', p, 600, q);
        for (let i = 0; i < before.length; i += 4) maxTerrainDrift = Math.max(maxTerrainDrift, Math.abs(after[i + 2] - before[i + 2]));
      }
      return { minGap, maxTerrainDrift, error: gl.getError() };
    });
    fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify({ captures, stress, geometry, errors }, null, 2));
    console.log(JSON.stringify({ captures, geometry, errors }, null, 2));
    if (process.env.SCENE_CAPTURE !== 'before') {
      assert.ok(geometry.minGap > 0, 'projected lyric glyph strips must remain separated at width/spacing/bob limits');
      assert.ok(geometry.maxTerrainDrift < .001, 'terrain stays framed after ten minutes of playback');
      assert.equal(geometry.error, 0, 'no WebGL errors during real vertex checks');
      for (const item of captures) {
        assert.ok(item.visible > .002, item.scene + ' is visible');
        assert.ok(item.white < .015, item.scene + ' avoids broad white clipping');
      }
      for (const item of stress) {
        assert.equal(item.error, 0, item.scene + ' quality ' + item.quality + ' GL errors');
        assert.ok(item.visible > .0005, item.scene + ' remains visible at energy ' + item.energy);
        assert.ok(item.bright < .15, item.scene + ' preserves negative space at energy ' + item.energy);
      }
      assert.deepEqual(errors, []);
    }
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
