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
      id: 'aurora', label: '极光穹顶', desc: '星野与流动极光帷幕',
      cam: { theta: 0.0, phi: 0.10, dist: 8.4, look: [0, 0.6, -2.0] },
      counts: [3000, 6500, 11000], additive: true, depth: false
    },
    {
      id: 'tunnel', label: '折跃隧道', desc: '穿越光环的速度感',
      // 机位必须落在隧道近端之外：look + dist 恰好把相机放在 z=0，而环铺在
      // z ∈ [-1, -zSpan]，整段都在前方，近平面永远裁不到东西。
      cam: { theta: 0.0, phi: 0.0, dist: 2.2, look: [0, 0, -2.2] },
      counts: [36, 60, 92], additive: true, depth: false
    },
    {
      id: 'terrain', label: '音域地形', desc: '随频谱起伏的声场地形',
      cam: { theta: 0.62, phi: 0.52, dist: 30.0, look: [0, 2.4, 0] },
      counts: [24, 38, 54], additive: false, depth: true
    },
    {
      id: 'orb', label: '黑曜星球', desc: '星球雕塑与大气边缘光',
      cam: { theta: 0.72, phi: 0.18, dist: 9.2, look: [0, 0, 0] },
      counts: [2400, 5200, 8600], additive: false, depth: true
    },
    {
      id: 'prism', label: '棱镜星系', desc: '色散旋臂与光谱尘埃',
      // 机位要落在星云半径（约 14）之外：相机埋进粒子云里时，落在相机背后
      // 的那半团点会被近平面的 w≤0 判定整片剔除，屏幕上凭空少一块。
      cam: { theta: 0.34, phi: 0.46, dist: 20.0, look: [0, 0, 0] },
      counts: [3000, 6000, 10000], additive: true, depth: false
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
    '  vA = (0.44 + tw*0.80) * (0.62 + uEnergy*0.5);',
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

  // 极光帷幕用真正的带状网格而不是散点：一条 13–21 单位宽、8–12 单位高的帘子，
  // 靠几百个点精灵是铺不满的（覆盖率只有百分之几，看起来是散沙），网格则天然
  // 连续，横向条纹与"底亮上散"的衰减都能直接写进片元。
  var CURTAIN_VS = stageVS([
    'in float aCurtain;',
    'in vec2 aUV;',
    'out vec3 vCol;',
    'out float vA;',
    'out vec2 vUV;',
    'void main(){',
    '  float c = aCurtain;',
    '  float u = aUV.x*2.0 - 1.0;',
    '  float v = aUV.y;',
    '  float seed = c*17.31;',
    '  float sway = snoise(vec3(u*1.35 + seed, uTime*0.055 + c*3.0, 0.0))*2.8;',
    '  vec3 pos;',
    '  pos.x = u*(12.0 + c*4.5) + sway;',
    '  pos.y = -3.4 + v*(7.5 + hash11(seed*7.7)*4.5)',
    '         + snoise(vec3(u*2.1, uTime*0.085, seed))*1.0;',
    '  pos.z = -6.0 - c*12.0 + sway*0.32;',
    '  pos += normalize(pos + vec3(0.0, 0.001, 0.0))*uScatter*(2.0 + hash11(seed*3.3)*4.0);',
    '  vec4 mv = uView * vec4(pos, 1.0);',
    '  float dist = -mv.z;',
    '  vUV = aUV;',
    //   极光的配色不跟主题走：主题里只有青与香槟两个色相，五五混出来是灰的，
    //   极光要的是「底绿顶紫」这条固定的荧光带。
    '  vec3 low = mix(uTint2, vec3(0.16, 1.00, 0.62), 0.65);',
    '  vec3 high = mix(uTint3, vec3(0.45, 0.34, 1.00), 0.60);',
    '  vCol = mix(low, high, v);',
    '  vCol = mix(vCol, vec3(1.0), uBeat*0.20);',
    //   真实极光是底部亮、向上消散。上下两端都必须化到 0：只压上端的话，
    //   帘子的下沿会在画面上切出一条笔直的横线。
    //   底部的常数项必须收到接近 0：帘子几何的下沿整条都在 v=0，只要那里 alpha
    //   不为零，投影出来就是一条横贯画面的硬边（上一版画面底部的锯齿直边）。
    '  float shade = smoothstep(0.02, 0.18, v)*(1.0 - smoothstep(0.58, 1.0, v))*pow(1.0 - v, 1.1);',
    '  vA = (0.025 + shade*0.96) * (0.62 + uMid*0.8 + uBeat*0.4)',
    '     * uFade * smoothstep(0.5, 3.0, dist) * (1.0 - smoothstep(42.0, 62.0, dist));',
    '  gl_Position = uProj * mv;',
    '}'
  ].join('\n'));

  var CURTAIN_FS = stageFS([
    'in vec3 vCol;',
    'in float vA;',
    'in vec2 vUV;',
    'void main(){',
    //   横向收边：帘子的左右两端要化开，否则能看到一块直边
    '  float edge = smoothstep(0.0, 0.16, vUV.x)*(1.0 - smoothstep(0.84, 1.0, vUV.x));',
    //   竖直条纹：极光的"褶"
    '  float streak = 0.30 + 0.70*pow(0.5 + 0.5*sin(vUV.x*46.0 + uTime*0.7), 2.0);',
    '  float a = edge*vA*streak;',
    '  if (a < 0.004) discard;',
    '  o = vec4(vCol*(0.85 + a*0.9), a);',
    '}'
  ].join('\n'));

  // ---- 舞台 2：折跃隧道 ----------------------------------------------------
  // 实例化圆环：一份环带几何 + 每实例一个序号，位置全在 VS 里按「模进」算。
  var TUNNEL_VS = stageVS([
    'in vec2 aDir;',
    'in float aSide;',
    'in float aIdx;',
    'out vec3 vCol;',
    'out float vA;',
    'uniform float uRings;',
    'void main(){',
    '  float spacing = 1.9;',
    '  float zSpan = uRings*spacing;',
    '  float travel = uTime*(6.5 + uEnergy*15.0 + uBeat*8.0);',
    //   模进：环沿 -Z 铺满一整段，随时间向相机方向流动，走完一轮从远端回卷。
    //   必须保证整段都在相机前方 —— 只要有环落在相机背后，它就会被近平面裁出
    //   一道笔直的硬边（这正是上一版画面里那条横线）。
    '  float z = -mod(aIdx*spacing - travel, zSpan) - 1.0;',
    '  float wob = snoise(vec3(aIdx*0.19, uTime*0.085, 0.0))*0.85;',
    '  float r = 3.2 + wob + uBass*0.9;',
    '  float side = mix(0.945, 1.055, aSide);',
    '  vec3 pos = vec3(aDir.x*r*side, aDir.y*r*side, z);',
    '  pos.xy *= 1.0 + uScatter*0.5;',
    '  vec4 mv = uView * vec4(pos, 1.0);',
    //   纵深窗函数改按视距算而不是按环序号：视距 ≤ 0 的环（在相机后面或贴着
    //   相机）alpha 直接归零，裁切边就永远不可见。
    '  float dist = -mv.z;',
    //   近端必须淡得够早：相机就在隧道轴上，离得最近的环半径 3 出头、
    //   在屏幕上却铺满整幅画面，不淡掉的话一眼看过去是一块大圆盘而不是隧道。
    '  float win = smoothstep(1.6, 13.0, dist) * (1.0 - smoothstep(62.0, 98.0, dist));',
    '  float depthN = 1.0 - clamp(dist/98.0, 0.0, 1.0);',
    //   色相必须由 aDir 直接构造，不能过 atan：atan(y,x) 在 ±π 处不连续，
    //   角向色相会沿 -X 撕开一条接缝，投影出来正好是「从中心向左的一条水平线」。
    '  float hue = 0.5 + 0.5*sin(aDir.x*2.2 + aDir.y*1.3 + uTime*0.35 + depthN*3.4);',
    //   同样不跟主题的「青 / 香槟」走：两者五五混是灰的，隧道要青→紫这条荧光带
    '  vec3 cLow = mix(uTint2, vec3(0.20, 0.86, 1.00), 0.60);',
    '  vec3 cHigh = mix(uTint3, vec3(0.55, 0.34, 1.00), 0.55);',
    '  vCol = mix(cLow, cHigh, hue);',
    '  vCol = mix(vCol, vec3(1.0), uBeat*0.30*(1.0 - depthN*0.5));',
    //   静默段（无音频）时 uMid/uBeat 都是 0，整条隧道的可见度就只剩这个常数项。
    //   0.20 在暗底上几乎看不见环带，看不出「隧道」，提到 0.30 让待机态也能读出来。
    '  vA = win * (0.30 + uMid*0.46 + uBeat*0.28) * uFade;',
    '  vA *= 1.0 - smoothstep(0.0, 1.0, uScatter*1.4);',
    '  gl_Position = uProj * mv;',
    '}'
  ].join('\n'));

  var TUNNEL_FS = stageFS([
    'in vec3 vCol;',
    'in float vA;',
    'void main(){',
    '  if (vA < 0.002) discard;',
    '  o = vec4(vCol*(0.85 + vA*1.15), vA);',
    '}'
  ].join('\n'));

  // ---- 舞台 3：音域地形 ----------------------------------------------------
  // 实例化立方体柱阵。高度 = 噪声地形 + 三段频谱抬升；大气雾交给距离衰减。
  var TERRAIN_VS = stageVS([
    'in vec3 aPos;',
    'in vec3 aNormal;',
    'in vec2 aCell;',
    'out vec3 vNormal;',
    'out vec3 vWorld;',
    'out float vHeight;',
    'out float vDist;',
    'void main(){',
    //   注意：GLSL ES 里 half / fixed / double 是保留字，不能用 half 命名
    '  float hs = (uGrid-1.0)*0.5;',
    '  vec2 cell = (aCell - vec2(hs)) * 0.92;',
    '  float cd = length(cell);',
    '  float rnd = hash11(cell.x*31.7 + cell.y*71.3);',
    //   噪声频率要够高：cell*0.055 在 ±17 的网格上只扫过不到 2 个噪声单位，
    //   整片地形会得到几乎相同的高度，看起来就是一块地毯而不是地景。
    '  vec2 mp = cell*0.15 + vec2(uTime*0.06, uTime*0.035);',
    '  float baseN = snoise(vec3(mp, uTime*0.02))*0.5 + 0.5;',
    '  float wave = sin(cell.x*0.30 + cell.y*0.22 - uTime*0.55)*0.5 + 0.5;',
    '  float falloff = smoothstep(uGrid*0.55, uGrid*0.08, cd);',
    '  float idle = mix(baseN, wave, 0.45) * 2.7 * falloff;',
    '  float bandR = smoothstep(uGrid*0.44, uGrid*0.02, cd);',
    '  float audioH = (uBass*4.0*bandR',
    '                + uMid*2.6*smoothstep(0.15, 1.0, rnd)*bandR',
    '                + uTreble*1.8*smoothstep(0.35, 1.0, rnd)) * falloff;',
    '  audioH = max(0.0, audioH - 0.04);',
    '  float h = 0.55 + idle + audioH + uBeat*1.8*bandR*(0.3 + rnd);',
    //   只沿 Y 拉伸：底面固定、顶面抬升，一个乘加搞定，不需要重建几何。
    //   aPos.y 在几何里已经抬到 0..1，所以这里直接乘高度。
    '  vec3 world = vec3(cell.x + aPos.x*0.62, aPos.y*h, cell.y + aPos.z*0.62);',
    '  world.y += uScatter*1.6*rnd;',
    '  vec4 mv = uView * vec4(world, 1.0);',
    '  vNormal = aNormal;',
    '  vWorld = world;',
    '  vHeight = h;',
    '  vDist = -mv.z;',
    '  gl_Position = uProj * mv;',
    '}'
  ].join('\n'));

  var TERRAIN_FS = stageFS([
    'in vec3 vNormal;',
    'in vec3 vWorld;',
    'in float vHeight;',
    'in float vDist;',
    'void main(){',
    '  vec3 n = normalize(vNormal);',
    '  vec3 vd = normalize(uCamPos - vWorld);',
    '  float diff = clamp(dot(n, normalize(vec3(0.34, 0.88, 0.33))), 0.0, 1.0);',
    '  float hN = clamp(vHeight/5.5, 0.0, 1.0);',
    '  vec3 base = mix(uTint2*0.20, uTint3, hN*0.85 + 0.08);',
    '  vec3 col = base*(0.14 + diff*0.80);',
    //   边缘光：正对视线的地方亮起来，柱体的轮廓才不会糊成一团
    '  float fres = pow(1.0 - clamp(dot(n, vd), 0.0, 1.0), 3.0);',
    '  col += uTint * fres * 0.30;',
    //   顶面自发光，跟着能量走
    '  col += uTint2 * smoothstep(0.55, 1.0, vHeight/3.4) * 0.22 * (0.35 + uEnergy);',
    //   大气透视：远处的柱子往背景色里退。系数要够大，否则网格的远端会在地平线
    //   上切出一条直边，整片地形看起来像一块被剪过的地毯。
    '  float fog = 1.0 - exp(-max(0.0, vDist-5.0)*0.034);',
    '  col = mix(col, vec3(0.010, 0.013, 0.020), clamp(fog, 0.0, 0.94));',
    '  o = vec4(col*uFade, 1.0);',
    '}'
  ].join('\n'));

  // ---- 舞台 4：黑曜星球 ----------------------------------------------------
  var ORB_SHELL_VS = stageVS([
    'in vec3 aPos;',
    'in vec3 aNormal;',
    'out vec3 vNormal;',
    'out vec3 vWorld;',
    'uniform float uRadius;',
    'void main(){',
    '  float breathe = 1.0 + sin(uTime*0.42)*0.012 + uBeat*0.045;',
    '  vec3 p = aPos*uRadius*breathe;',
    '  vec4 mv = uView * vec4(p, 1.0);',
    '  vNormal = aNormal;',
    '  vWorld = p;',
    '  gl_Position = uProj * mv;',
    '}'
  ].join('\n'));

  var ORB_SHELL_FS = stageFS([
    'in vec3 vNormal;',
    'in vec3 vWorld;',
    'void main(){',
    '  vec3 n = normalize(vNormal);',
    '  vec3 vd = normalize(uCamPos - vWorld);',
    '  vec3 ld = normalize(vec3(0.44, 0.71, 0.55));',
    '  float ndl = dot(n, ld);',
    //   晨昏线的过渡区间要够宽。之前把阈值卡在 0.0~0.30，而球面上「与光方向
    //   夹角小于 72°」的整片区域都落在这个区间之上，于是整个受光面被压成一块
    //   纯色 —— 屏幕上就是一颗青色的气球，完全没有体积。
    //   但上界也不能太松：0.62 时可见圆盘的边缘 ndl 还有 ~0.57、term 仍接近 1，
    //   整个球面照样是一块平色。上界提到 0.78，亮面从圆心向外一路衰减，
    //   晨昏线才真正落在可见面上，球体有了体积感。
    '  float term = smoothstep(-0.06, 0.78, ndl);',
    //   低频噪声当岩层，给表面一点结构，避免大片纯色
    '  float rock = snoise(n*3.4 + vec3(0.0, uTime*0.012, 0.0))*0.5 + 0.5;',
    '  vec3 base = mix(vec3(0.010, 0.013, 0.022), uTint3*0.24, term);',
    //   岩层调制的动态范围拉大：0.55±0.55 出来的是一层薄薄的灰纱，
    //   换成 0.40±0.85 才有明暗块面，黑曜石该有的「硬」才出来。
    '  vec3 col = base*(0.40 + rock*0.85);',
    //   受光侧的边缘散射：星球边缘那圈亮边
    '  col += uTint2 * pow(clamp(1.0 - abs(ndl), 0.0, 1.0), 8.0) * term * 0.38;',
    //   高光斑是「这是个球」最直接的线索。只有漫反射 + 轮廓光时，球面中间永远是
    //   一片均匀的灰度，看着像贴图而不是球。半程向量做一次锐化高光，体积立刻出来。
    //   指数取 42：够窄才有亮点感，又不至于小到在软渲染下闪掉。
    '  vec3 hv = normalize(ld + vd);',
    '  float spec = pow(max(dot(n, hv), 0.0), 42.0) * term;',
    '  col += mix(uTint2, vec3(1.0), 0.35) * spec * (0.60 + uBeat*0.35);',
    //   轮廓光压在球体剪影上，靠它把球从黑底里"切"出来
    //   球体整体比上一版更暗（term 上界收紧 + 岩层压暗），轮廓光要相应加强，
    //   否则星球的剪影会糊进背景里。指数放小一点让亮边更宽、更实。
    '  float fres = pow(1.0 - clamp(dot(n, vd), 0.0, 1.0), 3.0);',
    '  col += uTint2 * fres * (0.44 + uBeat*0.42);',
    '  o = vec4(col*uFade, 1.0);',
    '}'
  ].join('\n'));

  var ORB_ATMO_VS = stageVS([
    'in vec3 aPos;',
    'in vec3 aNormal;',
    'out vec3 vNormal;',
    'out vec3 vWorld;',
    'uniform float uRadius;',
    'void main(){',
    '  vec3 p = aPos*uRadius;',
    '  vec4 mv = uView * vec4(p, 1.0);',
    '  vNormal = aNormal;',
    '  vWorld = p;',
    '  gl_Position = uProj * mv;',
    '}'
  ].join('\n'));

  var ORB_ATMO_FS = stageFS([
    'in vec3 vNormal;',
    'in vec3 vWorld;',
    'void main(){',
    '  vec3 n = normalize(vNormal);',
    '  vec3 vd = normalize(uCamPos - vWorld);',
    //   渲染背面，所以法线朝内；越接近切向越亮，形成一圈大气环。指数取大一点
    //   才会收成"一圈"而不是整个球壳发亮。
    '  float rim = pow(clamp(1.0 - abs(dot(n, vd)), 0.0, 1.0), 5.0);',
    '  vec3 col = mix(uTint2, uTint3, 0.35) * rim * (1.25 + uEnergy*0.9 + uBeat*0.5);',
    '  o = vec4(col*uFade, rim);',
    '}'
  ].join('\n'));

  var ORB_DUST_VS = stageVS([
    'in float aSeed;',
    'in float aLane;',
    'out vec3 vCol;',
    'out float vA;',
    'void main(){',
    '  float seed = aSeed;',
    '  float shell = 1.0 + fract(aLane*5.0)*0.55;',
    '  float th = hash11(seed*2.17)*6.2831853;',
    '  float ph = acos(clamp(1.0-2.0*hash11(seed*3.91), -1.0, 1.0));',
    '  float r = 3.05*shell + snoise(vec3(ph*2.0, th*2.0, uTime*0.06))*0.22;',
    '  vec3 dir = vec3(sin(ph)*cos(th), cos(ph), sin(ph)*sin(th));',
    '  vec3 pos = dir*r;',
    //   绕 Y 慢转 + 沿法线呼吸
    '  float spin = uTime*0.075;',
    '  float cs = cos(spin), sn = sin(spin);',
    '  pos.xz = mat2(cs,-sn,sn,cs)*pos.xz;',
    '  pos += dir*(uBass*0.55 + uBeat*0.35);',
    '  pos += normalize(pos)*uScatter*(2.0 + hash11(seed*5.7)*4.0);',
    '  vCol = mix(uTint2, uTint3, hash11(seed*7.9));',
    '  vCol = mix(vCol, vec3(1.0), uBeat*0.18);',
    '  float tw = 0.55 + 0.45*sin(uTime*(0.5+hash11(seed*11.3)*1.2)+seed*8.0);',
    '  vec4 mv = uView * vec4(pos, 1.0);',
    '  float dist = -mv.z;',
    '  gl_PointSize = pointSize(dist, 0.85 + uBurst*0.8);',
    '  vA = tw*(0.14 + uMid*0.5) * uFade * smoothstep(0.5, 2.5, dist);',
    '  gl_Position = uProj * mv;',
    '}'
  ].join('\n'));

  var ORB_DUST_FS = STAR_FS;

  // ---- 舞台 5：棱镜星系 ----------------------------------------------------
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

  var stageIndex = 0;
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

  // 色调：从主题 CSS 变量取，跟着换肤走
  var tint = [1, 1, 1];
  var tint2 = [0, 0.96, 0.83];
  var tint3 = [0.96, 0.82, 0.54];

  // 性能与调度
  var perf = {
    hz: 60, lastAt: 0, samples: [],
    avgMs: 0, pressure: 0, divisor: 1, tick: 0,
    lastQualityDropAt: 0, quality: 2
  };
  var interactUntil = 0;

  // 交互
  var pointers = {};
  var pointerCount = 0;
  var pinchDist = 0;
  var dragVel = { t: 0, p: 0 };
  var dragging = false;

  var chromeTimer = 0;

  // -------------------------------------------------------------------------
  // GL 基础设施
  // -------------------------------------------------------------------------

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[stage3d] 着色器编译失败：', gl.getShaderInfoLog(sh));
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo: fbo, tex: tex, rb: rb, w: w, h: h };
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

  function ringGeometry(segments) {
    var dir = new Float32Array((segments + 1) * 2 * 2);
    var side = new Float32Array((segments + 1) * 2);
    var k = 0;
    for (var i = 0; i <= segments; i += 1) {
      var ang = i / segments * Math.PI * 2;
      var cx = Math.cos(ang), cy = Math.sin(ang);
      dir[k * 2] = cx; dir[k * 2 + 1] = cy; side[k] = 0; k += 1;
      dir[k * 2] = cx; dir[k * 2 + 1] = cy; side[k] = 1; k += 1;
    }
    return { dir: buffer(dir), side: buffer(side), verts: k };
  }

  function boxGeometry() {
    // 36 顶点三角列表。面法线直接写死，省掉一次索引与法线计算。
    var f = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
    ];
    var v = [];
    for (var i = 0; i < 6; i += 1) {
      var n = f[i];
      var u = i === 0 || i === 1 ? [0, 1, 0] : (i === 2 || i === 3 ? [0, 0, 1] : [1, 0, 0]);
      var w = i === 0 || i === 1 ? [0, 0, 1] : (i === 2 || i === 3 ? [1, 0, 0] : [0, 1, 0]);
      var s = [n[0] * 0.5, n[1] * 0.5, n[2] * 0.5];
      var q = [
        [s[0] - u[0] * 0.5 - w[0] * 0.5, s[1] - u[1] * 0.5 - w[1] * 0.5, s[2] - u[2] * 0.5 - w[2] * 0.5],
        [s[0] + u[0] * 0.5 - w[0] * 0.5, s[1] + u[1] * 0.5 - w[1] * 0.5, s[2] + u[2] * 0.5 - w[2] * 0.5],
        [s[0] + u[0] * 0.5 + w[0] * 0.5, s[1] + u[1] * 0.5 + w[1] * 0.5, s[2] + u[2] * 0.5 + w[2] * 0.5],
        [s[0] - u[0] * 0.5 + w[0] * 0.5, s[1] - u[1] * 0.5 + w[1] * 0.5, s[2] - u[2] * 0.5 + w[2] * 0.5]
      ];
      var order = [0, 1, 2, 0, 2, 3];
      for (var j = 0; j < 6; j += 1) {
        var p = q[order[j]];
        // y 从 -0.5..0.5 抬到 0..1，顶点着色器里直接 (aPos.y+0.5)*height
        v.push(p[0], p[1] + 0.5, p[2], n[0], n[1], n[2]);
      }
    }
    var arr = new Float32Array(v);
    var pos = new Float32Array(arr.length / 2);
    var nor = new Float32Array(arr.length / 2);
    for (var m = 0, o = 0; m < arr.length; m += 6, o += 3) {
      pos[o] = arr[m]; pos[o + 1] = arr[m + 1]; pos[o + 2] = arr[m + 2];
      nor[o] = arr[m + 3]; nor[o + 1] = arr[m + 4]; nor[o + 2] = arr[m + 5];
    }
    return { pos: buffer(pos), nor: buffer(nor), verts: pos.length / 3 };
  }

  function sphereGeometry(stacks, slices) {
    var pos = new Float32Array((stacks + 1) * (slices + 1) * 3);
    var k = 0;
    for (var i = 0; i <= stacks; i += 1) {
      var phi = i / stacks * Math.PI;
      var sp = Math.sin(phi), cp = Math.cos(phi);
      for (var j = 0; j <= slices; j += 1) {
        var th = j / slices * Math.PI * 2;
        pos[k] = sp * Math.cos(th); pos[k + 1] = cp; pos[k + 2] = sp * Math.sin(th);
        k += 3;
      }
    }
    var idx = [];
    for (        var a = 0; a < stacks; a += 1) {
      for (var b = 0; b < slices; b += 1) {
        var p1 = a * (slices + 1) + b;
        var p2 = p1 + slices + 1;
        // 逆时针缠绕（GL 默认 frontFace=CCW）。写成 (p1, p2, p1+1) 是顺时针，
        // 配合 cullFace(BACK) 会把整个近半球剔掉。
        idx.push(p1, p1 + 1, p2, p1 + 1, p2 + 1, p2);
      }
    }
    return {
      pos: buffer(pos),
      idx: indexBuffer(new Uint16Array(idx)),
      verts: idx.length
    };
  }

  // -------------------------------------------------------------------------
  // 舞台构建
  // -------------------------------------------------------------------------

  function q() {
    var t = (global.Stage && Stage.tier) ? Stage.tier() : 2;
    if (global.Stage && Stage.isLowFx && Stage.isLowFx()) t = 0;
    return clamp(Math.min(num(t, 2), perf.quality), 0, 2);
  }

  // 帘幕网格：每条帘子一张 (segU+1)×(segV+1) 的规则网格，逐顶点只存
  // 「第几条」和「归一化 uv」，世界坐标全在顶点着色器里算。
  function curtainGeometry(curtains, segU, segV) {
    var per = (segU + 1) * (segV + 1);
    var n = curtains * per;
    var aCurtain = new Float32Array(n);
    var aUV = new Float32Array(n * 2);
    var idx = [];
    var k = 0;
    for (var c = 0; c < curtains; c += 1) {
      var base = c * per;
      for (var j = 0; j <= segV; j += 1) {
        for (var i = 0; i <= segU; i += 1) {
          aCurtain[k] = c;
          aUV[k * 2] = i / segU;
          aUV[k * 2 + 1] = j / segV;
          k += 1;
        }
      }
      for (var jj = 0; jj < segV; jj += 1) {
        for (var ii = 0; ii < segU; ii += 1) {
          var a = base + jj * (segU + 1) + ii;
          var b = a + 1;
          var d = a + segU + 1;
          idx.push(a, d, b, b, d, d + 1);
        }
      }
    }
    return {
      curtain: buffer(aCurtain),
      uv: buffer(aUV),
      idx: indexBuffer(new Uint16Array(idx)),
      indices: idx.length
    };
  }

  function buildAurora(def) {
    var starP = buildProgram(STAR_VS, STAR_FS);
    var curP = buildProgram(CURTAIN_VS, CURTAIN_FS);
    if (!starP || !curP) return null;
    var s = seeds(def.counts[q()]);
    var starVao = makeVAO([
      { loc: starP.a('aSeed'), buffer: s.seed, size: 1 },
      { loc: starP.a('aLane'), buffer: s.lane, size: 1 }
    ]);
    var qq = q();
    var curtains = 6;
    var g = curtainGeometry(curtains, qq === 0 ? 26 : (qq === 1 ? 38 : 52), 12);
    var curVao = makeVAO([
      { loc: curP.a('aCurtain'), buffer: g.curtain, size: 1 },
      { loc: curP.a('aUV'), buffer: g.uv, size: 2 }
    ], g.idx);
    return {
      count: s.count,
      draw: function () {
        gl.useProgram(starP.p);
        uploadCommon(starP);
        gl.bindVertexArray(starVao);
        gl.drawArrays(gl.POINTS, 0, s.count);

        gl.useProgram(curP.p);
        uploadCommon(curP);
        gl.bindVertexArray(curVao);
        gl.drawElements(gl.TRIANGLES, g.indices, gl.UNSIGNED_SHORT, 0);
      },
      dispose: function () {
        gl.deleteProgram(starP.p); gl.deleteProgram(curP.p);
        gl.deleteVertexArray(starVao); gl.deleteVertexArray(curVao);
        gl.deleteBuffer(s.seed); gl.deleteBuffer(s.lane);
        gl.deleteBuffer(g.curtain); gl.deleteBuffer(g.uv); gl.deleteBuffer(g.idx);
      }
    };
  }

  function buildTunnel(def) {
    var prog = buildProgram(TUNNEL_VS, TUNNEL_FS);
    if (!prog) return null;
    var rings = def.counts[q()];
    var g = ringGeometry(72);
    var idx = new Float32Array(rings);
    for (var i = 0; i < rings; i += 1) idx[i] = i;
    var ib = buffer(idx);
    var vao = makeVAO([
      { loc: prog.a('aDir'), buffer: g.dir, size: 2 },
      { loc: prog.a('aSide'), buffer: g.side, size: 1 },
      { loc: prog.a('aIdx'), buffer: ib, size: 1, divisor: 1 }
    ]);
    return {
      count: rings,
      draw: function () {
        gl.useProgram(prog.p);
        uploadCommon(prog);
        setF(prog.u, 'uRings', rings);
        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, g.verts, rings);
      },
      dispose: function () {
        gl.deleteProgram(prog.p); gl.deleteVertexArray(vao);
        gl.deleteBuffer(g.dir); gl.deleteBuffer(g.side); gl.deleteBuffer(ib);
      }
    };
  }

  function buildTerrain(def) {
    var prog = buildProgram(TERRAIN_VS, TERRAIN_FS);
    if (!prog) return null;
    var grid = def.counts[q()];
    var cells = new Float32Array(grid * grid * 2);
    var k = 0;
    for (var z = 0; z < grid; z += 1) {
      for (var x = 0; x < grid; x += 1) {
        cells[k] = x; cells[k + 1] = z; k += 2;
      }
    }
    var box = boxGeometry();
    var cb = buffer(cells);
    var vao = makeVAO([
      { loc: prog.a('aPos'), buffer: box.pos, size: 3 },
      { loc: prog.a('aNormal'), buffer: box.nor, size: 3 },
      { loc: prog.a('aCell'), buffer: cb, size: 2, divisor: 1 }
    ]);
    return {
      count: grid * grid,
      grid: grid,
      draw: function () {
        gl.useProgram(prog.p);
        uploadCommon(prog);
        setF(prog.u, 'uGrid', grid);
        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, box.verts, grid * grid);
      },
      dispose: function () {
        gl.deleteProgram(prog.p); gl.deleteVertexArray(vao);
        gl.deleteBuffer(box.pos); gl.deleteBuffer(box.nor); gl.deleteBuffer(cb);
      }
    };
  }

  function buildOrb(def) {
    var shellP = buildProgram(ORB_SHELL_VS, ORB_SHELL_FS);
    var atmoP = buildProgram(ORB_ATMO_VS, ORB_ATMO_FS);
    var dustP = buildProgram(ORB_DUST_VS, ORB_DUST_FS);
    if (!shellP || !atmoP || !dustP) return null;
    var qq = q();
    var stacks = qq === 0 ? 24 : (qq === 1 ? 36 : 48);
    var slices = qq === 0 ? 32 : (qq === 1 ? 48 : 64);
    var sph = sphereGeometry(stacks, slices);
    var shellVao = makeVAO([
      { loc: shellP.a('aPos'), buffer: sph.pos, size: 3 },
      { loc: shellP.a('aNormal'), buffer: sph.pos, size: 3 }
    ], sph.idx);
    var atmoVao = makeVAO([
      { loc: atmoP.a('aPos'), buffer: sph.pos, size: 3 },
      { loc: atmoP.a('aNormal'), buffer: sph.pos, size: 3 }
    ], sph.idx);
    var s = seeds(def.counts[qq]);
    var dustVao = makeVAO([
      { loc: dustP.a('aSeed'), buffer: s.seed, size: 1 },
      { loc: dustP.a('aLane'), buffer: s.lane, size: 1 }
    ]);
    return {
      count: s.count,
      draw: function () {
        // 实体星球：写深度，让后面的尘埃被遮挡出正确的前后关系
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        gl.useProgram(shellP.p);
        uploadCommon(shellP);
        setF(shellP.u, 'uRadius', 2.9);
        gl.bindVertexArray(shellVao);
        gl.drawElements(gl.TRIANGLES, sph.verts, gl.UNSIGNED_SHORT, 0);

        // 大气壳：渲染背面（剔除正面）且不写深度，additive 叠一圈边缘光
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        gl.cullFace(gl.FRONT);
        gl.useProgram(atmoP.p);
        uploadCommon(atmoP);
        setF(atmoP.u, 'uRadius', 3.14);
        gl.bindVertexArray(atmoVao);
        gl.drawElements(gl.TRIANGLES, sph.verts, gl.UNSIGNED_SHORT, 0);

        // 环绕尘埃：深度测试保留（被星球挡住），但不写深度
        gl.disable(gl.CULL_FACE);
        gl.useProgram(dustP.p);
        uploadCommon(dustP);
        gl.bindVertexArray(dustVao);
        gl.drawArrays(gl.POINTS, 0, s.count);
      },
      dispose: function () {
        gl.deleteProgram(shellP.p); gl.deleteProgram(atmoP.p); gl.deleteProgram(dustP.p);
        gl.deleteVertexArray(shellVao); gl.deleteVertexArray(atmoVao); gl.deleteVertexArray(dustVao);
        gl.deleteBuffer(sph.pos); gl.deleteBuffer(sph.idx);
        gl.deleteBuffer(s.seed); gl.deleteBuffer(s.lane);
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
    aurora: buildAurora,
    tunnel: buildTunnel,
    terrain: buildTerrain,
    orb: buildOrb,
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
    setF(post.bright.u, 'uThreshold', 0.58);
    setF(post.bright.u, 'uKnee', 0.32);
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
    setF(post.comp.u, 'uBloomAmt', q() === 0 ? 0.55 : 0.85);
    setF(post.comp.u, 'uVignette', 0.62);
    setF(post.comp.u, 'uGrain', 0.028);
    setF(post.comp.u, 'uChroma', 1.0 + au.beat * 0.6);
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
    builtStages = {};
    post = null;
  }

  function onContextRestored() {
    contextLost = false;
    glFailed = false;
    if (!gl) return;
    gl.disable(gl.DITHER);
    if (buildPost()) { builtStages = {}; ensureStage(); }
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
    post = null;
    fsTri = null;
    if (canvas) {
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
    var cap = level === 0 ? 0.90 : (level === 1 ? 1.15 : 1.55);
    var floor = level === 0 ? 0.50 : (level === 1 ? 0.60 : 0.75);
    var budget = level === 0 ? 1900000 : (level === 1 ? 3600000 : 6200000);
    var budgetCap = Math.sqrt(budget / Math.max(1, w * h));
    return Math.max(floor, Math.min(dev, Math.min(cap, budgetCap)));
  }

  function resize() {
    if (!gl || !root) return;
    var w = Math.max(1, Math.round(root.clientWidth || window.innerWidth));
    var h = Math.max(1, Math.round(root.clientHeight || window.innerHeight));
    dpr = computeDpr(w, h);
    var nw = Math.max(1, Math.round(w * dpr));
    var nh = Math.max(1, Math.round(h * dpr));
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
    var drift = cam.cruise ? 1 : 0;
    var userBusy = dragging ? 0.25 : 1;   // 用户在拖的时候自动让位
    var d = drift * userBusy;
    cam.cineT = Math.sin(cam.cinemaT * 0.083) * 0.030 * d + au.beat * 0.012;
    cam.cineP = Math.sin(cam.cinemaT * 0.061 + 1.0) * 0.024 * d;
    cam.cineR = Math.sin(cam.cinemaT * 0.043 + 2.0) * 0.22 * d - au.beat * 0.30;

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
    cam.fovTarget = BASE_FOV - trans.punch * 2.6 - au.beat * 1.1;
    var tau = cam.fovTarget < cam.fov ? 90 : 240;
    cam.fov = damp(cam.fov, cam.fovTarget, tau, dtMs);
    cam.rollTarget = au.beat * 0.012;
    cam.roll = damp(cam.roll, cam.rollTarget, 160, dtMs);

    var cp = Math.cos(cam.curP), sp = Math.sin(cam.curP);
    var ct = Math.cos(cam.curT), st = Math.sin(cam.curT);
    var px = cam.curLook[0] + cam.curR * cp * st;
    var py = cam.curLook[1] + cam.curR * sp;
    var pz = cam.curLook[2] + cam.curR * cp * ct;
    cam.pos[0] = px; cam.pos[1] = py; cam.pos[2] = pz;

    var aspect = bw / Math.max(1, bh);
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
    var sp = (global.Stage && Stage.spectrum) ? Stage.spectrum() : null;
    var n = sp ? sp.length : 0;
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
    au.bass = damp(au.bass, clamp(bass, 0, 1.5), 70, dtMs);
    au.mid = damp(au.mid, clamp(mid, 0, 1.5), 90, dtMs);
    au.treble = damp(au.treble, clamp(treble, 0, 1.5), 60, dtMs);

    var en = (global.Stage && Stage.energy) ? Stage.energy() : 0;
    au.energy = damp(au.energy, clamp(num(en, 0), 0, 1), 140, dtMs);

    // 起音只认 Onset 一份判定，避免「换一种渲染，律动看起来变了」。
    if (onset && n) {
      onset.step(dtMs, sp, time * 1000);
      au.beat = clamp(onset.pulse / 1.35, 0, 1);
    } else {
      au.beat = damp(au.beat, 0, 200, dtMs);
    }
  }

  // -------------------------------------------------------------------------
  // 转场
  // -------------------------------------------------------------------------

  function startTransition() {
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
    if (!gl || contextLost) return;
    if (sizeDirty) resize();
    updateAudio(dtMs);
    updateCamera(dtMs);
    updateTransition(dtMs);

    var st = ensureStage();
    if (!st) return;

    // 主几何的公共 uniform 靠「每个 program 上传一遍」——5 个舞台的 uniform
    // 布局一致，切换时无需重新绑定，代价可以忽略。
    drawStage(st);
    runPost();
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
    if (perf.avgMs > budget) perf.pressure = Math.min(6, perf.pressure + 0.7);
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
    return 1;
  }

  function markInteraction(holdMs) {
    interactUntil = performance.now() + (holdMs || 900);
  }

  // 目标帧率。返回 0 表示这一层完全不需要帧，主循环据此停机。
  function targetFps() {
    if (!active || !gl || document.hidden) return 0;
    // 240 = 「每个 rAF 都给我」，降频自己用整数除数在 tick 里做：
    // 帧率必须是刷新率的整数分之一，90fps@144Hz 会因为帧间隔不均产生 judder。
    return 240;
  }

  function tick(dtMs) {
    if (!active || !gl) return;
    var t0 = performance.now();
    sampleHz(dtMs);
    perf.divisor = selectDivisor();
    perf.tick += 1;
    if (perf.divisor > 1 && (perf.tick - 1) % perf.divisor !== 0) return;
    // 被跳过的那些帧的时间并没有丢：帧门已经把 dt 累加进来了，
    // 所以降频不会让动画变慢。
    var step = Math.min(dtMs, 120);
    time += step / 1000;
    render(step);
    sampleCost(performance.now() - t0);
  }

  // -------------------------------------------------------------------------
  // 交互
  // -------------------------------------------------------------------------

  function localPoint(e) {
    var r = root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onPointerDown(e) {
    if (!active) return;
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
    var prev = pointers[e.pointerId];
    markInteraction(900);
    if (!prev) return;
    var p = localPoint(e);
    if (pointerCount >= 2) {
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
    if (pointerCount === 0) {
      dragging = false;
      root.classList.remove('s3d-dragging');
      pinchDist = 0;
    }
    markInteraction(700);
  }

  function onWheel(e) {
    if (!active) return;
    e.preventDefault();
    var k = Math.exp(-(e.deltaY || 0) * 0.0012);
    cam.userR = clamp(cam.userR * k, cam.minR, cam.maxR);
    markInteraction(900);
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
    root.classList.add('s3d-chrome');
    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = setTimeout(function () {
      root.classList.remove('s3d-chrome');
    }, CHROME_HIDE_MS);
  }

  // -------------------------------------------------------------------------
  // 舞台切换
  // -------------------------------------------------------------------------

  function setStage(i, immediate) {
    i = clamp(num(i, 0), 0, STAGES.length - 1);
    var changed = i !== stageIndex;
    stageIndex = i;
    var def = STAGES[i];
    applyStageCamera(def, !!immediate);
    if (changed) startTransition();
    syncDock();
    syncNowPlaying();
    markInteraction(1200);
    if (global.Stage && Stage.kick) Stage.kick();
    return true;
  }

  function cycleStage(dir) {
    setStage((stageIndex + (dir || 1) + STAGES.length) % STAGES.length, false);
  }

  // 曲目信息直接抄歌词页那两份：它们由 Stage.setTrack 维护，是唯一一份真值，
  // 这里再自己订阅一遍只会多一条可能不同步的链路。
  function syncNowPlaying() {
    var t = $('s3d-title');
    var a = $('s3d-artist');
    var lt = $('lp-title');
    var la = $('lp-artist');
    if (t && lt) t.textContent = lt.textContent || '未在播放';
    if (a && la) a.textContent = la.textContent || '';
    var hint = $('s3d-hint');
    if (hint) hint.textContent = STAGES[stageIndex].label + ' · ' + STAGES[stageIndex].desc;
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

  function open(stageId) {
    if (!root) return false;
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
    var fb = $('s3d-fallback');
    if (fb) fb.hidden = true;

    if (!ensureGl()) return false;
    sizeDirty = true;
    resize();
    applyStageCamera(STAGES[stageIndex], true);
    fade = 0;
    startTransition();
    syncDock();
    syncNowPlaying();
    syncFsUi();
    pokeChrome();
    if (global.Stage && Stage.kick) Stage.kick();
    return true;
  }

  function close() {
    if (!root || !active) return;
    fadeTarget = 0;
    active = false;
    root.classList.remove('s3d-open');
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('s3d-open');
    if (fsEl()) exitFs();
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
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;
    if (k === 'Escape') {
      if (fsEl()) { exitFs(); e.stopImmediatePropagation(); return; }
      close();
      e.stopImmediatePropagation();
      return;
    }
    if (k === 'f' || k === 'F') {
      toggleFullscreen();
      e.stopImmediatePropagation();
      return;
    }
    // V 与入口按钮同义：开着时收掉这一层，形成开合闭环。
    if (k === 'v' || k === 'V') { close(); e.stopImmediatePropagation(); return; }
    if (k === 'k' || k === 'K') { resetView(); e.stopImmediatePropagation(); return; }
    if (k === 'c' || k === 'C') {
      cam.cruise = !cam.cruise;
      var cb = $('s3d-cruise');
      if (cb) cb.setAttribute('aria-pressed', String(cam.cruise));
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

  function bindUi() {
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
      });
    }
    var xb = $('s3d-close');
    if (xb) xb.addEventListener('click', close);

    document.addEventListener('fullscreenchange', syncFsUi);
    document.addEventListener('webkitfullscreenchange', syncFsUi);

    // 打开入口：歌词页顶栏的三维按钮 + 舞台侧栏的同款按钮。
    var openers = ['lp-3d', 'stage-3d-btn'];
    openers.forEach(function (id) {
      var b = $(id);
      if (b) b.addEventListener('click', function () { open(); });
    });

    wrapEl.addEventListener('pointerdown', onPointerDown);
    wrapEl.addEventListener('pointermove', onPointerMove, { passive: true });
    wrapEl.addEventListener('pointerup', onPointerUp);
    wrapEl.addEventListener('pointercancel', onPointerUp);
    wrapEl.addEventListener('wheel', onWheel, { passive: false });
    wrapEl.addEventListener('dblclick', function () { resetView(); });
    root.addEventListener('pointermove', pokeChrome, { passive: true });
    root.addEventListener('pointerdown', pokeChrome, { passive: true });

    document.addEventListener('keydown', onKeyDown, true);

    // V 的开启分支。#stage-3d-btn 与 #lp-3d 的 title 都写着 "(V)"，但此前
    // 全工程没有任何 V 的处理器（onKeyDown 第一行就是 !active 直接 return），
    // 文档承诺和实际行为对不上。这里补上；开着的时候由 onKeyDown 收口关闭。
    document.addEventListener('keydown', function (e) {
      if (active) return;
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'v' && e.key !== 'V') return;
      e.preventDefault();
      open();
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

    readTint();
    buildDock();
    bindUi();

    // 帧门登记。返回 0 时主循环会把自己停掉，不需要帧的时候不烧 CPU。
    if (global.Stage && Stage.gate) Stage.gate(GATE, targetFps, tick);

    // 窗口尺寸与 DPR 不是同步生效的：全屏切换 / 跨屏拖动时 devicePixelRatio
    // 要晚一拍才更新，所以延后补几次（Mineradio 那边的经验值是 48/140/320）。
    function markDirty() { sizeDirty = true; if (active && global.Stage && Stage.kick) Stage.kick(); }
    if (window.ResizeObserver && root) {
      new ResizeObserver(markDirty).observe(root);
    }
    window.addEventListener('resize', function () {
      markDirty();
      [48, 140, 320].forEach(function (d) { setTimeout(markDirty, d); });
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && active && global.Stage) { /* 帧门自己会停机 */ }
      else if (!document.hidden && active && global.Stage && Stage.kick) Stage.kick();
    });
    if (global.Onset && Onset.create) onset = Onset.create({});
    return api;
  }

  function destroy() {
    active = false;
    if (global.Stage && Stage.removeGate) Stage.removeGate(GATE);
    releaseGl();
    inited = false;
    return api;
  }

  var api = {
    init: init,
    destroy: destroy,
    open: open,
    close: close,
    isActive: isActive,
    setStage: function (i) { return setStage(i, false); },
    setStageById: function (id) { return open(id); },
    stageId: function () { return STAGES[stageIndex].id; },
    stages: function () {
      return STAGES.map(function (s) {
        return { id: s.id, label: s.label, desc: s.desc };
      });
    },
    resetView: resetView,
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
