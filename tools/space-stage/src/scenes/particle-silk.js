// SPDX-License-Identifier: MIT
// 粒子绸带：三条会翻卷的发光绸带，丝线/经线与布面同步，悬停压出沿线传播的凹槽，
// 点击把一道光沿绸带甩出去。
import { basicInstance, own, qualityDensity, root, seed } from './factories.js';
import { particlePointerShader } from './particle-pointer.js';
import { createField, createGlow, createShockPool, createSky, createStarfield, faceCamera } from './scene-field.js';

const POINTS = 14000;

const silkShader = `
attribute float aU,aV,aRibbon,aSeed;
uniform float uTime,uBass,uMid,uTreble,uMotion,uResponse,uSize,uPixel,uHeight,uCharge,uBurst,uBurstAge;
uniform vec3 uColorA,uColorB,uColorC;
varying vec3 vColor; varying float vAlpha;
${particlePointerShader}
const float TAU=6.2831853;
vec3 silkCenter(float u,float ribbon){
 float t=uTime*uMotion;
 float phase=u*6.4+t*.6+ribbon*2.1+clamp(uPointerAmount,0.0,1.0)*.16*sin(u*4.0+t*.7);
 float y=sin(phase)*1.9+sin(u*17.0-t*.4+ribbon)*.28;
 float z=cos(u*5.2+t*.32+ribbon*1.6)*(2.0+ribbon*.35);
 y+=uBass*uResponse*sin(u*9.0+t*.9+ribbon)*.42;
 return vec3((u-.5)*17.0,y,z);
}
vec3 silkPoint(float u,float v,float ribbon,float seed){
 float e=.002;
 vec3 c=silkCenter(u,ribbon);
 vec3 tangent=normalize(silkCenter(u+e,ribbon)-silkCenter(u-e,ribbon)+vec3(1e-4,0.0,0.0));
 vec3 side=normalize(cross(tangent,vec3(0.0,1.0,0.0))+vec3(0.0,0.0,1e-4));
 vec3 up=normalize(cross(side,tangent));
 float twist=u*5.0+uTime*uMotion*.45+ribbon*1.7;
 vec3 widthDir=side*cos(twist)+up*sin(twist);
 vec3 p=c+widthDir*v*(1.05+ribbon*.16);
 float fold=sin(u*23.0+v*4.0-uTime*uMotion*.7+seed*6.0);
 p+=up*fold*(.05+uMid*uResponse*.16);
 return p;
}
void main(){
 vec3 p=silkPoint(aU,aV,aRibbon,aSeed);
 p+=vec3(sin(aSeed*37.0+aU*9.0),cos(aSeed*53.0),sin(aSeed*71.0))*.04;
 vec3 delta=p-uPointer;
 float depth=dot(delta,uPointerNormal);
 vec3 tangent=delta-uPointerNormal*depth;
 float reach=max(.001,uPointerRadius);
 float bowl=exp(-dot(tangent,tangent)/(reach*reach)*3.5)*clamp(uPointerAmount,0.0,1.0);
 p-=uPointerNormal*bowl*.7;
 p-=tangent/max(.0001,length(tangent))*bowl*.06;
 vec4 mv=modelViewMatrix*vec4(p,1.0); gl_Position=projectionMatrix*mv;
 float edge=1.0-smoothstep(.55,1.0,abs(aV));
 float wave=pow(.5+.5*sin((aU*3.2-uTime*uMotion*.62+aRibbon*.7)*TAU-uBurstAge*7.0),10.0);
 float burst=uBurst*pow(.5+.5*sin((aU*7.0-uBurstAge*12.0)*3.0),8.0);
 float tint=clamp(aRibbon*.5+aV*.14,0.0,1.0);
 vColor=mix(uColorA,uColorB,tint);
 vColor=mix(vColor,uColorC,wave*.55+burst*.6);
 vColor*=.78+uTreble*uResponse*.35+wave*.5+uCharge*.25;
 vAlpha=(.28+edge*.58+wave*.28)*(.9+uBass*uResponse*.2);
 float size=uSize*uPixel*(.55+aSeed*.85)*(1.0+wave*.8)*uHeight*.045/max(2.0,-mv.z);
 gl_PointSize=clamp(size,1.0,5.0);
}`;

const silkLineShader = `
attribute float aU,aV,aRibbon,aSeed,aAlpha;
uniform float uTime,uBass,uMid,uTreble,uMotion,uResponse,uCharge,uBurst,uBurstAge;
uniform vec3 uColorA,uColorB,uColorC;
varying vec3 vColor; varying float vAlpha;
${particlePointerShader}
const float TAU=6.2831853;
vec3 silkCenter(float u,float ribbon){
 float t=uTime*uMotion;
 float phase=u*6.4+t*.6+ribbon*2.1+clamp(uPointerAmount,0.0,1.0)*.16*sin(u*4.0+t*.7);
 float y=sin(phase)*1.9+sin(u*17.0-t*.4+ribbon)*.28;
 float z=cos(u*5.2+t*.32+ribbon*1.6)*(2.0+ribbon*.35);
 y+=uBass*uResponse*sin(u*9.0+t*.9+ribbon)*.42;
 return vec3((u-.5)*17.0,y,z);
}
vec3 silkPoint(float u,float v,float ribbon,float seed){
 float e=.002;
 vec3 c=silkCenter(u,ribbon);
 vec3 tangent=normalize(silkCenter(u+e,ribbon)-silkCenter(u-e,ribbon)+vec3(1e-4,0.0,0.0));
 vec3 side=normalize(cross(tangent,vec3(0.0,1.0,0.0))+vec3(0.0,0.0,1e-4));
 vec3 up=normalize(cross(side,tangent));
 float twist=u*5.0+uTime*uMotion*.45+ribbon*1.7;
 vec3 widthDir=side*cos(twist)+up*sin(twist);
 vec3 p=c+widthDir*v*(1.05+ribbon*.16);
 float fold=sin(u*23.0+v*4.0-uTime*uMotion*.7+seed*6.0);
 p+=up*fold*(.05+uMid*uResponse*.16);
 return p;
}
void main(){
 vec3 p=silkPoint(aU,aV,aRibbon,aSeed);
 vec3 delta=p-uPointer;
 float depth=dot(delta,uPointerNormal);
 vec3 tangent=delta-uPointerNormal*depth;
 float reach=max(.001,uPointerRadius);
 float bowl=exp(-dot(tangent,tangent)/(reach*reach)*3.5)*clamp(uPointerAmount,0.0,1.0);
 p-=uPointerNormal*bowl*.7;
 p-=tangent/max(.0001,length(tangent))*bowl*.06;
 vec4 mv=modelViewMatrix*vec4(p,1.0); gl_Position=projectionMatrix*mv;
 float wave=pow(.5+.5*sin((aU*3.2-uTime*uMotion*.62+aRibbon*.7)*TAU-uBurstAge*7.0),10.0);
 vColor=mix(uColorA,uColorC,wave*.5);
 vColor*=.8+uCharge*.2;
 vAlpha=aAlpha*(.72+wave*.55+uBass*uResponse*.15);
}`;

const silkLineFragment = `varying vec3 vColor; varying float vAlpha;
void main(){ gl_FragColor=vec4(vColor,vAlpha);
#include <colorspace_fragment>
}`;

export function createParticleSilk(ctx) {
  const T = ctx.THREE, group = root(ctx), world = new T.Group(); group.add(world);
  const field = createField(ctx, world, { depth: 0, radius: 2.1 });
  const uniforms = { ...field.uniforms, uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
    uMotion: { value: .6 }, uResponse: { value: .7 }, uSize: { value: 1 }, uPixel: { value: 1 }, uHeight: { value: 720 },
    uColorA: { value: new T.Color(0x5fe3ff) }, uColorB: { value: new T.Color(0xff6fb5) }, uColorC: { value: new T.Color(0xffd28a) } };

  const positions = new Float32Array(POINTS * 3), au = new Float32Array(POINTS), av = new Float32Array(POINTS), ribbon = new Float32Array(POINTS), seeds = new Float32Array(POINTS);
  for (let i = 0; i < POINTS; i++) {
    au[i] = seed(i, 1); av[i] = seed(i, 2) * 2 - 1; ribbon[i] = i % 3; seeds[i] = seed(i, 3);
  }
  const pointGeometry = own(ctx, new T.BufferGeometry());
  pointGeometry.setAttribute('position', new T.BufferAttribute(positions, 3));
  pointGeometry.setAttribute('aU', new T.BufferAttribute(au, 1));
  pointGeometry.setAttribute('aV', new T.BufferAttribute(av, 1));
  pointGeometry.setAttribute('aRibbon', new T.BufferAttribute(ribbon, 1));
  pointGeometry.setAttribute('aSeed', new T.BufferAttribute(seeds, 1));
  const points = new T.Points(pointGeometry, own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: silkShader, fragmentShader: `varying vec3 vColor; varying float vAlpha;
    void main(){ float d=length(gl_PointCoord-.5); if(d>.5) discard; float core=1.0-smoothstep(.04,.34,d), halo=exp(-d*d*18.0)*.3;
      gl_FragColor=vec4(vColor*(.85+core*.7),(core+halo)*vAlpha);
      #include <colorspace_fragment>
    }`,
    transparent: true, depthWrite: false, blending: T.NormalBlending })));
  points.frustumCulled = false; world.add(points);

  const linePositions = [], lu = [], lv = [], lr = [], lseed = [], la = [];
  function segment(rib, u0, u1, v0, v1, alpha, salt) {
    for (const [u, v] of [[u0, v0], [u1, v1]]) {
      linePositions.push(0, 0, 0); lu.push(u); lv.push(v); lr.push(rib); lseed.push(seed(salt + u * 97, 7)); la.push(alpha);
    }
  }
  for (let rib = 0; rib < 3; rib++) {
    for (let i = 0; i < 180; i++) segment(rib, i / 180, (i + 1) / 180, 0, 0, .22, rib * 1000 + i);
  }
  const lineGeometry = own(ctx, new T.BufferGeometry());
  lineGeometry.setAttribute('position', new T.Float32BufferAttribute(linePositions, 3));
  lineGeometry.setAttribute('aU', new T.Float32BufferAttribute(lu, 1));
  lineGeometry.setAttribute('aV', new T.Float32BufferAttribute(lv, 1));
  lineGeometry.setAttribute('aRibbon', new T.Float32BufferAttribute(lr, 1));
  lineGeometry.setAttribute('aSeed', new T.Float32BufferAttribute(lseed, 1));
  lineGeometry.setAttribute('aAlpha', new T.Float32BufferAttribute(la, 1));
  const lines = new T.LineSegments(lineGeometry, own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: silkLineShader, fragmentShader: silkLineFragment,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending })));
  lines.frustumCulled = false; world.add(lines);

  const sky = createSky(ctx, world, { top: 0x04070d, bottom: 0x0a1a22, glow: 0x256d78, opacity: .9 });
  const stars = createStarfield(ctx, world, { count: 900, near: 15, far: 52, palette: [0x9fe9ff, 0xffb6d9, 0xffe4b6], size: [.5, 1.7], opacity: .75 });
  const motes = createStarfield(ctx, world, { count: 460, near: 5, far: 17, palette: [0x8ff4ff, 0xffc7a8], size: [.8, 2.1], opacity: .5 });
  const aura = createGlow(ctx, world, { color: 0x1d6f7c, opacity: .16, size: 18, renderOrder: -6 });
  const counter = createGlow(ctx, world, { color: 0x6b2a4e, opacity: .12, size: 11, renderOrder: -5 });
  counter.mesh.position.set(4, -2, -7);
  const cursor = createGlow(ctx, world, { color: 0xa4f0ff, opacity: 0, size: 1.5, renderOrder: 8 });
  const shock = createShockPool(ctx, world, { count: 6, duration: 1.05 });
  const spawnQuat = new T.Quaternion(), parentQuat = new T.Quaternion(), cameraQuat = new T.Quaternion();
  const parallax = new T.Vector2();

  let profile = ctx.quality, params = { ...ctx.params };
  function density() {
    const fraction = qualityDensity(profile) * (params.density ?? 1);
    pointGeometry.setDrawRange(0, Math.floor(POINTS * fraction));
    lineGeometry.setDrawRange(0, Math.floor(linePositions.length / 3 * fraction / 2) * 2);
    stars.setDensity(fraction); motes.setDensity(fraction);
  }
  density();
  return basicInstance(group, params, profile, {
    update(frame, p) {
      const reduced = !!frame.reduced, time = Number(frame.time) || 0, dt = reduced ? 0 : Number(frame.dt) || 0;
      field.update(frame, (p.pointerStrength ?? 1) * .9);
      uniforms.uTime.value = time;
      uniforms.uBass.value = frame.bands?.bass ?? 0; uniforms.uMid.value = frame.bands?.mid ?? 0; uniforms.uTreble.value = frame.bands?.treble ?? 0;
      uniforms.uMotion.value = p.speed ?? .6; uniforms.uResponse.value = p.reactivity ?? .7;
      uniforms.uSize.value = p.pointSize ?? 1; uniforms.uPixel.value = ctx.renderer?.getPixelRatio() || 1;
      if (reduced) parallax.set(0, 0);
      else if (frame.pointer?.active && Number.isFinite(frame.pointer.x)) parallax.lerp(frame.pointer, 1 - Math.exp(-dt / .3));
      else parallax.lerp({ x: 0, y: 0 }, 1 - Math.exp(-dt / .5));
      world.rotation.set(parallax.y * -.07, Math.sin(time * .07) * .045 + parallax.x * .13, parallax.x * .025);
      sky.update(time); stars.uniforms.uTime.value = time; motes.uniforms.uTime.value = time;
      const amount = field.uniforms.uPointerAmount.value;
      cursor.set(undefined, amount * (.42 + field.charge * .42), 1.35 + field.charge * .9 + amount * .25);
      if (amount > 0) { cursor.mesh.position.copy(field.uniforms.uPointer.value); faceCamera(cursor.mesh, ctx.camera); }
      if (field.takeClick()) {
        parentQuat.copy(world.getWorldQuaternion(new T.Quaternion())).invert();
        ctx.camera.getWorldQuaternion(cameraQuat);
        spawnQuat.copy(parentQuat).multiply(cameraQuat);
        shock.spawn(field.uniforms.uBurstPoint.value, spawnQuat, 2.4 + field.charge * 1.6, 0xffd38a);
      }
      shock.update(dt, reduced);
    },
    resize(w, h) { uniforms.uHeight.value = h; },
    params(next) { params = next; density(); },
    quality(next) { profile = next; density(); },
    stats: () => ({ particles: pointGeometry.drawRange.count, lineVertices: lineGeometry.drawRange.count, drawCalls: 7 })
  });
}
