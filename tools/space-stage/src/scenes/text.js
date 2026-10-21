// SPDX-License-Identifier: MIT
import { basicInstance, root, own, level, qualityDensity, seed } from './factories.js';
import { createSpatialResources } from './resources.js';
import { lyricFill } from './text-layout.js';

const vertex = `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
const lyricFragment = `
uniform sampler2D uText;uniform vec4 uRows[6];uniform float uFill[6];
uniform float uCurrent,uOpacity,uTime,uGlow,uReveal,uKaraoke,uStyle;uniform vec2 uTexel;
uniform vec3 uBase,uHighlight;varying vec2 vUv;
void main(){
 vec2 uv=gl_FrontFacing?vUv:vec2(1.0-vUv.x,vUv.y);
 float mask=texture2D(uText,uv).a;
 float halo=max(max(texture2D(uText,uv+uTexel*vec2(2,0)).a,texture2D(uText,uv-uTexel*vec2(2,0)).a),
 max(texture2D(uText,uv+uTexel*vec2(0,2)).a,texture2D(uText,uv-uTexel*vec2(0,2)).a));
 if(max(mask,halo)<.01||uv.x>uReveal)discard;
 float filled=0.0,edge=0.0;
 for(int i=0;i<6;i++){vec4 row=uRows[i];if(uv.y>=row.z&&uv.y<=row.w){
  filled=1.0-smoothstep(uFill[i]-.004,uFill[i]+.004,uv.x);
  edge=exp(-pow((uv.x-uFill[i])/.018,2.0));}}
 float currentMix=clamp(uCurrent,0.0,1.0);
 vec3 color=mix(uBase,uHighlight,filled*currentMix*uKaraoke);
 color+=uHighlight*edge*currentMix*uKaraoke*(.12+uGlow*.12);
 float sweep=pow(max(0.0,sin(uv.x*5.0-uv.y*.6-uTime*.8)),18.0);
 color+=uHighlight*sweep*currentMix*uGlow*.045;
 float alpha=mask;
 if(uStyle>.5&&uStyle<1.5)alpha*=1.0-filled*currentMix*.55*uKaraoke;
 float shadow=max(0.0,halo-mask)*.6;
 gl_FragColor=vec4(mix(vec3(.005),color,alpha/max(.001,alpha+shadow)),max(alpha,shadow)*uOpacity);
 #include <colorspace_fragment>
}`;
const shots = ['editorial-column', 'type-impact', 'fragment-collage', 'tracking-ribbon', 'mask-reveal', 'poster-blocks', 'quiet-tableau'];
const compositions = ['split-duo', 'quad-grid', 'diagonal-cut', 'triptych', 'banded', 'poster-frame', 'fan-burst', 'shutters', 'offset-collage'];

export function createSpatialLyrics(ctx, style = 'corridor') {
  const T = ctx.THREE, group = root(ctx), resources = ctx.services.spatialResources || createSpatialResources(T);
  const local = !ctx.services.spatialResources, geometry = own(ctx, new T.PlaneGeometry(1, 1, style === 'cadenza' ? 80 : 1, 1));
  const highlight = style === 'tempera' ? 0xffce91 : style === 'sonnet' ? 0xffdeac : style === 'cadenza' ? 0x8eebdd : 0x91dfff;
  const rows = Array.from({ length: 7 }, () => {
    const uniforms = { uText: { value: null }, uRows: { value: Array.from({ length: 6 }, () => new T.Vector4(0, 0, -1, -1)) },
      uFill: { value: new Float32Array(6) }, uCurrent: { value: 0 }, uOpacity: { value: 0 }, uTime: { value: 0 },
      uGlow: { value: 0 }, uReveal: { value: 1 }, uKaraoke: { value: 1 },
      uStyle: { value: style === 'wipe' ? 1 : 0 }, uTexel: { value: new T.Vector2(1/1024, 1/256) },
      uBase: { value: new T.Color(0xf1f3f5) }, uHighlight: { value: new T.Color(highlight) } };
    const rowVertex = style === 'cadenza' ? `uniform float uTime,uCurrent,uGlow;varying vec2 vUv;void main(){vUv=uv;vec3 p=position;
      p.y+=sin(uv.x*24.0+uTime*.3)*uCurrent*uGlow*.018;p.z+=sin(uv.x*13.0-uTime*.2)*uCurrent*.08;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}` : vertex;
    const material = own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: rowVertex, fragmentShader: lyricFragment,
      transparent: true, depthWrite: false, depthTest: false, side: T.DoubleSide }));
    const mesh = new T.Mesh(geometry, material); mesh.visible = false; mesh.renderOrder = 2; group.add(mesh);
    return { mesh, key: '', entry: null, line: null, rel: 0, fresh: true,
      targetPosition: new T.Vector3(), targetScale: new T.Vector3(), targetRotation: new T.Euler(), targetQuaternion: new T.Quaternion() };
  });
  const decor = own(ctx, new T.InstancedMesh(own(ctx, new T.BoxGeometry(1, 1, 1)),
    own(ctx, new T.MeshBasicMaterial({ color: highlight, wireframe: style !== 'tempera', transparent: true, opacity: style === 'tempera' ? .22 : .17 })), 24));
  group.add(decor); const object = new T.Object3D(), color = new T.Color();
  let disposed = false, aspect = ctx.camera.aspect || 16 / 9, previousIndex = null;
  function cleanup() {
    if (disposed) return; disposed = true;
    rows.forEach(row => resources.text.release(row.entry)); if (local) resources.dispose();
  }
  ctx.scope.defer(cleanup);
  function update(frame, p) {
    const lyrics = frame.lyrics || ctx.services.lyrics || {}, lines = lyrics.lines || [];
    const index = lyrics.localIndex ?? lyrics.index ?? 0, globalIndex = lyrics.trackIndex ?? index;
    const wrapWidth = aspect < .8 ? 896 : aspect < 1.2 ? 1344 : 1792;
    const playback = frame.time || 0, time = frame.sceneTime ?? playback, dt = Math.max(0, frame.dynamicDt ?? frame.dt ?? 0);
    const snap = previousIndex === null || frame.playing === false || frame.reduced || Math.abs(globalIndex - previousIndex) > 1;
    const easing = 1 - Math.exp(-dt * 9);
    previousIndex = globalIndex;
    const wanted = [];
    for (let rel = -3; rel <= 3; rel++) {
      const line = lines[index + rel];
      if (line?.text) wanted.push({ line, rel, key: String(line.start ?? globalIndex + rel) + ':' + line.text });
    }
    rows.forEach(row => {
      if (wanted.some(item => item.key === row.key) && row.wrapWidth === wrapWidth) return;
      resources.text.release(row.entry); row.entry = null; row.key = ''; row.mesh.visible = false;
    });
    wanted.sort((a, b) => Math.abs(a.rel) - Math.abs(b.rel)).forEach(item => {
      const row = rows.find(row => row.key === item.key) || rows.find(row => !row.key);
      if (!row) return;
      if (row.key !== item.key) row.fresh = true;
      row.key = item.key; row.mesh.userData.lyricKey = item.key; row.rel = item.rel; row.line = item.line;
      row.wrapWidth = wrapWidth;
      if (!row.entry) row.entry = resources.text.acquire(item.line.text, style === 'sonnet' ? 'serif' : 'sans-serif', wrapWidth);
    });
    resources.beginFrame(frame.now ?? time);
    const distance = Math.max(8, ctx.camera.position.length()), visibleHeight = 2 * distance * Math.tan(ctx.camera.fov * Math.PI / 360);
    const visibleWidth = visibleHeight * aspect, maxWidth = Math.min(p.textWidth ?? 12, visibleWidth * .82);
    let step = p.spacing ?? 2.1;
    rows.forEach(row => {
      const layout = row.entry?.layout; if (!layout) return;
      const glyph = Math.min(row.rel === 0 ? .96 : .64, maxWidth * layout.fontSize / layout.width, visibleHeight * (row.rel === 0 ? .42 : .3) * layout.fontSize / layout.height);
      row.width = layout.width / layout.fontSize * glyph; row.height = layout.height / layout.fontSize * glyph;
      step = Math.max(step, row.height + .35);
    });
    rows.forEach(row => {
      const { mesh, entry, rel, line } = row, layout = entry?.layout;
      mesh.visible = !!entry?.texture && Math.abs(rel) <= 2; if (!mesh.visible) return;
      const abs = Math.abs(rel), current = rel === 0, u = mesh.material.uniforms;
      let x = Math.sin(rel * .35) * (p.arc ?? .7) * .28, z = -abs * .55;
      let y = -rel * step;
      const rotation = row.targetRotation; rotation.set(0, 0, 0);
      if (style === 'cadenza') { x += rel * .32; z -= abs * .5; rotation.z = rel * -.018; }
      if (style === 'sonnet') { x -= Math.min(.6, visibleWidth * .03); z -= abs * .3; }
      if (style === 'tempera') { x += Math.sin(rel * 2.4) * .3; rotation.z = Math.sin(rel) * .018; }
      row.targetScale.set(row.width, row.height, 1); u.uReveal.value = 1;
      if (style === 'sonnet') {
        const shot = !p.shotFlow || p.shotFlow === 'auto' ? shots[Math.floor(time / 9) % shots.length] : p.shotFlow;
        if (shot === 'fragment-collage') { x += Math.sin(rel * 3) * .3; rotation.z = rel * .016; }
        if (shot === 'tracking-ribbon') { x += Math.sin(time * .3) * .18; z -= abs * .3; }
        if (shot === 'type-impact' && current) row.targetScale.multiplyScalar(1 + Math.sin(time * .5) * .025);
        if (shot === 'mask-reveal' && current) u.uReveal.value = Math.max(entry.end, 1 - Math.exp(-Math.max(0, playback - (line.start || 0)) * 8));
        if (shot === 'poster-blocks') z -= abs % 2 * .4;
        if (shot === 'quiet-tableau') x = 0;
      }
      if (p.layout === 'diorama') { z -= abs * .6; rotation.y = rel * -.035; }
      if (p.layout === 'tempo') y += Math.sin(time * 2 + rel) * level(frame, 'bass') * .08;
      if (p.layout === 'still') rotation.set(0, 0, 0);
      const half = row.width * .5, margin = visibleWidth * .45;
      x = Math.max(-Math.max(0, margin - half), Math.min(Math.max(0, margin - half), x));
      row.targetPosition.set(x, y, z); row.targetQuaternion.setFromEuler(rotation);
      if (snap || row.fresh) {
        mesh.position.copy(row.targetPosition); mesh.scale.copy(row.targetScale); mesh.quaternion.copy(row.targetQuaternion);
      } else {
        mesh.position.lerp(row.targetPosition, easing); mesh.scale.lerp(row.targetScale, easing); mesh.quaternion.slerp(row.targetQuaternion, easing);
      }
      row.fresh = false;
      u.uText.value = entry.texture; u.uCurrent.value = current ? 1 : 0; u.uKaraoke.value = p.karaoke === false ? 0 : 1;
      u.uTexel.value.set(1 / layout.width, 1 / layout.height);
      u.uTime.value = time; u.uGlow.value = frame.reduced ? 0 : .25 + level(frame, 'bass') * .5;
      u.uOpacity.value = current ? 1 : Math.max(.1, .54 - abs * .13);
      const fills = lyricFill(layout, line, playback, lyrics.progress);
      for (let i = 0; i < 6; i++) {
        const physical = layout.rows[i];
        u.uRows.value[i].set(physical?.left || 0, physical?.right || 0, physical?.bottom ?? -1, physical?.top ?? -1);
        u.uFill.value[i] = fills[i] ?? -1;
      }
    });
    const edge = Math.max(visibleWidth * .47, maxWidth * .6), scene = p.sceneKind || 'orbital';
    for (let i = 0; i < decor.count; i++) {
      const side = i % 2 ? 1 : -1, n = Math.floor(i / 2), a = i / decor.count * Math.PI * 2;
      object.position.set(side * edge, (n % 5 - 2) * 1.7, -2 - n * 1.2);
      object.scale.set(.025, style === 'classic' ? .6 + level(frame, 'mid') : 1.1, .025); object.rotation.set(0, time * .02, 0);
      if (style === 'corridor' || style === 'wipe') object.scale.set(.018, 8, .018);
      if (style === 'cadenza') { object.scale.set(.4, .4, .4); object.rotation.z = time * .05 + i; }
      if (style === 'sonnet') {
        object.scale.set(.3, .025, .2);
        if (scene === 'orbital' || scene === 'orrery') { object.position.set(Math.cos(a + time * .04) * edge * 1.1, Math.sin(a + time * .04) * 5, -4 - i % 3); object.rotation.z = a; object.scale.x = scene === 'orrery' ? 1 : .3; }
        if (scene === 'constellation') { object.position.y = (seed(i, 2) - .5) * 10; object.scale.setScalar(.08); }
        if (scene === 'perspective') { object.position.y = side * 4; object.position.z = -n * 2; object.scale.z = 1.5; }
        if (scene === 'wave-score') { object.position.y = Math.sin(time * .4 + n * .7) * 3; object.scale.y = .3 + level(frame, 'mid'); }
        if (scene === 'editorial-lattice') { object.position.y = (n % 4 - 1.5) * 2; object.scale.x = 1.3; }
      }
      if (style === 'tempera') {
        const composition = !p.composition || p.composition === 'auto' ? compositions[Math.floor(time / 16) % compositions.length] : p.composition;
        object.scale.set(1.5, 1.2, .15); object.position.z = -4 - n % 3 * 2;
        if (composition === 'quad-grid') object.position.y = (n % 2 ? 1 : -1) * 3;
        if (composition === 'diagonal-cut') { object.rotation.z = -.4; object.scale.set(3, .6, .15); }
        if (composition === 'triptych') object.scale.set(.8, 3, .15);
        if (composition === 'banded' || composition === 'shutters') object.scale.set(2.6, composition === 'banded' ? .6 : .3, .15);
        if (composition === 'poster-frame') { object.position.y = (n % 2 ? 1 : -1) * 4; object.scale.set(.18, 2.5, .15); }
        if (composition === 'fan-burst') { object.rotation.z = side * n * .22; object.scale.set(3, .25, .15); }
        if (composition === 'offset-collage') { object.position.y += seed(i, 2); object.rotation.z = side * .15; }
        color.setHSL(p.colorMode === 'mono' ? 0 : i % 2 ? .47 : .055, p.colorMode === 'mono' ? 0 : p.colorMode === 'vivid' ? .9 : .5, .4); decor.setColorAt(i, color);
      }
      object.updateMatrix(); decor.setMatrixAt(i, object.matrix);
    }
    decor.instanceMatrix.needsUpdate = true; if (decor.instanceColor) decor.instanceColor.needsUpdate = true;
    decor.visible = !!lines.length; group.scale.setScalar(p.scale ?? 1); group.rotation.y = p.director ? Math.sin(time * .08) * .025 : 0;
  }
  function quality(profile) { decor.count = Math.max(8, Math.floor(24 * qualityDensity(profile))); }
  quality(ctx.quality);
  return basicInstance(group, ctx.params, ctx.quality, { update, quality, resize(w, h) { aspect = w / Math.max(1, h); }, dispose: cleanup,
    stats: () => ({ textRows: rows.filter(row => row.entry).length, drawCalls: 6, triangles: decor.count * 12 + 10, ...resources.stats() }) });
}

