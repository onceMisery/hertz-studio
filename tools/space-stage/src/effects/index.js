// SPDX-License-Identifier: MIT
import { root, own, basicInstance, level, seed, qualityDensity, number, commonParams, motionFrame } from '../scenes/factories.js';

export const postSpecs = {
  halftone: number('半调网点', 0, 0, 40, 1), grain: number('胶片颗粒', 0, 0, 40, 1),
  vignette: number('镜头暗角', 0, 0, 100, 1), softness: number('光晕柔化', 0, 0, 20, 1),
  bokeh: number('焦点虚化', 0, 0, 20, 1), chroma: number('径向色散', 0, 0, 12, 1),
  aberration: number('镜头光学瑕疵', 0, 0, 12, 1), distort: number('胶片散眩', 0, 0, 12, 1),
  bloom: number('对比度辉映', 0, 0, 12, 1)
};
export const optionalEffectSpecs = { dust: commonParams.dust, discRing: commonParams.discRing, ripples: commonParams.ripples, ...postSpecs };
function bufferResources(id, cpuPeakBytes, cpuRetainedBytes, bufferBytes, primitives) {
  return { id, cpuPeakBytes, cpuRetainedBytes, bufferBytes, primitives,
    ownedCpuBytes: cpuPeakBytes, bufferDeclaredBytes: bufferBytes };
}
function dustResourcePlan(profile) {
  const bytes = 1200 * 3 * 4;
  return bufferResources('dust', bytes, bytes, bytes,
    { drawCalls: 1, points: Math.floor(1200 * qualityDensity(profile)), triangles: 0 });
}
function orbitResourcePlan(profile) {
  const geometryBytes = 24 * 8 * 4 + 36 * 2, matrixBytes = 64 * 16 * 4;
  const retained = geometryBytes + matrixBytes;
  return bufferResources('orbit', retained + (24 * 8 + 36) * 8, retained, retained,
    { drawCalls: 1, points: 0, triangles: (qualityDensity(profile) < .5 ? 32 : 64) * 12 });
}
function rippleResourcePlan() {
  const vertices = 5 * 65, indices = 6 * 4 * 64, geometryBytes = vertices * 8 * 4 + indices * 2;
  const bufferBytes = geometryBytes + 6 * 16 * 4, retained = bufferBytes + 6 * 4;
  return bufferResources('ripple', retained + (vertices * 8 + indices) * 8, retained, bufferBytes,
    { drawCalls: 0, points: 0, triangles: 0 });
}
export function effectsResourcePlan(profile) {
  const buffers = [dustResourcePlan(profile), orbitResourcePlan(profile), rippleResourcePlan()];
  return { buffers, cpuRetainedBytes: buffers.reduce((sum, plan) => sum + plan.cpuRetainedBytes, 0),
    ownedCpuBytes: buffers.reduce((sum, plan) => sum + plan.cpuPeakBytes, 0), bufferDeclaredBytes: buffers.reduce((sum, plan) => sum + plan.bufferBytes, 0) };
}
export function createDust(ctx) {
  const T = ctx.THREE, group = root(ctx), count = 1200;
  const declared = dustResourcePlan(), plan = ctx.scope.bufferPlan(declared.ownedCpuBytes, declared.bufferDeclaredBytes, 'Space dust position1200', declared.id);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { positions[i * 3] = (seed(i, 1) - .5) * 24; positions[i * 3 + 1] = (seed(i, 2) - .5) * 16; positions[i * 3 + 2] = (seed(i, 3) - .5) * 24; }
  const geometry = own(ctx, new T.BufferGeometry()); geometry.setAttribute('position', plan.upload(new T.BufferAttribute(positions, 3)));
  plan.cpuReady(positions.byteLength);
  const material = own(ctx, new T.PointsMaterial({ color: 0xbcdbdd, size: .035, transparent: true, opacity: .5, depthWrite: false }));
  const points = new T.Points(geometry, material); group.add(points); let profile = ctx.quality, params = ctx.params;
  function adjust() { geometry.setDrawRange(0, Math.floor(count * qualityDensity(profile) * (params.dust ?? 0))); group.visible = geometry.drawRange.count > 0; }
  adjust();
  return basicInstance(group, params, profile, { update(f, p) { group.rotation.y = (p.reduced ? 0 : f.sceneTime ?? f.time ?? 0) * .013 * (p.speed ?? .6); material.opacity = .35 + level(f, 'treble') * .3; },
    params(p) { params = p; adjust(); }, quality(q) { profile = q; adjust(); }, stats: () => ({ particles: geometry.drawRange.count, drawCalls: group.visible ? 1 : 0 }) });
}
export function createSpectrumOrbit(ctx) {
  const T = ctx.THREE, group = root(ctx), count = 64;
  const geometryBytes = 24 * 8 * 4 + 36 * 2, matrixBytes = count * 16 * 4;
  const declared = orbitResourcePlan(), plan = ctx.scope.bufferPlan(declared.ownedCpuBytes, declared.bufferDeclaredBytes, 'Space spectrum orbit BoxGeometry and matrix64', declared.id);
  const geometry = own(ctx, new T.BoxGeometry(.065, 1, .065));
  const material = own(ctx, new T.MeshBasicMaterial({ color: 0xfca38f }));
  const mesh = own(ctx, new T.InstancedMesh(geometry, material, count)), o = new T.Object3D(); group.add(mesh); group.visible = !!ctx.params.discRing;
  Object.values(geometry.attributes).forEach(attribute => plan.upload(attribute)); plan.upload(geometry.index); plan.upload(mesh.instanceMatrix);
  plan.cpuReady(geometryBytes + matrixBytes);
  return basicInstance(group, ctx.params, ctx.quality, {
    update(f, p) {
      if (!p.discRing) return;
      for (let i = 0; i < mesh.count; i++) {
        const a = i / mesh.count * Math.PI * 2, spectrum = f.spectrum || f.bands?.spectrum;
        const sample = spectrum?.[Math.floor(i / mesh.count * spectrum.length)], band = sample === undefined ? level(f, i % 2 ? 'mid' : 'bass') : Math.min(1, sample > 1 ? sample / 255 : sample);
        const h = .2 + band * 1.2; o.position.set(Math.cos(a) * 5, -3 + h / 2, Math.sin(a) * 5); o.scale.set(1, h, 1); o.rotation.y = -a; o.updateMatrix(); mesh.setMatrixAt(i, o.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }, params(p) { group.visible = !!p.discRing; }, quality(q) { mesh.count = qualityDensity(q) < .5 ? 32 : 64; },
    stats: () => ({ triangles: mesh.count * 12, drawCalls: group.visible ? 1 : 0 })
  });
}
export function createRipple(ctx) {
  const T = ctx.THREE, group = root(ctx), vertices = 5 * 65, indices = 6 * 4 * 64;
  const geometryBytes = vertices * 8 * 4 + indices * 2, matrixBytes = 6 * 16 * 4, bornBytes = 6 * 4;
  const declared = rippleResourcePlan(), plan = ctx.scope.bufferPlan(declared.ownedCpuBytes, declared.bufferDeclaredBytes, 'Space ripple TorusGeometry4x64, matrix6 and born6', declared.id);
  const geometry = own(ctx, new T.TorusGeometry(1, .018, 4, 64));
  const material = own(ctx, new T.MeshBasicMaterial({ color: 0x8fcdda, transparent: true, opacity: .4, depthWrite: false }));
  const mesh = own(ctx, new T.InstancedMesh(geometry, material, 6)), o = new T.Object3D(), born = new Float32Array(6).fill(-100); group.add(mesh);
  Object.values(geometry.attributes).forEach(attribute => plan.upload(attribute)); plan.upload(geometry.index); plan.upload(mesh.instanceMatrix);
  plan.cpuReady(geometryBytes + matrixBytes + bornBytes);
  let next = 0, previousOnset = false, previousBass = 0, last = -100;
  return basicInstance(group, ctx.params, ctx.quality, {
    update(f, p) {
      const time = p.reduced ? 0 : f.sceneTime ?? f.time ?? 0, bass = level(f, 'bass'), onset = typeof f.onset === 'number' ? f.onset > .3 : !!f.onset;
      group.visible = (p.ripples ?? 0) > 0;
      if (((onset && !previousOnset) || (bass > .6 && previousBass <= .6)) && time - last > .25) { born[next++ % 6] = time; last = time; }
      previousOnset = onset; previousBass = bass;
      for (let i = 0; i < 6; i++) {
        const age = time - born[i], active = age >= 0 && age < 2.4;
        o.position.set(0, -2.9, 0); o.rotation.x = -Math.PI / 2; o.scale.setScalar(active ? (.5 + age * 3) * (p.ripples ?? 0) : 0); o.updateMatrix(); mesh.setMatrixAt(i, o.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }, reset() {born.fill(-100);next=0;previousOnset=false;previousBass=0;last=-100;},
    stats: () => ({ triangles: 3072, drawCalls: group.visible ? 1 : 0 })
  });
}
const factories = { dust: createDust, 'spectrum-orbit': createSpectrumOrbit, ripple: createRipple };
export function createEffects(ctx, ids = Object.keys(factories)) {
  const instances = ids.map(id => factories[id]?.(ctx)).filter(Boolean);
  return {
    update(frame) { instances.forEach(i => i.update(frame)); }, resize(w, h) { instances.forEach(i => i.resize(w, h)); },
    setParams(params) { instances.forEach(i => i.setParams(params)); }, setQuality(profile) { instances.forEach(i => i.setQuality(profile)); },
    resetHistory() {instances.forEach(i=>i.resetHistory?.());},
    dispose() { instances.forEach(i => i.dispose()); }, stats() { return instances.map(i => i.stats()); }
  };
}
export function composeEffects(ctx, primary) {
  const effects = createEffects(ctx); let params = ctx.params;
  return {
    group: primary.group,
    update(frame) { primary.update(frame); effects.update(motionFrame(frame, params.reduced)); },
    resize(w, h) { primary.resize?.(w, h); effects.resize(w, h); },
    setParams(next) { params = next; primary.setParams?.(next); effects.setParams(next); },
    setQuality(profile) { primary.setQuality?.(profile); effects.setQuality(profile); },
    resetHistory() {primary.resetHistory?.();effects.resetHistory();},
    dispose() { effects.dispose(); primary.dispose(); },
    ...(primary.setRig ? { setRig(pose) { primary.setRig(pose); } } : {}),
    stats: () => ({ primary: primary.stats?.(), effects: effects.stats() })
  };
}

export function registerEffects(registry) {
  for (const [id, factory] of Object.entries(factories)) registry.register({ apiVersion: 1, stateVersion: 1, id, label: { dust: '空间光尘', 'spectrum-orbit': '环绕频谱', ripple: '节拍涟漪' }[id], category: '组合效果', preview: '/space-scene-preview/aurora-dome.jpg', aliases: [], params: {},
    camera: {}, capabilities: { effect: true, stage: 'geometry', depth: true }, quality: {}, create: factory });
  for (const [key, spec] of Object.entries(postSpecs)) registry.register({ apiVersion: 1, stateVersion: 1, id: 'post-' + key, label: spec.label, category: '镜头效果', preview: '/space-scene-preview/aurora-dome.jpg', aliases: [],
    params: { amount: spec }, camera: {}, capabilities: { effect: true, stage: 'post', sharedChain: true }, quality: {},
    create(ctx) {
      let amount = ctx.params.amount ?? 0;
      return { update() {}, resize() {}, setQuality() {}, dispose() {}, setParams(p) { amount = p.amount ?? amount; },
        contribution: () => ({ key, uniform: 'u' + key[0].toUpperCase() + key.slice(1), amount }) };
    } });
}

const postFragment = `
uniform sampler2D uScene,uDepth;uniform vec2 uPixel;uniform float uTime,uNear,uFar,uFocus,uQuality;
uniform float uHalftone,uGrain,uVignette,uSoftness,uBokeh,uChroma,uAberration,uDistort,uBloom;
varying vec2 vUv;
float rnd(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
vec3 sampleColor(vec2 uv){return texture2D(uScene,clamp(uv,vec2(.001),vec2(.999))).rgb;}
void main(){
 vec2 radial=vUv-.5;float edge=dot(radial,radial);
 vec2 uv=vUv+radial*edge*uAberration*.0008;
 uv+=vec2(sin(uv.y*16.0+uTime*.2),cos(uv.x*13.0))*.00035*uDistort;
 vec3 c=sampleColor(uv);float chroma=uChroma+uAberration*.3;
 if(chroma>0.0){vec2 d=radial*uPixel*chroma*2.0;c.r=sampleColor(uv+d).r;c.b=sampleColor(uv-d).b;}
 float depth=texture2D(uDepth,uv).x;
 float distance=uNear*uFar/(uFar-depth*(uFar-uNear));
 float blur=uQuality>0.0?uSoftness*.15+uBokeh*.16*smoothstep(1.0,7.0,abs(distance-uFocus)):0.0;
 if(blur>0.0){vec2 d=uPixel*blur;vec3 soft=(sampleColor(uv+vec2(d.x,0.0))+sampleColor(uv-vec2(d.x,0.0))+sampleColor(uv+vec2(0.0,d.y))+sampleColor(uv-vec2(0.0,d.y)))*.25;c=mix(c,soft,min(.8,blur*.3));}
 if(uBloom>0.0)c+=max(c-.6,vec3(0.0))*uBloom*.08;
 if(uHalftone>0.0){float dotPattern=step(.26,length(fract(gl_FragCoord.xy/4.0)-.5));c*=mix(1.0,.55+.45*dotPattern,uHalftone*.025);}
 c+=(rnd(gl_FragCoord.xy+floor(uTime*24.0))-.5)*uGrain*.003;
 c*=1.0-smoothstep(.08,.5,edge)*uVignette*.01;
 gl_FragColor=vec4(c,1.0);
}`;

// One shared low-resolution target/pass; zero targets until a post control is enabled.
const postGeometryBytes = (12 + 12 + 8) * 4 + 6 * 2;
export function postResourcePlan(params, services, width, height) {
  const active = Object.keys(postSpecs).some(key => Number(params[key] || services.post?.[key]) > 0);
  return { programs: active ? 1 : 0, bufferDeclaredBytes: postGeometryBytes, ownedCpuBytes: postGeometryBytes,
    renderTargetDeclaredBytes: active ? Math.max(1, Math.floor(width * .5)) * Math.max(1, Math.floor(height * .5)) * 8 : 0 };
}
export function createPostChain(ctx) {
  const T = ctx.THREE, scene = new T.Scene(), camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const resources = ctx.resources;
  const release = ticket => ticket?.release({ apiReleased: true, allocationEnded: true });
  // PlaneGeometry(2,2): position/normal/uv Float32 plus six Uint16 indices.
  const geometryBytes = postGeometryBytes;
  const fixedTicket = resources?.require({ bufferDeclaredBytes: geometryBytes, ownedCpuBytes: geometryBytes },
    'Space post original PlaneGeometry arrays/upload; program admitted by Three cache owner', 0);
  const uniforms = { uScene: { value: null }, uDepth: { value: null }, uPixel: { value: new T.Vector2(1, 1) },
    uTime: { value: 0 }, uNear: { value: ctx.camera.near }, uFar: { value: ctx.camera.far }, uFocus: { value: 12 }, uQuality: { value: 1 } };
  for (const key of Object.keys(postSpecs)) uniforms['u' + key[0].toUpperCase() + key.slice(1)] = { value: 0 };
  let geometry, material;
  try {
    geometry = own(ctx, new T.PlaneGeometry(2, 2));
    if (fixedTicket) {
      Object.values(geometry.attributes).forEach(attribute => { attribute.hertzBufferAdmission = fixedTicket; });
      geometry.index.hertzBufferAdmission = fixedTicket;
    }
    material = own(ctx, new T.ShaderMaterial({ uniforms, depthTest: false, depthWrite: false,
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`, fragmentShader: postFragment }));
    fixedTicket?.materialize({ ownedCpuBytes: geometryBytes });
  } catch (error) { if (material) ctx.scope.release(material); if (geometry) ctx.scope.release(geometry); release(fixedTicket); throw error; }
  const quad = new T.Mesh(geometry, material); quad.frustumCulled = false; scene.add(quad);
  let target = null, width = 1, height = 1, disposed = false, params = ctx.params || {}, profile = ctx.quality;
  let targetTicket = null, rejectedSize = '', resourceFailure = '';
  let fixedSubmitted = false;
  function releaseTarget() {
    uniforms.uScene.value = uniforms.uDepth.value = null;
    target?.dispose(); target = null; release(targetTicket); targetTicket = null;
  }
  function candidateTarget() {
    if (target && target.width === width && target.height === height) return null;
    const key = width + 'x' + height;
    if (rejectedSize === key) return null;
    let ticket, value;
    try {
      ticket = resources?.require({ renderTargetDeclaredBytes: width * height * 8 },
        'Space post RGBA8 color plus unsigned-int depth texture; old/new replacement peak', 0);
      value = new T.WebGLRenderTarget(width, height, { minFilter: T.LinearFilter, magFilter: T.LinearFilter,
        format: T.RGBAFormat, type: T.UnsignedByteType, stencilBuffer: false });
      value.depthTexture = new T.DepthTexture(width, height); value.depthTexture.type = T.UnsignedIntType;
      resourceFailure = ''; return { value, ticket };
    } catch (error) {
      value?.dispose(); release(ticket); rejectedSize = key; resourceFailure = error.message; return null;
    }
  }
  function active() { return Object.keys(postSpecs).some(key => Number(params[key] || ctx.services.post?.[key]) > 0); }
  function setParams(next) {
    params = { ...params, ...next };
    for (const [key, spec] of Object.entries(postSpecs)) {
      const value = Number(params[key] || ctx.services.post?.[key]) || 0;
      uniforms['u' + key[0].toUpperCase() + key.slice(1)].value = Math.max(spec.min, Math.min(spec.max, value));
    }
    rejectedSize = '';
    if (!active()) releaseTarget();
  }
  function resize(w, h) {
    if (typeof w === 'object') { h = w.height; w = w.width; }
    const nextWidth = Math.max(1, Math.floor((w || 1) * .5)), nextHeight = Math.max(1, Math.floor((h || 1) * .5));
    if (width !== nextWidth || height !== nextHeight) rejectedSize = '';
    width = nextWidth; height = nextHeight;
  }
  setParams(params);
  return {
    retirementCandidates() { return disposed ? [] : [fixedTicket, targetTicket].filter(Boolean).map(ticket => ticket.resourceId); },
    retryResources() { rejectedSize = ''; resourceFailure = ''; },
    update(frame) { uniforms.uTime.value = params.reduced ? 0 : frame.sceneTime ?? frame.time ?? 0; }, setParams,
    setQuality(q) { profile = q; uniforms.uQuality.value = q.mode === 'low' ? 0 : 1; }, resize,
    render(renderer, world, viewCamera) {
      if (disposed) return;
      if (!active()) { renderer.render(world, viewCamera); return; }
      const candidate = candidateTarget(), drawingTarget = candidate?.value || target;
      if (!drawingTarget) { renderer.render(world, viewCamera); return; }
      uniforms.uScene.value = drawingTarget.texture; uniforms.uDepth.value = drawingTarget.depthTexture;
      uniforms.uPixel.value.set(1 / drawingTarget.width, 1 / drawingTarget.height);
      uniforms.uNear.value = viewCamera.near; uniforms.uFar.value = viewCamera.far;
      uniforms.uFocus.value = Math.max(1, viewCamera.position.length()); uniforms.uQuality.value = profile?.mode === 'low' ? 0 : 1;
      const previousTarget = renderer.getRenderTarget(), previousAuto = renderer.autoClear;
      try {
        renderer.autoClear = true; renderer.setRenderTarget(drawingTarget); renderer.render(world, viewCamera);
        renderer.setRenderTarget(previousTarget); renderer.render(scene, camera);
        if (!fixedSubmitted) { fixedTicket?.commit(); fixedSubmitted = true; }
        if (candidate) {
          candidate.ticket?.commit(); target?.dispose(); release(targetTicket);
          target = candidate.value; targetTicket = candidate.ticket;
        }
      } catch (error) {
        if (candidate) { candidate.value.dispose(); release(candidate.ticket); }
        uniforms.uScene.value = target?.texture || null; uniforms.uDepth.value = target?.depthTexture || null;
        throw error;
      } finally { renderer.setRenderTarget(previousTarget); renderer.autoClear = previousAuto; }
    },
    stats() { return { active: active(), drawCalls: active() && target ? 1 : 0,
      bytes: target ? target.width * target.height * 8 : 0, resourceFailure }; },
    dispose() {
      if (disposed) return; disposed = true; quad.removeFromParent(); releaseTarget();
      ctx.scope.release(material); ctx.scope.release(geometry); release(fixedTicket);
    }
  };
}
