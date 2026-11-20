// SPDX-License-Identifier: MIT
// Construction plans at procedural source owners, never renderer statistics.
import * as THREE from 'three';
import { mergeGeometries as merge } from 'three/addons/utils/BufferGeometryUtils.js';
import { constructedGeometry } from '../../space-stage/src/source-resources.js';

export function geometry(scope, kind, args) {
  return scope ? constructedGeometry(THREE, scope, kind, args) : new THREE[kind](...args);
}
export function numericArray(scope, Type, length, source) {
  const ticket = scope?.reserve({ ownedCpuBytes: length * Type.BYTES_PER_ELEMENT }, source);
  const value = new Type(length); ticket?.commit(); return value;
}
export function geometryPlan(scope, cpuBytes, gpuBytes, source) {
  return scope?.bufferPlan(cpuBytes, gpuBytes, source) || { cpuReady() {}, upload: value => value };
}
export function finishGeometry(scope, plan, value, retained) {
  scope?.track(value);
  for (const attr of [...Object.values(value.attributes), value.index].filter(Boolean)) plan.upload(attr);
  plan.cpuReady(retained); return value;
}
export function copyGeometry(scope, source, nonIndexed = false) {
  const count = nonIndexed && source.index ? source.index.count : null;
  const bytes = Object.values(source.attributes).reduce((sum, attr) => sum + (count === null ? attr.array.byteLength : count * attr.itemSize * attr.array.BYTES_PER_ELEMENT), 0)
    + (count === null && source.index ? source.index.array.byteLength : 0);
  const plan = geometryPlan(scope, bytes, bytes, 'Coast geometry ' + (nonIndexed ? 'nonindexed expansion' : 'clone') + ' original attribute arrays');
  return finishGeometry(scope, plan, nonIndexed ? source.toNonIndexed() : source.clone(), bytes);
}
export function mergeGeometry(scope, parts) {
  const vertices = parts.reduce((sum, part) => sum + part.attributes.position.count, 0);
  const attributeBytes = parts.reduce((sum, part) => sum + Object.values(part.attributes).reduce((bytes, attr) => bytes + attr.array.byteLength, 0), 0);
  const indices = parts.reduce((sum, part) => sum + (part.index?.count || 0), 0);
  const bytes = attributeBytes + indices * (vertices > 65535 ? 4 : 2);
  const plan = geometryPlan(scope, bytes + indices * 8, bytes, 'Coast merged geometry attributes and index scratch');
  const result = finishGeometry(scope, plan, merge(parts), bytes);
  // Construction-only inputs remain scoped until retirement, preserving their
  // CPU reservations without pretending garbage collection is synchronous.
  return result;
}
export function instancedMesh(scope, geometry, material, count) {
  const plan = geometryPlan(scope, count * 16 * 4, count * 16 * 4, 'Coast instance matrices ' + count);
  const mesh = new THREE.InstancedMesh(geometry, material, count); scope?.track(mesh);
  plan.upload(mesh.instanceMatrix); plan.cpuReady(count * 16 * 4); return mesh;
}
export function shapeGeometry(scope, shape, segments = 12) {
  const rings = [shape, ...shape.holes];
  const vertices = rings.reduce((sum, ring) => sum + 1 + ring.curves.reduce((n, curve) => n + (curve.isLineCurve ? 1 : segments * 2), 0), 0);
  // extractPoints endpoints, planar triangulation <= 2V triangles (including
  // holes), numeric Earcut working nodes and position/normal/uv payloads.
  const indices = vertices * 6, bytes = vertices * 32 + indices * 2;
  const plan = geometryPlan(scope, bytes + vertices * (8 + 2 * 2 + 12) * 8 + indices * 8, bytes,
    'Coast ShapeGeometry curve-segment and planar-triangulation bound');
  const value = new THREE.ShapeGeometry(shape, segments);
  const retained = Object.values(value.attributes).reduce((sum, attr) => sum + attr.array.byteLength, 0) + value.index.array.byteLength;
  if (retained > bytes) throw new Error('Coast shape plan exceeded');
  return finishGeometry(scope, plan, value, retained);
}
