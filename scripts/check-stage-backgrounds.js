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

// Shared backgrounds keep their settings while Space3D temporarily owns their clock/depth.
const backgroundSource = fs.readFileSync(path.join(root, 'backgrounds.js'), 'utf8').replace(/\r\n/g, '\n');
function backgroundFunction(name) {
  const start = backgroundSource.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, 'Backgrounds exposes the ' + name + ' lifecycle');
  return backgroundSource.slice(start, backgroundSource.indexOf('\n  }', start) + 4);
}
let paused = 0, played = 0, refreshed = 0, destroyed = 0, attached = 0;
const backgroundState = { spec: { type: 'mesh', depthMode: 'scene' }, attached: true,
  layer: { dataset: {}, style: { removeProperty() {} } }, depthEffective: 'scene', stageState: null,
  media: { tagName: 'VIDEO', paused:true, pause() { this.paused=true; paused++; }, play() { this.paused=false; played++; return Promise.resolve(); } } };
const backgroundContext = vm.createContext({ state: backgroundState, isVisible: () => true,
  window: {}, advancing: false, backgroundDirty: false,
  mediaGeneration: 0, serviceOnline: true, mediaProbe: null, selectionPin: null, temporaryApply: null,
  isCanvasType: () => true, BG_FPS: 12, document: { body: { classList: { contains: () => true } } },
  destroyWall: () => { destroyed++; }, ensureWall: () => { attached++; return true; },
  refresh: () => { refreshed++; }, isFinite, Math });
vm.runInContext(['setStageState', 'targetFps', 'syncMediaPlayback', 'configureDepth'].map(backgroundFunction).join('\n'), backgroundContext);
backgroundContext.setStageState({ flat: true, paused: true, reduced: false, timeSec: 4 });
assert.equal(backgroundContext.targetFps(), 0, 'paused space stops the background gate');
assert.equal(backgroundState.depthEffective, 'flat', 'space temporarily suspends the GL wall');
assert.equal(backgroundState.spec.depthMode, 'scene', 'configured depth is never overwritten by the temporary host');
assert.ok(paused > 0 && destroyed > 0, 'media and old GL resources are suspended');
const refreshCount = refreshed;
backgroundContext.setStageState({ flat: true, paused: true, timeSec: 9 });
assert.equal(refreshed, refreshCount, 'clock snapshot updates do not schedule redundant refreshes');
backgroundContext.setStageState({ flat: true, paused: false, reduced: true, timeSec: 9 });
assert.equal(backgroundContext.targetFps(), 0, 'reduced motion also stops background motion');
backgroundContext.setStageState({ flat: true, paused: false, reduced: false, timeSec: 10 });
assert.equal(backgroundContext.targetFps(), 12, 'playing space uses the existing background gate');
backgroundContext.setStageState(null);
assert.equal(backgroundState.depthEffective, 'scene', 'original depth becomes effective again when ownership returns');
assert.equal(backgroundContext.targetFps(), 30, 'original stage wall frame policy returns unchanged');
assert.ok(attached > 0 && played > 0, 'original wall and media playback resume');
console.log('Shared backgrounds: 11 host clock/depth lifecycle checks passed');
