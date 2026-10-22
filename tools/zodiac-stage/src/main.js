// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 「星座 · 十二星图」粒子舞台引擎入口。纯场景层：不感知 hertz-studio 的任何全局，
// 由 plugin/ui/stage-zodiac.js 适配层驱动。
//
// 每次只出现一座：粒子从深空云团汇聚成三维星座造型 → 停留自转、随音乐呼吸 →
// 散开飞入下一片云，十二座循环。拖拽环绕旋转、滚轮推拉缩放、双击复位。
//
// 图层（由远及近）：天空渐变穹顶 → 星场/星云/星光点缀 → 造型低多边形形象图
// （柔光 + 半透明面片 + 网格边）→ 主粒子池 → 星座连线与星点。形象图与骨架
// 和粒子共用同一套归一化坐标，三者永远对齐。
//
// 立面：
//   probe() / mount(canvas, {quality,reduced,palette,interactive}) / unmount()
//   resize(w,h) / setTime({time,playing}) / setAudio({bands,onset})
//   setPrefs({field,interact,glow,speed,reduced,palette})
//   setRig(pose, opts)              orbit: {yaw,pitch,dist,fov,tx,ty,tz};
//                                   free: {position:[x,y,z],yaw,pitch,roll,fov}
//                                   external:true skips damping; null releases
//   setInteraction(boolean)         local pointer ownership
//   stats() / debug() / capture() / pure

import * as THREE from 'three';
import { clamp, aggregateBands, envelopeBands, damp } from './util.js';
import {
  ZODIAC, SIGN_COUNT, GATHER_SECONDS, HOLD_SECONDS, DISPERSE_SECONDS, CYCLE_SECONDS,
  timelineAt, transitionStyle, viewBass, zoomClamp, buildShape, buildCloud, buildSeeds,
  buildFigureMesh, buildConstellation, CONSTELLATION, delaunay2, buildRibbon,
  shapeFit, FIG_HALF, FIG_HALF_W, FIG_ASPECT, FIGURE_DEPTH, SHAPE_BOX, SHAPE_BOX_V,
  SHAPE_BOX_Z, CONSTELLATION_Z, FIGURE_Z, FIGURE_MESH_POINTS,
  LINE_CORE_WIDTH, LINE_HALO_WIDTH, EDGE_CORE_WIDTH, EDGE_HALO_WIDTH,
} from './zodiac.js';
import { createWorld } from './world.js';

const QUALITY = {
  low: { prCap: 1.0, budget: 1900000 },
  medium: { prCap: 1.15, budget: 3600000 },
  high: { prCap: 1.55, budget: 6200000 },
};
const BIN_COUNT = 24;
const PAUSE_RENDER_MS = 250;
// 兜底清屏色（天空穹顶盖满时看不到）：取天空最暗那一段的值，不留黑边。
const BG_COLOR = '#030405';
// 机位距离不再是个常数：设计框是「半宽 FIG_HALF*FIG_ASPECT、半高 FIG_HALF」的
// 1.78 矩形，机位要按**舞台自己的宽高比**退到刚好装下它（再多留 8% 边距）。
// 写死距离的话，窄窗口会从左右切掉横宽的星座（巨蟹画到 8.7 宽，1.33 的画框只有
// ±3.6 可见）—— 而舞台比例随窗口变，这是唯一不重建几何就能自适应的地方。
// 边距不是装饰：投影里还有三份「看不见的放大」—— 造型微摆把 x 甩到 z 上
// 更靠近机位（+2.7%）、深度 0.45 与连线深度 0.5 的透视（+8%）、采样点比 fit
// 样本更极端（+2%）。1.08 的量出来有座次溢出 27%，1.30 的最坏值才落到 0.96，
// 横宽的星座仍占满 91~96% 的画面宽度。
const FRAME_MARGIN = 1.30;
const FOV_BASE = 52;
const DIST_MIN = 2.6;
const DIST_MAX = 18;
const ZOOM_MIN = 0.42;
const ZOOM_MAX = 2.4;

function fitDistance(aspect) {
  const tan = Math.tan((FOV_BASE * Math.PI / 180) / 2);
  const a = aspect > 0.01 ? aspect : FIG_ASPECT;
  return Math.max(
    (FIG_HALF * FRAME_MARGIN) / tan,
    (FIG_HALF_W * FRAME_MARGIN) / (tan * a),
  );
}

function orbitDistance(rig) {
  // Portrait framing can require more than the desktop distance ceiling.
  return clamp(rig.distFit * rig.zoom, DIST_MIN, Math.max(DIST_MAX, rig.distFit * ZOOM_MAX));
}
const PITCH_LIMIT = 0.75;
const CAMERA_DRIFT = 0.035;  // 机位极慢漂移（rad/s），与造型微摆错开速度产生视差

export function probe() {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext && canvas.getContext('webgl2'));
  } catch (_) {
    return false;
  }
}

let st = null;

function createStage(canvas, opts = {}, context = null) {
  const quality = QUALITY[opts.quality] ? opts.quality : 'high';
  let renderer = context && context.renderer;
  try {
    if (!renderer) renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (_) {
    return false;
  }
  if (!renderer.getContext()) return false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // 自定义着色器不走 three 的色调映射（要 #include 才生效），天空/粒子/连线的
  // 颜色都是「写什么显示什么」；把色调映射关掉，内置材质（网格/丝带/网格边）
  // 才和它们落在同一条色彩管线上，调色时不必两套换算。
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.info.autoReset = false;

  const scene = context ? context.scene : new THREE.Scene();
  scene.background = new THREE.Color(BG_COLOR);
  const camera = context ? context.camera : new THREE.PerspectiveCamera(FOV_BASE, 1, 0.1, 400);
  Object.assign(camera, { fov: FOV_BASE, near: 0.1, far: 400 });
  camera.position.set(0, 0, fitDistance(FIG_ASPECT));
  const cameraTarget = camera.clone();

  const prefs = {
    field: true, interactive: opts.interactive !== false,
    glow: 1, speed: 1, reactivity: 1, pointerStrength: 1,
    reduced: !!opts.reduced, meteors: clamp(Number(opts.meteors ?? 1), 0, 1.5),
    palette: opts.palette || {},
  };
  const world = createWorld(THREE, scene, { quality: context ? 'high' : quality, scope: context && context.scope,
    meteors: prefs.meteors, onEvent: opts.onEvent });
  if (context) context.scope.defer(() => world.dispose());
  world.setPalette(prefs.palette);
  const audio = {
    raw: null, levels: null, onset: false,
    bins: new Float32Array(BIN_COUNT), target: new Float32Array(BIN_COUNT),
    bass: 0, onsetLevel: 0,
  };

  // 相机在造型球外轨道：drift 极慢漂移 + 拖拽 yaw/pitch + 滚轮缩放，双击复位。
  // 「装下设计框」的距离由舞台宽高比算出（见 fitDistance），用户缩放是在它之上
  // 乘一个倍率 —— 窗口比例变化时用户的那点缩放不会被重置。
  const rig = {
    drift: 0, yaw: 0, pitch: 0.06, zoom: 1, distFit: fitDistance(FIG_ASPECT),
    dist: fitDistance(FIG_ASPECT), dragging: false, fov: FOV_BASE,
    spinYaw: 0, spinPitch: 0, roll: 0,
  };

  function updateDist() {
    rig.dist = orbitDistance(rig);
  }

  // 独立舞台（stage3d）没有 Space3D 的 frame.pointer，指针所有权在引擎自己手里。
  // 这里维护一份与宿主同形的 localPointer：x/y 为 NDC、active/down/dragging/click
  // 供 world 的悬停形变、蓄能与点击冲击使用；双指用 Map 算捏合缩放。
  const localPointer = { x: 0, y: 0, active: false, down: false, dragging: false, click: null };
  const touchPoints = new Map();
  let localSerial = 0, lastClickAt = 0, downX = 0, downY = 0, downAt = 0, pinchDistance = 0;

  function pointerNdc(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      y: 1 - ((e.clientY - rect.top) / Math.max(1, rect.height)) * 2,
    };
  }

  function onPointerDown(e) {
    if (!prefs.interactive) return;
    const p = pointerNdc(e);
    localPointer.x = p.x; localPointer.y = p.y; localPointer.active = true;
    touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPoints.size > 1) {
      // 第二根手指落下：取消拖拽/点击，改走捏合缩放。
      const [a, b] = Array.from(touchPoints.values());
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      localPointer.down = false;
      localPointer.dragging = true;
      rig.dragging = false;
      return;
    }
    localPointer.down = true;
    localPointer.dragging = false;
    downX = e.clientX; downY = e.clientY; downAt = performance.now();
    rig.dragging = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* 无捕获也能拖 */ }
  }
  function onPointerMove(e) {
    if (!prefs.interactive) return;
    const p = pointerNdc(e);
    localPointer.x = p.x; localPointer.y = p.y; localPointer.active = true;
    if (touchPoints.has(e.pointerId)) touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPoints.size > 1) {
      const [a, b] = Array.from(touchPoints.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance > 4) {
        rig.zoom = zoomClamp(rig.zoom * (pinchDistance / distance), ZOOM_MIN, ZOOM_MAX);
        updateDist();
      }
      pinchDistance = distance;
      return;
    }
    if (!rig.dragging || !(e.buttons & 1)) return;
    rig.yaw -= e.movementX * 0.008;
    rig.pitch = clamp(rig.pitch + e.movementY * 0.006, -PITCH_LIMIT, PITCH_LIMIT);
    // 拖拽惯性：松手后沿用最后一小段角速度，转场不再「说停就停」。
    rig.spinYaw = -e.movementX * 0.0009;
    rig.spinPitch = e.movementY * 0.0007;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) localPointer.dragging = true;
  }
  function onPointerUp(e) {
    if (e && touchPoints.has(e.pointerId)) touchPoints.delete(e.pointerId);
    if (touchPoints.size < 2) pinchDistance = 0;
    const wasDown = localPointer.down;
    const wasDragging = localPointer.dragging;
    localPointer.down = false;
    localPointer.dragging = false;
    if (wasDown && !wasDragging && performance.now() - downAt > 30) {
      // 双击复位会先落两次 click；250ms 内只发一次粒子冲击（与 Space3D 同规则）。
      const now = performance.now();
      if (now - lastClickAt > 250) {
        lastClickAt = now;
        localPointer.click = { x: localPointer.x, y: localPointer.y, serial: ++localSerial };
      }
    }
    rig.dragging = false;
  }
  function onPointerLeave() {
    localPointer.active = false;
    localPointer.down = false;
    localPointer.dragging = false;
    rig.dragging = false;
    touchPoints.clear();
    pinchDistance = 0;
  }
  function onWheel(e) {
    if (!prefs.interactive) return;
    e.preventDefault();
    rig.zoom = zoomClamp(rig.zoom * (1 + e.deltaY * 0.001), ZOOM_MIN, ZOOM_MAX);
    updateDist();
  }
  function onDouble() {
    if (!prefs.interactive) return;
    rig.yaw = 0; rig.pitch = 0.06; rig.zoom = 1;
    rig.spinYaw = 0; rig.spinPitch = 0;
    updateDist();
  }
  function bindInput() {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDouble);
    canvas.style.touchAction = prefs.interactive ? 'none' : '';
  }
  function unbindInput() {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('dblclick', onDouble);
    canvas.style.touchAction = '';
    touchPoints.clear();
  }

  const stage = {
    canvas, renderer, scene, camera, cameraTarget, control: null, world, quality, prefs, audio, rig,
    raf: 0, lastFrame: 0, lastRender: 0, lastTime: -1,
    time: 0, sceneTime: 0, playing: false, dirty: true,
    width: 0, height: 0, pr: 1, pointer: null, localPointer, charge: 0,
    timeline: { index: -1, state: 'gather', t: 0 },
    warmed: !!context,
    bindInput, unbindInput,
  };
  return stage;
}

export function mount(canvas, opts = {}) {
  if (st) unmount();
  st = createStage(canvas, opts);
  if (!st) return false;
  st.bindInput();
  st.raf = requestAnimationFrame(tick);
  return true;
}

// 预热：把 12 座的全部 attribute 缓冲与着色器程序都上传一次（一次性 12 帧），
// 之后换座只换对象引用、不再申请 GPU 资源 —— stats() 里的 geometries/textures
// 才是有意义的「无泄漏」判据，而不是每次换座都往上跳的数字。
function warmup(st) {
  const keep = st.timeline.index >= 0 ? st.timeline.index : 0;
  for (let i = 0; i < SIGN_COUNT; i += 1) {
    st.world.setSign(i);
    st.renderer.render(st.scene, st.camera);
  }
  st.world.setSign(keep);
  st.renderer.info.reset();
}

export function unmount() {
  if (!st) return;
  if (st.raf) cancelAnimationFrame(st.raf);
  st.raf = 0;
  try { st.unbindInput(); } catch (_) { /* 尽力释放 */ }
  try { st.world.dispose(); } catch (_) { /* 尽力释放 */ }
  try { st.renderer.dispose(); st.renderer.forceContextLoss(); } catch (_) { /* 尽力释放 */ }
  st = null;
}

function computeDpr(width, height, quality) {
  const q = QUALITY[quality];
  const dev = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const budgetCap = Math.sqrt(q.budget / Math.max(1, width * height));
  let maxSize = Infinity;
  try {
    const gl = st && st.renderer.getContext();
    if (gl) maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
  } catch (_) { /* 探测失败按无上限 */ }
  return Math.min(dev, q.prCap, budgetCap, maxSize / Math.max(width, height));
}

export function resize(width, height) {
  if (!st || !(width > 0) || !(height > 0)) return;
  st.width = width;
  st.height = height;
  st.pr = computeDpr(width, height, st.quality);
  st.renderer.setPixelRatio(st.pr);
  st.renderer.setSize(width, height, false);
  st.camera.aspect = width / height;
  st.camera.updateProjectionMatrix();
  // 舞台一变窄就得往后退：设计框是按 1.78 定的，窄画框会从左右切掉横宽的星座。
  st.rig.distFit = fitDistance(width / height);
  st.rig.dist = orbitDistance(st.rig);
  st.world.setPixelRatio(st.pr);
  st.dirty = true;
}

export function setTime(frame = {}) {
  if (!st) return;
  const time = clamp(Number(frame.time) || 0, 0, 3600 * 4);
  const playing = !!frame.playing;
  if (time !== st.time || playing !== st.playing) st.dirty = true;
  st.time = time;
  st.playing = playing;
}

export function setAudio(frame = {}) {
  if (!st) return;
  st.audio.raw = frame.bands && frame.bands.length ? frame.bands : null;
  st.audio.onset = !!frame.onset;
}

export function setPrefs(patch = {}) {
  if (!st) return;
  if (typeof patch.field === 'boolean') {
    st.prefs.field = patch.field;
    st.world.setFieldVisible(st.prefs.field);
  }
  if (typeof patch.interactive === 'boolean') {
    setInteraction(patch.interactive);
  }
  if (patch.glow != null) st.prefs.glow = clamp(Number(patch.glow), 0, 2);
  if (patch.speed != null) st.prefs.speed = clamp(Number(patch.speed), 0.15, 3);
  if (patch.reactivity != null) st.prefs.reactivity = clamp(Number(patch.reactivity), 0, 2);
  if (patch.pointerStrength != null) st.prefs.pointerStrength = clamp(Number(patch.pointerStrength), 0, 2);
  if (patch.reduced != null) st.prefs.reduced = !!patch.reduced;
  if (patch.meteors != null) {
    st.prefs.meteors = clamp(Number(patch.meteors), 0, 1.5);
    st.world.setMeteors(st.prefs.meteors);
  }
  if (patch.palette) {
    st.prefs.palette = patch.palette;
    st.world.setPalette(st.prefs.palette);
  }
  st.dirty = true;
}

export function setInteraction(value) {
  if (!st) return;
  st.prefs.interactive = !!value;
  if (!value) {
    st.rig.dragging = false;
    st.rig.spinYaw = 0;
    st.rig.spinPitch = 0;
    st.localPointer.active = false;
    st.localPointer.down = false;
    st.localPointer.dragging = false;
    st.localPointer.click = null;
  }
  st.canvas.style.touchAction = value ? 'none' : '';
}

// Angles are radians, FOV is degrees. Free poses use the same YXZ camera Euler
// convention as SpaceCamera: yaw=0 faces -Z and positive pitch looks upward.
// Local drift/input stay intact while a supplied camera owns the rendered pose.
export function setRig(pose, opts) {
  if (!st) return;
  if (pose == null) {
    st.control = null;
    st.dirty = true;
    return;
  }
  if (typeof pose !== 'object') return;
  const validPosition = Array.isArray(pose.position) && pose.position.length === 3
    && pose.position.every(Number.isFinite);
  // An invalid free position must never silently turn into an orbit request.
  if (pose.position !== undefined && !validPosition) return;
  const previous = st.control || { yaw: st.rig.drift + st.rig.yaw, pitch: st.rig.pitch,
    dist: st.rig.dist, fov: st.camera.fov, tx: 0, ty: 0, tz: 0, roll: 0 };
  const next = { ...previous, position: validPosition ? pose.position.slice() : null,
    external: !!(opts && opts.external !== undefined ? opts.external : pose.external) };
  for (const key of ['yaw', 'pitch', 'dist', 'fov', 'tx', 'ty', 'tz', 'roll']) {
    if (Number.isFinite(pose[key])) next[key] = pose[key];
  }
  next.pitch = clamp(next.pitch, -Math.PI * 0.49, Math.PI * 0.49);
  next.dist = zoomClamp(next.dist, DIST_MIN, DIST_MAX);
  next.fov = clamp(next.fov, 26, 72);
  const target = st.cameraTarget;
  if (next.position) {
    target.position.fromArray(next.position);
    target.rotation.set(next.pitch, next.yaw, next.roll, 'YXZ');
  } else {
    const cp = Math.cos(next.pitch);
    target.position.set(next.tx + Math.sin(next.yaw) * cp * next.dist,
      next.ty + Math.sin(next.pitch) * next.dist,
      next.tz + Math.cos(next.yaw) * cp * next.dist);
    target.lookAt(next.tx, next.ty, next.tz);
  }
  target.fov = next.fov;
  st.control = next;
  st.rig.dragging = false;
  st.dirty = true;
}

function tick(now) {
  if (!st) return;
  st.raf = requestAnimationFrame(tick);
  if (!st.playing && !st.dirty && now - st.lastRender < PAUSE_RENDER_MS) return;
  updateStage(st, now);
  st.renderer.info.reset();
  st.renderer.render(st.scene, st.camera);
}

function updateStage(st, now, suppliedDt, suppliedUiDt) {
  const dt = suppliedDt === undefined ? st.lastFrame ? Math.min((now - st.lastFrame) / 1000, st.playing ? 0.1 : 0.25) : 0.016 : suppliedDt;
  const uiDt = suppliedUiDt === undefined ? dt : suppliedUiDt;
  st.lastFrame = now;
  const prefs = st.prefs;
  const time = st.time;
  const seek = st.lastTime < 0 || Math.abs(time - st.lastTime) > 0.5;
  st.lastTime = time;
  // 首帧拿到真实尺寸后再预热：否则按 1×1 上传的缓冲后面还要重传一遍。
  if (!st.warmed && st.width > 0) {
    st.warmed = true;
    warmup(st);
  }

  // 频带包络：seek 落位，否则快攻慢放；暂停时目标归零。
  const target = aggregateBands(st.playing ? st.audio.raw : null, BIN_COUNT, st.audio.target);
  if (st.playing && !st.audio.raw && st.audio.levels) {
    for (let i = 0; i < BIN_COUNT; i++) {
      target[i] = clamp(Number(st.audio.levels[i < 8 ? 'bass' : i < 17 ? 'mid' : 'treble']) || 0);
    }
  }
  if (seek) st.audio.bins.set(target);
  else envelopeBands(st.audio.bins, target, dt);
  const bassTarget = viewBass(st.audio.bins);
  if (seek || !st.playing) st.audio.bass = seek ? bassTarget : damp(st.audio.bass, 0, 0.3, dt);
  else st.audio.bass = damp(st.audio.bass, bassTarget, 0.1, dt);
  const onsetEnv = st.playing && st.audio.onset ? 1 : 0;
  st.audio.onsetLevel = seek ? onsetEnv
    : damp(st.audio.onsetLevel || 0, onsetEnv, onsetEnv ? 0.05 : 0.22, dt);
  let mid = 0, treble = 0;
  for (let i = 8; i < 17; i++) mid += st.audio.bins[i];
  for (let i = 17; i < BIN_COUNT; i++) treble += st.audio.bins[i];
  const response = prefs.reactivity ?? 1;
  const bass = st.audio.bass * response, onset = st.audio.onsetLevel * response;

  if (!prefs.reduced || seek) st.sceneTime = time;
  const tl = prefs.sign >= 0
    ? { index: prefs.sign, state: 'hold', t: HOLD_SECONDS * .5, cycle: 0 }
    : timelineAt(st.sceneTime);
  st.timeline = tl;
  st.world.setSign(tl.index);
  const k = tl.state === 'gather' ? clamp(tl.t / GATHER_SECONDS)
    : tl.state === 'disperse' ? clamp(tl.t / DISPERSE_SECONDS) : 1;

  // 指针所有权：Space3D 会每帧提供 frame.pointer；独立舞台没有宿主指针，
  // 用引擎自己 canvas 上采到的 localPointer。两边同形，world 无需分支。
  const pointer = st.pointer || st.localPointer;
  const pointerActive = !!(pointer && pointer.active && !pointer.dragging && !prefs.reduced);
  const charging = !!(pointerActive && pointer.down);
  st.charge = prefs.reduced ? 0
    : charging ? Math.min(1, st.charge + dt / .85) : Math.max(0, st.charge - dt * 7);

  const rig = st.rig;
  const camera = st.camera;
  let cameraMoving = false;
  if (st.control) {
    const target = st.cameraTarget;
    const mix = st.control.external ? 1 : 1 - Math.exp(-dt / 0.26);
    camera.position.lerp(target.position, mix);
    camera.quaternion.slerp(target.quaternion, mix);
    camera.fov += (target.fov - camera.fov) * mix;
    camera.updateProjectionMatrix();
    cameraMoving = camera.position.distanceToSquared(target.position) > 1e-8
      || camera.quaternion.angleTo(target.quaternion) > 0.0001
      || Math.abs(camera.fov - target.fov) > 0.0001;
  } else {
    // 相机：极慢漂移 + 拖拽偏移；造型本身也在自转，两层速度错开有视差。
    // 松手后保留一小段角速度（惯性），拖拽的余韵比「说停就停」更像游戏镜头。
    if (!rig.dragging) {
      rig.yaw += rig.spinYaw * dt * 60;
      rig.pitch = clamp(rig.pitch + rig.spinPitch * dt * 60, -PITCH_LIMIT, PITCH_LIMIT);
      rig.spinYaw = damp(rig.spinYaw, 0, .22, dt);
      rig.spinPitch = damp(rig.spinPitch, 0, .22, dt);
    }
    rig.drift += dt * CAMERA_DRIFT * (prefs.reduced ? 0.3 : 1) * prefs.speed
      + dt * bass * 0.04 * (prefs.reduced ? 0.3 : 1);
    const effYaw = rig.drift + rig.yaw;
    const cp = Math.cos(rig.pitch);
    camera.position.set(
      Math.sin(effYaw) * cp * rig.dist,
      Math.sin(rig.pitch) * rig.dist,
      Math.cos(effYaw) * cp * rig.dist,
    );
    camera.lookAt(0, 0, 0);
    // 指针在屏幕左右移动时给一点极轻的滚转，像手持镜头跟着视线倾斜。
    const rollTarget = pointerActive && pointer ? clamp(pointer.x, -1, 1) * .018 : 0;
    rig.roll = prefs.reduced ? 0 : damp(rig.roll, rollTarget, .22, dt);
    if (Math.abs(rig.roll) > 1e-5) camera.rotateZ(rig.roll);
    // 蓄能时轻微推近（FOV 收窄）+ 低频 FOV 呼吸，松开瞬间由冲击波接棒。
    const fovTarget = FOV_BASE + bass * 1.6 + st.charge * 2.4;
    rig.fov = seek ? fovTarget : damp(rig.fov, fovTarget, 0.32, dt);
    if (Math.abs(camera.fov - rig.fov) > 0.001) {
      camera.fov = rig.fov;
      camera.updateProjectionMatrix();
    }
  }

  st.world.update(st.sceneTime, {
    bass, mid: mid / 9 * response, treble: treble / (BIN_COUNT - 17) * response,
    onset, cycle: tl.cycle, pointerStrength: prefs.pointerStrength,
    reduced: prefs.reduced, glow: prefs.glow, dt, uiDt,
    state: tl.state, k, cameraPos: camera.position, camera,
    pointer, width: st.width, height: st.height, now,
  });

  st.dirty = cameraMoving || rig.dragging
    || Math.abs(rig.spinYaw) > 1e-5 || Math.abs(rig.spinPitch) > 1e-5
    || Math.abs(rig.roll) > 1e-4 || st.charge > 1e-3;
  st.lastRender = now;
}

export function createScene(context) {
  const stage = createStage(context.renderer.domElement, {
    quality: context.quality.mode, interactive: false, meteors: context.params.meteors,
    onEvent: event => { if (context.services && typeof context.services.zodiacEvent === 'function') context.services.zodiacEvent(event); },
  }, context);
  if (!stage) throw new Error('Zodiac world initialization failed');
  let reduced = !!context.params.reduced;
  function motion(frame) {
    const elapsed = stage.timeline.state === 'gather' ? clamp(stage.timeline.t / GATHER_SECONDS)
      : stage.timeline.state === 'disperse' ? clamp(stage.timeline.t / DISPERSE_SECONDS) : 1;
    return { ...stage.timeline, morph: elapsed };
  }
  return {
    update(frame) {
      stage.prefs.reduced = reduced || !!frame.reduced;
      const frozen = stage.prefs.reduced || frame.playing === false;
      if (!frozen) stage.time = Number(frame.sceneTime ?? frame.time) || 0;
      stage.playing = !!frame.playing;
      stage.pointer = frame.pointer || null;
      stage.audio.raw = frame.spectrum && frame.spectrum.length ? frame.spectrum
        : frame.bands && (Array.isArray(frame.bands) || ArrayBuffer.isView(frame.bands)) ? frame.bands : null;
      stage.audio.levels = frame.bands && !stage.audio.raw ? frame.bands : null;
      stage.audio.onset = !frozen && !!frame.onset;
      const dt = frozen ? 0 : Math.max(0, Math.min(frame.dynamicDt ?? frame.dt ?? .016, .1));
      const uiDt = Math.max(0, Math.min(frame.dt ?? .016, .1));
      updateStage(stage, Number(frame.now) || 0, dt, uiDt);
    },
    resize(width, height) {
      stage.width = width; stage.height = height;
      stage.camera.aspect = width / height; stage.camera.updateProjectionMatrix();
      stage.rig.distFit = fitDistance(width / height); stage.rig.dist = orbitDistance(stage.rig);
      stage.world.setPixelRatio(stage.renderer.getPixelRatio());
    },
    setParams(params) {
      stage.prefs.glow = params.glow; stage.prefs.speed = params.speed; reduced = !!params.reduced; stage.prefs.reduced = reduced;
      stage.prefs.reactivity = clamp(Number(params.reactivity ?? 1), 0, 2);
      stage.prefs.pointerStrength = clamp(Number(params.pointerStrength ?? 1), 0, 2);
      stage.prefs.meteors = clamp(Number(params.meteors ?? 1), 0, 1.5);
      stage.prefs.sign = params.sign === 'cycle' ? -1 : ZODIAC.findIndex(sign => sign.id === params.sign);
      stage.world.setFieldVisible(params.field);
      stage.world.setMeteors(stage.prefs.meteors);
    },
    setQuality(profile) { stage.world.setQuality(profile.mode); stage.world.setPixelRatio(stage.renderer.getPixelRatio()); },
    setRig(pose) {
      stage.control = pose;
      if (!pose) return;
      const target = stage.cameraTarget;
      if (pose.position) { target.position.fromArray(pose.position); target.rotation.set(pose.pitch, pose.yaw, pose.roll || 0, 'YXZ'); }
      else { const cp = Math.cos(pose.pitch); target.position.set(pose.tx + Math.sin(pose.yaw) * cp * pose.dist, pose.ty + Math.sin(pose.pitch) * pose.dist, pose.tz + Math.cos(pose.yaw) * cp * pose.dist); target.lookAt(pose.tx, pose.ty, pose.tz); target.rotateZ(pose.roll || 0); }
      target.fov = pose.fov;
    },
    stats() {
      const tl = motion(stage.timeline);
      return { ...stage.world.stats(), state: tl.state, stateT: tl.t, morph: tl.morph,
        cycleSeconds: CYCLE_SECONDS, time: stage.time, playing: stage.playing,
        yaw: stage.rig.drift + stage.rig.yaw, dist: stage.rig.dist };
    },
    dispose() {},
  };
}

export function stats() {
  if (!st) return null;
  const info = st.renderer.info;
  return {
    mounted: true,
    quality: st.quality,
    drawCalls: info.render.calls,
    points: info.render.points,
    ...st.world.stats(),
    // 真实驻留数（预热后恒定）：契约据此判「换座不重建几何、无泄漏」。
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs ? info.programs.length : 0,
    state: st.timeline.state,
    stateT: st.timeline.t,
    morph: st.timeline.state === 'hold' ? 1
      : st.timeline.state === 'gather' ? clamp(st.timeline.t / GATHER_SECONDS)
        : clamp(st.timeline.t / DISPERSE_SECONDS),
    cycleSeconds: CYCLE_SECONDS,
    bass: st.audio.bass,
    onset: st.audio.onsetLevel,
    yaw: st.rig.drift + st.rig.yaw,
    dist: st.rig.dist,
    distDefault: st.rig.distFit,
    zoom: st.rig.zoom,
    time: st.time,
    playing: st.playing,
    warmed: !!st.warmed,
  };
}

export function debug() {
  if (!st) return null;
  return {
    mounted: true,
    quality: st.quality,
    time: st.time,
    playing: st.playing,
    bass: st.audio.bass,
    fov: st.rig.fov,
    drift: st.rig.drift,
    yaw: st.rig.yaw,
    pitch: st.rig.pitch,
    dist: st.rig.dist,
    distDefault: st.rig.distFit,
    zoom: st.rig.zoom,
    timeline: { ...st.timeline },
    controlled: !!st.control,
    camera: {
      position: st.camera.position.toArray(),
      direction: st.camera.getWorldDirection(new THREE.Vector3()).toArray(),
      quaternion: st.camera.quaternion.toArray(),
      fov: st.camera.fov,
      projection: st.camera.projectionMatrix.toArray(),
    },
    prefs: { ...st.prefs },
  };
}

export function capture() {
  if (!st) return null;
  st.renderer.info.reset();
  st.renderer.render(st.scene, st.camera);
  const gl = st.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const sample = (yFrac) => {
    const y = Math.max(0, Math.min(h - 1, Math.floor(h * yFrac)));
    const row = new Uint8Array(w * 4);
    gl.readPixels(0, y, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < row.length; i += 4) { r += row[i]; g += row[i + 1]; b += row[i + 2]; }
    return [Math.round(r / w), Math.round(g / w), Math.round(b / w)];
  };
  return { top: sample(0.8), middle: sample(0.5), bottom: sample(0.15), width: w, height: h };
}

export const pure = {
  ZODIAC, SIGN_COUNT, GATHER_SECONDS, HOLD_SECONDS: CYCLE_SECONDS - GATHER_SECONDS - DISPERSE_SECONDS,
  DISPERSE_SECONDS, CYCLE_SECONDS, buildShape, buildCloud, buildSeeds, timelineAt, transitionStyle,
  aggregateBands, viewBass, zoomClamp,
  // 形象图与星座骨架：Node 契约直接验证几何，不需要浏览器
  CONSTELLATION, buildFigureMesh, buildConstellation, buildRibbon, delaunay2, shapeFit,
  FIG_HALF, FIG_HALF_W, FIG_ASPECT, FIGURE_DEPTH, SHAPE_BOX, SHAPE_BOX_V, SHAPE_BOX_Z,
  CONSTELLATION_Z, FIGURE_Z, FIGURE_MESH_POINTS,
  LINE_CORE_WIDTH, LINE_HALO_WIDTH, EDGE_CORE_WIDTH, EDGE_HALO_WIDTH,
};
