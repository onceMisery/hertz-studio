// SPDX-License-Identifier: MIT
// Consumption only. The prepared package, pool, scope and renderer retain their
// existing ownership; this factory neither admits a source nor proves a frame.
import { FrontSide, LoadingManager, Matrix4, MeshStandardMaterial, Quaternion, REVISION, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const STATIC_MODEL_PROFILE = 'static-core-pbr-v1';
export const STATIC_MODEL_LOADER_VERSION = 'three-0.186.0-gltfloader';
export const STATIC_MODEL_MAX_DEPTH = 128;
const MAX_INPUT = 256 * 1024 * 1024, MAX_JSON = 4 * 1024 * 1024;
const MAX_ITEMS = 16384, MAX_NODES = 5000, MAX_TRIANGLES = 1000000;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const unavailable = reason => Object.assign(new Error('composition-model-profile-unavailable: ' + reason), { code: 'composition-model-profile-unavailable' });
const mismatch = path => Object.assign(new Error('composition-model-facts-mismatch: ' + path), { code: 'composition-model-facts-mismatch' });
function alive(signal) { if (signal?.aborted) throw new DOMException('Composition model cancelled', 'AbortError'); }
function integer(value, maximum = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function assert(condition, reason) { if (!condition) throw unavailable(reason); }
function array(value, reason) { assert(Array.isArray(value), reason); return value; }
function index(value, list, reason) { assert(integer(value) && value < list.length, reason); return list[value]; }
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// This inspects chunk lengths only. GLTFLoader remains the sole JSON decoder.
function inputFacts(buffer) {
  assert(buffer instanceof ArrayBuffer && buffer.byteLength >= 20 && buffer.byteLength <= MAX_INPUT, 'input-size');
  const header = new DataView(buffer);
  assert(header.getUint32(0, true) === 0x46546c67 && header.getUint32(4, true) === 2
    && header.getUint32(8, true) === buffer.byteLength, 'GLB-header');
  let offset = 12, jsonBytes = 0, binBytes = 0, chunks = 0;
  while (offset < buffer.byteLength) {
    assert(offset + 8 <= buffer.byteLength, 'GLB-chunk-header');
    const length = header.getUint32(offset, true), type = header.getUint32(offset + 4, true);
    assert(length % 4 === 0 && offset + 8 + length <= buffer.byteLength, 'GLB-chunk-range');
    if (type === 0x4e4f534a) {
      assert(chunks === 0 && !jsonBytes && length > 0 && length <= MAX_JSON, 'JSON-size-or-order'); jsonBytes = length;
    } else if (type === 0x004e4942) {
      assert(jsonBytes && !binBytes && length > 0, 'BIN-count-or-order'); binBytes = length;
    }
    offset += 8 + length; chunks++;
  }
  assert(jsonBytes > 0 && binBytes > 0, 'JSON-and-BIN-required');
  return { encodedBytes: buffer.byteLength, jsonBytes, binBytes };
}

function extrasExposeLoaderPivot(extras) {
  if (!extras || typeof extras !== 'object') return false;
  // GLTFLoader uses Object.assign(userData, extras), then reads visible .pivot.
  // A JSON own __proto__ key can change that local target's prototype, so an
  // own-field check misses this carrier. Match the assignment on a disposable
  // local object: JSON has no accessors/functions, and neither source metadata
  // nor Object.prototype is modified. Nested/prototype-shaped data which does
  // not expose .pivot remains ordinary metadata.
  return Object.assign({}, extras).pivot !== undefined;
}

function rejectDelegates(json) {
  for (const key of ['images', 'textures', 'materials', 'cameras', 'animations', 'skins', 'samplers']) {
    assert(json[key] === undefined || (Array.isArray(json[key]) && !json[key].length), key + '-unsupported');
  }
  // _markDefs runs before beforeRoot and would mark skinned meshes/bones.
  for (const node of json.nodes ?? []) {
    assert(node && !own(node, 'skin'), 'node-skin-unsupported');
    assert(!extrasExposeLoaderPivot(node.extras), 'loader-pivot-unsupported');
  }
  // A single-primitive mesh is the node itself; its userData is a second
  // metadata source even when the node has no extras. Reject visible pivot
  // sources consistently, including unused/leaf definitions, as this profile
  // already does for other unsupported declared content.
  for (const mesh of json.meshes ?? []) assert(!extrasExposeLoaderPivot(mesh?.extras), 'loader-pivot-unsupported');
  const stack = [json];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      // Author metadata is not a glTF dependency namespace.
      if (key === 'extras') continue;
      assert(key !== 'uri' && key !== 'extensions', key + '-unsupported');
      if (key === 'extensionsUsed' || key === 'extensionsRequired') assert(Array.isArray(child) && !child.length, 'extensions-unsupported');
      else if (child && typeof child === 'object') stack.push(child);
    }
  }
}

/** Exact structural equality: missing, additional and reordered layout facts fail. */
export function compareStaticModelFacts(expected, actual) {
  function compare(left, right, path) {
    if (left === right) return;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
      || Array.isArray(left) !== Array.isArray(right)) throw mismatch(path);
    if (Array.isArray(left) && left.length !== right.length) throw mismatch(path + '.length');
    const keys = Object.keys(left).sort(), other = Object.keys(right).sort();
    if (keys.length !== other.length || keys.some((key, i) => key !== other[i])) throw mismatch(path);
    for (const key of keys) compare(left[key], right[key], path + '.' + key);
  }
  compare(expected, actual, 'facts'); return true;
}

function profileFacts(json, input) {
  rejectDelegates(json);
  const scenes = array(json.scenes, 'scene-required'), nodes = array(json.nodes, 'nodes-required');
  const meshes = array(json.meshes, 'meshes-required'), accessors = array(json.accessors, 'accessors-required');
  const views = array(json.bufferViews, 'bufferViews-required'), buffers = array(json.buffers, 'buffers-required');
  assert(scenes.length === 1 && (json.scene === undefined || json.scene === 0), 'single-scene-required');
  const roots = array(scenes[0].nodes, 'nonempty-scene-required');
  assert(roots.length > 0 && nodes.length <= MAX_NODES && meshes.length <= MAX_ITEMS
    && accessors.length <= MAX_ITEMS && views.length <= MAX_ITEMS, 'item-limit');
  assert(buffers.length === 1 && integer(buffers[0].byteLength) && buffers[0].byteLength > 0
    && buffers[0].byteLength <= input.binBytes && input.binBytes - buffers[0].byteLength <= 3, 'single-BIN-buffer-required');
  for (const view of views) {
    assert(view && view.buffer === 0 && integer(view.byteOffset ?? 0) && integer(view.byteLength) && view.byteLength > 0
      && (view.byteOffset ?? 0) + view.byteLength <= buffers[0].byteLength, 'bufferView-range');
    assert(view.byteStride === undefined || (integer(view.byteStride) && view.byteStride > 0), 'bufferView-stride');
  }
  const layouts = accessors.map((accessor, accessorIndex) => {
    assert(accessor && !own(accessor, 'sparse') && own(accessor, 'bufferView') && accessor.normalized !== true, 'packed-accessor-required');
    const view = index(accessor.bufferView, views, 'accessor-bufferView');
    const vector = accessor.componentType === 5126 && accessor.type === 'VEC3';
    const scalar = [5121, 5123, 5125].includes(accessor.componentType) && accessor.type === 'SCALAR';
    assert(vector || scalar, 'accessor-type');
    const elementBytes = vector || accessor.componentType === 5125 ? 4 : accessor.componentType === 5123 ? 2 : 1;
    const itemBytes = vector ? 12 : elementBytes, byteOffset = accessor.byteOffset ?? 0;
    assert(integer(accessor.count) && accessor.count > 0 && integer(byteOffset) && byteOffset % elementBytes === 0
      && (view.byteOffset ?? 0) % elementBytes === 0 && byteOffset + accessor.count * itemBytes <= view.byteLength, 'packed-accessor-range');
    assert(view.byteStride === undefined || view.byteStride === itemBytes, 'interleaved-unsupported');
    return { index: accessorIndex, viewIndex: accessor.bufferView, componentType: accessor.componentType,
      type: accessor.type, count: accessor.count, byteOffset, byteLength: accessor.count * itemBytes };
  });
  let primitiveCount = 0, declaredTriangles = 0;
  const primitives = meshes.map((mesh, meshIndex) => {
    assert(mesh && !own(mesh, 'weights'), 'mesh-weights-unsupported');
    const list = array(mesh.primitives, 'primitives-required'); assert(list.length > 0, 'primitives-required');
    primitiveCount += list.length; assert(primitiveCount <= MAX_ITEMS, 'primitive-limit');
    return list.map((primitive, primitiveIndex) => {
      assert(primitive && !own(primitive, 'targets') && !own(primitive, 'material')
        && (primitive.mode === undefined || primitive.mode === 4), 'triangle-default-material-required');
      const attributes = primitive.attributes;
      assert(attributes && Object.keys(attributes).sort().join(',') === 'NORMAL,POSITION', 'POSITION-NORMAL-only');
      const position = index(attributes.POSITION, layouts, 'POSITION-accessor'), normal = index(attributes.NORMAL, layouts, 'NORMAL-accessor');
      assert(position.type === 'VEC3' && normal.type === 'VEC3' && position.count === normal.count, 'FLOAT-POSITION-NORMAL-required');
      const positionDef = accessors[position.index];
      assert(Array.isArray(positionDef.min) && positionDef.min.length === 3 && positionDef.min.every(Number.isFinite)
        && Array.isArray(positionDef.max) && positionDef.max.length === 3 && positionDef.max.every(Number.isFinite), 'POSITION-declared-bounds-required');
      const indices = primitive.indices === undefined ? null : index(primitive.indices, layouts, 'indices-accessor');
      assert(indices === null || indices.type === 'SCALAR', 'unsigned-indices-required');
      const count = indices?.count ?? position.count; assert(count % 3 === 0, 'triangle-count');
      declaredTriangles += count / 3; assert(declaredTriangles <= MAX_TRIANGLES, 'triangle-limit');
      const mode = primitive.mode ?? null, indexAccessor = indices?.index ?? null;
      // GLTFLoader's primitive cache distinguishes omitted mode from explicit 4.
      const key = `${indexAccessor ?? 'undefined'}:NORMAL:${normal.index};POSITION:${position.index};:${mode ?? 'undefined'}`;
      return { meshIndex, primitiveIndex, key, positionAccessor: position.index, normalAccessor: normal.index,
        indexAccessor, mode, triangles: count / 3, positionMin: [...positionDef.min], positionMax: [...positionDef.max] };
    });
  });
  const parents = new Array(nodes.length).fill(null), meshReferences = new Map();
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const node = nodes[nodeIndex];
    assert(node && !own(node, 'skin') && !own(node, 'weights') && !own(node, 'camera')
      && !own(node, 'isBone') && !own(node, 'isSkinnedMesh'), 'static-node-required');
    if (node.mesh !== undefined) { index(node.mesh, meshes, 'node-mesh'); meshReferences.set(node.mesh, (meshReferences.get(node.mesh) ?? 0) + 1); }
    const children = node.children ?? []; array(children, 'node-children');
    for (const child of children) {
      index(child, nodes, 'node-child'); assert(parents[child] === null, 'node-multiple-parent'); parents[child] = nodeIndex;
    }
  }
  const rootSet = new Set();
  for (const root of roots) { index(root, nodes, 'scene-node'); assert(!rootSet.has(root) && parents[root] === null, 'scene-multiple-parent'); rootSet.add(root); }
  // Check every declared node, including disconnected cycles, without recursion.
  const colors = new Uint8Array(nodes.length);
  for (let start = 0; start < nodes.length; start++) {
    const stack = [[start, false]];
    while (stack.length) {
      const [current, exit] = stack.pop();
      if (exit) { colors[current] = 2; continue; }
      assert(colors[current] !== 1, 'node-cycle'); if (colors[current] === 2) continue;
      colors[current] = 1; stack.push([current, true]);
      for (const child of nodes[current].children ?? []) stack.push([child, false]);
    }
  }
  const reachable = new Set(), stack = roots.map(node => [node, 1]); let maxDepth = 0;
  while (stack.length) {
    const [current, depth] = stack.pop(); assert(depth <= STATIC_MODEL_MAX_DEPTH, 'scene-depth-limit');
    reachable.add(current); maxDepth = Math.max(maxDepth, depth);
    for (const child of nodes[current].children ?? []) stack.push([child, depth + 1]);
  }
  const usedAccessors = new Set(), usedMeshes = new Set(), geometries = new Map(); let drawCalls = 0, triangles = 0, objectCount = 1;
  const sceneNodes = [...reachable].sort((a, b) => a - b).map(nodeIndex => {
    const node = nodes[nodeIndex], meshPrimitives = node.mesh === undefined ? [] : primitives[node.mesh];
    if (node.mesh !== undefined) usedMeshes.add(node.mesh);
    objectCount += 1 + (meshPrimitives.length > 1 ? meshPrimitives.length : 0);
    for (const primitive of meshPrimitives) {
      drawCalls++; triangles += primitive.triangles;
      usedAccessors.add(primitive.positionAccessor); usedAccessors.add(primitive.normalAccessor);
      if (primitive.indexAccessor !== null) usedAccessors.add(primitive.indexAccessor);
      if (!geometries.has(primitive.key)) {
        const { meshIndex: _mesh, primitiveIndex: _primitive, ...geometry } = primitive; geometries.set(primitive.key, geometry);
      }
    }
    const translation = node.translation ?? [0, 0, 0], rotation = node.rotation ?? [0, 0, 0, 1], scale = node.scale ?? [1, 1, 1];
    for (const [value, length] of [[translation, 3], [rotation, 4], [scale, 3]]) assert(Array.isArray(value) && value.length === length && value.every(Number.isFinite), 'node-TRS');
    let transform;
    if (node.matrix !== undefined) {
      assert(Array.isArray(node.matrix) && node.matrix.length === 16 && node.matrix.every(Number.isFinite), 'node-matrix');
      transform = { kind: 'matrix', matrix: [...node.matrix] };
    } else transform = { kind: 'trs', translation: [...translation], rotation: [...rotation], scale: [...scale] };
    return { index: nodeIndex, parentIndex: parents[nodeIndex], meshIndex: node.mesh ?? null,
      children: [...(node.children ?? [])], transform };
  });
  assert(drawCalls > 0 && triangles <= MAX_TRIANGLES, 'visible-triangle-limit');
  // _markDefs counts all declared mesh references. _getNodeRef retains a
  // hidden source Object3D tree whenever it clones the reachable node meshes.
  let allocatedObjectCount = objectCount;
  for (const mesh of usedMeshes) if (meshReferences.get(mesh) > 1) allocatedObjectCount += primitives[mesh].length + (primitives[mesh].length > 1 ? 1 : 0);
  const usedLayouts = [...usedAccessors].sort((a, b) => a - b).map(i => layouts[i]);
  const usedViews = [...new Set(usedLayouts.map(layout => layout.viewIndex))].sort((a, b) => a - b)
    .map(i => ({ index: i, byteOffset: views[i].byteOffset ?? 0, byteLength: views[i].byteLength }));
  return {
    profile: STATIC_MODEL_PROFILE, loaderVersion: STATIC_MODEL_LOADER_VERSION, input,
    declared: { nodes: nodes.length, meshes: meshes.length, primitives: primitiveCount, accessors: accessors.length, bufferViews: views.length },
    scene: { index: 0, roots: [...roots], nodes: sceneNodes, maxDepth, objectCount, allocatedObjectCount, drawCalls, triangles },
    resources: { geometries: [...geometries.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0), accessors: usedLayouts, bufferViews: usedViews,
      geometryCount: geometries.size, attributeCount: usedLayouts.length, backingCount: usedViews.length,
      gpuBufferBytes: usedLayouts.reduce((sum, layout) => sum + layout.byteLength, 0),
      cpuBackingBytes: usedViews.reduce((sum, view) => sum + view.byteLength, 0), allocatedMaterialCount: 2, retainedMaterialCount: 1 }
  };
}

function allocationTracker(parser) {
  const promises = new Set(), geometries = new Set(), materials = new Set(), textures = new Set(), objects = new Set();
  function capture(value) {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(capture); return; }
    if (value.isBufferGeometry) geometries.add(value);
    else if (value.isMaterial) { materials.add(value); Object.values(value).filter(item => item?.isTexture).forEach(item => textures.add(item)); }
    else if (value.isTexture) textures.add(value);
    else if (value.isObject3D) value.traverse(object => { objects.add(object); capture(object.geometry); capture(object.material); });
  }
  function track(promise) {
    const watched = Promise.resolve(promise).then(value => { capture(value); return value; });
    promises.add(watched); watched.catch(() => {}); return watched;
  }
  for (const name of ['getDependency', 'loadGeometries', 'loadMesh']) {
    const original = parser[name];
    parser[name] = function (...args) {
      try { return track(original.apply(this, args)); }
      finally { capture(parser.cache.DefaultMaterial); }
    };
  }
  // Observe the loader's own final material clone, including a mesh which later
  // fails while its node is being assembled. No geometry/material is mocked.
  const assign = parser.assignFinalMaterial;
  parser.assignFinalMaterial = function (mesh) { try { return assign.call(this, mesh); } finally { capture(mesh); } };
  return {
    geometries, materials, textures, objects, capture,
    async settle() {
      let count = -1;
      while (count !== promises.size) { count = promises.size; await Promise.allSettled([...promises]); }
      capture(parser.cache.DefaultMaterial);
    }
  };
}

function defaultPbr(material) {
  return material instanceof MeshStandardMaterial && !material.isMeshPhysicalMaterial && !material.flatShading && !material.vertexColors
    && material.color.getHex() === 0xffffff && material.emissive.getHex() === 0 && material.metalness === 1 && material.roughness === 1
    && material.opacity === 1 && material.transparent === false && material.depthTest === true && material.depthWrite === true
    && material.side === FrontSide && material.alphaTest === 0 && !Object.values(material).some(value => value?.isTexture);
}

async function verifyActual(result, parser, facts, tracker) {
  if (result.scenes.length !== 1 || result.scene !== result.scenes[0] || result.animations.length || result.cameras.length) throw mismatch('result');
  const objects = [], meshes = [], nodeObjects = new Map(), retainedMaterials = new Set(), geometryObjects = new Map(); let actualTriangles = 0;
  result.scene.traverse(object => {
    objects.push(object);
    if (object.isCamera || object.isLight || object.isBone || object.isSkinnedMesh || object.isInstancedMesh || object.isLine || object.isPoints) throw mismatch('object-type');
    const association = parser.associations.get(object);
    if (association?.nodes !== undefined) {
      if (nodeObjects.has(association.nodes)) throw mismatch('duplicate-node'); nodeObjects.set(association.nodes, object);
    }
    if (object.isMesh) {
      meshes.push(object); retainedMaterials.add(object.material);
      const primitive = parser.json.meshes[association?.meshes]?.primitives[association?.primitives];
      if (!primitive) throw mismatch('mesh-association');
      const key = `${primitive.indices ?? 'undefined'}:NORMAL:${primitive.attributes.NORMAL};POSITION:${primitive.attributes.POSITION};:${primitive.mode ?? 'undefined'}`;
      if (geometryObjects.has(key) && geometryObjects.get(key) !== object.geometry) throw mismatch('geometry-identity'); geometryObjects.set(key, object.geometry);
      if (Object.keys(object.geometry.attributes).sort().join(',') !== 'normal,position' || Object.keys(object.geometry.morphAttributes).length
        || object.geometry.groups.length || object.geometry.drawRange.start !== 0 || object.geometry.drawRange.count !== Infinity
        || !defaultPbr(object.material)) throw mismatch('geometry-or-PBR');
      actualTriangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
    } else if (object.geometry || object.material) throw mismatch('unexpected-resource');
  });
  if (objects.length !== facts.scene.objectCount || meshes.length !== facts.scene.drawCalls || actualTriangles !== facts.scene.triangles || nodeObjects.size !== facts.scene.nodes.length
    || tracker.geometries.size !== facts.resources.geometryCount || geometryObjects.size !== facts.resources.geometryCount
    || tracker.objects.size !== facts.scene.allocatedObjectCount || tracker.materials.size !== facts.resources.allocatedMaterialCount
    || retainedMaterials.size !== facts.resources.retainedMaterialCount || tracker.textures.size) throw mismatch('resource-count');
  for (const material of tracker.materials) if (!defaultPbr(material)) throw mismatch('allocated-PBR');
  for (const node of facts.scene.nodes) {
    const object = nodeObjects.get(node.index);
    if (!object) throw mismatch('node-object');
    if ((parser.associations.get(object)?.meshes ?? null) !== node.meshIndex) throw mismatch('node-mesh');
    const transform = node.transform;
    let expectedMatrix;
    if (transform.kind === 'matrix') {
      if (object.matrixAutoUpdate || object.matrix.elements.some((value, i) => value !== transform.matrix[i])) throw mismatch('authored-matrix');
      expectedMatrix = transform.matrix;
    } else {
      compareStaticModelFacts(transform.translation, object.position.toArray());
      compareStaticModelFacts(transform.rotation, object.quaternion.toArray());
      compareStaticModelFacts(transform.scale, object.scale.toArray());
      expectedMatrix = new Matrix4().compose(new Vector3().fromArray(transform.translation), new Quaternion().fromArray(transform.rotation), new Vector3().fromArray(transform.scale)).elements;
    }
    if (object.matrix.elements.some((value, i) => Math.abs(value - expectedMatrix[i]) > 1e-12 * Math.max(1, Math.abs(expectedMatrix[i])))) throw mismatch('node-matrix');
    const parent = object.parent === result.scene ? null : parser.associations.get(object.parent)?.nodes;
    if (parent !== node.parentIndex) throw mismatch('node-parent');
    const children = object.children.map(child => parser.associations.get(child)?.nodes).filter(value => value !== undefined);
    compareStaticModelFacts(node.children, children);
  }
  compareStaticModelFacts(facts.scene.roots, result.scene.children.map(object => parser.associations.get(object)?.nodes));
  const attributes = new Map(), attributeIdentities = new Set(), backings = new Map(), backingIdentities = new Set();
  for (const layout of facts.resources.accessors) {
    const attribute = await parser.getDependency('accessor', layout.index);
    const ArrayType = layout.componentType === 5126 ? Float32Array : layout.componentType === 5121 ? Uint8Array : layout.componentType === 5123 ? Uint16Array : Uint32Array;
    if (!attribute.isBufferAttribute || attribute.isInterleavedBufferAttribute || !(attribute.array instanceof ArrayType)
      || attribute.itemSize !== (layout.type === 'VEC3' ? 3 : 1) || attribute.count !== layout.count || attribute.normalized
      || attribute.array.byteOffset !== layout.byteOffset || attribute.array.byteLength !== layout.byteLength || attributeIdentities.has(attribute)) throw mismatch('accessor-layout-or-identity');
    attributeIdentities.add(attribute); attributes.set(layout.index, attribute);
    const backing = attribute.array.buffer;
    if (backings.has(layout.viewIndex) && backings.get(layout.viewIndex) !== backing) throw mismatch('backing-alias');
    backings.set(layout.viewIndex, backing); backingIdentities.add(backing);
  }
  for (const view of facts.resources.bufferViews) if (backings.get(view.index)?.byteLength !== view.byteLength) throw mismatch('backing-size');
  for (const geometry of facts.resources.geometries) {
    const actual = geometryObjects.get(geometry.key);
    if (!actual || actual.attributes.position !== attributes.get(geometry.positionAccessor) || actual.attributes.normal !== attributes.get(geometry.normalAccessor)
      || actual.index !== (geometry.indexAccessor === null ? null : attributes.get(geometry.indexAccessor))) throw mismatch('primitive-accessors');
    compareStaticModelFacts(geometry.positionMin, actual.boundingBox?.min.toArray()); compareStaticModelFacts(geometry.positionMax, actual.boundingBox?.max.toArray());
  }
  if (attributeIdentities.size !== facts.resources.attributeCount || backingIdentities.size !== facts.resources.backingCount
    || [...attributeIdentities].reduce((sum, attribute) => sum + attribute.array.byteLength, 0) !== facts.resources.gpuBufferBytes
    || [...backingIdentities].reduce((sum, backing) => sum + backing.byteLength, 0) !== facts.resources.cpuBackingBytes) throw mismatch('actual-bytes');
  return attributeIdentities;
}

function disposeResources(tracker) {
  const errors = [];
  for (const resources of [tracker.geometries, tracker.materials, tracker.textures]) {
    for (const resource of resources) { try { resource.dispose(); } catch (error) { errors.push(error); } }
    resources.clear();
  }
  if (errors.length) throw new AggregateError(errors, 'composition-model-cleanup-failed');
}

function createModelResource(template, facts, tracker) {
  const instances = new Set(); let retired = false;
  for (const resource of [...tracker.geometries, ...tracker.materials]) Object.defineProperty(resource, 'poolOwned', { value: true });
  function finish() { if (retired && !instances.size && template) { template.clear(); template = null; disposeResources(tracker); } }
  return Object.freeze({
    facts,
    instantiate() {
      if (retired) throw new Error('composition-model-resource-disposed');
      const root = template.clone(true); let released = false;
      const instance = Object.freeze({ root, detach() { root.removeFromParent(); }, release() {
        if (released) return; released = true; root.removeFromParent(); root.clear(); instances.delete(instance); finish();
      } });
      instances.add(instance); return instance;
    },
    dispose() { retired = true; finish(); }
  });
}

/**
 * Caller must already hold the original CPU construction ticket and a scope
 * bufferPlan (CPU backing + per-context upload). admissions.cpu is distinct
 * from backing CPU: encoded/BIN/JSON/parser construction only. Its settlement
 * and release stay with the caller, even on cancellation. bufferPlan.upload
 * merely attaches the scope's real onUpload admission; no upload occurs here.
 */
export async function parseStaticModel(buffer, expectedFacts, { signal, admissions, bufferPlan } = {}) {
  alive(signal);
  assert(REVISION === '186', 'loader-version');
  if (!admissions?.cpu || typeof admissions.cpu.state !== 'function' || !bufferPlan
    || typeof bufferPlan.cpuReady !== 'function' || typeof bufferPlan.upload !== 'function') throw new Error('composition-model-admission-required');
  const input = inputFacts(buffer);
  function checkAdmission() {
    const state = admissions.cpu.state();
    // Byte-copy lower bound only; the native preparation owner additionally
    // budgets JSON/parser objects and fixed Three object construction overhead.
    if (!state || state.released || state.cancelled || state.allocationEnded
      || !integer(state.pending?.ownedCpuBytes) || state.pending.ownedCpuBytes < input.encodedBytes + input.binBytes + input.jsonBytes * 2) throw new Error('composition-model-CPU-construction-plan-required');
  }
  checkAdmission();
  const manager = new LoadingManager(); manager.setURLModifier(() => { throw unavailable('URI-unsupported'); });
  const loader = new GLTFLoader(manager); let parser, tracker, completed, facts;
  loader.register(candidate => {
    parser = candidate;
    // Runs before GLTFLoader initializes extension delegates (e.g. Draco).
    rejectDelegates(parser.json);
    tracker = allocationTracker(parser);
    return { name: 'HERTZ_static_model_profile',
      beforeRoot() { alive(signal); checkAdmission(); alive(signal); facts = profileFacts(parser.json, input); compareStaticModelFacts(expectedFacts, facts); freeze(facts); },
      async afterRoot(result) {
        completed = result; tracker.capture(result.scenes); alive(signal);
        // GLTFLoader decomposes authored matrices. Preserve their exact local
        // matrix, including negative scale, instead of recomposing it later.
        const sceneNodes = new Map(facts.scene.nodes.map(node => [node.index, node]));
        result.scene.traverse(object => {
          const nodeIndex = parser.associations.get(object)?.nodes;
          const node = sceneNodes.get(nodeIndex);
          if (node?.transform.kind === 'matrix') { object.matrix.fromArray(node.transform.matrix); object.matrixAutoUpdate = false; }
        });
        result.scene.updateMatrixWorld(true);
        const attributes = await verifyActual(result, parser, facts, tracker); alive(signal);
        await bufferPlan.cpuReady(facts.resources.cpuBackingBytes); alive(signal);
        for (const attribute of attributes) { await bufferPlan.upload(attribute); alive(signal); }
        await verifyActual(result, parser, facts, tracker); alive(signal);
      }
    };
  });
  try {
    const result = await loader.parseAsync(buffer, '');
    await tracker.settle(); alive(signal);
    const retainedMaterials = new Set(); result.scene.traverse(object => { if (object.material) retainedMaterials.add(object.material); });
    for (const material of [...tracker.materials]) if (!retainedMaterials.has(material)) { tracker.materials.delete(material); material.dispose(); }
    // Never retain tracker closures: they close over the parser, JSON, BIN,
    // caches and completed dependency promises. The factory owns only these
    // shared resources and its private scene template after consumption.
    return createModelResource(result.scene, facts, { geometries: tracker.geometries, materials: tracker.materials, textures: tracker.textures });
  } catch (error) {
    if (tracker) { await tracker.settle(); completed?.scenes.forEach(scene => scene.clear()); disposeResources(tracker); }
    throw error;
  }
}
