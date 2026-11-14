// SPDX-License-Identifier: MIT
// Real untextured GLB bytes and their independent layout facts for the
// composition browser check. This mirrors the installed Three 0.186.0 core
// profile; it is a fixture oracle, not a second loader.
'use strict';
const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];

function coreGlb() {
  const binary = Buffer.alloc(80);
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  normals.forEach((value, index) => binary.writeFloatLE(value, 36 + index * 4));
  binary.writeUInt16LE(0, 72); binary.writeUInt16LE(1, 74); binary.writeUInt16LE(2, 76);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 8 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' }
    ]
  };
  const text = Buffer.from(JSON.stringify(json));
  const jsonBytes = Math.ceil(text.length / 4) * 4, binBytes = Math.ceil(binary.length / 4) * 4;
  const encodedBytes = 12 + 8 + jsonBytes + 8 + binBytes;
  const glb = Buffer.alloc(encodedBytes);
  glb.write('glTF', 0, 'ascii'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(encodedBytes, 8);
  glb.writeUInt32LE(jsonBytes, 12); glb.write('JSON', 16, 'ascii');
  glb.fill(0x20, 20, 20 + jsonBytes); text.copy(glb, 20);
  glb.writeUInt32LE(binBytes, 20 + jsonBytes); glb.write('BIN\0', 24 + jsonBytes, 'ascii');
  binary.copy(glb, 28 + jsonBytes);
  return { glb, input: { encodedBytes, jsonBytes, binBytes } };
}

function coreModelFacts(input) {
  const key = '2:NORMAL:1;POSITION:0;:undefined';
  return {
    profile: 'static-core-pbr-v1', loaderVersion: 'three-0.186.0-gltfloader', input,
    declared: { nodes: 1, meshes: 1, primitives: 1, accessors: 3, bufferViews: 3 },
    scene: {
      index: 0, roots: [0],
      nodes: [{ index: 0, parentIndex: null, meshIndex: 0, children: [],
        transform: { kind: 'trs', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }],
      maxDepth: 1, objectCount: 2, allocatedObjectCount: 2, drawCalls: 1, triangles: 1
    },
    resources: {
      geometries: [{ key, positionAccessor: 0, normalAccessor: 1, indexAccessor: 2, mode: null, triangles: 1,
        positionMin: [0, 0, 0], positionMax: [1, 1, 0] }],
      accessors: [
        { index: 0, viewIndex: 0, componentType: 5126, type: 'VEC3', count: 3, byteOffset: 0, byteLength: 36 },
        { index: 1, viewIndex: 1, componentType: 5126, type: 'VEC3', count: 3, byteOffset: 0, byteLength: 36 },
        { index: 2, viewIndex: 2, componentType: 5123, type: 'SCALAR', count: 3, byteOffset: 0, byteLength: 6 }
      ],
      bufferViews: [{ index: 0, byteOffset: 0, byteLength: 36 }, { index: 1, byteOffset: 36, byteLength: 36 },
        { index: 2, byteOffset: 72, byteLength: 8 }],
      geometryCount: 1, attributeCount: 3, backingCount: 3, gpuBufferBytes: 78, cpuBackingBytes: 80,
      allocatedMaterialCount: 2, retainedMaterialCount: 1
    }
  };
}

module.exports = { coreGlb, coreModelFacts };
