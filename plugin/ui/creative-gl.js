// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 创意舞台的 WebGL2 三维内核。
//
// 与 stage-particles-gl.js 的分工：那一个是「点精灵场」——所有顶点都在屏幕
// 平面上，没有相机、没有深度；本文件是真的三维场景：透视相机、深度缓冲、
// 离屏帧缓冲与后处理链。两者并存，用户可以在工坊里选任意一个作为舞台主渲染。
//
// 三条贯穿全文的设计约束：
//
// 1. **零顶点缓冲**。所有几何都靠 gl_VertexID / gl_InstanceID 在顶点着色器里
//    解析生成（方盒 = 36 个顶点索引、UV 球 = SEG×RING 网格、地形 = N×N 单元）。
//    于是「换一个场景」只是换一个 program + 一个 drawArrays 参数，没有 buffer
//    的创建/销毁/重传，工坊里切预置不会产生显存碎片。
//
// 2. **频谱走纹理，不走 uniform 数组**。64 段频谱每帧写成一张 64×2 的 R8 纹理
//    （第 0 行 = 平滑能量，第 1 行 = 起音包络差），着色器里 texelFetch 取。
//    用 uniform 数组的话每次改段数都要改一遍所有着色器；纹理化之后 32/64/128
//    段对场景是透明的，也不用担心某些驱动对动态下标 uniform 数组的兼容性。
//
// 3. **后处理只用 RGBA8**。浮点渲染目标需要 EXT_color_buffer_float 与
//    OES_texture_float_linear 两个扩展，缺一个就会静默变黑。这里刻意牺牲 HDR
//    动态范围，用加性混合让高光自己饱和，代价是泛光阈值只能取在 LDR 区间——
//    换来的是任何支持 WebGL2 的设备都能跑，不需要探测扩展。
//
// 本文件不主动运行，也不碰任何存储：由 creative-stage.js 每帧喂一个 state 进来。

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------

  // 4x4 矩阵按列主序存 Float32Array(16)，和 GL 的 uniformMatrix4fv 一致。
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
    var zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;
    var xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
    var xl = Math.hypot(xx, xy, xz) || 1;
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

  function mul(out, a, b) {
    for (var c = 0; c < 4; c += 1) {
      var b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return out;
  }

  // 相机滚转：lookAt 之后视线在视图空间指向 -Z，对视图矩阵左乘 Rz
  // 等价于绕相机前向轴旋转（若在世界轴上转，机位本身会被甩偏）。
  // scratch 为调用方持有的矩阵缓存，避免每帧分配。
  function rollView(out, scratch, viewMat, rollRad) {
    var c = Math.cos(rollRad), s = Math.sin(rollRad);
    scratch[0] = c;  scratch[1] = s;  scratch[2] = 0;  scratch[3] = 0;
    scratch[4] = -s; scratch[5] = c;  scratch[6] = 0;  scratch[7] = 0;
    scratch[8] = 0;  scratch[9] = 0;  scratch[10] = 1; scratch[11] = 0;
    scratch[12] = 0; scratch[13] = 0; scratch[14] = 0; scratch[15] = 1;
    mul(out, scratch, viewMat);
    return out;
  }

  // ---------------------------------------------------------------------------
  // 着色器公共前导
  // ---------------------------------------------------------------------------

  // 几何生成：全部靠顶点索引解析，没有任何属性数组。
  // 方盒按 6 个面 × 2 个三角形展开，顶点 v 落在第 v/6 个面、第 v%6 个角上。
  var GEOM = `
vec3 boxVert(int i) {
  int f = i / 6;
  int k = i - f * 6;
  int c = k;
  if (k == 3) c = 0;
  else if (k == 4) c = 2;
  else if (k == 5) c = 3;
  float sx = (c == 0 || c == 3) ? -1.0 : 1.0;
  float sy = (c == 0 || c == 1) ? -1.0 : 1.0;
  if (f == 0) return vec3(sx, sy,  1.0);
  if (f == 1) return vec3(sx, sy, -1.0);
  if (f == 2) return vec3(sx,  1.0, sy);
  if (f == 3) return vec3(sx, -1.0, sy);
  if (f == 4) return vec3( 1.0, sx, sy);
  return vec3(-1.0, sx, sy);
}
vec3 boxNrm(int i) {
  int f = i / 6;
  if (f == 0) return vec3(0.0, 0.0, 1.0);
  if (f == 1) return vec3(0.0, 0.0, -1.0);
  if (f == 2) return vec3(0.0, 1.0, 0.0);
  if (f == 3) return vec3(0.0, -1.0, 0.0);
  if (f == 4) return vec3(1.0, 0.0, 0.0);
  return vec3(-1.0, 0.0, 0.0);
}
vec2 quadVert(int i) {
  int k = i - (i / 6) * 6;
  if (k == 0) return vec2(-1.0, -1.0);
  if (k == 1) return vec2( 1.0, -1.0);
  if (k == 2) return vec2( 1.0,  1.0);
  if (k == 3) return vec2(-1.0, -1.0);
  if (k == 4) return vec2( 1.0,  1.0);
  return vec2(-1.0, 1.0);
}
// UV 球：q = 顶点/6 是四边形序号，拆成 (iu, iv) 后取四个角之一。
vec3 sphereVert(int v, int seg, int ring, out vec3 bary) {
  int q = v / 6;
  int k = v - q * 6;
  int iu = q - (q / seg) * seg;
  int iv = q / seg;
  int du = 0; int dv = 0;
  if (k == 1) du = 1;
  else if (k == 2) { du = 1; dv = 1; }
  else if (k == 3) { du = 0; dv = 0; }
  else if (k == 4) { du = 1; dv = 1; }
  else if (k == 5) { dv = 1; }
  bary = (k == 0 || k == 3) ? vec3(1.0, 0.0, 0.0)
       : (k == 1 || k == 4) ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  float u = float(iu + du) / float(seg);
  float w = float(iv + dv) / float(ring);
  float phi = u * 6.2831853;
  float th = w * 3.14159265;
  return vec3(sin(th) * cos(phi), cos(th), sin(th) * sin(phi));
}
// 地形网格：N×N 个单元，每单元两个三角形。
vec3 gridCell(int v, int n, out vec2 cellXZ, out vec3 bary) {
  int q = v / 6;
  int k = v - q * 6;
  int cx = q - (q / n) * n;
  int cz = q / n;
  int du = 0; int dv = 0;
  // 两个三角形共用 (1,0)–(0,1) 这条对角线；这里的 k→角点必须与下面 bary 的
  // 三个重心角一一对应，否则棱线会画在错误的边上。
  // 每条分支都带花括号：这段在 GEOM 里，五个场景共用的顶点前导。少一个括号
  // 不是"地形坏了"，是"三维全没了"。
  if (k == 1 || k == 3) { du = 1; }
  else if (k == 2 || k == 5) { dv = 1; }
  else if (k == 4) { du = 1; dv = 1; }
  bary = (k == 0 || k == 3) ? vec3(1.0, 0.0, 0.0)
       : (k == 1 || k == 4) ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  cellXZ = vec2(float(cx + du) / float(n), float(cz + dv) / float(n));
  return vec3(cellXZ.x, 0.0, cellXZ.y);
}
`;

  var COMMON = `
// 片段着色器里没有 float 的默认精度（ES 3.00 只在顶点阶段给），不写这一行的话
// 五个场景的片元全都编译不过，而报错只有一句 "No precision specified for (float)"。
// 顶点阶段多写一次是合法的，所以两个阶段共用这一段前导。
precision highp float;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uSeed;
uniform sampler2D uSpec;      // 64x2 R8：v=0.25 平滑带、v=0.75 起音差
uniform vec4 uAgg;            // 低频 / 中低 / 中高 / 高频 聚合
uniform float uPulse;
uniform float uEnergy;
uniform float uPlay;          // 0 停播 1 播放。停播时场景要能自己站住不动
uniform vec2 uRes;
uniform vec3 uColorA;
uniform vec3 uColorB;

// 段号归一化到 0–1 取带能量。
float bandAt(float u) { return texture(uSpec, vec2(clamp(u, 0.0, 1.0), 0.25)).r; }
float riseAt(float u) { return texture(uSpec, vec2(clamp(u, 0.0, 1.0), 0.75)).r; }
float bandIx(int i, int n) { return bandAt((float(i) + 0.5) / float(n)); }

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
vec3 hash31(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash11(i.x + i.y * 57.0);
  float b = hash11(i.x + 1.0 + i.y * 57.0);
  float c = hash11(i.x + (i.y + 1.0) * 57.0);
  float d = hash11(i.x + 1.0 + (i.y + 1.0) * 57.0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
vec3 paletteMix(float t) { return mix(uColorA, uColorB, clamp(t, 0.0, 1.0)); }
`;

  // ---------------------------------------------------------------------------
  // 场景定义
  //
  // 每个场景 = 一个顶点着色器 + 一个片元着色器 + 一次 drawArrays(Instanced)。
  // `geom` 决定画什么、画多少；`uniforms` 是本场景额外要的 uniform；`setup`
  // 把它们从 state.p 里读出来塞进 GL。参数名与工坊面板一一对应（见
  // creative-stage.js 的 SCENE_PARAMS）。
  // ---------------------------------------------------------------------------

  var SCENES = [];
  function scene(def) { SCENES.push(def); return def; }

  // --- 1. 频谱塔林 -----------------------------------------------------------
  // 64 根柱体排成一条走廊。高度来自频谱，光晕来自起音差；地面是同一批柱体
  // 沿 y 翻转、压暗后的第二次绘制（比再加一份反射 buffer 便宜得多）。
  scene({
    id: 'towers',
    label: '频谱塔林',
    geom: { mode: 'TRIANGLES', verts: 36, instances: 64 },
    qualityGeom: [
      { verts: 36, instances: 32 },
      { verts: 36, instances: 48 },
      { verts: 36, instances: 64 }
    ],
    depth: true,
    blend: 'surface',
    uniforms: ['uCount', 'uSpan', 'uHeight', 'uWidth', 'uDepth', 'uAlphaK'],
    defaults: { span: 24, height: 5.5, width: 0.10, depth: 0.16, mirror: 0.16 },
    decl: `
uniform int uCount;
uniform float uSpan; uniform float uHeight; uniform float uWidth; uniform float uDepth;
uniform float uAlphaK;
`,
    vert: GEOM + `
out vec3 vN; out vec3 vW; out float vGlow; out float vId;
void main() {
  int id = gl_InstanceID;
  int n = uCount;
  vec3 lp = boxVert(gl_VertexID);
  vec3 ln = boxNrm(gl_VertexID);

  float u = (float(id) + 0.5) / float(n);
  float b = bandIx(id, n);
  float r = riseAt(u);

  float h = 0.22 + b * uHeight * 0.9 + r * uHeight * 0.12;
  // 柱体沿 x 排开，z 上做一点正弦错位，避免一眼看穿是"一排"。
  float x = (u - 0.5) * uSpan;
  float z = sin(u * 6.2831853 + uSeed * 6.28) * 0.7;

  vec3 scale = vec3(min(uWidth, uSpan / float(n) * 0.32), h * 0.5, uDepth * 0.65);
  // y 从 0 长到 h：底面贴地，所以倒影那一趟只需把模型矩阵沿 y 翻过去，
  // 不必再算一次基准高度差。
  vec3 p = vec3(x + lp.x * scale.x, lp.y * scale.y + h * 0.5, z + lp.z * scale.z);

  vec3 world = (uModel * vec4(p, 1.0)).xyz;
  vN = normalize((uModel * vec4(ln, 0.0)).xyz);
  vW = world;
  vGlow = 0.25 + b * 0.48 + r * 0.16;
  vId = u;
  gl_Position = uViewProj * vec4(world, 1.0);
}`,
    frag: `
in vec3 vN; in vec3 vW; in float vGlow; in float vId;
out vec4 frag;
void main() {
  vec3 V = normalize(uCamPos - vW);
  vec3 N = normalize(vN);
  float fres = pow(1.0 - abs(dot(N, V)), 2.6);
  // 有明暗面的细柱；表面写深度，背面不再重复累积亮度。
  float light = 0.42 + max(dot(N, normalize(vec3(-0.4, 0.8, 0.6))), 0.0) * 0.38;
  vec3 c = paletteMix(vId * 0.72 + 0.12) * (light + vGlow * 0.32 + fres * 0.10);
  c += paletteMix(0.8) * max(N.y, 0.0) * 0.12;
  float a = uAlphaK * exp(-max(-vW.y, 0.0) * 0.8);
  frag = vec4(c * a, a);
}`,
    setup: function (gl, U, S) {
      var q = qualityOf(S);
      gl.uniform1i(U.uCount, [32, 48, 64][q]);
      gl.uniform1f(U.uSpan, S.p.span);
      gl.uniform1f(U.uHeight, S.p.height);
      gl.uniform1f(U.uWidth, S.p.width);
      gl.uniform1f(U.uDepth, S.p.depth);
      gl.uniform1f(U.uAlphaK, 1);
    },
    // 倒影：模型矩阵沿 y 镜像后再画一遍，强度由 p.mirror 控制。
    // 不做真正的平面反射（那要多渲染一整趟），只是把同一份几何翻到地面以下
    // 并压暗——在这个"全是光"的场景里，两者在观感上没有区别。
    extraPasses: function (gl, U, S, eng, drawIt) {
      if (!(S.p.mirror > 0.01)) return;
      gl.uniform1f(U.uAlphaK, S.p.mirror * 0.5);
      gl.uniformMatrix4fv(U.uModel, false, eng.mirrorMat);
      drawIt();
      gl.uniformMatrix4fv(U.uModel, false, eng.identity);
      gl.uniform1f(U.uAlphaK, 1);
    }
  });

  // --- 2. 频谱球 -------------------------------------------------------------
  // 平滑频谱驱动轻微径向呼吸，连续纬线保留球体轮廓。
  scene({
    id: 'orb',
    label: '频谱球',
    geom: { mode: 'TRIANGLES', verts: 40 * 24 * 6, instances: 1 },
    qualityGeom: [
      { verts: 24 * 14 * 6, instances: 1 },
      { verts: 32 * 20 * 6, instances: 1 },
      { verts: 40 * 24 * 6, instances: 1 }
    ],
    qualityDefs: function (q) {
      var seg = [24, 32, 40][q], ring = [14, 20, 24][q];
      return '#define Q_SEG ' + seg + '\n#define Q_RING ' + ring + '\n';
    },
    depth: true,
    blend: 'surface',
    uniforms: ['uRadius', 'uAmp', 'uWire', 'uWobble'],
    defaults: { radius: 3.0, amp: 0.65, wire: 0.42, wobble: 0.22 },
    decl: `
uniform float uRadius; uniform float uAmp; uniform float uWire; uniform float uWobble;
`,
    vert: GEOM + `
const int SEG = Q_SEG;
const int RING = Q_RING;
out vec3 vN; out vec3 vW; out float vLatitude; out float vE;
void main() {
  vec3 bary;
  vec3 dir = sphereVert(gl_VertexID, SEG, RING, bary);
  float u = acos(clamp(dir.y, -1.0, 1.0)) / 3.14159265;
  float e = (bandAt(u - 0.025) + bandAt(u) * 2.0 + bandAt(u + 0.025)) * 0.25;
  float r = uAmp * (e * 0.32 + uAgg.x * 0.12);
  // 切向抖动用半球噪声，避免位移只沿法线、看起来像单纯放大。
  float w = vnoise(vec2(u * 5.0, uTime * 0.12 + uSeed)) - 0.5;
  vec3 p = dir * (uRadius + r + w * uWobble * 0.2);
  vN = normalize(dir);
  vLatitude = u;
  vE = e;
  vW = (uModel * vec4(p, 1.0)).xyz;
  gl_Position = uViewProj * vec4(vW, 1.0);
}`,
    frag: `
in vec3 vN; in vec3 vW; in float vLatitude; in float vE;
out vec4 frag;
void main() {
  vec3 V = normalize(uCamPos - vW);
  float fres = pow(1.0 - abs(dot(normalize(vN), V)), 3.0);
  float e = vE;
  // 连续纬线代替发白的三角面，屏幕导数保持细线在各档画质下清楚。
  float latitude = vLatitude * 32.0;
  float edge = abs(fract(latitude + 0.5) - 0.5);
  float aa = max(fwidth(latitude), 0.018);
  float wire = (1.0 - smoothstep(aa * 0.35, aa * 1.2, edge)) * uWire;
  vec3 c = paletteMix(0.18 + vLatitude * 0.65) * (0.045 + e * 0.035 + wire * 1.6 + fres * 0.30);
  frag = vec4(c, 1.0);
}`,
    setup: function (gl, U, S) {
      gl.uniform1f(U.uRadius, S.p.radius);
      gl.uniform1f(U.uAmp, S.p.amp);
      gl.uniform1f(U.uWire, S.p.wire);
      gl.uniform1f(U.uWobble, S.p.wobble);
    }
  });

  // --- 3. 光隧道 -------------------------------------------------------------
  // 连续细光环沿 z 轴缓缓推进；低频只轻微改变半径。
  scene({
    id: 'tunnel',
    label: '光隧道',
    geom: { mode: 'TRIANGLES', verts: 64 * 6, instances: 32 },
    qualityGeom: [
      { verts: 64 * 6, instances: 18 },
      { verts: 64 * 6, instances: 24 },
      { verts: 64 * 6, instances: 32 }
    ],
    depth: true,
    blend: 'add',
    uniforms: ['uCount', 'uRingRadius', 'uRingLen', 'uSpread', 'uPush'],
    defaults: { ringRadius: 4.2, ringLen: 28, spread: 0.65, push: 2.4 },
    decl: `
uniform int uCount;
uniform float uRingRadius; uniform float uRingLen; uniform float uSpread; uniform float uPush;
`,
    vert: GEOM + `
out vec2 vUV; out float vId; out float vDepth; out vec3 vW;
void main() {
  int n = uCount;
  int id = gl_InstanceID;
  vec2 q = quadVert(gl_VertexID % 6);
  float lane = float(id) / float(n);
  // z 随时间向前推进并取小数回绕：一个实例飞出视锥就自动接回远端。
  // 速度只依赖推进力，避免瞬时能量变化乘上累计时间后让所有环突然跳位。
  float speed = 0.012 + uPush * 0.003;
  float z = fract(lane - uTime * speed);
  float zz = z * uRingLen;
  float segment = float(gl_VertexID / 6);
  float ang = (segment + q.x * 0.5 + 0.5) / 64.0 * 6.2831853;
  float rad = uRingRadius * (0.94 + uAgg.x * 0.08 + uPulse * 0.025)
            + sin(ang * 3.0 + uSeed) * 0.08;
  // 每个实例一圈连续细光环，宽度只改变线厚，不把高能量展开成大面片。
  float thickness = 0.012 + uSpread * 0.035;
  vec3 p = vec3(vec2(cos(ang), sin(ang)) * (rad + q.y * thickness), -uRingLen + zz);
  p.xy += vec2(sin(z * 3.0 + uTime * 0.06), cos(z * 2.0 + uTime * 0.05)) * 0.16;
  vUV = q * 0.5 + 0.5;
  vId = lane;
  vDepth = z;
  vW = (uModel * vec4(p, 1.0)).xyz;
  gl_Position = uViewProj * vec4(vW, 1.0);
}`,
    frag: `
in vec2 vUV; in float vId; in float vDepth; in vec3 vW;
out vec4 frag;
void main() {
  float b = bandAt(vId);
  float r = riseAt(vId);
  // 光环两侧软化，远近端淡出后再回绕。
  float soft = 1.0 - smoothstep(0.25, 0.5, abs(vUV.y - 0.5));
  float fade = smoothstep(0.0, 0.12, vDepth) * (1.0 - smoothstep(0.8, 1.0, vDepth));
  vec3 c = paletteMix(0.25 + vDepth * 0.55) * (0.65 + b * 0.25 + r * 0.12);
  float a = soft * fade * (0.32 + b * 0.20 + r * 0.10);
  a = min(a, 0.42);
  frag = vec4(c * a, a);
}`,
    setup: function (gl, U, S) {
      var q = qualityOf(S);
      gl.uniform1i(U.uCount, [18, 24, 32][q]);
      gl.uniform1f(U.uRingRadius, S.p.ringRadius);
      gl.uniform1f(U.uRingLen, S.p.ringLen);
      gl.uniform1f(U.uSpread, S.p.spread);
      gl.uniform1f(U.uPush, S.p.push);
    }
  });

  // --- 4. 星云 -------------------------------------------------------------
  // 三维点云的轨道。每个点的轨道半径/倾角/相位由实例号哈希出来，位置在顶点
  // 着色器里解析求值 —— CPU 每帧只更新十来个 uniform。
  scene({
    id: 'nebula',
    label: '星云',
    geom: { mode: 'POINTS', verts: 1, instances: 24000 },
    qualityGeom: [
      { verts: 1, instances: 8000 },
      { verts: 1, instances: 16000 },
      { verts: 1, instances: 24000 }
    ],
    depth: true,
    blend: 'add',
    uniforms: ['uCount', 'uCloudR', 'uSpread3', 'uSize', 'uSpin', 'uDensityK'],
    defaults: { cloudR: 6.0, spread3: 1.6, size: 1.25, spin: 0.18, densityK: 0.8 },
    decl: `
uniform int uCount;
uniform float uCloudR; uniform float uSpread3; uniform float uSize;
uniform float uSpin; uniform float uDensityK;
`,
    vert: GEOM + `
out float vG; out float vTint; out float vSeed;
void main() {
  float i = float(gl_InstanceID);
  vec3 h = hash31(i * 0.7311 + uSeed * 13.0);
  vec3 h2 = hash31(i * 1.9137 + 7.0 + uSeed * 5.0);
  float n = float(uCount);
  float u = (i + 0.5) / n;

  // 参考带：每个点归属一段频谱，轨道半径与高度都由那一段的能量决定。
  float b = bandAt(fract(u * 3.0));
  float r = uCloudR * (0.18 + pow(h.x, 0.7) * 0.95) * (0.94 + b * 0.12);
  float spin = uSpin * (0.35 + 0.5 / (0.6 + r * 0.35));
  // 旋臂：相位随半径扭转。同心圆轨道和"银河"之间就差这一项——
  // 内圈与外圈的角速度差把圆拉成螺旋，点云立刻读出"星云"而不是"星环"。
  float arm = floor(h.y * 3.0);
  float ang = arm * 2.0943951 + r * 0.52 + (fract(h.y * 3.0) - 0.5) * 0.8 + uTime * spin * 0.16;
  float tilt = (h2.z - 0.5) * uSpread3;
  vec3 p = vec3(cos(ang) * r, tilt * (0.5 + h2.x * 1.6), sin(ang) * r);
  // 轨道面上的抖动，避免看出是"几层同心圆"。
  p += (hash31(i * 0.377 + 3.0) - 0.5) * (0.35 + b * 0.2);

  vec3 world = (uModel * vec4(p, 1.0)).xyz;
  vec4 clip = uViewProj * vec4(world, 1.0);
  float dist = length(uCamPos - world);
  // 小点保留星尘细节，同时限制近镜头的填充率。
  float ps = clamp(uSize * (0.85 + b * 0.35) * 24.0 / max(dist, 2.0), 1.35, 8.0);
  gl_PointSize = ps;
  vG = (0.18 + b * 0.28 + riseAt(fract(u * 3.0)) * 0.12) * uDensityK;
  vTint = h.z;
  vSeed = i;
  gl_Position = clip;
}`,
    frag: `
in float vG; in float vTint; in float vSeed;
out vec4 frag;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r = length(q) * 2.0;
  if (r >= 1.0) discard;
  float a = (1.0 - smoothstep(0.0, 1.0, r)) * (1.0 - smoothstep(0.25, 1.0, r));
  float g = vG * (0.9 + 0.1 * sin(uTime * 0.5 + vSeed * 0.37));
  // 颜色随能量偏移：安静的星云是一个色调，炸起来的星云往 uColorB 偏。
  vec3 c = paletteMix(clamp(vTint * 0.72 + g * 0.13, 0.0, 1.0));
  float star = mix(0.65, 2.2, pow(fract(vSeed * 0.61803), 8.0));
  float o = a * (0.12 + g * 0.55) * star;
  // 限制单颗亮星的贡献，旋臂之间保留暗部。
  o = min(o, 0.42);
  frag = vec4(c * o, o);
}`,
    setup: function (gl, U, S) {
      var q = qualityOf(S);
      gl.uniform1i(U.uCount, [8000, 16000, 24000][q]);
      gl.uniform1f(U.uCloudR, S.p.cloudR);
      gl.uniform1f(U.uSpread3, S.p.spread3);
      gl.uniform1f(U.uSize, S.p.size);
      gl.uniform1f(U.uSpin, S.p.spin);
      gl.uniform1f(U.uDensityK, S.p.densityK);
    }
  });

  // --- 5. 频谱地形 -----------------------------------------------------------
  // 网格高度场。高度 = 沿 z 方向铺开的频谱 × 时间滚动，所以看上去像"声音
  // 在往前流动"。网格留在原地，只滚动采样相位。
  scene({
    id: 'terrain',
    label: '频谱地形',
    geom: { mode: 'TRIANGLES', verts: 72 * 72 * 6, instances: 1 },
    qualityGeom: [
      { verts: 36 * 36 * 6, instances: 1 },
      { verts: 54 * 54 * 6, instances: 1 },
      { verts: 72 * 72 * 6, instances: 1 }
    ],
    qualityDefs: function (q) {
      var n = [36, 54, 72][q];
      return '#define Q_N ' + n + '\n';
    },
    depth: true,
    blend: 'surface',
    uniforms: ['uExtent', 'uAmp2', 'uScroll', 'uWire2'],
    defaults: { extent: 24, amp2: 1.8, scroll: 0.22, wire2: 0.42 },
    // 网格分辨率 N 是编译期常量而不是 uniform：地形用 gl_VertexID 反解出
    // 单元坐标，N 参与整数除法与取模，放在着色器里算比每帧传进来更省事，
    // 也让顶点数在上屏之前就固定下来（工坊里看得见的"顶点数"才是真的）。
    decl: `
uniform float uExtent; uniform float uAmp2;
uniform float uScroll; uniform float uWire2;
`,
    vert: GEOM + `
const int N = Q_N;
out vec3 vW; out vec2 vGrid; out float vH; out vec3 vN; out float vZ;
void main() {
  vec2 cxz; vec3 bary;
  gridCell(gl_VertexID, N, cxz, bary);
  float x = (cxz.x - 0.5) * uExtent;
  float z = (cxz.y - 0.5) * uExtent;
  // 沿 z 的滚动用 fract 包住，保证采样索引永远在 0–1 内。
  float scroll = cxz.y + uTime * uScroll * 0.08;
  float zz = fract(scroll) * 0.5 + 0.12;
  float e = (bandAt(zz - 0.03) + bandAt(zz) * 2.0 + bandAt(zz + 0.03)) * 0.25;
  float n = vnoise(vec2(cxz.x * 4.0, cxz.y * 4.0 + uTime * uScroll * 0.2));
  float h = (e * 0.6 + (n - 0.5) * 0.8) * uAmp2 + uAgg.x * 0.12;
  h *= smoothstep(0.0, 0.18, cxz.y) * smoothstep(1.0, 0.75, cxz.y);
  vH = e;
  vGrid = cxz;
  // 片元里那道扫描波用的是这个滚动相位，不是网格坐标：地形在滚，波要跟着
  // 贴在地面上走，否则看起来是"一层玻璃罩子在自己动"。
  vZ = scroll;
  vec3 lp = vec3(x, h - 1.2, z);
  vW = (uModel * vec4(lp, 1.0)).xyz;
  vN = normalize(vec3(-(vnoise(vec2(cxz.x * 4.0 + 0.08, cxz.y * 4.0 + uTime * uScroll * 0.2)) - n) * 4.0,
                      1.0,
                      -(e - bandAt(zz + 0.05)) * 6.0));
  gl_Position = uViewProj * vec4(vW, 1.0);
}`,
    frag: `
in vec3 vW; in vec2 vGrid; in float vH; in vec3 vN; in float vZ;
out vec4 frag;
void main() {
  vec2 grid = vGrid * 32.0;
  vec2 edge = abs(fract(grid + 0.5) - 0.5) / max(fwidth(grid), vec2(0.001));
  float wire = (1.0 - smoothstep(0.35, 1.0, min(edge.x, edge.y))) * uWire2;
  vec3 V = normalize(uCamPos - vW);
  float fres = pow(1.0 - abs(dot(normalize(vN), V)), 3.0);
  vec3 c = paletteMix(0.2 + vH * 0.65) * (0.025 + wire * (0.75 + vH * 0.30) + fres * 0.025);
  // 节拍行波：鼓点一下，一道亮带沿 z 滚过去。频谱让地形"有形状"，
  // 这道波让地形"有节拍"。
  float wave = exp(-pow((fract(vZ * 2.0 - uTime * 0.45) - 0.5) * 7.0, 2.0));
  c += paletteMix(0.8) * wave * uPulse * wire * 0.10;
  float fade = smoothstep(0.0, 0.12, vGrid.x) * (1.0 - smoothstep(0.88, 1.0, vGrid.x))
             * smoothstep(0.0, 0.12, vGrid.y) * (1.0 - smoothstep(0.8, 1.0, vGrid.y));
  frag = vec4(c * fade, fade);
}`,
    setup: function (gl, U, S) {
      gl.uniform1f(U.uExtent, S.p.extent);
      gl.uniform1f(U.uAmp2, S.p.amp2);
      gl.uniform1f(U.uScroll, S.p.scroll);
      gl.uniform1f(U.uWire2, S.p.wire2);
    }
  });

  // --- 6. 三维歌词 -----------------------------------------------------------
  // 九张文字面片上下排开，当前行锚在原点，前后句都退向 -z 深处。
  // 文字本身由 lyric3d.js
  // 烘进图集纹理，这里每帧
  // 只做「按实例摆面片 + 采样图集」，与其它场景同构（零顶点缓冲、加性混合、
  // RGBA8 后处理）。
  scene({
    id: 'lyric',
    label: '三维歌词',
    geom: { mode: 'TRIANGLES', verts: 6, instances: 9 },
    depth: true,
    blend: 'add',
    // 文字是密集团块：1/4 分辨率的粗光晕会把一整行字平均成实心白条。
    // 场景级泛光折扣——字形保留，只留紧贴笔画的细辉光，不把整行糊成棒。
    bloomScale: 0.25,
    // 字形需要阅读对比度；提亮发生在泛光提取之后，不扩大笔画光晕。
    exposureScale: 2.4,
    uniforms: ['uLyricTex', 'uSpacing', 'uArc', 'uPWidth', 'uDimK', 'uBob', 'uTint'],
    defaults: { spacing: 2.5, arc: 0.65, pwidth: 16, dimK: 0.48, bob: 0.18, tint: 0.5 },
    decl: `
uniform sampler2D uLyricTex; uniform float uSpacing; uniform float uArc; uniform float uPWidth;
uniform float uDimK; uniform float uBob; uniform float uTint;
`,
    vert: GEOM + `
out vec2 vUV; out float vCell; out float vRel;
void main() {
  vec2 q = quadVert(gl_VertexID);
  float cell = float(gl_InstanceID);
  float rel = cell - 4.0;
  // 前后句都退向远处；行距跟随文字尺寸，不再把多句钳在相同近景深度。
  float z = -abs(rel) * uSpacing * 0.55;
  float x = sin(rel * 0.24) * uArc * 0.35;
  // 当前行随节拍轻推。
  float pw = uPWidth * (rel == 0.0 ? 1.0 + uPulse * 0.012 : 1.0);
  float ph = pw / 5.3333;               // 图集条带的宽高比 1024/192
  float lineStep = max(uSpacing, uPWidth / 5.3333 * 0.85);
  float y = -rel * lineStep + sin(uTime * 0.45) * uBob * 0.06;
  vec3 p = vec3(x + q.x * pw * 0.5, y + q.y * ph * 0.5, z);
  vUV = q * 0.5 + 0.5;
  vCell = cell;
  vRel = rel;
  vec3 world = (uModel * vec4(p, 1.0)).xyz;
  gl_Position = uViewProj * vec4(world, 1.0);
}`,
    frag: `
in vec2 vUV; in float vCell; in float vRel;
out vec4 frag;
void main() {
  // 图集条带：texImage2D 不做 flip，源图首行对应 v=0，所以条带顶 = vCell/9；
  // vUV.y=0 在面片底，取 1-vUV.y。
  float v0 = vCell / 9.0;
  float v1 = (vCell + 1.0) / 9.0;
  vec4 t = texture(uLyricTex, vec2(vUV.x, mix(v0, v1, 1.0 - vUV.y)));
  float isAct = vRel == 0.0 ? 1.0 : 0.0;
  // 远句距离淡变：|rel| 1.5 以内满，4.5 以上无。
  float fade = 1.0 - smoothstep(1.5, 4.5, abs(vRel));
  vec3 activeCol = mix(vec3(1.0), uColorA, uTint);
  activeCol = mix(activeCol, uColorB, uEnergy * 0.35);
  vec3 quietCol = mix(uColorA, uColorB, 0.5) * sqrt(uDimK);
  vec3 c = mix(quietCol, activeCol, isAct);
  float a = t.a * mix(fade * (0.55 + uDimK * 0.6), 1.0, isAct);
  // 与其它场景一致的加性约定：rgb 预乘 alpha。
  frag = vec4(c * a, a);
}`,
    setup: function (gl, U, S) {
      gl.uniform1i(U.uLyricTex, 1);
      gl.uniform1f(U.uSpacing, S.p.spacing);
      gl.uniform1f(U.uArc, S.p.arc);
      gl.uniform1f(U.uPWidth, S.p.pwidth);
      gl.uniform1f(U.uDimK, S.p.dimK);
      gl.uniform1f(U.uBob, S.p.bob);
      gl.uniform1f(U.uTint, S.p.tint);
    }
  });

  // ---------------------------------------------------------------------------
  // 后处理
  // ---------------------------------------------------------------------------

  var POST_VS = `#version 300 es
precision highp float;
out vec2 vUV;
void main() {
  int k = gl_VertexID - (gl_VertexID / 6) * 6;
  vec2 p;
  if (k == 0) p = vec2(-1.0, -1.0);
  else if (k == 1) p = vec2(1.0, -1.0);
  else if (k == 2) p = vec2(1.0, 1.0);
  else if (k == 3) p = vec2(-1.0, -1.0);
  else if (k == 4) p = vec2(1.0, 1.0);
  else p = vec2(-1.0, 1.0);
  vUV = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

  // 亮部提取：只留超过阈值的部分，作为泛光源。
  var BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uThresh;
uniform float uKnee;
out vec4 frag;
void main() {
  vec3 c = texture(uTex, vUV).rgb;
  float l = max(max(c.r, c.g), c.b);
  float w = smoothstep(uThresh, uThresh + uKnee, l);
  frag = vec4(c * w, 1.0);
}`;

  // 可分离高斯：一次只做一个方向，两趟拼成二维模糊。
  var BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uDir;      // 已乘上 1/分辨率
out vec4 frag;
void main() {
  // 9 抽样高斯，权重 1,4,7,10,13 —— 够平滑，比 13 抽样省一半带宽。
  float w[5]; w[0] = 0.0489; w[1] = 0.1216; w[2] = 0.2072; w[3] = 0.2420;
  vec3 acc = texture(uTex, vUV).rgb * 0.1804;
  for (int i = 1; i <= 4; i += 1) {
    vec2 o = uDir * float(i);
    acc += texture(uTex, vUV + o).rgb * w[i - 1];
    acc += texture(uTex, vUV - o).rgb * w[i - 1];
  }
  frag = vec4(acc, 1.0);
}`;

  // 合成：泛光 + 色散 + 暗角 + 颗粒 + 手绘描边 + 纸张 + 调色。
  var COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uBloom2;   // 1/4 分辨率的粗光晕（空气感那一级）
uniform vec2 uTexel;
uniform float uBloomK;
uniform float uBloom2K;
uniform float uChroma;
uniform float uVignette;
uniform float uGrain;
uniform float uToon;        // >0 时走手绘描边
uniform float uPaper;
uniform float uExposure;
uniform float uSaturation;
uniform int uGrade;         // 0 原色 1 双色 2 单色 3 霓虹
uniform float uTime;
uniform vec3 uColorA;
uniform vec3 uColorB;
out vec4 frag;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float h11(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Reinhard 扩展式 tone mapping：白点以上的能量按 x/(1+x) 压回来。
//
// 为什么必须有它：这个场景全程加性混合（ONE, ONE），64 根柱体再叠一次倒影，
// 离屏缓冲的 rgb 本来就远超 1.0。以前末端只有 clamp(c, 0, 1) —— 那不是
// 高光压缩，是"截断"。凡是超过 1 的通道一律变成 1.0，于是所有过曝区域
// 都收敛到同一个纯白，画面丢掉全部结构，只剩一块白团。
//
// 关键差别在预览小画布上尤其致命：主舞台是整屏，1/4 分辨率的粗光晕
// target 还有几百像素，能分辨出"光从几何体上溢出来"的结构；面板内
// 预览只有约 324px 宽，粗光晕 target 掉到 81x50，高斯核在这个尺寸下
// 等效于全屏均匀提升 —— 再叠上 clamp 截断，结果就是一整块纯白。
// 有了这条曲线，过曝区是"变亮但仍有层次"，不是"什么都没有"。
vec3 tonemap(vec3 c) { return c / (1.0 + c); }

void main() {
  // 径向色散：以画面中心为原点，R/B 通道分别向外/向内偏移。
  vec2 d = vUV - 0.5;
  float k = uChroma * 0.0022;
  vec3 c;
  c.r = texture(uScene, vUV + d * k).r;
  c.g = texture(uScene, vUV).g;
  c.b = texture(uScene, vUV - d * k).b;

  // 场景是不透明的"光"，不是不透明的"面"：把离屏缓冲的 alpha 当作覆盖度带出来，
  // 于是画布背后自定义背景层仍然看得见，泛光还能溢到没有几何的地方。
  // 手绘模式例外——铅笔稿要压在纸上，那就必须是实心的。
  float cover = texture(uScene, vUV).a;
  float solid = clamp(max(uToon, uPaper) * 1.4, 0.0, 1.0);
  float outA = mix(clamp(cover * 1.35, 0.0, 1.0), 1.0, solid);

  vec3 bloom = texture(uBloom, vUV).rgb;
  c += bloom * uBloomK;
  // 第二级泛光：1/4 分辨率的粗光晕。半分辨率那级负责"锐利的辉光"，
  // 这一级负责"空气感"——光从几何体上溢出来、铺满周围空间的观感
  // 主要靠它。只跑 1/16 的像素量，代价远低于观感收益。
  c += texture(uBloom2, vUV).rgb * uBloom2K;

  // 手绘描边：3x3 Sobel 取亮度梯度，阈值化后叠成墨线。
  if (uToon > 0.001) {
    float gx = 0.0; float gy = 0.0;
    for (int y = -1; y <= 1; y += 1) {
      for (int x = -1; x <= 1; x += 1) {
        vec2 o = vec2(float(x), float(y)) * uTexel * 1.6;
        float l = luma(texture(uScene, vUV + o).rgb);
        gx += l * float(x);
        gy += l * float(y);
      }
    }
    float g = length(vec2(gx, gy));
    // 描边本身带抖动，配合手绘层才像铅笔而不是 PS 滤镜。
    float jit = (h11(floor(vUV * 420.0)) - 0.5) * 0.6;
    float ink = smoothstep(0.55 + jit * 0.25, 0.95, g) * uToon;
    c = mix(c, vec3(0.05, 0.045, 0.04), ink * 0.85);
  }

  // 纸张：细纤维 + 低频斑块。乘性叠加，不改变色相。
  if (uPaper > 0.001) {
    float fib = h11(floor(vUV * vec2(900.0, 240.0))) ;
    float blot = h11(floor(vUV * 6.0) + 3.7);
    float p = 0.94 + fib * 0.07 + (blot - 0.5) * 0.09;
    c *= mix(1.0, p, uPaper);
    c += (h11(floor(vUV * 300.0) + uTime * 0.001) - 0.5) * 0.018 * uPaper;
  }

  c *= uExposure;

  // 高光压缩必须在调色之前：grade/saturation/暗角/颗粒全都在 0..1 区间里
  // 设计，喂未压缩的 HDR 值会让霓虹三级色阶全部撞到最亮一档。
  c = tonemap(c);

  float l = luma(c);
  if (uGrade == 1) c = mix(uColorA, uColorB, clamp(l * 1.25, 0.0, 1.0)) * (0.5 + l);
  else if (uGrade == 2) c = vec3(l);
  else if (uGrade == 3) {
    // 霓虹：按亮度做三级色阶，青-洋红-黄。
    vec3 neon = mix(vec3(0.10, 0.95, 1.0), vec3(1.0, 0.15, 0.85), smoothstep(0.2, 0.6, l));
    neon = mix(neon, vec3(1.0, 0.95, 0.35), smoothstep(0.65, 1.0, l));
    c = mix(c, neon * (0.35 + l), 0.62);
  }

  // 颗粒放在调色之后：否则调色会把噪声一起量化掉，颗粒感消失。
  if (uGrain > 0.001) {
    float g = h11(vUV * 900.0 + fract(uTime * 0.07) * 91.0) - 0.5;
    c += g * uGrain * 0.14;
  }

  c = mix(vec3(l), c, uSaturation);

  float vig = 1.0 - uVignette * dot(d, d) * 1.8;
  c *= clamp(vig, 0.0, 1.0);

  // 上下文用 premultipliedAlpha（默认），所以这里给的就是"已乘过 alpha 的颜色"，
  // 与上面加性混合累加出来的 rgb 语义一致，浏览器合成时不会再乘一遍。
  frag = vec4(clamp(c, 0.0, 1.0), outA);
}`;

  // ---------------------------------------------------------------------------
  // 引擎
  // ---------------------------------------------------------------------------

  function isAvailable() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
    } catch (e) { return false; }
  }

  function clampQuality(q, fallback) {
    var n = Number(q);
    if (!isFinite(n)) n = fallback;
    return n < 0 ? 0 : n > 2 ? 2 : n | 0;
  }

  function qualityOf(S) {
    return clampQuality(S && S.quality, 2);
  }

  function geometryFor(def, q) {
    var base = def.geom;
    var pick = (def.qualityGeom && def.qualityGeom[q]) || base;
    return {
      mode: pick.mode || base.mode,
      verts: pick.verts,
      instances: pick.instances || 1
    };
  }

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      // 编译日志要带出来：工坊里有自定义片段的入口，用户改错一行必须能定位。
      var log = gl.getShaderInfoLog(sh) || '未知错误';
      gl.deleteShader(sh);
      throw new Error(log);
    }
    return sh;
  }

  function link(gl, vsSrc, fsSrc) {
    var vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(p) || '链接失败';
      gl.deleteProgram(p);
      throw new Error(log);
    }
    return p;
  }

  // 粗光晕（第二级泛光）target 的短边像素地板。低于这个尺寸，1/4 降采样
  // 的高斯核就不再是"光从几何体上溢出来"，而是一层盖满画面的均匀白雾 ——
  // 面板内的小尺寸预览正好落在这个区间里。详见 resize 里的说明。
  var COARSE_MIN_PX = 96;

  function create(canvas, opts) {
    opts = opts || {};
    var engineQuality = clampQuality(opts.quality, 2);
    var gl = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        depth: true,
        stencil: false,
        powerPreference: 'high-performance'
      });
    } catch (e) { gl = null; }
    if (!gl) return null;

    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    var w = 1, h = 1, dpr = 1;
    var lost = false;
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      lost = true;
    });

    // --- 频谱纹理 -----------------------------------------------------------
    var specTex = gl.createTexture();
    var specPixels = new Uint8Array(64 * 2);
    gl.bindTexture(gl.TEXTURE_2D, specTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 64, 2, 0, gl.RED, gl.UNSIGNED_BYTE, specPixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // --- 歌词图集纹理（TEXTURE1，懒分配）-----------------------------------
    // 图集内容由 window.Lyric3D 生成；只在当前行变化时变像素。
    var lyricTex = gl.createTexture();
    var lyricReady = false;
    var atlasW = 0, atlasH = 0;
    // 本引擎纹理当前内容的签名。不能依赖 Lyric3D 的全局去重：舞台与全屏页各持
    // 一个引擎、一张纹理，却共享同一张图集。一个视图停渲时图集被另一个视图反复
    // 改写；它重新激活的那一帧全局签名恰好相同，全局去重会返回"无变化"，纹理
    // 便停在旧歌词上（表现为从全屏页返回舞台后当前行短时间显示成旧句子）。
    var lyricSig = null;
    function uploadLyric(S) {
      if (!window.Lyric3D) return;
      var q = qualityOf(S);
      window.Lyric3D.setQuality(q);
      var info = window.Lyric3D.size();
      var resized = info.w !== atlasW || info.h !== atlasH;
      var need = window.Lyric3D.sig(S.lyric);
      var changed = false;
      if (resized || need !== lyricSig) {
        lyricSig = need;
        // force：即使全局签名相同也重画图集——图集此刻多半装着另一视图的歌词，
        // 或尺寸刚发生变化。
        changed = window.Lyric3D.frame(S.lyric, true);
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lyricTex);
      if (!lyricReady || resized) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, window.Lyric3D.canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        lyricReady = true;
        atlasW = info.w;
        atlasH = info.h;
      } else if (changed) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, window.Lyric3D.canvas);
      }
      gl.activeTexture(gl.TEXTURE0);
    }

    // --- 渲染目标 -----------------------------------------------------------
    function makeTarget(wp, hp, withDepth) {
      var fbo = gl.createFramebuffer();
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, wp, hp, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      var rb = null;
      if (withDepth) {
        rb = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, wp, hp);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { fbo: fbo, tex: tex, depth: rb, w: wp, h: hp };
    }

    var sceneT = null, brightA = null, brightB = null, brightC = null, brightD = null;

    function disposeTargets() {
      [sceneT, brightA, brightB, brightC, brightD].forEach(function (t) {
        if (!t) return;
        gl.deleteFramebuffer(t.fbo);
        gl.deleteTexture(t.tex);
        if (t.depth) gl.deleteRenderbuffer(t.depth);
      });
      sceneT = brightA = brightB = null;
    }

    // --- program 缓存 -------------------------------------------------------
    var progs = {};       // sceneId -> { prog, U }
    var postProgs = {};

    function sceneProgram(def, quality) {
      var q = clampQuality(quality, engineQuality);
      var key = def.id + ':' + q;
      if (progs[key]) return progs[key];
      // decl 同时前置到两个阶段。某个阶段用不到的 uniform 会被编译器优化掉、
      // location 变 null，uniform*() 传 null 在 WebGL 里是合法的空操作 ——
      // 这样就不必为每个场景维护两份声明列表，也就不会出现"改了声明忘了另一边"。
      var decl = def.decl || '';
      var qualityDefs = def.qualityDefs ? def.qualityDefs(q) : '';
      var prog = link(gl,
        '#version 300 es\n' + qualityDefs + COMMON + decl + def.vert,
        '#version 300 es\n' + COMMON + decl + def.frag);
      var U = collect(prog, ['uViewProj', 'uModel', 'uCamPos', 'uTime', 'uSeed',
        'uSpec', 'uAgg', 'uPulse', 'uEnergy', 'uPlay', 'uRes',
        'uColorA', 'uColorB'].concat(def.uniforms || []));
      var entry = { prog: prog, U: U };
      progs[key] = entry;
      return entry;
    }

    function collect(prog, names) {
      var out = {};
      names.forEach(function (n) { out[n] = gl.getUniformLocation(prog, n); });
      return out;
    }

    function postProgram(key, fsSrc) {
      if (postProgs[key]) return postProgs[key];
      var prog;
      // 与 sceneProgram 不同，这里原先是直接把异常抛出去的：后处理挂一次，
      // 就从 render() 里一路穿出 attach()，用户看到的是"开关拨了没反应"，
      // 而不是可读的降级原因。缓存成失败对象，由 render() 统一转成
      // {ok:false, reason:'shader'}。
      try {
        prog = link(gl, POST_VS, fsSrc);
      } catch (e) {
        var failed = { fail: '后处理 ' + key + '：' + String(e.message || e) };
        postProgs[key] = failed;
        return failed;
      }
      var U = collect(prog, ['uTex', 'uScene', 'uBloom', 'uBloom2', 'uDir', 'uTexel', 'uThresh',
        'uKnee', 'uBloomK', 'uBloom2K', 'uChroma', 'uVignette', 'uGrain', 'uToon', 'uPaper',
        'uExposure', 'uSaturation', 'uGrade', 'uTime', 'uColorA', 'uColorB']);
      var entry = { prog: prog, U: U };
      postProgs[key] = entry;
      return entry;
    }

    // --- 矩阵缓存 -----------------------------------------------------------
    var proj = mat4(), view = mat4(), viewProj = mat4(), rollM = mat4(), rolled = mat4();
    var identity = mat4();
    identity[0] = identity[5] = identity[10] = identity[15] = 1;
    // 沿 y 镜像：倒影用。模型矩阵直接换成它，顶点着色器不用改。
    var mirrorMat = mat4();
    mirrorMat[0] = 1; mirrorMat[5] = -1; mirrorMat[10] = 1; mirrorMat[15] = 1;

    var vsrc = {};

    function resize(wp, hp, d) {
      w = Math.max(1, wp | 0);
      h = Math.max(1, hp | 0);
      dpr = d || 1;
      var bw = Math.max(1, Math.round(w * dpr));
      var bh = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      disposeTargets();
      sceneT = makeTarget(bw, bh, true);
      var hw = Math.max(1, bw >> 1), hh = Math.max(1, bh >> 1);
      brightA = makeTarget(hw, hh, false);
      brightB = makeTarget(hw, hh, false);
      // 第二级泛光链路：1/4 分辨率。两级独立模糊，合成时各乘各的权重。
      //
      // 但 1/4 不能无条件成立：粗光晕的观感来自"光溢出来、铺满周围空间"，
      // 前提是 target 还有足够像素让高斯核分辨出结构。面板内预览只有
      // 约 324px 宽，1/4 之后 target 掉到 81x50 —— 这个尺寸下核半径
      // 覆盖的角度大到等价于全屏均匀提升，粗光晕不再是"光"，而是"一层
      // 均匀的白雾"盖满整个画面。所以这里给一个地板：粗光晕 target 的
      // 短边不低于 COARSE_MIN_PX，不够就退回半分辨率。
      //
      // 退回半分辨率会让这一级的"散"变少（像素更多 = 核覆盖的角度更小），
      // 但那也比整屏糊白好：宁可光晕紧一点，也不要看不见结构。
      var coarseShift = COARSE_MIN_PX * 2 <= Math.min(bw, bh) ? 2 : 1;
      var qw = Math.max(1, bw >> coarseShift), qh = Math.max(1, bh >> coarseShift);
      brightC = makeTarget(qw, qh, false);
      brightD = makeTarget(qw, qh, false);
    }

    function uploadSpectrum(bands, rises) {
      var i;
      for (i = 0; i < 64; i += 1) {
        specPixels[i] = Math.max(0, Math.min(255, (bands[i] || 0) * 255)) | 0;
        specPixels[64 + i] = Math.max(0, Math.min(255, (rises[i] || 0) * 255)) | 0;
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, specTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 2, gl.RED, gl.UNSIGNED_BYTE, specPixels);
    }

    function bindCommon(U, S, def) {
      gl.uniformMatrix4fv(U.uViewProj, false, viewProj);
      // 模型矩阵由编排层算好（绕 Y 旋转 + 整体缩放）。给不出就用单位阵，
      // 这样单独调用本文件做冒烟测试也能出一帧正常画面。
      gl.uniformMatrix4fv(U.uModel, false, S.modelMatrix || identity);
      gl.uniform3f(U.uCamPos, S.eye[0], S.eye[1], S.eye[2]);
      gl.uniform1f(U.uTime, S.t / 1000);
      gl.uniform1f(U.uSeed, S.seed || 0);
      gl.uniform1i(U.uSpec, 0);
      gl.uniform4f(U.uAgg, S.agg[0], S.agg[1], S.agg[2], S.agg[3]);
      gl.uniform1f(U.uPulse, S.pulse);
      gl.uniform1f(U.uEnergy, S.energy);
      gl.uniform1f(U.uPlay, S.play ? 1 : 0);
      gl.uniform2f(U.uRes, w, h);
      gl.uniform3fv(U.uColorA, S.colors[0]);
      gl.uniform3fv(U.uColorB, S.colors[1]);
      if (def && def.setup) def.setup(gl, U, S);
    }

    var fullscreenVerts = 6;

    function render(S) {
      if (lost || !sceneT) return { ok: false, reason: 'context-lost' };
      var def = null;
      for (var i = 0; i < SCENES.length; i += 1) if (SCENES[i].id === S.scene) def = SCENES[i];
      if (!def) return { ok: false, reason: 'unknown-scene' };

      var q = qualityOf(S);
      var entry;
      try {
        entry = sceneProgram(def, q);
      } catch (e) {
        return { ok: false, reason: 'shader', message: String(e.message || e) };
      }

      // --- 相机 ---
      var cam = S.cam;
      // 竖屏按同一构图留白，镜头距离仍可由用户缩放。
      var framedDist = cam.dist * Math.max(1, 1.25 / (w / h));
      var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      var eye = [
        cam.tx + Math.sin(cam.yaw) * cp * framedDist,
        cam.ty + sp * framedDist,
        cam.tz + Math.cos(cam.yaw) * cp * framedDist
      ];
      S.eye = eye;
      perspective(proj, cam.fov * Math.PI / 180, w / h, 0.1, 400);
      lookAt(view, eye[0], eye[1], eye[2], cam.tx, cam.ty, cam.tz, 0, 1, 0);
      // roll 缺省 0：除电影/自由相机外所有调用方不传即完全等价旧路径。
      if (cam.roll) {
        rollView(rolled, rollM, view, cam.roll);
        mul(viewProj, proj, rolled);
      } else {
        mul(viewProj, proj, view);
      }

      uploadSpectrum(S.bands, S.rises);
      if (def.id === 'lyric' && S.lyricVisible !== false) uploadLyric(S);

      // --- 场景渲染到离屏 ---
      var g = geometryFor(def, q);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneT.fbo);
      gl.viewport(0, 0, sceneT.w, sceneT.h);
      gl.clearColor(0, 0, 0, 0);
      gl.depthMask(true);
      if (def.depth) {
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
      } else {
        gl.disable(gl.DEPTH_TEST);
      }
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      gl.useProgram(entry.prog);
      var U = entry.U;
      bindCommon(U, S, def);

      // 实体表面正常遮挡；光点与文字才做加性混合。材质在各场景声明。
      var surface = def.blend === 'surface';
      gl.blendFunc(gl.ONE, surface ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
      gl.depthMask(surface);

      var mode = gl[g.mode];
      function drawIt() {
        if (g.instances > 1) gl.drawArraysInstanced(mode, 0, g.verts, g.instances);
        else gl.drawArrays(mode, 0, g.verts);
      }
      if (def.id !== 'lyric' || S.lyricVisible !== false) drawIt();
      if (def.extraPasses) def.extraPasses(gl, U, S, { mirrorMat: mirrorMat, identity: identity }, drawIt);

      gl.depthMask(true);
      gl.disable(gl.DEPTH_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // --- 后处理 ---
      var P = S.post || {};
      var bloomK = P.bloom === undefined ? 0.9 : P.bloom;
      bloomK *= def && def.bloomScale === undefined ? 1 : def.bloomScale;
      if (bloomK > 0.001) {
        var bri = postProgram('bright', BRIGHT_FS);
        if (bri.fail) return { ok: false, reason: 'shader', message: bri.fail };
        gl.useProgram(bri.prog);
        gl.bindFramebuffer(gl.FRAMEBUFFER, brightA.fbo);
        gl.viewport(0, 0, brightA.w, brightA.h);
        gl.clearColor(0, 0, 0, 0);
        gl.blendFunc(gl.ONE, gl.ZERO);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sceneT.tex);
        gl.uniform1i(bri.U.uTex, 0);
        gl.uniform1f(bri.U.uThresh, P.bloomThresh === undefined ? 0.58 : P.bloomThresh);
        gl.uniform1f(bri.U.uKnee, 0.28);
        gl.drawArrays(gl.TRIANGLES, 0, fullscreenVerts);

        var blur = postProgram('blur', BLUR_FS);
        if (blur.fail) return { ok: false, reason: 'shader', message: blur.fail };
        gl.useProgram(blur.prog);
        gl.uniform1i(blur.U.uTex, 0);
        // 两趟可分离 + 一次额外的横向，等价于把核放大到 2 倍半径，代价只有 1.5 倍。
        for (var pass = 0; pass < 3; pass += 1) {
          var from = (pass === 1) ? brightB : brightA;
          var to = (pass === 1) ? brightA : brightB;
          gl.bindFramebuffer(gl.FRAMEBUFFER, to.fbo);
          gl.viewport(0, 0, to.w, to.h);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.bindTexture(gl.TEXTURE_2D, from.tex);
          var horiz = (pass % 2) === 0;
          var k = (pass === 2) ? 2.4 : 1.0;
          gl.uniform2f(blur.U.uDir,
            horiz ? k / to.w : 0, horiz ? 0 : k / to.h);
          gl.drawArrays(gl.TRIANGLES, 0, fullscreenVerts);
        }
        gl.blendFunc(gl.ONE, gl.ONE);

        // 粗光晕：把半分辨率的结果降到 1/4 分辨率再抹两趟。像素量只有主链的
        // 约 1/16，换来的是"光从几何体上溢出来、铺满周围空间"的空气感 ——
        // 细光晕负责辉光，这一级负责让辉光有体积。目标视口比源纹理小本身就是
        // 一次双线性降采样，所以不需要单独的 downsample pass。
        for (var coarse = 0; coarse < 3; coarse += 1) {
          var cFrom = (coarse === 0) ? brightB : (coarse === 1 ? brightC : brightD);
          var cTo = (coarse === 0) ? brightC : (coarse === 1 ? brightD : brightC);
          gl.bindFramebuffer(gl.FRAMEBUFFER, cTo.fbo);
          gl.viewport(0, 0, cTo.w, cTo.h);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.bindTexture(gl.TEXTURE_2D, cFrom.tex);
          // 第一趟是半分辨率 → 1/4，横向；后两趟在 1/4 上横竖各一次，核半径拉得
          // 比主链宽（低分辨率上同样的核半径覆盖的角度更大，正是我们要的"散"）。
          var axis = (coarse === 2) ? 0 : 1;
          gl.uniform2f(blur.U.uDir,
            axis ? 2.2 / cTo.w : 0, axis ? 0 : 2.2 / cTo.h);
          gl.drawArrays(gl.TRIANGLES, 0, fullscreenVerts);
        }
        gl.blendFunc(gl.ONE, gl.ONE);
      }

      var comp = postProgram('composite', COMPOSITE_FS);
      if (comp.fail) return { ok: false, reason: 'shader', message: comp.fail };
      gl.useProgram(comp.prog);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, sceneT.w, sceneT.h);
      gl.clearColor(0, 0, 0, 0);
      gl.blendFunc(gl.ONE, gl.ZERO);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneT.tex);
      gl.uniform1i(comp.U.uScene, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, (bloomK > 0.001 ? brightB : sceneT).tex);
      gl.uniform1i(comp.U.uBloom, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, (bloomK > 0.001 ? brightC : sceneT).tex);
      gl.uniform1i(comp.U.uBloom2, 2);
      gl.uniform2f(comp.U.uTexel, 1 / sceneT.w, 1 / sceneT.h);
      gl.uniform1f(comp.U.uBloomK, bloomK);
      gl.uniform1f(comp.U.uBloom2K, bloomK > 0.001 ? bloomK * 0.3 : 0);
      gl.uniform1f(comp.U.uChroma, P.chroma === undefined ? 0.3 : P.chroma);
      gl.uniform1f(comp.U.uVignette, P.vignette === undefined ? 0.25 : P.vignette);
      gl.uniform1f(comp.U.uGrain, P.grain === undefined ? 0.18 : P.grain);
      gl.uniform1f(comp.U.uToon, P.toon === undefined ? 0 : P.toon);
      gl.uniform1f(comp.U.uPaper, P.paper === undefined ? 0 : P.paper);
      gl.uniform1f(comp.U.uExposure, (P.exposure === undefined ? 1.12 : P.exposure) * (def.exposureScale || 1));
      gl.uniform1f(comp.U.uSaturation, P.saturation === undefined ? 1.1 : P.saturation);
      gl.uniform1i(comp.U.uGrade, P.grade | 0);
      gl.uniform1f(comp.U.uTime, S.t);
      gl.uniform3fv(comp.U.uColorA, S.colors[0]);
      gl.uniform3fv(comp.U.uColorB, S.colors[1]);
      gl.drawArrays(gl.TRIANGLES, 0, fullscreenVerts);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.activeTexture(gl.TEXTURE0);

      return { ok: true, scene: def.id };
    }

    // 把最后一帧抓成 dataURL，供工坊做预置缩略图。
    // 必须在 render 之后、同一个任务里调用：drawingBuffer 没有 preserve，
    // 跨任务再读就是一张空图。
    function capture(scale) {
      if (!sceneT) return null;
      var wpx = 240, hpx = Math.max(1, Math.round(240 * h / w));
      var out = document.createElement('canvas');
      out.width = wpx; out.height = hpx;
      var ctx = out.getContext('2d');
      // WebGL 的 y 轴朝上，readPixels 出来的行是倒的，靠 2D 的负向缩放翻回来。
      var buf = new Uint8Array(sceneT.w * sceneT.h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneT.fbo);
      gl.readPixels(0, 0, sceneT.w, sceneT.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      var full = document.createElement('canvas');
      full.width = sceneT.w; full.height = sceneT.h;
      var fctx = full.getContext('2d');
      var img = fctx.createImageData(sceneT.w, sceneT.h);
      // 翻转同时把行首 alpha 从 0 补齐到 255：加性混合渲染出来的 alpha 是权重和，
      // 直接塞进 ImageData 会得到一张透明度乱掉的图。
      for (var y = 0; y < sceneT.h; y += 1) {
        var src = (sceneT.h - 1 - y) * sceneT.w * 4;
        var dst = y * sceneT.w * 4;
        for (var x = 0; x < sceneT.w * 4; x += 4) {
          img.data[dst + x] = Math.min(255, buf[src + x] * 2.2);
          img.data[dst + x + 1] = Math.min(255, buf[src + x + 1] * 2.2);
          img.data[dst + x + 2] = Math.min(255, buf[src + x + 2] * 2.2);
          img.data[dst + x + 3] = 255;
        }
      }
      fctx.putImageData(img, 0, 0);
      ctx.drawImage(full, 0, 0, wpx, hpx);
      return out.toDataURL('image/jpeg', 0.62);
    }

    function dispose() {
      disposeTargets();
      Object.keys(progs).forEach(function (k) { gl.deleteProgram(progs[k].prog); });
      Object.keys(postProgs).forEach(function (k) { gl.deleteProgram(postProgs[k].prog); });
      progs = {};
      postProgs = {};
      gl.deleteTexture(specTex);
      gl.deleteTexture(lyricTex);
      var ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }

    // 预编译全部场景：切预置时第一次着色器编译会卡二三百毫秒，而且会打断
    // 正在跑的帧率探测。放在用户还看不到画面的启动阶段一次付清。
    function warmUp() {
      for (var i = 0; i < SCENES.length; i += 1) {
        try { sceneProgram(SCENES[i], engineQuality); } catch (e) { /* 单个场景坏掉不影响其它 */ }
      }
      try { postProgram('bright', BRIGHT_FS); postProgram('blur', BLUR_FS); postProgram('composite', COMPOSITE_FS); }
      catch (e) { /* 同上 */ }
    }

    return {
      gl: gl,
      resize: resize,
      render: render,
      capture: capture,
      warmUp: warmUp,
      dispose: dispose,
      isLost: function () { return lost; },
      size: function () { return { w: w, h: h, dpr: dpr, bw: sceneT ? sceneT.w : 0, bh: sceneT ? sceneT.h : 0 }; }
    };
  }

  window.CreativeGL = {
    isAvailable: isAvailable,
    create: create,
    scenes: function () {
      return SCENES.map(function (s) {
        return { id: s.id, label: s.label, defaults: JSON.parse(JSON.stringify(s.defaults || {})) };
      });
    },
    sceneById: function (id) {
      for (var i = 0; i < SCENES.length; i += 1) if (SCENES[i].id === id) return SCENES[i];
      return null;
    },
    // 场景着色器源码。给两件事用：一是无头校验（着色器里引用了一个从未声明的
    // uniform 时 GL 只在编译期报一句很难定位的话，静态查一遍更早也更清楚），
    // 二是工坊将来的 GLSL 片段编辑器需要拿公共前导去预览编译。
    sceneSource: function (id) {
      var s = null;
      for (var i = 0; i < SCENES.length; i += 1) if (SCENES[i].id === id) s = SCENES[i];
      if (!s) return null;
      return {
        id: s.id,
        common: COMMON,
        geom: GEOM,
        decl: s.decl || '',
        vert: s.vert,
        frag: s.frag,
        uniforms: (s.uniforms || []).slice()
      };
    },
    // 公共前导里的 uniform 名单：无头校验用它区分"已经声明过"与"漏了"。
    commonUniforms: function () {
      var out = [];
      var re = /uniform\s+\w+\s+(\w+)\s*;/g;
      var m;
      while ((m = re.exec(COMMON)) !== null) out.push(m[1]);
      return out;
    },
    postSource: function () {
      return { vs: POST_VS, bright: BRIGHT_FS, blur: BLUR_FS, composite: COMPOSITE_FS };
    },
    // 工坊的自定义片段走这个口子：编译失败会把 GL 的日志原文抛出来，
    // 面板把行号标到编辑器里。
    validateFragment: function (fsSrc) {
      var c = document.createElement('canvas');
      var g = c.getContext('webgl2');
      if (!g) return { ok: false, message: '本设备不支持 WebGL2' };
      try {
        var sh = g.createShader(g.FRAGMENT_SHADER);
        g.shaderSource(sh, '#version 300 es\n' + COMMON + fsSrc);
        g.compileShader(sh);
        var ok = g.getShaderParameter(sh, g.COMPILE_STATUS);
        var log = g.getShaderInfoLog(sh) || '';
        g.deleteShader(sh);
        return { ok: !!ok, message: log };
      } catch (e) {
        return { ok: false, message: String(e.message || e) };
      }
    }
  };
})();
