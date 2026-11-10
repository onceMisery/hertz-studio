// SPDX-License-Identifier: MIT
// Real GLBs and the installed loader. Only admission ports / their delay gates
// are simulated; Three objects, attributes, arrays and disposal are real.
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const threeUrl = pathToFileURL(path.join(root, 'tools/space-stage/node_modules/three/build/three.module.js')).href;
const THREE = await import(threeUrl);
const { GLTFLoader } = await import(pathToFileURL(path.join(root, 'tools/space-stage/node_modules/three/examples/jsm/loaders/GLTFLoader.js')).href);
const { parseStaticModel, compareStaticModelFacts, STATIC_MODEL_PROFILE, STATIC_MODEL_LOADER_VERSION, STATIC_MODEL_MAX_DEPTH } = await import(pathToFileURL(path.join(root, 'tools/space-stage/src/composition/model-resource.js')).href);
const { createScope } = await import(pathToFileURL(path.join(root, 'tools/space-stage/src/scope.js')).href);
const packageInfo = JSON.parse(await readFile(path.join(root, 'tools/space-stage/node_modules/three/package.json'), 'utf8'));
assert.equal(packageInfo.version, '0.186.0'); assert.equal(THREE.REVISION, '186');
console.log(`loader=${STATIC_MODEL_LOADER_VERSION} package=${packageInfo.version} profile=${STATIC_MODEL_PROFILE}`);

const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0], normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
const trs = (translation = [0, 0, 0], rotation = [0, 0, 0, 1], scale = [1, 1, 1]) => ({ kind: 'trs', translation, rotation, scale });
const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function encodeGlb(json, binary) {
  const text = new TextEncoder().encode(JSON.stringify(json)), jsonBytes = Math.ceil(text.length / 4) * 4;
  const binBytes = Math.ceil(binary.byteLength / 4) * 4, encodedBytes = 12 + 8 + jsonBytes + 8 + binBytes;
  const buffer = new ArrayBuffer(encodedBytes), bytes = new Uint8Array(buffer), view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, encodedBytes, true);
  view.setUint32(12, jsonBytes, true); view.setUint32(16, 0x4e4f534a, true); bytes.fill(0x20, 20, 20 + jsonBytes); bytes.set(text, 20);
  const binOffset = 20 + jsonBytes; view.setUint32(binOffset, binBytes, true); view.setUint32(binOffset + 4, 0x004e4942, true); bytes.set(binary, binOffset + 8);
  return { buffer, input: { encodedBytes, jsonBytes, binBytes } };
}

function fixture({ indexed = true, aliased = false, multiplePrimitives = false } = {}) {
  const binary = new Uint8Array(indexed ? 80 : 72);
  new Float32Array(binary.buffer, 0, 9).set(positions); new Float32Array(binary.buffer, 36, 9).set(normals);
  if (indexed) new Uint16Array(binary.buffer, 72, 3).set([0, 1, 2]);
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, ...(indexed ? { indices: 2 } : {}) }] }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }, ...(indexed ? [{ buffer: 0, byteOffset: 72, byteLength: 8 }] : [])],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }, ...(indexed ? [{ bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' }] : [])] };
  // Two distinct POSITION accessor objects over the same full view. This is
  // packed, with the legal explicit stride required by the package owner.
  if (aliased) {
    json.bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: 72, byteStride: 12 }, { buffer: 0, byteOffset: 72, byteLength: 8 }];
    json.accessors = [{ ...json.accessors[0] }, { ...json.accessors[1], bufferView: 0, byteOffset: 36 },
      { ...json.accessors[0] }, { ...json.accessors[2], bufferView: 1 }];
    json.meshes[0].primitives[0].indices = 3;
    const second = { attributes: { POSITION: 2, NORMAL: 1 }, indices: 3 };
    if (multiplePrimitives) json.meshes[0].primitives.push(second);
    else { json.meshes.push({ primitives: [second] }); json.nodes.push({ mesh: 1 }); json.scenes[0].nodes.push(1); }
  }
  return { json, binary };
}

// Expected layouts below are fixture declarations, independent of the factory
// preflight; there is no mirror parser or fake geometry implementation.
function expectedBase(input, indexed = true) {
  const geometries = [{ key: `${indexed ? 2 : 'undefined'}:NORMAL:1;POSITION:0;:undefined`, positionAccessor: 0, normalAccessor: 1,
    indexAccessor: indexed ? 2 : null, mode: null, triangles: 1, positionMin: [0, 0, 0], positionMax: [1, 1, 0] }];
  const accessors = [{ index: 0, viewIndex: 0, componentType: 5126, type: 'VEC3', count: 3, byteOffset: 0, byteLength: 36 },
    { index: 1, viewIndex: 1, componentType: 5126, type: 'VEC3', count: 3, byteOffset: 0, byteLength: 36 },
    ...(indexed ? [{ index: 2, viewIndex: 2, componentType: 5123, type: 'SCALAR', count: 3, byteOffset: 0, byteLength: 6 }] : [])];
  return { profile: STATIC_MODEL_PROFILE, loaderVersion: STATIC_MODEL_LOADER_VERSION, input,
    declared: { nodes: 1, meshes: 1, primitives: 1, accessors: indexed ? 3 : 2, bufferViews: indexed ? 3 : 2 },
    scene: { index: 0, roots: [0], nodes: [{ index: 0, parentIndex: null, meshIndex: 0, children: [], transform: trs() }], maxDepth: 1, objectCount: 2, allocatedObjectCount: 2, drawCalls: 1, triangles: 1 },
    resources: { geometries, accessors, bufferViews: [{ index: 0, byteOffset: 0, byteLength: 36 }, { index: 1, byteOffset: 36, byteLength: 36 },
      ...(indexed ? [{ index: 2, byteOffset: 72, byteLength: 8 }] : [])], geometryCount: 1, attributeCount: indexed ? 3 : 2,
      backingCount: indexed ? 3 : 2, gpuBufferBytes: indexed ? 78 : 72, cpuBackingBytes: indexed ? 80 : 72, allocatedMaterialCount: 2, retainedMaterialCount: 1 } };
}
function expectedAliased(input, multiplePrimitives = false) {
  const facts = expectedBase(input);
  facts.declared = { nodes: multiplePrimitives ? 1 : 2, meshes: multiplePrimitives ? 1 : 2, primitives: 2, accessors: 4, bufferViews: 2 };
  facts.scene = { index: 0, roots: multiplePrimitives ? [0] : [0, 1], nodes: [{ index: 0, parentIndex: null, meshIndex: 0, children: [], transform: trs() },
    ...(multiplePrimitives ? [] : [{ index: 1, parentIndex: null, meshIndex: 1, children: [], transform: trs() }])], maxDepth: 1, objectCount: multiplePrimitives ? 4 : 3, allocatedObjectCount: multiplePrimitives ? 4 : 3, drawCalls: 2, triangles: 2 };
  facts.resources.geometries = [0, 2].map(positionAccessor => ({ key: `3:NORMAL:1;POSITION:${positionAccessor};:undefined`, positionAccessor, normalAccessor: 1,
    indexAccessor: 3, mode: null, triangles: 1, positionMin: [0, 0, 0], positionMax: [1, 1, 0] }));
  facts.resources.accessors = [{ index: 0, viewIndex: 0, componentType: 5126, type: 'VEC3', count: 3, byteOffset: 0, byteLength: 36 },
    { index: 1, viewIndex: 0, componentType: 5126, type: 'VEC3', count: 3, byteOffset: 36, byteLength: 36 },
    { index: 2, viewIndex: 0, componentType: 5126, type: 'VEC3', count: 3, byteOffset: 0, byteLength: 36 },
    { index: 3, viewIndex: 1, componentType: 5123, type: 'SCALAR', count: 3, byteOffset: 0, byteLength: 6 }];
  Object.assign(facts.resources, { bufferViews: [{ index: 0, byteOffset: 0, byteLength: 72 }, { index: 1, byteOffset: 72, byteLength: 8 }],
    geometryCount: 2, attributeCount: 4, backingCount: 2, gpuBufferBytes: 114, cpuBackingBytes: 80 });
  return facts;
}
function parentChildFixture() {
  const f = fixture();
  f.json.nodes = [{ mesh: 0, children: [1], translation: [4, -3, 2], extras: { ownMarker: 'parent' } },
    { mesh: 0, translation: [0, 2, -1], extras: { ownMarker: 'child' } }];
  f.json.meshes[0].extras = { meshMarker: { name: 'fixture' } };
  return f;
}
function expectedParentChild(input) {
  const facts = expectedBase(input); facts.declared.nodes = 2;
  facts.scene = { index: 0, roots: [0], maxDepth: 2, objectCount: 3, allocatedObjectCount: 4, drawCalls: 2, triangles: 2,
    nodes: [{ index: 0, parentIndex: null, meshIndex: 0, children: [1], transform: trs([4, -3, 2]) },
      { index: 1, parentIndex: 0, meshIndex: 0, children: [], transform: trs([0, 2, -1]) }] };
  return facts;
}
function ports(input, overrides = {}) {
  const cpuState = { pending: { ownedCpuBytes: input.encodedBytes + input.binBytes + input.jsonBytes * 2 + 65536 }, released: false, cancelled: false, allocationEnded: false };
  const record = { readyBytes: [], attributes: [], releases: 0, settlements: 0, cpuCommits: 0 };
  return { record, cpuState, options: { admissions: { cpu: { state: () => cpuState,
    commit() { record.cpuCommits++; }, release() { record.releases++; }, settle() { record.settlements++; } } },
    bufferPlan: { cpuReady(bytes) { record.readyBytes.push(bytes); return overrides.cpuReady?.(bytes); },
      upload(attribute) { record.attributes.push(attribute); return overrides.upload ? overrides.upload(attribute) : attribute; } } } };
}
function meshesOf(rootObject) { const list = []; rootObject.traverse(object => { if (object.isMesh) list.push(object); }); return list; }
function closeVector(actual, expected) { actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-12, `${actual} != ${expected}`)); }

const disposedGeometries = new Map(), disposedMaterials = new Map();
const geometryDispose = THREE.BufferGeometry.prototype.dispose, materialDispose = THREE.Material.prototype.dispose;
THREE.BufferGeometry.prototype.dispose = function () { disposedGeometries.set(this, (disposedGeometries.get(this) || 0) + 1); return geometryDispose.call(this); };
THREE.Material.prototype.dispose = function () { disposedMaterials.set(this, (disposedMaterials.get(this) || 0) + 1); return materialDispose.call(this); };
function disposalSnapshot() { return { geometries: new Set(disposedGeometries.keys()), materials: new Set(disposedMaterials.keys()) }; }
function newDisposals(before, geometryCount, materialCount) {
  const geometries = [...disposedGeometries].filter(([object]) => !before.geometries.has(object));
  const materials = [...disposedMaterials].filter(([object]) => !before.materials.has(object));
  assert.equal(geometries.length, geometryCount, 'unique real geometry cleanup'); assert.equal(materials.length, materialCount, 'including hidden default material cleanup');
  assert.ok(geometries.every(([, count]) => count === 1)); assert.ok(materials.every(([object, count]) => count === 1 && object instanceof THREE.MeshStandardMaterial));
  return { geometries: geometries.map(([object]) => object), materials: materials.map(([object]) => object) };
}

let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

try {
  await check('same installed Three and real GLTFLoader baseline', async () => {
    const f = fixture(), encoded = encodeGlb(f.json, f.binary), before = disposalSnapshot();
    const result = await new GLTFLoader().parseAsync(encoded.buffer, '');
    const mesh = meshesOf(result.scene)[0];
    assert.ok(mesh instanceof THREE.Mesh && mesh.material instanceof THREE.MeshStandardMaterial && mesh.geometry instanceof THREE.BufferGeometry);
    assert.deepEqual([...mesh.geometry.attributes.position.array], positions); assert.deepEqual([...mesh.geometry.index.array], [0, 1, 2]);
    mesh.geometry.dispose(); mesh.material.dispose(); result.parser.cache.DefaultMaterial.dispose(); newDisposals(before, 1, 2);
  });
  for (const indexed of [true, false]) await check(indexed ? 'indexed packed arrays and deferred upload' : 'nonindexed packed arrays and default PBR', async () => {
    const f = fixture({ indexed }), encoded = encodeGlb(f.json, f.binary), facts = expectedBase(encoded.input, indexed), p = ports(encoded.input), before = disposalSnapshot();
    const resource = await parseStaticModel(encoded.buffer, facts, p.options), instance = resource.instantiate(), mesh = meshesOf(instance.root)[0];
    compareStaticModelFacts(facts, resource.facts); assert.equal(resource.ready, undefined); assert.equal(resource.parser, undefined); assert.equal(resource.scene, undefined);
    assert.ok(Object.isFrozen(resource.facts) && Object.isFrozen(resource.facts.scene.nodes[0].transform));
    assert.deepEqual([...mesh.geometry.attributes.position.array], positions); assert.deepEqual([...mesh.geometry.attributes.normal.array], normals);
    if (indexed) assert.deepEqual([...mesh.geometry.index.array], [0, 1, 2]); else assert.equal(mesh.geometry.index, null);
    const material = mesh.material;
    assert.equal(material.type, 'MeshStandardMaterial'); assert.equal(material.color.getHex(), 0xffffff); assert.equal(material.emissive.getHex(), 0);
    assert.equal(material.roughness, 1); assert.equal(material.metalness, 1); assert.equal(material.depthTest, true); assert.equal(material.depthWrite, true);
    assert.equal(material.transparent, false); assert.equal(material.side, THREE.FrontSide);
    assert.equal(mesh.geometry.poolOwned, true); assert.equal(material.poolOwned, true);
    assert.deepEqual(p.record.readyBytes, [indexed ? 80 : 72]); assert.equal(p.record.attributes.length, indexed ? 3 : 2);
    assert.equal(new Set(p.record.attributes).size, p.record.attributes.length); assert.equal(p.record.cpuCommits, 0); assert.equal(p.record.settlements, 0); assert.equal(p.record.releases, 0);
    const scope = createScope(); scope.trackTree(instance.root); assert.equal(scope.stats().resources, 0); scope.dispose(); newDisposals(before, 0, 1);
    instance.release(); resource.dispose(); resource.dispose(); instance.release(); newDisposals(before, 1, 2);
    assert.throws(() => resource.instantiate(), /disposed/);
  });
  await check('two model nodes, two private instances, parent TRS and negative scale', async () => {
    const f = fixture(), rotation = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    f.json.nodes = [{ name: 'parent', children: [1, 2], translation: [2, 3, 4], rotation, scale: [-2, 3, 1.5], extras: { nested: { label: 'original', uri: 'metadata-only' } } },
      { name: 'a', mesh: 0, translation: [1, 0, 0] }, { name: 'b', mesh: 0, translation: [0, 1, 0] }];
    const encoded = encodeGlb(f.json, f.binary), facts = expectedBase(encoded.input), before = disposalSnapshot();
    facts.declared.nodes = 3; facts.scene = { index: 0, roots: [0], nodes: [
      { index: 0, parentIndex: null, meshIndex: null, children: [1, 2], transform: trs([2, 3, 4], rotation, [-2, 3, 1.5]) },
      { index: 1, parentIndex: 0, meshIndex: 0, children: [], transform: trs([1, 0, 0]) },
      { index: 2, parentIndex: 0, meshIndex: 0, children: [], transform: trs([0, 1, 0]) }], maxDepth: 2, objectCount: 4, allocatedObjectCount: 5, drawCalls: 2, triangles: 2 };
    const p = ports(encoded.input), resource = await parseStaticModel(encoded.buffer, facts, p.options), first = resource.instantiate(), second = resource.instantiate();
    const a = meshesOf(first.root), b = meshesOf(second.root);
    assert.notEqual(first.root, second.root); assert.notEqual(a[0], a[1]); assert.notEqual(a[0], b[0]); assert.notEqual(a[0].position, b[0].position);
    assert.equal(a[0].geometry, a[1].geometry); assert.equal(a[0].geometry, b[0].geometry); assert.equal(a[0].material, b[1].material);
    assert.equal(p.record.attributes.length, 3, 'shared accessors attach one upload handler each');
    closeVector(a[0].getWorldPosition(new THREE.Vector3()).toArray(), [2, 1, 4]); closeVector(a[1].getWorldPosition(new THREE.Vector3()).toArray(), [-1, 3, 4]);
    first.root.children[0].userData.nested.label = 'changed'; a[0].position.x = 90; a[0].visible = false;
    assert.equal(second.root.children[0].userData.nested.label, 'original'); assert.equal(b[0].position.x, 1); assert.equal(b[0].visible, true);
    const third = resource.instantiate(); assert.equal(third.root.children[0].userData.nested.label, 'original'); assert.equal(meshesOf(third.root)[0].position.x, 1);
    const parent = new THREE.Group(); parent.add(first.root, second.root); first.detach(); assert.equal(first.root.parent, null); assert.equal(second.root.parent, parent);
    first.release(); resource.dispose(); newDisposals(before, 0, 1); assert.equal(second.root.parent, parent);
    second.release(); newDisposals(before, 0, 1); third.release(); newDisposals(before, 1, 2);
  });
  await check('authored arbitrary rotation matrix retains exact negative nonuniform scale', async () => {
    const f = fixture(), quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.37, -0.82, 1.13));
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(1.2, -3.4, 5.6), quaternion, new THREE.Vector3(-1.7, 2.9, 0.43)).elements;
    f.json.nodes[0].matrix = [...matrix];
    const encoded = encodeGlb(f.json, f.binary), facts = expectedBase(encoded.input), before = disposalSnapshot();
    facts.scene.nodes[0].transform = { kind: 'matrix', matrix: [...matrix] };
    const resource = await parseStaticModel(encoded.buffer, facts, ports(encoded.input).options), first = resource.instantiate(), second = resource.instantiate();
    const a = meshesOf(first.root)[0], b = meshesOf(second.root)[0];
    assert.deepEqual(a.matrix.elements, matrix); assert.equal(a.matrixAutoUpdate, false); assert.equal(b.matrixAutoUpdate, false);
    a.updateMatrixWorld(true); assert.deepEqual(a.matrix.elements, matrix); assert.deepEqual(a.matrixWorld.elements, matrix);
    a.matrix.elements[12] = 100; assert.equal(b.matrix.elements[12], 1.2); first.release(); second.release(); resource.dispose(); newDisposals(before, 1, 2);
  });
  await check('depth 128 consumes and clones; depth 129 rejects before allocations', async () => {
    assert.equal(STATIC_MODEL_MAX_DEPTH, 128);
    for (const depth of [128, 129]) {
      const f = fixture();
      f.json.nodes = Array.from({ length: depth }, (_, i) => i === depth - 1 ? { mesh: 0 } : { children: [i + 1] });
      const encoded = encodeGlb(f.json, f.binary), facts = expectedBase(encoded.input), before = disposalSnapshot();
      facts.declared.nodes = depth; Object.assign(facts.scene, { maxDepth: depth, objectCount: depth + 1, allocatedObjectCount: depth + 1,
        nodes: Array.from({ length: depth }, (_, i) => ({ index: i, parentIndex: i === 0 ? null : i - 1, meshIndex: i === depth - 1 ? 0 : null,
          children: i === depth - 1 ? [] : [i + 1], transform: trs() })) });
      if (depth > STATIC_MODEL_MAX_DEPTH) { await assert.rejects(parseStaticModel(encoded.buffer, facts, ports(encoded.input).options), /scene-depth-limit/); newDisposals(before, 0, 0); }
      else {
        const resource = await parseStaticModel(encoded.buffer, facts, ports(encoded.input).options), instance = resource.instantiate();
        assert.equal(meshesOf(instance.root).length, 1); instance.root.updateMatrixWorld(true); instance.release(); resource.dispose(); newDisposals(before, 1, 2);
      }
    }
  });
  await check('5000 broad nodes preserve actual cached mesh allocation count', async () => {
    const f = fixture(); f.json.nodes = Array.from({ length: 5000 }, () => ({ mesh: 0 })); f.json.scenes[0].nodes = f.json.nodes.map((_, i) => i);
    const encoded = encodeGlb(f.json, f.binary), facts = expectedBase(encoded.input), before = disposalSnapshot();
    facts.declared.nodes = 5000; Object.assign(facts.scene, { roots: f.json.scenes[0].nodes, objectCount: 5001, allocatedObjectCount: 5002, drawCalls: 5000, triangles: 5000,
      nodes: Array.from({ length: 5000 }, (_, i) => ({ index: i, parentIndex: null, meshIndex: 0, children: [], transform: trs() })) });
    const p = ports(encoded.input), resource = await parseStaticModel(encoded.buffer, facts, p.options), instance = resource.instantiate();
    assert.equal(instance.root.children.length, 5000); assert.equal(p.record.attributes.length, 3); instance.release(); resource.dispose(); newDisposals(before, 1, 2);
  });
  await check('raw declared bounds differ from effective Float32 bounds; no GPU bounds proof', async () => {
    const f = fixture(), fractional = [0.1, 0.1, 0, 0.5, 0.1, 0, 0.1, 0.8, 0];
    new Float32Array(f.binary.buffer, 0, 9).set(fractional); f.json.accessors[0].min = [0.1, 0.1, 0]; f.json.accessors[0].max = [0.5, 0.8, 0];
    const encoded = encodeGlb(f.json, f.binary), facts = expectedBase(encoded.input), before = disposalSnapshot();
    Object.assign(facts.resources.geometries[0], { positionMin: [0.1, 0.1, 0], positionMax: [0.5, 0.8, 0] });
    const resource = await parseStaticModel(encoded.buffer, facts, ports(encoded.input).options), instance = resource.instantiate(), geometry = meshesOf(instance.root)[0].geometry;
    const raw = geometry.boundingBox.max.y, effective = geometry.attributes.position.array[7];
    assert.equal(raw, 0.8); assert.equal(effective, Math.fround(0.8)); assert.ok(effective > raw);
    assert.equal(geometry.attributes.position.array[0], Math.fround(0.1)); assert.equal(resource.gpuReady, undefined);
    console.log(`EVIDENCE bounds rawMaxY=${raw} effectiveFloat32MaxY=${effective}; rawMinX=0.1 effectiveFloat32MinX=${geometry.attributes.position.array[0]}; conservative bounds remain native/render follow-up`);
    instance.release(); resource.dispose(); newDisposals(before, 1, 2);
  });
  await check('omitted default scene and unused supported declarations stay lazy', async () => {
    const f = fixture(); delete f.json.scene;
    f.json.meshes.push(clone(f.json.meshes[0])); f.json.accessors.push(clone(f.json.accessors[0])); f.json.bufferViews.push(clone(f.json.bufferViews[0]));
    // Unreachable references still cause the loader to clone the reachable mesh.
    f.json.nodes.push({ mesh: 0 });
    const encoded = encodeGlb(f.json, f.binary), facts = expectedBase(encoded.input), before = disposalSnapshot();
    Object.assign(facts.declared, { nodes: 2, meshes: 2, primitives: 2, accessors: 4, bufferViews: 4 }); facts.scene.allocatedObjectCount = 3;
    const p = ports(encoded.input), resource = await parseStaticModel(encoded.buffer, facts, p.options), instance = resource.instantiate();
    assert.equal(instance.root.children.length, 1); assert.equal(p.record.attributes.length, 3); instance.release(); resource.dispose(); newDisposals(before, 1, 2);
  });
  for (const multiplePrimitives of [false, true]) await check(multiplePrimitives ? 'multiple primitives preserve private hierarchy' : 'distinct BufferAttributes sharing backing upload separately', async () => {
    const f = fixture({ aliased: true, multiplePrimitives }), encoded = encodeGlb(f.json, f.binary), facts = expectedAliased(encoded.input, multiplePrimitives), p = ports(encoded.input), before = disposalSnapshot();
    const resource = await parseStaticModel(encoded.buffer, facts, p.options), instance = resource.instantiate(), meshes = meshesOf(instance.root);
    assert.equal(meshes.length, 2); assert.notEqual(meshes[0].geometry, meshes[1].geometry);
    const positionA = meshes[0].geometry.attributes.position, positionB = meshes[1].geometry.attributes.position, normal = meshes[0].geometry.attributes.normal;
    assert.notEqual(positionA, positionB); assert.notEqual(positionA.array, positionB.array); assert.equal(positionA.array.buffer, positionB.array.buffer);
    assert.equal(positionA.array.buffer, normal.array.buffer); assert.equal(meshes[1].geometry.attributes.normal, normal); assert.equal(meshes[1].geometry.index, meshes[0].geometry.index);
    assert.deepEqual([...positionB.array], positions); assert.deepEqual([...normal.array], normals);
    assert.equal(p.record.attributes.reduce((sum, attribute) => sum + attribute.array.byteLength, 0), 114);
    assert.equal([...new Set(p.record.attributes.map(attribute => attribute.array.buffer))].reduce((sum, buffer) => sum + buffer.byteLength, 0), 80);
    assert.deepEqual(p.record.readyBytes, [80]); assert.equal(p.record.attributes.length, 4);
    instance.release(); resource.dispose(); const cleanup = newDisposals(before, 2, 2);
    assert.equal(cleanup.geometries.reduce((sum, geometry) => sum + geometry.attributes.position.array.length, 0), 18);
  });
  await check('explicit TRIANGLES uses its real separate primitive cache key', async () => {
    const f = fixture(); f.json.meshes[0].primitives.push({ ...clone(f.json.meshes[0].primitives[0]), mode: 4 });
    const encoded = encodeGlb(f.json, f.binary), facts = expectedBase(encoded.input), p = ports(encoded.input), before = disposalSnapshot();
    facts.declared.primitives = 2; facts.scene.objectCount = 4; facts.scene.allocatedObjectCount = 4; facts.scene.drawCalls = 2; facts.scene.triangles = 2;
    const explicit = { ...clone(facts.resources.geometries[0]), key: '2:NORMAL:1;POSITION:0;:4', mode: 4 };
    facts.resources.geometries = [explicit, facts.resources.geometries[0]]; facts.resources.geometryCount = 2;
    const resource = await parseStaticModel(encoded.buffer, facts, p.options), instance = resource.instantiate(), meshes = meshesOf(instance.root);
    assert.notEqual(meshes[0].geometry, meshes[1].geometry); assert.equal(meshes[0].geometry.attributes.position, meshes[1].geometry.attributes.position);
    assert.equal(p.record.attributes.length, 3); instance.release(); resource.dispose(); newDisposals(before, 2, 2);
  });
  for (const componentType of [5121, 5125]) await check(`real unsigned indices ${componentType}`, async () => {
    const f = fixture(), type = componentType === 5121 ? Uint8Array : Uint32Array, length = componentType === 5121 ? 76 : 84;
    f.binary = new Uint8Array(length); new Float32Array(f.binary.buffer, 0, 9).set(positions); new Float32Array(f.binary.buffer, 36, 9).set(normals);
    new type(f.binary.buffer, 72, 3).set([0, 1, 2]); f.json.buffers[0].byteLength = length; f.json.bufferViews[2].byteLength = length - 72; f.json.accessors[2].componentType = componentType;
    const encoded = encodeGlb(f.json, f.binary), facts = expectedBase(encoded.input), before = disposalSnapshot();
    Object.assign(facts.resources.accessors[2], { componentType, byteLength: type.BYTES_PER_ELEMENT * 3 });
    facts.resources.bufferViews[2].byteLength = length - 72; facts.resources.cpuBackingBytes = length; facts.resources.gpuBufferBytes = 72 + type.BYTES_PER_ELEMENT * 3;
    const resource = await parseStaticModel(encoded.buffer, facts, ports(encoded.input).options), instance = resource.instantiate();
    assert.ok(meshesOf(instance.root)[0].geometry.index.array instanceof type); instance.release(); resource.dispose(); newDisposals(before, 1, 2);
  });

  // JSON.parse preserves an own "__proto__" data key. Build that exact JSON
  // fixture shape without the object-literal prototype setter shortcut.
  const protoExtras = value => Object.fromEntries([['__proto__', value]]);
  const pivotRejectCases = [
    ['node direct', f => { f.json.nodes[0].extras.pivot = [1, 2, 3]; }],
    ['mesh direct', f => { f.json.meshes[0].extras.pivot = [1, 2, 3]; }],
    ['node prototype carrier', f => { f.json.nodes[0].extras = { ...f.json.nodes[0].extras, ...protoExtras({ pivot: [1, 2, 3] }) }; }],
    ['mesh prototype carrier', f => { f.json.meshes[0].extras = { ...f.json.meshes[0].extras, ...protoExtras({ pivot: [1, 2, 3] }) }; }],
    ['node prototype null pivot', f => { f.json.nodes[0].extras = { ...f.json.nodes[0].extras, ...protoExtras({ pivot: null }) }; }],
    ['mesh false pivot', f => { f.json.meshes[0].extras.pivot = false; }]
  ];
  const harmlessMetadataCases = [
    ['parent-child control', () => {}],
    ['ordinary nested pivot and URI metadata', f => { f.json.nodes[0].extras.nested = { pivot: [1, 2, 3], uri: 'metadata-only' }; f.json.meshes[0].extras.nested = { pivot: [4, 5, 6] }; }],
    ['node harmless prototype metadata', f => { f.json.nodes[0].extras = { ...f.json.nodes[0].extras, ...protoExtras({ description: 'metadata-only' }) }; }],
    ['mesh harmless prototype metadata', f => { f.json.meshes[0].extras = { ...f.json.meshes[0].extras, ...protoExtras({ description: 'metadata-only' }) }; }],
    ['nested proto data does not create a prototype chain', f => { f.json.nodes[0].extras = { ...f.json.nodes[0].extras, ...protoExtras(protoExtras({ pivot: [1, 2, 3] })) }; }],
    ['constructor prototype data does not expose pivot', f => { f.json.nodes[0].extras.constructor = { prototype: { pivot: [1, 2, 3] } }; }],
    ['scene and geometry pivot metadata is not node userData', f => { f.json.scenes[0].extras = { pivot: [1, 2, 3] }; f.json.meshes[0].primitives[0].extras = { pivot: [4, 5, 6] }; }]
  ];
  const globalPrototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
  let pivotRequests = 0;
  const pivotRequestChannel = channel('undici:request:create'), observePivotRequest = () => { pivotRequests++; };
  pivotRequestChannel.subscribe(observePivotRequest);
  try {
    for (const [name, change] of pivotRejectCases) await check('pivot source preallocation reject ' + name, async () => {
      const f = parentChildFixture(); change(f);
      const encoded = encodeGlb(f.json, f.binary), before = disposalSnapshot(), p = ports(encoded.input);
      await assert.rejects(parseStaticModel(encoded.buffer, expectedParentChild(encoded.input), p.options), error => error.code === 'composition-model-profile-unavailable' && /loader-pivot-unsupported/.test(error.message));
      newDisposals(before, 0, 0); assert.deepEqual(p.record.readyBytes, []); assert.deepEqual(p.record.attributes, []); assert.equal(p.record.releases, 0);
      assert.equal(pivotRequests, 0); assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), globalPrototypeBefore);
    });
    for (const [name, change] of harmlessMetadataCases) await check('harmless extras preserve parent-child TRS ' + name, async () => {
      const f = parentChildFixture(); change(f);
      const encoded = encodeGlb(f.json, f.binary), before = disposalSnapshot(), p = ports(encoded.input);
      const resource = await parseStaticModel(encoded.buffer, expectedParentChild(encoded.input), p.options), instance = resource.instantiate(), meshes = meshesOf(instance.root);
      assert.equal(meshes.length, 2); assert.deepEqual(meshes[0].position.toArray(), [4, -3, 2]); assert.deepEqual(meshes[1].position.toArray(), [0, 2, -1]);
      assert.deepEqual(meshes[1].getWorldPosition(new THREE.Vector3()).toArray(), [4, -1, 1]);
      assert.equal(meshes[0].pivot, null); assert.equal(meshes[1].pivot, null);
      assert.equal(meshes[0].userData.ownMarker, 'parent'); assert.equal(meshes[1].userData.ownMarker, 'child');
      assert.equal(meshes[0].userData.meshMarker.name, 'fixture'); assert.equal(meshes[1].userData.meshMarker.name, 'fixture');
      if (name === 'ordinary nested pivot and URI metadata') assert.equal(meshes[0].userData.nested.uri, 'metadata-only');
      if (name === 'constructor prototype data does not expose pivot') assert.deepEqual(meshes[0].userData.constructor.prototype.pivot, [1, 2, 3]);
      if (name === 'scene and geometry pivot metadata is not node userData') {
        assert.deepEqual(instance.root.userData.pivot, [1, 2, 3]); assert.deepEqual(meshes[0].geometry.userData.pivot, [4, 5, 6]);
      }
      assert.deepEqual(p.record.readyBytes, [80]); assert.equal(p.record.attributes.length, 3); assert.equal(pivotRequests, 0);
      assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), globalPrototypeBefore);
      instance.release(); resource.dispose(); newDisposals(before, 1, 2);
    });
  } finally { pivotRequestChannel.unsubscribe(observePivotRequest); }

  const rejectCases = [
    ['buffer URI https', f => { f.json.buffers[0].uri = 'https://example.invalid/model.bin'; }],
    ['buffer URI data', f => { f.json.buffers[0].uri = 'data:application/octet-stream;base64,AAAA'; }],
    ['image URI', f => { f.json.images = [{ uri: 'https://example.invalid/image.png' }]; }],
    ...['images', 'textures', 'materials', 'cameras', 'animations', 'skins', 'samplers'].map(key => [key, f => { f.json[key] = [{}]; }]),
    ...['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_materials_unlit', 'KHR_mesh_quantization', 'unknown_extension'].map(extension => ['extension ' + extension, f => { f.json.extensionsUsed = [extension]; }]),
    ['required extension', f => { f.json.extensionsRequired = ['KHR_draco_mesh_compression']; }],
    ['primitive extension', f => { f.json.meshes[0].primitives[0].extensions = {}; }],
    ['node extension', f => { f.json.nodes[0].extensions = { KHR_lights_punctual: { light: 0 } }; }],
    ['second scene', f => { f.json.scenes.push({ nodes: [0] }); }],
    ['missing scene', f => { delete f.json.scenes; }], ['empty scene', f => { f.json.scenes[0].nodes = []; }],
    ['selected scene 1', f => { f.json.scene = 1; }],
    ...['skin', 'weights', 'camera', 'isBone'].map(key => ['node ' + key, f => { f.json.nodes[0][key] = key === 'weights' ? [] : 0; }]),
    ['mesh weights', f => { f.json.meshes[0].weights = []; }], ['morph targets', f => { f.json.meshes[0].primitives[0].targets = []; }],
    ['explicit material', f => { f.json.meshes[0].primitives[0].material = 0; }],
    ...[0, 1, 2, 3, 5, 6].map(mode => ['mode ' + mode, f => { f.json.meshes[0].primitives[0].mode = mode; }]),
    ['missing NORMAL', f => { delete f.json.meshes[0].primitives[0].attributes.NORMAL; }],
    ['additional UV', f => { f.json.meshes[0].primitives[0].attributes.TEXCOORD_0 = 1; }],
    ['non FLOAT POSITION', f => { f.json.accessors[0].componentType = 5123; }],
    ['non VEC3 NORMAL', f => { f.json.accessors[1].type = 'VEC2'; }],
    ['normalized accessor', f => { f.json.accessors[0].normalized = true; }],
    ['signed indices', f => { f.json.accessors[2].componentType = 5122; }],
    ['FLOAT indices', f => { f.json.accessors[2].componentType = 5126; }],
    ['non SCALAR indices', f => { f.json.accessors[2].type = 'VEC3'; }],
    ['implicit zero accessor', f => { delete f.json.accessors[0].bufferView; }],
    ['sparse accessor', f => { f.json.accessors[0].sparse = {}; }],
    ['interleaved accessor', f => { f.json.bufferViews[0].byteStride = 24; }],
    ['packed range overrun', f => { f.json.accessors[0].byteOffset = 4; }],
    ['misaligned accessor', f => { f.json.accessors[0].byteOffset = 2; }],
    ['missing POSITION bounds', f => { delete f.json.accessors[0].min; }],
    ['mismatched NORMAL count', f => { f.json.accessors[1].count = 2; }],
    ['non triangle index count', f => { f.json.accessors[2].count = 2; }],
    ['second buffer', f => { f.json.buffers.push({ byteLength: 4 }); }],
    ['view other buffer', f => { f.json.bufferViews[0].buffer = 1; }],
    ['view range overrun', f => { f.json.bufferViews[0].byteLength = 1000; }],
    ['missing mesh reference', f => { f.json.nodes[0].mesh = 5; }],
    ['missing child reference', f => { f.json.nodes[0].children = [1]; }],
    ['cycle', f => { f.json.nodes.push({ children: [2] }, { children: [1] }); }],
    ['multiple parents', f => { f.json.nodes.push({ children: [0] }, { children: [0] }); f.json.scenes[0].nodes = [1, 2]; }],
    ['duplicate roots', f => { f.json.scenes[0].nodes = [0, 0]; }],
    ['duplicate child', f => { f.json.nodes.push({}); f.json.nodes[0].children = [1, 1]; }],
    ['root also child', f => { f.json.nodes.push({ children: [0] }); }],
    ['pivot loader special case', f => { f.json.nodes[0].extras = { pivot: [1, 2, 3] }; }],
    ['nodes 5001', f => { f.json.nodes = Array.from({ length: 5001 }, (_, i) => i ? {} : { mesh: 0 }); }],
    ['accessors 16385', f => { f.json.accessors = Array.from({ length: 16385 }, () => clone(f.json.accessors[0])); }],
    ['views 16385', f => { f.json.bufferViews = Array.from({ length: 16385 }, () => clone(f.json.bufferViews[0])); }],
    ['primitives 16385', f => { f.json.meshes[0].primitives = Array.from({ length: 16385 }, () => clone(f.json.meshes[0].primitives[0])); }]
  ];
  let requests = 0;
  const requestChannel = channel('undici:request:create'), observeRequest = () => { requests++; };
  requestChannel.subscribe(observeRequest);
  try {
    for (const [name, change] of rejectCases) await check('profile reject ' + name, async () => {
      const f = fixture(); change(f); const encoded = encodeGlb(f.json, f.binary), before = disposalSnapshot(), p = ports(encoded.input);
      await assert.rejects(parseStaticModel(encoded.buffer, expectedBase(encoded.input), p.options), error => error.code === 'composition-model-profile-unavailable');
      assert.deepEqual(p.record.readyBytes, []); assert.deepEqual(p.record.attributes, []); newDisposals(before, 0, 0);
      assert.equal(requests, 0, 'URI rejected before any loader request');
    });
  } finally { requestChannel.unsubscribe(observeRequest); }
  await check('declared and reachable triangle limits before allocations', async () => {
    for (const sceneLimit of [false, true]) {
      const f = fixture(), indexCount = sceneLimit ? 768 : 192;
      f.binary = new Uint8Array(72 + indexCount * 2); new Float32Array(f.binary.buffer, 0, 9).set(positions); new Float32Array(f.binary.buffer, 36, 9).set(normals);
      new Uint16Array(f.binary.buffer, 72, indexCount).set(Array.from({ length: indexCount }, (_, i) => i % 3));
      f.json.buffers[0].byteLength = f.binary.byteLength; f.json.bufferViews[2].byteLength = indexCount * 2; f.json.accessors[2].count = indexCount;
      if (sceneLimit) { f.json.nodes = Array.from({ length: 3907 }, () => ({ mesh: 0 })); f.json.scenes[0].nodes = f.json.nodes.map((_, i) => i); }
      else f.json.meshes[0].primitives = Array.from({ length: 15626 }, () => clone(f.json.meshes[0].primitives[0]));
      const encoded = encodeGlb(f.json, f.binary), before = disposalSnapshot();
      await assert.rejects(parseStaticModel(encoded.buffer, expectedBase(encoded.input), ports(encoded.input).options), /triangle-limit/); newDisposals(before, 0, 0);
    }
  });
  await check('JSON 4MiB and encoded 256MiB hard caps', async () => {
    const f = fixture(); f.json.extras = { padding: 'x'.repeat(4 * 1024 * 1024) }; const encoded = encodeGlb(f.json, f.binary), before = disposalSnapshot();
    await assert.rejects(parseStaticModel(encoded.buffer, expectedBase(encoded.input), ports(encoded.input).options), /JSON-size/);
    await assert.rejects(parseStaticModel(new ArrayBuffer(256 * 1024 * 1024 + 4), {}, ports(encoded.input).options), /input-size/); newDisposals(before, 0, 0);
  });
  await check('admission and exact expected facts reject before geometry allocation', async () => {
    const f = fixture(), encoded = encodeGlb(f.json, f.binary), facts = expectedBase(encoded.input), before = disposalSnapshot();
    await assert.rejects(parseStaticModel(encoded.buffer, facts), /admission-required/);
    const insufficient = ports(encoded.input); insufficient.cpuState.pending.ownedCpuBytes = 1;
    await assert.rejects(parseStaticModel(encoded.buffer, facts, insufficient.options), /construction-plan-required/);
    for (const mutate of [item => { item.resources.gpuBufferBytes--; }, item => { item.declared.nodes++; }, item => { item.loaderVersion = 'old'; }, item => { item.extra = true; }, item => { delete item.scene.nodes[0].transform; }]) {
      const expected = clone(facts), p = ports(encoded.input); mutate(expected);
      await assert.rejects(parseStaticModel(encoded.buffer, expected, p.options), error => error.code === 'composition-model-facts-mismatch'); assert.deepEqual(p.record.attributes, []);
    }
    assert.throws(() => compareStaticModelFacts([0, 1], [1, 0]), /facts-mismatch/);
    assert.throws(() => compareStaticModelFacts(new Array(2), new Array(3)), /facts-mismatch/); newDisposals(before, 0, 0);
  });
  await check('abort before parse and at beforeRoot allocates nothing', async () => {
    const f = fixture(), encoded = encodeGlb(f.json, f.binary), facts = expectedBase(encoded.input), before = disposalSnapshot(), controller = new AbortController();
    controller.abort(); await assert.rejects(parseStaticModel(encoded.buffer, facts, { ...ports(encoded.input).options, signal: controller.signal }), { name: 'AbortError' });
    const during = new AbortController(), p = ports(encoded.input); let checks = 0;
    p.options.admissions.cpu.state = () => { if (++checks === 2) during.abort(); return p.cpuState; };
    await assert.rejects(parseStaticModel(encoded.buffer, facts, { ...p.options, signal: during.signal }), { name: 'AbortError' });
    newDisposals(before, 0, 0); assert.equal(p.record.releases, 0);
  });
  await check('late cancelled loader waits for real admission gate then disposes once', async () => {
    const f = fixture(), encoded = encodeGlb(f.json, f.binary), facts = expectedBase(encoded.input), controller = new AbortController(), entered = deferred(), gate = deferred(), before = disposalSnapshot();
    const p = ports(encoded.input, { cpuReady() { entered.resolve(); return gate.promise; } }); let settled = false;
    const loading = parseStaticModel(encoded.buffer, facts, { ...p.options, signal: controller.signal }); loading.finally(() => { settled = true; }).catch(() => {});
    await entered.promise; controller.abort(); await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, false); assert.equal(p.record.releases, 0); assert.equal(p.record.settlements, 0); newDisposals(before, 0, 0);
    gate.resolve(); await assert.rejects(loading, { name: 'AbortError' }); newDisposals(before, 1, 2); assert.deepEqual(p.record.attributes, []);
  });
  await check('CPU admission failure after real allocation disposes cache and scene', async () => {
    const f = fixture({ aliased: true }), encoded = encodeGlb(f.json, f.binary), facts = expectedAliased(encoded.input), before = disposalSnapshot();
    const p = ports(encoded.input, { cpuReady() { throw new Error('test-admission-denied'); } });
    await assert.rejects(parseStaticModel(encoded.buffer, facts, p.options), /test-admission-denied/); newDisposals(before, 2, 2); assert.equal(p.record.releases, 0);
  });
  await check('upload admission failure disposes all real unique resources once', async () => {
    const f = fixture({ aliased: true }), encoded = encodeGlb(f.json, f.binary), facts = expectedAliased(encoded.input), before = disposalSnapshot();
    const p = ports(encoded.input, { upload() { throw new Error('test-upload-denied'); } });
    await assert.rejects(parseStaticModel(encoded.buffer, facts, p.options), /test-upload-denied/); newDisposals(before, 2, 2); assert.equal(p.record.attributes.length, 1); assert.equal(p.record.releases, 0);
  });
  await check('post-load actual mismatch cleans original geometry and hidden materials', async () => {
    const f = fixture(), encoded = encodeGlb(f.json, f.binary), before = disposalSnapshot();
    const p = ports(encoded.input, { upload(attribute) { attribute.itemSize = 7; return attribute; } });
    await assert.rejects(parseStaticModel(encoded.buffer, expectedBase(encoded.input), p.options), error => error.code === 'composition-model-facts-mismatch'); newDisposals(before, 1, 2);
  });
  await check('real partial GLTFLoader mesh assembly failure waits and cleans siblings', async () => {
    const f = fixture({ aliased: true }); f.json.meshes[0].name = 'good'; f.json.meshes[1].name = { invalid: 'upstream-proof-would-reject' };
    const encoded = encodeGlb(f.json, f.binary), before = disposalSnapshot(), p = ports(encoded.input);
    await assert.rejects(parseStaticModel(encoded.buffer, expectedAliased(encoded.input), p.options), /replace/);
    const cleanup = newDisposals(before, 2, 2);
    assert.ok(cleanup.geometries.every(geometry => geometry.attributes.position instanceof THREE.BufferAttribute && geometry.attributes.normal instanceof THREE.BufferAttribute));
    assert.equal(p.record.releases, 0); assert.deepEqual(p.record.readyBytes, []);
  });
  assert.ok([...disposedGeometries.values()].every(count => count === 1)); assert.ok([...disposedMaterials.values()].every(count => count === 1));
  console.log(`PASS ${passed} cases; requests=0; all real geometry/material disposal counts=1; consumption-only, native/model gate unchanged`);
} finally {
  THREE.BufferGeometry.prototype.dispose = geometryDispose; THREE.Material.prototype.dispose = materialDispose;
}
