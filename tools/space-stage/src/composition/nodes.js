// SPDX-License-Identifier: MIT
// Concrete bounded adapters and node builders. No node owns a frame scheduler.
const releaseTicket = ticket => ticket?.release({ apiReleased: true, allocationEnded: true });
const cancelled = () => new DOMException('Composition cancelled', 'AbortError');
function assertAlive(signal) { if (signal.aborted) throw cancelled(); }
function waitMedia(element, event, signal, ready) {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    function clean() { element.removeEventListener(event, done); element.removeEventListener('error', fail); signal?.removeEventListener('abort', abort); }
    function done() { clean(); resolve(); }
    function fail() { clean(); reject(new Error('composition-media-decode-failed')); }
    function abort() { clean(); reject(cancelled()); }
    element.addEventListener(event, done, { once: true }); element.addEventListener('error', fail, { once: true });
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}
export async function loadResource(THREE, context, requirement, signal, generation, onInvalidate, admissions) {
  const tickets = Object.values(admissions || {}).filter(Boolean);
  let texture = null, image = null, video = null, font = null, buffer = null, released = false;
  const seekState={target:0,ready:true};
  const release = () => {
    if (released) return; released = true;
    texture?.dispose();
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    if (image) { image.onload = image.onerror = null; image.src = ''; }
    if (font) document.fonts.delete(font);
    buffer = null; tickets.forEach(releaseTicket);
  };
  try {
    assertAlive(signal);
    if (requirement.kind === 'font') {
      const cpu = admissions?.cpu;
      const response = await fetch(requirement.url, { signal });
      if (!response.ok) throw new Error('composition-font-source-unavailable');
      buffer = await response.arrayBuffer(); assertAlive(signal);
      if (buffer.byteLength !== requirement.byteLength) throw new Error('composition-font-content-size-mismatch');
      cpu?.commit();
      const family = 'hertz-' + requirement.contentKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 80);
      font = new FontFace(family, buffer); await font.load(); assertAlive(signal);
      document.fonts.add(font); return {font,family,release,retirementCandidates:()=>tickets.map(ticket=>ticket.resourceId)};
    }
    const decode = admissions?.decode, upload = admissions?.upload;
    if (requirement.kind === 'video') {
      video = document.createElement('video'); video.muted = true; video.defaultMuted = true;
      video.volume = 0; video.playsInline = true; video.preload = 'auto'; video.crossOrigin = 'anonymous';
      const metadata = waitMedia(video, 'loadedmetadata', signal, () => video.readyState >= 1);
      video.src = requirement.url; video.load(); await metadata; assertAlive(signal);
      if (video.videoWidth !== requirement.width || video.videoHeight !== requirement.height
          || Math.abs(video.duration * 1000 - requirement.durationMs) > 20)
        throw new Error('composition-video-resolved-metadata-mismatch');
      const data = waitMedia(video, 'loadeddata', signal, () => video.readyState >= 2); await data; assertAlive(signal);
      texture = context.pool.markOwned(new THREE.VideoTexture(video));
      // VideoTexture's renderer shader has no custom-material transfer macro.
      // The node shader performs the video sRGB transfer once.
      texture.colorSpace = THREE.NoColorSpace;
      video.addEventListener('seeked', () => { if (!released) { seekState.ready=true; onInvalidate?.(); } });
      video.addEventListener('error', () => onInvalidate?.());
    } else {
      image = new Image(); image.crossOrigin = 'anonymous'; image.decoding = 'async';
      const loaded = waitMedia(image, 'load', signal, () => image.complete && image.naturalWidth > 0);
      image.src = requirement.url; await loaded; assertAlive(signal);
      if (image.naturalWidth !== requirement.width || image.naturalHeight !== requirement.height)
        throw new Error('composition-image-resolved-metadata-mismatch');
      texture = context.pool.markOwned(new THREE.Texture(image)); texture.needsUpdate = true;
      texture.colorSpace = requirement.usage === 'mask' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    }
    texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
    texture.premultiplyAlpha = false;
    texture.onUpdate = () => { if (!released) upload?.commit(); };
    decode?.commit(); return {texture,image,video,requirement,seekState,release,retirementCandidates:()=>tickets.map(ticket=>ticket.resourceId)};
  } catch (error) { release(); throw error; }
}

const vertexShader = `varying vec2 vUv;
void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const fragmentShader = `uniform sampler2D colorMap; uniform sampler2D maskMap;
uniform bool hasMap; uniform bool hasMask; uniform bool isVideo; uniform bool isCircle;
uniform float opacity; uniform vec2 uvScale; uniform vec2 uvOffset; varying vec2 vUv;
vec3 videoLinear(vec3 c){return mix(pow(c*0.9478672986+vec3(0.0521327014),vec3(2.4)),c*0.0773993808,lessThanEqual(c,vec3(0.04045)));}
void main(){ vec2 uv=vUv*uvScale+uvOffset;
  vec4 color=hasMap?texture2D(colorMap,uv):vec4(1.0);
  if(isVideo)color.rgb=videoLinear(color.rgb);
  if(isCircle && length(vUv-0.5)>0.5)discard;
  float alpha=color.a*opacity*(hasMask?texture2D(maskMap,vUv).r:1.0);
  gl_FragColor=vec4(color.rgb*alpha,alpha);
}`;
function material(THREE, spec, texture, mask) {
  const blend = spec.constant('blend');
  return new THREE.ShaderMaterial({ vertexShader, fragmentShader, transparent: true, depthTest: false, depthWrite: false,
    toneMapped: false, side: THREE.DoubleSide, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: blend === 'multiply' ? THREE.DstColorFactor : THREE.OneFactor,
    blendDst: blend === 'add' ? THREE.OneFactor : blend === 'screen' ? THREE.OneMinusSrcColorFactor : THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    uniforms: { colorMap: { value: texture }, maskMap: { value: mask }, hasMap: { value: !!texture }, hasMask: { value: !!mask },
      isVideo: { value: !!texture?.isVideoTexture }, isCircle: { value: !texture && spec.node.nodeType === 'particles' },
      opacity: { value: 1 }, uvScale: { value: new THREE.Vector2(1, 1) }, uvOffset: { value: new THREE.Vector2(0, 0) } } });
}
export function updateNodeMaterial(THREE, node, assets) {
  const mat=node.material, spec=node.spec;
  if (!mat) return;
  const blend=spec.constant('blend');
  mat.blendSrc=blend==='multiply'?THREE.DstColorFactor:THREE.OneFactor;
  mat.blendDst=blend==='add'?THREE.OneFactor:blend==='screen'?THREE.OneMinusSrcColorFactor:THREE.OneMinusSrcAlphaFactor;
  if (spec.node.nodeType!=='text') {
    const texture=assets.asset?.texture || assets.spriteAsset?.texture || null, mask=assets.maskAsset?.texture || null;
    mat.uniforms.colorMap.value=texture; mat.uniforms.maskMap.value=mask;
    mat.uniforms.hasMap.value=!!texture; mat.uniforms.hasMask.value=!!mask;
    mat.uniforms.isVideo.value=!!texture?.isVideoTexture;
    mat.uniforms.isCircle.value=!texture&&node.particles;
  }
  if (node.particles) {
    mat.uniforms.lifetime.value=spec.number('lifetimeSeconds'); mat.uniforms.speed.value=spec.number('speed');
    mat.uniforms.spread.value=spec.number('spread');
  }
}
function rectangle(THREE, scope, plan) {
  const geometry = scope.track(new THREE.BufferGeometry());
  geometry.setAttribute('position', plan.upload(new THREE.BufferAttribute(new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0]), 3)));
  geometry.setAttribute('uv', plan.upload(new THREE.BufferAttribute(new Float32Array([0,1, 1,1, 1,0, 0,0]), 2)));
  geometry.setIndex(plan.upload(new THREE.BufferAttribute(new Uint16Array([0,1,2, 0,2,3]), 1)));
  plan.cpuReady(92); return geometry;
}
function makeText(THREE, context, scope, spec, font, generation) {
  const width = spec.textWidth, height = spec.textHeight, ticket = spec.textTicket;
  let canvas = null, texture = null;
  try {
    canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('composition-text-canvas-unavailable');
    ctx.font = `${spec.number('fontSize')}px "${font.family}"`; ctx.textBaseline = 'top';
    ctx.fillStyle = spec.constant('color'); ctx.textAlign = spec.constant('align');
    const text = spec.constant('text'), x = ctx.textAlign === 'center' ? width / 2 : ctx.textAlign === 'right' ? width : 0;
    const lineHeight = spec.number('fontSize') * spec.number('lineHeight');
    let y = 0;
    for (const paragraph of text.split('\n')) {
      let row = '';
      for (const character of paragraph) {
        const candidate = row + character;
        if (row && ctx.measureText(candidate).width > width) { ctx.fillText(row, x, y); y += lineHeight; row = character; }
        else row = candidate;
      }
      ctx.fillText(row, x, y); y += lineHeight;
    }
    texture = scope.track(new THREE.CanvasTexture(canvas)); texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
    ticket?.materialize({ canvases: 1, drawingBufferPixels: width * height, ownedCpuBytes: width * height * 4 });
    texture.onUpdate = () => ticket?.commit();
    const disposeTexture=texture.dispose.bind(texture);
    texture.dispose=() => { disposeTexture(); canvas.width=canvas.height=0; releaseTicket(ticket); };
    spec.claimTextTicket?.(); return texture;
  } catch (error) { texture?.dispose(); if (canvas) canvas.width = canvas.height = 0; releaseTicket(ticket); throw error; }
}
function seedValues(seed, count) {
  const result = new Float32Array(count * 2); let state = seed >>> 0;
  for (let index = 0; index < result.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0; result[index] = state / 4294967296;
  }
  return result;
}
export function buildNode(THREE, context, scope, spec, assets, generation) {
  if (spec.node.nodeType === 'group') return { object: new THREE.Group(), spec, opacity: 1 };
  let texture = assets.asset?.texture || assets.spriteAsset?.texture || null;
  if (spec.node.nodeType === 'text') texture = makeText(THREE, context, scope, spec, assets.fontAsset, generation);
  const mat = scope.track(material(THREE, spec, texture, assets.maskAsset?.texture));
  if (spec.node.nodeType === 'particles') {
    const geometry = scope.track(new THREE.BufferGeometry()), count = spec.count;
    const plan = spec.bufferPlan;
    const positions = new Float32Array(count * 3), seeds = seedValues(spec.number('seed'), count);
    geometry.setAttribute('position', plan.upload(new THREE.BufferAttribute(positions, 3)));
    geometry.setAttribute('seed', plan.upload(new THREE.BufferAttribute(seeds, 2))); plan.cpuReady(count * 20);
    mat.vertexShader = `attribute vec2 seed; varying vec2 vUv; uniform float sceneTime;
      uniform float lifetime; uniform float speed; uniform float spread;
      void main(){float age=mod(sceneTime+seed.x*lifetime,lifetime);
        vec3 p=vec3((seed.y-0.5)*spread,age*speed,0.0);
        gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);gl_PointSize=4.0;vUv=vec2(0.5);}`;
    mat.fragmentShader = mat.fragmentShader.replace('vec2 uv=vUv*uvScale+uvOffset;', 'vec2 uv=gl_PointCoord;')
      .replace('length(vUv-0.5)', 'length(gl_PointCoord-0.5)');
    Object.assign(mat.uniforms, { sceneTime: { value: 0 }, lifetime: { value: spec.number('lifetimeSeconds') },
      speed: { value: spec.number('speed') }, spread: { value: spec.number('spread') } });
    const object = new THREE.Points(geometry, mat); object.frustumCulled = false;
    return { object, material: mat, spec, particles: true, opacity: 1 };
  }
  const object = new THREE.Mesh(rectangle(THREE, scope, spec.bufferPlan), mat); object.frustumCulled = false;
  return { object, material: mat, spec, opacity: 1 };
}
