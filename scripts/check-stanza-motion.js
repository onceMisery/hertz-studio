'use strict';
// Lyrics must remain readable and continuous at sung boundaries, including short syllables.
const assert = require('node:assert/strict');
globalThis.StanzaUtil = require('../plugin/ui/stanza/stanza-util.js');
const FX = require('../plugin/ui/stanza/stanza-sonnet-fx.js');
const point = () => ({ x: 0, y: 0, set(x, y = x) { this.x = x; this.y = y; } });
const line = { startTime: 1, endTime: 5, vocalEndTime: 5, renderHints: {} };
const tuning = { palette: { ink: '#f5f3ee' }, waitingOpacity: 0.38 };
function makeNode(data = {}) {
  return { position: point(), scale: point(), skew: point(), dataset: {
    text: '风', index: 0, startTime: 2, endTime: 3, phraseStart: 1, phraseEnd: 5,
    baseX: 200, baseY: 160, fit: 0.65, fontSize: 64, angle: 0.04, enterStyle: 'from-left',
    ...data
  } };
}
function animate(node, time, extra = {}, isPlaying = false) {
  FX.animateLyrics([node], { playbackTime: time, activeLine: line, isPlaying }, { ...tuning, ...extra }, 0x85bcfa);
  return node;
}
function sample(time, extra = {}, data = {}) { return animate(makeNode(data), time, extra); }
function pose(node) {
  return [node.position.x, node.position.y, node.scale.x, node.scale.y,
    node.rotation, node.skew.x, node.skew.y].map(value => value === 0 ? 0 : value);
}
function state(node) { return [...pose(node), node.alpha, node.tint]; }
function colorDistance(a, b) {
  return Math.max(...[0, 8, 16].map(shift => Math.abs((a >> shift & 255) - (b >> shift & 255))));
}
for (const boundary of [2, 3]) {
  const before = sample(boundary - 0.0001), after = sample(boundary + 0.0001);
  assert.ok(Math.abs(before.alpha - after.alpha) < 0.01, 'opacity must not pop at ' + boundary);
  assert.ok(colorDistance(before.tint, after.tint) <= 1, 'highlight must not snap at ' + boundary);
  assert.ok(Math.abs(before.scale.x - after.scale.x) < 0.001, 'scale must not snap at ' + boundary);
}
assert.ok(sample(2.5).alpha > 0.95, 'current glyph remains readable');
assert.ok(sample(2.95).scale.x > 0.65, 'a sustained syllable keeps gentle emphasis to its end');
assert.ok(sample(3.15).scale.x > 0.65, 'emphasis releases gently after the sung end');
const punctuation = sample(2.1, {}, { text: '，', startTime: 2, endTime: 2 });
assert.ok(punctuation.scale.x <= 0.651, 'zero-duration punctuation must not pulse');
const reduced = sample(1.95, { reducedMotion: true });
assert.deepEqual([reduced.position.x, reduced.position.y, reduced.scale.x, reduced.scale.y, reduced.rotation],
  [200, 160, 0.65, 0.65, 0], 'reduced motion pins glyphs to their layout');
assert.notEqual(sample(2.5, { reducedMotion: true }).tint, sample(1.5, { reducedMotion: true }).tint,
  'reduced motion preserves timing-driven highlighting');
const expected = sample(2.06, { lyricMotion: 'tempera' });
sample(4); sample(1);
const actual = sample(2.06, { lyricMotion: 'tempera' });
for (const key of ['position', 'scale', 'skew']) {
  assert.equal(actual[key].x, expected[key].x, 'seek determinism: ' + key);
  assert.equal(actual[key].y, expected[key].y, 'seek determinism: ' + key);
}
assert.equal(actual.tint, expected.tint);
assert.equal(actual.alpha, expected.alpha);
assert.notEqual(sample(1.9, { lyricMotion: 'sonnet' }).position.x,
  sample(1.9, { lyricMotion: 'tempera' }).position.x, 'stages have distinct entrance directions');
for (const mode of ['sonnet', 'tempera']) {
  for (const duration of [0, 0.04, 0.1, 0.5, 4]) {
    for (const t of [1.75, 1.999, 2, 2.001, 2.08, 2.5, 4.9, 5.5]) {
      const n = sample(t, { lyricMotion: mode }, { endTime: 2 + duration });
      assert.ok([n.position.x, n.position.y, n.scale.x, n.scale.y, n.alpha].every(Number.isFinite));
      assert.ok(n.scale.x >= 0.5 && n.scale.x <= 0.9, 'bounded typography scale');
      assert.ok(n.alpha >= 0 && n.alpha <= 1);
    }
  }
}

// Do not inherit Sonnet's explicit low waiting opacity when checking Tempera defaults.
const tempera = { lyricMotion: 'tempera', waitingOpacity: undefined };
const ribbonData = { ribbonU: 0.5, ribbonPhase: 0.7, angle: 0, enterStyle: 'rise' };
const ribbon = (time, u, phase = 0.7) => sample(time, tempera, { ...ribbonData, ribbonU: u, ribbonPhase: phase });
// All glyphs share timing/entry/size: any curvature here must come from row position,
// not staggered syllable entrances or unrelated random glyph angles.
const us = [0, 0.25, 0.5, 0.75, 1];
const rows = [2.6, 2.85, 3.7].map(time => us.map(u => ribbon(time, u)));
const bends = rows.map(row => row.slice(1, -1).map((node, i) =>
  row[i].position.y - 2 * node.position.y + row[i + 2].position.y));
for (let index = 0; index < rows.length; index += 1) {
  const row = rows[index], ys = row.map(node => node.position.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 0.2, 'Tempera ribbon has visible row-wise displacement');
  assert.ok(bends[index].some(value => Math.abs(value) > 0.1), 'ribbon is curved, not just a tilted straight line');
  assert.ok(bends[index].every(value => Math.abs(value) < 8), 'row curvature remains smooth between neighboring glyphs');
  assert.ok(bends[index].every(value => value * bends[index][0] > 0), 'one row forms a coherent arc, not a glyph zigzag');
  const turns = row.map(node => node.rotation);
  assert.ok(Math.max(...turns) - Math.min(...turns) > 0.001, 'glyph rotation follows row position');
  for (let i = 1; i < row.length - 1; i += 1) {
    const slope = row[i + 1].position.y - row[i - 1].position.y;
    if (Math.abs(slope) > 0.2) assert.ok(slope * row[i].rotation > 0, 'glyph rotation follows the local ribbon tangent');
  }
}
assert.ok(bends[0].every((value, i) => value * bends[1][i] > 0), 'nearby playback times preserve the arc direction');
assert.notDeepEqual(pose(ribbon(2.6, 0.5)), pose(ribbon(2.85, 0.5)), 'a settled syllable still rides the slow baseline wave');
assert.notDeepEqual(pose(ribbon(2.6, 0.5, 0.7)), pose(ribbon(2.6, 0.5, 2.1)), 'deterministic ribbon phase drives the wave');
for (const u of us) {
  const a = ribbon(2.6, u), b = ribbon(2.6001, u);
  assert.ok(Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y) < 0.02, 'baseline wave has no frame-sized jumps');
  assert.ok(Math.abs(a.rotation - b.rotation) < 0.001, 'tangent rotation is continuous in time');
}
for (const boundary of [2, 3]) {
  const a = ribbon(boundary - 0.0001, 0.75), b = ribbon(boundary + 0.0001, 0.75);
  assert.ok(Math.abs(a.alpha - b.alpha) < 0.01, 'Tempera opacity is continuous at sung boundaries');
  assert.ok(colorDistance(a.tint, b.tint) <= 1, 'Tempera color is continuous at sung boundaries');
  assert.ok(Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y) < 0.02, 'Tempera position is continuous at sung boundaries');
  assert.ok(Math.abs(a.rotation - b.rotation) < 0.001, 'Tempera rotation is continuous at sung boundaries');
}
for (const time of [1.2, 1.5, 1.75]) {
  assert.ok(sample(time, tempera, ribbonData).alpha >= 0.74, 'default waiting Tempera glyphs remain readable');
  assert.ok(sample(time, { ...tempera, waitingOpacity: 0.9, phraseEmphasis: 0 }, { ...ribbonData, phraseStart: 2 }).alpha >= 0.74,
    'Tempera engine tuning preserves future phrases as well');
}
for (const time of [2.5, 2.95]) {
  const active = sample(time, tempera, ribbonData);
  const unaccented = sample(time, tempera, { ...ribbonData, text: '，' });
  assert.ok(active.position.y < unaccented.position.y - 0.1, 'active syllables stay gently lifted through their sustain');
  assert.notEqual(active.tint, 0xf5f3ee, 'active syllables retain timing-driven color through their sustain');
}
assert.equal(sample(3.8, tempera, ribbonData).tint, 0xf5f3ee, 'passed Tempera glyphs release to the exact body ink');

// Reuse a dirty node: fresh-node-only checks would miss accumulated frame history
// or reduced motion failing to clear a prior animated transform.
const reused = makeNode(ribbonData);
const expectedState = state(animate(reused, 2.6, tempera, true));
for (let i = 0; i < 8; i += 1) {
  assert.deepEqual(state(animate(reused, 2.6, tempera, false)), expectedState, 'paused playback cannot accumulate ribbon motion');
}
for (const time of [4.8, 1.1, 3.6, 0, 2.6]) animate(reused, time, tempera, true);
assert.deepEqual(state(reused), expectedState, 'backward/forward seek returns the exact pose, opacity and color');
assert.deepEqual(state(sample(2.6, tempera, ribbonData)), expectedState, 'direct seek matches played frames');
for (const time of [0, 1.5, 2.5, 2.95, 3.8, 5.5]) {
  animate(reused, 2.6, tempera, true);
  reused.skew.set(0.2, -0.1);
  animate(reused, time, { ...tempera, reducedMotion: true });
  assert.deepEqual(pose(reused), [200, 160, 0.65, 0.65, 0, 0, 0], 'reduced Tempera resets every transform to the exact layout base');
}
const quiet = { ...tempera, reducedMotion: true };
assert.notEqual(sample(2.5, quiet, ribbonData).tint, sample(1.5, quiet, ribbonData).tint, 'reduced Tempera still follows the singing color');
assert.equal(sample(3.8, quiet, ribbonData).tint, 0xf5f3ee, 'reduced Tempera releases passed color as well');
for (const time of [1.5, 2.6, 3.8, 5.5]) {
  assert.deepEqual(pose(sample(time, { ...tempera, typographyMotion: 0 }, ribbonData)),
    [200, 160, 0.65, 0.65, 0, 0, 0], 'zero typography motion disables the ribbon');
  for (const lyricMotion of [undefined, 'sonnet']) {
    const baseline = state(sample(time, { lyricMotion }));
    for (const ribbonU of [-1, 0, 0.5, 1]) {
      assert.deepEqual(state(sample(time, { lyricMotion }, { ribbonU, ribbonPhase: 2.1 })), baseline,
        'Sonnet/default motion ignores Tempera-only ribbon metadata');
    }
  }
}
for (const u of [-1, ...us]) {
  for (const strength of [0.1, 1, 2]) {
    for (const duration of [0, 0.04, 0.1, 0.5, 4]) {
      for (const time of [0, 1.75, 2, 2.08, 2.6, 3.1, 4.9, 5.5]) {
        const node = sample(time, { ...tempera, typographyMotion: strength, animationIntensity: strength },
          { ...ribbonData, ribbonU: u, endTime: 2 + duration });
        assert.ok(state(node).every(Number.isFinite), 'all ribbon pose/color values remain finite');
        assert.ok(Math.abs(node.position.x - 200) <= 64 * 0.65 * 1.5
          && Math.abs(node.position.y - 160) <= 64 * 0.65 * 1.5, 'ribbon displacement stays within a readable glyph-sized envelope');
        assert.ok(Math.abs(node.rotation) <= 0.35, 'ribbon tangent cannot spin the typography');
        assert.ok(node.scale.x >= 0.5 && node.scale.x <= 0.9 && node.scale.y === node.scale.x, 'bounded uniform ribbon scale');
        assert.ok(node.alpha >= 0 && node.alpha <= 1, 'bounded ribbon opacity');
      }
    }
  }
}

// A minimal injected Text measures mixed advances; exercise the real row layout,
// including line wraps and a singleton, without DOM/Pixi/WebGL dependencies.
class TextStub {
  constructor({ text, style }) {
    this.text = text;
    this.width = style.fontSize * (text === 'i' ? 0.25 : text === 'W' ? 0.95 : 0.7);
    this.anchor = point(); this.position = point(); this.scale = point();
  }
}
function layout(text, seed = 'ribbon-layout', width = 480) {
  const container = { position: point(), removeChildren: () => [], addChild() {} };
  return FX.buildLyrics({ Text: TextStub }, container,
    { ...line, fullText: text, words: [{ text, startTime: 1, endTime: 5 }] },
    width, 360, { ...tuning, ...tempera, lyricLayout: 'lines' }, seed, 'sans-serif');
}
const text = 'Wi风海听见Wi星光流转Wi晚风';
const laidOut = layout(text), repeat = layout(text);
assert.deepEqual(laidOut.map(node => node.dataset), repeat.map(node => node.dataset), 'rebuilding the same line preserves ribbon metadata');
const rowGroups = new Map();
for (const node of laidOut) {
  const d = node.dataset;
  assert.ok(Number.isFinite(d.ribbonU) && Math.abs(d.ribbonU) <= 1, 'buildLyrics provides normalized ribbonU');
  assert.ok(Number.isFinite(d.ribbonPhase), 'buildLyrics provides a deterministic ribbonPhase');
  if (!rowGroups.has(d.baseY)) rowGroups.set(d.baseY, []);
  rowGroups.get(d.baseY).push(d);
}
assert.ok(rowGroups.size > 1, 'layout fixture actually wraps to multiple rows');
for (const row of rowGroups.values()) {
  assert.ok(row.length >= 3, 'layout fixture has enough glyphs to check horizontal normalization');
  const slope = (row[1].ribbonU - row[0].ribbonU) / (row[1].baseX - row[0].baseX);
  assert.ok(slope > 0, 'ribbonU increases with physical horizontal position');
  for (let i = 1; i < row.length; i += 1) {
    assert.ok(Math.abs((row[i].ribbonU - row[0].ribbonU) - slope * (row[i].baseX - row[0].baseX)) < 1e-9,
      'ribbonU tracks physical glyph advance rather than character index');
  }
}
const singleton = layout('风')[0].dataset;
assert.ok(Number.isFinite(singleton.ribbonU) && Number.isFinite(singleton.ribbonPhase), 'singleton rows have finite ribbon coordinates');
assert.notDeepEqual(layout(text, 'another-line').map(node => node.dataset.ribbonPhase),
  laidOut.map(node => node.dataset.ribbonPhase), 'different line seeds vary the deterministic phase');
console.log('stanza motion: existing Sonnet coverage plus Tempera ribbon curvature, sustain/color, bounds, pause/seek, reduced motion and row metadata passed');
