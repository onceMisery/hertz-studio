'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../plugin/ui');
const source = fs.readFileSync(path.join(root, 'stage3d.js'), 'utf8').replace(/\r\n/g, '\n');
function extract(name) {
  const start = source.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n  }', start);
  return source.slice(start, end + 4);
}
const catalog = [{ id: 'morning-01.jpg' }, { id: 'evening-16.jpg' }];
const theme = { wallpapers: () => catalog };
const state = vm.createContext({ global: { ThemeStudio: theme }, ThemeStudio: theme,
  stanza: { bgMode: 'anime' }, stanzaActive: () => true, sceneSource: 'immersive' });
vm.runInContext(['sceneCovered', 'stageWallpapers', 'stageWallpaper'].map(extract).join('\n'), state);
assert.equal(state.stageWallpaper('morning-01.jpg'), 'morning-01.jpg');
assert.equal(state.stageWallpaper('../../secret'), 'evening-16.jpg');
assert.equal(state.stageWallpaper('https://example.com/picture.jpg'), 'evening-16.jpg');
assert.equal(state.sceneCovered(), true);
state.stanza.bgMode = 'atmosphere';
assert.equal(state.sceneCovered(), true);
state.stanza.bgMode = 'stage';
assert.equal(state.sceneCovered(), false);
for (const background of ['geometric', 'fluid', 'solid']) {
  state.stanza.bgMode = background;
  assert.equal(state.sceneCovered(), true, background + ' owns the background');
}
state.stanza.bgMode = 'anime'; state.stanzaActive = () => false;
assert.equal(state.sceneCovered(), false);
// 创意舞台接管场景源（sceneSource === 'creative'）时背景选择一并隐藏，
// 且优先于 stanza 的 bgMode（后者只决定「谁画背景」）。
state.stanzaActive = () => true;
state.stanza.bgMode = 'stage';
state.sceneSource = 'immersive';
assert.equal(state.sceneCovered(), false, '沉浸场景源下 stanza 的 stage 模式露出背景');
state.sceneSource = 'creative';
assert.equal(state.sceneCovered(), true, 'creative 场景源接管即视为被覆盖');
state.sceneSource = 'immersive';
theme.wallpapers = () => [];
assert.equal(state.stageWallpaper('missing.jpg'), '');
const prefs = extract('preferences');
assert.match(prefs, /stanzaWallpaper: stanza.wallpaper/);
assert.match(prefs, /stanzaWallpaperDim: stanza.wallpaperDim/);
assert.match(extract('render'), /sceneCovered\(\)/);
assert.match(extract('onPointerDown'), /sceneCovered\(\)/);
assert.match(extract('onWheel'), /sceneCovered\(\)/);
assert.match(extract('applyStanzaConfig'), /resolveSonnet/);
assert.match(extract('applyStanzaConfig'), /stanza.bgMode === 'anime' \|\| stanza.bgMode === 'atmosphere' \? 'stage'/);
assert.doesNotMatch(extract('syncStageBackdrop'), /setWallpaper\(|setOptions\(|localStorage/);
assert.match(extract('syncStageBackdrop'), /picture.onerror/);
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.match(html, /value="anime"/);
assert.match(html, /s3d-fl-wallpaper-grid/);
assert.match(html, /s3d-fl-wallpaper-dim/);
console.log('Stage backgrounds: 20 checks passed (catalog, isolation, persistence, render/input gates, controls)');
