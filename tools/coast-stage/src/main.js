// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 「纯真3D」海岸公路舞台场景引擎。纯场景层：不感知 hertz-studio 的任何全局，
// 由 plugin/ui/stage-coast.js 适配层驱动。场景装配与光照移植自 pelican-bike
// （claude-demo）src/main.js，裁掉骑手/玩法/调试面板，加上舞台化改动：
//   - 相机 = 沿公路自动巡航 + 拖拽环绕/滚轮推拉/双击复位，静置回归巡航；
//   - 时刻固定可调（黄昏→夜→黎明），不自动流动；
//   - setAudio({level,bands,onset}) 驱动浪高、巡航速度、海面碎光与天空亮度；
//   - unmount() 完整释放 GL 资源（舞台与创意舞台互斥切换，不允许泄漏上下文）。
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createSky, SKY, samplePalette, sunDirection, moonDirection, nightFactor } from './sky.js';
import { createOcean, wavePhases, SEA_LEVEL } from './ocean.js';
import { createWorld, terrainHeight, prepareGridLod } from './world.js';
import { clamp, lerp, damp, smoothstep } from './util.js';
import { createScope } from '../../space-stage/src/scope.js';
import { createRenderContext } from '../../space-stage/src/render-context.js';
export { resourcePlan } from './resource-plan.js';

// 画质三档对应舞台 tier 2/1/0。pr 上限沿用原作的按 DPR 折算。
const QUALITY = {
  low: { prCap: 1, prMul: 0.8, shadow: 0, bloom: false, msaa: 0, density: 0.5 },
  medium: { prCap: 1.25, prMul: 1, shadow: 1024, bloom: true, msaa: 2, density: 0.8 },
  high: { prCap: 1.75, prMul: 1, shadow: 2048, bloom: true, msaa: 4, density: 1 },
};

const DPR = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
const SHORE_GUARD = -13;
// 滑杆 0..1（黄昏→午夜→黎明）映射到小时角；18 点太阳落在前方海上。
const hourFromTod = (v) => (18 + 12.2 * clamp(v, 0, 1)) % 24;

// 泛光前清理 NaN/Inf：一个坏像素会被 Bloom 的多级模糊扩散成大块黑矩形。
const sanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    float fixf(float x) {
      uint b = floatBitsToUint(x);
      if ((b & 0x7f800000u) == 0x7f800000u) return ((b & 0x007fffffu) == 0u && (b & 0x80000000u) == 0u) ? 48.0 : 0.0;
      return clamp(x, 0.0, 48.0);
    }
    void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; gl_FragColor = vec4(fixf(c.r), fixf(c.g), fixf(c.b), 1.0); }`,
};

let st = null; // 当前舞台实例；同一时刻只允许一份

function disposeObject(root) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) {
      for (const key of Object.keys(m)) {
        const v = m[key];
        if (v && v.isTexture) v.dispose();
      }
      m.dispose();
    }
  });
}

function createStage(canvas, opts, context = null) {
  const shared = context && !context.standalone;
  let quality = QUALITY[opts.quality] || QUALITY.high;
  let renderer = context && context.renderer;
  try {
    if (!renderer) renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  } catch (e) {
    return null;
  }
  const pr = Math.min(DPR, quality.prCap) * quality.prMul;
  if (!context) renderer.setPixelRatio(pr);
  renderer.shadowMap.enabled = !shared && quality.shadow > 0;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;

  const scene = context ? context.scene : new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xffffff, 0.0052);
  const camera = context ? context.camera : new THREE.PerspectiveCamera(44, 1, 0.05, 900);
  Object.assign(camera, { fov: 44, near: 0.05, far: 900 });
  const cameraTarget = camera.clone();
  scene.add(camera);

  const sky = createSky(context?.scope);
  if (context) { context.scope.trackTree(sky.mesh); context.scope.trackTree(sky.envMesh); }
  scene.add(sky.mesh);
  const pmrem = new THREE.PMREMGenerator(renderer);
  if (context) context.scope.track(pmrem);
  const envScene = new THREE.Scene();
  envScene.add(sky.envMesh);
  let envRT = null;
  let envTicket = null, pmremTicket = null;
  let envHour = -99;
  function refreshEnv() {
    const scope = context?.scope;
    // r186 fromScene(size256): 768x1024 RGBA16F output + depth24,
    // one RGBA16F ping-pong target and eleven 36-vertex LOD planes.
    if (scope && !pmremTicket) pmremTicket = scope.reserve({
      renderTargetDeclaredBytes: 768 * 1024 * 8,
      ownedCpuBytes: 11 * 36 * 6 * 4 + (24 * 8 * 4 + 36 * 2) + (24 * 8 + 36 + 30) * 8
    }, 'Coast PMREM r186 size256 ping-pong and fixed plane/background source arrays', 'bounded-estimate');
    const ticket = scope?.reserve({ renderTargetDeclaredBytes: 768 * 1024 * 12 },
      'Coast PMREM r186 size256 RGBA16F plus depth output; old/new replacement');
    let rt;
    // Keep each newly created result reachable even if a shader/upload fails
    // before fromScene returns. The pinned original owner still creates it.
    const allocate = pmrem._allocateTargets;
    if (scope) pmrem._allocateTargets = function () { return scope.track(allocate.call(this)); };
    try { rt = pmrem.fromScene(envScene, 0, 0.1, 100); }
    finally { pmrem._allocateTargets = allocate; }
    ticket?.commit(); pmremTicket?.commit();
    if (envRT) { if (context) context.scope.release(envRT); else envRT.dispose(); }
    scope?.releaseReservation(envTicket); envTicket = ticket;
    envRT = rt;
    if (context) context.scope.track(rt);
    scene.environment = rt.texture;
  }

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  if (quality.shadow > 0) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(quality.shadow, quality.shadow);
    const s = 7.5;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 80 });
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.025;
    sun.shadow.radius = 2.5;
  }
  scene.add(sun, sun.target);
  const lampLights = [new THREE.PointLight('#ffc27a', 0, 14, 1.6), new THREE.PointLight('#ffc27a', 0, 14, 1.6)];
  lampLights.forEach((l) => scene.add(l));
  const lampPos = [new THREE.Vector3(), new THREE.Vector3()];
  const fillLight = new THREE.PointLight('#b9c8ff', 0, 10, 1.2);
  fillLight.position.set(0.6, 0.8, 0.5);
  camera.add(fillLight);

  const ocean = createOcean(context?.scope);
  if (context) prepareGridLod(ocean.mesh.geometry, ocean.columns, ocean.rows, context.scope);
  if (context) context.scope.trackTree(ocean.mesh);
  scene.add(ocean.mesh);
  let world;
  try { world = createWorld(scene, { density: shared ? 1 : quality.density, scope: context?.scope }); }
  catch (error) { context?.scope.trackTree(scene); throw error; }
  if (context) context.scope.trackTree(scene);

  // 后期：渲染 -> 清洗 -> 泛光 -> 输出。暖色分级交给调色板与雾，不再叠 grade。
  const size2 = renderer.getDrawingBufferSize(new THREE.Vector2());
  let postTicket = null, shadowTicket = null;
  function postBytes(w, h) {
    let bytes = w * h * 2 * (12 + 12 * quality.msaa);
    let x = Math.max(1, Math.round(w / 2)), y = Math.max(1, Math.round(h / 2));
    bytes += x * y * 8;
    for (let i = 0; i < 5; i++) { bytes += x * y * 16; x = Math.max(1, Math.round(x / 2)); y = Math.max(1, Math.round(y / 2)); }
    return bytes;
  }
  if (context && !shared) {
    postTicket = context.scope.reserve({ renderTargetDeclaredBytes: postBytes(size2.x, size2.y) },
      'Coast composer two RGBA16F/depth targets with MSAA/resolve and bloom bright plus ten RGBA16F mips', 'bounded-estimate');
    shadowTicket = quality.shadow ? context.scope.reserve({ renderTargetDeclaredBytes: quality.shadow * quality.shadow * 8 },
      'Coast original PCF directional shadow RGBA8 and depth24 storage', 'bounded-estimate') : null;
    context.scope.reserve({ ownedCpuBytes: (6 + 10 + 14 + 18 + 22) * 2 * 8 + 5 * 3 * 8 },
      'Coast r186 bloom five Gaussian kernels offsets/weights and tint vectors')?.commit();
  }
  const rt = shared ? null : new THREE.WebGLRenderTarget(size2.x, size2.y, { type: THREE.HalfFloatType, samples: quality.msaa });
  if (context && rt) context.scope.track(rt);
  const composer = shared ? null : new EffectComposer(renderer, rt);
  if (context && composer) context.scope.track(composer);
  const bloom = shared ? { enabled: false } : new UnrealBloomPass(new THREE.Vector2(2, 2), 0.4, 0.55, 0.92);
  if (composer) {
    composer.setPixelRatio(context ? 1 : pr);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new ShaderPass(sanitizeShader));
    bloom.enabled = quality.bloom;
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    if (context) composer.passes.forEach(pass => { if (pass.dispose) context.scope.track(pass); });
  }
  if (context) { context.scope.trackTree(scene); context.scope.trackTree(envScene); }

  // ---------- 状态 ----------
  const S = {
    t: 0,
    distance: 0,
    speed: 0,
    lane: 0.9,
    laneV: 0,
    laneTarget: 0.9,
    tod: 0,
    hour: hourFromTod(opts.tod || 0),
    reduced: !!opts.reduced,
    interactive: opts.interactive !== false,
  };
  const env = { night: 0, waveAmp: 1 };
  const audio = { target: 0, level: 0, slow: 0, bass: 0, onset: false };
  let onsetEnv = 0;

  // ---------- 巡航相机 ----------
  // 默认机位：路后上方看向行进方向（+x）；拖拽改成绕焦点球面环绕。
  const FOCUS_Y = 1.05;
  const off0 = new THREE.Vector3(-4.4, 1.8, 2.4);
  const rig = {
    yaw0: Math.atan2(off0.x, off0.z),
    pitch0: Math.asin(off0.y / off0.length()),
    dist0: off0.length(),
    yaw: 0,
    pitch: 0,
    dist: 0,
    lastInput: -99,
    dragging: false,
    control: null,
  };
  rig.yaw = rig.yaw0;
  rig.pitch = rig.pitch0;
  rig.dist = rig.dist0;
  const focus = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const camPos = new THREE.Vector3();

  function onPointerDown() {
    if (!S.interactive) return;
    rig.dragging = true;
    rig.lastInput = S.t;
  }
  function onPointerMove(e) {
    if (!S.interactive || !rig.dragging || !(e.buttons & 1)) return;
    rig.yaw = clamp(rig.yaw - e.movementX * 0.005, rig.yaw0 - 2.6, rig.yaw0 + 2.6);
    rig.pitch = clamp(rig.pitch + e.movementY * 0.004, 0.08, 1.25);
    rig.lastInput = S.t;
  }
  function onPointerUp() {
    rig.dragging = false;
  }
  function onWheel(e) {
    if (!S.interactive) return;
    e.preventDefault();
    rig.dist = clamp(rig.dist * (1 + e.deltaY * 0.001), 2.4, 15);
    rig.lastInput = S.t;
  }
  function onDouble() {
    if (!S.interactive) return;
    rig.yaw = rig.yaw0;
    rig.pitch = rig.pitch0;
    rig.dist = rig.dist0;
    rig.lastInput = S.t;
  }

  function groundAt(p) {
    const wx = p.x + S.distance;
    if (Math.abs(p.z) < 2.9) return 0.02;
    if (p.z < SHORE_GUARD) return Math.max(SEA_LEVEL + 0.4, terrainHeight(wx, p.z));
    return terrainHeight(wx, p.z);
  }

  function cameraUpdate(dt) {
    if (rig.control) {
      const pose = rig.control;
      if (pose.position) cameraTarget.position.fromArray(pose.position);
      else {
        const cp = Math.cos(pose.pitch);
        cameraTarget.position.set(pose.tx + Math.sin(pose.yaw) * cp * pose.dist,
          pose.ty + Math.sin(pose.pitch) * pose.dist,
          pose.tz + Math.cos(pose.yaw) * cp * pose.dist);
      }
      // Moving terrain remains owned by Coast for both orbit and free poses.
      cameraTarget.position.y = Math.max(cameraTarget.position.y, groundAt(cameraTarget.position) + 0.3);
      if (pose.position) cameraTarget.rotation.set(pose.pitch, pose.yaw, pose.roll, 'YXZ');
      else { cameraTarget.lookAt(pose.tx, pose.ty, pose.tz); cameraTarget.rotateZ(pose.roll || 0); }
      const mix = pose.external ? 1 : 1 - Math.exp(-dt / 0.26);
      camera.position.lerp(cameraTarget.position, mix);
      camera.position.y = Math.max(camera.position.y, groundAt(camera.position) + 0.3);
      camera.quaternion.slerp(cameraTarget.quaternion, mix);
      camera.fov += (pose.fov - camera.fov) * mix;
      camera.updateProjectionMatrix();
      return;
    }
    focus.set(0, FOCUS_Y, S.lane);
    // Native Stage3D motion is unchanged while no supplied camera owns the rig.
    if (S.t - rig.lastInput > 4) {
      rig.yaw = damp(rig.yaw, rig.yaw0, 1.2, dt);
      rig.pitch = damp(rig.pitch, rig.pitch0, 1.2, dt);
      rig.dist = damp(rig.dist, rig.dist0, 1.2, dt);
    }
    const cp = Math.cos(rig.pitch);
    camPos.set(
      focus.x + Math.sin(rig.yaw) * cp * rig.dist,
      focus.y + Math.sin(rig.pitch) * rig.dist,
      focus.z + Math.cos(rig.yaw) * cp * rig.dist,
    );
    camPos.y = Math.max(camPos.y, groundAt(camPos) + 0.3);
    lookAt.set(2.2, 0.55, S.lane * 0.4);
    camera.position.copy(camPos);
    camera.lookAt(lookAt);
    camera.fov = 44;
    camera.updateProjectionMatrix();
  }

  // ---------- 光照（移植自原作 updateLighting；时刻固定，不流动） ----------
  const pal = {};
  const sunDir = new THREE.Vector3();
  const moonDir = new THREE.Vector3();
  function updateLighting() {
    const hour = S.hour;
    sunDirection(hour, sunDir);
    moonDirection(hour, moonDir);
    const elev = (Math.asin(clamp(sunDir.y, -1, 1)) * 180) / Math.PI;
    samplePalette(elev, pal);
    const night = nightFactor(elev);
    env.night = night;
    SKY.uSunDir.value.copy(sunDir);
    SKY.uMoonDir.value.copy(moonDir);
    SKY.uZenith.value.copy(pal.zen);
    SKY.uHorizon.value.copy(pal.hor);
    SKY.uGround.value.copy(pal.gnd);
    SKY.uSunColor.value.copy(pal.sun);
    SKY.uSunGlow.value = 1 - night * 0.9;
    SKY.uNight.value = night;
    SKY.uTime.value = S.t;
    SKY.uCloudCover.value = 0.42;
    SKY.uCloudTint.value.copy(pal.ct);
    SKY.uCloudShade.value.copy(pal.cs);
    SKY.uCloudOffset.value.set(S.distance * 0.0009 + S.t * 0.004, S.t * 0.0015);

    const useMoon = elev < -4;
    const lightDir = useMoon ? moonDir : sunDir;
    sun.position.set(0, 0, S.lane).addScaledVector(lightDir, 40);
    sun.target.position.set(0, 0, S.lane);
    if (useMoon) {
      sun.color.set('#9fb6ff');
      sun.intensity = 0.8 * smoothstep(-4, -12, elev) * clamp(moonDir.y * 3, 0, 1);
    } else {
      sun.color.copy(pal.sun);
      sun.intensity = pal.li;
    }
    hemi.color.copy(pal.hs);
    hemi.groundColor.copy(pal.hg);
    hemi.intensity = pal.hi;
    scene.fog.color.copy(pal.fog);
    scene.fog.density = 0.0052;
    ocean.uniforms.uFogDensity.value = 0.0036;
    ocean.uniforms.uDayLight.value = clamp(pal.li / 3 + pal.hi * 0.25, 0.08, 1);
    ocean.uniforms.uOffset.value = S.distance % 36000;
    wavePhases(S.distance, S.t, ocean.uniforms.uPhase.value);
    ocean.uniforms.uAmp.value = env.waveAmp;
    // 音频反应：持续高能量轻微提亮天空（曝光），起音打一下海面碎光（泛光脉冲）
    renderer.toneMappingExposure = pal.exp * (1 + 0.1 * smoothstep(0.4, 0.9, audio.slow));
    scene.environmentIntensity = lerp(1.0, 0.22, night);
    if (quality.bloom) {
      bloom.strength = pal.bloom * (1 + 0.9 * onsetEnv) * lerp(1, 0.7, night);
      bloom.threshold = lerp(1.05, 0.88, night);
    }
    fillLight.intensity = night * 2.2;
    if (Math.abs(hour - envHour) > 0.18 || envHour < 0) {
      envHour = hour;
      refreshEnv();
    }
    world.lampPositions(S.distance, lampPos);
    lampLights.forEach((l, i) => {
      l.position.copy(lampPos[i]);
      l.intensity = smoothstep(0.25, 0.75, night) * 18;
    });
  }

  // ---------- 主循环 ----------
  let raf = 0;
  let last = 0;
  const bufSize = new THREE.Vector2();
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    const dt = last ? Math.min((ts - last) / 1000, 0.05) : 0;
    last = ts;
    update(dt);
    if (dt) composer.render();
  }
  function update(dt, uiDt = dt) {
    if (!dt && !context) return;
    S.t += dt;

    // 音频包络：level 快跟（速度）、slow 慢跟（曝光）、起音脉冲后衰减
    audio.level = damp(audio.level, audio.target, 3.2, dt);
    audio.slow = damp(audio.slow, audio.level, 0.9, dt);
    if (audio.onset) onsetEnv = 1;
    else onsetEnv = damp(onsetEnv, 0, 2.2, dt);
    audio.onset = false;

    // 巡航速度：基速 ±40% 随总能量
    const base = S.reduced ? 3.2 : 6.8;
    const factor = 0.6 + 0.8 * smoothstep(0.05, 0.7, audio.level);
    S.speed = damp(S.speed, base * (S.reduced ? 0.45 : factor), 0.9, dt);
    S.distance += S.speed * dt;
    // 车道漫游（原作自动驾驶去掉追鱼）
    S.laneTarget = 0.9 + Math.sin(S.t * 0.23) * 0.7;
    const k = 10;
    S.laneV += ((S.laneTarget - S.lane) * k - S.laneV * 2 * Math.sqrt(k)) * dt;
    S.lane += S.laneV * dt;

    env.waveAmp = S.reduced ? 0.35 : 0.55 + 0.9 * smoothstep(0.1, 0.75, audio.bass);
    world.update(S.distance, dt, S.t, env);
    updateLighting();
    cameraUpdate(uiDt);
    sky.mesh.position.copy(camera.position);
    renderer.getDrawingBufferSize(bufSize);
    world.ffMat.uniforms.uScale.value = bufSize.y / (2 * Math.tan((camera.fov * Math.PI) / 360));
  }

  function resize(w, h) {
    const width = Math.max(2, w | 0);
    const height = Math.max(2, h | 0);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (!context) renderer.setSize(width, height, false);
    if (composer) {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2());
      const rw = context ? draw.x : width, rh = context ? draw.y : height;
      if (composer.renderTarget1.width !== rw || composer.renderTarget1.height !== rh) {
        const next = context?.scope.reserve({ renderTargetDeclaredBytes: postBytes(rw, rh) },
          'Coast composer old/new resized RGBA16F MSAA/depth and bloom target peak', 'bounded-estimate');
        composer.setSize(rw, rh);
        context?.scope.releaseReservation(postTicket); postTicket = next;
      }
    }
    if (bloom.resolution) bloom.resolution.set(width / 2, height / 2);
  }

  function bind() {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDouble);
    canvas.style.touchAction = S.interactive ? 'none' : '';
  }
  function unbind() {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('dblclick', onDouble);
    canvas.style.touchAction = '';
  }

  return {
    canvas,
    renderer,
    composer,
    quality,
    scene,
    camera,
    S,
    env,
    audio,
    rig,
    resize,
    update,
    setQuality(profile) {
      quality = QUALITY[profile.mode] || QUALITY.medium;
      world.setDensity(profile.density, profile.mode);
      const range = ocean.mesh.geometry.userData.lodRanges[profile.mode];
      ocean.mesh.geometry.setDrawRange(range.start, range.count);
    },
    start() {
      last = 0;
      raf = requestAnimationFrame(loop);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    },
    renderOnce() {
      // 检查用：同步渲一帧（调用方随后可在同一任务内 readPixels）
      world.update(S.distance, 0.016, S.t, env);
      updateLighting();
      cameraUpdate(0.016);
      sky.mesh.position.copy(camera.position);
      if (composer) composer.render();
    },
    render(dt, uiDt = dt, sceneTime) {
      if (Number.isFinite(sceneTime)) S.t = sceneTime - dt;
      update(dt, uiDt);
      renderer.info.reset();
      if (composer) composer.render(dt); else renderer.render(scene, camera);
      postTicket?.commit(); if (sun.shadow.map) shadowTicket?.commit();
    },
    bind,
    unbind,
    dispose() {
      if (context) return;
      disposeObject(scene);
      pmrem.dispose();
      if (envRT) envRT.dispose();
      composer.dispose();
      rt.dispose();
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
    },
  };
}

export function createScene(context) {
  const stage = createStage(context.renderer.domElement, { quality: context.quality.mode, tod: context.params.tod, interactive: false }, context);
  if (!stage) throw new Error('Coast world initialization failed');
  let disposed = false, reduced = !!context.params.reduced;
  return {
    update(frame) {
      stage.S.reduced = reduced || !!frame.reduced;
      stage.audio.target = clamp(frame.level || 0, 0, 1);
      const bands = frame.bands || [];
      let bass = 0; const count = Math.min(8, bands.length);
      for (let i = 0; i < count; i++) bass += bands[i] || 0;
      stage.audio.bass = count ? clamp(bass / count * 1.4, 0, 1) : 0;
      stage.audio.onset = !stage.S.reduced && !!frame.onset;
      const dt = stage.S.reduced || frame.playing === false ? 0 : frame.dynamicDt ?? frame.dt ?? .016;
      stage.update(Math.max(0, Math.min(dt, .1)));
    },
    resize: stage.resize,
    setParams(params) { stage.S.tod = params.tod; stage.S.hour = hourFromTod(params.tod); reduced = !!params.reduced; stage.S.reduced = reduced; },
    setQuality: stage.setQuality,
    setRig(pose) { stage.rig.control = pose; },
    dispose() { if (disposed) return; disposed = true; },
  };
}

// ---------------- 对外接口 ----------------

// 探测当前环境能否起 WebGL2（用于入口置灰），不留持久状态。
export function probe() {
  return typeof WebGL2RenderingContext !== 'undefined';
}

// opts: { quality: 'low'|'medium'|'high', tod: 0..1, interactive: bool, reduced: bool }
// 返回 false 表示 WebGL2 不可用（适配层走降级）。
export function mount(canvas, opts = {}) {
  if (st) unmount();
  if (opts.admissionRequired && !opts.resources) throw new Error('resource-policy-required');
  let context, scope, s;
  try {
    if (opts.resources) {
      scope = createScope({ resources: opts.resources, generation: opts.generation || 0 });
      context = createRenderContext(THREE, canvas, { resources: opts.resources,
        onContextLost() { unmount(); opts.onContextLost?.(); } });
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
      s = createStage(canvas, opts, { renderer: context.renderer, scope, scene, camera, standalone: true });
      s.resources = context; s.scope = scope;
    } else s = createStage(canvas, opts);
    if (!s) return false;
    st = s; s.external = !!opts.external;
    resize(opts.width || canvas.clientWidth || 640, opts.height || canvas.clientHeight || 360);
    s.bind(); if (!s.external) s.start(); return true;
  } catch (error) {
    s?.unbind(); scope?.dispose(); context?.dispose(); st = null; throw error;
  }
}

export function unmount() {
  if (!st) return;
  st.stop();
  st.unbind();
  st.dispose();
  st.scope?.trackTree(st.scene); st.scope?.dispose(); st.resources?.dispose();
  st = null;
}

export function render(now, dynamicDt = 0, uiDt = 0, sceneTime) {
  if (!st || !st.external) return false;
  st.render(Math.max(0, Math.min(dynamicDt, .1)), Math.max(0, Math.min(uiDt, .1)), sceneTime);
  if (st.renderer.info.programs.some(program => program.diagnostics?.runnable === false)) throw new Error('Three shader program failed');
  return true;
}
export function resetInput() { if (st) { st.audio.target = st.audio.level = st.audio.slow = st.audio.bass = 0; st.audio.onset = false; } }
export function setReduced(value) { if (st) st.S.reduced = !!value; }

// frame = { level: 0..1 总能量, bands: 频谱带数组(0..1), onset: 低频起音 }
export function setAudio(frame) {
  if (!st) return;
  const a = st.audio;
  a.target = clamp(frame.level || 0, 0, 1);
  const bands = frame.bands;
  if (bands && bands.length) {
    let acc = 0;
    const n = Math.min(8, bands.length);
    for (let i = 0; i < n; i += 1) acc += bands[i] || 0;
    a.bass = clamp((acc / n) * 1.4, 0, 1);
  }
  if (frame.onset) a.onset = true;
}

export function setTimeOfDay(v) {
  if (!st) return;
  st.S.tod = clamp(v, 0, 1);
  st.S.hour = hourFromTod(st.S.tod);
}

export function setInteraction(v) {
  if (!st) return;
  st.S.interactive = !!v;
  if (!v) st.rig.dragging = false;
  st.canvas.style.touchAction = v ? 'none' : '';
}

export function resize(w, h) {
  if (!st) return;
  if (st.resources) {
    const pr = Math.min(window.devicePixelRatio || 1, st.quality.prCap) * st.quality.prMul;
    if (!st.resources.resize(w, h, pr)) throw new Error(st.resources.admissionFailure);
  }
  st.resize(w, h);
}

// Shared adapter contract: orbit {yaw,pitch,dist,fov,tx,ty,tz}, or free
// {position:[x,y,z],yaw,pitch,roll,fov}. Angles are radians, FOV is degrees.
// Free orientation is camera Euler YXZ (yaw=0 faces -Z; positive pitch is up).
// external:true skips target damping; null releases to the untouched local rig.
export function setRig(pose, opts) {
  if (!st) return;
  if (pose == null) {
    st.rig.control = null;
    st.rig.lastInput = st.S.t;
    return;
  }
  if (typeof pose !== 'object') return;
  const validPosition = Array.isArray(pose.position) && pose.position.length === 3
    && pose.position.every(Number.isFinite);
  if (pose.position !== undefined && !validPosition) return;
  const previous = st.rig.control || { yaw: st.rig.yaw, pitch: st.rig.pitch,
    dist: st.rig.dist, fov: st.camera.fov, tx: 0, ty: 0, tz: 0, roll: 0 };
  const next = { ...previous, position: validPosition ? pose.position.slice() : null,
    external: !!(opts && opts.external !== undefined ? opts.external : pose.external) };
  for (const key of ['yaw', 'pitch', 'dist', 'fov', 'tx', 'ty', 'tz', 'roll']) {
    if (Number.isFinite(pose[key])) next[key] = pose[key];
  }
  next.pitch = clamp(next.pitch, -Math.PI * 0.49, Math.PI * 0.49);
  next.dist = clamp(next.dist, 2.4, 15);
  next.fov = clamp(next.fov, 26, 72);
  st.rig.control = next;
  st.rig.lastInput = st.S.t;
  st.rig.dragging = false;
}

// 供泄漏检查：GL 侧几何/纹理/程序驻留数
export function stats() {
  if (!st) return null;
  const m = st.renderer.info.memory;
  return { geometries: m.geometries, textures: m.textures, programs: st.renderer.info.programs.length,
    sceneTime: st.S.t, external: !!st.external, scope: st.scope?.stats(), context: st.resources?.stats() };
}

// 供检查脚本做确定性断言（只读快照，不改行为）：相机 rig、巡航、音频包络，
// 以及场景根（供诊断探针遍历/定位对象）。
export function debug() {
  if (!st) return null;
  return {
    scene: st.scene,
    rig: { yaw: st.rig.yaw, pitch: st.rig.pitch, dist: st.rig.dist, yaw0: st.rig.yaw0, pitch0: st.rig.pitch0, dist0: st.rig.dist0 },
    speed: st.S.speed, distance: st.S.distance, lane: st.S.lane, hour: st.S.hour,
    night: st.env.night, waveAmp: st.env.waveAmp,
    audio: { level: st.audio.level, bass: st.audio.bass },
    interactive: st.S.interactive,
    controlled: !!st.rig.control,
    camera: { position: st.camera.position.toArray(),
      direction: st.camera.getWorldDirection(new THREE.Vector3()).toArray(),
      quaternion: st.camera.quaternion.toArray(), fov: st.camera.fov,
      projection: st.camera.projectionMatrix.toArray() },
  };
}

// 供检查脚本：同步渲一帧并按上/下分区返回像素均值（readPixels 与渲染同任务，无需 preserveDrawingBuffer）。
export function capture() {
  if (!st) return null;
  st.renderOnce();
  const gl = st.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const ticket = st.scope?.reserve({ ownedCpuBytes: w * h * 4 }, 'Coast diagnostic RGBA8 pixel readback');
  try {
  const px = new Uint8Array(w * h * 4);
  ticket?.commit();
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const step = Math.max(1, (Math.min(w, h) / 48) | 0);
  const region = (y0, y1) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y += step) {
      for (let x = 0; x < w; x += step) {
        const k = (y * w + x) * 4;
        r += px[k]; g += px[k + 1]; b += px[k + 2]; n += 1;
      }
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  };
  return { top: region((h * 0.62) | 0, h - 1), bottom: region(0, (h * 0.3) | 0), width: w, height: h };
  } finally { st.scope?.releaseReservation(ticket); }
}
