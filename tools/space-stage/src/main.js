import * as THREE from 'three';
import { createRegistry } from './registry.js';
import { createScope } from './scope.js';
import { createQuality, normalizeQualityMode } from './quality.js';
import { createScene as createCoast } from '../../coast-stage/src/main.js';
import { createScene as createZodiac, pure as zodiac } from '../../zodiac-stage/src/main.js';
import { registerScenes } from './scenes/index.js';
import { createSpatialResources } from './scenes/resources.js';
import { registerEffects, createPostChain, composeEffects, optionalEffectSpecs } from './effects/index.js';

const registry = createRegistry();
const effects = createRegistry();
const basicCapabilities = { interaction: true, ownsLyrics: false, effects: true, threejs: true };
registry.register({ apiVersion: 1, id: 'coast', stateVersion: 1, label: '海岸公路', category: 'world',
  preview: '/space-scene-preview/coast.jpg', aliases: [],
  params: { ...optionalEffectSpecs, tod: { type: 'number', label: '时段', default: 0, min: 0, max: 1, step: .01 }, reduced: { type: 'boolean', label: '减少动态', default: false } },
  camera: { theta: -1.071, phi: .346, radius: 5.33, fov: 44, lookAt: [0,1.05,.9], minRadius: 2.4, maxRadius: 15 },
  capabilities: basicCapabilities, quality: { pooled: true }, create: ctx => composeEffects(ctx, createCoast(ctx)) });
registry.register({ apiVersion: 1, id: 'zodiac', stateVersion: 1, label: '星座', category: 'world',
  preview: '/space-scene-preview/zodiac.jpg', aliases: [],
  params: { ...optionalEffectSpecs, sign: { type: 'select', label: '星座', default: 'cycle', options: [{value:'cycle',label:'循环'}, ...zodiac.ZODIAC.map(sign => ({value:sign.id,label:sign.cn}))] },
    field: { type: 'boolean', label: '星尘', default: true }, glow: { type: 'number', label: '辉光', default: 1, min: 0, max: 2, step: .05 },
    meteors: { type: 'number', label: '流星密度', default: 1, min: 0, max: 1.5, step: .05 },
    reactivity: { type: 'number', label: '音乐响应', default: 1, min: 0, max: 2, step: .05 },
    pointerStrength: { type: 'number', label: '悬停凹陷', default: 1, min: 0, max: 2, step: .05 },
    speed: { type: 'number', label: '运动', default: 1, min: .15, max: 3, step: .05 }, reduced: { type: 'boolean', label: '减少动态', default: false } },
  camera: { theta: 0, phi: .06, radius: 11.87, fov: 52, lookAt: [0,0,0], minRadius: 2.6, maxRadius: 30,
    fit: { halfWidth: zodiac.FIG_HALF_W * 1.3, halfHeight: zodiac.FIG_HALF * 1.3 } },
  capabilities: basicCapabilities, quality: { pooled: true }, create: ctx => composeEffects(ctx, createZodiac(ctx)) });
registerScenes(registry);
registerEffects(effects);
export const catalog = () => registry.catalog();
export const effectCatalog = () => effects.catalog();
export const register = definition => registry.register(definition);
export const resolveId = id => registry.resolve(id) || null;
export const normalizeState = (id, state) => registry.normalizeState(id, state);
export { normalizeQualityMode };

function rigPose(pose) {
  if (!pose) return null;
  if (typeof pose !== 'object') throw new Error('Invalid camera pose');
  const look = pose.lookAt || [pose.tx || 0, pose.ty || 0, pose.tz || 0];
  const world = pose.world || {};
  const result = { yaw: pose.theta === undefined ? pose.yaw || 0 : pose.theta + (world.y || world.cy || 0),
    pitch: pose.phi === undefined ? pose.pitch || 0 : pose.phi + (world.x || world.cx || 0), dist: pose.radius === undefined ? pose.dist || 8 : pose.radius,
    fov: pose.fov || 52, tx: look[0], ty: look[1], tz: look[2], roll: pose.roll || 0, external: true };
  if (pose.position !== undefined) {
    if (!Array.isArray(pose.position) || pose.position.length !== 3 || !pose.position.every(Number.isFinite)) throw new Error('Invalid free camera position');
    result.position = pose.position.slice();
  }
  if (!Object.values(result).filter(value => typeof value === 'number').every(Number.isFinite)) throw new Error('Invalid camera pose values');
  return result;
}

export function create(canvas, options = {}) {
  if (!canvas || typeof canvas.addEventListener !== 'function') throw new Error('Stage requires a canvas');
  const quality = createQuality(options.qualityMode, options.deviceTier);
  const lifetime = createScope();
  const spatialResources = createSpatialResources(THREE, options.onInvalidate, url => services.resolveCover ? services.resolveCover(url) : url);
  lifetime.defer(() => spatialResources.dispose());
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }); }
  catch (error) { lifetime.dispose(); throw new Error(`WebGL initialization failed: ${error.message}`); }
  renderer.info.autoReset = false;
  let active = null, lyricLayer = null, generation = 0, lyricGeneration = 0, disposed = false, width = 640, height = 360, services = { spatialResources }, pose = null;
  let state = 'idle', error = '', contextLost = false, frameCount = 0, lastFrame = null, intervals = [], cpuMs = 0, gpuMs = null;
  function stats() {
    const info = renderer.info;
    const sample = intervals.slice().sort((a,b) => a-b);
    const median = sample.length ? sample[Math.floor(sample.length / 2)] : null;
    const scoped = active ? active.scope.stats() : { resources: 0, tasks: 0, estimatedBytes: 0 };
    const lyricStats = lyricLayer ? lyricLayer.scope.stats() : { resources: 0, tasks: 0, estimatedBytes: 0 };
    const shared = spatialResources.stats();
    const post = active && active.post && active.post.stats ? active.post.stats() : { bytes: 0 };
    return { state, id: active && active.def.id, lyricId: lyricLayer && lyricLayer.def.id, error, ...quality.status(), frameCount,
      actualFps: median ? 1000 / median : null, frameIntervalP95: sample.length ? sample[Math.floor(sample.length * .95)] : null,
      cpuUpdateRenderMs: cpuMs, gpuMs, gpuTimingSource: 'unavailable', drawCalls: info.render.calls,
      points: info.render.points, triangles: info.render.triangles, geometries: info.memory.geometries,
      textures: info.memory.textures, programs: info.programs ? info.programs.length : 0,
      physicalPixels: canvas.width * canvas.height, memorySource: 'tracked-resource-estimate',
      ...scoped, resources: scoped.resources + lyricStats.resources, estimatedBytes: scoped.estimatedBytes + lyricStats.estimatedBytes + shared.bytes + post.bytes,
      textTextures: shared.textTextures, coverTextures: shared.coverTextures, tasks: scoped.tasks + lyricStats.tasks + shared.queued,
      sceneStats: active?.instance?.stats?.() || null };
  }
  function notify() { if (typeof options.onStatus === 'function') options.onStatus(stats()); }
  function releaseActive() {
    const previous = active; active = null;
    if (!previous) return;
    previous.scope.trackTree(previous.scene);
    previous.scope.dispose();
    previous.scene.clear();
    renderer.renderLists.dispose();
    renderer.info.reset();
  }
  function releaseLyrics() {
    const previous = lyricLayer; lyricLayer = null;
    if (!previous) return;
    previous.scope.trackTree(previous.scene); previous.scope.dispose(); previous.scene.clear();
    renderer.renderLists.dispose();
  }
  async function selectLyrics(id, savedState = {}) {
    if (disposed) throw new Error('Stage disposed');
    if (contextLost) throw new Error('WebGL context is lost; recreate the stage to retry');
    const normalized = id ? registry.normalizeState(id, savedState) : null;
    const def = normalized && registry.get(normalized.id);
    if (def && !def.capabilities.ownsLyrics) throw new Error('Expected a lyric effect');
    const ticket = ++lyricGeneration; releaseLyrics();
    if (!def) { notify(); return null; }
    const scope = createScope(), scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(def.camera.fov || 58, width / height, .05, 900);
    camera.position.set(0, 0, def.camera.radius || 15); camera.lookAt(0, 0, 0);
    const context = { THREE, scene, camera, renderer, scope, layer: 'lyrics', params: normalized.params, quality: quality.profile(), signal: scope.signal, services };
    const candidate = { def, scene, camera, scope, context, params: normalized.params, instance: null };
    lyricLayer = candidate;
    try {
      const instance = await def.create(context);
      if (!instance || typeof instance.update !== 'function' || typeof instance.dispose !== 'function') throw new Error('Invalid lyric instance');
      if (disposed || ticket !== lyricGeneration || scope.signal.aborted) { instance.dispose(); scope.trackTree(scene); scope.dispose(); return null; }
      candidate.instance = instance; scope.defer(() => instance.dispose()); scope.trackTree(scene);
      instance.setParams?.(candidate.params); instance.setQuality?.(quality.profile()); instance.resize?.(width, height);
      quality.warmup(null); notify(); return normalized;
    } catch (reason) {
      scope.trackTree(scene); scope.dispose();
      if (lyricLayer === candidate) { lyricLayer = null; notify(); }
      throw reason;
    }
  }
  function resize(w, h) {
    if (disposed) return;
    width = Math.max(2, Math.floor(Number(w) || 2)); height = Math.max(2, Math.floor(Number(h) || 2));
    renderer.setPixelRatio(quality.dpr(width, height, globalThis.devicePixelRatio || 1));
    renderer.setSize(width, height, false);
    quality.warmup(null);
    if (active) {
      active.camera.aspect = width / height; active.camera.updateProjectionMatrix();
      if (active.instance && active.instance.resize) active.instance.resize(width, height);
      if (active.post) active.post.resize(width, height);
    }
    if (lyricLayer) {
      lyricLayer.camera.aspect = width / height; lyricLayer.camera.updateProjectionMatrix();
      lyricLayer.instance?.resize?.(width, height);
    }
  }
  function applyQuality() {
    resize(width, height);
    if (active && active.instance && active.instance.setQuality) active.instance.setQuality(quality.profile());
    if (active && active.post) active.post.setQuality(quality.profile());
    lyricLayer?.instance?.setQuality?.(quality.profile());
    notify();
  }
  function fail(reason) {
    error = reason instanceof Error ? reason.message : String(reason);
    state = 'failed'; generation++; lyricGeneration++; releaseActive(); releaseLyrics(); notify();
  }
  lifetime.listen(canvas, 'webglcontextlost', event => { event.preventDefault(); contextLost = true; fail('WebGL context lost'); });
  lifetime.listen(canvas, 'webglcontextrestored', () => { contextLost = false; quality.warmup(null); state = 'idle'; notify(); });
  resize(canvas.clientWidth || 640, canvas.clientHeight || 360);
  return {
    selectLyrics,
    async select(id, savedState = {}) {
      if (disposed) throw new Error('Stage disposed');
      if (contextLost) throw new Error('WebGL context is lost; recreate the stage to retry');
      const normalized = registry.normalizeState(id, savedState), def = registry.get(normalized.id);
      const ticket = ++generation;
      releaseActive();
      renderer.setRenderTarget(null); renderer.setClearColor(0x030405, 1);
      renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1; renderer.shadowMap.enabled = false;
      const scope = createScope(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(52, width / height, .05, 900);
      scene.background = new THREE.Color(0x030405);
      const baseline = def.camera;
      if (baseline.position) camera.position.fromArray(baseline.position);
      else { const cp = Math.cos(baseline.phi || 0), r = baseline.radius || 8; camera.position.set(Math.sin(baseline.theta || 0) * cp * r, Math.sin(baseline.phi || 0) * r, Math.cos(baseline.theta || 0) * cp * r); }
      camera.lookAt(...(baseline.lookAt || [0,0,0])); camera.fov = baseline.fov || 52; camera.updateProjectionMatrix();
      const context = { THREE, scene, camera, renderer, scope, params: normalized.params, quality: quality.profile(), signal: scope.signal, services };
      active = { def, scene, camera, scope, params: normalized.params, context, instance: null, post: null };
      const candidate = active; state = 'loading'; error = ''; notify();
      try {
        const instance = await def.create(context);
        if (!instance || typeof instance.update !== 'function' || typeof instance.dispose !== 'function') throw new Error('Invalid scene instance');
        if (disposed || ticket !== generation || scope.signal.aborted) { instance.dispose(); scope.trackTree(scene); scope.dispose(); return null; }
        candidate.instance = instance; scope.defer(() => instance.dispose()); scope.trackTree(scene);
        candidate.post = createPostChain(context); if (candidate.post) scope.defer(() => candidate.post.dispose());
        if (instance.setParams) instance.setParams(candidate.params);
        if (instance.setRig) instance.setRig(pose);
        applyQuality(); state = 'ready'; lastFrame = null; intervals = []; quality.warmup(null); notify();
        return normalized;
      } catch (reason) {
        scope.trackTree(scene); scope.dispose();
        if (ticket === generation && !disposed) { active = null; fail(reason); }
        throw reason;
      }
    },
    frame(frame = {}) {
      if (disposed || state !== 'ready' || !active || (typeof document !== 'undefined' && document.hidden)) return false;
      const now = Number.isFinite(frame.now) ? frame.now : performance.now();
      if (lastFrame !== null && now - lastFrame > 500) { intervals = []; lastFrame = null; quality.warmup(null); }
      const dt = Number.isFinite(frame.dt) ? Math.max(0, Math.min(frame.dt, .25)) : lastFrame === null ? .016 : Math.min((now - lastFrame) / 1000, .25);
      if (lastFrame !== null && now > lastFrame) { intervals.push(now-lastFrame); if (intervals.length > 240) intervals.shift(); }
      lastFrame = now;
      const started = performance.now();
      try {
        if (frame.deviceTier !== undefined && quality.setDeviceTier(frame.deviceTier)) applyQuality();
        spatialResources.beginFrame(now);
        active.instance.update({ ...frame, now, dt });
        if (lyricLayer?.instance) {
          lyricLayer.scene.visible = !!frame.lyrics?.lines?.length && !active.def.capabilities.ownsLyrics;
          lyricLayer.instance.update({ ...frame, now, dt });
        }
        if (active.post && active.post.update) active.post.update(frame);
        renderer.info.reset();
        if (active.post) active.post.render(renderer, active.scene, active.camera); else renderer.render(active.scene, active.camera);
        if (lyricLayer?.instance && lyricLayer.scene.visible) {
          // Preserve the world's color buffer while giving lyrics their own reading depth.
          const autoClear = renderer.autoClear, toneMapping = renderer.toneMapping, exposure = renderer.toneMappingExposure;
          try {
            renderer.setRenderTarget(null); renderer.autoClear = false;
            renderer.toneMapping = THREE.NoToneMapping; renderer.toneMappingExposure = 1;
            renderer.clearDepth(); renderer.render(lyricLayer.scene, lyricLayer.camera);
          } finally { renderer.autoClear = autoClear; renderer.toneMapping = toneMapping; renderer.toneMappingExposure = exposure; }
        }
        cpuMs = performance.now() - started; frameCount++;
        if (quality.sample(now, () => {
          const info = renderer.info.render, scoped = active.scope.stats(), shared = spatialResources.stats();
          const post = active.post && active.post.stats ? active.post.stats().bytes : 0;
          return { drawCalls: info.calls, points: info.points, triangles: info.triangles, estimatedBytes: scoped.estimatedBytes + (lyricLayer ? lyricLayer.scope.stats().estimatedBytes : 0) + shared.bytes + post };
        }, cpuMs)) applyQuality();
        if (frameCount % 120 === 0) notify();
        return true;
      } catch (reason) { fail(reason); return false; }
    },
    resize,
    setQualityMode(mode) { if (disposed) return; quality.setMode(mode); applyQuality(); },
    setDeviceTier(tier) { if (!disposed && quality.setDeviceTier(tier)) applyQuality(); },
    effectiveQuality() { return quality.profile().mode; },
    setLyricParams(patch) {
      if (!lyricLayer?.instance) return null;
      const params = registry.validateParams(lyricLayer.def.id, patch, lyricLayer.params);
      lyricLayer.params = params; lyricLayer.context.params = params; lyricLayer.instance.setParams?.(params);
      return { id: lyricLayer.def.id, stateVersion: lyricLayer.def.stateVersion, params };
    },
    setParams(patch) {
      if (!active || !active.instance) return null;
      const params = registry.validateParams(active.def.id, patch, active.params);
      active.params = params; active.context.params = params;
      try { if (active.instance.setParams) active.instance.setParams(params); if (active.post) active.post.setParams(params); }
      catch (reason) { fail(reason); throw reason; }
      return { id: active.def.id, stateVersion: active.def.stateVersion, params };
    },
    setRig(value) {
      pose = rigPose(value);
      if (!active || !active.instance) return;
      if (pose && !pose.position && active.def.camera.fit) {
        const fit = active.def.camera.fit, tan = Math.tan(pose.fov * Math.PI / 360);
        const distance = Math.max(fit.halfHeight / tan, fit.halfWidth / (tan * width / height));
        pose.dist *= Math.max(1, distance / active.def.camera.radius);
      }
      if (active.instance.setRig) active.instance.setRig(pose);
      else if (pose) {
        const camera = active.camera;
        if (pose.position) { camera.position.fromArray(pose.position); camera.rotation.set(pose.pitch, pose.yaw, pose.roll, 'YXZ'); }
        else { const cp = Math.cos(pose.pitch); camera.position.set(pose.tx + Math.sin(pose.yaw)*cp*pose.dist, pose.ty + Math.sin(pose.pitch)*pose.dist, pose.tz + Math.cos(pose.yaw)*cp*pose.dist); camera.lookAt(pose.tx,pose.ty,pose.tz); camera.rotateZ(pose.roll); }
        camera.fov = pose.fov; camera.updateProjectionMatrix();
      }
    },
    setServices(value = {}) { Object.keys(services).filter(key => key !== 'spatialResources').forEach(key => delete services[key]); Object.assign(services, value, { spatialResources }); },
    dispose() { if (disposed) return; disposed = true; generation++; lyricGeneration++; releaseActive(); releaseLyrics(); lifetime.dispose(); renderer.dispose(); renderer.forceContextLoss(); state = 'disposed'; notify(); },
    stats,
  };
}
