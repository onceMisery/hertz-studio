// SPDX-License-Identifier: MIT
// 曲面封面墙：真正的展墙纵深、地台反射与卡片倒角；指针抬升/倾斜卡片，
// 点击卡片播放对应曲目，悬停队列行时整面墙会预览那一首。
import { basicInstance, level, own, qualityDensity, root } from './factories.js';
import { createSpatialResources } from './resources.js';
import { approach, createGlow, createShockPool, createStarfield, faceCamera } from './scene-field.js';

const wallVertex = `varying vec2 vUv;
void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const wallFragment = `uniform sampler2D uCover; uniform float uHasCover,uBrightness,uReflection,uHover; varying vec2 vUv;
void main(){
 vec2 p=vUv-.5; float d=length(p),groove=.5+.5*sin(d*220.0);
 vec3 empty=mix(vec3(.035,.06,.07),vec3(.16,.28,.29),1.0-smoothstep(.05,.5,d))*(.8+groove*.1);
 vec3 art=mix(empty,texture2D(uCover,vUv).rgb,uHasCover)*uBrightness;
 float edge=min(min(vUv.x,1.0-vUv.x),min(vUv.y,1.0-vUv.y));
 float frame=1.0-smoothstep(0.0,.045,edge);
 vec3 frameColor=mix(vec3(.02,.04,.05),vec3(.35,.6,.65),uHover*.55);
 art=mix(art,frameColor,frame*.82);
 art+=vec3(.55,.8,.85)*frame*.12;
 float glare=exp(-pow((vUv.x*.7+vUv.y*.3-.55)/.16,2.0))*uHover*.18;
 art+=vec3(.8,.95,1.0)*glare;
 float alpha=mix(1.0,pow(vUv.y,2.2)*.24,uReflection);
 gl_FragColor=vec4(art,alpha);
 #include <colorspace_fragment>
}`;
const floorVertex = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const floorFragment = `uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv;
void main(){
 float d=length(vUv-.5)*2.0;
 vec2 gridUv=vUv*vec2(14.0,9.0);
 vec2 grid=abs(fract(gridUv-.5)-.5)/max(fwidth(gridUv),vec2(.001));
 float line=1.0-min(min(grid.x,grid.y),1.0);
 float fade=1.0-smoothstep(.15,1.0,d);
 float alpha=(.14+line*.12)*fade*uOpacity;
 gl_FragColor=vec4(uColor,alpha);
 #include <colorspace_fragment>
}`;

export function createCoverWall(ctx) {
  const T = ctx.THREE, group = root(ctx), world = new T.Group(); group.add(world);
  const resources = ctx.services.spatialResources || createSpatialResources(T), local = !ctx.services.spatialResources;
  const geometry = own(ctx, new T.PlaneGeometry(3, 3, 24, 1)), count = 9;
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i); positions.setXYZ(i, Math.sin(x / 11) * 11, positions.getY(i), (Math.cos(x / 11) - 1) * 11);
  }
  geometry.computeVertexNormals();
  const cards = [], reflections = [], entries = [], keys = [], hoverAmounts = new Float32Array(count);
  const backCards = [], backEntries = [], backKeys = [], backCount = 7;
  const makeMaterial = reflection => own(ctx, new T.ShaderMaterial({
    uniforms: { uCover: { value: null }, uHasCover: { value: 0 }, uBrightness: { value: 1 }, uReflection: { value: reflection ? 1 : 0 }, uHover: { value: 0 } },
    vertexShader: wallVertex, fragmentShader: wallFragment, transparent: reflection, depthWrite: !reflection, side: T.DoubleSide
  }));
  for (let i = 0; i < count; i++) {
    const card = new T.Mesh(geometry, makeMaterial(false)), mirror = new T.Mesh(geometry, makeMaterial(true));
    card.userData.index = i; world.add(card, mirror); cards.push(card); reflections.push(mirror); entries.push(null); keys.push('');
  }
  for (let i = 0; i < backCount; i++) {
    const card = new T.Mesh(geometry, makeMaterial(false)); card.scale.setScalar(.72); world.add(card);
    backCards.push(card); backEntries.push(null); backKeys.push('');
  }

  const floor = new T.Mesh(own(ctx, new T.PlaneGeometry(26, 16)), own(ctx, new T.ShaderMaterial({
    uniforms: { uColor: { value: new T.Color(0x2b6f8f) }, uOpacity: { value: .8 } },
    vertexShader: floorVertex, fragmentShader: floorFragment, transparent: true, depthWrite: false, blending: T.AdditiveBlending
  })));
  floor.rotation.x = -Math.PI / 2; floor.position.set(0, -3.18, -4.5); floor.renderOrder = -2; world.add(floor);
  const backlight = createGlow(ctx, world, { color: 0x246a8a, opacity: .14, size: 13, renderOrder: -3 });
  backlight.mesh.position.set(0, -.2, -4.5);
  const dust = createStarfield(ctx, world, { count: 700, near: 10, far: 34, palette: [0x9fe0ff, 0xffc7a8], size: [.5, 1.8], opacity: .42 });
  const cursor = createGlow(ctx, world, { color: 0xbff4ff, opacity: 0, size: 1.4, renderOrder: 8 });
  const shock = createShockPool(ctx, world, { count: 6, duration: 1.05 });
  const raycaster = new T.Raycaster(), ndc = new T.Vector2(), clickNdc = new T.Vector2();
  const hitPoint = new T.Vector3(), effectPoint = new T.Vector3(), spawnQuat = new T.Quaternion(), parentQuat = new T.Quaternion(), cameraQuat = new T.Quaternion();
  const parallax = new T.Vector2();
  let profile = ctx.quality, params = { ...ctx.params }, aspect = 16 / 9, disposed = false, hover = -1, lastSerial = null, lastCurrent = null, pulse = 0;

  function cleanup() { if (disposed) return; disposed = true; entries.forEach(entry => resources.cover.release(entry)); backEntries.forEach(entry => resources.cover.release(entry)); if (local) resources.dispose(); }
  ctx.scope.defer(cleanup);
  function applyQuality() {
    const fraction = qualityDensity(profile);
    reflections.forEach(mirror => { mirror.visible = fraction > .45; });
    dust.setDensity(fraction);
  }
  applyQuality();

  function rayAt(x, y) {
    ctx.camera.updateMatrixWorld(); world.updateMatrixWorld(true);
    ndc.set(x, y); raycaster.setFromCamera(ndc, ctx.camera);
    const hits = raycaster.intersectObjects(cards, false);
    return hits.length ? { index: hits[0].object.userData.index, point: hits[0].point } : null;
  }
  function spawnShock(point, size) {
    world.getWorldQuaternion(parentQuat).invert(); ctx.camera.getWorldQuaternion(cameraQuat);
    spawnQuat.copy(parentQuat).multiply(cameraQuat);
    effectPoint.copy(point || new T.Vector3(0, 0, -2)); world.worldToLocal(effectPoint);
    shock.spawn(effectPoint, spawnQuat, size, 0xbff4ff);
  }

  return basicInstance(group, ctx.params, ctx.quality, {
    update(frame, p) {
      const reduced = !!frame.reduced, dt = reduced ? 0 : Math.max(0, Math.min(.05, Number(frame.dt) || 0));
      const time = frame.sceneTime ?? frame.time ?? 0, bass = level(frame, 'bass') * (p.reactivity ?? .7);
      const source = ctx.services.coverItems, supplied = (typeof source === 'function' ? source() : source) || [];
      const coverSource = ctx.services.coverUrl, current = (typeof coverSource === 'function' ? coverSource() : coverSource) || frame.coverUrl || '';
      const currentId = frame.track?.id ? String(frame.track.id) : '';
      const items = supplied.map(item => typeof item === 'string' ? { cover: item, id: '' } : { cover: item?.coverUrl || item?.cover || item?.url || '', id: item?.id ? String(item.id) : '' }).filter(item => item.cover);
      if (current && !items.some(item => item.cover === current)) items.unshift({ cover: current, id: currentId });
      const currentIndex = Math.max(0, items.findIndex(item => item.cover === current));
      const preview = frame.preview;
      const previewIndex = preview ? items.findIndex(item => (preview.id && item.id === String(preview.id)) || (preview.cover && item.cover === preview.cover)) : -1;
      const display = previewIndex >= 0 ? previewIndex : currentIndex;
      const center = (display + Math.round(p.coverIndex || 0)) % Math.max(1, items.length);
      const radius = p.radius ?? 11;

      const pointer = frame.pointer;
      const hoverResult = !reduced && pointer?.active ? rayAt(pointer.x, pointer.y) : null;
      const nextHover = hoverResult ? hoverResult.index : -1;
      if (nextHover !== hover) { hover = nextHover; }
      const click = pointer?.click;
      if (lastSerial === null) lastSerial = click?.serial ?? 0;
      const clicked = click && click.serial !== lastSerial;
      if (clicked) lastSerial = click.serial;
      let clickedCard = null;
      if (clicked) {
        clickNdc.set(click.x, click.y); ctx.camera.updateMatrixWorld(); world.updateMatrixWorld(true);
        raycaster.setFromCamera(clickNdc, ctx.camera);
        const hits = raycaster.intersectObjects(cards, false);
        clickedCard = hits.length ? { index: hits[0].object.userData.index, point: hits[0].point } : null;
        if (clickedCard) {
          const item = items[((center + clickedCard.index - 4) % Math.max(1, items.length) + Math.max(1, items.length)) % Math.max(1, items.length)];
          if (item?.id && item.id !== currentId) ctx.services.playTrack?.(item.id);
        }
        pulse = reduced ? 0 : 1;
        if (!reduced) spawnShock(clickedCard?.point, 2.6 + pulse * .5);
      }
      if (reduced) { hover = -1; parallax.set(0, 0); pulse = 0; }
      else {
        parallax.x += ((pointer?.active ? pointer.x : 0) - parallax.x) * approach(dt, .4);
        parallax.y += ((pointer?.active ? pointer.y : 0) - parallax.y) * approach(dt, .4);
        pulse = Math.max(0, pulse - dt * 1.8);
      }
      if (current !== lastCurrent && lastCurrent !== null && !reduced) pulse = 1;
      lastCurrent = current;
      world.rotation.set(parallax.y * .03, parallax.x * .05, 0);
      const px = reduced ? 0 : (pointer?.x || 0), py = reduced ? 0 : (pointer?.y || 0);

      for (let i = 0; i < count; i++) {
        const rel = i - 4, card = cards[i], mirror = reflections[i];
        const index = ((center + rel) % Math.max(1, items.length) + Math.max(1, items.length)) % Math.max(1, items.length);
        const item = items[index], url = item?.cover || '';
        const target = hover === i ? 1 : 0;
        hoverAmounts[i] += (target - hoverAmounts[i]) * (reduced ? 1 : approach(dt, .16));
        if (reduced) hoverAmounts[i] = 0;
        const lift = hoverAmounts[i], angle = rel * .34;
        const bob = Math.sin(time * .4 + i) * .035 * (p.speed ?? .6);
        card.position.set(Math.sin(angle) * radius, bob + lift * .14, -radius + Math.cos(angle) * radius - 2 + lift * .55);
        card.rotation.set(-py * lift * .1, angle + px * lift * .08, 0);
        card.scale.setScalar(((rel === 0 ? 1.12 : 1) * (1 + Math.max(0, 1 - Math.abs(rel) * .06) * pulse * .06) * (1 + bass * .012) * (1 + lift * .05)));
        mirror.position.copy(card.position); mirror.position.y = -3.15 - card.position.y;
        mirror.rotation.copy(card.rotation); mirror.scale.set(card.scale.x, -card.scale.y, 1);
        if (keys[i] !== url) { resources.cover.release(entries[i]); keys[i] = url; entries[i] = resources.cover.acquire(url, ctx.signal); }
        const texture = entries[i]?.texture || null;
        const brightness = (rel === 0 ? 1 : Math.max(.35, .8 - Math.abs(rel) * .1)) + lift * .26 + (rel === 0 ? pulse * .16 : 0) + bass * .12;
        for (const mesh of [card, mirror]) {
          mesh.material.uniforms.uCover.value = texture; mesh.material.uniforms.uHasCover.value = texture ? 1 : 0;
          mesh.material.uniforms.uBrightness.value = brightness; mesh.material.uniforms.uHover.value = hoverAmounts[i];
        }
      }
      for (let i = 0; i < backCount; i++) {
        const card = backCards[i], rel = i - 3, item = items.length ? items[((center + rel + 3) % items.length + items.length) % items.length] : null, url = item?.cover || '';
        const angle = rel * .38, bob = Math.sin(time * .32 + i + 2) * .025 * (p.speed ?? .6);
        card.position.set(Math.sin(angle) * radius * 1.35, bob - .05, -radius + Math.cos(angle) * radius - 5.2);
        card.rotation.set(0, angle * .8, 0); card.scale.setScalar(.72);
        if (backKeys[i] !== url) { resources.cover.release(backEntries[i]); backKeys[i] = url; backEntries[i] = resources.cover.acquire(url, ctx.signal); }
        const texture = backEntries[i]?.texture || null;
        card.material.uniforms.uCover.value = texture; card.material.uniforms.uHasCover.value = texture ? 1 : 0;
        card.material.uniforms.uBrightness.value = .3 + bass * .08; card.material.uniforms.uHover.value = 0;
      }
      const hoverPoint = hoverResult?.point;
      cursor.set(undefined, hoverResult ? .34 + hoverAmounts[Math.max(0, hover)] * .3 : 0, 1.35 + (hoverResult ? .2 : 0));
      if (hoverPoint) { effectPoint.copy(hoverPoint); world.worldToLocal(effectPoint); cursor.mesh.position.copy(effectPoint); faceCamera(cursor.mesh, ctx.camera); }
      dust.uniforms.uTime.value = time;
      shock.update(dt, reduced);
      group.scale.setScalar(p.scale ?? 1);
    },
    resize(w, h) { aspect = w / Math.max(1, h); world.scale.setScalar(aspect < 1 ? .82 : 1); },
    params(next) { params = next; }, quality(next) { profile = next; applyQuality(); },
    dispose: cleanup,
    stats: () => ({ covers: entries.filter(Boolean).length, drawCalls: reflections.filter(mirror => mirror.visible).length + 21,
      triangles: 864 + backCount * 48, textTextures: 0 })
  });
}
