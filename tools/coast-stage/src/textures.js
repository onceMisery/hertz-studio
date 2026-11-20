// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 程序化纹理，改自 pelican-bike（claude-demo）src/textures.js。
// 只保留地形/路面/路牌/灯光牌与条纹所需；羽毛、藤篮、车架贴花等
// 角色纹理不移植。
import * as THREE from 'three';
import { mulberry32 } from './util.js';
const canvasAdmissions = new WeakMap();

function makeCanvas(w, h, scope) {
  const ticket = scope?.reserve({ canvases: 1, ownedCpuBytes: w * h * 4, textureDeclaredBytes: mipBytes(w, h) }, "Coast procedural RGBA8 canvas and mipmapped texture");
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  scope?.defer(() => { c.width = c.height = 0; });
  ticket?.materialize({ canvases: 1, ownedCpuBytes: w * h * 4 });
  if (ticket) canvasAdmissions.set(c, { ticket, bytes: mipBytes(w, h) });
  return [c, c.getContext('2d')];
}

function toTexture(c, { srgb = true, repeat = true, aniso = 8 } = {}, scope) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  const admission = canvasAdmissions.get(c);
  if (admission) t.onUpdate = () => admission.ticket.commit({ textureDeclaredBytes: admission.bytes });
  scope?.track(t); return t;
}

function mipBytes(w, h) { let bytes = 0; do { bytes += Math.max(1, w) * Math.max(1, h) * 4; w = Math.floor(w / 2); h = Math.floor(h / 2); } while (w || h); return bytes; }

// 可平铺的多倍频值噪声
function tileNoise(size, octaves, seed) {
  const rnd = mulberry32(seed);
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const g = 4 << o;
    const grid = new Float32Array(g * g);
    for (let i = 0; i < grid.length; i++) grid[i] = rnd();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * g;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * g;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const a = grid[(y0 % g) * g + (x0 % g)];
        const b = grid[(y0 % g) * g + ((x0 + 1) % g)];
        const c = grid[((y0 + 1) % g) * g + (x0 % g)];
        const d = grid[((y0 + 1) % g) * g + ((x0 + 1) % g)];
        out[y * size + x] += amp * ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

export function makeDetailTexture(size = 256, lo = 0.78, hi = 1.0, seed = 7, scope) {
  const [c, ctx] = makeCanvas(size, size, scope);
  const scratch = scope?.reserve({ ownedCpuBytes: size * size * 8 + 4 * (16 + 64 + 256 + 1024 + 4096 + 16384) }, "Coast detail noise six octave grids and ImageData");
  const n = tileNoise(size, 6, seed);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < n.length; i++) {
    const v = Math.round((lo + (hi - lo) * n[i]) * 255);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  scope?.releaseReservation(scratch);
  return toTexture(c, { srgb: false }, scope);
}

// 路面：24m x 5.4m 一个周期，含边线、虚线中线、自行车道标识
export function makeRoadTextures(scope) {
  const W = 2048;
  const H = 512;
  const [c, ctx] = makeCanvas(W, H, scope);
  const [b, bctx] = makeCanvas(W, H, scope);
  const rnd = mulberry32(42);
  ctx.fillStyle = '#44464b';
  ctx.fillRect(0, 0, W, H);
  bctx.fillStyle = '#808080';
  bctx.fillRect(0, 0, W, H);
  // 沥青颗粒
  for (let i = 0; i < 90000; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const s = rnd() * 2.2 + 0.6;
    const g = Math.floor(40 + rnd() * 70);
    ctx.fillStyle = `rgb(${g},${g + 1},${g + 4})`;
    ctx.fillRect(x, y, s, s);
    const bg = Math.floor(90 + rnd() * 120);
    bctx.fillStyle = `rgb(${bg},${bg},${bg})`;
    bctx.fillRect(x, y, s, s);
  }
  // 修补块
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = `rgba(20,20,24,${0.12 + rnd() * 0.12})`;
    const x = rnd() * W;
    const y = rnd() * H;
    ctx.fillRect(x, y, 60 + rnd() * 160, 30 + rnd() * 90);
  }
  // 车辙暗带
  const grd = ctx.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0.0, 'rgba(0,0,0,0)');
  grd.addColorStop(0.3, 'rgba(0,0,0,0.10)');
  grd.addColorStop(0.36, 'rgba(0,0,0,0)');
  grd.addColorStop(0.64, 'rgba(0,0,0,0)');
  grd.addColorStop(0.7, 'rgba(0,0,0,0.10)');
  grd.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  // 以米为单位绘制
  const sx = W / 24;
  const sy = H / 5.4;
  const paintLine = (x, y, w, h, color = '#ecebe2') => {
    ctx.fillStyle = color;
    ctx.fillRect(x * sx, y * sy, w * sx, h * sy);
    bctx.fillStyle = '#c8c8c8';
    bctx.fillRect(x * sx, y * sy, w * sx, h * sy);
  };
  paintLine(0, 0.18, 24, 0.12);
  paintLine(0, 5.1, 24, 0.12);
  for (let x = 0; x < 24; x += 6) paintLine(x, 2.64, 3, 0.12, '#f2c94c');

  // 右侧车道自行车标识 + 箭头（图标"上方"朝向前进方向 +x）
  ctx.save();
  ctx.translate(12 * sx, 4.0 * sy);
  ctx.rotate(Math.PI / 2);
  ctx.scale(sy, sx);
  ctx.strokeStyle = 'rgba(236,235,226,0.92)';
  ctx.fillStyle = 'rgba(236,235,226,0.92)';
  ctx.lineWidth = 0.09;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const wr = 0.42;
  ctx.beginPath();
  ctx.arc(-0.62, 0.35, wr, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0.62, 0.35, wr, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-0.62, 0.35);
  ctx.lineTo(-0.1, 0.35);
  ctx.lineTo(0.35, -0.2);
  ctx.lineTo(-0.3, -0.2);
  ctx.closePath();
  ctx.moveTo(-0.1, 0.35);
  ctx.lineTo(-0.36, -0.42);
  ctx.moveTo(0.62, 0.35);
  ctx.lineTo(0.42, -0.5);
  ctx.lineTo(0.6, -0.55);
  ctx.moveTo(-0.5, -0.45);
  ctx.lineTo(-0.2, -0.45);
  ctx.stroke();
  // 前进箭头
  ctx.beginPath();
  ctx.moveTo(0, -2.9);
  ctx.lineTo(0.45, -2.3);
  ctx.lineTo(0.16, -2.3);
  ctx.lineTo(0.16, -1.6);
  ctx.lineTo(-0.16, -1.6);
  ctx.lineTo(-0.16, -2.3);
  ctx.lineTo(-0.45, -2.3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const map = toTexture(c, { aniso: 16 }, scope);
  const bump = toTexture(b, { srgb: false, aniso: 16 }, scope);
  return { map, bump };
}

export function makeSpriteTexture(scope) {
  const S = 128;
  const [c, ctx] = makeCanvas(S, S, scope);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return toTexture(c, { repeat: false }, scope);
}

// 标准人形骑行者简笔（交通警示牌画法）：前倾躯干 + 双轮车架，
// 画在约 2×2 单位盒内，+x 为前进方向。
function drawRiderGlyph(ctx, x, y, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = '#161616';
  ctx.strokeStyle = '#161616';
  ctx.lineWidth = 0.09;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 车轮
  ctx.beginPath();
  ctx.arc(-0.6, 0.52, 0.35, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0.63, 0.52, 0.35, 0, Math.PI * 2);
  ctx.stroke();
  // 车架：链撑、座管、上管、下管、前叉
  ctx.beginPath();
  ctx.moveTo(-0.6, 0.52);
  ctx.lineTo(0.02, 0.52);      // 链撑 -> 五通
  ctx.lineTo(-0.2, 0.0);       // 座管
  ctx.moveTo(-0.2, 0.0);
  ctx.lineTo(0.46, 0.02);      // 上管 -> 车首
  ctx.moveTo(0.46, 0.02);
  ctx.lineTo(0.02, 0.52);      // 下管
  ctx.moveTo(0.46, 0.02);
  ctx.lineTo(0.63, 0.52);      // 前叉
  ctx.moveTo(-0.6, 0.52);
  ctx.lineTo(-0.2, 0.0);       // 座撑
  ctx.stroke();
  // 车把与车座
  ctx.beginPath();
  ctx.moveTo(0.46, 0.02);
  ctx.lineTo(0.58, -0.12);     // 立管
  ctx.moveTo(-0.34, -0.08);
  ctx.lineTo(-0.1, -0.08);     // 车座
  ctx.stroke();
  // 人形：髋在车座，躯干前倾，手臂扶把，两腿踩曲柄
  ctx.beginPath();
  ctx.moveTo(-0.2, -0.12);
  ctx.lineTo(0.22, -0.64);     // 躯干
  ctx.moveTo(0.22, -0.64);
  ctx.lineTo(0.4, -0.38);      // 大臂
  ctx.lineTo(0.55, -0.12);     // 小臂扶把
  ctx.moveTo(-0.2, -0.12);
  ctx.lineTo(0.2, 0.22);       // 前腿
  ctx.lineTo(0.18, 0.68);
  ctx.moveTo(-0.2, -0.12);
  ctx.lineTo(-0.3, 0.24);      // 后腿
  ctx.lineTo(-0.14, 0.36);
  ctx.stroke();
  // 头
  ctx.beginPath();
  ctx.arc(0.32, -0.79, 0.13, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// 路牌：黄色菱形警示牌
export function makeSignTexture(kind, scope) {
  const S = 512;
  const [c, ctx] = makeCanvas(S, S, scope);
  ctx.clearRect(0, 0, S, S);
  if (kind === 'crossing') {
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#161616';
    ctx.fillRect(-172, -172, 344, 344);
    ctx.fillStyle = '#f7c531';
    ctx.fillRect(-160, -160, 320, 320);
    ctx.restore();
    drawRiderGlyph(ctx, S / 2, S / 2 - 6, 112);
  } else if (kind === 'speed') {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, 230, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 42;
    ctx.strokeStyle = '#d7263d';
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, 200, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.font = '900 190px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('45', S / 2, S / 2 - 18);
    ctx.font = '700 46px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('骑行限速', S / 2, S / 2 + 110);
  } else {
    // 蓝色指示牌：前方海岸
    ctx.fillStyle = '#0f5fa8';
    roundRect(ctx, 20, 110, S - 40, S - 220, 34);
    ctx.fill();
    ctx.lineWidth = 12;
    ctx.strokeStyle = '#ffffff';
    roundRect(ctx, 36, 126, S - 72, S - 252, 24);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '800 76px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('前方海岸', S / 2, S / 2 - 40);
    ctx.font = '700 44px "Arial", sans-serif';
    ctx.fillText('COAST AHEAD  ➜', S / 2, S / 2 + 56);
  }
  return toTexture(c, { repeat: false }, scope);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 灯塔条纹 / 遮阳伞条纹
export function makeStripeTexture(colors, n = 8, vertical = false, scope) {
  const [c, ctx] = makeCanvas(256, 256, scope);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[i % colors.length];
    if (vertical) ctx.fillRect((i * 256) / n, 0, 256 / n + 1, 256);
    else ctx.fillRect(0, (i * 256) / n, 256, 256 / n + 1);
  }
  return toTexture(c, {}, scope);
}
