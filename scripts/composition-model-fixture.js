// SPDX-License-Identifier: MIT
// Real untextured GLB bytes and their independent layout facts for the
// composition browser check. This mirrors the installed Three 0.186.0 core
// profile; it is a fixture oracle, not a second loader.
'use strict';
const zlib = require('node:zlib');
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

module.exports = { coreGlb, texturedGlb, texturedModelFacts };

function crc32(bytes) {
  let value = -1;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8), crc = Buffer.alloc(4);
  head.writeUInt32BE(data.length); head.write(type, 4, 'ascii');
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}
function texturedPng() {
  const width = 2, height = 2, header = Buffer.alloc(13), row = width * 4 + 1;
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * row + 1 + x * 4;
    raw[at] = x === 0 ? 255 : 0; raw[at + 1] = x === 0 ? 0 : 255; raw[at + 2] = 0; raw[at + 3] = 255;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

function texturedGlb() {
  const image = texturedPng(), binary = Buffer.alloc(104 + image.length);
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  normals.forEach((value, index) => binary.writeFloatLE(value, 36 + index * 4));
  [0, 0, 1, 0, 0, 1].forEach((value, index) => binary.writeFloatLE(value, 72 + index * 4));
  binary.writeUInt16LE(0, 96); binary.writeUInt16LE(1, 98); binary.writeUInt16LE(2, 100);
  image.copy(binary, 104);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 3 }, indices: 2, material: 0 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 24 }, { buffer: 0, byteOffset: 96, byteLength: 8 },
      { buffer: 0, byteOffset: 104, byteLength: image.length }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' }
    ],
    images: [{ bufferView: 4, mimeType: 'image/png' }],
    samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }],
    textures: [{ source: 0, sampler: 0 }],
    materials: [{
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: 0, texCoord: 0 },
        metallicFactor: 0, roughnessFactor: 1 },
      alphaMode: 'OPAQUE'
    }]
  };
  const text = Buffer.from(JSON.stringify(json));
  const jsonBytes = Math.ceil(text.length / 4) * 4, binBytes = Math.ceil(binary.length / 4) * 4;
  const encodedBytes = 12 + 8 + jsonBytes + 8 + binBytes, glb = Buffer.alloc(encodedBytes);
  glb.write('glTF', 0, 'ascii'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(encodedBytes, 8);
  glb.writeUInt32LE(jsonBytes, 12); glb.write('JSON', 16, 'ascii');
  glb.fill(0x20, 20, 20 + jsonBytes); text.copy(glb, 20);
  glb.writeUInt32LE(binBytes, 20 + jsonBytes); glb.write('BIN\0', 24 + jsonBytes, 'ascii');
  binary.copy(glb, 28 + jsonBytes);
  return { glb, input: { encodedBytes, jsonBytes, binBytes }, imageBytes: image.length };
}

function texturedModelFacts(input, imageBytes) {
  const embedded = { index: 0, source: 'embedded', mime: 'image/png', bytes: imageBytes };
  return {
    profile: 'static-pbr-texture-v1', loaderVersion: 'three-0.186.0-gltfloader', input,
    declared: { nodes: 1, meshes: 1, primitives: 1, accessors: 4, bufferViews: 5, materials: 1, textures: 1, images: 1 },
    scene: {
      index: 0, roots: [0],
      nodes: [{ index: 0, parentIndex: null, meshIndex: 0, children: [],
        transform: { kind: 'trs', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }],
      maxDepth: 1, objectCount: 2, allocatedObjectCount: 2, drawCalls: 1, triangles: 1
    },
    materials: [{
      index: 0, baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1,
      baseColorTexture: { index: 0, texCoord: 0 }, metallicRoughnessTexture: null,
      normalTexture: null, occlusionTexture: null, emissiveTexture: null, emissiveFactor: [0, 0, 0],
      alphaMode: 'OPAQUE', alphaCutoff: 0.5, doubleSided: false
    }],
    textures: [{ index: 0, source: embedded, sampler: { magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 } }],
    images: [embedded],
    resources: {
      geometries: [{ key: '2:NORMAL:1;POSITION:0;TEXCOORD_0:3;:undefined', material: 0, positionAccessor: 0,
        normalAccessor: 1, uvAccessors: [{ set: 0, accessor: 3 }], indexAccessor: 2, mode: null, triangles: 1,
        positionMin: [0, 0, 0], positionMax: [1, 1, 0] }],
      accessors: [
        { index: 0, viewIndex: 0, componentType: 5126, type: 'VEC3', count: 3, byteOffset: 0, byteLength: 36 },
        { index: 1, viewIndex: 1, componentType: 5126, type: 'VEC3', count: 3, byteOffset: 0, byteLength: 36 },
        { index: 2, viewIndex: 3, componentType: 5123, type: 'SCALAR', count: 3, byteOffset: 0, byteLength: 6 },
        { index: 3, viewIndex: 2, componentType: 5126, type: 'VEC2', count: 3, byteOffset: 0, byteLength: 24 }
      ],
      bufferViews: [
        { index: 0, byteOffset: 0, byteLength: 36 }, { index: 1, byteOffset: 36, byteLength: 36 },
        { index: 2, byteOffset: 72, byteLength: 24 }, { index: 3, byteOffset: 96, byteLength: 8 }
      ],
      geometryCount: 1, attributeCount: 4, backingCount: 4, gpuBufferBytes: 102,
      cpuBackingBytes: 36 + 36 + 24 + 8, materialCount: 1, allocatedMaterialCount: 2,
      textureCount: 1, imageCount: 1
    }
  };
}
