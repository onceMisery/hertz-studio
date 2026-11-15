// SPDX-License-Identifier: MIT
// Real untextured GLB bytes and their independent layout facts for the
// composition browser check. This mirrors the installed Three 0.186.0 core
// profile; it is a fixture oracle, not a second loader.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
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

module.exports = { coreGlb, animatedGlb, texturedGlb, ktx2Glb, basisGlb, basisUastcGlb, multiMaterialGlb, texturedModelFacts };

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

function animatedGlb() {
  const binary = Buffer.alloc(112);
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  normals.forEach((value, index) => binary.writeFloatLE(value, 36 + index * 4));
  binary.writeUInt16LE(0, 72); binary.writeUInt16LE(1, 74); binary.writeUInt16LE(2, 76);
  binary.writeFloatLE(0, 80); binary.writeFloatLE(1, 84);
  [0, 0, 0, 1, 0, 0].forEach((value, index) => binary.writeFloatLE(value, 88 + index * 4));
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'mesh' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 8 }, { buffer: 0, byteOffset: 80, byteLength: 8 },
      { buffer: 0, byteOffset: 88, byteLength: 24 }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
      { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 4, componentType: 5126, count: 2, type: 'VEC3' }
    ],
    animations: [{
      name: 'move',
      samplers: [{ input: 3, output: 4, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }]
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
  return { glb, input: { encodedBytes, jsonBytes, binBytes } };
}

// 4x4 Basis UASTC solid-color block. Mode 8 (huffman code 0x17/5 bits) is
// followed by R,G,B,A at 8 bits each; this one is opaque red.
function uastcRed() {
  const block = Buffer.from([0xf7, 0x1f, 0x00, 0xe0, 0x1f, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const dfdBytes = 44, dfdOffset = 80 + 24, levelOffset = dfdOffset + dfdBytes;
  const bytes = Buffer.alloc(levelOffset + block.length);
  Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 13, 10, 26, 10]).copy(bytes);
  for (const [offset, value] of [[12, 0], [16, 1], [20, 4], [24, 4], [28, 0], [32, 0], [36, 1], [40, 1], [44, 0],
    [48, dfdOffset], [52, dfdBytes], [56, 0], [60, 0]]) bytes.writeUInt32LE(value, offset);
  for (const [offset, value] of [[64, 0], [72, 0], [80, levelOffset], [88, block.length], [96, block.length]]) {
    bytes.writeBigUInt64LE(BigInt(value), offset);
  }
  bytes.writeUInt32LE(dfdBytes, dfdOffset);
  bytes.writeUInt16LE(2, dfdOffset + 8); bytes.writeUInt16LE(40, dfdOffset + 10);
  bytes[dfdOffset + 12] = 166; bytes[dfdOffset + 13] = 1; bytes[dfdOffset + 14] = 2;
  bytes[dfdOffset + 16] = 3; bytes[dfdOffset + 17] = 3;
  bytes[dfdOffset + 20] = 16;
  const sample = dfdOffset + 28;
  bytes[sample + 2] = 128; bytes.writeUInt32LE(0xffffffff, sample + 12);
  block.copy(bytes, levelOffset);
  return bytes;
}

// Shared GLB framing for a single embedded KTX2 baseColor texture. The
// ETC1S fixture is the Khronos KTX-Software test resource
// tests/resources/ktx2/r8g8b8a8_srgb_mip_blze.ktx2 (Apache-2.0): one solid
// color per mip level, 64x64 and seven levels, decoded through the pinned
// Basis transcoder rather than a second decoder here.
function ktx2TexturedGlb(image) {
  const binary = Buffer.alloc(104 + image.length);
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  normals.forEach((value, index) => binary.writeFloatLE(value, 36 + index * 4));
  [0, 0, 1, 0, 0, 1].forEach((value, index) => binary.writeFloatLE(value, 72 + index * 4));
  binary.writeUInt16LE(0, 96); binary.writeUInt16LE(1, 98); binary.writeUInt16LE(2, 100);
  image.copy(binary, 104);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    extensionsUsed: ['KHR_texture_basisu'], extensionsRequired: ['KHR_texture_basisu'],
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
    images: [{ bufferView: 4, mimeType: 'image/ktx2' }],
    samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }],
    textures: [{ sampler: 0, extensions: { KHR_texture_basisu: { source: 0 } } }],
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

function basisGlb() {
  return ktx2TexturedGlb(fs.readFileSync(path.join(__dirname, 'fixtures/basis-etc1s-mip.ktx2')));
}

function basisUastcGlb() {
  return ktx2TexturedGlb(uastcRed());
}

function whitePng() {
  const width = 2, height = 2, header = Buffer.alloc(13), row = width * 4 + 1;
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * row + 1 + x * 4;
    raw[at] = 255; raw[at + 1] = 255; raw[at + 2] = 255; raw[at + 3] = 255;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

// Two nodes with distinct materials over one shared white texture. Both
// materials are OPAQUE by default (one program variant); `masked` makes the
// second MASK so active alpha test adds a second variant.
function multiMaterialGlb(masked = false) {
  const image = whitePng(), binary = Buffer.alloc(104 + image.length);
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  normals.forEach((value, index) => binary.writeFloatLE(value, 36 + index * 4));
  [0, 0, 1, 0, 0, 1].forEach((value, index) => binary.writeFloatLE(value, 72 + index * 4));
  binary.writeUInt16LE(0, 96); binary.writeUInt16LE(1, 98); binary.writeUInt16LE(2, 100);
  image.copy(binary, 104);
  const primitive = material => ({ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 3 }, indices: 2, material });
  const material = (factor, alphaMode) => ({
    pbrMetallicRoughness: { baseColorFactor: factor, baseColorTexture: { index: 0, texCoord: 0 },
      metallicFactor: 0, roughnessFactor: 1 },
    alphaMode,
    ...(alphaMode === 'MASK' ? { alphaCutoff: 0.5 } : {})
  });
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0, name: 'left', translation: [-0.6, 0, 0] },
      { mesh: 1, name: 'right', translation: [0.2, 0, 0] }],
    meshes: [{ primitives: [primitive(0)] }, { primitives: [primitive(1)] }],
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
    materials: [material([1, 0, 0, 1], 'OPAQUE'), material([0, 1, 0, 1], masked ? 'MASK' : 'OPAQUE')]
  };
  const text = Buffer.from(JSON.stringify(json));
  const jsonBytes = Math.ceil(text.length / 4) * 4, binBytes = Math.ceil(binary.length / 4) * 4;
  const encodedBytes = 12 + 8 + jsonBytes + 8 + binBytes, glb = Buffer.alloc(encodedBytes);
  glb.write('glTF', 0, 'ascii'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(encodedBytes, 8);
  glb.writeUInt32LE(jsonBytes, 12); glb.write('JSON', 16, 'ascii');
  glb.fill(0x20, 20, 20 + jsonBytes); text.copy(glb, 20);
  glb.writeUInt32LE(binBytes, 20 + jsonBytes); glb.write('BIN\0', 24 + jsonBytes, 'ascii');
  binary.copy(glb, 28 + jsonBytes);
  return { glb, input: { encodedBytes, jsonBytes, binBytes }, masked };
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

function ktx2Rgba8() {
  const edge = 2, levelBytes = edge * edge * 4, bytes = Buffer.alloc(196 + levelBytes);
  Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 13, 10, 26, 10]).copy(bytes);
  for (const [offset, value] of [[12, 43], [16, 1], [20, edge], [24, edge], [36, 1], [40, 1],
    [48, 104], [52, 92], [104, 92]]) bytes.writeUInt32LE(value, offset);
  for (const [offset, value] of [[80, 196], [88, levelBytes], [96, levelBytes]]) bytes.writeBigUInt64LE(BigInt(value), offset);
  bytes.writeUInt16LE(2, 112); bytes.writeUInt16LE(88, 114);
  Buffer.from([1, 1, 2, 0]).copy(bytes, 116); bytes[124] = 4;
  [0, 1, 2, 15].forEach((channel, index) => {
    const sample = 132 + index * 16;
    bytes.writeUInt16LE(index * 8, sample); bytes[sample + 2] = 8; bytes[sample + 3] = channel;
    bytes.writeUInt32LE(0xff, sample + 12);
  });
  Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255]).copy(bytes, 196);
  return bytes;
}

function ktx2Glb() {
  const image = ktx2Rgba8(), binary = Buffer.alloc(104 + image.length);
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  normals.forEach((value, index) => binary.writeFloatLE(value, 36 + index * 4));
  [0, 0, 1, 0, 0, 1].forEach((value, index) => binary.writeFloatLE(value, 72 + index * 4));
  binary.writeUInt16LE(0, 96); binary.writeUInt16LE(1, 98); binary.writeUInt16LE(2, 100);
  image.copy(binary, 104);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    extensionsUsed: ['KHR_texture_basisu'], extensionsRequired: ['KHR_texture_basisu'],
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
    images: [{ bufferView: 4, mimeType: 'image/ktx2' }],
    samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }],
    textures: [{ sampler: 0, extensions: { KHR_texture_basisu: { source: 0 } } }],
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
