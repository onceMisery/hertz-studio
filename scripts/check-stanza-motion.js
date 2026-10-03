'use strict';
// Lyrics must remain readable and continuous at sung boundaries, including short syllables.
const assert = require('node:assert/strict');
const FX = require('../plugin/ui/stanza/stanza-sonnet-fx.js');
const point = () => ({ x: 0, y: 0, set(x, y = x) { this.x = x; this.y = y; } });
const line = { startTime: 1, endTime: 5, vocalEndTime: 5, renderHints: {} };
const tuning = { palette: { ink: '#f5f3ee' }, waitingOpacity: 0.38 };
function sample(time, extra = {}, data = {}) {
  const node = { position: point(), scale: point(), skew: point(), dataset: {
    text: '风', index: 0, startTime: 2, endTime: 3, phraseStart: 1, phraseEnd: 5,
    baseX: 200, baseY: 160, fit: 0.65, fontSize: 64, angle: 0.04, enterStyle: 'from-left',
    ...data
  } };
  FX.animateLyrics([node], { playbackTime: time, activeLine: line }, { ...tuning, ...extra }, 0x85bcfa);
  return node;
}
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
console.log('stanza motion: continuous boundaries, sustain/release, punctuation, reduced motion, seek and bounded poses passed');
