// SPDX-License-Identifier: MIT
// 棱镜星系：四条分色旋臂、核球辉光、星晕与棱镜碎片；指针制造切向涡旋，
// 点击在盘面炸出棱镜新星环。
import { basicInstance, own, qualityDensity, root, seed } from './factories.js';
import { particlePointerShader } from './particle-pointer.js';
import { createField, createGlow, createShockPool, createSky, createStarfield, faceCamera, TAU } from './scene-field.js';

const ARMS = 20000, CORE = 1200, SHARDS = 8;

const armShader = `
attribute float aArm,aR,aSeed,aSize; attribute vec3 aJitter;
uniform float uTime,uBass,uMid,uTreble,uMotion,uResponse,uSize,uPixel,uHeight,uCharge,uBurst,uBurstAge;
uniform vec3 uColorA,uColorB,uColorC,uColorD,uBurstPoint;
varying vec3 vColor; varying float vAlpha;
${particlePointerShader}
const float TAU=6.2831853;
void main(){
 float t=uTime*uMotion;
 float r=pow(aR,.52)*10.0;
 float arm=aArm*TAU*.25;
 float spread=(aSeed-.5)*(.10+aR*.52);
 float theta=arm+r*.62+spread+t*(.05+.24/(.75+r))+sin(uTime*.7+aSeed*6.2831853)*clamp(uPointerAmount,0.0,1.0)*.05*aR;
 float y=aJitter.y*(.15+(1.0-aR)*.75)+sin(r*.66-t*.22+aArm)*.07;
 r*=1.0+uBass*uResponse*.035;
 vec3 p=vec3(cos(theta)*r,y,sin(theta)*r)+vec3(aJitter.x,0.0,aJitter.z)*(.12+aR*.35);
 vec3 dp=p-uPointer;
 float d2=dot(dp.xz,dp.xz);
 if(d2!=d2||d2>100000.0){dp=vec3(0.0);d2=0.0;}
 float reach=max(.001,uPointerRadius*3.2);
 vec2 radial=dp.xz/max(.001,sqrt(d2));
 float pull=exp(-d2/(reach*reach))*clamp(uPointerAmount,0.0,1.0);
 p.xz+=vec2(-radial.y,radial.x)*pull*.22; p.y+=pull*.18;
 vec2 burstDelta=p.xz-uBurstPoint.xz;
 float bd2=dot(burstDelta,burstDelta);
 if(bd2!=bd2){burstDelta=vec2(0.0);bd2=0.0;}
 float ring=exp(-pow((sqrt(bd2)-(1.0-uBurstAge)*7.0)/.5,2.0))*max(0.0,min(1.0,uBurst));
 p.y+=ring*.45;
 vec4 mv=modelViewMatrix*vec4(p,1.0); gl_Position=projectionMatrix*mv;
 vec3 base=aArm<.5?uColorA:aArm<1.5?uColorB:aArm<2.5?uColorC:uColorD;
 vec3 c=mix(base,vec3(1.0,.95,.82),smoothstep(.5,0.0,aR)*.5);
 c+=vec3(.4,.2,.08)*ring;
 c*=.8+uTreble*uResponse*.3+pull*.55+uCharge*.2;
 float lane=.72+.28*smoothstep(-.3,.45,sin(theta*3.0+r*8.0+aSeed*2.0));
 vColor=c;
 vAlpha=(.3+.62*(1.0-smoothstep(.6,1.0,aR)))*lane+pull*.3+ring*.4;
 float size=uSize*uPixel*(.65+aSize*.95)*uHeight*.035/max(2.0,-mv.z);
 gl_PointSize=clamp(size*(1.0+pull*.7),1.0,5.0);
}`;

const coreShader = `
attribute vec3 aDir; attribute float aSeed;
uniform float uTime,uBass,uMid,uTreble,uMotion,uResponse,uSize,uPixel,uHeight,uCharge,uBurst,uBurstAge;
uniform vec3 uColorA,uColorC;
varying vec3 vColor; varying float vAlpha;
${particlePointerShader}
void main(){
 float r=pow(aSeed,.55)*1.15*(1.0+uBass*uResponse*.08);
 vec3 p=normalize(aDir)*r;
 p*=1.0+uBurst*.12*(1.0-uBurstAge);
 vec4 mv=modelViewMatrix*vec4(p,1.0); gl_Position=projectionMatrix*mv;
 float tw=.7+.3*sin(uTime*.8+aSeed*40.0);
 vColor=mix(uColorC,uColorA,.25+uBass*.3)*tw*(1.0+uCharge*.3);
 vAlpha=.5+uBass*.3;
 gl_PointSize=clamp(uSize*uPixel*(.8+aSeed*1.6)*uHeight*.045/max(2.0,-mv.z),1.0,6.0);
}`;

const pointFragment = `varying vec3 vColor; varying float vAlpha;
void main(){ float d=length(gl_PointCoord-.5); if(d>.5) discard;
 float core=1.0-smoothstep(.05,.35,d), halo=exp(-d*d*17.0)*.32;
 gl_FragColor=vec4(vColor*(.9+core*.6),(core+halo)*vAlpha);
 #include <colorspace_fragment>
}`;

export function createPrismGalaxy(ctx) {
  const T = ctx.THREE, group = root(ctx), world = new T.Group(); group.add(world);
  const field = createField(ctx, world, { depth: 0, radius: 2.4 });
  const uniforms = { ...field.uniforms, uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
    uMotion: { value: .6 }, uResponse: { value: .7 }, uSize: { value: 1 }, uPixel: { value: 1 }, uHeight: { value: 720 },
    uColorA: { value: new T.Color(0x7fe8ff) }, uColorB: { value: new T.Color(0xff7fbe) },
    uColorC: { value: new T.Color(0xffd08a) }, uColorD: { value: new T.Color(0xa98cff) } };

  const arms = new Float32Array(ARMS), radius = new Float32Array(ARMS), seeds = new Float32Array(ARMS), sizes = new Float32Array(ARMS), jitter = new Float32Array(ARMS * 3);
  for (let i = 0; i < ARMS; i++) {
    arms[i] = i % 4; radius[i] = seed(i, 1); seeds[i] = seed(i, 2); sizes[i] = seed(i, 3);
    jitter.set([(seed(i, 4) - .5) * 2, (seed(i, 5) - .5) * 1.2, (seed(i, 6) - .5) * 2], i * 3);
  }
  const armGeometry = own(ctx, new T.BufferGeometry());
  armGeometry.setAttribute('position', new T.BufferAttribute(new Float32Array(ARMS * 3), 3));
  armGeometry.setAttribute('aArm', new T.BufferAttribute(arms, 1));
  armGeometry.setAttribute('aR', new T.BufferAttribute(radius, 1));
  armGeometry.setAttribute('aSeed', new T.BufferAttribute(seeds, 1));
  armGeometry.setAttribute('aSize', new T.BufferAttribute(sizes, 1));
  armGeometry.setAttribute('aJitter', new T.BufferAttribute(jitter, 3));
  const armPoints = new T.Points(armGeometry, own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: armShader, fragmentShader: pointFragment,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending })));
  armPoints.frustumCulled = false; world.add(armPoints);

  const dirs = new Float32Array(CORE * 3), coreSeeds = new Float32Array(CORE);
  for (let i = 0; i < CORE; i++) {
    const y = 1 - seed(i, 7) * 2, a = seed(i, 8) * TAU, r = Math.sqrt(Math.max(0, 1 - y * y));
    dirs.set([Math.cos(a) * r, y * .55, Math.sin(a) * r], i * 3); coreSeeds[i] = seed(i, 9);
  }
  const coreGeometry = own(ctx, new T.BufferGeometry());
  coreGeometry.setAttribute('position', new T.BufferAttribute(new Float32Array(CORE * 3), 3));
  coreGeometry.setAttribute('aDir', new T.BufferAttribute(dirs, 3));
  coreGeometry.setAttribute('aSeed', new T.BufferAttribute(coreSeeds, 1));
  const core = new T.Points(coreGeometry, own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: coreShader, fragmentShader: pointFragment,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending })));
  core.frustumCulled = false; world.add(core);

  const shardGeometry = own(ctx, new T.OctahedronGeometry(.13, 0));
  const shardMaterial = own(ctx, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .3, depthWrite: false, blending: T.AdditiveBlending }));
  const shards = new T.InstancedMesh(shardGeometry, shardMaterial, SHARDS); shards.frustumCulled = false; world.add(shards);
  const shardObject = new T.Object3D(), shardColor = new T.Color(), shardTints = [0x8ff0ff, 0xffa8d4, 0xffd9a1, 0xb9a8ff];
  for (let i = 0; i < SHARDS; i++) { shardColor.set(shardTints[i % shardTints.length]); shards.setColorAt(i, shardColor); }
  if (shards.instanceColor) shards.instanceColor.needsUpdate = true;

  const guidePositions = [];
  for (let ring = 0; ring < 3; ring++) {
    const tilt = .08 + ring * .07, radius = 5.2 + ring * 1.9, ecc = .92 - ring * .04;
    for (let i = 0; i < 128; i++) {
      const a0 = i / 128 * TAU, a1 = (i + 1) / 128 * TAU;
      const p0 = [Math.cos(a0) * radius, Math.sin(a0) * radius * tilt, Math.sin(a0) * radius * ecc];
      const p1 = [Math.cos(a1) * radius, Math.sin(a1) * radius * tilt, Math.sin(a1) * radius * ecc];
      guidePositions.push(...p0, ...p1);
    }
  }
  const guideGeometry = own(ctx, new T.BufferGeometry());
  guideGeometry.setAttribute('position', new T.Float32BufferAttribute(guidePositions, 3));
  const guideMaterial = own(ctx, new T.LineBasicMaterial({ color: 0x7f9fe8, transparent: true, opacity: .13, depthWrite: false, blending: T.AdditiveBlending }));
  const guides = new T.LineSegments(guideGeometry, guideMaterial); guides.frustumCulled = false; world.add(guides);

  const sky = createSky(ctx, world, { top: 0x05050f, bottom: 0x0d0a20, glow: 0x4b2a6b, opacity: .95 });
  const stars = createStarfield(ctx, world, { count: 1900, near: 15, far: 60, palette: [0xbfe9ff, 0xffd7b0, 0xd0b6ff], size: [.5, 2.2], opacity: .8 });
  const halo = createGlow(ctx, world, { color: 0x6f8fff, opacity: .13, size: 22, renderOrder: -7 });
  const coreGlow = createGlow(ctx, world, { color: 0xffe2b0, opacity: .46, size: 3.0, renderOrder: -2 });
  const coreHalo = createGlow(ctx, world, { color: 0x9b7cff, opacity: .18, size: 8.5, renderOrder: -3 });
  const cursor = createGlow(ctx, world, { color: 0xbfefff, opacity: 0, size: 1.5, renderOrder: 8 });
  const shock = createShockPool(ctx, world, { count: 6, duration: 1.2 });
  const parallax = new T.Vector2(), flatQuat = new T.Quaternion().setFromEuler(new T.Euler(-Math.PI / 2, 0, 0));
  const spawnPosition = new T.Vector3();

  let profile = ctx.quality, params = { ...ctx.params };
  function density() {
    const fraction = qualityDensity(profile) * (params.density ?? 1);
    armGeometry.setDrawRange(0, Math.floor(ARMS * fraction));
    coreGeometry.setDrawRange(0, Math.floor(CORE * fraction));
    guideGeometry.setDrawRange(0, Math.floor(guidePositions.length / 3 / 2 * fraction) * 2);
    stars.setDensity(fraction); shards.count = Math.max(4, Math.floor(SHARDS * fraction));
  }
  density();
  return basicInstance(group, params, profile, {
    update(frame, p) {
      const reduced = !!frame.reduced, time = Number(frame.time) || 0, dt = reduced ? 0 : Number(frame.dt) || 0;
      field.update(frame, (p.pointerStrength ?? 1) * 1.05);
      uniforms.uTime.value = time;
      uniforms.uBass.value = frame.bands?.bass ?? 0; uniforms.uMid.value = frame.bands?.mid ?? 0; uniforms.uTreble.value = frame.bands?.treble ?? 0;
      uniforms.uMotion.value = p.speed ?? .6; uniforms.uResponse.value = p.reactivity ?? .7;
      uniforms.uSize.value = p.pointSize ?? 1; uniforms.uPixel.value = ctx.renderer?.getPixelRatio() || 1;
      if (reduced) parallax.set(0, 0);
      else if (frame.pointer?.active && Number.isFinite(frame.pointer.x)) parallax.lerp(frame.pointer, 1 - Math.exp(-dt / .38));
      else parallax.lerp({ x: 0, y: 0 }, 1 - Math.exp(-dt / .65));
      world.rotation.set(.08 + parallax.y * -.05, 0, -.05 + parallax.x * .07);
      sky.update(time); stars.uniforms.uTime.value = time;
      const spin = reduced ? 0 : time * .12;
      for (let i = 0; i < shards.count; i++) {
        const r = 4.1 + (i % 4) * 1.6, a = spin * (.5 + (i % 3) * .18) + i * 2.4;
        shardObject.position.set(Math.cos(a) * r, Math.sin(a * 1.7 + i) * 1.1, Math.sin(a) * r * .9);
        shardObject.rotation.set(time * .2 + i, time * .15 + i * .7, i * .4);
        shardObject.scale.setScalar(.5 + (i % 3) * .16 + (reduced ? 0 : Math.sin(time + i) * .04));
        shardObject.updateMatrix(); shards.setMatrixAt(i, shardObject.matrix);
      }
      shards.instanceMatrix.needsUpdate = true;
      const amount = field.uniforms.uPointerAmount.value;
      cursor.set(undefined, amount * (.42 + field.charge * .4), 1.5 + field.charge * .9);
      if (amount > 0) { cursor.mesh.position.copy(field.uniforms.uPointer.value); faceCamera(cursor.mesh, ctx.camera); }
      coreGlow.set(undefined, .34 + field.charge * .18 + (frame.bands?.bass ?? 0) * .16, 2.7 + (frame.bands?.bass ?? 0) * .4);
      if (field.takeClick()) {
        spawnPosition.copy(field.uniforms.uBurstPoint.value); spawnPosition.y = 0;
        shock.spawn(spawnPosition, flatQuat, 4.2 + field.charge * 2.4, 0xffd8a8);
      }
      shock.update(dt, reduced);
    },
    resize(w, h) { uniforms.uHeight.value = h; },
    params(next) { params = next; density(); },
    quality(next) { profile = next; density(); },
    stats: () => ({ particles: armGeometry.drawRange.count + coreGeometry.drawRange.count, drawCalls: 12 })
  });
}
