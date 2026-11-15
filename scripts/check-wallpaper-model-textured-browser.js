// SPDX-License-Identifier: MIT
// Real Chrome decode of the textured PBR loader profile. Three, GLTFLoader,
// ImageBitmap, PNG/JPEG decode and disposal are real; only admission ports are
// simulated. No renderer, upload or first frame is claimed.
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/miracle/node_modules/playwright');
const root = path.resolve(__dirname, '..');

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes) {
  let c = -1;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8), crc = Buffer.alloc(4);
  head.writeUInt32BE(data.length); head.write(type, 4, 'ascii');
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}
function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const row = width * 4 + 1, raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const at = y * row + 1 + x * 4;
      raw[at] = 30 + x * 40; raw[at + 1] = 60 + y * 40; raw[at + 2] = 200; raw[at + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}
function floats(values) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes;
}

function fixture({ missingUv1 = false, badSampler = false, sharedTexture = false, unmapped = false, pbrField = false } = {}) {
  const image = png(2, 2), binary = [];
  let offset = 0;
  const view = (bytes) => {
    while (offset % 4 !== 0) { binary.push(0); offset++; }
    const item = { buffer: 0, byteOffset: offset, byteLength: bytes.length };
    binary.push(...bytes); offset += bytes.length;
    return item;
  };
  const views = [
    view(floats([0, 0, 0, 1, 0, 0, 0, 1, 0])),
    view(floats([0, 0, 1, 0, 0, 1, 0, 0, 1])),
    view(floats([0, 0, 1, 0, 0, 1])),
    view(floats([0, 0, 0.5, 0.5, 1, 1])),
    view(Buffer.from([0, 0, 1, 0, 2, 0, 0, 0]))
  ];
  views.push(view(image));
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, TEXCOORD_1: 3 }, indices: 4, material: 0 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: views,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 4, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    images: [
      { bufferView: 5, mimeType: 'image/png' }, { bufferView: 5, mimeType: 'image/png' },
      { bufferView: 5, mimeType: 'image/png' }, { bufferView: 5, mimeType: 'image/png' },
      { uri: unmapped ? 'textures/unmapped.png' : 'textures/emissive.png', mimeType: 'image/png' }
    ],
    samplers: [
      { magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33648 },
      { magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 33071 },
      { magFilter: 9729, minFilter: 9728, wrapS: 33648, wrapT: 10497 },
      { magFilter: 9728, minFilter: 9987, wrapS: 33071, wrapT: 10497 },
      { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }
    ],
    textures: [
      { source: 0, sampler: 0 }, { source: 1, sampler: 1 }, { source: 2, sampler: 2 },
      { source: 3, sampler: 3 }, { source: 4, sampler: 4 }
    ],
    materials: [{
      pbrMetallicRoughness: {
        baseColorFactor: [0.25, 0.5, 0.75, 0.8],
        baseColorTexture: { index: 0, texCoord: 0 },
        metallicFactor: 0.4,
        roughnessFactor: 0.6,
        metallicRoughnessTexture: { index: 1, texCoord: 1 }
      },
      normalTexture: { index: 2, texCoord: 1, scale: 0.75 },
      occlusionTexture: { index: 3, texCoord: 0, strength: 0.6 },
      emissiveTexture: { index: 4, texCoord: 0 },
      emissiveFactor: [0.1, 0.2, 0.3],
      alphaMode: 'MASK', alphaCutoff: 0.3, doubleSided: true
    }]
  };
  if (missingUv1) delete json.meshes[0].primitives[0].attributes.TEXCOORD_1;
  if (badSampler) json.samplers[0].wrapS = 1;
  if (sharedTexture) json.materials[0].normalTexture.index = 0;
  if (pbrField) json.materials[0].pbrMetallicRoughness.clearcoat = {};
  while (binary.length % 4 !== 0) binary.push(0);
  json.buffers[0].byteLength = binary.length;
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20); text.copy(padded);
  const bin = Buffer.from(binary), total = 12 + 8 + padded.length + 8 + bin.length;
  const glb = Buffer.alloc(total), header = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  glb.write('glTF', 0, 'ascii'); header.setUint32(4, 2, true); header.setUint32(8, total, true);
  header.setUint32(12, padded.length, true); glb.write('JSON', 16, 'ascii'); padded.copy(glb, 20);
  header.setUint32(20 + padded.length, bin.length, true); glb.write('BIN\0', 24 + padded.length, 'ascii');
  bin.copy(glb, 28 + padded.length);
  return { glb, embeddedImageBytes: image.length };
}

function expectedFacts(input, embeddedImageBytes) {
  const key = '4:NORMAL:1;POSITION:0;TEXCOORD_0:2;TEXCOORD_1:3;:undefined';
  const embedded = index => ({ index, source: 'embedded', mime: 'image/png', bytes: embeddedImageBytes });
  const external = { index: 4, source: 'external', mime: 'image/png', uri: 'textures/emissive.png' };
  const samplers = [
    { magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33648 },
    { magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 33071 },
    { magFilter: 9729, minFilter: 9728, wrapS: 33648, wrapT: 10497 },
    { magFilter: 9728, minFilter: 9987, wrapS: 33071, wrapT: 10497 },
    { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }
  ];
  return {
    profile: 'static-pbr-texture-v1', loaderVersion: 'three-0.186.0-gltfloader', input,
    declared: { nodes: 1, meshes: 1, primitives: 1, accessors: 5, bufferViews: 6, materials: 1, textures: 5, images: 5 },
    scene: { index: 0, roots: [0], nodes: [{ index: 0, parentIndex: null, meshIndex: 0, morphTargetCount: 0, morphWeights: null, children: [], transform: { kind: 'trs', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }], maxDepth: 1, objectCount: 2, allocatedObjectCount: 2, drawCalls: 1, triangles: 1 },
    materials: [{
      index: 0, baseColorFactor: [0.25, 0.5, 0.75, 0.8], metallicFactor: 0.4, roughnessFactor: 0.6,
      baseColorTexture: { index: 0, texCoord: 0 }, metallicRoughnessTexture: { index: 1, texCoord: 1 },
      normalTexture: { index: 2, texCoord: 1, scale: 0.75 },
      occlusionTexture: { index: 3, texCoord: 0, strength: 0.6 },
      emissiveTexture: { index: 4, texCoord: 0 }, emissiveFactor: [0.1, 0.2, 0.3],
      alphaMode: 'MASK', alphaCutoff: 0.3, doubleSided: true
    }],
    meshes: [{ index: 0, morphTargetCount: 0, defaultWeights: null }],
    textures: [0, 1, 2, 3, 4].map(index => ({ index, source: index === 4 ? external : embedded(index), sampler: samplers[index] })),
    images: [embedded(0), embedded(1), embedded(2), embedded(3), external],
    resources: {
      geometries: [{ key, material: 0, positionAccessor: 0, normalAccessor: 1, uvAccessors: [{ set: 0, accessor: 2 }, { set: 1, accessor: 3 }],
        morphTargets: [], indexAccessor: 4, mode: null, triangles: 1, positionMin: [0, 0, 0], positionMax: [1, 1, 0] }],
      accessors: [
        { index: 0, viewIndex: 0, componentType: 5126, type: 'VEC3', count: 3, byteOffset: 0, byteLength: 36 },
        { index: 1, viewIndex: 1, componentType: 5126, type: 'VEC3', count: 3, byteOffset: 0, byteLength: 36 },
        { index: 2, viewIndex: 2, componentType: 5126, type: 'VEC2', count: 3, byteOffset: 0, byteLength: 24 },
        { index: 3, viewIndex: 3, componentType: 5126, type: 'VEC2', count: 3, byteOffset: 0, byteLength: 24 },
        { index: 4, viewIndex: 4, componentType: 5123, type: 'SCALAR', count: 3, byteOffset: 0, byteLength: 6 }
      ],
      bufferViews: [
        { index: 0, byteOffset: 0, byteLength: 36 }, { index: 1, byteOffset: 36, byteLength: 36 },
        { index: 2, byteOffset: 72, byteLength: 24 }, { index: 3, byteOffset: 96, byteLength: 24 },
        { index: 4, byteOffset: 120, byteLength: 8 }
      ],
      geometryCount: 1, attributeCount: 5, backingCount: 5, gpuBufferBytes: 126, cpuBackingBytes: 128,
      materialCount: 1, allocatedMaterialCount: 2, programCount: 1, textureCount: 5, imageCount: 5
    }
  };
}

function inputFactsOf(glb) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  let offset = 12, jsonBytes = 0, binBytes = 0;
  while (offset < glb.length) {
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    if (type === 0x4e4f534a) jsonBytes = length;
    else if (type === 0x004e4942) binBytes = length;
    offset += 8 + length;
  }
  return { encodedBytes: glb.length, jsonBytes, binBytes };
}
function expectedPayload({ buffer, ...source }) {
  return { ...source, expected: expectedFacts(inputFactsOf(buffer), source.embeddedImageBytes) };
}

async function main() {
  const image = png(2, 2);
  const main = fixture();
  const variants = {
    missingUv1: fixture({ missingUv1: true }), badSampler: fixture({ badSampler: true }),
    sharedTexture: fixture({ sharedTexture: true }), unmapped: fixture({ unmapped: true }),
    pbrField: fixture({ pbrField: true })
  };
  let externalRequests = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      const html = '<!doctype html><meta charset="utf-8"><script type="importmap">' + JSON.stringify({
        imports: { three: '/tools/space-stage/node_modules/three/build/three.module.js', 'three/addons/': '/tools/space-stage/node_modules/three/examples/jsm/' }
      }) + '</script>';
      response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); return;
    }
    if (url.pathname === '/tex/emissive.png') {
      externalRequests++;
      response.writeHead(200, { 'content-type': 'image/png' }); response.end(image); return;
    }
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
    require('node:fs').readFile(file, (error, bytes) => {
      if (error) { response.writeHead(404); response.end(); return; }
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      response.writeHead(200, { 'content-type': type }); response.end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/');
    const result = await page.evaluate(async payload => {
      const THREE = await import('/tools/space-stage/node_modules/three/build/three.module.js');
      const module = await import('/tools/space-stage/src/composition/model-resource.js');
      const bytes = fromBase64 => Uint8Array.from(atob(fromBase64), c => c.charCodeAt(0)).buffer;
      const disposed = { textures: 0, materials: 0, geometries: 0 };
      for (const [name, prototype] of [['textures', THREE.Texture.prototype], ['materials', THREE.Material.prototype], ['geometries', THREE.BufferGeometry.prototype]]) {
        const original = prototype.dispose;
        prototype.dispose = function () { disposed[name]++; return original.call(this); };
      }
      function ports(input) {
        const state = { pending: { ownedCpuBytes: input.encodedBytes + input.binBytes + input.jsonBytes * 2 + 65536 }, released: false, cancelled: false, allocationEnded: false };
        const uploads = [];
        return { uploads, options: {
          admissions: { cpu: { state: () => state, commit() {}, release() {}, settle() {} } },
          bufferPlan: { cpuReady() {}, upload(attribute) { uploads.push(attribute); return attribute; } },
          textureUrl: uri => uri === 'textures/emissive.png' ? '/tex/emissive.png' : null
        } };
      }
      async function attempt(source) {
        const buffer = bytes(source.glb.toString('base64'));
        const port = ports(source.expected.input);
        return module.parseTexturedModel(buffer, source.expected, port.options).then(resource => ({ resource, port }), error => ({ error: error.message, port }));
      }
      const passed = await attempt(payload.main);
      if (passed.error) return { error: passed.error, stage: 'main' };
      const instance = passed.resource.instantiate();
      const rootObject = instance.root;
      const mesh = []; rootObject.traverse(object => { if (object.isMesh) mesh.push(object); });
      const material = mesh[0].material, map = material.map, metal = material.metalnessMap, roughness = material.roughnessMap;
      const normal = material.normalMap, ao = material.aoMap, emissive = material.emissiveMap;
      const textureFacts = texture => texture && {
        width: texture.image.width, height: texture.image.height, channel: texture.channel,
        wrapS: texture.wrapS, wrapT: texture.wrapT, magFilter: texture.magFilter, minFilter: texture.minFilter,
        flipY: texture.flipY, colorSpace: texture.colorSpace
      };
      const summary = {
        facts: JSON.parse(JSON.stringify(passed.resource.facts)),
        uploads: passed.port.uploads.length,
        objectCount: mesh.length,
        material: {
          color: material.color.toArray(), opacity: material.opacity, metalness: material.metalness, roughness: material.roughness,
          side: material.side, transparent: material.transparent, alphaTest: material.alphaTest, depthWrite: material.depthWrite,
          metalIsRoughness: metal === roughness, hasRoughnessMap: !!roughness, hasMetalnessMap: !!metal,
          normalScale: material.normalScale.toArray(), aoMapIntensity: material.aoMapIntensity,
          emissive: material.emissive.toArray(), hasNormalMap: !!normal, hasAoMap: !!ao, hasEmissiveMap: !!emissive
        },
        map: textureFacts(map),
        metal: textureFacts(metal),
        roughness: textureFacts(roughness),
        normal: textureFacts(normal),
        ao: textureFacts(ao),
        emissive: textureFacts(emissive),
        attributes: Object.keys(mesh[0].geometry.attributes).sort(),
        uv: Array.from(mesh[0].geometry.attributes.uv.array), uv1: Array.from(mesh[0].geometry.attributes.uv1.array)
      };
      rootObject.removeFromParent(); rootObject.clear(); instance.release(); passed.resource.dispose();
      summary.disposed = { ...disposed };
      try { passed.resource.instantiate(); summary.reinstantiated = true; } catch { summary.reinstantiated = false; }
      const negative = {};
      for (const [name, source] of Object.entries(payload.variants)) {
        const value = await attempt(source);
        negative[name] = value.error || 'accepted';
      }
      return { summary, negative };
    }, {
      main: expectedPayload({ buffer: main.glb, glb: main.glb.toString('base64'), embeddedImageBytes: main.embeddedImageBytes }),
      variants: Object.fromEntries(Object.entries(variants).map(([name, value]) =>
        [name, expectedPayload({ buffer: value.glb, glb: value.glb.toString('base64'), embeddedImageBytes: value.embeddedImageBytes })]))
    });
    assert.ok(result.summary, JSON.stringify(result));
    assert.equal(result.summary.facts.profile, 'static-pbr-texture-v1');
    assert.equal(result.summary.uploads, 5);
    assert.equal(result.summary.objectCount, 1);
    assert.deepEqual(result.summary.attributes, ['normal', 'position', 'uv', 'uv1']);
    assert.deepEqual(result.summary.uv, [0, 0, 1, 0, 0, 1]);
    assert.deepEqual(result.summary.uv1, [0, 0, 0.5, 0.5, 1, 1]);
    assert.deepEqual(result.summary.material.color.map(value => Math.round(value * 1000) / 1000), [0.25, 0.5, 0.75]);
    assert.equal(result.summary.material.opacity, 0.8);
    assert.equal(result.summary.material.metalness, 0.4);
    assert.equal(result.summary.material.roughness, 0.6);
    assert.equal(result.summary.material.side, 2);
    assert.equal(result.summary.material.transparent, false);
    assert.equal(result.summary.material.alphaTest, 0.3);
    assert.equal(result.summary.material.depthWrite, true);
    assert.equal(result.summary.material.hasRoughnessMap, true);
    assert.equal(result.summary.material.hasMetalnessMap, true);
    assert.equal(result.summary.material.metalIsRoughness, false);
    assert.deepEqual(result.summary.material.normalScale, [0.75, -0.75]);
    assert.equal(result.summary.material.aoMapIntensity, 0.6);
    assert.deepEqual(result.summary.material.emissive.map(value => Math.round(value * 1000) / 1000), [0.1, 0.2, 0.3]);
    assert.equal(result.summary.material.hasNormalMap, true);
    assert.equal(result.summary.material.hasAoMap, true);
    assert.equal(result.summary.material.hasEmissiveMap, true);
    assert.deepEqual(result.summary.map, { width: 2, height: 2, channel: 0, wrapS: 1001, wrapT: 1002, magFilter: 1006, minFilter: 1008, flipY: false, colorSpace: 'srgb' });
    assert.deepEqual(result.summary.metal, { width: 2, height: 2, channel: 1, wrapS: 1000, wrapT: 1001, magFilter: 1003, minFilter: 1003, flipY: false, colorSpace: '' });
    assert.deepEqual(result.summary.roughness, result.summary.metal);
    assert.deepEqual(result.summary.normal, { width: 2, height: 2, channel: 1, wrapS: 1002, wrapT: 1000, magFilter: 1006, minFilter: 1003, flipY: false, colorSpace: '' });
    assert.deepEqual(result.summary.ao, { width: 2, height: 2, channel: 0, wrapS: 1001, wrapT: 1000, magFilter: 1003, minFilter: 1008, flipY: false, colorSpace: '' });
    assert.deepEqual(result.summary.emissive, { width: 2, height: 2, channel: 0, wrapS: 1000, wrapT: 1000, magFilter: 1006, minFilter: 1008, flipY: false, colorSpace: 'srgb' });
    assert.deepEqual(result.summary.disposed, { textures: 8, materials: 2, geometries: 1 });
    assert.equal(result.summary.reinstantiated, false);
    assert.equal(externalRequests, 1, 'external texture fetched once');
    assert.match(result.negative.missingUv1, /TEXCOORD-required/);
    assert.match(result.negative.badSampler, /sampler-wrap/);
    assert.match(result.negative.sharedTexture, /texture-slot-sharing/);
    assert.match(result.negative.unmapped, /URI-unsupported/);
    assert.match(result.negative.pbrField, /pbr-field-unsupported/);
    assert.equal(externalRequests, 1, 'unmapped URI never fetched');
    assert.deepEqual(errors, []);
    console.log(`textured loader: 2x2 PNG x5, PBR 0.25/0.5/0.75 alpha MASK 0.3, normal .75/ao .6/emissive .1/.2/.3, 5 accessors, ${externalRequests} external request; negative profile/sampler/sharing/URI passed`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exit(1); });
