// SPDX-License-Identifier: MIT
// Fixed non-cyclic effect metadata. Runtime material/pass admission is separate.
const number = (value, min, max) => ({ type: 'number', default: value, min, max, animatable: false });
const planar = ['image', 'video', 'text', 'particles'];
const effect = (type, targets, properties, assets = {}, surfaces = 0) => ({
  type, stateVersion: 1, targets, properties, assets,
  inputTextures: 1 + Object.keys(assets).length, outputFormat: 'rgba8', sampleScale: surfaces ? 0.5 : 1,
  history: false, quality: { low: { sampleScale: surfaces ? 0.25 : 1 },
    medium: { sampleScale: surfaces ? 0.5 : 1 }, high: { sampleScale: surfaces ? 0.5 : 1 } },
  cost: { ...(targets.some(target => target !== 'output') ? { node: { surfaces: 0, drawPasses: 0, bytesPerPixel: 4 } } : {}),
    ...(targets.includes('output') ? { output: { surfaces: surfaces || 1, drawPasses: surfaces ? 3 : 1, bytesPerPixel: 4 } } : {}) }
});
export const effectDefinitions = [
  effect('colorAdjust', [...planar, 'output'], { brightness: number(0, -1, 1), contrast: number(1, 0, 4),
    saturation: number(1, 0, 4), hueDegrees: number(0, -360, 360) }),
  effect('ripple', planar, { amplitude: number(0.05, 0, 1), frequency: number(8, 0, 64), speed: number(1, 0, 10) }),
  effect('wind', planar, { strength: number(0.1, 0, 1), speed: number(1, 0, 10), directionDegrees: number(0, -360, 360) }),
  effect('mask', planar, { invert: { type: 'boolean', default: false, animatable: false } },
    { maskAsset: { kinds: ['image', 'texture'], required: true, usage: 'mask' } }),
  effect('glow', ['output'], { strength: number(0.5, 0, 4), radius: number(8, 0, 32), threshold: number(0.8, 0, 1) }, {}, 2)
];
