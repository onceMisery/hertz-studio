// SPDX-License-Identifier: MIT
// Consumption only. The prepared package, pool, scope and renderer retain their
// existing ownership; this factory neither admits a source nor proves a frame.
import {
  ClampToEdgeWrapping, DoubleSide, FrontSide, LinearFilter, LinearMipmapLinearFilter,
  LinearMipmapNearestFilter, LoadingManager, Matrix4, MeshStandardMaterial,
  MirroredRepeatWrapping, NearestFilter, NearestMipmapLinearFilter, NearestMipmapNearestFilter,
  NoColorSpace, Quaternion, RepeatWrapping, REVISION, SRGBColorSpace, Vector3
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const STATIC_MODEL_PROFILE = 'static-core-pbr-v1';
export const STATIC_MODEL_LOADER_VERSION = 'three-0.186.0-gltfloader';
export const STATIC_MODEL_MAX_DEPTH = 128;
export const STATIC_TEXTURED_PROFILE = 'static-pbr-texture-v1';
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

// Textured PBR profile. It deliberately supports only the core metallic-
// roughness slots consumed by this slice; all other material extensions and
// texture roles stay closed until separately qualified.
const TEXTURED_DEFAULT_SAMPLER = { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 };
const TEXTURED_MAG_FILTERS = { 9728: NearestFilter, 9729: LinearFilter };
const TEXTURED_MIN_FILTERS = {
  9728: NearestFilter, 9729: LinearFilter, 9984: NearestMipmapNearestFilter,
  9985: LinearMipmapNearestFilter, 9986: NearestMipmapLinearFilter, 9987: LinearMipmapLinearFilter
};
const TEXTURED_WRAPS = {
  33071: ClampToEdgeWrapping, 33648: MirroredRepeatWrapping, 10497: RepeatWrapping
};

/** Chunk facts for callers which must supply their own independent oracle. */
export function inspectModelInputFacts(buffer) {
  return inputFacts(buffer);
}

function rejectTexturedDelegates(json) {
  for (const key of ['animations', 'skins', 'cameras']) {
    assert(json[key] === undefined || (Array.isArray(json[key]) && !json[key].length), key + '-unsupported');
  }
  for (const buffer of json.buffers ?? []) assert(buffer && !own(buffer, 'uri'), 'buffer-uri-unsupported');
  for (const node of json.nodes ?? []) {
    assert(node && !own(node, 'skin') && !own(node, 'weights') && !own(node, 'camera')
      && !own(node, 'isBone') && !own(node, 'isSkinnedMesh'), 'static-node-required');
    assert(!extrasExposeLoaderPivot(node.extras), 'loader-pivot-unsupported');
  }
  for (const mesh of json.meshes ?? []) {
    assert(mesh && !own(mesh, 'weights'), 'mesh-weights-unsupported');
    assert(!extrasExposeLoaderPivot(mesh.extras), 'loader-pivot-unsupported');
    for (const primitive of mesh.primitives ?? []) {
      assert(primitive && !own(primitive, 'targets'), 'morph-targets-unsupported');
      assert(primitive.mode === undefined || primitive.mode === 4, 'triangle-mode-required');
      for (const key of Object.keys(primitive.attributes ?? {})) {
        assert(['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1'].includes(key), 'attribute-unsupported');
      }
    }
  }
  const stack = [json];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'extras') continue;
      assert(key !== 'extensions' && key !== 'sparse', key + '-unsupported');
      if (key === 'extensionsUsed' || key === 'extensionsRequired') assert(Array.isArray(child) && !child.length, 'extensions-unsupported');
      else if (child && typeof child === 'object') stack.push(child);
    }
  }
}

function texturedImageFacts(json, views) {
  const images = array(json.images ?? [], 'images-required');
  assert(images.length <= MAX_ITEMS, 'item-limit');
  return images.map((image, imageIndex) => {
    assert(image && typeof image === 'object', 'image-required');
    assert(image.mimeType === 'image/png' || image.mimeType === 'image/jpeg', 'image-mime');
    if (own(image, 'bufferView')) {
      assert(!own(image, 'uri'), 'image-source-ambiguous');
      const view = index(image.bufferView, views, 'image-bufferView');
      assert(view.byteLength > 0, 'image-range');
      return { index: imageIndex, source: 'embedded', mime: image.mimeType, bytes: view.byteLength };
    }
    assert(typeof image.uri === 'string' && image.uri.length > 0 && image.uri.length <= 1024, 'image-uri');
    assert(!image.uri.startsWith('data:'), 'data-uri-unsupported');
    return { index: imageIndex, source: 'external', mime: image.mimeType, uri: image.uri };
  });
}

function texturedSamplerFacts(json) {
  const samplers = array(json.samplers ?? [], 'samplers-required');
  assert(samplers.length <= MAX_ITEMS, 'item-limit');
  return samplers.map((sampler, samplerIndex) => {
    assert(sampler && typeof sampler === 'object', 'sampler-required');
    const mag = sampler.magFilter ?? TEXTURED_DEFAULT_SAMPLER.magFilter;
    const min = sampler.minFilter ?? TEXTURED_DEFAULT_SAMPLER.minFilter;
    const wrapS = sampler.wrapS ?? TEXTURED_DEFAULT_SAMPLER.wrapS;
    const wrapT = sampler.wrapT ?? TEXTURED_DEFAULT_SAMPLER.wrapT;
    assert(own(TEXTURED_MAG_FILTERS, mag), 'sampler-magFilter');
    assert(own(TEXTURED_MIN_FILTERS, min), 'sampler-minFilter');
    assert(own(TEXTURED_WRAPS, wrapS) && own(TEXTURED_WRAPS, wrapT), 'sampler-wrap');
    return { index: samplerIndex, magFilter: mag, minFilter: min, wrapS, wrapT };
  });
}

function texturedTextureFacts(json, images, samplers) {
  const textures = array(json.textures ?? [], 'textures-required');
  assert(textures.length <= MAX_ITEMS, 'item-limit');
  return textures.map((texture, textureIndex) => {
    assert(texture && own(texture, 'source'), 'texture-source-required');
    const source = index(texture.source, images, 'texture-source');
    const sampler = texture.sampler === undefined
      ? { ...TEXTURED_DEFAULT_SAMPLER }
      : (() => { const { index: _index, ...value } = index(texture.sampler, samplers, 'texture-sampler'); return value; })();
    return { index: textureIndex, source, sampler };
  });
}

function texturedMaterialFacts(json, textures) {
  const materials = array(json.materials ?? [], 'materials-required');
  assert(materials.length <= MAX_ITEMS, 'item-limit');
  const slot = (info, role) => {
    if (info === undefined) return null;
    assert(info && typeof info === 'object', 'texture-info-required');
    for (const key of Object.keys(info)) assert(['index', 'texCoord'].includes(key), 'texture-info-field-unsupported');
    const texture = index(info.index, textures, role);
    const texCoord = info.texCoord ?? 0;
    assert(integer(texCoord) && texCoord <= 1, 'texCoord-unsupported');
    return { index: texture.index, texCoord };
  };
  return materials.map((material, materialIndex) => {
    assert(material && typeof material === 'object', 'material-required');
    for (const key of Object.keys(material)) {
      assert(['name', 'extras', 'pbrMetallicRoughness', 'normalTexture', 'occlusionTexture',
        'emissiveTexture', 'emissiveFactor', 'alphaMode', 'alphaCutoff', 'doubleSided'].includes(key), 'material-field-unsupported');
    }
    const pbr = material.pbrMetallicRoughness ?? {};
    assert(pbr && typeof pbr === 'object', 'pbr-required');
    for (const key of Object.keys(pbr)) {
      assert(['baseColorFactor', 'baseColorTexture', 'metallicFactor', 'roughnessFactor', 'metallicRoughnessTexture'].includes(key), 'pbr-field-unsupported');
    }
    const baseColorFactor = pbr.baseColorFactor ?? [1, 1, 1, 1];
    assert(Array.isArray(baseColorFactor) && baseColorFactor.length === 4
      && baseColorFactor.every(value => Number.isFinite(value) && value >= 0 && value <= 1), 'baseColorFactor');
    const metallicFactor = pbr.metallicFactor ?? 1, roughnessFactor = pbr.roughnessFactor ?? 1;
    assert(Number.isFinite(metallicFactor) && metallicFactor >= 0 && metallicFactor <= 1, 'metallicFactor');
    assert(Number.isFinite(roughnessFactor) && roughnessFactor >= 0 && roughnessFactor <= 1, 'roughnessFactor');
    const baseColorTexture = slot(pbr.baseColorTexture, 'baseColorTexture');
    const metallicRoughnessTexture = slot(pbr.metallicRoughnessTexture, 'metallicRoughnessTexture');
    const normalTexture = (info => {
      if (info === undefined) return null;
      assert(info && typeof info === 'object', 'normal-texture-required');
      for (const key of Object.keys(info)) assert(['index', 'texCoord', 'scale'].includes(key), 'normal-texture-field-unsupported');
      const texture = index(info.index, textures, 'normalTexture');
      const texCoord = info.texCoord ?? 0;
      assert(integer(texCoord) && texCoord <= 1, 'texCoord-unsupported');
      const scale = info.scale ?? 1;
      assert(Number.isFinite(scale), 'normal-scale');
      return { index: texture.index, texCoord, scale };
    })(material.normalTexture);
    const occlusionTexture = (info => {
      if (info === undefined) return null;
      assert(info && typeof info === 'object', 'occlusion-texture-required');
      for (const key of Object.keys(info)) assert(['index', 'texCoord', 'strength'].includes(key), 'occlusion-texture-field-unsupported');
      const texture = index(info.index, textures, 'occlusionTexture');
      const texCoord = info.texCoord ?? 0;
      assert(integer(texCoord) && texCoord <= 1, 'texCoord-unsupported');
      const strength = info.strength ?? 1;
      assert(Number.isFinite(strength) && strength >= 0 && strength <= 1, 'occlusion-strength');
      return { index: texture.index, texCoord, strength };
    })(material.occlusionTexture);
    const emissiveTexture = slot(material.emissiveTexture, 'emissiveTexture');
    const emissiveFactor = material.emissiveFactor ?? [0, 0, 0];
    assert(Array.isArray(emissiveFactor) && emissiveFactor.length === 3
      && emissiveFactor.every(value => Number.isFinite(value) && value >= 0 && value <= 1), 'emissiveFactor');
    // GLTFLoader caches one texture per source+sampler; a shared index across
    // sRGB and linear roles would leak one colorSpace/channel into the other.
    const used = [baseColorTexture, metallicRoughnessTexture, normalTexture, occlusionTexture, emissiveTexture]
      .filter(Boolean).map(info => info.index);
    assert(new Set(used).size === used.length, 'texture-slot-sharing');
    const alphaMode = material.alphaMode ?? 'OPAQUE';
    assert(['OPAQUE', 'MASK', 'BLEND'].includes(alphaMode), 'alphaMode');
    const alphaCutoff = material.alphaCutoff ?? 0.5;
    assert(Number.isFinite(alphaCutoff) && alphaCutoff >= 0, 'alphaCutoff');
    return {
      index: materialIndex, baseColorFactor: [...baseColorFactor], metallicFactor, roughnessFactor,
      baseColorTexture, metallicRoughnessTexture, normalTexture, occlusionTexture,
      emissiveTexture, emissiveFactor: [...emissiveFactor], alphaMode, alphaCutoff,
      doubleSided: material.doubleSided === true
    };
  });
}

function texturedProfileFacts(json, input) {
  rejectTexturedDelegates(json);
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
  const images = texturedImageFacts(json, views);
  const samplers = texturedSamplerFacts(json);
  const textures = texturedTextureFacts(json, images, samplers);
  const materials = texturedMaterialFacts(json, textures);
  const layouts = accessors.map((accessor, accessorIndex) => {
    assert(accessor && !own(accessor, 'sparse') && own(accessor, 'bufferView') && accessor.normalized !== true, 'packed-accessor-required');
    const view = index(accessor.bufferView, views, 'accessor-bufferView');
    const vector3 = accessor.componentType === 5126 && accessor.type === 'VEC3';
    const vector2 = accessor.componentType === 5126 && accessor.type === 'VEC2';
    const scalar = [5121, 5123, 5125].includes(accessor.componentType) && accessor.type === 'SCALAR';
    assert(vector3 || vector2 || scalar, 'accessor-type');
    const elementBytes = vector3 ? 4 : vector2 ? 4 : accessor.componentType === 5125 ? 4 : accessor.componentType === 5123 ? 2 : 1;
    const components = vector3 ? 3 : vector2 ? 2 : 1;
    const itemBytes = elementBytes * components, byteOffset = accessor.byteOffset ?? 0;
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
      assert(primitive && !own(primitive, 'targets'), 'morph-targets-unsupported');
      const attributes = primitive.attributes;
      assert(attributes && own(attributes, 'POSITION') && own(attributes, 'NORMAL'), 'POSITION-NORMAL-required');
      const position = index(attributes.POSITION, layouts, 'POSITION-accessor'), normal = index(attributes.NORMAL, layouts, 'NORMAL-accessor');
      assert(position.type === 'VEC3' && normal.type === 'VEC3' && position.count === normal.count, 'FLOAT-POSITION-NORMAL-required');
      const positionDef = accessors[position.index];
      assert(Array.isArray(positionDef.min) && positionDef.min.length === 3 && positionDef.min.every(Number.isFinite)
        && Array.isArray(positionDef.max) && positionDef.max.length === 3 && positionDef.max.every(Number.isFinite), 'POSITION-declared-bounds-required');
      const material = primitive.material === undefined ? null : index(primitive.material, materials, 'primitive-material').index;
      const texCoords = [];
      if (material === null) {
        assert(Object.keys(attributes).every(key => key === 'POSITION' || key === 'NORMAL'), 'uv-without-material');
      } else {
        const facts = materials[material];
        for (const info of [facts.baseColorTexture, facts.metallicRoughnessTexture,
          facts.normalTexture, facts.occlusionTexture, facts.emissiveTexture]) {
          if (info) texCoords.push(info.texCoord);
        }
        for (const texCoord of new Set(texCoords)) assert(own(attributes, 'TEXCOORD_' + texCoord), 'TEXCOORD-required');
        for (const key of Object.keys(attributes)) {
          if (!key.startsWith('TEXCOORD_')) continue;
          const set = Number(key.slice(9));
          assert(texCoords.includes(set), 'TEXCOORD-unused');
          const uv = layouts[attributes[key]];
          assert(uv && uv.type === 'VEC2' && uv.count === position.count, 'FLOAT-TEXCOORD-required');
        }
      }
      const indices = primitive.indices === undefined ? null : index(primitive.indices, layouts, 'indices-accessor');
      assert(indices === null || indices.type === 'SCALAR', 'unsigned-indices-required');
      const count = indices?.count ?? position.count; assert(count % 3 === 0, 'triangle-count');
      declaredTriangles += count / 3; assert(declaredTriangles <= MAX_TRIANGLES, 'triangle-limit');
      const key = `${indices?.index ?? 'undefined'}:${Object.keys(attributes).sort().map(k => k + ':' + attributes[k] + ';').join('')}:${primitive.mode ?? 'undefined'}`;
      return { meshIndex, primitiveIndex, key, material, positionAccessor: position.index, normalAccessor: normal.index,
        uvAccessors: Object.keys(attributes).filter(key => key.startsWith('TEXCOORD_')).sort()
          .map(key => ({ set: Number(key.slice(9)), accessor: attributes[key] })),
        indexAccessor: indices?.index ?? null, mode: primitive.mode ?? null, triangles: count / 3,
        positionMin: [...positionDef.min], positionMax: [...positionDef.max] };
    });
  });
  const parents = new Array(nodes.length).fill(null), meshReferences = new Map();
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const node = nodes[nodeIndex];
    assert(node && !own(node, 'skin') && !own(node, 'weights') && !own(node, 'camera')
      && !own(node, 'isBone') && !own(node, 'isSkinnedMesh'), 'static-node-required');
    if (node.mesh !== undefined) { index(node.mesh, meshes, 'node-mesh'); meshReferences.set(node.mesh, (meshReferences.get(node.mesh) ?? 0) + 1); }
    for (const child of array(node.children ?? [], 'node-children')) {
      index(child, nodes, 'node-child'); assert(parents[child] === null, 'node-multiple-parent'); parents[child] = nodeIndex;
    }
  }
  const rootSet = new Set();
  for (const root of roots) { index(root, nodes, 'scene-node'); assert(!rootSet.has(root) && parents[root] === null, 'scene-multiple-parent'); rootSet.add(root); }
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
  const usedAccessors = new Set(), usedMeshes = new Set(), geometries = new Map();
  const usedMaterials = new Set(), usedTextures = new Set(), usedImages = new Set();
  let drawCalls = 0, triangles = 0, objectCount = 1;
  const sceneNodes = [...reachable].sort((a, b) => a - b).map(nodeIndex => {
    const node = nodes[nodeIndex], meshPrimitives = node.mesh === undefined ? [] : primitives[node.mesh];
    if (node.mesh !== undefined) usedMeshes.add(node.mesh);
    objectCount += 1 + (meshPrimitives.length > 1 ? meshPrimitives.length : 0);
    for (const primitive of meshPrimitives) {
      drawCalls++; triangles += primitive.triangles;
      usedAccessors.add(primitive.positionAccessor); usedAccessors.add(primitive.normalAccessor);
      if (primitive.indexAccessor !== null) usedAccessors.add(primitive.indexAccessor);
      for (const uv of primitive.uvAccessors) usedAccessors.add(uv.accessor);
      if (!geometries.has(primitive.key)) {
        const { meshIndex: _mesh, primitiveIndex: _primitive, ...geometry } = primitive;
        geometries.set(primitive.key, geometry);
      }
      if (primitive.material !== null) {
        const facts = materials[primitive.material];
        usedMaterials.add(facts.index);
        for (const info of [facts.baseColorTexture, facts.metallicRoughnessTexture,
          facts.normalTexture, facts.occlusionTexture, facts.emissiveTexture]) {
          if (!info) continue;
          usedTextures.add(info.index);
          usedImages.add(textures[info.index].source.index);
        }
      }
    }
    const translation = node.translation ?? [0, 0, 0], rotation = node.rotation ?? [0, 0, 0, 1], scale = node.scale ?? [1, 1, 1];
    for (const [value, length] of [[translation, 3], [rotation, 4], [scale, 3]]) {
      assert(Array.isArray(value) && value.length === length && value.every(Number.isFinite), 'node-TRS');
    }
    let transform;
    if (node.matrix !== undefined) {
      assert(Array.isArray(node.matrix) && node.matrix.length === 16 && node.matrix.every(Number.isFinite), 'node-matrix');
      transform = { kind: 'matrix', matrix: [...node.matrix] };
    } else transform = { kind: 'trs', translation: [...translation], rotation: [...rotation], scale: [...scale] };
    return { index: nodeIndex, parentIndex: parents[nodeIndex], meshIndex: node.mesh ?? null,
      children: [...(node.children ?? [])], transform };
  });
  assert(drawCalls > 0 && triangles <= MAX_TRIANGLES, 'visible-triangle-limit');
  let allocatedObjectCount = objectCount;
  for (const mesh of usedMeshes) if (meshReferences.get(mesh) > 1) allocatedObjectCount += primitives[mesh].length + (primitives[mesh].length > 1 ? 1 : 0);
  const usedLayouts = [...usedAccessors].sort((a, b) => a - b).map(i => layouts[i]);
  const usedViews = [...new Set(usedLayouts.map(layout => layout.viewIndex))].sort((a, b) => a - b)
    .map(i => ({ index: i, byteOffset: views[i].byteOffset ?? 0, byteLength: views[i].byteLength }));
  return {
    profile: STATIC_TEXTURED_PROFILE, loaderVersion: STATIC_MODEL_LOADER_VERSION, input,
    declared: { nodes: nodes.length, meshes: meshes.length, primitives: primitiveCount, accessors: accessors.length,
      bufferViews: views.length, materials: materials.length, textures: textures.length, images: images.length },
    scene: { index: 0, roots: [...roots], nodes: sceneNodes, maxDepth, objectCount, allocatedObjectCount, drawCalls, triangles },
    materials: materials.filter(material => usedMaterials.has(material.index)),
    textures: textures.filter(texture => usedTextures.has(texture.index)),
    images: images.filter(image => usedImages.has(image.index)),
    resources: {
      geometries: [...geometries.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      accessors: usedLayouts, bufferViews: usedViews,
      geometryCount: geometries.size, attributeCount: usedLayouts.length, backingCount: usedViews.length,
      gpuBufferBytes: usedLayouts.reduce((sum, layout) => sum + layout.byteLength, 0),
      cpuBackingBytes: usedViews.reduce((sum, view) => sum + view.byteLength, 0),
      materialCount: usedMaterials.size, allocatedMaterialCount: usedMaterials.size * 2,
      textureCount: usedTextures.size, imageCount: usedImages.size
    }
  };
}

function approx(value, expected) {
  return Math.abs(value - expected) <= 1e-12;
}

function texturedPrimitiveKey(primitive) {
  const attributes = Object.keys(primitive.attributes).sort().map(key => key + ':' + primitive.attributes[key] + ';').join('');
  return `${primitive.indices ?? 'undefined'}:${attributes}:${primitive.mode ?? 'undefined'}`;
}

async function verifyTexturedActual(result, parser, facts, tracker) {
  if (result.scenes.length !== 1 || result.scene !== result.scenes[0] || result.animations.length || result.cameras.length) throw mismatch('result');
  const materials = new Map(facts.materials.map(material => [material.index, material]));
  const textures = new Map(facts.textures.map(texture => [texture.index, texture]));
  const textureObjects = new Map();
  for (const index of textures.keys()) textureObjects.set(index, await parser.getDependency('texture', index));
  const accessors = new Map();
  for (const layout of facts.resources.accessors) accessors.set(layout.index, await parser.getDependency('accessor', layout.index));
  const objects = [], meshes = [], nodeObjects = new Map(), retainedMaterials = new Set(), geometryObjects = new Map();
  let actualTriangles = 0, clonedTextureCount = 0;
  result.scene.traverse(object => {
    objects.push(object);
    if (object.isCamera || object.isLight || object.isBone || object.isSkinnedMesh || object.isInstancedMesh
      || object.isLine || object.isPoints) throw mismatch('object-type');
    const association = parser.associations.get(object);
    if (association?.nodes !== undefined) {
      if (nodeObjects.has(association.nodes)) throw mismatch('duplicate-node');
      nodeObjects.set(association.nodes, object);
    }
    if (object.isMesh) {
      meshes.push(object); retainedMaterials.add(object.material);
      const primitive = parser.json.meshes[association?.meshes]?.primitives[association?.primitives];
      if (!primitive) throw mismatch('mesh-association');
      const key = texturedPrimitiveKey(primitive);
      if (geometryObjects.has(key) && geometryObjects.get(key) !== object.geometry) throw mismatch('geometry-identity');
      geometryObjects.set(key, object.geometry);
      const expected = materials.get(primitive.material);
      if (!expected) throw mismatch('material-association');
      const material = object.material;
      if (!(material instanceof MeshStandardMaterial) || material.isMeshPhysicalMaterial
        || material.flatShading || material.vertexColors) throw mismatch('material-type');
      if (!approx(material.color.r, expected.baseColorFactor[0]) || !approx(material.color.g, expected.baseColorFactor[1])
        || !approx(material.color.b, expected.baseColorFactor[2]) || !approx(material.opacity, expected.baseColorFactor[3])) {
        throw mismatch('baseColorFactor');
      }
      if (!approx(material.metalness, expected.metallicFactor) || !approx(material.roughness, expected.roughnessFactor)) {
        throw mismatch('pbr-factors');
      }
      if ((material.side === DoubleSide) !== expected.doubleSided) throw mismatch('doubleSided');
      if (expected.alphaMode === 'OPAQUE') {
        if (material.transparent || material.alphaTest !== 0 || material.depthWrite !== true) throw mismatch('alpha-opaque');
      } else if (expected.alphaMode === 'MASK') {
        if (material.transparent || !approx(material.alphaTest, expected.alphaCutoff)) throw mismatch('alpha-mask');
      } else if (!material.transparent || material.depthWrite !== false) throw mismatch('alpha-blend');
      const base = expected.baseColorTexture, rough = expected.metallicRoughnessTexture;
      const baseOriginal = base ? textureObjects.get(base.index) : null;
      const roughOriginal = rough ? textureObjects.get(rough.index) : null;
      const checkSlot = (map, info, original, srgb) => {
        if (!info) {
          if (map) throw mismatch('unexpected-texture');
          return 0;
        }
        if (!map) throw mismatch('missing-texture');
        const sampler = textures.get(info.index).sampler;
        if (info.texCoord === 0) {
          if (map !== original) throw mismatch('texture-identity');
        } else if (map === original || map.image !== original.image || map.channel !== info.texCoord) {
          throw mismatch('texture-channel-clone');
        }
        if (map.flipY !== false || map.wrapS !== TEXTURED_WRAPS[sampler.wrapS] || map.wrapT !== TEXTURED_WRAPS[sampler.wrapT]
          || map.magFilter !== TEXTURED_MAG_FILTERS[sampler.magFilter]
          || map.minFilter !== TEXTURED_MIN_FILTERS[sampler.minFilter]
          || map.colorSpace !== (srgb ? SRGBColorSpace : NoColorSpace)
          || !map.image || !(map.image.width > 0) || !(map.image.height > 0)) throw mismatch('texture-state');
        return info.texCoord === 0 ? 0 : 1;
      };
      clonedTextureCount += checkSlot(material.map, base, baseOriginal, true);
      if (!rough) {
        if (material.metalnessMap || material.roughnessMap) throw mismatch('unexpected-texture');
      } else {
        if (rough.texCoord !== undefined && rough.texCoord > 0 && material.metalnessMap === material.roughnessMap) {
          throw mismatch('texture-channel-clone-identity');
        }
        clonedTextureCount += checkSlot(material.metalnessMap, rough, roughOriginal, false);
        clonedTextureCount += checkSlot(material.roughnessMap, rough, roughOriginal, false);
      }
      const normal = expected.normalTexture, occlusion = expected.occlusionTexture, emissive = expected.emissiveTexture;
      clonedTextureCount += checkSlot(material.normalMap, normal, normal ? textureObjects.get(normal.index) : null, false);
      clonedTextureCount += checkSlot(material.aoMap, occlusion, occlusion ? textureObjects.get(occlusion.index) : null, false);
      clonedTextureCount += checkSlot(material.emissiveMap, emissive, emissive ? textureObjects.get(emissive.index) : null, true);
      // No TANGENT attribute: GLTFLoader clones the final material and negates
      // normalScale.y for derivative tangents, even without a normal texture.
      const normalScale = normal?.scale ?? 1;
      if (!approx(material.normalScale.x, normalScale) || !approx(material.normalScale.y, -normalScale)) {
        throw mismatch('normal-scale');
      }
      if (!approx(material.aoMapIntensity, occlusion?.strength ?? 1)) throw mismatch('occlusion-strength');
      if (!approx(material.emissive.r, expected.emissiveFactor[0])
        || !approx(material.emissive.g, expected.emissiveFactor[1])
        || !approx(material.emissive.b, expected.emissiveFactor[2])) throw mismatch('emissive-factor');
      const expectedAttributes = ['normal', 'position'];
      for (const key of Object.keys(primitive.attributes)) {
        if (key === 'TEXCOORD_0') expectedAttributes.push('uv');
        if (key === 'TEXCOORD_1') expectedAttributes.push('uv1');
      }
      expectedAttributes.sort();
      if (Object.keys(object.geometry.attributes).sort().join(',') !== expectedAttributes.join(',')) throw mismatch('geometry-attributes');
      if (object.geometry.attributes.position !== accessors.get(primitive.attributes.POSITION)
        || object.geometry.attributes.normal !== accessors.get(primitive.attributes.NORMAL)) throw mismatch('primitive-accessors');
      for (const key of Object.keys(primitive.attributes)) {
        if (!key.startsWith('TEXCOORD_')) continue;
        const name = key === 'TEXCOORD_0' ? 'uv' : 'uv1';
        if (object.geometry.attributes[name] !== accessors.get(primitive.attributes[key])) throw mismatch('uv-accessor');
      }
      if (object.geometry.index !== (primitive.indices === undefined ? null : accessors.get(primitive.indices))) throw mismatch('index-accessor');
      if (Object.keys(object.geometry.morphAttributes).length || object.geometry.groups.length
        || object.geometry.drawRange.start !== 0 || object.geometry.drawRange.count !== Infinity) throw mismatch('geometry-state');
      actualTriangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
    } else if (object.geometry || object.material) throw mismatch('unexpected-resource');
  });
  if (objects.length !== facts.scene.objectCount || meshes.length !== facts.scene.drawCalls
    || actualTriangles !== facts.scene.triangles || nodeObjects.size !== facts.scene.nodes.length
    || tracker.geometries.size !== facts.resources.geometryCount || geometryObjects.size !== facts.resources.geometryCount
    || tracker.objects.size !== facts.scene.allocatedObjectCount
    || tracker.materials.size !== facts.resources.allocatedMaterialCount
    || retainedMaterials.size !== facts.resources.materialCount
    || tracker.textures.size !== new Set(textureObjects.values()).size + clonedTextureCount) throw mismatch('resource-count');
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
    compareStaticModelFacts(node.children, object.children.map(child => parser.associations.get(child)?.nodes).filter(value => value !== undefined));
  }
  compareStaticModelFacts(facts.scene.roots, result.scene.children.map(object => parser.associations.get(object)?.nodes));
  const backings = new Map();
  for (const layout of facts.resources.accessors) {
    const attribute = accessors.get(layout.index);
    if (!attribute || !attribute.isBufferAttribute || attribute.isInterleavedBufferAttribute || attribute.normalized
      || attribute.itemSize !== (layout.type === 'VEC3' ? 3 : layout.type === 'VEC2' ? 2 : 1)
      || attribute.count !== layout.count || attribute.array.byteOffset !== layout.byteOffset
      || attribute.array.byteLength !== layout.byteLength) throw mismatch('accessor-layout-or-identity');
    if (!backings.has(layout.viewIndex)) backings.set(layout.viewIndex, attribute.array.buffer);
    else if (backings.get(layout.viewIndex) !== attribute.array.buffer) throw mismatch('backing-alias');
  }
  for (const view of facts.resources.bufferViews) if (backings.get(view.index)?.byteLength !== view.byteLength) throw mismatch('backing-size');
  for (const geometry of facts.resources.geometries) {
    const actual = geometryObjects.get(geometry.key);
    if (!actual || actual.attributes.position !== accessors.get(geometry.positionAccessor)
      || actual.attributes.normal !== accessors.get(geometry.normalAccessor)) throw mismatch('primitive-accessors');
    for (const uv of geometry.uvAccessors) {
      const name = uv.set === 0 ? 'uv' : 'uv1';
      if (actual.attributes[name] !== accessors.get(uv.accessor)) throw mismatch('uv-accessors');
    }
    if (actual.index !== (geometry.indexAccessor === null ? null : accessors.get(geometry.indexAccessor))) throw mismatch('primitive-indices');
    compareStaticModelFacts(geometry.positionMin, actual.boundingBox?.min.toArray());
    compareStaticModelFacts(geometry.positionMax, actual.boundingBox?.max.toArray());
  }
  return accessors;
}

/**
 * Textured PBR profile consumption. `textureUrl` maps a declared external
 * image URI to a same-package broker URL; unmapped URIs fail before any fetch.
 */
export async function parseTexturedModel(buffer, expectedFacts, { signal, admissions, bufferPlan, textureUrl } = {}) {
  alive(signal);
  assert(REVISION === '186', 'loader-version');
  if (!admissions?.cpu || typeof admissions.cpu.state !== 'function' || !bufferPlan
    || typeof bufferPlan.cpuReady !== 'function' || typeof bufferPlan.upload !== 'function') throw new Error('composition-model-admission-required');
  if (typeof textureUrl !== 'function') throw new Error('composition-model-texture-url-required');
  const input = inputFacts(buffer);
  function checkAdmission() {
    const state = admissions.cpu.state();
    if (!state || state.released || state.cancelled || state.allocationEnded
      || !integer(state.pending?.ownedCpuBytes) || state.pending.ownedCpuBytes < input.encodedBytes + input.binBytes + input.jsonBytes * 2) throw new Error('composition-model-CPU-construction-plan-required');
  }
  checkAdmission();
  const manager = new LoadingManager();
  manager.setURLModifier(url => {
    if (/^(blob:|data:)/.test(url)) return url;
    const mapped = textureUrl(url);
    if (!mapped) throw unavailable('URI-unsupported');
    return mapped;
  });
  const loader = new GLTFLoader(manager); let parser, tracker, completed, facts;
  loader.register(candidate => {
    parser = candidate;
    rejectTexturedDelegates(parser.json);
    tracker = allocationTracker(parser);
    return { name: 'HERTZ_textured_model_profile',
      beforeRoot() {
        alive(signal); checkAdmission(); alive(signal);
        facts = texturedProfileFacts(parser.json, input);
        for (const image of facts.images) {
          if (image.source === 'external' && !textureUrl(image.uri)) throw unavailable('URI-unsupported');
        }
        compareStaticModelFacts(expectedFacts, facts); freeze(facts);
      },
      async afterRoot(result) {
        completed = result; tracker.capture(result.scenes); alive(signal);
        const sceneNodes = new Map(facts.scene.nodes.map(node => [node.index, node]));
        result.scene.traverse(object => {
          const nodeIndex = parser.associations.get(object)?.nodes;
          const node = sceneNodes.get(nodeIndex);
          if (node?.transform.kind === 'matrix') { object.matrix.fromArray(node.transform.matrix); object.matrixAutoUpdate = false; }
        });
        result.scene.updateMatrixWorld(true);
        const accessors = await verifyTexturedActual(result, parser, facts, tracker); alive(signal);
        await bufferPlan.cpuReady(facts.resources.cpuBackingBytes); alive(signal);
        for (const accessor of accessors.values()) { await bufferPlan.upload(accessor); alive(signal); }
        await verifyTexturedActual(result, parser, facts, tracker); alive(signal);
      }
    };
  });
  try {
    const result = await loader.parseAsync(buffer, '');
    await tracker.settle(); alive(signal);
    const retainedMaterials = new Set(); result.scene.traverse(object => { if (object.material) retainedMaterials.add(object.material); });
    for (const material of [...tracker.materials]) if (!retainedMaterials.has(material)) { tracker.materials.delete(material); material.dispose(); }
    return createModelResource(result.scene, facts, { geometries: tracker.geometries, materials: tracker.materials, textures: tracker.textures });
  } catch (error) {
    if (tracker) { await tracker.settle(); completed?.scenes.forEach(scene => scene.clear()); disposeResources(tracker); }
    throw error;
  }
}
