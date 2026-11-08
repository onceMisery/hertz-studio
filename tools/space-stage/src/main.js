import * as THREE from 'three';
import { createRegistry } from './registry.js';
import { createScope } from './scope.js';
import { createQuality, normalizeQualityMode } from './quality.js';
import { createScene as createCoast } from '../../coast-stage/src/main.js';
import { createScene as createZodiac, pure as zodiac } from '../../zodiac-stage/src/main.js';
import { registerScenes } from './scenes/index.js';
import { createSpatialResources } from './scenes/resources.js';
import { registerEffects, createPostChain, postResourcePlan, composeEffects, optionalEffectSpecs } from './effects/index.js';

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
export { PROFILES as qualityProfiles } from './quality.js';

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
  const pagePort = options.resources || null;
  if (pagePort && pagePort.contractVersion !== 1) throw new Error('resource-policy-required');
  let contextTicket = null, surfaceTicket = null, admissionFailure = '';
  const releaseTicket = ticket => ticket?.release({ apiReleased: true, allocationEnded: true });
  const quality = createQuality(options.qualityMode, options.deviceTier);
  const lifetime = createScope();
  const spatialResources = createSpatialResources(THREE, options.onInvalidate,
    (url, signal) => services.resolveCover ? services.resolveCover(url, signal) : url, undefined,
    { resources: pagePort, decodeImage: (url, options) => services.decodeImage
      ? services.decodeImage(url, options) : Promise.reject(new Error('estimate-unavailable')) });
  lifetime.defer(() => spatialResources.dispose());
  let renderer;
  try {
    contextTicket = pagePort?.require({ gpuContexts: 1 }, 'SpaceStage original shared Three renderer context', 0);
    const pixels = Math.max(1, canvas.width * canvas.height);
    surfaceTicket = pagePort?.require({ drawingBufferPixels: pixels, renderTargetDeclaredBytes: pixels * 8 },
      'SpaceStage original RGBA8/depth drawing buffer', 0, 'bounded-estimate');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.hertzProgramResources = pagePort;
    renderer.hertzBufferResources = pagePort;
    contextTicket?.commit(); surfaceTicket?.commit();
  } catch (error) {
    lifetime.dispose(); renderer?.dispose(); renderer?.forceContextLoss();
    canvas.width = canvas.height = 0; releaseTicket(contextTicket); releaseTicket(surfaceTicket);
    throw new Error(`WebGL initialization failed: ${error.message}`);
  }
  renderer.info.autoReset = false;
  let active = null, lyricLayer = null, generation = 0, lyricGeneration = 0, disposed = false, width = 640, height = 360, services = { spatialResources }, pose = null;
  let state = 'idle', error = '', contextLost = false, frameCount = 0, lastFrame = null, intervals = [], cpuMs = 0, gpuMs = null;
  let requestId = '', requestedId = '', lastResourceFailure = '';
  function stats() {
    const info = renderer?.info || { render: { calls: 0, points: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, programs: [] };
    const sample = intervals.slice().sort((a,b) => a-b);
    const median = sample.length ? sample[Math.floor(sample.length / 2)] : null;
    const scoped = active ? active.scope.stats() : { resources: 0, tasks: 0, estimatedBytes: 0 };
    const lyricStats = lyricLayer ? lyricLayer.scope.stats() : { resources: 0, tasks: 0, estimatedBytes: 0 };
    const shared = spatialResources.stats();
    const post = active && active.post && active.post.stats ? active.post.stats() : { bytes: 0 };
    return { state, id: active && active.def.id, requestedId, requestId, lyricId: lyricLayer && lyricLayer.def.id, error, ...quality.status(), frameCount,
      actualFps: median ? 1000 / median : null, frameIntervalP95: sample.length ? sample[Math.floor(sample.length * .95)] : null,
      cpuUpdateRenderMs: cpuMs, gpuMs, gpuTimingSource: 'unavailable', drawCalls: info.render.calls,
      points: info.render.points, triangles: info.render.triangles, geometries: info.memory.geometries,
      textures: info.memory.textures, programs: info.programs ? info.programs.length : 0,
      physicalPixels: canvas.width * canvas.height, memorySource: 'tracked-resource-estimate',
      ...scoped, resources: scoped.resources + lyricStats.resources, estimatedBytes: scoped.estimatedBytes + lyricStats.estimatedBytes + shared.bytes + post.bytes,
      textTextures: shared.textTextures, coverTextures: shared.coverTextures, tasks: scoped.tasks + lyricStats.tasks + shared.queued + shared.coverLoads,
      sceneStats: active?.instance?.stats?.() || null, firstSubmit: !!active?.firstSubmit, resourceAdmissionFailure: admissionFailure,
      postResourceFailure: post.resourceFailure || '', poolResourceFailure: shared.resourceFailure || '',
      resourceCoverage: pagePort ? 'context-post-text-raster-cover-and-shared-buffer-subset' : 'original-consumer-policy' };
  }
  function notify() {
    const value = stats();
    lastResourceFailure = value.resourceAdmissionFailure || value.postResourceFailure || value.poolResourceFailure || '';
    if (pagePort) {
      if (disposed) pagePort.forgetReport();
      else pagePort.report({ requestId, requestedScene: requestedId, actualScene: value.id || '',
        requestedQuality: value.qualityMode, actualQuality: value.effectiveQuality,
        actualBackend: renderer ? 'three-webgl2' : 'none', lifecycle: value.state,
        firstSubmit: value.firstSubmit, reason: error || lastResourceFailure, coverage: value.resourceCoverage });
    }
    if (typeof options.onStatus === 'function') options.onStatus(value);
  }
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
    if (options.isVisible && !options.isVisible()) throw new Error('preparation-suspended');
    const normalized = id ? registry.normalizeState(id, savedState) : null;
    const def = normalized && registry.get(normalized.id);
    if (def && !def.capabilities.ownsLyrics) throw new Error('Expected a lyric effect');
    const ticket = ++lyricGeneration; releaseLyrics();
    if (!def) { notify(); return null; }
    const scope = createScope({ resources: pagePort, generation: ticket }), scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(def.camera.fov || 58, width / height, .05, 900);
    camera.position.set(0, 0, def.camera.radius || 15); camera.lookAt(0, 0, 0);
    const context = { THREE, scene, camera, renderer, scope, resources: pagePort, layer: 'lyrics', params: normalized.params, quality: quality.profile(), signal: scope.signal, services };
    const candidate = { def, scene, camera, scope, context, params: normalized.params, instance: null };
    lyricLayer = candidate;
    scope.beginAllocation();
    try {
      const instance = await def.create(context);
      if (!instance || typeof instance.update !== 'function' || typeof instance.dispose !== 'function') throw new Error('Invalid lyric instance');
      if (disposed || ticket !== lyricGeneration || scope.signal.aborted) { instance.dispose(); scope.trackTree(scene); scope.dispose(); return null; }
      candidate.instance = instance; scope.defer(() => instance.dispose()); scope.trackTree(scene);
      candidate.prepare = () => {
        instance.setParams?.(candidate.params); instance.setQuality?.(quality.profile()); instance.resize?.(width, height);
        candidate.prepare = null;
      };
      if (!options.isVisible || options.isVisible()) candidate.prepare();
      quality.warmup(null); notify(); return normalized;
    } catch (reason) {
      scope.trackTree(scene); scope.dispose();
      if (lyricLayer === candidate) { lyricLayer = null; notify(); }
      throw reason;
    } finally { scope.endAllocation(); }
  }
  function resize(w, h) {
    if (disposed || contextLost) return false;
    const nextWidth = Math.max(2, Math.floor(Number(w) || 2)), nextHeight = Math.max(2, Math.floor(Number(h) || 2));
    const nativePixels = globalThis.HertzGlBudget?.limits?.pixelBudget || Infinity;
    const dpr = Math.min(quality.dpr(nextWidth, nextHeight, globalThis.devicePixelRatio || 1), Math.sqrt(nativePixels / (nextWidth * nextHeight)));
    const pixelWidth = Math.floor(nextWidth * dpr), pixelHeight = Math.floor(nextHeight * dpr);
    let nextSurface = null;
    try {
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        const peakPixels = Math.max(pixelWidth * canvas.height, pixelWidth * pixelHeight);
        nextSurface = pagePort?.require({ drawingBufferPixels: peakPixels, renderTargetDeclaredBytes: peakPixels * 8 },
          'SpaceStage shared drawing buffer old/new/intermediate resize', 0, 'bounded-estimate');
        // r186 updates CSS size, ratio and backing dimensions in one owner call.
        renderer.setDrawingBufferSize(nextWidth, nextHeight, dpr);
        nextSurface?.commit({ drawingBufferPixels: pixelWidth * pixelHeight, renderTargetDeclaredBytes: pixelWidth * pixelHeight * 8 });
        releaseTicket(surfaceTicket); surfaceTicket = nextSurface;
      }
      admissionFailure = ''; width = nextWidth; height = nextHeight;
    } catch (error) {
      if (nextSurface) { canvas.width = canvas.height = 0; releaseTicket(surfaceTicket); surfaceTicket = null; releaseTicket(nextSurface); }
      admissionFailure = error.message; return false;
    }
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
    return true;
  }
  function applyQuality() {
    if (options.isVisible && !options.isVisible()) return;
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
  function retireRenderer() {
    if (!renderer) return;
    renderer.dispose(); if (!renderer.getContext().isContextLost()) renderer.forceContextLoss(); renderer = null;
    canvas.width = canvas.height = 0; releaseTicket(surfaceTicket); releaseTicket(contextTicket);
    surfaceTicket = contextTicket = null;
  }
  lifetime.listen(canvas, 'webglcontextlost', event => {
    event.preventDefault(); contextLost = true; fail('WebGL context lost'); retireRenderer();
  });
  // Lost generations are retired. Recreating a stage is the caller's explicit operation.
  lifetime.listen(canvas, 'webglcontextrestored', () => { if (contextLost) notify(); });
  if (!resize(canvas.clientWidth || 640, canvas.clientHeight || 360) && !canvas.width) {
    lifetime.dispose(); retireRenderer(); throw new Error(admissionFailure || 'drawing-buffer-unavailable');
  }
  return {
    selectLyrics,
    cancelPreparation() {
      if (disposed || !['loading', 'preparing'].includes(state)) return;
      generation++; releaseActive(); state = 'idle'; error = ''; notify();
    },
    async select(id, savedState = {}) {
      if (disposed) throw new Error('Stage disposed');
      if (contextLost) throw new Error('WebGL context is lost; recreate the stage to retry');
      if (options.isVisible && !options.isVisible()) throw new Error('preparation-suspended');
      const normalized = registry.normalizeState(id, savedState), def = registry.get(normalized.id);
      requestId = pagePort?.nextId() || String(generation + 1); requestedId = normalized.id;
      if (pagePort && def.resourcePlan) {
        try {
          const declared = def.resourcePlan({ params: normalized.params, quality: quality.profile(), width, height, services });
          if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw new Error('estimate-unavailable');
          const resources = { ...declared };
          const post = postResourcePlan(normalized.params, services, width, height);
          for (const [key, value] of Object.entries(post)) resources[key] = (resources[key] || 0) + value;
          const retiring = [...(active?.scope.retirementCandidates(renderer) || []), ...(active?.post?.retirementCandidates() || [])];
          const result = pagePort.preflight(resources, retiring);
          if (!result.ok) { const reason = new Error(result.reason); reason.resourceFailure = result; throw reason; }
        } catch (reason) {
          admissionFailure = reason.message;
          // A refused plan has not retired or changed the committed instance.
          if (!active) { state = 'failed'; error = reason.message; }
          notify(); throw reason;
        }
      }
      admissionFailure = '';
      const ticket = ++generation;
      state = 'loading'; error = ''; notify();
      releaseActive();
      renderer.setRenderTarget(null); renderer.setClearColor(0x030405, 1);
      renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1; renderer.shadowMap.enabled = false;
      const scope = createScope({ resources: pagePort, generation: ticket }), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(52, width / height, .05, 900);
      scene.background = new THREE.Color(0x030405);
      const baseline = def.camera;
      if (baseline.position) camera.position.fromArray(baseline.position);
      else { const cp = Math.cos(baseline.phi || 0), r = baseline.radius || 8; camera.position.set(Math.sin(baseline.theta || 0) * cp * r, Math.sin(baseline.phi || 0) * r, Math.cos(baseline.theta || 0) * cp * r); }
      camera.lookAt(...(baseline.lookAt || [0,0,0])); camera.fov = baseline.fov || 52; camera.updateProjectionMatrix();
      const context = { THREE, scene, camera, renderer, scope, resources: pagePort, params: normalized.params, quality: quality.profile(), signal: scope.signal, services };
      active = { def, scene, camera, scope, params: normalized.params, context, instance: null, post: null, firstSubmit: false };
      const candidate = active; state = 'loading'; error = ''; notify();
      scope.beginAllocation();
      try {
        const instance = await def.create(context);
        if (!instance || typeof instance.update !== 'function' || typeof instance.dispose !== 'function') throw new Error('Invalid scene instance');
        if (disposed || ticket !== generation || scope.signal.aborted) { instance.dispose(); scope.trackTree(scene); scope.dispose(); return null; }
        candidate.instance = instance; scope.defer(() => instance.dispose()); scope.trackTree(scene);
        candidate.prepare = () => {
          candidate.post = createPostChain(context); if (candidate.post) scope.defer(() => candidate.post.dispose());
          if (instance.setParams) instance.setParams(candidate.params);
          if (instance.setRig) instance.setRig(pose);
          applyQuality(); candidate.prepare = null;
        };
        if (!options.isVisible || options.isVisible()) candidate.prepare();
        state = 'preparing'; lastFrame = null; intervals = []; quality.warmup(null); notify();
        return normalized;
      } catch (reason) {
        scope.trackTree(scene); scope.dispose();
        if (ticket === generation && !disposed) { active = null; fail(reason); }
        throw reason;
      } finally { scope.endAllocation(); }
    },
    frame(frame = {}) {
      if (disposed || !['preparing', 'ready'].includes(state) || !active?.instance || !canvas.width || !canvas.height
          || (typeof document !== 'undefined' && document.hidden) || (options.isVisible && !options.isVisible())) return false;
      const now = Number.isFinite(frame.now) ? frame.now : performance.now();
      if (lastFrame !== null && now - lastFrame > 500) { intervals = []; lastFrame = null; quality.warmup(null); }
      const dt = Number.isFinite(frame.dt) ? Math.max(0, Math.min(frame.dt, .25)) : lastFrame === null ? .016 : Math.min((now - lastFrame) / 1000, .25);
      if (lastFrame !== null && now > lastFrame) { intervals.push(now-lastFrame); if (intervals.length > 240) intervals.shift(); }
      lastFrame = now;
      const started = performance.now();
      try {
        if (active.prepare) active.prepare();
        if (lyricLayer?.prepare) lyricLayer.prepare();
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
        if (renderer.info.programs.some(program => program.diagnostics?.runnable === false))
          throw new Error('Three shader program failed');
        cpuMs = performance.now() - started; frameCount++;
        if (!active.firstSubmit) { active.firstSubmit = true; state = 'ready'; notify(); }
        if (quality.sample(now, () => {
          const info = renderer.info.render, scoped = active.scope.stats(), shared = spatialResources.stats();
          const post = active.post && active.post.stats ? active.post.stats().bytes : 0;
          return { drawCalls: info.calls, points: info.points, triangles: info.triangles, estimatedBytes: scoped.estimatedBytes + (lyricLayer ? lyricLayer.scope.stats().estimatedBytes : 0) + shared.bytes + post };
        }, cpuMs)) applyQuality();
        const currentFailure = admissionFailure || active.post?.stats?.().resourceFailure || spatialResources.stats().resourceFailure || '';
        if (frameCount % 120 === 0 || currentFailure !== lastResourceFailure) notify();
        return true;
      } catch (reason) { fail(reason); return false; }
    },
    resize,
    retryResources() {
      if (disposed || contextLost || (typeof document !== 'undefined' && document.hidden)
          || (options.isVisible && !options.isVisible())) return false;
      active?.post?.retryResources(); spatialResources.retryResources();
      resize(width, height); options.onInvalidate?.(); notify(); return true;
    },
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
    dispose() { if (disposed) return; disposed = true; generation++; lyricGeneration++; releaseActive(); releaseLyrics(); lifetime.dispose(); retireRenderer(); state = 'disposed'; notify(); },
    stats,
  };
}
