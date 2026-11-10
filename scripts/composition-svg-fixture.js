// SPDX-License-Identifier: MIT
// Original geometric fixtures, dedicated to CC0-1.0. Fonts retain their OFL notice.
'use strict';
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {buildZip} = require('./check-wallpaper-media-native');
const {loadCompositionFontFixture} = require('./composition-font-fixture');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function projectionIdentity(projection) {
  assert.match(projection.semanticKey, /^[a-f0-9]{64}$/, 'native projection semanticKey');
  assert.match(projection.targetKey, /^[a-f0-9]{64}$/, 'native projection targetKey');
  return {semanticKey: projection.semanticKey, targetKey: projection.targetKey};
}
const svg = body => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">${body}</svg>`);
const sources = {
  red: svg('<rect width="320" height="180" fill="#ff0000"/>'),
  blue: svg('<rect width="320" height="180" fill="#0000ff"/>'),
  alpha: svg('<g opacity="0.5"><rect x="80" y="45" width="160" height="90" fill="#ff0000" fill-opacity="0.5"/></g>'),
  gradient: svg('<defs><linearGradient id="ramp"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs><rect width="320" height="180" fill="url(#ramp)"/>'),
  missingFont: svg('<text x="10" y="100" font-family="Missing Author Font" font-size="40">Hertz Studio</text>'),
  external: svg('<use href="file:///unavailable.svg#shape"/>'),
  animation: svg('<rect width="320" height="180"><animate attributeName="opacity" values="0;1" dur="1s"/></rect>'),
};

function makePackage({text = false} = {}) {
  const workId = text ? '603c58fc-321d-4b92-8a5b-791cbb958a06' : '705d219d-a001-47d7-8e4a-461b5d2b1b25';
  const entries = Object.entries(sources).filter(([id]) => ['red', 'blue', 'alpha', 'gradient'].includes(id))
    .map(([id, bytes]) => ({file: `assets/${id}.svg`, bytes, mime: 'image/svg+xml'}));
  const assets = entries.map(({file}) => ({id: file.slice(7, -4), kind: 'vector', source: file, variants: []}));
  assets.push({id: 'red-alias', kind: 'vector', source: 'assets/red.svg', variants: []});
  if (text) {
    const font = loadCompositionFontFixture();
    entries.push({file: 'assets/font.ttf', bytes: font.bytes, mime: font.mime}, ...font.packageFiles);
    entries.push({file: 'assets/label.svg', bytes: svg('<text x="10" y="100" font-family="Instrument Serif" font-weight="400" font-size="40">Hertz Studio</text>'), mime: 'image/svg+xml'});
    assets.push({id: 'author-font', kind: 'font', source: 'assets/font.ttf', variants: []}, {id: 'label', kind: 'vector', source: 'assets/label.svg', variants: []});
  }
  const picture = (id, asset, properties = {}) => ({id, type: 'image', stateVersion: 1, assets: {asset},
    properties: {x: 0, y: 0, width: 320, height: 180, anchorX: 0, anchorY: 0, fit: 'contain', ...properties}});
  const nodes = [picture('back', 'blue'), picture('picture', text ? 'label' : 'red'),
    picture('shared-red', 'red-alias', {visible: false}), picture('overlay', 'alpha'),
    {id: 'sprites', type: 'particles', stateVersion: 1, assets: {spriteAsset: 'red'},
      properties: {x: 160, y: 90, width: 320, height: 180, anchorX: 0, anchorY: 0, count: 1, seed: 1, speed: 0, spread: 0}}];
  const document = {documentVersion: 1, canvas: {width: 320, height: 180, colorSpace: 'srgb', background: '#000000'},
    nodes, timeline: {durationSeconds: 4, loop: true, tracks: []}, bindings: [], effects: []};
  const properties = text ? [] : [{id: 'picture', label: 'Picture', type: 'asset', default: 'red',
    constraints: {kind: 'vector', options: ['red', 'blue', 'red-alias', 'gradient']},
    target: {kind: 'node', nodeId: 'picture', property: 'asset', component: null}}];
  const documentBytes = Buffer.from(JSON.stringify(document));
  entries.unshift({file: 'composition.json', bytes: documentBytes, mime: 'application/json'});
  const manifest = {formatVersion: 1, workId, version: 1, title: text ? 'SVG author font verification' : 'SVG resource verification',
    content: {kind: 'composition', document: 'composition.json'}, assets,
    files: entries.map(({file, bytes, mime}) => ({path: file, bytes: bytes.length, sha256: hash(bytes), mime})), properties,
    permissions: {audioSpectrum: false, pointer: false},
    license: {code: 'MIT', assets: text ? 'CC0-1.0 SVG; OFL-1.1 Instrument Serif' : 'CC0-1.0', attribution: text ? 'Instrument Serif Project Authors; included OFL notice' : 'Original geometric verification fixtures'}};
  const bytes = buildZip([['manifest.json', Buffer.from(JSON.stringify(manifest))], ...entries.map(({file, bytes}) => [file, bytes])]);
  return {bytes, manifest, document, entries, packageHash: hash(bytes), documentHash: hash(documentBytes),
    selection: {kind: 'package', workKey: 'local-' + workId, packageHash: hash(bytes)}};
}

module.exports = {sources, makePackage, hash, projectionIdentity};
