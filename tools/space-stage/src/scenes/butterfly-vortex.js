// SPDX-License-Identifier: MIT
import { basicInstance, own, qualityDensity, root, seed } from './factories.js';
import { createParticlePointer, particleNoiseShader } from './particle-pointer.js';
import { approach, createGlow, createSky, createStarfield, faceCamera, TAU } from './scene-field.js';

const BUTTERFLIES = 640, DUST = 18000;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function butterflyTimeline(time, mode = 'auto') {
  if (mode === 'butterfly') return { scatter: 0, vortex: 0 };
  if (mode === 'swarm') return { scatter: 1, vortex: 0 };
  if (mode === 'vortex') return { scatter: 1, vortex: 1 };
  const t = ((time % 36) + 36) % 36;
  return { scatter: smooth(7, 12, t) * (1 - smooth(30, 36, t)), vortex: smooth(13, 19, t) * (1 - smooth(27, 34, t)) };
}

function outlines(T, detail) {
  const fore = new T.CurvePath();
  const hind = new T.CurvePath();
  const add = (path, a, b, c, d) => path.add(new T.CubicBezierCurve(new T.Vector2(...a), new T.Vector2(...b), new T.Vector2(...c), new T.Vector2(...d)));
  add(fore, [.055, .16], [.65, 1.35], [2.66, 3.13], [3.48, 2.76]);
  add(fore, [3.48, 2.76], [3.73, 2.58], [3.18, 1.65], [3.04, 1.49]);
  add(fore, [3.04, 1.49], [2.78, 1.39], [2.97, 1.17], [2.73, 1.06]);
  add(fore, [2.73, 1.06], [2.49, .99], [2.69, .77], [2.41, .66]);
  add(fore, [2.41, .66], [2.22, .56], [2.23, .39], [1.87, .31]);
  add(fore, [1.87, .31], [1.15, .1], [.52, -.04], [.055, -.08]);
  add(hind, [.055, .09], [.65, .4], [2.08, .51], [2.48, -.46]);
  add(hind, [2.48, -.46], [2.67, -.78], [2.12, -.66], [2.28, -1.03]);
  add(hind, [2.28, -1.03], [2.34, -1.26], [1.87, -1.04], [1.98, -1.43]);
  add(hind, [1.98, -1.43], [2.01, -1.69], [1.66, -1.46], [1.61, -1.8]);
  add(hind, [1.61, -1.8], [1.57, -2.19], [1.27, -2.59], [1.31, -2.18]);
  add(hind, [1.31, -2.18], [1.43, -1.57], [.93, -1.91], [.85, -1.66]);
  add(hind, [.85, -1.66], [.51, -1.82], [.23, -.68], [.055, -.12]);
  return [fore.getPoints(detail), hind.getPoints(detail)];
}

function wings(ctx, rings, detail) {
  const T = ctx.THREE, positions = [], fan = [], sides = [], parts = [], indices = [];
  for (const [part, outline] of outlines(T, detail).entries()) for (const side of [-1, 1]) {
    const start = positions.length / 3, n = outline.length;
    for (let r = 0; r <= rings; r++) for (let j = 0; j < n; j++) {
      const u = r / rings, x = .055 + (outline[j].x - .055) * u, y = outline[j].y * u;
      positions.push(x * side, y, Math.sin(u * Math.PI) * .13);
      fan.push(j / (n - 1), u); sides.push(side); parts.push(part);
    }
    for (let r = 0; r < rings; r++) for (let j = 0; j < n - 1; j++) {
      const a = start + r * n + j, b = a + n;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = own(ctx, new T.BufferGeometry());
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aFan', new T.Float32BufferAttribute(fan, 2));
  geometry.setAttribute('aSide', new T.Float32BufferAttribute(sides, 1));
  geometry.setAttribute('aPart', new T.Float32BufferAttribute(parts, 1));
  geometry.setIndex(indices);
  return geometry;
}

const motionShader = `
uniform float uTime,uScatter,uVortex,uBass,uMid,uTreble,uResponse,uCharge,uBurst;
uniform vec3 uPointer; uniform float uPointerAmount;
const float TAU=6.283185307;
mat2 turn(float a){return mat2(cos(a),-sin(a),sin(a),cos(a));}
vec3 heroPose(vec3 p){
 p.xz=turn(.22+sin(uTime*.37)*.1)*p.xz;
 p.xy=turn(-.24+sin(uTime*.24)*.085)*p.xy;
 return p+vec3(-.55+sin(uTime*.27)*.24,.8+sin(uTime*.57)*.17,.8);
}
vec3 wingPose(vec3 p,float side,float part,float phase){
 float flap=.28+(.5+.5*sin(phase))*(.9+uMid*uResponse*.16);
 flap+=sin(p.y*1.6-phase)*abs(p.x)*.025;
 p.z+=sin(abs(p.x)*1.1-phase+part*.7)*aFan.y*.075;
 p.xz=turn(-side*flap)*p.xz;
 return p;
}
`;

const wingVertex = `
attribute vec2 aFan; attribute float aSide,aPart;
varying vec2 vFan; varying vec3 vLocal; varying float vLight,vOpacity,vTint;
${motionShader}
#ifdef SWARM
attribute vec4 aFlight; attribute vec3 aHome;
#endif
void main(){
 vFan=aFan; vLocal=position;
 #ifdef SWARM
 float id=aFlight.x, phase=uTime*(3.2+aFlight.y*2.6)+id*TAU;
 vec3 p=wingPose(position,aSide,aPart,phase);
 float theta=id*TAU*7.0+uTime*(.09+aFlight.w*.08);
 float radius=2.6+pow(aFlight.y,.65)*10.5;
 vec3 cloud=vec3(cos(theta)*radius,sin(theta)*radius*.62,(aFlight.z-.5)*16.0-2.0);
 cloud+=vec3(sin(phase*.31),cos(phase*.24),sin(phase*.19))*.6;
 float vr=1.0+pow(aFlight.y,.65)*11.0, va=id*TAU*5.0+log(1.0+vr)*2.8-uTime*.19;
 vec3 orbit=vec3(cos(va)*vr,sin(va)*vr*.88+.8,-4.0-vr*.32+(aFlight.z-.5)*2.5);
 vec3 destination=mix(cloud,orbit,uVortex);
 vec3 attraction=uPointer-destination;
 float nearField=exp(-dot(attraction,attraction)*.012);
 destination+=attraction*min(.68,uPointerAmount*(.25+uCharge*.4))*nearField;
 destination+=normalize(destination-uPointer+vec3(.001))*uBurst*(1.0+aFlight.w)*1.8;
 float size=(.055+pow(aFlight.w,4.0)*.21)*mix(.55,1.0,uScatter)*mix(1.0,.72,uVortex);
 p*=size;
 p.yz=turn(sin(theta*.7)*.65)*p.yz;
 p.xy=turn(theta*.5+sin(phase*.3)*.4)*p.xy;
 p+=mix(heroPose(aHome),destination,uScatter);
 vOpacity=smoothstep(.035,.38,uScatter)*(.65+aFlight.w*.35);
 vOpacity*=1.0-uVortex*smoothstep(.03,.2,aFlight.x)*.975;
 vTint=aFlight.z; vLight=.6+.4*abs(cos(phase));
 #else
 float phase=uTime*2.4;
 vec3 p=heroPose(wingPose(position,aSide,aPart,phase));
 p.xy+=uPointer.xy*min(.13,uPointerAmount*.075);
 vOpacity=1.0; vTint=.45; vLight=.76+.24*cos(phase+.6);
 #endif
 gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
}`;

const wingFragment = `
uniform float uTime,uScatter,uTreble,uResponse;
varying vec2 vFan; varying vec3 vLocal; varying float vLight,vOpacity,vTint;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.0),f.x),f.y);}
void main(){
 float r=vFan.y, a=vFan.x, grain=noise(vLocal.xy*96.0);
 float cells=noise(vec2(a*33.0,r*19.0));
 float detail=1.0-smoothstep(.015,.1,max(fwidth(vLocal.x),fwidth(vLocal.y)));
 float ribs=abs(sin((a*11.0+sin(r*6.0+a*13.0)*.055)*3.141593));
 float vein=(1.0-smoothstep(.025,.09+fwidth(ribs),ribs))*detail;
 float branch=1.0-smoothstep(.015,.055,abs(sin((r*8.0+a*17.0+sin(a*31.0)*.2)*3.141593)));
 branch*=smoothstep(.4,.75,r)*.42*detail;
 vec3 ruby=vec3(.46,.024,.067), violet=vec3(.25,.18,.34), pearl=vec3(.54,.4,.51);
 float blush=exp(-pow((r-.46)*3.8,2.0));
 vec3 color=mix(violet,pearl,smoothstep(.3,2.7,vLocal.y)*.72);
 color=mix(color,ruby,blush*(.74+sin(a*5.0)*.2));
 color=mix(color,vec3(.25,.065,.19),vTint*.14);
 color*=.72+cells*.26+grain*.1*detail;
 float margin=smoothstep(.72,.95,r+sin(a*80.0)*.012);
 color=mix(color,vec3(.008,.003,.009),margin*.98);
 color*=1.0-max(vein*.88,branch*.5)*smoothstep(.02,.23,r);
 color+=vec3(.18,.04,.08)*pow(r,18.0)*(.4+.6*sin(a*130.0)*sin(a*130.0));
 color*=smoothstep(.015,.13,r)*vLight*(.88+uTreble*uResponse*.18);
 float alpha=vOpacity;
 #ifndef SWARM
 float dissolve=noise(vLocal.xy*4.8)*.65+.08;
 alpha*=1.0-smoothstep(dissolve,dissolve+.22,uScatter);
 #endif
 if(alpha<.015)discard;
 gl_FragColor=vec4(color,alpha);
 #include <colorspace_fragment>
}`;

const dustVertex = `
attribute vec4 aDust; attribute float aTrail;
uniform float uPixel,uHeight,uSize; varying vec3 vColor; varying float vAlpha;
${particleNoiseShader}
uniform float uTime,uVortex,uBass,uTreble,uResponse,uBurst;
uniform vec3 uPointer; uniform float uPointerAmount;
void main(){
 float r=.2+pow(aDust.x,.68)*12.8;
 float arm=floor(aDust.y*5.0), lane=fract(aDust.y*5.0)-.5;
 float a=arm*1.256637+log(1.0+r)*2.85-uTime*.18+lane*(.14+r*.021);
 a+=particleNoise(vec3(r*.8,arm*7.0,uTime*.065))*.105;
 #ifdef TRAILS
 a-=aTrail*(.008+aDust.w*.024);
 #endif
 vec3 vortex=vec3(cos(a)*r,sin(a)*r*.88+.8,-4.0-r*.32+(aDust.z-.5)*(.25+r*.055));
 vortex.xy+=vec2(sin(r*2.0+a*3.0),cos(r*1.6-a*2.0))*.08;
 vec3 idle=position+vec3(sin(uTime*.17+aDust.w*20.0),cos(uTime*.12+aDust.z*20.0),0.0)*.12;
 vec3 p=mix(idle,vortex,uVortex);
 p.xy+=uPointer.xy*uPointerAmount*.015;
 p.xy*=1.0+uBass*uResponse*.025+uBurst*.025;
 vec4 mv=modelViewMatrix*vec4(p,1.0);gl_Position=projectionMatrix*mv;
 vColor=mix(vec3(.95,.22,.31),vec3(.72,.36,.105),smoothstep(.8,6.5,r));
 vColor=mix(vColor,vec3(1.0,.73,.41),aDust.w*.45);
 float tw=.66+.34*sin(uTime*.6+aDust.w*80.0);
 vAlpha=mix(.025,uVortex*(.52+aDust.w*.75),uVortex)*tw*(1.0-smoothstep(10.0,13.0,r));
 #ifdef TRAILS
 vAlpha*=uVortex*.6*(1.0-aTrail*.65);
 #endif
 gl_PointSize=clamp((.65+aDust.w*1.65)*uPixel*uHeight*.052/max(2.0,-mv.z)*uSize*(1.0+uTreble*uResponse*.25),1.0,4.2);
}`;
const dustFragment = `varying vec3 vColor; varying float vAlpha;
void main(){
 #ifndef TRAILS
 float d=length(gl_PointCoord-.5);if(d>.5)discard;
 float alpha=exp(-d*d*25.0)*(1.0-smoothstep(.3,.5,d))*vAlpha;
 #else
 float alpha=vAlpha;
 #endif
 gl_FragColor=vec4(vColor,alpha);
 #include <colorspace_fragment>
}`;
const veilFragment = `
uniform float uTime,uVortex,uBass,uResponse,uFine; varying vec2 vUv;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.0),f.x),f.y);}
float fbm(vec2 p){float n=noise(p)*.57+noise(p*2.03+4.7)*.28;return uFine>.5?n+noise(p*4.13+9.2)*.15:n/.85;}
void main(){
 vec2 p=(vUv-.5)*26.0;float r=length(p),a=atan(p.y,p.x),t=uTime*.18;
 float turbulence=fbm(p*1.4+vec2(t*.2,-t*.3))*1.5;
 float spiral=a*5.0-log(1.0+r)*14.25+t*5.0+turbulence;
 float ridge=pow(.5+.5*cos(spiral),8.0);
 float filament=pow(.5+.5*cos(spiral+fbm(p*1.7)*2.5),19.0);
 float cloud=fbm(p*2.3+vec2(t*.3,-t*.22));
 float alpha=(ridge*.9+filament*.65)*cloud*uVortex*smoothstep(.25,.95,r)*(1.0-smoothstep(6.0,12.5,r));
 vec3 color=mix(vec3(1.05,.16,.24),vec3(1.1,.52,.17),smoothstep(.8,5.0,r));
 color*=1.0+uBass*uResponse*.2;
 gl_FragColor=vec4(color,alpha);
 #include <colorspace_fragment>
}`;

export function createButterflyVortex(ctx) {
  const T = ctx.THREE, group = root(ctx), world = new T.Group(); group.add(world);
  const pointer = createParticlePointer(ctx, world, { depth: 0, radius: 3 });
  const uniforms = { ...pointer.uniforms, uTime: { value: 0 }, uScatter: { value: 0 }, uVortex: { value: 0 },
    uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 }, uResponse: { value: .7 },
    uCharge: { value: 0 }, uBurst: { value: 0 }, uPixel: { value: 1 }, uHeight: { value: 720 }, uSize: { value: 1 }, uFine: { value: 1 } };
  const wingMaterial = swarm => own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: wingVertex, fragmentShader: wingFragment,
    defines: swarm ? { SWARM: 1 } : {}, side: T.DoubleSide, transparent: true, depthWrite: false }));
  const hero = new T.Mesh(wings(ctx, 10, 9), wingMaterial(false)); hero.frustumCulled = false; world.add(hero);
  const swarmGeometry = wings(ctx, 1, 2), flights = new Float32Array(BUTTERFLIES * 4), homes = new Float32Array(BUTTERFLIES * 3);
  const borders = outlines(T, 12);
  for (let i = 0; i < BUTTERFLIES; i++) {
    flights.set([seed(i, 1), seed(i, 2), seed(i, 3), seed(i, 4)], i * 4);
    const border = borders[i % 2], sample = border[Math.floor(seed(i, 5) * border.length)], r = Math.sqrt(seed(i, 6));
    homes.set([(sample.x * r) * (i % 4 < 2 ? -1 : 1), sample.y * r, 0], i * 3);
  }
  swarmGeometry.setAttribute('aFlight', new T.InstancedBufferAttribute(flights, 4));
  swarmGeometry.setAttribute('aHome', new T.InstancedBufferAttribute(homes, 3));
  const swarm = own(ctx, new T.InstancedMesh(swarmGeometry, wingMaterial(true), BUTTERFLIES));
  swarm.frustumCulled = false; world.add(swarm);

  const body = new T.Group(); world.add(body);
  const bodyMaterial = own(ctx, new T.MeshBasicMaterial({ color: 0x24111d, transparent: true, depthWrite: false }));
  const bodyMesh = own(ctx, new T.InstancedMesh(own(ctx, new T.SphereGeometry(1, 12, 8)), bodyMaterial, 3));
  const dummy = new T.Object3D();
  for (const [i, spec] of [[0, [.1, .48, .09, -.21]], [1, [.145, .23, .13, .26]], [2, [.1, .1, .1, .52]]]) {
    dummy.position.set(0, spec[3], .06); dummy.scale.set(spec[0], spec[1], spec[2]); dummy.updateMatrix(); bodyMesh.setMatrixAt(i, dummy.matrix);
  }
  bodyMesh.instanceMatrix.needsUpdate = true; body.add(bodyMesh);
  const antennaPositions = [];
  for (const side of [-1, 1]) {
    const curve = new T.CubicBezierCurve3(new T.Vector3(side * .045, .53, .06), new T.Vector3(side * .14, .99, .06), new T.Vector3(side * .55, 1.16, .03), new T.Vector3(side * .48, 1.31, .1));
    const points = curve.getPoints(24);
    for (let i = 0; i < points.length - 1; i++) antennaPositions.push(...points[i].toArray(), ...points[i + 1].toArray());
  }
  const antennaMaterial = own(ctx, new T.LineBasicMaterial({ color: 0x936778, transparent: true, opacity: .72 }));
  const antennaGeometry = own(ctx, new T.BufferGeometry()); antennaGeometry.setAttribute('position', new T.Float32BufferAttribute(antennaPositions, 3));
  body.add(new T.LineSegments(antennaGeometry, antennaMaterial));

  function dustGeometry(count, trails) {
    const position = [], data = [], ends = [];
    for (let i = 0; i < count; i++) for (let end = 0; end < (trails ? 2 : 1); end++) {
      position.push((seed(i, 8) - .5) * 37, (seed(i, 9) - .5) * 23, -seed(i, 10) * 30);
      data.push(seed(i, 11), seed(i, 12), seed(i, 13), seed(i, 14)); ends.push(end);
    }
    const geometry = own(ctx, new T.BufferGeometry());
    geometry.setAttribute('position', new T.Float32BufferAttribute(position, 3));
    geometry.setAttribute('aDust', new T.Float32BufferAttribute(data, 4));
    geometry.setAttribute('aTrail', new T.Float32BufferAttribute(ends, 1));
    return geometry;
  }
  const dustMaterial = trails => own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: dustVertex, fragmentShader: dustFragment,
    defines: trails ? { TRAILS: 1 } : {}, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
  const dust = new T.Points(dustGeometry(DUST, false), dustMaterial(false)); dust.frustumCulled = false; world.add(dust);
  const trails = new T.LineSegments(dustGeometry(1800, true), dustMaterial(true)); trails.frustumCulled = false; world.add(trails);
  const veil = new T.Mesh(own(ctx, new T.PlaneGeometry(26, 26)), own(ctx, new T.ShaderMaterial({ uniforms,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}', fragmentShader: veilFragment,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide })));
  veil.position.set(0, .8, -4); veil.renderOrder = -4; world.add(veil);
  const sky = createSky(ctx, world, { top: 0x020304, bottom: 0x050308, glow: 0x10050e });
  const stars = createStarfield(ctx, world, { count: 420, near: 22, far: 55, palette: [0xbb9aaf, 0x8e9ba9], opacity: .22, size: [.4, .85] });
  const core = createGlow(ctx, world, { color: 0xffc8ba, opacity: 0, size: 2.4, depthTest: true }); core.mesh.position.set(0, .8, -3.8);
  const aura = createGlow(ctx, world, { color: 0xb62c43, opacity: 0, size: 8.5, depthTest: true }); aura.mesh.position.copy(core.mesh.position);
  const flare = createGlow(ctx, world, { color: 0xffae95, opacity: 0, size: 1, depthTest: true }); flare.mesh.position.copy(core.mesh.position); flare.mesh.scale.set(9, .16, 1);
  const cursor = createGlow(ctx, world, { color: 0xdda4bf, opacity: 0, size: .85 });
  let params = { ...ctx.params }, profile = ctx.quality, elapsed = 0, boost = 0, burstAge = 20, lastSerial = null, performanceChanged = false;
  let { scatter, vortex } = butterflyTimeline(0, params.performance);
  function density() {
    const fraction = qualityDensity(profile) * (params.density ?? 1);
    swarm.count = Math.max(1, Math.floor(BUTTERFLIES * fraction));
    dust.geometry.setDrawRange(0, Math.floor(DUST * fraction));
    trails.geometry.setDrawRange(0, Math.floor(1800 * fraction) * 2);
    uniforms.uFine.value = profile?.mode === 'low' ? 0 : 1; stars.setDensity(fraction);
  }
  function appearance() {
    const time = elapsed, amount = uniforms.uPointerAmount.value;
    uniforms.uTime.value = elapsed; uniforms.uScatter.value = scatter; uniforms.uVortex.value = vortex;
    uniforms.uSize.value = params.pointSize ?? 1; uniforms.uResponse.value = params.reactivity ?? .7;
    body.rotation.set(0, .22 + Math.sin(time * .37) * .1, .24 - Math.sin(time * .24) * .085, 'ZYX');
    body.position.set(-.55 + Math.sin(time * .27) * .24, .8 + Math.sin(time * .57) * .17, .8);
    body.position.x += uniforms.uPointer.value.x * Math.min(.13, amount * .075);
    body.position.y += uniforms.uPointer.value.y * Math.min(.13, amount * .075);
    bodyMaterial.opacity = 1 - smooth(.12, .75, scatter); antennaMaterial.opacity = bodyMaterial.opacity * .72;
    hero.visible = scatter < .97; body.visible = bodyMaterial.opacity > .01; swarm.visible = scatter > .015; veil.visible = vortex > .001;
    core.set(undefined, vortex * (.95 + uniforms.uBass.value * uniforms.uResponse.value * .1), 2.4);
    aura.set(undefined, vortex * .45, 8.5); flare.set(undefined, vortex * .4);
    faceCamera(core.mesh, ctx.camera); faceCamera(aura.mesh, ctx.camera); faceCamera(flare.mesh, ctx.camera);
    cursor.set(undefined, amount * (.14 + uniforms.uCharge.value * .16), .75 + uniforms.uCharge.value * .5);
    cursor.mesh.position.copy(uniforms.uPointer.value); faceCamera(cursor.mesh, ctx.camera);
    sky.update(time); stars.uniforms.uTime.value = time;
  }
  density(); appearance();
  return basicInstance(group, params, profile, {
    update(frame, p) {
      const click = frame.pointer?.click;
      const dt = frame.reduced ? 0 : Math.max(0, Math.min(.1, Number(frame.dt) || 0));
      if (performanceChanged && dt === 0) {
        ({ scatter, vortex } = butterflyTimeline(elapsed, p.performance));
        boost = 0; burstAge = 20; uniforms.uBurst.value = 0;
      }
      performanceChanged = false;
      if (frame.reduced) { lastSerial = click?.serial ?? lastSerial; appearance(); return; }
      pointer.update(frame, p.pointerStrength ?? 1);
      if (lastSerial === null) lastSerial = click?.serial ?? 0;
      else if (click && click.serial !== lastSerial) { lastSerial = click.serial; burstAge = 0; }
      burstAge += dt;
      boost += ((burstAge < 2.2 ? 1 : 0) - boost) * approach(dt, burstAge < 2.2 ? .48 : 1.2);
      elapsed += dt * (p.speed ?? .6) / .6;
      const target = butterflyTimeline(elapsed, p.performance || 'auto');
      scatter += (Math.max(target.scatter, boost) - scatter) * approach(dt, .55);
      vortex += (target.vortex - vortex) * approach(dt, .8);
      uniforms.uBass.value = frame.bands?.bass ?? 0; uniforms.uMid.value = frame.bands?.mid ?? 0; uniforms.uTreble.value = frame.bands?.treble ?? 0;
      uniforms.uPixel.value = ctx.renderer?.getPixelRatio() || 1;
      uniforms.uBurst.value = Math.exp(-burstAge * 1.8) * smooth(0, .2, burstAge);
      uniforms.uCharge.value += ((frame.pointer?.down && !frame.pointer.dragging ? 1 : 0) - uniforms.uCharge.value) * approach(dt, .5);
      appearance();
    },
    resize(w, h) { uniforms.uHeight.value = h; stars.uniforms.uHeight.value = h; },
    params(next) { performanceChanged ||= params.performance !== next.performance; params = next; density(); },
    quality(next) { profile = next; density(); },
    stats: () => ({ butterflies: swarm.count, dust: dust.geometry.drawRange.count, scatter, vortex, interactionBoost: boost, elapsed })
  });
}
