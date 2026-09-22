// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 星河舞台背景（Mineradio 风格）：全天闪烁星野 + 横贯下半区的流动星河。
//
// 与粒子专辑封面（stage-cover-particles.js）同级、互斥：两者共用 .lp-cover
// 背景盒，由 stage.js 的场景状态（'cover' / 'starriver'）切换。星河不依赖
// 专辑封面图——没有封面的曲目也能完整呈现。
//
// 分层渲染（两套程序、四个空间层）：
//   · 深天星野  SKY：全天均匀星 + 向星带聚集的高斯星，慢速视差漂移；
//   · 主星河    RIVER，一个程序内分三种粒子、三个景深：
//       尘雾 dust  —— 星带的外层密度梯度，慢、小、弥散；
//       光带 lane  —— 5 条 Mineradio 流动光带；
//       近闪 near  —— 少量更近、更快、更亮的掠屏亮点。
//     景深层（far/mid/near）给出不同速度/尺寸/亮度与 z 推移，旋转视角时
//     各层产生视差，空间层次由此建立。
//   片元级闪烁统一采用 Mineradio 的 pow(…,4) 曲线与 lane 色彩混合。
//
// 分辨率一致性：点尺寸公式 = 世界单位 * uPixel(DPR) * 120/distance，
// 在任何分辨率/像素比下屏幕尺寸一致；设备档只调整粒子总数与 DPR 上限。
//
// WebGL 不可用时静默放弃，stage.js 自动退回 CSS 旋转封面。不自己起 rAF，
// 通过 Stage.gate() 挂进 stage.js 的单一帧循环。

(function () {
  'use strict';

  var CAM_Z = 9.0;
  var FOV_DEG = 30.5;            // 与粒子封面同一相机：铺满短边
  var PLANE_HALF_H = 2.45;       // z=0 平面的可见半高
  // 三档粒子数：[深天星野, 主星河]
  var SKY_COUNTS = [1500, 2500, 3600];
  var RIVER_COUNTS = [800, 1250, 1850];
  var DPR_CAP = [1.0, 1.4, 1.75];
  var TIER_FPS = [18, 26, 34];
  var BAND_Y = -0.75;            // 星河带中心（世界单位，下半区）
  var BAND_H = 1.0;              // 星河带纵向展开尺度

  var coverEl = null;
  var canvas = null;
  var gl = null;
  var proj = new Float32Array(16);
  var aspect = 1;
  var sky = null;                // {prog, u, buf, count}
  var river = null;              // {prog, u, buf, count}
  var dotTex = null;
  var onset = null;

  var active = false;
  var attached = false;
  var playing = false;
  var reduced = false;
  var lowfx = false;
  var playT = 0;
  var timeSec = 0;
  var bufW = 0;
  var bufH = 0;
  var dprUsed = 1;
  var needsFrame = false;
  var lastSpectrum = null;
  var lastSpectrumAt = 0;
  var SILENCE = new Float64Array(64);

  function nowMs() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function tauAlpha(dtMs, tauMs) { return 1 - Math.exp(-Math.max(0.001, dtMs) / tauMs); }
  function tierIndex() {
    var t = window.Stage ? Stage.tier() : 2;
    return t < 0 ? 0 : t > 2 ? 2 : t;
  }

  function perspective(out, fovDeg, asp, near, far) {
    var f = 1 / Math.tan((fovDeg * Math.PI / 180) / 2);
    var nf = 1 / (near - far);
    out[0] = f / asp; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
  }

  // 圆点纹理（与 Mineradio 同一条径向曲线）
  function makeDotTexture() {
    var cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    var ctx = cv.getContext('2d');
    var g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
    g.addColorStop(0.00, 'rgba(255,255,255,0.96)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.78)');
    g.addColorStop(0.72, 'rgba(255,255,255,0.22)');
    g.addColorStop(1.00, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // -------------------------------------------------------------------------
  // 着色器
  // -------------------------------------------------------------------------

  // ---- 深天星野 ----
  var SKY_VERT = [
    'precision highp float;',
    'attribute float aX;',          // 0..1 → 横向映射到可见宽度
    'attribute vec3 aDist;',        // y, z, seed
    'attribute float aTint;',       // 0 冷色 / 1 暖色 / 2 白
    'uniform mat4 uProj;',
    'uniform float uTime,uPixel,uPlay,uBeat,uCamZ,uWidth2;',
    'varying float vTint,vAlpha,vSeed;',
    'void main(){',
    '  float seed=aDist.z;',
    // 慢速视差横移：近一点的星位移略大，远星几乎不动
    '  float x=(aX-0.5)*uWidth2',
    '    + sin(uTime*(0.05+0.05*fract(seed))+seed*12.0)*0.16*(0.3+0.7*fract(seed*1.3));',
    '  float y=aDist.x',
    '    + sin(uTime*(0.04+0.07*fract(seed*2.1))+seed*30.0)*0.05;',
    '  vec3 p=vec3(x,y,aDist.y);',
    '  vec4 vp=vec4(p.x,p.y,p.z-uCamZ,1.0);',
    '  gl_Position=uProj*vp;',
    '  float tw=0.55+0.45*sin(uTime*(0.7+fract(seed)*1.3)+seed*40.0);',
    // 星等梯度：seed 决定基础亮度，天然形成明暗不一的星野
    '  float a=(0.08+0.15*seed)*(0.35+0.65*tw);',
    // 播放时星野整体亮、鼓点短促加亮；暂停时淡成安静疏星
    '  a*=0.30+uPlay*1.0+uBeat*0.7*uPlay;',
    '  vAlpha=a;',
    '  vTint=aTint;',
    '  vSeed=seed;',
    '  float depthSize=36.0/max(0.5,-vp.z);',
    '  float size=depthSize*(0.5+0.8*seed)*(1.0+uBeat*0.5*uPlay);',
    '  gl_PointSize=clamp(size*uPixel,1.0,5.0);',
    '}'
  ].join('\n');

  var SKY_FRAG = [
    'precision highp float;',
    'uniform sampler2D uDot;',
    'uniform vec3 uColorA,uColorB;',
    'uniform float uAlpha;',
    'varying float vTint,vAlpha,vSeed;',
    'void main(){',
    '  vec4 tex=texture2D(uDot,gl_PointCoord);',
    '  if(tex.a<0.02) discard;',
    '  float t=clamp(vTint,0.0,1.0);',
    '  vec3 col=mix(uColorA,uColorB,t);',
    '  if(vTint>1.0) col=mix(col,vec3(1.0),clamp(vTint-1.0,0.0,1.0));',
    '  float a=tex.a*vAlpha*uAlpha;',
    '  if(a<0.004) discard;',
    '  gl_FragColor=vec4(col,a);',
    '}'
  ].join('\n');

  // ---- 主星河（尘雾 / 5 条光带 / 近闪，远中近三景深）----
  var RIVER_VERT = [
    'precision highp float;',
    // stride 5：seed, kind(0光带/1尘雾), layer(0远/1中/2近), lane, tint
    'attribute float aSeed,aKind,aLayer,aLane,aTint;',
    'uniform mat4 uProj;',
    'uniform float uTime,uPixel,uPlay,uBass,uBeat,uCamZ;',
    'uniform float uWidth,uBandY,uHeight;',
    'varying float vTint,vGlow,vAlpha,vSeed,vLayer,vKind;',
    'float hash(float n){return fract(sin(n)*43758.5453123);}',
    'void main(){',
    // 景深分层系数
    '  float far = step(aLayer,0.5);',
    '  float near = step(1.5,aLayer);',
    '  float speedMul = far*0.65 + (1.0-far-near)*1.0 + near*1.8;',
    '  float sizeMul  = far*0.6 + (1.0-far-near)*1.0 + near*1.8;',
    '  float zPush    = far*(-0.3) + near*0.7;',
    '  float seed=aSeed;',
    '  float x; float y; float glowBase;',
    '  if(aKind>0.5){',
    // ---- 弥散尘雾：星带外层密度梯度，慢速连续漂移，无明显出入屏 ----
    '    float sp=0.006+hash(seed*1.7)*0.014;',
    '    float fl=fract(hash(seed*2.1)+uTime*sp*speedMul*7.0);',
    '    x=(fl-0.5)*uWidth*1.25;',
    '    y=uBandY+aLane*uHeight*1.7',
    '      + sin(fl*6.28+seed+uTime*0.15)*uHeight*0.25;',
    '    glowBase=0.30+0.25*sin(uTime*(0.5+0.5*hash(seed*3.3))+seed*7.0);',
    '  } else {',
    // ---- 5 条流动光带（Mineradio 算法）----
    '    float laneBand=floor(aLane*5.0);',
    '    float laneLocal=fract(aLane*5.0);',
    '    float speed=0.030+hash(seed*1.71)*0.055+laneBand*0.005;',
    '    float flow=fract(hash(seed*2.13)+uTime*speed*speedMul);',
    '    x=(flow-0.5)*uWidth*(1.08+hash(seed*5.1)*0.18);',
    '    float curve=sin(flow*6.2831853*(0.92+hash(seed*4.0)*0.46)+seed*0.071+uTime*0.34);',
    '    float breath=sin(uTime*(0.42+hash(seed*6.9)*0.42)+seed*0.093);',
    '    y=uBandY+(laneBand-2.0)*uHeight*0.135',
    '      +curve*uHeight*(0.20+hash(seed*9.0)*0.18)',
    '      +(laneLocal-0.5)*uHeight*0.16+breath*uHeight*0.10;',
    // 出入屏边缘：粒子从两侧淡入淡出，流动感主要来自这里
    '    glowBase=smoothstep(0.0,0.18,flow)*(1.0-smoothstep(0.82,1.0,flow));',
    '  }',
    '  float z=-0.08+(hash(seed*7.7)-0.5)*0.4+zPush',
    '    +sin(uTime*(0.18+hash(seed)*0.24)+seed)*0.08;',
    '  vec3 pos=vec3(x,y,z);',
    '  float glow=glowBase*(0.62+0.38*sin(uTime*(0.9+hash(seed*8.0)*0.7)+seed));',
    '  vGlow=glow; vTint=aTint; vSeed=seed; vLayer=near; vKind=aKind;',
    '  vec4 mv=vec4(pos.x,pos.y,pos.z-uCamZ,1.0);',
    '  gl_Position=uProj*mv;',
    '  float dist=max(0.45,-mv.z);',
    '  float base=(0.030+hash(seed*12.0)*0.040+glow*0.024+uBeat*0.010)*(1.0+uBass*0.18);',
    // 光带粒子更大更醒目，尘雾压小做背景层次
    '  base*= (aKind>0.5?0.55:1.25)*(0.8+near*0.9);',
    '  gl_PointSize=clamp(base*uPixel*120.0/dist*sizeMul,1.0,near>0.5?9.0:7.2);',
    // 基础透明度（具体亮度项在片元里叠）：尘雾更柔、近层更亮
    '  vAlpha=(aKind>0.5?0.55:1.0)*(far*0.75+(1.0-far-near)*1.0+near*1.25);',
    '}'
  ].join('\n');

  // 片元：Mineradio 片元闪烁 + lane 色彩混合
  var RIVER_FRAG = [
    'precision highp float;',
    'uniform sampler2D uDot;',
    'uniform vec3 uColorA,uColorB;',
    'uniform float uAlpha,uTime,uBeat,uPlay;',
    'varying float vTint,vGlow,vAlpha,vSeed,vLayer,vKind;',
    'void main(){',
    '  vec4 tex=texture2D(uDot,gl_PointCoord);',
    '  if(tex.a<0.02) discard;',
    // 片元级闪烁：pow4 曲线，与 Mineradio 同款
    '  float tw=pow(0.5+0.5*sin(uTime*(0.55+fract(vSeed)*0.35)+vSeed),4.0);',
    '  vec3 col=mix(uColorA,uColorB,',
    '    smoothstep(0.12,0.92,fract(vSeed*3.7))*0.45+tw*0.42+vGlow*0.26);',
    // tint 0 = 冷色，1 = 暖色，>1 = 白色
    '  col=mix(col,uColorA,clamp(1.0-vTint,0.0,1.0)*0.25);',
    '  if(vTint>1.0) col=mix(col,vec3(1.0),clamp(vTint-1.0,0.0,1.0)*0.8);',
    '  col=col*(0.82+vGlow*0.6+tw*0.3);',
    // 光带提亮、尘雾压暗，强化星带的主次层次
    '  col*= (vKind>0.5?0.75:1.1);',
    '  float a=tex.a*uAlpha*(0.20+vGlow*0.78+tw*0.32+uBeat*0.10)*vAlpha;',
    '  a*= (vKind>0.5?0.55:1.3);',
    // 播放/暂停明暗
    '  a*=0.30+uPlay*0.9;',
    '  if(a<0.004) discard;',
    '  gl_FragColor=vec4(col,a);',
    '}'
  ].join('\n');

  // -------------------------------------------------------------------------
  // GL 搭建
  // -------------------------------------------------------------------------

  function linkProgram(vsSrc, fsSrc, names) {
    var vs = null, fs = null;
    try {
      vs = gl.createShader(gl.VERTEX_SHADER);
      fs = gl.createShader(gl.FRAGMENT_SHADER);
    } catch (e) { vs = fs = null; }
    if (!vs || !fs) {
      if (vs) try { gl.deleteShader(vs); } catch (e) { /* ignore */ }
      if (fs) try { gl.deleteShader(fs); } catch (e) { /* ignore */ }
      return null;
    }
    var prog;
    try {
      gl.shaderSource(vs, vsSrc);
      gl.shaderSource(fs, fsSrc);
      gl.compileShader(vs);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        console.warn('星河顶点着色器编译失败：', gl.getShaderInfoLog(vs));
        return null;
      }
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        console.warn('星河片元着色器编译失败：', gl.getShaderInfoLog(fs));
        return null;
      }
      prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.warn('星河程序链接失败：', gl.getProgramInfoLog(prog));
        gl.deleteProgram(prog);
        return null;
      }
      // 链接产物已内含在程序里：立刻 detach+delete shader，释放 live shader
      // 槽位（部分 GPU 进程对 live shader 总数有硬上限，不释放会让后续程序
      // 的 createShader 静默返回 null）。
      gl.detachShader(prog, vs);
      gl.detachShader(prog, fs);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    } catch (e) {
      try { gl.deleteProgram(prog); } catch (e2) { /* ignore */ }
      return null;
    }
    var u = {};
    names.forEach(function (n) { u[n] = gl.getUniformLocation(prog, n); });
    var buf = null;
    try { buf = gl.createBuffer(); } catch (e) {
      gl.deleteProgram(prog);
      return null;
    }
    return { prog: prog, u: u, buf: buf };
  }

  function gauss() {
    var u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // -------------------------------------------------------------------------
  // 几何
  // -------------------------------------------------------------------------
  function buildSky(count) {
    // stride 5：aX, y, z, seed, tint
    var a = new Float32Array(count * 5);
    for (var i = 0; i < count; i += 1) {
      var o = i * 5;
      a[o] = Math.random();
      var y;
      // 55% 全天均匀；45% 向星河带中心高斯聚集（星带后方的密度背景）
      if (Math.random() < 0.55) {
        y = Math.random() * 2 - 1;
        y *= PLANE_HALF_H;
      } else {
        y = BAND_Y + gauss() * 0.55;
        if (y < -PLANE_HALF_H) y = -PLANE_HALF_H;
        if (y > PLANE_HALF_H) y = PLANE_HALF_H;
      }
      a[o + 1] = y;
      // z 景深：星野整体在星带之后
      a[o + 2] = (Math.random() - 0.5) * 0.5 - 0.15;
      a[o + 3] = Math.random();
      // 50% 暖 / 30% 冷 / 20% 白
      var r = Math.random();
      a[o + 4] = r < 0.5 ? 1 : (r < 0.8 ? 0 : 2);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, sky.buf);
    gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
    sky.count = count;
  }

  function buildRiver(count) {
    // stride 5：seed, kind, layer, lane, tint
    var a = new Float32Array(count * 5);
    for (var i = 0; i < count; i += 1) {
      var o = i * 5;
      a[o] = Math.random() * 1000;
      var r = Math.random();
      var kind; var layer; var lane;
      // 构成比例：12% 近闪掠屏，38% 弥散尘雾，50% 光带
      if (r < 0.12) {
        kind = 0; layer = 2; lane = Math.random();
      } else if (r < 0.50) {
        kind = 1; layer = Math.random() < 0.3 ? 0 : 1;
        // 尘雾纵向高斯展开（存在 lane 属性里）
        lane = Math.max(-2.2, Math.min(2.2, gauss()));
      } else {
        kind = 0;
        var rl = Math.random();
        layer = rl < 0.22 ? 0 : (rl < 0.9 ? 1 : 2);
        lane = Math.random();
      }
      a[o + 1] = kind;
      a[o + 2] = layer;
      a[o + 3] = lane;
      // 50% 暖 / 30% 冷 / 20% 白
      var r2 = Math.random();
      a[o + 4] = r2 < 0.5 ? 1 : (r2 < 0.8 ? 0 : 2);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, river.buf);
    gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
    river.count = count;
  }

  function bindAttrs(progSet, attrs) {
    // 无 VAO：逐程序设置顶点属性指针（全局状态，绘制该程序前生效）
    var stride = attrs.length * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, progSet.buf);
    attrs.forEach(function (at) {
      var loc = gl.getAttribLocation(progSet.prog, at.name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, at.size, gl.FLOAT, false, stride, at.offset * 4);
    });
  }

  // -------------------------------------------------------------------------
  // 配色
  // -------------------------------------------------------------------------
  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function parseRgb(str, dflt) {
    var parts = String(str).split(',');
    var out = dflt.slice();
    for (var i = 0; i < 3; i += 1) {
      var n = parseFloat(parts[i]);
      if (isFinite(n)) out[i] = Math.max(0, Math.min(255, n)) / 255;
    }
    return out;
  }

  var colorHi = [0.95, 0.9, 0.75];
  var colorAlt = [0.55, 0.8, 1.0];

  function readColors() {
    colorHi = parseRgb(cssVar('--music-highlight-rgb', '242, 230, 191'),
      [0.95, 0.9, 0.75]);
    colorAlt = parseRgb(cssVar('--music-highlight-alt-rgb', '140, 200, 255'),
      [0.55, 0.8, 1.0]);
  }

  // -------------------------------------------------------------------------
  // 尺寸
  // -------------------------------------------------------------------------
  function resize(force) {
    if (!canvas) return false;
    // 构建期间画布还没挂 gl-active（display:none，client 尺寸为 0）：
    // 直接用视口尺寸——激活后画布就是 100vw×100vh，尺寸一致。
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    if (!w || !h) return false;
    var dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP[tierIndex()]);
    var bw = Math.round(w * dpr);
    var bh = Math.round(h * dpr);
    if (!force && bw === bufW && bh === bufH) return true;
    canvas.width = bw;
    canvas.height = bh;
    bufW = bw;
    bufH = bh;
    dprUsed = dpr;
    aspect = bw / bh;
    perspective(proj, FOV_DEG, aspect, 0.1, 100);
    return true;
  }

  // -------------------------------------------------------------------------
  // 绘制
  // -------------------------------------------------------------------------
  function setUniforms(set, extra) {
    var u = set.u;
    if (u.uProj) gl.uniformMatrix4fv(u.uProj, false, proj);
    if (u.uTime) gl.uniform1f(u.uTime, timeSec);
    if (u.uPixel) gl.uniform1f(u.uPixel, dprUsed);
    if (u.uPlay) gl.uniform1f(u.uPlay, playT);
    if (u.uBeat) gl.uniform1f(u.uBeat, beatV);
    if (u.uBass) gl.uniform1f(u.uBass, bassV);
    if (u.uCamZ) gl.uniform1f(u.uCamZ, CAM_Z);
    if (u.uDot) gl.uniform1i(u.uDot, 0);
    if (u.uAlpha) gl.uniform1f(u.uAlpha, 1);
    if (u.uColorA) gl.uniform3fv(u.uColorA, colorAlt);
    if (u.uColorB) gl.uniform3fv(u.uColorB, colorHi);
    if (extra) extra(u);
  }

  var bassV = 0;
  var beatV = 0;

  // 共享上下文：禁用其他模块遗留的顶点属性数组
  function resetVertexArrays() {
    var n = gl.getParameter(gl.MAX_VERTEX_ATTRIBS);
    for (var i = 0; i < n; i += 1) gl.disableVertexAttribArray(i);
  }

  function draw() {
    gl.viewport(0, 0, bufW, bufH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dotTex);

    var halfW = PLANE_HALF_H * aspect;

    // 第一趟：深天星野
    gl.useProgram(sky.prog);
    resetVertexArrays();
    bindAttrs(sky, [
      { name: 'aX', size: 1, offset: 0 },
      { name: 'aDist', size: 3, offset: 1 },
      { name: 'aTint', size: 1, offset: 4 }
    ]);
    setUniforms(sky, function (u) {
      if (u.uWidth2) gl.uniform1f(u.uWidth2, halfW * 2 * 1.05);
    });
    gl.drawArrays(gl.POINTS, 0, sky.count);

    // 第二趟：主星河（尘雾 + 光带 + 近闪）
    gl.useProgram(river.prog);
    bindAttrs(river, [
      { name: 'aSeed', size: 1, offset: 0 },
      { name: 'aKind', size: 1, offset: 1 },
      { name: 'aLayer', size: 1, offset: 2 },
      { name: 'aLane', size: 1, offset: 3 },
      { name: 'aTint', size: 1, offset: 4 }
    ]);
    setUniforms(river, function (u) {
      if (u.uWidth) gl.uniform1f(u.uWidth, halfW * 2 * 1.1);
      if (u.uBandY) gl.uniform1f(u.uBandY, BAND_Y);
      if (u.uHeight) gl.uniform1f(u.uHeight, BAND_H);
    });
    gl.drawArrays(gl.POINTS, 0, river.count);
  }

  // -------------------------------------------------------------------------
  // 帧门
  // -------------------------------------------------------------------------
  function targetFps() {
    if (!window.Stage || Stage.isHidden() || !active) return 0;
    if (!Stage.isPageOpen() || Stage.scene() !== 'starriver') return 0;
    if (needsFrame) return 24;
    var target = playing && !reduced ? 1 : 0;
    if (playing) return TIER_FPS[tierIndex()];
    if (Math.abs(playT - target) > 0.002) return 20;
    return 0;
  }

  function tick(dtMs) {
    if (!active) return;
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.body.classList.contains('reduce-motion');
    lowfx = Stage.tier() === 0;
    timeSec += dtMs / 1000;

    playing = document.body.classList.contains('is-playing');
    var targetPlay = playing && !reduced ? 1 : 0;
    playT += (targetPlay - playT) * tauAlpha(dtMs, playing ? 300 : 420);
    playT = clamp01(playT);

    // 分带：星河只需要底鼓亮度与节拍脉冲
    var sp = Stage.spectrum();
    if (sp && sp.length && sp !== lastSpectrum) {
      lastSpectrum = sp;
      lastSpectrumAt = nowMs();
    }
    var fresh = !!(sp && sp.length) && (nowMs() - lastSpectrumAt < 600);
    onset.step(dtMs, fresh ? sp : SILENCE, nowMs());
    bassV = onset.agg[0];
    beatV = onset.pulse;

    if (resize(false)) draw();
    needsFrame = false;
  }

  // -------------------------------------------------------------------------
  // init（一次性接线）+ GL 异步重试构建
  // -------------------------------------------------------------------------

  function deleteProgramSafe(p) {
    if (!p) return;
    try { if (p.prog) gl.deleteProgram(p.prog); } catch (e) { /* ignore */ }
  }

  function delay(ms){ return new Promise(function(res){setTimeout(res,ms);}); }

  // 一次 GL 构建尝试（异步顺序化）；任何资源/编译失败返回 false，由 tryBuild 重试。
  // 各重步骤之间留小等待：部分 GPU 进程在链接/编译刚结束的瞬间 createShader
  // 会静默返回 null，顺序化后给后端留出释放/收口的时间。
  function buildGL() {
    sky = linkProgram(SKY_VERT, SKY_FRAG, ['uProj', 'uTime', 'uPixel',
      'uPlay', 'uBeat', 'uCamZ', 'uWidth2', 'uDot', 'uAlpha',
      'uColorA', 'uColorB']);
    if (!sky) return Promise.resolve(false);
    return delay(60).then(function(){
      river = linkProgram(RIVER_VERT, RIVER_FRAG, ['uProj', 'uTime', 'uPixel',
        'uPlay', 'uBass', 'uBeat', 'uCamZ', 'uWidth', 'uBandY', 'uHeight',
        'uDot', 'uAlpha', 'uColorA', 'uColorB']);
      if (!river) return false;
      return delay(40);
    }).then(function(ok){
      if(ok===false) return false;
      try { dotTex = makeDotTexture(); } catch (e) { dotTex = null; }
      if (!dotTex) return false;

      var ti = tierIndex();
      try {
        buildSky(SKY_COUNTS[ti]);
        buildRiver(RIVER_COUNTS[ti]);
      } catch (e) { return false; }

      onset = Onset.create({ groups: Onset.GROUPS });

      readColors();
      if (!resize(true)) return false;
      needsFrame = true;
      return true;
    });
  }

  function disposeGL() {
    deleteProgramSafe(sky);
    deleteProgramSafe(river);
    if (dotTex) { try { gl.deleteTexture(dotTex); } catch (e) { /* ignore */ } }
    sky = null;
    river = null;
    dotTex = null;
    onset = null;
  }

  // 退避表：GPU 进程在高负载机器上可能 10 秒内都无法受理新 shader，
  // 重试必须覆盖整个忙窗口，而不是 3 秒内快速耗尽。
  var BACKOFF_MS = [300, 1000, 2500, 5000, 8000];

  function scheduleRetry(attempt) {
    // attempt 从 1 起：映射到下标 attempt-1（300ms → 1s → 2.5s → 5s → 8s）
    if (attempt <= BACKOFF_MS.length) {
      setTimeout(function () { tryBuild(attempt); }, BACKOFF_MS[attempt - 1]);
    } else {
      fallback();
    }
  }

  function tryBuild(attempt) {
    Promise.resolve().then(buildGL).then(function (ok) {
      if (ok) {
        active = true;
        // 同步背景类（构建期间 active 一直 false，gl-active 可能还没挂上）
        try { Stage.repaint(); } catch (e) { Stage.kick(); }
        return;
      }
      disposeGL();
      scheduleRetry(attempt + 1);
    }).catch(function () {
      try { disposeGL(); } catch (e) { /* ignore */ }
      scheduleRetry(attempt + 1);
    });
  }

  function init() {
    if (attached) return api;
    if (!window.Stage || typeof Stage.gate !== 'function' || !window.Onset) return null;
    // 共享 GL 宿主：画布与上下文来自 stage-gl-host.js
    var host = window.StageGLHost;
    if (!host || !host.gl() || !host.canvas()) return null;
    canvas = host.canvas();
    gl = host.gl();
    coverEl = document.querySelector('.lp-cover');
    if (!coverEl) return null;

    attached = true;

    Stage.gate('starriver', targetFps, tick);

    // 取色变化：重读强调色
    document.addEventListener('stage:retint', function () {
      readColors();
      needsFrame = true;
      Stage.kick();
    });

    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        if (!active) return;
        if (resize(false)) { needsFrame = true; Stage.kick(); }
      }).observe(canvas);
    }

    // 不阻塞启动序列：GL 资源紧张时异步重试，全部失败才退回 CSS 卡片
    tryBuild(0);
    return api;
  }

  // WebGL/纹理最终失败时退回 CSS 卡片
  function fallback() {
    active = false;
    if (coverEl) coverEl.classList.remove('gl-active');
  }

  // 销毁：释放 GL 资源、摘 gl-active、注销帧门
  function destroy() {
    if (window.Stage && Stage.removeGate) Stage.removeGate('starriver');
    disposeGL();
    active = false;
    if (coverEl) coverEl.classList.remove('gl-active');
  }

  var api = {
    init: init,
    destroy: destroy,
    active: function () { return active; },
    skyCount: function () { return sky ? sky.count : 0; },
    riverCount: function () { return river ? river.count : 0; }
  };

  window.StageStarRiver = api;
})();
