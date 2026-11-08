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

// ---- 设置弹窗：形态、分组、遮罩接线，以及「设置项一个不少」 ----
// 只切新增的那一节 CSS，避免就近正则抓到共享抽屉里同名的旧声明。
const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const allCss = fs.readFileSync(path.join(web, 'space3d.css'), 'utf8');
const dialogCss = allCss.slice(allCss.indexOf('沉浸声场设置：居中弹窗'));
assert.ok(dialogCss.length > 2000, 'dialog style block exists'); count++;
assert.match(dialogCss, /#s3d-settings\s*\{[^}]*position:\s*fixed[^}]*margin:\s*auto/,
  'dialog is centred by margin auto, not by a transform that the drawer would fight'); count++;
assert.match(dialogCss, /grid-template-columns:\s*minmax\(132px, 34%\) minmax\(0, 1fr\)/,
  'field grid has a label column and a control column'); count++;
assert.match(dialogCss, /\.s3d-settings-scrim\s*\{[^}]*position:\s*fixed/,
  'scrim is a viewport-sized layer'); count++;
assert.match(html, /<div class="s3d-settings-scrim" id="s3d-settings-scrim" hidden/,
  'scrim node exists and starts hidden'); count++;
assert.match(html, /id="s3d-settings" aria-label="沉浸声场设置" role="dialog" aria-modal="true" hidden/,
  'settings announces itself as a modal dialog'); count++;
const shortcuts = (html.match(/data-sec="s3d-sec-/g) || []).length;
const sections = (html.match(/class="s3d-sec" id="s3d-sec-/g) || []).length;
assert.equal(shortcuts, 5, 'five section shortcuts'); count++;
assert.equal(sections, shortcuts, 'every shortcut has a section heading'); count++;
// 分组只跳转、不隐藏：设置项全部留在 DOM，浏览器契约才能直接操作任意一项。
for (const id of ['s3d-lyrics-toggle', 's3d-reset', 's3d-fs', 's3d-layout', 's3d-lyric-visual',
  's3d-fl-starborn', 's3d-scene-source', 's3d-coast-tuning', 's3d-zodiac-tuning', 's3d-anime-tuning',
  's3d-shelf-mode', 's3d-workshop', 's3d-reactivity', 's3d-motion', 's3d-bloom', 's3d-fl-common',
  's3d-fl-classic', 's3d-fl-cadenza', 's3d-fl-sonnet', 's3d-fl-tempera', 's3d-defaults',
  's3d-defaults-note', 's3d-settings-status', 's3d-motion-note']) {
  assert.ok(html.includes('id="' + id + '"'), '设置项 ' + id + ' 仍在'); count++;
}
assert.match(source, /function bindSettingsShell\(\)/, 'shell bindings exist'); count++;
assert.match(source, /panel\.scrollTo\(\{ top: Math\.max\(0, top\)/,
  'section shortcuts scroll instead of hiding rows'); count++;
assert.match(source, /head\.getBoundingClientRect\(\)\.top - panelTop/,
  'jump target comes from the real rect (offsetTop drifted from scrollTop)'); count++;
assert.match(source, /jumpTarget = head\.id/, 'a shortcut marks itself current immediately'); count++;
assert.match(source, /if \(jumpTarget\) \{ mark\(jumpTarget\); return; \}/,
  'jump highlight holds until the user scrolls (short tail sections never reach the top line)'); count++;
assert.match(source, /panel\.addEventListener\('wheel', releaseJump/,
  'manual wheel releases the jump highlight'); count++;
assert.match(source, /panel\.clientHeight >= panel\.scrollHeight - 4/,
  'scrolling to the bottom marks the last section'); count++;
assert.match(source, /scrim\.hidden = !on/, 'scrim follows setSettings'); count++;
assert.match(source, /shownReasons\[setting\.reason\]/, 'duplicate availability reasons collapse to one'); count++;
assert.doesNotMatch(source, /note\.hidden = setting\.enabled;/,
  'old per-control reason repetition is gone'); count++;
console.log('Stage settings: ' + count + ' checks passed (mode/background/device matrix, preferences, theme ownership, dialog wiring)');
