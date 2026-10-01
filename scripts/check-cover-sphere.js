'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'crates', 'hertz-studio', 'web', 'stage3d.js'), 'utf8').replace(/\r\n/g, '\n');
let checks = 0;
function check(value, label) { assert.ok(value, label); checks += 1; }
function extract(name) {
  const start = source.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n  }', start);
  return source.slice(start, end + 4);
}
const definitions = {};
vm.runInNewContext(source.slice(source.indexOf('  var STAGES ='), source.indexOf('  var UNIFORMS =')) +
  source.slice(source.indexOf('  var UNIFORMS ='), source.indexOf('  // ---- 舞台 1')),
definitions);
const sphere = definitions.STAGES.find(stage => stage.id === 'silk');
check(sphere && sphere.field === 0 && sphere.depth && !sphere.additive, 'silk retains its id and enables opaque depth handling');
check(sphere.cam.theta === 0 && sphere.cam.phi === 0, 'reference view presents the cover from the front');
assert.deepEqual(Array.from(sphere.counts), [14000, 32000, 54000]);

function harness(level, field = 0) {
  const events = [], images = [], uniforms = {};
  const state = { depth: false, write: false, blend: [], program: null, lost: false, uploadError: false };
  let programId = 0;
  const gl = new Proxy({
    useProgram(program) { state.program = program; },
    enable(capability) { if (capability === 'DEPTH_TEST') state.depth = true; },
    disable(capability) { if (capability === 'DEPTH_TEST') state.depth = false; },
    depthMask(value) { state.write = value; },
    blendFunc(...values) { state.blend = values; },
    drawArrays(mode, first, count) { events.push({ kind: 'draw', ...state, count }); },
    createTexture() { return {}; },
    createVertexArray() { return {}; },
    isContextLost() { return state.lost; },
    texImage2D(...values) {
      if (state.uploadError) throw new Error('upload rejected');
      events.push({ kind: 'upload', image: values.at(-1) });
    },
    pixelStorei(parameter, value) { events.push({ kind: 'pixelStore', parameter, value }); },
    generateMipmap() { events.push({ kind: 'mipmap' }); },
    deleteTexture() { events.push({ kind: 'deleteTexture' }); },
    texParameteri() {}, bindTexture() {}, activeTexture() {}, bindVertexArray() {},
    uniform1fv() {}, uniform3f() {}, deleteProgram() {}, deleteVertexArray() {}, deleteBuffer() {}
  }, { get(target, key) { return key in target ? target[key] : key; } });
  const env = {
    gl, FIELD_VS: definitions.FIELD_VS, FIELD_FS: definitions.FIELD_FS, STAR_VS: '', STAR_FS: '',
    q: () => level, seeds: count => ({ count }), makeVAO: () => ({}),
    buildProgram: () => ({ p: ++programId, u: { uBands: 'uBands', uClick: 'uClick' }, a: () => 0 }),
    global: { Stage: true }, Stage: { coverUrl: () => env.url },
    Image: class { constructor() { images.push(this); this.naturalWidth = 1024; this.naturalHeight = 1024; } },
    uploadCommon() {}, setI: (locations, name, value) => { uniforms[name] = value; },
    setF: (locations, name, value) => { uniforms[name] = value; },
    setV2: (locations, name, first, second) => { uniforms[name] = [first, second]; },
    reducedMotion: () => env.reduced, motion: 0.65, reduced: false, url: '',
    bw: 1440, bh: 960, time: 10, lastBeatAt: 9, audioBands: new Float32Array(64),
    pointerField: { x: 0, y: 0, active: 1, clickX: 0, clickY: 0, clickAt: 9 }
  };
  vm.runInNewContext(extract('buildField'), env);
  const definition = field === 0 ? sphere : definitions.STAGES.find(stage => stage.field === field);
  return { env, state, events, images, uniforms, built: env.buildField(definition) };
}

for (const level of [0, 1, 2]) {
  const run = harness(level);
  check(run.built.count <= sphere.counts[level] && run.built.count > sphere.counts[level] * 0.98, 'particle budget at tier ' + level);
  run.built.draw();
  const draws = run.events.filter(event => event.kind === 'draw');
  check(!draws[0].depth && !draws[0].write && draws[0].blend[1] === 'ONE', 'background stars keep additive rendering at tier ' + level);
  check(draws[1].depth && draws[1].write && draws[1].blend[1] === 'ONE_MINUS_SRC_ALPHA', 'cover uses depth writes and normal alpha blending at tier ' + level);
  check(run.uniforms.uHasArt === 0 && run.uniforms.uArtLod === 0, 'missing cover remains a complete fallback sphere');
  run.env.reduced = true;
  run.built.draw();
  check(run.uniforms.uCoverMotion === 0 && run.uniforms.uPointerActive === 0 && run.uniforms.uBeatAge === 100, 'reduced motion disables sphere and pointer displacement');
  run.env.reduced = false; run.env.motion = 0; run.env.bw = 390; run.env.bh = 844;
  run.built.draw();
  check(run.uniforms.uCoverMotion === 0 && run.uniforms.uViewportHeight === 844, 'motion zero and viewport height reach the shader');
  check(Math.abs(run.uniforms.uCoverDistance - sphere.cam.dist * 1.05 / (390 / 844)) < 1e-9, 'portrait mapping follows the existing camera framing');
  run.built.dispose();
  check(run.events.filter(event => event.kind === 'deleteTexture').length === 1, 'texture is released at tier ' + level);
}

const art = harness(2);
art.env.url = 'cover-a'; art.built.draw();
const first = art.images[0], lateFirst = first.onload;
art.env.url = 'cover-b'; art.built.draw();
const second = art.images[1], lateSecond = second.onload;
art.env.url = 'cover-a'; art.built.draw();
const current = art.images[2];
lateFirst(); lateSecond();
check(art.events.filter(event => event.kind === 'upload').length === 1, 'late images cannot overwrite a newer A/B/A cover request');
current.naturalWidth = 2048; current.naturalHeight = 1024; current.onload(); art.built.draw();
check(art.uniforms.uHasArt === 1 && art.uniforms.uArtScale[0] === 0.5 && art.uniforms.uArtScale[1] === 1, 'landscape cover uses centered sampling without stretching');
check(art.uniforms.uArtLod > 0 && art.events.some(event => event.kind === 'mipmap'), 'large artwork receives density-matched mip sampling');
check(art.events.filter(event => event.kind === 'pixelStore').at(-1).value === false, 'texture upload restores vertical flip state');
art.env.url = ''; art.built.draw();
check(art.uniforms.uHasArt === 0 && art.uniforms.uArtScale.every(value => value === 1), 'clearing the cover clears stale sampling state');
art.env.url = 'cover-c'; art.built.draw(); art.state.uploadError = true; art.images.at(-1).onload(); art.built.draw();
check(art.uniforms.uHasArt === 0 && art.events.filter(event => event.kind === 'pixelStore').at(-1).value === false, 'failed uploads retain fallback and restore unpack state');
art.state.uploadError = false;
art.env.url = 'cover-d'; art.built.draw();
const lateDisposed = art.images.at(-1).onload;
const uploadCount = art.events.filter(event => event.kind === 'upload').length;
art.built.dispose(); lateDisposed();
check(art.events.filter(event => event.kind === 'upload').length === uploadCount, 'disposed scenes reject late cover uploads');

for (const field of [1, 2, 3, 4, 5]) {
  const run = harness(1, field);
  run.built.draw();
  check(run.events.filter(event => event.kind === 'draw').every(event => event.blend.length === 0), 'sphere state handling stays isolated from field ' + field);
  check(!('uCoverMotion' in run.uniforms), 'sphere uniforms stay isolated from field ' + field);
  run.built.dispose();
}

async function gpuChecks() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(({ vertex, fragment, budgets }) => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 640;
      const gl = canvas.getContext('webgl2', { antialias: false });
      if (!gl) throw new Error('WebGL2 unavailable');
      let assertions = 0;
      function ensure(value, label) { if (!value) throw new Error(label); assertions += 1; }
      function compile(type, code) {
        const shader = gl.createShader(type); gl.shaderSource(shader, code); gl.compileShader(shader);
        ensure(gl.getShaderParameter(shader, gl.COMPILE_STATUS), gl.getShaderInfoLog(shader));
        return shader;
      }
      const instrumented = vertex.replace('out vec3 vColor;', 'out vec3 checkPosition; out vec3 checkNormal; out vec2 checkUv; out vec3 vColor;')
        .replace('vec3 art = textureLod', 'checkUv = artUv;\n    vec3 art = textureLod')
        .replace('  gl_Position = uProj*mv;', '  checkPosition = pos; checkNormal = normal;\n  gl_Position = uProj*mv;');
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, instrumented));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
      gl.transformFeedbackVaryings(program, ['checkPosition', 'checkNormal', 'checkUv', 'gl_PointSize', 'vAlpha', 'vColor'], gl.INTERLEAVED_ATTRIBS);
      gl.linkProgram(program); ensure(gl.getProgramParameter(program, gl.LINK_STATUS), gl.getProgramInfoLog(program));
      gl.useProgram(program); gl.bindVertexArray(gl.createVertexArray());
      const uniform = name => gl.getUniformLocation(program, name);
      const scalar = (name, value) => gl.uniform1f(uniform(name), value);
      gl.uniform1i(uniform('uField'), 0); gl.uniform1i(uniform('uArt'), 0);
      scalar('uFade', 1); scalar('uPointScale', 1); scalar('uBeatAge', 100);
      scalar('uHasArt', 1); gl.uniform2f(uniform('uArtScale'), 1, 1); gl.uniform3f(uniform('uClick'), 0, 0, 100);
      const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const summaries = [];
      for (const budget of budgets) {
        const cols = Math.ceil(Math.sqrt(budget * 1.24)), rows = Math.floor(budget / cols), count = cols * rows;
        const frontCount = Math.floor(count * 0.76);
        for (const aspect of [1.5, 390 / 844]) {
          const distance = 10.2 * Math.max(1, Math.min(2.6, 1.05 / aspect));
          const focal = 1 / Math.tan(52 * Math.PI / 360);
          const projection = new Float32Array([focal / aspect, 0, 0, 0, 0, focal, 0, 0, 0, 0, -1.0009095, -1, 0, 0, -0.20009095, 0]);
          const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -distance, 1]);
          gl.uniformMatrix4fv(uniform('uProj'), false, projection); gl.uniformMatrix4fv(uniform('uView'), false, view);
          gl.uniform3f(uniform('uCamPos'), 0, 0, distance);
          scalar('uCols', cols); scalar('uRows', rows); scalar('uAspect', aspect); scalar('uCoverDistance', distance); scalar('uViewportHeight', 640);
          const feedback = gl.createBuffer(); gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, feedback);
          gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, count * 13 * 4, gl.STREAM_READ);
          gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, feedback);
          gl.enable(gl.RASTERIZER_DISCARD); gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, count); gl.endTransformFeedback(); gl.disable(gl.RASTERIZER_DISCARD);
          const samples = new Float32Array(count * 13); gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, samples);
          let radiusError = 0, mappingError = 0, maxZ = -Infinity, minZ = Infinity, visible = 0, rearVisible = 0, minPoint = Infinity, maxPoint = 0;
          const referenceProjection = Math.sqrt((distance / 2.55) ** 2 - 1);
          for (let index = 0; index < count; index += 1) {
            const offset = index * 13;
            const posX = samples[offset], posY = samples[offset + 1], posZ = samples[offset + 2];
            radiusError = Math.max(radiusError, Math.abs(Math.hypot(posX, posY, posZ) - 2.55));
            maxZ = Math.max(maxZ, posZ); minZ = Math.min(minZ, posZ);
            const alpha = samples[offset + 9];
            if (alpha > 0) { visible += 1; if (index >= frontCount) rearVisible += 1; }
            minPoint = Math.min(minPoint, samples[offset + 8]); maxPoint = Math.max(maxPoint, samples[offset + 8]);
            if (index < frontCount) {
              const expectedX = 0.5 + posX / (distance - posZ) * referenceProjection * 0.5;
              const expectedY = 0.5 + posY / (distance - posZ) * referenceProjection * 0.5;
              mappingError = Math.max(mappingError, Math.abs(expectedX - samples[offset + 6]), Math.abs(expectedY - samples[offset + 7]));
            }
          }
          ensure(radiusError < 0.0001, 'points lie on a real sphere: ' + JSON.stringify({ radiusError, maxZ, minZ, error: gl.getError(), sample: Array.from(samples.slice(0, 13)) }));
          ensure(maxZ - minZ > 5.08, 'full front and rear surface have depth');
          ensure(mappingError < 0.0001, 'front UV preserves perspective-projected image shape: ' + mappingError);
          ensure(rearVisible === 0 && visible > frontCount * 0.98, 'rear samples are culled and the front stays visible');
          ensure(minPoint >= 1.25 && maxPoint <= 7, 'point footprint respects pixel bounds');
          function recapture() {
            gl.enable(gl.RASTERIZER_DISCARD); gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, count); gl.endTransformFeedback(); gl.disable(gl.RASTERIZER_DISCARD);
            const captured = new Float32Array(count * 13); gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, captured);
            return captured;
          }
          scalar('uTime', 900); scalar('uBass', 1); scalar('uBeat', 1); scalar('uPointerActive', 1);
          const still = recapture();
          ensure(still.every((value, index) => value === samples[index]), 'zero motion keeps geometry and colors unchanged by time, audio and pointer input');
          scalar('uCoverMotion', 1);
          const moving = recapture();
          let maxMotion = 0;
          for (let index = 0; index < count; index += 1) {
            const offset = index * 13;
            maxMotion = Math.max(maxMotion, Math.hypot(moving[offset] - samples[offset], moving[offset + 1] - samples[offset + 1], moving[offset + 2] - samples[offset + 2]));
          }
          ensure(maxMotion > 0.01 && maxMotion < 0.22, 'music and pointer motion stay gentle on the cover');
          scalar('uCoverMotion', 0); scalar('uTime', 0); scalar('uBass', 0); scalar('uBeat', 0); scalar('uPointerActive', 0);
          for (const eye of [[distance, 0, 0], [0, 0, -distance]]) {
            gl.uniform3f(uniform('uCamPos'), ...eye);
            const turned = recapture();
            let facingCount = 0, turnedLeaks = 0;
            for (let index = 0; index < count; index += 1) {
              const offset = index * 13;
              const facing = turned[offset + 3] * (eye[0] - turned[offset]) + turned[offset + 4] * (eye[1] - turned[offset + 1]) + turned[offset + 5] * (eye[2] - turned[offset + 2]);
              if (turned[offset + 9] > 0) { facingCount += 1; if (facing <= 0) turnedLeaks += 1; }
            }
            ensure(turnedLeaks === 0 && facingCount > count * 0.12, 'side and rear camera positions reveal only the facing surface');
          }
          gl.uniform3f(uniform('uCamPos'), 0, 0, distance);
          gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null); gl.deleteBuffer(feedback);
          summaries.push({ count, aspect, radiusError, mappingError, visible, minPoint, maxPoint });
        }
      }
      scalar('uCoverMotion', 0); scalar('uTime', 900); scalar('uBass', 1); scalar('uBeat', 1);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0.1, 0.3, 0.7, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, summaries.at(-1).count);
      const pixels = new Uint8Array(640 * 640 * 4); gl.readPixels(0, 0, 640, 640, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let dark = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) if (pixels[offset] < 8 && pixels[offset + 1] < 8 && pixels[offset + 2] < 8) dark += 1;
      ensure(dark > 15000, 'black cover pixels remain opaque instead of disappearing into the background');
      ensure(gl.getError() === gl.NO_ERROR, 'no WebGL errors');
      return { assertions, summaries, darkPixels: dark, renderer: gl.getParameter(gl.RENDERER) };
    }, { vertex: definitions.FIELD_VS, fragment: definitions.FIELD_FS, budgets: sphere.counts });
    checks += result.assertions;
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
}

async function main() {
  if (process.argv.includes('--gpu')) await gpuChecks();
  console.log('PASS ' + checks + ' cover sphere checks' + (process.argv.includes('--gpu') ? ' (including WebGL2)' : ' (use --gpu for WebGL2 geometry and rendering)'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
