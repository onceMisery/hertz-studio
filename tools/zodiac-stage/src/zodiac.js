// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 十二星图几何与纯函数。figures.js 提供手绘轮廓、孔洞及主星坐标；
// Earcut 约束三角化后细分，网格与粒子共享同一剪影和等比变换。
// 随机采样有种子，seek 与顺播一致；不创建 DOM 或 GPU 资源。

import { clamp, seededRandom } from './util.js';
import earcut from 'three/src/extras/lib/earcut.js';
import { FIGURES } from './figures.js';

export const SIGN_COUNT = 12;

// 单座生命周期（秒）：汇聚 → 停留 → 散开；散开终点即下一座汇聚起点。
export const GATHER_SECONDS = 2.8;
export const HOLD_SECONDS = 7.6;
export const DISPERSE_SECONDS = 2.6;
export const CYCLE_SECONDS = GATHER_SECONDS + HOLD_SECONDS + DISPERSE_SECONDS;

// 根据精确轮廓包围盒等比落到设计框，不拉伸高瘦或横宽的造型。
export const FIG_HALF = 2.50;
export const FIG_ASPECT = 1.78;
// 设计框半宽。缩放是等比的（x/y 同一个 k），所以横宽的星座会撑满宽度、顶到 ±这里。
export const FIG_HALF_W = FIG_HALF * FIG_ASPECT;
// 体积深度上限；正面依轮廓距离隆起，背面与侧壁封闭体积。
export const FIGURE_DEPTH = 0.85;
// 公开的画框边界，留量供呼吸与交互使用。
export const SHAPE_BOX = FIG_HALF_W * 1.06;
export const SHAPE_BOX_V = FIG_HALF * 1.06;
export const SHAPE_BOX_Z = FIGURE_DEPTH * 1.2;

// 默认连线深度保留兼容；主星和网格边实际贴合正面曲面的逐点深度。
export const CONSTELLATION_Z = 0.50;
export const FIGURE_Z = 0.26;
// 连线的两级宽度（世界单位）：细芯保持矢量清晰，宽晕给一层柔光。
// 参考图里连线是「一眼可读」的主元素，1px 的线在这个体量下等于没画。
export const LINE_CORE_WIDTH = 0.022;
export const LINE_HALO_WIDTH = 0.072;

// 形象图网格边同样是两级：细芯给矢量感，宽晕给低多边形的辉光。
// 用 LineBasicMaterial 画不出这个宽度（WebGL 下 linewidth 恒为 1），所以网格边
// 也走丝带几何。宽度压得比连线细一档 —— 参考图里网格是「底面语言」，密而细；
// 量出来亮像素（L>170）占比一度到 8.6%，而参考只有 3~5%。
export const EDGE_CORE_WIDTH = 0.0055;
export const EDGE_HALO_WIDTH = 0.017;

export const ZODIAC = [
  { id: 'aries', cn: '白羊', en: 'Aries' },
  { id: 'taurus', cn: '金牛', en: 'Taurus' },
  { id: 'gemini', cn: '双子', en: 'Gemini' },
  { id: 'cancer', cn: '巨蟹', en: 'Cancer' },
  { id: 'leo', cn: '狮子', en: 'Leo' },
  { id: 'virgo', cn: '处女', en: 'Virgo' },
  { id: 'libra', cn: '天秤', en: 'Libra' },
  { id: 'scorpius', cn: '天蝎', en: 'Scorpius' },
  { id: 'sagittarius', cn: '射手', en: 'Sagittarius' },
  { id: 'capricornus', cn: '摩羯', en: 'Capricornus' },
  { id: 'aquarius', cn: '水瓶', en: 'Aquarius' },
  { id: 'pisces', cn: '双鱼', en: 'Pisces' },
];

// ---------------------------------------------------------------------------
// 采样原语：rnd 为 mulberry32；返回 [x, y, z]。
// ---------------------------------------------------------------------------

// 高斯近似（三次均匀相加），多数点落在 ±1。
function gauss(rnd) {
  return (rnd() + rnd() + rnd() - 1.5) * 0.82;
}

// 单位球内一个随机方向。
function unitDir(rnd) {
  let x, y, z, l;
  do {
    x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1;
    l = x * x + y * y + z * z;
  } while (l > 1 || l < 1e-6);
  const inv = 1 / Math.sqrt(l);
  return [x * inv, y * inv, z * inv];
}

// Explicit silhouettes own fitting, mesh coverage and particle placement.
const fitCache = new Array(SIGN_COUNT);
export function shapeFit(index) {
  const i = ((index % SIGN_COUNT) + SIGN_COUNT) % SIGN_COUNT;
  if (!fitCache[i]) {
    const points = FIGURES[i].regions.flatMap(r => r.outline);
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const dx = maxX - minX, dy = maxY - minY;
    const k = Math.min(FIG_HALF_W * 2 / dx, FIG_HALF * 2 / dy);
    fitCache[i] = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
      k, kz: 1, w: dx * k / 2, h: dy * k / 2 };
  }
  return fitCache[i];
}

export const FIGURE_MESH_POINTS = 560;
const artworkCache = new Array(SIGN_COUNT);

function insideRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0]-a[0]) * (y-a[1]) / (b[1]-a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function reliefDepth(index, x, y) {
  let distance = 0;
  for (const region of FIGURES[index].regions) {
    if (!insideRing(x, y, region.outline) || region.holes.some(h => insideRing(x, y, h))) continue;
    let nearest = Infinity;
    for (const ring of [region.outline, ...region.holes]) {
      ring.forEach((a, i) => {
        const b = ring[(i+1)%ring.length], dx = b[0]-a[0], dy = b[1]-a[1];
        const t = clamp(((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy), 0, 1);
        nearest = Math.min(nearest, Math.hypot(x-a[0]-dx*t, y-a[1]-dy*t));
      });
    }
    distance = Math.max(distance, nearest * shapeFit(index).k);
  }
  return FIGURE_Z + .06 + Math.min(FIGURE_DEPTH-FIGURE_Z-.08, Math.sqrt(distance)*.52);
}

const backDepth = z => -(z-FIGURE_Z)*.8-.08;

// 体积法线：由三角面片按面积加权求和，再把 z 翻正（正面朝机位）。
// 起伏只来自 reliefDepth 的径向隆起，所以内部法线接近 +z、靠轮廓处向外倾斜 ——
// 正好让轮廓附近的星尘能吃到轮廓光。一次按座烘焙，采样时只做插值。
function vertexNormals(points, triangles, depths) {
  const out = new Float32Array(points.length * 3);
  for (const [a, b, c] of triangles) {
    const p = points[a], q = points[b], r = points[c];
    const ux = q[0]-p[0], uy = q[1]-p[1], uz = depths[b]-depths[a];
    const vx = r[0]-p[0], vy = r[1]-p[1], vz = depths[c]-depths[a];
    let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    for (const v of [a, b, c]) {
      out[v*3] += nx; out[v*3+1] += ny; out[v*3+2] += nz;
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const length = Math.hypot(out[i], out[i+1], out[i+2]);
    if (length > 1e-9) {
      out[i] /= length; out[i+1] /= length; out[i+2] /= length;
    } else {
      out[i] = 0; out[i+1] = 0; out[i+2] = 1;
    }
  }
  return out;
}

function artwork(index) {
  if (artworkCache[index]) return artworkCache[index];
  const points = [], triangles = [], contours = [];
  for (const region of FIGURES[index].regions) {
    const rings = [region.outline, ...region.holes];
    const base = points.length;
    const flat = [], holes = [];
    rings.forEach((ring, r) => {
      if (r) holes.push(flat.length / 2);
      const start = points.length;
      ring.forEach(p => { points.push(p.slice()); flat.push(...p); });
      if (!r) ring.forEach((p, k) => contours.push([start + k, start + (k + 1) % ring.length]));
    });
    const indices = earcut(flat, holes, 2);
    for (let t = 0; t < indices.length; t += 3) {
      triangles.push(indices.slice(t, t + 3).map(v => base + v));
    }
  }
  const rnd = seededRandom('zodiac-contour-mesh:' + FIGURES[index].id);
  // Split both faces incident to an edge together: no cracks or T-junctions.
  // Earcut preserves concavities and holes before any refinement takes place.
  while (points.length < FIGURE_MESH_POINTS) {
    let best = null, longest = -1;
    for (const tri of triangles) {
      for (let j = 0; j < 3; j++) {
        const a = tri[j], b = tri[(j + 1) % 3], p = points[a], q = points[b];
        const length = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
        if (length > longest) { longest = length; best = [a,b]; }
      }
    }
    const [a,b] = best, p = points[a], q = points[b];
    const mix = .43 + rnd() * .14, n = points.length;
    points.push([p[0] + (q[0] - p[0]) * mix, p[1] + (q[1] - p[1]) * mix]);
    for (let t = triangles.length - 1; t >= 0; t--) {
      const tri = triangles[t];
      if (!tri.includes(a) || !tri.includes(b)) continue;
      for (let j = 0; j < 3; j++) {
        const u = tri[j], v = tri[(j + 1) % 3], w = tri[(j + 2) % 3];
        if ((u === a && v === b) || (u === b && v === a)) {
          triangles[t] = [u,n,w]; triangles.push([n,v,w]); break;
        }
      }
    }
  }
  let totalArea = 0, totalLength = 0;
  const areas = triangles.map(([a,b,c]) => {
    const p = points[a], q = points[b], r = points[c];
    totalArea += Math.abs((q[0]-p[0])*(r[1]-p[1]) - (q[1]-p[1])*(r[0]-p[0])) / 2;
    return totalArea;
  });
  const lengths = contours.map(([a,b]) => {
    totalLength += Math.hypot(points[a][0]-points[b][0], points[a][1]-points[b][1]);
    return totalLength;
  });
  const depths = points.map(([x,y]) => reliefDepth(index,x,y));
  const normals = vertexNormals(points, triangles, depths);
  return (artworkCache[index] = { points, triangles, contours, areas, lengths, totalArea, totalLength, depths, normals });
}

function weightedIndex(cumulative, value) {
  let lo = 0, hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (value < cumulative[mid]) hi = mid; else lo = mid + 1;
  }
  return lo;
}

function sampleArtwork(index, count, seed, surface = false, normalsOut = null) {
  const art = artwork(index), fit = shapeFit(index), rnd = seededRandom(seed);
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    let x, y, depth;
    let nx = 0, ny = 0, nz = 1;
    if (rnd() < .18) {
      const [a,b] = art.contours[weightedIndex(art.lengths, rnd() * art.totalLength)];
      const t = rnd(), p = art.points[a], q = art.points[b];
      x = p[0] + (q[0]-p[0])*t; y = p[1] + (q[1]-p[1])*t;
      depth = art.depths[a]*(1-t)+art.depths[b]*t;
      nx = art.normals[a*3]*(1-t)+art.normals[b*3]*t;
      ny = art.normals[a*3+1]*(1-t)+art.normals[b*3+1]*t;
      nz = art.normals[a*3+2]*(1-t)+art.normals[b*3+2]*t;
    } else {
      const tri = art.triangles[weightedIndex(art.areas, rnd() * art.totalArea)];
      const [p,q,r] = tri.map(v => art.points[v]);
      const u = Math.sqrt(rnd()), v = rnd();
      x = p[0]*(1-u) + q[0]*u*(1-v) + r[0]*u*v;
      y = p[1]*(1-u) + q[1]*u*(1-v) + r[1]*u*v;
      depth = art.depths[tri[0]]*(1-u)+art.depths[tri[1]]*u*(1-v)+art.depths[tri[2]]*u*v;
      for (let k = 0; k < 3; k += 1) {
        const w = [1-u, u*(1-v), u*v][k], at = tri[k]*3;
        nx += art.normals[at]*w; ny += art.normals[at+1]*w; nz += art.normals[at+2]*w;
      }
    }
    pos[i*3] = (x-fit.cx)*fit.k;
    pos[i*3+1] = (y-fit.cy)*fit.k;
    // zMix 偏向正面：星尘的「表皮」才是被看见的那一层，均匀铺满厚度会让
    // 正面和背面叠成同一片亮雾。仍保留少量贴背粒子，侧面才有真正的纵深。
    const zMix = surface ? 1 : 0.12 + 0.88 * Math.pow(rnd(), 0.58);
    pos[i*3+2] = surface ? depth : backDepth(depth)+(depth-backDepth(depth))*zMix;
    if (normalsOut) {
      // 体积内粒子：前半参考正面法线、后半沿深度翻转，中间过渡到侧壁；
      // 这样从背后看过去也有一致的受光面，而不是一块均匀发光的贴片。
      const flip = surface ? 1 : zMix * 2 - 1;
      let nx2 = nx, ny2 = ny, nz2 = nz * flip;
      const length = Math.hypot(nx2, ny2, nz2);
      if (length > 1e-6) { nx2 /= length; ny2 /= length; nz2 /= length; }
      else { nx2 = 0; ny2 = 0; nz2 = 1; }
      normalsOut[i*3] = nx2; normalsOut[i*3+1] = ny2; normalsOut[i*3+2] = nz2;
    }
  }
  return pos;
}

export function buildShape(index, count) {
  const i = ((index % SIGN_COUNT) + SIGN_COUNT) % SIGN_COUNT;
  const normals = new Float32Array(count * 3);
  const pos = sampleArtwork(i, count, 'zodiac-shape:' + ZODIAC[i].id + ':' + count, false, normals);
  const rnd = seededRandom('zodiac-shine:' + ZODIAC[i].id + ':' + count);
  const shine = new Float32Array(count);
  for (let k = 0; k < count; k++) shine[k] = .40 + Math.pow(rnd(), 3) * .8;
  return { pos, normals, shine, sign: ZODIAC[i] };
}

export const CONSTELLATION = FIGURES.map(({nodes,lines}) => ({nodes,lines}));

function surfaceDepth(index, x, y) {
  const art = artwork(index);
  for (const [a,b,c] of art.triangles) {
    const p=art.points[a], q=art.points[b], r=art.points[c];
    const det=(q[1]-r[1])*(p[0]-r[0])+(r[0]-q[0])*(p[1]-r[1]);
    const u=((q[1]-r[1])*(x-r[0])+(r[0]-q[0])*(y-r[1]))/det;
    const v=((r[1]-p[1])*(x-r[0])+(p[0]-r[0])*(y-r[1]))/det;
    if(u>=-1e-6 && v>=-1e-6 && u+v<=1+1e-6) return art.depths[a]*u+art.depths[b]*v+art.depths[c]*(1-u-v);
  }
  return reliefDepth(index,x,y);
}

export function transitionStyle(cycle, sign = 0) {
  const n = Math.max(0,Math.floor(Number(cycle)||0));
  const s = Math.max(0,Math.floor(Number(sign)||0));
  // 座次也参与配方：同一轮里十二座各有各的轨迹，下一轮同一座又是另一种。
  // hash 只做确定性的整数混合，跳转回同一时刻仍得到相同配方。
  const hash = (salt) => {
    let h = Math.imul(n + 0x9e3779b9, 0x85ebca6b)
      ^ Math.imul(s + 0x7f4a7c15, 0xc2b2ae35) ^ salt;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  };
  return {
    // 八种轨迹：旋涡、纵深星流、波浪、轨道、放射、螺旋、星雨、脉冲。
    gather: (n*3+s*5)%8, disperse: (n*5+s*3+1)%8,
    direction: (n+s)%2 ? -1 : 1,
    stagger: .30+hash(0x1f)*.30,   // 粒子错峰窗口
    spin: .65+hash(0x2f)*.90,      // 旋进速度
    arc: .72+hash(0x3f)*.65,       // 飞行弧幅
  };
}
export function buildConstellation(index) {
  const i = ((index % SIGN_COUNT) + SIGN_COUNT) % SIGN_COUNT;
  const src = CONSTELLATION[i], fit = shapeFit(i);
  const x = new Float32Array(src.nodes.length), y = new Float32Array(src.nodes.length);
  const m = new Float32Array(src.nodes.length);
  const z = new Float32Array(src.nodes.length);
  src.nodes.forEach(([px,py,b], k) => {
    x[k] = (px-fit.cx)*fit.k; y[k] = (py-fit.cy)*fit.k; m[k] = b;
    z[k] = surfaceDepth(i,px,py)+.08;
  });
  return { x, y, z, m, nodes: x.length, segments: src.lines.length,
    core: buildRibbon(x, y, src.lines, LINE_CORE_WIDTH,z),
    halo: buildRibbon(x, y, src.lines, LINE_HALO_WIDTH,z) };
}

// Retained pure utility for the existing public test API; artwork uses Earcut.
export function delaunay2(points) {
  const n = points.length;
  if (n < 3) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const p = points[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;
  const dmax = Math.max(dx, dy);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  // 超三角形：把全部输入点稳稳包在里面。
  const verts = [
    { x: midX - 20 * dmax, y: midY - dmax },
    { x: midX, y: midY + 20 * dmax },
    { x: midX + 20 * dmax, y: midY - dmax },
  ].concat(points.map((p) => ({ x: p.x, y: p.y })));
  let tris = [[0, 1, 2]];
  const circum = (a, b, c) => {
    const ax = a.x, ay = a.y, bx = b.x, by = b.y, cx2 = c.x, cy2 = c.y;
    const d = 2 * (ax * (by - cy2) + bx * (cy2 - ay) + cx2 * (ay - by));
    if (Math.abs(d) < 1e-12) return { x: 0, y: 0, r: Infinity };
    const a2 = ax * ax + ay * ay;
    const b2 = bx * bx + by * by;
    const c2 = cx2 * cx2 + cy2 * cy2;
    const ux = (a2 * (by - cy2) + b2 * (cy2 - ay) + c2 * (ay - by)) / d;
    const uy = (a2 * (cx2 - bx) + b2 * (ax - cx2) + c2 * (bx - ax)) / d;
    const dx2 = ux - ax, dy2 = uy - ay;
    return { x: ux, y: uy, r: dx2 * dx2 + dy2 * dy2 };
  };
  const cc = [circum(verts[0], verts[1], verts[2])];
  for (let p = 3; p < verts.length; p += 1) {
    const pt = verts[p];
    const bad = [];
    for (let t = 0; t < tris.length; t += 1) {
      const c = cc[t];
      const ddx = pt.x - c.x, ddy = pt.y - c.y;
      if (ddx * ddx + ddy * ddy <= c.r) bad.push(t);
    }
    // 坏三角形的边界边（只出现一次的边）围成空腔多边形。
    const edges = new Map();
    const key = (a, b) => (a < b ? a + ':' + b : b + ':' + a);
    bad.forEach((t) => {
      const [a, b, c] = tris[t];
      [[a, b], [b, c], [c, a]].forEach(([u, v]) => {
        const k = key(u, v);
        const hit = edges.get(k);
        if (hit) hit.n += 1; else edges.set(k, { u, v, n: 1 });
      });
    });
    const keepTris = [];
    const keepCc = [];
    for (let t = 0; t < tris.length; t += 1) {
      if (bad.indexOf(t) < 0) { keepTris.push(tris[t]); keepCc.push(cc[t]); }
    }
    tris = keepTris;
    cc.length = 0;
    keepCc.forEach((c) => cc.push(c));
    edges.forEach((e) => {
      if (e.n !== 1) return;
      tris.push([e.u, e.v, p]);
      cc.push(circum(verts[e.u], verts[e.v], pt));
    });
  }
  // 丢掉与超三角形共享顶点的输出。
  return tris.filter((t) => t[0] > 2 && t[1] > 2 && t[2] > 2)
    .map((t) => [t[0] - 3, t[1] - 3, t[2] - 3]);
}


export function buildFigureMesh(index, cloudCount) {
  const i = ((index % SIGN_COUNT) + SIGN_COUNT) % SIGN_COUNT;
  const art = artwork(i), fit = shapeFit(i);
  const pts = art.points.map(([x,y]) => ({x:(x-fit.cx)*fit.k, y:(y-fit.cy)*fit.k}));
  const tris = art.triangles;
  const cloud = sampleArtwork(i, cloudCount, 'zodiac-figure-cloud:' + ZODIAC[i].id + ':' + cloudCount, true);

  const tintRnd = seededRandom('zodiac-figure-tint:' + ZODIAC[i].id);
  const boundary = new Map();
  tris.forEach(([a,b,c]) => [[a,b],[b,c],[c,a]].forEach(([u,v]) => {
    const key=u<v ? u+':'+v : v+':'+u;
    if(boundary.has(key)) boundary.get(key).count++;
    else boundary.set(key,{u,v,count:1});
  }));
  const rims = [...boundary.values()].filter(e=>e.count===1);
  const triangles = tris.length*2+rims.length*2;
  const meshPos = new Float32Array(triangles * 9);
  const tint = new Float32Array(triangles * 9);
  const edgeSet = new Map();
  tris.forEach(([a, b, c], t) => {
    const v = [pts[a], pts[b], pts[c]];
    v.forEach((p, n) => {
      meshPos[t * 9 + n * 3] = p.x;
      meshPos[t * 9 + n * 3 + 1] = p.y;
      meshPos[t * 9 + n * 3 + 2] = art.depths[[a,b,c][n]];
    });
    // 面片明度：暗面/亮面交错，低多边形才不塌成一块平色。
    const t0 = 0.62 + tintRnd() * 0.66;
    for (let n = 0; n < 3; n += 1) tint[t * 9 + n * 3] = tint[t * 9 + n * 3 + 1] = tint[t * 9 + n * 3 + 2] = t0;
    [[a, b], [b, c], [c, a]].forEach(([u, w]) => {
      const k = u < w ? u + ':' + w : w + ':' + u;
      if (!edgeSet.has(k)) edgeSet.set(k, [u, w]);
    });
  });
  let face=tris.length;
  const addFace = vertices => {
    const tone=.68+tintRnd()*.28;
    vertices.forEach(([index,back],k)=>{
      const p=pts[index], offset=face*9+k*3;
      meshPos.set([p.x,p.y,back?backDepth(art.depths[index]):art.depths[index]],offset);
      tint.set([tone,tone,tone],offset);
    });
    face++;
  };
  tris.forEach(([a,b,c])=>addFace([[c,true],[b,true],[a,true]]));
  rims.forEach(({u,v})=>{
    addFace([[u,false],[u,true],[v,true]]);
    addFace([[u,false],[v,true],[v,false]]);
  });
  const px = new Float32Array(pts.length);
  const py = new Float32Array(pts.length);
  pts.forEach((p, k) => { px[k] = p.x; py[k] = p.y; });
  const edgeLines = [];
  edgeSet.forEach((pair) => edgeLines.push(pair));
  const contourLines = rims.map(({u,v}) => [u,v]);
  const frontDepths = art.depths.map(z => z + .006);
  // 网格顶点的亮点云（参考图里每个三角形顶点都是一个小亮核）。
  const nodes = new Float32Array(pts.length * 3);
  pts.forEach((p, k) => {
    nodes[k * 3] = p.x; nodes[k * 3 + 1] = p.y; nodes[k * 3 + 2] = art.depths[k]+.006;
  });
  return {
    cloud,
    mesh: { pos: meshPos, tint },
    edgeCore: buildRibbon(px, py, edgeLines, EDGE_CORE_WIDTH, art.depths.map(z=>z+.006)),
    edgeHalo: buildRibbon(px, py, edgeLines, EDGE_HALO_WIDTH, art.depths.map(z=>z+.006)),
    contourCore: buildRibbon(px, py, contourLines, .012, frontDepths),
    contourHalo: buildRibbon(px, py, contourLines, .048, frontDepths),
    nodes,
    triangles,
    frontTriangles: tris.length,
    segmentCount: edgeSet.size,
  };
}

// 连线丝带：二维线段按宽度向两侧挤成四边形（不做屏幕空间的粗线，几何一次性
// 烘死在造型平面里，缩放旋转下始终清晰）。两端各外扩半个线宽，拐角就不会开豁口。
// z 支持标量或逐节点深度，连线两端随曲面插值。
export function buildRibbon(x, y, lines, width, z) {
  const hw = (width || 0.03) / 2;
  const zz = z == null ? CONSTELLATION_Z : z;
  const out = new Float32Array(lines.length * 18);
  lines.forEach(([a, b], s) => {
    const az = typeof zz === 'number' ? zz : zz[a];
    const bz = typeof zz === 'number' ? zz : zz[b];
    let dx = x[b] - x[a], dy = y[b] - y[a];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const nx = -dy * hw, ny = dx * hw;
    const ex = dx * hw, ey = dy * hw;
    const ax = x[a] - ex, ay = y[a] - ey;
    const bx = x[b] + ex, by = y[b] + ey;
    const v = [
      ax + nx, ay + ny, ax - nx, ay - ny, bx - nx, by - ny,
      ax + nx, ay + ny, bx - nx, by - ny, bx + nx, by + ny,
    ];
    for (let n = 0; n < 6; n += 1) {
      out[s * 18 + n * 3] = v[n * 2];
      out[s * 18 + n * 3 + 1] = v[n * 2 + 1];
      out[s * 18 + n * 3 + 2] = [az,az,bz,az,bz,bz][n];
    }
  });
  return out;
}

// 粒子汇聚前 / 散开后的深空云团：大部分是宽球壳里的远星，小部分拉成星流，
// 让飞行轨迹有「从星海深处冲出来」的纵深。云团围绕 ±4.2..16 的半径。
export function buildCloud(seedStr, count) {
  const rnd = seededRandom('zodiac-cloud:' + seedStr);
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const stream = rnd() < 0.28;
    if (stream) {
      // 星流：沿随机方向拉长的一条短线段。
      const dir = unitDir(rnd);
      const along = (rnd() - 0.5) * 22;
      const jitter = 0.35;
      pos[i * 3] = dir[0] * along + gauss(rnd) * jitter;
      pos[i * 3 + 1] = dir[1] * along * 0.6 + gauss(rnd) * jitter;
      pos[i * 3 + 2] = dir[2] * along + gauss(rnd) * jitter;
    } else {
      const dir = unitDir(rnd);
      const r = 4.2 + Math.pow(rnd(), 0.7) * 12;
      pos[i * 3] = dir[0] * r;
      pos[i * 3 + 1] = dir[1] * r * 0.7;
      pos[i * 3 + 2] = dir[2] * r;
    }
  }
  return pos;
}

// 每个粒子的随机种子（错峰汇聚/闪烁），全周期复用，单独一片 buffer。
export function buildSeeds(count) {
  const rnd = seededRandom('zodiac-seeds:' + count);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i += 1) seeds[i] = rnd();
  return seeds;
}

// 生命周期状态机（纯函数）：time 为播放秒。
// 返回 {index, state: 'gather'|'hold'|'disperse', t: 状态内秒数, cycle}。
export function timelineAt(time) {
  const t = Math.max(0, Number(time) || 0);
  const cycle = Math.floor(t / CYCLE_SECONDS);
  const local = t - cycle * CYCLE_SECONDS;
  if (local < GATHER_SECONDS) {
    return { index: ((cycle % SIGN_COUNT) + SIGN_COUNT) % SIGN_COUNT, state: 'gather', t: local, cycle };
  }
  if (local < GATHER_SECONDS + HOLD_SECONDS) {
    return { index: ((cycle % SIGN_COUNT) + SIGN_COUNT) % SIGN_COUNT, state: 'hold', t: local - GATHER_SECONDS, cycle };
  }
  return { index: ((cycle % SIGN_COUNT) + SIGN_COUNT) % SIGN_COUNT, state: 'disperse', t: local - GATHER_SECONDS - HOLD_SECONDS, cycle };
}

// 低频能量：前 5 个频带的均值，夹 0..1（保留旧立面，供 main 与契约使用）。
export function viewBass(bins) {
  if (!bins || !bins.length) return 0;
  let sum = 0;
  const n = Math.min(5, bins.length);
  for (let i = 0; i < n; i += 1) sum += clamp(Number(bins[i]) || 0);
  return clamp(sum / n);
}

// 缩放距离钳制（纯函数）。
export function zoomClamp(dist, minDist, maxDist) {
  return clamp(dist, minDist || 3, maxDist || 17);
}
