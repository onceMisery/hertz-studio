// SPDX-License-Identifier: MIT
// Released authoring metadata only. Validation is owned by hertz-wallpaper;
// the existence of a definition does not grant a renderer/adapter capability.
const number = (value, min, max, animatable = true, extra = {}) =>
  ({ type: 'number', default: value, min, max, animatable, affects: ['material'], ...extra });
const vector = value => ({ type: 'vector', default: value, length: 3, min: -10000, max: 10000, animatable: true, affects: ['matrix'] });
const select = (value, options) => ({ type: 'select', default: value, options, animatable: false });
const text = (value, maxLength) => ({ type: 'text', default: value, maxLength, animatable: false });
const boolean = value => ({ type: 'boolean', default: value, animatable: false });
const appearance = { opacity: { ...number(1, 0, 1), affects: ['material', 'descendants'] },
  visible: { ...boolean(true), affects: ['visibility', 'descendants'] } };
const planar = {
  x: number(0, -65536, 65536), y: number(0, -65536, 65536),
  width: number(1920, 0.001, 16384), height: number(1080, 0.001, 16384),
  anchorX: number(0.5, 0, 1), anchorY: number(0.5, 0, 1),
  rotation: number(0, -36000, 36000), scaleX: number(1, -64, 64), scaleY: number(1, -64, 64),
  ...appearance, blend: select('normal', ['normal', 'add', 'screen', 'multiply'])
};
const spatial = {
  position: vector([0, 0, 0]), rotation: vector([0, 0, 0]),
  scale: { ...vector([1, 1, 1]), min: 0.0001 }, ...appearance
};
const asset = (kinds, required, usage) => ({ kinds, required, usage });
const node = (type, space, properties, assets = {}) => ({ type, stateVersion: 1, space, properties, assets });
export const nodeDefinitions = [
  node('image', '2d', { ...planar, fit: select('cover', ['contain', 'cover', 'stretch']) }, {
    asset: asset(['image', 'vector'], true, 'color'), maskAsset: asset(['image', 'texture'], false, 'mask')
  }),
  node('video', '2d', { ...planar, loopStartMs: number(0, 0, 86400000, false),
    loopEndMs: { type: 'number', min: 0.001, max: 86400000, animatable: false } },
  { asset: asset(['video'], true, 'video') }),
  node('text', '2d', { ...planar, text: text('', 4096), fontSize: number(48, 1, 1024, false),
    color: { type: 'color', default: '#ffffff', animatable: false },
    align: select('left', ['left', 'center', 'right']), lineHeight: number(1.25, 0.25, 8, false) },
  { fontAsset: asset(['font'], true, 'font') }),
  node('group', 'dynamic', { space: { ...select('2d', ['2d', '3d']), public: false },
    ...Object.fromEntries(Object.entries(planar).filter(([key]) => !['visible', 'opacity'].includes(key))
      .map(([key, value]) => [key, { ...value, space: '2d', ...(key === 'blend' ? { options: ['normal'] } : {}) }])),
    ...Object.fromEntries(Object.entries(spatial).filter(([key]) => !['visible', 'opacity'].includes(key))
      .map(([key, value]) => [key === 'rotation' ? 'rotation3d' : key, { ...value, space: '3d' }])),
    ...appearance }),
  node('particles', '2d', { ...planar, count: number(2048, 0, 65536, false, { integer: true }),
    seed: number(0, 0, 4294967295, false, { integer: true }), lifetimeSeconds: number(6, 0.001, 3600),
    speed: number(30, 0, 10000), spread: number(400, 0, 65536) },
  { spriteAsset: asset(['image', 'vector'], false, 'color') }),
  node('model', '3d', { ...spatial, animationClip: text('', 256), animationSpeed: number(1, -16, 16) },
  { asset: asset(['model'], true, 'model') }),
  node('builtinScene', '3d', { sceneId: { type: 'sceneId', animatable: false, public: false },
    stateVersion: number(1, 1, 4294967295, false, { integer: true, public: false }),
    params: { type: 'sceneParams', default: {}, animatable: false, public: false } })
];

// 3d group uses the same vector rotation spelling as model. The planar scalar
// variant is selected before applying defaults, so both cannot be accepted.
const group = nodeDefinitions.find(definition => definition.type === 'group');
group.properties.rotation = { ...group.properties.rotation, alternatives: {
  '3d': { ...spatial.rotation, space: '3d' }
} };
delete group.properties.rotation3d;

export const compositionInputs = ['energy', 'bass', 'mid', 'high', 'pointerX', 'pointerY', 'sceneTime',
  ...Array.from({ length: 64 }, (_, index) => 'spectrum' + index)];

// The publisher declares fixed invalidation roles here. Native compilation
// turns them into index tables; frame loops never interpret property names.
for (const definition of nodeDefinitions) {
  for (const [name, field] of Object.entries(definition.properties)) {
    if (['x', 'y', 'anchorX', 'anchorY', 'rotation', 'scaleX', 'scaleY'].includes(name)) field.affects = ['matrix'];
    if (['width', 'height'].includes(name)) field.affects = ['matrix', 'layout'];
    if (['text', 'fontSize', 'align', 'lineHeight'].includes(name)) field.affects = ['layout', 'material'];
    if (['count', 'seed'].includes(name)) field.affects = ['geometry'];
    if (field.public === false) field.affects = [];
    if (!field.affects) field.affects = ['material'];
  }
}
