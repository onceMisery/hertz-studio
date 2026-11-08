// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 字形引擎 GL 层：一个 WebGL2 上下文、一个 program、一组实例化属性、一次 draw。
// 除 uResolution 外的长度单位都是屏幕 CSS px；图集 px 通过 uPxScale 换算。
(function (global) {
  'use strict';
  if (typeof window === 'undefined') return;

  var VERT = [
    '#version 300 es',
    'precision highp float;',
    'layout(location=0) in vec4 aPosSize;',
    'layout(location=1) in vec4 aUVU;',
    'layout(location=2) in vec4 aTime;',
    // aBox: 字墨包围盒（图集内容盒坐标），xy=中心、zw=半宽高。
    // 只服务辉光远场：SDF 在 ±uRange 外饱和，没有它就会把整格 quad 点亮。
    'layout(location=3) in vec4 aBox;',
    'uniform vec2  uResolution;',
    'uniform vec2  uUVSize;',
    'uniform float uCellPx;',
    'uniform float uPadPx;',
    'uniform float uTimeMs;',
    'uniform float uShear;',
    'uniform float uBaseY;',
    'uniform float uAmp;',
    'uniform float uFreq;',
    'uniform float uDamp;',
    'uniform float uCurveB[33];',
    'uniform float uCurveW[33];',
    'uniform float uDecorKind;',
    'uniform float uDecorStride;',
    'uniform float uDecorSeed;',
    'out vec2  vUV;',
    'out float vU;',
    'out float vW;',
    'out vec4  vBox;',
    'out vec2  vLocal;',
    'flat out float vDecor;',
    'flat out float vSeed;',
    'void main() {',
    '  vec2 quad = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));',
    '  float u = mix(aUVU.z, aUVU.w, quad.x);',
    '  float cu = clamp(u, 0.0, 1.0) * 32.0;',
    '  int   iu = int(min(floor(cu), 31.0));',
    '  float fu = cu - float(iu);',
    '  float bPx = mix(uCurveB[iu], uCurveB[iu + 1], fu);',
    '  float wv  = mix(uCurveW[iu], uCurveW[iu + 1], fu);',
    '  vec2 p = aPosSize.xy + quad * aPosSize.zw;',
    '  p.x += uShear * (p.y - uBaseY);',
    '  p.y += bPx;',
    '  float x   = clamp((uTimeMs - aTime.x) / max(aTime.y, 1.0), 0.0, 1.0);',
    '  float env = pow(1.0 - x, uDamp);',
    '  p.y += uAmp * env * sin(x * uFreq * 6.2831853);',
    '  vec2 ndc = vec2(p.x / uResolution.x * 2.0 - 1.0,',
    '                 1.0 - p.y / uResolution.y * 2.0);',
    '  gl_Position = vec4(ndc, 0.0, 1.0);',
    '  vUV = aUVU.xy + quad * uUVSize;',
    '  vU  = u;',
    '  vW  = wv;',
    '  vBox = aBox;',
    // 内容盒坐标（0..CONTENT），与图集里算出的 aBox 同一坐标系。
    '  vLocal = quad * uCellPx - vec2(uPadPx);',
    '  vDecor = (uDecorKind > 0.5 && mod(float(gl_InstanceID), max(uDecorStride, 1.0)) < 0.5) ? 1.0 : 0.0;',
    '  vSeed = uDecorSeed + float(gl_InstanceID) * 17.0;',
    '}'
  ].join('\n');

  var FRAG = [
    '#version 300 es',
    'precision highp float;',
    'in vec2  vUV;',
    'in float vU;',
    'in float vW;',
    'in vec4  vBox;',
    'in vec2  vLocal;',
    'flat in float vDecor;',
    'flat in float vSeed;',
    'uniform sampler2D uAtlas;',
    'uniform float uRange;',
    'uniform float uPxScale;',
    'uniform float uWeightGain;',
    'uniform float uWeightGainHi;',
    'uniform float uGlowK;',
    'uniform float uGlowAmt;',
    'uniform float uRimAmt;',
    'uniform float uRimWidth;',
    'uniform float uClipU;',
    'uniform float uSoft;',
    'uniform float uWobble;',
    'uniform float uTurbAmp;',
    'uniform float uTimeMs;',
    'uniform float uOpacity;',
    'uniform float uSceneTimeMs;',
    'uniform float uDual;',
    // 双图集的混合端点：blend = (w - uWLo) / (uWHi - uWLo)。
    // 固定为 0.30 / 0.50：w=0.5（中性）必须落在 700 面，与 stanza 的
    // DOM 歌词基础字重一致；本机 600/700/800/900 是同一个物理面。
    'uniform float uWLo;',
    'uniform float uWHi;',
    'uniform vec3  uIdleColor;',
    'uniform vec3  uSungColor;',
    'uniform vec3  uGlowColor;',
    'uniform float uDecorKind;',
    'uniform float uDecorDur;',
    'uniform vec3  uDecorColor;',
    'out vec4 frag;',
    'void main() {',
    '  vec2 uv = vUV;',
    '  if (uTurbAmp > 0.0) {',
    '    uv += vec2(sin(vUV.y * 17.0 + uSceneTimeMs * 0.0031),',
    '               cos(vUV.x * 13.0 + uSceneTimeMs * 0.0023)) * uTurbAmp;',
    '  }',
    '  vec4 texel = texture(uAtlas, uv);',
    '  float dpx  = (texel.r - 0.5) * 2.0 * uRange;',
    // 双图集：R=400 基面、G=700 基面。w 0.30→400、0.50→700，
    // 中间线性混合两张 SDF；不再用阈值增益伪造中间字重。
    // 端点必须让 w=0.5（中性）落在粗面上 —— stanza 的 DOM 歌词基础字重就是 700。
    '  float blend = clamp((vW - uWLo) / max(uWHi - uWLo, 1e-4), 0.0, 1.0);',
    '  if (uDual > 0.5) {',
    '    float dpxHi = (texel.g - 0.5) * 2.0 * uRange;',
    '    dpx = mix(dpx, dpxHi, blend);',
    '  }',
    // 粗细：w 高于 0.50 时没有更粗的字面，只能膨胀；低端只能收缩。
    // 注意 wpx 的符号：mask 用 dpx - wpx，负 wpx 才是膨胀。
    // 情绪场把 w 钳在 0.30–0.62，增益 8 不会堵死字怀。
    '  float gain = vW > 0.5 ? uWeightGainHi : uWeightGain;',
    '  float wpx = uDual > 0.5',
    '    ? (vW > uWHi ? (uWHi - vW) * uWeightGainHi : (vW < uWLo ? (uWLo - vW) * uWeightGain : 0.0))',
    '    : (0.5 - vW) * gain;',
    // 抗锯齿带宽取半个 fwidth：dpx 以图集 px 为单位，scale=1 时 1 个屏幕像素
    // 对应 1 个图集像素，0.5 正好把过渡带收在一个像素内。原来的 0.75 会让
    // 笔画边缘糊出约 1.5px 的灰边，在深色背景上看着"发虚"。
    '  float aa  = max(fwidth(dpx) * 0.5, 1e-4);',
    '  float mask = smoothstep(-aa, aa, dpx - wpx);',
    '  float wob  = uWobble * sin(vUV.y * 40.0 + uSceneTimeMs * 0.0029);',
    '  float sung = smoothstep(uClipU - uSoft + wob, uClipU + uSoft + wob, vU);',
    '  vec3  col  = mix(uIdleColor, uSungColor, sung);',
    '  float rim  = (1.0 - smoothstep(0.0, uRimWidth, abs(dpx - wpx))) * uRimAmt;',
    '  float outD = max(0.0, wpx - dpx);',
    // SDF 只编码到 uRange（8px）。再远的像素全饱和成同一个值，直接算
    // exp(-outD*K) 会给整格 quad 一个常数亮度——就是“每个字后面一块方格”。
    // 饱和后用墨迹盒距离延续衰减；盒内凹处仍取 SDF 的 8px 下限，
    // 效果是笔画孔隙里保留近场辉光，而格子边缘自然衰减到零。
    '  vec2  bq = abs(vLocal - vBox.xy) - vBox.zw;',
    '  float boxD = length(max(bq, 0.0)) + min(max(bq.x, bq.y), 0.0);',
    '  boxD = max(0.0, boxD + wpx);',
    '  float farW = smoothstep(uRange - 1.5, uRange - 0.25, outD);',
    '  float glowD = mix(outD, max(outD, boxD), farW);',
    '  float glow = exp(-glowD * uGlowK) * uGlowAmt * (1.0 - mask);',
    '  float a = clamp(mask + glow * 0.55, 0.0, 1.0);',
    '  vec3  c = col * mask + uGlowColor * glow + col * rim;',
    // P2a 片元粒子：每个 stride 字格画一颗，不新增 draw call。
    // 1 spark / 2 tear / 3 ember；t 从 0 到 1 循环，t=0/1 时淡出。
    '  if (uDecorKind > 0.5 && vDecor > 0.5) {',
    '    float t = fract((uSceneTimeMs + vSeed * 137.0) / max(uDecorDur, 1.0));',
    '    float h1 = fract(vSeed * 0.371);',
    '    float dx = (h1 - 0.5) * 18.0;',
    // 从该字实墨迹盒的底边发射，而不是格子中心；这样粒子不会被字身盖住。
    '    vec2 center = vec2(vBox.x + (h1 - 0.5) * vBox.z * 2.2, vBox.y + vBox.w + 2.0);',
    '    float travel = uDecorKind > 2.5 ? -34.0 : (uDecorKind > 1.5 ? 78.0 : -24.0);',
    '    center += vec2(dx, travel) * t;',
    '    vec2 q = vLocal - center;',
    '    if (uDecorKind > 1.5 && uDecorKind < 2.5) q.y /= 2.4;',
    '    float radius = uDecorKind > 2.5 ? 4.0 : (uDecorKind > 1.5 ? 3.2 : 3.6);',
    '    float particle = (1.0 - smoothstep(radius - 0.9, radius, length(q))) * sin(3.1415926 * t);',
    '    c += uDecorColor * particle;',
    '    a = max(a, particle * 0.9);',
    '  }',
    '  frag = vec4(c, a * uOpacity);',
    '}'
  ].join('\n');

  function compile(gl, type, src, shaders) {
    var sh = gl.createShader(type);
    if (!sh) throw new Error('glyph shader allocation failed');
    shaders.push(sh);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      throw new Error('glyph shader: ' + log);
    }
    return sh;
  }

  // 取 location 时数组必须写 'name[0]'：部分驱动对裸数组名返回 null，
  // 而 uniform1fv(null) 是静默 no-op —— 表现是「场完全没生效」。
  var UNIFORMS = ['uResolution', 'uUVSize', 'uTimeMs', 'uSceneTimeMs', 'uShear', 'uBaseY',
    'uCellPx', 'uPadPx', 'uDecorKind', 'uDecorStride', 'uDecorSeed', 'uDecorDur', 'uDecorColor',
    'uAmp', 'uFreq', 'uDamp', 'uCurveB[0]', 'uCurveW[0]',
    'uAtlas', 'uRange', 'uPxScale', 'uWeightGain', 'uWeightGainHi', 'uGlowK', 'uGlowAmt',
    'uRimAmt', 'uRimWidth', 'uClipU', 'uSoft', 'uWobble', 'uTurbAmp', 'uOpacity', 'uDual',
    'uWLo', 'uWHi',
    'uIdleColor', 'uSungColor', 'uGlowColor'];

  var INSTANCE_BYTES = 128 * 16 * 4;
  function create(canvas, options) {
    options = options || {};
    var resources = options.resources, generation = options.generation || 0;
    if (options.admissionRequired && (!resources || resources.contractVersion !== 1)) throw new Error('resource-port-required');
    var gl = null, prog = null, vao = null, vbo = null, tex = null, inst = null;
    var fixed = null, surface = null, texture = null, shaders = [], destroyed = false, cleanupFailed = false;
    var texWidth = 0, texHeight = 0, texDual = false;
    function requirePlan(value, source, precision) {
      return resources ? resources.require(value, source, generation, precision) : null;
    }
    function release(ticket, clean) {
      if (!ticket) return;
      ticket.cancel();
      if (clean) ticket.release({apiReleased:true, allocationEnded:true});
      else { ticket.settle({allocationEnded:true}); cleanupFailed = true; }
    }
    function materialize(ticket, value) {
      if (ticket) { var result = ticket.materialize(value); if (!result.ok) throw new Error(result.reason); }
    }
    function assertLive() {
      if (destroyed || !gl || gl.isContextLost()) throw new Error('context-lost');
    }
    function deleteHandle(method, handle) {
      if (!handle || !gl || gl.isContextLost()) return true;
      try { gl[method](handle); return true; } catch (_) { cleanupFailed = true; return false; }
    }
    function retireShaders() {
      var clean = true;
      shaders.forEach(function (shader) { if (!deleteHandle('deleteShader', shader)) clean = false; });
      shaders = []; return clean;
    }
    function destroy() {
      if (destroyed) return {apiReleased:!cleanupFailed, cleanupFailed:cleanupFailed};
      destroyed = true;
      var clean = retireShaders();
      if (!deleteHandle('deleteProgram', prog)) clean = false;
      if (!deleteHandle('deleteVertexArray', vao)) clean = false;
      if (!deleteHandle('deleteBuffer', vbo)) clean = false;
      var textureClean = deleteHandle('deleteTexture', tex);
      try {
        if (gl && !gl.isContextLost()) { var ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
      } catch (_) { clean = false; textureClean = false; }
      // Context loss is an API retirement proof, not physical GPU reclamation.
      if (gl && gl.isContextLost()) clean = textureClean = true;
      try { canvas.width = canvas.height = 0; } catch (_) { clean = false; }
      gl = prog = vao = vbo = tex = inst = null;
      release(fixed, clean); release(surface, clean); release(texture, textureClean);
      if (!clean || !textureClean) cleanupFailed = true;
      return {apiReleased:clean && textureClean, cleanupFailed:cleanupFailed};
    }
    try {
      fixed = requirePlan({gpuContexts:1, programs:1, bufferDeclaredBytes:INSTANCE_BYTES, ownedCpuBytes:INSTANCE_BYTES},
        'Glyph GL context/program and fixed 128x16 Float32 instance CPU/upload');
      var pixels = canvas.width * canvas.height;
      if (!Number.isSafeInteger(pixels) || pixels < 1 || !Number.isSafeInteger(pixels * 4)) throw new Error('estimate-unavailable');
      surface = requirePlan({drawingBufferPixels:pixels, renderTargetDeclaredBytes:pixels * 4}, 'Glyph initial RGBA8 drawing surface', 'bounded-estimate');
      gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: false, antialias: false,
      depth: false, stencil: false, powerPreference: 'low-power'
    });
      if (!gl) { destroy(); return null; }
      materialize(fixed, {gpuContexts:1});
      if (surface) surface.commit();

      prog = gl.createProgram();
      if (!prog) throw new Error('glyph program allocation failed');
      materialize(fixed, {programs:1});
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT, shaders));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG, shaders));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('glyph link: ' + gl.getProgramInfoLog(prog));
      if (!retireShaders()) throw new Error('glyph shader cleanup failed');
    var U = {};
    UNIFORMS.forEach(function (n) {
      U[n.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, n);
    });

    vao = gl.createVertexArray();
    vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('glyph buffer allocation failed');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    inst = new Float32Array(128 * 16);
    materialize(fixed, {ownedCpuBytes:INSTANCE_BYTES});
    gl.bufferData(gl.ARRAY_BUFFER, INSTANCE_BYTES, gl.DYNAMIC_DRAW);
    materialize(fixed, {bufferDeclaredBytes:INSTANCE_BYTES});
    var stride = 16 * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);  gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 16); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 32); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 48); gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (fixed) fixed.settle({allocationEnded:true});
    } catch (error) { destroy(); error.glyphCleanupFailed = cleanupFailed; throw error; }
    var texFormat = gl.RED;
    var texInternal = gl.R8;

    function initTexture(w, h, dual) {
      assertLive();
      if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1
          || w > gl.getParameter(gl.MAX_TEXTURE_SIZE) || h > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error('estimate-unavailable');
      if (tex && texWidth === w && texHeight === h && texDual === !!dual) return;
      var candidateTicket = requirePlan({textureDeclaredBytes:w * h * (dual ? 2 : 1)}, 'Glyph single-context R8/RG8 atlas replacement');
      var candidate = null, format = dual ? gl.RG : gl.RED, internal = dual ? gl.RG8 : gl.R8;
      try {
        candidate = gl.createTexture(); if (!candidate) throw new Error('glyph texture allocation failed');
        gl.bindTexture(gl.TEXTURE_2D, candidate);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.UNSIGNED_BYTE, null);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('glyph texture allocation failed');
        if (candidateTicket) candidateTicket.commit();
      } catch (error) { release(candidateTicket, deleteHandle('deleteTexture', candidate)); throw error; }
      release(texture, deleteHandle('deleteTexture', tex));
      texture = candidateTicket; tex = candidate; texWidth = w; texHeight = h; texDual = !!dual;
      texFormat = format; texInternal = internal;
    }

    function resize(w, h) {
      assertLive();
      if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1) throw new Error('estimate-unavailable');
      if (w === canvas.width && h === canvas.height) return;
      var oldWidth = canvas.width, oldHeight = canvas.height, peak = Math.max(w * oldHeight, w * h);
      if (!Number.isSafeInteger(peak * 4)) throw new Error('estimate-unavailable');
      var next = requirePlan({drawingBufferPixels:peak, renderTargetDeclaredBytes:peak * 4}, 'Glyph resize width-first RGBA8 replacement peak', 'bounded-estimate');
      try {
        canvas.width = w; canvas.height = h;
        if (gl.isContextLost() || gl.drawingBufferWidth !== w || gl.drawingBufferHeight !== h) throw new Error('glyph surface unavailable');
        if (next) next.commit({drawingBufferPixels:w * h, renderTargetDeclaredBytes:w * h * 4});
      } catch (error) {
        var restored = false;
        try { canvas.width = oldWidth; canvas.height = oldHeight; restored = !gl.isContextLost() && gl.drawingBufferWidth === oldWidth && gl.drawingBufferHeight === oldHeight; } catch (_) {}
        release(next, restored); throw error;
      }
      release(surface, true); surface = next;
    }

    // 9 参数重载：(target, level, x, y, w, h, format, type, pixels)。
    // 少写 width/height 不会报「参数错」，只会抛 TypeError 或静默上传 0 字节。
    function uploadCell(x, y, size, bytes) {
      assertLive();
      if (!tex || !Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)
          || x < 0 || y < 0 || x + size > texWidth || y + size > texHeight
          || !(bytes instanceof Uint8Array) || bytes.byteLength !== size * size * (texDual ? 2 : 1)) throw new Error('glyph cell outside admitted atlas');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, size, size, texFormat, gl.UNSIGNED_BYTE, bytes);
    }

    function beginFrame(cssW, cssH) {
      assertLive();
      gl.viewport(0, 0, canvas.width, canvas.height);   // 设备 px
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.uniform2f(U.uResolution, cssW, cssH);          // CSS px，与视口分离
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    function draw(glyphs, n, o) {
      assertLive();
      if (!Number.isSafeInteger(n) || n < 0 || n > 128 || n > glyphs.length) throw new Error('glyph instance capacity');
      if (!n) return;
      var d = inst;
      var cellPx = o.cellPx != null ? o.cellPx : 160;
      var padPx = o.padPx != null ? o.padPx : 16;
      var inner = Math.max(1, cellPx - padPx * 2);
      for (var i = 0; i < n; i += 1) {
        var g = glyphs[i], k = i * 16;
        d[k] = g.x; d[k + 1] = g.y; d[k + 2] = g.w; d[k + 3] = g.h;
        d[k + 4] = g.u0; d[k + 5] = g.v0; d[k + 6] = g.uStart; d[k + 7] = g.uEnd;
        d[k + 8] = g.startMs; d[k + 9] = g.durMs; d[k + 10] = 0; d[k + 11] = 0;
        // 缺省盒子取整个内容盒：只影响辉光远场，不改变字形。
        d[k + 12] = g.box ? g.box.cx : inner / 2;
        d[k + 13] = g.box ? g.box.cy : inner / 2;
        d[k + 14] = g.box ? g.box.hx : inner / 2;
        d[k + 15] = g.box ? g.box.hy : inner / 2;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, n * 16));

      gl.uniform2f(U.uUVSize, o.uvW, o.uvH);
      gl.uniform1f(U.uCellPx, cellPx);
      gl.uniform1f(U.uPadPx, padPx);
      gl.uniform1f(U.uDecorKind, o.decorKind || 0);
      gl.uniform1f(U.uDecorStride, o.decorStride || 1);
      gl.uniform1f(U.uDecorSeed, o.decorSeed || 0);
      gl.uniform1f(U.uDecorDur, o.decorDur || 1800);
      gl.uniform3fv(U.uDecorColor, o.decorColor || o.glowColor || [1, 1, 1]);
      gl.uniform1f(U.uTimeMs, o.timeMs);
      gl.uniform1f(U.uSceneTimeMs, Number.isFinite(o.sceneTimeMs) ? o.sceneTimeMs : o.timeMs);
      gl.uniform1f(U.uShear, o.shear);
      gl.uniform1f(U.uBaseY, o.baseY);
      gl.uniform1f(U.uAmp, o.amp);
      gl.uniform1f(U.uFreq, o.freq);
      gl.uniform1f(U.uDamp, o.damp);
      gl.uniform1fv(U.uCurveB, o.curveB);
      gl.uniform1fv(U.uCurveW, o.curveW);
      gl.uniform1f(U.uRange, o.range);
      gl.uniform1f(U.uPxScale, o.pxScale);
      gl.uniform1f(U.uWeightGain, o.weightGain);
      gl.uniform1f(U.uWeightGainHi, o.weightGainHi != null ? o.weightGainHi : o.weightGain);
      gl.uniform1f(U.uGlowK, o.glowK);
      gl.uniform1f(U.uGlowAmt, o.glowAmt);
      gl.uniform1f(U.uRimAmt, o.rimAmt);
      gl.uniform1f(U.uRimWidth, o.rimWidth);
      gl.uniform1f(U.uClipU, o.clipU);
      gl.uniform1f(U.uSoft, o.soft);
      gl.uniform1f(U.uWobble, o.wobble);
      gl.uniform1f(U.uTurbAmp, o.turbAmp);
      gl.uniform1f(U.uOpacity, o.opacity);
      gl.uniform1f(U.uDual, o.dual ? 1 : 0);
      // 双图集端点：0.30 = 常规面（原生 400），0.50 = 粗面（原生 600/700 同面）。
      // w > 0.50 的加粗交给 SDF 膨胀，因为本机字体没有更粗的面可用。
      gl.uniform1f(U.uWLo, o.wLo != null ? o.wLo : 0.30);
      gl.uniform1f(U.uWHi, o.wHi != null ? o.wHi : 0.50);
      gl.uniform3fv(U.uIdleColor, o.idleColor);
      gl.uniform3fv(U.uSungColor, o.sungColor);
      gl.uniform3fv(U.uGlowColor, o.glowColor);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(U.uAtlas, 0);

      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.bindVertexArray(null);
    }

    return {
      gl: gl, initTexture: initTexture, uploadCell: uploadCell,
      beginFrame: beginFrame, draw: draw, resize: resize,
      destroy: destroy,
      isLost: function () { return destroyed || !gl || gl.isContextLost(); },
      resourceState: function () { return {destroyed:destroyed, cleanupFailed:cleanupFailed,
        fixed:fixed && fixed.state(), surface:surface && surface.state(), texture:texture && texture.state()}; }
    };
  }

  global.LyricGlyphGL = { create: create };
})(window);
