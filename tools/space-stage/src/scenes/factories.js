// SPDX-License-Identifier: MIT
import { createSpatialResources } from './resources.js';
import { createParticlePointer, particleNoiseShader, particlePointerShader } from './particle-pointer.js';

const TAU = Math.PI * 2;
const silentBands = Object.freeze({ bass: 0, mid: 0, treble: 0 });
const silentSpectrum = new Float32Array(16);
export function motionFrame(frame, reduced, preservePlayback = false) {
  // 环境运动许可（P0-02 时钟分离）：motionActive 由宿主策略显式计算；
  // 未携带该字段的旧宿主回退到 playing 语义，行为不变。
  const motionAllowed = frame.motionActive === undefined ? frame.playing !== false : !!frame.motionActive;
  const frozen = reduced || frame.reduced, sceneTime = reduced ? 0 : frame.sceneTime ?? frame.time ?? 0;
  return { ...frame, sceneTime, reduced: !!frozen, dt: frame.dynamicDt ?? (motionAllowed && !frozen ? frame.dt : 0),
    ...(preservePlayback ? {} : { time: sceneTime }), ...(frozen ? { level: 0, bands: silentBands, spectrum: silentSpectrum, onset: 0 } : {}) };
}
export const seed = (i, salt = 0) => { const n = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453; return n - Math.floor(n); };
export const number = (label, value, min, max, step = .05) => ({ type: 'number', label, default: value, min, max, step });
const optionLabels = {
  auto: '自动', verse: '主歌', chorus: '副歌', bridge: '过渡', venue: '第一现场', diorama: '纸雕剧场', tempo: '节拍律动', still: '静帧',
  duo: '双色', mono: '单色', vivid: '浓彩', 'split-duo': '双色分割', 'quad-grid': '四格构图', 'diagonal-cut': '斜切构图', triptych: '三联构图',
  banded: '横向色带', 'poster-frame': '海报边框', 'fan-burst': '放射构图', shutters: '百叶构图', 'offset-collage': '错位拼贴',
  'editorial-column': '社论栏', 'type-impact': '文字冲击', 'fragment-collage': '碎片拼贴', 'tracking-ribbon': '追踪光带', 'mask-reveal': '遮罩揭示',
  'poster-blocks': '海报色块', 'quiet-tableau': '静像', orbital: '环绕', constellation: '星群', perspective: '透视走廊', 'wave-score': '声波谱面',
  orrery: '星轨仪', 'editorial-lattice': '格栅谱面'
};
export const select = (label, value, options) => ({ type: 'select', label, default: value, options: options.map(option => typeof option === 'string' ? { value: option, label: optionLabels[option] || option } : option) });
export const commonParams = {
  speed: number('运动速度', .6, 0, 2), reactivity: number('律动强度', .7, 0, 2),
  scale: number('空间尺度', 1, .5, 2), density: number('粒子密度', 1, .2, 1),
  director: { type: 'boolean', label: '自动导演', default: false },
  cue: select('段落编排', 'auto', ['auto', 'verse', 'chorus', 'bridge']),
  dust: number('空间光尘', 0, 0, 1), discRing: { type: 'boolean', label: '环绕频谱', default: false },
  ripples: number('节拍涟漪', 0, 0, 1)
};
export function own(ctx, resource) { ctx.scope.track(resource); return resource; }
export function root(ctx) { const group = new ctx.THREE.Group(); ctx.scene.add(group); ctx.scope.defer(() => group.removeFromParent()); return group; }
export function level(frame, name) {
  const value = frame.bands?.[name] ?? (name === 'bass' ? frame.level : 0);
  return Math.min(1, Math.max(0, Number(value) || 0));
}
export function qualityDensity(profile) { return Math.max(.1, Math.min(1, profile?.density ?? ({ low: .4, medium: .7, high: 1 }[profile?.mode]) ?? .7)); }
export function writeSpectrum(target, frame) {
  const source = frame.spectrum || frame.bands?.spectrum;
  for (let i = 0; i < target.length; i++) {
    const sample = source?.[Math.floor(i / target.length * source.length)];
    target[i] = sample === undefined ? level(frame, i < 5 ? 'bass' : i < 11 ? 'mid' : 'treble') : Math.max(0, Math.min(1, sample > 1 ? sample / 255 : Number(sample) || 0));
  }
}
export function basicInstance(group, params, quality, hooks = {}) {
  let gone = false;
  return {
    group,
    update(frame) { if (!gone) hooks.update?.(frame, params); },
    resize(w, h) { hooks.resize?.(w, h); },
    setParams(next) { params = { ...params, ...next }; hooks.params?.(params); },
    setQuality(next) { quality = next; hooks.quality?.(quality); },
    dispose() { if (gone) return; gone = true; hooks.dispose?.(); group.removeFromParent(); },
    stats: () => hooks.stats?.() || {}
  };
}
const particleVertex = `
attribute float aSeed; attribute vec2 aCover;
uniform float uTime,uBass,uMid,uTreble,uMotion,uResponse,uSize,uMode,uPixel,uHeight,uRefined;
uniform float uBands[16];
varying vec3 vColor; varying vec2 vCover;varying float vAlpha,vGlow;
${particleNoiseShader}
${particlePointerShader}
float noise(vec3 p){return particleNoise(p);}
mat2 turn(float a){return mat2(cos(a),-sin(a),sin(a),cos(a));}
void main(){
 vec3 p=position;float t=uTime*uMotion,a=aCover.x*6.2831853,b=aCover.y;
 float band=uBands[int(clamp(floor(aCover.x*16.0),0.0,15.0))],drive=band*uResponse;
 vColor=color;vCover=aCover;vAlpha=.72;vGlow=.2;
 if(uMode<.5||uMode>8.5){
  float y=1.0-2.0*b;vec3 n=vec3(cos(a)*sqrt(max(0.0,1.0-y*y)),y,sin(a)*sqrt(max(0.0,1.0-y*y)));
  float detail=noise(n*3.2+vec3(0,t*.3,t*.18));
  float r=3.2+uBass*uResponse*.22+detail*(.08+uTreble*uResponse*.28);
  if(uMode>8.5)r+=drive*(.3+pow(.5+.5*sin(a*32.0),6.0)*1.4);
  p=n*r;p.xz=turn(t*.15)*p.xz;
  float contour=pow(.5+.5*sin(n.y*42.0+detail*2.0+t*.24),7.0);
  vAlpha=.22+.62*contour;vGlow=contour*.3+drive*.25;
 }else if(uMode<1.5){
  float arm=floor(aCover.x*4.0),r=pow(b,.68)*10.0;
  float spread=(fract(aCover.x*4.0)-.5)*(.12+b*.5);
  float angle=arm*1.5707963+r*.62+t*.045+spread;
  float lane=exp(-pow(spread/(.07+b*.19),2.0));
  p=vec3(cos(angle)*r,(aSeed-.5)*(.24+(1.0-b)*.65)+sin(r*.7-t*.25)*.09,sin(angle)*r);
  p.y+=drive*sin(r*1.2-t)*.14;
  vAlpha=(.16+lane*.62)*(1.0-smoothstep(.78,1.0,b));vGlow=pow(1.0-b,5.0)*.45+drive*.18;
 }else if(uMode<2.5){
  float layer=floor(b*6.0),local=fract(b*6.0),flow=aCover.x*24.0-12.0;
  float phase=flow*.26+layer*.8+t*.08;
  p=vec3(flow,sin(phase)*2.0+(layer-2.5)*.72+(local-.5)*1.2,-3.0-layer*2.1+cos(phase)*2.0);
  p.y+=noise(vec3(flow*.25,layer,t*.12))*.65+drive*.25;
  float ridge=exp(-pow((local-.48)/.2,2.0));vAlpha=.08+ridge*.72;vGlow=ridge*.5;
 }else if(uMode<3.5){
  float flow=fract(b+t*.045),z=5.0-flow*52.0,spin=a+t*.1+sin(flow*6.0+t*.12)*.045;
  float radius=4.1-uBass*uResponse*.22+sin(a*5.0+z*.35-t*.5)*(.07+uMid*uResponse*.14);
  p=vec3(cos(spin)*radius,sin(spin)*radius,z);
  float ring=pow(.5+.5*cos(flow*150.796),18.0);
  float seam=pow(.5+.5*cos(a*24.0),24.0);
  vCover=vec2(aCover.x,flow);vAlpha=(.1+ring*.65+seam*.18)*(1.0-smoothstep(12.0,52.0,-z));vGlow=ring*.24+drive*.25;
 }else if(uMode<4.5){
  p=vec3((aCover.x-.5)*30.0,-3.0,-b*32.0+6.0);
  float wave=sin(p.x*.32+t*.5)*cos(p.z*.23-t*.25);
  p.y+=wave*(1.2+uBass*uResponse*1.5)+drive*1.6;
  vAlpha=.35+.5*pow(.5+.5*sin(b*160.0),8.0);vGlow=max(0.0,p.y+2.0)*.15;
 }else if(uMode<5.5&&uRefined>.5){
  float ribbon=floor(b*3.0),v=fract(b*3.0)-.5,x=(aCover.x-.5)*14.0;
  float curl=x*.38+t*.18+ribbon*1.7;
  p=vec3(x,sin(curl)*(1.0+ribbon*.3)+v*(.8+.25*cos(curl)),cos(curl*.78+ribbon)*1.4+(ribbon-1.0)*1.2);
  float fold=noise(vec3(x*.65,v*2.0,t*.2+ribbon));
  p.z+=fold*(.12+uBass*uResponse*.25)+sin(v*18.0+x*.8-t)*uMid*uResponse*.12;
  float filament=pow(.5+.5*cos(v*65.0+fold*.8),7.0);
  float edge=pow(abs(v)*2.0,4.0);
  vAlpha=(.12+filament*.44+edge*.25)*(1.0-smoothstep(.82,1.0,abs(x)/7.0));vGlow=filament*.25+drive*.18;
 }else if(uMode<5.5||uMode>7.5){
  p=vec3((aCover.x-.5)*12.0,(b-.5)*8.0,0);
  float broad=noise(vec3(p.xy*.45,t*.28)),fine=noise(vec3(p.xy*1.2,t*.42));
  p.z=broad*(.7+uBass*uResponse*.7)+fine*uMid*uResponse*.65;
  p.z+=sin(length(p.xy)*3.0-t*2.2)*uBass*uResponse*.22;
  if(uMode<7.5){p.y+=sin(p.x*.5+t*.25)*.7;p.z+=sin(p.x*.4+t*.3)*1.3;}
  vAlpha=.8;vGlow=abs(broad)*drive*.4;
 }else if(uMode<6.5){
  float r=pow(b,.72),theta=a+r*.7+t*.025,petal=.5+.5*cos(theta*9.0-r*3.8);
  float radius=r*(5.0+uBass*uResponse*.5)*(.8+petal*.3);
  p=vec3(cos(theta)*radius,sin(theta)*radius*.82,(1.0-r)*1.7-r*r*.7+sin(theta*9.0-r*5.0+t*.14)*(.2+r*.7));
  p.yz=turn(-.3)*p.yz;vAlpha=.2+petal*.5;vGlow=pow(r,4.0)*.6+drive*.3;
 }else{
  float column=floor(aCover.x*52.0),fall=fract(b+t*(.04+aSeed*.05));
  p=vec3((column/51.0-.5)*18.0,(.5-fall)*13.0,(aSeed-.5)*10.0-2.0);
  p.x+=sin(t*.17+column*.63+fall*3.4)*.15;
  float dash=pow(.5+.5*sin(fall*(70.0+aSeed*40.0)),10.0);vAlpha=.12+dash*.8;vGlow=dash*.4;
 }
 if(uRefined>.5){
  p=indentParticle(p);
  float twinkle=.82+.18*sin(t*.52+aSeed*40.0);
  vAlpha*=twinkle;vGlow*=.7;
 }
 vec4 mv=modelViewMatrix*vec4(p,1.0); gl_Position=projectionMatrix*mv;
 float focus=1.0-smoothstep(14.0,52.0,-mv.z);
 float size=uSize*uPixel*(.86+aSeed*.36+vGlow*.3+uTreble*uResponse*.08)*uHeight*.045/max(2.0,-mv.z);
 gl_PointSize=clamp(size*mix(1.0,1.38,uRefined),1.0,5.4);vAlpha*=mix(.42,1.0,focus);
}`;
const particleFragment = `
uniform sampler2D uCover;uniform float uHasCover,uArtwork,uRefined;varying vec3 vColor;varying vec2 vCover;varying float vAlpha,vGlow;
void main(){float r=length(gl_PointCoord-.5);if(r>.5)discard;
 vec3 sampled=texture2D(uCover,clamp(vCover,.002,.998)).rgb;
 vec3 c=mix(vColor,sampled,uHasCover*mix(.36,1.0,uArtwork));
 c*=1.08+vGlow*.25;
 c=mix(c,sqrt(max(c,vec3(0.0))),uRefined*.4);
 float core=1.0-smoothstep(.16,.42,r),halo=exp(-r*r*20.0)*.09;
 float alpha=clamp(mix(1.0-smoothstep(.18,.5,r),(core+halo)*1.85,uRefined)*vAlpha,0.0,.98);
 gl_FragColor=vec4(c,alpha);
 #include <colorspace_fragment>
}`;

export function createParticles(ctx, kind, palette = [0x67d9cf, 0xfb7298, 0x8fb9ff]) {
  const T = ctx.THREE, group = root(ctx), count = 24000;
  const refined = ['silk', 'sphere', 'tunnel', 'galaxy'].includes(kind);
  const pointer = createParticlePointer(ctx, group, { depth: kind === 'sphere' ? 2.8 : kind === 'tunnel' ? -5 : 0, radius: kind === 'galaxy' ? 2 : 1.4 });
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), seeds = new Float32Array(count), uv = new Float32Array(count * 2);
  const color = new T.Color(), ca = new T.Color(palette[0]), cb = new T.Color(palette[1]);
  const modes = { sphere: 0, galaxy: 1, aurora: 2, tunnel: 3, terrain: 4, silk: 5, nebula: 6, flow: 7, cover: 8, 'spectrum-sphere': 9 };
  for (let i = 0; i < count; i++) {
    const a = seed(i, 1) * TAU, b = seed(i, 2), c = seed(i, 3), j = i * 3;
    uv[i * 2] = a / TAU; uv[i * 2 + 1] = b;
    if (kind === 'sphere' || kind === 'cover') {
      const y = 1 - b * 2, r = Math.sqrt(1 - y * y) * 3.2;
      positions[j] = Math.cos(a) * r; positions[j + 1] = y * 3.2; positions[j + 2] = Math.sin(a) * r;
    } else if (kind === 'galaxy') {
      const r = Math.pow(b, .65) * 10, angle = a * .08 + r * .65 + (i % 4) * TAU / 4;
      positions[j] = Math.cos(angle) * r; positions[j + 1] = (c - .5) * (1.6 - b); positions[j + 2] = Math.sin(angle) * r;
    } else if (kind === 'tunnel') {
      const ring = i % 48, radius = 4 + c * .14;
      positions[j] = Math.cos(a) * radius; positions[j + 1] = Math.sin(a) * radius; positions[j + 2] = -ring - .5;
    } else if (kind === 'terrain') {
      positions[j] = (a / TAU - .5) * 28; positions[j + 1] = Math.sin(a * 2) * .3 - 3; positions[j + 2] = -b * 26 + 6;
    } else if (kind === 'aurora') {
      positions[j] = (a / TAU - .5) * 24; positions[j + 1] = b * 7 - 2;
      positions[j + 2] = -4 - (i % 5) * 2 + Math.sin(a * 2) * 1.5;
    } else if (kind === 'silk') {
      positions[j] = (a / TAU - .5) * 15; positions[j + 1] = Math.sin(a * 3) * 1.8 + (b - .5) * 2; positions[j + 2] = (c - .5) * 8;
    } else {
      const r = Math.cbrt(b) * 9;
      positions[j] = Math.cos(a) * r; positions[j + 1] = (c - .5) * 7; positions[j + 2] = Math.sin(a) * r;
    }
    const tint = kind === 'aurora' || kind === 'nebula' ? b : kind === 'galaxy' ? (i % 4) / 3 : kind === 'sphere' ? b : seed(i, 5);
    color.copy(ca).lerp(cb, tint); color.toArray(colors, j); seeds[i] = c;
  }
  const geometry = own(ctx, new T.BufferGeometry());
  geometry.setAttribute('position', new T.BufferAttribute(positions, 3)); geometry.setAttribute('color', new T.BufferAttribute(colors, 3));
  geometry.setAttribute('aSeed', new T.BufferAttribute(seeds, 1)); geometry.setAttribute('aCover', new T.BufferAttribute(uv, 2));
  const uniforms = { ...pointer.uniforms, uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
    uHeight: { value: 720 }, uRefined: { value: Number(refined) },
    uMotion: { value: .6 }, uResponse: { value: .7 }, uSize: { value: kind === 'cover' ? 1.7 : 1 }, uPixel: { value: 1 }, uArtwork: { value: kind === 'cover' ? 1 : 0 },
    uMode: { value: modes[kind] ?? 6 }, uCover: { value: null }, uHasCover: { value: 0 }, uBands: { value: new Float32Array(16) } };
  const material = own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: particleVertex, fragmentShader: particleFragment,
    vertexColors: true, transparent: true, depthWrite: false, blending: kind === 'cover' || refined ? T.NormalBlending : T.AdditiveBlending }));
  const points = new T.Points(geometry, material); points.frustumCulled = false; group.add(points);
  let profile = ctx.quality, params = { ...ctx.params }, entry = null, coverKey = '';
  const resources = ctx.services.spatialResources || createSpatialResources(T), local = !ctx.services.spatialResources;
  // 池资源只经 scope.lease 释放租约；私有对象仍走 track/dispose。
  ctx.scope.lease({ release() { resources.cover.release(entry); } });
  if (local) ctx.scope.defer(() => resources.dispose());
  function density() { geometry.setDrawRange(0, Math.floor(count * qualityDensity(profile) * (params.density ?? 1))); }
  density();
  return basicInstance(group, params, profile, {
    update(frame, p) {
      const time = Number(frame.time) || 0;
      uniforms.uTime.value = time; uniforms.uBass.value = level(frame, 'bass'); uniforms.uMid.value = level(frame, 'mid'); uniforms.uTreble.value = level(frame, 'treble');
      writeSpectrum(uniforms.uBands.value, frame);
      uniforms.uMotion.value = p.speed ?? .6; uniforms.uResponse.value = p.reactivity ?? .7;
      uniforms.uPixel.value = ctx.renderer?.getPixelRatio() || 1;
      uniforms.uSize.value = p.pointSize ?? (kind === 'cover' ? 1.7 : 1);
      group.scale.setScalar((p.scale ?? 1) * (p.cue === 'chorus' ? 1.08 : 1));
      group.rotation.set(p.cue === 'bridge' ? .06 : 0, 0, p.director ? Math.sin(time * .08) * .04 : 0);
      if (p.cue === 'chorus') uniforms.uResponse.value *= 1.3;
      if (refined) pointer.update(frame, (p.pointerStrength ?? 1) * .65);
      if (resources) {
        const source = ctx.services.coverUrl, url = (typeof source === 'function' ? source() : source) || frame.coverUrl || '';
        if (url !== coverKey) { resources.cover.release(entry); coverKey = url; entry = resources.cover.acquire(url, ctx.signal); }
        uniforms.uCover.value = entry?.texture || null; uniforms.uHasCover.value = entry?.texture ? 1 : 0;
      }
    },
    resize(w, h) { uniforms.uHeight.value = h; },
    params(p) { params = p; density(); }, quality(q) { profile = q; density(); },
    stats() { return { particles: geometry.drawRange.count, drawCalls: 1, bytes: positions.byteLength + colors.byteLength + seeds.byteLength + uv.byteLength }; }
  });
}

export function createTowers(ctx, style = 'spectrum') {
  const T = ctx.THREE, group = root(ctx), count = 256;
  const geometry = own(ctx, new T.BoxGeometry(.32, 1, .32));
  const material = own(ctx, new T.ShaderMaterial({ vertexColors: true, wireframe: style === 'wire',
    vertexShader: `varying vec3 vColor;varying float vY;varying vec3 vNormal;
    void main(){vY=position.y+.5;vNormal=normal;vColor=color;
    #ifdef USE_INSTANCING_COLOR
    vColor*=instanceColor;
    #endif
    gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);}`,
    fragmentShader: `varying vec3 vColor,vNormal;varying float vY;
    void main(){vec3 c=vColor*mix(.18,1.1,pow(vY,1.4))*(.6+abs(vNormal.z)*.4);
    c+=vec3(.6,.9,1.0)*smoothstep(.97,1.0,vY)*.5;gl_FragColor=vec4(c,1.0);
    #include <colorspace_fragment>
    }` }));
  const mesh = own(ctx, new T.InstancedMesh(geometry, material, count)), object = new T.Object3D(), color = new T.Color(); group.add(mesh);
  function update(frame, p) {
    for (let i = 0; i < mesh.count; i++) {
      const x = i % 16 - 7.5, z = Math.floor(i / 16) - 7.5;
      const spectrum = frame.spectrum || frame.bands?.spectrum;
      const raw = spectrum?.[Math.floor(i / count * spectrum.length)];
      const band = raw === undefined ? level(frame, i % 3 === 0 ? 'bass' : 'mid') : Math.min(1, raw > 1 ? raw / 255 : raw);
      const ripple = Math.sin(Math.hypot(x, z) * .8 - (frame.time || 0) * (p.speed ?? .6));
      const h = .12 + band * (2.3 + ripple * 1.3) * (p.reactivity ?? .7) + (ripple + 1) * .12;
      object.position.set(x * .65, h / 2 - 2, z * .65); object.scale.set(1, h, 1); object.updateMatrix(); mesh.setMatrixAt(i, object.matrix);
      color.setHSL(.48 + (x + 7.5) / 15 * .4, .75, .42 + band * .18); mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.scale.setScalar(p.scale ?? 1);
  }
  function quality(q) { mesh.count = Math.floor(count * qualityDensity(q)); }
  quality(ctx.quality); update({ time: 0 }, ctx.params);
  return basicInstance(group, ctx.params, ctx.quality, { update, quality, stats: () => ({ instances: mesh.count, triangles: mesh.count * 12, drawCalls: 1 }) });
}

export function createRings(ctx, tunnel = false) {
  const T = ctx.THREE, group = root(ctx), count = tunnel ? 36 : 12;
  const geometry = own(ctx, new T.TorusGeometry(tunnel ? 4 : 3, tunnel ? .018 : .014, 4, 128));
  const material = own(ctx, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .8, blending: T.AdditiveBlending, depthWrite: false }));
  const mesh = own(ctx, new T.InstancedMesh(geometry, material, count)), o = new T.Object3D(), c = new T.Color(), endColor = new T.Color(tunnel ? 0xf36eac : 0xefc986); group.add(mesh);
  if (!tunnel) {
    const core = new T.Mesh(own(ctx, new T.SphereGeometry(1.05, 32, 24)), own(ctx, new T.MeshBasicMaterial({ color: 0x030506 })));
    group.add(core);
  }
  function update(frame, p) {
    const time = frame.time || 0, bass = level(frame, 'bass');
    for (let i = 0; i < mesh.count; i++) {
      const n = i / mesh.count, t = time * (p.speed ?? .6), drive = bass * (p.reactivity ?? .7);
      o.position.set(tunnel ? Math.sin(i * .2 + t * .1) * .25 : 0, 0, tunnel ? -(((i * 2 - t * 3) % 72 + 72) % 72) : (n - .5) * 1.5);
      o.rotation.set(tunnel ? 0 : -.4 + n * .8, tunnel ? 0 : Math.sin(n * 6 + t * .06) * .18, tunnel ? i * .09 + t * .12 : -.22 + n * .5);
      const radius = tunnel ? 1 : .5 + n * 1.1;
      o.scale.set(radius * (1 + drive * .08), radius * (tunnel ? 1 : .5 + n * .16), 1); o.updateMatrix(); mesh.setMatrixAt(i, o.matrix);
      c.set(tunnel ? 0x70dfee : 0x8accf0).lerp(endColor, n); mesh.setColorAt(i, c);
    }
    mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.scale.setScalar(p.scale ?? 1);
  }
  function quality(q) { mesh.count = Math.max(6, Math.floor(count * qualityDensity(q))); }
  quality(ctx.quality); update({ time: 0 }, ctx.params);
  return basicInstance(group, ctx.params, ctx.quality, { update, quality, stats: () => ({ instances: mesh.count, triangles: mesh.count * 1024 + (tunnel ? 0 : 1472), drawCalls: tunnel ? 1 : 2 }) });
}

export function createTerrain(ctx, style = 'terrain') {
  const T = ctx.THREE, group = root(ctx), geometry = own(ctx, new T.PlaneGeometry(24, 24, 64, 64));
  geometry.rotateX(-Math.PI / 2);
  const uniforms = { uTime: { value: 0 }, uBass: { value: 0 }, uSpeed: { value: .6 }, uResponse: { value: .7 }, uStyle: { value: style === 'mesh' ? 1 : style === 'spectrogram' ? 2 : 0 }, uBands: { value: new Float32Array(16) } };
  const material = own(ctx, new T.ShaderMaterial({ uniforms, side: T.DoubleSide,
    vertexShader: `uniform float uTime,uBass,uSpeed,uResponse,uStyle;uniform float uBands[16];varying float vHeight;varying vec2 vGrid;
    void main(){vec3 p=position;float t=uTime*uSpeed;
    p.y=sin(p.x*.32+t*.3)*cos(p.z*.23+t*.16)*(1.2+uBass*uResponse*2.0);
    float band=uBands[int(clamp(floor((p.x+12.0)/24.0*16.0),0.0,15.0))];p.y+=band*uResponse*2.0;
    if(uStyle>1.5)p.y=band*(1.2+sin(p.z*.8-t)*.8)*uResponse*3.0+sin(p.x*.3+t)*.3;
    vHeight=p.y;vGrid=p.xz;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`,
    fragmentShader: `uniform float uStyle;varying float vHeight;varying vec2 vGrid;
    void main(){vec2 coord=vGrid*(uStyle>1.5?1.8:2.5),width=fwidth(coord);
    vec2 line=abs(fract(coord-.5)-.5)/max(width,vec2(.001));float grid=1.0-min(min(line.x,line.y),1.0);
    vec3 c=mix(vec3(.08,.45,.51),vec3(.96,.42,.55),smoothstep(-1.5,3.5,vHeight));
    c*=mix(.13,.28,step(.5,uStyle))+grid*.9;c+=vec3(.14,.22,.2)*pow(max(0.0,vHeight)*.15,2.0);
    gl_FragColor=vec4(c,1.0);
    #include <colorspace_fragment>
    }` }));
  const mesh = new T.Mesh(geometry, material); mesh.position.y = -3; group.add(mesh);
  const max = geometry.index.count;
  function quality() { geometry.setDrawRange(0, max); }
  quality(ctx.quality);
  return basicInstance(group, ctx.params, ctx.quality, {
    update(f, p) { uniforms.uTime.value = f.time || 0; uniforms.uBass.value = level(f, 'bass'); uniforms.uSpeed.value = p.speed ?? .6; uniforms.uResponse.value = p.reactivity ?? .7; writeSpectrum(uniforms.uBands.value, f); group.scale.setScalar(p.scale ?? 1); },
    quality, stats: () => ({ triangles: geometry.drawRange.count / 3, drawCalls: 1 })
  });
}

export function createHanddrawn(ctx, style) {
  const T = ctx.THREE, group = root(ctx), count = 32;
  const geometry = own(ctx, new T.BufferGeometry());
  geometry.setAttribute('position', new T.Float32BufferAttribute([0,-.5,0,-1,.7,.6,-.35,-.3,.15,0,-.5,0,.35,-.3,.15,1,.7,.6],3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute([.5,0,0,1,.3,.2,.5,0,.7,.2,1,1],2)); geometry.computeVertexNormals();
  const resources = ctx.services.spatialResources || createSpatialResources(T), local = !ctx.services.spatialResources;
  let entry = null, key = '', disposed = false;
  function cleanup() { if (disposed) return; disposed = true; resources.cover.release(entry); if (local) resources.dispose(); }
  ctx.scope.defer(cleanup);
  const uniforms = { uTime: { value: 0 }, uStyle: { value: ['manga', 'anime', 'pencil', 'color'].indexOf(style) }, uBass: { value: 0 }, uCover: { value: null }, uHasCover: { value: 0 } };
  const material = own(ctx, new T.ShaderMaterial({ uniforms, side: T.DoubleSide,
    vertexShader: `uniform float uTime,uBass;varying vec3 vNormal;varying vec2 vUv;void main(){vec3 p=position;vUv=uv;
    #ifdef USE_INSTANCING
    vNormal=normalize(normalMatrix*mat3(instanceMatrix)*normal);p.z+=abs(p.x)*sin(uTime*.7)*(.15+uBass*.2);
    gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(p,1.0);
    #else
    vNormal=normalize(normalMatrix*normal);p.z+=sin(p.x*.6+uTime*.2)*cos(p.y*.5)*(.15+uBass*.2);
    gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
    #endif
    }`,
    fragmentShader: `uniform float uTime,uStyle,uBass,uHasCover;uniform sampler2D uCover;varying vec3 vNormal;varying vec2 vUv;void main(){
    float shade=floor((dot(normalize(vNormal),normalize(vec3(.4,.8,1.0)))*.5+.5)*4.0)/4.0;
    float dots=step(.22,length(fract(gl_FragCoord.xy/5.0)-.5));float hatch=step(.7,fract((gl_FragCoord.x+gl_FragCoord.y)/7.0));
    vec3 art=mix(mix(vec3(.18,.65,.6),vec3(.98,.5,.65),vUv.x),texture2D(uCover,vUv).rgb,uHasCover);
    float lum=dot(art,vec3(.299,.587,.114));
    vec2 texel=vec2(.002,0);float edge=length(texture2D(uCover,vUv+texel).rgb-texture2D(uCover,vUv-texel).rgb);
    vec3 c;
    if(uStyle<.5)c=vec3(floor(lum*5.0)/5.0*.8+.12)*mix(.56,1.0,dots);
    else if(uStyle<1.5)c=floor(art*5.0)/5.0*(.75+shade*.25);
    else if(uStyle<2.5)c=vec3(.9,.93,.91)*(1.0-edge*2.0)*mix(.55,1.0,lum)*mix(.72,1.0,hatch);
    else c=mix(vec3(.08,.55,.53),vec3(.98,.42,.57),smoothstep(.2,.8,lum))*mix(.78,1.0,dots);
    c*=1.0-clamp(edge*1.5,0.0,.65);gl_FragColor=vec4(c,1.0);
    #include <colorspace_fragment>
    }` }));
  const mesh = own(ctx, new T.InstancedMesh(geometry, material, count)), o = new T.Object3D(); group.add(mesh);
  const artwork = new T.Mesh(own(ctx, new T.PlaneGeometry(6.4, 6.4, 48, 48)), material); group.add(artwork);
  function update(f, p) {
    const time = f.time || 0;
    const source = ctx.services.coverUrl, url = (typeof source === 'function' ? source() : source) || f.coverUrl || '';
    if (key !== url) { resources.cover.release(entry); key = url; entry = resources.cover.acquire(url, ctx.signal); }
    uniforms.uCover.value = entry?.texture || null; uniforms.uHasCover.value = entry?.texture ? 1 : 0;
    uniforms.uTime.value = time * (p.speed ?? .6); uniforms.uBass.value = level(f, 'bass') * (p.reactivity ?? .7);
    artwork.rotation.set(Math.sin(time*.07)*.035,Math.sin(time*.05)*.08,0);
    for (let i = 0; i < mesh.count; i++) {
      const a = i * 2.4 + time * .025 * (p.speed ?? .6), r = 5 + i % 3;
      o.position.set(Math.cos(a) * r, Math.sin(i * .8) * 4.5, -2-seed(i,3)*5);
      o.rotation.set(Math.sin(time*.3+i)*.3, i*.4, Math.sin(i)*.35); o.scale.setScalar(.3+seed(i,3)*.6); o.updateMatrix(); mesh.setMatrixAt(i,o.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true; group.scale.setScalar(p.scale ?? 1);
  }
  function quality(q) { mesh.count = Math.max(12, Math.floor(count * qualityDensity(q))); }
  quality(ctx.quality); update({}, ctx.params);
  return basicInstance(group, ctx.params, ctx.quality, { update, quality, dispose: cleanup, stats: () => ({ instances: mesh.count, triangles: mesh.count * 2 + 4608, drawCalls: 2 }) });
}
