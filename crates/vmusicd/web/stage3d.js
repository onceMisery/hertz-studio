// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 沉浸式三维舞台 —— 一套独立的全屏 3D 演出层。
//
// 为什么另起一层而不是往 creative-gl 里加场景：创意舞台是「嵌在右栏/歌词页
// 里的一块画布」，它的机位、交互、后处理都服务于「陪衬歌词」；而这里要的是
// 「整块屏幕就是一个舞台」——独占指针、独占全屏、独占后处理链，还要在切换
// 舞台时换掉整套几何与着色器。两者对同一份资源的诉求是互斥的，硬塞进一个
// 编排层只会让两边都长出一堆 if。
//
// 设计上大量借鉴 Mineradio 的三维层（它的结论是实测调过的）：
//
//   · DPR 双钳制：硬性上限 ∩ 总像素预算 sqrt(budget / cssPixels)。只写
//     min(dpr, 2) 在 4K 上会直接爆显存带宽，这个公式保证任何分辨率下
//     光栅化像素数都被压在预算内。
//   · 三态相机：user（拖拽基线）+ cinema（低频漂移）+ beat（起音冲击）
//     三路相加得到目标值，current 用一阶低通追目标。任何一路改自己的值都
//     不会污染其它路，也不会出现「自动演出结束后镜头跳回去」。
//   · 转场 = sin(t·π) 一次性脉冲，同时推 uScatter / uBurst / 镜头 punch，
//     而不是「幕布盖住再拉开」——后者会让切换显得像加载。
//   · 粒子位置全在顶点着色器里算，CPU 每帧只上传几十个 uniform。稳态下
//     没有任何 buffer 被 needsUpdate。
//   · 后处理是真正的 FBO 链（亮部提取 → 可分离高斯 ping-pong → 合成），
//     不是「同一份几何画两遍放大」的伪辉光。
//
// 几条本项目的硬约定（和 stage-gl-host.js / onset.js 一致，不要破）：
//   · 不另起 requestAnimationFrame：逐帧驱动走 Stage.gate()，全项目只有
//     stage.js 那一个主循环。不需要帧时目标帧率报 0。
//   · 起音不自己算：鼓点是哪一刻只有 Onset 一份定义，否则换一种渲染
//     「歌的律动看起来就变了」。
//   · 时间常数一律按毫秒表达，系数用 1 − exp(−dt/τ)：帧门的推送率随设备
//     档位变化，按「每帧固定比例」平滑的话同一首歌在两台机器上呼吸速度不同。
//   · WebGL 上下文只在这里按需建一个，且拿不到就整体降级（某些驱动只允许
//     页面存在一个上下文，宁可不显示也不抢别人的）。
//
// 零依赖、ES5、无构建。

(function (global) {
  'use strict';

  // Node（无头契约扫描）下早退：不触碰 document / window。
  if (typeof window === 'undefined') return;

  var GATE = 'stage3d';
  var BASE_FOV = 52;
  var CHROME_HIDE_MS = 2600;
  var TAU_ANGLE = 190;      // 相机角度低通时间常数（ms）
  var TAU_RADIUS = 300;
  var TAU_LOOK = 260;

  // folia 歌词视觉（流光 classic / 心象 cadenza / 商籁 sonnet）是与「3D 舞台布局」正交的独立维度：
  // layout 始终是三维舞台（focus/sleeve/single），GL 场景照常渲染、相机手势照常工作；
  // folia 歌词以透明叠加层浮在 3D 之上。仅当设备无 GL 时才退化为「纯平面」（standalone），
  // 此时停掉 GL 与 3D 手势，由 folia 渲染器独立撑画面。
  //   foliaActive：当前歌词走 folia（classic/cadenza/sonnet）；standalone：folia 激活且无 GL。
  var FOLIA_VISUALS = ['classic', 'cadenza', 'sonnet', 'tempera'];
  function foliaActive(v) { return FOLIA_VISUALS.indexOf(v != null ? v : folia.visual) >= 0; }
  function isStandalone() { return foliaActive() && !gl; }
  // 旧调用点语义：isPlane() 现在专指「无 GL 纯平面回退」。
  function isPlane() { return isStandalone(); }
  var folia = { ready: false, bg: null, sub: null, classic: null, cadenza: null, sonnet: null, tempera: null,
    visual: 'stage',
    bgMode: 'stage', bgOpacity: 0.75, vignette: true, subtitle: true,
    wallpaper: 'evening-16.jpg', wallpaperDim: 0.48,
    classicTuning: { rotation: true, breathing: 1, spacing: 0.7 },
    cadenzaTuning: { width: 0.72, motion: 1, glow: 1, beam: 0 },
    sonnetTuning: { shotFlow: 'auto', lyricLayout: 'phrases', phraseLength: 12, decor: true, accents: true },
    temperaTuning: { composition: 'auto', colorMode: 'duo', screens: true, inversion: true },
    // pendingOffset：歌词偏移的乐观暂存（毫秒），null 表示与服务端一致。
    // PUT+refresh 追上之前连点都基于它递增，避免读旧值导致连点塌缩成一步。
    // pendingTrackId：pendingOffset 所属曲目 id；切歌隔离与 PUT 失败回清都据此判定。
    themeSig: '', coverSig: '', pendingOffset: null, pendingTrackId: null };

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, f) { v = Number(v); return isFinite(v) ? v : f; }

  // 帧率无关的一阶低通。tau 是「追到 63% 所需毫秒数」。
  function damp(cur, target, tauMs, dtMs) {
    if (!(tauMs > 0)) return target;
    return cur + (target - cur) * (1 - Math.exp(-Math.max(0, dtMs) / tauMs));
  }

  function mat4() { return new Float32Array(16); }

  function perspective(out, fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    var nf = 1 / (near - far);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
    return out;
  }

  function lookAt(out, ex, ey, ez, cx, cy, cz, ux, uy, uz) {
    var zx = ex - cx, zy = ey - cy, zz = ez - cz;
    var zl = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;
    var xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
    var xl = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * ex + xy * ey + xz * ez);
    out[13] = -(yx * ex + yy * ey + yz * ez);
    out[14] = -(zx * ex + zy * ey + zz * ez);
    out[15] = 1;
    return out;
  }

  // 绕视线轴滚转：直接右乘一个 Z 旋转，比重建 lookAt 便宜。
  function rollView(out, view, rollRad) {
    var c = Math.cos(rollRad), s = Math.sin(rollRad);
    for (var i = 0; i < 4; i += 1) {
      var x = view[i * 4], y = view[i * 4 + 1];
      out[i * 4] = x * c + y * s;
      out[i * 4 + 1] = -x * s + y * c;
      out[i * 4 + 2] = view[i * 4 + 2];
      out[i * 4 + 3] = view[i * 4 + 3];
    }
    return out;
  }

  // 十六进制色 → 线性 RGB 三元组（着色器里全程按线性算，合成时再 tonemap）。
  function parseColor(str, fallback) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(str || '').trim());
    if (!m) return fallback.slice();
    var n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  // -------------------------------------------------------------------------
  // 舞台目录
  // -------------------------------------------------------------------------

  var ICONS = {
    silk: '<path d="M4 4h16v16H4zM4 15c4-8 8 8 16-6M4 10c4-8 8 8 16-6"/>',
    resonance: '<ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-28 12 12)"/><circle cx="12" cy="12" r="2"/>',
    aurora: '<path d="M3 17c3-5 6-5 9-1s6 4 9-2"/><path d="M5 21c3-3.5 6-3.5 7-1"/>' +
      '<circle cx="12" cy="6" r="1.6"/>',
    tunnel: '<ellipse cx="12" cy="12" rx="9" ry="7"/><ellipse cx="12" cy="12" rx="5.5" ry="4"/>' +
      '<ellipse cx="12" cy="12" rx="2" ry="1.5" fill="currentColor" stroke="none"/>',
    terrain: '<path d="M3 18l4.5-8 3.5 5.5 3-4 7 6.5"/><path d="M3 21h18"/>',
    orb: '<circle cx="12" cy="12" r="6.5"/><path d="M5.8 9.2C8 7.4 16 7.4 18.2 9.2"/>' +
      '<path d="M6.4 15.4C8.4 17.2 15.6 17.2 17.6 15.4"/>',
    prism: '<path d="M12 3.5v17"/><path d="M12 3.5l7.5 13H4.5z"/><path d="M12 10.5l3.6 6h-7.2z"/>'
  };

  var STAGES = [
    {
      id: 'aurora', label: '极光穹顶', desc: '星野与流动的彩色极光帘幕',
      cam: { theta: 0.0, phi: 0.10, dist: 8.4, look: [0, 0.6, -2.0] },
      counts: [3000, 6500, 11000], additive: true, depth: false, field: 5
    },
    {
      id: 'tunnel', label: '折跃隧道', desc: '穿越光环的速度感',
      // 机位必须落在隧道近端之外：look + dist 恰好把相机放在 z=0，而环铺在
      // z ∈ [-1, -zSpan]，整段都在前方，近平面永远裁不到东西。
      cam: { theta: 0.0, phi: 0.0, dist: 2.2, look: [0, 0, -2.2] },
      counts: [12000, 26000, 42000], additive: true, depth: false, field: 1
    },
    {
      id: 'terrain', label: '音域地形', desc: '随频谱起伏的声场地形',
      cam: { theta: 0.12, phi: 0.38, dist: 22.0, look: [0, 0.4, -3] },
      counts: [14000, 32000, 54000], additive: true, depth: false, field: 3
    },
    {
      id: 'orb', label: '引力星球', desc: '声波在粒子曲面上流动',
      cam: { theta: 0.15, phi: 0.12, dist: 8.2, look: [0, 0, 0] },
      counts: [12000, 28000, 48000], additive: true, depth: false, field: 2
    },
    {
      id: 'prism', label: '棱镜星系', desc: '色散旋臂与光谱尘埃',
      // 机位要落在星云半径（约 14）之外：相机埋进粒子云里时，落在相机背后
      // 的那半团点会被近平面的 w≤0 判定整片剔除，屏幕上凭空少一块。
      cam: { theta: 0.34, phi: 0.46, dist: 20.0, look: [0, 0, 0] },
      counts: [3000, 6000, 10000], additive: true, depth: false
    },
    {
      id: 'resonance', label: '共振星环', desc: '让每一次心跳，都有回响',
      cam: { theta: 0.06, phi: 0.10, dist: 10.5, look: [0, 0, 0] },
      counts: [14000, 30000, 48000], additive: true, depth: false, field: 4
    },
    {
      id: 'silk', label: '封面星球', desc: '清晰的封面，随音乐在粒子球面上呼吸',
      cam: { theta: 0.0, phi: 0.0, dist: 10.2, look: [0, 0, 0] },
      counts: [14000, 32000, 54000], additive: false, depth: true, field: 0
    }
  ];

  // -------------------------------------------------------------------------
  // 着色器公共段
  // -------------------------------------------------------------------------

  // 顶点侧公共段：矩阵、时间、音频、转场、色调。所有舞台共用同一份 uniform
  // 布局，切换舞台只换 program，不需要重新绑定。
  // 顶点侧与片元侧共用同一份 uniform 声明：片元里也要读 uCamPos / uTint* /
  // uFade（做边缘光、雾、整体淡出），只写进顶点侧的话片元编译会直接报
  // undeclared identifier，而驱动只给一行日志、画面直接黑掉。
  var UNIFORMS = [
    'uniform mat4 uProj;',
    'uniform mat4 uView;',
    'uniform vec3 uCamPos;',
    'uniform float uTime;',
    'uniform float uBass;',
    'uniform float uMid;',
    'uniform float uTreble;',
    'uniform float uEnergy;',
    'uniform float uBeat;',
    'uniform float uScatter;',
    'uniform float uBurst;',
    'uniform float uPointScale;',
    'uniform float uFade;',
    'uniform float uGrid;',
    'uniform vec3 uTint;',
    'uniform vec3 uTint2;',
    'uniform vec3 uTint3;',
    ''
  ].join('\n');

  // 噪声 / 哈希 / 点尺寸这三组工具在顶点与片元两侧都要用（片元里的星球表面
  // 噪声、地形细节都靠它），所以同样两侧都注入一份。
  var HELPERS = [
    'float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }',
    'vec3 hash31(float p){',
    '  vec3 q = fract(vec3(p)*vec3(0.1031,0.1030,0.0973));',
    '  q += dot(q, q.yzx+33.33);',
    '  return fract((q.xxy+q.yzz)*q.zyx);',
    '}',
    // Ashima / Gustavson 3D simplex noise（42.0 缩放版）
    'vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}',
    'vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}',
    'vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}',
    'vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}',
    'float snoise(vec3 v){',
    '  const vec2 C=vec2(1.0/6.0,1.0/3.0);',
    '  const vec4 D=vec4(0.0,0.5,1.0,2.0);',
    '  vec3 i=floor(v+dot(v,C.yyy));',
    '  vec3 x0=v-i+dot(i,C.xxx);',
    '  vec3 g=step(x0.yzx,x0.xyz);',
    '  vec3 l=1.0-g;',
    '  vec3 i1=min(g.xyz,l.zxy);',
    '  vec3 i2=max(g.xyz,l.zxy);',
    '  vec3 x1=x0-i1+C.xxx;',
    '  vec3 x2=x0-i2+C.yyy;',
    '  vec3 x3=x0-D.yyy;',
    '  i=mod289(i);',
    '  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))',
    '        +i.y+vec4(0.0,i1.y,i2.y,1.0))',
    '        +i.x+vec4(0.0,i1.x,i2.x,1.0));',
    '  float n_=0.142857142857;',
    '  vec3 ns=n_*D.wyz-D.xzx;',
    '  vec4 j=p-49.0*floor(p*ns.z*ns.z);',
    '  vec4 x_=floor(j*ns.z);',
    '  vec4 y_=floor(j-7.0*x_);',
    '  vec4 x=x_*ns.x+ns.yyyy;',
    '  vec4 y=y_*ns.x+ns.yyyy;',
    '  vec4 h=1.0-abs(x)-abs(y);',
    '  vec4 b0=vec4(x.xy,y.xy);',
    '  vec4 b1=vec4(x.zw,y.zw);',
    '  vec4 s0=floor(b0)*2.0+1.0;',
    '  vec4 s1=floor(b1)*2.0+1.0;',
    '  vec4 sh=-step(h,vec4(0.0));',
    '  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;',
    '  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;',
    '  vec3 p0=vec3(a0.xy,h.x);',
    '  vec3 p1=vec3(a0.zw,h.y);',
    '  vec3 p2=vec3(a1.xy,h.z);',
    '  vec3 p3=vec3(a1.zw,h.w);',
    '  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));',
    '  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;',
    '  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);',
    '  m=m*m;',
    '  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));',
    '}',
    // 透视点尺寸：36/-z 是标准写法；下限防远处亚像素闪烁，上限防近处糊成大块。
    'float pointSize(float dist, float boost){',
    //   透视点尺寸：36/-z 是标准写法。下限 1.4 不是随手写的——小于 1.4px 之后
    //   点精灵会在亚像素采样里闪烁甚至整体消失（远处的星野就是这么没的）。
    '  return clamp(36.0 / max(0.75, dist) * boost, 1.4, 9.0) * uPointScale;',
    '}',
    //   点精灵的软圆点：smoothstep 比线性衰减铺得开，小尺寸下才不会只剩一个
    //   像素亮点。
    'float dotMask(float r){ float a = max(0.0, 1.0 - r); return a*a*(3.0 - 2.0*a); }',
    ''
  ].join('\n');

  var COMMON_VS = ['precision highp float;', UNIFORMS, HELPERS].join('\n');
  var COMMON_FS = ['precision highp float;', UNIFORMS, HELPERS, 'out vec4 o;', ''].join('\n');

  function stageVS(body) { return '#version 300 es\n' + COMMON_VS + body; }
  function stageFS(body) { return '#version 300 es\n' + COMMON_FS + body; }

  // Organised surfaces, rather than random point clouds. The same immutable
  // vertex grid becomes silk, a tunnel, a globe, topography or nested orbits.
  // Each frequency band displaces its own part of the surface on the GPU.
  var FIELD_VS = stageVS([
    'uniform highp int uField; uniform float uCols; uniform float uRows;',
    'uniform sampler2D uArt; uniform float uHasArt; uniform float uBands[64];',
    'uniform vec2 uPointer; uniform float uPointerActive; uniform vec3 uClick;',
    'uniform float uBeatAge; uniform float uAspect;',
    'uniform float uCoverMotion; uniform float uCoverDistance; uniform float uViewportHeight;',
    'uniform vec2 uArtScale; uniform float uArtLod;',
    'out vec3 vColor; out float vAlpha;',
    'const float PI = 3.14159265359;',
    'void main(){',
    '  float id = float(gl_VertexID);',
    '  vec2 uv = vec2(mod(id,uCols)/(uCols-1.0),floor(id/uCols)/(uRows-1.0));',
    '  float seed = hash11(id*1.71);',
    '  float t = uTime;',
    '  float band = uBands[int(clamp(uv.x*63.0,0.0,63.0))];',
    '  vec3 colorA = vec3(0.31,0.68,0.91), colorB = vec3(0.88,0.60,0.94);',
    '  vec3 color = mix(colorA,colorB,uv.x*0.65+uv.y*0.35);',
    '  vec3 pos = vec3(0.0), normal = vec3(0.0,0.0,1.0);',
    '  float light = 0.55, alpha = 0.80, scale = 1.0;',
    '  float coverSpacing = 0.0;',
    '  float beatWave = sin(length(uv-0.5)*24.0-uBeatAge*9.0)*exp(-uBeatAge*2.8);',
    '  if(uField==0){',
    '    float count = uCols*uRows, frontCount = floor(count*0.76);',
    '    float reference = max(1.1,uCoverDistance/2.55);',
    '    float projection = sqrt(reference*reference-1.0);',
    '    float angle = mod(mod(id,256.0)*2.39996322973+floor(id/256.0)*4.92161201412,PI*2.0);',
    '    vec2 direction = vec2(cos(angle),sin(angle));',
    '    if(id<frontCount){',
    '      float diskRadius2 = (id+0.5)/frontCount;',
    '      normal.z = (reference*diskRadius2+(reference*reference-1.0)*sqrt(1.0-diskRadius2))',
    '                 /(reference*reference-1.0+diskRadius2);',
    '      normal.xy = direction*sqrt(diskRadius2)*(reference-normal.z)/projection;',
    '      coverSpacing = 2.55*(reference-normal.z)/projection*sqrt(PI/frontCount);',
    '    } else {',
    '      normal.z = -1.0+(id-frontCount+0.5)/(count-frontCount)*(1.0+1.0/reference);',
    '      normal.xy = direction*sqrt(max(0.0,1.0-normal.z*normal.z));',
    '      coverSpacing = 2.55*sqrt(2.0*PI*(1.0+1.0/reference)/(count-frontCount));',
    '    }',
    '    vec2 artUv = 0.5+normal.xy*projection/(2.0*(reference-normal.z));',
    '    vec3 art = textureLod(uArt,0.5+(artUv-0.5)*uArtScale,uArtLod).rgb;',
    '    color = mix(mix(colorA,colorB,artUv.x*0.65+artUv.y*0.35),art,uHasArt);',
    '    float yaw = sin(t*0.19)*0.035*uCoverMotion;',
    '    normal.xz = mat2(cos(yaw),-sin(yaw),sin(yaw),cos(yaw))*normal.xz;',
    '    float breath = 1.0+(sin(t*0.72)*0.006+uBass*0.018+uBeat*0.010)*uCoverMotion;',
    '    pos = normal*2.55*breath;',
    '    coverSpacing *= breath;',
    '    light = 0.90;',
    '    alpha = 1.0;',
    '  } else if(uField==1){',
    '    float travel = fract(uv.y-t*(0.038+uBass*0.022));',
    '    float angle = uv.x*PI*2.0+t*0.085;',
    '    float radius = 2.65+sin(angle*5.0+travel*16.0-t)*(0.10+uMid*0.28)+band*0.45;',
    '    pos = vec3(cos(angle)*radius,sin(angle)*radius,-travel*34.0);',
    '    normal = normalize(vec3(pos.xy,0.0));',
    '    color = mix(vec3(0.18,0.74,0.91),vec3(0.75,0.44,0.94),0.5+0.5*sin(angle+travel*5.0));',
    '    light = (0.55+0.45*pow(0.5+0.5*sin(travel*60.0-t),5.0));',
    '    alpha = smoothstep(0.005,0.065,travel)*(1.0-smoothstep(0.76,1.0,travel));',
    '    scale = 0.68;',
    '  } else if(uField==2){',
    '    float longitude = uv.x*PI*2.0+t*0.065;',
    '    float latitude = (uv.y-0.5)*PI;',
    '    normal = vec3(cos(latitude)*sin(longitude),sin(latitude),cos(latitude)*cos(longitude));',
    '    float tide = snoise(normal*2.4+vec3(0.0,t*0.16,t*0.12));',
    '    float radius = 3.25+uBass*0.55+tide*(0.12+uMid*0.60)+beatWave*0.12;',
    '    pos = normal*radius;',
    '    float facing = dot(normal,normalize(uCamPos-pos));',
    '    float rim = pow(1.0-abs(facing),2.4);',
    '    light = 0.38+max(0.0,facing)*0.44+rim*0.65;',
    '    color = mix(vec3(0.37,0.42,0.91),vec3(0.30,0.91,0.80),0.5+0.5*sin(latitude*2.4+longitude*0.7+tide));',
    '    alpha = facing>0.0 ? 0.88 : 0.22;',
    '    scale = 0.82;',
    '  } else if(uField==3){',
    '    pos.xz = (uv-0.5)*vec2(28.0,27.0);',
    '    float valley = sin(pos.x*0.37+pos.z*0.24-t*0.23);',
    '    float ridge = sin(pos.z*0.55-t*0.33+cos(pos.x*0.29));',
    '    pos.y = valley*1.25+ridge*0.70+band*(1.1+uBass*1.8);',
    '    pos.y += snoise(vec3(pos.xz*0.18,t*0.12))*0.80+beatWave*0.40;',
    '    normal = vec3(0.0,1.0,0.0);',
    '    color = mix(vec3(0.17,0.57,0.73),vec3(0.67,0.96,0.83),smoothstep(-1.8,2.2,pos.y));',
    '    light = 0.45+smoothstep(-0.8,2.1,pos.y)*0.8;',
    '    alpha = smoothstep(0.0,0.10,uv.y)*(1.0-smoothstep(0.80,1.0,uv.y));',
    '    scale = 0.82;',
    '  } else if(uField==5){',
    '    // 极光穹顶：与其余场型同一套点阵语言——一段拱起的极光帘幕，尺寸',
    '    // 对标其它舞台（约 55% 视高），不铺满整屏。彩色版：沿帘幕横向走',
    '    // 绿→青→紫→品红四段色相并随时间缓慢流动，相位脊线上有白热闪点。',
    '    float ang = (uv.x-0.5)*2.2;',
    '    float sway = snoise(vec3(uv.x*3.0, uv.y*1.2, t*0.14))*(0.35+uMid*0.5);',
    '    float R = 5.0 + uBass*0.35 + sin(uv.x*9.0+t*0.5)*0.10;',
    '    pos.x = sin(ang)*R + sway*0.6;',
    '    pos.y = -2.6 + uv.y*5.4 + pow(abs(ang)*0.91, 2.0)*0.9',
    '          + snoise(vec3(uv.x*4.0, t*0.11, uv.y*0.5))*0.35',
    '          + band*(0.5+uBass*0.9)*sin(uv.y*PI) + beatWave*(0.10+uBass*0.20);',
    '    pos.z = -cos(ang)*R*0.55 - 2.0 + sway*0.4;',
    '    normal = normalize(vec3(pos.x*0.4, 0.35, pos.z+3.0));',
    '    float aur = pow(0.5+0.5*sin(uv.x*60.0 + sway*2.2 + t*0.35), 2.2);',
    '    float mottle = 0.55+0.45*snoise(vec3(uv.x*18.0, t*0.05, uv.y*1.3));',
    '    float huePos = fract(uv.x + t*0.012);',
    '    vec3 col = mix(vec3(0.16,1.00,0.62), vec3(0.20,0.80,1.00), smoothstep(0.0,0.33,huePos));',
    '    col = mix(col, vec3(0.55,0.35,1.00), smoothstep(0.33,0.66,huePos));',
    '    col = mix(col, vec3(1.00,0.45,0.75), smoothstep(0.66,1.0,huePos));',
    '    color = mix(col, vec3(0.88,1.0,0.94), aur*0.30);',
    '    light = 0.68 + aur*0.85*mottle + (1.0-uv.y)*0.30 + uEnergy*0.20;',
    '    alpha = (0.50 + aur*0.50*mottle)',
    '          * smoothstep(0.0,0.05,uv.y)*(1.0-smoothstep(0.80,1.0,uv.y))',
    '          * smoothstep(0.0,0.03,uv.x)*(1.0-smoothstep(0.97,1.0,uv.x));',
    '    scale = 1.0;',
    '  } else {',
    '    float orbit = min(6.0,floor(uv.y*7.0));',
    '    float lane = fract(uv.y*7.0)-0.5;',
    '    float angle = uv.x*PI*2.0+orbit*0.19+t*(0.026+orbit*0.005);',
    '    float radius = 1.75+orbit*0.63+lane*0.19+uBass*(0.08+orbit*0.026);',
    '    radius += band*0.16+sin(angle*9.0-orbit-t)*uTreble*0.07;',
    '    pos = vec3(cos(angle)*radius*1.22,sin(angle)*radius*0.63,(orbit-3.0)*0.24);',
    '    pos.z += sin(angle*2.0+orbit*0.65)*(0.13+uMid*0.34)+beatWave*0.20;',
    '    pos.xy = mat2(0.992,-0.126,0.126,0.992)*pos.xy;',
    '    color = mix(vec3(0.45,0.80,0.94),vec3(0.96,0.75,0.43),orbit/6.0);',
    '    float filament = exp(-lane*lane*110.0);',
    '    light = 0.40+filament*0.72+pow(0.5+0.5*sin(angle*18.0-orbit-t*0.6),9.0)*0.26;',
    '    alpha = (0.28+filament*0.88)*(0.8+0.2*sin(uv.x*PI));',
    '    scale = 1.08;',
    '  }',
    '  vec4 clip = uProj*uView*vec4(pos,1.0);',
    '  vec2 ndc = clip.xy/max(0.001,clip.w);',
    '  vec2 delta = (ndc-uPointer)*vec2(uAspect,1.0);',
    '  float nearPointer = exp(-dot(delta,delta)*25.0)*uPointerActive;',
    '  float clickDistance = length((ndc-uClick.xy)*vec2(uAspect,1.0));',
    '  float clickRing = exp(-pow((clickDistance-uClick.z*0.8)*13.0,2.0))*exp(-uClick.z*2.0);',
    '  float interaction = uField==0 ? 0.065*uCoverMotion : 1.0;',
    '  pos += normal*(nearPointer*0.55+clickRing*0.65)*interaction;',
    '  pos += normalize(pos+0.001)*uScatter*(uField==0 ? 0.16*uCoverMotion : 1.7);',
    '  vec4 mv = uView*vec4(pos,1.0);',
    '  vColor = color*(light+uEnergy*0.32+nearPointer*0.25+clickRing*0.30);',
    '  vAlpha = alpha*uFade*smoothstep(0.15,1.2,-mv.z);',
    '  float pixel = 44.0/max(1.5,-mv.z)*scale;',
    '  gl_PointSize = clamp(pixel,1.35,5.4)*uPointScale;',
    '  if(uField==0){',
    '    float facing = dot(normal,normalize(uCamPos-pos));',
    '    vAlpha *= step(0.012,facing);',
    '    vColor = color*light*(0.78+0.22*smoothstep(0.0,0.65,facing));',
    '    float diameter = coverSpacing*uProj[1][1]*uViewportHeight*0.5/max(0.1,-mv.z);',
    '    gl_PointSize = clamp(diameter*1.22,1.25,7.0*uPointScale);',
    '  }',
    '  gl_Position = uProj*mv;',
    '}'
  ].join('\n'));

  var FIELD_FS = stageFS([
    'uniform highp int uField;',
    'in vec3 vColor; in float vAlpha;',
    'void main(){',
    '  float r = length(gl_PointCoord-0.5)*2.0;',
    '  if(r>1.0 || vAlpha<0.003) discard;',
    '  if(uField==0){',
    '    float edge = 1.0-smoothstep(1.0-min(0.32,fwidth(r)),1.0,r);',
    '    if(edge<0.08) discard;',
    '    o = vec4(vColor,edge*vAlpha);',
    '    return;',
    '  }',
    '  float core = 1.0-smoothstep(0.12,0.60,r);',
    '  float edge = exp(-r*r*6.0)*(1.0-smoothstep(0.76,1.0,r));',
    '  o = vec4(vColor*(1.10+core*1.05),edge*vAlpha);',
    '}'
  ].join('\n'));

  // ---- 舞台 1：极光穹顶 ----------------------------------------------------
  // 星野用点精灵（position 不存在 VBO 里，全部由 aSeed / aLane 在顶点着色器
  // 推导：每帧 CPU→GPU 的只有 uniform，这是整个视觉层最省的一条路）。
  //
  // 星野必须铺在「地平线带」上而不是均匀铺满整个天球：可见视锥的竖直半角只有
  // 26°，均匀球面采样下只有约 5% 的点落在屏幕里，几千个点最后只剩一两百个
  // 可见 —— 这就是"设了 9000 个点却几乎看不到星星"的原因。把仰角压到 ±30°
  // 之后，可见比例升到四分之一左右，同样的点数看起来密一个量级。
  var STAR_VS = stageVS([
    'in float aSeed;',
    'in float aLane;',
    'out vec3 vCol;',
    'out float vA;',
    'void main(){',
    '  float seed = aSeed;',
    '  float az = hash11(seed*2.31)*6.2831853;',
    '  float el = (hash11(seed*3.77)*2.0 - 1.0)*0.52;',
    '  float r = 19.0 + hash11(seed*5.11)*15.0 + aLane*6.0;',
    '  vec3 pos = vec3(cos(el)*sin(az), sin(el)*0.9, cos(el)*cos(az))*r;',
    '  vCol = mix(vec3(0.62,0.74,0.96), uTint2, hash11(seed*7.31)*0.55);',
    '  float tw = pow(0.5+0.5*sin(uTime*(0.55+hash11(seed*9.13)*1.7)+seed*10.0), 4.0);',
    //   基准亮度必须够高：加性混合下 alpha 会被 sprite 的软边再乘一次，
    //   再叠上 tonemap 的低位压缩，写 0.1 最后屏幕上就是 0.01（看不见）。
    '  vA = (0.55 + tw*0.80) * (0.62 + uEnergy*0.5);',
    '  pos += normalize(pos + vec3(0.0, 0.001, 0.0))*uScatter*(2.0 + hash11(seed*23.1)*4.0);',
    '  vec4 mv = uView * vec4(pos, 1.0);',
    '  float dist = -mv.z;',
    '  gl_PointSize = pointSize(dist, 1.35 + uBurst*0.8 + uBeat*0.3);',
    '  vA *= uFade * smoothstep(0.5, 3.4, dist) * (1.0 - smoothstep(44.0, 66.0, dist));',
    '  gl_Position = uProj * mv;',
    '}'
  ].join('\n'));

  var STAR_FS = stageFS([
    'in vec3 vCol;',
    'in float vA;',
    'void main(){',
    '  float a = dotMask(length(gl_PointCoord - 0.5)*2.0);',
    '  if (a*vA < 0.004) discard;',
    '  o = vec4(vCol*(0.75 + vA*0.7), a*vA);',
    '}'
  ].join('\n'));

  var PRISM_VS = stageVS([
    'in float aSeed;',
    'in float aLane;',
    'out vec3 vCol;',
    'out float vA;',
    'void main(){',
    '  float seed = aSeed;',
    '  float arm = floor(hash11(seed*2.11)*3.0);',
    //   径向分布：pow 指数 > 1 会把点往内圈赶，盘心才不会空出一个洞
    '  float t = pow(hash11(seed*4.73), 1.25);',
    '  float r = 0.8 + t*10.5;',
    '  float ang = t*3.6 + arm*2.0944 + uTime*0.06*(1.6 - t);',
    '  float y = (hash11(seed*6.31)-0.5)*(0.5 + t*1.9)',
    '           + snoise(vec3(r*0.28, uTime*0.05, seed))*0.75;',
    '  vec3 pos = vec3(cos(ang)*r, y, sin(ang)*r);',
    //   星系盘整体倾一个角度，正视时才有「盘」的形状
    '  pos.yz = mat2(0.91,-0.42,0.42,0.91)*pos.yz;',
    '  vec3 dir = normalize(pos + vec3(0.0, 0.001, 0.0));',
    //   色散：走向量对齐的调色板，而不是三通道各自独立的 sin —— 后者会在某些
    //   方向上三通道同时落到 0，凭空在盘面中间拉出一条黑带。
    '  float disp = 0.6 + uBeat*0.8;',
    '  float band = 0.5 + 0.5*sin(dir.x*2.4 + dir.z*2.4 + uTime*0.38 + disp);',
    '  float band2 = 0.5 + 0.5*sin(dir.y*3.2 - uTime*0.31);',
    '  vCol = mix(uTint2, uTint3, band);',
    '  vCol += vec3(0.18, 0.10, 0.34) * band2;',
    '  vCol *= 0.85 + uEnergy*0.55;',
    '  pos += dir*uScatter*(2.0 + hash11(seed*9.7)*5.0);',
    '  vec4 mv = uView * vec4(pos, 1.0);',
    '  float dist = -mv.z;',
    '  gl_PointSize = pointSize(dist, 2.4 + uBurst*0.9 + uBeat*0.35);',
    '  float core = 1.0 - smoothstep(0.0, 0.30, t);',
    //   盘心密、外缘疏：外缘本来就稀疏，再压亮度就整片没了
    '  vA = (0.40 + core*0.50) * uFade * smoothstep(0.5, 3.0, dist)',
    '     * (1.0 - smoothstep(26.0, 44.0, dist));',
    '  gl_Position = uProj * mv;',
    '}'
  ].join('\n'));

  var PRISM_FS = STAR_FS;

  // ---- 后处理 --------------------------------------------------------------
  // 全屏一个「大三角形」而不是两个三角形拼的 quad：少一次顶点处理、没有
  // 对角线接缝。vUv 会超出 0..1，但光栅化会裁掉多余部分。
  var POST_VS = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 aPos;',
    'out vec2 vUv;',
    'void main(){ vUv = aPos*0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');

  var BRIGHT_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D uTex;',
    'uniform float uThreshold;',
    'uniform float uKnee;',
    'in vec2 vUv;',
    'out vec4 o;',
    'void main(){',
    '  vec3 c = texture(uTex, vUv).rgb;',
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    //   软膝盖：阈值附近平滑过渡，避免亮部边缘出现硬轮廓
    '  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0*uKnee);',
    '  soft = soft*soft/(4.0*uKnee + 0.0001);',
    '  float contrib = max(soft, l - uThreshold)/max(l, 0.0001);',
    '  o = vec4(c*contrib, 1.0);',
    '}'
  ].join('\n');

  var BLUR_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D uTex;',
    'uniform vec2 uStep;',
    'in vec2 vUv;',
    'out vec4 o;',
    'void main(){',
    //   9 抽样线性采样高斯：等效 5×5 卷积，只花 5 次纹理读取
    '  vec3 s = texture(uTex, vUv).rgb * 0.227027;',
    '  s += (texture(uTex, vUv + uStep*1.3846).rgb',
    '     +  texture(uTex, vUv - uStep*1.3846).rgb) * 0.316216;',
    '  s += (texture(uTex, vUv + uStep*3.2308).rgb',
    '     +  texture(uTex, vUv - uStep*3.2308).rgb) * 0.070270;',
    '  o = vec4(s, 1.0);',
    '}'
  ].join('\n');

  var COMPOSITE_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D uScene;',
    'uniform sampler2D uBloom;',
    'uniform vec2 uRes;',
    'uniform float uTime;',
    'uniform float uBeat;',
    'uniform float uBloomAmt;',
    'uniform float uVignette;',
    'uniform float uGrain;',
    'uniform float uChroma;',
    'uniform float uExposure;',
    'uniform float uFade;',
    'in vec2 vUv;',
    'out vec4 o;',
    'void main(){',
    '  vec2 c = vUv - 0.5;',
    '  float r2 = dot(c, c);',
    //   色差随离心距增大：中心锐利、边缘分光，起音时整幅抖一下
    '  float ca = uChroma*(0.0014 + r2*0.011)*(1.0 + uBeat*1.25);',
    '  vec3 base;',
    '  base.r = texture(uScene, vUv + c*ca).r;',
    '  base.g = texture(uScene, vUv).g;',
    '  base.b = texture(uScene, vUv - c*ca).b;',
    '  vec3 col = base + texture(uBloom, vUv).rgb*uBloomAmt;',
    '  col *= uExposure;',
    //   指数 tonemap 会把高饱和荧光色往粉彩里洗（加性堆叠越亮越灰）。
    //   tonemap 前先做一档轻度 vibrance 把色度拉回来，极光的荧光绿/紫才
    //   保得住；对其它舞台只是略提饱和，无副作用。
    '  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));',
    '  col = max(mix(vec3(lum), col, 1.10), vec3(0.0));',
    //   指数 tonemap：比 ACES 便宜，且不会把 LDR 场景压暗太多
    '  col = vec3(1.0) - exp(-max(col, 0.0));',
    '  float vig = smoothstep(1.18, 0.16, length(c*vec2(1.06, 1.0)));',
    '  col *= mix(1.0, vig, uVignette);',
    '  float n = fract(sin(dot(vUv*uRes + uTime*13.7, vec2(12.9898, 78.233)))*43758.5453);',
    '  col += (n - 0.5)*uGrain;',
    //   1/255 的抖动：暗部渐变上消除 8bit 色带
    '  col += (fract(sin(dot(vUv*uRes, vec2(12.9898, 78.233)))*43758.5453) - 0.5)/255.0;',
    '  o = vec4(max(col, 0.0)*uFade, 1.0);',
    '}'
  ].join('\n');

  // -------------------------------------------------------------------------
  // 运行时状态
  // -------------------------------------------------------------------------

  var root = null;
  var wrapEl = null;
  var canvas = null;
  var gl = null;
  var glFailed = false;
  var contextLost = false;

  var active = false;
  var fade = 0;             // 0..1 开合淡入淡出
  var fadeTarget = 0;
  var inited = false;
  var uiBound = false;
  var resizeObserver = null, resizeTimers = [];

  var stageIndex = 5;
  var builtStages = {};     // id -> { draw, dispose, count }
  var post = null;          // 后处理资源
  var fsTri = null;

  var time = 0;             // 秒
  var dpr = 1;
  var bw = 1, bh = 1;       // drawing buffer 尺寸
  // 只在尺寸真的动过时才去读 clientWidth：逐帧读会强制一次布局，
  // 而这一层每帧本来就不写 DOM，那次布局纯属白交。
  var sizeDirty = true;

  var proj = mat4();
  var view = mat4();
  var viewR = mat4();

  // 三态相机。user 只被拖拽/滚轮/舞台预设改；cine 每帧被自动演出覆写；
  // cur 是插值后的实际值，永远只被低通推着走。
  var cam = {
    userT: 0, userP: 0.10, userR: 8.4,
    cineT: 0, cineP: 0, cineR: 0,
    curT: 0, curP: 0.10, curR: 8.4,
    look: [0, 0.6, -2.0], curLook: [0, 0.6, -2.0],
    fov: BASE_FOV, fovTarget: BASE_FOV,
    roll: 0, rollTarget: 0,
    minP: -1.15, maxP: 1.15, minR: 1.6, maxR: 42,
    cruise: true, cinemaT: 0,
    pos: [0, 0, 8.4]
  };

  // 转场脉冲
  var trans = { on: false, t: 0, dur: 0.42, scatter: 0, burst: 0, punch: 0 };

  // 音频
  var onset = null;
  var au = { bass: 0, mid: 0, treble: 0, energy: 0, beat: 0 };
  var audioBands = new Float32Array(64);
  var lastBeatAt = -100, previousBeat = 0;
  var pointerField = { x: -9, y: -9, active: 0, clickX: 0, clickY: 0, clickAt: -100 };

  // 色调：从主题 CSS 变量取，跟着换肤走
  var tint = [1, 1, 1];
  var tint2 = [0, 0.96, 0.83];
  var tint3 = [0.96, 0.82, 0.54];

  // 性能与调度
  var perf = {
    hz: 60, lastAt: 0, samples: [],
    avgMs: 0, pressure: 0, divisor: 1, tick: 0,
    lastQualityDropAt: 0, quality: 2, goodSince: 0
  };
  var interactUntil = 0;

  // 交互
  var pointers = {};
  var pointerCount = 0;
  var pinchDist = 0;
  var dragVel = { t: 0, p: 0 };
  var dragging = false;

  var chromeTimer = 0;
  var motion = 0.65, bloom = 0.80, showLyrics = true;
  var reactivity = 1.35;
  var queueData = [], queueOpen = false;
  // 3D 歌单架（stage-shelf.js）：off/stage/side，默认舞台封面流。
  // 默认「右侧竖向歌单架」：歌曲列表在屏幕右缘纵向排列上下滑动，
  // 不再横向铺开（2026-09 需求变更）。
  var shelf = null, shelfMode = 'side';
  var restoring = false;
  var pendingDt = 0;
  var returnFocus = null, backgroundNodes = [];
  var seeking = false, lastCover = null, changingVolume = false;
  var seekTrackId = null, seekCancelled = false;
  var lyricView = null, layout = 'focus', lyricSize = 1, lyricGlow = .45;
  // 舞台主题：只管沉浸舞台操作层的观感（见 stage-themes/）。与皮肤正交——
  // 皮肤换整个应用的布局，舞台主题换舞台 chrome，两者可任意组合。
  var stageTheme = 'classic';

  function reducedMotion() {
    return !!(global.Stage && Stage.presentation && Stage.presentation().reduced) ||
      !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // -------------------------------------------------------------------------
  // GL 基础设施
  // -------------------------------------------------------------------------

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      //  驱动的报错只给行号不给内容：把出错行（±1）的源码一起打出来，
      //  否则每次都得人肉数着色器的第 N 行。
      var log = String(gl.getShaderInfoLog(sh) || '');
      var m = /ERROR:\s*\d+:(\d+)/.exec(log);
      if (m) {
        var n = Number(m[1]);
        var lines = src.split('\n');
        for (var i = Math.max(0, n - 2); i < Math.min(lines.length, n + 1); i += 1) {
          log += '\n  ' + (i + 1) + (i + 1 === n ? ' → ' : '   ') + lines[i];
        }
      }
      console.warn('[stage3d] 着色器编译失败：', log);
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  // 编译并自动收集 uniform location：改着色器不用再同步改一堆 getUniformLocation。
  function buildProgram(vsSrc, fsSrc) {
    var v = compile(gl.VERTEX_SHADER, vsSrc);
    var f = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!v || !f) { if (v) gl.deleteShader(v); if (f) gl.deleteShader(f); return null; }
    var p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('[stage3d] 着色器链接失败：', gl.getProgramInfoLog(p));
      gl.deleteProgram(p);
      return null;
    }
    var u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i += 1) {
      var info = gl.getActiveUniform(p, i);
      if (!info) continue;
      var name = String(info.name).replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p: p, u: u, a: function (n2) { return gl.getAttribLocation(p, n2); } };
  }

  function buffer(data) {
    var b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }

  function indexBuffer(data) {
    var b = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }

  // attribs: [{ loc, buffer, size, divisor }]
  function makeVAO(attribs, indices) {
    var v = gl.createVertexArray();
    gl.bindVertexArray(v);
    for (var i = 0; i < attribs.length; i += 1) {
      var s = attribs[i];
      if (s.loc < 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, s.buffer);
      gl.enableVertexAttribArray(s.loc);
      gl.vertexAttribPointer(s.loc, s.size, gl.FLOAT, false, 0, 0);
      if (s.divisor) gl.vertexAttribDivisor(s.loc, 1);
    }
    if (indices) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.bindVertexArray(null);
    return v;
  }

  function makeRT(w, h, withDepth) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, post.internalFmt, w, h, 0, gl.RGBA, post.texType, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    var rb = null;
    if (withDepth) {
      rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    }
    var complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    var target = { fbo: fbo, tex: tex, rb: rb, w: w, h: h };
    if (!complete) { freeRT(target); return null; }
    return target;
  }

  function freeRT(rt) {
    if (!rt) return;
    if (rt.fbo) gl.deleteFramebuffer(rt.fbo);
    if (rt.tex) gl.deleteTexture(rt.tex);
    if (rt.rb) gl.deleteRenderbuffer(rt.rb);
  }

  // -------------------------------------------------------------------------
  // 几何构造
  // -------------------------------------------------------------------------

  function seeds(count) {
    var a = new Float32Array(count);
    var b = new Float32Array(count);
    for (var i = 0; i < count; i += 1) {
      // +i*0.37：即使 Math.random 撞车也不会有两个完全相同的种子
      a[i] = Math.random() * 1000 + i * 0.37;
      b[i] = Math.random();
    }
    return { seed: buffer(a), lane: buffer(b), count: count };
  }

  function q() {
    var t = (global.Stage && Stage.tier) ? Stage.tier() : 2;
    if (global.Stage && Stage.isLowFx && Stage.isLowFx()) t = 0;
    return clamp(Math.min(num(t, 2), perf.quality), 0, 2);
  }

  function buildField(def) {
    var p = buildProgram(FIELD_VS, FIELD_FS);
    var starP = buildProgram(STAR_VS, STAR_FS);
    if (!p || !starP) {
      if (p) gl.deleteProgram(p.p);
      if (starP) gl.deleteProgram(starP.p);
      return null;
    }
    var level = q(), count = def.counts[level];
    var cols = Math.ceil(Math.sqrt(count * 1.24));
    var rows = Math.floor(count / cols);
    if (def.field === 4) { cols = [180, 280, 360][level]; rows = Math.floor(count / cols / 7) * 7; }
    count = cols * rows;
    var vao = gl.createVertexArray();
    var stars = seeds([900, 1500, 2400][level]);
    var starVao = makeVAO([
      { loc: starP.a('aSeed'), buffer: stars.seed, size: 1 },
      { loc: starP.a('aLane'), buffer: stars.lane, size: 1 }
    ]);
    var ctx = gl, disposed = false, artUrl = '', artReady = false, artImage = null;
    var artScaleX = 1, artScaleY = 1, artLod = 0;
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([48, 76, 96, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    function syncArt() {
      if (def.field !== 0) return;
      var url = global.Stage && Stage.coverUrl ? Stage.coverUrl() || '' : '';
      if (url === artUrl) return;
      artUrl = url; artReady = false; artScaleX = artScaleY = 1; artLod = 0;
      if (artImage) { artImage.onload = null; artImage.onerror = null; }
      if (!url) return;
      var img = artImage = new Image(); img.crossOrigin = 'anonymous';
      img.onload = function () {
        if (disposed || ctx !== gl || ctx.isContextLost() || url !== artUrl || img !== artImage) return;
        try {
          ctx.activeTexture(ctx.TEXTURE0); ctx.bindTexture(ctx.TEXTURE_2D, texture);
          ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, true);
          ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, img);
          ctx.generateMipmap(ctx.TEXTURE_2D);
          ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR_MIPMAP_LINEAR);
          var width = img.naturalWidth || img.width || 1, height = img.naturalHeight || img.height || 1;
          artScaleX = Math.min(1, height / width); artScaleY = Math.min(1, width / height);
          artLod = Math.max(0, Math.log(Math.min(width, height) * 0.5 * Math.sqrt(Math.PI / Math.floor(count * 0.76))) / Math.LN2);
          artReady = true;
        } catch (e) { artReady = false; }
        finally { ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, false); }
      };
      img.src = url;
    }
    return {
      count: count,
      draw: function () {
        syncArt();
        if (def.field === 0) {
          gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
          gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        }
        gl.useProgram(starP.p); uploadCommon(starP); gl.bindVertexArray(starVao);
        gl.drawArrays(gl.POINTS, 0, stars.count);
        if (def.field === 0) {
          gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
          gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        }
        gl.useProgram(p.p); uploadCommon(p); gl.bindVertexArray(vao);
        setI(p.u, 'uField', def.field); setF(p.u, 'uCols', cols); setF(p.u, 'uRows', rows);
        setI(p.u, 'uArt', 0); setF(p.u, 'uHasArt', artReady ? 1 : 0);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
        if (p.u.uBands) gl.uniform1fv(p.u.uBands, audioBands);
        var reduced = reducedMotion();
        if (def.field === 0) {
          setF(p.u, 'uCoverMotion', reduced ? 0 : motion);
          setF(p.u, 'uCoverDistance', def.cam.dist * Math.max(1, Math.min(2.6, 1.05 / (bw / bh))));
          setF(p.u, 'uViewportHeight', bh);
          setV2(p.u, 'uArtScale', artScaleX, artScaleY); setF(p.u, 'uArtLod', artLod);
        }
        setV2(p.u, 'uPointer', pointerField.x, pointerField.y);
        setF(p.u, 'uPointerActive', reduced ? 0 : pointerField.active);
        setF(p.u, 'uBeatAge', reduced ? 100 : Math.max(0, time - lastBeatAt));
        setF(p.u, 'uAspect', bw / bh);
        if (p.u.uClick) gl.uniform3f(p.u.uClick, pointerField.clickX, pointerField.clickY, reduced ? 100 : time - pointerField.clickAt);
        gl.drawArrays(gl.POINTS, 0, count);
      },
      dispose: function () {
        disposed = true;
        if (artImage) { artImage.onload = null; artImage.onerror = null; }
        ctx.deleteProgram(p.p); ctx.deleteProgram(starP.p);
        ctx.deleteVertexArray(vao); ctx.deleteVertexArray(starVao);
        ctx.deleteBuffer(stars.seed); ctx.deleteBuffer(stars.lane); ctx.deleteTexture(texture);
      }
    };
  }

  function buildPrism(def) {
    var prog = buildProgram(PRISM_VS, PRISM_FS);
    if (!prog) return null;
    var s = seeds(def.counts[q()]);
    var vao = makeVAO([
      { loc: prog.a('aSeed'), buffer: s.seed, size: 1 },
      { loc: prog.a('aLane'), buffer: s.lane, size: 1 }
    ]);
    return {
      count: s.count,
      draw: function () {
        gl.useProgram(prog.p);
        uploadCommon(prog);
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.POINTS, 0, s.count);
      },
      dispose: function () {
        gl.deleteProgram(prog.p); gl.deleteVertexArray(vao);
        gl.deleteBuffer(s.seed); gl.deleteBuffer(s.lane);
      }
    };
  }

  var BUILDERS = {
    resonance: buildField,
    silk: buildField,
    aurora: buildField,
    tunnel: buildField,
    terrain: buildField,
    orb: buildField,
    prism: buildPrism
  };

  // -------------------------------------------------------------------------
  // 后处理
  // -------------------------------------------------------------------------

  function buildPost() {
    // 半浮点 RT 优先：HDR 亮部才不会被截断成一片白。拿不到就退到 RGBA8，
    // 合成端的 exposure 会相应调低。
    var hdr = !!gl.getExtension('EXT_color_buffer_float') ||
      !!gl.getExtension('EXT_color_buffer_half_float');
    post = {
      hdr: hdr,
      internalFmt: hdr ? gl.RGBA16F : gl.RGBA,
      texType: hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      scene: null, a: null, b: null
    };
    var pBright = buildProgram(POST_VS, BRIGHT_FS);
    var pBlur = buildProgram(POST_VS, BLUR_FS);
    var pComp = buildProgram(POST_VS, COMPOSITE_FS);
    if (!pBright || !pBlur || !pComp) {
      [pBright, pBlur, pComp].forEach(function (program) { if (program) gl.deleteProgram(program.p); });
      post = null;
      return false;
    }
    post.bright = pBright;
    post.blur = pBlur;
    post.comp = pComp;
    var tri = buffer(new Float32Array([-1, -1, 3, -1, -1, 3]));
    fsTri = makeVAO([{ loc: pBright.a('aPos'), buffer: tri, size: 2 }]);
    post.tri = tri;
    return true;
  }

  function resizeTargets() {
    if (!post) return;
    var hw = Math.max(1, bw >> 1), hh = Math.max(1, bh >> 1);
    if (post.scene && post.scene.w === bw && post.scene.h === bh) return;
    freeRT(post.scene); freeRT(post.a); freeRT(post.b);
    post.scene = makeRT(bw, bh, true);
    post.a = makeRT(hw, hh, false);
    post.b = makeRT(hw, hh, false);
    if (!post.scene || !post.a || !post.b) {
      freeRT(post.scene); freeRT(post.a); freeRT(post.b);
      post.scene = post.a = post.b = null;
      if (post.hdr) {
        post.hdr = false;
        post.internalFmt = gl.RGBA;
        post.texType = gl.UNSIGNED_BYTE;
        resizeTargets();
      } else showFallback('当前设备无法分配舞台画面，请缩小窗口后重试。');
    }
  }

  function drawFullscreen(prog) {
    gl.useProgram(prog.p);
    gl.bindVertexArray(fsTri);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function runPost() {
    if (!post || !post.scene) return;
    var hw = post.a.w, hh = post.a.h;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    // 1) 亮部提取
    gl.bindFramebuffer(gl.FRAMEBUFFER, post.a.fbo);
    gl.viewport(0, 0, hw, hh);
    gl.useProgram(post.bright.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, post.scene.tex);
    setI(post.bright.u, 'uTex', 0);
    //   阈值必须卡在「亮的结构」上：极光底帐加性堆叠后的亮度普遍在 0.5 上下，
    //   阈值放低了整片帷幕都会进 bloom——整屏糊一层半分辨率高斯晕，这就是
    //   「发糊」的直接来源。0.72 只让射线亮脊与星点发光。
    setF(post.bright.u, 'uThreshold', 0.72);
    setF(post.bright.u, 'uKnee', 0.26);
    drawFullscreen(post.bright);

    // 2) 可分离高斯 ping-pong。迭代次数跟着画质档走。
    var iters = q() === 0 ? 1 : (q() === 1 ? 2 : 3);
    gl.useProgram(post.blur.p);
    setI(post.blur.u, 'uTex', 0);
    for (var i = 0; i < iters; i += 1) {
      var spread = 1 + i * 1.15;
      gl.bindFramebuffer(gl.FRAMEBUFFER, post.b.fbo);
      gl.bindTexture(gl.TEXTURE_2D, post.a.tex);
      setV2(post.blur.u, 'uStep', spread / hw, 0);
      drawFullscreen(post.blur);
      gl.bindFramebuffer(gl.FRAMEBUFFER, post.a.fbo);
      gl.bindTexture(gl.TEXTURE_2D, post.b.tex);
      setV2(post.blur.u, 'uStep', 0, spread / hh);
      drawFullscreen(post.blur);
    }

    // 3) 合成到默认帧缓冲
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, bw, bh);
    gl.useProgram(post.comp.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, post.scene.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, post.a.tex);
    setI(post.comp.u, 'uScene', 0);
    setI(post.comp.u, 'uBloom', 1);
    setV2(post.comp.u, 'uRes', bw, bh);
    setF(post.comp.u, 'uTime', time);
    setF(post.comp.u, 'uBeat', au.beat);
    setF(post.comp.u, 'uBloomAmt', bloom * (q() === 0 ? 0.7 : 1.05));
    setF(post.comp.u, 'uVignette', 0.62);
    setF(post.comp.u, 'uGrain', 0.028);
    setF(post.comp.u, 'uChroma', 0.16 + au.beat * 0.25);
    setF(post.comp.u, 'uExposure', post.hdr ? 1.18 : 1.42);
    setF(post.comp.u, 'uFade', fade);
    drawFullscreen(post.comp);
    // 把活动纹理单元还回 0：上面合成用了两个单元，不还回去的话下一次
    // 进后处理时 bindTexture 会写到 TEXTURE1 上，亮部提取拿到空纹理。
    gl.activeTexture(gl.TEXTURE0);
  }

  // -------------------------------------------------------------------------
  // uniform 写入（全部带空值保护：未使用的 uniform 会被编译器优化掉）
  // -------------------------------------------------------------------------

  function setF(u, name, v) { var l = u[name]; if (l) gl.uniform1f(l, v); }
  // 采样器必须走 uniform1i：用 uniform1f 写 sampler 是 INVALID_OPERATION，
  // 而驱动只会静默地把纹理绑到 0 号单元，画面全黑且不报任何错。
  function setI(u, name, v) { var l = u[name]; if (l) gl.uniform1i(l, v); }
  function setV2(u, name, a, b) { var l = u[name]; if (l) gl.uniform2f(l, a, b); }
  function setV3(u, name, a) { var l = u[name]; if (l) gl.uniform3f(l, a[0], a[1], a[2]); }
  function setM4(u, name, m) { var l = u[name]; if (l) gl.uniformMatrix4fv(l, false, m); }

  function uploadCommon(prog) {
    setM4(prog.u, 'uProj', proj);
    setM4(prog.u, 'uView', viewR);
    setV3(prog.u, 'uCamPos', cam.pos);
    setF(prog.u, 'uTime', time);
    setF(prog.u, 'uBass', au.bass);
    setF(prog.u, 'uMid', au.mid);
    setF(prog.u, 'uTreble', au.treble);
    setF(prog.u, 'uEnergy', au.energy);
    setF(prog.u, 'uBeat', au.beat);
    setF(prog.u, 'uScatter', trans.scatter);
    setF(prog.u, 'uBurst', trans.burst);
    setF(prog.u, 'uPointScale', dpr);
    setF(prog.u, 'uFade', fade);
    setV3(prog.u, 'uTint', tint);
    setV3(prog.u, 'uTint2', tint2);
    setV3(prog.u, 'uTint3', tint3);
  }

  // -------------------------------------------------------------------------
  // 上下文生命周期
  // -------------------------------------------------------------------------

  function ensureGl() {
    if (gl) return true;
    if (glFailed || !wrapEl) return false;
    contextLost = false;
    canvas = document.createElement('canvas');
    canvas.className = 's3d-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    wrapEl.appendChild(canvas);
    try {
      gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: true, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false,
        powerPreference: 'high-performance'
      });
    } catch (e) { gl = null; }
    if (!gl) {
      // 拿不到上下文就把画布撤掉：宁可整个舞台不出现，也不抢别人的上下文。
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      canvas = null;
      glFailed = true;
      showFallback('当前环境不支持 WebGL2，三维舞台不可用。');
      return false;
    }

    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);

    gl.disable(gl.DITHER);
    if (!buildPost()) {
      releaseGl();
      showFallback('三维舞台的后处理链初始化失败。');
      return false;
    }
    return true;
  }

  function onContextLost(e) {
    // 不 preventDefault 就永远不会收到 restored。
    if (e && e.preventDefault) e.preventDefault();
    contextLost = true;
    cancelGestures();
    // Detach pending cover loads before the restored context invalidates their textures.
    disposeStages();
    post = null;
    // 平面布局不依赖 GL，不能让 fallback 横幅盖住 folia；但 preventDefault/
    // 状态位/资源释放这些恢复前置动作必须照常，否则切回三维后无法恢复。
    if (!isPlane()) showFallback('舞台正在恢复渲染，音乐播放不受影响。');
    pokeChrome();
  }

  function onContextRestored() {
    contextLost = false;
    glFailed = false;
    if (!gl) return;
    gl.disable(gl.DITHER);
    if (buildPost()) {
      builtStages = {}; sizeDirty = true;
      $('s3d-fallback').hidden = true;
      if (global.Stage && Stage.kick) Stage.kick();
    } else { releaseGl(); showFallback('舞台暂时无法恢复，可退出后重新进入。'); }
  }

  function releaseGl() {
    disposeStages();
    builtStages = {};
    if (post) {
      freeRT(post.scene); freeRT(post.a); freeRT(post.b);
      if (post.bright) gl.deleteProgram(post.bright.p);
      if (post.blur) gl.deleteProgram(post.blur.p);
      if (post.comp) gl.deleteProgram(post.comp.p);
      if (post.tri) gl.deleteBuffer(post.tri);
    }
    if (fsTri && gl) gl.deleteVertexArray(fsTri);
    post = null;
    fsTri = null;
    if (canvas) {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      var ext = gl.getExtension('WEBGL_lose_context');
      if (ext) { try { ext.loseContext(); } catch (e) { /* ignore */ } }
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }
    canvas = null;
    gl = null;
  }

  function showFallback(text) {
    var el = $('s3d-fallback');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
  }

  // -------------------------------------------------------------------------
  // 尺寸与 DPR
  // -------------------------------------------------------------------------

  // 双钳制：硬性 DPR 上限 ∩ 总像素预算。只写 min(dpr, 1.5) 的话，4K 屏上
  // 光栅化像素数会是 1080p 的四倍，帧率直接腰斩。
  function computeDpr(w, h) {
    var dev = window.devicePixelRatio || 1;
    var level = q();
    var cap = level === 0 ? 1.0 : (level === 1 ? 1.15 : 1.55);
    var budget = level === 0 ? 1900000 : (level === 1 ? 3600000 : 6200000);
    var budgetCap = Math.sqrt(budget / Math.max(1, w * h));
    var maxSize = gl ? Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) : Infinity;
    return Math.min(dev, cap, budgetCap, maxSize / Math.max(w, h));
  }

  function resize() {
    if (!gl || !root) return;
    var w = Math.max(1, Math.round(wrapEl.clientWidth || window.innerWidth));
    var h = Math.max(1, Math.round(wrapEl.clientHeight || window.innerHeight));
    dpr = computeDpr(w, h);
    var nw = Math.max(1, Math.floor(w * dpr));
    var nh = Math.max(1, Math.floor(h * dpr));
    if (canvas.width !== nw || canvas.height !== nh) {
      canvas.width = nw; canvas.height = nh;
    }
    bw = canvas.width; bh = canvas.height;
    resizeTargets();
    sizeDirty = false;
  }

  // -------------------------------------------------------------------------
  // 相机
  // -------------------------------------------------------------------------

  function applyStageCamera(def, immediate) {
    cam.userT = def.cam.theta;
    cam.userP = def.cam.phi;
    cam.userR = clamp(def.cam.dist, cam.minR, cam.maxR);
    cam.look = def.cam.look.slice();
    if (immediate) {
      cam.curT = cam.userT; cam.curP = cam.userP; cam.curR = cam.userR;
      cam.curLook = cam.look.slice();
    }
  }

  // 球坐标 → 笛卡尔。注意 phi 是仰角（不是 three.js 那种从 +Y 量起的极角）。
  function updateCamera(dtMs) {
    // 自动演出：三条互质低频正弦叠加，周期各不相同的「呼吸」。
    cam.cinemaT += dtMs / 1000;
    var amount = reducedMotion() ? 0 : motion;
    var drift = cam.cruise ? amount : 0;
    var userBusy = dragging ? 0.25 : 1;   // 用户在拖的时候自动让位
    var d = drift * userBusy;
    cam.cineT = Math.sin(cam.cinemaT * 0.083) * 0.030 * d + au.beat * 0.012 * amount;
    cam.cineP = Math.sin(cam.cinemaT * 0.061 + 1.0) * 0.024 * d;
    cam.cineR = Math.sin(cam.cinemaT * 0.043 + 2.0) * 0.22 * d - au.beat * 0.30 * amount;

    var tT = cam.userT + cam.cineT;
    var tP = clamp(cam.userP + cam.cineP, cam.minP, cam.maxP);
    var tR = clamp(cam.userR + cam.cineR, cam.minR, cam.maxR);

    cam.curT = damp(cam.curT, tT, TAU_ANGLE, dtMs);
    cam.curP = damp(cam.curP, tP, TAU_ANGLE, dtMs);
    cam.curR = damp(cam.curR, tR, TAU_RADIUS, dtMs);
    for (var i = 0; i < 3; i += 1) {
      cam.curLook[i] = damp(cam.curLook[i], cam.look[i], TAU_LOOK, dtMs);
    }

    // 起音：焦距收窄快、回弹慢，这个不对称是打击感的来源
    cam.fovTarget = BASE_FOV - (trans.punch * 2.6 + au.beat * 1.1) * amount;
    var tau = cam.fovTarget < cam.fov ? 90 : 240;
    cam.fov = damp(cam.fov, cam.fovTarget, tau, dtMs);
    cam.rollTarget = au.beat * 0.012 * amount;
    cam.roll = damp(cam.roll, cam.rollTarget, 160, dtMs);

    var cp = Math.cos(cam.curP), sp = Math.sin(cam.curP);
    var ct = Math.cos(cam.curT), st = Math.sin(cam.curT);
    var aspect = bw / Math.max(1, bh);
    var framed = /^(resonance|silk|orb)$/.test(STAGES[stageIndex].id);
    var fit = framed ? Math.max(1, Math.min(2.6, 1.05 / aspect)) : 1;
    var radius = cam.curR * fit;
    var px = cam.curLook[0] + radius * cp * st;
    var py = cam.curLook[1] + radius * sp;
    var pz = cam.curLook[2] + radius * cp * ct;
    cam.pos[0] = px; cam.pos[1] = py; cam.pos[2] = pz;

    perspective(proj, cam.fov * Math.PI / 180, aspect, 0.1, 220);
    lookAt(view, px, py, pz, cam.curLook[0], cam.curLook[1], cam.curLook[2], 0, 1, 0);
    rollView(viewR, view, cam.roll);
  }

  function resetView() {
    var def = STAGES[stageIndex];
    applyStageCamera(def, false);
    cam.fov = BASE_FOV;
    cam.roll = 0;
    dragVel.t = 0;
    dragVel.p = 0;
    markInteraction(700);
  }

  // -------------------------------------------------------------------------
  // 音频
  // -------------------------------------------------------------------------

  function updateAudio(dtMs) {
    var live = global.Stage && Stage.presentation && Stage.presentation().playing && !reducedMotion();
    var sp = (live && Stage.spectrum) ? Stage.spectrum() : null;
    var n = sp ? sp.length : 0;
    for (var b = 0; b < 64; b += 1) audioBands[b] = damp(audioBands[b], n ? clamp(Math.pow(Math.max(0, sp[Math.min(n - 1, Math.floor(b * n / 64))] || 0), 0.7) * reactivity, 0, 1.5) : 0, 65, dtMs);
    var bass = 0, mid = 0, treble = 0;
    if (n) {
      var i;
      var e1 = Math.max(1, Math.floor(n * 0.125));
      for (i = 0; i < e1; i += 1) bass += sp[i] || 0;
      bass /= e1;
      var s2 = Math.max(1, Math.floor(n * 0.25));
      for (i = e1; i < s2; i += 1) mid += sp[i] || 0;
      mid /= Math.max(1, s2 - e1);
      var s3 = Math.max(1, Math.floor(n * 0.55));
      for (i = s2; i < s3; i += 1) treble += sp[i] || 0;
      treble /= Math.max(1, s3 - s2);
      treble = treble * 0.6 + (function () {
        var hi = 0, c = 0;
        for (i = s3; i < n; i += 1) { hi += sp[i] || 0; c += 1; }
        return c ? hi / c : 0;
      })() * 0.4;
    }
    au.bass = damp(au.bass, clamp(Math.pow(bass, 0.7) * reactivity, 0, 1.5), 70, dtMs);
    au.mid = damp(au.mid, clamp(Math.pow(mid, 0.7) * reactivity, 0, 1.5), 90, dtMs);
    au.treble = damp(au.treble, clamp(Math.pow(treble, 0.7) * reactivity, 0, 1.5), 60, dtMs);

    var en = (live && Stage.energy) ? Stage.energy() : 0;
    au.energy = damp(au.energy, clamp(num(en, 0) * reactivity, 0, 1), 140, dtMs);

    // 起音只认 Onset 一份判定，避免「换一种渲染，律动看起来变了」。
    if (onset && n) {
      onset.step(dtMs, sp, time * 1000);
      au.beat = clamp(onset.pulse * reactivity / 1.35, 0, 1);
    } else {
      au.beat = damp(au.beat, 0, 200, dtMs);
    }
    if (au.beat > previousBeat + 0.08 && au.beat > 0.20 && time - lastBeatAt > 0.22) lastBeatAt = time;
    previousBeat = au.beat;
  }

  // -------------------------------------------------------------------------
  // 转场
  // -------------------------------------------------------------------------

  function startTransition() {
    if (reducedMotion()) { trans.on = false; trans.scatter = trans.burst = trans.punch = 0; return; }
    trans.on = true;
    trans.t = 0;
    trans.punch = Math.max(trans.punch, 0.16);
  }

  function updateTransition(dtMs) {
    if (trans.on) {
      trans.t += dtMs / 1000;
      var raw = trans.t / trans.dur;
      if (raw >= 1) { trans.on = false; trans.scatter = 0; trans.burst = 0; }
      else {
        // sin(t·π)：0 → 1 → 0 的对称脉冲，一次性、自收敛
        var wave = Math.sin(clamp(raw, 0, 1) * Math.PI);
        trans.scatter = wave * 0.16;
        trans.burst = wave * 0.55;
      }
    }
    trans.punch = damp(trans.punch, 0, 260, dtMs);
    fade = damp(fade, fadeTarget, 220, dtMs);
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  // 全部舞台的 GL 资源一次性释放（画质降档、上下文丢失、整体销毁都走它）。
  // 注意是彻底的 remove → dispose 三件套，否则换档时旧几何会一直挂在显存里。
  function disposeStages() {
    Object.keys(builtStages).forEach(function (k) {
      try { builtStages[k].dispose(); } catch (e) { /* ignore */ }
      delete builtStages[k];
    });
  }

  function ensureStage() {
    var def = STAGES[stageIndex];
    if (builtStages[def.id]) return builtStages[def.id];
    var fn = BUILDERS[def.id];
    var built = fn ? fn(def) : null;
    if (!built) return null;
    builtStages[def.id] = built;
    return built;
  }

  function drawStage(st) {
    var def = STAGES[stageIndex];
    gl.bindFramebuffer(gl.FRAMEBUFFER, post.scene.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.clearColor(0.004, 0.005, 0.009, 1);
    // 清深度之前必须先把 depthMask 打开。加性舞台（星野 / 隧道 / 星系）会把
    // depthMask 关掉，如果紧接着切到写深度的舞台（地形 / 星球），清屏就会
    // 因为 depthMask=false 而**静默跳过深度清零**，新几何被上一帧的陈旧深度
    // 挡掉大半 —— 症状是星球只剩一牙，而且只在"从加性舞台切过来"时出现。
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (def.depth) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
    } else {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
    }
    if (def.additive) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);   // 加性：舞台是光，不是面
    } else {
      gl.disable(gl.BLEND);
    }
    gl.disable(gl.CULL_FACE);

    st.draw();
    gl.bindVertexArray(null);
  }

  function render(dtMs) {
    // 3D 场景始终渲染：folia 歌词只是透明叠加层（standalone 无 GL 回退时才没有 GL）。
    if (!gl || contextLost || sceneCovered()) return;
    if (sizeDirty) resize();
    if (!post || !post.scene || !post.a || !post.b) return;
    updateAudio(dtMs);
    updateCamera(dtMs);
    updateTransition(dtMs);

    var st = ensureStage();
    if (!st) { showFallback('当前场景未能加载，请切换另一舞台。'); return; }

    // 主几何的公共 uniform 靠「每个 program 上传一遍」——各个舞台的 uniform
    // 布局一致，切换时无需重新绑定，代价可以忽略。
    drawStage(st);
    runPost();
    paintWords();
  }

  // -------------------------------------------------------------------------
  // 帧调度
  // -------------------------------------------------------------------------

  function sampleHz(dtMs) {
    // 中位数抗离群 + 迟滞 EMA：换显示器时快速跟上，平时慢速收敛。
    if (dtMs < 4 || dtMs > 40) return;
    perf.samples.push(dtMs);
    if (perf.samples.length > 36) perf.samples.shift();
    var s = perf.samples.slice().sort(function (a, b) { return a - b; });
    var hz = clamp(1000 / Math.max(1, s[s.length >> 1]), 40, 240);
    perf.hz = Math.abs(perf.hz - hz) > 18 ? hz : perf.hz * 0.9 + hz * 0.1;
  }

  function sampleCost(costMs) {
    if (!isFinite(costMs) || costMs < 0) return;
    var budget = (1000 / Math.max(1, perf.hz)) * 0.72;
    perf.avgMs = perf.avgMs ? perf.avgMs * 0.9 + costMs * 0.1 : costMs;
    // 压力计带滞回：涨得快、落得慢，避免在阈值附近来回抖。
    if (perf.avgMs > budget) {
      perf.pressure = Math.min(6, perf.pressure + 0.7);
      perf.goodSince = 0;
    }
    else if (perf.avgMs < budget * 0.62) perf.pressure = Math.max(0, perf.pressure - 0.3);
    else perf.pressure = Math.max(0, perf.pressure - 0.1);
  }

  function selectDivisor() {
    var now = performance.now();
    var boost = now < interactUntil;
    if (boost) return 1;
    if (perf.pressure >= 4) {
      // 连续吃满预算就再降一档画质（DPR 随之变小），但 8 秒内只降一次，
      // 免得刚降完还没生效又接着降。
      if (perf.quality > 0 && now - perf.lastQualityDropAt > 8000) {
        perf.quality -= 1;
        perf.lastQualityDropAt = now;
        // 画质档同时决定 DPR 与粒子/实例数量，所以几何要按新档重建。
        disposeStages();
        sizeDirty = true;
      }
      return perf.hz >= 120 ? 3 : 2;
    }
    if (perf.pressure >= 2) return perf.hz >= 90 ? 2 : 1;
    // 压力清零持续 12 秒就逐档回升（上限仍被设备档钳住）：偶发卡顿不该
    // 永久钉在最低档——此前画质只降不升，糊过一次就一直糊到刷新页面。
    if (!perf.goodSince) perf.goodSince = now;
    if (perf.quality < 2 && now - perf.goodSince > 12000) {
      perf.quality += 1;
      perf.goodSince = now;
      disposeStages();
      sizeDirty = true;
    }
    return 1;
  }

  function markInteraction(holdMs) {
    interactUntil = performance.now() + (holdMs || 900);
  }

  // 目标帧率。返回 0 表示这一层完全不需要帧，主循环据此停机。
  function targetFps() {
    if (!active || document.hidden) return 0;
    if (contextLost && !foliaActive()) return 0;
    if (post && !post.scene && !sizeDirty && !foliaActive()) return 0;
    // 无 GL 时只有 folia 歌词视觉需要帧（纯平面回退）；有 GL 一律走原帧率。
    if (!gl) return foliaActive() ? (reducedMotion() ? 15 : 60) : 0;
    // 240 = 「每个 rAF 都给我」，降频自己用整数除数在 tick 里做：
    // 帧率必须是刷新率的整数分之一，90fps@144Hz 会因为帧间隔不均产生 judder。
    if (reducedMotion()) return 15;
    var data = global.Stage && Stage.presentation ? Stage.presentation() : null;
    if (!dragging && performance.now() > interactUntil && (!data || !data.playing)) return 30;
    return 240;
  }

  function tick(dtMs) {
    if (!active || document.hidden) return;
    var t0 = performance.now();
    // 帧停摆后的一记补帧不是性能证据：内嵌视图/遮挡窗口里「偶发泵帧 + 被
    // 高估的 hz」会把压力计一路顶满，画质被永久钉在最低档——极光穹顶发糊
    // 的根源。两帧墙钟隔太久时，耗时样本与压力全部作废，从头再积累。
    if (perf.lastAt && t0 - perf.lastAt > 250) {
      perf.samples.length = 0;
      perf.avgMs = 0;
      perf.pressure = 0;
      perf.goodSince = 0;
    }
    perf.lastAt = t0;
    sampleHz(dtMs);
    perf.divisor = selectDivisor();
    perf.tick += 1;
    pendingDt += dtMs;
    if (perf.divisor > 1 && (perf.tick - 1) % perf.divisor !== 0) return;
    // The host gate resets its accumulator on every callback, including skipped
    // callbacks. Accumulate here so adaptive rendering cannot slow the animation.
    var step = Math.min(pendingDt, 160);
    pendingDt = 0;
    if (!reducedMotion()) time += step / 1000;
    render(step);
    // 3D 歌词轨倾角只在舞台轨模式需要；folia 接管歌词时该轨隐藏。
    if (showLyrics && !foliaActive()) writeLyrTilt();
    if (foliaActive()) driveFolia(step);
    sampleCost(performance.now() - t0);
  }

  // -------------------------------------------------------------------------
  // 交互
  // -------------------------------------------------------------------------

  function localPoint(e) {
    var r = wrapEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function controlTarget(e) {
    return e.target && e.target.closest && e.target.closest('button, a, input, select, textarea, [contenteditable], [role="button"], .s3d-settings, .s3d-queue-panel, #s3d-reading, #s3d-folia');
  }

  function cancelGestures() {
    cancelSeek();
    endVolumeChange();
    Object.keys(pointers).forEach(function (id) {
      onPointerUp({ pointerId: Number(id), type: 'pointercancel' });
    });
    var host = $('s3d-reading');
    var id = lyrTilt.dragId;
    lyrTilt.dragId = -1;
    lyrTilt.from = null;
    if (host && host.hasPointerCapture && host.hasPointerCapture(id)) host.releasePointerCapture(id);
    dragVel.t = dragVel.p = 0;
    pointerField.active = 0;
  }

  function onPointerDown(e) {
    if (!active || (e.button != null && e.button !== 0) || pointers[e.pointerId]) return;
    // 仅无 GL 纯平面回退禁用 3D 手势；folia 透明叠加时相机拖拽照常
    // （folia 容器 pointer-events:none，词节点自己处理点击 seek，空白处穿透到这里）。
    if (isStandalone() || sceneCovered() || controlTarget(e)) return;
    root.focus({ preventScroll: true });
    var point = localPoint(e);
    pointerField.clickX = point.x / wrapEl.clientWidth * 2 - 1;
    pointerField.clickY = 1 - point.y / wrapEl.clientHeight * 2;
    pointerField.clickAt = time;
    pointers[e.pointerId] = localPoint(e);
    pointerCount += 1;
    if (pointerCount === 1) {
      dragging = true;
      dragVel.t = 0; dragVel.p = 0;
      root.classList.add('s3d-dragging');
    } else if (pointerCount === 2) {
      var ks = Object.keys(pointers);
      var a = pointers[ks[0]], b = pointers[ks[1]];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    markInteraction(1000);
    if (canvas && canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
  }

  function onPointerMove(e) {
    if (!active) return;
    var point = localPoint(e);
    pointerField.x = point.x / wrapEl.clientWidth * 2 - 1;
    pointerField.y = 1 - point.y / wrapEl.clientHeight * 2;
    if (!reducedMotion() && layout === 'sleeve') {
      root.style.setProperty('--sleeve-rx', (-pointerField.y * 5) + 'deg');
      root.style.setProperty('--sleeve-ry', (pointerField.x * 8 - 14) + 'deg');
    }
    pointerField.active = 1;
    var prev = pointers[e.pointerId];
    markInteraction(900);
    if (!prev) return;
    var p = localPoint(e);
    if (pointerCount >= 2) {
      pointers[e.pointerId] = p;
      // 双指捏合：只认两指间距的变化量
      var ks = Object.keys(pointers);
      var a = pointers[ks[0]], b = pointers[ks[1]];
      var d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) {
        cam.userR = clamp(cam.userR * (pinchDist / Math.max(1, d)), cam.minR, cam.maxR);
      }
      pinchDist = d;
      pointers[e.pointerId] = p;
      return;
    }
    var dx = p.x - prev.x, dy = p.y - prev.y;
    pointers[e.pointerId] = p;
    if (!dragging) return;
    // 0.28°/px 与创意舞台保持一致，换一层渲染时手感不该变。
    var dt2 = dx * 0.0049;
    var dp = dy * 0.0038;
    cam.userT -= dt2;
    cam.userP = clamp(cam.userP + dp, cam.minP, cam.maxP);
    dragVel.t = -dt2;
    dragVel.p = dp;
  }

  function onPointerUp(e) {
    if (!pointers[e.pointerId]) return;
    delete pointers[e.pointerId];
    pointerCount = Math.max(0, pointerCount - 1);
    if (canvas && canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (e.type !== 'pointerup') dragVel.t = dragVel.p = 0;
    if (pointerCount === 0) {
      dragging = false;
      root.classList.remove('s3d-dragging');
      pinchDist = 0;
    }
    markInteraction(700);
  }

  function onWheel(e) {
    if (!active || e.ctrlKey || e.metaKey || controlTarget(e)) return;
    if (isStandalone() || sceneCovered()) return;
    e.preventDefault();
    var delta = (e.deltaY || 0) * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? wrapEl.clientHeight : 1);
    var k = Math.exp(-clamp(delta, -500, 500) * 0.0012);
    cam.userR = clamp(cam.userR * k, cam.minR, cam.maxR);
    markInteraction(900);
  }

  // -------------------------------------------------------------------------
  // 歌词 3D（自歌词演出页移植）
  //
  // 与歌词页同一套手法：CSS 3D 而不是 WebGL——歌词留在 DOM 里才保得住清晰
  // 度、字体回退与点击跳转；让旋转"看起来是 3D"的是每行按离当前行的距离
  // translateZ（stage-lyrics 的 --sl-d），近的行位移多、远的少，转起来有视差。
  //
  // 手势分工：抓住歌词行拖拽 = 转歌词平面本身（横向绕 Y、纵向绕 X，角度不设
  // 上限，可连续转满整圈）；画布空白处拖拽 = 转机位（上面的 pointer 处理器）。
  // 行的 click（点一行跳转）由 8px 阈值保护，超阈值算拖拽。
  // -------------------------------------------------------------------------

  var lyrTilt = { rx: 0, ry: 0, _rx: null, _ry: null, dragId: -1, from: null, lastInputAt: 0, on: false };

  function readLyrTilt() {
    var cs = getComputedStyle(document.documentElement);
    // 与歌词页共用同一个开关：--lp-3d: off 时两边都不转。
    lyrTilt.on = cs.getPropertyValue('--lp-3d').trim() !== 'off';
  }

  function writeLyrTilt() {
    if (!lyrTilt.on || !root) return;
    var t = performance.now();
    var rx = lyrTilt.rx, ry = lyrTilt.ry;
    // 静止超过 1.4s 后小幅正弦漂移（与歌词页同一参数）；用户刚操作过就让位。
    if (lyrTilt.dragId < 0 && !reducedMotion() && t - lyrTilt.lastInputAt > 1400) {
      var d = Math.sin(t / 5200) * 3.4;
      rx += d * 0.6;
      ry += d;
    }
    if (rx === lyrTilt._rx && ry === lyrTilt._ry) return;
    lyrTilt._rx = rx;
    lyrTilt._ry = ry;
    root.style.setProperty('--s3d-rx', rx.toFixed(2) + 'deg');
    root.style.setProperty('--s3d-ry', ry.toFixed(2) + 'deg');
  }

  function resetLyrTilt() {
    lyrTilt.rx = 0;
    lyrTilt.ry = 0;
    lyrTilt.lastInputAt = performance.now();
    lyrTilt._rx = null;
    writeLyrTilt();
  }

  function bindLyrTilt() {
    readLyrTilt();
    var host = $('s3d-reading');
    if (!host) return;
    host.addEventListener('pointerdown', function (e) {
      if (!active || !showLyrics || !lyrTilt.on || e.button !== 0 || lyrTilt.dragId >= 0) return;
      lyrTilt.dragId = e.pointerId;
      lyrTilt.from = { x: e.clientX, y: e.clientY, rx: lyrTilt.rx, ry: lyrTilt.ry, moved: 0 };
      lyrTilt.lastInputAt = performance.now();
      // 捕获后移出歌词区也不会丢事件，更不会中途落到画布上变成转机位。
    });
    host.addEventListener('pointermove', function (e) {
      if (e.pointerId !== lyrTilt.dragId || !lyrTilt.from) return;
      var dx = e.clientX - lyrTilt.from.x;
      var dy = e.clientY - lyrTilt.from.y;
      lyrTilt.from.moved = Math.max(lyrTilt.from.moved, Math.abs(dx) + Math.abs(dy));
      if (lyrTilt.from.moved < 8) return;
      if (host.setPointerCapture && !host.hasPointerCapture(e.pointerId)) host.setPointerCapture(e.pointerId);
      // 拖 4px 转 1°，与歌词页同一手感。直接写不等帧门：eco 档 24fps 下
      // 等一帧要 40ms，手感就是"粘"。
      lyrTilt.ry = lyrTilt.from.ry + dx / 4;
      lyrTilt.rx = lyrTilt.from.rx - dy / 4;
      lyrTilt.lastInputAt = performance.now();
      writeLyrTilt();
      if (e.cancelable) e.preventDefault();
    });
    function end(e) {
      if (e.pointerId !== lyrTilt.dragId) return;
      lyrTilt.dragId = -1;
      if (host.hasPointerCapture && host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
      lyrTilt.lastInputAt = performance.now();
      // 挂到宿主上，供 stage-lyrics 的行 click 判断"这一下是拖拽不是跳转"。
      host._justDragged = !!(lyrTilt.from && lyrTilt.from.moved >= 8);
      lyrTilt.from = null;
      if (host._justDragged) setTimeout(function () { host._justDragged = false; }, 0);
    }
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
    host.addEventListener('lostpointercapture', end);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
    host.addEventListener('dblclick', resetLyrTilt);
  }

  // -------------------------------------------------------------------------
  // 全屏
  // -------------------------------------------------------------------------

  function fsEl() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function requestFs() {
    var el = root;
    if (!el) return;
    try {
      if (el.requestFullscreen) {
        var p = el.requestFullscreen();
        if (p && p.catch) p.catch(function () { /* 被拒绝就留在页内全屏 */ });
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      }
    } catch (e) { /* 页内全屏仍然可用 */ }
  }

  function exitFs() {
    try {
      if (document.exitFullscreen) {
        var p = document.exitFullscreen();
        if (p && p.catch) p.catch(function () { /* ignore */ });
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    } catch (e) { /* ignore */ }
  }

  function toggleFullscreen() {
    if (fsEl()) exitFs(); else requestFs();
  }

  function syncFsUi() {
    var on = !!fsEl();
    sizeDirty = true;
    root.classList.toggle('s3d-native-fs', on);
    var b = $('s3d-fs');
    if (b) {
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? '退出全屏 (F)' : '全屏 (F)';
    }
  }

  function pokeChrome() {
    if (!root || !active) return;
    var wasVisible = root.classList.contains('s3d-chrome');
    root.classList.add('s3d-chrome');
    if (!wasVisible && global.Stage && Stage.kick) Stage.kick();
    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = setTimeout(function () {
      // 队列面板打开不再豁免 chrome：它应与 3D 歌单架一致，
      // 静止后随 chrome 一起淡出（只保留舞台与歌词）。
      // 设置/工坊面板属于显式模态，静止期间仍保留。
      if ((global.Workshop && Workshop.isOpen()) || !$('s3d-settings').hidden || root.querySelector('.s3d-head:focus-within, .s3d-player:focus-within, .s3d-dock:focus-within') || dragging || seeking) return;
      root.classList.remove('s3d-chrome');
    }, CHROME_HIDE_MS);
  }

  // -------------------------------------------------------------------------
  // 舞台切换
  // -------------------------------------------------------------------------

  function setStage(i, immediate) {
    i = Math.round(clamp(num(i, 0), 0, STAGES.length - 1));
    var changed = i !== stageIndex;
    stageIndex = i;
    var def = STAGES[i];
    root.setAttribute('data-scene', def.id);
    applyStageCamera(def, !!immediate);
    if (changed) startTransition();
    if (changed) savePreferences();
    if (gl && !contextLost) $('s3d-fallback').hidden = true;
    syncDock();
    // 进入封面浮雕默认只保留舞台场景与歌词：播放队列不常驻，
    // 由鼠标移动/按键唤醒 chrome 时才显示，静止后自动收起。
    markInteraction(1200);
    if (global.Stage && Stage.kick) Stage.kick();
    return true;
  }

  function cycleStage(dir) {
    setStage((stageIndex + (dir || 1) + STAGES.length) % STAGES.length, false);
  }

  function control(action, value) {
    document.dispatchEvent(new CustomEvent('stage:control', { detail: { action: action, value: value } }));
    pokeChrome();
  }

  function preferences() {
    return { scene: STAGES[stageIndex].id, motion: motion, bloom: bloom, reactivity: reactivity, lyrics: showLyrics, cruise: cam.cruise, layout: layout, lyricSize: lyricSize, lyricGlow: lyricGlow,
      shelfMode: shelfMode,
      stageTheme: stageTheme,
      foliaVisual: folia.visual,
      foliaBg: folia.bgMode, foliaBgOpacity: folia.bgOpacity, foliaVignette: folia.vignette,
      foliaWallpaper: folia.wallpaper, foliaWallpaperDim: folia.wallpaperDim,
      foliaSubtitle: folia.subtitle, classicTuning: folia.classicTuning, cadenzaTuning: folia.cadenzaTuning,
      sonnetTuning: folia.sonnetTuning, temperaTuning: folia.temperaTuning };
  }

  function savePreferences() { if (!restoring) control('stage3d', preferences()); }

  function configure(value) {
    if (!value || typeof value !== 'object') return;
    restoring = true;
    try {
      if (typeof value.motion === 'number') motion = clamp(num(value.motion, 0.65), 0, 1);
      if (typeof value.bloom === 'number') bloom = clamp(num(value.bloom, 0.8), 0, 1.5);
      if (typeof value.reactivity === 'number') reactivity = clamp(num(value.reactivity, 1.35), 0, 2);
      if (typeof value.lyrics === 'boolean') showLyrics = value.lyrics;
      if (typeof value.cruise === 'boolean') cam.cruise = value.cruise;
      // 布局始终是三维舞台（focus/sleeve/single）。旧版本把流光/心象存成了 layout，
      // 这里一次性迁移到正交的 foliaVisual 维度（layout 归位 focus）。
      if (value.layout === 'spark') { layout = 'focus'; folia.visual = 'classic'; }
      else if (value.layout === 'scatter') { layout = 'focus'; folia.visual = 'cadenza'; }
      else if (value.layout === 'classic' || value.layout === 'cadenza') { layout = 'focus'; folia.visual = value.layout; }
      else if (['focus', 'sleeve', 'single'].indexOf(value.layout) >= 0) { layout = value.layout; }
      if (['stage', 'classic', 'cadenza', 'sonnet', 'tempera'].indexOf(value.foliaVisual) >= 0) folia.visual = value.foliaVisual;
      if (value.stageTheme === 'starfall' || value.stageTheme === 'classic') stageTheme = value.stageTheme;
      if (typeof value.lyricSize === 'number') lyricSize = clamp(value.lyricSize, 0.7, 1.5);
      if (typeof value.lyricGlow === 'number') lyricGlow = clamp(value.lyricGlow, 0, 1);
      if (value.shelfMode === 'off' || value.shelfMode === 'stage' || value.shelfMode === 'side') {
        shelfMode = value.shelfMode;
        if (shelf) shelf.setMode(shelfMode);
        var shelfSel = $('s3d-shelf-mode');
        if (shelfSel) shelfSel.value = shelfMode;
      }
      if (['stage', 'geometric', 'fluid', 'solid', 'anime', 'atmosphere'].indexOf(value.foliaBg) >= 0) folia.bgMode = value.foliaBg;
      if (typeof value.foliaWallpaper === 'string') folia.wallpaper = stageWallpaper(value.foliaWallpaper);
      if (typeof value.foliaWallpaperDim === 'number') folia.wallpaperDim = clamp(num(value.foliaWallpaperDim, 0.48), 0.2, 0.8);
      if (typeof value.foliaBgOpacity === 'number') folia.bgOpacity = clamp(value.foliaBgOpacity, 0, 1);
      if (typeof value.foliaVignette === 'boolean') folia.vignette = value.foliaVignette;
      if (typeof value.foliaSubtitle === 'boolean') folia.subtitle = value.foliaSubtitle;
      if (value.classicTuning && typeof value.classicTuning === 'object') folia.classicTuning = {
        rotation: value.classicTuning.rotation !== false,
        breathing: clamp(num(value.classicTuning.breathing, 1), 0, 2),
        spacing: clamp(num(value.classicTuning.spacing, 0.7), 0, 2)
      };
      if (value.cadenzaTuning && typeof value.cadenzaTuning === 'object') folia.cadenzaTuning = {
        width: clamp(num(value.cadenzaTuning.width, 0.72), 0.5, 0.9),
        motion: clamp(num(value.cadenzaTuning.motion, 1), 0, 2),
        glow: clamp(num(value.cadenzaTuning.glow, 1), 0, 1.6),
        beam: clamp(num(value.cadenzaTuning.beam, 0), 0, 1.2)
      };
      if (value.sonnetTuning && typeof value.sonnetTuning === 'object') folia.sonnetTuning = {
        shotFlow: typeof value.sonnetTuning.shotFlow === 'string' ? value.sonnetTuning.shotFlow : 'auto',
        lyricLayout: ['phrases', 'lines', 'staircase', 'editorial-track']
          .indexOf(value.sonnetTuning.lyricLayout) >= 0 ? value.sonnetTuning.lyricLayout : 'phrases',
        phraseLength: clamp(Math.round(num(value.sonnetTuning.phraseLength, 12)), 4, 24),
        decor: value.sonnetTuning.decor !== false,
        accents: value.sonnetTuning.accents !== false
      };
      if (value.temperaTuning && typeof value.temperaTuning === 'object') folia.temperaTuning = {
        composition: global.FoliaTempera && global.FoliaTempera.COMPOSITION_KINDS.indexOf(value.temperaTuning.composition) >= 0 ? value.temperaTuning.composition : 'auto',
        colorMode: ['duo', 'mono', 'vivid'].indexOf(value.temperaTuning.colorMode) >= 0 ? value.temperaTuning.colorMode : 'duo',
        screens: value.temperaTuning.screens !== false,
        inversion: value.temperaTuning.inversion !== false
      };
      syncLayout();
      for (var i = 0; i < STAGES.length; i += 1) if (STAGES[i].id === value.scene) setStage(i, true);
      $('s3d-motion').value = Math.round(motion * 100); text('s3d-motion-value', Math.round(motion * 100) + '%');
      $('s3d-bloom').value = Math.round(bloom * 100); text('s3d-bloom-value', Math.round(bloom * 100) + '%');
      $('s3d-reactivity').value = Math.round(reactivity * 100); text('s3d-reactivity-value', Math.round(reactivity * 100) + '%');
      $('s3d-reading').hidden = foliaActive() ? true : !showLyrics;
      $('s3d-lyrics-toggle').setAttribute('aria-pressed', String(showLyrics));
      $('s3d-cruise').setAttribute('aria-pressed', String(cam.cruise));
    } finally { restoring = false; }
  }

  function play() {
    if (global.Stage && Stage.presentation && !Stage.presentation().track) { close(); control('view', 'library'); }
    else control('toggle');
  }

  function fmt(ms) {
    var s = Math.floor(Math.max(0, ms || 0) / 1000);
    return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2);
  }

  function text(id, value) {
    var el = $(id);
    if (el && el.textContent !== value) el.textContent = value;
  }

  function setSettings(on) {
    $('s3d-settings').hidden = !on;
    $('s3d-settings-toggle').setAttribute('aria-expanded', String(on));
    if (on && queueOpen) setQueuePanel(false);
    if (shelf) shelf.setBlocked(!!on || queueOpen);
    pokeChrome();
    if (on) $('s3d-motion').focus();
  }

  // 播放队列浮层：全屏里直接看队列、点行跳播，不再退出声场去队列页
  //（交互对齐 folia-major 的沉浸播放器面板）。队列数据由 app.js 在
  // renderQueue / 换曲时经 setQueue 推送，这里只渲染并回传意图。
  function setQueuePanel(on) {
    queueOpen = !!on;
    $('s3d-queue-panel').hidden = !on;
    $('s3d-queue').setAttribute('aria-expanded', String(on));
    if (on && !$('s3d-settings').hidden) setSettings(false);
    // 队列面板与歌单架是同一信息的两种形态，面板展开时把架子让出去。
    if (shelf) shelf.setBlocked(queueOpen || !$('s3d-settings').hidden);
    pokeChrome();
    if (on) {
      renderQueuePanel();
      var current = $('s3d-queue-list').querySelector('.s3d-queue-row.playing') || $('s3d-queue-close');
      if (current) current.focus({ preventScroll: true });
    }
  }

  function renderQueuePanel() {
    var list = $('s3d-queue-list');
    if (!list) return;
    text('s3d-queue-count', String(queueData.length));
    list.innerHTML = '';
    if (!queueData.length) {
      var empty = document.createElement('div');
      empty.className = 's3d-queue-empty';
      empty.textContent = '队列为空。在曲库或歌单里点一首喜欢的歌吧。';
      list.appendChild(empty);
      return;
    }
    for (var i = 0; i < queueData.length; i += 1) {
      var item = queueData[i];
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 's3d-queue-row' + (item.playing ? ' playing' : '');
      row.innerHTML =
        '<span class="s3d-queue-num"></span>' +
        '<span class="s3d-queue-main"><span class="s3d-queue-title"></span><span class="s3d-queue-sub"></span></span>' +
        '<span class="s3d-queue-dur"></span>';
      row.querySelector('.s3d-queue-num').textContent = String(i + 1);
      row.querySelector('.s3d-queue-title').textContent = item.title || '未知曲目';
      row.querySelector('.s3d-queue-sub').textContent = item.artist || '未知艺术家';
      row.querySelector('.s3d-queue-dur').textContent = item.duration ? fmt(item.duration) : '';
      (function (id) {
        row.addEventListener('click', function () { control('queue-play', id); });
      })(item.id);
      list.appendChild(row);
    }
    // 打开或换曲后把正在播放的行带回可视区。
    var playing = list.querySelector('.s3d-queue-row.playing');
    if (playing) list.scrollTop = Math.max(0, playing.offsetTop - list.clientHeight / 2);
  }

  function setQueue(list) {
    queueData = Array.isArray(list) ? list : [];
    if (queueOpen) renderQueuePanel();
    // 3D 歌单架消费同一份队列（含封面 URL），切歌交叉淡化与封面流由它自管。
    if (shelf) shelf.setItems(queueData);
  }

  function toggleLyrics() {
    showLyrics = !showLyrics;
    syncLayout();
    $('s3d-reading').hidden = foliaActive() ? true : !showLyrics;
    $('s3d-lyrics-toggle').setAttribute('aria-pressed', String(showLyrics));
    if (foliaActive() && folia.ready) applyFoliaConfig();
    pokeChrome();
    savePreferences();
  }

  // -------------------------------------------------------------------------
  // folia 平面布局：挂载、配置推送与动画驱动
  //
  // 帧循环只做动画驱动（driveFolia）；主题/字号/调参等配置在 syncLayout、
  // 8fps 元数据 gate（syncFoliaMeta）与控件回调里推（applyFoliaConfig），
  // 避免每帧 getComputedStyle/重排。
  // -------------------------------------------------------------------------

  // 当前播放曲目 id。presentation() 正常返回 {track:{id,...}}；同时兼容外层再
  // 包一层 {track:{track:{id}}} 的形态。无 Stage / 无曲目时为 null。
  function currentTrackId() {
    var pres = global.Stage && Stage.presentation ? Stage.presentation() : null;
    var t = pres && pres.track;
    if (!t) return null;
    return (t.track && t.track.id) || t.id || null;
  }

  function ensureFolia() {
    if (folia.ready) { applyFoliaConfig(); return; }
    var bgHost = $('s3d-fl-bg'), lyricHost = $('s3d-fl-lyric'), subHost = $('s3d-fl-sub');
    var sonnetHost = $('s3d-fl-sonnet-stage');
    if (!global.FoliaBg || !bgHost) return;
    folia.bg = global.FoliaBg.init(bgHost);
    folia.sub = global.FoliaSubtitle.init(subHost);
    folia.classic = global.FoliaClassic.init(lyricHost, function (ms) { control('seek', ms); });
    folia.cadenza = global.FoliaCadenza.init(lyricHost, function (ms) { control('seek', ms); });
    // 商籁独立占一层（全屏 Pixi 画布），不与 classic/cadenza 共用歌词宿主。
    if (global.FoliaSonnet && sonnetHost) {
      folia.sonnet = global.FoliaSonnet.init(sonnetHost, function (ms) { control('seek', ms); });
    }
    // 凝彩与商籁共用同一层宿主与同一份惰性 Pixi；同一时刻只有一个可见。
    // 凝彩不给 seek 回调：它的取景框只覆盖正在唱的那句，点击只会把播放打回
    // 句首（见 folia-tempera 的取景框注释），舞台点击应留给机位手势。
    if (global.FoliaTempera && global.FoliaSonnet && sonnetHost) {
      folia.tempera = global.FoliaTempera.init(sonnetHost);
    }
    folia.ready = true;
    bindFoliaControls();
    applyFoliaConfig();
  }

  function planeApi() {
    return folia.visual === 'classic' ? folia.classic
      : folia.visual === 'sonnet' ? folia.sonnet
      : folia.visual === 'tempera' && folia.tempera ? folia.tempera : folia.cadenza;
  }

  function sceneCovered() {
    return foliaActive() && (folia.bgMode === 'anime' || folia.bgMode === 'atmosphere');
  }

  function stageWallpapers() {
    return global.ThemeStudio && ThemeStudio.wallpapers ? ThemeStudio.wallpapers() : [];
  }

  function stageWallpaper(id) {
    var list = stageWallpapers();
    var selected = list.find(function (item) { return item.id === id; });
    return selected ? selected.id : (list.find(function (item) { return item.id === 'evening-16.jpg'; }) || list[0] || {}).id || '';
  }

  function syncStageBackdrop() {
    var backdrop = $('s3d-fl-backdrop'), picture = $('s3d-fl-wallpaper');
    var panel = $('s3d-fl-wallpapers'), gallery = $('s3d-fl-wallpaper-grid');
    var useImage = folia.bgMode === 'anime';
    if (backdrop) backdrop.hidden = !sceneCovered();
    if (panel) panel.hidden = !useImage;
    if (root) root.classList.toggle('s3d-scene-covered', sceneCovered());
    if (backdrop && backdrop.dataset.dim !== String(folia.wallpaperDim)) {
      backdrop.dataset.dim = String(folia.wallpaperDim);
      backdrop.style.setProperty('--fl-wallpaper-dim', String(folia.wallpaperDim));
    }
    if (picture && backdrop) {
      var selected = stageWallpaper(folia.wallpaper);
      if (useImage && picture.dataset.wallpaper !== selected) {
        folia.wallpaper = selected;
        picture.dataset.wallpaper = selected;
        picture.hidden = true;
        backdrop.dataset.image = 'loading';
        picture.onload = function () { backdrop.dataset.image = 'ready'; picture.hidden = folia.bgMode !== 'anime'; };
        picture.onerror = function () { backdrop.dataset.image = 'error'; picture.hidden = true; };
        if (selected) picture.src = '/wallpapers/' + encodeURIComponent(selected);
        else { picture.removeAttribute('src'); backdrop.dataset.image = 'error'; }
      } else picture.hidden = !useImage || backdrop.dataset.image !== 'ready';
    }
    if (gallery && !gallery.childElementCount) {
      stageWallpapers().forEach(function (item) {
        var button = document.createElement('button');
        button.type = 'button'; button.className = 's3d-wallpaper-choice'; button.dataset.wallpaper = item.id;
        button.setAttribute('aria-label', item.label); button.title = item.label;
        var thumbnail = document.createElement('img');
        thumbnail.alt = ''; thumbnail.loading = 'lazy'; thumbnail.src = '/wallpapers/' + encodeURIComponent(item.id);
        var caption = document.createElement('span'); caption.textContent = item.label;
        button.append(thumbnail, caption);
        button.addEventListener('click', function () { folia.wallpaper = item.id; applyFoliaConfig(); savePreferences(); });
        gallery.append(button);
      });
    }
    if (gallery) gallery.querySelectorAll('button').forEach(function (button) {
      var pressed = String(button.dataset.wallpaper === folia.wallpaper);
      if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    });
    var note = $('s3d-fl-wallpaper-note');
    if (note) {
      var message = backdrop && backdrop.dataset.image === 'error' ? '图片加载失败，已使用彩色氛围。可选择另一张图片。' : '仅用于歌词舞台，不改变主页背景。';
      if (note.textContent !== message) note.textContent = message;
    }
  }

  function applyFoliaConfig() {
    if (!folia.ready) return;
    var t = folia.visual === 'sonnet' && global.FoliaTheme.resolveSonnet ? global.FoliaTheme.resolveSonnet(reactivity) : global.FoliaTheme.resolve(reactivity);
    var sig = folia.visual + ':' + global.FoliaTheme.signature(t);
    if (sig !== folia.themeSig) {
      folia.themeSig = sig;
      folia.bg.setTheme(t); folia.sub.setTheme(t);
      folia.classic.setTheme(t); folia.cadenza.setTheme(t);
      if (folia.sonnet) folia.sonnet.setTheme(t);
      if (folia.tempera) folia.tempera.setTheme(t);
      // 商籁 HUD/角标文案的取色跟着主题 accent 走（canvas 内部另有自己的换算）。
      root.style.setProperty('--fl-sonnet-accent', t.accentColor);
      root.style.setProperty('--fl-scene-base', t.backgroundColor);
      root.style.setProperty('--fl-scene-accent', t.accentColor);
      root.style.setProperty('--fl-scene-secondary', t.secondaryColor);
      root.style.setProperty('--fl-scene-tertiary', t.tertiaryColor || t.accentColor);
    }
    var fs = clamp(num(lyricSize, 1), 0.7, 1.5);
    root.style.setProperty('--folia-fontscale', String(fs));
    [folia.classic, folia.cadenza, folia.sub].forEach(function (a) { a.setFontScale(fs); });
    if (folia.sonnet) folia.sonnet.setFontScale(fs);
    if (folia.tempera) folia.tempera.setFontScale(fs);
    folia.bg.setMode(sceneCovered() ? 'stage' : folia.bgMode);
    syncStageBackdrop();
    folia.bg.setOpacity(folia.bgOpacity);
    folia.bg.setVignette(folia.vignette);
    folia.sub.setVisible(folia.subtitle && showLyrics);
    folia.classic.setTuning(folia.classicTuning);
    folia.cadenza.setTuning(folia.cadenzaTuning);
    if (folia.sonnet) {
      folia.sonnet.setTuning(folia.sonnetTuning);
      // 舞台全局滑杆/开关对商籁的旁路：镜头动态→镜头强度，律动→演绎强度，
      // 背景样式决定 HUD 布景层显隐，暗角开关走光学后期渐晕。
      folia.sonnet.setMotion(motion);
      folia.sonnet.setReactivity(reactivity);
      folia.sonnet.setBgMode(folia.bgMode);
      folia.sonnet.setVignette(folia.vignette);
    }
    if (folia.tempera) {
      folia.tempera.setTuning(folia.temperaTuning);
      folia.tempera.setMotion(motion);
      folia.tempera.setReactivity(reactivity);
      folia.tempera.setBgMode(folia.bgMode);
      folia.tempera.setVignette(folia.vignette);
    }
    // 只有当前歌词视觉对应的渲染器可见，其余必须隐藏（classic/cadenza 共用
    // #s3d-fl-lyric；商籁启用时该宿主整体隐藏，独占 #s3d-fl-sonnet-stage 层）。
    folia.classic.setVisible(showLyrics && folia.visual === 'classic');
    folia.cadenza.setVisible(showLyrics && folia.visual === 'cadenza');
    var pixiVisual = folia.visual === 'sonnet' || folia.visual === 'tempera';
    if ($('s3d-fl-lyric')) $('s3d-fl-lyric').hidden = pixiVisual;
    if (folia.sonnet) folia.sonnet.setVisible(showLyrics && folia.visual === 'sonnet');
    if (folia.tempera) folia.tempera.setVisible(showLyrics && folia.visual === 'tempera');
    var data = global.Stage && Stage.presentation ? Stage.presentation() : null;
    folia.bg.setPaused(!data || !data.playing);
    [folia.classic, folia.cadenza].forEach(function (a) { a.setPaused(!data || !data.playing); });
    if (folia.sonnet) folia.sonnet.setPaused(!data || !data.playing);
    if (folia.tempera) folia.tempera.setPaused(!data || !data.playing);
    var eco = !!(global.Stage && Stage.tier && Stage.tier() === 0);
    folia.bg.setEco(eco);
    [folia.classic, folia.cadenza].forEach(function (a) { a.setEco(eco); });
    if (folia.sonnet) folia.sonnet.setEco(eco);
    if (folia.tempera) folia.tempera.setEco(eco);
  }

  function driveFolia(dtMs) {
    if (!folia.ready) return;
    // 配置只在 8fps 的 syncFoliaMeta/控件回调里推；帧循环只做动画驱动，避免每帧重建。
    folia.bg.frame(dtMs);
    if (showLyrics) { planeApi().frame(dtMs); }
  }

  function syncFoliaMeta() {
    if (!folia.ready || !foliaActive()) return;
    applyFoliaConfig();
    // 封面变化检测降到 8fps：presentation() 每帧比签名是纯空转。
    var data = global.Stage && Stage.presentation ? Stage.presentation() : null;
    if (data && data.cover !== folia.coverSig) {
      folia.coverSig = data.cover;
      // stage 背景模式（透 3D）不消费封面，仍记录签名避免重复判定。
      if (folia.bgMode === 'fluid') folia.bg.setCover(data.cover || null);
    }
    folia.sub.update();
    planeApi().update();
    var serverOff = global.Stage && Stage.lyricOffset ? Stage.lyricOffset() : 0;
    // 乐观值核销：服务端值追上 pending（PUT+refresh 完成）后回归服务端读数；
    // 未追上则继续显示 pending，不让 8fps 节拍把显示刷回旧值。
    // 核销只清 pendingOffset；pendingTrackId 保留为当前曲，作为切歌/失败判定基准。
    if (folia.pendingOffset != null && serverOff === folia.pendingOffset) {
      folia.pendingOffset = null;
    }
    var off = folia.pendingOffset != null ? folia.pendingOffset : serverOff;
    var ov = $('s3d-fl-off-value');
    if (ov) ov.textContent = (off > 0 ? '+' : '') + (off / 1000).toFixed(1) + 's';
    // 在线曲目没有偏移语义：两个 nudge 按钮置灰（nudge 源头也会再拦一次）。
    var offOnline = String(currentTrackId()).indexOf('online:') === 0;
    var offDown = $('s3d-fl-off-down'), offUp = $('s3d-fl-off-up');
    if (offDown) offDown.disabled = offOnline;
    if (offUp) offUp.disabled = offOnline;
  }

  // 浓度行只灰显 input 与其 label（二者是兄弟节点），不能压暗整个 #s3d-fl-common。
  function setOpacityRowEnabled(enabled) {
    var input = $('s3d-fl-opacity');
    var label = document.querySelector('label[for="s3d-fl-opacity"]');
    if (input) { input.disabled = !enabled; input.style.opacity = enabled ? '1' : '.4'; }
    if (label) label.style.opacity = enabled ? '1' : '.4';
  }

  function syncLayout() {
    root.dataset.layout = layout;
    root.dataset.stageTheme = stageTheme;
    root.style.setProperty('--sl-size', lyricSize);
    root.style.setProperty('--sl-glow', lyricGlow);
    $('s3d-layout').value = layout;
    var visualSel = $('s3d-lyric-visual');
    if (visualSel) visualSel.value = folia.visual;
    var themeSel = $('s3d-stage-theme');
    if (themeSel) themeSel.value = stageTheme;
    $('s3d-sleeve').hidden = layout !== 'sleeve';
    var fa = foliaActive();
    var standalone = isStandalone();
    if (lyricView) lyricView.configure(showLyrics && !fa);
    // s3d-folia：folia 歌词叠加层激活（无论是否有 GL）；s3d-plane：仅无 GL 纯平面回退
    // （该类负责隐藏 3D 画布与禁用手势）。叠加时 3D 场景照常渲染、相机照常工作。
    root.classList.toggle('s3d-folia', fa);
    root.classList.toggle('s3d-plane', standalone);
    $('s3d-folia').hidden = !fa;
    $('s3d-reading').hidden = fa ? true : !showLyrics;
    $('s3d-fl-common').hidden = !fa;
    $('s3d-fl-classic').hidden = folia.visual !== 'classic';
    $('s3d-fl-cadenza').hidden = folia.visual !== 'cadenza';
    var sonnetPanel = $('s3d-fl-sonnet');
    if (sonnetPanel) sonnetPanel.hidden = folia.visual !== 'sonnet';
    var temperaPanel = $('s3d-fl-tempera');
    if (temperaPanel) temperaPanel.hidden = folia.visual !== 'tempera';
    syncTemperaControls();
    setOpacityRowEnabled(folia.bgMode === 'fluid');
    syncStageBackdrop();
    // 镜头动态只在无 GL 纯平面回退时失效；folia 透明叠加时它仍驱动 3D 相机。
    var motionInput = $('s3d-motion');
    if (motionInput) {
      motionInput.disabled = standalone;
      var ml = document.querySelector('label[for="s3d-motion"]');
      if (ml) ml.style.opacity = standalone ? '.5' : '1';
    }
    // init/configure 时 active=false 不预建 folia；舞台打开后 open() 会再跑一次
    // syncLayout，届时才创建实例。
    if (fa && active) ensureFolia();
    else if (!fa) {
      if (folia.ready) {
        folia.classic.setVisible(false); folia.cadenza.setVisible(false);
        if (folia.sonnet) folia.sonnet.setVisible(false);
        if (folia.tempera) folia.tempera.setVisible(false);
      }
      // 回到舞台歌词轨：GL 已挂掉时把降级提示还给用户。
      if (glFailed) showFallback('当前设备暂不支持三维渲染，仍可播放音乐或返回曲库。');
      else if (contextLost) showFallback('舞台正在恢复渲染，音乐播放不受影响。');
    }
  }

  function toggleLayout() {
    layout = layout === 'sleeve' ? 'focus' : 'sleeve';
    syncLayout(); savePreferences(); pokeChrome();
  }

  function paintWords() {
    if (lyricView && showLyrics) lyricView.paint(Stage.position());
  }

  // Consume the same clock, metadata and lyric document as the ordinary player.
  // A separate low-frequency gate updates DOM even when WebGL is unavailable.
  function syncSeek(data) {
    var range = $('s3d-seek');
    if (!range || !data) return;
    if (seeking && seekTrackId !== currentTrackId()) {
      seeking = false;
      seekTrackId = null;
      seekCancelled = true;
    }
    if (seeking) return;
    range.max = Math.max(1, data.duration);
    range.value = Math.min(data.duration, data.position);
    range.disabled = !(data.duration > 0);
    range.setAttribute('aria-valuetext', fmt(data.position) + ' / ' + fmt(data.duration));
    range.style.setProperty('--s3d-progress', (data.duration > 0 ? Math.min(100, data.position / data.duration * 100) : 0) + '%');
    text('s3d-elapsed', fmt(data.position));
  }

  function cancelSeek() {
    seeking = false;
    seekTrackId = null;
    seekCancelled = true;
    if (global.Stage && Stage.presentation) syncSeek(Stage.presentation());
  }

  function beginSeek(e) {
    if (!active || document.hidden || this.disabled) return;
    if (e.type === 'pointerdown' && e.button !== 0) return;
    if (e.type === 'keydown' && !/^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(e.key)) return;
    seekCancelled = false;
    seekTrackId = currentTrackId();
    seeking = false;
  }

  function previewSeek() {
    if (!active || document.hidden || seekCancelled || (seekTrackId !== null && seekTrackId !== currentTrackId())) { cancelSeek(); return; }
    if (!seeking) seekTrackId = currentTrackId();
    seeking = true;
    text('s3d-elapsed', fmt(Number(this.value)));
  }

  function commitSeek() {
    if (!seeking || seekCancelled || !active || document.hidden || document.activeElement !== this || seekTrackId !== currentTrackId()) { cancelSeek(); return; }
    var position = Number(this.value);
    seeking = false;
    seekTrackId = null;
    seekCancelled = true;
    control('seek', position);
  }

  function onVolumeInput() {
    if (!active || document.hidden) { endVolumeChange(); return; }
    changingVolume = true;
    control('volume', Number(this.value) / 100);
  }

  function endVolumeChange() {
    changingVolume = false;
  }

  function syncNowPlaying() {
    if (!root || !global.Stage || !Stage.presentation) return;
    var data = Stage.presentation(), track = data.track;
    // 曲目切换隔离：此 gate 无论是否平面布局都以 8fps 运行。当前曲与乐观暂存
    // 归属不一致（含 null↔id：停播、首次建立基准）时，作废在途偏移，避免 A 曲
    // 的迟到 PUT/refresh 污染 B 曲显示。首次只建立基准，pendingOffset 本就是 null。
    var curTid = currentTrackId();
    if (curTid !== folia.pendingTrackId) {
      folia.pendingOffset = null;
      folia.pendingTrackId = curTid;
    }
    text('s3d-title', track ? track.title || '未知曲目' : '还没有播放音乐');
    text('s3d-artist', track ? track.artist || '未知艺术家' : '从曲库选择一首喜欢的歌');
    text('s3d-hint', ('0' + (stageIndex + 1)).slice(-2) + ' / ' + STAGES[stageIndex].label);
    syncSeek(data);
    text('s3d-duration', fmt(data.duration));
    text('s3d-status', track ? (data.playing ? '正在聆听' : '已暂停') : '让音乐，拥有形状');
    text('s3d-motion-note', data.reduced ? '已遵循减少动态效果设置' : '设置即时生效');
    root.classList.toggle('s3d-playing', data.playing);
    root.classList.toggle('s3d-reduced', data.reduced);
    if (foliaActive()) syncFoliaMeta();
    $('s3d-play').setAttribute('aria-label', !track ? '选择音乐' : data.playing ? '暂停' : '播放');
    $('s3d-play-icon').setAttribute('href', data.playing ? '#i-pause' : '#i-play');
    $('s3d-prev').disabled = $('s3d-next').disabled = !track;
    if (!changingVolume) $('s3d-volume').value = Math.round(data.volume * 100);
    var cover = $('s3d-cover');
    if (lastCover !== data.cover) {
      lastCover = data.cover;
      cover.hidden = !data.cover;
      if (data.cover) cover.src = data.cover;
      else cover.removeAttribute('src');
    }
    var sleeve = $('s3d-sleeve-image');
    if (sleeve.dataset.url !== (data.cover || '')) {
      sleeve.dataset.url = data.cover || ''; sleeve.hidden = !data.cover;
      if (data.cover) sleeve.src = data.cover; else sleeve.removeAttribute('src');
    }
    text('s3d-sleeve-title', track ? track.title || '未知曲目' : '你的下一张唱片');
    text('s3d-sleeve-artist', track ? track.artist || '未知艺术家' : '从曲库开始聆听');
    // 平面布局由 folia 渲染器接管歌词，GL lyricView 空转 update 没有意义。
    if (lyricView && showLyrics && !foliaActive()) lyricView.update(data);
  }

  function syncDock() {
    var btns = root ? root.querySelectorAll('.s3d-dock-btn') : [];
    for (var i = 0; i < btns.length; i += 1) {
      var on = Number(btns[i].getAttribute('data-stage')) === stageIndex;
      btns[i].classList.toggle('active', on);
      btns[i].setAttribute('aria-pressed', String(on));
    }
  }

  function buildDock() {
    var dock = $('s3d-dock');
    if (!dock || dock.childNodes.length) return;
    STAGES.forEach(function (s, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 's3d-dock-btn';
      b.setAttribute('data-stage', String(i));
      b.setAttribute('aria-pressed', 'false');
      b.title = s.label + ' · ' + s.desc;
      b.innerHTML =
        '<svg class="s3d-dock-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        (ICONS[s.id] || '') + '</svg><span class="s3d-dock-tx"></span>';
      b.querySelector('.s3d-dock-tx').textContent = s.label;
      b.addEventListener('click', function () { setStage(i, false); });
      dock.appendChild(b);
    });
    syncDock();
  }

  // -------------------------------------------------------------------------
  // 开合
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 帧停摆看门狗
  //
  // 逐帧驱动走 Stage.gate 的主循环（全项目唯一的 rAF），但宿主环境可能把
  // rAF 整个挂起：Electron 内嵌视图被判定遮挡、全屏切换重建合成器、系统
  // 省电节流，都会出现「页面 visible、上下文健在、画面却永远静止」。主循环
  // 的 schedule() 依赖 rAF 回调，挂起后 kick 也叫不醒。看门狗每 1.2s 检查
  // 一次场景时间：连续三次没有推进就先 kick 一次，仍无帧则由这里低频代跑
  // （约 1fps），只推进 time 与 render，不碰 perf 统计，避免拉低帧率档位。
  // rAF 恢复后 time 自然开始前进，看门狗自动退回静默。
  // -------------------------------------------------------------------------

  var wdTimer = 0, wdLastT = -1, wdStalls = 0;

  function watchdog() {
    if (!active || !gl || contextLost || document.hidden) { wdStalls = 0; return; }
    if (time !== wdLastT) { wdLastT = time; wdStalls = 0; return; }
    wdStalls += 1;
    if (global.Stage && Stage.kick) Stage.kick();
    if (wdStalls >= 3 && !reducedMotion()) {
      time += 0.016;
      wdLastT = time;
      render(16);
      if (showLyrics) writeLyrTilt();
    }
  }

  function open(stageId) {
    if (!root) return false;
    if (!active) {
      if (global.StageFreecam) StageFreecam.setEnabled(false);
      returnFocus = document.activeElement;
      backgroundNodes = [];
      Array.prototype.forEach.call(document.body.children, function (node) {
        if (node === root || /^(SCRIPT|STYLE|SVG)$/.test(node.tagName)) return;
        backgroundNodes.push({ node: node, inert: node.inert }); node.inert = true;
      });
    }
    if (stageId != null) {
      for (var i = 0; i < STAGES.length; i += 1) {
        if (STAGES[i].id === stageId) { stageIndex = i; break; }
      }
    }
    active = true;
    fadeTarget = 1;
    root.classList.add('s3d-open');
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('s3d-open');
    root.setAttribute('data-scene', STAGES[stageIndex].id);
    root.focus({ preventScroll: true });
    pendingDt = 0;
    if (!wdTimer) wdTimer = setInterval(watchdog, 1200);
    var fb = $('s3d-fallback');
    if (fb) fb.hidden = true;

    syncDock(); syncNowPlaying(); pokeChrome();
    if (global.Stage && Stage.kick) Stage.kick();
    var hasGl = ensureGl();
    // 无 GL 时只有 folia 歌词视觉可以纯平面回退放行；舞台歌词/封面/单句都需要三维渲染。
    if (!hasGl && !foliaActive()) { showFallback('当前设备暂不支持三维渲染，仍可播放音乐或返回曲库。'); return false; }
    if (!hasGl) { var fbNoGl = $('s3d-fallback'); if (fbNoGl) fbNoGl.hidden = true; }
    sizeDirty = true;
    resize();
    applyStageCamera(STAGES[stageIndex], true);
    resetLyrTilt();
    fade = 0;
    startTransition();
    syncDock();
    // active 已置位：若恢复的布局是平面，这里才真正创建 folia 实例。
    syncLayout();
    syncNowPlaying();
    if (shelf) { shelf.setItems(queueData); shelf.setBlocked(false); shelf.show(); }
    syncFsUi();
    pokeChrome();
    if (global.Stage && Stage.kick) Stage.kick();
    return true;
  }

  function close() {
    if (!root || !active) return;
    if (global.Workshop && Workshop.isOpen()) Workshop.close();
    if (lyricView) lyricView.reset();
    fadeTarget = 0;
    active = false;
    root.classList.remove('s3d-open');
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('s3d-open');
    backgroundNodes.forEach(function (entry) { entry.node.inert = entry.inert; });
    backgroundNodes = [];
    if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
    if (chromeTimer) clearTimeout(chromeTimer);
    $('s3d-settings').hidden = true;
    $('s3d-settings-toggle').setAttribute('aria-expanded', 'false');
    queueOpen = false;
    $('s3d-queue-panel').hidden = true;
    $('s3d-queue').setAttribute('aria-expanded', 'false');
    if (shelf) shelf.hide();
    cancelGestures();
    seeking = false;
    root.classList.remove('s3d-dragging');
    if (wdTimer) { clearInterval(wdTimer); wdTimer = 0; }
    wdLastT = -1; wdStalls = 0;
    if (fsEl()) exitFs();
    if (global.Stage && Stage.kick) Stage.kick();
    // 等淡出走完再真的停手：直接归零会看到画面硬切。
    setTimeout(function () {
      if (active) return;
      document.body.classList.remove('s3d-open');
    }, 320);
  }

  function isActive() { return active; }

  // -------------------------------------------------------------------------
  // 色调：跟着主题走
  // -------------------------------------------------------------------------

  function readTint() {
    var cs = window.getComputedStyle(document.documentElement);
    tint = parseColor(cs.getPropertyValue('--accent'), [1, 1, 1]);
    tint2 = parseColor(cs.getPropertyValue('--accent-2'), [0, 0.96, 0.83]);
    tint3 = parseColor(cs.getPropertyValue('--music-highlight') ||
      cs.getPropertyValue('--accent-2'), [0.96, 0.82, 0.54]);
    // 换肤后强制 folia 主题重算（签名缓存在下一次 applyFoliaConfig 失效）。
    folia.themeSig = '';
  }

  // -------------------------------------------------------------------------
  // 键盘
  // -------------------------------------------------------------------------

  function isTyping(t) {
    var tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
      !!(t && t.isContentEditable);
  }

  // 用捕获阶段注册：document 上的冒泡监听器按脚本顺序触发，而 stage-immersive
  // 的 F 键是全局的。三维舞台开着时它必须先吃掉，否则一次 F 会同时切两层全屏。
  //
  // 这一层只管「已经开着」的按键；V 的开启分支在 bindUi 的全局监听里，
  // 两者用 active 严格分工，同一个键不会有两个写者。
  function onKeyDown(e) {
    if (!active) return;
    pokeChrome();
    if (global.Workshop && Workshop.isOpen()) return;
    var k = e.key;
    if (k === 'Tab') {
      var focusable = Array.prototype.filter.call(root.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)'), function (el) { return el.tabIndex >= 0 && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'; });
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === root)) { e.preventDefault(); first.focus(); }
      return;
    }
    if (k === 'Escape') {
      if (!$('s3d-settings').hidden) { setSettings(false); $('s3d-settings-toggle').focus(); e.stopImmediatePropagation(); return; }
      if (queueOpen) { setQueuePanel(false); $('s3d-queue').focus(); e.stopImmediatePropagation(); return; }
      if (fsEl()) { exitFs(); e.stopImmediatePropagation(); return; }
      close();
      e.stopImmediatePropagation();
      return;
    }
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.repeat && /^(v|f|c|l)$/i.test(k)) { e.stopImmediatePropagation(); return; }
    if (k === ' ' && e.target.tagName === 'BUTTON') { e.stopImmediatePropagation(); return; }
    if (k === ' ' && e.target.tagName !== 'BUTTON') { e.preventDefault(); play(); e.stopImmediatePropagation(); return; }
    if (k === 'b' || k === 'B') { toggleLayout(); e.stopImmediatePropagation(); return; }
    if (k === 'l' || k === 'L') { toggleLyrics(); e.stopImmediatePropagation(); return; }
    if (k === 'q' || k === 'Q') { setQueuePanel($('s3d-queue-panel').hidden); e.stopImmediatePropagation(); return; }
    if (k === 'f' || k === 'F') {
      toggleFullscreen();
      e.stopImmediatePropagation();
      return;
    }
    // V 与入口按钮同义：开着时收掉这一层，形成开合闭环。
    if (k === 'v' || k === 'V') { close(); e.stopImmediatePropagation(); return; }
    if (k === 'k' || k === 'K') { if (!isStandalone()) resetView(); e.stopImmediatePropagation(); return; }
    if (k === 'c' || k === 'C') {
      cam.cruise = !cam.cruise;
      var cb = $('s3d-cruise');
      if (cb) cb.setAttribute('aria-pressed', String(cam.cruise));
      savePreferences();
      e.stopImmediatePropagation();
      return;
    }
    if (k === '[') { cycleStage(-1); e.stopImmediatePropagation(); return; }
    if (k === ']') { cycleStage(1); e.stopImmediatePropagation(); return; }
    if (k >= '1' && k <= '9') {
      var i = Number(k) - 1;
      if (i < STAGES.length) { setStage(i, false); e.stopImmediatePropagation(); }
    }
  }

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------

  // folia 设置面板控件：首次进入平面布局（ensureFolia）时绑定一次。
  function bindFoliaControls() {
    // saveOn === 'change'：拖动过程 input 只即时应用（applyFoliaConfig），
    // 松手触发 change 才 savePreferences 发 PUT，与 motion/bloom/reactivity 一致。
    function range(id, fn, fmt, saveOn) {
      var el = $(id), out = $(id + '-value');
      if (!el || el._bound) return;
      el._bound = true;
      var when = saveOn || 'input';
      el.addEventListener('input', function () {
        fn(Number(el.value));
        if (out) out.textContent = fmt ? fmt(Number(el.value)) : el.value;
        applyFoliaConfig();
        if (when !== 'change') savePreferences();
      });
      if (when === 'change') el.addEventListener('change', savePreferences);
    }
    function check(id, fn) {
      var el = $(id);
      if (!el || el._bound) return;
      el._bound = true;
      el.addEventListener('change', function () { fn(el.checked); applyFoliaConfig(); savePreferences(); });
    }
    range('s3d-fl-size', function (v) { lyricSize = v; }, function (v) { return Math.round(v * 100) + '%'; }, 'change');
    var bgSel = $('s3d-fl-bg-mode');
    if (bgSel && !bgSel._bound) { bgSel._bound = true; bgSel.value = folia.bgMode;
      bgSel.addEventListener('change', function () {
        folia.bgMode = bgSel.value;
        setOpacityRowEnabled(folia.bgMode === 'fluid');
        applyFoliaConfig();
        // stage 模式不缓存封面，切到 fluid 时立刻补喂当前封面。
        if (folia.bgMode === 'fluid' && global.Stage && Stage.presentation) {
          var cov = Stage.presentation().cover;
          folia.coverSig = cov;
          folia.bg.setCover(cov || null);
        }
        savePreferences();
      }); }
    range('s3d-fl-opacity', function (v) { folia.bgOpacity = v; }, function (v) { return Math.round(v * 100) + '%'; }, 'change');
    range('s3d-fl-wallpaper-dim', function (v) { folia.wallpaperDim = clamp(v, 0.2, 0.8); }, function (v) { return Math.round(v * 100) + '%'; }, 'change');
    check('s3d-fl-vignette', function (b) { folia.vignette = b; });
    check('s3d-fl-subtitle', function (b) { folia.subtitle = b; });
    check('s3d-fl-rotation', function (b) { folia.classicTuning.rotation = b; });
    range('s3d-fl-breathing', function (v) { folia.classicTuning.breathing = v; }, function (v) { return v.toFixed(2) + 'x'; }, 'change');
    range('s3d-fl-spacing', function (v) { folia.classicTuning.spacing = v; }, function (v) { return v.toFixed(2) + 'x'; }, 'change');
    range('s3d-fl-width', function (v) { folia.cadenzaTuning.width = v; }, function (v) { return Math.round(v * 100) + '%'; }, 'change');
    range('s3d-fl-motion', function (v) { folia.cadenzaTuning.motion = v; }, function (v) { return v.toFixed(2) + 'x'; }, 'change');
    range('s3d-fl-glow', function (v) { folia.cadenzaTuning.glow = v; }, function (v) { return v.toFixed(2) + 'x'; }, 'change');
    range('s3d-fl-beam', function (v) { folia.cadenzaTuning.beam = v; }, function (v) { return v.toFixed(2) + 'x'; }, 'change');
    // 商籁：镜头调度/排布为下拉，词组长度为滑杆，装饰与重音为开关。
    function select(id, fn) {
      var el = $(id);
      if (!el || el._bound) return;
      el._bound = true;
      el.addEventListener('change', function () { fn(el.value); applyFoliaConfig(); savePreferences(); });
    }
    select('s3d-fl-shot', function (v) { folia.sonnetTuning.shotFlow = v; });
    select('s3d-fl-track-layout', function (v) { folia.sonnetTuning.lyricLayout = v; });
    range('s3d-fl-phrase', function (v) { folia.sonnetTuning.phraseLength = Math.round(v); },
      function (v) { return String(Math.round(v)); }, 'change');
    check('s3d-fl-decor', function (b) { folia.sonnetTuning.decor = b; });
    check('s3d-fl-accents', function (b) { folia.sonnetTuning.accents = b; });
    select('s3d-fl-composition', function (value) { folia.temperaTuning.composition = value; });
    select('s3d-fl-color-mode', function (value) { folia.temperaTuning.colorMode = value; });
    check('s3d-fl-screens', function (value) { folia.temperaTuning.screens = value; });
    check('s3d-fl-inversion', function (value) { folia.temperaTuning.inversion = value; });
    var down = $('s3d-fl-off-down'), up = $('s3d-fl-off-up');
    function nudge(d) {
      if (!global.Stage || !Stage.lyricOffset) return;
      var tid = currentTrackId();
      // 无当前曲：不写乐观态、不派发控制。
      if (!tid) return;
      // 在线曲目没有偏移语义：源头直接拦截，不写乐观暂存、不派发控制。
      if (String(tid).indexOf('online:') === 0) return;
      // 基于乐观暂存递增：落库+refresh 完成前 Stage.lyricOffset() 仍是旧值，
      // 直接读它连点会塌缩成一步。
      var base = (folia.pendingOffset == null) ? Stage.lyricOffset() : folia.pendingOffset;
      var next = Math.max(-60000, Math.min(60000, base + d));
      // pendingOffset 与归属曲目成对记录，供切歌隔离与 PUT 失败回清判定。
      folia.pendingOffset = next;
      folia.pendingTrackId = tid;
      control('lyricOffset', next);
      var ov = $('s3d-fl-off-value');
      if (ov) ov.textContent = (next > 0 ? '+' : '') + (next / 1000).toFixed(1) + 's';
    }
    if (down && !down._bound) { down._bound = true; down.addEventListener('click', function () { nudge(-100); }); }
    if (up && !up._bound) { up._bound = true; up.addEventListener('click', function () { nudge(100); }); }
    // PUT 失败回清：app.js 落库失败时派发 folia:offset-failed。只注册一次
    // （bindFoliaControls 理论上仅首调，folia 级标志兜底 destroy 后重建场景）；
    // 仅当失败的仍是 pending 归属曲目时回清，已切歌则忽略，避免误清新曲状态。
    if (!folia.offsetFailBound) {
      folia.offsetFailBound = true;
      document.addEventListener('folia:offset-failed', function (e) {
        var fid = e.detail && e.detail.id;
        if (folia.ready && fid === folia.pendingTrackId) {
          folia.pendingOffset = null;
          syncFoliaMeta();
        }
      });
    }
    // 从 folia 状态回填全部控件并刷新 output 文本。bindFoliaControls 只在首次
    // 进平面时绑一次，而 configure 在此之前已把偏好读进 folia 状态，故刷新恢复也覆盖。
    function syncFoliaControls() {
      var bgMode = $('s3d-fl-bg-mode');
      if (bgMode) bgMode.value = folia.bgMode;
      var op = $('s3d-fl-opacity');
      if (op) op.value = String(folia.bgOpacity);
      var opOut = $('s3d-fl-opacity-value');
      if (opOut) opOut.textContent = Math.round(folia.bgOpacity * 100) + '%';
      var wallDim = $('s3d-fl-wallpaper-dim'); if (wallDim) wallDim.value = String(folia.wallpaperDim);
      text('s3d-fl-wallpaper-dim-value', Math.round(folia.wallpaperDim * 100) + '%');
      syncStageBackdrop();
      setOpacityRowEnabled(folia.bgMode === 'fluid');
      var vg = $('s3d-fl-vignette'); if (vg) vg.checked = folia.vignette;
      var st = $('s3d-fl-subtitle'); if (st) st.checked = folia.subtitle;
      var rot = $('s3d-fl-rotation'); if (rot) rot.checked = folia.classicTuning.rotation;
      function fillRange(id, v, fmt) {
        var el = $(id), out = $(id + '-value');
        if (el) el.value = String(v);
        if (out) out.textContent = fmt(v);
      }
      var mult = function (v) { return v.toFixed(2) + 'x'; };
      fillRange('s3d-fl-breathing', folia.classicTuning.breathing, mult);
      fillRange('s3d-fl-spacing', folia.classicTuning.spacing, mult);
      fillRange('s3d-fl-width', folia.cadenzaTuning.width, function (v) { return Math.round(v * 100) + '%'; });
      fillRange('s3d-fl-motion', folia.cadenzaTuning.motion, mult);
      fillRange('s3d-fl-glow', folia.cadenzaTuning.glow, mult);
      fillRange('s3d-fl-beam', folia.cadenzaTuning.beam, mult);
      var shot = $('s3d-fl-shot'); if (shot) shot.value = folia.sonnetTuning.shotFlow;
      var tlay = $('s3d-fl-track-layout'); if (tlay) tlay.value = folia.sonnetTuning.lyricLayout;
      fillRange('s3d-fl-phrase', folia.sonnetTuning.phraseLength, function (v) { return String(Math.round(v)); });
      var decor = $('s3d-fl-decor'); if (decor) decor.checked = folia.sonnetTuning.decor;
      var accents = $('s3d-fl-accents'); if (accents) accents.checked = folia.sonnetTuning.accents;
      syncTemperaControls();
      var sizeEl = $('s3d-fl-size'); if (sizeEl) sizeEl.value = String(lyricSize);
      var sizeOut = $('s3d-fl-size-value'); if (sizeOut) sizeOut.textContent = Math.round(lyricSize * 100) + '%';
    }
    syncFoliaControls();
  }

  // 歌词视觉独立切换（舞台 3D 歌词轨 / 流光 / 心象 / 商籁）：与布局正交，
  // 选 classic/cadenza/sonnet 时 folia 叠加到 3D 场景之上（无 GL 则纯平面回退）。
  function bindLyricVisual() {
    var sel = $('s3d-lyric-visual');
    if (!sel || sel._bound) return;
    sel._bound = true;
    sel.value = folia.visual;
    sel.addEventListener('change', function () {
      var v = sel.value;
      folia.visual = FOLIA_VISUALS.indexOf(v) >= 0 ? v : 'stage';
      syncLayout();
      if (folia.ready) applyFoliaConfig();
      savePreferences();
    });
  }

  function syncTemperaControls() {
    var composition = $('s3d-fl-composition');
    if (composition) composition.value = folia.temperaTuning.composition;
    var colorMode = $('s3d-fl-color-mode');
    if (colorMode) colorMode.value = folia.temperaTuning.colorMode;
    var screens = $('s3d-fl-screens');
    if (screens) screens.checked = folia.temperaTuning.screens;
    var inversion = $('s3d-fl-inversion');
    if (inversion) inversion.checked = folia.temperaTuning.inversion;
  }

  // 舞台主题与皮肤正交：换主题只改 #stage3d 上的 data-stage-theme，
  // 不碰 Skins，也不影响应用布局。
  function bindStageTheme() {
    var sel = $('s3d-stage-theme');
    if (!sel || sel._bound) return;
    sel._bound = true;
    sel.value = stageTheme;
    sel.addEventListener('change', function () {
      stageTheme = sel.value === 'starfall' ? 'starfall' : 'classic';
      syncLayout();
      savePreferences();
    });
  }

  function bindUi() {
    bindLyricVisual();
    bindStageTheme();
    $('s3d-lyrics-toggle').addEventListener('click', toggleLyrics);
    $('s3d-settings-toggle').addEventListener('click', function () { setSettings($('s3d-settings').hidden); });
    $('s3d-settings-close').addEventListener('click', function () { setSettings(false); $('s3d-settings-toggle').focus(); });
    $('s3d-motion').addEventListener('input', function () {
      motion = Number(this.value) / 100; text('s3d-motion-value', this.value + '%');
      // 商籁的镜头强度直接吃这根滑杆：拖动即时推送，不等 8fps gate。
      if (folia.sonnet) folia.sonnet.setMotion(motion);
      if (folia.tempera) folia.tempera.setMotion(motion);
    });
    $('s3d-bloom').addEventListener('input', function () { bloom = Number(this.value) / 100; text('s3d-bloom-value', this.value + '%'); });
    $('s3d-reactivity').addEventListener('input', function () { reactivity = Number(this.value) / 100; text('s3d-reactivity-value', this.value + '%'); });
    $('s3d-reactivity').addEventListener('change', savePreferences);
    $('s3d-motion').addEventListener('change', savePreferences);
    $('s3d-bloom').addEventListener('change', savePreferences);
    $('s3d-play').addEventListener('click', play);
    $('s3d-prev').addEventListener('click', function () { control('prev'); });
    $('s3d-next').addEventListener('click', function () { control('next'); });
    $('s3d-queue').addEventListener('click', function () { setQueuePanel($('s3d-queue-panel').hidden); });
    $('s3d-queue-close').addEventListener('click', function () { setQueuePanel(false); $('s3d-queue').focus(); });
    $('s3d-cover').addEventListener('error', function () { this.hidden = true; });
    $('s3d-seek').addEventListener('pointerdown', beginSeek);
    $('s3d-seek').addEventListener('keydown', beginSeek);
    $('s3d-seek').addEventListener('input', previewSeek);
    $('s3d-seek').addEventListener('change', commitSeek);
    $('s3d-seek').addEventListener('pointercancel', cancelSeek);
    $('s3d-seek').addEventListener('blur', cancelSeek);
    $('s3d-volume').addEventListener('input', onVolumeInput);
    $('s3d-volume').addEventListener('change', endVolumeChange);
    $('s3d-volume').addEventListener('pointercancel', endVolumeChange);
    $('s3d-volume').addEventListener('blur', endVolumeChange);
    $('s3d-cover-toggle').addEventListener('click', toggleLayout);
    $('s3d-sleeve-image').addEventListener('error', function () { this.hidden = true; });
    $('s3d-layout').addEventListener('change', function () { layout = this.value; syncLayout(); savePreferences(); });
    $('s3d-shelf-mode').addEventListener('change', function () {
      shelfMode = this.value === 'off' || this.value === 'side' ? this.value : 'stage';
      if (shelf) shelf.setMode(shelfMode);
      savePreferences();
    });
    $('s3d-workshop').addEventListener('click', function () { setSettings(false); if (global.Workshop) Workshop.open(); });
    root.addEventListener('focusin', pokeChrome);
    root.addEventListener('focusout', pokeChrome);
    var fsb = $('s3d-fs');
    if (fsb) fsb.addEventListener('click', toggleFullscreen);
    var rb = $('s3d-reset');
    if (rb) rb.addEventListener('click', resetView);
    var cb = $('s3d-cruise');
    if (cb) {
      cb.setAttribute('aria-pressed', String(cam.cruise));
      cb.addEventListener('click', function () {
        cam.cruise = !cam.cruise;
        cb.setAttribute('aria-pressed', String(cam.cruise));
        savePreferences();
      });
    }
    var xb = $('s3d-close');
    if (xb) xb.addEventListener('click', close);

    document.addEventListener('fullscreenchange', syncFsUi);
    document.addEventListener('webkitfullscreenchange', syncFsUi);

    // 统一入口效果：任何地方进沉浸声场都是「开启 + 申请原生全屏」，不再有
    // 「有的全屏有的不全屏、有的落极光有的落当前舞台」的差别。原生全屏被
    // 拒绝（无手势/权限）时留在页内全屏层，不影响其余功能。
    function enterFromUi() {
      if (!open()) return;
      requestFs();
    }
    var openers = ['stage3d-entry'];
    openers.forEach(function (id) {
      var b = $(id);
      if (b) b.addEventListener('click', enterFromUi);
    });

    wrapEl.addEventListener('pointerdown', onPointerDown);
    wrapEl.addEventListener('pointermove', onPointerMove, { passive: true });
    $('s3d-sleeve').addEventListener('pointermove', onPointerMove, { passive: true });
    wrapEl.addEventListener('pointerup', onPointerUp);
    wrapEl.addEventListener('pointercancel', onPointerUp);
    wrapEl.addEventListener('lostpointercapture', onPointerUp);
    window.addEventListener('blur', cancelGestures);
    wrapEl.addEventListener('pointerleave', function () { pointerField.active = 0; });
    wrapEl.addEventListener('wheel', onWheel, { passive: false });
    wrapEl.addEventListener('dblclick', function () { if (!isStandalone()) resetView(); });
    bindLyrTilt();
    // 驾驶舱改了 --lp-3d 开关后要重读（与 stage.js 的 readTilt 同一事件源）。
    document.addEventListener('stagecontrol:change', readLyrTilt);
    // 捕获阶段挂 window：舞台之上若还有浮层接管命中（弹窗/提示/歌词热区），
    // 冒泡到不了 root，chrome 会永远唤不醒；捕获阶段无论命中谁都先经过这里。
    // pokeChrome 自身按 active 收口，舞台关着时是空转。
    window.addEventListener('pointermove', pokeChrome, { passive: true, capture: true });
    window.addEventListener('pointerdown', pokeChrome, { passive: true, capture: true });

    document.addEventListener('keydown', onKeyDown, true);

    // V 的开启分支：与所有入口按钮同一效果（开启 + 原生全屏）。
    // 开着的时候由 onKeyDown 收口关闭，形成开合闭环。
    document.addEventListener('keydown', function (e) {
      if (active) return;
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'v' && e.key !== 'V') return;
      e.preventDefault();
      enterFromUi();
    });

    // 换肤后重取色调：主题改的是 --accent / --music-highlight，
    // 着色器里的色调是从这里读的。
    document.addEventListener('stage:retint', readTint);
  }

  function init() {
    if (inited) return api;
    root = $('stage3d');
    if (!root) return null;
    wrapEl = $('s3d-canvas-wrap');
    if (!wrapEl) return null;
    inited = true;

    if (global.StageLyrics) lyricView = StageLyrics.init($('s3d-reading'), function (ms) { control('seek', ms); });
    // 3D 歌单架：与舞台同生命周期，gate 自注册；不存在（脚本加载失败）时静默降级。
    if (global.StageShelf && !shelf) {
      shelf = StageShelf.init(root);
      if (shelf) shelf.setMode(shelfMode);
    }
    syncLayout();
    readTint();
    buildDock();
    if (!uiBound) { bindUi(); uiBound = true; }

    // 帧门登记。返回 0 时主循环会把自己停掉，不需要帧的时候不烧 CPU。
    if (global.Stage && Stage.gate) Stage.gate(GATE, targetFps, tick);
    if (global.Stage && Stage.gate) Stage.gate('stage3d-ui', function () { return active && !document.hidden ? 8 : 0; }, syncNowPlaying);
    // 播放态跳变沿（暂停/起播/曲尾停止）立刻刷一次，不等 8fps 门控。
    document.addEventListener('stage:playing-changed', function () { if (active && !document.hidden) syncNowPlaying(); });

    // 窗口尺寸与 DPR 不是同步生效的：全屏切换 / 跨屏拖动时 devicePixelRatio
    // 要晚一拍才更新，所以延后补几次（Mineradio 那边的经验值是 48/140/320）。
    if (window.ResizeObserver && root) {
      resizeObserver = new ResizeObserver(markSizeDirty);
      resizeObserver.observe(wrapEl);
    }
    window.addEventListener('resize', onViewportResize);
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (global.Onset && Onset.create) onset = Onset.create({});
    root.setAttribute('data-s3d-ready', '1');
    // silk 恢复时同样默认不展开队列：只显示舞台与歌词。
    return api;
  }

  function markSizeDirty() {
    sizeDirty = true;
    if (active && global.Stage && Stage.kick) Stage.kick();
  }

  function onViewportResize() {
    markSizeDirty();
    resizeTimers.forEach(clearTimeout);
    resizeTimers = [48, 140, 320].map(function (delay) {
      return setTimeout(function () {
        markSizeDirty();
        // classic 视口 resize：软重建按新视口重算 clamp 字号/散布/narrow（spec 10.3）。
        // cadenza 有自有 ResizeObserver，不走这里。
        if (folia.ready && folia.visual === 'classic' && folia.classic) folia.classic.resize();
        if (folia.ready && folia.visual === 'sonnet' && folia.sonnet) folia.sonnet.resize();
      }, delay);
    });
  }

  function onVisibilityChange() {
    if (document.hidden) cancelGestures();
    if (!document.hidden && active && global.Stage && Stage.kick) Stage.kick();
  }

  function destroy() {
    close();
    if (shelf) { shelf.destroy(); shelf = null; }
    if (lyricView) lyricView.destroy();
    lyricView = null;
    if (folia.ready) {
      [folia.bg, folia.sub, folia.classic, folia.cadenza, folia.sonnet, folia.tempera].forEach(function (renderer) { if (renderer) renderer.destroy(); });
      if (global.PIXI && global.PIXI.GlobalResourceRegistry) global.PIXI.GlobalResourceRegistry.release();
      folia.ready = false; folia.bg = folia.sub = folia.classic = folia.cadenza = folia.sonnet = folia.tempera = null;
      folia.themeSig = ''; folia.coverSig = ''; folia.pendingOffset = null; folia.pendingTrackId = null;
    }
    active = false;
    if (global.Stage && Stage.removeGate) Stage.removeGate(GATE);
    if (global.Stage && Stage.removeGate) Stage.removeGate('stage3d-ui');
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    resizeTimers.forEach(clearTimeout); resizeTimers = [];
    window.removeEventListener('resize', onViewportResize);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    releaseGl();
    glFailed = false;
    inited = false;
    return api;
  }

  var api = {
    init: init,
    destroy: destroy,
    open: open,
    close: close,
    isActive: isActive,
    setQueue: setQueue,
    // 全屏舞台入口（stage-immersive / 模式键）统一走这里申请原生全屏；
    // 此前这两个方法没导出，外部调用静默失效，全屏链路整个断了。
    requestFullscreen: function () { if (active) requestFs(); },
    toggleFullscreen: function () { if (active) toggleFullscreen(); },
    setStage: function (i) { return setStage(i, false); },
    setStageById: function (id) { return open(id); },
    stageId: function () { return STAGES[stageIndex].id; },
    stages: function () {
      return STAGES.map(function (s) {
        return { id: s.id, label: s.label, desc: s.desc };
      });
    },
    resetView: resetView,
    configure: configure,
    preferences: preferences,
    save: savePreferences,
    stats: function () {
      return {
        fps: Math.round(perf.hz / Math.max(1, perf.divisor)),
        hz: Math.round(perf.hz),
        costMs: Math.round(perf.avgMs * 10) / 10,
        pressure: Math.round(perf.pressure * 10) / 10,
        divisor: perf.divisor,
        quality: q(),
        dpr: Math.round(dpr * 100) / 100,
        stage: STAGES[stageIndex].id,
        audio: { bass: au.bass, mid: au.mid, treble: au.treble, energy: au.energy, beat: au.beat },
        camera: { theta: cam.curT, phi: cam.curP, radius: cam.curR },
        time: time,
        buffer: bw + 'x' + bh
      };
    }
  };

  global.Stage3D = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }
}(typeof window !== 'undefined' ? window : this));
