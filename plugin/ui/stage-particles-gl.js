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
//   WebGL   ：粒子位置是 (aSeed, aLane, aAng, uTime, 音频 uniform) 的解析函数，
//              在顶点着色器里算。CPU 每帧只更新十几个 uniform，粒子数与主线程
//              开销解耦，所以能开到几万颗。
//
// 泛光沿用「同一份顶点数据画两遍、第二遍点更大更淡」的做法，而不是一趟全屏
// 后处理：加性混合的两遍点精灵在视觉上都比一次 bloom pass 便宜一个数量级。
//
// 之所以不用 Three.js：本项目前端是 include_str! 内嵌 + 裸 <script>，没有打包器
// 也没有 import map，而 Three.js 现代版本是 ESM 且把 Loader/Controls 拆在
// three/addons 下。为一个点精灵场景引入 150KB 依赖不划算，手写反而更小更可控。

(function () {
  'use strict';

  // 每档粒子上限与 DPR 上限。
  //
  // 这两个数是量出来的，不是猜的：泛光那一遍把点放大约 2.6 倍，填充率按
  // dpr² 涨，在 Intel UHD 这类核显上 32000 颗 @dpr1.5 会把帧率从 ~53 拖到 ~37，
  // 也就是"增强"反而比标准更卡。所以这里刻意压在"核显也稳得住"的水位上，
  // 真正的余量交给下面的 A/B 探测去要。
  var COUNTS = [2000, 7000, 14000];
  var DPR = [1.0, 1.15, 1.35];
  var STRIDE = 5;          // seed, lane, ang, size, tint

  var VERT = `#version 300 es
precision highp float;
in float aSeed; in float aLane; in float aAng; in float aSize; in float aTint;
uniform float uTime; uniform vec2 uRes; uniform float uPixel;
uniform float uDrift; uniform float uStrength; uniform vec4 uBands;
uniform float uPulse; uniform vec2 uCenter; uniform vec3 uFade;
uniform float uSizeMul;
out float vAlpha; out float vTint;

void main() {
  float z = aLane;                       // 深度：越近越大、越快、越亮
  float t = uTime;

  float speed = uDrift * (0.4 + z) * (1.0 + uBands.z * 2.2);
  float y = 1.06 - fract(aSeed - t * speed) * 1.12;
  float x = fract(aSeed * 0.6173 + 0.13)
          + sin(t * 0.526 + aAng) * 0.013 * (0.3 + z) * (1.0 + uBands.y);
  vec2 p = vec2(x * uRes.x, y * uRes.y);
  p.y += sin(t * 0.417) * uBands.x * 0.010 * uRes.y * uStrength;

  // 节拍把粒子沿「离圆心的方向」推开：越靠近圆心推得越狠，边缘几乎不动，
  // 读起来是冲击波而不是整层平移。
  vec2 d = p - uCenter;
  float dist = length(d) + 1e-4;
  float k = uPulse * 0.055 * (1.0 - min(1.0, dist / (uRes.x * 0.75))) * 0.07 * uStrength;
  p += (d / dist) * k * uRes;

  // 文字让位：uFade = (歌词带上沿, 下沿, 是否启用)。带内压到 0.28，
  // 两侧各 48px 线性过渡回 1.0。用斜坡而不是硬边界，否则粒子会在歌词
  // 上下沿整齐地"断掉"，反而更抢眼。
  float fade = 1.0;
  if (uFade.z > 0.5) {
    float dd = max(uFade.x - p.y, p.y - uFade.y);
    if (dd > 0.0) fade = 0.28;
    else fade = 0.28 + 0.72 * (min(-dd, 48.0) / 48.0);
  }

  float tw = 0.72 + 0.28 * sin(t * 2.381 + aAng * 3.1);
  float a = (0.05 + 0.16 * z + uBands.x * 0.10 + uPulse * 0.14) * tw * fade;
  // 高频泛音闪烁：每帧只点亮 1/8 的粒子，制造"空气里有东西在反光"
  float lane = floor(fract(aSeed * 71.3) * 8.0);
  float cur = floor(mod(t * 11.0, 8.0));
  if (uBands.w > 0.02 && abs(lane - cur) < 0.5) a += uBands.w * 0.9 * 0.22;

  float sz = aSize * (0.7 + z * 0.9) * (1.0 + uBands.x * 0.5 + uPulse * 0.35)
           * 3.2 * uPixel * uSizeMul;
  gl_PointSize = clamp(sz, 1.0, 64.0);
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

  function tierIndex() {
    var t = window.Stage ? Stage.tier() : 2;
    return t < 0 ? 0 : t > 2 ? 2 : t;
  }

  function isAvailable() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
    } catch (e) { return false; }
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

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function link(gl) {
    var vs = compile(gl, gl.VERTEX_SHADER, VERT);
    var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return null;
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      gl.deleteProgram(p);
      return null;
    }
    return p;
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
    }
    return a;
  }

  function create() {
    var contexts = [];
    var count = 0;
    var data = null;
    var colors = [parseRgb('226, 176, 113'), parseRgb('226, 176, 113')];

    function mountOne(v) {
      var gl;
      try {
        gl = v.canvas.getContext('webgl2', {
          alpha: true, antialias: false, depth: false, stencil: false,
          premultipliedAlpha: false, preserveDrawingBuffer: false,
          powerPreference: 'high-performance'
        });
      } catch (e) { gl = null; }
      if (!gl) return false;

      var prog = link(gl);
      if (!prog) { v.canvas.__lost = true; return false; }

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);           // 加性：重叠光点亮度累加

      var vao = gl.createVertexArray();
      var buf = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      if (data) gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

      var loc = {
        aSeed: gl.getAttribLocation(prog, 'aSeed'),
        aLane: gl.getAttribLocation(prog, 'aLane'),
        aAng: gl.getAttribLocation(prog, 'aAng'),
        aSize: gl.getAttribLocation(prog, 'aSize'),
        aTint: gl.getAttribLocation(prog, 'aTint')
      };
      for (var i = 0; i < STRIDE; i += 1) {
        var key = ['aSeed', 'aLane', 'aAng', 'aSize', 'aTint'][i];
        var l = loc[key];
        if (l < 0) continue;
        gl.enableVertexAttribArray(l);
        gl.vertexAttribPointer(l, 1, gl.FLOAT, false, STRIDE * 4, i * 4);
      }

      var u = {};
      ['uTime', 'uRes', 'uPixel', 'uDrift', 'uStrength', 'uBands', 'uPulse',
        'uCenter', 'uFade', 'uColorA', 'uColorB', 'uSizeMul', 'uAlphaMul']
        .forEach(function (name) { u[name] = gl.getUniformLocation(prog, name); });

      var ctx = { v: v, gl: gl, prog: prog, vao: vao, buf: buf, u: u, w: 0, h: 0 };
      v.canvas.addEventListener('webglcontextlost', function (e) {
        e.preventDefault();
        v.__lost = true;
      });
      contexts.push(ctx);
      return true;
    }

    function find(v) {
      for (var i = 0; i < contexts.length; i += 1) if (contexts[i].v === v) return contexts[i];
      return null;
    }

    return {
      name: 'webgl',
      counts: COUNTS,
      dpr: DPR,
      mount: function (v) {
        if (find(v)) return true;
        return mountOne(v);
      },
      setColors: function (hi, alt) {
        colors = [parseRgb(hi), parseRgb(alt)];
      },
      setCount: function (n) {
        if (n === count) return;
        count = n;
        data = seedData(n);
        for (var i = 0; i < contexts.length; i += 1) {
          var c = contexts[i];
          c.gl.bindBuffer(c.gl.ARRAY_BUFFER, c.buf);
          c.gl.bufferData(c.gl.ARRAY_BUFFER, data, c.gl.STATIC_DRAW);
        }
      },
      resize: function (v) {
        var c = find(v);
        if (!c) return;
        var dpr = Math.min(window.devicePixelRatio || 1, DPR[tierIndex()]);
        var bw = Math.round(v.w * dpr), bh = Math.round(v.h * dpr);
        if (c.v.canvas.width !== bw || c.v.canvas.height !== bh) {
          c.v.canvas.width = bw; c.v.canvas.height = bh;
        }
        c.v.canvas.style.width = v.w + 'px';
        c.v.canvas.style.height = v.h + 'px';
        c.w = bw; c.h = bh; c.pixel = dpr;
        c.gl.viewport(0, 0, bw, bh);
      },
      clear: function (v) {
        var c = find(v);
        if (!c || v.__lost) return;
        c.gl.clearColor(0, 0, 0, 0);
        c.gl.clear(c.gl.COLOR_BUFFER_BIT);
      },
      draw: function (v, f) {
        var c = find(v);
        if (!c) return;
        if (v.__lost) {
          // 上下文丢失（驱动重置、显卡切换、显存吃紧）后 WebGL2 不会自己回来，
          // 唯一正确的处置是交还给宿主降级，而不是让画面永久停在最后一帧。
          if (window.StageParticles) StageParticles.handleContextLost();
          return;
        }
        if (!count) { this.clear(v); return; }
        var gl = c.gl, u = c.u;
        gl.useProgram(c.prog);
        gl.bindVertexArray(c.vao);
        gl.viewport(0, 0, c.w, c.h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.uniform1f(u.uTime, f.t / 1000);
        gl.uniform2f(u.uRes, v.w, v.h);
        gl.uniform1f(u.uPixel, c.pixel || 1);
        gl.uniform1f(u.uDrift, f.drift * (0.018 + f.bands[2] * 0.05));
        gl.uniform1f(u.uStrength, f.strength);
        gl.uniform4f(u.uBands, f.bands[0], f.bands[1], f.bands[2], f.bands[3]);
        gl.uniform1f(u.uPulse, f.pulse * f.strength);
        gl.uniform2f(u.uCenter, v.cx, v.cy);
        gl.uniform3f(u.uFade, v.fade0, v.fade1, v.fade1 > 0 ? 1 : 0);
        gl.uniform3fv(u.uColorA, colors[0]);
        gl.uniform3fv(u.uColorB, colors[1]);

        // 两遍：实点 + 更大更淡的泛光。比一趟全屏 bloom pass 便宜一个数量级。
        gl.uniform1f(u.uSizeMul, 1.0);
        gl.uniform1f(u.uAlphaMul, 1.0);
        gl.drawArrays(gl.POINTS, 0, count);
        gl.uniform1f(u.uSizeMul, 2.6);
        gl.uniform1f(u.uAlphaMul, 0.32);
        gl.drawArrays(gl.POINTS, 0, count);

        gl.bindVertexArray(null);
      },
      // 编译 + 链接 + 首次上传全部发生在这一帧，且不依赖音频数据。
      warmUp: function (v) {
        var c = find(v);
        if (!c) return;
        this.setCount(count || 1);
        this.resize(v);
        c.gl.useProgram(c.prog);
        c.gl.bindVertexArray(c.vao);
        c.gl.drawArrays(c.gl.POINTS, 0, 0);
        c.gl.bindVertexArray(null);
      },
      dispose: function () {
        for (var i = 0; i < contexts.length; i += 1) {
          var c = contexts[i];
          try {
            c.gl.deleteBuffer(c.buf);
            c.gl.deleteVertexArray(c.vao);
            c.gl.deleteProgram(c.prog);
            var ext = c.gl.getExtension('WEBGL_lose_context');
            if (ext) ext.loseContext();
          } catch (e) { /* 已经掉了就别再管 */ }
        }
        contexts.length = 0;
        count = 0;
        data = null;
      }
    };
  }

  window.ParticleGL = { isAvailable: isAvailable, create: create };
})();
