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
//     -90 形象图面罩     低多边形体积：写深度，把背壳星尘与背景星挡在身后
//     -88 形象图柔光     裹在面罩外的表面点云，大点径低透明 → 半透明的「体量」
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
  ZODIAC, SIGN_COUNT, CYCLE_SECONDS, buildShape, buildCloud, buildSeeds, buildFigureMesh,
  buildConstellation, CONSTELLATION, CONSTELLATION_Z, FIGURE_Z, FIGURE_DEPTH, FIGURE_MESH_POINTS,
  figureBackDepth, transitionStyle,
} from './zodiac.js';
import { clamp, damp, seededRandom } from './util.js';

// 归一化改成「落到 1.78 的设计框」之后，横宽的星座比原来大了约 1.8 倍，
// 同样的粒子数摊在更大的面积上会显稀 —— 三个池子跟着上调一档。
const SHAPE_COUNTS = { low: 3900, medium: 9000, high: 15000 };
const FIGURE_COUNTS = { low: 1000, medium: 1700, high: 2600 };
// 点预算与空间场景的三档 cap 对齐：背景暗星退一步，近/中景星尘补层次。
const FIELD_COUNTS = { low: 6000, medium: 16000, high: 28000 };
const SPARKLE_COUNTS = { low: 70, medium: 112, high: 160 };
const DUST_COUNTS = {
  low: { near: 90, mid: 150 },
  medium: { near: 160, mid: 540 },
  high: { near: 240, mid: 700 },
};
// 游戏化能量场：星环数量与轨道星尘随画质缩放，低档仍保留一层主环。
const RING_COUNTS = { low: 1, medium: 2, high: 3 };
const ORBIT_COUNTS = { low: 140, medium: 260, high: 420 };
const NEBULA = 36;
const DISC_SLOTS = 18;   // 单座骨架最多 18 个星点（当前最大 15，留余量）
const STAR_SLOTS = DISC_SLOTS + Math.max(...CONSTELLATION.map(s => s.lines.length));
const HIT_RADIUS = 22;

// 主体、辉光、冷色与副色；次序与 ZODIAC 一致。上一版是低饱和的粉彩，
// 在近黑背景上容易读成同一片灰雾；这一版把主色、冷光与副色都推到霓虹档，
// 同时保留十二座可区分的色相骨架（珊瑚/翡翠/香槟/月银…）。
const SIGN_COLORS = [
  ['#ff6b57', '#ffd166', '#22e6ff', '#ff2e9a'], // 白羊：珊瑚 / 琥珀 / 冰青 / 霓虹玫红
  ['#35e29a', '#d7ff7a', '#00d9ff', '#ffb35c'], // 金牛：翡翠 / 荧光黄绿 / 湖蓝 / 香槟
  ['#ffd166', '#fff3b0', '#3de1ff', '#c77dff'], // 双子：香槟 / 蜜白 / 冰青 / 藕紫
  ['#bcd4ff', '#ffffff', '#00e5ff', '#ff6ec7'], // 巨蟹：月银 / 纯白 / 冰青 / 玫瑰
  ['#ffab3d', '#ffe08a', '#00e5ff', '#ff3d9a'], // 狮子：琥珀 / 蜜金 / 冰青 / 玫红
  ['#b6ff6b', '#f4ffb0', '#00e0ff', '#ff7ad9'], // 处女：浅草 / 柠光 / 湖蓝 / 玫瑰
  ['#ff7ac8', '#ffd8a8', '#4de8ff', '#a78bfa'], // 天秤：玫瑰 / 香槟 / 冰青 / 星紫
  ['#ff4d8d', '#ffb36b', '#00d4ff', '#a855f7'], // 天蝎：红紫 / 琥珀 / 湖蓝 / 电紫
  ['#a78bfa', '#ffd166', '#22d3ee', '#ff6ec7'], // 射手：星紫 / 香槟 / 冰青 / 玫瑰
  ['#2dd4bf', '#ffe9b0', '#38bdf8', '#e879f9'], // 摩羯：青玉 / 暖金 / 冰蓝 / 洋红
  ['#38bdf8', '#ffe08a', '#2dd4bf', '#ff6ec7'], // 水瓶：冰蓝 / 蜜金 / 青玉 / 玫瑰
  ['#b39ddb', '#fce0b7', '#63f5ff', '#ee98bd'], // 双鱼：淡紫 / 香槟 / 冰青 / 玫瑰
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
      const broad = fbm(u, v, 12);
      const detail = fbm(u + (broad - .5) * .045, v + .37, 64);
      const latitude = (.52 * dx + .84 * dy + .16 * dz) / normalLength + .20;
      const warped = latitude + (broad - .5) * .32;
      const band = Math.exp(-warped * warped * 62);
      const longitude = Math.atan2(Math.sin((u - .72) * Math.PI * 2), Math.cos((u - .72) * Math.PI * 2));
      const bulge = Math.exp(-longitude * longitude * 1.7 - warped * warped * 96);
      const rift = Math.exp(-Math.pow((warped + .016 + (detail - .5) * .24) / .022, 2));
      const branch = Math.exp(-Math.pow((warped - .07 + (broad - .5) * .23 + (detail - .5) * .10) / .012, 2));
      const extinction = (1 - rift * .94) * (1 - branch * .70);
      const cloud = Math.pow(clamp((detail - .32) / .34), 1.6);
      const dust = band * (.28 + broad * .9) * (.35 + cloud) * extinction * (.76 + grain() * .48);
      const core = bulge * (.32 + cloud * .7) * extinction;
      const knots = band * Math.pow(clamp((detail - .52) * 5), 2) * .12;
      const k = (y * width + x) * 4;
      pixels[k] = Math.round(255 * clamp(dust * .22 + core * .36 + knots));
      pixels[k + 1] = Math.round(255 * clamp(dust * .16 + core * .29 + knots * .25));
      pixels[k + 2] = Math.round(255 * clamp(dust * .32 + core * .21 + knots * .62));
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
  'uniform float uTime;',
  'varying float vY;',
  'varying vec2 vUv;',
  'varying vec3 vNdc;',
  'void main() {',
  '  float y = clamp(vY * 0.5 + 0.5, 0.0, 1.0);',
  '  vec3 col = mix(uBot, uMid, smoothstep(0.0, 0.58, y));',
  '  col = mix(col, uTop, smoothstep(0.46, 1.0, y));',
  '  col += texture2D(uGalaxy,vUv).rgb*uNeb;',
  // 极淡的极光帷幕：只在银河带附近出现，颜色与座次无关，不能把整片天空
  // 提亮成灰蓝（「大部分天空保持近黑」是既有像素回归的一部分）。
  '  float curtain = exp(-pow((y - 0.60 - 0.085*sin(vUv.x*12.566+uTime*0.045))/0.115,2.0));',
  '  float ripple = 0.55+0.45*sin(vUv.x*25.13-uTime*0.06);',
  '  vec3 aurora = mix(vec3(0.015,0.085,0.11),vec3(0.085,0.015,0.13),',
  '    0.5+0.5*sin(vUv.x*6.283+uTime*0.028));',
  '  col += aurora*curtain*ripple*0.34;',
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
      uTime: { value: 0 },
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
  'uniform float uBass;',
  'uniform float uMid;',
  'uniform float uTreble;',
  'uniform float uOnset;',
  'uniform vec3 uPointer;',
  'uniform float uPointerAmount;',
  'uniform vec3 uBurstPoint;',
  'uniform float uBurstAge;',
  'uniform float uBurst;',
  'uniform float uCharge;',
  'uniform float uSpin;',
  'uniform float uLit;',
  'uniform float uZMin;',
  'uniform float uZSpan;',
  'uniform vec3 uKeyDir;',
  'uniform int uVariant;',
  'uniform int uState;',
  'uniform float uK;',
  'uniform float uStagger;',
  'uniform float uSpinRate;',
  'uniform float uArcScale;',
  'varying float vAlpha;',
  'varying float vShine;',
  'varying float vCore;',
  'varying float vLight;',
  'varying float vRim;',
  'varying float vDepth;',
  'varying float vTint;',
  'varying float vFlow;',
  'varying float vEnergy;',
  'varying vec2 vDirection;',
  'varying float vStretch;',
  'vec3 flight(float t) {',
  '  t = clamp(t,0.0,1.0);',
  '  float ease = uState == 2 ? t*t : 1.0-(1.0-t)*(1.0-t);',
  '  vec3 origin = uState == 2 ? aShape : aEntry;',
  '  vec3 target = uState == 2 ? aExit : aShape;',
  '  vec3 p = mix(origin,target,ease);',
  '  float arc = sin(t*3.14159265)*uMotion*uArcScale;',
  '  float angle = aPhase+t*(7.0+aSeed*8.0)*uSpin*uSpinRate;',
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
  '  } else if(uVariant == 4) {',
  '    vec3 direction = normalize(aShape+vec3(sin(aPhase),cos(aPhase),aSeed-0.5));',
  '    p += direction*arc*(2.0+4.0*aSeed);',
  '  } else if(uVariant == 5) {',
  '    // 螺旋：绕机位轴旋进，半径一路收到零，落位时正好收束成一点。',
  '    float radius = (1.0-t)*arc*(2.2+aSeed*3.4);',
  '    p.xy += vec2(cos(angle*1.35),sin(angle*1.35))*radius;',
  '    p.z += (1.0-t)*arc*(aSeed*3.0-1.2);',
  '  } else if(uVariant == 6) {',
  '    // 星雨：从上方斜落，每颗的下落时刻由 aSeed 错开。',
  '    float drop = pow(1.0-t,2.0)*arc*(7.0+aSeed*7.0);',
  '    p.y += drop+(aSeed-0.5)*arc*1.6;',
  '    p.x += drop*0.34*sin(aPhase);',
  '    p.z += drop*0.22*cos(aPhase*1.7);',
  '  } else {',
  '    // 脉冲：沿目标方向的径向冲击，先冲过头再回弹。',
  '    vec3 direction = normalize(aShape+vec3(sin(aPhase*1.3),cos(aPhase),aSeed-0.5));',
  '    p += direction*arc*sin(t*3.14159265*1.5)*(1.4+aSeed*2.2);',
  '  }',
  '  return p;',
  '}',
  'void main() {',
  '  float k = clamp(uK*(1.0+uStagger)-aSeed*uStagger,0.0,1.0);',
  '  vec3 p;',
  '  vec3 ahead;',
  '  float arc = 0.0;',
  '  if(uState == 1) {',
  '    p = aShape;',
  '    p += vec3(sin(uTime*0.72+aPhase),cos(uTime*0.49+aPhase*1.7),',
  '              sin(uTime*0.55+aPhase*0.6))*0.028*uMotion;',
  '    float fold = sin(aShape.x*1.8+aShape.y*1.1-uTime*2.1);',
  '    p += aNormal*(uBass*.16+fold*uMid*.13)*uMotion;',
  '    p.z += sin(aShape.y*2.2-uTime*2.6+aShape.x)*(.035+uMid*.11)*uMotion;',
  '    ahead = p;',
  '    float wave = pow(max(0.0,sin(aShape.x*1.6-uTime*3.1+aSeed*0.8)),12.0);',
  '    vAlpha = 0.448+wave*1.12*uMotion;',
  '  } else {',
  '    p = flight(k); ahead = flight(min(1.0,k+0.012));',
  '    arc = sin(k*3.14159265);',
  '    vAlpha = uState == 0 ? 0.24+smoothstep(0.0,0.78,k)*0.76 : 1.0-smoothstep(0.72,1.0,k);',
  '  }',
  // 绸带式局部凹陷与球面冲击波：只扰动星尘，主星与剪影坐标仍共用原数据。
  '  float settled = uState == 1 ? 1.0 : smoothstep(0.35,0.95,uState == 0 ? k : 1.0-k);',
  '  vec3 delta = p-uPointer;',
  '  float bowl = exp(-dot(delta.xy,delta.xy)*1.8)*uPointerAmount*settled;',
  '  p.xy -= delta.xy*bowl*.12; p.z -= bowl*.46;',
  // 蓄能：按住指针时星尘被更强的引力井吸向指针，并绕它旋转半圈；
  // 松开后 uBurst 接管，把同一片粒子推出去 —— 一吸一放才有「充能→爆发」的手感。
  '  float pull = uCharge*exp(-dot(delta.xy,delta.xy)*1.15)*settled;',
  '  p.xy -= delta.xy*pull*.30;',
  '  p.xy += vec2(-delta.y,delta.x)*pull*.10;',
  '  p.z -= pull*1.05;',
  '  vec3 fromBurst = p-uBurstPoint;',
  '  float distance = length(fromBurst);',
  '  float front = exp(-pow((distance-uBurstAge*7.5)/.58,2.0))*uBurst*settled;',
  '  p += fromBurst/max(.001,distance)*front*.52;',
  '  vTint = clamp(.5+.5*sin(aShape.y*.72+aShape.x*.44+aShape.z*.9-uTime*.18*uMotion),0.0,1.0);',
  '  vFlow = pow(.5+.5*sin(aShape.x*2.0+aShape.y*.75-uTime*(2.2+uMid)*uMotion),6.0);',
  '  vEnergy = front+uOnset*.32+uCharge*.62+uTreble*pow(max(0.0,sin(aPhase*13.0+uTime*7.0)),10.0);',
  '  vAlpha *= 1.0+front*.8+uTreble*.12+uCharge*.34;',
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
  // 终止线要压得够深：低环境光 + 三次受光曲线，正面隆起与侧壁才分得开。
  '  vLight = mix(1.0,0.18+1.08*pow(wrap,3.0)+0.22*fill,uLit)*(0.7+0.3*clamp(aShine,0.0,1.0));',
  '  vRim = rim*uLit;',
  '  float size = uState == 1 ? 0.34+aShine*0.95 : (0.35+aShine*0.65)*(1.0+arc*1.8*uMotion);',
  // 前景粒子更大更亮、后景更小更暗：屏幕空间里也读出前后层次。
  '  float near = clamp((p.z-uZMin)/uZSpan,0.0,1.0);',
  '  size *= 0.65+0.5*near;',
  '  vDepth = near;',
  '  gl_PointSize = clamp(size*tw*boost*(1.0+vFlow*.24+vEnergy*.3)*(70.0/max(1.0,-mv.z))*uPixelRatio,0.6,40.0);',
  '  vShine = aShine; vCore = clamp(aShine,0.0,1.0);',
  '  gl_Position = clip;',
  '}',
].join('\n');

const SHAPE_FRAG = [
  'precision mediump float;',
  'uniform vec3 uAccent;',
  'uniform vec3 uBody;',
  'uniform vec3 uRim;',
  'uniform vec3 uCool;',
  'uniform vec3 uSecondary;',
  'uniform float uAccentMix;',
  'varying float vAlpha;',
  'varying float vShine;',
  'varying float vCore;',
  'varying float vLight;',
  'varying float vRim;',
  'varying float vDepth;',
  'varying float vTint;',
  'varying float vFlow;',
  'varying float vEnergy;',
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
  '  float a = min(1.0,halo+core)*vAlpha*(0.62+tail*0.25);',
  // 近处粒子更实、深处更淡：加法混合下这是唯一能避免「前后叠成一片」的手段。
  '  a *= 0.14+0.86*vDepth;',
  '  vec3 base = mix(uCool,uBody,smoothstep(0.06,0.52,vTint));',
  '  base = mix(base,uSecondary,smoothstep(0.52,0.96,vTint));',
  '  base = mix(base,uRim,clamp(vFlow*.48+vEnergy*.48,0.0,.72));',
  '  vec3 col = mix(base,uAccent,clamp((vShine-0.9)*1.2,0.0,uAccentMix));',
  // 受光量只乘在颜色上、不乘 alpha：扫过亮带的对比和「聚→停」亮度台阶保持原样。
  '  col *= vLight;',
  // 轮廓光用座次亮色提亮边缘，背光面留一点冷调，体积才有正反两面。
  '  col = mix(col,mix(uCool,uRim,vDepth),clamp(vRim*0.65,0.0,0.65));',
  '  col *= 0.82+0.24*vDepth;',
  '  col += core*vCore*0.17*vLight;',
  '  col *= 1.32+vFlow*.4+vEnergy*.65;',
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
  'uniform float uFocus;',
  'uniform float uAperture;',
  'varying vec3 vColor;',
  'varying float vAlpha;',
  'varying float vCoc;',
  'void main() {',
  '  vColor = aColor*uTint;',
  '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
  '  float breath = sin(uTime*(0.34+0.12*sin(aPhase))+aPhase);',
  '  float tw = 1.0-uTwinkle*0.24+uTwinkle*0.34*breath;',
  // 失焦量 = 到造型焦点面的距离：镜头只有一层能对上焦，其余摊成柔斑。
  '  float coc = uAperture>0.0 ? clamp(abs(-mv.z-uFocus)*uAperture,0.0,1.0) : 0.0;',
  '  vCoc = coc;',
  '  gl_PointSize = clamp(aSize * uSizeScale * tw * (1.0 + coc*2.6) * (1.0 / max(1.0, -mv.z)) * uPixelRatio, 1.0, 512.0);',
  '  vAlpha = aAlpha * tw * uAlpha * (1.0 - coc*0.55);',
  '  gl_Position = projectionMatrix * mv;',
  '}',
].join('\n');

const FIELD_FRAG = [
  'precision mediump float;',
  'varying vec3 vColor;',
  'varying float vAlpha;',
  'varying float vCoc;',
  'void main() {',
  '  vec2 q = gl_PointCoord - vec2(0.5);',
  '  float d = length(q);',
  // 大颗（星云斑块/柔光）用超柔边，普通星点用紧核；失焦的换成平底柔斑。
  '  float halo = smoothstep(0.5, 0.0, d);',
  '  float disc = smoothstep(0.5, 0.18, d) * 0.62;',
  '  float a = mix(halo * halo, disc, vCoc) * vAlpha;',
  '  gl_FragColor = vec4(vColor, a);',
  '}',
].join('\n');

// —— 四芒星：核心 + 十字光刺 + 柔晕。大颗亮星是画面里最锋利的一层。 ——
const GLINT_VERT = [
  'attribute float aSize;',
  'attribute float aBright;',
  'attribute float aPhase;',
  'attribute float aRunner;',
  'attribute float aIndex;',
  'attribute vec3 aTarget;',
  'uniform float uTime;',
  'uniform float uPixelRatio;',
  'uniform float uSizeScale;',
  'uniform float uBrightness;',
  'uniform float uTwinkle;',
  'uniform float uFlow;',
  'uniform float uSurge;',
  'uniform float uHoverIndex;',
  'uniform float uHoverMix;',
  'varying float vBright;',
  'void main() {',
  '  float runner = step(0.5,aRunner);',
  '  float progress = fract((uTime-2.15)*0.2-(aRunner-1.0)*0.073);',
  '  vec3 p = mix(position,aTarget,progress*runner);',
  '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
  '  float breath = sin(uTime*(0.42+0.09*sin(aPhase))+aPhase);',
  '  float flare = pow(max(0.0,breath),8.0);',
  '  float tw = 1.0+uTwinkle*(0.20*breath+0.10*flare);',
  '  float selected = 1.0-step(0.5,abs(aIndex-uHoverIndex));',
  // 点击后的能量涌流：所有沿连线飞行的光点同时增亮、胀大，读成一次「星链脉冲」。
  '  float surge = 1.0+uSurge*(0.52+runner*1.15);',
  '  gl_PointSize = clamp(aSize * uSizeScale * tw * surge * (1.0+selected*uHoverMix*.38) * (1.0 / max(1.0, -mv.z)) * uPixelRatio, 1.0, 320.0);',
  '  vBright = aBright*uBrightness*(1.0+uTwinkle*(0.27*sin(uTime*0.44+aPhase)+0.16*flare));',
  '  vBright *= 1.0+selected*uHoverMix*.48+uSurge*(0.35+runner*.9);',
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

const SHELL_VERT = [
  'attribute vec3 aTint;',
  'varying float vTone;',
  'varying vec3 vNormal;',
  'varying vec3 vView;',
  'void main() {',
  '  vec4 world = modelMatrix * vec4(position, 1.0);',
  '  vNormal = normalize(mat3(modelMatrix) * normal);',
  '  vView = cameraPosition - world.xyz;',
  '  vTone = aTint.r;',
  '  gl_Position = projectionMatrix * viewMatrix * world;',
  '}',
].join('\n');

const SHELL_FRAG = [
  'precision mediump float;',
  'uniform vec3 uColor;',
  'uniform vec3 uRim;',
  'uniform vec3 uKeyDir;',
  'uniform float uOpacity;',
  'varying float vTone;',
  'varying vec3 vNormal;',
  'varying vec3 vView;',
  'void main() {',
  '  vec3 n = normalize(vNormal);',
  '  float graze = pow(1.0 - abs(dot(n, normalize(vView))), 2.4);',
  '  float lam = dot(n, uKeyDir) * 0.5 + 0.5;',
  '  vec3 col = uColor * vTone * (0.006 + 0.034 * pow(lam, 2.6)) + uRim * graze * 0.125;',
  '  gl_FragColor = vec4(col, min(uOpacity * (0.42 + graze * 3.1), 1.0));',
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
      uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 }, uOnset: { value: 0 },
      uPointer: { value: new THREE.Vector3() }, uPointerAmount: { value: 0 },
      uBurstPoint: { value: new THREE.Vector3() }, uBurstAge: { value: 1 }, uBurst: { value: 0 },
      uCharge: { value: 0 },
      uSpin: { value: 1 },
      uStagger: { value: 0.48 },
      uSpinRate: { value: 1 },
      uArcScale: { value: 1 },
      uVariant: { value: 0 },
      uK: { value: 0 },
      uLit: { value: 1 },
      // 纵深区间由几何常量算出：前壳浮到表面之上，背壳镜像到 -1.6 附近。
      uZMin: { value: figureBackDepth(FIGURE_DEPTH) },
      uZSpan: { value: FIGURE_DEPTH + 0.16 - figureBackDepth(FIGURE_DEPTH) },
      uKeyDir: { value: new THREE.Vector3(-0.45, 0.52, 0.72).normalize() },
      uAccent: { value: new THREE.Color('#b9d3ff') },
      uBody: { value: new THREE.Color(1, 1, 1) },
      uRim: { value: new THREE.Color(1, 1, 1) },
      uCool: { value: new THREE.Color(1, 1, 1) },
      uSecondary: { value: new THREE.Color(1, 1, 1) },
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
      uFocus: { value: 0 },
      uAperture: { value: 0 },
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
      uSurge: { value: 0 },
      uHoverIndex: { value: -1 },
      uHoverMix: { value: 0 },
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

// —— 流星层：相机视角内的近景光痕。相机随动让它始终划过可见天空，
// 而不是在球壳背面错过镜头；近/远两层混合，换座时固定来一轮双流星。
const METEOR_COUNTS = { low: 5, medium: 10, high: 18 };

const METEOR_VERT = [
  'attribute vec3 aOrigin;',
  'attribute vec3 aDir;',
  'attribute vec2 aCorner;',
  'attribute float aLen;',
  'attribute float aWidth;',
  'attribute float aPhase;',
  'attribute float aPeriod;',
  'attribute float aDuration;',
  'attribute float aBright;',
  'uniform float uTime;',
  'uniform float uAlpha;',
  'varying float vAlong;',
  'varying float vAcross;',
  'varying float vAlpha;',
  'void main() {',
  '  float elapsed = mod(uTime-aPhase,aPeriod);',
  '  float t = clamp(elapsed/max(aDuration,0.01),0.0,1.0);',
  '  vec3 head = aOrigin+aDir*(aLen*(t*0.94));',
  '  vec3 tail = head-aDir*(aLen*0.34);',
  '  vec4 h = modelViewMatrix*vec4(head,1.0);',
  '  vec4 b = modelViewMatrix*vec4(tail,1.0);',
  '  vec2 direction = h.xy/max(0.001,-h.z)-b.xy/max(0.001,-b.z);',
  '  vec2 side = vec2(direction.y,-direction.x)/max(length(direction),0.00001);',
  '  vec4 p = mix(h,b,aCorner.x);',
  '  p.xy += side*aWidth*aCorner.y*mix(1.0,0.10,aCorner.x);',
  '  vAlong = aCorner.x;',
  '  vAcross = aCorner.y;',
  '  float fade = smoothstep(0.0,0.07,t)*(1.0-smoothstep(0.72,1.0,t));',
  '  vAlpha = uAlpha*aBright*fade*step(aPhase,uTime);',
  '  gl_Position = projectionMatrix*p;',
  '}',
].join('\n');

const METEOR_FRAG = [
  'precision mediump float;',
  'uniform vec3 uColor;',
  'varying float vAlong;',
  'varying float vAcross;',
  'varying float vAlpha;',
  'void main() {',
  '  float taper = pow(clamp(1.0-vAlong,0.0,1.0),3.2);',
  '  float head = exp(-vAlong*vAlong*150.0);',
  '  float edge = 1.0-smoothstep(0.08,1.0,abs(vAcross));',
  '  float a = min(1.0,(taper*0.62+head*1.05)*edge*vAlpha);',
  '  vec3 col = mix(uColor,vec3(1.0),clamp(head*.8,0.0,.75));',
  '  gl_FragColor = vec4(col*(0.95+head*0.35),a);',
  '}',
].join('\n');

// ---------------------------------------------------------------------------
// 游戏化能量场：星环 / 力场地面 / 轨道星尘
// 三层都只依赖时间与音频 uniform，不新增逐帧对象；透明度统一由 figAlpha
// 驱动，散开时整组消失，背景像素回归（「大部分天空保持近黑」）不受影响。
// ---------------------------------------------------------------------------

const AURA_RING_VERT = [
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = uv;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}',
].join('\n');

const AURA_RING_FRAG = [
  'precision mediump float;',
  'uniform float uTime;',
  'uniform float uOpacity;',
  'uniform float uBass;',
  'uniform float uOnset;',
  'uniform float uCharge;',
  'uniform float uSeed;',
  'uniform float uBearing;',
  'uniform float uAttention;',
  'uniform vec3 uColorA;',
  'uniform vec3 uColorB;',
  'varying vec2 vUv;',
  'float stroke(float r,float at,float width) {',
  '  float aa=max(fwidth(r),0.0006);',
  '  return 1.0-smoothstep(width,width+aa,abs(r-at));',
  '}',
  'void main() {',
  '  vec2 p = vUv*2.0-1.0;',
  '  float r = length(p);',
  '  float a = atan(p.y,p.x);',
  '  float phase = a-uTime*(0.055+uSeed*.018);',
  '  float segment = step(.15,fract(phase/6.283185*12.0));',
  '  float core = stroke(r,.968,.0013)+stroke(r,.803,.0008)*.40;',
  '  float track = stroke(r,.922,.0017)*segment;',
  '  float tickAngle = abs(fract(phase/6.283185*96.0+.5)-.5);',
  '  float aa = max(fwidth(phase)*15.28,.008);',
  '  float ticks = (1.0-smoothstep(.028,.028+aa,tickAngle))',
  '    *smoothstep(.837,.844,r)*(1.0-smoothstep(.872,.879,r));',
  '  float major = pow(max(0.0,cos(phase*12.0)),240.0)',
  '    *smoothstep(.846,.852,r)*(1.0-smoothstep(.902,.908,r));',
  '  float runner = pow(max(0.0,cos(a-uTime*.26-uSeed*2.1)),180.0);',
  '  float attention = pow(max(0.0,cos(a-uBearing)),24.0)*uAttention;',
  '  float halo = exp(-pow((r-.968)/.009,2.0))*.12;',
  '  float alpha = (core*.62+track*.48+ticks*.42+major*.55+halo)',
  '    *(1.0+runner*2.8+attention*1.5)*uOpacity;',
  '  alpha *= .85+uBass*.20+uOnset*.25+uCharge*.8;',
  '  vec3 col = mix(uColorA,uColorB,clamp(runner*.75+attention*.65+uCharge*.3,0.0,1.0));',
  '  gl_FragColor = vec4(col,clamp(alpha,0.0,1.0));',
  '}',
].join('\n');

const AURA_GRID_VERT = [
  'varying vec2 vPos;',
  'void main() {',
  '  vPos = position.xy;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}',
].join('\n');

const AURA_GRID_FRAG = [
  'precision mediump float;',
  'uniform float uTime;',
  'uniform float uOpacity;',
  'uniform float uBass;',
  'uniform float uOnset;',
  'uniform float uCharge;',
  'uniform vec3 uColorA;',
  'uniform vec3 uColorB;',
  'varying vec2 vPos;',
  'void main() {',
  '  vec2 q = vPos;',
  '  float r = length(q);',
  '  vec2 cell = abs(fract(q*0.34)-0.5);',
  '  float grid = smoothstep(0.475,0.5,max(cell.x,cell.y));',
  '  float ring = smoothstep(0.92,1.0,abs(sin(r*1.35-uTime*.32)));',
  '  float scan = exp(-pow((r-fract(uTime*.09)*34.0)/.9,2.0));',
  '  float fade = exp(-r*.10);',
  '  float alpha = (grid*.30+ring*.20+scan*.5)*fade*uOpacity;',
  '  alpha = clamp(alpha*(.60+uBass*.5+uOnset*.4+uCharge*.6),0.0,1.0);',
  '  vec3 col = mix(uColorA,uColorB,.5+.5*sin(r*.16-uTime*.2));',
  '  gl_FragColor = vec4(col,alpha);',
  '}',
].join('\n');

const AURA_ORBIT_VERT = [
  'attribute float aAngle;',
  'attribute float aRadius;',
  'attribute float aHeight;',
  'attribute float aSpeed;',
  'attribute float aSize;',
  'attribute float aPhase;',
  'uniform float uTime;',
  'uniform float uPixelRatio;',
  'uniform float uBass;',
  'uniform float uOnset;',
  'uniform float uCharge;',
  'uniform float uOpacity;',
  'varying float vAlpha;',
  'varying float vMix;',
  'void main() {',
  '  float angle = aAngle+uTime*aSpeed*(0.35+uBass*0.34+uCharge*0.55);',
  '  float radius = aRadius*(1.0+uBass*0.05+uCharge*0.14)+sin(uTime*0.7+aPhase)*0.07;',
  '  vec3 p = vec3(cos(angle)*radius, aHeight+sin(angle*1.7+aPhase)*0.16, sin(angle)*radius*0.62);',
  '  vec4 mv = modelViewMatrix*vec4(p,1.0);',
  '  gl_PointSize = clamp(aSize*(1.0+uOnset*.6+uCharge*.8)*uPixelRatio*90.0/max(1.0,-mv.z),1.0,18.0);',
  '  float pulse = .45+.55*(.5+.5*sin(uTime*1.35+aPhase));',
  '  vAlpha = uOpacity*pulse;',
  '  vMix = .5+.5*sin(aPhase*3.1);',
  '  gl_Position = projectionMatrix*mv;',
  '}',
].join('\n');

const AURA_ORBIT_FRAG = [
  'precision mediump float;',
  'uniform vec3 uColorA;',
  'uniform vec3 uColorB;',
  'varying float vAlpha;',
  'varying float vMix;',
  'void main() {',
  '  vec2 q = gl_PointCoord-vec2(0.5);',
  '  float d = length(q);',
  '  float core = exp(-d*d*26.0);',
  '  float halo = exp(-d*d*7.0)*0.36;',
  '  float a = (core+halo)*vAlpha;',
  '  gl_FragColor = vec4(mix(uColorA,uColorB,vMix),a);',
  '}',
].join('\n');

const SCANNER_FRAG = `
  uniform float uTime;
  uniform float uOpacity;
  uniform float uLock;
  uniform float uCharge;
  uniform float uSurge;
  varying vec2 vUv;
  float stroke(float r,float at,float width) {
    float aa=max(fwidth(r),.003);
    return 1.0-smoothstep(width,width+aa,abs(r-at));
  }
  void main() {
    vec2 p=(vUv-.5)*2.0;
    float r=length(p), a=atan(p.y,p.x);
    float brackets=stroke(r,.74,.012)*step(.45,abs(sin(a*2.0)));
    float track=stroke(r,.92,.005)*.24;
    float progress=stroke(r,.92,.019)*step(fract(a/6.283185+.25),uCharge)*step(.001,uCharge);
    float ticks=pow(max(0.0,cos(a*32.0)),32.0)*stroke(r,.83,.015)*.35;
    float cross=(1.0-smoothstep(.006,.014,min(abs(p.x),abs(p.y))))
      *smoothstep(.12,.16,r)*(1.0-smoothstep(.22,.26,r));
    float echo=stroke(r,.32+fract(uTime*.24)*.28,.008)*(1.0-fract(uTime*.24))*.28;
    vec3 col=mix(vec3(.28,.80,1.0),vec3(1.0,.80,.45),max(uLock*.85,uCharge));
    float alpha=(brackets+track+progress+ticks+cross*.5+echo)*uOpacity*(.72+uCharge*.28+uSurge*.35);
    gl_FragColor=vec4(col,clamp(alpha,0.0,1.0));
  }
`;

function makeAuraRingMaterial(THREE, seed) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uBass: { value: 0 }, uOnset: { value: 0 }, uCharge: { value: 0 },
      uSeed: { value: seed },
      uBearing: { value: 0 }, uAttention: { value: 0 },
      uColorA: { value: new THREE.Color(1, 1, 1) },
      uColorB: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: AURA_RING_VERT,
    fragmentShader: AURA_RING_FRAG,
    transparent: true,
    depthWrite: false,
    // 星环在造型后面：写深度的面罩会正确挡住环的内侧，只留下环绕剪影的光晕。
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function makeAuraGridMaterial(THREE) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uBass: { value: 0 }, uOnset: { value: 0 }, uCharge: { value: 0 },
      uColorA: { value: new THREE.Color(1, 1, 1) },
      uColorB: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: AURA_GRID_VERT,
    fragmentShader: AURA_GRID_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function makeAuraOrbitMaterial(THREE) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uOpacity: { value: 0 },
      uBass: { value: 0 }, uOnset: { value: 0 }, uCharge: { value: 0 },
      uColorA: { value: new THREE.Color(1, 1, 1) },
      uColorB: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: AURA_ORBIT_VERT,
    fragmentShader: AURA_ORBIT_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

// 软圆斑几何：共享同一批 BufferAttribute 对象，避免逐座重复上传 GPU buffer。
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
function glintGeometry(THREE, pos, size, bright, phase, index) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
  geo.setAttribute('aPhase', phase);
  geo.setAttribute('aRunner', new THREE.BufferAttribute(new Float32Array(size.length), 1));
  geo.setAttribute('aTarget', new THREE.BufferAttribute(new Float32Array(pos.length), 3));
  geo.setAttribute('aIndex', new THREE.BufferAttribute(index || new Float32Array(size.length).fill(-100), 1));
  return geo;
}

export function createWorld(THREE, scene, opts) {
  const quality = SHAPE_COUNTS[opts.quality] ? opts.quality : 'high';
  const count = SHAPE_COUNTS[quality];
  const figureCount = FIGURE_COUNTS[quality];
  const fieldCount = FIELD_COUNTS[quality];
  const sparkleCount = SPARKLE_COUNTS[quality];
  const dustCounts = DUST_COUNTS[quality] || DUST_COUNTS.high;
  const lowQ = quality === 'low';
  const disposables = [];
  if (opts.scope) {
    disposables.push = (...resources) => { resources.forEach(resource => opts.scope.track(resource)); return Array.prototype.push.apply(disposables, resources); };
  }
  let activeQuality = quality, meteorDensity = clamp(Number(opts.meteors ?? 1), 0, 1.5);
  // 力场地面是整屏级别的片元开销；低档直接停画，保底帧率优先。
  let gridAllowed = quality !== 'low';
  function setQuality(mode) {
    activeQuality = SHAPE_COUNTS[mode] ? mode : quality;
    applyLayerRanges();
  }
  function layerTotal(object) { return object.geometry.getAttribute('position').count; }
  function setLayerRange(object, target) {
    if (object) object.geometry.setDrawRange(0, Math.max(1, Math.min(layerTotal(object), Math.floor(target))));
  }
  function applyLayerRanges() {
    const mode = activeQuality, dust = DUST_COUNTS[mode] || dustCounts;
    pools.forEach(geo => geo.setDrawRange(0, Math.min(geo.getAttribute('position').count, SHAPE_COUNTS[mode])));
    hazes.forEach(geo => geo.setDrawRange(0, Math.min(geo.getAttribute('position').count, FIGURE_COUNTS[mode])));
    nodeSets.forEach(geo => geo.setDrawRange(0, geo.getAttribute('position').count));
    setLayerRange(fieldPoints, FIELD_COUNTS[mode]);
    setLayerRange(sparklePoints, SPARKLE_COUNTS[mode]);
    setLayerRange(nearDust, dust.near);
    setLayerRange(midDust, dust.mid);
    // 能量场也吃画质档：低档只留一层主环与少量轨道星尘，避免弱设备被
    // 三张大面积加法混合平面拖垮。
    ringMeshes.forEach((mesh, i) => { mesh.visible = i < (RING_COUNTS[mode] || 3); });
    gridAllowed = mode !== 'low';
    if (orbitGeo) orbitGeo.setDrawRange(0, Math.min(orbitCount, ORBIT_COUNTS[mode] || orbitCount));
    if (meteorGeo) {
      const total = Math.min(meteorCount, METEOR_COUNTS[mode]);
      const show = Math.min(total, Math.round(total * meteorDensity));
      meteorGeo.setDrawRange(0, Math.max(0, show) * 6);
      meteors.visible = show > 0;
    }
  }

  // =========================================================================
  // 1) 天空穹顶（常驻，不受星云开关影响）
  // =========================================================================
  const skyGeo = new THREE.SphereGeometry(140, lowQ ? 40 : 64, lowQ ? 26 : 40);
  const skyMat = makeSkyMaterial(THREE, lowQ ? 512 : quality === 'medium' ? 1024 : 2048);
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.name = 'zodiac-sky';
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  scene.add(sky);
  disposables.push(skyGeo, skyMat, skyMat.uniforms.uGalaxy.value);

  // =========================================================================
  // 2) 星场 + 星云斑块 + 星光点缀（背景星云开关控制整组）
  // =========================================================================
  const fieldGroup = new THREE.Group();
  fieldGroup.name = 'zodiac-field';
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
    fieldSize[i] = .65 + Math.pow(frnd(), 4.4) * 3.6;
    fieldPhase[i] = frnd() * Math.PI * 2;
    fieldAlpha[i] = 0.22 + Math.pow(frnd(), 1.6) * 0.74;
  }
  const fieldGeo = softGeometry(THREE, fieldPos,
    softAttrs(THREE, fieldCol, fieldSize, fieldPhase, fieldAlpha));
  fieldGeo.applyMatrix4(galaxyFrame);
  const fieldMat = makeFieldMaterial(THREE);
  fieldMat.uniforms.uSizeScale.value = 132;
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

  // 中景与近景星尘不跟随机位平移：转动时它们以不同速度掠过主体，形成视差。
  const dustGroup = new THREE.Group();
  dustGroup.name = 'zodiac-dust';
  scene.add(dustGroup);
  const dustRnd = seededRandom('zodiac-depth-dust-4');
  function depthDust(count, near) {
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
    const size = new Float32Array(count), phase = new Float32Array(count), alpha = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const u = dustRnd() * 2 - 1, t = dustRnd() * Math.PI * 2;
      const r = near ? 4.2 + dustRnd() * 3.2 : 8.5 + dustRnd() * 7.5;
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = Math.cos(t) * s * r;
      pos[i * 3 + 1] = u * r * .82;
      pos[i * 3 + 2] = Math.sin(t) * s * r;
      const tone = .55 + dustRnd() * .45, warm = dustRnd();
      col[i * 3] = tone * (warm > .82 ? 1 : .82);
      col[i * 3 + 1] = tone * (warm > .82 ? .9 : .9);
      col[i * 3 + 2] = tone * (warm > .82 ? .72 : 1);
      size[i] = near ? .55 + Math.pow(dustRnd(), 2.2) * 2.1 : .3 + Math.pow(dustRnd(), 3) * 1.3;
      phase[i] = dustRnd() * Math.PI * 2;
      alpha[i] = near ? .012 + dustRnd() * .026 : .026 + dustRnd() * .055;
    }
    const geo = softGeometry(THREE, pos, softAttrs(THREE, col, size, phase, alpha));
    const mat = makeFieldMaterial(THREE);
    mat.uniforms.uSizeScale.value = near ? 72 : 44;
    mat.uniforms.uTwinkle.value = near ? .35 : .7;
    // 只有景深层吃这个光圈：焦点跟着机位到造型的距离走。
    mat.uniforms.uAperture.value = near ? .09 : .04;
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = near ? 20 : -95;
    dustGroup.add(points);
    disposables.push(geo, mat);
    return points;
  }
  const midDust = depthDust(dustCounts.mid, false);
  const nearDust = depthDust(dustCounts.near, true);

  // =========================================================================
  // 2b) 流星（相机视角内、近远混合）
  // =========================================================================
  const meteorCount = METEOR_COUNTS[quality] || METEOR_COUNTS.high;
  const ambientCount = Math.max(1, meteorCount - 2);
  const ambientPeriod = Math.max(12, 4 + ambientCount * 2.8);
  const mrnd = seededRandom('zodiac-meteors-4');
  const mPos = new Float32Array(meteorCount * 6 * 3);
  const mOrigin = new Float32Array(meteorCount * 6 * 3);
  const mDir = new Float32Array(meteorCount * 6 * 3);
  const mCorner = new Float32Array(meteorCount * 6 * 2);
  const mLen = new Float32Array(meteorCount * 6);
  const mWidth = new Float32Array(meteorCount * 6);
  const mPhase = new Float32Array(meteorCount * 6);
  const mPeriod = new Float32Array(meteorCount * 6);
  const mDuration = new Float32Array(meteorCount * 6);
  const mBright = new Float32Array(meteorCount * 6);
  const CORNERS = [[0, -1], [1, -1], [1, 1], [0, -1], [1, 1], [0, 1]];
  for (let i = 0; i < meteorCount; i += 1) {
    // 前两颗锁在换座时刻，保证每轮汇聚都有肉眼可见的流星。
    const shower = i < 2, near = shower || (i - 2) % 3 !== 2;
    let ox, oy, oz, dx, dy, len, width, phase, period, duration, bright;
    if (shower) {
      const side = i === 0 ? -1 : 1;
      ox = side * (4.2 + mrnd() * 1.2); oy = 6.6 + mrnd() * 2.4; oz = -(23 + mrnd() * 5);
      const dl = Math.hypot(.38, .95);
      dx = side * .38 / dl; dy = -.95 / dl;
      len = 12 + mrnd() * 4.5; width = .045 + mrnd() * .018;
      phase = 1 + i * .26; period = CYCLE_SECONDS; duration = 2.8 + mrnd() * .3; bright = 1;
    } else {
      const slot = i - 2, side = slot % 2 ? 1 : -1;
      ox = side * (4 + mrnd() * (near ? 8 : 10)); oy = 5.8 + mrnd() * 5.2;
      oz = near ? -(21 + mrnd() * 9) : -(38 + mrnd() * 14);
      const dl = Math.hypot(.35, .8 + mrnd() * .35);
      dx = side * .35 / dl; dy = -(.8 + mrnd() * .35) / dl;
      len = near ? 10 + mrnd() * 7 : 11 + mrnd() * 8;
      width = near ? .042 + mrnd() * .022 : .082 + mrnd() * .05;
      phase = 4 + slot * 2.8; period = ambientPeriod; duration = 2.2 + mrnd() * .6;
      bright = near ? .86 + mrnd() * .2 : .48 + mrnd() * .2;
    }
    const dz = (mrnd() - .5) * .04;
    for (let v = 0; v < 6; v += 1) {
      const k = i * 6 + v;
      mOrigin.set([ox, oy, oz], k * 3);
      mDir.set([dx, dy, dz], k * 3);
      mCorner.set(CORNERS[v], k * 2);
      mLen[k] = len; mWidth[k] = width; mPhase[k] = phase;
      mPeriod[k] = period; mDuration[k] = duration; mBright[k] = bright;
    }
  }
  const meteorGeo = new THREE.BufferGeometry();
  meteorGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
  meteorGeo.setAttribute('aOrigin', new THREE.BufferAttribute(mOrigin, 3));
  meteorGeo.setAttribute('aDir', new THREE.BufferAttribute(mDir, 3));
  meteorGeo.setAttribute('aCorner', new THREE.BufferAttribute(mCorner, 2));
  meteorGeo.setAttribute('aLen', new THREE.BufferAttribute(mLen, 1));
  meteorGeo.setAttribute('aWidth', new THREE.BufferAttribute(mWidth, 1));
  meteorGeo.setAttribute('aPhase', new THREE.BufferAttribute(mPhase, 1));
  meteorGeo.setAttribute('aPeriod', new THREE.BufferAttribute(mPeriod, 1));
  meteorGeo.setAttribute('aDuration', new THREE.BufferAttribute(mDuration, 1));
  meteorGeo.setAttribute('aBright', new THREE.BufferAttribute(mBright, 1));
  meteorGeo.setDrawRange(0, meteorCount * 6);
  const meteorMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uAlpha: { value: 1 },
      uColor: { value: new THREE.Color(0.82, 0.89, 1.0) },
    },
    vertexShader: METEOR_VERT,
    fragmentShader: METEOR_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const meteorGroup = new THREE.Group();
  meteorGroup.name = 'zodiac-meteors';
  const meteors = new THREE.Mesh(meteorGeo, meteorMat);
  meteors.frustumCulled = false;
  meteors.renderOrder = 5;
  meteorGroup.add(meteors);
  scene.add(meteorGroup);
  disposables.push(meteorGeo, meteorMat);

  // =========================================================================
  // 3) 逐座预建：主粒子池 + 形象图（柔光/面片/网格边）+ 星座骨架（连线/星点）
  // =========================================================================
  const root = new THREE.Group();
  root.name = 'zodiac-figure';
  scene.add(root);
  const figureGroup = new THREE.Group();
  figureGroup.name = 'zodiac-sculpture';
  root.add(figureGroup);

  const auraGroup = new THREE.Group();
  auraGroup.name = 'zodiac-aura';
  root.add(auraGroup);
  const ringGeo = new THREE.RingGeometry(.78, 1, 256, 4);
  const ringPositions = ringGeo.getAttribute('position');
  for (let i = 0; i < ringPositions.count; i++) {
    const radius = Math.hypot(ringPositions.getX(i), ringPositions.getY(i));
    ringPositions.setZ(i, Math.sin((radius - .78) / .22 * Math.PI) * .024);
  }
  ringGeo.computeVertexNormals();
  const ringMats = [];
  const ringMeshes = [];
  const RING_RIGS = [
    { scale: 5.9, x: 1.08, y: 0.16, z: -0.26, seed: 0.35 },
    { scale: 5.05, x: 0.28, y: -0.64, z: 0.32, seed: 1.60 },
    { scale: 4.2, x: -0.52, y: 0.46, z: 0.62, seed: 2.85 },
  ];
  for (let i = 0; i < RING_RIGS.length; i += 1) {
    const rig = RING_RIGS[i];
    const mat = makeAuraRingMaterial(THREE, rig.seed);
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -86 + i;
    mesh.position.set(0, 0, -.25 - i * .12);
    mesh.rotation.set(rig.x, rig.y, rig.z);
    mesh.scale.setScalar(rig.scale);
    auraGroup.add(mesh);
    ringMats.push(mat);
    ringMeshes.push(mesh);
  }
  disposables.push(ringGeo, ...ringMats);

  const gridGeo = new THREE.PlaneGeometry(48, 48, 1, 1);
  const gridMat = makeAuraGridMaterial(THREE);
  const grid = new THREE.Mesh(gridGeo, gridMat);
  grid.name = 'zodiac-grid';
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = -3.15;
  grid.frustumCulled = false;
  grid.renderOrder = -95;
  scene.add(grid);
  disposables.push(gridGeo, gridMat);

  const orbitCount = ORBIT_COUNTS[quality] || ORBIT_COUNTS.high;
  const orbitRnd = seededRandom('zodiac-orbit-2');
  const orbitPos = new Float32Array(orbitCount * 3);
  const orbitAngle = new Float32Array(orbitCount);
  const orbitRadius = new Float32Array(orbitCount);
  const orbitHeight = new Float32Array(orbitCount);
  const orbitSpeed = new Float32Array(orbitCount);
  const orbitSize = new Float32Array(orbitCount);
  const orbitPhase = new Float32Array(orbitCount);
  for (let i = 0; i < orbitCount; i += 1) {
    orbitAngle[i] = orbitRnd() * Math.PI * 2;
    orbitRadius[i] = 2.6 + Math.pow(orbitRnd(), .72) * 3.9;
    orbitHeight[i] = (orbitRnd() - .5) * 3.0;
    orbitSpeed[i] = (.25 + orbitRnd() * .65) * (orbitRnd() < .5 ? -1 : 1);
    orbitSize[i] = .45 + Math.pow(orbitRnd(), 2.0) * 1.7;
    orbitPhase[i] = orbitRnd() * Math.PI * 2;
  }
  const orbitGeo = new THREE.BufferGeometry();
  orbitGeo.setAttribute('position', new THREE.BufferAttribute(orbitPos, 3));
  orbitGeo.setAttribute('aAngle', new THREE.BufferAttribute(orbitAngle, 1));
  orbitGeo.setAttribute('aRadius', new THREE.BufferAttribute(orbitRadius, 1));
  orbitGeo.setAttribute('aHeight', new THREE.BufferAttribute(orbitHeight, 1));
  orbitGeo.setAttribute('aSpeed', new THREE.BufferAttribute(orbitSpeed, 1));
  orbitGeo.setAttribute('aSize', new THREE.BufferAttribute(orbitSize, 1));
  orbitGeo.setAttribute('aPhase', new THREE.BufferAttribute(orbitPhase, 1));
  orbitGeo.setDrawRange(0, orbitCount);
  const orbitMat = makeAuraOrbitMaterial(THREE);
  const orbit = new THREE.Points(orbitGeo, orbitMat);
  orbit.name = 'zodiac-orbit';
  orbit.frustumCulled = false;
  orbit.renderOrder = 8;
  root.add(orbit);
  disposables.push(orbitGeo, orbitMat);

  const shapeMat = makeShapeMaterial(THREE);
  // 体积面罩：正面压到近黑，只有掠射角（侧壁与轮廓斜面）吃到光。
  // 体量因此靠「挡住背景 + 一圈受光侧壁」读出来，而不是一块会发光的塑料。
  const meshMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color('#ffffff') },
      uRim: { value: new THREE.Color('#ffffff') },
      uKeyDir: { value: new THREE.Vector3(0, 0, 1) },
      uOpacity: { value: 0 },
    },
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    transparent: true,
    side: THREE.DoubleSide,
    depthTest: true,
    // 面罩写深度：星尘、背景星与背面轮廓被体量挡住 —— 遮挡才是最强的立体线索。
    depthWrite: true,
  });
  const ribbonMat = (color, opacity, occluded = false) => new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthTest: occluded,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  // 两级轮廓丝带保留细肢与孔洞；主星骨架比轮廓更亮。
  // 轮廓边光会被体量挡住（背面那圈不该透过来），星座连线永远浮在最前。
  const edgeCoreMat = ribbonMat('#ffffff', 0.28, true);
  const edgeHaloMat = ribbonMat('#ffffff', 0.075, true);
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
  const signColors = SIGN_COLORS.map(([bodyHex, glowHex, coolHex, secondaryHex]) => {
    const body = new THREE.Color(bodyHex), glow = new THREE.Color(glowHex);
    // 自定义 shader 直接输出显示色；内置材质由 three 转换线性色。
    return {
      body, glow,
      edge: body.clone().lerp(white, .55), core: glow.clone().lerp(white, .82),
      particle: body.clone().lerp(glow, .2).convertLinearToSRGB(),
      particleRim: body.clone().lerp(glow, .55).convertLinearToSRGB(),
      cool: new THREE.Color(coolHex).convertLinearToSRGB(),
      secondary: new THREE.Color(secondaryHex).convertLinearToSRGB(),
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
  const discIndexAttr = new THREE.BufferAttribute(Float32Array.from({ length: STAR_SLOTS }, (_, i) => i), 1);
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
    mg.setAttribute('aTint', new THREE.BufferAttribute(fig.mesh.tint, 3));
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
    const dg = glintGeometry(THREE, dpos, dsize, dbright, discPhaseAttr, discIndexAttr.array);
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
  // 柔光层排在面罩之后：辉光裹在体积外面，而不是被体积吃掉。
  haze.renderOrder = -88;
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

  const scannerGeo = new THREE.PlaneGeometry(2, 2);
  const scannerMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uLock: { value: 0 },
      uCharge: { value: 0 }, uSurge: { value: 0 } },
    vertexShader: AURA_RING_VERT, fragmentShader: SCANNER_FRAG,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const scanner = new THREE.Mesh(scannerGeo, scannerMat);
  scanner.name = 'zodiac-scanner';
  scanner.visible = false; scanner.renderOrder = 25; scanner.frustumCulled = false;
  figureGroup.add(scanner);
  disposables.push(scannerGeo, scannerMat);
  const scannerTarget = new THREE.Vector3(), scannerWorld = new THREE.Vector3();
  const scannerRotation = new THREE.Quaternion();
  let scannerMix = 0;

  const pulseUniforms = { uLife: { value: 1 }, uPixel: { value: 1 }, uColor: { value: new THREE.Color('#ffffff') } };
  const pulseGeo = new THREE.RingGeometry(.84, 1, 64, 1);
  const pulseMat = new THREE.ShaderMaterial({
    uniforms: pulseUniforms,
    vertexShader: `varying float vR;void main(){vR=length(position.xy);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `uniform float uLife;uniform vec3 uColor;varying float vR;void main(){float band=smoothstep(.82,.94,vR)*(1.0-smoothstep(.94,1.0,vR));float a=band*(1.0-uLife)*.9;gl_FragColor=vec4(uColor,a);}`,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const pulse = new THREE.Mesh(pulseGeo, pulseMat);
  pulse.visible = false; pulse.renderOrder = 14; pulse.frustumCulled = false;
  figureGroup.add(pulse);
  const sparkCount = 28, sparkPos = new Float32Array(sparkCount * 3), sparkDir = new Float32Array(sparkCount * 3);
  const sparkSpeed = new Float32Array(sparkCount), sparkSize = new Float32Array(sparkCount), sparkSeed = new Float32Array(sparkCount);
  const prnd = seededRandom('zodiac-pulse-sparks-2');
  for (let i = 0; i < sparkCount; i += 1) {
    const angle = prnd() * Math.PI * 2, tilt = (prnd() - .5) * .6;
    sparkDir[i * 3] = Math.cos(angle); sparkDir[i * 3 + 1] = Math.sin(angle); sparkDir[i * 3 + 2] = tilt;
    sparkSpeed[i] = .28 + prnd() * .85; sparkSize[i] = .9 + prnd() * 2.1; sparkSeed[i] = prnd();
  }
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute('aDir', new THREE.BufferAttribute(sparkDir, 3));
  sparkGeo.setAttribute('aSpeed', new THREE.BufferAttribute(sparkSpeed, 1));
  sparkGeo.setAttribute('aSize', new THREE.BufferAttribute(sparkSize, 1));
  sparkGeo.setAttribute('aSeed', new THREE.BufferAttribute(sparkSeed, 1));
  const sparkMat = new THREE.ShaderMaterial({
    uniforms: pulseUniforms,
    vertexShader: `attribute vec3 aDir;attribute float aSpeed;attribute float aSize;attribute float aSeed;uniform float uLife;uniform float uPixel;varying float vA;
      void main(){float ease=1.0-pow(1.0-uLife,2.0);vec3 p=aDir*(aSpeed*ease);p.z+=sin(aSeed*6.2832)*.06*ease;vec4 mv=modelViewMatrix*vec4(p,1.0);gl_PointSize=clamp(aSize*(1.0-uLife)*uPixel*120.0/max(1.0,-mv.z),1.0,20.0);vA=pow(1.0-uLife,1.6);gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `uniform vec3 uColor;varying float vA;void main(){vec2 q=gl_PointCoord-.5;float r=length(q);float a=(1.0-smoothstep(.1,.5,r))*vA;gl_FragColor=vec4(uColor,a);}`,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.visible = false; sparks.renderOrder = 15; sparks.frustumCulled = false;
  figureGroup.add(sparks);
  disposables.push(pulseGeo, pulseMat, sparkGeo, sparkMat);
  let pulseLife = 1;

  let current = -1;
  let lastCycle = 0;
  let fieldVisible = true;
  let figAlpha = 1;
  let hoverNode = -1, hoverMix = 0, lastHoverEmit = 0, lastClickSerial = -1;
  // 交互状态：蓄能值（按住指针累积）、爆发倍率（松开时按蓄能放大）与
  // 星链涌流（点击后沿连线飞行的光点短暂增亮）。它们都不是几何或材质，
  // 只是 uniform 标量，换座/暂停时随生命周期归零。
  let charge = 0, surge = 0, pulsePower = 1;
  let parallaxX = 0, parallaxY = 0;
  let lastCamera = null, lastWidth = 0, lastHeight = 0;
  const pickVec = new THREE.Vector3();
  const pointerOrigin = new THREE.Vector3(), pointerNext = new THREE.Vector3();
  const pointerNdc = new THREE.Vector2();
  const ray = new THREE.Raycaster();
  function emit(event) {
    if (typeof opts.onEvent === 'function') {
      try { opts.onEvent(event); } catch (_) { /* UI must never break rendering */ }
    }
  }
  function pickStar(pointer, camera, width, height) {
    if (!pointer || !camera || current < 0 || !(width > 2) || !(height > 2)) return null;
    const line = lines[current], halfW = width * .5, halfH = height * .5;
    root.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    let best = null, bestDistance = HIT_RADIUS * HIT_RADIUS;
    for (let k = 0; k < line.nodes; k += 1) {
      pickVec.set(line.x[k], line.y[k], line.z[k]).applyMatrix4(figureGroup.matrixWorld).project(camera);
      if (pickVec.z < -1 || pickVec.z > 1) continue;
      const dx = (pickVec.x - pointer.x) * halfW, dy = (pickVec.y - pointer.y) * halfH;
      const distance = dx * dx + dy * dy;
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = { index: k, x: pickVec.x, y: pickVec.y, px: (pickVec.x * .5 + .5) * width,
          py: (1 - (pickVec.y * .5 + .5)) * height, magnitude: line.m[k], links: line.links[k], count: line.nodes };
      }
    }
    return best;
  }
  function localFromPointer(pointer, camera) {
    if (!pointer || !camera) return null;
    camera.updateMatrixWorld();
    figureGroup.updateWorldMatrix(true, false);
    pointerNdc.set(pointer.x, pointer.y);
    ray.setFromCamera(pointerNdc, camera);
    const origin = figureGroup.worldToLocal(pointerOrigin.copy(ray.ray.origin));
    const next = figureGroup.worldToLocal(pointerNext.copy(ray.ray.origin).add(ray.ray.direction));
    const dir = next.sub(origin).normalize();
    if (Math.abs(dir.z) < 1e-5) return null;
    const t = (FIGURE_Z - origin.z) / dir.z;
    return t > 0 ? origin.addScaledVector(dir, t) : null;
  }
  function startPulse(local, color, power = 1) {
    pulseLife = 0;
    pulsePower = clamp(Number(power) || 1, 1, 2.8);
    shapeMat.uniforms.uBurstPoint.value.copy(local);
    pulse.position.copy(local); sparks.position.copy(local);
    pulse.visible = true; sparks.visible = true;
    sparks.scale.setScalar(.8 + pulsePower * .28);
    pulseUniforms.uColor.value.copy(color);
  }
  function hoverEvent(best) {
    if (best) return { type: 'hover', hovered: true, index: best.index, count: best.count,
      magnitude: best.magnitude, links: best.links, x: best.px, y: best.py };
    return { type: 'hover', hovered: false };
  }

  function setSign(i) {
    const idx = ((i % SIGN_COUNT) + SIGN_COUNT) % SIGN_COUNT;
    if (idx === current) return ZODIAC[idx];
    current = idx;
    hoverNode = -1; hoverMix = 0; pulseLife = 1; pulse.visible = false; sparks.visible = false;
    scanner.visible = false; scannerMix = 0;
    scannerMat.uniforms.uLock.value = 0;
    scannerMat.uniforms.uCharge.value = 0;
    shapeMat.uniforms.uBurst.value = 0;
    shapeMat.uniforms.uBurstAge.value = 1;
    shapeMat.uniforms.uPointerAmount.value = 0;
    const color = signColors[idx];
    meshMat.uniforms.uColor.value.copy(color.body);
    meshMat.uniforms.uRim.value.copy(color.glow);
    edgeCoreMat.color.copy(color.edge);
    edgeHaloMat.color.copy(color.glow);
    coreMat.color.copy(color.core);
    haloMat.color.copy(color.glow);
    shapeMat.uniforms.uBody.value.copy(color.particle);
    shapeMat.uniforms.uRim.value.copy(color.particleRim);
    shapeMat.uniforms.uCool.value.copy(color.cool);
    shapeMat.uniforms.uSecondary.value.copy(color.secondary);
    hazeMat.uniforms.uTint.value.copy(color.haze);
    nodeMat.uniforms.uTint.value.copy(color.node);
    discMat.uniforms.uColor.value.copy(color.star);
    ringMats.forEach((material, k) => {
      material.uniforms.uColorA.value.setRGB(.30 + k * .055, .68 + k * .035, .86);
      material.uniforms.uColorB.value.copy(color.star);
      material.uniforms.uAttention.value = 0;
    });
    gridMat.uniforms.uColorA.value.setRGB(.24, .55, .68);
    gridMat.uniforms.uColorB.value.setRGB(.36, .43, .58);
    orbitMat.uniforms.uColorA.value.setRGB(.58, .80, .94);
    orbitMat.uniforms.uColorB.value.copy(color.star);
    charge = 0;
    surge = 0;
    pulsePower = 1;
    shapeMat.uniforms.uCharge.value = 0;
    discMat.uniforms.uSurge.value = 0;
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
    const line = lines[idx];
    emit({ type: 'sign', index: idx, cn: ZODIAC[idx].cn, en: ZODIAC[idx].en,
      nodes: line.nodes, segments: line.segments });
    return ZODIAC[idx];
  }

  function setPixelRatio(pr) {
    shapeMat.uniforms.uPixelRatio.value = pr;
    [fieldMat, nebulaMat, hazeMat, nodeMat, nearDust.material, midDust.material].forEach((m) => { m.uniforms.uPixelRatio.value = pr; });
    sparkleMat.uniforms.uPixelRatio.value = pr;
    discMat.uniforms.uPixelRatio.value = pr;
    orbitMat.uniforms.uPixelRatio.value = pr;
    pulseUniforms.uPixel.value = pr;
  }

  function setMeteors(value) {
    meteorDensity = clamp(Number(value ?? 1), 0, 1.5);
    applyLayerRanges();
  }

  function setPalette(palette) {
    if (!palette || !palette.accent) return;
    shapeMat.uniforms.uAccent.value.set(palette.accent).convertLinearToSRGB();
    // 应用主题只混入高亮粒子，不覆盖座次色；这一版把混入量抬到 0.16，
    // 让界面主题色在星尘峰值上也能被读到。
    shapeMat.uniforms.uAccentMix.value = .16;
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
    const mid = c.mid || 0, treble = c.treble || 0;
    const onset = c.onset || 0;
    // 能量场的动画时钟：减弱动效时归零，星环停在固定朝向、地面不再扫描。
    const effectTime = reduced ? 0 : time;

    shapeMat.uniforms.uTime.value = time;
    shapeMat.uniforms.uBoost.value = 1 + bass * 0.6 + onset * 0.8;
    shapeMat.uniforms.uBass.value = reduced ? 0 : bass;
    shapeMat.uniforms.uMid.value = reduced ? 0 : mid;
    shapeMat.uniforms.uTreble.value = reduced ? 0 : treble;
    shapeMat.uniforms.uOnset.value = reduced ? 0 : onset;
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
    const style = transitionStyle(c.cycle || 0, current < 0 ? 0 : current);
    shapeMat.uniforms.uVariant.value = state === 'disperse' ? style.disperse : style.gather;
    shapeMat.uniforms.uSpin.value = style.direction;
    // 每次汇聚/散开的错峰、旋进与弧幅都不一样：同一座下一轮也不重复。
    shapeMat.uniforms.uStagger.value = style.stagger;
    shapeMat.uniforms.uSpinRate.value = style.spin;
    shapeMat.uniforms.uArcScale.value = style.arc;
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
    meteorMat.uniforms.uTime.value = time;
    meteorMat.uniforms.uAlpha.value = reduced ? 0 : 1;
    meteorGroup.visible = !reduced && meteors.visible;
    if (c.camera) {
      meteorGroup.position.copy(c.camera.position);
      meteorGroup.quaternion.copy(c.camera.quaternion);
      meteorGroup.scale.x = clamp((Number(c.width) / Math.max(1, Number(c.height))) / 1.78, .5, 1.2);
    }
    const focus = c.camera
      ? Math.max(1, Math.hypot(c.camera.position.x - root.position.x,
        c.camera.position.y - root.position.y, c.camera.position.z - root.position.z)) : 8;
    [nearDust.material, midDust.material].forEach((material) => {
      material.uniforms.uTime.value = time;
      material.uniforms.uTwinkle.value = fTw;
      material.uniforms.uFocus.value = focus;
    });
    dustGroup.rotation.y = time * (reduced ? 0 : 0.0035);

    const pointer = c.pointer || null, uiDt = Math.max(0, Math.min(Number(c.uiDt) || 0, .1));
    lastCamera = c.camera || lastCamera;
    lastWidth = Number(c.width) || lastWidth;
    lastHeight = Number(c.height) || lastHeight;
    const allowPointer = !!(pointer && pointer.active && !pointer.dragging && !reduced);
    // 蓄能：按住指针 0.85 秒充满；松开后快速衰减。charge 同时驱动造型引力井、
    // 星环收缩/增辉与镜头 FOV，让「按住」有连续可见的反馈，而不是只等松手那一下。
    const holding = !!(allowPointer && pointer.down);
    const previousCharge = charge;
    charge = reduced ? 0 : holding ? Math.min(1, charge + uiDt / .85) : Math.max(0, charge - uiDt * 7);
    shapeMat.uniforms.uCharge.value = charge;
    // 星链涌流：点击后沿星座连线飞行的光点短暂增亮，0.34s 内衰减。
    surge = reduced ? 0 : damp(surge, 0, .34, uiDt);
    parallaxX = reduced ? 0 : damp(parallaxX, allowPointer ? pointer.x : 0, .18, uiDt);
    parallaxY = reduced ? 0 : damp(parallaxY, allowPointer ? pointer.y : 0, .18, uiDt);
    root.position.set(parallaxX * .19, parallaxY * .12, 0);
    dustGroup.position.set(-parallaxX * .50, -parallaxY * .28, 0);

    // 造型自转改成「以播放时间为唯一输入」的微摆：seek 到任意时刻画面一致，
    // 暂停时冻结；微摆展示立体侧面，同时保持剪影可识别。幅度比早期版本更大：
    // 配合逐点法线，摆角一变化明暗就跟着扫过表面，侧脸不再是「一张贴片」。
    const sway = reduced ? 0.06 : 0.54;
    root.rotation.y = Math.sin(time * 0.30) * sway + Math.sin(time * 0.085 + 1.3) * sway * 0.42;
    root.rotation.x = Math.sin(time * 0.19) * (reduced ? 0 : 0.19) + Math.cos(time * 0.075 + 0.5) * (reduced ? 0 : 0.06);
    const breathe = 1 + (reduced ? 0 : onset * 0.025 + bass * 0.035);
    root.scale.setScalar(state === 'gather' ? breathe * (0.92 + k * 0.08) : breathe);

    const pointerStrength = clamp(Number(c.pointerStrength ?? 1), 0, 2);
    const localPointer = allowPointer ? localFromPointer(pointer, c.camera) : null;
    const amount = shapeMat.uniforms.uPointerAmount;
    amount.value = reduced ? 0 : damp(amount.value, localPointer ? pointerStrength : 0, .12, uiDt);
    if (localPointer) shapeMat.uniforms.uPointer.value.copy(localPointer);

    const hovered = allowPointer && c.camera ? pickStar(pointer, c.camera, c.width, c.height) : null;
    if (hovered) {
      if (hovered.index !== hoverNode || (Number(c.now) || 0) - lastHoverEmit > 60) {
        emit(hoverEvent(hovered));
        lastHoverEmit = Number(c.now) || 0;
      }
    } else if (hoverNode >= 0) {
      emit(hoverEvent(null));
      lastHoverEmit = Number(c.now) || 0;
    }
    hoverNode = hovered ? hovered.index : -1;
    discMat.uniforms.uHoverIndex.value = hoverNode;
    hoverMix = damp(hoverMix, hoverNode >= 0 ? 1 : 0, .09, uiDt);
    discMat.uniforms.uHoverMix.value = hoverMix;

    const scannerActive = !!(allowPointer && localPointer && figureOpacity(state, k) > .05);
    scannerMix = scannerActive ? damp(scannerMix, 1, .08, uiDt) : 0;
    if (scannerActive) {
      const line = lines[current];
      if (hovered) scannerTarget.set(line.x[hoverNode], line.y[hoverNode], line.z[hoverNode]);
      else scannerTarget.copy(localPointer);
      if (!scanner.visible) scanner.position.copy(scannerTarget);
      else scanner.position.lerp(scannerTarget, 1 - Math.exp(-uiDt / .045));
      figureGroup.getWorldQuaternion(scannerRotation).invert();
      scanner.quaternion.copy(scannerRotation).multiply(c.camera.quaternion);
      scanner.getWorldPosition(scannerWorld);
      const pixelScale = 2 * scannerWorld.distanceTo(c.camera.position) * Math.tan(c.camera.fov * Math.PI / 360) / Math.max(1, c.height);
      scanner.scale.setScalar(pixelScale * (42 - hoverMix * 8 - charge * 5) / root.scale.x);
    }
    scanner.visible = scannerActive;
    scannerMat.uniforms.uTime.value = effectTime;
    scannerMat.uniforms.uOpacity.value = scannerMix;
    scannerMat.uniforms.uLock.value = hoverMix;
    scannerMat.uniforms.uCharge.value = charge;
    scannerMat.uniforms.uSurge.value = surge;

    if (pointer && pointer.click && pointer.click.serial !== lastClickSerial) {
      lastClickSerial = pointer.click.serial;
      const samePointer = pointer.active && Math.hypot(pointer.click.x - pointer.x, pointer.click.y - pointer.y) < .02;
      const hit = samePointer && hovered ? hovered : c.camera ? pickStar(pointer.click, c.camera, c.width, c.height) : null;
      if (!reduced) {
        const local = hit
          ? new THREE.Vector3(lines[current].x[hit.index], lines[current].y[hit.index], lines[current].z[hit.index])
          : localFromPointer(pointer.click, c.camera);
        // 蓄能越满，冲击波与星链涌流越强：轻点是一次涟漪，满蓄释放是一次超新星。
        const power = 1 + Math.max(previousCharge, charge) * 1.8;
        if (local) startPulse(local, signColors[current].glow, power);
        surge = 1;
      }
      if (hit) emit({ type: 'select', hovered: true, index: hit.index, count: hit.count,
        magnitude: hit.magnitude, links: hit.links, x: hit.px, y: hit.py });
    }
    if (!reduced && pulseLife < 1) {
      pulseLife = Math.min(1, pulseLife + uiDt / 1.2);
      pulseUniforms.uLife.value = pulseLife;
      pulse.scale.setScalar(.2 + pulseLife * 7.5 * pulsePower);
      if (pulseLife >= 1) { pulse.visible = false; sparks.visible = false; }
    } else if (reduced) {
      pulseLife = 1;
      pulse.visible = false; sparks.visible = false;
    }
    shapeMat.uniforms.uBurstAge.value = pulseLife;
    shapeMat.uniforms.uBurst.value = reduced ? 0 : Math.pow(1 - pulseLife, 1.4) * pulsePower;

    // 形象图 / 连线：随生命周期淡入淡出（每帧只算一次，九层共用）。
    // 透明度是材质标量，改它不触发着色器重编译，逐帧写没有代价。
    figAlpha = figureOpacity(state, k);
    hazeMat.uniforms.uAlpha.value = figAlpha;
    hazeMat.uniforms.uTime.value = time;
    // 体积面罩：它自己几乎不发光（回归线把面罩的自发光量卡在上限），存在感
    // 全部来自遮挡 —— 背景星与背壳星尘被它挡住，加上逐面明暗勾出的侧壁。
    meshMat.uniforms.uOpacity.value = 0.62 * figAlpha;
    meshMat.uniforms.uKeyDir.value.copy(shapeMat.uniforms.uKeyDir.value);
    edgeCoreMat.opacity = 0.28 * figAlpha;
    edgeHaloMat.opacity = (0.075 + bass * 0.035) * figAlpha;
    nodeMat.uniforms.uAlpha.value = figAlpha * 0.045;
    nodeMat.uniforms.uTime.value = time;
    nodeMat.uniforms.uTwinkle.value = reduced ? 0.25 : 1;
    // 点击/悬停让星座连线与沿线飞行的光点一起增辉：读成「星链被点亮」，
    // 而不是只有一颗星单独闪一下。
    coreMat.opacity = (0.90 + bass * 0.06 + surge * 0.46 + hoverMix * 0.10) * figAlpha;
    haloMat.opacity = (0.20 + bass * 0.16 + surge * 0.30 + hoverMix * 0.08) * figAlpha;
    discMat.uniforms.uBrightness.value = figAlpha * (1 + onset * 0.35);
    discMat.uniforms.uTime.value = time;
    discMat.uniforms.uTwinkle.value = reduced ? 0.25 : 1;
    discMat.uniforms.uFlow.value = reduced ? 0.2 : 1;
    discMat.uniforms.uSurge.value = reduced ? 0 : surge + hoverMix * 0.18;
    // 完全透明时整组跳过绘制：汇聚/散开阶段省掉九次 draw call。
    figureGroup.visible = figAlpha > 0.002;

    // —— 能量场：与形象图同生命周期。散开末段 figAlpha 归零，星环/地面/
    // 轨道星尘整组跳过绘制，背景恢复为纯星空（背景像素回归依赖这一点）。——
    const auraVisible = figAlpha > 0.002;
    auraGroup.visible = auraVisible;
    orbit.visible = auraVisible;
    grid.visible = auraVisible && gridAllowed;
    skyMat.uniforms.uTime.value = effectTime;
    gridMat.uniforms.uTime.value = effectTime;
    gridMat.uniforms.uOpacity.value = 0.14 * figAlpha;
    gridMat.uniforms.uBass.value = reduced ? 0 : bass;
    gridMat.uniforms.uOnset.value = reduced ? 0 : onset;
    gridMat.uniforms.uCharge.value = charge;
    for (let i = 0; i < ringMats.length; i += 1) {
      const material = ringMats[i], mesh = ringMeshes[i], rig = RING_RIGS[i];
      material.uniforms.uTime.value = effectTime;
      material.uniforms.uOpacity.value = (0.70 - i * 0.08) * figAlpha;
      material.uniforms.uBass.value = reduced ? 0 : bass;
      material.uniforms.uOnset.value = reduced ? 0 : onset;
      material.uniforms.uCharge.value = charge;
      material.uniforms.uAttention.value = scannerMix;
      if (scannerActive) {
        mesh.worldToLocal(pickVec.copy(scannerWorld));
        material.uniforms.uBearing.value = Math.atan2(pickVec.y, pickVec.x);
      }
      if (reduced) {
        mesh.rotation.set(rig.x, rig.y, rig.z);
        mesh.scale.setScalar(rig.scale);
      } else {
        const phase = i * 1.7;
        mesh.rotation.set(
          rig.x + Math.sin(effectTime * (0.09 + i * 0.025) + phase) * 0.15,
          rig.y + Math.cos(effectTime * (0.07 + i * 0.020) + phase * 1.4) * 0.22,
          rig.z + effectTime * (0.05 + i * 0.02) * (i % 2 ? -1 : 1),
        );
        mesh.scale.setScalar(rig.scale * (1 + bass * 0.03 + onset * 0.02 - charge * 0.06));
      }
    }
    orbitMat.uniforms.uTime.value = effectTime;
    orbitMat.uniforms.uOpacity.value = figAlpha * (reduced ? 0.22 : 0.48);
    orbitMat.uniforms.uBass.value = reduced ? 0 : bass;
    orbitMat.uniforms.uOnset.value = reduced ? 0 : onset;
    orbitMat.uniforms.uCharge.value = charge;

    fieldGroup.rotation.y = time * (reduced ? 0 : 0.0022);
    fieldGroup.position.copy(c.cameraPos || { x: 0, y: 0, z: 0 });
    sky.rotation.y = fieldGroup.rotation.y;
    sky.position.copy(fieldGroup.position);
  }

  function setFieldVisible(v) { fieldVisible = !!v; fieldGroup.visible = fieldVisible; }

  function screenStars() {
    if (!lastCamera || current < 0) return [];
    const line = lines[current], stars = [];
    figureGroup.updateWorldMatrix(true, false);
    lastCamera.updateMatrixWorld();
    lastCamera.matrixWorldInverse.copy(lastCamera.matrixWorld).invert();
    for (let k = 0; k < line.nodes; k += 1) {
      pickVec.set(line.x[k], line.y[k], line.z[k]).applyMatrix4(figureGroup.matrixWorld).project(lastCamera);
      if (pickVec.z < -1 || pickVec.z > 1) continue;
      stars.push({ index: k, x: pickVec.x, y: pickVec.y,
        px: (pickVec.x * .5 + .5) * lastWidth, py: (1 - (pickVec.y * .5 + .5)) * lastHeight,
        magnitude: line.m[k], links: line.links[k] });
    }
    return stars;
  }

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
      layers: 22,
      scannerActive: scanner.visible,
      charge: Math.round(charge * 1000) / 1000,
      surge: Math.round(surge * 1000) / 1000,
      auraRings: RING_COUNTS[activeQuality] || 3,
      orbitPoints: orbitGeo.drawRange.count,
      meteorCount: meteorGeo.drawRange.count / 6,
      meteorDensity,
      depthDust: nearDust.geometry.drawRange.count + midDust.geometry.drawRange.count,
      hover: hoverNode,
      stars: screenStars(),
      quality: activeQuality,
      transition: { ...transitionStyle(lastCycle, current < 0 ? 0 : current) },
    };
  }

  function dispose() {
    if (!opts.scope) disposables.forEach((d) => { d.dispose(); });
    scene.remove(root);
    scene.remove(fieldGroup);
    scene.remove(dustGroup);
    scene.remove(meteorGroup);
    scene.remove(grid);
    scene.remove(sky);
  }

  setFieldVisible(true);

  return {
    setSign, update, dispose, stats, setPalette, setPixelRatio, setFieldVisible, setQuality, setMeteors,
  };
}
