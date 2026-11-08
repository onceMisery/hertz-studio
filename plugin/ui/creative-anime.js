// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// Four original, flat-painted landscapes. All motion comes from the stage clock;
// the registry owns their parameters, camera and navigation illustrations. The
// navigation art loops through CSS keyframes in creative-anime.css (cx-* hooks)
// so the same strings double as the still painting when that sheet is absent.
(function () {
  'use strict';

  var VERT = `
out vec2 vUV;
void main() {
  const vec2 corners[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(1,1),
    vec2(-1,-1), vec2(1,1), vec2(-1,1));
  vec2 p = corners[gl_VertexID];
  vUV = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

  // Distances are in a 1600 x 900 drawing. The view crops naturally on narrow
  // screens, while the focal subjects remain near the centre. Only distant
  // silhouettes use soft edges; foreground ink remains at drawing resolution.
  var PAINT = `
in vec2 vUV;
out vec4 frag;
float aa;
const vec3 ink = vec3(0.105, 0.155, 0.285);
const vec3 cream = vec3(0.98, 0.951, 0.863);
float ellipse(vec2 p, vec2 r) { return (length(p / r) - 1.0) * min(r.x, r.y); }
float box(vec2 p, vec2 r) {
  vec2 q = abs(p) - r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
float segment(vec2 p, vec2 a, vec2 b) {
  vec2 v = b - a;
  return length(p - a - v * clamp(dot(p - a, v) / dot(v, v), 0.0, 1.0));
}
float cover(float d) { return 1.0 - smoothstep(-aa, aa, d); }
vec3 paint(vec3 c, float d, vec3 color) { return mix(c, color, cover(d)); }
vec3 softPaint(vec3 c, float d, float blur, vec3 color) {
  return mix(c, color, 1.0 - smoothstep(-blur, blur, d));
}
vec3 outline(vec3 c, float d, vec3 color, vec3 edge) {
  c = paint(c, d - 1.7, edge);
  return paint(c, d, color);
}
vec2 drawing() {
  vec2 p = (vec2(vUV.x, 1.0 - vUV.y) - 0.5) * vec2(uRes.x / uRes.y, 1.0) * 900.0;
  float c = cos(uFrame.w), s = sin(uFrame.w);
  p = mat2(c, -s, s, c) * p;
  p = p * uFrame.z + uFrame.xy + vec2(800.0, 450.0);
  aa = max(0.65, 620.0 / uRes.y) * uFrame.z;
  return p;
}
float grain(vec2 p) {
  vec3 q=fract(vec3(p.xyx)*0.1031);
  q+=dot(q,q.yzx+33.33);
  return fract((q.x+q.y)*q.z);
}
vec3 finishPaint(vec3 c, vec2 p) {
  // A fixed 6.5% paper layer, not animated film noise.
  c = mix(c, c * (0.62 + 0.72 * grain(floor(gl_FragCoord.xy))), 0.065);
  return clamp(c * uPaint.x, 0.0, 1.0);
}
// 四幅绘景与舞台共用同一份 640 x 400 画稿坐标系：1 画稿单位 ≈ 2.25 绘图
// 单位，画稿中心 (320,200) 恒对窗口中心。窄窗口裁两侧，宽窗口向两侧延展，
// 主体构图在任何舞台比例下都居中。y 轴向下，与 SVG 一致。
vec2 art() {
  aa = max(1.5, 1400.0 / uRes.y) * uFrame.z;
  vec2 p = drawing();
  return vec2((p.x - 800.0) / 2.25 + 320.0, (p.y - 450.0) / 2.25 + 200.0);
}
// 平涂折线是插画的造型语言：山脊、岸线、桥拱都用沿 x（或 y）单调的
// 关键点逐段线性插值照抄，切面和导航插画逐块对齐。
vec3 gull(vec3 c, vec2 p, vec2 at, float size, vec3 color) {
  vec2 q = (p - at) / size;
  float d = min(segment(q, vec2(-14,-4), vec2(0,0)), segment(q, vec2(0,0), vec2(13,-6)));
  return paint(c, d * size - 1.0, color);
}
float scatter(float n) { return hash11(n + uSeed * 37.0); }
`;

  var SKY = `
// 晴空云海：垭口主峰立在云海之上。山体分面、雪线破碎，统一朝向右上方光源；
// 山与岩壁固定，云海三带按 31 / 23 / 19 秒错相漂移，山腰薄雾 13 秒、
// 卷云 43 秒在透明时换相。
float crest(float x) {
  float y = 260.0;
  y = mix(y, 236.0, clamp(x / 27.0, 0.0, 1.0));
  y = mix(y, 209.0, clamp((x - 27.0) / 33.0, 0.0, 1.0));
  y = mix(y, 187.0, clamp((x - 60.0) / 36.0, 0.0, 1.0));
  y = mix(y, 159.0, clamp((x - 96.0) / 41.0, 0.0, 1.0));
  y = mix(y, 146.0, clamp((x - 137.0) / 18.0, 0.0, 1.0));
  y = mix(y, 113.0, clamp((x - 155.0) / 39.0, 0.0, 1.0));
  y = mix(y, 97.0, clamp((x - 194.0) / 20.0, 0.0, 1.0));
  y = mix(y, 79.0, clamp((x - 214.0) / 22.0, 0.0, 1.0));
  y = mix(y, 89.0, clamp((x - 236.0) / 14.0, 0.0, 1.0));
  y = mix(y, 115.0, clamp((x - 250.0) / 17.0, 0.0, 1.0));
  y = mix(y, 133.0, clamp((x - 267.0) / 18.0, 0.0, 1.0));
  y = mix(y, 152.0, clamp((x - 285.0) / 20.0, 0.0, 1.0));
  y = mix(y, 178.0, clamp((x - 305.0) / 37.0, 0.0, 1.0));
  y = mix(y, 194.0, clamp((x - 342.0) / 22.0, 0.0, 1.0));
  y = mix(y, 218.0, clamp((x - 364.0) / 25.0, 0.0, 1.0));
  y = mix(y, 265.0, clamp((x - 389.0) / 53.0, 0.0, 1.0));
  return y;
}
float faceBottom(float x) {
  float y = 247.0;
  y = mix(y, 230.0, clamp((x - 227.0) / 30.0, 0.0, 1.0));
  y = mix(y, 244.0, clamp((x - 257.0) / 19.0, 0.0, 1.0));
  y = mix(y, 239.0, clamp((x - 276.0) / 15.0, 0.0, 1.0));
  y = mix(y, 260.0, clamp((x - 291.0) / 34.0, 0.0, 1.0));
  y = mix(y, 274.0, clamp((x - 325.0) / 55.0, 0.0, 1.0));
  return y;
}
float farRidge(float x) {
  float a = (x - 450.0) / 46.0;
  float b = (x - 516.0) / 34.0;
  return 220.0 - 79.0 * exp(-a * a) - 65.0 * exp(-b * b) + sin(x * 0.11) * 2.5;
}
float cragTop(float x) {
  float y = 291.0;
  y = mix(y, 284.0, clamp(x / 15.0, 0.0, 1.0));
  y = mix(y, 292.0, clamp((x - 15.0) / 12.0, 0.0, 1.0));
  y = mix(y, 288.0, clamp((x - 27.0) / 15.0, 0.0, 1.0));
  y = mix(y, 305.0, clamp((x - 42.0) / 14.0, 0.0, 1.0));
  y = mix(y, 325.0, clamp((x - 56.0) / 11.0, 0.0, 1.0));
  y = mix(y, 324.0, clamp((x - 67.0) / 15.0, 0.0, 1.0));
  y = mix(y, 341.0, clamp((x - 82.0) / 6.0, 0.0, 1.0));
  y = mix(y, 346.0, clamp((x - 88.0) / 13.0, 0.0, 1.0));
  y = mix(y, 361.0, clamp((x - 101.0) / 3.0, 0.0, 1.0));
  y = mix(y, 367.0, clamp((x - 104.0) / 15.0, 0.0, 1.0));
  y = mix(y, 386.0, clamp((x - 119.0) / 8.0, 0.0, 1.0));
  y = mix(y, 400.0, clamp((x - 127.0) / 23.0, 0.0, 1.0));
  return y;
}
// 云顶：一排密集交叠的圆头鼓包压在缓起伏的基线上，整体按离基线的
// 深度做明暗，瓣顶再点一抹高光 —— 融成带圆弧瓣的一整团积云。
float bankBase(float x, float baseY, float amp, float ph) {
  return baseY + sin(x * 0.021 + ph) * amp * 0.35 + sin(x * 0.047 + ph * 2.3) * amp * 0.2;
}
vec3 bankPaint(vec3 c, vec2 q, float baseY, float amp, float ph, float dx, float seed,
    vec3 lit, vec3 shade, float depth, vec3 glowCol, float glowAmt) {
  vec2 s = vec2(q.x - dx, q.y);
  float base = bankBase(s.x, baseY, amp, ph);
  float d = base - s.y;
  for (int i = 0; i < 12; i++) {
    float n = float(i) * 5.1 + seed;
    float cx = (float(i) + scatter(n) * 0.9) * 55.0 - 40.0;
    float r = amp * (0.55 + scatter(n * 1.7) * 1.25);
    float cy = base - r * 0.35;
    d = min(d, length(s - vec2(cx, cy)) - r);
  }
  float g = clamp((s.y - baseY + amp) / depth, 0.0, 1.0);
  g = g * g * (3.0 - 2.0 * g);
  c = paint(c, d, mix(lit, shade, g));
  for (int i = 0; i < 12; i++) {
    float n = float(i) * 5.1 + seed;
    float cx = (float(i) + scatter(n) * 0.9) * 55.0 - 40.0;
    float r = amp * (0.55 + scatter(n * 1.7) * 1.25);
    float cy = base - r * 0.35;
    float dc = length(s - vec2(cx, cy)) - r;
    float lit2 = step(0.35, scatter(n * 2.3));
    float glow = ellipse(s - vec2(cx, cy - r * 0.55), vec2(r * 0.6, r * 0.18));
    c = mix(c, glowCol, cover(max(glow, dc)) * glowAmt * lit2);
  }
  return c;
}
void main() {
  vec2 q = art();
  // 蔚蓝晴空过渡到浅金空气；右上角一团暖光，不画日轮。
  vec3 c = mix(vec3(0.137, 0.482, 0.765), vec3(0.482, 0.788, 0.898), smoothstep(0.0, 154.0, q.y));
  c = mix(c, vec3(0.965, 0.855, 0.761), smoothstep(154.0, 320.0, q.y));
  float sun = length(q - vec2(518.0, 64.0));
  c = mix(c, vec3(1.0, 0.945, 0.737), exp(-sun * sun / 39200.0) * 0.45);
  // 卷云：26 秒周期，完全透明时换相。原来 43 秒时 1 秒只挪 1.9 个画稿单位，
  // 顶部带量出来是 0% 变化 —— 看着就是一块静止的天。
  float cyc = fract(uTime * uPaint.y / 26.0 + 0.62);
  float chop = smoothstep(0.0, 0.16, cyc) * (1.0 - smoothstep(0.8, 1.0, cyc));
  vec2 w = q - vec2(463.0 + mix(-38.0, 42.0, cyc), 52.0);
  w.x += sin(w.y * 0.16) * 14.0;
  c = mix(c, vec3(0.933, 0.976, 0.969), cover(ellipse(w, vec2(126.0, 5.5))) * 0.55 * chop * (0.5 + uPaint.z * 0.5));
  w = q - vec2(497.0 + mix(-38.0, 42.0, cyc), 66.0);
  w.x += sin(w.y * 0.2) * 10.0;
  c = mix(c, vec3(0.933, 0.976, 0.969), cover(ellipse(w, vec2(72.0, 3.6))) * 0.28 * chop * (0.5 + uPaint.z * 0.5));
  // 静态底：画稿 0..640 × 0..400 内直接采样卡片同源的那张画稿纹理。
  // 画稿外（宽屏两侧）仍由下面的程序化裙边补画，所以「窄裁宽延」这个既有行为不变。
  //
  // artOn 必须乘上纹理自己的 alpha：Chrome 对**解码失败的 SVG data URI 照样 fire onload**，
  // 那时 uArtOk 是 1 而纹理工件全透明 —— 只按 uArtOk 判就会拿 (0,0,0) 去 mix，
  // 画稿范围糊成一块黑底。带上 alpha 之后，空纹理自动让位给程序化底。
  // 静态底本身是满铺不透明的（画稿第一层就是 640×400 的空气渐变），所以 alpha 恒 1，
  // 乘它不改变正常路径的任何像素。
  float dArt = box(q - vec2(320.0, 200.0), vec2(320.0, 200.0));
  vec4 artTex = texture(uArt, q / vec2(640.0, 400.0));
  float artOn = uArtOk * cover(dArt) * step(0.5, artTex.a);
  c = mix(c, artTex.rgb, artOn);
  if (artOn < 0.5) {
    // 远山：淡蓝紫，脊线上一点残雪。
    float dFar = max(farRidge(q.x) - q.y, 312.0 - q.x);
    c = paint(c, dFar, vec3(0.6, 0.667, 0.792));
    float dSn = max(abs(q.x - 447.0) - 18.0, farRidge(q.x) - q.y);
    dSn = max(dSn, q.y - farRidge(q.x) - 5.0);
    c = paint(c, max(dSn, dFar), vec3(0.902, 0.824, 0.808));
    // 主峰：岩体对角渐变，左坡背光、右肩受光。
    float d = max(crest(q.x) - q.y, max(q.y - 346.0, q.x - 442.0));
    float t = clamp((q.y * 0.9 + (500.0 - q.x) * 0.62) / 430.0, 0.0, 1.0);
    vec3 rock = mix(vec3(0.447, 0.494, 0.690), vec3(0.322, 0.412, 0.561), smoothstep(0.0, 0.55, t));
    rock = mix(rock, vec3(0.506, 0.608, 0.698), smoothstep(0.55, 1.0, t));
    c = paint(c, d, rock);
    // 背光坡的灰紫切面。
    float A = 214.0 - 0.497 * (q.y - 97.0);
    float B = q.y < 165.0 ? 230.0 - 0.095 * (q.y - 91.0) : 223.0 - 0.978 * (q.y - 165.0);
    float dsh = max(max(A - q.x, q.x - B), max(91.0 - q.y, q.y - 254.0));
    c = mix(c, vec3(0.769, 0.741, 0.784), cover(max(dsh, d)) * 0.66);
    // 受光面：蜜桃色高光滑向冷青阴影。
    float faceL = 236.0 - 0.054 * (q.y - 79.0);
    float dFace = max(max(faceL - q.x, q.y - faceBottom(q.x)), q.x - 385.0);
    dFace = max(dFace, d);
    float ft = clamp((q.y * 0.7 + (640.0 - q.x) * 0.55) / 460.0, 0.0, 1.0);
    vec3 face = mix(vec3(0.929, 0.761, 0.725), vec3(0.702, 0.655, 0.702), smoothstep(0.0, 0.5, ft));
    face = mix(face, vec3(0.459, 0.541, 0.671), smoothstep(0.5, 1.0, ft));
    c = paint(c, dFace, face);
    // 峰顶雪檐与两道破碎雪线。
    float wedge = 19.0 - abs(q.x - 233.0) * 1.15;
    float dSnow = max(crest(q.x) - q.y, q.y - crest(q.x) - max(0.0, wedge));
    dSnow = max(dSnow, abs(q.x - 233.0) - 19.0);
    c = paint(c, max(dSnow, d), vec3(0.961, 0.937, 0.878));
    c = mix(c, vec3(1.0, 0.957, 0.871), cover(max(segment(q, vec2(233.0, 133.0), vec2(220.0, 183.0)) - 2.6, d)) * 0.85);
    c = mix(c, vec3(1.0, 0.957, 0.871), cover(max(segment(q, vec2(272.0, 116.0), vec2(287.0, 162.0)) - 2.4, dFace)) * 0.8);
    c = mix(c, vec3(1.0, 0.957, 0.871), cover(max(segment(q, vec2(247.0, 210.0), vec2(258.0, 246.0)) - 2.2, dFace)) * 0.7);
    // 岩层与沟壑的细线，密度归「云影层次」。
    float strata = 0.3 + uPaint.z * 0.5;
    c = mix(c, vec3(0.961, 0.843, 0.769), cover(max(segment(q, vec2(240.0, 112.0), vec2(247.0, 134.0)) - 0.85, dFace)) * strata);
    c = mix(c, vec3(0.961, 0.843, 0.769), cover(max(segment(q, vec2(286.0, 152.0), vec2(301.0, 175.0)) - 0.85, dFace)) * strata * 0.8);
    c = mix(c, vec3(0.961, 0.843, 0.769), cover(max(segment(q, vec2(322.0, 196.0), vec2(340.0, 220.0)) - 0.85, dFace)) * strata * 0.6);
    c = mix(c, vec3(0.204, 0.310, 0.475), cover(max(segment(q, vec2(112.0, 226.0), vec2(142.0, 210.0)) - 0.9, d)) * strata * 0.55);
    c = mix(c, vec3(0.204, 0.310, 0.475), cover(max(segment(q, vec2(160.0, 196.0), vec2(196.0, 176.0)) - 0.9, d)) * strata * 0.55);
    c = mix(c, vec3(0.204, 0.310, 0.475), cover(max(segment(q, vec2(348.0, 230.0), vec2(370.0, 250.0)) - 0.9, d)) * strata * 0.4);
  }
  // 云海三带：远带灰紫、中带奶油、近带最亮，各带自去的漂移周期；
  // 带内右侧隆起用平滑过渡衔接，不留拼接缝。
  float drift = uTime * uPaint.y * 0.2027;   // 31s
  float dx = sin(drift) * 14.0;
  float farBase = 252.0 - 20.0 * smoothstep(300.0, 390.0, q.x - dx);
  c = bankPaint(c, q, farBase, 16.0, 1.3, dx, 1.0,
    vec3(0.945, 0.922, 0.929), vec3(0.553, 0.647, 0.792), 90.0,
    vec3(0.972, 0.968, 0.972), 0.5 * (0.4 + uPaint.z * 0.6));
  drift = uTime * uPaint.y * 0.2732;         // 23s
  dx = sin(drift) * 17.0;
  float midBase = 292.0 + 26.0 * smoothstep(230.0, 320.0, q.x - dx);
  c = bankPaint(c, q, midBase, 17.0, 2.6, dx, 2.0,
    vec3(1.0, 0.976, 0.914), vec3(0.624, 0.706, 0.839), 80.0,
    vec3(1.0, 0.984, 0.929), 0.55 * (0.4 + uPaint.z * 0.6));
  drift = uTime * uPaint.y * 0.3307;         // 19s
  dx = sin(drift) * 16.0;
  float nearBase = 348.0 - 8.0 * smoothstep(410.0, 470.0, q.x - dx);
  c = bankPaint(c, q, nearBase, 14.0, 5.1, dx, 3.0,
    vec3(1.0, 0.984, 0.929), vec3(0.624, 0.706, 0.839), 70.0,
    vec3(1.0, 0.961, 0.871), 0.6 * (0.4 + uPaint.z * 0.6));
  // 左下角岩壁：冷青色，压住云海的一角。
  float dCrag = max(cragTop(q.x) - q.y, q.y - 400.0);
  float ct = clamp((q.y - 284.0) / 116.0, 0.0, 1.0);
  vec3 crag = mix(vec3(0.404, 0.549, 0.565), vec3(0.149, 0.310, 0.400), ct);
  c = paint(c, dCrag, crag);
  c = mix(c, vec3(0.831, 0.776, 0.624), cover(max(ellipse(q - vec2(10.0, 310.0), vec2(11.0, 4.5)), dCrag)) * 0.5);
  c = mix(c, vec3(0.831, 0.776, 0.624), cover(max(ellipse(q - vec2(58.0, 332.0), vec2(12.0, 5.5)), dCrag)) * 0.45);
  c = mix(c, vec3(0.153, 0.298, 0.380), cover(max(segment(q, vec2(23.0, 322.0), vec2(27.0, 355.0)) - 1.4, dCrag)) * (0.4 + uPaint.z * 0.5));
  c = mix(c, vec3(0.153, 0.298, 0.380), cover(max(segment(q, vec2(52.0, 326.0), vec2(62.0, 364.0)) - 1.4, dCrag)) * (0.4 + uPaint.z * 0.5));
  c = mix(c, vec3(0.902, 0.824, 0.675), cover(max(segment(q, vec2(6.0, 306.0), vec2(17.0, 311.0)) - 0.8, dCrag)) * (0.3 + uPaint.z * 0.4));
  c = mix(c, vec3(0.902, 0.824, 0.675), cover(max(segment(q, vec2(25.0, 312.0), vec2(33.0, 321.0)) - 0.8, dCrag)) * (0.3 + uPaint.z * 0.4));
  // 山腰薄雾：13 秒独立明暗与漂移。
  float hb = 0.5 + 0.5 * sin(uTime * uPaint.y * 0.4833);
  vec2 hz = q - vec2(234.0 + mix(-15.0, 26.0, hb), 264.0);
  c = mix(c, vec3(1.0, 0.949, 0.863), cover(ellipse(hz, vec2(92.0, 3.4))) * mix(0.25, 0.85, hb) * (0.5 + uPaint.z * 0.5));
  hz = q - vec2(241.0 + mix(-15.0, 26.0, hb), 291.0);
  c = mix(c, vec3(1.0, 0.949, 0.863), cover(ellipse(hz, vec2(61.0, 2.8))) * mix(0.2, 0.7, hb) * (0.5 + uPaint.z * 0.5));
  frag = vec4(finishPaint(c, q), 1.0);
}`;

  var COAST = `
// 黄昏海岸：左岩壁托起小灯塔，落日悬在海平线上，弧形沙岸从右下伸进画里。
// 地平线与岸线固定；碎光 11 秒舒展，涌浪 7.3 / 9.7 秒在透明时换相，
// 岸线白沫 13.1 秒往复。
float cliffTop(float x) {
  float y = 110.0;
  y = mix(y, 114.0, clamp(x / 20.0, 0.0, 1.0));
  y = mix(y, 110.0, clamp((x - 20.0) / 17.0, 0.0, 1.0));
  y = mix(y, 119.0, clamp((x - 37.0) / 15.0, 0.0, 1.0));
  y = mix(y, 124.0, clamp((x - 52.0) / 22.0, 0.0, 1.0));
  y = mix(y, 137.0, clamp((x - 74.0) / 7.0, 0.0, 1.0));
  y = mix(y, 145.0, clamp((x - 81.0) / 14.0, 0.0, 1.0));
  y = mix(y, 155.0, clamp((x - 95.0) / 5.0, 0.0, 1.0));
  y = mix(y, 156.0, clamp((x - 100.0) / 19.0, 0.0, 1.0));
  y = mix(y, 164.0, clamp((x - 119.0) / 9.0, 0.0, 1.0));
  y = mix(y, 169.0, clamp((x - 128.0) / 19.0, 0.0, 1.0));
  y = mix(y, 176.0, clamp((x - 147.0) / 9.0, 0.0, 1.0));
  y = mix(y, 183.0, clamp((x - 156.0) / 28.0, 0.0, 1.0));
  y = mix(y, 194.0, clamp((x - 184.0) / 15.0, 0.0, 1.0));
  return y;
}
float cliffBase(float x) {
  float y = 247.0;
  y = mix(y, 248.0, clamp(x / 24.0, 0.0, 1.0));
  y = mix(y, 239.0, clamp((x - 24.0) / 23.0, 0.0, 1.0));
  y = mix(y, 235.0, clamp((x - 47.0) / 33.0, 0.0, 1.0));
  y = mix(y, 226.0, clamp((x - 80.0) / 28.0, 0.0, 1.0));
  y = mix(y, 217.0, clamp((x - 108.0) / 33.0, 0.0, 1.0));
  y = mix(y, 207.0, clamp((x - 141.0) / 19.0, 0.0, 1.0));
  y = mix(y, 204.0, clamp((x - 160.0) / 24.0, 0.0, 1.0));
  y = mix(y, 194.0, clamp((x - 184.0) / 15.0, 0.0, 1.0));
  return y;
}
float sandTop(float x) {
  float y = 400.0;
  y = mix(y, 345.0, clamp((x - 136.0) / 54.0, 0.0, 1.0));
  y = mix(y, 310.0, clamp((x - 190.0) / 60.0, 0.0, 1.0));
  y = mix(y, 287.0, clamp((x - 250.0) / 80.0, 0.0, 1.0));
  y = mix(y, 272.0, clamp((x - 330.0) / 100.0, 0.0, 1.0));
  y = mix(y, 258.0, clamp((x - 430.0) / 100.0, 0.0, 1.0));
  y = mix(y, 240.0, clamp((x - 530.0) / 110.0, 0.0, 1.0));
  return y;
}
vec3 lighthouse(vec3 c, vec2 q) {
  // 塔身微收分，暗面朝右，塔顶灯室一点琥珀。
  float body = max(abs(q.x - 47.0 + (115.0 - q.y) * 0.055) - 6.5, q.y - 115.0);
  body = max(body, 76.0 - q.y);
  c = outline(c, body, vec3(0.973, 0.867, 0.749), vec3(0.4, 0.345, 0.42));
  c = paint(c, max(47.5 - q.x, max(body, q.y - 112.0)), vec3(0.722, 0.624, 0.624));
  float cap = max(abs(q.x - 47.0) - 8.0, max(q.y - 78.0, 68.0 - q.y));
  c = paint(c, cap, vec3(0.325, 0.329, 0.467));
  c = paint(c, max(abs(q.x - 47.5) - 6.5 * (78.0 - q.y) / 12.0, max(q.y - 70.0, 62.0 - q.y)), vec3(0.286, 0.286, 0.412));
  c = paint(c, max(abs(q.x - 44.5) - 1.6, abs(q.y - 73.0) - 1.6), vec3(1.0, 0.906, 0.659));
  c = paint(c, max(abs(q.x - 50.0) - 1.6, abs(q.y - 73.0) - 1.6), vec3(1.0, 0.906, 0.659));
  c = paint(c, max(abs(q.x - 47.0) - 7.5, abs(q.y - 80.0) - 0.8), vec3(0.4, 0.345, 0.471));
  return c;
}
void main() {
  vec2 q = art();
  // 珊瑚粉与杏金的暮空。
  vec3 c = mix(vec3(0.4, 0.415, 0.667), vec3(0.804, 0.545, 0.655), smoothstep(0.0, 82.0, q.y));
  c = mix(c, vec3(0.961, 0.690, 0.600), smoothstep(82.0, 141.0, q.y));
  c = mix(c, vec3(1.0, 0.878, 0.655), smoothstep(141.0, 186.0, q.y));
  float glow = length(q - vec2(461.0, 164.0));
  c = mix(c, vec3(1.0, 0.871, 0.690), exp(-glow * glow / 26000.0) * 0.55);
  // 高层云带：远带 62 秒、近带 38 秒反向缓漂。原来这里写死「静止」，
  // 结果整条顶部带在 1 秒帧间零变化 —— 天空没有风，是静止感的主因之一。
  float cdx = uTime * uPaint.y;
  vec2 w = q - vec2(150.0 + sin(cdx * 0.1013) * 26.0, 53.0);
  c = mix(c, vec3(0.439, 0.431, 0.667), cover(ellipse(w, vec2(120.0, 5.0))) * 0.36);
  w = q - vec2(505.0 + sin(cdx * 0.1013 + 2.0) * 22.0, 60.0);
  c = mix(c, vec3(0.439, 0.431, 0.667), cover(ellipse(w, vec2(92.0, 4.0))) * 0.36);
  w = q - vec2(185.0 + sin(cdx * 0.1653 + 1.0) * 34.0, 110.0);
  c = mix(c, vec3(1.0, 0.773, 0.686), cover(ellipse(w, vec2(95.0, 4.0))) * 0.74);
  w = q - vec2(152.0 + sin(cdx * 0.1653 + 1.4) * 30.0, 121.0);
  c = mix(c, vec3(1.0, 0.773, 0.686), cover(ellipse(w, vec2(60.0, 3.0))) * 0.74);
  w = q - vec2(432.0 + sin(cdx * 0.1653 + 3.0) * 30.0, 104.0);
  c = mix(c, vec3(1.0, 0.773, 0.686), cover(ellipse(w, vec2(78.0, 3.5))) * 0.74);
  // 落日与海平线。
  c = paint(c, length(q - vec2(456.0, 154.0)) - 28.0, vec3(0.996, 0.965, 0.831));
  c = paint(c, max(abs(q.y - 181.0) - 0.8, q.y - 182.0), vec3(1.0, 0.890, 0.710));
  c = mix(c, vec3(0.929, 0.729, 0.663), cover(max(abs(q.y - 151.5) - 1.6, abs(q.x - 456.0) - 66.0)) * 0.58);
  // 海面：蓝紫到深蓝的退潮色阶。
  float wt = clamp((q.y - 181.0) / 219.0, 0.0, 1.0);
  vec3 water = mix(vec3(0.843, 0.694, 0.714), vec3(0.545, 0.604, 0.757), smoothstep(0.0, 0.24, wt));
  water = mix(water, vec3(0.259, 0.424, 0.600), smoothstep(0.24, 0.7, wt));
  water = mix(water, vec3(0.157, 0.361, 0.471), smoothstep(0.7, 1.0, wt));
  c = paint(c, 181.0 - q.y, water);
  // 右侧小屿剪影。
  float isle = max(182.0 - sin(q.x * 0.05) * 2.0 - (q.x - 527.0) * 0.03 - q.y, q.y - 188.0);
  c = paint(c, max(isle, 525.0 - q.x), vec3(0.576, 0.580, 0.694));
  // 风皱：横向断续细线，随风缓移。
  float drift = uTime * uPaint.y;
  for (int i = 0; i < 12; i++) {
    float n = float(i);
    float y = 190.0 + n * 7.4 + scatter(n) * 4.0;
    float deep = clamp((y - 181.0) / 190.0, 0.0, 1.0);
    for (int j = 0; j < 3; j++) {
      float m = n * 3.1 + float(j) * 7.7;
      float x = scatter(m) * 680.0 - 20.0 + sin(drift * 0.34 + n) * 16.0;
      float len = 14.0 + scatter(m * 1.31) * 52.0;
      vec3 tint = mix(vec3(0.945, 0.812, 0.808), mix(vec3(0.753, 0.812, 0.871), vec3(0.271, 0.396, 0.553), deep), 0.45);
      c = mix(c, tint, cover(max(abs(q.y - y) - 0.75, abs(q.x - x) - len)) * (0.30 + uPaint.z * 0.38) * (1.0 - deep * 0.4));
    }
  }
  // 落日碎光：11 秒舒展呼吸。
  float ph = 0.5 + 0.5 * sin(uTime * uPaint.y * 0.5712);
  float span = mix(0.90, 1.10, ph);
  for (int i = 0; i < 15; i++) {
    float n = float(i);
    float y = 187.0 + n * 9.4;
    float x = 456.0 + (scatter(n * 2.9) - 0.5) * (14.0 + n * 3.4);
    float rx = (13.0 + scatter(n * 1.7) * 30.0 + n * 1.2) * span;
    c = mix(c, vec3(1.0, 0.898, 0.651), cover(ellipse(q - vec2(x, y), vec2(rx, 1.5 + n * 0.12)))
      * mix(0.52, 0.94, ph) * (n < 8.5 ? 1.0 : 0.62) * (0.55 + uPaint.z * 0.45));
  }
  // 左岩壁：受光面暖紫、暗面冷蓝。
  float dCliff = max(cliffTop(q.x) - q.y, max(q.y - cliffBase(q.x), q.x - 199.0));
  float kt = clamp((q.y - 110.0) * 0.62 + (199.0 - q.x) * 0.34, 0.0, 160.0) / 160.0;
  vec3 cliff = mix(vec3(0.643, 0.604, 0.678), vec3(0.396, 0.373, 0.514), smoothstep(0.0, 0.45, kt));
  cliff = mix(cliff, vec3(0.208, 0.294, 0.431), smoothstep(0.45, 1.0, kt));
  c = paint(c, dCliff, cliff);
  float grass = max(cliffTop(q.x) - q.y - 2.0, q.y - cliffTop(q.x) - 7.0);
  c = paint(c, max(max(grass, q.x - 95.0), dCliff), vec3(0.435, 0.506, 0.490));
  // 岩壁裂隙与受光棱线。
  float rock = 0.35 + uPaint.z * 0.4;
  c = mix(c, vec3(0.706, 0.627, 0.647), cover(max(segment(q, vec2(4.0, 142.0), vec2(25.0, 155.0)) - 2.2, dCliff)) * rock);
  c = mix(c, vec3(0.706, 0.627, 0.647), cover(max(segment(q, vec2(76.0, 145.0), vec2(94.0, 158.0)) - 2.0, dCliff)) * rock);
  c = mix(c, vec3(0.706, 0.627, 0.647), cover(max(segment(q, vec2(136.0, 168.0), vec2(156.0, 181.0)) - 1.8, dCliff)) * rock);
  c = mix(c, vec3(0.231, 0.298, 0.431), cover(max(segment(q, vec2(30.0, 145.0), vec2(13.0, 190.0)) - 1.1, dCliff)) * rock * 0.9);
  c = mix(c, vec3(0.231, 0.298, 0.431), cover(max(segment(q, vec2(60.0, 152.0), vec2(50.0, 200.0)) - 1.1, dCliff)) * rock * 0.9);
  c = mix(c, vec3(0.231, 0.298, 0.431), cover(max(segment(q, vec2(104.0, 172.0), vec2(96.0, 214.0)) - 1.0, dCliff)) * rock * 0.8);
  c = mix(c, vec3(0.933, 0.816, 0.718), cover(max(segment(q, vec2(13.0, 137.0), vec2(29.0, 146.0)) - 0.8, dCliff)) * (0.3 + uPaint.z * 0.4));
  c = mix(c, vec3(0.933, 0.816, 0.718), cover(max(segment(q, vec2(38.0, 149.0), vec2(45.0, 156.0)) - 0.8, dCliff)) * (0.3 + uPaint.z * 0.4));
  c = mix(c, vec3(0.933, 0.816, 0.718), cover(max(segment(q, vec2(88.0, 160.0), vec2(100.0, 168.0)) - 0.8, dCliff)) * (0.3 + uPaint.z * 0.4));
  c = lighthouse(c, q);
  // 岸脚白沫。
  float foam = abs(q.y - cliffBase(q.x) - 4.0) - 1.1;
  c = mix(c, vec3(0.922, 0.824, 0.796), cover(max(foam, 195.0 - q.x)) * 0.75);
  // 涌浪两道：7.3 / 9.7 秒在透明时换相。
  float cycA = fract(uTime * uPaint.y / 7.3 + 0.22);
  vec2 sa = q - vec2(mix(9.0, -11.0, cycA), mix(-12.0, 21.0, cycA));
  float opA = smoothstep(0.0, 0.22, cycA) * (1.0 - smoothstep(0.68, 1.0, cycA));
  c = mix(c, vec3(0.898, 0.878, 0.902), cover(abs(sa.y - 303.0 - sin(sa.x * 0.008 + 1.2) * 7.0) - 1.5) * 0.65 * opA);
  float cycB = fract(uTime * uPaint.y / 9.7 + 0.55);
  vec2 sb = q - vec2(mix(12.0, -18.0, cycB), mix(-14.0, 18.0, cycB));
  float opB = smoothstep(0.0, 0.3, cycB) * (1.0 - smoothstep(0.66, 1.0, cycB));
  c = mix(c, vec3(0.949, 0.894, 0.878), cover(abs(sb.y - 341.0 - sin(sb.x * 0.007 + 3.1) * 8.0) - 1.9) * 0.6 * opB);
  // 沙岸与湿沙反光。
  float dSand = max(sandTop(q.x) - q.y, 130.0 - q.x);
  float st = clamp(dot(vec2(q.x - 136.0, q.y - 400.0), vec2(0.83, 0.55)) / 460.0, 0.0, 1.0);
  vec3 sand = mix(vec3(0.643, 0.541, 0.671), vec3(0.867, 0.690, 0.659), smoothstep(0.0, 0.35, st));
  sand = mix(sand, vec3(0.941, 0.820, 0.690), smoothstep(0.35, 1.0, st));
  c = paint(c, dSand, sand);
  float wet = max(sandTop(q.x) - q.y, q.y - sandTop(q.x) - 20.0);
  vec3 wetC = mix(vec3(0.471, 0.557, 0.690), vec3(0.871, 0.706, 0.710), clamp((q.y - sandTop(q.x)) / 20.0, 0.0, 1.0));
  c = paint(c, max(wet, 130.0 - q.x), wetC);
  // 岸线白沫：13.1 秒往复。行程从 9 单位抬到 20 单位 —— 原来退潮只挪 9 单位
  // （画高的 2%），读起来像一条没动的水线。
  float pw = 0.5 + 0.5 * sin(uTime * uPaint.y * 0.4794);
  float edge = q.y - sandTop(q.x) + mix(-7.0, 13.0, pw);
  c = mix(c, vec3(0.969, 0.902, 0.859), cover(max(abs(edge) - 1.6, 130.0 - q.x)) * mix(0.4, 0.85, pw));
  c = mix(c, vec3(1.0, 0.945, 0.859), cover(max(abs(edge - 7.0) - 0.7, 150.0 - q.x)) * mix(0.25, 0.7, pw));
  for (int i = 0; i < 10; i++) {
    float n = float(i);
    float x = 175.0 + n * 47.0 + sin(n * 2.1) * 8.0;
    c = mix(c, vec3(1.0, 0.953, 0.875), cover(box(q - vec2(x, sandTop(x) + 9.0 + sin(n) * 4.0), vec2(2.6, 1.3))) * (0.4 + uPaint.z * 0.35));
  }
  // 近景石块与沙面碎点。
  c = paint(c, ellipse(q - vec2(473.0, 372.0), vec2(21.0, 7.0)), vec3(0.714, 0.584, 0.627));
  c = paint(c, ellipse(q - vec2(471.0, 369.0), vec2(14.0, 6.5)), vec3(0.416, 0.420, 0.525));
  c = paint(c, ellipse(q - vec2(556.0, 328.0), vec2(15.0, 5.5)), vec3(0.467, 0.502, 0.600));
  c = paint(c, ellipse(q - vec2(554.0, 326.0), vec2(11.0, 4.5)), vec3(0.827, 0.722, 0.710));
  c = paint(c, ellipse(q - vec2(329.0, 366.0), vec2(6.0, 2.4)), vec3(0.737, 0.624, 0.647));
  c = paint(c, ellipse(q - vec2(292.0, 383.0), vec2(4.0, 1.8)), vec3(0.737, 0.624, 0.647));
  for (int i = 0; i < 8; i++) {
    float n = float(i);
    float x = 200.0 + scatter(n * 5.1) * 420.0;
    float y = sandTop(x) + 12.0 + scatter(n * 2.3) * 60.0;
    c = mix(c, vec3(0.573, 0.498, 0.580), cover(max(abs(q.y - y) - 0.5, abs(q.x - x) - 2.2)) * (0.35 + uPaint.z * 0.3));
  }
  // 海鸥：卡片那份是 cx-coast-gulls 会飞的，舞台这两只原来钉死在坐标上。
  float gx = sin(uTime * uPaint.y * 0.107) * 46.0;
  float gy = sin(uTime * uPaint.y * 0.214 + 1.2) * 9.0;
  c = gull(c, q, vec2(268.0 + gx, 107.0 + gy), 0.9, vec3(0.451, 0.420, 0.569));
  c = gull(c, q, vec2(299.0 + gx * 0.72, 119.0 + gy * 0.6), 0.6, vec3(0.451, 0.420, 0.569));
  frag = vec4(finishPaint(c, q), 1.0);
}`;

  var RAIL = `
// 月下列车：细雨里，青蓝客车带着琥珀车窗横穿石拱桥。桥、山与接触网静止；
// 列车 37.7 移出画外换相，两幕细雨错相衔接，薄雾 17 秒漂移。
float farCrest(float x) {
  float y = 201.0;
  y = mix(y, 168.0, clamp(x / 66.0, 0.0, 1.0));
  y = mix(y, 145.0, clamp((x - 66.0) / 34.0, 0.0, 1.0));
  y = mix(y, 135.0, clamp((x - 100.0) / 27.0, 0.0, 1.0));
  y = mix(y, 113.0, clamp((x - 127.0) / 43.0, 0.0, 1.0));
  y = mix(y, 118.0, clamp((x - 170.0) / 27.0, 0.0, 1.0));
  y = mix(y, 147.0, clamp((x - 197.0) / 34.0, 0.0, 1.0));
  y = mix(y, 162.0, clamp((x - 231.0) / 49.0, 0.0, 1.0));
  y = mix(y, 155.0, clamp((x - 280.0) / 60.0, 0.0, 1.0));
  y = mix(y, 175.0, clamp((x - 340.0) / 80.0, 0.0, 1.0));
  y = mix(y, 168.0, clamp((x - 420.0) / 80.0, 0.0, 1.0));
  y = mix(y, 185.0, clamp((x - 500.0) / 140.0, 0.0, 1.0));
  return y;
}
float hillTop(float x) {
  return 252.0 + sin(x * 0.012 + 1.2) * 14.0 + sin(x * 0.033 + 3.0) * 6.0;
}
float groundTop(float x) {
  return 323.0 + sin(x * 0.008 + 0.5) * 10.0 + sin(x * 0.027) * 5.0;
}
// 拱洞：圆心落在 104 的等距桩距上，跨过画框继续延伸。
float arch(vec2 q) {
  float cx = 61.0 + floor((q.x - 61.0) / 104.0 + 0.5) * 104.0;
  float dx = abs(q.x - cx);
  float apex = 333.0 - sqrt(max(0.0, 1369.0 - dx * dx));
  return max(apex - q.y, dx - 37.0);
}
float catenary(float x) {
  float s = (x - 296.0) / 236.0;
  return 219.5 + 14.0 * (1.0 - s * s);
}
// 细雨：沿运动方向的斜网格，相位每循环平移 24 行，同行取同一抖动，
// 接缝在数学上无缝。画稿 y 轴向下，所以相位必须从 s 里**减**掉：加了会让
// 同一颗雨落在越来越小的 q.y 上，看起来就是雨往上飘（卡片那份是 translate(… ,440px) 向下）。
vec3 rainField(vec3 c, vec2 q, float loop, float width, float len, float op, float seed) {
  float s = dot(q, vec2(-0.0815, 0.9967)) - fract(uTime * uPaint.y / loop) * 1056.0;
  float p = dot(q, vec2(0.9967, 0.0815));
  float row = floor(s / 44.0);
  float col = floor(p / 46.0);
  float m = mod(row, 24.0);
  float h1 = hash11(m * 12.7 + col * 3.17 + seed);
  float h2 = hash11(m * 5.31 + col * 17.93 + seed + 4.0);
  float sc = (row + 0.3 + h1 * 0.4) * 44.0;
  float pc = (col + 0.5 + (h2 - 0.5) * 0.6) * 46.0;
  float d = length(vec2(max(0.0, abs(s - sc) - len * (0.7 + h2 * 0.6)), p - pc)) - width;
  return mix(c, vec3(0.808, 0.875, 1.0), cover(d) * op);
}
void main() {
  vec2 q = art();
  // 月夜：靛蓝到雾紫。
  vec3 c = mix(vec3(0.078, 0.153, 0.278), vec3(0.243, 0.341, 0.576), smoothstep(0.0, 148.0, q.y));
  c = mix(c, vec3(0.557, 0.565, 0.729), smoothstep(148.0, 257.0, q.y));
  c = mix(c, vec3(0.776, 0.686, 0.725), smoothstep(257.0, 330.0, q.y));
  float moon = length(q - vec2(448.0, 68.0));
  c = mix(c, vec3(0.667, 0.737, 0.890), exp(-moon * moon / 102400.0) * 0.34);
  // 新月：一弯 #fff1ce，暗侧朝左下。
  float disc = length(q - vec2(449.0, 48.0)) - 21.0;
  float bite = length(q - vec2(440.0, 54.0)) - 17.0;
  c = mix(c, vec3(1.0, 0.945, 0.808), cover(disc) * (1.0 - cover(bite)));
  vec2 w = q - vec2(456.0, 104.0);
  c = mix(c, vec3(0.659, 0.718, 0.843), cover(ellipse(w, vec2(104.0, 7.0))) * 0.19);
  // 远山与峰值残雪。
  float dFar = farCrest(q.x) - q.y;
  c = paint(c, dFar, vec3(0.408, 0.482, 0.651));
  c = mix(c, vec3(0.659, 0.659, 0.749), cover(max(segment(q, vec2(166.0, 116.0), vec2(186.0, 124.0)) - 2.0, dFar)) * (0.3 + uPaint.z * 0.3));
  c = mix(c, vec3(0.659, 0.659, 0.749), cover(max(segment(q, vec2(140.0, 139.0), vec2(155.0, 147.0)) - 1.5, dFar)) * (0.3 + uPaint.z * 0.3));
  // 中景山脊与谷底。
  float dHill = hillTop(q.x) - q.y;
  c = paint(c, dHill, mix(vec3(0.275, 0.369, 0.537), vec3(0.149, 0.247, 0.400), clamp((q.y - 235.0) / 90.0, 0.0, 1.0)));
  // 山腰薄雾：17 秒漂移。
  float hm = 0.5 + 0.5 * sin(uTime * uPaint.y * 0.3696);
  vec2 mz = q - vec2(320.0 + mix(-22.0, 22.0, hm), 238.0);
  c = mix(c, vec3(0.745, 0.776, 0.882), cover(ellipse(mz, vec2(260.0, 18.0))) * mix(0.06, 0.13, hm) * (0.5 + uPaint.z * 0.5));
  mz = q - vec2(430.0 + mix(-22.0, 22.0, hm), 330.0);
  c = mix(c, vec3(0.745, 0.776, 0.882), cover(ellipse(mz, vec2(210.0, 15.0))) * mix(0.08, 0.17, hm) * (0.5 + uPaint.z * 0.5));
  // 谷底地面。
  c = paint(c, groundTop(q.x) - q.y, vec3(0.145, 0.263, 0.392));
  // 石拱桥：桥身渐变，六个拱洞透出雾谷。
  float dStone = max(277.0 - q.y, q.y - 400.0);
  float sx = clamp((q.x * 0.6 + q.y * 0.8 - 300.0) / 260.0, 0.0, 1.0);
  vec3 stone = mix(vec3(0.459, 0.514, 0.592), vec3(0.294, 0.376, 0.490), smoothstep(0.0, 0.3, sx));
  stone = mix(stone, vec3(0.157, 0.235, 0.353), smoothstep(0.3, 1.0, sx));
  c = paint(c, dStone, stone);
  float dArch = max(arch(q), 277.0 - q.y);
  c = paint(c, dArch, mix(vec3(0.098, 0.173, 0.290), vec3(0.157, 0.235, 0.353), clamp((q.y - 300.0) / 100.0, 0.0, 1.0)));
  // 拱缘两道描边：内亮外暗。
  c = mix(c, vec3(0.573, 0.627, 0.702), cover(abs(dArch) - 4.5) * 0.63 * step(277.5, q.y));
  c = mix(c, vec3(0.573, 0.627, 0.702), cover(abs(dArch) - 1.6) * 0.45 * step(277.5, q.y));
  // 桥面人行道与轨顶。
  c = paint(c, max(269.0 - q.y, q.y - 277.0), vec3(0.157, 0.239, 0.349));
  c = mix(c, vec3(0.733, 0.749, 0.800), cover(abs(q.y - 271.0) - 0.55) * 0.85);
  c = mix(c, vec3(0.733, 0.749, 0.800), cover(abs(q.y - 279.0) - 0.55) * 0.85);
  c = mix(c, vec3(0.122, 0.212, 0.325), cover(max(abs(q.y - 284.0) - 0.5, dStone)) * 0.6);
  c = mix(c, vec3(0.122, 0.212, 0.325), cover(max(abs(q.y - 290.0) - 0.5, dStone)) * 0.6);
  // 砌石短痕。
  for (int i = 0; i < 12; i++) {
    float n = float(i);
    float x = 30.0 + scatter(n * 7.3) * 580.0;
    float y = 300.0 + scatter(n * 2.9) * 90.0;
    c = mix(c, vec3(0.639, 0.678, 0.729), cover(max(abs(q.y - y) - 0.45, abs(q.x - x) - (3.0 + scatter(n) * 5.0))) * (0.18 + uPaint.z * 0.3));
  }
  // 接触网：支柱、承力索与吊弦。
  vec3 wire = vec3(0.129, 0.224, 0.341);
  float wy = catenary(q.x);
  c = paint(c, abs(q.y - wy) - 0.7, wire);
  c = paint(c, abs(q.y - wy - 11.0) - 0.35, wire);
  c = paint(c, max(abs(q.x - 61.5) - 1.5, max(q.y - 273.0, wy - q.y)), wire);
  c = paint(c, max(abs(q.x - 554.0) - 1.5, max(q.y - 273.0, catenary(554.0) - q.y)), wire);
  float armA = max(abs(q.y - catenary(61.5)) - 1.2, max(q.x - 104.0, 58.5 - q.x));
  c = paint(c, armA, wire);
  float armB = max(abs(q.y - catenary(554.0)) - 1.2, max(q.x - 597.0, 552.5 - q.x));
  c = paint(c, armB, wire);
  for (int i = 0; i < 5; i++) {
    float n = float(i);
    float x = 105.0 + n * 100.0;
    c = mix(c, wire, cover(max(abs(q.x - x) - 0.45, max(wy - q.y, q.y - wy - 11.0))) * (0.4 + uPaint.z * 0.6));
  }
  // 列车：37.7 秒横穿，画外换相。
  float xoff = mix(-413.0, 663.0, fract(uTime * uPaint.y / 37.7));
  vec2 u = vec2(q.x - xoff, q.y);
  float nose = 376.0 + (u.y - 240.0) * 0.65;
  float dBody = max(max(3.0 - u.x, u.x - nose), max(240.0 - u.y, u.y - 266.0));
  float bt = clamp((u.y - 240.0) / 26.0, 0.0, 1.0);
  vec3 body = mix(vec3(0.773, 0.847, 0.831), vec3(0.525, 0.773, 0.796), smoothstep(0.0, 0.22, bt));
  body = mix(body, vec3(0.349, 0.620, 0.678), smoothstep(0.22, 0.5, bt));
  body = mix(body, vec3(0.220, 0.416, 0.514), smoothstep(0.5, 1.0, bt));
  c = outline(c, dBody, body, vec3(0.133, 0.208, 0.290));
  c = paint(c, max(dBody, u.y - 243.0), vec3(0.741, 0.839, 0.839));
  c = paint(c, max(dBody, 262.0 - u.y), vec3(0.133, 0.298, 0.408));
  c = paint(c, max(dBody, abs(u.y - 258.0) - 0.7), vec3(0.910, 0.757, 0.565));
  // 车窗带：三节车厢的琥珀窗。
  float bandX = min(min(max(15.0 - u.x, u.x - 104.0), max(136.0 - u.x, u.x - 225.0)), max(257.0 - u.x, u.x - 338.0));
  c = paint(c, max(max(bandX, 246.0 - u.y), u.y - 256.0), vec3(0.145, 0.243, 0.345));
  for (int car = 0; car < 3; car++) {
    for (int win = 0; win < 5; win++) {
      float wx = 26.5 + float(car) * 121.0 + float(win) * 19.0;
      float dWin = max(abs(u.x - wx) - 6.5, abs(u.y - 251.0) - 3.6);
      vec3 glass = mix(vec3(1.0, 0.894, 0.627), vec3(0.914, 0.678, 0.396), clamp((u.y - 247.4) / 7.2, 0.0, 1.0));
      c = paint(c, max(dWin, dBody), glass);
    }
    float dxr = 125.0 + float(car) * 121.0;
    float door = max(abs(u.x - dxr) - 4.5, abs(u.y - 252.0) - 8.0);
    c = paint(c, max(door, dBody), vec3(0.361, 0.529, 0.588));
    c = paint(c, max(abs(u.x - dxr + 2.5) - 0.6, max(abs(u.y - 252.0) - 8.0, dBody)), vec3(0.882, 0.761, 0.596));
  }
  for (int i = 0; i < 6; i++) {
    float bx = 22.0 + float(i) * 61.0;
    c = paint(c, max(max(bx - u.x, u.x - bx - 20.0), max(266.0 - u.y, u.y - 270.0)), vec3(0.086, 0.176, 0.278));
    c = paint(c, length(u - vec2(bx + 10.0, 270.0)) - 3.0, vec3(0.086, 0.176, 0.278));
  }
  c = paint(c, max(length(u - vec2(383.0, 260.0)) - 1.8, dBody), vec3(1.0, 0.949, 0.733));
  c = paint(c, max(length(u - vec2(6.5, 255.0)) - 1.3, dBody), vec3(0.941, 0.616, 0.529));
  // 两幕细雨。
  c = rainField(c, q, 12.6, 0.55, 11.0, 0.25, 1.0);
  c = rainField(c, q, 9.6, 0.7, 15.0, 0.32, 9.0);
  // 前景灌木剪影。
  float bushL = 368.0 + sin(q.x * 0.05) * 4.0 + sin(q.x * 0.013) * 3.0;
  c = paint(c, max(bushL - q.y, q.x - 185.0), vec3(0.094, 0.192, 0.286));
  float bushR = 388.0 + sin(q.x * 0.05 + 2.0) * 5.0;
  c = paint(c, max(bushR - q.y, q.x - 428.0), vec3(0.094, 0.192, 0.286));
  frag = vec4(finishPaint(c, q), 1.0);
}`;

  var FOREST = `
// 森间灯火：雨后翡翠林间，树干自然收细，树冠围出浅金林隙，蜿蜒小径
// 通向一盏暖灯。树木、灯具与光束方向固定；萤火游移，灯 7.7 秒、
// 斜光 23.3 秒、蕨叶 8.3 秒独立变化。
float beamD(vec2 q, vec2 a, vec2 b, float r0, float r1) {
  vec2 v = b - a;
  float t = clamp(dot(q - a, v) / dot(v, v), 0.0, 1.0);
  return length(q - a - v * t) - mix(r0, r1, t);
}
float pathX(float y) {
  float x = 352.0;
  x = mix(x, 349.0, clamp((y - 263.0) / 31.0, 0.0, 1.0));
  x = mix(x, 316.0, clamp((y - 294.0) / 43.0, 0.0, 1.0));
  x = mix(x, 287.0, clamp((y - 337.0) / 63.0, 0.0, 1.0));
  return x;
}
float pathW(float y) {
  float w = 9.0;
  w = mix(w, 20.0, clamp((y - 263.0) / 31.0, 0.0, 1.0));
  w = mix(w, 52.0, clamp((y - 294.0) / 43.0, 0.0, 1.0));
  w = mix(w, 124.0, clamp((y - 337.0) / 63.0, 0.0, 1.0));
  return w;
}
float groundTop(float x) {
  return 298.0 + sin(x * 0.011 + 2.0) * 8.0 + sin(x * 0.027 + 1.0) * 5.0;
}
float canopyTop(float x) {
  return 34.0 + 12.0 * sin(x * 0.05 + 1.0) + 6.0 * sin(x * 0.113 + 2.0);
}
// 树干：带收分的竖干，边缘一丝弯曲。
float trunk(vec2 q, float x, float w, float y0, float y1) {
  float bend = x + sin(q.y * 0.02 + x) * 2.0;
  return max(abs(q.x - bend) - w * (0.55 + q.y * 0.0012), max(y0 - q.y, q.y - y1));
}
void main() {
  vec2 q = art();
  // 翡翠色的进深：对角渐变透出薄荷色空气。
  float dt = clamp(dot(q - vec2(128.0, 0.0), vec2(0.693, 0.722)) / 545.0, 0.0, 1.0);
  vec3 c = mix(vec3(0.082, 0.306, 0.314), vec3(0.294, 0.643, 0.545), smoothstep(0.0, 0.44, dt));
  c = mix(c, vec3(0.416, 0.686, 0.549), smoothstep(0.44, 0.69, dt));
  c = mix(c, vec3(0.125, 0.357, 0.275), smoothstep(0.69, 1.0, dt));
  // 中央林隙的浅金空气与一束暖光。
  float air = length(q - vec2(365.0, 192.0));
  c = mix(c, vec3(0.875, 0.867, 0.627), exp(-air * air / 51200.0) * 0.55);
  // 远处细干。
  for (int i = 0; i < 10; i++) {
    float n = float(i);
    float x = 190.0 + n * 30.0 + scatter(n * 3.3) * 12.0;
    c = mix(c, vec3(0.576, 0.765, 0.647), cover(trunk(q, x, 1.4 + scatter(n) * 1.2, -10.0, 248.0 + scatter(n * 1.9) * 30.0)) * 0.36);
  }
  // 中景三干与斜枝。
  c = paint(c, trunk(q, 148.0, 4.6, -10.0, 332.0), vec3(0.231, 0.537, 0.455));
  c = paint(c, trunk(q, 324.0, 4.4, -10.0, 336.0), vec3(0.231, 0.537, 0.455));
  c = paint(c, trunk(q, 518.0, 5.4, -10.0, 332.0), vec3(0.231, 0.537, 0.455));
  c = paint(c, segment(q, vec2(148.0, 120.0), vec2(196.0, 88.0)) - 1.6, vec3(0.231, 0.537, 0.455));
  c = paint(c, segment(q, vec2(324.0, 96.0), vec2(288.0, 132.0)) - 1.5, vec3(0.231, 0.537, 0.455));
  c = paint(c, segment(q, vec2(518.0, 140.0), vec2(478.0, 110.0)) - 1.7, vec3(0.231, 0.537, 0.455));
  // 地面、小径与林下灌丛。
  c = paint(c, groundTop(q.x) - q.y, vec3(0.267, 0.529, 0.408));
  float pt = clamp((q.y - 263.0) / 137.0, 0.0, 1.0);
  vec3 path = mix(vec3(0.827, 0.773, 0.545), vec3(0.620, 0.667, 0.463), smoothstep(0.0, 0.42, pt));
  path = mix(path, vec3(0.404, 0.533, 0.365), smoothstep(0.42, 1.0, pt));
  float dPath = max(abs(q.x - pathX(q.y) - sin(q.y * 0.08) * 5.0) - pathW(q.y) * 0.5, q.y - 401.0);
  dPath = max(dPath, 263.0 - q.y);
  c = paint(c, dPath, path);
  c = mix(c, vec3(0.843, 0.808, 0.592), cover(max(abs(q.x - pathX(q.y) + pathW(q.y) * 0.5 - 2.5) - 1.0, dPath)) * (0.25 + uPaint.z * 0.25));
  float bushL = 334.0 + sin(q.x * 0.03 + 1.0) * 7.0 - q.x * 0.06;
  c = paint(c, max(bushL - q.y, q.x - 178.0), vec3(0.157, 0.396, 0.298));
  float bushR = 344.0 + sin(q.x * 0.024 + 3.0) * 6.0 + (q.x - 500.0) * 0.05;
  c = paint(c, max(bushR - q.y, q.x - 356.0), vec3(0.157, 0.396, 0.298));
  // 斜光：三束从右上切入林隙，18.5 秒明暗，呼吸深度从 0.55–0.9 抬到 0.40–1.0。
  float ro = 0.5 + 0.5 * sin(uTime * uPaint.y * 0.3396);
  float rayOp = mix(0.40, 1.0, ro);
  c = mix(c, vec3(1.0, 0.894, 0.631), (1.0 - smoothstep(-4.0, 7.0, beamD(q, vec2(397.0, -10.0), vec2(237.0, 375.0), 12.0, 33.0))) * 0.30 * rayOp);
  c = mix(c, vec3(1.0, 0.894, 0.631), (1.0 - smoothstep(-4.0, 6.0, beamD(q, vec2(435.0, -10.0), vec2(317.0, 331.0), 5.0, 12.0))) * 0.30 * 0.65 * rayOp);
  c = mix(c, vec3(1.0, 0.894, 0.631), (1.0 - smoothstep(-4.0, 5.0, beamD(q, vec2(371.0, 6.0), vec2(237.0, 281.0), 4.0, 10.0))) * 0.30 * 0.45 * rayOp);
  // 近景大干：左、右两根与画框两根，树皮渐变。
  float btL = clamp((q.x - 91.0) / 19.0, 0.0, 1.0);
  vec3 barkL = mix(vec3(0.071, 0.247, 0.239), vec3(0.208, 0.455, 0.365), btL);
  barkL = mix(barkL, vec3(0.267, 0.529, 0.420), smoothstep(0.75, 1.0, btL));
  c = paint(c, trunk(q, 100.5, 9.5, -10.0, 292.0), barkL);
  c = paint(c, segment(q, vec2(106.0, 118.0), vec2(140.0, 96.0)) - 1.8, vec3(0.133, 0.357, 0.298));
  c = paint(c, segment(q, vec2(104.0, 190.0), vec2(76.0, 168.0)) - 1.6, vec3(0.133, 0.357, 0.298));
  vec3 barkR = mix(vec3(0.267, 0.529, 0.420), vec3(0.145, 0.369, 0.314), clamp((q.x - 468.0) / 18.0, 0.0, 1.0));
  c = paint(c, trunk(q, 477.0, 9.0, -10.0, 296.0), barkR);
  c = paint(c, segment(q, vec2(472.0, 128.0), vec2(438.0, 104.0)) - 1.7, vec3(0.157, 0.373, 0.310));
  c = paint(c, trunk(q, 29.5, 17.5, -10.0, 401.0), mix(vec3(0.071, 0.247, 0.239), vec3(0.271, 0.510, 0.400), clamp((q.x - 12.0) / 35.0, 0.0, 1.0)));
  c = paint(c, segment(q, vec2(40.0, 96.0), vec2(76.0, 62.0)) - 2.4, vec3(0.094, 0.290, 0.251));
  c = paint(c, segment(q, vec2(38.0, 214.0), vec2(70.0, 196.0)) - 2.0, vec3(0.094, 0.290, 0.251));
  c = paint(c, trunk(q, 591.0, 16.0, -10.0, 401.0), mix(vec3(0.271, 0.510, 0.400), vec3(0.071, 0.247, 0.239), clamp((q.x - 575.0) / 32.0, 0.0, 1.0)));
  c = paint(c, segment(q, vec2(582.0, 108.0), vec2(546.0, 82.0)) - 2.3, vec3(0.098, 0.294, 0.251));
  c = paint(c, segment(q, vec2(585.0, 228.0), vec2(552.0, 210.0)) - 2.0, vec3(0.098, 0.294, 0.251));
  // 树冠：顶缘扇贝形，叶团起伏。
  c = paint(c, q.y - canopyTop(q.x), vec3(0.110, 0.345, 0.282));
  for (int i = 0; i < 12; i++) {
    float n = float(i);
    float x = 14.0 + n * 54.0 + sin(n * 2.3) * 10.0;
    c = mix(c, vec3(0.224, 0.514, 0.416), cover(ellipse(q - vec2(x, canopyTop(x) - 5.0), vec2(26.0, 10.0))) * 0.7);
  }
  // 叶簇点缀。
  float leaf = 0.3 + uPaint.z * 0.5;
  c = mix(c, vec3(0.169, 0.451, 0.333), cover(ellipse(q - vec2(66.0, 86.0), vec2(11.0, 5.0))) * leaf);
  c = mix(c, vec3(0.169, 0.451, 0.333), cover(ellipse(q - vec2(558.0, 64.0), vec2(12.0, 5.5))) * leaf);
  c = mix(c, vec3(0.169, 0.451, 0.333), cover(ellipse(q - vec2(545.0, 150.0), vec2(9.0, 4.5))) * leaf);
  c = mix(c, vec3(0.169, 0.451, 0.333), cover(ellipse(q - vec2(96.0, 200.0), vec2(10.0, 4.5))) * leaf);
  // 挂灯：吊线、外壳、蜜色玻璃与光晕。
  float glowT = 0.5 + 0.5 * sin(uTime * uPaint.y * 0.8161);
  float lampGlow = mix(0.64, 0.92, glowT);
  float halo = length(q - vec2(448.0, 181.0));
  c = mix(c, vec3(1.0, 0.894, 0.627), exp(-halo * halo / 1800.0) * lampGlow);
  c = mix(c, vec3(1.0, 0.894, 0.627), exp(-halo * halo / 7400.0) * lampGlow * 0.5);
  c = paint(c, segment(q, vec2(448.0, 155.0), vec2(448.0, 46.0)) - 0.7, vec3(0.624, 0.675, 0.522));
  c = paint(c, segment(q, vec2(448.0, 86.0), vec2(462.0, 76.0)) - 0.7, vec3(0.624, 0.675, 0.522));
  float housing = max(abs(q.x - 448.5) - 13.5, abs(q.y - 181.0) - 15.0);
  c = outline(c, housing, vec3(0.196, 0.306, 0.259), vec3(0.161, 0.243, 0.208));
  float glassD = max(abs(q.x - 448.5) - 9.5, abs(q.y - 181.0) - 12.5);
  vec3 glass = mix(vec3(0.839, 0.592, 0.329), vec3(1.0, 0.941, 0.718), 1.0 - abs(q.x - 448.5) / 10.5);
  glass *= 0.92 + 0.08 * lampGlow;
  c = paint(c, max(glassD, housing), glass);
  c = paint(c, max(abs(q.x - 448.5) - 15.5, abs(q.y - 164.5) - 2.5), vec3(0.208, 0.294, 0.243));
  c = paint(c, max(abs(q.x - 450.5) - 15.5, abs(q.y - 198.0) - 2.0), vec3(0.208, 0.294, 0.243));
  c = mix(c, vec3(0.600, 0.533, 0.353), cover(max(abs(q.y - 174.0) - 0.45, glassD)) * 0.75);
  c = mix(c, vec3(0.600, 0.533, 0.353), cover(max(abs(q.y - 181.0) - 0.45, glassD)) * 0.75);
  c = mix(c, vec3(0.600, 0.533, 0.353), cover(max(abs(q.y - 188.0) - 0.45, glassD)) * 0.75);
  c = mix(c, vec3(1.0, 0.969, 0.812), cover(max(abs(q.x - 445.5) - 1.6, max(glassD, abs(q.y - 181.0) - 11.0))) * 0.8);
  // 七枚萤火。前三枚沿用画稿那三个位置与周期（与卡片一致），后四枚补进林隙空档。
  // 漂移幅度、光晕半径与亮度包络各抬一档：原来 3 枚 × 0.25 光晕的结果是
  // 「25.7% 的像素在动、平均只有 1.36」—— 大面积微变被眼睛读成没动。
  const vec2 fBase[7] = vec2[7](vec2(226.0, 240.0), vec2(385.0, 286.0), vec2(294.0, 346.0),
    vec2(163.0, 297.0), vec2(451.0, 251.0), vec2(352.0, 213.0), vec2(122.0, 262.0));
  const float fDrift[7] = float[7](11.3, 17.9, 13.7, 15.1, 9.8, 20.3, 12.6);
  const float fRise[7] = float[7](7.9, 11.1, 9.1, 10.4, 6.8, 13.2, 8.3);
  const float fBlink[7] = float[7](4.7, 6.1, 5.9, 5.2, 4.4, 6.8, 3.9);
  for (int i = 0; i < 7; i++) {
    float n = float(i);
    vec2 at = fBase[i] + vec2(sin(uTime * uPaint.y * 6.2832 / fDrift[i] + n * 2.1) * (26.0 - n * 1.6),
      sin(uTime * uPaint.y * 6.2832 / fRise[i] + n * 4.2) * (20.0 - n * 1.2));
    float shine = mix(0.08, 0.98, 0.5 + 0.5 * sin(uTime * uPaint.y * 6.2832 / fBlink[i] + n * 1.3));
    float r = 5.6 - n * 0.35;
    c = mix(c, vec3(1.0, 0.910, 0.631), cover(length(q - at) - r) * shine * 0.45);
    c = mix(c, vec3(1.0, 0.910, 0.631), cover(length(q - at) - (1.6 - n * 0.09)) * shine);
  }
  // 底部暗坡与蕨叶（6.6 秒轻转）。摆角从 0.6° 抬到 2°：0.0105 弧度在 r=200 处
  // 只挪 2 个画稿单位，等于没动。卡片侧 cx-forest-fern 同步到 2deg，两边同一语言。
  c = paint(c, max(372.0 + sin(q.x * 0.03) * 6.0 - q.y, q.x - 168.0), vec3(0.090, 0.247, 0.200));
  c = paint(c, max(392.0 + sin(q.x * 0.04 + 2.0) * 4.0 - q.y, q.x - 452.0), vec3(0.090, 0.247, 0.200));
  float fernA = 0.034 * sin(uTime * uPaint.y * 0.95);
  vec2 fq = vec2(q.x - 82.0, q.y - 400.0);
  fq = mat2(cos(fernA), -sin(fernA), sin(fernA), cos(fernA)) * fq;
  fq += vec2(82.0, 400.0);
  vec3 fernC = vec3(0.314, 0.549, 0.380);
  c = paint(c, beamD(fq, vec2(82.0, 398.0), vec2(100.0, 345.0), 4.0, 1.1), fernC);
  c = paint(c, beamD(fq, vec2(82.0, 398.0), vec2(82.0, 338.0), 3.4, 0.9), fernC);
  c = paint(c, beamD(fq, vec2(82.0, 398.0), vec2(64.0, 352.0), 3.0, 0.9), fernC);
  // 草叶与地面碎光。
  float grass = 0.35 + uPaint.z * 0.4;
  c = mix(c, vec3(0.475, 0.643, 0.439), cover(max(segment(q, vec2(151.0, 355.0), vec2(152.0, 341.0)) - 1.0, 168.0 - q.x)) * grass);
  c = mix(c, vec3(0.475, 0.643, 0.439), cover(max(segment(q, vec2(320.0, 345.0), vec2(326.0, 333.0)) - 1.0, 356.0 - q.x)) * grass);
  c = mix(c, vec3(0.475, 0.643, 0.439), cover(max(segment(q, vec2(513.0, 368.0), vec2(519.0, 355.0)) - 1.0, q.x - 452.0)) * grass);
  c = mix(c, vec3(0.671, 0.763, 0.545), cover(max(segment(q, vec2(435.0, 320.0), vec2(439.0, 313.0)) - 0.6, groundTop(q.x) - q.y)) * grass * 0.7);
  c = mix(c, vec3(0.671, 0.763, 0.545), cover(max(segment(q, vec2(245.0, 330.0), vec2(248.0, 324.0)) - 0.6, groundTop(q.x) - q.y)) * grass * 0.7);
  frag = vec4(finishPaint(c, q), 1.0);
}`;

  // Navigation illustrations are independent vector studies of the registered
  // scenes. Shared linework and warm light unite four distinct scene palettes.
  // Static gradients supply depth; CSS transforms carry the moving layers.
  //
  // body 可以是整串 SVG（该场景还没拆层，舞台仍全程序化），也可以是图层数组。图层三种：
  //   { svg }                  静态底 —— 卡片与舞台共用，舞台侧走光栅化纹理
  //   { motion, svg }          带 cx-* 的动画层 —— 卡片由 CSS keyframes 驱动，
  //                            舞台侧仍是 GLSL 程序化动画，两边相位各自跑，所以不进底纹理
  //   { keep, svg }            静态但**压在动画层之上**的造型（如前景岩压住近带云海）——
  //                            进了底纹理会被云盖住，遮挡关系就翻了，所以留在着色器里
  // 拆层的目的只有一个：让「同一幅画被手写两遍」变成一份画稿两个消费者。
  function celArt(scene, defs, body) {
    var layers = typeof body === 'string' ? [{ svg: body }] : body;
    function join(want) {
      return layers.filter(want).map(function (l) { return l.svg; }).join('');
    }
    var head = '<svg xmlns="http://www.w3.org/2000/svg" class="ws-scene-art celx celx-' + scene
      + '" viewBox="0 0 640 400" aria-hidden="true" focusable="false"><defs>' + defs + '</defs>';
    var staticBody = join(function (l) { return !l.motion && !l.keep; });
    return {
      svg: head + join(function () { return true; }) + '</svg>',
      // 不带 defs 里没引用的渐变也无害，整份 defs 一起给，省掉逐层判引用。
      staticSvg: typeof body === 'string' || !staticBody.trim()
        ? null : head + staticBody + '</svg>'
    };
  }

  // 01 / Alpine air. Irregular ridgelines, exposed strata and sculpted cloud
  // volumes share one light direction; only vapor moves through the landscape.
  var artSky = celArt('sky', `
    <linearGradient id="cx-sky-air" gradientUnits="userSpaceOnUse" x2="0" y2="320"><stop stop-color="#1565d8"/><stop offset=".48" stop-color="#58bde8"/><stop offset="1" stop-color="#ffd9a0"/></linearGradient>
    <radialGradient id="cx-sky-sun" cx=".81" cy=".16" r=".66"><stop stop-color="#fff3c0" stop-opacity=".7"/><stop offset="1" stop-color="#ffd98a" stop-opacity="0"/></radialGradient>
    <linearGradient id="cx-sky-rock" x1=".8" y1="0" x2=".2" y2="1"><stop stop-color="#9a8ad0"/><stop offset=".55" stop-color="#5a6aa8"/><stop offset="1" stop-color="#7f8fc8"/></linearGradient>
    <linearGradient id="cx-sky-face" x1="1" y1="0" x2="0" y2="1"><stop stop-color="#f6cbb6"/><stop offset=".5" stop-color="#c9a0b8"/><stop offset="1" stop-color="#a088b8"/></linearGradient>
    <radialGradient id="cx-sky-cloud" cx=".44" cy=".12" r=".85" gradientTransform="translate(0 -.07) scale(1 1.3)"><stop stop-color="#fff9ee"/><stop offset=".33" stop-color="#f5e8d8"/><stop offset=".66" stop-color="#a8a8dc"/><stop offset="1" stop-color="#7f8fc8"/></radialGradient>
    <radialGradient id="cx-sky-shadow" cx=".4" cy="0" r="1"><stop stop-color="#a8b4d8"/><stop offset=".48" stop-color="#8496c8"/><stop offset="1" stop-color="#5f74b8"/></radialGradient>
    <linearGradient id="cx-sky-crag" x1="1" y1="0" x2="0" y2="1"><stop stop-color="#3f6a78"/><stop offset="1" stop-color="#10283f"/></linearGradient>`, [
    { svg: `
    <path fill="url(#cx-sky-air)" d="M0 0h640v400H0z"/>` },
    { motion: 'cx-sky-glow', svg: `
    <path class="cx-motion cx-sky-glow" fill="url(#cx-sky-sun)" d="M0 0h640v400H0z"/>` },
    { motion: 'cx-sky-cirrus', svg: `
    <g class="cx-motion cx-sky-cirrus" fill="#eef9f7" opacity=".55">
      <path d="M337 48c41-16 66-12 87-19 25-9 46-8 72-14-30 13-54 14-74 21-23 8-42 5-85 12Z"/>
      <path d="M377 60c40-9 55-6 80-13 27-7 44-9 65-11-37 12-47 11-63 16-23 7-52 6-82 8Z" opacity=".5"/>
    </g>` },
    { motion: 'cx-sky-birds', svg: `
    <g class="cx-motion cx-sky-birds" fill="none" stroke="#2c3e63" stroke-width="2.2" stroke-linecap="round" opacity=".7">
      <g class="cx-motion cx-sky-bob">
        <path d="M96 74c6-5 12-5 17 0m10-9c5-4 10-4 14 0"/>
      </g>
    </g>` },
    { svg: `
    <path d="m315 214 24-25 11 5 18-16 14 3 21-26 13 6 22-20 15 9 11-6 14 20 12-4 22 25 15-5 25 20 13-5 25 20 12-6 18 11 20-5v179H315Z" fill="#7f8fc8"/>
    <path d="m438 141-9 28 14 10-5 14 21 7-10-28 4-22 11-6 14 20 12-4 22 25-44-14 25 41-49-23-30-26Z" fill="#f2e8dc" opacity=".8"/>` },
    { svg: `
    <path d="M0 260 27 236 38 235 60 209 70 211 96 187 104 191 137 159 144 162 155 146 165 148 194 113 202 115 214 97 222 99 236 79 245 90 250 89 267 115 277 117 285 133 293 132 305 152 319 160 323 170 342 178 355 194 364 192 389 218 407 221 442 265v81H0Z" fill="url(#cx-sky-rock)" stroke="#232a4a" stroke-width="3" stroke-linejoin="round"/>
    <path d="M0 260 27 236 38 235 60 209 70 211 96 187 104 191 137 159 144 162 155 146 165 148 194 113 202 115 214 97 222 99 236 79L0 346Z" fill="#1b2352"/>
    <path d="M236 79 245 90 250 89 267 115 277 117 285 133 293 132 305 152 319 160 323 170 342 178 355 194 364 192 389 218 407 221 442 265" fill="none" stroke="#ffd9a8" stroke-width="2.5" opacity=".9"/>` },
    { svg: `
    <path d="m236 79-5 45 8 13-10 28 15-6-10 35 12 17-19 36 30-17 19 14 15-5 34 21 55 14-34-36-12-29-17-11-12-19-13-20-12-26-18-19-9-24-8-1Z" fill="url(#cx-sky-face)"/>
    <path d="m214 97-22 53-3 21-35 43 22-9-9 22-31 27 43-17 35-46 9-26-8-10 8-32 7-32Z" fill="#9a8fb0" opacity=".85"/>` },
    { svg: `
    <path d="m236 79-7 25-10 9 4-14-9 15-12 1-8 17-16 16 6-19 10-16 8 2 12-18 8 2Z" fill="#fff6ea" stroke="#3c4c7e" stroke-width="1.1" stroke-linejoin="round"/>
    <path d="m236 79 9 11 5-1 17 26 10 2 8 16-16-9-9-18-8-5-1 12-8-15-2 17-10 9Z" fill="#fff4de"/>
    <path d="m233 133-6 28-14 24-16 10 15-22 9-29 3-1m40-19 17 27 5 23 15 23-13-9-13-21-3-25Z" fill="#b9c9e8"/>` },
    { svg: `
    <path d="m201 132-19 48-22 19 5-14 14-14Zm-54 33-18 40-19 14 12-24Zm72 35-9 25-25 27 9-28Zm30-57 9 21-7 29 14 18-1-35Zm64 38 17 30 18 14-10-28Z" fill="#455d87" opacity=".8"/>
    <path d="m238 113 7 12-3 22 7 17m4-26 10 19 2 24 15 26m-63-78-12 25-4 17m-24 3-18 29-19 14m99-19-10 25-17 18m88-42 14 23 18 14m-39-9 3 14 19 15" fill="none" stroke="#f5d7c4" stroke-width="1.1" opacity=".7"/>
    <path d="m112 226 25-16 16-18m-50 48 20-5 30-25m-6 35 27-17 9-15m92 6 20 21 13 6m-62 6 30-4 33 20m-8-36 31 21 22 3" fill="none" stroke="#232a4a" stroke-width="1" opacity=".5"/>
    <path d="m52 118h40m-10 16h32m-46 34h30" fill="none" stroke="#ffffff" stroke-width="1" opacity=".32"/>` },
    { svg: `
    <path d="M0 258c88-9 152-7 232-11 76-4 148 4 220 0 68-4 130-2 188-6v24c-62 6-124 4-192 8-72 4-142-4-216 0-80 4-146 2-232 10Z" fill="#fbe3c4" opacity=".3"/>` },
    { motion: 'cx-sky-bank-far', svg: `
    <g class="cx-motion cx-sky-bank-far">
      <path d="M-54 265c12-16 29-22 45-17-7-19 15-32 33-25 3-19 31-23 42-7 12-8 30-5 37 8 21-8 42 1 44 15 14-7 33-5 44 5 20-22 46-23 66-10 13-23 48-22 59-2 16-8 33-5 41 8 23-20 59-16 69 6 18-9 35-7 45 8 27-13 46-6 55 8 16-21 43-24 58-10 17-28 59-26 71-1 20-7 37 0 45 18v86H-54Z" fill="url(#cx-sky-shadow)" stroke="#3c4c7e" stroke-width="2" stroke-linejoin="round"/>
      <path d="M337 251c-5-18 13-32 31-27 3-23 25-40 47-34 12-24 42-28 60-9 18-9 43 2 44 23 26-4 42 11 40 28 24-5 46 6 47 24 23-7 44 5 47 21-76 22-90 4-123 5-44 1-62-12-100-6-33 6-64-9-93-25Z" fill="url(#cx-sky-cloud)" stroke="#3c4c7e" stroke-width="2" stroke-linejoin="round"/>
      <path d="M399 202c9-22 35-31 54-15-13-3-31-2-40 9l-14 6Zm79 5c13-8 29 0 29 13-8-10-16-10-29-13Z" fill="#fff9e8" opacity=".7"/>
      <path d="M-29 239c11-16 32-16 41-6 9-23 29-26 48-13-19-2-30 4-36 18 24-6 43 8 52 16-46 8-62-10-105-15Z" fill="#f9f0e6"/>
    </g>` },
    { motion: 'cx-sky-bank-mid', svg: `
    <g class="cx-motion cx-sky-bank-mid">
      <path d="M-65 335c1-25 27-41 49-35-11-25 12-48 36-43-1-26 26-45 48-32 20-24 58-14 61 16 26-8 48 8 47 30 22-6 45 6 49 26 27-2 42 10 43 29 28-18 57-9 70 11v82H-65Z" fill="url(#cx-sky-cloud)" stroke="#3c4c7e" stroke-width="2" stroke-linejoin="round"/>
      <path d="M26 267c-3-19 10-32 24-32-12 13-11 28-4 36-17-5-33 3-41 15 1-10 9-17 21-19Zm58-28c20-8 39 10 37 27-7-14-17-22-37-27Z" fill="#fffbed" opacity=".8"/>
      <path d="M75 311c21-18 53-15 66 5 16-12 45-5 49 16 17-3 34 4 41 18-51-7-73 8-103-1-20-6-46-9-72-4 2-16 8-26 19-34Z" fill="url(#cx-sky-shadow)" opacity=".74"/>
      <path d="M254 325c12-21 41-32 60-16-1-24 26-41 47-29 12-24 43-29 62-9 14-8 35 2 37 17 17-10 41-3 46 16 22-12 49 3 51 20 24-7 49 6 51 27-78 17-135 0-183 9-65 13-107-6-171-35Z" fill="url(#cx-sky-cloud)" stroke="#3c4c7e" stroke-width="2" stroke-linejoin="round"/>
      <path d="M366 286c6-17 28-20 41-9-13-1-30 4-41 9Zm65 23c18-21 47-11 49 7-15-12-28-11-49-7Z" fill="#fffae8" opacity=".65"/>
    </g>` },
    { motion: 'cx-sky-bank-near', svg: `
    <g class="cx-motion cx-sky-bank-near">
      <path d="M229 363C242 340 256 318 284 316C302 316 314 318 336 322C346 330 350 342 356 346C366 314 386 286 414 284C436 284 448 286 468 292C478 310 482 336 490 340C502 316 526 292 552 290C574 290 582 292 602 298C612 314 614 338 620 342C632 318 646 296 664 294C669 294 671 297 674 300V415Z" fill="#6a7fba" stroke="#3c4c7e" stroke-width="2.4" stroke-linejoin="round"/>
      <path d="M195 415C208 392 222 370 250 368C268 368 280 370 302 374C312 382 316 394 322 398C332 366 352 338 380 336C402 336 414 338 434 344C444 362 448 388 456 392C468 368 492 344 518 342C540 342 548 344 568 350C578 366 580 390 586 394C598 370 612 348 630 346C635 346 637 349 640 352V415Z" fill="#8b9ccc" stroke="#3c4c7e" stroke-width="2.4" stroke-linejoin="round"/>
      <path d="M195 415C208 392 222 370 250 368C268 368 280 370 302 374C312 382 316 394 322 398C332 366 352 338 380 336C402 336 414 338 434 344C444 362 448 388 456 392C468 368 492 344 518 342C540 342 548 344 568 350C578 366 580 390 586 394C598 370 612 348 630 346C635 346 637 349 640 352L640 386C637 383 635 380 630 380C612 382 598 404 586 428C580 424 578 400 568 384C548 378 540 376 518 376C492 378 468 402 456 426C448 422 444 396 434 378C414 372 402 370 380 370C352 372 332 400 322 432C316 428 312 416 302 408C280 404 268 402 250 402C222 404 208 426 195 449Z" fill="url(#cx-sky-cloud)"/>
</g>` },
    { keep: true, svg: `
    <path d="M0 291 15 284 27 292 42 288 56 305 63 308 67 325 82 324 88 341 101 346 104 361 119 367 127 386 150 400H0Z" fill="url(#cx-sky-crag)" stroke="#0f1830" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M0 291 15 284 27 292 42 288 56 305 63 308 67 325 82 324 88 341 101 346 104 361 119 367 127 386 150 400L0 400Z" fill="#14203f"/>
    <path d="m0 297 17-7 10 9 14-5 11 19-10 8-18-4-3 17-21 3Zm62 31 12 0 10 17 15 8-7 11-11-17-22-3Z" fill="#d4c69f" opacity=".66"/>
    <path d="m23 322 4 33-8 22m29-56 9 26-2 27 12 26m13-50 8 17-2 18 11 15M6 348l7 20-7 32" fill="none" stroke="#1b3050" stroke-width="2"/>
    <path d="m6 306 11 5m19-4 8 9m-6 27 6 17m23 2 7 17m27 3 8 13" fill="none" stroke="#e6d2ac" stroke-width=".8" opacity=".55"/>` },
    { motion: 'cx-sky-haze', svg: `
    <g class="cx-motion cx-sky-haze" fill="#fff6e0">
      <path d="M143 264c48-8 77-7 113-2 28 3 43-1 69-2-21 10-51 10-77 7-41-5-71 1-105-3Z" opacity=".45"/>
      <path d="M181 291c27-3 39-3 61-1 26 3 43 2 59 0-27 10-82 5-120 1Z" opacity=".38"/>
    </g>` }
  ]);

  // 02 / Tidal light. A fixed headland and horizon establish scale; the water
  // alone carries broken reflections, advancing crests and withdrawing foam.
  // JOJO 化处理：天空走深紫→热玫瑰→珊瑚→金的四段高饱和渐变；岩壁与灯塔上墨线，
  // 暗面平涂深紫硬阴、受光脊加暖边缘光；浪花加粗加白并补两朵白帽浪。
  var artCoast = celArt('coast', `
    <linearGradient id="cx-coast-sky" gradientUnits="userSpaceOnUse" x2="0" y2="186"><stop stop-color="#58479e"/><stop offset=".44" stop-color="#f0629b"/><stop offset=".76" stop-color="#ff8a5c"/><stop offset="1" stop-color="#ffe3a0"/></linearGradient>
    <radialGradient id="cx-coast-glow" cx=".72" cy=".41" r=".52"><stop stop-color="#ffd9a0" stop-opacity=".75"/><stop offset="1" stop-color="#ff8a5c" stop-opacity="0"/></radialGradient>
    <linearGradient id="cx-coast-water" x2=".35" y2="1"><stop stop-color="#c98fa8"/><stop offset=".7" stop-color="#2c4f86"/><stop offset="1" stop-color="#123a5e"/></linearGradient>
    <linearGradient id="cx-coast-sand" x1="0" y1="0" x2=".6" y2="1"><stop stop-color="#b98ac0"/><stop offset="1" stop-color="#ffd9a0"/></linearGradient>
    <linearGradient id="cx-coast-cliff" x1="1" y1="0" x2=".2" y2="1"><stop stop-color="#8a7fae"/><stop offset="1" stop-color="#241d3a"/></linearGradient>
    <linearGradient id="cx-coast-sun" x2="0" y2="1"><stop stop-color="#fffbe8"/><stop offset="1" stop-color="#ffd76b"/></linearGradient>
    <linearGradient id="cx-coast-wet" x2=".65" y2="1"><stop stop-color="#6f5570"/><stop offset="1" stop-color="#cf937e"/></linearGradient>
    <linearGradient id="cx-coast-shimmer" gradientUnits="userSpaceOnUse" x2="0" y2="366"><stop stop-color="#ffd76b" stop-opacity=".86"/><stop offset=".74" stop-color="#ff9f6b" stop-opacity=".5"/><stop offset="1" stop-color="#ff8a5c" stop-opacity="0"/></linearGradient>
    <radialGradient id="cx-coast-beacon" cx=".5" cy=".5" r=".5"><stop stop-color="#fff2c6" stop-opacity=".62"/><stop offset="1" stop-color="#ffd76b" stop-opacity="0"/></radialGradient>`, `
    <path d="M0 0h640v400H0z" fill="url(#cx-coast-sky)"/>
    <path class="cx-motion cx-coast-glow" d="M0 0h640v300H0z" fill="url(#cx-coast-glow)"/>
    <path d="M-10 53c95-6 110 17 179 13 61-4 80 12 131 9-48 13-72 1-126 4-71 4-100-13-184-9Zm364-17c53-10 70-2 113-8 32-4 51-3 70 1-54 2-66 15-100 12-30-3-47-2-83-5Z" fill="#7a5fb0" opacity=".4"/>
    <path d="M310 95c69-6 86 4 140 2 48-2 62 7 101 4-44 10-74 4-109 6-61 2-85-8-132-12ZM36 112c56-4 85 2 123 4 39 1 64-1 97 5-69 4-161-3-220-9Z" fill="#ff9a7a" opacity=".8"/>
    <circle cx="456" cy="154" r="28" fill="url(#cx-coast-sun)"/>
    <path d="M409 150c39-1 69 1 100-1l31 3-143 1Z" fill="#edbaa9" opacity=".58"/>
    <path d="m348 118 22-8m30 22 26-10m-14 34 24-6" fill="none" stroke="#fff3c0" stroke-width="1.6" opacity=".8"/>
    <path d="M0 181h640v219H0z" fill="url(#cx-coast-water)"/>
    <path d="M0 186q80 3 160 0t160 0t160 0t160 1v12q-80 3-160 0t-160 0t-160 0T0 198Z" fill="#bb93b0" opacity=".42"/>
    <path d="M0 236q80 4 160 1t160 0t160 1t160-1v17q-80 3-160 0t-160-1t-160 1T0 253Z" fill="#3f5490" opacity=".32"/>
    <path d="M198 181h442" stroke="#2b2140" stroke-width="1.4" opacity=".85"/>
    <path d="m539 179 16-4 9 1 21-5 16 4 15-2 24 5v4H527Z" fill="#6a5f9e" stroke="#2b2140" stroke-width="1.5" stroke-linejoin="round"/>
    <g class="cx-motion cx-coast-waves" fill="none" stroke-linecap="round">
      <path d="M227 188h99m16 3h29m167-2h98m-465 11 64-2m25 7 43-1m234-1h59m-392 11 55-2m61 7 30-2m216 0 58 2m-491 11 71-6m264 5 43 1m54 7 74 3" stroke="#fff0ee" stroke-width="1.1" opacity=".5"/>
      <path d="M124 244c43-8 72-8 100-11m48 4 44-1m229-3 75 4M-9 275c76-4 102-16 160-23m37-2 58-5m204 2 46 2m-482 43 56-4 51-9m25-3 35-6m-165 46 71-15 44-6m-116 41 49-13 60-12" stroke="#dce8f5" stroke-width="1.2" opacity=".4"/>
      <path d="M291 198h29m55 5h20m105-5h25m-357 37 65-7m93-9 36-1m202 0 55 3m-455 42 74-10m76-14 48-3m-332 70 73-12m8 14 61-15m-129 47 58-16" stroke="#2c4f86" stroke-width="1.6" opacity=".35"/>
    </g>
    <g class="cx-motion cx-coast-reflection">
      <path d="M446 185h20l30 76 20 66H402l34-66Z" fill="url(#cx-coast-shimmer)" opacity=".34"/>
      <path d="M449 185h14l10 22h-34Z" fill="#fffbe0" opacity=".62"/>
      <path d="M452 189h8M445 199h22M438 210h36M431 222h50M424 235h62M417 248h74M410 262h86M403 276h98M409 290h94M405 304h102M401 318h110M397 332h118M393 346h126" fill="none" stroke="#ffe9a8" stroke-width="2.6" opacity=".78" stroke-linecap="round"/>
      <path d="M431 222h50M417 248h74M403 276h98M401 318h110M393 346h126" fill="none" stroke="#ffcf6e" stroke-width="2" opacity=".45" stroke-linecap="round"/>
    </g>
    <path d="M0 110 20 114 37 110 52 119 74 124 81 137 95 145 100 155 119 156 128 164 147 169 156 176 184 183 199 194 184 204 160 207 141 217 108 226 80 235 47 239 24 248 0 247Z" fill="url(#cx-coast-cliff)" stroke="#2b2140" stroke-width="3" stroke-linejoin="round"/>
    <path d="M0 109 20 112 38 107 52 116 73 121 83 134 92 143 80 148 59 141 42 136 28 133 0 137Z" fill="#9a8fb0"/>
    <path d="m4 142 18-9 8 12 23-1-7 38-13 20-11 26-21 5Zm72 3 14 3 10 13 18 0-8 26-15 9-11 21-26 11 14-36Zm60 26 19 8 20 6-13 13-21 2-18 10 8-22Z" fill="#c9a0b8" opacity=".6"/>
    <path d="m30 145-3 32 9 11-13 34m37-65-8 17 1 25-10 28m65-58-7 15-1 18m30-12-11 15m-104 7 21-4m13-8 15-4m-26 25 24-7m30-12 15-6" fill="none" stroke="#2b2140" stroke-width="1.4" opacity=".65"/>
    <path d="m13 137 16-3m25 8 7 6m32 12 7 9m30 9 17 6m-34 21 12-4" fill="none" stroke="#ffd9b0" stroke-width="1" opacity=".7"/>
    <path d="M0 110 20 114 37 110 52 119 74 124 81 137 95 145 100 155 119 156 128 164 147 169 156 176 184 183L60 237 47 239 24 248 0 247Z" fill="#241d3a" opacity=".55"/>
    <path d="M100 155 119 156 128 164 147 169 156 176 184 183 199 194" fill="none" stroke="#ffd9a8" stroke-width="2.2" opacity=".9"/>
    <circle cx="47" cy="74" r="30" fill="url(#cx-coast-beacon)"/>
    <path d="m39 113 3-37h10l4 43-10-2Z" fill="#faf0dc" stroke="#2b2140" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="m48 77 4-1 4 43-7-2Z" fill="#8a7fae"/>
    <path d="M40 72h14v8H40z" fill="#3a2d55" stroke="#2b2140" stroke-width="1.5"/>
    <path d="m38 72 9-6 9 6Z" fill="#2b2140"/>
    <path d="M43 74h3v4h-3zm5 0h3v4h-3Z" fill="#ffd76b"/>
    <path d="M39 81h16m-14-11v10m12-10v10M45 101v7" fill="none" stroke="#4a4470" stroke-width="1"/>
    <path d="m47 64-4-12m8 12 8-14m8 14 12-10" fill="none" stroke="#ffd76b" stroke-width="1.6" opacity=".85"/>
    <path d="m0 246 25-4 18 2 23-5 17 1 24-9 14 1 25-11 19-3 19-9" fill="none" stroke="#fff0ee" stroke-width="1.6" opacity=".8"/>
    <g class="cx-motion cx-coast-swell-far" fill="none" stroke="#fff5f0" stroke-linecap="round">
      <path d="M-30 308c47-2 75-18 116-27 35-7 49-18 76-22 51-11 61-9 93-16 50-10 76-4 120-9" stroke-width="2.2"/>
      <path d="m16 302 28-6m24-7 38-9m51-19 29-7m33-2 36-5m34-5 41-1" stroke-width="1" opacity=".6"/>
    </g>
    <g class="cx-motion cx-coast-swell-mid" fill="none" stroke="#ffffff" stroke-linecap="round">
      <path d="M-40 373c35-6 66-20 93-35 31-17 54-22 80-36 20-11 46-14 73-21 35-10 65-13 89-16" stroke-width="2.6"/>
      <path d="m-7 367 37-16m14-5 39-18m46-22 36-13m20-4 45-9" stroke-width="1" opacity=".7"/>
    </g>
    <path d="M-20 358c62-16 116-9 172-23 38-10 80-7 120 7-50 4-94 19-138 25-54 8-106 2-154 6Z" fill="#10304f" opacity=".6"/>
    <path d="M-20 358c62-16 116-9 172-23 38-10 80-7 120 7" fill="none" stroke="#ffe6c4" stroke-width="1.5" opacity=".38"/>
    <path d="M136 400c28-31 49-51 78-67 43-24 93-34 145-39 89-9 180-16 281-54v160Z" fill="url(#cx-coast-sand)"/>
    <path d="M137 400c48-60 97-90 195-103 117-15 195-17 308-57v15c-115 39-186 38-290 52-96 12-143 36-180 85Z" fill="url(#cx-coast-wet)"/>
    <g class="cx-motion cx-coast-wash" fill="none" stroke-linecap="round">
      <path d="M133 410c21-39 65-72 104-90 41-19 79-25 132-30 83-8 152-14 279-56" stroke="#f7e6db" stroke-width="3"/>
      <path d="M151 402c28-37 65-63 103-80 30-13 66-17 102-21m28-4c74-6 153-20 236-47" stroke="#fff1db" stroke-width="1"/>
      <path d="m184 356 8-5m12-7 13-7m31-13 5-2m19-6 17-5m37-7 15-2m50-6 19-3m39-6 13-2m44-9 16-4m33-8 10-3m27-7 13-4" stroke="#fff3df" stroke-width="3.4" opacity=".85"/>
    </g>
    <path d="m262 322c9-7 19-3 24 4-9 3-19 1-24-4Z" fill="#ffffff" stroke="#2b2140" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="m398 344c10-8 21-3 26 5-10 3-21 1-26-5Z" fill="#ffffff" stroke="#2b2140" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="m467 371 26-5 42 7 11 8-50 3-36-7Z" fill="#c98fa8" opacity=".45"/>
    <path d="m466 364 16-9 16 2 12 15-13 5-32-4Z" fill="#4a4470" stroke="#2b2140" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="m466 364 16-9 16 2-8 7 6 8-18-3Z" fill="#c9a0b8"/>
    <path d="m550 326 15-6 19 7 4 8-23 4-18-6Z" fill="#5f74b4" stroke="#2b2140" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="m550 326 15-6 19 7-19 1Z" fill="#f0b4b0"/>
    <path d="m325 365 9-3 10 4-10 3Zm45-25 6-2 6 3-6 2Zm215 51 10-3 9 5-11 2Z" fill="#c98fa8"/>
    <path d="M240 400c60-30 110-36 180-30 76 6 140 14 220 30Z" fill="#e0a67c" opacity=".38"/>
    <path d="m296 358c8-6 17-2 21 4-8 3-17 1-21-4Zm146-32c8-6 17-2 21 4-8 3-17 1-21-4Zm62 46c7-5 15-2 19 3-7 3-15 1-19-3Z" fill="#ffffff" stroke="#2b2140" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="m244 382 3-1m39-20 4-1m104 15 5 1m23-35 4-1m112 16 5 2m51 15 4-1m-244-30 3-1m-97 46 3-1" stroke="#b8846a" stroke-width="2" stroke-linecap="round" opacity=".6"/>
    <path d="M452 372c24-5 50-1 68 8-16 7-54 5-68-8ZM538 334c18-5 40 0 54 9-13 5-44 3-54-9ZM318 368c9-3 21 0 28 5-8 3-22 2-28-5Z" fill="#8a5f50" opacity=".34"/>
    <path d="m466 364 16-9 16 2M550 326l15-6 19 7" fill="none" stroke="#ffd9a0" stroke-width="1.5" opacity=".5"/>
    <path d="M172 392c34-24 74-40 118-48m-72 30c22-14 46-24 72-30m112-11c40-8 82-14 124-19m-96-2c32-4 64-8 96-9m-64 44c44-8 90-14 136-18M320 400c40-27 84-42 132-48m-46 34c30-12 62-20 96-24" fill="none" stroke="#c98a70" stroke-width="1.3" opacity=".38"/>
    <path class="cx-motion cx-coast-gulls" d="m265 104 5-2 5 2m30 13 4-2 4 1" fill="none" stroke="#2b2140" stroke-width="1.1" stroke-linecap="round"/>
  `);

  // 03 / Rain transit. The stone viaduct, overhead wires and valley are fixed;
  // the train crosses them while two seamless fine-rain fields fall past it.
  // JOJO 化处理：夜空压成深靛蓝高对比；桥拱内侧平涂冷暗硬阴、拱脚走墨线；
  // 列车上墨线轮廓 + 车顶边缘光 + 车头发光束；雨丝提亮。运动层几何不动。
  var artRail = celArt('rail', `
    <linearGradient id="cx-rail-night" gradientUnits="userSpaceOnUse" x2="0" y2="330"><stop stop-color="#0a1830"/><stop offset=".46" stop-color="#2c4472"/><stop offset=".78" stop-color="#6a6ea8"/><stop offset="1" stop-color="#a898b4"/></linearGradient>
    <radialGradient id="cx-rail-moonlight" cx=".7" cy=".17" r=".6"><stop stop-color="#aabce3" stop-opacity=".34"/><stop offset="1" stop-color="#8fabe0" stop-opacity="0"/></radialGradient>
    <linearGradient id="cx-rail-hill" x2=".25" y2="1"><stop stop-color="#2c4a78"/><stop offset="1" stop-color="#0e2242"/></linearGradient>
    <linearGradient id="cx-rail-stone" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="#7e8ea6"/><stop offset=".3" stop-color="#3c5070"/><stop offset="1" stop-color="#16283f"/></linearGradient>
    <linearGradient id="cx-rail-car" x2="0" y2="1"><stop stop-color="#b8d0cc"/><stop offset=".2" stop-color="#6fb8c4"/><stop offset=".45" stop-color="#3f8aa6"/><stop offset="1" stop-color="#1f5670"/></linearGradient>
    <linearGradient id="cx-rail-glass" x2="0" y2="1"><stop stop-color="#ffca62"/><stop offset="1" stop-color="#f09d3c"/></linearGradient>
    <linearGradient id="cx-rail-mist" x2="0" y2="1"><stop stop-color="#b9c6e1" stop-opacity="0"/><stop offset=".55" stop-color="#b9c6e1" stop-opacity=".35"/><stop offset="1" stop-color="#b9c6e1" stop-opacity="0"/></linearGradient>
    <radialGradient id="cx-rail-halo"><stop stop-color="#cfd9f2" stop-opacity=".38"/><stop offset="1" stop-color="#cfd9f2" stop-opacity="0"/></radialGradient>
    <path id="cx-rail-rain-far" d="m21 12-1 12m89 39-1 9m121-40-1 13m81 45-1 10m91-63-1 12m129 40-1 11m99-54-1 13M57 150l-1 11m105 22-1 13m102-29-1 9m98 39-1 12m85-52-1 11m126 20-1 13m103-18-1 12M19 287l-1 11m100 31-1 10m91-25-1 12m137 32-1 9m104-24-1 12m104 28-1 11m89-32-1 10M70 411l-1 10m124-14-1 11m101 19-1 12m96-22-1 13m122 18-1 9m103-20-1 10"/>
    <path id="cx-rail-rain-near" d="m43 24-1.5 18m127 72-1.5 20m154-63-1.5 16m122 62-1.5 18m137-76-1.5 20M-11 219l-1.5 18m143-38-1.5 17m127 75-1.5 21m159-58-1.5 16m129 68-1.5 18m119-63-1.5 20M66 369l-1.5 18m135 24-1.5 19m139-49-1.5 17m120 54-1.5 20m131-48-1.5 18"/>`, `
    <path d="M0 0h640v400H0z" fill="url(#cx-rail-night)"/>
    <path d="M0 0h640v400H0z" fill="url(#cx-rail-moonlight)"/>
    <circle class="cx-motion cx-rail-halo" cx="449" cy="48" r="47" fill="url(#cx-rail-halo)"/>
    <path d="M449 48a21 21 0 1 0 19 31 23 23 0 0 1-19-31Z" fill="#fff8e0" stroke="#fffdf4" stroke-width="1.2"/>
    <path d="M353 106c24-9 44-5 64-9 29-7 51-4 69-8 31-6 70-2 88-6-35 14-73 9-99 15-23 6-46 3-64 7-22 4-38-1-58 1Z" fill="#a8b7d7" opacity=".19"/>
    <path d="m0 201 25-11 19-3 22-19 13 1 21-24 12 3 15-13 13 4 30-26 16 8 11-3 18 24 16 5 18 24 18 2 15 15 21 4 25 20 30 7 27-5 25 12 37-4 24 7 29-9 36 2 25-8 23 5 39-3 26 7 21-4v183H0Z" fill="#3a5490" stroke="#0e1e38" stroke-width="2" stroke-linejoin="round"/>
    <path d="m170 113-8 24 16 12-5 18 31 28 41 7-24-29-11-11-11-28-14-13-9 2Zm-70 32-22 31-20 13 32-9 10-16 12-16Z" fill="#c9d4ee" opacity=".5"/>
    <path d="M0 235c29-6 44-20 66-21l18-12 17 3 20-14 20 5 26-18 15 6 19-7 25 14 17-2 25 17 20-1 21 18 26 5 17 10 22-5 27 9 19-4 21 7 30-9 22 3 22-12 16 1 15-8 14 3 20-12 20 4 21-12 27 4 22-8v203H0Z" fill="url(#cx-rail-hill)" stroke="#0b1a30" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="m167 178-20 32-8 22-33 25 51-18 22-27 22-21-19-7Zm363 52 12 13 24-3 20-14 20 6-23 5-14 12-48 15-33-3Z" fill="#8fa3c8" opacity=".35"/>
    <path d="M0 194h640v141H0z" fill="url(#cx-rail-mist)"/>
    <g class="cx-motion cx-rail-mist" fill="#bec8de">
      <path d="M-90 231c78-12 124 4 178-2 75-8 100 7 161 1 60-5 84 9 135 5-70 14-101 3-163 9-74 7-113-5-161 1-52 6-103-9-150-14Z" opacity=".18"/>
      <path d="M284 347c82-16 109-5 164-12 53-7 81 7 129 2 65-7 104 9 150 5-74 14-125 3-177 11-78 12-172-10-266-6Z" opacity=".25"/>
    </g>
    <path d="M0 323c73 12 117 45 177 56 75 14 113-9 154-1 78 13 140-21 183-31 50-12 84-10 126-15v68H0Z" fill="#12284a"/>
    <path d="M302 400c17-19 40-30 67-34 23-4 45-16 57-25-8 19-36 31-63 40-22 7-28 14-36 19Z" fill="#b8c6e0" opacity=".5"/>
    <path d="M544 400V333a37 37 0 0 0 74 0v67Zm-104 0V333a37 37 0 0 0 74 0v67Zm-104 0V333a37 37 0 0 0 74 0v67Zm-104 0V333a37 37 0 0 0 74 0v67Zm-104 0V333a37 37 0 0 0 74 0v67Zm-104 0V333a37 37 0 0 0 74 0v67Z" fill="#0e1e38"/>
    <path d="M0 273h640v127h-22v-67a37 37 0 0 0-74 0v67h-30v-67a37 37 0 0 0-74 0v67h-30v-67a37 37 0 0 0-74 0v67h-30v-67a37 37 0 0 0-74 0v67h-30v-67a37 37 0 0 0-74 0v67H98v-67a37 37 0 0 0-74 0v67H0Z" fill="url(#cx-rail-stone)"/>
    <path d="M24 400v-67a37 37 0 0 1 74 0v67m30 0v-67a37 37 0 0 1 74 0v67m30 0v-67a37 37 0 0 1 74 0v67m30 0v-67a37 37 0 0 1 74 0v67m30 0v-67a37 37 0 0 1 74 0v67m30 0v-67a37 37 0 0 1 74 0v67" fill="none" stroke="#c9d6e8" stroke-width="2" opacity=".5"/>
    <path d="M1 273h6v127h-6ZM99 273h7v127h-7ZM203 273h7v127h-7ZM307 273h7v127h-7ZM411 273h7v127h-7ZM515 273h7v127h-7ZM619 273h5v127h-5Z" fill="#d6e2f2" opacity=".28"/>
    <path d="M15 273h8v127h-8ZM117 273h10v127h-10ZM221 273h10v127h-10ZM325 273h10v127h-10ZM429 273h10v127h-10ZM533 273h10v127h-10ZM632 273h7v127h-7Z" fill="#08131f" opacity=".38"/>
    <path d="M24 333A37 37 0 0 1 98 333L106 333A45 45 0 0 0 16 333ZM128 333A37 37 0 0 1 202 333L210 333A45 45 0 0 0 120 333ZM232 333A37 37 0 0 1 306 333L314 333A45 45 0 0 0 224 333ZM336 333A37 37 0 0 1 410 333L418 333A45 45 0 0 0 328 333ZM440 333A37 37 0 0 1 514 333L522 333A45 45 0 0 0 432 333ZM544 333A37 37 0 0 1 618 333L626 333A45 45 0 0 0 536 333Z" fill="#0d1b30" opacity=".45"/>
    <path d="M29 400v-67c0-19 14-33 32-33m72 100v-67c0-19 14-33 32-33m72 100v-67c0-19 14-33 32-33m72 100v-67c0-19 14-33 32-33m72 100v-67c0-19 14-33 32-33m72 100v-67c0-19 14-33 32-33" fill="none" stroke="#0d1b30" stroke-width="4" opacity=".9"/>
    <path d="M0 284h640M0 290h640M0 357h23m76 0h28m76 0h28m76 0h28m76 0h28m76 0h28m76 0h22M0 384h23m76 0h28m76 0h28m76 0h28m76 0h28m76 0h28m76 0h22" fill="none" stroke="#10203a" stroke-width=".8" opacity=".7"/>
    <path d="m21 312-6-4m20-11-4-7m27 5v-9m28 14 4-8m13 22 7-3m20 3-7-4m20-12-4-8m27 4v-8m26 11 4-7m14 21 6-3m21 3-6-4m19-12-4-7m27 4v-8m26 11 4-7m14 21 7-3m20 3-6-4m19-12-4-7m27 4v-8m26 11 4-7m14 21 7-3m20 3-6-4m19-12-4-7m27 4v-8m26 11 4-7m14 21 7-3m20 3-6-4m19-12-4-7m27 4v-8m26 11 4-7m14 21 7-3" fill="none" stroke="#a3adba" stroke-width=".7" opacity=".35"/>
    <path d="M0 271h640v6H0z" fill="#24405f"/>
    <path d="M0 277h640v11H0z" fill="#08131f" opacity=".42"/>
    <path d="M0 271h640M0 279h640" stroke="#d8deee" stroke-width=".9" opacity=".6"/>
    <g class="cx-motion cx-rail-train">
      <path d="M-6 262h366l18 20H-28Z" fill="#ffd76b" opacity=".1"/>
      <path d="M8 260h352l12 8H-4Z" fill="#ffe9b8" opacity=".16"/>
      <circle cx="4" cy="256" r="10" fill="#ff7a5c" opacity=".24"/>
      <path d="M9 240h340c13 0 22 7 31 16l10 10H3v-17q0-9 6-9Z" fill="url(#cx-rail-car)" stroke="#122438" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M11 239h334c14 0 20 4 28 13l-20-8H6Z" fill="#d8ecec"/>
      <path d="M4 262h381l5 4H3Z" fill="#10283f"/>
      <path d="M5 258h369" stroke="#ffd76b" stroke-width="1.6"/>
      <path d="M125 241v25m121-25v25" stroke="#122438" stroke-width="4"/>
      <path d="M15 246h89v10H15zm121 0h89v10h-89zm121 0h81v10h-81Z" fill="#16283f"/>
      <path class="cx-motion cx-rail-windows" d="M18 247h15v8H18zm19 0h15v8H37zm19 0h15v8H56zm19 0h15v8H75zm19 0h7v8h-7zm45 0h15v8h-15zm19 0h15v8h-15zm19 0h15v8h-15zm19 0h15v8h-15zm19 0h7v8h-7zm45 0h15v8h-15zm19 0h15v8h-15zm19 0h15v8h-15zm19 0h15v8h-15Z" fill="url(#cx-rail-glass)"/>
      <path d="M28 251h4v4h-4zm31 1h5v3h-5zm24-2h4v5h-4zm62 1h4v4h-4zm36 0h4v4h-4zm23 1h5v3h-5zm59-1h4v4h-4zm39-1h4v5h-4zm23 2h5v3h-5Z" fill="#3a2f28" opacity=".7"/>
      <path d="M110 244h8v18h-8zm121 0h8v18h-8Zm109 1h7v18h-7Z" fill="#4f7d92" stroke="#d8ecec" stroke-width=".5"/>
      <path d="M112 246h4v7h-4zm121 0h4v7h-4zm109 0h3v7h-3Z" fill="#ffd76b"/>
      <path d="m353 246 10 1 11 10-20-1Z" fill="#10283f"/>
      <path d="m355 247 6 1 7 6-11-1Z" fill="#d8ecec" opacity=".8"/>
      <path d="M22 266h20v4H22zm63 0h21v4H85zm58 0h20v4h-20zm63 0h21v4h-21zm58 0h20v4h-20zm63 0h21v4h-21Z" fill="#0d1b30"/>
      <path d="m164 239 10-6h19l8 6m-28-6h22" fill="none" stroke="#122438" stroke-width="1"/>
      <path d="M385 256h44l-7 9h-37Z" fill="#ffe9b8" opacity=".22"/>
      <path d="M380 260h5" stroke="#fff2bb" stroke-width="3"/>
      <path d="M6 255v3" stroke="#ff7a5c" stroke-width="2"/>
      <path d="M2 246h-20M6 256h-16M0 236h-12" fill="none" stroke="#d8ecec" stroke-width="1.4" opacity=".55"/>
    </g>
    <g fill="none" stroke="#0e1e38">
      <path d="M60 273V220h43m-40 0 21 17m469 36V219h44m-41 0 21 18" stroke-width="2"/>
      <path d="M-20 223q38 2 80-3 247 21 493-1 49 7 107 4M-20 232q306 4 680 0" stroke-width=".9" opacity=".95"/>
      <path d="M105 224v8m96-4v4m97-3v3m109-5v5m98-8v8" stroke-width=".7"/>
    </g>
    <path d="M0 370 15 364 24 368 32 360 41 365 52 362 64 373 73 370 85 381 97 378 112 385 127 382 147 391 166 389 185 400H0Zm430 30 16-8 9 2 18-15 14 3 15-12 10 4 21-16 12 5 19-12 13 5 16-10 11 4 19-11 16 4 11-6v73Z" fill="#0e1e38" stroke="#0a1424" stroke-width="2" stroke-linejoin="round"/>
    <path d="m11 395 4-36 4 11 7-8m-11 16-8-6m511 28 3-31 6 7 6-13m24 26 3-33 6 8 9-13m40 23 3-37 7 10" fill="none" stroke="#3a6a8c" stroke-width="2.2"/>
    <g fill="none" stroke="#dce8ff" stroke-linecap="round">
      <g class="cx-motion cx-rail-rain-far" stroke-width=".65" opacity=".3"><use href="#cx-rail-rain-far"/><use href="#cx-rail-rain-far" x="36" y="-440"/></g>
      <g class="cx-motion cx-rail-rain-near" stroke-width=".85" opacity=".38"><use href="#cx-rail-rain-near"/><use href="#cx-rail-rain-near" x="36" y="-440"/></g>
    </g>
  `);

  // 04 / Woodland shelter. Tapered trunks and layered understory frame a lit
  // footpath. The canopy stays anchored; tiny fireflies trace independent paths.
  // JOJO 化处理：林冠整体墨线 + 叶缘下挂硬阴；两根前景树干上墨线与内侧边缘光；
  // 小径走暖金并压深色路缘；灯罩墨线 + 四道灯光射线。元素预算最紧（68→<80）。
  var artForest = celArt('forest', `
    <linearGradient id="cx-forest-depth" x1=".2" y1="0" x2=".8" y2="1"><stop stop-color="#0b3f3e"/><stop offset=".44" stop-color="#1f8a6e"/><stop offset="1" stop-color="#0f4a38"/></linearGradient>
    <radialGradient id="cx-forest-air" cx=".57" cy=".48" r=".53"><stop stop-color="#dfdda0" stop-opacity=".7"/><stop offset="1" stop-color="#69ab8c" stop-opacity="0"/></radialGradient>
    <linearGradient id="cx-forest-bark" x1="0" y1="0" x2="1" y2=".1"><stop stop-color="#0f3a34"/><stop offset="1" stop-color="#58a37c"/></linearGradient>
    <linearGradient id="cx-forest-path" x1=".6" y1="0" x2=".25" y2="1"><stop stop-color="#e8d9a0"/><stop offset="1" stop-color="#4e7a52"/></linearGradient>
    <linearGradient id="cx-forest-light" x1=".8" y1="0" x2=".2" y2="1"><stop stop-color="#fff3c0" stop-opacity=".3"/><stop offset="1" stop-color="#e5dda4" stop-opacity="0"/></linearGradient>
    <radialGradient id="cx-forest-halo"><stop stop-color="#fff0b8" stop-opacity=".5"/><stop offset="1" stop-color="#ffcf6e" stop-opacity="0"/></radialGradient>
    <linearGradient id="cx-forest-lamp" x2="1" y2=".2"><stop stop-color="#d69754"/><stop offset="1" stop-color="#e9b569"/></linearGradient>`, `
    <path d="M0 0h640v400H0z" fill="url(#cx-forest-depth)"/>
    <g fill="#5aa08a" opacity=".3">
      <path d="m198-10 9 1-6 85 5 71-7 101h-9l9-114-5-57Zm79 0h7l-5 125 4 147h-9l2-128Zm81 0h6l6 120-5 147h-7l4-153Zm57 0h8l-10 155 5 128-9-2-2-137Zm60 0h8l7 118-9 172h-11l11-171Z"/>
      <path d="m199 110-30-46 2-3 29 38m76 51 32-41 3 1-34 49m86-52-25-40 2-3 23 30m48 36 29-34 3 1-33 44m69 47-26-31 2-3 27 27Z"/>
      <path d="M498 40h10l-6 118 6 96-4 106h-11l5-108-6-92Zm58 34h8l-4 96 5 78-3 92h-9l4-96-5-74Z"/>
    </g>
    <g fill="#1d5b4b" opacity=".62">
      <path d="M142-10h13l-5 96 9 106-4 112-15 5 7-133-6-83Zm178 0h9l-8 105 5 86-8 100-10 1 8-101-4-83Zm191 0h11l-7 102 3 93 12 116-15-1-7-117 1-103Z"/>
      <path d="m149 106-42-45 2-3 35 30m9 62 38-51 5-2-39 63m161-32-28-39 2-3 28 29m199 36 27-48 4 1-29 64Z"/>
    </g>
    <path d="M0 0h640v400H0z" fill="url(#cx-forest-air)"/>
    <path d="M0 298c40-4 58-14 96-7 34 6 42-5 67-1 36 6 51-15 83-8 28 6 48-5 71-13 21-7 33 1 54-6 36-11 73 9 101 4 50-9 112 2 168-6v139H0Z" fill="#1a5540"/>
    <path d="M0 308c40-4 58-14 96-7 34 6 42-5 67-1 36 6 51-15 83-8 28 6 48-5 71-13 21-7 33 1 54-6 36-11 73 9 101 4 50-9 112 2 168-6v139H0Z" fill="#35855f"/>
    <path d="M356 263c-23 17-23 21-1 31 33 16 20 32-13 43-31 12-29 31 18 63H213c-9-31 24-54 83-70 55-16 54-25 28-34-19-6-16-18 32-33Z" fill="url(#cx-forest-path)" stroke="#3a2f1c" stroke-width="2" stroke-linejoin="round"/>
    <path d="M351 273c-18 11-9 16 4 23 20 12 10 23-20 34m-48 18c-27 13-37 29-26 46" fill="none" stroke="#d7ce97" stroke-width="1" opacity=".4"/>
    <path d="M0 336c61-24 105-20 139-18 49 2 74-9 117-2l45 10c-64 15-91 39-93 74H0Zm368 64c-43-33-43-45-9-60 30-14 79-16 103-10 70-16 112-13 178-20v90Z" fill="#174a38"/>
    <path d="M392 196c14-22 44-28 62-12 12-20 44-24 60-6 16-14 44-12 54 6 18-10 42-4 48 14 16-6 34 2 38 18-70 10-118 4-166 8-46 4-72-6-96-28Z" fill="#2b7459" opacity=".55"/>
    <path d="M432 214h12l-4 60 3 56h-12l3-60Zm96-8h11l-3 54 3 50h-12l3-54Z" fill="#2b7459" opacity=".5"/>
    <path d="m191 340 19-12 30-1 17 6-28 3-23 11Zm218 1 32-13 26 7-16 6-31 5Zm-1 48 29-16 36 5 13 15-33 7Z" fill="#3d7350"/>
    <path d="m208 329 11-10 20 1 12 10-26-3Zm202 7 22-16 12 3 16 10-21-4Zm33 46 14-11 17 7 6 8-21-5Z" fill="#6e9c68"/>
    <path d="m254 357 8-2 11 2-9 3Zm43-17 6-2 8 1-7 3Zm27-23 5-1 5 2-5 1Zm-63 65 13-2 11 4-17 2Z" fill="#4f7550"/>
    <g class="cx-motion cx-forest-rays" fill="url(#cx-forest-light)">
      <path d="m386-10 23 0-144 371-55 29Z"/>
      <path d="m431-10 9 0-91 332-23 9Z" opacity=".65"/>
      <path d="m369 6 5 0-122 267-16 8Z" opacity=".45"/>
    </g>
    <path d="M91-10h19l-6 72 6 63-7 104 6 79 16 35-25 1-17 11 10-50-1-73 7-109-8-58Z" fill="url(#cx-forest-bark)" stroke="#0c2b24" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="m101 111 16-24 24-15 26-36 4 1-24 43-24 16-19 35m-7 48-21-30-30-24 1-5 34 24 16 23Z" fill="#143f36"/>
    <path d="M468-10h18l-1 87-7 72 8 85-3 75 16 29-22-4-13 9 8-42-4-72 3-83 7-70Z" fill="url(#cx-forest-bark)" stroke="#0c2b24" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="m479 127 19-31 24-18 18-32 4 1-15 37-26 23-23 35m-7 66-24-32-24-15 1-4 29 14 23 27Z" fill="#16473c"/>
    <path d="m101 5-2 55 5 57-7 53 1 73m1 19-2 42 7 25m375-319-1 67-5 76 5 47m0 12-2 78 5 28" fill="none" stroke="#a8d8a0" stroke-width="1.6" opacity=".6"/>
    <path d="M0 0h640v43c-16 9-27 3-32-4-13 14-27 11-34 6-7 13-24 17-33 8-10 12-27 11-35 2-14 12-29 7-34-5-11 7-24 3-28-8-14 10-34 10-42-1-12 8-27 8-35-2-9 6-23 4-28-4-11 13-26 19-38 9-10 14-24 15-36 8-8 13-24 17-37 6-10 12-26 10-36 0-11 15-29 16-39 6-15 10-30 4-36-6-14 7-28 3-36-5-10 11-24 8-35 0-16 6-26 2-32-7C12 51 3 48 0 44Z" fill="#07281f" opacity=".85" transform="translate(0 8)"/>
    <path d="M0 0h640v43c-16 9-27 3-32-4-13 14-27 11-34 6-7 13-24 17-33 8-10 12-27 11-35 2-14 12-29 7-34-5-11 7-24 3-28-8-14 10-34 10-42-1-12 8-27 8-35-2-9 6-23 4-28-4-11 13-26 19-38 9-10 14-24 15-36 8-8 13-24 17-37 6-10 12-26 10-36 0-11 15-29 16-39 6-15 10-30 4-36-6-14 7-28 3-36-5-10 11-24 8-35 0-16 6-26 2-32-7C12 51 3 48 0 44Z" fill="#123f35" stroke="#0c2b24" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M219 20c8-10 17-10 24-3 10-12 22-11 28-4 10-7 18-6 26 0 14-6 24-3 34 3-15-1-18 12-33 10-8 10-20 6-25 0-11 8-25 11-32 4-13 5-17-2-22-10Zm185-1c13-11 23-7 27-2 12-10 23-9 30-2 13-11 29-7 39 4-13-3-18 8-31 4-13 11-26 9-33 1-14 9-23 4-32-5Z" fill="#2e7058" opacity=".8"/>
    <path d="M12-10h35c-1 34-11 55-8 78 2 28 9 53 4 78-5 23-8 37-6 61 3 34-1 60 5 90 3 26 9 51 13 63l20 40H0c12-21 19-64 20-99 2-38-6-67-3-102 2-24 12-45 9-67-2-33-8-46-7-74 1-25-8-45-7-68Z" fill="url(#cx-forest-bark)" stroke="#0c2b24" stroke-width="3" stroke-linejoin="round"/>
    <path d="M34 93c16-13 22-15 32-29 8-13 17-23 30-34 17-7 21-23 27-37h8c-9 20-19 38-35 48-12 8-16 19-22 29-9 15-20 23-33 33Zm5 119c15-17 25-22 35-39 8-14 15-29 24-40l5-2c-8 17-13 35-24 49-14 18-26 30-40 45Z" fill="#0e332c"/>
    <path d="M575-10h32c-2 32-10 67-8 91 2 31 10 53 8 82-3 36-8 67-6 102 2 40 6 69 12 92 8 21 16 33 27 43h-85c10-19 17-35 22-55 7-28 11-60 10-89-1-31-1-61-4-89-3-30-12-61-9-91 2-32 2-55 1-86Z" fill="url(#cx-forest-bark)" stroke="#0c2b24" stroke-width="3" stroke-linejoin="round"/>
    <path d="M583 106c-17-20-29-24-43-32-16-8-24-24-38-37-8-7-18-5-27-8-8-6-12-13-15-20l3-2c6 8 10 13 19 17 8 3 18 0 28 6 15 9 20 20 27 24 14 8 19 8 26 10l26 27Zm5 119c-10-10-25-20-40-26-17-3-29-4-36-5-8-4-15-10-18-16l2-3c10 12 20 15 30 15 24-1 42 11 62 21Z" fill="#0e332c"/>
    <path d="m34 6-4 52 7 81-7 59 5 100 12 56m-22-131 4 41-3 45m6 12-5 36-9 32m577-375-10 62 9 89-5 90 10 92m-4-55 1 48 13 35" fill="none" stroke="#8fc49a" stroke-width="1.4" opacity=".5"/>
    <path d="m21 93 6 29-6 51m17 129 8 18 2 39m533-238 6 26-2 28m9 30-5 39m3 75-4 29 12 33" fill="none" stroke="#0a241f" stroke-width="2.4"/>
    <g fill="#2b7355">
      <path d="M65 86c-18-4-26-17-23-29 16 4 24 14 23 29Zm8-11c-2-17 8-29 21-31 0 15-6 25-21 31Zm14-21c10-10 26-9 34 0-13 7-25 8-34 0Zm-4 118c-17 2-30-7-32-18 15-1 25 4 32 18Zm10-14c-6-16 0-28 11-35 4 14 0 25-11 35Z"/>
      <path d="M544 62c-17-2-27-14-25-27 15 4 23 13 25 27Zm12 9c8-16 20-20 32-16-7 13-17 19-32 16Zm-30-24c-1-15 10-27 23-28-2 14-10 23-23 28Zm-16 126c-14 3-25-3-31-14 14-3 26 2 31 14Zm22 8c-3-13 4-24 15-30 4 14-1 23-15 30Z"/>
    </g>
    <path d="M448 155V82q0-8 8-8h6" fill="none" stroke="#6a7a5c" stroke-width="1.4"/>
    <circle class="cx-motion cx-forest-lantern" cx="448" cy="180" r="61" fill="url(#cx-forest-halo)"/>
    <path d="m435 166 6-10h14l7 10-3 30h-21Z" fill="#1e3830" stroke="#0c2b24" stroke-width="2" stroke-linejoin="round"/>
    <path d="M439 168h19l-2 25h-15Z" fill="url(#cx-forest-lamp)"/>
    <path d="m433 166 6-4h18l7 4Zm4 30h22l3 4h-28Z" fill="#16281f"/>
    <path d="M447 168v25m-9-13h20m-17 13h15" stroke="#c9a86a" stroke-width="1.2"/>
    <path d="M444 171h3v19h-3Z" fill="#fff7cf" opacity=".8"/>
    <path d="m448 178-6-18m-16 8-16-12m28 4 18-10m-30 20-20 4" fill="none" stroke="#ffdf9a" stroke-width="1.6" opacity=".8"/>
    <g fill="#fff3b8">
      <g class="cx-motion cx-forest-drift-a"><g class="cx-motion cx-forest-rise-a"><g class="cx-motion cx-forest-glow-a"><circle cx="226" cy="240" r="4" opacity=".1"/><circle cx="226" cy="240" r="1.3"/></g></g></g>
      <g class="cx-motion cx-forest-drift-b"><g class="cx-motion cx-forest-rise-b"><g class="cx-motion cx-forest-glow-b"><circle cx="385" cy="286" r="3.5" opacity=".12"/><circle cx="385" cy="286" r="1.1"/></g></g></g>
      <g class="cx-motion cx-forest-drift-c"><g class="cx-motion cx-forest-rise-c"><g class="cx-motion cx-forest-glow-c"><circle cx="294" cy="346" r="3" opacity=".12"/><circle cx="294" cy="346" r=".95"/></g></g></g>
    </g>
    <path d="M0 370c43-16 73-3 103-4 28-1 48 13 65 34H0Zm454 30c31-34 62-29 85-40 27-13 58-4 101-9v49Z" fill="#173f33"/>
    <path d="M0 398c36-13 72-15 100-4l8 6H0Zm640-4c-34-13-70-15-98-5l-8 9h106ZM186 352c22-6 48-3 72 8-18 8-56 5-72-8ZM404 366c22-6 48-4 68 8-17 6-52 4-68-8ZM404 402c26-8 56-4 78 9-19 8-60 6-78-9Z" fill="#0b3a2c" opacity=".48"/>
    <g class="cx-motion cx-forest-fern" fill="#3f7a52" stroke="#0c2b24" stroke-width="1.5" stroke-linejoin="round">
      <path d="M82 400c13-30 22-48 55-65-25 20-36 36-52 65Z"/>
      <path d="m94 377-21-5-15-18 20 9 16 11Zm5-11-19-9-8-16 17 11 11 11Zm9-12-12-10-3-13 12 11 6 10Zm13-11-5-11 4-11 4 12-1 8Zm-22 28 23-9 19 0-18 10-27 2Zm8-12 19-10 15 1-14 8-22 4Zm12-12 14-9 15 1-12 6-18 5Z"/>
    </g>
    <path d="m544 400-6-20-13-11 18 7 5 13 1-26 8-17-2 27 12-15 20-6-22 17-12 24 19-12 17-1-24 12-7 8Z" fill="#38744f"/>
    <path d="m151 355 1-14 6-9-3 18 10-11 9-3-15 17Zm266-32 4-12-3-9 8 8-3 11 8-8 7-2-12 12Zm-235 62-5-16-8-4 12 3 5 12 3-14 6-7-4 20 9-8 8-1-13 12Z" fill="#79a470"/>
    <path d="m47 393 9-3 6 2m72-7 8 2 5 6m399-17 6-1 6 3m37 13 8-3 7 2" fill="none" stroke="#75a26d" stroke-width=".8" opacity=".55"/>
    <path d="M110 306c8-10 17-8 20 0-9 3-14 2-20 0Zm18 7c6-12 15-15 23-10-5 9-12 12-23 10Zm34-13c-6-10-3-18 4-23 6 8 4 16-4 23Zm15 12c4-12 12-17 22-14-3 10-10 15-22 14Zm-44 40c-12-6-14-16-9-23 9 6 12 14 9 23Zm27-11c-3-11 3-19 11-21 3 9-1 17-11 21Zm254-35c5-10 12-13 21-10-4 8-11 12-21 10Zm40 7c-3-11 2-19 10-23 3 10 0 18-10 23Zm47-1c-9-9-9-18-4-25 8 7 10 15 4 25Zm12 5c4-10 11-14 20-11-3 9-10 13-20 11Z" fill="#639766" opacity=".7"/>
    <path d="m117 316 1-12m15 15 9-10m22-1 1-23m7 31 13-11m-48 61-7-20 m32-1 4-15m256-25 6-7m24 14 5-18m41 14-3-18m9 20 10-8" fill="none" stroke="#abc38b" stroke-width=".6" opacity=".6"/>
    <path d="m55 14 3 9 14 4m41-13 8 5 12-3m36 23 5 9 14-2m25-8 11-6 8 4m20-15 9 5 10-4m51-11 7 6 11-5m65 4 10 7 9-3m58 11 11 3 7-6m45-6 5 8 12 1m44-7 8 5 7-4" fill="none" stroke="#71a774" stroke-width="1" opacity=".28"/>
  `);

  // 底纹理：把画稿的静态层光栅化成一张 GL 纹理，舞台直接采样它 —— 山形与卡片同源，
  // 不再靠 GLSL 手抄折线。
  //
  // 用 data: URI + <img> 解码而不是 fetch：宿主 CSP 是 connect-src 'none'，帧内 fetch
  // 一律失败，而 img-src 放行 data:/blob:（见 pluginHostBridge.ts 的 pluginSandboxDocument）。
  // 解码没完成或失败时 uArtOk 保持 0，着色器整幅回落到程序化底 —— 不能有「纹理没到=黑屏」。
  // 首帧之前不做任何 DOM/GL 动作：本文件在 Node 契约扫描里也会被求值。
  function artBase(svg) {
    var source = null, views = new Map();
    function release(ticket) { if (ticket) ticket.release({ apiReleased: true, allocationEnded: true }); }
    function retireSource(value) {
      if (value.users.size) return;
      value.retired = true; value.img.src = ''; value.uri = null;
      if (source === value) source = null;
      if (value.ended) { value.img = null; release(value.ticket); }
    }
    function acquireSource(owner) {
      if (!source) {
        var ticket = owner.resources.require({ decoderLeases: 1, decodeReservedBytes: 640 * 400 * 4,
          ownedCpuBytes: (svg.length * 9 + 64) * 2 }, 'CreativeAnime fixed640x400 SVG image and bounded encoded URI', 0, 'bounded-estimate');
        var value = { ticket: ticket, img: null, uri: null, users: new Set(), ready: false, failed: false, ended: false, retired: false };
        source = value;
        try {
          value.img = new Image(); value.uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
          value.img.src = value.uri;
          Promise.resolve(value.img.decode()).then(function () {
            if (value.retired) return;
            var bytes = value.img.naturalWidth * value.img.naturalHeight * 4;
            var result = ticket.commit({ decoderLeases: 1, decodeReservedBytes: bytes, ownedCpuBytes: value.uri.length * 2 });
            value.ready = result.ok; value.failed = !result.ok;
          }, function () { value.failed = true; }).finally(function () {
            value.ended = true;
            if (value.retired) { value.img = null; release(ticket); }
            else value.users.forEach(function (view) { if (view.invalidate) view.invalidate(); });
          });
        } catch (error) {
          value.ended = value.retired = true; if (value.img) value.img.src = ''; value.img = null;
          source = null; release(ticket); throw error;
        }
      }
      return source;
    }
    return {
      bind: function (gl, U, owner) {
        if (!svg) { gl.uniform1f(U.uArtOk, 0); return; }
        if (!owner || !owner.resources) throw new Error('resource-policy-required');
        var view = views.get(gl);
        if (!view) {
          var image = acquireSource(owner), useId = owner.resources.nextId();
          var retained = owner.resources.retain(image.ticket.resourceId, useId);
          if (!retained.ok) throw new Error(retained.reason);
          view = { source: image, lease: retained.ticket, cv: null, tex: null, h: 0, cpu: null, gpu: null, failed: false, invalidate: owner.invalidate };
          views.set(gl, view); image.users.add(view);
          owner.register(function () {
            if (!views.delete(gl)) return;
            if (view.tex) gl.deleteTexture(view.tex); if (view.cv) view.cv.width = view.cv.height = 0;
            view.cv = view.tex = null; release(view.cpu); release(view.gpu);
            image.users.delete(view); view.lease.release(); retireSource(image); view.invalidate = null;
          });
        }
        if (!view.source.ready || view.source.failed || view.failed) { gl.uniform1f(U.uArtOk, 0); return; }
        // 画稿 400 单位恒铺满画布高（见 PAINT 的 drawing/art 换算），所以纹理高度
        // 直接对齐 drawingBufferHeight。上限 2048 控显存，约 10MB RGBA。
        var th = Math.max(512, Math.min(2048, gl.drawingBufferHeight | 0));
        if (view.h !== th) {
          var width = Math.round(th * 1.6), pixels = width * th, cpu = null, gpu = null, cv = null, tex = null;
          try {
          cpu = owner.resources.require({ canvases: 1, drawingBufferPixels: pixels, ownedCpuBytes: pixels * 4 },
            'CreativeAnime per-view RGBA8 raster old plus new', 0);
          gpu = owner.resources.require({ textureDeclaredBytes: pixels * 4 }, 'CreativeAnime per-context RGBA8 texture old plus new', 0);
          cv = document.createElement('canvas'); cv.width = width; cv.height = th;
          var cx = cv.getContext('2d'); if (!cx) throw new Error('art-canvas-unavailable');
          cx.drawImage(view.source.img, 0, 0, width, th);
          tex = gl.createTexture(); if (!tex) throw new Error('art-texture-unavailable'); gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          // 不翻转：着色器用 q.y/400 直接当 v，画稿 y 轴向下与 canvas 一致。
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
          cpu.commit(); gpu.commit();
          if (view.tex) gl.deleteTexture(view.tex); if (view.cv) view.cv.width = view.cv.height = 0;
          view.tex = tex; view.cv = cv; view.h = th; release(view.cpu); release(view.gpu); view.cpu = cpu; view.gpu = gpu;
          } catch (error) {
            if (tex) gl.deleteTexture(tex); if (cv) cv.width = cv.height = 0;
            release(cpu); release(gpu); view.failed = true; throw error;
          }
        }
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, view.tex);
        gl.uniform1i(U.uArt, 3);
        gl.uniform1f(U.uArtOk, 1);
      }
    };
  }

  [
    { id: 'anime-sky', label: '晴空云海', aliases: ['晴空云海','晴空','云海','anime sky'],
      note: '风吹过云的留白，光落在远山。', tag: '01 / DAYLIGHT', art: artSky, shader: SKY,
      labels: ['日光亮度','云间微风','云影层次'] },
    { id: 'anime-coast', label: '黄昏海岸', aliases: ['黄昏海岸','黄昏','海岸','anime coast'],
      note: '潮水漫过沙岸，余晖在水面舒展。', tag: '02 / AFTERGLOW', art: artCoast, shader: COAST,
      labels: ['落日亮度','潮汐流速','海面碎光'] },
    { id: 'anime-rail', label: '月下列车', aliases: ['月下列车','月下','列车','anime rail'],
      note: '蒙蒙细雨中，一列暖灯缓缓穿过夜色。', tag: '03 / MOONLIGHT', art: artRail, shader: RAIL,
      labels: ['月夜亮度','夜行节奏','雨雾层次'] },
    { id: 'anime-forest', label: '森间灯火', aliases: ['森间灯火','森林灯火','森间','anime forest'],
      note: '沿着林间小径，走向一盏温暖的灯。', tag: '04 / LANTERNS', art: artForest, shader: FOREST,
      labels: ['林间亮度','枝叶微风','萤火密度'] }
  ].forEach(function (scene) {
    // 底纹理是**逐场景迁移**的：着色器里真的采样 uArt 的场景才有静态底，
    // 判据只能取自着色器源码本身，不能靠注释或名单 —— 名单会漏改，而漏改的
    // 表现是"这张画稿没生效"且不报错。还没迁的场景连 uniform 都不声明 ——
    // 声明了却没人采样，就是契约脚本那条"死参数"（check-creative 早先正是
    // 用它抓到 tunnel 的 uPush）。
    var usesArt = (PAINT + scene.shader).indexOf('uArt') >= 0;
    scene.base = usesArt ? artBase(scene.art.staticSvg) : null;
    CreativeGL.register({
      id: scene.id, label: scene.label, aliases: scene.aliases, ownsLyrics: false,
      params: [
        ['light',scene.labels[0],0.60,1.35,0.01,'',1.0],
        ['motion',scene.labels[1],0,2,0.05,'',0.65],
        ['detail',scene.labels[2],0,1,0.02,'',0.62]
      ],
      camera: { 'cam.yaw':0, 'cam.pitch':0, 'cam.dist':20, 'cam.fov':55, 'cam.height':0 },
      presentation: { family:'anime', description:scene.note, tag:scene.tag,
        art:scene.art.svg, artStatic:scene.art.staticSvg },
      geom: { mode:'TRIANGLES', verts:6, instances:1 }, depth:false, blend:'surface',
      bloomScale:0.06, toneMapped:false,
      uniforms: usesArt ? ['uPaint','uFrame','uArt','uArtOk'] : ['uPaint','uFrame'],
      decl: 'uniform vec3 uPaint;\nuniform vec4 uFrame;\n'
        + (usesArt ? 'uniform sampler2D uArt;\nuniform float uArtOk;\n' : ''),
      // 底纹理的上传器一起登记（函数键注册表原样保留，对象会被 JSON 深拷贝掉）：
      // 契约脚本要顺着 setup 的这一跳去查 uArt/uArtOk 到底有没有被赋值，
      // 只看 setup 的文本会把它当成"永远是 0"的参数。
      artBind: scene.base ? scene.base.bind : null,
      vert:VERT, frag:PAINT + scene.shader,
      setup:function (gl,U,S,owner) {
        if (scene.base) scene.base.bind(gl, U, owner);
        gl.uniform3f(U.uPaint,S.p.light,S.p.motion,S.p.detail);
        // Shared camera/model controls pan and crop the drawing without adding
        // perspective. Y rotation becomes a horizontal panorama adjustment.
        var m=S.modelMatrix, scale=m ? Math.max(0.01,Math.hypot(m[0],m[1],m[2])) : 1;
        // Manual camera and authored cue values stay continuous across the
        // +/-180 degree seam. CreativeStage suppresses incidental camera motion.
        var turn=m ? m[8]/scale : 0;
        var zoom=Math.max(0.72,Math.min(1.22,(S.cam.dist+(S.cam.tz||0)*0.4)/20*S.cam.fov/55))/Math.sqrt(scale);
        gl.uniform4f(U.uFrame,(Math.sin(S.cam.yaw)-turn)*65+(S.cam.tx||0)*14,
          Math.sin(S.cam.pitch)*40-(S.cam.ty||0)*14,zoom,S.cam.roll||0);
      }
    });
  });
}());
