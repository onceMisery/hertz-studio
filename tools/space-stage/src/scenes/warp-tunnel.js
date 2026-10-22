// SPDX-License-Identifier: MIT
// 折跃隧道：真实纵深光轨 + 环形闸门 + 灭点耀斑；指针弯曲隧道轴，点击/长按触发折跃。
import { basicInstance, own, qualityDensity, root, seed } from './factories.js';
import { particlePointerShader } from './particle-pointer.js';
import { approach, createField, createGlow, createShockPool, faceCamera, TAU } from './scene-field.js';

const SEGMENTS = 1500, RINGS = 16, DUST = 800;

const streakShader = `
attribute float aSeed,aLane,aRadius,aBaseZ,aEnd,aAlpha;
uniform float uTravel,uWarp,uBass,uMid,uTreble,uMotion,uResponse,uSize,uPixel,uHeight,uCharge;
uniform vec3 uColorA,uColorB,uColorC;
varying vec3 vColor; varying float vAlpha;
${particlePointerShader}
void main(){
 float wrap=64.0;
 float flow=uTravel*(.55+aSeed*.65)*(.6+uMotion*.8);
 float z=2.0-mod(aBaseZ*wrap-flow,wrap);
 float speedGlow=1.0+uBass*uResponse*.5+uWarp*1.6+uCharge*.5;
 float len=(.5+aSeed*2.9)*speedGlow;
 z+=aEnd*len;
 float angle=aLane+sin(z*.055+uTravel*.02+aSeed*3.0)*.035;
 float radius=aRadius*(1.0+sin(z*.1+uTravel*.03+aSeed*6.0)*.035)*(1.0-uWarp*.05);
 vec3 p=vec3(cos(angle)*radius,sin(angle)*radius,z);
 float depth=clamp((-z+2.0)/64.0,0.0,1.0);
 p.xy+=uPointer.xy*clamp(uPointerAmount,0.0,1.0)*(.25+depth*2.8);
 p.xy+=vec2(sin(z*.07+uTravel*.03),cos(z*.05+uTravel*.025))*uMid*uResponse*.14*depth;
 vec4 mv=modelViewMatrix*vec4(p,1.0); gl_Position=projectionMatrix*mv;
 vec3 c=mix(uColorA,uColorB,fract(aSeed*3.7+aLane*.159));
 c=mix(c,uColorC,smoothstep(.86,1.0,depth));
 vColor=c*(.65+pow(1.0-depth,2.0)*1.8+uWarp*.9);
 vAlpha=aAlpha*(.55+pow(1.0-depth,1.5)*.9)*smoothstep(0.0,.04,depth)*(1.0-smoothstep(.7,1.0,depth));
}`;
const streakFragment = `varying vec3 vColor; varying float vAlpha;
void main(){ gl_FragColor=vec4(vColor,vAlpha);
#include <colorspace_fragment>
}`;

const dustShader = `
attribute float aSeed,aAngle,aRadius,aBaseZ;
uniform float uTravel,uWarp,uBass,uMid,uTreble,uMotion,uResponse,uSize,uPixel,uHeight,uCharge;
uniform vec3 uColorA,uColorB,uColorC;
varying vec3 vColor; varying float vAlpha;
${particlePointerShader}
void main(){
 float wrap=58.0;
 float z=2.0-mod(aBaseZ*wrap-uTravel*(.7+aSeed*.9)*(.6+uMotion*.8),wrap);
 float angle=aAngle+z*.02+clamp(uPointerAmount,0.0,1.0)*.06*sin(z*.1+aSeed*6.2831853);
 float radius=aRadius*(1.0+sin(z*.12+aSeed*9.0)*.06);
 vec3 p=vec3(cos(angle)*radius,sin(angle)*radius,z);
 float depth=clamp((-z+2.0)/58.0,0.0,1.0);
 p.xy+=uPointer.xy*clamp(uPointerAmount,0.0,1.0)*(.2+depth*2.4);
 vec4 mv=modelViewMatrix*vec4(p,1.0); gl_Position=projectionMatrix*mv;
 vColor=mix(uColorA,uColorC,.35+aSeed*.4)*(.6+uWarp*.6);
 vAlpha=(.15+aSeed*.35)*smoothstep(.02,.14,depth)*(1.0-smoothstep(.7,1.0,depth));
 gl_PointSize=clamp(uSize*uPixel*(.7+aSeed*1.4)*uHeight*.035/max(2.0,-mv.z),1.0,3.5);
}`;

const shellVertex = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const shellFragment = `uniform float uTime,uWarp,uBurst,uCharge,uOpacity; uniform vec3 uColorA,uColorB; varying vec2 vUv;
const float TAU=6.2831853;
void main(){
 float spokes=pow(.5+.5*sin(vUv.x*TAU*24.0),14.0);
 float bands=pow(.5+.5*sin(vUv.y*92.0-uTime*1.1),20.0);
 vec3 c=mix(uColorA,uColorB,vUv.x);
 float fade=smoothstep(0.0,.06,vUv.y)*(1.0-smoothstep(.75,1.0,vUv.y));
 float a=(spokes*.16+bands*.12)*(.55+uWarp*.9+uCharge*.2)*fade*uOpacity;
 gl_FragColor=vec4(c,a);
 #include <colorspace_fragment>
}`;

const pointFragment = `varying vec3 vColor; varying float vAlpha;
void main(){ float d=length(gl_PointCoord-.5); if(d>.5) discard;
 float core=1.0-smoothstep(.06,.36,d), halo=exp(-d*d*18.0)*.3;
 gl_FragColor=vec4(vColor,(core+halo)*vAlpha);
 #include <colorspace_fragment>
}`;

export function createWarpTunnel(ctx) {
  const T = ctx.THREE, group = root(ctx), world = new T.Group(); group.add(world);
  const field = createField(ctx, world, { depth: -8, radius: 3.0 });
  const uniforms = { ...field.uniforms, uTime: { value: 0 }, uTravel: { value: 0 }, uWarp: { value: 0 },
    uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 }, uMotion: { value: .6 }, uResponse: { value: .7 },
    uSize: { value: 1 }, uPixel: { value: 1 }, uHeight: { value: 720 }, uOpacity: { value: .9 },
    uColorA: { value: new T.Color(0x64e8ff) }, uColorB: { value: new T.Color(0xc07cff) }, uColorC: { value: new T.Color(0xffd39a) } };

  const positions = [], lanes = [], radii = [], bases = [], ends = [], alphas = [], streaks = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const lane = (i % 96) / 96 * TAU + (seed(i, 1) - .5) * .14, radius = 1.05 + Math.pow(seed(i, 2), .6) * 3.2, base = seed(i, 3), s = seed(i, 4);
    for (let glow = 0; glow < 3; glow++) {
      for (let end = 0; end < 2; end++) {
        positions.push(0, 0, 0); lanes.push(lane + (glow - 1) * .012); radii.push(radius); bases.push(base); ends.push(end);
        alphas.push(glow === 1 ? .82 : .26); streaks.push(s);
      }
    }
  }
  const streakGeometry = own(ctx, new T.BufferGeometry());
  streakGeometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  streakGeometry.setAttribute('aLane', new T.Float32BufferAttribute(lanes, 1));
  streakGeometry.setAttribute('aRadius', new T.Float32BufferAttribute(radii, 1));
  streakGeometry.setAttribute('aBaseZ', new T.Float32BufferAttribute(bases, 1));
  streakGeometry.setAttribute('aEnd', new T.Float32BufferAttribute(ends, 1));
  streakGeometry.setAttribute('aAlpha', new T.Float32BufferAttribute(alphas, 1));
  streakGeometry.setAttribute('aSeed', new T.Float32BufferAttribute(streaks, 1));
  const streaksMesh = new T.LineSegments(streakGeometry, own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: streakShader, fragmentShader: streakFragment,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending })));
  streaksMesh.frustumCulled = false; world.add(streaksMesh);

  const shell = new T.Mesh(own(ctx, new T.CylinderGeometry(4.42, 4.42, 64, 48, 1, true)), own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: shellVertex, fragmentShader: shellFragment,
    side: T.BackSide, transparent: true, depthWrite: false, blending: T.AdditiveBlending })));
  shell.rotation.x = Math.PI / 2; shell.position.z = -30; world.add(shell);

  const ringGeometry = own(ctx, new T.TorusGeometry(3.2, .012, 4, 96));
  const ringMaterial = own(ctx, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .55, depthWrite: false, blending: T.AdditiveBlending }));
  const gates = new T.InstancedMesh(ringGeometry, ringMaterial, RINGS); gates.frustumCulled = false; world.add(gates);
  const ringObject = new T.Object3D(), ringColor = new T.Color();
  const ringColors = [0x6fe9ff, 0xb78bff, 0xffc89c];
  for (let i = 0; i < RINGS; i++) { ringColor.set(ringColors[i % ringColors.length]); gates.setColorAt(i, ringColor); }
  if (gates.instanceColor) gates.instanceColor.needsUpdate = true;

  const dustPositions = [], dustAngles = [], dustRadii = [], dustBases = [], dustSeeds = [];
  for (let i = 0; i < DUST; i++) {
    dustPositions.push(0, 0, 0); dustAngles.push(seed(i, 5) * TAU); dustRadii.push(.6 + seed(i, 6) * 3.4);
    dustBases.push(seed(i, 7)); dustSeeds.push(seed(i, 8));
  }
  const dustGeometry = own(ctx, new T.BufferGeometry());
  dustGeometry.setAttribute('position', new T.Float32BufferAttribute(dustPositions, 3));
  dustGeometry.setAttribute('aAngle', new T.Float32BufferAttribute(dustAngles, 1));
  dustGeometry.setAttribute('aRadius', new T.Float32BufferAttribute(dustRadii, 1));
  dustGeometry.setAttribute('aBaseZ', new T.Float32BufferAttribute(dustBases, 1));
  dustGeometry.setAttribute('aSeed', new T.Float32BufferAttribute(dustSeeds, 1));
  const dust = new T.Points(dustGeometry, own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: dustShader, fragmentShader: pointFragment,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending })));
  dust.frustumCulled = false; world.add(dust);

  const gateGroup = new T.Group(); world.add(gateGroup);
  const flare = createGlow(ctx, gateGroup, { color: 0x9ff4ff, opacity: .62, size: 9.5, renderOrder: 2 });
  flare.mesh.position.z = -57;
  const innerFlare = createGlow(ctx, gateGroup, { color: 0xffc79a, opacity: .32, size: 3.0, renderOrder: 3 });
  innerFlare.mesh.position.z = -30;
  const haze = createGlow(ctx, gateGroup, { color: 0x626bff, opacity: .14, size: 30, renderOrder: -4 });
  haze.mesh.position.z = -22;
  const deepHaze = createGlow(ctx, gateGroup, { color: 0x3155aa, opacity: .1, size: 46, renderOrder: -5 });
  deepHaze.mesh.position.z = -52;
  const cursor = createGlow(ctx, world, { color: 0xb9f6ff, opacity: 0, size: 1.2, renderOrder: 8 });
  const shock = createShockPool(ctx, world, { count: 6, duration: 1.2 });
  const spawnQuat = new T.Quaternion(), parentQuat = new T.Quaternion(), cameraQuat = new T.Quaternion();
  let profile = ctx.quality, params = { ...ctx.params }, travel = 0, warp = 0;

  function density() {
    const fraction = qualityDensity(profile) * (params.density ?? 1);
    streakGeometry.setDrawRange(0, Math.floor(positions.length / 3 / 2 * fraction) * 2);
    dustGeometry.setDrawRange(0, Math.floor(DUST * fraction));
    gates.count = Math.max(4, Math.floor(RINGS * fraction));
  }
  density();
  return basicInstance(group, params, profile, {
    update(frame, p) {
      const reduced = !!frame.reduced, time = Number(frame.time) || 0, dt = reduced ? 0 : Math.max(0, Math.min(.05, Number(frame.dt) || 0));
      field.update(frame, (p.pointerStrength ?? 1) * .95);
      const clicked = field.takeClick();
      if (reduced) warp = 0;
      else {
        travel += dt * (10 + warp * 34 + field.charge * 12) * (p.speed ?? .6) * 1.8;
        warp += (0 - warp) * approach(dt, .6);
        if (clicked) {
          warp = Math.min(1.4, .65 + field.charge * .75);
          parentQuat.copy(world.getWorldQuaternion(new T.Quaternion())).invert();
          ctx.camera.getWorldQuaternion(cameraQuat);
          spawnQuat.copy(parentQuat).multiply(cameraQuat);
          shock.spawn(field.uniforms.uBurstPoint.value, spawnQuat, 3.2 + field.charge * 2.2, 0xffe0b0);
        }
      }
      uniforms.uTime.value = time; uniforms.uTravel.value = travel; uniforms.uWarp.value = warp;
      uniforms.uBass.value = frame.bands?.bass ?? 0; uniforms.uMid.value = frame.bands?.mid ?? 0; uniforms.uTreble.value = frame.bands?.treble ?? 0;
      uniforms.uMotion.value = p.speed ?? .6; uniforms.uResponse.value = p.reactivity ?? .7;
      uniforms.uSize.value = p.pointSize ?? 1; uniforms.uPixel.value = ctx.renderer?.getPixelRatio() || 1;
      const amount = field.uniforms.uPointerAmount.value, pointer = field.uniforms.uPointer.value;
      gateGroup.position.set(pointer.x * amount * .12, pointer.y * amount * .12, 0);
      flare.set(undefined, .5 + warp * .45 + field.charge * .15, 9.5 + warp * 4);
      innerFlare.set(undefined, .24 + warp * .35, 3.0 + warp * 1.2);
      cursor.set(undefined, amount * (.4 + field.charge * .35), 1.2 + field.charge * .8);
      if (amount > 0) { cursor.mesh.position.copy(pointer); faceCamera(cursor.mesh, ctx.camera); }
      world.rotation.z = reduced ? 0 : Math.sin(time * .12) * .035 + pointer.x * amount * .04;
      for (let i = 0; i < gates.count; i++) {
        const z = 2 - (((i * 2.9 - travel * 1.2) % 64) + 64) % 64;
        const pulse = 1 + Math.sin(time * 1.3 + i * 2.1) * .025 + warp * .06;
        ringObject.position.set(0, 0, z); ringObject.scale.set(pulse, pulse, 1); ringObject.rotation.z = i * .41 + time * .18 + warp * .4;
        ringObject.updateMatrix(); gates.setMatrixAt(i, ringObject.matrix);
      }
      gates.instanceMatrix.needsUpdate = true;
      shock.update(dt, reduced);
    },
    resize(w, h) { uniforms.uHeight.value = h; },
    params(next) { params = next; density(); },
    quality(next) { profile = next; density(); },
    stats: () => ({ particles: dustGeometry.drawRange.count, lineVertices: streakGeometry.drawRange.count, drawCalls: 8 })
  });
}
