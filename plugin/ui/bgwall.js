// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 弧形背景墙 —— 把用户图片（或生成式背景画布）贴在环绕听众的圆柱内壁上。
//
// 为什么是独立的一份 WebGL2，而不是 creative-gl 的第 6 个场景：
// creative-gl 画的是「舞台里的东西」，随舞台场景切换、且整个 creative stage
// 关闭时它不存在；背景墙是「舞台后面那层」，任何渲染模式下都应该在。
// 两者画布、帧门、生命周期都不同，所以这里是一个刻意做小的独立内核。
//
// 与全项目 GL 风格一致的三条：
//
// 1. **零顶点缓冲。** 整张画面是一个 3 顶点全屏三角形，所有几何在片元着色器
//    里用解析式算（射线 → 圆柱求交 → UV）。没有 VBO/IBO/VAO 要建、要丢。
//
// 2. **媒体纹理长边 ≤1024。** 源图先画进一张上传画布再进 GL：背景是低频
//    大图，4K 原图进纹理纯属浪费显存与上传带宽。视频每帧重传这张 1024 图。
//
// 3. **不可用就摘画布。** WebGL2 缺失 / 编译失败 / 上下文丢失，调用方立刻把
//    画布从 DOM 摘除并降级到视差，设置页展示「生效真相」而不是留一块黑。

(function () {
  'use strict';

  var MAX_TEX_EDGE = 1024;

  var VERT = [
    '#version 300 es',
    'void main() {',
    '  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // 圆柱内壁：相机在 (0, h, 0) 看向 -z，视线与 xz 平面上半径 R 的圆柱求交。
  // 命中点的方位角 → u，高度 → v，按 cover 方式采样图片；边缘雾化进深色，
  // 能量只做轻微亮度推让，背景不跟舞台抢注意力。
  var FRAG = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D uTex;',
    'uniform float uYaw;',
    'uniform float uPitch;',
    'uniform float uEnergy;',
    'uniform vec2 uRes;',         // 画布像素分辨率
    'uniform float uAspect;',     // 画布宽高比
    'uniform float uTexAspect;',  // 纹理宽高比
    'uniform float uHasTex;',
    'out vec4 frag;',
    '',
    'mat3 rotY(float a) {',
    '  float s = sin(a), c = cos(a);',
    '  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);',
    '}',
    'mat3 rotX(float a) {',
    '  float s = sin(a), c = cos(a);',
    '  return mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c);',
    '}',
    '',
    'void main() {',
    '  vec2 nd = gl_FragCoord.xy / uRes * 2.0 - 1.0;',
    '  float tf = tan(radians(28.0));',
    '  vec3 rd = normalize(vec3(nd.x * tf * uAspect, nd.y * tf, -1.0));',
    '  rd = rotY(uYaw) * rotX(uPitch) * rd;',
    '  vec3 ro = vec3(0.0, 1.25, 0.0);',
    '',
    '  float R = 10.0;',
    '  float A = dot(rd.xz, rd.xz);',
    '  float B = 2.0 * dot(ro.xz, rd.xz);',
    '  float Cc = dot(ro.xz, ro.xz) - R * R;',
    '  float disc = B * B - 4.0 * A * Cc;',
    '',
    '  vec3 deep = vec3(0.012, 0.017, 0.026);',
    '  vec3 col = deep;',
    '',
    '  if (disc > 0.0 && A > 1e-5) {',
    '    // 相机在圆柱「内部」（ro 到轴的距离 < R），近交点 t 为负、在身后；',
    '    // 要取 +sqrt 那个远交点，它才是视线前方的墙（取反会整屏雾化成 deep）。',
    '    float t = (-B + sqrt(disc)) / (2.0 * A);',
    '    vec3 hit = ro + rd * t;',
    '    float angSpan = 1.42;',                 // 墙张到两侧约 81°
    '    float ang = atan(hit.x, -hit.z);',      // 0 = 正前方
    '    float u = ang / angSpan;',
    '    float yBot = -5.5, yTop = 9.5;',
    '    float v = (hit.y - yBot) / (yTop - yBot);',
    '',
    '    // cover：弧长/墙高 与 图片宽高比 对齐，短边铺满、长边裁切',
    '    float wallAspect = (R * 2.0 * angSpan) / (yTop - yBot);',
    '    vec2 uv;',
    '    if (wallAspect > uTexAspect) {',
    '      float fit = uTexAspect / wallAspect;',
    '      uv = vec2(u * 0.5 + 0.5, (v - 0.5) * fit + 0.5);',
    '    } else {',
    '      float fit = wallAspect / uTexAspect;',
    '      uv = vec2(u * 0.5 * fit + 0.5, v);',
    '    }',
    '',
    '    if (uHasTex > 0.5 && all(greaterThanEqual(uv, vec2(0.0))) &&',
    '        all(lessThanEqual(uv, vec2(1.0)))) {',
    '      // 纹理按原始行序上传，v=1 是图片顶边',
    '      col = texture(uTex, vec2(uv.x, uv.y)).rgb;',
    '    } else {',
    '      col = deep * 1.35;',
    '    }',
    '    // 两侧雾化进深，让墙的边缘不是一条硬切线',
    '    float edge = smoothstep(0.72, 1.0, abs(u));',
    '    col = mix(col, deep, edge);',
    '    float vfade = smoothstep(0.0, 0.12, v) * (1.0 - smoothstep(0.9, 1.0, v));',
    '    col *= 0.55 + 0.45 * vfade;',
    '  }',
    '',
    '  col *= 0.88 + uEnergy * 0.22;',
    '  frag = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var host = null;
  var canvas = null;
  var gl = null;
  var prog = null;
  var U = {};
  var tex = null;
  var upCanvas = null;
  var upCtx = null;
  var texW = 0, texH = 0;
  var source = null;
  var onLost = null;

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader compile failed: ' + log);
    }
    return sh;
  }

  function initGl() {
    gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'low-power'
    });
    if (!gl) return false;

    var vs = compile(gl.VERTEX_SHADER, VERT);
    var fs = compile(gl.FRAGMENT_SHADER, FRAG);
    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('program link failed: ' + gl.getProgramInfoLog(prog));
    }

    ['uTex', 'uYaw', 'uPitch', 'uEnergy', 'uRes',
      'uAspect', 'uTexAspect', 'uHasTex'].forEach(function (n) {
        U[n] = gl.getUniformLocation(prog, n);
      });

    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    upCanvas = document.createElement('canvas');
    upCtx = upCanvas.getContext('2d', { willReadFrequently: false });

    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      var cb = onLost;
      gl = null;
      if (cb) cb();
    });
    return true;
  }

  // 源 → 上传画布（长边 ≤1024）→ GL 纹理。返回当前是否拿到了有效帧。
  function upload() {
    if (!gl || !source) return false;
    var sw = source.videoWidth || source.naturalWidth || source.width;
    var sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) return false;
    if (source.readyState !== undefined && source.readyState < 2) return false;

    var dw, dh;
    if (sw >= sh) {
      dw = Math.min(sw, MAX_TEX_EDGE);
      dh = Math.max(1, Math.round(sh * dw / sw));
    } else {
      dh = Math.min(sh, MAX_TEX_EDGE);
      dw = Math.max(1, Math.round(sw * dh / sh));
    }
    if (upCanvas.width !== dw || upCanvas.height !== dh) {
      upCanvas.width = dw;
      upCanvas.height = dh;
    }
    try {
      upCtx.drawImage(source, 0, 0, dw, dh);
    } catch (e) {
      return false; // 视频帧还没准备好 / 跨源，跳过这一帧
    }

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, upCanvas);
    texW = dw; texH = dh;
    return true;
  }

  function resize() {
    if (!canvas || !gl) return;
    // 背景层，DPR 压到 1：省下的像素在边缘雾化与上层压暗里根本看不出来。
    var dpr = Math.min(window.devicePixelRatio || 1, 1);
    var w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    var h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  var api = {
    // hostEl：#creative-bg。成功时画布已挂进 DOM 且 GL 就绪。
    attach: function (hostEl, lostCb) {
      if (gl) return true;
      // contextlost 后内部 canvas 变量还指着那张"死"画布，先摘掉再建新的
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      host = hostEl;
      onLost = lostCb || null;
      canvas = document.createElement('canvas');
      canvas.id = 'creative-bg-wall';
      canvas.setAttribute('aria-hidden', 'true');
      try {
        if (!initGl()) {
          if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
          canvas = null;
          return false;
        }
      } catch (e) {
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        canvas = null; gl = null;
        return false;
      }
      host.appendChild(canvas);
      resize();
      return true;
    },

    detach: function () {
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      source = null;
    },

    // 彻底释放：切回主题 / 长时间不用时调用，连 GL 上下文一起还回去。
    dispose: function () {
      api.detach();
      if (gl) {
        var ext = gl.getExtension('WEBGL_lose_context');
        if (ext) try { ext.loseContext(); } catch (e) { /* 忽略 */ }
      }
      canvas = null; gl = null; prog = null; tex = null;
      upCanvas = null; upCtx = null; U = {}; texW = texH = 0;
    },

    setSource: function (el) { source = el; },

    // o: { timeMs, yaw, pitch, energy }
    render: function (dtMs, o) {
      if (!gl) return false;
      resize();
      var has = upload();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(U.uTex, 0);
      gl.uniform1f(U.uYaw, (o && o.yaw) || 0);
      gl.uniform1f(U.uPitch, (o && o.pitch) || 0);
      gl.uniform1f(U.uEnergy, (o && o.energy) || 0);
      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      gl.uniform1f(U.uAspect, canvas.width / canvas.height);
      gl.uniform1f(U.uTexAspect, texW && texH ? texW / texH : 1.6);
      gl.uniform1f(U.uHasTex, has ? 1 : 0);
      gl.disable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    },

    resize: resize,
    ready: function () { return !!gl; },
    textureSize: function () { return texW ? [texW, texH] : null; }
  };

  window.BgWall = api;
})();
