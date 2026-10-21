// SPDX-License-Identifier: MIT
// 引力星球：有明暗分界的粒子表面、菲涅尔大气、四条倾斜吸积流与两颗卫星；
// 指针在近半球挖出引力井，点击打出表面冲击环。
import { basicInstance, own, qualityDensity, root, seed } from './factories.js';
import { particleNoiseShader, particlePointerShader } from './particle-pointer.js';
import { createField, createGlow, createShockPool, createSky, createStarfield, faceCamera, TAU } from './scene-field.js';

const SURFACE = 18000, RING = 10000;
const ringBases = [
  [1, 0, 0, 0, .04, 1], [1, .12, .05, -.06, .16, 1], [.9, -.16, .1, .1, .2, 1], [1, .03, -.18, .18, .12, 1]
];

const surfaceShader = `
attribute vec3 aDir; attribute float aSeed;
uniform float uTime,uBass,uMid,uTreble,uMotion,uResponse,uSize,uPixel,uHeight,uCharge,uBurst,uBurstAge;
uniform vec3 uColorA,uColorB,uColorC,uColorD,uBurstPoint;
varying vec3 vColor; varying float vAlpha;
${particlePointerShader}
${particleNoiseShader}
void main(){
 vec3 n=normalize(aDir);
 float t=uTime*uMotion;
 float detail=particleNoise(n*3.0+vec3(0.0,t*.12,t*.08));
 float ridge=pow(max(0.0,sin(n.y*34.0+n.x*13.0+t*.6)),12.0);
 float r=3.12+uBass*uResponse*.14+detail*(.05+uTreble*uResponse*.16)+ridge*.035;
 vec3 target=normalize(uPointer+vec3(0.0,0.0,.0001));
 float ang=1.0-dot(n,target);
 float amount=clamp(uPointerAmount,0.0,1.0);
 float well=exp(-ang*22.0)*amount;
 float halo=exp(-pow((sqrt(max(0.0,ang))-.42)/.11,2.0))*amount;
 r-=well*.5; r+=halo*.06;
 vec3 burstDir=normalize(uBurstPoint+vec3(0.0,0.0,.0001));
 float bang=1.0-dot(n,burstDir);
 float wave=1.0-uBurstAge;
 float ring=exp(-pow((sqrt(max(0.0,bang))-wave*2.6)/.09,2.0))*uBurst;
 r+=ring*.2;
 vec3 p=n*r;
 vec4 mv=modelViewMatrix*vec4(p,1.0); gl_Position=projectionMatrix*mv;
 vec3 vn=normalize(normalMatrix*n), vd=normalize(-mv.xyz);
 float rim=pow(1.0-abs(dot(vn,vd)),3.0);
 float light=clamp(dot(n,normalize(vec3(-.85,.35,.28))),0.0,1.0);
 float lit=smoothstep(.02,.92,light);
 vec3 c=mix(uColorD,uColorA,lit);
 c+=uColorB*rim*.35+uColorC*(ring*.9+halo*.5+well*.4);
 c+=uColorC*pow(max(0.0,1.0-abs(light-.44)*2.4),3.0)*.28;
 c*=.82+uBass*uResponse*.35+uCharge*.25;
 vColor=c;
 vAlpha=(.42+light*.46+rim*.2)*(.85+uMid*uResponse*.15);
 float size=uSize*uPixel*(.52+aSeed*.64)*uHeight*.03/max(2.0,-mv.z);
 gl_PointSize=clamp(size*(1.0+ring*.8),1.0,3.6);
}`;

const ringShader = `
attribute float aRing,aAngle,aRadius,aSeed;
uniform float uTime,uBass,uMid,uTreble,uMotion,uResponse,uSize,uPixel,uHeight,uCharge,uBurst,uBurstAge;
uniform vec3 uColorA,uColorB,uColorC,uColorD;
varying vec3 vColor; varying float vAlpha;
${particlePointerShader}
void main(){
 vec3 ex,ey;
 if(aRing<.5){ex=vec3(1,0,0);ey=vec3(0,0,1);}
 else if(aRing<1.5){ex=normalize(vec3(1,.25,.06));ey=normalize(vec3(-.08,.16,1));}
 else if(aRing<2.5){ex=normalize(vec3(.9,-.3,.2));ey=normalize(vec3(.2,.28,1));}
 else {ex=normalize(vec3(1,.05,-.3));ey=normalize(vec3(.3,.2,1));}
 float dir=mod(aRing,2.0)<.5?1.0:-1.0;
 float a=aAngle+uTime*uMotion*(.2+.55/(.8+aRadius))*dir+clamp(uPointerAmount,0.0,1.0)*.08*sin(aSeed*6.2831853+uTime*.4);
 float rad=aRadius*(1.0+sin(a*5.0+uTime*.5)*.02);
 vec3 p=ex*cos(a)*rad+ey*sin(a)*rad*.78+vec3(0.0,(aSeed-.5)*.1,0.0);
 vec3 dp=p-uPointer;
 float reach=max(.001,uPointerRadius);
 float pull=exp(-dot(dp.xz,dp.xz)/(reach*reach*2.6))*clamp(uPointerAmount,0.0,1.0);
 p.xz+=normalize(dp.xz+vec2(1e-4))*pull*.32; p.y+=pull*.2;
 p*=1.0+uBurst*.06*(1.0-uBurstAge);
 vec4 mv=modelViewMatrix*vec4(p,1.0); gl_Position=projectionMatrix*mv;
 float gaps=.3+.7*pow(.5+.5*sin(a*13.0+aSeed*40.0),3.0);
 if(aRing<.5)gaps=.68+.32*pow(.5+.5*sin(a*11.0+aSeed*31.0),2.0);
 vec3 c=aRing<.5?uColorA:aRing<1.5?uColorB:aRing<2.5?uColorC:uColorD;
 c*= .85+uBass*uResponse*.4+gaps*.25;
 vColor=c; vAlpha=gaps*(.58+uMid*uResponse*.25)+pull*.5;
 float size=uSize*uPixel*(.6+aSeed*.75)*uHeight*.032/max(2.0,-mv.z);
 gl_PointSize=clamp(size,1.0,4.0);
}`;

const atmoVertex = `varying vec3 vNormal; varying vec3 vView;
void main(){ vec4 world=modelMatrix*vec4(position,1.0); vNormal=normalize(mat3(modelMatrix)*normal); vView=normalize(cameraPosition-world.xyz);
 gl_Position=projectionMatrix*viewMatrix*world; }`;
const atmoFragment = `uniform vec3 uColorA,uColorB; uniform float uAtmo,uCharge,uBurst; varying vec3 vNormal; varying vec3 vView;
void main(){ float f=pow(1.0-abs(dot(normalize(vNormal),normalize(vView))),3.0);
 float a=f*(.42+uCharge*.22+uBurst*.16)*uAtmo;
 if(a<.002) discard;
 gl_FragColor=vec4(mix(uColorA,uColorB,.18+f*.62),a*1.15);
 #include <colorspace_fragment>
}`;

const pointFragment = `varying vec3 vColor; varying float vAlpha;
void main(){ float d=length(gl_PointCoord-.5); if(d>.5) discard;
 float core=1.0-smoothstep(.05,.35,d), halo=exp(-d*d*16.0)*.32;
 gl_FragColor=vec4(vColor*(.9+core*.6),(core+halo)*vAlpha);
 #include <colorspace_fragment>
}`;

export function createGravitySphere(ctx) {
  const T = ctx.THREE, group = root(ctx), world = new T.Group(); group.add(world);
  const field = createField(ctx, world, { depth: 0, radius: 2.7 });
  const uniforms = { ...field.uniforms, uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
    uMotion: { value: .6 }, uResponse: { value: .7 }, uSize: { value: 1 }, uPixel: { value: 1 }, uHeight: { value: 720 },
    uAtmo: { value: 1 }, uColorA: { value: new T.Color(0x76e6ff) }, uColorB: { value: new T.Color(0xff76b4) },
    uColorC: { value: new T.Color(0xffd28a) }, uColorD: { value: new T.Color(0x101b3a) } };

  const dirs = new Float32Array(SURFACE * 3), seeds = new Float32Array(SURFACE);
  for (let i = 0; i < SURFACE; i++) {
    const y = 1 - seed(i, 1) * 2, a = seed(i, 2) * TAU, r = Math.sqrt(Math.max(0, 1 - y * y));
    dirs.set([Math.cos(a) * r, y, Math.sin(a) * r], i * 3); seeds[i] = seed(i, 3);
  }
  const surfaceGeometry = own(ctx, new T.BufferGeometry());
  surfaceGeometry.setAttribute('position', new T.BufferAttribute(new Float32Array(SURFACE * 3), 3));
  surfaceGeometry.setAttribute('aDir', new T.BufferAttribute(dirs, 3));
  surfaceGeometry.setAttribute('aSeed', new T.BufferAttribute(seeds, 1));
  const surface = new T.Points(surfaceGeometry, own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: surfaceShader, fragmentShader: pointFragment,
    transparent: true, depthWrite: false, blending: T.NormalBlending })));
  surface.frustumCulled = false; world.add(surface);

  const core = new T.Mesh(own(ctx, new T.SphereGeometry(2.97, 48, 32)), own(ctx, new T.MeshBasicMaterial({ color: 0x040810 })));
  world.add(core);
  const atmo = new T.Mesh(own(ctx, new T.SphereGeometry(3.24, 64, 40)), own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: atmoVertex, fragmentShader: atmoFragment,
    transparent: true, depthWrite: false, side: T.FrontSide, blending: T.AdditiveBlending })));
  world.add(atmo);

  const angles = new Float32Array(RING), radii = new Float32Array(RING), rings = new Float32Array(RING), rseeds = new Float32Array(RING);
  for (let i = 0; i < RING; i++) {
    const band = i % 20, ring = band < 14 ? 0 : band < 18 ? 1 : 2;
    rings[i] = ring; angles[i] = seed(i, 4) * TAU;
    radii[i] = (ring === 0 ? 4.2 : ring === 1 ? 5.2 : 6.0) + seed(i, 5) * (ring === 0 ? .7 : .35);
    rseeds[i] = seed(i, 6);
  }
  const ringGeometry = own(ctx, new T.BufferGeometry());
  ringGeometry.setAttribute('position', new T.BufferAttribute(new Float32Array(RING * 3), 3));
  ringGeometry.setAttribute('aRing', new T.BufferAttribute(rings, 1));
  ringGeometry.setAttribute('aAngle', new T.BufferAttribute(angles, 1));
  ringGeometry.setAttribute('aRadius', new T.BufferAttribute(radii, 1));
  ringGeometry.setAttribute('aSeed', new T.BufferAttribute(rseeds, 1));
  const ringPoints = new T.Points(ringGeometry, own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: ringShader, fragmentShader: pointFragment,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending })));
  ringPoints.frustumCulled = false; world.add(ringPoints);

  const guidePositions = [];
  for (let ring = 0; ring < 3; ring++) {
    const b = ringBases[ring], ex = new T.Vector3(b[0], b[1], b[2]).normalize(), ey = new T.Vector3(b[3], b[4], b[5]).normalize();
    const radius = ring === 0 ? 4.55 : ring === 1 ? 5.4 : 6.2;
    for (let i = 0; i < 128; i++) {
      const a0 = i / 128 * TAU, a1 = (i + 1) / 128 * TAU;
      const p0 = ex.clone().multiplyScalar(Math.cos(a0) * radius).add(ey.clone().multiplyScalar(Math.sin(a0) * radius * .78));
      const p1 = ex.clone().multiplyScalar(Math.cos(a1) * radius).add(ey.clone().multiplyScalar(Math.sin(a1) * radius * .78));
      guidePositions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    }
  }
  const guideGeometry = own(ctx, new T.BufferGeometry());
  guideGeometry.setAttribute('position', new T.Float32BufferAttribute(guidePositions, 3));
  const guideMaterial = own(ctx, new T.LineBasicMaterial({ color: 0x4fa8d8, transparent: true, opacity: .16, depthWrite: false, blending: T.AdditiveBlending }));
  const guides = new T.LineSegments(guideGeometry, guideMaterial); guides.frustumCulled = false; world.add(guides);

  const sky = createSky(ctx, world, { top: 0x05070f, bottom: 0x081423, glow: 0x1b4f72, opacity: .92 });
  const stars = createStarfield(ctx, world, { count: 1600, near: 16, far: 58, palette: [0xa8ddff, 0xffe3c2, 0xb4a6ff], size: [.5, 2.0], opacity: .8 });
  const aura = createGlow(ctx, world, { color: 0x1c6f95, opacity: .22, size: 9.5, renderOrder: -6 });
  aura.mesh.position.z = -1.6;
  const cursor = createGlow(ctx, world, { color: 0x9ef2ff, opacity: 0, size: 1.6, renderOrder: 8 });
  const moonA = createGlow(ctx, world, { color: 0xffd38a, opacity: .9, size: .34, renderOrder: 3 });
  const moonB = createGlow(ctx, world, { color: 0x8fe9ff, opacity: .8, size: .26, renderOrder: 3 });
  const shock = createShockPool(ctx, world, { count: 6, duration: 1.05 });
  const parallax = new T.Vector2(), spawnQuat = new T.Quaternion(), parentQuat = new T.Quaternion(), cameraQuat = new T.Quaternion();
  const burstNormal = new T.Vector3(0, 0, 1), outward = new T.Vector3();

  let profile = ctx.quality, params = { ...ctx.params };
  function density() {
    const fraction = qualityDensity(profile) * (params.density ?? 1);
    surfaceGeometry.setDrawRange(0, Math.floor(SURFACE * fraction));
    ringGeometry.setDrawRange(0, Math.floor(RING * fraction));
    guideGeometry.setDrawRange(0, Math.floor(guidePositions.length / 3 / 2 * fraction) * 2);
    stars.setDensity(fraction);
  }
  density();
  return basicInstance(group, params, profile, {
    update(frame, p) {
      const reduced = !!frame.reduced, time = Number(frame.time) || 0, dt = reduced ? 0 : Number(frame.dt) || 0;
      field.update(frame, (p.pointerStrength ?? 1) * .95);
      uniforms.uTime.value = time;
      uniforms.uBass.value = frame.bands?.bass ?? 0; uniforms.uMid.value = frame.bands?.mid ?? 0; uniforms.uTreble.value = frame.bands?.treble ?? 0;
      uniforms.uMotion.value = p.speed ?? .6; uniforms.uResponse.value = p.reactivity ?? .7;
      uniforms.uSize.value = p.pointSize ?? 1; uniforms.uPixel.value = ctx.renderer?.getPixelRatio() || 1;
      uniforms.uAtmo.value = .55 + (p.reactivity ?? .7) * .28;
      if (reduced) parallax.set(0, 0);
      else if (frame.pointer?.active && Number.isFinite(frame.pointer.x)) parallax.lerp(frame.pointer, 1 - Math.exp(-dt / .34));
      else parallax.lerp({ x: 0, y: 0 }, 1 - Math.exp(-dt / .6));
      world.rotation.set(parallax.y * -.06, parallax.x * .12, parallax.x * .02);
      guideMaterial.opacity = .12 + (frame.bands?.mid ?? 0) * .08;
      sky.update(time); stars.uniforms.uTime.value = time;
      const amount = field.uniforms.uPointerAmount.value;
      cursor.set(undefined, amount * (.45 + field.charge * .35), 1.4 + field.charge * .9 + amount * .2);
      if (amount > 0) { cursor.mesh.position.copy(field.uniforms.uPointer.value); faceCamera(cursor.mesh, ctx.camera); }
      const moonTime = reduced ? 0 : time * .18;
      moonA.mesh.position.set(Math.cos(moonTime) * 5.6, Math.sin(moonTime * .7) * 1.5 + .4, Math.sin(moonTime) * 5.6);
      moonB.mesh.position.set(Math.cos(-moonTime * .72 + 2.1) * 7.1, Math.sin(moonTime * .5 + 1.2) * 2.1 - .3, Math.sin(-moonTime * .72 + 2.1) * 7.1);
      faceCamera(moonA.mesh, ctx.camera); faceCamera(moonB.mesh, ctx.camera);
      if (field.takeClick()) {
        outward.copy(field.uniforms.uBurstPoint.value).normalize();
        if (outward.lengthSq() < .001) outward.set(0, 0, 1);
        burstNormal.copy(outward);
        spawnQuat.setFromUnitVectors(new T.Vector3(0, 0, 1), burstNormal);
        parentQuat.copy(world.getWorldQuaternion(new T.Quaternion())).invert();
        spawnQuat.premultiply(parentQuat);
        shock.spawn(outward.clone().multiplyScalar(3.22), spawnQuat, 2.0 + field.charge * 1.8, 0xffd38a);
      }
      shock.update(dt, reduced);
    },
    resize(w, h) { uniforms.uHeight.value = h; },
    params(next) { params = next; density(); },
    quality(next) { profile = next; density(); },
    stats: () => ({ particles: surfaceGeometry.drawRange.count + ringGeometry.drawRange.count, drawCalls: 13 })
  });
}
