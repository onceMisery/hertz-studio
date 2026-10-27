// SPDX-License-Identifier: MIT
// 粒子反应堆：每首歌一套「色相 / 粒子壳层 / 机位」配方，切歌与悬停预览都在 GPU 上换场。
import { basicInstance, level, own, qualityDensity, root, seed } from './factories.js';
import { createParticlePointer, particlePointerShader } from './particle-pointer.js';

const TAU = Math.PI * 2;
const DEFAULT_HUE = 187 / 360;
const MORPH_SECONDS = 1.6, HUE_TAU = .42, SHOT_TAU = .6, SHOT_DELAY = .18, PULSE_SECONDS = .9, HUE_WAIT = .6, MAX_NODES = 24;
// Amber stays the house accent. The other two hues sit a third of the wheel away on either
// side, so even amber or cyan tracks keep distinct warm/cool families instead of one wash.
const ACCENT_HUE = 45 / 360, SECONDARY_SHIFT = .335, TERTIARY_SHIFT = .67;
export const SHELLS = Object.freeze([
  Object.freeze({ id: 'torus', label: '环面' }), Object.freeze({ id: 'sphere', label: '球壳' }),
  Object.freeze({ id: 'gyro', label: '双环' }), Object.freeze({ id: 'helix', label: '螺旋' })
]);
export const SHOTS = Object.freeze([
  Object.freeze({ id: 'front', label: '正面', yaw: 0, pitch: 0, dist: 1, fov: 0 }),
  Object.freeze({ id: 'high', label: '俯瞰', yaw: .2, pitch: .36, dist: 1.1, fov: -2 }),
  Object.freeze({ id: 'sweep', label: '侧掠', yaw: .7, pitch: .08, dist: .94, fov: 3 }),
  Object.freeze({ id: 'close', label: '贴近', yaw: -.24, pitch: -.05, dist: .8, fov: -5 })
]);

export function trackHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  // FNV alone barely moves the low bits when ids differ only in a trailing digit.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
export function recipeFor(id, hue) {
  if (!id) return { id: '', hue: DEFAULT_HUE, shell: 0, shot: 0 };
  const h = trackHash(String(id));
  return { id: String(id), hue: Number.isFinite(hue) ? hue : (h % 3600) / 3600, shell: (h >>> 12) % SHELLS.length, shot: (h >>> 20) % SHOTS.length };
}
// Saturation-weighted hue histogram; grey or near-black artwork defers to the id hash.
export function dominantHue(data) {
  const weight = new Float64Array(36), xs = new Float64Array(36), ys = new Float64Array(36);
  for (let i = 0; i + 2 < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), sat = max ? (max - min) / max : 0;
    if (max < .12 || sat < .18) continue;
    let hue = max === r ? (g - b) / (max - min) : max === g ? 2 + (b - r) / (max - min) : 4 + (r - g) / (max - min);
    hue = ((hue / 6) % 1 + 1) % 1;
    const w = sat * sat * max, bin = Math.floor(hue * 36) % 36;
    weight[bin] += w; xs[bin] += Math.cos(hue * TAU) * w; ys[bin] += Math.sin(hue * TAU) * w;
  }
  let best = -1, score = 0;
  for (let i = 0; i < 36; i++) {
    const s = weight[(i + 35) % 36] + weight[i] + weight[(i + 1) % 36];
    if (s > score) { score = s; best = i; }
  }
  if (best < 0 || score < .5) return null;
  let x = 0, y = 0;
  for (const i of [(best + 35) % 36, best, (best + 1) % 36]) { x += xs[i]; y += ys[i]; }
  return ((Math.atan2(y, x) / TAU) % 1 + 1) % 1;
}

const hueCache = new Map();
function rememberHue(id, hue) {
  hueCache.delete(id); hueCache.set(id, hue);
  while (hueCache.size > 128) hueCache.delete(hueCache.keys().next().value);
}
function createHueSampler(ctx, onReady) {
  const queue = [], pending = new Set(), latest = new Map(), failed = new Set();
  let busy = null;
  function finish(hue, error) {
    const job = busy; busy = null; pending.delete(job.key);
    if (ctx.signal.aborted) return;
    if (latest.get(job.id) === job.url) {
      if (error) failed.add(job.key); else rememberHue(job.key, hue);
      onReady();
    }
    pump();
  }
  function pump() {
    if (busy || ctx.signal.aborted) return;
    while (queue.length) {
      const job = queue.shift();
      if (latest.get(job.id) !== job.url) { pending.delete(job.key); continue; }
      const img = new Image(); busy = { ...job, img }; img.crossOrigin = 'anonymous'; img.decoding = 'async';
      img.onload = () => {
        if (busy?.img !== img) return;
        try {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 24;
          const g = canvas.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, 24, 24); finish(dominantHue(g.getImageData(0, 0, 24, 24).data), false);
        } catch { finish(null, true); }
      };
      img.onerror = () => { if (busy?.img === img) finish(null, true); };
      const resolve = ctx.services.resolveCover;
      Promise.resolve().then(() => resolve ? resolve(job.url) : job.url).then(src => {
        if (busy?.img !== img) return;
        if (src) img.src = src; else finish(null, true);
      }, () => { if (busy?.img === img) finish(null, true); });
      break;
    }
  }
  ctx.scope.defer(() => { if (busy) { busy.img.onload = busy.img.onerror = null; busy = null; } queue.length = 0; pending.clear(); });
  return {
    request(id, url) {
      if (!id) return;
      latest.set(id, url || '');
      if (busy?.id === id && busy.url !== url) { busy.img.onload = busy.img.onerror = null; pending.delete(busy.key); busy = null; }
      const key = id + '\n' + url;
      if (!url || hueCache.has(key) || pending.has(key) || failed.has(key) || typeof Image === 'undefined' || typeof document === 'undefined') { pump(); return; }
      pending.add(key); queue.push({ id, url, key });
      while (queue.length > MAX_NODES + 2) pending.delete(queue.shift().key);
      while (latest.size > 128) latest.delete(latest.keys().next().value);
      pump();
    },
    hue(id) { const value = hueCache.get(id + '\n' + latest.get(id)); return value == null ? undefined : value; },
    pending: id => pending.has(id + '\n' + latest.get(id))
  };
}

const cloudVertex = `
attribute vec4 aSeed;
uniform float uTime,uEnergy,uBurst,uPixel,uMorph,uScatter,uSize,uShellWeights[4];
uniform vec3 uBurstPoint,uColorA,uColorB,uColorC,uColorD;
varying vec3 vColor;varying vec3 vHalo;varying float vAlpha;
${particlePointerShader}
const float TAU=6.2831853;
vec3 shell(float k,vec4 s){
 float u=s.x*TAU,v=s.y*TAU;
 if(k<.5){
  float R=3.25+(s.z-.5)*.75,tube=1.08*pow(s.w,.58);
  vec3 p=vec3((R+tube*cos(v))*cos(u),tube*sin(v)*.78,(R+tube*cos(v))*sin(u));
  return vec3(p.x,p.y*.913-p.z*.408,p.y*.408+p.z*.913);
 }
 if(k<1.5){
  float band=floor(s.y*9.0);
  float y=clamp((band+.5)/4.5-1.0+(s.y*9.0-band-.5)*.045,-1.0,1.0);
  float r=sqrt(max(0.0,1.0-y*y)),R=3.2+(s.z-.5)*.45+pow(s.w,3.0)*.95;
  return vec3(cos(u)*r,y,sin(u)*r)*R;
 }
 if(k<2.5){
  bool outer=s.z<.55;float R=outer?3.15:2.2,tube=(outer?.6:.42)*pow(s.w,.6);
  vec3 p=vec3((R+tube*cos(v))*cos(u),tube*sin(v),(R+tube*cos(v))*sin(u));
  if(outer)return vec3(p.x,p.y*.94-p.z*.34,p.y*.34+p.z*.94);
  return vec3(p.x*.8-p.z*.6,p.y*.6+(p.x*.6+p.z*.8)*.8,-p.y*.8+(p.x*.6+p.z*.8)*.6);
 }
 float t=s.y*2.0-1.0,a=t*TAU*1.25+step(.5,s.z)*3.1415927,tube=.55*pow(s.w,.7);
 vec3 center=vec3(cos(a)*2.45,t*3.5,sin(a)*2.45);
 return center+vec3(cos(a)*cos(v),sin(v)*.8,sin(a)*cos(v))*tube;
}
vec3 shellTint(float k,vec4 s,float slot){
 if(k<.5){
  if(slot<.045)return uColorC;
  if(slot<.18)return uColorD;
  if(slot<.55)return mix(uColorB,uColorA,slot);
  return uColorA;
 }
 if(k<1.5){
  float band=mod(floor(s.y*9.0),6.0);
  if(band<1.0)return uColorD;
  if(band<2.8)return uColorA;
  if(band<4.0)return uColorB;
  if(band<5.2)return mix(uColorD,uColorA,.55);
  return uColorC;
 }
 if(k<2.5){
  if(s.z<.55)return slot<.32?uColorD:slot<.68?uColorB:uColorA;
  return slot<.2?uColorC:uColorD;
 }
 return s.z<.5?(slot<.14?uColorC:slot<.62?uColorA:uColorB):(slot<.38?uColorD:uColorB);
}
void main(){
 vec3 p=shell(0.0,aSeed)*uShellWeights[0]+shell(1.0,aSeed)*uShellWeights[1]
       +shell(2.0,aSeed)*uShellWeights[2]+shell(3.0,aSeed)*uShellWeights[3];
 vec3 n=normalize(p+vec3(.001));
 p+=n*sin(p.x*1.7+uTime*2.2+aSeed.x*8.0)*.08*(1.0+uEnergy*2.2);
 p+=n*pow(uEnergy,3.0)*sin(aSeed.x*81.0+uTime*3.0)*.45;
 p+=n*uScatter*(.6+aSeed.z*2.2);
 vec3 d=p-uBurstPoint;p+=normalize(d+vec3(.001))*uBurst*exp(-length(d)*.55)*1.4;
 p=indentParticle(p);
 vec4 view=modelViewMatrix*vec4(p,1.0);gl_Position=projectionMatrix*view;
 float size=.8+pow(fract(aSeed.x*13.17+aSeed.y*7.31),3.0)*3.2;
 float shellScale=uShellWeights[0]+uShellWeights[1]*.78+uShellWeights[2]*1.16+uShellWeights[3]*.9;
 gl_PointSize=clamp(size*uSize*uPixel*shellScale*(22.0/max(.5,-view.z))*(1.0+uEnergy*.85),1.0,15.0);
 float slot=fract(aSeed.x*7.31+aSeed.z*3.17);
 vec3 tint=shellTint(0.0,aSeed,slot)*uShellWeights[0]+shellTint(1.0,aSeed,slot)*uShellWeights[1]
          +shellTint(2.0,aSeed,slot)*uShellWeights[2]+shellTint(3.0,aSeed,slot)*uShellWeights[3];
 float heat=pow(max(0.0,1.0-length(p)/4.4),3.0);
 float travel=.5+.5*sin(aSeed.x*TAU*2.0+uTime*1.15+p.y*1.4);
 tint=mix(tint,uColorC,travel*travel*.13*(.35+uEnergy));
 vColor=tint*(.72+fract(aSeed.y*5.7)*.28+heat*.22);
 vHalo=mix(uColorD,uColorC,clamp((slot-.58)*2.3,0.0,.8));
 vHalo=mix(vHalo,uColorB,slot*.22+heat*.18);
 float pulse=sin(aSeed.x*20.0+uTime*1.4);vAlpha=(.42+.58*pulse*pulse)*(uShellWeights[0]*.96+uShellWeights[1]*.68+uShellWeights[2]+uShellWeights[3]*.84);
}`;
const cloudFragment = `
varying vec3 vColor;varying vec3 vHalo;varying float vAlpha;
void main(){vec2 p=gl_PointCoord-.5;float d=length(p);if(d>.5)discard;
 float core=smoothstep(.18,0.0,d),glow=smoothstep(.5,.05,d);
 vec3 color=mix(vHalo,vColor,.28+core*.72);
 color+=vColor*core*.55;
 gl_FragColor=vec4(color*(glow*1.08+core*1.6),(glow*.78+core)*vAlpha);
 #include <colorspace_fragment>
}`;
const glowVertex = `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
const glowFragment = `
uniform vec3 uColor;uniform float uOpacity;varying vec2 vUv;
void main(){float d=length(vUv-.5)*2.0;if(d>1.0)discard;
 float core=exp(-d*d*28.0),halo=exp(-d*d*5.0)*.42,tail=(1.0-smoothstep(.45,1.0,d))*.12;
 gl_FragColor=vec4(mix(uColor,vec3(1.0),core*.8),(core*.85+halo+tail)*uOpacity);
 #include <colorspace_fragment>
}`;
const nodeVertex = `
attribute vec3 aColor;attribute float aSize;uniform float uFocal;varying vec3 vColor;
void main(){vColor=aColor;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mv;
 gl_PointSize=clamp(aSize*uFocal/max(.5,-mv.z),2.0,96.0);}`;
const nodeFragment = `
uniform vec3 uHalo;varying vec3 vColor;
void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;
 float core=smoothstep(.2,0.0,d),glow=smoothstep(.5,0.0,d);
 vec3 color=mix(uHalo,vColor,core*.82+glow*.35);
 gl_FragColor=vec4(color*(glow*.8+core*1.6),glow*.55+core);
 #include <colorspace_fragment>
}`;

const shortest = (from, to) => ((to - from) % 1 + 1.5) % 1 - .5;
const approach = (dt, tau) => 1 - Math.exp(-dt / tau);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createReactor(ctx) {
  const T = ctx.THREE, group = root(ctx), world = new T.Group(); group.add(world);
  const previousFog = ctx.scene.fog;
  ctx.scene.fog = new T.FogExp2(0x030405, .03);
  ctx.scope.defer(() => { ctx.scene.fog = previousFog || null; });
  const colorA = new T.Color(), colorB = new T.Color(), colorC = new T.Color(), colorD = new T.Color(), colorDim = new T.Color(), white = new T.Color(1, 1, 1);
  const additive = (material, extra = {}) => own(ctx, new material({ transparent: true, depthWrite: false, blending: T.AdditiveBlending, ...extra }));

  const COUNT = 9000, positions = new Float32Array(COUNT * 3), seeds = new Float32Array(COUNT * 4);
  for (let i = 0; i < COUNT; i++) {
    const s = [seed(i, 1), seed(i, 2), seed(i, 3), seed(i, 4)], u = s[0] * TAU, v = s[1] * TAU;
    const R = 3.25 + (s[2] - .5) * .75, tube = 1.08 * Math.pow(s[3], .58);
    positions.set([(R + tube * Math.cos(v)) * Math.cos(u), tube * Math.sin(v) * .78, (R + tube * Math.cos(v)) * Math.sin(u)], i * 3);
    seeds.set(s, i * 4);
  }
  const cloudGeometry = own(ctx, new T.BufferGeometry());
  cloudGeometry.setAttribute('position', new T.BufferAttribute(positions, 3));
  cloudGeometry.setAttribute('aSeed', new T.BufferAttribute(seeds, 4));
  const cloudGroup = new T.Group(); world.add(cloudGroup);
  const pointer = createParticlePointer(ctx, cloudGroup, { radius: 1.6 });
  const shellWeights = new Float32Array([1, 0, 0, 0]), fromWeights = shellWeights.slice(), toWeights = shellWeights.slice();
  const uniforms = { ...pointer.uniforms, uTime: { value: 0 }, uEnergy: { value: .35 }, uBurst: { value: 0 }, uPixel: { value: 1 },
    uShellWeights: { value: shellWeights }, uMorph: { value: 1 }, uScatter: { value: 0 }, uSize: { value: 1 },
    uBurstPoint: { value: new T.Vector3() }, uColorA: { value: colorA }, uColorB: { value: colorB }, uColorC: { value: colorC }, uColorD: { value: colorD } };
  const cloud = new T.Points(cloudGeometry, own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: cloudVertex, fragmentShader: cloudFragment,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending })));
  cloud.frustumCulled = false; cloudGroup.add(cloud);

  const glowGeometry = own(ctx, new T.PlaneGeometry(1, 1));
  const glow = (opacity) => {
    const material = own(ctx, new T.ShaderMaterial({ uniforms: { uColor: { value: new T.Color() }, uOpacity: { value: opacity } },
      vertexShader: glowVertex, fragmentShader: glowFragment, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
    const mesh = new T.Mesh(glowGeometry, material); mesh.frustumCulled = false; group.add(mesh); return mesh;
  };
  const coreGlow = glow(.5), accentGlow = glow(.26);

  const coreMaterial = own(ctx, new T.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: .3 }));
  const core = new T.Mesh(own(ctx, new T.IcosahedronGeometry(1.32, 2)), coreMaterial); world.add(core);
  const innerMaterial = own(ctx, new T.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: .72 }));
  const innerGeometry = own(ctx, new T.IcosahedronGeometry(.72, 1));
  const innerCore = new T.Mesh(innerGeometry, innerMaterial); world.add(innerCore);
  const midMaterial = own(ctx, new T.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: .27 }));
  const midCore = new T.Mesh(innerGeometry, midMaterial); midCore.scale.setScalar(1.48); world.add(midCore);
  const shockMaterial = additive(T.MeshBasicMaterial, { opacity: 0, side: T.DoubleSide });
  const shockwave = new T.Mesh(own(ctx, new T.RingGeometry(2.9, 2.96, 128)), shockMaterial); shockwave.position.z = 1.4; world.add(shockwave);

  const rings = [];
  for (let ring = 0; ring < 7; ring++) {
    const points = [];
    for (let i = 0; i < 180; i++) {
      const angle = i / 180 * TAU, radius = 2.1 + ring * .44 + Math.sin(angle * (3 + ring) + ring) * .06;
      points.push(new T.Vector3(Math.cos(angle) * radius, Math.sin(angle * (2 + ring % 2)) * .12, Math.sin(angle) * radius));
    }
    const line = new T.LineLoop(own(ctx, new T.BufferGeometry().setFromPoints(points)), additive(T.LineBasicMaterial, { opacity: .14 + ring * .025 }));
    line.userData.base = [(ring - 3) * .16, ring * .38, ring * .13];
    rings.push(line); world.add(line);
  }

  const tickGroup = new T.Group(); world.add(tickGroup);
  const tickLines = [[], [], []];
  for (let i = 0; i < 180; i++) {
    const angle = i / 180 * TAU, inner = 5.35, outer = inner + (i % 15 === 0 ? .5 : i % 5 === 0 ? .26 : .11);
    tickLines[i % 15 === 0 ? 2 : i % 5 === 0 ? 1 : 0].push(Math.cos(angle) * inner, 0, Math.sin(angle) * inner, Math.cos(angle) * outer, 0, Math.sin(angle) * outer);
  }
  const tickMaterials = tickLines.map((_, i) => additive(T.LineBasicMaterial, { opacity: [.28, .36, .46][i] }));
  tickLines.forEach((list, i) => {
    const geometry = own(ctx, new T.BufferGeometry()); geometry.setAttribute('position', new T.Float32BufferAttribute(list, 3));
    tickGroup.add(new T.LineSegments(geometry, tickMaterials[i]));
  });

  const scanMaterialA = additive(T.MeshBasicMaterial, { opacity: .35 }), scanMaterialB = additive(T.MeshBasicMaterial, { opacity: .22 });
  const scanRingA = new T.Mesh(own(ctx, new T.TorusGeometry(4.15, .012, 6, 140)), scanMaterialA); scanRingA.rotation.x = Math.PI / 2; world.add(scanRingA);
  const scanRingB = new T.Mesh(own(ctx, new T.TorusGeometry(3.55, .01, 6, 140)), scanMaterialB); scanRingB.rotation.x = Math.PI / 2; world.add(scanRingB);
  const beamMaterial = additive(T.MeshBasicMaterial, { opacity: .028, side: T.DoubleSide });
  const beam = new T.Mesh(own(ctx, new T.CylinderGeometry(.25, 4.6, 9.5, 48, 1, true)), beamMaterial); beam.position.y = -.2; world.add(beam);

  const pillarPositions = [];
  for (let i = 0; i < 64; i++) {
    const angle = i / 64 * TAU, radius = 5.05 + (i % 4) * .06, height = .4 + seed(i, 9) * 1.6;
    pillarPositions.push(Math.cos(angle) * radius, -2.2, Math.sin(angle) * radius, Math.cos(angle) * radius, -2.2 + height, Math.sin(angle) * radius);
  }
  const pillarGeometry = own(ctx, new T.BufferGeometry()); pillarGeometry.setAttribute('position', new T.Float32BufferAttribute(pillarPositions, 3));
  const pillarMaterial = additive(T.LineBasicMaterial, { opacity: .28 });
  const pillars = new T.LineSegments(pillarGeometry, pillarMaterial); world.add(pillars);

  const DUST = 1800, dustPositions = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) dustPositions.set([(seed(i, 11) - .5) * 50, (seed(i, 12) - .5) * 28, -8 - seed(i, 13) * 55], i * 3);
  const dustGeometry = own(ctx, new T.BufferGeometry()); dustGeometry.setAttribute('position', new T.BufferAttribute(dustPositions, 3));
  const dustMaterial = own(ctx, new T.PointsMaterial({ size: .035, transparent: true, opacity: .5, depthWrite: false }));
  const dust = new T.Points(dustGeometry, dustMaterial); dust.frustumCulled = false; group.add(dust);

  const gridPositions = [];
  for (let i = 0; i <= 60; i++) { const k = i - 30; gridPositions.push(-30, 0, k, 30, 0, k, k, 0, -30, k, 0, 30); }
  const gridGeometry = own(ctx, new T.BufferGeometry()); gridGeometry.setAttribute('position', new T.Float32BufferAttribute(gridPositions, 3));
  const gridMaterial = own(ctx, new T.LineBasicMaterial({ transparent: true, opacity: .34 }));
  const grid = new T.LineSegments(gridGeometry, gridMaterial); grid.position.y = -4.1; group.add(grid);
  const padMaterial = additive(T.MeshBasicMaterial, { opacity: .22, side: T.DoubleSide }), padAccentMaterial = additive(T.MeshBasicMaterial, { opacity: .16, side: T.DoubleSide });
  const pad = new T.Mesh(own(ctx, new T.RingGeometry(4.4, 4.46, 128)), padMaterial); pad.rotation.x = -Math.PI / 2; pad.position.y = -4.08; group.add(pad);
  const padAccent = new T.Mesh(own(ctx, new T.RingGeometry(5.15, 5.18, 128)), padAccentMaterial); padAccent.rotation.x = -Math.PI / 2; padAccent.position.y = -4.08; group.add(padAccent);

  const nodePositions = new Float32Array(MAX_NODES * 3), nodeColors = new Float32Array(MAX_NODES * 3), nodeSizes = new Float32Array(MAX_NODES);
  const nodeGeometry = own(ctx, new T.BufferGeometry());
  nodeGeometry.setAttribute('position', new T.BufferAttribute(nodePositions, 3));
  nodeGeometry.setAttribute('aColor', new T.BufferAttribute(nodeColors, 3));
  nodeGeometry.setAttribute('aSize', new T.BufferAttribute(nodeSizes, 1));
  nodeGeometry.setDrawRange(0, 0);
  const nodeUniforms = { uFocal: { value: 700 }, uHalo: { value: new T.Color() } };
  const nodes = new T.Points(nodeGeometry, own(ctx, new T.ShaderMaterial({ uniforms: nodeUniforms, vertexShader: nodeVertex, fragmentShader: nodeFragment,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending })));
  nodes.frustumCulled = false; world.add(nodes);

  let profile = ctx.quality, params = ctx.params, width = 1280, height = 720, pose = null, lastNow = null;
  let shown = recipeFor('', null), reported = '', hueNow = shown.hue, hueTarget = shown.hue, waitHue = 0;
  let toShell = 0, morph = 1, pulse = 1, pulseGain = 0, pulseOrigin = 0, energy = .35, burstAge = 10, lastClick = null, burstCount = 0;
  const shot = { yaw: 0, pitch: 0, dist: 1, fov: 0 }, parallax = new T.Vector2();
  let aimShot = 0, shotWait = 0;
  let queueKey = '', queueItems = [], renderedItems = [], hoverNode = -1, hoverTrack = null, hoverPointer = null, hueVersion = 0, paintedVersion = -1, currentId = '';
  const sampler = createHueSampler(ctx, () => { hueVersion++; ctx.services.invalidate?.(); });
  const ray = new T.Raycaster(), ndc = new T.Vector2(), plane = new T.Plane(), hit = new T.Vector3(), normal = new T.Vector3(), projected = new T.Vector3(), pickView = new T.Vector3(), cameraQuat = new T.Quaternion(), parentQuat = new T.Quaternion();

  function density() { cloudGeometry.setDrawRange(0, Math.floor(COUNT * qualityDensity(profile) * (params.density ?? 1))); dustGeometry.setDrawRange(0, Math.floor(DUST * qualityDensity(profile))); }
  density();
  function palette(hue) {
    const primary = ((hue % 1) + 1) % 1;
    colorA.setHSL(primary, .96, .6);
    colorB.setHSL((primary + SECONDARY_SHIFT) % 1, .92, .53);
    colorC.setHSL(ACCENT_HUE, 1, .62);
    colorD.setHSL((primary + TERTIARY_SHIFT) % 1, .95, .55);
    colorDim.setHSL(primary, .62, .24);
    coreMaterial.color.copy(colorA).lerp(white, .35);
    midMaterial.color.copy(colorD).lerp(white, .18);
    innerMaterial.color.copy(colorC);
    shockMaterial.color.copy(colorC); scanMaterialA.color.copy(colorA); scanMaterialB.color.copy(colorD);
    beamMaterial.color.copy(colorA).lerp(colorD, .35).multiplyScalar(.7); pillarMaterial.color.copy(colorDim);
    const tones = [colorA, colorD, colorB, colorC];
    rings.forEach((line, i) => line.material.color.copy(tones[i % tones.length]));
    tickMaterials[0].color.copy(colorA); tickMaterials[1].color.copy(colorD); tickMaterials[2].color.copy(colorC);
    dustMaterial.color.copy(colorDim).lerp(colorD, .35); gridMaterial.color.copy(colorDim);
    padMaterial.color.copy(colorA); padAccentMaterial.color.copy(colorD);
    coreGlow.material.uniforms.uColor.value.copy(colorA).multiplyScalar(.55); accentGlow.material.uniforms.uColor.value.copy(colorD);
    nodeUniforms.uHalo.value.copy(colorD).lerp(colorC, .16);
    ctx.scene.fog?.color.copy(colorDim).multiplyScalar(.55);
  }
  function hueOf(id) { return sampler.hue(id); }
  function retarget(next, reduced, preview) {
    const changed = next.id !== shown.id || next.shell !== shown.shell || next.shot !== shown.shot;
    if (toShell !== next.shell) {
      fromWeights.set(shellWeights); toWeights.fill(0); toWeights[next.shell] = 1; toShell = next.shell; morph = 0;
    }
    if (changed && next.id !== shown.id) { pulseOrigin = uniforms.uScatter.value; pulse = 0; pulseGain = preview ? .45 : .9; if (!preview && next.id) burstAge = 0; }
    shown = next;
    if (reduced) { shellWeights.fill(0); shellWeights[next.shell] = 1; fromWeights.set(shellWeights); toWeights.set(shellWeights); toShell = next.shell; morph = 1; pulse = 1; }
  }
  function report(preview) {
    const key = [shown.id, Math.round(shown.hue * 360), shown.shell, shown.shot, preview ? 1 : 0].join('|');
    if (key === reported) return;
    reported = key;
    ctx.services.onRecipe?.({ id: shown.id, preview: !!preview, hue: Math.round(shown.hue * 360),
      shell: SHELLS[shown.shell].label, shot: SHOTS[shown.shot].label });
  }
  function syncQueue(list, current) {
    const items = list.slice(0, MAX_NODES), key = items.map(item => item.id + '|' + (item.cover || '')).join('\n') + '|' + current;
    const currentIndex = items.findIndex(item => item.id === current);
    const nextId = currentIndex >= 0 && items.length > 1 ? items[(currentIndex + 1) % items.length].id : '';
    // Current and preview covers come from the frame (freshest URL); only the next track is prefetched here.
    for (const item of items) if (item.id === nextId) sampler.request(item.id, item.cover);
    if (key === queueKey && paintedVersion === hueVersion) return;
    queueKey = key; paintedVersion = hueVersion; queueItems = items;
    const color = new T.Color();
    items.forEach((item, i) => {
      color.setHSL(recipeFor(item.id, hueOf(item.id)).hue, .85, item.id === current ? .82 : .64).toArray(nodeColors, i * 3);
    });
    nodeGeometry.attributes.aColor.needsUpdate = true; nodeGeometry.setDrawRange(0, items.length);
    if (hoverNode >= items.length) hoverNode = -1;
  }
  function applyCamera(charge) {
    if (!pose) return;
    const camera = ctx.camera;
    if (pose.position) {
      camera.position.fromArray(pose.position); camera.rotation.set(pose.pitch, pose.yaw, pose.roll, 'YXZ'); camera.fov = pose.fov;
    } else {
      const yaw = pose.yaw + shot.yaw, pitch = clamp(pose.pitch + shot.pitch, -1.2, 1.2), dist = Math.max(2.5, pose.dist * shot.dist - charge * .6), cp = Math.cos(pitch);
      camera.position.set(pose.tx + Math.sin(yaw) * cp * dist, pose.ty + Math.sin(pitch) * dist, pose.tz + Math.cos(yaw) * cp * dist);
      camera.lookAt(pose.tx, pose.ty, pose.tz); camera.rotateZ(pose.roll); camera.fov = clamp(pose.fov + shot.fov, 20, 90);
    }
    camera.updateProjectionMatrix();
  }
  function pickNode(frame) {
    const p = frame.pointer;
    if (!p?.active || !renderedItems.length || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return -1;
    ctx.camera.updateMatrixWorld();
    const dpr = ctx.renderer?.getPixelRatio() || 1;
    const focal = height * dpr * ctx.camera.projectionMatrix.elements[5] * .5;
    let best = -1, bestScore = 1;
    for (let i = 0; i < renderedItems.length; i++) {
      projected.fromArray(nodePositions, i * 3).applyMatrix4(nodes.matrixWorld);
      pickView.copy(projected).applyMatrix4(ctx.camera.matrixWorldInverse);
      projected.copy(pickView).applyMatrix4(ctx.camera.projectionMatrix);
      if (projected.z > 1) continue;
      const distance = Math.hypot((projected.x - p.x) * width / 2, (projected.y - p.y) * height / 2);
      // Match the hit circle to the point size the shader draws, so edge clicks respond at any zoom.
      const diameter = clamp(nodeSizes[i] * focal / Math.max(.5, -pickView.z), 2, 96) / dpr;
      const score = distance / Math.max(12, diameter * .58);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }
  function burstAt(click) {
    ndc.set(click.x, click.y); ctx.camera.updateMatrixWorld(); ray.setFromCamera(ndc, ctx.camera);
    ctx.camera.getWorldDirection(normal).negate(); world.updateMatrixWorld(true);
    plane.setFromNormalAndCoplanarPoint(normal, world.getWorldPosition(hit));
    if (ray.ray.intersectPlane(plane, hit)) { cloudGroup.worldToLocal(hit); uniforms.uBurstPoint.value.copy(hit); }
    burstAge = 0; burstCount++;
  }

  return Object.assign(basicInstance(group, params, profile, {
    update(frame, p) {
      const now = Number.isFinite(frame.now) ? frame.now : 0, reduced = !!frame.reduced;
      const dt = reduced || lastNow === null ? 0 : clamp((now - lastNow) / 1000, 0, .1);
      lastNow = now;
      const speed = (p.speed ?? .6) / .6, t = (frame.sceneTime ?? frame.time ?? 0) * speed;
      const track = frame.track || {}, preview = p.queuePreview !== false && p.trackRecipes !== false ? frame.preview : null;
      currentId = track.id ? String(track.id) : '';
      sampler.request(currentId, track.cover || (typeof ctx.services.coverUrl === 'function' ? ctx.services.coverUrl() : ''));
      if (preview?.id && String(preview.id) !== currentId) sampler.request(String(preview.id), preview.cover);
      const queue = typeof ctx.services.queue === 'function' ? ctx.services.queue() || [] : [];
      syncQueue(queue, currentId);

      const previewing = !!(preview?.id && String(preview.id) !== currentId);
      const targetId = p.trackRecipes === false ? '' : previewing ? String(preview.id) : currentId;
      const next = recipeFor(targetId, hueOf(targetId));
      if (next.id !== shown.id) waitHue = 0;
      if (next.id && hueOf(next.id) === undefined && sampler.pending(next.id) && waitHue < HUE_WAIT && !reduced) { waitHue += dt; next.hue = shown.id === next.id ? shown.hue : hueTarget; }
      retarget(next, reduced, previewing);
      hueTarget = next.hue;
      report(previewing);

      if (reduced) {
        aimShot = shown.shot; shotWait = 0;
        const aim = SHOTS[shown.shot];
        hueNow = hueTarget; Object.assign(shot, { yaw: aim.yaw, pitch: aim.pitch, dist: aim.dist, fov: aim.fov });
      } else {
        if (aimShot !== shown.shot) { aimShot = shown.shot; shotWait = SHOT_DELAY; }
        shotWait = Math.max(0, shotWait - dt);
        hueNow = ((hueNow + shortest(hueNow, hueTarget) * approach(dt, HUE_TAU)) % 1 + 1) % 1;
        if (shotWait === 0) {
          const aim = SHOTS[aimShot];
          for (const key of ['yaw', 'pitch', 'dist', 'fov']) shot[key] += (aim[key] - shot[key]) * approach(dt, SHOT_TAU);
        }
        morph = Math.min(1, morph + dt / MORPH_SECONDS); pulse = Math.min(1, pulse + dt / PULSE_SECONDS);
      }
      palette(hueNow);
      const shellMix = morph * morph * (3 - 2 * morph);
      for (let i = 0; i < shellWeights.length; i++) shellWeights[i] = fromWeights[i] * (1 - shellMix) + toWeights[i] * shellMix;
      uniforms.uMorph.value = morph;
      uniforms.uScatter.value = pulse < 1 ? pulseOrigin * (1 - pulse) + Math.sin(pulse * Math.PI) * pulseGain : 0;

      world.updateMatrixWorld(true);
      const canHover = frame.pointer?.active && !frame.pointer.dragging && p.queuePreview !== false && p.trackRecipes !== false;
      const pointerMoved = hoverPointer && frame.pointer
        ? Math.hypot((frame.pointer.x - hoverPointer.x) * width / 2, (frame.pointer.y - hoverPointer.y) * height / 2)
        : Infinity;
      let hoverId = null;
      if (canHover && hoverTrack && pointerMoved < 8) hoverId = hoverTrack;
      else if (canHover) { const index = pickNode(frame); hoverId = index >= 0 ? renderedItems[index].id : null; }
      hoverNode = queueItems.findIndex(item => item.id === hoverId);
      const selectedHover = hoverNode >= 0 ? hoverId : null;
      if (selectedHover !== hoverTrack) {
        hoverTrack = selectedHover;
        const item = queueItems[hoverNode];
        if (item) sampler.request(item.id, item.cover);
        ctx.services.previewTrack?.(hoverTrack);
      }
      hoverPointer = canHover ? { x: frame.pointer.x, y: frame.pointer.y } : null;
      const click = frame.pointer?.click;
      if (lastClick === null) lastClick = click ? click.serial : 0;
      if (click && click.serial !== lastClick) {
        lastClick = click.serial;
        const target = pickNode({ pointer: { active: true, x: click.x, y: click.y } });
        const latched = hoverTrack && hoverPointer
          && Math.hypot((click.x - hoverPointer.x) * width / 2, (click.y - hoverPointer.y) * height / 2) < 8;
        const id = latched ? hoverTrack : target >= 0 ? renderedItems[target].id : null;
        if (id && id !== currentId && queueItems.some(item => item.id === id)) ctx.services.playTrack?.(id);
        if (!reduced) burstAt(click);
      }
      burstAge += dt;
      const shock = reduced ? 1 : Math.min(1, burstAge / PULSE_SECONDS), burst = 1 - shock;
      const held = !reduced && !!frame.pointer?.down;
      const beat = Math.min(1, (typeof frame.onset === 'number' ? frame.onset : 0) * .8 + level(frame, 'bass') * .45) * (p.reactivity ?? .7) / .7;
      const energyTarget = held ? 1 : Math.min(1, .2 + beat * .46 + burst * .35);
      energy = reduced ? energyTarget : energy + (energyTarget - energy) * approach(dt, .2);
      uniforms.uTime.value = t; uniforms.uEnergy.value = energy; uniforms.uBurst.value = burst * burst;
      uniforms.uPixel.value = ctx.renderer?.getPixelRatio() || 1; uniforms.uSize.value = p.pointSize ?? 1;

      if (!reduced && frame.pointer?.active && Number.isFinite(frame.pointer.x)) parallax.lerp(frame.pointer, approach(dt, .35));
      world.rotation.y = t * .075 + parallax.x * .2;
      world.rotation.x = parallax.y * -.11;
      cloud.rotation.z = t * .035;
      core.rotation.set(t * .18, -t * .22, t * .08);
      innerCore.scale.setScalar(1 + beat * .12); innerCore.rotation.set(-t * .36, t * .48, 0);
      midCore.rotation.set(t * .23, -t * .31, t * .09); midCore.scale.setScalar(1.48 + beat * .18);
      shockwave.scale.setScalar(.45 + shock * 2.1); shockMaterial.opacity = shock < 1 ? (1 - shock) * .42 : 0;
      tickGroup.rotation.y = -t * .03;
      const scan = .5 + .5 * Math.sin(t * .5);
      scanRingA.position.y = Math.sin(t * .5) * 2.6; scanMaterialA.opacity = .16 + scan * .24;
      scanRingB.position.y = Math.sin(t * .5 + Math.PI) * 2.3; scanMaterialB.opacity = .1 + (1 - scan) * .16;
      beam.rotation.y = t * .05; pillars.rotation.y = t * .02;
      pad.rotation.z = t * .03; padAccent.rotation.z = -t * .02;
      rings.forEach((line, i) => {
        const [x, y, z] = line.userData.base;
        line.rotation.set(x, y + (i % 2 ? -1 : 1) * (.048 + i * .009) * t, z + .024 * t);
      });
      dust.position.set(parallax.x * -1.2, parallax.y * -.8, 0);

      queueItems.forEach((item, i) => {
        const angle = i / Math.max(1, queueItems.length) * TAU + t * (.1 + (i % 5) * .018), radius = 3.5 + (i % 3) * .65;
        nodePositions.set([Math.cos(angle) * radius, Math.sin(angle * 2.4 + i) * 1.35, Math.sin(angle) * radius], i * 3);
        nodeSizes[i] = (item.id === currentId ? .9 : .5) * (i === hoverNode ? 1.65 : 1) * (1 + beat * .4);
      });
      if (queueItems.length) { nodeGeometry.attributes.position.needsUpdate = true; nodeGeometry.attributes.aSize.needsUpdate = true; }
      nodeUniforms.uFocal.value = height * (ctx.renderer?.getPixelRatio() || 1) * ctx.camera.projectionMatrix.elements[5] * .5;

      applyCamera(held ? energy : 0);
      ctx.camera.updateMatrixWorld();
      group.updateMatrixWorld(true);
      renderedItems = queueItems.slice();
      group.getWorldQuaternion(parentQuat).invert();
      ctx.camera.getWorldQuaternion(cameraQuat);
      coreGlow.quaternion.copy(parentQuat).multiply(cameraQuat); accentGlow.quaternion.copy(coreGlow.quaternion);
      coreGlow.scale.setScalar(7.2 + beat * 1.3 + burst * 1.6); accentGlow.scale.setScalar(3.1 + beat * .9 + burst * 1.1);
      pointer.update(frame, (p.pointerStrength ?? 1) * .6);
    },
    resize(w, h) { width = w; height = h; },
    params(next) { params = next; density(); }, quality(next) { profile = next; density(); },
    stats: () => ({ particles: cloudGeometry.drawRange.count + dustGeometry.drawRange.count + nodeGeometry.drawRange.count, nodes: queueItems.length,
      recipe: { id: shown.id, hue: Math.round(shown.hue * 360), shell: SHELLS[shown.shell].id, shot: SHOTS[shown.shot].id }, morph, hover: hoverNode, energy, bursts: burstCount,
      yaw: ((world.rotation.y * 180 / Math.PI) % 360 + 360) % 360, zoom: 15 / Math.max(1, ctx.camera.position.length()) })
  }), { setRig(value) { pose = value; } });
}
