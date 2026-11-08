// SPDX-License-Identifier: MIT
import { basicInstance, level, own, root } from './factories.js';
import { createSpatialResources } from './resources.js';
import { createParticlePointer, particleNoiseShader, particlePointerShader } from './particle-pointer.js';

const vertex = `
attribute vec2 aCover;
uniform sampler2D uCover,uPrevious;
uniform float uHasCover,uMix,uTime,uBass,uMid,uTreble,uRelief,uPointSize,uFocal,uSpacing;
varying vec3 vColor;varying float vLight;
${particleNoiseShader}
${particlePointerShader}
void main(){
 vec3 fallback=mix(vec3(.09,.32,.36),vec3(.84,.36,.48),aCover.x);
 fallback=mix(fallback,vec3(.83,.78,.59),smoothstep(.1,1.0,aCover.y)*.6);
 vec3 art=mix(texture2D(uPrevious,aCover).rgb,texture2D(uCover,aCover).rgb,uMix);
 vColor=mix(fallback,art,uHasCover);
 float luminance=dot(vColor,vec3(.2126,.7152,.0722));
 vec3 p=position;
 float broad=particleNoise(vec3(p.xy*.52,uTime*.32));
 float detail=particleNoise(vec3(p.xy*1.65,uTime*.57));
 p.z+=(luminance-.45)*uRelief*.22;
 p.z+=(broad*uBass*.42+detail*uMid*.24+sin(p.x*7.0+p.y*6.0+uTime*2.1)*uTreble*.055)*uRelief;
 vec3 deformed=indentParticle(p);
 float dent=dot(p-deformed,uPointerNormal);
 p=deformed;
 vLight=1.0-dent*.16+(detail*uMid)*.04;
 vec4 mv=modelViewMatrix*vec4(p,1.0);
 // Cover-sized spacing keeps a legible grid at every geometry and DPR tier.
 gl_PointSize=clamp(uSpacing*uFocal*uPointSize*length(modelViewMatrix[0].xyz)/max(.5,-mv.z),.8,11.0);
 gl_Position=projectionMatrix*mv;
}`;
const fragment = `
varying vec3 vColor;varying float vLight;
void main(){
 float r=length(gl_PointCoord-.5)*2.0;if(r>1.0)discard;
 float alpha=1.0-smoothstep(.64,1.0,r);
 gl_FragColor=vec4(vColor*vLight,alpha*.98);
 #include <colorspace_fragment>
}`;

const coverMaxGrid = 192;
export function coverParticlesResourcePlan() {
  const arrayBytes = coverMaxGrid * coverMaxGrid * 5 * 4;
  return { ownedCpuBytes: arrayBytes + 3 * 8, bufferDeclaredBytes: arrayBytes };
}
export function createCoverParticles(ctx) {
  const T = ctx.THREE, group = root(ctx), sheet = new T.Group(); group.add(sheet);
  const maxGrid = coverMaxGrid, declared = coverParticlesResourcePlan(), arrayBytes = declared.bufferDeclaredBytes;
  const plan = ctx.scope.bufferPlan(declared.ownedCpuBytes, arrayBytes, 'Space authored cover particle position/UV arrays');
  const positions = new Float32Array(maxGrid * maxGrid * 3), uvs = new Float32Array(maxGrid * maxGrid * 2);
  plan.cpuReady(arrayBytes);
  const geometry = own(ctx, new T.BufferGeometry());
  geometry.setAttribute('position', plan.upload(new T.BufferAttribute(positions, 3)));
  geometry.setAttribute('aCover', plan.upload(new T.BufferAttribute(uvs, 2)));
  const pointer = createParticlePointer(ctx, sheet, { surface: true, radius: 1.15 });
  const uniforms = { ...pointer.uniforms,
    uCover: { value: null }, uPrevious: { value: null }, uHasCover: { value: 0 }, uMix: { value: 1 },
    uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
    uRelief: { value: 1 }, uPointSize: { value: 1 }, uSpacing: { value: 8 / maxGrid }, uFocal: { value: 700 }
  };
  const material = own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: vertex, fragmentShader: fragment,
    transparent: true, depthWrite: true, blending: T.NormalBlending }));
  const points = new T.Points(geometry, material); points.frustumCulled = false; sheet.add(points);
  const resources = ctx.services.spatialResources || createSpatialResources(T), local = !ctx.services.spatialResources;
  let entry = null, previous = null, key = '', profile = ctx.quality, params = ctx.params;
  let grid = 0, aspect = 16 / 9, height = 900, disposed = false;
  function density() {
    const tier = { low: 96, medium: 144, high: maxGrid }[profile?.mode] || 144;
    const next = Math.max(32, Math.floor(tier * Math.sqrt(params.density ?? 1)));
    if (next === grid) return;
    grid = next;
    for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) {
      const i = y * grid + x, u = (x + .5) / grid, v = (y + .5) / grid;
      positions.set([(u - .5) * 8, (v - .5) * 8, Math.sin(u * 6.28) * .012], i * 3);
      uvs.set([u, v], i * 2);
    }
    geometry.attributes.position.needsUpdate = true; geometry.attributes.aCover.needsUpdate = true;
    geometry.setDrawRange(0, grid * grid); uniforms.uSpacing.value = 8 / grid;
  }
  function cleanup() {
    if (disposed) return; disposed = true;
    resources.cover.release(entry); resources.cover.release(previous);
    if (local) resources.dispose();
  }
  ctx.scope.defer(cleanup); density();
  return basicInstance(group, params, profile, {
    update(frame, p) {
      const source = ctx.services.coverUrl, url = (typeof source === 'function' ? source() : source) || frame.coverUrl || '';
      if (url !== key) {
        const lastGood = entry?.texture ? entry : previous;
        if (previous !== lastGood) resources.cover.release(previous);
        if (entry !== lastGood) resources.cover.release(entry);
        previous = lastGood;
        key = url; entry = resources.cover.acquire(url, ctx.signal); uniforms.uMix.value = 0;
        if (!url) { resources.cover.release(previous); previous = null; }
      }
      const texture = entry?.texture || previous?.texture;
      uniforms.uCover.value = texture || null;
      uniforms.uPrevious.value = previous?.texture || texture || null;
      uniforms.uHasCover.value = texture ? 1 : 0;
      if (entry?.texture) {
        // P0-02：转场补间冻结看 motionActive；旧宿主回退 playing 语义。
        const motionAllowed = frame.motionActive === undefined ? frame.playing !== false : !!frame.motionActive;
        uniforms.uMix.value = !motionAllowed || frame.reduced || !previous ? 1 : Math.min(1, uniforms.uMix.value + (frame.dt || 0) * 3);
        if (uniforms.uMix.value === 1 && previous) {
          resources.cover.release(previous); previous = null; uniforms.uPrevious.value = texture;
        }
      }
      const time = (frame.sceneTime ?? frame.time ?? 0) * (p.speed ?? .6);
      uniforms.uTime.value = time;
      uniforms.uBass.value = level(frame, 'bass') * (p.reactivity ?? .7);
      uniforms.uMid.value = level(frame, 'mid') * (p.reactivity ?? .7);
      uniforms.uTreble.value = level(frame, 'treble') * (p.reactivity ?? .7);
      uniforms.uRelief.value = p.relief ?? 1; uniforms.uPointSize.value = p.pointSize ?? 1;
      uniforms.uFocal.value = height * (ctx.renderer?.getPixelRatio() || 1) * ctx.camera.projectionMatrix.elements[5] * .5;
      // Keep the whole square visible on portrait without changing the user's camera.
      sheet.scale.setScalar(Math.min(1, aspect / 1.08));
      sheet.rotation.set(Math.sin(time * .15) * .018, Math.sin(time * .12) * .035, 0);
      group.scale.setScalar((p.scale ?? 1) * (p.cue === 'chorus' ? 1.08 : 1));
      group.rotation.set(p.cue === 'bridge' ? .06 : 0, 0, p.director ? Math.sin((frame.sceneTime ?? 0) * .08) * .04 : 0);
      pointer.update(frame, p.pointerStrength ?? 1);
    },
    resize(w, h) { aspect = w / Math.max(1, h); height = h; },
    params(p) { params = p; density(); }, quality(q) { profile = q; density(); }, dispose: cleanup,
    stats: () => ({ particles: grid * grid, drawCalls: 1, covers: Number(!!entry?.texture) + Number(!!previous?.texture) })
  });
}
