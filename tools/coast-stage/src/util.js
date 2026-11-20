// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 几何与数学工具，改自 pelican-bike（claude-demo）src/util.js。
// 只保留舞台场景用到的部分；骨骼/IK/两圆柱连接等角色代码不移植。
import * as THREE from 'three';
import { geometryPlan, finishGeometry, copyGeometry } from './resource-tools.js';

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
// 帧率无关的指数阻尼
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function v3(x, y, z) {
  return new THREE.Vector3(x, y, z);
}

/**
 * 放样几何：沿中心线 center(t) 扫掠截面 section(t,a) -> [y,z]
 * 截面约定 (y,z) = (cos θ·h, sin θ·w)，θ = 2πa
 */
export function loft({ segs = 32, ring = 16, center, section, color }, scope) {
  const vertices = (segs + 1) * (ring + 1), indices = segs * ring * 6;
  const bytes = vertices * (color ? 11 : 8) * 4 + indices * (vertices > 65535 ? 4 : 2);
  const plan = geometryPlan(scope, bytes + (vertices * (color ? 8 : 5) + indices) * 8, bytes, "Coast loft source arrays");
  const pos = [];
  const uv = [];
  const col = [];
  const idx = [];
  const c = new THREE.Color();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const p = center(t);
    for (let j = 0; j <= ring; j++) {
      const a = j / ring;
      const [y, z] = section(t, a);
      pos.push(p.x, p.y + y, p.z + z);
      uv.push(t, a);
      if (color) {
        color(t, a, c);
        col.push(c.r, c.g, c.b);
      }
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < ring; j++) {
      const a = i * (ring + 1) + j;
      const b = a + ring + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (color) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return finishGeometry(scope, plan, g, bytes);
}

/**
 * 每帧可更新的变径管（棕榈树干、路灯弯臂），平行传输标架避免扭转
 */
export class DynamicTube {
  constructor(tub, rad, radiusFn, scope) {
    this.tub = tub;
    this.rad = rad;
    this.radiusFn = radiusFn;
    const n = (tub + 1) * (rad + 1);
    const bytes = n * 8 * 4 + tub * rad * 6 * (n > 65535 ? 4 : 2);
    const frameBytes = ((tub + 1) * 6 + 15) * 8; // _P/_T, two curve points and _N/_B/_d.
    const plan = geometryPlan(scope, bytes + tub * rad * 6 * 8 + frameBytes, bytes, "Coast dynamic tube arrays and frame vectors");
    this.pos = new Float32Array(n * 3);
    this.nor = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const idx = [];
    for (let i = 0; i <= tub; i++) {
      for (let j = 0; j <= rad; j++) {
        const k = i * (rad + 1) + j;
        uv[k * 2] = i / tub;
        uv[k * 2 + 1] = j / rad;
      }
    }
    for (let i = 0; i < tub; i++) {
      for (let j = 0; j < rad; j++) {
        const a = i * (rad + 1) + j;
        const b = a + rad + 1;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(this.pos, 3);
    const na = new THREE.BufferAttribute(this.nor, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    na.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa);
    g.setAttribute('normal', na);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.geometry = g;
    this.curve = new THREE.CatmullRomCurve3([v3(0, 0, 0), v3(0, 1, 0)], false, 'centripetal');
    this._P = [];
    this._T = [];
    for (let i = 0; i <= tub; i++) {
      this._P.push(new THREE.Vector3());
      this._T.push(new THREE.Vector3());
    }
    this._N = new THREE.Vector3();
    this._B = new THREE.Vector3();
    this._d = new THREE.Vector3();
    finishGeometry(scope, plan, g, bytes + frameBytes);
  }

  update(points) {
    const { tub, rad, pos, nor, _P, _T, _N, _B, _d } = this;
    this.curve.points = points;
    for (let i = 0; i <= tub; i++) this.curve.getPoint(i / tub, _P[i]);
    for (let i = 0; i <= tub; i++) {
      const a = _P[Math.max(0, i - 1)];
      const b = _P[Math.min(tub, i + 1)];
      _T[i].subVectors(b, a).normalize();
    }
    // 初始法线
    const T0 = _T[0];
    _N.set(0, 0, 1);
    if (Math.abs(T0.dot(_N)) > 0.9) _N.set(1, 0, 0);
    _N.addScaledVector(T0, -T0.dot(_N)).normalize();
    for (let i = 0; i <= tub; i++) {
      const T = _T[i];
      if (i > 0) _N.addScaledVector(T, -T.dot(_N)).normalize();
      _B.crossVectors(T, _N);
      const r = this.radiusFn(i / tub);
      const P = _P[i];
      for (let j = 0; j <= rad; j++) {
        const th = (j / rad) * TAU;
        const c = Math.cos(th);
        const s = Math.sin(th);
        _d.set(_N.x * c + _B.x * s, _N.y * c + _B.y * s, _N.z * c + _B.z * s);
        const k = (i * (rad + 1) + j) * 3;
        pos[k] = P.x + _d.x * r;
        pos[k + 1] = P.y + _d.y * r;
        pos[k + 2] = P.z + _d.z * r;
        nor[k] = _d.x;
        nor[k + 1] = _d.y;
        nor[k + 2] = _d.z;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
  }
}

// 对几何体整体着色（写入顶点色），便于合并成单一网格
export function paint(geo, color, scope) {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const plan = geometryPlan(scope, n * 3 * 4, n * 3 * 4, "Coast geometry vertex colors");
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', plan.upload(new THREE.BufferAttribute(arr, 3)));
  plan.cpuReady(arr.byteLength);
  return geo;
}

// 合并前统一属性：非索引 + position/normal/color
export function normalizeForMerge(geo, scope) {
  let g = geo.index ? copyGeometry(scope, geo, true) : geo;
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'color') g.deleteAttribute(k);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.color) paint(g, 0xffffff, scope);
  g.morphAttributes = {};
  return g;
}
