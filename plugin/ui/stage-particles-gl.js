// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 增强渲染器：WebGL2 光尘场。由 stage-particles.js 在用户开启
// 「Three.js / WebGL 增强渲染」时挂载；本文件不主动运行，也不碰任何设置存储。
//
// 与标准 Canvas 2D 渲染器的分工差异只有一处，但正是关键的一处：
//
//   Canvas 2D：每帧在 JS 里逐粒子积分位置 → drawImage × N。
//              N 超过一千左右，主线程就开始吃掉歌词滚动的帧。
//   WebGL   ：粒子位置是 (aSeed, aX, aLane, aAng, uTime, 音频 uniform) 的解析函数，
//              在顶点着色器里算。CPU 每帧只更新十几个 uniform，粒子数与主线程
//              开销解耦，适合绘制更细的光点与柔和泛光。
//
// 泛光沿用「同一份顶点数据画两遍、第二遍点更大更淡」的做法，而不是一趟全屏
// 后处理：加性混合的两遍点精灵在视觉上都比一次 bloom pass 便宜一个数量级。
//
// 之所以不用 Three.js：本项目前端是 include_str! 内嵌 + 裸 <script>，没有打包器
// 也没有 import map，而 Three.js 现代版本是 ESM 且把 Loader/Controls 拆在
// three/addons 下。为一个点精灵场景引入 150KB 依赖不划算，手写反而更小更可控。

(function () {
  'use strict';

  // 每档粒子上限与 DPR 上限。宿主（stage-particles.js）还会在这之上再按面板
  // 面积缩放一次，所以这里定的是"基准尺寸下该有多少颗"。
  //
  // 侧栏需要少量可分辨的柔光点。GPU 的容量不应决定视觉密度；
  // 增强档保留更细的光点与淡泛光，而不是把整个播放器铺成星空噪点。
  var COUNTS = [120, 220, 360];
  var DPR = [1.0, 1.15, 1.35];
  var STRIDE = 6;          // seed, lane, ang, size, tint, x

  var VERT = `#version 300 es
precision highp float;
in float aSeed; in float aLane; in float aAng; in float aSize; in float aTint; in float aX;
uniform float uTime; uniform vec2 uRes; uniform float uPixel;
uniform float uTravel; uniform float uStrength; uniform vec4 uBands;
uniform float uPulse; uniform vec2 uCenter; uniform vec3 uFade;
uniform float uSizeMul;
out float vAlpha; out float vTint;

void main() {
  float z = aLane;                       // 深度：越近越大、越快、越亮
  float t = uTime;

  // 位移在宿主按 dt 积分；绝对时间乘实时音量会在频谱变化时瞬移。
  float y = 1.06 - fract(aSeed + uTravel * (0.4 + z)) * 1.12;
  // 横向必须用独立的一路随机数。以前是 fract(aSeed * 0.6173 + 0.13)：
  // 与 y 同源于 aSeed 且都是线性映射，于是整场粒子塌成一条斜率 -1.12/0.6173
  // 的直线（aSeed < 相位的那部分另成一条），屏幕上就是两道白杠子而不是光尘。
  float x = aX + sin(t * 0.2 + aAng) * 0.006 * (0.3 + z) * (1.0 + uBands.y * 0.2);
  vec2 p = vec2(x * uRes.x, y * uRes.y);
  p.y += sin(t * 0.2) * uBands.x * 0.002 * uRes.y * uStrength;

  // 节拍把粒子沿「离圆心的方向」推开：越靠近圆心推得越狠，边缘几乎不动，
  // 读起来是冲击波而不是整层平移。
  vec2 d = p - uCenter;
  float dist = length(d) + 1e-4;
  float k = uPulse * 0.012 * (1.0 - min(1.0, dist / (uRes.x * 0.75))) * 0.07 * uStrength;
  p += (d / dist) * k * uRes;

  // 文字让位：uFade = (歌词带上沿, 下沿, 是否启用)。带内压到 0.28，
  // 两侧各 48px 线性过渡回 1.0。用斜坡而不是硬边界，否则粒子会在歌词
  // 上下沿整齐地"断掉"，反而更抢眼。
  float fade = 1.0;
  if (uFade.z > 0.5) {
    float dd = max(uFade.x - p.y, p.y - uFade.y);
    fade = 0.28 + 0.72 * clamp(dd / 48.0, 0.0, 1.0);
  }

  // 慢速、错相的呼吸替代轮转闪点；高频亮度也必须经过文字让位。
  float tw = 0.82 + 0.18 * sin(t * 0.45 + aAng * 3.1);
  float shimmer = uBands.w * 0.025 * (0.5 + 0.5 * sin(t * 0.7 + aAng));
  float a = (0.06 + 0.15 * z + uBands.x * 0.03 + uPulse * 0.035 + shimmer) * tw * fade;

  float sz = aSize * (0.7 + z * 0.9) * (1.0 + uBands.x * 0.12 + uPulse * 0.10)
           * 2.4 * uPixel * uSizeMul;
  gl_PointSize = clamp(sz, 1.0, 34.0);
  vAlpha = a;
  vTint = aTint;

  vec2 clip = (p / uRes) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

  var FRAG = `#version 300 es
precision mediump float;
in float vAlpha; in float vTint;
uniform vec3 uColorA; uniform vec3 uColorB; uniform float uAlphaMul;
out vec4 frag;

void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r = length(q) * 2.0;
  if (r >= 1.0) discard;
  // 与 2D 精灵同一条三段径向曲线（1 → 0.5@0.32 → 0），换渲染器时观感才对得上
  float a = mix(1.0, 0.5, smoothstep(0.0, 0.32, r)) * (1.0 - smoothstep(0.32, 1.0, r));
  vec3 c = mix(uColorA, uColorB, vTint);
  float o = a * vAlpha * uAlphaMul;
  if (o < 0.004) discard;
  frag = vec4(c * o, o);
}`;

  var nextGeneration = 0;
  var capabilityProbe = {
    attempts: 0, contextsCreated: 0, contextReleaseRequested: 0,
    contextReferencesReleased: 0, peakContexts: 0, failures: 0
  };

  function probeResources() {
    return {
      attempts: capabilityProbe.attempts,
      contexts: 0,
      contextsCreated: capabilityProbe.contextsCreated,
      contextReleaseRequested: capabilityProbe.contextReleaseRequested,
      contextReferencesReleased: capabilityProbe.contextReferencesReleased,
      peakContexts: capabilityProbe.peakContexts,
      failures: capabilityProbe.failures
    };
  }

  function isAvailable(options) {
    var canvas = null, gl = null, ticket = null;
    capabilityProbe.attempts += 1;
    try {
      if (!window.WebGL2RenderingContext) return false;
      if (!options || !options.resources) return false;
      ticket = options.resources.require({ canvases: 1, gpuContexts: 1, drawingBufferPixels: 1,
        renderTargetDeclaredBytes: 4 }, 'particle capability probe RGBA8', 0, 'bounded-estimate');
      canvas = document.createElement('canvas');
      canvas.width = canvas.height = 0;
      gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false });
      if (!gl) return false;
      capabilityProbe.contextsCreated += 1;
      capabilityProbe.peakContexts = 1;
      ticket.commit();
      return true;
    } catch (e) {
      capabilityProbe.failures += 1;
      return false;
    } finally {
      if (gl) {
        try {
          var ext = gl.getExtension('WEBGL_lose_context');
          if (ext) {
            capabilityProbe.contextReleaseRequested += 1;
            ext.loseContext();
          }
        } catch (e) { /* Reference release is separate from a driver release request. */ }
        capabilityProbe.contextReferencesReleased += 1;
      }
      if (canvas) {
        try { canvas.width = canvas.height = 0; } catch (e) { /* Best effort backing-store release. */ }
      }
      gl = null;
      canvas = null;
      if (ticket) ticket.release({ apiReleased: true, allocationEnded: true });
    }
  }

  function parseRgb(str) {
    var parts = String(str).split(',');
    var out = [0.89, 0.69, 0.44];
    for (var i = 0; i < 3; i += 1) {
      var n = parseFloat(parts[i]);
      out[i] = isFinite(n) ? Math.max(0, Math.min(255, n)) / 255 : out[i];
    }
    return out;
  }

  function seedData(n) {
    var a = new Float32Array(n * STRIDE);
    for (var i = 0; i < n; i += 1) {
      var o = i * STRIDE;
      a[o] = Math.random();
      a[o + 1] = 0.18 + Math.random() * 0.82;
      a[o + 2] = Math.random() * Math.PI * 2;
      a[o + 3] = 0.6 + Math.random() * 1.9;
      a[o + 4] = (i & 1) ? 1 : 0;
      a[o + 5] = Math.random();
    }
    return a;
  }

  function create(options) {
    options = options || {};
    var generation = ++nextGeneration;
    var resourcePort = options.resources, colorTicket = null, seedTicket = null, fixedError = '';
    function admission(resources, source) {
      if (!resourcePort) throw new Error('resource-policy-required');
      return resourcePort.require(resources, source, generation);
    }
    function releaseTicket(ticket) { if (ticket) ticket.release({ apiReleased: true, allocationEnded: true }); }
    var onContextLost = typeof options.onContextLost === 'function' ? options.onContextLost : null;
    var contexts = [];
    var count = 0;
    var data = null;
    var colors = [];
    try {
      colorTicket = admission({ ownedCpuBytes: 24 }, 'two particle color float32 vectors');
      colors = [parseRgb('226, 176, 113'), parseRgb('226, 176, 113')]; colorTicket.commit();
    } catch (e) { colors = []; releaseTicket(colorTicket); colorTicket = null; fixedError = e.message; }
    var disposed = false, failed = !!fixedError;
    var phase = 'idle';
    var alive = { contexts: 0, shaders: 0, programs: 0, buffers: 0, vaos: 0, listeners: 0,
      bufferBytes: 0, typedArrayBytes: 0, surfacePixels: 0, drawingBufferPixels: 0 };
    var created = { contexts: 0, shaders: 0, programs: 0, buffers: 0, vaos: 0, listeners: 0 };
    var released = { contexts: 0, shaders: 0, programs: 0, buffers: 0, vaos: 0, listeners: 0 };
    var peak = { contexts: 0, shaders: 0, programs: 0, buffers: 0, vaos: 0, listeners: 0,
      bufferBytes: 0, typedArrayBytes: 0, surfacePixels: 0, drawingBufferPixels: 0 };
    var uploadBytes = 0, releaseRequests = 0, failures = 0;
    var mountResult = { status: fixedError ? 'failed' : 'idle', phase: 'admission', reason: fixedError };
    var warmResult = { status: 'idle', reason: '', count: 0, drawCalls: 0,
      attempts: 0, submitted: 0, deferred: 0, failed: 0 };
    var productionDraws = 0, productionDrawCalls = 0;
    var neutralFrame = { t: 0, dt: 0, bands: [0, 0, 0, 0], pulse: 0, strength: 1, drift: 0 };

    function copyNumbers(source) {
      var out = {};
      for (var key in source) if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
      return out;
    }

    function updatePeak() {
      for (var key in alive) if (alive[key] > peak[key]) peak[key] = alive[key];
    }

    function own(kind) {
      alive[kind] += 1;
      created[kind] += 1;
      updatePeak();
    }

    function relinquish(kind) {
      alive[kind] -= 1;
      released[kind] += 1;
    }

    function checked(result) {
      if (result === false || result === null) throw new Error(phase + ' returned ' + result);
      return result;
    }

    function checkError(gl) {
      var error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(phase + ' GL error ' + error);
    }

    function updateSurface(c) {
      alive.surfacePixels -= c.surfacePixels;
      alive.drawingBufferPixels -= c.drawingBufferPixels;
      c.surfacePixels = c.canvas.width * c.canvas.height;
      c.drawingBufferPixels = c.gl.drawingBufferWidth * c.gl.drawingBufferHeight;
      alive.surfacePixels += c.surfacePixels;
      alive.drawingBufferPixels += c.drawingBufferPixels;
      updatePeak();
    }

    function releaseShader(c, index) {
      var shader = c.shaders[index];
      if (!shader) return;
      try { c.gl.deleteShader(shader); } finally {
        c.shaders[index] = null;
        relinquish('shaders');
      }
    }

    function releaseContext(c) {
      c.active = false;
      var gl = c.gl, canvas = c.canvas;
      if (c.v) c.v.ctx = null;
      if (c.listener) {
        try { canvas.removeEventListener('webglcontextlost', c.listener); } catch (e) { /* Clear owned references below. */ }
        c.listener = null;
        relinquish('listeners');
      }
      for (var i = 0; i < c.shaders.length; i += 1) {
        try { releaseShader(c, i); } catch (e) { /* Continue releasing sibling resources. */ }
      }
      var names = ['buf', 'vao', 'prog'];
      var kinds = ['buffers', 'vaos', 'programs'];
      var methods = ['deleteBuffer', 'deleteVertexArray', 'deleteProgram'];
      for (var j = 0; j < names.length; j += 1) {
        if (!c[names[j]]) continue;
        try { gl[methods[j]](c[names[j]]); } catch (e) { /* Loss cannot prevent cleanup of the remaining handles. */ }
        c[names[j]] = null;
        relinquish(kinds[j]);
      }
      alive.bufferBytes -= c.bufferBytes;
      alive.surfacePixels -= c.surfacePixels;
      alive.drawingBufferPixels -= c.drawingBufferPixels;
      c.bufferBytes = c.surfacePixels = c.drawingBufferPixels = 0;
      try { canvas.width = canvas.height = 0; } catch (e) { /* Canvas may already be detached. */ }
      if (gl) {
        try {
          var ext = gl.getExtension('WEBGL_lose_context');
          if (ext) { releaseRequests += 1; ext.loseContext(); }
        } catch (e) { /* Only the API request is measurable, not physical GPU reclamation. */ }
        relinquish('contexts');
      }
      c.gl = c.canvas = c.v = c.u = null;
      c.shaders.length = 0;
      releaseTicket(c.resourceTicket); releaseTicket(c.surfaceTicket); releaseTicket(c.bufferTicket);
      releaseTicket(c.pendingSurfaceTicket); releaseTicket(c.pendingBufferTicket);
      c.resourceTicket = c.surfaceTicket = c.bufferTicket = c.pendingSurfaceTicket = c.pendingBufferTicket = null;
    }

    function releaseAll() {
      for (var i = 0; i < contexts.length; i += 1) releaseContext(contexts[i]);
      contexts.length = 0;
      data = null;
      colors = [];
      releaseTicket(seedTicket); releaseTicket(colorTicket); seedTicket = colorTicket = null;
      count = 0;
      alive.typedArrayBytes = 0;
    }

    function fail(error) {
      failed = true;
      failures += 1;
      mountResult.status = 'failed';
      mountResult.phase = phase;
      mountResult.reason = error && error.message ? String(error.message) : String(error || phase);
      releaseAll();
      return false;
    }

    function compile(c, type, src) {
      var gl = c.gl;
      var shader = gl.createShader(type);
      if (!shader) throw new Error(phase + ' could not create shader');
      c.shaders.push(shader);
      own('shaders');
      checked(gl.shaderSource(shader, src));
      checked(gl.compileShader(shader));
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(phase + ' shader compile failed');
      return shader;
    }

    function upload(c) {
      var gl = c.gl;
      var bytes = data ? data.byteLength : 0;
      var ticket = admission({ bufferDeclaredBytes: bytes }, 'particle GPU buffer full replacement capacity');
      c.pendingBufferTicket = ticket;
      checked(gl.bindBuffer(gl.ARRAY_BUFFER, c.buf));
      checked(gl.bufferData(gl.ARRAY_BUFFER, data || 0, gl.STATIC_DRAW));
      checkError(gl);
      alive.bufferBytes -= c.bufferBytes;
      c.bufferBytes = data ? data.byteLength : 0;
      alive.bufferBytes += c.bufferBytes;
      uploadBytes += c.bufferBytes;
      ticket.commit(); releaseTicket(c.bufferTicket); c.bufferTicket = ticket; c.pendingBufferTicket = null;
      updatePeak();
    }

    function mountOne(v) {
      var gl = null, c = null, resourceTicket = null, surfaceTicket = null;
      try {
        phase = 'context';
        if (!v || !v.canvas) throw new Error('missing canvas');
        resourceTicket = admission({ gpuContexts: 1, programs: 1 }, 'particle GL context and linked program');
        var initialPixels = v.canvas.width * v.canvas.height;
        surfaceTicket = admission({ drawingBufferPixels: initialPixels, renderTargetDeclaredBytes: initialPixels * 4 }, 'particle GL initial RGBA8 surface');
        // premultipliedAlpha 保持默认的 true：片元写的是 vec4(c*o, o)，已经乘过
        // alpha。声明 false 等于告诉合成器"还要再乘一次"，于是整层按 o² 而不是 o
        // 落地——单颗越暗掉得越狠，这一层的曝光就跟标准档的调参对不上号了。
        gl = v.canvas.getContext('webgl2', {
          alpha: true, antialias: false, depth: false, stencil: false,
          preserveDrawingBuffer: false,
          powerPreference: 'high-performance'
        });
        if (!gl) throw new Error('WebGL2 context unavailable');
        c = { v: v, canvas: v.canvas, gl: gl, prog: null, vao: null, buf: null, u: null,
          shaders: [], listener: null, active: true, lost: false, notified: false,
          generation: generation, w: 0, h: 0, pixel: 1, travel: 0,
          bufferBytes: 0, surfacePixels: 0, drawingBufferPixels: 0, resourceTicket: resourceTicket, surfaceTicket: surfaceTicket };
        contexts.push(c);
        own('contexts');
        updateSurface(c);
        surfaceTicket.commit();
        v.__lost = false;

        phase = 'listener';
        c.listener = function (event) {
          // A disposed context cannot notify a replacement renderer, even if an event was queued.
          if (!c.active || disposed || c.generation !== generation || !c.gl || c.notified) return;
          c.lost = true;
          c.notified = true;
          failed = true;
          if (c.v) c.v.__lost = true;
          mountResult.status = 'lost';
          mountResult.phase = 'context-loss';
          mountResult.reason = 'WebGL2 context lost';
          try { event.preventDefault(); } catch (e) { /* Invalidity is already recorded. */ }
          if (onContextLost) onContextLost(c.v, generation);
        };
        own('listeners');
        checked(c.canvas.addEventListener('webglcontextlost', c.listener));

        phase = 'vertex-shader';
        var vs = compile(c, gl.VERTEX_SHADER, VERT);
        phase = 'fragment-shader';
        var fs = compile(c, gl.FRAGMENT_SHADER, FRAG);
        phase = 'program';
        c.prog = gl.createProgram();
        if (!c.prog) throw new Error('could not create program');
        own('programs');
        checked(gl.attachShader(c.prog, vs));
        checked(gl.attachShader(c.prog, fs));
        checked(gl.linkProgram(c.prog));
        if (!gl.getProgramParameter(c.prog, gl.LINK_STATUS)) throw new Error('program link failed');
        releaseShader(c, 0);
        releaseShader(c, 1);

        phase = 'state';
        checked(gl.disable(gl.DEPTH_TEST));
        checked(gl.disable(gl.CULL_FACE));
        checked(gl.enable(gl.BLEND));
        checked(gl.blendFunc(gl.ONE, gl.ONE)); // 加性：重叠光点亮度累加
        phase = 'vao';
        c.vao = gl.createVertexArray();
        if (!c.vao) throw new Error('could not create VAO');
        own('vaos');
        phase = 'buffer';
        c.buf = gl.createBuffer();
        if (!c.buf) throw new Error('could not create buffer');
        own('buffers');
        checked(gl.bindVertexArray(c.vao));
        phase = 'upload';
        upload(c);
        phase = 'attributes';
        var attributes = ['aSeed', 'aLane', 'aAng', 'aSize', 'aTint', 'aX'];
        for (var i = 0; i < STRIDE; i += 1) {
          var loc = gl.getAttribLocation(c.prog, attributes[i]);
          if (typeof loc !== 'number' || loc < 0) throw new Error('missing attribute ' + attributes[i]);
          checked(gl.enableVertexAttribArray(loc));
          checked(gl.vertexAttribPointer(loc, 1, gl.FLOAT, false, STRIDE * 4, i * 4));
        }
        phase = 'uniforms';
        c.u = {};
        var uniforms = ['uTime', 'uRes', 'uPixel', 'uTravel', 'uStrength', 'uBands', 'uPulse',
          'uCenter', 'uFade', 'uColorA', 'uColorB', 'uSizeMul', 'uAlphaMul'];
        for (var j = 0; j < uniforms.length; j += 1) {
          var name = uniforms[j];
          c.u[name] = gl.getUniformLocation(c.prog, name);
          if (c.u[name] == null || c.u[name] === false) throw new Error('missing uniform ' + name);
        }
        checked(gl.bindVertexArray(null));
        checkError(gl);
        mountResult.status = 'ready';
        mountResult.phase = 'mounted';
        mountResult.reason = '';
        resourceTicket.commit();
        return true;
      } catch (error) {
        if (!c) { releaseTicket(resourceTicket); releaseTicket(surfaceTicket); }
        return fail(error);
      }
    }

    function find(v) {
      for (var i = 0; i < contexts.length; i += 1) if (contexts[i].v === v) return contexts[i];
      return null;
    }

    function ready(c) {
      return !!(c && c.active && !c.lost && !failed && !disposed);
    }

    function finite(value, fallback) { return isFinite(value) ? Number(value) : fallback; }

    function clearOne(c) {
      checked(c.gl.clearColor(0, 0, 0, 0));
      checked(c.gl.clear(c.gl.COLOR_BUFFER_BIT));
    }

    function submit(c, v, f, warm) {
      var gl = c.gl, u = c.u;
      checked(gl.useProgram(c.prog));
      checked(gl.bindVertexArray(c.vao));
      checked(gl.viewport(0, 0, c.w, c.h));
      clearOne(c);
      checked(gl.uniform1f(u.uTime, finite(f.t, 0) / 1000));
      checked(gl.uniform2f(u.uRes, v.w, v.h));
      checked(gl.uniform1f(u.uPixel, c.pixel));
      if (!warm) c.travel += Math.min(100, Math.max(0, finite(f.dt, 0))) / 1000 *
        finite(f.drift, 0) * (0.004 + finite(f.bands[2], 0) * 0.004);
      checked(gl.uniform1f(u.uTravel, warm ? 0 : c.travel));
      checked(gl.uniform1f(u.uStrength, finite(f.strength, 1)));
      checked(gl.uniform4f(u.uBands, finite(f.bands[0], 0), finite(f.bands[1], 0),
        finite(f.bands[2], 0), finite(f.bands[3], 0)));
      checked(gl.uniform1f(u.uPulse, finite(f.pulse, 0) * finite(f.strength, 1)));
      checked(gl.uniform2f(u.uCenter, v.cx, v.cy));
      checked(gl.uniform3f(u.uFade, v.fade0, v.fade1, v.fade1 > 0 ? 1 : 0));
      checked(gl.uniform3fv(u.uColorA, colors[0]));
      checked(gl.uniform3fv(u.uColorB, colors[1]));
      // 两遍：实点 + 更大更淡的泛光。
      checked(gl.uniform1f(u.uSizeMul, 1.0));
      checked(gl.uniform1f(u.uAlphaMul, 1.0));
      checked(gl.drawArrays(gl.POINTS, 0, count));
      checked(gl.uniform1f(u.uSizeMul, 2.0));
      checked(gl.uniform1f(u.uAlphaMul, 0.10));
      checked(gl.drawArrays(gl.POINTS, 0, count));
      checked(gl.bindVertexArray(null));
    }

    return {
      name: 'webgl',
      counts: COUNTS,
      dpr: DPR,
      mount: function (v) {
        if (disposed || failed) return false;
        if (find(v)) return ready(find(v));
        return mountOne(v);
      },
      setColors: function (hi, alt) {
        if (disposed || failed) return false;
        var nextTicket = null;
        try {
          nextTicket = admission({ ownedCpuBytes: 24 }, 'particle color vector replacement peak');
          colors = [parseRgb(hi), parseRgb(alt)];
          nextTicket.commit(); releaseTicket(colorTicket); colorTicket = nextTicket;
          return true;
        } catch (e) { releaseTicket(nextTicket); return fail(e); }
      },
      setCount: function (n) {
        if (disposed || failed) return false;
        n = Math.max(0, Math.floor(finite(n, 0)));
        if (n === count) return true;
        var nextTicket = null;
        try {
          phase = 'seed-data';
          nextTicket = admission({ ownedCpuBytes: n * STRIDE * 4 }, 'particle CPU seed full replacement peak');
          // Count the transient old/new CPU arrays as well as retained storage.
          var next = n ? seedData(n) : null;
          var nextBytes = next ? next.byteLength : 0;
          peak.typedArrayBytes = Math.max(peak.typedArrayBytes, alive.typedArrayBytes + nextBytes);
          data = next;
          nextTicket.commit(); releaseTicket(seedTicket); seedTicket = nextTicket; nextTicket = null;
          count = n;
          alive.typedArrayBytes = nextBytes;
          phase = 'upload';
          for (var i = 0; i < contexts.length; i += 1) upload(contexts[i]);
          return true;
        } catch (error) { next = null; releaseTicket(nextTicket); return fail(error); }
      },
      resize: function (v, budget) {
        var c = find(v);
        if (!ready(c)) return false;
        try {
          phase = 'resize';
          var tier = typeof budget === 'number' ? budget : budget && budget.tier;
          tier = Math.max(0, Math.min(2, Math.floor(finite(tier, 2))));
          var dpr = budget && typeof budget === 'object' && isFinite(budget.dpr) && budget.dpr > 0 ?
            Number(budget.dpr) : Math.min(finite(window.devicePixelRatio, 1) || 1, DPR[tier]);
          var width = Math.max(0, finite(v.w, 0)), height = Math.max(0, finite(v.h, 0));
          var bw = Math.round(width * dpr), bh = Math.round(height * dpr);
          if (c.canvas.width !== bw || c.canvas.height !== bh) {
            var peakPixels = Math.max(bw * c.canvas.height, bw * bh);
            c.pendingSurfaceTicket = admission({ drawingBufferPixels: peakPixels, renderTargetDeclaredBytes: peakPixels * 4 },
              'particle GL resize including intermediate width/height RGBA8 backing');
          }
          if (c.canvas.width !== bw) { c.canvas.width = bw; updateSurface(c); }
          if (c.canvas.height !== bh) { c.canvas.height = bh; updateSurface(c); }
          if (c.pendingSurfaceTicket) {
            c.pendingSurfaceTicket.commit({ drawingBufferPixels: bw * bh, renderTargetDeclaredBytes: bw * bh * 4 });
            releaseTicket(c.surfaceTicket); c.surfaceTicket = c.pendingSurfaceTicket; c.pendingSurfaceTicket = null;
          }
          c.canvas.style.width = width + 'px';
          c.canvas.style.height = height + 'px';
          c.w = bw; c.h = bh; c.pixel = dpr;
          checked(c.gl.viewport(0, 0, bw, bh));
          updateSurface(c);
          return true;
        } catch (error) { return fail(error); }
      },
      clear: function (v) {
        var c = find(v);
        if (!ready(c)) return false;
        try { phase = 'clear'; clearOne(c); return true; } catch (error) { return fail(error); }
      },
      draw: function (v, f) {
        var c = find(v);
        if (!ready(c) || !count || !c.w || !c.h || !v.w || !v.h) return false;
        try {
          phase = 'draw';
          submit(c, v, f, false);
          productionDraws += 1;
          productionDrawCalls += 2;
          return true;
        } catch (error) { return fail(error); }
      },
      // Submit the current target to the real surface, then clear it before production.
      // Compilation/linking/upload belong to mount/count; no GPU completion is claimed.
      warmUp: function (v, f) {
        var c = find(v);
        warmResult.attempts += 1;
        warmResult.count = count;
        warmResult.drawCalls = 0;
        if (!ready(c)) {
          warmResult.status = 'failed'; warmResult.reason = 'backend unavailable'; warmResult.failed += 1;
        } else if (!count || !c.w || !c.h || !v.w || !v.h || (f && f.dust === false)) {
          warmResult.status = 'deferred'; warmResult.reason = !count ? 'zero count' :
            (f && f.dust === false) ? 'dust disabled' : 'zero size'; warmResult.deferred += 1;
        } else {
          try {
            phase = 'warm-up';
            neutralFrame.strength = f ? finite(f.strength, 1) : 1;
            submit(c, v, neutralFrame, true);
            checkError(c.gl);
            clearOne(c);
            checkError(c.gl);
            warmResult.status = 'submitted'; warmResult.reason = '';
            warmResult.drawCalls = 2; warmResult.submitted += 1;
          } catch (error) {
            fail(error);
            warmResult.status = 'failed'; warmResult.reason = mountResult.reason; warmResult.failed += 1;
          }
        }
        return copyNumbers(warmResult);
      },
      dispose: function () {
        if (disposed) return;
        disposed = true;
        releaseAll();
        onContextLost = null;
        colors = null;
        neutralFrame = null;
      },
      resources: function () {
        var result = copyNumbers(alive);
        result.backend = 'webgl';
        result.generation = generation;
        result.ready = !disposed && !failed && alive.contexts > 0;
        result.disposed = disposed;
        result.count = count;
        result.created = copyNumbers(created);
        result.released = copyNumbers(released);
        result.peak = copyNumbers(peak);
        result.cumulativeUploadBytes = uploadBytes;
        result.surfaceRgbaEstimateBytes = alive.surfacePixels * 4;
        result.contextReleaseRequested = releaseRequests;
        result.contextReferencesReleased = released.contexts;
        result.failures = failures;
        result.mount = copyNumbers(mountResult);
        result.warmUp = copyNumbers(warmResult);
        result.productionDraws = productionDraws;
        result.productionDrawCalls = productionDrawCalls;
        result.capabilityProbe = probeResources();
        return result;
      }
    };
  }

  window.ParticleGL = { isAvailable: isAvailable, create: create, probeResources: probeResources };
})();
