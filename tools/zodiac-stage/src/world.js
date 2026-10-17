// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 「星座」世界：近黑星空、流动星尘、轮廓边光与星座骨架。
//
// 背景、星尘和辉光按 renderOrder 绘制；微弱底面不写入深度：
//   -1000 天空穹顶      预烘焙银河尘埃 + 屏幕暗角
//    -900 星场           细密星点（加法混合）
//    -890 星云斑块       大尺度柔斑
//    -880 星光点缀       四芒星闪烁（大颗亮星）
//    -100 形象图柔光     造型表面点云，大点径低透明 → 半透明的「体量」
//     -90 形象图底面     微弱受光体积，主体由星尘呈现
//     -82 轮廓边宽晕     外轮廓和孔洞的柔光
//     -80 轮廓边细芯     沿轮廓的细线
//     -78 表面点缀       极低亮度的表面星点
//     -10 主粒子池       汇聚/停留/散开
//      10 星座连线晕     宽丝带柔光
//      11 星座连线芯     细丝带，矢量清晰
//      12 星座星点       四芒星，主星最大
//
// 十二座的全部几何在一次构建里做好（零分配、零 GC、零重建，也不依赖
// three 的 attribute 替换语义），换座只是把九个对象指向另一套几何。
// 预建的几何在 dispose() 里逐个释放 —— 挂在同一个几何上的 attribute 被换掉时
// three 不会回收旧 buffer（弱引用只跟包装对象走），只有「每座一个几何」才收得干净。

import {
  ZODIAC, SIGN_COUNT, buildShape, buildCloud, buildSeeds, buildFigureMesh,
  buildConstellation, CONSTELLATION, CONSTELLATION_Z, FIGURE_Z, FIGURE_MESH_POINTS,
  transitionStyle,
} from './zodiac.js';
import { clamp, seededRandom } from './util.js';

// 归一化改成「落到 1.78 的设计框」之后，横宽的星座比原来大了约 1.8 倍，
// 同样的粒子数摊在更大的面积上会显稀 —— 三个池子跟着上调一档。
const SHAPE_COUNTS = { low: 3200, medium: 5200, high: 7600 };
const FIGURE_COUNTS = { low: 1000, medium: 1700, high: 2600 };
const FIELD_COUNTS = { low: 28000, medium: 64000, high: 120000 };
const SPARKLE_COUNTS = { low: 70, medium: 112, high: 160 };
const NEBULA = 36;
const DISC_SLOTS = 18;   // 单座骨架最多 18 个星点（当前最大 15，留余量）
const STAR_SLOTS = DISC_SLOTS + Math.max(...CONSTELLATION.map(s => s.lines.length));

// 主体与辉光分别定色；次序与 ZODIAC 一致。
const SIGN_COLORS = [
  ['#d96b66', '#ffbaa2'], // 白羊：珊瑚红
  ['#73b890', '#b9f1c4'], // 金牛：翡翠绿
  ['#ddb36d', '#ffedb2'], // 双子：香槟金
  ['#a7bfd0', '#e8efff'], // 巨蟹：月光银
  ['#e6ab51', '#ffe49b'], // 狮子：琥珀金
  ['#a0bb76', '#e1edac'], // 处女：浅草绿
  ['#c794b9', '#f6d0e7'], // 天秤：玫瑰粉
  ['#b76d94', '#f5aecb'], // 天蝎：红紫
  ['#9889d2', '#d7c8ff'], // 射手：星云紫
  ['#66b3a6', '#b0e9d3'], // 摩羯：青玉
  ['#5da5cf', '#b3e5fa'], // 水瓶：冰蓝
  ['#8c87bf', '#d6ccfa'], // 双鱼：淡紫
];

// —— 天空穹顶 ——
// Bake periodic dust once: no per-frame FBM cost or vertex interpolation facets.
function galaxyTexture(THREE, width) {
  const height = width / 2;
  const pixels = new Uint8Array(width * height * 4);
  const hash = (x, y, period) => {
    const wrapped = ((x % period) + period) % period;
    let h = Math.imul(wrapped + 193, 374761393) ^ Math.imul(y + 571, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const noise = (x, y, period) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx *= fx * (3 - 2 * fx); fy *= fy * (3 - 2 * fy);
    const a = hash(ix, iy, period), b = hash(ix + 1, iy, period);
    const c = hash(ix, iy + 1, period), d = hash(ix + 1, iy + 1, period);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  };
  const fbm = (u, v, frequency) => {
    let sum = 0, weight = .5;
    for (let octave = 0; octave < 6; octave++) {
      sum += noise(u * frequency, v * frequency, frequency) * weight;
      frequency *= 2; weight *= .5;
    }
    return sum;
  };
  const grain = seededRandom('zodiac-galactic-dust');
  const normalLength = Math.hypot(.52, .84, .16);
  for (let y = 0; y < height; y++) {
    const v = (y + .5) / height;
    const sinPhi = Math.sin(v * Math.PI), dy = Math.cos(v * Math.PI);
    for (let x = 0; x < width; x++) {
      const u = (x + .5) / width, theta = u * Math.PI * 2;
      const dx = -Math.cos(theta) * sinPhi, dz = Math.sin(theta) * sinPhi;
      const broad = fbm(u, v, 12), detail = fbm(u, v + .37, 48);
      const latitude = (.52 * dx + .84 * dy + .16 * dz) / normalLength + .20;
      const band = Math.exp(-Math.pow(latitude + (broad - .5) * .24, 2) * 38);
      const lane = 1 - Math.pow(clamp((detail - .30) / .36), 1.3) * .94;
      const dust = band * (.25 + broad * .9) * lane * (.68 + grain() * .64);
      const core = band * Math.pow(detail, 3) * .11;
      const k = (y * width + x) * 4;
      pixels[k] = Math.round(255 * (dust * .125 + core));
      pixels[k + 1] = Math.round(255 * (dust * .080 + core * .83));
      pixels[k + 2] = Math.round(255 * (dust * .142 + core * .95));
      pixels[k + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height);
  texture.wrapS = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

const SKY_VERT = [
  'varying float vY;',
  'varying vec2 vUv;',
  'varying vec3 vNdc;',
  'void main() {',
  '  vY = normalize(position).y;',
  '  vUv = vec2(uv.x,1.0-uv.y);',
  '  vec4 pos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '  vNdc = pos.xyw;',
  '  gl_Position = pos;',
  '}',
].join('\n');

const SKY_FRAG = [
  'precision mediump float;',
  'uniform vec3 uTop;',
  'uniform vec3 uMid;',
  'uniform vec3 uBot;',
  'uniform sampler2D uGalaxy;',
  'uniform float uNeb;',
  'uniform float uVignette;',
  'varying float vY;',
  'varying vec2 vUv;',
  'varying vec3 vNdc;',
  'void main() {',
  '  float y = clamp(vY * 0.5 + 0.5, 0.0, 1.0);',
  '  vec3 col = mix(uBot, uMid, smoothstep(0.0, 0.58, y));',
  '  col = mix(col, uTop, smoothstep(0.46, 1.0, y));',
  '  col += texture2D(uGalaxy,vUv).rgb*uNeb;',
  // 暗角：屏幕边缘压暗才有纵深，也让画面中心的造型更跳出来。
  '  vec2 ndc = vNdc.xy / max(1e-4, vNdc.z);',
  '  col *= 1.0 - uVignette * smoothstep(0.28, 1.18, length(ndc * vec2(0.84, 1.0)));',
  '  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);',
  '}',
].join('\n');

function makeSkyMaterial(THREE, width) {
  return new THREE.ShaderMaterial({
    uniforms: {
      // 近黑夜空，层次来自星点和低亮度尘埃。
      uTop: { value: new THREE.Color(0.006,0.007,0.011) },
      uMid: { value: new THREE.Color(0.010,0.011,0.015) },
      uBot: { value: new THREE.Color(0.003,0.004,0.006) },
      uGalaxy: { value: galaxyTexture(THREE, width) },
      uNeb: { value: 1.00 },
      uVignette: { value: 0.30 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });
}

// —— 主粒子（星座造型）着色器 ——
const SHAPE_VERT = [
  'attribute vec3 aEntry;',
  'attribute vec3 aShape;',
  'attribute vec3 aExit;',
  'attribute vec3 aNormal;',
  'attribute float aShine;',
  'attribute float aPhase;',
  'attribute float aSeed;',
  'uniform float uTime;',
  'uniform float uPixelRatio;',
  'uniform float uBoost;',
  'uniform float uTwinkle;',
  'uniform float uMotion;',
  'uniform float uSpin;',
  'uniform float uLit;',
  'uniform vec3 uKeyDir;',
  'uniform int uVariant;',
  'uniform int uState;',
  'uniform float uK;',
  'varying float vAlpha;',
  'varying float vShine;',
  'varying float vCore;',
  'varying float vLight;',
  'varying float vRim;',
  'varying float vDepth;',
  'varying vec2 vDirection;',
  'varying float vStretch;',
  'vec3 flight(float t) {',
  '  t = clamp(t,0.0,1.0);',
  '  float ease = uState == 2 ? t*t : 1.0-(1.0-t)*(1.0-t);',
  '  vec3 origin = uState == 2 ? aShape : aEntry;',
  '  vec3 target = uState == 2 ? aExit : aShape;',
  '  vec3 p = mix(origin,target,ease);',
  '  float arc = sin(t*3.14159265)*uMotion;',
  '  float angle = aPhase+t*(7.0+aSeed*8.0)*uSpin;',
  '  if(uVariant == 0) {',
  '    p.xy += vec2(cos(angle),sin(angle))*arc*(1.2+aSeed*2.6);',
  '    p.z += arc*sin(angle*0.7)*1.8;',
  '  } else if(uVariant == 1) {',
  '    p.xz += vec2(sin(angle),cos(angle))*arc*2.8;',
  '    p.y += arc*(aSeed-0.5)*5.0;',
  '  } else if(uVariant == 2) {',
  '    p.x += arc*(aSeed-0.5)*7.0;',
  '    p.y += sin(t*9.0+aPhase)*arc*1.2;',
  '    p.z += arc*(aSeed*4.0-2.0);',
  '  } else if(uVariant == 3) {',
  '    p.xz += vec2(cos(angle),sin(angle))*arc*4.2;',
  '    p.y += sin(angle*0.4)*arc*0.8;',
  '  } else {',
  '    vec3 direction = normalize(aShape+vec3(sin(aPhase),cos(aPhase),aSeed-0.5));',
  '    p += direction*arc*(2.0+4.0*aSeed);',
  '  }',
  '  return p;',
  '}',
  'void main() {',
  '  float stagger = (aSeed-0.5)*0.48;',
  '  float k = clamp(uK*1.24+stagger,0.0,1.0);',
  '  vec3 p;',
  '  vec3 ahead;',
  '  float arc = 0.0;',
  '  if(uState == 1) {',
  '    p = aShape;',
  '    p += vec3(sin(uTime*0.72+aPhase),cos(uTime*0.49+aPhase*1.7),',
  '              sin(uTime*0.55+aPhase*0.6))*0.028*uMotion;',
  '    ahead = p;',
  '    float wave = pow(max(0.0,sin(aShape.x*1.6-uTime*3.1+aSeed*0.8)),12.0);',
  '    vAlpha = 0.448+wave*1.12*uMotion;',
  '  } else {',
  '    p = flight(k); ahead = flight(min(1.0,k+0.012));',
  '    arc = sin(k*3.14159265);',
  '    vAlpha = uState == 0 ? 0.24+smoothstep(0.0,0.78,k)*0.76 : 1.0-smoothstep(0.72,1.0,k);',
  '  }',
  '  vec4 mv = modelViewMatrix*vec4(p,1.0);',
  '  vec4 clip = projectionMatrix*mv;',
  '  vec4 next = projectionMatrix*modelViewMatrix*vec4(ahead,1.0);',
  '  vec2 velocity = next.xy/max(0.001,abs(next.w))-clip.xy/max(0.001,abs(clip.w));',
  '  vDirection = length(velocity)>0.00001 ? normalize(velocity) : vec2(1.0,0.0);',
  '  vStretch = uState == 1 ? 1.0 : 1.0+(2.0+arc*5.0)*uMotion;',
  '  float tw = 1.0+uTwinkle*sin(uTime*1.9+aPhase)*0.35;',
  '  float boost = 1.0+(uBoost-1.0)*(0.55+aShine*0.45);',
  // 体积受光：aNormal 是逐点表面法线。主光固定在世界空间，造型微摆时
  // 明暗会扫过表面 —— 这才是「3D」的来源，而不是整体变亮或变按。
  '  vec3 wn = normalize(mat3(modelMatrix)*aNormal);',
  '  float wrap = dot(wn,uKeyDir)*0.5+0.5;',
  '  float fill = dot(wn,normalize(vec3(-0.55,0.15,-0.65)))*0.5+0.5;',
  '  vec3 vn = normalize(mat3(viewMatrix)*wn);',
  '  float rim = pow(1.0-abs(vn.z),2.0);',
  '  vLight = mix(1.0,0.20+0.96*wrap*wrap+0.28*fill,uLit)*(0.64+0.36*clamp(aShine,0.0,1.0));',
  '  vRim = rim*uLit;',
  '  float size = uState == 1 ? 0.34+aShine*0.95 : (0.35+aShine*0.65)*(1.0+arc*1.8*uMotion);',
  // 前景粒子更大更亮、后景更小更暗：屏幕空间里也读出前后层次。
  '  float near = clamp((p.z+0.9)/1.8,0.0,1.0);',
  '  size *= 0.74+0.34*near;',
  '  vDepth = near;',
  '  gl_PointSize = clamp(size*tw*boost*(54.0/max(1.0,-mv.z))*uPixelRatio,0.6,40.0);',
  '  vShine = aShine; vCore = clamp(aShine,0.0,1.0);',
  '  gl_Position = clip;',
  '}',
].join('\n');

const SHAPE_FRAG = [
  'precision mediump float;',
  'uniform vec3 uAccent;',
  'uniform vec3 uBody;',
  'uniform vec3 uRim;',
  'uniform float uAccentMix;',
  'varying float vAlpha;',
  'varying float vShine;',
  'varying float vCore;',
  'varying float vLight;',
  'varying float vRim;',
  'varying float vDepth;',
  'varying vec2 vDirection;',
  'varying float vStretch;',
  'void main() {',
  '  vec2 q = gl_PointCoord-vec2(0.5);',
  '  vec2 dir = vec2(vDirection.x,-vDirection.y);',
  '  float along = dot(q,dir);',
  '  float across = dot(q,vec2(-dir.y,dir.x));',
  '  float d = length(vec2(along,across*vStretch));',
  '  float halo = exp(-d*d*15.0)*0.34;',
  '  float core = exp(-d*d*240.0);',
  '  float tail = mix(1.0,smoothstep(-0.5,0.15,along),clamp(vStretch-1.0,0.0,1.0));',
  '  float a = min(1.0,halo+core)*vAlpha*(0.45+tail*0.25);',
  // 近处粒子更实、深处更淡：加法混合下这是唯一能避免「前后叠成一片」的手段。
  '  a *= 0.52+0.78*vDepth;',
  '  vec3 base = mix(uBody,uRim,vCore);',
  '  vec3 col = mix(base,uAccent,clamp((vShine-0.9)*1.2,0.0,uAccentMix));',
  // 受光量只乘在颜色上、不乘 alpha：扫过亮带的对比和「聚→停」亮度台阶保持原样。
  '  col *= vLight;',
  // 轮廓光用座次亮色提亮边缘，背光面留一点冷调，体积才有正反两面。
  '  col = mix(col,uRim,clamp(vRim*0.55,0.0,0.6));',
  '  col *= 0.82+0.24*vDepth;',
  '  col += core*vCore*0.3*vLight;',
  '  gl_FragColor = vec4(col,a);',
  '}',
].join('\n');

// —— 星点 / 星云斑块 / 形象图柔光：同一套软圆斑着色器，靠 aSize/aAlpha 分流 ——
const FIELD_VERT = [
  'attribute float aSize;',
  'attribute vec3 aColor;',
  'attribute float aPhase;',
  'attribute float aAlpha;',
  'uniform float uTime;',
  'uniform float uPixelRatio;',
  'uniform float uSizeScale;',
  'uniform float uAlpha;',
  'uniform float uTwinkle;',
  'uniform vec3 uTint;',
  'varying vec3 vColor;',
  'varying float vAlpha;',
  'void main() {',
  '  vColor = aColor*uTint;',
  '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
  '  float breath = sin(uTime*(0.34+0.12*sin(aPhase))+aPhase);',
  '  float tw = 1.0-uTwinkle*0.24+uTwinkle*0.34*breath;',
  '  gl_PointSize = clamp(aSize * uSizeScale * tw * (1.0 / max(1.0, -mv.z)) * uPixelRatio, 1.0, 512.0);',
  '  vAlpha = aAlpha * tw * uAlpha;',
  '  gl_Position = projectionMatrix * mv;',
  '}',
].join('\n');

const FIELD_FRAG = [
  'precision mediump float;',
  'varying vec3 vColor;',
  'varying float vAlpha;',
  'void main() {',
  '  vec2 q = gl_PointCoord - vec2(0.5);',
  '  float d = length(q);',
  // 大颗（星云斑块/柔光）用超柔边，普通星点用紧核。
  '  float halo = smoothstep(0.5, 0.0, d);',
  '  float a = halo * halo * vAlpha;',
  '  gl_FragColor = vec4(vColor, a);',
  '}',
].join('\n');

// —— 四芒星：核心 + 十字光刺 + 柔晕。大颗亮星是画面里最锋利的一层。 ——
const GLINT_VERT = [
  'attribute float aSize;',
  'attribute float aBright;',
  'attribute float aPhase;',
  'attribute float aRunner;',
  'attribute vec3 aTarget;',
  'uniform float uTime;',
  'uniform float uPixelRatio;',
  'uniform float uSizeScale;',
  'uniform float uBrightness;',
  'uniform float uTwinkle;',
  'uniform float uFlow;',
  'varying float vBright;',
  'void main() {',
  '  float runner = step(0.5,aRunner);',
  '  float progress = fract((uTime-2.15)*0.2-(aRunner-1.0)*0.073);',
  '  vec3 p = mix(position,aTarget,progress*runner);',
  '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
  '  float breath = sin(uTime*(0.42+0.09*sin(aPhase))+aPhase);',
  '  float flare = pow(max(0.0,breath),8.0);',
  '  float tw = 1.0+uTwinkle*(0.20*breath+0.10*flare);',
  '  gl_PointSize = clamp(aSize * uSizeScale * tw * (1.0 / max(1.0, -mv.z)) * uPixelRatio, 1.0, 320.0);',
  '  vBright = aBright*uBrightness*(1.0+uTwinkle*(0.27*sin(uTime*0.44+aPhase)+0.16*flare));',
  '  vBright *= mix(1.0,uFlow*smoothstep(0.0,0.08,progress)*(1.0-smoothstep(0.92,1.0,progress)),runner);',
  '  gl_Position = projectionMatrix * mv;',
  '}',
].join('\n');

const GLINT_FRAG = [
  'precision highp float;',
  'uniform vec3 uColor;',
  'varying float vBright;',
  'void main() {',
  '  vec2 q = gl_PointCoord - vec2(0.5);',
  '  float r = length(q);',
  '  float ax = abs(q.x);',
  '  float ay = abs(q.y);',
  // 核心 + 两条细长光刺（沿 q 的一个轴收得很紧、另一个轴放得很开）。
  '  float core = exp(-r * r * 96.0);',
  '  float sx = exp(-ax * ax * 1300.0 - ay * ay * 20.0);',
  '  float sy = exp(-ay * ay * 1300.0 - ax * ax * 20.0);',
  '  float halo = exp(-r * r * 13.0) * 0.32;',
  '  float spike = sx + sy;',
  '  float a = clamp((core + spike * 0.60 + halo) * vBright, 0.0, 1.0);',
  '  vec3 col = mix(uColor, vec3(1.0), clamp(core * 1.3 + spike * 0.55, 0.0, 1.0));',
  '  gl_FragColor = vec4(col * clamp(vBright, 0.0, 1.4), a);',
  '}',
].join('\n');

function makeShapeMaterial(THREE) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uBoost: { value: 1 },
      uTwinkle: { value: 1 },
      uState: { value: 0 },
      uMotion: { value: 1 },
      uSpin: { value: 1 },
      uVariant: { value: 0 },
      uK: { value: 0 },
      uLit: { value: 1 },
      uKeyDir: { value: new THREE.Vector3(-0.45, 0.52, 0.72).normalize() },
      uAccent: { value: new THREE.Color('#b9d3ff') },
      uBody: { value: new THREE.Color(1, 1, 1) },
      uRim: { value: new THREE.Color(1, 1, 1) },
      uAccentMix: { value: 0 },
    },
    vertexShader: SHAPE_VERT,
    fragmentShader: SHAPE_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

function makeFieldMaterial(THREE) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uSizeScale: { value: 1 },
      uAlpha: { value: 1 },
      uTwinkle: { value: 1 },
      uTint: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: FIELD_VERT,
    fragmentShader: FIELD_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

function makeGlintMaterial(THREE, color) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uSizeScale: { value: 1 },
      uBrightness: { value: 1 },
      uTwinkle: { value: 1 },
      uFlow: { value: 1 },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: GLINT_VERT,
    fragmentShader: GLINT_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

// 软圆斑几何（星场/星云/形象图柔光共用）：位置各是各的，色/尺寸/相位/透明
// 走 shared —— 注意共享的必须是**同一批 BufferAttribute 对象**：three 按包装
// 对象认 GPU buffer，各建一个新包装看着像共享，实际是每座多传一份。
function softGeometry(THREE, positions, shared) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aColor', shared.color);
  geo.setAttribute('aSize', shared.size);
  geo.setAttribute('aPhase', shared.phase);
  geo.setAttribute('aAlpha', shared.alpha);
  return geo;
}

function softAttrs(THREE, col, size, phase, alpha) {
  return {
    color: new THREE.BufferAttribute(col, 3),
    size: new THREE.BufferAttribute(size, 1),
    phase: new THREE.BufferAttribute(phase, 1),
    alpha: new THREE.BufferAttribute(alpha, 1),
  };
}

// 四芒星几何（aPhase 同样可以跨座共享）。
function glintGeometry(THREE, pos, size, bright, phase) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
  geo.setAttribute('aPhase', phase);
  geo.setAttribute('aRunner', new THREE.BufferAttribute(new Float32Array(size.length), 1));
  geo.setAttribute('aTarget', new THREE.BufferAttribute(new Float32Array(pos.length), 3));
  return geo;
}

export function createWorld(THREE, scene, opts) {
  const quality = SHAPE_COUNTS[opts.quality] ? opts.quality : 'high';
  const count = SHAPE_COUNTS[quality];
  const figureCount = FIGURE_COUNTS[quality];
  const fieldCount = FIELD_COUNTS[quality];
  const sparkleCount = SPARKLE_COUNTS[quality];
  const lowQ = quality === 'low';
  const disposables = [];
  if (opts.scope) {
    disposables.push = (...resources) => { resources.forEach(resource => opts.scope.track(resource)); return Array.prototype.push.apply(disposables, resources); };
  }
  let activeQuality = quality;
  function setQuality(mode) {
    activeQuality = SHAPE_COUNTS[mode] ? mode : quality;
    scene.traverse(object => {
      if (!object.isPoints || !object.geometry) return;
      const total = object.geometry.getAttribute('position').count;
      object.geometry.setDrawRange(0, Math.max(1, Math.floor(total * Math.min(1, SHAPE_COUNTS[activeQuality] / count))));
    });
  }

  // =========================================================================
  // 1) 天空穹顶（常驻，不受星云开关影响）
  // =========================================================================
  const skyGeo = new THREE.SphereGeometry(140, lowQ ? 40 : 64, lowQ ? 26 : 40);
  const skyMat = makeSkyMaterial(THREE, lowQ ? 512 : quality === 'medium' ? 1024 : 2048);
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  scene.add(sky);
  disposables.push(skyGeo, skyMat, skyMat.uniforms.uGalaxy.value);

  // =========================================================================
  // 2) 星场 + 星云斑块 + 星光点缀（背景星云开关控制整组）
  // =========================================================================
  const fieldGroup = new THREE.Group();
  scene.add(fieldGroup);

  // Match the sky shader's galactic latitude for every background layer.
  const galaxyNormal = new THREE.Vector3(0.52, 0.84, 0.16).normalize();
  const galaxyTangent = new THREE.Vector3(0.84, -0.52, 0).normalize();
  const galaxyBitangent = new THREE.Vector3().crossVectors(galaxyNormal, galaxyTangent);
  const galaxyFrame = new THREE.Matrix4().makeBasis(galaxyTangent, galaxyNormal, galaxyBitangent);
  const frnd = seededRandom('zodiac-field-3');
  const fieldPos = new Float32Array(fieldCount * 3);
  const fieldCol = new Float32Array(fieldCount * 3);
  const fieldSize = new Float32Array(fieldCount);
  const fieldPhase = new Float32Array(fieldCount);
  const fieldAlpha = new Float32Array(fieldCount);
  for (let i = 0; i < fieldCount; i += 1) {
    const inGalaxy = frnd() < .64;
    const u = inGalaxy ? (frnd()+frnd()+frnd()-1.5)*.23-.20 : frnd()*2-1;
    const t = frnd() * Math.PI * 2;
    const r = 65 + frnd() * 35;
    const s = Math.sqrt(1 - u * u);
    fieldPos[i * 3] = Math.cos(t) * s * r;
    fieldPos[i * 3 + 1] = u*r;
    fieldPos[i * 3 + 2] = Math.sin(t) * s * r;
    // 中性白为主，少量冷暖星点。
    const tone = 0.62 + frnd() * 0.38;
    const pick = frnd();
    fieldCol[i * 3] = tone*(pick>.90 ? 1.0 : pick<.12 ? .8 : .96);
    fieldCol[i * 3 + 1] = tone*(pick>.90 ? .88 : .96);
    fieldCol[i * 3 + 2] = tone*(pick>.90 ? .70 : 1.0);
    // A dense bed of pinpoints, with only a few brighter photographic stars.
    fieldSize[i] = .55 + Math.pow(frnd(), 5.0) * 2.8;
    fieldPhase[i] = frnd() * Math.PI * 2;
    fieldAlpha[i] = 0.18 + Math.pow(frnd(), 1.8) * 0.72;
  }
  const fieldGeo = softGeometry(THREE, fieldPos,
    softAttrs(THREE, fieldCol, fieldSize, fieldPhase, fieldAlpha));
  fieldGeo.applyMatrix4(galaxyFrame);
  const fieldMat = makeFieldMaterial(THREE);
  fieldMat.uniforms.uSizeScale.value = 96;
  const fieldPoints = new THREE.Points(fieldGeo, fieldMat);
  fieldPoints.frustumCulled = false;
  fieldPoints.renderOrder = -900;
  fieldGroup.add(fieldPoints);
  disposables.push(fieldGeo, fieldMat);

  const nrnd = seededRandom('zodiac-nebula-3');
  const nebulaPalette = [
    [0.26, 0.18, 0.29], [0.29, 0.23, 0.25], [0.19, 0.20, 0.27], [0.26, 0.22, 0.29],
  ];
  const nPos = new Float32Array(NEBULA * 3);
  const nCol = new Float32Array(NEBULA * 3);
  const nSize = new Float32Array(NEBULA);
  const nPhase = new Float32Array(NEBULA);
  const nAlpha = new Float32Array(NEBULA);
  for (let i = 0; i < NEBULA; i += 1) {
    const u = (nrnd()+nrnd()+nrnd()-1.5)*.20-.20;
    const t = nrnd() * Math.PI * 2;
    const r = 30 + nrnd() * 48;
    const s = Math.sqrt(1 - u * u);
    nPos[i * 3] = Math.cos(t) * s * r;
    nPos[i * 3 + 1] = u * r;
    nPos[i * 3 + 2] = Math.sin(t) * s * r;
    const c = nebulaPalette[i % nebulaPalette.length];
    const tone = 0.45 + nrnd() * 0.55;
    nCol[i * 3] = c[0] * tone; nCol[i * 3 + 1] = c[1] * tone; nCol[i * 3 + 2] = c[2] * tone;
    nSize[i] = 70 + nrnd() * 150;
    nPhase[i] = nrnd() * Math.PI * 2;
    nAlpha[i] = 0.010 + nrnd() * 0.025;
  }
  const nebulaGeo = softGeometry(THREE, nPos, softAttrs(THREE, nCol, nSize, nPhase, nAlpha));
  nebulaGeo.applyMatrix4(galaxyFrame);
  const nebulaMat = makeFieldMaterial(THREE);
  nebulaMat.uniforms.uSizeScale.value = 120;
  const nebulaPoints = new THREE.Points(nebulaGeo, nebulaMat);
  nebulaPoints.frustumCulled = false;
  nebulaPoints.renderOrder = -890;
  fieldGroup.add(nebulaPoints);
  disposables.push(nebulaGeo, nebulaMat);

  const srnd = seededRandom('zodiac-sparkle-3');
  const sPos = new Float32Array(sparkleCount * 3);
  const sSize = new Float32Array(sparkleCount);
  const sBright = new Float32Array(sparkleCount);
  const sPhase = new Float32Array(sparkleCount);
  for (let i = 0; i < sparkleCount; i += 1) {
    const u = srnd() * 2 - 1;
    const t = srnd() * Math.PI * 2;
    const r = 52 + srnd() * 34;
    const s = Math.sqrt(1 - u * u);
    sPos[i * 3] = Math.cos(t) * s * r;
    sPos[i * 3 + 1] = u * r * 0.85;
    sPos[i * 3 + 2] = Math.sin(t) * s * r;
    // 大颗的极少：长尾分布，避免「满天都是大星」的廉价感。
    sSize[i] = 1.2 + Math.pow(srnd(), 5.0) * 4.8;
    sBright[i] = 0.34 + srnd() * 0.66;
    sPhase[i] = srnd() * Math.PI * 2;
  }
  const sparkleGeo = glintGeometry(THREE, sPos, sSize, sBright,
    new THREE.BufferAttribute(sPhase, 1));
  const sparkleMat = makeGlintMaterial(THREE, '#f2f0eb');
  sparkleMat.uniforms.uSizeScale.value = 260;
  const sparklePoints = new THREE.Points(sparkleGeo, sparkleMat);
  sparklePoints.frustumCulled = false;
  sparklePoints.renderOrder = -880;
  fieldGroup.add(sparklePoints);
  disposables.push(sparkleGeo, sparkleMat);

  // =========================================================================
  // 3) 逐座预建：主粒子池 + 形象图（柔光/面片/网格边）+ 星座骨架（连线/星点）
  // =========================================================================
  const root = new THREE.Group();
  scene.add(root);
  const figureGroup = new THREE.Group();
  root.add(figureGroup);

  const lights = new THREE.Group();
  lights.add(new THREE.AmbientLight('#b4b4c5',.65));
  const keyLight = new THREE.DirectionalLight('#fff4e3',3.2);
  keyLight.position.set(-5,6,8);lights.add(keyLight);
  const rimLight = new THREE.DirectionalLight('#c4daf1',2.4);
  rimLight.position.set(4,1,-5);lights.add(rimLight);
  const fillLight = new THREE.DirectionalLight('#e0cadb',1.1);
  fillLight.position.set(5,-3,4);lights.add(fillLight);
  scene.add(lights);

  const shapeMat = makeShapeMaterial(THREE);
  const meshMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#ffffff'),
    emissive: new THREE.Color('#000000'),
    emissiveIntensity: .35,
    roughness: .42,
    metalness: .18,
    flatShading: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.005,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const ribbonMat = (color, opacity) => new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  // 两级轮廓丝带保留细肢与孔洞；主星骨架比轮廓更亮。
  const edgeCoreMat = ribbonMat('#ffffff', 0.28);
  const edgeHaloMat = ribbonMat('#ffffff', 0.075);
  const nodeMat = makeFieldMaterial(THREE);
  nodeMat.uniforms.uSizeScale.value = 52;
  const haloMat = ribbonMat('#ffffff', 0.20);
  const coreMat = ribbonMat('#ffffff', 0.90);
  const hazeMat = makeFieldMaterial(THREE);
  hazeMat.uniforms.uSizeScale.value = 120;
  const discMat = makeGlintMaterial(THREE, '#ffffff');
  discMat.uniforms.uSizeScale.value = 300;
  disposables.push(shapeMat, meshMat, edgeCoreMat, edgeHaloMat, nodeMat,
    haloMat, coreMat, hazeMat, discMat);

  const white = new THREE.Color('#ffffff');
  const signColors = SIGN_COLORS.map(([bodyHex, glowHex]) => {
    const body = new THREE.Color(bodyHex), glow = new THREE.Color(glowHex);
    // 自定义 shader 直接输出显示色；内置材质由 three 转换线性色。
    return {
      body, glow, emissive: body.clone().multiplyScalar(.18),
      edge: body.clone().lerp(white, .55), core: glow.clone().lerp(white, .82),
      particle: body.clone().lerp(glow, .2).convertLinearToSRGB(),
      particleRim: body.clone().lerp(glow, .55).convertLinearToSRGB(),
      haze: body.clone().lerp(glow, .35).convertLinearToSRGB(),
      node: glow.clone().lerp(white, .5).convertLinearToSRGB(),
      star: glow.clone().lerp(white, .3).convertLinearToSRGB(),
    };
  });

  const seeds = buildSeeds(count);
  const poolPhase = new Float32Array(count);
  for (let i = 0; i < count; i += 1) poolPhase[i] = seeds[i] * Math.PI * 2;
  // 与座次无关的 attribute 包一次做好，12 座共用同一批对象。
  const poolPhaseAttr = new THREE.BufferAttribute(poolPhase, 1);
  const seedAttr = new THREE.BufferAttribute(seeds, 1);

  // 形象图柔光的尺寸/亮度/相位/色与座次无关：12 套几何共享同一批 attribute，
  // 只有位置各是各的（同一片 buffer 也就只上传一次）。
  const hazeShare = (() => {
    const hr = seededRandom('zodiac-haze-1');
    const col = new Float32Array(figureCount * 3);
    const size = new Float32Array(figureCount);
    const phase = new Float32Array(figureCount);
    const alpha = new Float32Array(figureCount);
    for (let i = 0; i < figureCount; i += 1) {
      const tone = 0.55 + hr() * 0.45;
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = tone;
      // 只补充体积感，保持主粒子的亮核可分辨。
      size[i] = 1.1 + Math.pow(hr(), 2.4) * 3.0;
      phase[i] = hr() * Math.PI * 2;
      alpha[i] = 0.006 + hr() * 0.016;
    }
    return softAttrs(THREE, col, size, phase, alpha);
  })();
  const discPhaseAttr = (() => {
    const dr = seededRandom('zodiac-disc-1');
    const phase = new Float32Array(STAR_SLOTS);
    for (let i = 0; i < STAR_SLOTS; i += 1) phase[i] = dr() * Math.PI * 2;
    return new THREE.BufferAttribute(phase, 1);
  })();
  // 网格顶点亮点的尺寸/亮度：十二座点数固定（FIGURE_MESH_POINTS），跨座共享。
  const nodeShare = (() => {
    const nr = seededRandom('zodiac-node-1');
    const col = new Float32Array(FIGURE_MESH_POINTS * 3);
    const size = new Float32Array(FIGURE_MESH_POINTS);
    const phase = new Float32Array(FIGURE_MESH_POINTS);
    const alpha = new Float32Array(FIGURE_MESH_POINTS);
    for (let i = 0; i < FIGURE_MESH_POINTS; i += 1) {
      const tone = 0.70 + nr() * 0.30;
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = tone;
      size[i] = 0.30 + Math.pow(nr(), 1.8) * 0.55;
      phase[i] = nr() * Math.PI * 2;
      alpha[i] = 0.25 + nr() * 0.35;
    }
    return softAttrs(THREE, col, size, phase, alpha);
  })();

  const pools = [];
  const hazes = [];
  const meshes = [];
  const edgeCores = [];
  const edgeHalos = [];
  const nodeSets = [];
  const halos = [];
  const cores = [];
  const discSets = [];
  const lines = [];
  const figures = [];

  for (let i = 0; i < SIGN_COUNT; i += 1) {
    const shape = buildShape(i, count);
    const clouds = [
      buildCloud(ZODIAC[i].id, count),
      buildCloud(ZODIAC[(i + 1) % SIGN_COUNT].id, count),
    ];
    const fig = buildFigureMesh(i, figureCount);
    const line = buildConstellation(i);
    figures.push(fig);
    lines.push(line);

    // 主粒子池：入场云 / 造型 / 出场云 + 亮度，一套几何一座
    const pgeo = new THREE.BufferGeometry();
    // three 的渲染入口要求几何必须带 position 属性（否则 renderBufferDirect
    // 直接跳过这个对象）；真实位置由 aEntry/aShape/aExit 在着色器里插值，这里
    // 放一片零占位移除该门槛。
    pgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    pgeo.setAttribute('aEntry', new THREE.BufferAttribute(clouds[0], 3));
    pgeo.setAttribute('aShape', new THREE.BufferAttribute(shape.pos, 3));
    pgeo.setAttribute('aExit', new THREE.BufferAttribute(clouds[1], 3));
    pgeo.setAttribute('aNormal', new THREE.BufferAttribute(shape.normals, 3));
    pgeo.setAttribute('aShine', new THREE.BufferAttribute(shape.shine, 1));
    pgeo.setAttribute('aPhase', poolPhaseAttr);
    pgeo.setAttribute('aSeed', seedAttr);
    pools.push(pgeo);
    disposables.push(pgeo);

    // 形象图柔光
    const hg = softGeometry(THREE, fig.cloud, hazeShare);
    hazes.push(hg);
    disposables.push(hg);

    // 形象图网格（非索引三角面片 + 逐顶点明度）
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(fig.mesh.pos, 3));
    mg.setAttribute('color', new THREE.BufferAttribute(fig.mesh.tint, 3));
    mg.computeVertexNormals();
    meshes.push(mg);
    disposables.push(mg);

    // 渲染轮廓边光；完整内部网格仍由纯几何层保留。
    const ecg = new THREE.BufferGeometry();
    ecg.setAttribute('position', new THREE.BufferAttribute(fig.contourCore, 3));
    edgeCores.push(ecg);
    const ehg = new THREE.BufferGeometry();
    ehg.setAttribute('position', new THREE.BufferAttribute(fig.contourHalo, 3));
    edgeHalos.push(ehg);
    const ngeo = softGeometry(THREE, fig.nodes, nodeShare);
    nodeSets.push(ngeo);
    disposables.push(ecg, ehg, ngeo);

    // 星座连线两级丝带
    const hgeo = new THREE.BufferGeometry();
    hgeo.setAttribute('position', new THREE.BufferAttribute(line.halo, 3));
    halos.push(hgeo);
    const cgeo = new THREE.BufferGeometry();
    cgeo.setAttribute('position', new THREE.BufferAttribute(line.core, 3));
    cores.push(cgeo);
    disposables.push(hgeo, cgeo);

    // 星座星点
    const dpos = new Float32Array(STAR_SLOTS * 3);
    const dsize = new Float32Array(STAR_SLOTS);
    const dbright = new Float32Array(STAR_SLOTS);
    const n = Math.min(line.nodes, DISC_SLOTS);
    for (let k = 0; k < n; k += 1) {
      dpos[k * 3] = line.x[k];
      dpos[k * 3 + 1] = line.y[k];
      dpos[k * 3 + 2] = line.z[k];
      // 参考图里的主星是大颗的四芒星（带一大片辉光），次星也明显可见 ——
      // 「每颗都是小圆点」是上一版最不像的地方之一。
      dsize[k] = 0.55 + line.m[k] * 1.75;
      dbright[k] = 0.55 + line.m[k] * 0.85;
    }
    const dg = glintGeometry(THREE, dpos, dsize, dbright, discPhaseAttr);
    // Link runners share the prebuilt main-star geometry and its render pass.
    CONSTELLATION[i].lines.forEach(([a,b], k) => {
      const slot = DISC_SLOTS + k;
      dpos.set([line.x[a],line.y[a],line.z[a]], slot * 3);
      dg.getAttribute('aTarget').array.set([line.x[b],line.y[b],line.z[b]], slot * 3);
      dg.getAttribute('aRunner').array[slot] = k + 1;
      dsize[slot] = 0.6;
      dbright[slot] = 0.7;
    });
    dg.setDrawRange(0, DISC_SLOTS + line.segments);
    discSets.push(dg);
    disposables.push(dg);
  }

  const points = new THREE.Points(pools[0], shapeMat);
  points.frustumCulled = false;
  points.renderOrder = -10;
  root.add(points);

  const haze = new THREE.Points(hazes[0], hazeMat);
  haze.frustumCulled = false;
  haze.renderOrder = -100;
  figureGroup.add(haze);

  const mesh = new THREE.Mesh(meshes[0], meshMat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -90;
  figureGroup.add(mesh);

  const edgeHalo = new THREE.Mesh(edgeHalos[0], edgeHaloMat);
  const edgeCore = new THREE.Mesh(edgeCores[0], edgeCoreMat);
  const nodes = new THREE.Points(nodeSets[0], nodeMat);
  edgeHalo.frustumCulled = false;
  edgeCore.frustumCulled = false;
  nodes.frustumCulled = false;
  edgeHalo.renderOrder = -82;
  edgeCore.renderOrder = -80;
  nodes.renderOrder = -78;
  figureGroup.add(edgeHalo);
  figureGroup.add(edgeCore);
  figureGroup.add(nodes);

  const lineHalo = new THREE.Mesh(halos[0], haloMat);
  const lineCore = new THREE.Mesh(cores[0], coreMat);
  lineHalo.frustumCulled = false;
  lineCore.frustumCulled = false;
  lineHalo.renderOrder = 10;
  lineCore.renderOrder = 11;
  figureGroup.add(lineHalo);
  figureGroup.add(lineCore);

  const discs = new THREE.Points(discSets[0], discMat);
  discs.frustumCulled = false;
  discs.renderOrder = 12;
  figureGroup.add(discs);

  let current = -1;
  let lastCycle = 0;
  let fieldVisible = true;
  let figAlpha = 1;

  function setSign(i) {
    const idx = ((i % SIGN_COUNT) + SIGN_COUNT) % SIGN_COUNT;
    if (idx === current) return ZODIAC[idx];
    current = idx;
    const color = signColors[idx];
    meshMat.color.copy(color.body);
    meshMat.emissive.copy(color.emissive);
    edgeCoreMat.color.copy(color.edge);
    edgeHaloMat.color.copy(color.glow);
    coreMat.color.copy(color.core);
    haloMat.color.copy(color.glow);
    shapeMat.uniforms.uBody.value.copy(color.particle);
    shapeMat.uniforms.uRim.value.copy(color.particleRim);
    hazeMat.uniforms.uTint.value.copy(color.haze);
    nodeMat.uniforms.uTint.value.copy(color.node);
    discMat.uniforms.uColor.value.copy(color.star);
    points.geometry = pools[idx];
    haze.geometry = hazes[idx];
    mesh.geometry = meshes[idx];
    edgeHalo.geometry = edgeHalos[idx];
    edgeCore.geometry = edgeCores[idx];
    nodes.geometry = nodeSets[idx];
    lineHalo.geometry = halos[idx];
    lineCore.geometry = cores[idx];
    discs.geometry = discSets[idx];
    setQuality(activeQuality);
    return ZODIAC[idx];
  }

  function setPixelRatio(pr) {
    shapeMat.uniforms.uPixelRatio.value = pr;
    [fieldMat, nebulaMat, hazeMat, nodeMat].forEach((m) => { m.uniforms.uPixelRatio.value = pr; });
    sparkleMat.uniforms.uPixelRatio.value = pr;
    discMat.uniforms.uPixelRatio.value = pr;
  }

  function setPalette(palette) {
    if (!palette || !palette.accent) return;
    shapeMat.uniforms.uAccent.value.set(palette.accent).convertLinearToSRGB();
    shapeMat.uniforms.uAccentMix.value = .10;
  }

  function smooth01(v) {
    const x = clamp(v);
    return x * x * (3 - 2 * x);
  }

  // 形象图/连线的出现时机：粒子把造型「拼」出来之后才显影，散开时先撤。
  function figureOpacity(state, k) {
    if (state === 'gather') return smooth01((k - 0.42) / 0.5);
    if (state === 'disperse') return 1 - smooth01(k / 0.62);
    return 1;
  }

  function update(time, ctx) {
    const c = ctx || {};
    lastCycle = c.cycle || 0;
    const reduced = !!c.reduced;
    const state = c.state || 'hold';
    const k = c.k || 0;
    const bass = c.bass || 0;
    const onset = c.onset || 0;

    shapeMat.uniforms.uTime.value = time;
    shapeMat.uniforms.uBoost.value = 1 + bass * 0.6 + onset * 0.8;
    shapeMat.uniforms.uTwinkle.value = reduced ? 0.15 : 1;
    // 主光缓慢横扫：即使造型摆得很少，明暗也会在体积上移动 —— 静态帧里
    // 正背面亮度差、播放时高光缓慢扫过，这两件事合起来才是「立体」。
    const keySwing = reduced ? 0 : Math.sin(time * 0.11) * 0.34;
    const keyLift = reduced ? 0.52 : 0.44 + Math.sin(time * 0.067 + 0.8) * 0.14;
    shapeMat.uniforms.uKeyDir.value.set(
      Math.sin(-0.62 + keySwing) * Math.cos(keyLift),
      Math.sin(keyLift),
      Math.cos(-0.62 + keySwing) * Math.cos(keyLift),
    ).normalize();
    shapeMat.uniforms.uState.value = state === 'gather' ? 0 : state === 'disperse' ? 2 : 1;
    shapeMat.uniforms.uK.value = k;
    const style = transitionStyle(c.cycle || 0);
    shapeMat.uniforms.uVariant.value = state === 'disperse' ? style.disperse : style.gather;
    shapeMat.uniforms.uSpin.value = style.direction;
    shapeMat.uniforms.uMotion.value = reduced ? .12 : 1;

    // 减弱动效降低呼吸幅度，星云与星点常驻。
    const fTw = reduced ? 0.2 : 1;
    fieldMat.uniforms.uTime.value = time;
    fieldMat.uniforms.uTwinkle.value = fTw;
    nebulaMat.uniforms.uTime.value = time;
    nebulaMat.uniforms.uTwinkle.value = fTw * 0.35;
    sparkleMat.uniforms.uTime.value = time;
    sparkleMat.uniforms.uTwinkle.value = fTw;
    sparkleMat.uniforms.uBrightness.value = 0.82 + onset * 0.3;

    // 造型自转改成「以播放时间为唯一输入」的微摆：seek 到任意时刻画面一致，
    // 暂停时冻结；微摆展示立体侧面，同时保持剪影可识别。幅度比早期版本更大：
    // 配合逐点法线，摆角一变化明暗就跟着扫过表面，侧脸不再是「一张贴片」。
    const sway = reduced ? 0.06 : 0.46;
    root.rotation.y = Math.sin(time * 0.30) * sway + Math.sin(time * 0.085 + 1.3) * sway * 0.42;
    root.rotation.x = Math.sin(time * 0.19) * (reduced ? 0 : 0.16) + Math.cos(time * 0.075 + 0.5) * (reduced ? 0 : 0.05);
    const pulse = 1 + onset * 0.02 + bass * 0.012;
    root.scale.setScalar(state === 'gather' ? pulse * (0.92 + k * 0.08) : pulse);

    // 形象图 / 连线：随生命周期淡入淡出（每帧只算一次，九层共用）。
    // 透明度是材质标量，改它不触发着色器重编译，逐帧写没有代价。
    figAlpha = figureOpacity(state, k);
    hazeMat.uniforms.uAlpha.value = figAlpha;
    hazeMat.uniforms.uTime.value = time;
    // 体积层：极低透明度但不再是「等于不存在」的 0.005 —— 逐面明暗 + 主光照
    // 让它成为一层可读的低多边形体积，同时仍低于「亮度占比 < 10%」的回归线。
    meshMat.opacity = 0.016 * figAlpha;
    edgeCoreMat.opacity = 0.28 * figAlpha;
    edgeHaloMat.opacity = (0.075 + bass * 0.035) * figAlpha;
    nodeMat.uniforms.uAlpha.value = figAlpha * 0.045;
    nodeMat.uniforms.uTime.value = time;
    nodeMat.uniforms.uTwinkle.value = reduced ? 0.25 : 1;
    coreMat.opacity = (0.90 + bass * 0.06) * figAlpha;
    haloMat.opacity = (0.20 + bass * 0.16) * figAlpha;
    discMat.uniforms.uBrightness.value = figAlpha * (1 + onset * 0.35);
    discMat.uniforms.uTime.value = time;
    discMat.uniforms.uTwinkle.value = reduced ? 0.25 : 1;
    discMat.uniforms.uFlow.value = reduced ? 0.2 : 1;
    // 完全透明时整组跳过绘制：汇聚/散开阶段省掉九次 draw call。
    figureGroup.visible = figAlpha > 0.002;

    fieldGroup.rotation.y = time * (reduced ? 0 : 0.0022);
    fieldGroup.position.copy(c.cameraPos || { x: 0, y: 0, z: 0 });
    sky.rotation.y = fieldGroup.rotation.y;
    sky.position.copy(fieldGroup.position);
  }

  function setFieldVisible(v) { fieldVisible = !!v; fieldGroup.visible = fieldVisible; }

  function stats() {
    return {
      signIndex: current < 0 ? 0 : current,
      sign: current < 0 ? null : ZODIAC[current].id,
      signCn: current < 0 ? null : ZODIAC[current].cn,
      signEn: current < 0 ? null : ZODIAC[current].en,
      particleCount: count,
      fieldPoints: fieldCount + NEBULA + sparkleCount,
      fieldVisible,
      figureTriangles: current < 0 ? 0 : figures[current].triangles,
      figureEdges: current < 0 ? 0 : figures[current].segmentCount,
      figurePoints: figureCount,
      figureMeshPoints: FIGURE_MESH_POINTS,
      constellationNodes: current < 0 ? 0 : lines[current].nodes,
      constellationSegments: current < 0 ? 0 : lines[current].segments,
      figureAlpha: Math.round(figAlpha * 1000) / 1000,
      sky: true,
      layers: 13,
      transition: { ...transitionStyle(lastCycle) },
    };
  }

  function dispose() {
    if (!opts.scope) disposables.forEach((d) => { d.dispose(); });
    scene.remove(root);
    scene.remove(fieldGroup);
    scene.remove(sky);
    scene.remove(lights);
  }

  setFieldVisible(true);

  return {
    setSign, update, dispose, stats, setPalette, setPixelRatio, setFieldVisible, setQuality,
  };
}
