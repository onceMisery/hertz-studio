'use strict';
// 实现后回归：组合能力、用户偏好保留与主题角色隔离。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.join(__dirname, '../plugin/ui');
const Settings = require(path.join(web, 'stage-settings.js'));
let count = 0;
for (const visual of ['stage', 'classic', 'cadenza', 'sonnet', 'tempera', 'starborn']) {
  for (const background of ['stage', 'anime', 'atmosphere', 'fluid', 'solid', 'geometric']) {
    for (const webgl of [true, false]) {
      const input = { visual, background, webgl, lyrics: true, effective: visual === 'starborn' ? 'sonnet' : visual, lyricLayout: 'phrases' };
      const original = JSON.stringify(input);
      const state = Settings.resolve(input);
      assert.equal(state.covered, visual !== 'stage' && background !== 'stage');
      assert.equal(state.scene, webgl && !state.covered);
      assert.equal(state.rows['s3d-bloom'].enabled, state.scene);
      assert.equal(state.rows['s3d-layout'].enabled, visual === 'stage');
      assert.equal(state.rows['s3d-motion'].enabled, visual !== 'stage' || state.scene);
      assert.equal(state.rows['s3d-fl-opacity'].enabled, background === 'fluid');
      assert.equal(JSON.stringify(input), original, 'capability resolution never mutates preferences');
      count += 7;
    }
  }
}
const reduced = Settings.resolve({ visual: 'sonnet', background: 'anime', reduced: true, lyrics: false, lyricLayout: 'lines' });
for (const id of ['s3d-motion', 's3d-reactivity', 's3d-fl-size', 's3d-fl-subtitle', 's3d-fl-phrase']) {
  assert.equal(reduced.rows[id].enabled, false); assert.ok(reduced.rows[id].reason); count += 2;
}
const sandbox = { StanzaUtil: require(path.join(web, 'stanza/stanza-util.js')), window: {}, document: { documentElement: {} } };
let color = '#ffffff';
sandbox.window.getComputedStyle = () => ({ getPropertyValue: name => name === '--music-highlight' ? color : '' });
vm.runInNewContext(fs.readFileSync(path.join(web, 'stanza/stanza-theme.js'), 'utf8'), sandbox);
const Theme = sandbox.StanzaTheme;
const neutral = Theme.resolveTempera(1.35);
assert.notEqual(neutral.accentColor, Theme.DEFAULT.accentColor);
assert.notEqual(neutral.accentColor, neutral.secondaryColor);
assert.equal(Theme.resolve(1.35).accentColor, Theme.DEFAULT.accentColor, 'ordinary neutral theme preserved');
color = '#ef8040';
const warm = Theme.resolveTempera(1.35);
assert.notEqual(warm.accentColor, neutral.accentColor, 'cover hue reaches Tempera');
const source = fs.readFileSync(path.join(web, 'stage3d.js'), 'utf8');
const host = { document: { readyState: 'loading', addEventListener() {} } };
host.window = host;
vm.runInNewContext(source, host);
const visuals = host.Stage3D.lyricVisuals();
assert.equal(Settings.resolve({ visuals, visual: 'tempera' }).label, '凝彩');
assert.equal(Settings.resolve({ visuals, visual: 'starborn', effective: 'sonnet' }).label, '星诞 · 当前演出：商籁');
assert.doesNotMatch(source, /setOpacityRowEnabled/);
assert.match(source, /if \(stanza\.shownVisual === id\) return/);
assert.match(source, /if \(active && \(sceneCovered\(\) \|\| !gl \|\| contextLost\)\) return false/);
count += 9;
const image = Settings.resolve({ visual: 'sonnet', background: 'anime', lyrics: true });
for (const id of ['s3d-fl-accents', 's3d-fl-atmosphere', 's3d-fl-halation']) {
  assert.equal(image.rows[id].enabled, false); assert.ok(image.rows[id].reason); count += 2;
}
const hiddenLyrics = Settings.resolve({ visual: 'sonnet', background: 'solid', lyrics: false, webgl: true });
assert.equal(hiddenLyrics.rows['s3d-reactivity'].enabled, false); count++;
console.log('Stage settings: ' + count + ' checks passed (mode/background/device matrix, preferences, theme ownership)');
