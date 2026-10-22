// SPDX-License-Identifier: MIT
// 封面星球：封面亮度驱动真实浮雕，指针可把玩倾斜，点击在球面打出冲击波，
// 换曲用双纹理交叉淡入；轨道尘埃/细环提供纵深。
import { basicInstance, level, own, qualityDensity, root } from './factories.js';
import { createSpatialResources } from './resources.js';
import { approach, createField, createGlow, createShockPool, createStarfield, faceCamera, TAU } from './scene-field.js';

const coverUv = `
vec2 coverUv(vec3 n){
 float arc=acos(clamp(abs(n.z),0.0,1.0));
 vec2 direction=n.xy/max(length(n.xy),.0001);
 return clamp(.5+direction*arc/2.05,.002,.998);
}`;

const vertex = `
uniform sampler2D uCover,uPrevCover;
uniform float uHasCover,uHasPrev,uMix,uTime,uBass,uMotion,uCharge;
uniform vec3 uPointer,uBurstPoint;
uniform float uPointerAmount,uBurst,uBurstAge;
varying vec3 vNormal,vSurface;
varying float vRelief,vGlow;
${coverUv}
void main(){
 vec3 n=normalize(position);
 vec2 uv=coverUv(n);
 float lumCur=uHasCover>.5?dot(textureLod(uCover,uv,4.0).rgb,vec3(.299,.587,.114)):.5;
 float lumPrev=uHasPrev>.5?dot(textureLod(uPrevCover,uv,4.0).rgb,vec3(.299,.587,.114)):lumCur;
 float lum=mix(lumPrev,lumCur,uMix);
 float relief=(lum-.5)*.16;
 relief+=sin(n.y*8.0+uTime*.3)*cos(n.x*6.0-uTime*.2)*uBass*.028;
 vec3 target=normalize(uPointer+vec3(0.0,0.0,.0001));
 float ang=1.0-dot(n,target);
 float well=exp(-ang*20.0)*clamp(uPointerAmount,0.0,1.0);
 relief-=well*.07;
 vec3 burstDir=normalize(uBurstPoint+vec3(0.0,0.0,.0001));
 float bang=1.0-dot(n,burstDir);
 float wave=exp(-pow((sqrt(max(0.0,bang))-(1.0-uBurstAge)*2.4)/.09,2.0))*uBurst;
 relief+=wave*.1;
 vec3 p=position+n*relief*(1.0+uCharge*.18);
 vSurface=n; vNormal=normalize(normalMatrix*n); vRelief=relief; vGlow=well+wave;
 gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
}`;

const artwork = `
uniform sampler2D uCover,uPrevCover;
uniform float uHasCover,uHasPrev,uMix;
varying vec3 vNormal,vSurface;
varying float vRelief,vGlow;
${coverUv}
vec3 artAt(vec3 n){
 vec2 uv=coverUv(n);
 vec3 empty=mix(vec3(.025,.06,.08),vec3(.14,.23,.25),uv.y);
 vec3 cur=uHasCover>.5?texture2D(uCover,uv).rgb:vec3(0.0);
 vec3 prev=uHasPrev>.5?texture2D(uPrevCover,uv).rgb:cur;
 return mix(empty,mix(prev,cur,uMix),max(uHasCover,uHasPrev));
}`;
const surface = artwork + `
uniform float uCharge,uBurst;
void main(){
 vec3 n=normalize(vNormal),l=normalize(vec3(-.4,.65,1.0));
 float diffuse=max(0.0,dot(n,l));
 float rim=pow(1.0-max(n.z,0.0),3.0);
 float spec=pow(max(0.0,dot(n,normalize(l+vec3(0,0,1)))),90.0);
 float reliefLight=1.0+clamp(vRelief*2.6,-.24,.3);
 vec3 c=artAt(normalize(vSurface))*(.56+.44*diffuse)*reliefLight;
 c+=vec3(.8,.92,1.0)*spec*(.18+vGlow*.45);
 c+=mix(artAt(normalize(vSurface)),vec3(.52,.75,.8),.4)*rim*(.18+vGlow*.35);
 c+=vec3(.72,.92,1.0)*vGlow*.18;
 c*=1.0+uCharge*.12+uBurst*.05;
 gl_FragColor=vec4(c,1.0);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`;
const atmosphere = artwork + `
uniform float uCharge,uBurst;
void main(){
 float edge=pow(1.0-abs(normalize(vNormal).z),4.0);
 gl_FragColor=vec4(mix(artAt(normalize(vSurface)),vec3(.52,.78,.85),.3),edge*(.18+uCharge*.12+uBurst*.07));
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`;

export function createCoverSphere(ctx) {
  const T = ctx.THREE, group = root(ctx), globe = new T.Group(); group.add(globe);
  const resources = ctx.services.spatialResources || createSpatialResources(T), local = !ctx.services.spatialResources;
  const field = createField(ctx, globe, { depth: 0, radius: 3.0 });
  const uniforms = { ...field.uniforms, uCover: { value: null }, uPrevCover: { value: null }, uHasCover: { value: 0 }, uHasPrev: { value: 0 },
    uMix: { value: 1 }, uTime: { value: 0 }, uBass: { value: 0 }, uMotion: { value: .6 } };
  const geometry = own(ctx, new T.SphereGeometry(3.2, 96, 64));
  const surfaceMesh = new T.Mesh(geometry, own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: vertex, fragmentShader: surface })));
  globe.add(surfaceMesh);
  const shell = new T.Mesh(own(ctx, new T.SphereGeometry(3.26, 48, 32)), own(ctx, new T.ShaderMaterial({
    uniforms, vertexShader: vertex, fragmentShader: atmosphere, side: T.BackSide, transparent: true, depthWrite: false
  }))); globe.add(shell);

  const count = 10000, positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const y = 1 - 2 * (i + .5) / count, r = Math.sqrt(1 - y * y), a = i * 2.39996323;
    positions.set([Math.cos(a) * r * 3.207, y * 3.207, Math.sin(a) * r * 3.207], i * 3);
  }
  const grains = own(ctx, new T.BufferGeometry()); grains.setAttribute('position', new T.BufferAttribute(positions, 3));
  const grainsMaterial = own(ctx, new T.PointsMaterial({ color: 0xe4f5f0, size: .012, transparent: true, opacity: .13, depthWrite: false }));
  globe.add(new T.Points(grains, grainsMaterial));

  const orbitPositions = [];
  for (let i = 0; i < 192; i++) { const a = i / 192 * TAU; orbitPositions.push(Math.cos(a) * 4.25, 0, Math.sin(a) * 4.25); }
  const orbit = new T.LineLoop(own(ctx, new T.BufferGeometry().setFromPoints(orbitPositions.map((v, i) => i % 3 === 0 ? new T.Vector3(v, orbitPositions[i + 1], orbitPositions[i + 2]) : null).filter(Boolean))),
    own(ctx, new T.LineBasicMaterial({ color: 0x8fe8ff, transparent: true, opacity: .16, depthWrite: false, blending: T.AdditiveBlending })));
  orbit.rotation.set(.7, 0, .25); group.add(orbit);
  const stars = createStarfield(ctx, group, { count: 1300, near: 7, far: 30, palette: [0xa8e8ff, 0xffd0e0, 0xffe1b6], size: [.5, 1.8], opacity: .65 });
  const aura = createGlow(ctx, group, { color: 0x3bb6d8, opacity: .15, size: 13, renderOrder: -4 });
  aura.mesh.position.z = -2.5;
  const counter = createGlow(ctx, group, { color: 0x7a355c, opacity: .1, size: 8, renderOrder: -3 });
  counter.mesh.position.set(2.6, -1.5, -2.1);
  const cursor = createGlow(ctx, globe, { color: 0xbff4ff, opacity: 0, size: 1.6, renderOrder: 8 });
  const impact = createGlow(ctx, globe, { color: 0x9ff2ff, opacity: 0, size: 1.8, renderOrder: 7 });
  const shock = createShockPool(ctx, globe, { count: 6, duration: 1.05 });
  const parallax = new T.Vector2(), spawnQuat = new T.Quaternion(), normal = new T.Vector3();
  let profile = ctx.quality, params = { ...ctx.params }, aspect = 16 / 9, entry = null, prev = null, key = '', fade = 1, disposed = false;
  let spin = 0, spinVel = 0;

  function cleanup() { if (disposed) return; disposed = true; resources.cover.release(entry); resources.cover.release(prev); if (local) resources.dispose(); }
  ctx.scope.defer(cleanup);
  function density() { grains.setDrawRange(0, Math.floor(count * qualityDensity(profile) * (params.density ?? 1))); stars.setDensity(qualityDensity(profile) * (params.density ?? 1)); }
  density();
  return basicInstance(group, params, profile, {
    update(frame, p) {
      const reduced = !!frame.reduced, dt = reduced ? 0 : Math.max(0, Math.min(.05, Number(frame.dt) || 0));
      const time = (frame.sceneTime ?? frame.time ?? 0) * (p.speed ?? .6);
      field.update(frame, (p.pointerStrength ?? 1) * .9);
      const source = ctx.services.coverUrl, url = (typeof source === 'function' ? source() : source) || frame.coverUrl || '';
      if (url !== key) {
        key = url;
        if (prev) { resources.cover.release(prev); prev = null; }
        if (entry) prev = entry;
        entry = resources.cover.acquire(url, ctx.signal);
        fade = reduced || !prev ? 1 : 0;
      }
      if (reduced) { fade = 1; if (prev) { resources.cover.release(prev); prev = null; } }
      else if (prev && entry?.texture) fade = Math.min(1, fade + dt / .65);
      else if (!prev) fade = 1;
      if (prev && fade >= 1) { resources.cover.release(prev); prev = null; }
      uniforms.uCover.value = entry?.texture || null; uniforms.uHasCover.value = entry?.texture ? 1 : 0;
      uniforms.uPrevCover.value = prev?.texture || null; uniforms.uHasPrev.value = prev?.texture ? 1 : 0; uniforms.uMix.value = fade;
      uniforms.uTime.value = time; uniforms.uBass.value = level(frame, 'bass') * (p.reactivity ?? .7); uniforms.uMotion.value = p.speed ?? .6;
      const pointer = frame.pointer, active = !reduced && pointer?.active;
      if (reduced) { parallax.set(0, 0); spin = 0; spinVel = 0; }
      else {
        parallax.x += ((active ? pointer.x : 0) - parallax.x) * approach(dt, .3);
        parallax.y += ((active ? pointer.y : 0) - parallax.y) * approach(dt, .3);
        spin += spinVel * dt; spinVel *= Math.exp(-dt / .85);
        const click = pointer?.click;
        if (field.takeClick()) {
          spinVel += (click?.x || 0) * .7;
          normal.copy(field.uniforms.uBurstPoint.value).normalize();
          if (normal.lengthSq() < .001) normal.set(0, 0, 1);
          spawnQuat.setFromUnitVectors(new T.Vector3(0, 0, 1), normal);
          shock.spawn(normal.clone().multiplyScalar(3.24), spawnQuat, 2.4 + field.charge * 1.4, 0xffd7a0);
        }
      }
      globe.rotation.set(Math.sin(time * .16) * .03 + parallax.y * .24, Math.sin(time * .12) * .18 + parallax.x * .46 + spin, Math.sin(time * .09) * .02);
      const breath = 1 + Math.sin(time * .7) * .003 + level(frame, 'bass') * .012 * (p.reactivity ?? .7);
      globe.scale.setScalar(breath * Math.min(1, aspect / .95)); group.scale.setScalar(p.scale ?? 1);
      orbit.rotation.z = .25 + (reduced ? 0 : time * .03);
      stars.uniforms.uTime.value = time;
      const amount = field.uniforms.uPointerAmount.value, burst = field.uniforms.uBurst.value;
      cursor.set(undefined, amount * (.4 + field.charge * .4), 1.5 + field.charge * .9);
      if (amount > 0) { cursor.mesh.position.copy(field.uniforms.uPointer.value); faceCamera(cursor.mesh, ctx.camera); }
      if (burst > .01) {
        normal.copy(field.uniforms.uBurstPoint.value).normalize(); if (normal.lengthSq() < .001) normal.set(0, 0, 1);
        impact.mesh.position.copy(normal).multiplyScalar(3.27);
        impact.set(undefined, burst * .75, 1.5 + burst * 1.4);
        faceCamera(impact.mesh, ctx.camera);
      } else impact.set(undefined, 0, 1);
      shock.update(dt, reduced);
    },
    resize(w, h) { aspect = w / Math.max(1, h); }, params(next) { params = next; density(); }, quality(next) { profile = next; density(); },
    dispose: cleanup, stats: () => ({ covers: entry?.texture ? 1 : 0, particles: grains.drawRange.count, drawCalls: 9, triangles: 15168 })
  });
}
