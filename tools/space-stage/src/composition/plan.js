// SPDX-License-Identifier: MIT
// This accepts the native compiler/planner projection, never author JSON.
import { resourceKey } from '../resources/pool.js';
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
export function compilePlan(projection) {
  const { ir, finalPublicValues, canvas, timeline, target, resolvedAssets, sessionId, generation } = projection || {};
  if (!sessionId || !Number.isSafeInteger(generation) || !target || !Number.isSafeInteger(target.budgetAllocationRevision)
      || !Number.isFinite(target.budgetFps) || target.budgetFps < 1 || !canvas || !timeline
      || !Array.isArray(resolvedAssets)) throw new Error('composition-preparation-projection-required');
  const values = projectValues(ir, finalPublicValues);
  if (projection.semanticKey !== ir.semanticKey) throw new Error('composition-semantic-identity-mismatch');
  if (ir.effects.length) throw new Error('composition-adapter-unavailable:effects');
  if (ir.tracks.length) throw new Error('composition-adapter-unavailable:tracks');
  if (ir.bindings.length) throw new Error('composition-adapter-unavailable:bindings');
  if (!['contain', 'cover', 'stretch'].includes(target.fit || 'cover')) throw new Error('composition-target-fit-invalid');
  const supported = new Set(['image', 'video', 'text', 'group', 'particles']);
  for (const node of ir.nodes) if (!supported.has(node.nodeType) || node.space !== '2d')
    throw new Error(`composition-adapter-unavailable:${node.nodeType}:${node.space}`);
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
    assets.set(representation, asset);
  }
  const uses = finalPublicValues.resourceUses, nodeResources = ir.nodes.map(() => ({}));
  const unique = new Map();
  if (projection.resolvedUses && (!Array.isArray(projection.resolvedUses) || projection.resolvedUses.length !== uses.length)) throw new Error('composition-resource-closure-mismatch');
  for (const [useIndex, use] of uses.entries()) {
    const asset = assets.get(projection.resolvedUses?.[useIndex] || use.assetId);
    if (asset?.assetId !== use.assetId) throw new Error('composition-resource-logical-identity-mismatch');
    if (!asset || use.effectIndex !== null || !Number.isSafeInteger(use.nodeIndex)) throw new Error('composition-resource-closure-mismatch');
    if (['vector', 'model', 'texture'].includes(asset.kind) || /glb|ktx/i.test(asset.adapterId))
      throw new Error(`composition-adapter-unavailable:${asset.kind}:${asset.adapterId}`);
    if (!['image', 'video', 'font'].includes(asset.kind)) throw new Error(`composition-adapter-unavailable:${asset.kind}`);
    if (asset.kind !== 'font' && (!Number.isSafeInteger(asset.width) || asset.width < 1 || !Number.isSafeInteger(asset.height) || asset.height < 1))
      throw new Error('composition-real-dimensions-required');
    if (asset.logicalKind === 'vector' && (asset.adapterId !== 'prepared-svg-png' || !['color','sprite'].includes(use.usage)
        || JSON.parse(asset.decodeOptions.svgCanonicalOptions).usage !== use.usage)) throw new Error('composition-svg-preparation-required');
    const node = ir.nodes[use.nodeIndex];
    if (!node) throw new Error('composition-resource-node-invalid');
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
    unique.set(key, requirement); nodeResources[use.nodeIndex][use.field] = requirement;
  }
  const pixels = target.width * target.height;
  if (!Number.isSafeInteger(pixels) || pixels < 1 || !Number.isSafeInteger(canvas.width * canvas.height)
      || canvas.width < 1 || canvas.height < 1) throw new Error('composition-output-plan-invalid');
  const resources = { renderTargetDeclaredBytes: pixels * 8, textureDeclaredBytes: 0, bufferDeclaredBytes: 92,
    ownedCpuBytes: 92, decodeReservedBytes: 0, decoderLeases: 0, canvases: 0, drawingBufferPixels: 0, programs: 2 };
  for (const requirement of unique.values()) {
    if (requirement.kind === 'font') { resources.ownedCpuBytes += fontCpuBytes(requirement); continue; }
    const bytes = requirement.width * requirement.height * 4;
    resources.textureDeclaredBytes += bytes;
    resources.decodeReservedBytes += bytes;
    if (requirement.kind === 'video') { resources.decoderLeases++; resources.decodeReservedBytes += bytes * 2; }
  }
  const nodePlans = ir.nodes.map((node, index) => {
    const result = { index, node, resources: nodeResources[index], number: name => number(node, name), constant: name => constant(node, name) };
    if (node.nodeType !== 'group' && node.nodeType !== 'particles') { resources.bufferDeclaredBytes += 92; resources.ownedCpuBytes += 92; }
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
      resources.programs = 3;
    }
    return result;
  });
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
  return { projection, ir, values, nodePlans, requirements: [...unique.values()], textRasters, resources, pixels };
}
