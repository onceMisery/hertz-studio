// SPDX-License-Identifier: MIT
// This accepts the native compiler/planner projection, never author JSON.
import { resourceKey } from '../resources/pool.js';
import { validateBinding, validateTrack } from './animation.js';
import { planBuiltin } from './builtin.js';
const FONT_ADAPTER_VERSION = 'sfnt-ttf-parser-0.25.1-static-v3';
const RASTER_ADAPTER_VERSION = 'text-raster-v2';
const SVG_ADAPTER_VERSION = 'svg-static-resvg-049-usvg-049-v1';
function checkSvg(asset) {
  if (asset.adapterId !== 'prepared-svg-png') return;
  const hashes = asset.contentKey.split(':');
  if (asset.kind !== 'image' || asset.logicalKind !== 'vector' || asset.representationKind !== 'image'
      || asset.mime !== 'image/png' || !digest(asset.sourceHash) || hashes.length !== 2 || !hashes.every(digest)
      || asset.adapterVersion !== 1 || asset.decodeOptions.svgAdapterVersion !== SVG_ADAPTER_VERSION
      || typeof asset.decodeOptions.svgCanonicalOptions !== 'string' || !Array.isArray(asset.decodeOptions.svgFontDependencies)
      || !/\/prepared\/[0-9a-f]{64}\/render\.png$/.test(asset.url)) throw new Error('composition-svg-preparation-required');
  const options = JSON.parse(asset.decodeOptions.svgCanonicalOptions);
  if (options.clipPolicy !== 'flat-clip-subtree-v1'
      || options.targetFormat !== 'png-rgba8' || options.colorSpace !== 'sRGB-SDR' || options.alpha !== 'straight'
      || options.mipmaps !== false || options.wrap !== 'clamp' || !['color','sprite'].includes(options.usage)
      || options.dpi !== 96 || JSON.stringify(options.languages) !== '["en"]'
      || !options.target || !['cover','contain'].includes(options.target.fit)
      || !['preview','low','medium','high'].includes(options.target.purpose)
      || !Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width > 4096 || asset.height > 4096
      || asset.width * asset.height > 8294400 || asset.decodeOptions.svgFontDependencies.length > 256
      || asset.decodeOptions.svgFontDependencies.some(font => !digest(font.sha256) || font.faceIndex !== 0
        || font.adapterVersion !== FONT_ADAPTER_VERSION || !Array.isArray(font.families) || !font.families.length)
      || options.width !== asset.width || options.height !== asset.height) throw new Error('composition-svg-preparation-required');
}

const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const MODEL_PROFILE = 'static-core-pbr-v1';
const MODEL_TEXTURED_PROFILE = 'static-pbr-texture-v1';
const MODEL_KTX2_PROFILE = 'static-ktx2-texture-v1';
const MODEL_LOADER_VERSION = 'three-0.186.0-gltfloader';
function planCamera(camera) {
  if (!camera || !Array.isArray(camera.position) || !Array.isArray(camera.target)
      || camera.position.length !== 3 || camera.target.length !== 3
      || ![...camera.position, ...camera.target].every(value => Number.isFinite(value) && Math.abs(value) <= 10000)
      || !Number.isFinite(camera.fovDegrees) || camera.fovDegrees < 1 || camera.fovDegrees > 120
      || !Number.isFinite(camera.near) || !Number.isFinite(camera.far)
      || camera.near <= 0 || camera.far <= camera.near || camera.far > 1000000
      || camera.position.every((value, index) => value === camera.target[index]))
    throw new Error('composition-scene3d-camera-invalid');
  return { position: [...camera.position], target: [...camera.target],
    fovDegrees: camera.fovDegrees, near: camera.near, far: camera.far };
}
function checkModelAnimations(facts) {
  const animations = facts.animations, resources = facts.resources, nodes = facts.scene?.nodes;
  if (animations === undefined) {
    if (resources?.animationCount !== undefined || resources?.animationCpuBytes !== undefined)
      throw new Error('composition-model-preparation-required');
    return;
  }
  if (!Array.isArray(animations) || !animations.length || animations.length > 1024
      || resources.animationCount !== animations.length
      || !Number.isSafeInteger(resources.animationCpuBytes) || resources.animationCpuBytes < 1
      || !Array.isArray(resources.animationAccessors) || !resources.animationAccessors.length
      || !Array.isArray(resources.animationBufferViews) || !resources.animationBufferViews.length)
    throw new Error('composition-model-preparation-required');
  const clipNames = new Set();
  let channelCount = 0;
  for (const clip of animations) {
    if (!clip || typeof clip.name !== 'string' || !clip.name || clip.name.length > 128
        || clipNames.has(clip.name) || !Number.isFinite(clip.duration) || clip.duration <= 0
        || !Array.isArray(clip.channels) || !clip.channels.length)
      throw new Error('composition-model-preparation-required');
    clipNames.add(clip.name);
    for (const channel of clip.channels) {
      if (!channel || !Number.isSafeInteger(channel.node) || channel.node < 0 || channel.node >= nodes.length
          || !['translation', 'rotation', 'scale'].includes(channel.path)
          || !['STEP', 'LINEAR', 'CUBICSPLINE'].includes(channel.interpolation)
          || !Number.isSafeInteger(channel.inputAccessor) || channel.inputAccessor < 0
          || !Number.isSafeInteger(channel.outputAccessor) || channel.outputAccessor < 0
          || !Number.isSafeInteger(channel.times) || channel.times < 1
          || !Number.isSafeInteger(channel.values) || channel.values < 1
          || ![3, 4].includes(channel.components))
        throw new Error('composition-model-preparation-required');
      channelCount += 1;
    }
  }
  if (resources.animationChannelCount !== channelCount)
    throw new Error('composition-model-preparation-required');
}
function checkModel(asset) {
  const facts = asset.modelFacts, input = facts?.input, resources = facts?.resources, scene = facts?.scene;
  const ktx2 = facts?.profile === MODEL_KTX2_PROFILE;
  const textured = facts?.profile === MODEL_TEXTURED_PROFILE;
  if (asset.adapterId !== 'three-gltf-loader' || asset.adapterVersion !== 1
      || asset.decodeOptions?.profile !== facts?.profile
      || ![MODEL_PROFILE, MODEL_TEXTURED_PROFILE, MODEL_KTX2_PROFILE].includes(facts?.profile)
      || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 1
      || typeof asset.url !== 'string' || !asset.url
      || facts.loaderVersion !== MODEL_LOADER_VERSION
      || !input || input.encodedBytes !== asset.byteLength
      || !Number.isSafeInteger(input.jsonBytes) || input.jsonBytes < 1
      || !Number.isSafeInteger(input.binBytes) || input.binBytes < 1
      || !Number.isSafeInteger(resources?.gpuBufferBytes) || resources.gpuBufferBytes < 1
      || !Number.isSafeInteger(resources?.cpuBackingBytes) || resources.cpuBackingBytes < 1
      || !Number.isSafeInteger(scene?.drawCalls) || scene.drawCalls < 1
      || !Number.isSafeInteger(scene?.triangles) || scene.triangles < 1)
    throw new Error('composition-model-preparation-required');
  if (!textured && !ktx2) {
    if (facts.materials !== undefined || facts.textures !== undefined || facts.images !== undefined
        || facts.declared?.materials || facts.declared?.textures || facts.declared?.images
        || asset.textureUploadBytes !== undefined || asset.textureUrls !== undefined)
      throw new Error('composition-model-preparation-required');
    checkModelAnimations(facts);
    return;
  }
  const images = facts.images, materials = facts.materials, textures = facts.textures;
  if (!Array.isArray(images) || !images.length || !Array.isArray(materials) || !materials.length
      || !Array.isArray(textures) || !textures.length
      || resources.textureCount !== textures.length || resources.imageCount !== images.length)
    throw new Error('composition-model-preparation-required');
  if (ktx2) {
    for (const image of images) {
      const transcoded = image?.transcode === true;
      if (image?.mime !== 'image/ktx2'
          || !Number.isSafeInteger(image.width) || image.width < 1 || image.width > 16384
          || !Number.isSafeInteger(image.height) || image.height < 1 || image.height > 16384
          || (transcoded ? image.vkFormat !== 0 || !Number.isSafeInteger(image.rgbaBytes)
            || image.rgbaBytes < image.levelCount * 4 : ![37, 43].includes(image.vkFormat))
          || typeof image.srgb !== 'boolean'
          || !Number.isSafeInteger(image.levelCount) || image.levelCount < 1 || image.levelCount > 15
          || !Array.isArray(image.levelByteLengths) || image.levelByteLengths.length !== image.levelCount
          || image.levelByteLengths.some(bytes => !Number.isSafeInteger(bytes) || bytes < 1)
          || !Number.isSafeInteger(image.uploadBytes)
          || image.uploadBytes !== (transcoded ? image.rgbaBytes
            : image.levelByteLengths.reduce((sum, bytes) => sum + bytes, 0)))
        throw new Error('composition-model-preparation-required');
    }
    if (!Number.isSafeInteger(resources.imageUploadBytes)
        || resources.imageUploadBytes !== images.reduce((sum, image) => sum + image.uploadBytes, 0)
        || asset.textureUploadBytes !== resources.imageUploadBytes)
      throw new Error('composition-model-preparation-required');
  } else if (!Number.isSafeInteger(asset.textureUploadBytes) || asset.textureUploadBytes < images.length * 4) {
    throw new Error('composition-model-preparation-required');
  }
  const external = images.filter(image => image?.source === 'external');
  const urls = asset.textureUrls;
  if (!urls || typeof urls !== 'object' || Array.isArray(urls)
      || Object.keys(urls).length !== external.length
      || external.some(image => typeof image.uri !== 'string' || typeof urls[image.uri] !== 'string' || !urls[image.uri]))
    throw new Error('composition-model-texture-url-required');
  checkModelAnimations(facts);
}
function modelConstructionBytes(facts) {
  return facts.input.encodedBytes + facts.input.binBytes + facts.input.jsonBytes * 2
    + (facts.resources.animationCpuBytes || 0);
}
function fontCpuBytes(asset) {
  const facts = asset.fontMetadata;
  if (asset.adapterId !== 'prepared-sfnt-font' || asset.adapterVersion !== 1
      || asset.decodeOptions?.fontAdapterVersion !== FONT_ADAPTER_VERSION
      || facts?.format !== 'ttf' || asset.byteLength > 16 * 1024 * 1024
      || facts.sfntBytes !== asset.byteLength || !Number.isSafeInteger(facts.glyphCount)
      || facts.glyphCount < 1 || facts.glyphCount > 65535
      || typeof facts.probeText !== 'string' || !facts.probeText || [...facts.probeText].length > 32
      || facts.cpuBudgetBytes !== 5 * asset.byteLength + 64 * facts.glyphCount + 4096)
    throw new Error('composition-font-preparation-required');
  return facts.cpuBudgetBytes;
}
export function projectValues(ir, finalPublicValues) {
  if (!ir || ir.compilerVersion !== 1 || finalPublicValues?.semanticKey !== ir.semanticKey)
    throw new Error('composition-semantic-identity-mismatch');
  const numeric = new Float64Array(ir.numericSlots.map(slot => slot.value));
  const constants = ir.constantSlots.map(slot => slot.value);
  if (Object.keys(finalPublicValues.values).length !== ir.publicProperties.length)
    throw new Error('composition-final-values-required');
  for (const property of ir.publicProperties) {
    if (!Object.hasOwn(finalPublicValues.values, property.descriptor.id)) throw new Error('composition-final-values-required');
    const value = finalPublicValues.values[property.descriptor.id], target = property.target;
    if (target.kind === 'numeric') numeric[target.slot] = value;
    if (target.kind === 'constant') constants[target.slot] = value;
  }
  return { numeric, constants };
}
export function compilePlan(projection, registry = null, identity = null) {
  const { ir, finalPublicValues, canvas, timeline, target, resolvedAssets, sessionId, generation } = projection || {};
  if (!sessionId || !Number.isSafeInteger(generation) || !target || !Number.isSafeInteger(target.budgetAllocationRevision)
      || !Number.isFinite(target.budgetFps) || target.budgetFps < 1 || !canvas || !timeline
      || !Array.isArray(resolvedAssets)) throw new Error('composition-preparation-projection-required');
  const values = projectValues(ir, finalPublicValues);
  if (projection.semanticKey !== ir.semanticKey) throw new Error('composition-semantic-identity-mismatch');
  const outputEffects = [], nodeEffects = new Map(), effectNodes = new Map();
  let outputGlow = null;
  const nodeIndices = new Map(ir.nodes.map((node, index) => [node.id, index]));
  const graphic3d = ir.nodes.some(node => node.nodeType !== 'builtinScene' && node.space === '3d');
  if (graphic3d && !canvas.scene3d) throw new Error('composition-adapter-unavailable:scene3d-required');
  const camera = graphic3d ? planCamera(canvas.scene3d) : null;
  if (graphic3d) {
    let seen2d = false;
    for (const index of ir.painterOrder) {
      const node = ir.nodes[index];
      if (node.nodeType === 'builtinScene') continue;
      if (node.space === '3d') { if (seen2d) throw new Error('composition-adapter-unavailable:cross-space-order'); }
      else seen2d = true;
    }
  }
  for (const [effectIndex, effect] of ir.effects.entries()) {
    const target = effect.target;
    if (effect.type === 'colorAdjust') {
      if (target.kind !== 'output' && target.kind !== 'node')
        throw new Error(`composition-adapter-unavailable:effect:${effect.type}:${target.kind}`);
      const properties = effect.properties || {};
      if (Object.keys(properties).length !== 4
        || !['brightness', 'contrast', 'saturation', 'hueDegrees'].every(name => Number.isFinite(properties[name])))
        throw new Error('composition-effect-properties-invalid');
      if (effect.assets && Object.keys(effect.assets).length) throw new Error('composition-effect-assets-invalid');
      const grade = { brightness: properties.brightness, contrast: properties.contrast,
        saturation: properties.saturation, hueDegrees: properties.hueDegrees };
      if (target.kind === 'output') { outputEffects.push(grade); continue; }
      const index = nodeIndices.get(target.nodeId);
      if (index === undefined) throw new Error('composition-effect-target-invalid');
      if (!['image', 'video', 'text', 'particles'].includes(ir.nodes[index].nodeType))
        throw new Error(`composition-adapter-unavailable:effect-target:${ir.nodes[index].nodeType}`);
      const effects = nodeEffects.get(index) || {};
      if (effects.colorAdjust) throw new Error('composition-adapter-unavailable:effect-chain');
      effects.colorAdjust = grade;
      nodeEffects.set(index, effects);
      continue;
    }
    if (effect.type === 'glow') {
      if (target.kind !== 'output')
        throw new Error(`composition-adapter-unavailable:effect:${effect.type}:${target.kind}`);
      const properties = effect.properties || {};
      if (Object.keys(properties).length !== 3
        || !['strength', 'radius', 'threshold'].every(name => Number.isFinite(properties[name])))
        throw new Error('composition-effect-properties-invalid');
      if (effect.assets && Object.keys(effect.assets).length) throw new Error('composition-effect-assets-invalid');
      if (outputGlow) throw new Error('composition-adapter-unavailable:effect-chain');
      const surfaces = ir.effectSurfaces?.[effectIndex];
      const requirement = ir.staticRequirements?.find(item =>
        item.kind === 'effectSurfaces' && item.effectIndex === effectIndex), cost = requirement?.cost;
      if (surfaces !== 2 || !requirement || requirement.count !== 2 || requirement.inputTextures !== 1
          || requirement.outputFormat !== 'rgba8'
          || !Number.isFinite(requirement.sampleScale) || requirement.sampleScale <= 0 || requirement.sampleScale > 1
          || !cost || cost.surfaces !== 2 || cost.drawPasses !== 3 || cost.bytesPerPixel !== 4)
        throw new Error('composition-effect-surface-plan-invalid');
      outputGlow = { strength: properties.strength, radius: properties.radius,
        threshold: properties.threshold, sampleScale: requirement.sampleScale };
      continue;
    }
    if (!['ripple', 'wind', 'mask'].includes(effect.type))
      throw new Error(`composition-adapter-unavailable:effect:${effect.type}:${target.kind}`);
    if (target.kind !== 'node')
      throw new Error(`composition-adapter-unavailable:effect:${effect.type}:${target.kind}`);
    const index = nodeIndices.get(target.nodeId);
    if (index === undefined) throw new Error('composition-effect-target-invalid');
    if (!['image', 'video', 'text', 'particles'].includes(ir.nodes[index].nodeType))
      throw new Error(`composition-adapter-unavailable:effect-target:${ir.nodes[index].nodeType}`);
    const properties = effect.properties || {}, effects = nodeEffects.get(index) || {};
    if (effects[effect.type]) throw new Error('composition-adapter-unavailable:effect-chain');
    if (effect.type === 'mask') {
      const assets = effect.assets || {};
      if (Object.keys(properties).length !== 1 || typeof properties.invert !== 'boolean')
        throw new Error('composition-effect-properties-invalid');
      if (Object.keys(assets).length !== 1 || typeof assets.maskAsset !== 'string')
        throw new Error('composition-effect-assets-invalid');
      effects.mask = { invert: properties.invert };
    } else {
      if (effect.assets && Object.keys(effect.assets).length) throw new Error('composition-effect-assets-invalid');
      const names = effect.type === 'ripple'
        ? ['amplitude', 'frequency', 'speed'] : ['strength', 'speed', 'directionDegrees'];
      if (Object.keys(properties).length !== names.length || !names.every(name => Number.isFinite(properties[name])))
        throw new Error('composition-effect-properties-invalid');
      effects[effect.type] = effect.type === 'ripple'
        ? { amplitude: properties.amplitude, frequency: properties.frequency, speed: properties.speed }
        : { strength: properties.strength, speed: properties.speed, directionDegrees: properties.directionDegrees };
    }
    nodeEffects.set(index, effects);
    effectNodes.set(effectIndex, index);
  }
  if (outputEffects.length > 1) throw new Error('composition-adapter-unavailable:effect-chain');
  for (const binding of ir.bindings) {
    const invalid = validateBinding(binding, ir.numericSlots, ir.inputs.length);
    if (invalid) throw new Error(invalid);
    const slot = ir.numericSlots[binding.targetSlot];
    if (slot && ir.nodes[slot.nodeIndex]?.space === '3d')
      throw new Error('composition-adapter-unavailable:binding-3d');
  }
  const bindingParameters = ir.bindings.map(binding => binding.parameters.map(pair => pair[1]));
  for (const property of ir.publicProperties) {
    const target = property.target;
    if (target.kind !== 'bindingParameter') continue;
    const parameters = bindingParameters[target.bindingIndex];
    if (!parameters || !Number.isSafeInteger(target.parameterIndex) || target.parameterIndex < 0
      || target.parameterIndex >= parameters.length) throw new Error('composition-binding-target-invalid');
    const value = finalPublicValues.values[property.descriptor.id];
    if (!Number.isFinite(value)) throw new Error('composition-final-values-required');
    parameters[target.parameterIndex] = value;
  }
  for (const track of ir.tracks) {
    const invalid = validateTrack(track, ir.numericSlots);
    if (invalid) throw new Error(invalid);
    const slot = ir.numericSlots[track.targetSlot];
    const node = ir.nodes[slot.nodeIndex];
    if (!node) throw new Error('composition-track-target-invalid');
    if (node.nodeType === 'builtinScene') throw new Error('composition-adapter-unavailable:track-builtin');
    if (node.space === '3d') throw new Error('composition-adapter-unavailable:track-3d');
    if ((node.nodeType === 'text' && ['width', 'height', 'fontSize', 'lineHeight'].includes(slot.property))
      || (node.nodeType === 'particles' && ['count', 'seed'].includes(slot.property)))
      throw new Error('composition-adapter-unavailable:track-rebuild');
  }
  if (!['contain', 'cover', 'stretch'].includes(target.fit || 'cover')) throw new Error('composition-target-fit-invalid');
  const builtin = planBuiltin(projection,values,registry,identity);
  const supported = new Set(['image', 'video', 'text', 'group', 'particles', 'model']);
  for (const node of ir.nodes) {
    if (node.nodeType === 'builtinScene') continue;
    if (!supported.has(node.nodeType)
        || (node.space !== '2d' && (node.space !== '3d' || !['group', 'model'].includes(node.nodeType))))
      throw new Error(`composition-adapter-unavailable:${node.nodeType}:${node.space}`);
  }
  const number = (node, name) => values.numeric[node.propertySlots[name]?.[0]];
  const constant = (node, name) => values.constants[node.constantSlots[name]];
  const assets = new Map();
  for (const asset of resolvedAssets) {
    if (!asset.assetId || !asset.contentKey || !asset.url || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 1
        || !asset.adapterId || !Number.isSafeInteger(asset.adapterVersion) || asset.adapterVersion < 1 || !asset.decodeOptions)
      throw new Error('composition-resolved-metadata-required');
    if (/\.svg(?:[?#]|$)/i.test(asset.url) || asset.mime === 'image/svg+xml') throw new Error('composition-svg-preparation-required');
    const representation = asset.representationId || asset.assetId;
    if (assets.has(representation)) throw new Error('composition-resource-closure-duplicate');
    checkSvg(asset);
    if (asset.kind === 'font') fontCpuBytes(asset);
    if (asset.kind === 'model') checkModel(asset);
    assets.set(representation, asset);
  }
  const uses = finalPublicValues.resourceUses, nodeResources = ir.nodes.map(() => ({}));
  const unique = new Map(), modelUses = new Map();
  if (projection.resolvedUses && (!Array.isArray(projection.resolvedUses) || projection.resolvedUses.length !== uses.length)) throw new Error('composition-resource-closure-mismatch');
  for (const [useIndex, use] of uses.entries()) {
    const asset = assets.get(projection.resolvedUses?.[useIndex] || use.assetId);
    if (asset?.assetId !== use.assetId) throw new Error('composition-resource-logical-identity-mismatch');
    const effectTarget = use.effectIndex == null ? null : effectNodes.get(use.effectIndex);
    const targetIndex = effectTarget ?? use.nodeIndex;
    if (!asset || !Number.isSafeInteger(targetIndex)
        || (effectTarget !== null && (use.nodeIndex !== null || use.field !== 'maskAsset')))
      throw new Error('composition-resource-closure-mismatch');
    if (['vector', 'texture'].includes(asset.kind) || /glb|ktx/i.test(asset.adapterId))
      throw new Error(`composition-adapter-unavailable:${asset.kind}:${asset.adapterId}`);
    if (!['image', 'video', 'font', 'model'].includes(asset.kind)) throw new Error(`composition-adapter-unavailable:${asset.kind}`);
    if (asset.kind !== 'font' && asset.kind !== 'model'
        && (!Number.isSafeInteger(asset.width) || asset.width < 1 || !Number.isSafeInteger(asset.height) || asset.height < 1))
      throw new Error('composition-real-dimensions-required');
    const node = ir.nodes[targetIndex];
    if (!node) throw new Error('composition-resource-node-invalid');
    if (asset.kind === 'model') {
      if (effectTarget !== null || use.field !== 'asset' || use.usage !== 'model' || node.nodeType !== 'model')
        throw new Error('composition-model-preparation-required');
      modelUses.set(asset.assetId, (modelUses.get(asset.assetId) || 0) + 1);
    }
    if (asset.logicalKind === 'vector' && (asset.adapterId !== 'prepared-svg-png' || !['color','sprite'].includes(use.usage)
        || JSON.parse(asset.decodeOptions.svgCanonicalOptions).usage !== use.usage)) throw new Error('composition-svg-preparation-required');
    let clock = null;
    if (asset.kind === 'video') {
      const start = number(node, 'loopStartMs'), end = number(node, 'loopEndMs');
      if (!Number.isFinite(asset.durationMs) || start < 0 || end <= start || end > asset.durationMs)
        throw new Error('composition-video-range-exceeds-duration');
      clock = { sessionId, clockDomain: projection.clockDomain || sessionId, loopStartMs: start, loopEndMs: end, seekStrategy: 'absolute' };
    }
    const decodeOptions = { ...asset.decodeOptions, usage: use.usage, ...(clock ? { clock } : {}) };
    const identity = { contentKey: asset.contentKey, decodeOptions, adapterId: asset.adapterId, adapterVersion: asset.adapterVersion };
    const key = resourceKey(identity,'target-plan');
    const requirement = unique.get(key) || { ...asset, key, identity, usage: use.usage, clock };
    // A node schema mask and a mask effect would compete for the same sampling
    // slot; accept only one source until their composition semantics are fixed.
    if (effectTarget !== null && nodeResources[targetIndex].maskAsset)
      throw new Error('composition-adapter-unavailable:effect-chain');
    unique.set(key, requirement); nodeResources[targetIndex][use.field] = requirement;
  }
  // One GLB resource owns one construction and one buffer plan. Shared model
  // nodes would upload through only the first node scope, so fail closed.
  if ([...modelUses.values()].some(count => count > 1))
    throw new Error('composition-adapter-unavailable:model-sharing');
  const pixels = target.width * target.height;
  if (!Number.isSafeInteger(pixels) || pixels < 1 || !Number.isSafeInteger(canvas.width * canvas.height)
      || canvas.width < 1 || canvas.height < 1) throw new Error('composition-output-plan-invalid');
  if (outputGlow) {
    outputGlow.width = Math.max(1, Math.ceil(target.width * outputGlow.sampleScale));
    outputGlow.height = Math.max(1, Math.ceil(target.height * outputGlow.sampleScale));
  }
  const resources = { renderTargetDeclaredBytes: pixels * 8 + (outputGlow ? outputGlow.width * outputGlow.height * 8 : 0),
    textureDeclaredBytes: 0, bufferDeclaredBytes: 92,
    ownedCpuBytes: 92, decodeReservedBytes: 0, decoderLeases: 0, canvases: 0, drawingBufferPixels: 0,
    programs: outputGlow ? 4 : 2 };
  if (graphic3d) resources.renderTargetDeclaredBytes += pixels * 4;
  const primitives = {drawCalls:1,points:0,triangles:2};
  if (outputGlow) { primitives.drawCalls += 3; primitives.triangles += 6; }
  if (builtin) {
    const source=builtin.profile.sourceResources;
    resources.renderTargetDeclaredBytes += pixels*4;
    resources.bufferDeclaredBytes += source.bufferBytes;
    resources.ownedCpuBytes += source.cpuPeakBytes+builtin.clock.inputBytes;
    resources.programs += source.programs;
    for (const key of Object.keys(primitives)) primitives[key] += builtin.profile.sourcePrimitives[key];
  }
  for (const requirement of unique.values()) {
    if (requirement.kind === 'font') { resources.ownedCpuBytes += fontCpuBytes(requirement); continue; }
    if (requirement.kind === 'model') {
      const facts = requirement.modelFacts;
      const textured = facts.profile === MODEL_TEXTURED_PROFILE || facts.profile === MODEL_KTX2_PROFILE;
      resources.bufferDeclaredBytes += facts.resources.gpuBufferBytes;
      resources.ownedCpuBytes += modelConstructionBytes(facts) + facts.resources.cpuBackingBytes;
      resources.programs += Math.max(1, textured ? facts.materials.length : 1);
      if (textured) {
        resources.textureDeclaredBytes += requirement.textureUploadBytes;
        resources.decodeReservedBytes += requirement.textureUploadBytes;
      }
      primitives.drawCalls += facts.scene.drawCalls;
      primitives.triangles += facts.scene.triangles;
      continue;
    }
    const bytes = requirement.width * requirement.height * 4;
    resources.textureDeclaredBytes += bytes;
    resources.decodeReservedBytes += bytes;
    if (requirement.kind === 'video') { resources.decoderLeases++; resources.decodeReservedBytes += bytes * 2; }
  }
  const nodePlans = ir.nodes.map((node, index) => {
    const result = { index, node, resources: nodeResources[index], number: name => number(node, name), constant: name => constant(node, name) };
    if (node.nodeType !== 'group' && node.nodeType !== 'particles' && node.nodeType !== 'builtinScene' && node.nodeType !== 'model') {
      resources.bufferDeclaredBytes += 92; resources.ownedCpuBytes += 92; primitives.drawCalls++;primitives.triangles+=2;
    }
    if (node.space === '3d') {
      const opacity = number(node, 'opacity');
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
        throw new Error('composition-adapter-unavailable:3d-opacity');
    }
    if (node.nodeType === 'model') {
      if (!result.resources.asset) throw new Error('composition-model-preparation-required');
      const clip = constant(node, 'animationClip');
      if (typeof clip !== 'string' || clip.length > 128)
        throw new Error('composition-adapter-unavailable:model-animation');
      if (clip !== '') {
        const animations = result.resources.asset.modelFacts.animations;
        if (!Array.isArray(animations) || !animations.some(item => item.name === clip))
          throw new Error('composition-adapter-unavailable:model-animation');
        result.animation = clip;
      }
      result.materialBytes = Math.max(1, result.resources.asset.modelFacts.resources.materialCount || 1) * 1024;
      resources.ownedCpuBytes += result.materialBytes;
      result.model = true;
    }
    if (node.nodeType === 'text') {
      if (!result.resources.fontAsset) throw new Error('composition-font-preparation-required');
      const text = constant(node, 'text');
      if (typeof text !== 'string' || text.length > 4096)
        throw new Error('composition-text-layout-plan-invalid');
    }
    if (node.nodeType === 'particles') {
      result.count = number(node, 'count');
      if (!Number.isSafeInteger(result.count) || result.count < 0 || result.count > 65536) throw new Error('composition-particle-count-invalid');
      resources.bufferDeclaredBytes += result.count * 20; resources.ownedCpuBytes += result.count * 20;
      primitives.drawCalls++;primitives.points+=result.count;
      resources.programs = Math.max(resources.programs,builtin?7:3);
    }
    return result;
  });
  for (const [index, effects] of nodeEffects) nodePlans[index].effects = effects;
  const textRasters = [], coveredNodes = new Set(), rasterKeys = new Set();
  const rasterFacts = projection.textRasters || [];
  if (!Array.isArray(rasterFacts) || rasterFacts.length > ir.nodes.length)
    throw new Error('composition-text-raster-projection-required');
  for (const fact of rasterFacts) {
    if (!fact || !digest(fact.rasterKey) || !digest(fact.fontContentKey)
        || rasterKeys.has(fact.rasterKey) || fact.adapterId !== 'prepared-text-raster'
        || fact.adapterVersion !== RASTER_ADAPTER_VERSION
        || !Array.isArray(fact.nodeIndices) || !fact.nodeIndices.length || fact.nodeIndices.length > ir.nodes.length
        || !Number.isFinite(fact.logicalWidth) || fact.logicalWidth <= 0
        || !Number.isFinite(fact.logicalHeight) || fact.logicalHeight <= 0
        || !Number.isFinite(fact.scale) || fact.scale < 1 / 64 || !Number.isSafeInteger(fact.scale * 64)
        || !Number.isSafeInteger(fact.widthPx) || fact.widthPx < 1 || fact.widthPx > 4096
        || !Number.isSafeInteger(fact.heightPx) || fact.heightPx < 1 || fact.heightPx > 4096
        || fact.widthPx * fact.heightPx > 8294400
        || fact.widthPx !== Math.max(1, Math.ceil(fact.logicalWidth * fact.scale))
        || fact.heightPx !== Math.max(1, Math.ceil(fact.logicalHeight * fact.scale)))
      throw new Error('composition-text-raster-plan-invalid');
    const representative = assets.get(fact.fontAssetId);
    if (representative?.kind !== 'font' || representative.contentKey !== fact.fontContentKey)
      throw new Error('composition-text-raster-font-mismatch');
    let first = null;
    for (const index of fact.nodeIndices) {
      const spec = Number.isSafeInteger(index) ? nodePlans[index] : null;
      if (!spec || spec.node.nodeType !== 'text' || coveredNodes.has(index)
          || spec.resources.fontAsset?.kind !== 'font' || spec.resources.fontAsset.contentKey !== fact.fontContentKey
          || spec.number('width') !== fact.logicalWidth || spec.number('height') !== fact.logicalHeight)
        throw new Error('composition-text-raster-consumer-mismatch');
      if (first && (['text', 'color', 'align'].some(field => first.constant(field) !== spec.constant(field))
          || ['fontSize', 'lineHeight'].some(field => first.number(field) !== spec.number(field))))
        throw new Error('composition-text-raster-style-mismatch');
      first ||= spec; coveredNodes.add(index);
    }
    const identity = { contentKey: fact.rasterKey, adapterId: fact.adapterId, adapterVersion: 1,
      decodeOptions: { rasterVersion: fact.adapterVersion, fontContentKey: fact.fontContentKey,
        widthPx: fact.widthPx, heightPx: fact.heightPx, scale: fact.scale } };
    const requirement = { ...fact, key: resourceKey(identity, 'target-plan'), identity,
      fontRequirement: first.resources.fontAsset, text: first.constant('text'),
      fontSize: first.number('fontSize'), color: first.constant('color'), align: first.constant('align'),
      lineHeight: first.number('lineHeight') };
    for (const index of fact.nodeIndices) nodePlans[index].textRaster = requirement;
    rasterKeys.add(fact.rasterKey); textRasters.push(requirement);
    const rasterPixels = fact.widthPx * fact.heightPx;
    resources.canvases++; resources.drawingBufferPixels += rasterPixels;
    resources.ownedCpuBytes += rasterPixels * 4; resources.textureDeclaredBytes += rasterPixels * 4;
  }
  if (nodePlans.some(spec => spec.node.nodeType === 'text' && !coveredNodes.has(spec.index)))
    throw new Error('composition-text-raster-projection-required');
  if (builtin) {
    if (primitives.drawCalls>builtin.profile.drawCalls || primitives.points>builtin.profile.particles
        || primitives.triangles>builtin.profile.triangles) throw new Error('composition-builtin-primitive-budget');
    const gpu=pixels*20+resources.textureDeclaredBytes+resources.bufferDeclaredBytes
      + [...unique.values()].filter(value=>value.kind==='video').reduce((sum,value)=>sum+value.width*value.height*4,0)+96;
    if (gpu>builtin.profile.memoryBytes || resources.ownedCpuBytes+resources.decodeReservedBytes>builtin.profile.memoryBytes)
      throw new Error('composition-builtin-complete-memory-budget');
    const limits=projection.pageLimits;
    for (const key of ['bufferDeclaredBytes','ownedCpuBytes','textureDeclaredBytes','decodeReservedBytes','decoderLeases','programs','canvases'])
      if (!limits || limits[key] !== resources[key]) throw new Error('composition-builtin-page-projection-mismatch:'+key);
    if (limits.renderTargetDeclaredBytes !== resources.renderTargetDeclaredBytes+pixels*8
        || limits.drawingBufferPixels !== resources.drawingBufferPixels+pixels || limits.gpuContexts !== 1)
      throw new Error('composition-builtin-page-projection-mismatch:output');
  }
  return { projection, ir, values, nodePlans, requirements: [...unique.values()], textRasters, resources, pixels, builtin, primitives, bindingParameters, outputEffects, outputGlow, camera, has3d: graphic3d };
}
