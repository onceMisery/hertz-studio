// SPDX-License-Identifier: MIT
// Pure preflight of this original source's fixed construction graph. The
// descriptors below count numeric payloads; they create no Three/DOM objects.
import { geometrySourcePlan } from '../../space-stage/src/source-resources.js';
import { effectsResourcePlan } from '../../space-stage/src/effects/index.js';

export function resourcePlan() {
  let cpu = 0, gpu = 0;
  const array = (bytes, upload = true) => { cpu += bytes; if (upload) gpu += bytes; };
  const add = (vertices, indices, components, scratch = 0, retainedExtra = 0) => {
    const bytes = vertices * components * 4 + indices * (vertices > 65535 ? 4 : 2);
    cpu += bytes + scratch + retainedExtra; gpu += bytes;
    return { vertices, indices, components, bytes };
  };
  const geometry = (kind, args) => {
    const plan = geometrySourcePlan(kind, args); cpu += plan.cpuPeakBytes; gpu += plan.bufferBytes;
    return { vertices: plan.vertices, indices: plan.indices, components: 8, bytes: plan.bufferBytes };
  };
  const copy = (g, expand = false) => add(expand && g.indices ? g.indices : g.vertices,
    expand ? 0 : g.indices, g.components);
  const color = g => { array(g.vertices * 12); return { ...g, components: g.components + 3, bytes: g.bytes + g.vertices * 12 }; };
  const normalize = g => {
    if (g.indices) g = copy(g, true);
    // Removing UVs retains their original source allocation in its scope.
    g = { ...g, components: g.components - 2, bytes: g.bytes - g.vertices * 8 };
    return color(g);
  };
  const painted = (kind, args) => color(normalize(geometry(kind, args)));
  const merged = parts => {
    const vertices = parts.reduce((sum, g) => sum + g.vertices, 0), indices = parts.reduce((sum, g) => sum + g.indices, 0);
    // Original normalize/paint replaces existing color attributes. Their
    // retired source payload remains in cpu/gpu, while the merge has 9 floats.
    return add(vertices, indices, parts[0]?.indices ? 8 : 9, indices * 8);
  };
  const loft = (segments, ring, colors = false) => {
    const vertices = (segments + 1) * (ring + 1), indices = segments * ring * 6;
    return add(vertices, indices, colors ? 11 : 8, (vertices * (colors ? 8 : 5) + indices) * 8);
  };
  const tube = (segments, ring) => add((segments + 1) * (ring + 1), segments * ring * 6, 8,
    segments * ring * 6 * 8, ((segments + 1) * 6 + 15) * 8);
  const shape = (vertices) => add(vertices, vertices * 6, 8,
    vertices * (8 + 2 * 2 + 12) * 8 + vertices * 6 * 8);
  const lod = (columns, rows) => {
    const count = 6 * ((columns - 1) * (rows - 1) + Math.ceil((columns - 1) / 2) * Math.ceil((rows - 1) / 2)
      + Math.ceil((columns - 1) / 3) * Math.ceil((rows - 1) / 3));
    const bytes = count * (columns * rows > 65535 ? 4 : 2); cpu += bytes + count * 8; gpu += bytes;
  };
  geometry('SphereGeometry', [400, 48, 24]); geometry('SphereGeometry', [50, 32, 16]);
  let columns = 0, rows = 0;
  for (let x = -260; x <= 420; x += x > -60 && x < 120 ? 1.2 : 4) columns++;
  for (let z = -8; z >= -520; z -= z > -70 ? .9 : z > -160 ? 2.5 : 8) rows++;
  add(columns * rows, (columns - 1) * (rows - 1) * 6, 3,
    (columns * rows * 3 + (columns - 1) * (rows - 1) * 6) * 8); lod(columns, rows); array(6 * 4, false);
  geometry('PlaneGeometry', [72, 5.64]);
  merged([painted('CylinderGeometry', [.12, .2, 1.8, 7]), ...Array.from({ length: 4 }, () => painted('IcosahedronGeometry', [1, 1]))]);
  merged([painted('CylinderGeometry', [.1, .16, 1.2, 6]), ...Array.from({ length: 4 }, () => painted('ConeGeometry', [1, 1, 8, 1]))]);
  merged([color(normalize(copy(tube(18, 8)))), ...Array.from({ length: 9 }, () => color(normalize(loft(14, 4)))),
    ...Array.from({ length: 4 }, () => painted('SphereGeometry', [.14, 8, 6]))]);
  painted('DodecahedronGeometry', [.8, 1]);
  const cone = copy(geometry('ConeGeometry', [1.25, .45, 12, 1, true]), true); array(cone.vertices * 12);
  merged([painted('CylinderGeometry', [.03, .03, 2.2, 6]), { ...cone, components: 9 }, painted('BoxGeometry', [1.8, .02, .9])]);
  let guardPosts = 0; for (let x = 0; x < 72; x += 2.4) guardPosts++;
  merged(Array.from({ length: guardPosts + 5 }, () => painted('BoxGeometry', [1, 1, 1])));
  const lamps = [];
  for (let i = 0; i < 2; i++) lamps.push(normalize(geometry('CylinderGeometry', [.06, .1, 5.2, 10])),
    normalize(copy(tube(12, 6))), normalize(geometry('CylinderGeometry', [.12, .26, .2, 12])),
    normalize(geometry('CylinderGeometry', [.16, .16, .06, 10])));
  color(merged(lamps));
  merged(Array.from({ length: 2 }, () => normalize(geometry('SphereGeometry', [.17, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]))));
  merged(Array.from({ length: 2 }, () => geometry('CircleGeometry', [3.4, 32])));
  painted('CylinderGeometry', [.04, .04, 2.3, 8]); geometry('PlaneGeometry', [1.1, 1.1]);
  rows = 0;
  for (let z = -34; z < -16; z += 2) rows++;
  for (let z = -16; z < -3.4; z += .7) rows++;
  rows += 5;
  for (let z = 4.6; z < 22; z += 1.2) rows++;
  for (let z = 22; z < 60; z += 2.4) rows++;
  for (let z = 60; z <= 136; z += 4) rows++;
  for (let chunk = 0; chunk < 7; chunk++) {
    add(37 * rows, 36 * (rows - 1) * 6, 11, 36 * (rows - 1) * 6 * 8); lod(37, rows); array(39 * rows * 4, false);
    for (const count of [34, 26, 6, 8, 2]) array(count * (16 + 3) * 4);
  }
  geometry('ConeGeometry', [16, 7, 14, 3]); geometry('SphereGeometry', [7, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2.4]);
  geometry('CylinderGeometry', [1.1, 1.7, 13, 24, 1]); geometry('CylinderGeometry', [1.7, 1.7, .25, 24]);
  geometry('CylinderGeometry', [.9, .9, 1.6, 16]); geometry('ConeGeometry', [1.25, 1.4, 16]);
  loft(16, 12, true); shape(1 + 1 + 16 + 1); shape(4);
  for (let i = 0; i < 5; i++) geometry('CylinderGeometry', [.06, .08, 8, 6]);
  merged([painted('SphereGeometry', [1, 12, 8]), painted('SphereGeometry', [.06, 10, 8]),
    painted('ConeGeometry', [.018, .08, 6]), painted('ConeGeometry', [.06, .16, 6])]);
  merged([painted('SphereGeometry', [1, 14, 10]), painted('SphereGeometry', [.11, 10, 8]),
    painted('ConeGeometry', [.045, .55, 8]), painted('SphereGeometry', [.05, 8, 6])]);
  for (let i = 0; i < 2; i++) { const wing = shape(1 + 12 + 1 + 12 + 1); array(wing.vertices * 12); }
  array((9 + 3) * 3 * 16 * 4); array(160 * 4 * 4);
  // Original canvas source metadata: detail, two roads, sprite, three signs,
  // lighthouse stripes. Each ordinary texture owns its complete mip chain.
  const images = [[256, 256], [2048, 512], [2048, 512], [128, 128], [512, 512], [512, 512], [512, 512], [256, 256]];
  let textureDeclaredBytes = 0;
  for (const [w0, h0] of images) { cpu += w0 * h0 * 4; let w = w0, h = h0;
    do { textureDeclaredBytes += Math.max(1, w) * Math.max(1, h) * 4; w = Math.floor(w / 2); h = Math.floor(h / 2); } while (w || h); }
  cpu += 256 * 256 * 8 + 4 * (16 + 64 + 256 + 1024 + 4096 + 16384);
  // PMREM's eleven LOD planes, background box and temporary JS arrays.
  const pmremBuffers = 11 * 36 * 6 * 4 + 24 * 8 * 4 + 36 * 2;
  cpu += pmremBuffers + (24 * 8 + 36 + 30) * 8; gpu += pmremBuffers;
  const effects = effectsResourcePlan();
  return { ownedCpuBytes: cpu + effects.ownedCpuBytes, bufferDeclaredBytes: gpu + effects.bufferDeclaredBytes,
    canvases: images.length, textureDeclaredBytes,
    // One output + pingpong at first render; retain a second full output to
    // cover the existing time-of-day environment replacement peak.
    renderTargetDeclaredBytes: 768 * 1024 * (12 * 2 + 8),
    // Sky/ocean, 10 material families, two instanced variants, five boat sail
    // variants, PMREM's three programs and three original optional effects.
    programs: 2 + 10 + 2 + 5 + 3 + 3 };
}
