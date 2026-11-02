// SPDX-License-Identifier: MIT
// Deterministic regression checks for scheduler integration and late media callbacks.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../crates/hertz-desktop/assets/wallpaper-scene.js'), 'utf8');
const url = 'https://' + 'a'.repeat(32) + '.' + 'b'.repeat(32) + '.wallpaper.invalid/files/assets/bg.webm';

function fixture(options = {}) {
  let nextId = 1, now = 0, selections = 0;
  const rafs = new Map(), timers = new Map(), events = [], elements = [], frames = [], selected = [];
  const host = { style: {}, appendChild() {} };
  function element(kind) {
    const listeners = new Map();
    let resolveDecode;
    const el = {
      kind, style: {}, paused: true, loads: 0, removed: false, src: '',
      addEventListener(name, callback) { listeners.set(name, callback); },
      removeEventListener(name) { listeners.delete(name); },
      setAttribute() {}, removeAttribute(name) { if (name === 'src') this.src = ''; },
      remove() { this.removed = true; },
      play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; }, load() { this.loads++; },
      requestVideoFrameCallback: options.noVideoFrames ? undefined : function(callback) { this.frameReady = callback; return 1; },
      cancelVideoFrameCallback() { this.frameCancelled = true; },
      decode() { return new Promise(resolve => { resolveDecode = resolve; }); },
      finishDecode() { resolveDecode(); }, emit(name) { listeners.get(name)?.(); },
    };
    elements.push(el);
    return el;
  }
  const runtime = {
    catalog: () => [{ id: 'coast', camera: {} }, { id: 'reactor', camera: {} }],
    create: () => ({
      select: async (id, state) => { selections++; selected.push({ id, params: state.params }); return { id, params: state.params }; },
      setParams(params) { selected.push({ id: selected.at(-1).id, params }); return { params }; },
      frame: frame => { frames.push(frame); return options.submitted ? options.submitted() : true; },
      dispose() {}, setServices() {}, resize() {}, setRig() {}, stats: () => ({}),
    }),
  };
  const window = { HertzStageRuntime: { SpaceStagePure: runtime }, ipc: { postMessage: message => events.push(message) } };
  if (options.binding) window.__hertzWallpaperBinding = options.binding;
  window.parent = window;
  const context = {
    window, document: { getElementById: () => host, createElement: element },
    innerWidth: 960, innerHeight: 540, performance: { now: () => now }, addEventListener() {},
    requestAnimationFrame: callback => { const id = nextId++; rafs.set(id, callback); return id; },
    cancelAnimationFrame: id => rafs.delete(id),
    setTimeout: callback => { const id = nextId++; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => nextId++, clearInterval() {},
  };
  vm.runInNewContext(source, context);
  return {
    api: window.hertzWallpaper, events, frames, elements, timers, selected, host,
    get selections() { return selections; },
    tick(stamp) { now = stamp; const callbacks = [...rafs.values()]; rafs.clear(); callbacks.forEach(callback => callback(now)); },
  };
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }
async function main() {
  for (const fps of [15, 30, 60]) {
    const f = fixture();
    f.api.applyConfig({ source: 'fixed', scene: 'coast', motion: 1 });
    f.api.start(fps); await flush();
    for (let i = 1; i <= 60; i++) f.tick(i * 1000 / 60);
    const seconds = f.frames.reduce((total, frame) => total + frame.dynamicDt, 0);
    assert.ok(Math.abs(seconds - 59 / 60) < .001, `${fps} fps must integrate all elapsed time: ${seconds}`);
    f.api.stop(); const count = f.frames.length;
    f.tick(100000); assert.equal(f.frames.length, count);
    f.api.start(fps);
    for (let i = 1; i <= 4; i++) f.tick(100000 + i * 1000 / 60);
    assert.ok(f.frames.at(-1).dynamicDt < .1, 'resume must not catch up paused time');
    const selections = f.selections;
    f.api.applyConfig({ source: 'fixed', scene: 'coast', quality: 'high' }); await flush();
    assert.equal(f.selections, selections + 1, 'quality change must reach the renderer');
    f.api.unmount();
  }

  const binding = { sessionId: 'a'.repeat(32), generation: 9 };
  const receipts = f => f.events.filter(event => event.startsWith('wallpaper_session ')).map(event => JSON.parse(event.slice('wallpaper_session '.length)));
  let submitted = false;
  const bound = fixture({ binding, submitted: () => submitted });
  assert.deepEqual(receipts(bound), [{ ...binding, event: 'pageHandshake' }]);
  assert.equal(bound.host.style.visibility, 'hidden');
  assert.equal(bound.api.reveal(), false, 'no reveal before an actual frame');
  bound.api.start(); await flush();
  assert.equal(receipts(bound).length, 1, 'mount completion is not firstFrame');
  for (let i = 1; i <= 4; i++) bound.tick(i * 1000 / 60);
  assert.equal(receipts(bound).length, 1, 'attempted submissions cannot report ready');
  submitted = true;
  for (let i = 5; i <= 8; i++) bound.tick(i * 1000 / 60);
  assert.deepEqual(receipts(bound)[1], { ...binding, event: 'firstFrame', frameKind: 'gl' });
  assert.equal(receipts(bound).length, 2, 'one firstFrame per native identity');
  assert.equal(bound.host.style.visibility, 'hidden', 'native host decides when all four facts hold');
  assert.equal(bound.api.reveal(), true);
  assert.equal(bound.host.style.visibility, 'visible');
  bound.api.unmount();

  const boundImage = fixture({ binding });
  boundImage.api.applyMedia({ kind: 'image', url });
  assert.equal(receipts(boundImage).length, 1);
  boundImage.elements.at(-1).finishDecode(); await flush();
  assert.deepEqual(receipts(boundImage)[1], { ...binding, event: 'firstFrame', frameKind: 'image' });
  boundImage.api.unmount();

  const boundVideo = fixture({ binding });
  boundVideo.api.applyMedia({ kind: 'video', url });
  const liveVideo = boundVideo.elements.at(-1);
  liveVideo.emit('loadeddata');
  assert.equal(receipts(boundVideo).length, 1, 'loadeddata is not a presented video frame');
  liveVideo.frameReady(); await flush();
  assert.deepEqual(receipts(boundVideo)[1], { ...binding, event: 'firstFrame', frameKind: 'video' });
  boundVideo.api.unmount();
  assert.equal(liveVideo.frameCancelled, true);

  const unsupported = fixture({ binding, noVideoFrames: true });
  assert.equal(unsupported.api.applyMedia({ kind: 'video', url }), false);
  unsupported.elements.at(-1).emit('loadeddata'); await flush();
  assert.equal(unsupported.api.debug().media.state, 'failed');
  assert.equal(unsupported.api.debug().media.error, 'media_frame_callback_unsupported');
  assert.equal(receipts(unsupported).length, 1);
  unsupported.api.unmount();

  const followed = fixture();
  followed.api.applyConfig({ source: 'follow', scene: 'coast', params: { speed: .5 } });
  followed.api.start(); await flush();
  assert.equal(followed.selected.at(-1).params.speed, .5);
  followed.api.applyFeed({ valid: true, playing: true, spectrum: { bands: Array(64).fill(0), energy: 0, ageMs: 0 }, space: { scene: 'reactor', params: { speed: 2 } } });
  await flush(); assert.equal(followed.api.debug().scene, 'reactor');
  followed.api.applyFeed(null); await flush();
  assert.equal(followed.api.debug().scene, 'coast', 'lost source restores explicit idle selection');
  assert.equal(followed.selected.at(-1).params.speed, .5, 'idle parameters remain saved');
  followed.api.unmount();

  const f = fixture();
  f.api.start(); await flush();
  assert.equal(f.api.applyMedia({ kind: 'video', url }), true);
  const video = f.elements.at(-1);
  video.emit('error');
  assert.equal(f.api.debug().media.state, 'failed');
  assert.equal(video.paused, true); assert.equal(video.src, ''); assert.equal(video.loads, 1);
  const readyEvents = f.events.filter(event => event === 'wallpaper_ready').length;
  video.frameReady(); await flush();
  assert.equal(f.api.debug().media.state, 'failed', 'late frame must not resurrect failed media');
  assert.equal(f.events.filter(event => event === 'wallpaper_ready').length, readyEvents);

  f.api.applyMedia({ kind: 'image', url });
  const image = f.elements.at(-1);
  [...f.timers.values()].forEach(callback => callback());
  assert.equal(f.api.debug().media.state, 'failed', 'image decode needs a bounded deadline');
  image.finishDecode(); await flush();
  assert.equal(f.api.debug().media.state, 'failed', 'late decode must not report ready');
  assert.equal(f.api.applyMedia({ kind: 'image', url: url.replace('/assets/', '/assets/../') }), false);
  f.api.applyMedia(null); await flush();
  assert.equal(f.api.debug().backend, 'space', 'clearing media must restore the scene');
  f.api.unmount();
  const audio = fixture();
  const hertzFeed = { valid: true, playing: false, positionMs: 2345, spectrum: { bands: Array(64).fill(.9), energy: .9, ageMs: 0 } };
  const systemInput = { kind: 'system', device: { kind: 'default' }, gain: 2, attackMs: 100, releaseMs: 500 };
  const systemFrame = (generation, seq, value, ageMs = 0, pageDispatchMs) => ({ generation, seq, bands: Array(64).fill(value), ageMs, pageDispatchMs });
  audio.api.applyConfig({ source:'fixed', scene:'coast', audioInput:systemInput });
  audio.api.applyFeed(hertzFeed);
  assert.equal(audio.api.debug(0).feedPeak, 0, 'Hertz spectrum cannot leak into a system consumer');
  assert.equal(audio.api.applyAudio(systemFrame(2,1,.2)), true);
  assert.ok(Math.abs(audio.api.debug(0).feedPeak - .4) < .00001, 'each consumer applies its gain');
  assert.equal(audio.api.debug(0).positionMs, 2345, 'system spectrum never forges the Hertz clock');
  assert.equal(audio.api.debug(0).playing, false, 'system spectrum never forges playback state');
  assert.equal(audio.api.applyAudio(systemFrame(1,100,.8)), false, 'old capture generation rejected');
  assert.equal(audio.api.applyAudio(systemFrame(2,1,.8)), false, 'same-generation duplicate rejected');
  assert.equal(audio.api.applyAudio({ ...systemFrame(99,2,.8), bands:[NaN] }), false, 'malformed input cannot advance the generation');
  assert.equal(audio.api.debug(0).audioGeneration, 2);
  assert.equal(audio.api.applyAudio({...systemFrame(99,2,.8),sourceKey:'fixed:old-device'}),false,'queued old-device frames cannot enter a new source configuration');
  assert.ok(Math.abs(audio.api.debug(750).feedPeak - .2) < .00001, 'system data decays after 500ms');
  assert.equal(audio.api.debug(1000).feedPeak, 0, 'system data reaches exact zero by one second');
  audio.api.start(60); await flush();
  audio.tick(16); const attack1 = audio.frames.at(-1).level;
  audio.tick(116); const attack2 = audio.frames.at(-1).level;
  assert.ok(attack1 > 0 && attack1 < attack2 && attack2 < .4, 'attack smoothing reaches the scene gradually');
  audio.api.applyAudio(systemFrame(2,2,0)); audio.tick(216);
  const released = audio.frames.at(-1).level;
  assert.ok(released > 0 && released < attack2, 'release smoothing is independent from attack');
  audio.tick(1200); assert.equal(audio.frames.at(-1).level, 0, 'long release cannot keep stale audio alive');
  audio.api.applyAudio({generation:3,seq:0,bands:null});
  assert.equal(audio.api.applyAudio(systemFrame(2,3,.8)), false, 'invalidation preserves the generation barrier');
  audio.api.applyConfig({audioInput:{kind:'hertz',gain:1,attackMs:0,releaseMs:0}});
  assert.equal(audio.api.applyAudio(systemFrame(4,1,.8)), false, 'system frames are isolated from Hertz consumers');
  audio.api.applyConfig({audioInput:{kind:'none'}});
  assert.equal(audio.api.debug(1200).feedPeak, 0, 'none always clears audio response');
  audio.api.applyConfig({audioInput:systemInput});
  assert.equal(audio.api.applyAudio(systemFrame(4,1,.8,1000)), false, 'queued stale PCM is rejected');
  assert.equal(audio.api.applyAudio(systemFrame(5,1,.2,0,0)), false, 'page dispatch delay contributes to sample age');
  audio.api.applyConfig({audioInput:{...systemInput,device:{id:'endpoint-a',kind:'fixed'}}});
  assert.equal(audio.api.applyAudio({...systemFrame(6,1,.2),sourceKey:'fixed:endpoint-a'}),true,'fixed device identity is independent of JSON property order');
  audio.api.unmount();
  console.log('wallpaper runtime checks passed: 15/30/60 fps integration, resume, quality, source isolation, spectrum freshness, gain/attack/release, native identity, actual first frames, failure release and late callbacks');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
