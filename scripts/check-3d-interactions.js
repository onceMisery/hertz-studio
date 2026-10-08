'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.join(__dirname, '..', 'plugin', 'ui');
const read = file => fs.readFileSync(path.join(web, file), 'utf8').replace(/\r\n/g, '\n');
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; }
function extract(file, name) {
  const source = read(file);
  const match = new RegExp('^( +)function ' + name + '\\(', 'm').exec(source);
  assert.ok(match, name);
  const end = source.indexOf('\n' + match[1] + '}', match.index);
  return source.slice(match.index, end + match[1].length + 2);
}
function load(file, names, state) {
  vm.createContext(state);
  vm.runInContext(names.map(name => extract(file, name)).join('\n'), state);
  return state;
}
function surface() {
  const listeners = {};
  const captures = new Set();
  return {
    listeners, captures, style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, listener) { (listeners[type] ||= new Set()).add(listener); },
    removeEventListener(type, listener) { listeners[type]?.delete(listener); },
    emit(type, event = {}) { for (const listener of listeners[type] || []) listener({ type, ...event }); },
    setPointerCapture(id) { captures.add(id); },
    hasPointerCapture(id) { return captures.has(id); },
    releasePointerCapture(id) { captures.delete(id); },
    closest() { return null; }, focus() {}, offsetHeight: 96
  };
}
function pointer(overrides = {}) {
  return { button: 0, pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0,
    target: surface(), stopPropagation() {}, preventDefault() {}, ...overrides };
}

const stage = load('stage3d.js', ['computeDpr', 'targetFps', 'controlTarget', 'onWheel', 'onPointerUp'], {
  window: { devicePixelRatio: 3 }, gl: null, q: () => 0,
  active: true, document: { hidden: false }, contextLost: false, post: null, sizeDirty: false,
  stanzaActive: () => false, reducedMotion: () => false,
  global: { Stage: true }, Stage: { presentation: () => ({ playing: false }) },
  performance: { now: () => 2000 }, interactUntil: 0, dragging: false,
  cam: { userR: 10, minR: 1, maxR: 100 }, isStandalone: () => false, sceneCovered: () => false,
  markInteraction() {}, clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  wrapEl: { clientHeight: 800 }, canvas: surface(), pointers: { 1: {} }, pointerCount: 1,
  root: surface(), dragVel: { t: 1, p: 1 }, pinchDist: 10
});
for (const level of [0, 1, 2]) {
  stage.q = () => level;
  for (const [width, height] of [[1920, 1080], [3840, 2160], [7680, 4320]]) {
    const ratio = stage.computeDpr(width, height);
    check(Math.floor(width * ratio) * Math.floor(height * ratio) <= [1900000, 3600000, 6200000][level], 'pixel budget ' + level + '/' + width);
  }
}
stage.gl = { getParameter: () => 2048 };
check(stage.computeDpr(10000, 100) * 10000 <= 2048, 'GL dimension cap');
check(stage.targetFps() === 30, 'paused stage frame cap');
stage.document.hidden = true;
check(stage.targetFps() === 0, 'hidden stage stops');
stage.document.hidden = false;
stage.contextLost = true;
check(stage.targetFps() === 0, 'lost GL stops');
stage.contextLost = false;
stage.Stage.presentation = () => ({ playing: true });
check(stage.targetFps() === 240, 'playing stage preserves refresh scheduling');
stage.reducedMotion = () => true;
check(stage.targetFps() === 15, 'reduced stage rate');
let prevented = 0;
stage.onWheel(pointer({ ctrlKey: true, deltaY: 100, preventDefault() { prevented++; } }));
stage.onWheel(pointer({ target: { closest: () => ({}) }, deltaY: 100, preventDefault() { prevented++; } }));
check(prevented === 0 && stage.cam.userR === 10, 'zoom and controls retain wheel');
stage.onWheel(pointer({ deltaY: 1, deltaMode: 1 }));
const lineRadius = stage.cam.userR;
stage.cam.userR = 10;
stage.onWheel(pointer({ deltaY: 16, deltaMode: 0 }));
check(stage.cam.userR === lineRadius, 'wheel delta units agree');
stage.canvas.setPointerCapture(1);
stage.onPointerUp({ pointerId: 1, type: 'pointercancel' });
check(!stage.dragging && !stage.pointerCount && !stage.canvas.hasPointerCapture(1) && stage.dragVel.t === 0, 'cancel clears stage drag and capture');

const nudges = [], taps = [];
const cardState = load('stage-shelf.js', ['bindCard', 'onWheelCapture'], {
  active: true, blocked: false, mode: 'side', CLICK_THRESHOLD: 10, items: [1, 2],
  hoverId: null, lastWheelAt: 0, WHEEL_COOLDOWN_MS: 180,
  plane: { contains: node => node === card },
  nudgeBrowse: delta => nudges.push(delta), onCardTap: id => taps.push(id)
});
const card = surface();
cardState.bindCard(card, 'song');
card.emit('pointerdown', pointer({ button: 2 }));
card.emit('pointerup', pointer());
check(taps.length === 0, 'right button never plays');
card.emit('pointerdown', pointer());
card.emit('pointermove', pointer({ clientY: 1 }));
card.emit('pointerup', pointer({ clientY: 1 }));
check(nudges.length === 0 && taps.length === 1, 'one pixel movement remains a tap');
card.emit('pointerdown', pointer());
card.emit('pointerup', pointer({ pointerId: 2 }));
check(card.captures.has(1), 'second finger cannot release first');
card.emit('pointermove', pointer({ clientY: 110 }));
card.emit('pointermove', pointer());
card.emit('pointerup', pointer());
check(nudges.join(',') === '1,-1' && taps.length === 1, 'out-and-back drag restores browse without play');
card.emit('pointerdown', pointer());
card._cancelDrag();
card.emit('pointerup', pointer());
check(taps.length === 1 && !card.captures.size, 'blur/hide cancellation cannot play');
cardState.onWheelCapture(pointer({ deltaY: 100, preventDefault() { prevented++; } }));
check(prevented === 0, 'empty stage wheel is not shelf wheel');
cardState.onWheelCapture(pointer({ target: { closest: () => card }, deltaX: 0, deltaY: 0, preventDefault() { prevented++; } }));
check(prevented === 0, 'zero wheel does nothing');
cardState.onWheelCapture(pointer({ target: { closest: () => card }, deltaX: 40, deltaY: 0, preventDefault() { prevented++; } }));
check(prevented === 1 && nudges.at(-1) === 1, 'horizontal wheel browses actual card');

let chromeVisible = false;
const shelfGate = load('stage-shelf.js', ['canRender', 'gateFps'], {
  active: true, mode: 'side', blocked: false, items: [1], document: { hidden: false },
  narrowScreen: { matches: false },
  root: { classList: { contains: () => chromeVisible } }, reducedMotion: () => false,
  eco: () => false, Stage: { presentation: () => ({ playing: true }) }
});
check(shelfGate.gateFps() === 0, 'invisible shelf stops rendering');
chromeVisible = true;
check(shelfGate.gateFps() === 60, 'visible shelf resumes');
shelfGate.document.hidden = true;
check(shelfGate.gateFps() === 0, 'hidden document stops shelf');

const freed = [];
const targets = load('stage3d.js', ['resizeTargets'], {
  post: { hdr: true, scene: null, a: null, b: null }, bw: 800, bh: 600,
  gl: { RGBA: 1, UNSIGNED_BYTE: 2 },
  freeRT: target => { if (target) freed.push(target); },
  showFallback() { throw Error('RGBA8 fallback should succeed'); }
});
targets.makeRT = (width, height) => targets.post.hdr ? null : { w: width, h: height };
targets.resizeTargets();
check(!targets.post.hdr && targets.post.scene.w === 800 && targets.post.b.w === 400, 'incomplete HDR targets retry RGBA8');
let fallback = false;
targets.bw = 1600;
targets.makeRT = () => null;
targets.showFallback = () => { fallback = true; };
targets.resizeTargets();
check(fallback && !targets.post.scene && freed.length === 3, 'failed target allocation frees previous resources');

let clock = 1000, steps = 0;
const shelf = load('shelf.js', ['onWheel'], {
  items: [1, 2, 3], center: 1, wheelAcc: 0, wheelAt: 0, wheelEventAt: 0,
  WHEEL_STEP: 48, host: { clientWidth: 800 }, Date: { now: () => clock }, stepBy: delta => { steps += delta; }
});
for (let event = 0; event < 24; event++) {
  shelf.onWheel(pointer({ deltaX: 0, deltaY: 2, deltaMode: 0 }));
  clock += 10;
}
check(steps === 1, 'small trackpad deltas accumulate across events');
shelf.center = 2;
shelf.onWheel(pointer({ deltaX: 0, deltaY: 50, preventDefault() { throw Error('edge scroll swallowed'); } }));
check(steps === 1, 'shelf edge permits page scrolling');

const windowMock = surface(), documentMock = surface(), freeStage = surface();
let cameraLayer, reduced = false, unlocked = 0;
documentMock.getElementById = id => id === 'stage' ? freeStage : null;
documentMock.exitPointerLock = () => { unlocked++; documentMock.pointerLockElement = null; };
const freecam = { window: windowMock, document: documentMock, performance: { now: () => 100 },
  localStorage: { getItem: () => null, setItem() {} } };
windowMock.Stage = freecam.Stage = { tier: () => 2, presentation: () => ({ reduced }) };
windowMock.CreativeStage = freecam.CreativeStage = { addCamLayer: callback => { cameraLayer = callback; }, setInteractionBlocker() {} };
vm.runInNewContext(read('stage-freecam.js'), freecam);
const camera = time => ({ t: time, baseYawDeg: 0, basePitchDeg: 0, baseDist: 6, baseHeight: 0, baseFov: 52 });
windowMock.StageFreecam.setEnabled(true);
cameraLayer(camera(100));
freeStage.emit('pointerdown', pointer());
documentMock.emit('pointermove', pointer({ clientX: 20 }));
const moved = camera(116); cameraLayer(moved);
check(moved.yawDeg < 0, 'touch fallback moves camera');
documentMock.emit('pointerup', pointer());
documentMock.emit('pointermove', pointer({ clientX: 60 }));
const released = camera(132); cameraLayer(released);
check(released.yawDeg === moved.yawDeg, 'release outside stage ends fallback drag');
documentMock.emit('keydown', { code: 'KeyW', target: { isContentEditable: true }, preventDefault() { throw Error('editable key swallowed'); } });
documentMock.emit('keydown', { code: 'KeyW', ctrlKey: true, preventDefault() { throw Error('shortcut swallowed'); } });
documentMock.emit('keydown', { code: 'KeyW', preventDefault() {} });
windowMock.emit('blur');
const blurred = camera(148); cameraLayer(blurred);
check(blurred.tx === released.tx && blurred.tz === released.tz, 'blur clears movement keys');
documentMock.pointerLockElement = {};
reduced = true;
windowMock.StageFreecam.setEnabled(false);
check(unlocked === 0 && !windowMock.StageFreecam.isBusy(), 'reduced exit is immediate and preserves foreign lock');
check(documentMock.listeners.pointermove.size === 0 && documentMock.listeners.pointercancel.size === 0, 'freecam removes interaction listeners');

const draws = [];
const atlasContext = { clearRect() {}, measureText: text => ({ width: text.length * 30 }), fillText: (...args) => draws.push(args) };
const atlas = { getContext: () => atlasContext };
const lyricState = { window: {}, document: { createElement: () => atlas } };
vm.runInNewContext(read('lyric3d.js'), lyricState);
const lyric = { index: 0, lines: [{ text: '长'.repeat(1000) }] };
check(lyricState.window.Lyric3D.frame(lyric), 'atlas draws long line');
check(draws.every(args => args[3] <= atlas.width), 'long glyph runs stay within atlas');
check(!lyricState.window.Lyric3D.frame(lyric), 'unchanged atlas skips rasterization');
lyricState.window.Lyric3D.setQuality(0);
check(lyricState.window.Lyric3D.frame(lyric) && atlas.width === 512, 'quality resize invalidates atlas');

let trackId = 'first';
const seekRange = { ...surface(), value: 0, disabled: false, setAttribute() {} };
const seekData = { duration: 200000, position: 12000 };
const seekCommands = [];
const seek = load('stage3d.js', ['syncSeek', 'cancelSeek', 'beginSeek', 'previewSeek', 'commitSeek', 'cancelGestures', 'onVisibilityChange', 'onVolumeInput', 'endVolumeChange'], {
  seeking: false, seekTrackId: null, seekCancelled: false, active: true,
  changingVolume: false,
  document: { hidden: false, activeElement: seekRange }, currentTrackId: () => trackId,
  $: id => id === 's3d-seek' ? seekRange : null,
  fmt: value => String(value), text() {},
  global: { Stage: true }, Stage: { presentation: () => seekData, kick() {} },
  control: (action, value) => seekCommands.push({ action, value }),
  pointers: {}, lyrTilt: { dragId: -1 }, dragVel: {}, pointerField: {}
});
function previewPosition(value) {
  seek.beginSeek.call(seekRange, { type: 'pointerdown', button: 0 });
  seekRange.value = value;
  seek.previewSeek.call(seekRange);
}
seek.beginSeek.call(seekRange, { type: 'pointerdown', button: 0 });
seek.syncSeek(seekData);
check(!seek.seeking && seekRange.value === 12000, 'pointerdown without input does not freeze seek progress');
previewPosition(90000);
seek.syncSeek(seekData);
check(seek.seeking && seekRange.value === 90000, 'UI refresh preserves active seek preview');
seek.cancelSeek();
check(!seek.seeking && seekRange.value === 12000, 'pointercancel/element blur restores position immediately');
seekRange.value = 91000;
seek.previewSeek.call(seekRange);
seek.commitSeek.call(seekRange);
check(seekCommands.length === 0 && !seek.seeking, 'late input/change cannot revive cancelled seek');
previewPosition(80000);
seek.cancelGestures();
check(!seek.seeking && seekRange.value === 12000, 'window blur cancels seek with camera gestures');
previewPosition(75000);
seek.document.activeElement = null;
seek.commitSeek.call(seekRange);
check(!seek.seeking && seekCommands.length === 0, 'native change preceding blur cannot commit an unfocused seek');
seek.document.activeElement = seekRange;
previewPosition(70000);
seek.document.hidden = true;
seek.onVisibilityChange();
seekData.position = 15000;
seek.document.hidden = false;
seek.onVisibilityChange();
seek.syncSeek(seekData);
check(!seek.seeking && seekRange.value === 15000, 'hidden then visible resumes live progress');
previewPosition(60000);
trackId = 'second';
seekData.position = 3000;
seek.syncSeek(seekData);
seek.commitSeek.call(seekRange);
check(!seek.seeking && seekRange.value === 3000 && seekCommands.length === 0, 'track refresh invalidates previous seek');
previewPosition(50000);
trackId = 'third';
seek.commitSeek.call(seekRange);
check(seekCommands.length === 0, 'track change before UI refresh cannot seek new track');
seek.beginSeek.call(seekRange, { type: 'keydown', key: 'ArrowRight' });
seekRange.value = 4000;
seek.previewSeek.call(seekRange);
seek.commitSeek.call(seekRange);
check(seekCommands.length === 1 && seekCommands[0].value === 4000 && !seek.seeking, 'new keyboard seek works after cancellation');
for (const event of ['pointercancel', 'blur']) {
  check(read('stage3d.js').includes("$('s3d-seek').addEventListener('" + event + "', cancelSeek)"), 'seek cancellation bound to ' + event);
}
seek.onVolumeInput.call({ value: '35' });
check(seek.changingVolume && seekCommands.at(-1).action === 'volume' && seekCommands.at(-1).value === 0.35, 'volume input submits immediately before release');
seek.onVolumeInput.call({ value: '72' });
check(seekCommands.at(-1).value === 0.72, 'subsequent volume input submits latest value');
const volumeCount = seekCommands.length;
seek.endVolumeChange();
check(!seek.changingVolume && seekCommands.length === volumeCount, 'volume change/cancel/blur clears editing without duplicate submission');
seek.onVolumeInput.call({ value: '0' });
check(seekCommands.at(-1).value === 0, 'volume input supports mute');
seek.cancelGestures();
check(!seek.changingVolume, 'window blur clears volume editing');
seek.onVolumeInput.call({ value: '100' });
check(seekCommands.at(-1).value === 1, 'volume input supports full scale');
seek.document.hidden = true;
seek.onVisibilityChange();
check(!seek.changingVolume, 'hidden page clears volume editing');
const hiddenCount = seekCommands.length;
seek.onVolumeInput.call({ value: '50' });
check(!seek.changingVolume && seekCommands.length === hiddenCount, 'hidden page ignores late volume input');
for (const event of ['change', 'pointercancel', 'blur']) {
  check(read('stage3d.js').includes("$('s3d-volume').addEventListener('" + event + "', endVolumeChange)"), 'volume editing ends on ' + event);
}
check(read('stage3d.js').includes("$('s3d-volume').addEventListener('input', onVolumeInput)"), 'volume input is bound to immediate submission');
console.log('3D interaction checks passed: ' + checks);

// ---------------------------------------------------------------------------
// 沉浸模式回归（2026-10-07 用户报告「全屏控制按钮不隐藏」）：chrome 静止自动
// 隐藏不得被「鼠标点击残留的焦点」永久钉住 —— 焦点豁免只认键盘焦点
// （:focus-visible）。设置/工坊模态、拖拽中的豁免保持不变。
{
  function chromeHarness(keyboardFocus, extra) {
    const removed = [];
    let timerFn = null;
    const focusedEl = { matches: sel => (sel === ':focus-visible') === keyboardFocus };
    const rootStub = {
      classList: {
        set: new Set(['s3d-chrome']),
        contains(c) { return this.set.has(c); },
        add(c) { this.set.add(c); },
        remove(c) { this.set.delete(c); removed.push(c); }
      },
      querySelector() { return focusedEl; }
    };
    const ctx = load('stage3d.js', ['pokeChrome'], Object.assign({
      root: rootStub, active: true, chromeTimer: 1, CHROME_HIDE_MS: 2600,
      dragging: false, seeking: false,
      chromeKeyboardFocus: () => keyboardFocus,
      Workshop: { isOpen: () => false },
      Stage: { kick() {} },
      global: { Workshop: { isOpen: () => false }, Stage: { kick() {} } },
      $: () => ({ hidden: true }),
      setTimeout: fn => { timerFn = fn; return 7; },
      clearTimeout() {}
    }, extra || {}));
    return {
      fire() { ctx.pokeChrome(); assert.equal(typeof timerFn, 'function', 'hide timer scheduled'); timerFn(); },
      removed
    };
  }
  const mouse = chromeHarness(false);
  mouse.fire();
  check(mouse.removed.includes('s3d-chrome'), 'mouse click residual focus: chrome hides after idle');
  const keyboard = chromeHarness(true);
  keyboard.fire();
  check(!keyboard.removed.includes('s3d-chrome'), 'keyboard focus (:focus-visible): chrome stays');
  const modal = chromeHarness(false, { $: () => ({ hidden: false }) });
  modal.fire();
  check(!modal.removed.includes('s3d-chrome'), 'open settings panel: chrome stays');
  const drag = chromeHarness(false, { dragging: true });
  drag.fire();
  check(!drag.removed.includes('s3d-chrome'), 'camera drag in progress: chrome stays');
  const pokeBody = (read('stage3d.js').match(/function pokeChrome\(\)[\s\S]*?\n  \}/) || [''])[0];
  check(pokeBody.length > 0 && pokeBody.indexOf(':focus-within') < 0,
    'chrome guard no longer pins on :focus-within (mouse leftover focus)');
}
