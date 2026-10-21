// SPDX-License-Identifier: MIT
// Shared hand-feel for the four stellar scenes: pointer field, click impulse,
// hold charge, glow billboards and pooled shock rings. No host API is added.
import { createParticlePointer } from './particle-pointer.js';
import { seed } from './factories.js';

const TAU = Math.PI * 2;
export { TAU };
export const approach = (dt, tau) => 1 - Math.exp(-Math.max(0, dt) / Math.max(.001, tau));

export function createField(ctx, object, options = {}) {
  const pointer = createParticlePointer(ctx, object, options);
  const uniforms = {
    ...pointer.uniforms,
    uBurst: { value: 0 }, uBurstAge: { value: 1 }, uCharge: { value: 0 },
    uBurstPoint: { value: new ctx.THREE.Vector3() }
  };
  const ray = new ctx.THREE.Raycaster(), ndc = new ctx.THREE.Vector2(), plane = new ctx.THREE.Plane();
  const origin = new ctx.THREE.Vector3(), normal = new ctx.THREE.Vector3(), hit = new ctx.THREE.Vector3();
  let lastSerial = null, fresh = false, charge = 0, burstAge = 1;
  function localClick(click) {
    ctx.camera.updateMatrixWorld();
    object.updateWorldMatrix(true, false);
    ctx.camera.getWorldDirection(normal).negate();
    origin.set(0, 0, options.depth || 0).applyMatrix4(object.matrixWorld);
    plane.setFromNormalAndCoplanarPoint(normal, origin);
    ndc.set(click.x, click.y); ray.setFromCamera(ndc, ctx.camera);
    if (!ray.ray.intersectPlane(plane, hit)) return false;
    object.worldToLocal(hit);
    uniforms.uBurstPoint.value.copy(hit);
    return true;
  }
  return {
    uniforms,
    update(frame, strength = 1) {
      const reduced = !!frame.reduced;
      const dt = reduced ? 0 : Math.max(0, Math.min(.05, Number(frame.dt) || 0));
      pointer.update(frame, reduced ? 0 : strength);
      if (reduced) {
        charge = 0; burstAge = 1; fresh = false;
        uniforms.uCharge.value = 0; uniforms.uBurst.value = 0; uniforms.uBurstAge.value = 1;
        if (lastSerial === null) lastSerial = frame.pointer?.click?.serial ?? 0;
        return;
      }
      const source = frame.pointer;
      charge += ((source?.down && !source.dragging ? 1 : 0) - charge) * approach(dt, .3);
      const click = source?.click;
      if (lastSerial === null) lastSerial = click?.serial ?? 0;
      else if (click && click.serial !== lastSerial) {
        lastSerial = click.serial;
        if (localClick(click)) { burstAge = 0; fresh = true; }
      }
      if (burstAge < 1) burstAge = Math.min(1, burstAge + dt / 1.05);
      uniforms.uCharge.value = charge;
      uniforms.uBurstAge.value = burstAge;
      uniforms.uBurst.value = (1 - burstAge) * (1 - burstAge);
    },
    takeClick() { const value = fresh; fresh = false; return value; },
    get charge() { return charge; }
  };
}

const glowVertex = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const glowFragment = `uniform vec3 uColor; uniform float uOpacity,uPower; varying vec2 vUv;
void main(){ float d=length(vUv-.5)*2.0; if(d>1.0) discard;
 float core=exp(-d*d*(18.0+uPower*22.0)), halo=exp(-d*d*4.2)*.42, tail=(1.0-smoothstep(.35,1.0,d))*.08;
 float alpha=(core*.8+halo+tail)*uOpacity;
 gl_FragColor=vec4(uColor*(.72+core*.95),alpha);
 #include <colorspace_fragment>
}`;

export function createGlow(ctx, parent, { color = 0xffffff, opacity = .5, power = 0, renderOrder = 6, depthTest = false, size = 1 } = {}) {
  const T = ctx.THREE;
  const uniforms = { uColor: { value: new T.Color(color) }, uOpacity: { value: opacity }, uPower: { value: power } };
  const material = ctx.scope.track(new T.ShaderMaterial({ uniforms, vertexShader: glowVertex, fragmentShader: glowFragment,
    transparent: true, depthWrite: false, depthTest, blending: T.AdditiveBlending }));
  const mesh = new T.Mesh(ctx.scope.track(new T.PlaneGeometry(1, 1)), material);
  mesh.scale.setScalar(size); mesh.renderOrder = renderOrder; mesh.frustumCulled = false; parent.add(mesh);
  return {
    mesh, uniforms,
    set(nextColor, nextOpacity, nextSize) {
      if (nextColor !== undefined) uniforms.uColor.value.set(nextColor);
      if (nextOpacity !== undefined) uniforms.uOpacity.value = nextOpacity;
      if (nextSize !== undefined) mesh.scale.setScalar(nextSize);
    }
  };
}

export function faceCamera(mesh, camera) {
  const q = new (mesh.quaternion.constructor)(), cq = new (mesh.quaternion.constructor)();
  if (mesh.parent) { mesh.parent.getWorldQuaternion(q); q.invert(); } else q.identity();
  camera.getWorldQuaternion(cq);
  mesh.quaternion.copy(q.multiply(cq));
}

const starVertex = `attribute vec3 aColor; attribute float aSize; uniform float uTime,uPixel,uHeight,uOpacity;
varying vec3 vColor; varying float vAlpha;
void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv;
 float tw=.72+.28*sin(uTime*(.45+aSize*.35)+position.x*1.7+position.y*2.3+position.z*.9);
 vColor=aColor; vAlpha=uOpacity*tw;
 gl_PointSize=clamp(aSize*uPixel*uHeight*.085/max(2.0,-mv.z),1.0,5.0);
}`;
const starFragment = `varying vec3 vColor; varying float vAlpha;
void main(){ float d=length(gl_PointCoord-.5); if(d>.5) discard;
 float core=1.0-smoothstep(.05,.36,d), halo=exp(-d*d*22.0)*.28;
 gl_FragColor=vec4(vColor,(core+halo)*vAlpha);
 #include <colorspace_fragment>
}`;

export function createStarfield(ctx, parent, { count = 1200, near = 18, far = 64, palette = [0x9fd7e8, 0xf7e4c8, 0x8ea6ff], size = [.6, 2.2], opacity = .8 } = {}) {
  const T = ctx.THREE;
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), sizes = new Float32Array(count);
  const color = new T.Color(), tints = palette.map(hex => new T.Color(hex));
  for (let i = 0; i < count; i++) {
    const r = near + Math.pow(seed(i, 11), .7) * (far - near);
    const theta = seed(i, 12) * TAU, phi = Math.acos(2 * seed(i, 13) - 1), cp = Math.sin(phi);
    positions.set([Math.cos(theta) * cp * r, Math.cos(phi) * r * .66, Math.sin(theta) * cp * r], i * 3);
    color.copy(tints[i % tints.length]).lerp(tints[(i + 1) % tints.length], seed(i, 14) * .4);
    color.toArray(colors, i * 3); sizes[i] = size[0] + Math.random() * (size[1] - size[0]);
  }
  const geometry = ctx.scope.track(new T.BufferGeometry());
  geometry.setAttribute('position', new T.BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new T.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new T.BufferAttribute(sizes, 1));
  const uniforms = { uTime: { value: 0 }, uPixel: { value: 1 }, uHeight: { value: 720 }, uOpacity: { value: opacity } };
  const material = ctx.scope.track(new T.ShaderMaterial({ uniforms, vertexShader: starVertex, fragmentShader: starFragment,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
  const points = new T.Points(geometry, material); points.frustumCulled = false; parent.add(points);
  return { points, uniforms, setDensity(fraction) { geometry.setDrawRange(0, Math.floor(count * fraction)); } };
}

const skyVertex = `varying vec3 vPos; void main(){ vPos=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const skyFragment = `uniform vec3 uTop,uBottom,uGlow; uniform float uTime,uOpacity; varying vec3 vPos;
void main(){ vec3 n=normalize(vPos); float h=clamp(n.y*.5+.5,0.0,1.0);
 vec3 c=mix(uBottom,uTop,smoothstep(.16,.92,h));
 float band=pow(max(0.0,sin(n.x*2.6+n.z*1.9+uTime*.018)),6.0);
 float haze=pow(max(0.0,sin(n.y*3.1-n.z*2.2+uTime*.012)),4.0);
 c+=uGlow*(band*.22+haze*.12)*(1.0-h*.55);
 gl_FragColor=vec4(c*uOpacity,1.0);
 #include <colorspace_fragment>
}`;

export function createSky(ctx, parent, { top = 0x05070d, bottom = 0x0b1520, glow = 0x1b5b68, opacity = 1 } = {}) {
  const T = ctx.THREE;
  const uniforms = { uTop: { value: new T.Color(top) }, uBottom: { value: new T.Color(bottom) }, uGlow: { value: new T.Color(glow) }, uTime: { value: 0 }, uOpacity: { value: opacity } };
  const material = ctx.scope.track(new T.ShaderMaterial({ uniforms, vertexShader: skyVertex, fragmentShader: skyFragment,
    side: T.BackSide, depthWrite: false, depthTest: false, blending: T.NormalBlending }));
  const mesh = new T.Mesh(ctx.scope.track(new T.SphereGeometry(86, 32, 18)), material);
  mesh.renderOrder = -20; mesh.frustumCulled = false; parent.add(mesh);
  return { mesh, uniforms, update(time) { uniforms.uTime.value = time; } };
}

const shockVertex = `attribute float aAge; attribute vec3 aColor; varying vec2 vUv; varying float vAge; varying vec3 vColor;
void main(){ vUv=uv; vAge=aAge; vColor=aColor;
 gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);
}`;
const shockFragment = `uniform float uOpacity; varying vec2 vUv; varying float vAge; varying vec3 vColor;
void main(){ float d=length(vUv-.5)*2.0; float r=.12+vAge*.86;
 float ring=exp(-pow((d-r)/.035,2.0)), halo=exp(-pow((d-r)/.14,2.0))*.22;
 float alpha=(ring+halo)*pow(max(0.0,1.0-vAge),1.7)*uOpacity;
 if(alpha<.004) discard;
 gl_FragColor=vec4(vColor*(.8+ring*.8),alpha);
 #include <colorspace_fragment>
}`;

export function createShockPool(ctx, parent, { count = 6, duration = 1.1, opacity = .9 } = {}) {
  const T = ctx.THREE;
  const geometry = ctx.scope.track(new T.PlaneGeometry(2, 2));
  const ages = new Float32Array(count).fill(1), colors = new Float32Array(count * 3).fill(1);
  geometry.setAttribute('aAge', new T.InstancedBufferAttribute(ages, 1));
  geometry.setAttribute('aColor', new T.InstancedBufferAttribute(colors, 3));
  const uniforms = { uOpacity: { value: opacity } };
  const material = ctx.scope.track(new T.ShaderMaterial({ uniforms, vertexShader: shockVertex, fragmentShader: shockFragment,
    transparent: true, depthWrite: false, depthTest: false, blending: T.AdditiveBlending }));
  const mesh = new T.InstancedMesh(geometry, material, count); mesh.frustumCulled = false; mesh.renderOrder = 5; parent.add(mesh);
  const dummy = new T.Object3D(), color = new T.Color();
  for (let i = 0; i < count; i++) { dummy.scale.setScalar(0); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); }
  mesh.instanceMatrix.needsUpdate = true;
  let cursor = 0;
  return {
    mesh,
    spawn(position, quaternion = null, size = 2, tint = 0xffffff) {
      const index = cursor++ % count;
      dummy.position.copy(position); dummy.quaternion.copy(quaternion || new T.Quaternion()); dummy.scale.setScalar(size); dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix); ages[index] = 0; color.set(tint); color.toArray(colors, index * 3);
      geometry.attributes.aAge.needsUpdate = true; geometry.attributes.aColor.needsUpdate = true; mesh.instanceMatrix.needsUpdate = true;
    },
    update(dt, reduced) {
      let changed = false;
      for (let i = 0; i < count; i++) {
        const next = reduced ? 1 : Math.min(1, ages[i] + dt / duration);
        if (next !== ages[i]) { ages[i] = next; changed = true; }
      }
      if (changed) geometry.attributes.aAge.needsUpdate = true;
    }
  };
}

