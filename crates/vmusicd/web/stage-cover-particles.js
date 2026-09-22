// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 3D 粒子舞台封面（Mineradio 风格）。
//
// 表现：
//   · 暂停 —— 粒子按规整点阵落位，颜色逐点采样封面，静态封面；
//   · 播放 —— 底鼓呼吸、中频波浪、高频抖动，鼓点落下时从随机区域扩散
//              凸起+圆环涟漪，粒子尺寸随节拍脉动；播放/暂停由 uPlay 在
//              CPU 侧按时间常数缓动，状态切换是连续过渡而不是硬切。
//
// 与 stage-particles.js 的环境光尘不同：那是全屏背景层，这是封面本体，
// 挂在 .lp-cover 容器里，复用它的位置、尺寸和舞台倾角，不另起透视。
//
// WebGL 不可用、或跨域封面主机不给 CORS 头时，自动退回 .lp-cover-spin
// 那张 CSS 双面卡片——本模块绝不输出报错画面。
//
// 帧循环不自己起：通过 Stage.gate() 登记为 stage.js 单一 rAF 的一个子系统门。

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // 常量
  // -------------------------------------------------------------------------
  var PLANE_SIZE = 4.8;          // 封面平面世界尺寸（与 Mineradio 一致）
  var CAM_Z = 9.0;               // 相机距离
  // 纵向视场角按"封面平面恰好铺满画布"反算：
  // 平面半宽 2.4，相机距离 9 → tan(fov/2)=2.45/9 ≈ 0.272 → fov≈30.5°，
  // 留 ~2% 过扫描，任何边缘都不会露出黑边
  var FOV_DEG = 30.5;
  var RIP_MAX = 8;               // 同时存在的涟漪数
  var GRIDS = [72, 96, 118];     // 各设备档点阵边长：5184 / 9216 / 13924
  var DPR_CAP = [1.0, 1.4, 1.75];
  var TIER_FPS = [18, 26, 34];
  // 点精灵基础尺寸系数：depthSize = POINT_BASE / 相机空间深度
  var POINT_BASE = 36;
  var BLOOM_SIZE = 2.65;
  var BLOOM_STRENGTH = 0.55;

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------
  var coverEl = null;
  var canvas = null;
  var gl = null;
  var grid = 0;
  var pointCount = 0;
  var buffers = null;            // {pos, uv, rand}
  var solid = null;              // {prog, u}
  var bloom = null;              // {prog, u}
  var coverTex = null;
  var dotTex = null;
  var proj = new Float32Array(16);
  var aspect = 0;
  var fitV = 1;                   // cover-fit 放大系数（随 aspect 变化）

  var onset = null;
  var ripples = [];
  var ripData = new Float32Array(RIP_MAX * 4);
  var ripHead = 0;

  var active = false;            // 本层是否在渲染（false = 退回 CSS 卡片）
  var attached = false;
  var playing = false;
  var reduced = false;
  var lowfx = false;
  var playT = 0;                 // 0 静态 .. 1 完全律动，CPU 缓动
  var timeSec = 0;
  var cssW = 0;
  var cssH = 0;
  var bufW = 0;
  var bufH = 0;
  var dprUsed = 1;
  var loadedUrl = null;
  var loadingUrl = null;
  var needsFrame = false;
  var lastSpectrum = null;
  var lastSpectrumAt = 0;
  var SILENCE = new Float64Array(64);

  var regions = [];
  for (var ry = 0; ry < 3; ry += 1) for (var rx = 0; rx < 3; rx += 1) {
    regions.push({
      x: (rx / 2 - 0.5) * PLANE_SIZE * 0.72,
      y: (ry / 2 - 0.5) * PLANE_SIZE * 0.72
    });
  }

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------
  function nowMs() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function tauAlpha(dtMs, tauMs) { return 1 - Math.exp(-Math.max(0.001, dtMs) / tauMs); }

  function tierIndex() {
    var t = window.Stage ? Stage.tier() : 2;
    return t < 0 ? 0 : t > 2 ? 2 : t;
  }

  // -------------------------------------------------------------------------
  // 透视矩阵（列优先）
  // -------------------------------------------------------------------------
  function perspective(out, fovDeg, asp, near, far) {
    var f = 1 / Math.tan((fovDeg * Math.PI / 180) / 2);
    var nf = 1 / (near - far);
    out[0] = f / asp; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
  }

  // -------------------------------------------------------------------------
  // 着色器
  // -------------------------------------------------------------------------

  // 干净圆点纹理（与 Mineradio 同一条径向曲线：0.96 → 0.78@0.42 → 0.22@0.72 → 0）
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
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  var VERT = [
    'precision highp float;',
    'attribute vec3 aPos;',
    'attribute vec2 aUv;',
    'attribute float aRand;',
    'uniform mat4 uProj;',
    'uniform float uTime;',
    'uniform float uBass; uniform float uMid; uniform float uTreble; uniform float uBeat;',
    'uniform float uPlay;',
    'uniform float uPixel;',
    'uniform float uCamZ;',
    // cover-fit：把 4.8 的方形封面放大到铺满整个视口（短边铺满、长边裁切）
    'uniform float uFit;',
    'uniform int uRipCount;',
    'uniform vec4 uRips[8];',
    'uniform sampler2D uCover;',
    'varying vec3 vColor;',
    'varying float vVAlpha;',

    // ---- Simplex 3D（Ashima，与 Mineradio 同一份）----
    'vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}',
    'vec4 mod289v(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}',
    'vec4 perm(vec4 x){return mod289v(((x*34.0)+1.0)*x);}',
    'float snoise(vec3 v){',
    '  const vec2 C=vec2(1.0/6.0,1.0/3.0);',
    '  const vec4 D=vec4(0.0,0.5,1.0,2.0);',
    '  vec3 i=floor(v+dot(v,C.yyy));',
    '  vec3 x0=v-i+dot(i,C.xxx);',
    '  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;',
    '  vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);',
    '  vec3 x1=x0-i1+C.xxx;',
    '  vec3 x2=x0-i2+C.yyy;',
    '  vec3 x3=x0-D.yyy;',
    '  i=mod289(i);',
    '  vec4 p=perm(perm(perm(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));',
    '  float n_=0.142857142857;',
    '  vec3 ns=n_*D.wyz-D.xzx;',
    '  vec4 j=p-49.0*floor(p*ns.z*ns.z);',
    '  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);',
    '  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy;',
    '  vec4 h=1.0-abs(x)-abs(y);',
    '  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);',
    '  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0;',
    '  vec4 sh=-step(h,vec4(0.0));',
    '  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;',
    '  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);',
    '  vec4 norm=inversesqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));',
    '  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;',
    '  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);',
    '  m=m*m;',
    '  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));',
    '}',

    // ---- 涟漪：中心凸起 + 扩散圆环（Mineradio rippleSumAt）----
    'float rippleAt(vec2 p, out float maxAmp){',
    '  float sum=0.0; maxAmp=0.0;',
    '  for (int k=0;k<8;k++){',
    '    if(k>=uRipCount) break;',
    '    vec4 r=uRips[k];',
    '    float age=r.z; float str=r.w;',
    '    if(str<0.005||age<0.0||age>2.0) continue;',
    '    float dx=p.x-r.x, dy=p.y-r.y;',
    '    float dist=sqrt(dx*dx+dy*dy);',
    '    float lifeN=age/2.0;',
    '    float fadeIn=smoothstep(0.0,0.06,age);',
    '    float fadeOut=1.0-smoothstep(0.7,1.0,lifeN);',
    '    float env=fadeIn*fadeOut;',
    '    float bulgeW=0.55+age*0.80;',
    '    float bulge=exp(-dist*dist/(2.0*bulgeW*bulgeW))*(1.0-smoothstep(0.0,0.55,lifeN));',
    '    float waveR=age*2.10;',
    '    float ringW=0.40+age*0.22;',
    '    float ring=exp(-pow((dist-waveR)/ringW,2.0));',
    '    float local=(bulge*2.4+ring*1.3)*env*str;',
    '    sum+=local;',
    '    maxAmp=max(maxAmp,abs(local));',
    '  }',
    '  return sum;',
    '}',

    'void main(){',
    '  float t=uTime;',
    // 先按视口宽高比做 cover-fit 放大，后续噪声/涟漪全部使用放大后的坐标
    '  vec3 pos=vec3(aPos.x*uFit,aPos.y*uFit,aPos.z);',

    // 封面逐点采色，轻微提亮曲线
    '  vec2 suv=clamp(aUv,vec2(0.001),vec2(0.999));',
    '  vec3 col=texture2D(uCover,suv).rgb;',
    '  col=pow(max(col,vec3(0.0)),vec3(1.0/1.05));',

    '  float maxAmp=0.0;',
    '  float rip=rippleAt(pos.xy,maxAmp);',

    // 频段位移（Mineradio SILK 系数，K≈1.6）
    '  float midN=snoise(vec3(pos.x*1.4,pos.y*1.4,t*0.55))*0.6',
    '           +snoise(vec3(pos.x*2.8+5.0,pos.y*2.8-3.0,t*0.85))*0.4;',
    '  float midMask=0.55+0.45*snoise(vec3(pos.x*0.4,pos.y*0.4,t*0.18));',
    '  float midDisp=midN*uMid*0.55*midMask*1.6;',
    '  float trebleJ=snoise(vec3(pos.x*6.5,pos.y*6.5,t*3.5+aRand*4.0))*uTreble*0.18*1.6;',
    '  float bassBreath=snoise(vec3(pos.x*0.35,pos.y*0.35,t*0.4))*uBass*0.42*1.6;',

    '  pos.z=(rip*1.30+midDisp+trebleJ+bassBreath)*uPlay;',

    // 亮度：底亮 + 涟漪/底鼓/节拍加成，全部随 uPlay 进出
    '  float bright=0.86+maxAmp*0.55*uPlay+uBass*0.10*uPlay+uBeat*0.12*uPlay;',
    '  vColor=col*bright;',
    '  vVAlpha=1.0;',

    '  vec4 viewPos=vec4(pos.x,pos.y,pos.z-uCamZ,1.0);',
    '  gl_Position=uProj*viewPos;',
    '  float depthSize=' + POINT_BASE + '.0/max(0.5,-viewPos.z);',
    '  float audioBoost=1.0+maxAmp*0.7+uBeat*0.30+uBass*0.15;',
    '  float size=clamp(depthSize*mix(1.0,audioBoost,uPlay),1.05,4.95);',
    '  gl_PointSize=size*uPixel;',
    '}'
  ].join('\n');

  var FRAG_SOLID = [
    'precision highp float;',
    'uniform sampler2D uDot;',
    'uniform float uAlpha;',
    'varying vec3 vColor;',
    'varying float vVAlpha;',
    'void main(){',
    '  vec4 tex=texture2D(uDot,gl_PointCoord);',
    '  if(tex.a<0.02) discard;',
    '  gl_FragColor=vec4(vColor,tex.a*vVAlpha*uAlpha);',
    '}'
  ].join('\n');

  var FRAG_BLOOM = [
    'precision highp float;',
    'uniform sampler2D uDot;',
    'uniform float uAlpha;',
    'uniform float uBloomStrength;',
    'varying vec3 vColor;',
    'varying float vVAlpha;',
    'void main(){',
    '  vec4 tex=texture2D(uDot,gl_PointCoord);',
    '  if(tex.a<0.01) discard;',
    '  float soft=tex.a*tex.a;',
    '  float pulse=1.0+uBloomStrength*0.2;',
    '  gl_FragColor=vec4(vColor*0.85,soft*uAlpha*uBloomStrength*vVAlpha*0.55*pulse);',
    '}'
  ].join('\n');

  // 泛光顶点：同一份 VS，点放更大
  var VERT_BLOOM = VERT
    .replace('uniform float uPixel;', 'uniform float uPixel; uniform float uBloomSize;')
    .replace('gl_PointSize=size*uPixel;', 'gl_PointSize=size*uPixel*uBloomSize;');

  // -------------------------------------------------------------------------
  // GL 初始化
  // -------------------------------------------------------------------------
  function linkProgram(vsSrc, fsSrc) {
    // 两个 shader 对象先都创建好再编译：部分 GPU 进程在一次编译刚结束的瞬间
    // createShader 会静默返回 null。任何一步失败都返回 null，绝不抛错。
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
        console.warn('粒子封面顶点着色器编译失败：', gl.getShaderInfoLog(vs));
        return null;
      }
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        console.warn('粒子封面片元着色器编译失败：', gl.getShaderInfoLog(fs));
        return null;
      }
      prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.warn('粒子封面程序链接失败：', gl.getProgramInfoLog(prog));
        gl.deleteProgram(prog);
        return null;
      }
      // detach 后再 delete：程序已内含链接产物，live shader 槽位立即释放
      gl.detachShader(prog, vs);
      gl.detachShader(prog, fs);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    } catch (e) {
      try { gl.deleteProgram(prog); } catch (e2) { /* ignore */ }
      return null;
    }
    return prog;
  }

  var UNIFORM_NAMES = [
    'uProj', 'uTime', 'uBass', 'uMid', 'uTreble', 'uBeat', 'uPlay',
    'uPixel', 'uCamZ', 'uFit', 'uRipCount', 'uRips', 'uCover', 'uDot', 'uAlpha'
  ];

  function uniformMap(prog) {
    var u = {};
    UNIFORM_NAMES.forEach(function (name) {
      u[name] = gl.getUniformLocation(prog, name);
    });
    return u;
  }

  // -------------------------------------------------------------------------
  // 点阵几何
  // -------------------------------------------------------------------------
  function buildGeometry(nextGrid) {
    var count = nextGrid * nextGrid;
    var positions = new Float32Array(count * 3);
    var uvs = new Float32Array(count * 2);
    var rands = new Float32Array(count);
    var texel = 1 / nextGrid;
    for (var i = 0; i < count; i += 1) {
      var gx = i % nextGrid;
      var gy = (i / nextGrid) | 0;
      var px = gx / (nextGrid - 1);
      var py = gy / (nextGrid - 1);
      positions[i * 3] = (px - 0.5) * PLANE_SIZE;
      positions[i * 3 + 1] = (py - 0.5) * PLANE_SIZE;
      positions[i * 3 + 2] = 0;
      uvs[i * 2] = (gx + 0.5) * texel;
      uvs[i * 2 + 1] = (gy + 0.5) * texel;
      rands[i] = Math.random();
    }

    if (!buffers) {
      buffers = {
        pos: gl.createBuffer(),
        uv: gl.createBuffer(),
        rand: gl.createBuffer()
      };
    }
    function upload(buf, data, attrName, size) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(solid.prog, attrName);
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      }
    }
    upload(buffers.pos, positions, 'aPos', 3);
    upload(buffers.uv, uvs, 'aUv', 2);
    upload(buffers.rand, rands, 'aRand', 1);

    // 泛光程序共用同一份缓冲，按同一 VAO 状态绘制（无 VAO 时全局属性状态即可）
    grid = nextGrid;
    pointCount = count;
  }

  // -------------------------------------------------------------------------
  // 封面纹理
  // -------------------------------------------------------------------------
  function neutralCover() {
    var cv = document.createElement('canvas');
    cv.width = cv.height = 4;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#16181d';
    ctx.fillRect(0, 0, 4, 4);
    return cv;
  }

  function uploadCover(cv) {
    gl.bindTexture(gl.TEXTURE_2D, coverTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  function loadCover(url) {
    loadingUrl = url;
    if (!url) {
      uploadCover(neutralCover());
      loadedUrl = null;
      needsFrame = true;
      Stage.kick();
      return;
    }
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = function () {
      if (loadingUrl !== url) return;
      var size = 384;
      var cv = document.createElement('canvas');
      cv.width = cv.height = size;
      var ctx = cv.getContext('2d');
      var iw = img.naturalWidth;
      var ih = img.naturalHeight;
      var s = Math.min(iw, ih);
      // 居中方形裁剪，与 Mineradio cover crop 一致
      ctx.drawImage(img, (iw - s) / 2, (ih - s) / 2, s, s, 0, 0, size, size);
      try {
        uploadCover(cv);
      } catch (e) {
        // 跨域安全错误：退回 CSS 卡片
        fallback();
        return;
      }
      loadedUrl = url;
      needsFrame = true;
      Stage.kick();
    };
    img.onerror = function () {
      if (loadingUrl !== url) return;
      fallback();
    };
    img.src = url;
  }

  // -------------------------------------------------------------------------
  // 涟漪
  // -------------------------------------------------------------------------
  function spawnRipple() {
    var bassNow = onset ? onset.agg[0] : 0;
    var reg = regions[(Math.random() * regions.length) | 0];
    var slot = ripHead;
    ripHead = (ripHead + 1) % RIP_MAX;
    ripData[slot * 4] = reg.x + (Math.random() - 0.5) * 0.7;
    ripData[slot * 4 + 1] = reg.y + (Math.random() - 0.5) * 0.7;
    ripData[slot * 4 + 2] = 0;
    ripData[slot * 4 + 3] = 0.65 + bassNow * 1.4 + Math.random() * 0.25;
  }

  function updateRipples(dtMs) {
    for (var i = 0; i < RIP_MAX; i += 1) {
      var off = i * 4;
      var str = ripData[off + 3];
      if (str > 0.005) {
        ripData[off + 2] += dtMs / 1000;
        if (ripData[off + 2] > 2) {
          ripData[off + 2] = -10;
          ripData[off + 3] = 0;
        }
      }
    }
  }

  function ripCount() {
    var n = 0;
    for (var i = 0; i < RIP_MAX; i += 1) {
      if (ripData[i * 4 + 3] > 0.005) n += 1;
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // 尺寸
  // -------------------------------------------------------------------------
  function resize(force) {
    if (!coverEl) return false;
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    if (!w || !h) { cssW = cssH = 0; return false; }
    var ti = tierIndex();
    var dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP[ti]);
    var bw = Math.round(w * dpr);
    var bh = Math.round(h * dpr);
    if (!force && bw === bufW && bh === bufH) return true;
    canvas.width = bw;
    canvas.height = bh;
    bufW = bw;
    bufH = bh;
    cssW = w;
    cssH = h;
    dprUsed = dpr;
    aspect = bw / bh;
    perspective(proj, FOV_DEG, aspect, 0.1, 100);
    // z=0 平面的可见半高；方形封面要同时盖住可见高与可见宽，
    // 半平面 = max(半高, 半宽)——即 object-fit: cover 的 3D 版本。
    var halfH = Math.tan(FOV_DEG * Math.PI / 360) * CAM_Z;
    var halfPlane = Math.max(halfH, halfH * aspect);
    fitV = (2 * halfPlane) / PLANE_SIZE;
    return true;
  }

  // -------------------------------------------------------------------------
  // 绘制
  // -------------------------------------------------------------------------
  function setCommonUniforms(progSet, isBloomPass) {
    var u = progSet.u;
    if (u.uProj) gl.uniformMatrix4fv(u.uProj, false, proj);
    if (u.uTime) gl.uniform1f(u.uTime, timeSec);
    if (u.uBass) gl.uniform1f(u.uBass, bassV);
    if (u.uMid) gl.uniform1f(u.uMid, midV);
    if (u.uTreble) gl.uniform1f(u.uTreble, trebleV);
    if (u.uBeat) gl.uniform1f(u.uBeat, beatV);
    if (u.uPlay) gl.uniform1f(u.uPlay, playT);
    if (u.uPixel) gl.uniform1f(u.uPixel, dprUsed);
    if (u.uCamZ) gl.uniform1f(u.uCamZ, CAM_Z);
    if (u.uFit) gl.uniform1f(u.uFit, fitV);
    if (u.uRipCount) gl.uniform1i(u.uRipCount, activeRips);
    if (u.uRips) gl.uniform4fv(u.uRips, ripData);
    if (u.uCover) gl.uniform1i(u.uCover, 0);
    if (u.uDot) gl.uniform1i(u.uDot, 1);
    if (u.uAlpha) gl.uniform1f(u.uAlpha, 1);
    if (isBloomPass && u.uBloomSize) gl.uniform1f(u.uBloomSize, BLOOM_SIZE);
    if (isBloomPass && u.uBloomStrength) gl.uniform1f(u.uBloomStrength, BLOOM_STRENGTH);
  }

  var bassV = 0;
  var midV = 0;
  var trebleV = 0;
  var beatV = 0;
  var activeRips = 0;

  // 共享上下文：先禁用所有已开启的顶点属性数组，避免读到星河模块残留的
  // 缓冲数据。MAX_VERTEX_ATTRIBS 通常 16，逐帧一次开销可忽略。
  function resetVertexArrays() {
    var n = gl.getParameter(gl.MAX_VERTEX_ATTRIBS);
    for (var i = 0; i < n; i += 1) gl.disableVertexAttribArray(i);
  }

  function bindOwnAttributes(progSet) {
    // 封面三个属性来自 buildGeometry 的三个独立 VBO
    function one(buf, attrName, size) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      var loc = gl.getAttribLocation(progSet.prog, attrName);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }
    one(buffers.pos, 'aPos', 3);
    one(buffers.uv, 'aUv', 2);
    one(buffers.rand, 'aRand', 1);
  }

  function draw() {
    gl.viewport(0, 0, bufW, bufH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, coverTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, dotTex);

    gl.enable(gl.BLEND);

    // 第一遍：实点，正常混合
    gl.useProgram(solid.prog);
    resetVertexArrays();
    bindOwnAttributes(solid);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    setCommonUniforms(solid, false);
    gl.drawArrays(gl.POINTS, 0, pointCount);

    // 第二遍：更大更淡的加性泛光（低 spec / 减少动效时跳过）
    if (bloom && !lowfx && !reduced) {
      gl.useProgram(bloom.prog);
      bindOwnAttributes(bloom);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      setCommonUniforms(bloom, true);
      gl.drawArrays(gl.POINTS, 0, pointCount);
    }
  }

  // -------------------------------------------------------------------------
  // 帧门
  // -------------------------------------------------------------------------
  function isReducedNow() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.body.classList.contains('reduce-motion');
  }

  function targetFps() {
    if (!window.Stage || Stage.isHidden() || !active) return 0;
    // 封面只在全屏页且当前场景为 cover 时出现，星河场景下让 GPU 停掉
    if (!Stage.isPageOpen() || Stage.scene() !== 'cover') return 0;
    if (needsFrame) return 24;
    var target = playing && !reduced ? 1 : 0;
    var settling = Math.abs(playT - target) > 0.002;
    if (playing) return TIER_FPS[tierIndex()];
    if (settling) return 20;       // 暂停后把涟漪和缓动放完
    return 0;
  }

  function tick(dtMs) {
    if (!active) return;
    reduced = isReducedNow();
    lowfx = Stage.tier() === 0;
    timeSec += dtMs / 1000;

    // 封面 URL 跟随曲目
    var url = Stage.coverUrl ? Stage.coverUrl() : null;
    if (url !== loadingUrl) loadCover(url);

    // 播放状态缓动（attack 300ms / release 420ms）
    playing = document.body.classList.contains('is-playing');
    var targetPlay = playing && !reduced ? 1 : 0;
    playT += (targetPlay - playT) * tauAlpha(dtMs, playing ? 300 : 420);
    playT = clamp01(playT);

    // 频谱 → 分带（断供时喂静默帧，让包络自然归零）
    var sp = Stage.spectrum();
    if (sp && sp.length && sp !== lastSpectrum) {
      lastSpectrum = sp;
      lastSpectrumAt = nowMs();
    }
    var fresh = !!(sp && sp.length) && (nowMs() - lastSpectrumAt < 600);
    onset.step(dtMs, fresh ? sp : SILENCE, nowMs());
    bassV = onset.agg[0];
    midV = onset.agg[1] * 0.5 + onset.agg[2];
    trebleV = onset.agg[3];
    beatV = onset.pulse;

    updateRipples(dtMs);
    activeRips = ripCount();

    if (resize(false)) draw();
    needsFrame = false;
  }

  // -------------------------------------------------------------------------
  // 退回 CSS 卡片
  // -------------------------------------------------------------------------
  function fallback() {
    active = false;
    // gl-active 在 cover 节点上（由 paintCover 切换）：立刻摘掉，让 CSS 卡片兜底
    if (coverEl) coverEl.classList.remove('gl-active');
  }

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------
  function init() {
    if (attached) return api;
    if (!window.Stage || typeof Stage.gate !== 'function' || !window.Onset) return null;
    // 共享 GL 宿主：画布与上下文都来自 stage-gl-host.js
    var host = window.StageGLHost;
    if (!host || !host.gl() || !host.canvas()) return null;
    canvas = host.canvas();
    gl = host.gl();
    coverEl = document.querySelector('.lp-cover');
    if (!coverEl) return null;

    var pSolid = linkProgram(VERT, FRAG_SOLID);
    var pBloom = linkProgram(VERT_BLOOM, FRAG_BLOOM);
    if (!pSolid || !pBloom) {
      fallback();
      return null;
    }
    solid = { prog: pSolid, u: uniformMap(pSolid) };
    bloom = { prog: pBloom, u: uniformMap(pBloom) };

    coverTex = gl.createTexture();
    uploadCover(neutralCover());
    dotTex = makeDotTexture();

    buildGeometry(GRIDS[tierIndex()]);

    onset = Onset.create({ groups: Onset.GROUPS });
    onset.onBeat(function () {
      // 只有在真正进入播放状态时才扩散涟漪，暂停的余响不补涟漪
      if (playT > 0.35) spawnRipple();
    });

    active = true;
    attached = true;

    Stage.gate('cover-particles', targetFps, tick);

    // 换曲目 / retint 时检查封面 URL；tick 暂停时不跑，事件负责踢帧
    document.addEventListener('stage:retint', function () {
      if (!active) {
        // 此前因跨域失败过：给新封面一次重试机会
        var retryUrl = Stage.coverUrl ? Stage.coverUrl() : null;
        if (retryUrl) {
          active = true;
          loadingUrl = null;
          loadCover(retryUrl);
        }
        return;
      }
      var url = Stage.coverUrl ? Stage.coverUrl() : null;
      if (url !== loadingUrl) loadCover(url);
    });

    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        if (!active) return;
        if (resize(false)) {
          needsFrame = true;
          Stage.kick();
        }
      }).observe(canvas);
    }

    var initial = Stage.coverUrl ? Stage.coverUrl() : null;
    if (initial) loadCover(initial);
    resize(true);
    needsFrame = true;
    Stage.kick();

    return api;
  }

  // 销毁：删程序/缓冲/纹理、摘 gl-active、注销帧门
  function destroy() {
    if (window.Stage && Stage.removeGate) Stage.removeGate('cover-particles');
    try {
      if (solid && solid.prog) gl.deleteProgram(solid.prog);
      if (bloom && bloom.prog) gl.deleteProgram(bloom.prog);
      if (buffers) {
        if (buffers.pos) gl.deleteBuffer(buffers.pos);
        if (buffers.uv) gl.deleteBuffer(buffers.uv);
        if (buffers.rand) gl.deleteBuffer(buffers.rand);
      }
      if (coverTex) gl.deleteTexture(coverTex);
      if (dotTex) gl.deleteTexture(dotTex);
    } catch (e) { /* ignore */ }
    if (coverEl) coverEl.classList.remove('gl-active');
    solid = bloom = null;
    buffers = null;
    coverTex = dotTex = null;
    active = false;
  }

  var api = {
    init: init,
    destroy: destroy,
    active: function () { return active; },
    grid: function () { return grid; },
    count: function () { return pointCount; }
  };

  window.StageCoverParticles = api;
})();
