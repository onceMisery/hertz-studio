// SPDX-License-Identifier: MIT
// This accepts the native compiler/planner projection, never author JSON.
import { resourceKey } from '../resources/pool.js';
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
    if (assets.has(asset.assetId)) throw new Error('composition-resource-closure-duplicate');
    assets.set(asset.assetId, asset);
  }
  const uses = finalPublicValues.resourceUses, nodeResources = ir.nodes.map(() => ({}));
  const unique = new Map();
  for (const use of uses) {
    const asset = assets.get(use.assetId);
    if (!asset || use.effectIndex !== null || !Number.isSafeInteger(use.nodeIndex)) throw new Error('composition-resource-closure-mismatch');
    if (['vector', 'model', 'texture'].includes(asset.kind) || /svg|glb|ktx/i.test(asset.adapterId))
      throw new Error(`composition-adapter-unavailable:${asset.kind}:${asset.adapterId}`);
    if (!['image', 'video', 'font'].includes(asset.kind)) throw new Error(`composition-adapter-unavailable:${asset.kind}`);
    if (asset.kind !== 'font' && (!Number.isSafeInteger(asset.width) || asset.width < 1 || !Number.isSafeInteger(asset.height) || asset.height < 1))
      throw new Error('composition-real-dimensions-required');
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
    if (requirement.kind === 'font') { resources.ownedCpuBytes += requirement.byteLength; continue; }
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
      const width = Math.ceil(number(node, 'width')), height = Math.ceil(number(node, 'height')), text = constant(node, 'text');
      if (typeof text !== 'string' || text.length > 4096 || width * height > 16384 * 16384)
        throw new Error('composition-text-layout-plan-invalid');
      result.textWidth = width; result.textHeight = height;
      resources.canvases++; resources.drawingBufferPixels += width * height;
      resources.ownedCpuBytes += width * height * 4; resources.textureDeclaredBytes += width * height * 4;
    }
    if (node.nodeType === 'particles') {
      result.count = number(node, 'count');
      if (!Number.isSafeInteger(result.count) || result.count < 0 || result.count > 65536) throw new Error('composition-particle-count-invalid');
      resources.bufferDeclaredBytes += result.count * 20; resources.ownedCpuBytes += result.count * 20;
      resources.programs = 3;
    }
    return result;
  });
  return { projection, ir, values, nodePlans, requirements: [...unique.values()], resources, pixels };
}
