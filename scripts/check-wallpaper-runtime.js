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
      getContext: () => ({ setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, stroke() {}, fill() {}, createRadialGradient: () => ({ addColorStop() {} }) }),
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
    runTimers(stamp) { now = stamp; const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); },
  };
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }
async function main() {
  const pointer = fixture();
  pointer.api.applyConfig({ source: 'fixed', scene: 'coast' });
  pointer.api.start(30); await flush();
  const press = serial => ({ active: true, x: .4, y: .5, click: { serial, x: .4, y: .5 } });
  assert.equal(pointer.api.applyPointer(press(1)), false, 'pointer remains opt-in');
  pointer.api.applyConfig({ source: 'fixed', scene: 'coast', pointer: true });
  assert.equal(pointer.api.applyPointer(press(1)), true);
  pointer.api.applyPointer(press(1));
  assert.equal(pointer.api.debug().pointer.clicks, 1, 'a sampled press must trigger only once');
  assert.equal(pointer.api.applyPointer({ ...press(2), x: NaN }), false);
  pointer.tick(500);
  assert.equal(pointer.api.applyPointer({ ...press(2), pageDispatchMs: 0 }), false, 'queued stale input is discarded');
  for (let i = 2; i < 100; i++) pointer.api.applyPointer(press(i));
  assert.equal(pointer.api.debug().pointer.waves, 24, 'effects have a fixed memory/work bound');
  pointer.api.stop();
  assert.equal(pointer.api.debug().pointer.waves, 0);
  assert.equal(pointer.elements.filter(el => el.id === 'wallpaper-pointer-effects' && !el.removed).length, 0);
  pointer.api.start();
  pointer.api.applyConfig({ source: 'fixed', scene: 'coast', pointer: true, motion: 0 });
  assert.equal(pointer.api.applyPointer(press(101)), false, 'frozen wallpaper has no pointer motion');
  pointer.api.applyConfig({ source: 'fixed', scene: 'coast', pointer: true, motion: 1, params: { reduced: true } });
  assert.equal(pointer.api.applyPointer(press(101)), false, 'reduced scene motion also suppresses effects');
  pointer.api.applyConfig({ source: 'fixed', scene: 'coast', pointer: true, motion: 1 });
  pointer.api.applyMedia({ kind: 'image', url });
  pointer.elements.at(-1).finishDecode(); await flush();
  pointer.api.applyPointer(press(101));
  assert.equal(pointer.api.debug().pointer.mediaAnimating, true, 'static media animates only on input');
  for (let i = 1; i <= 90; i++) pointer.tick(500 + i * 1000 / 60);
  assert.equal(pointer.api.debug().pointer.waves, 0);
  assert.equal(pointer.api.debug().pointer.mediaAnimating, false, 'the media effect loop sleeps once ripples fade');
  pointer.api.unmount();

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
  const beforeLoss = bound.api.debug().draws;
  bound.elements.find(el => el.kind === 'canvas').emit('webglcontextlost');
  assert.match(bound.events.at(-1), /^wallpaper_heartbeat \d+ \d+ 0 1$/, 'context loss reaches native even though RAF stops');
  bound.tick(1000);
  assert.equal(bound.api.debug().draws, beforeLoss, 'lost context stops GL submissions');
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

  function pausableVideo() {
    const f = fixture({binding});
    f.api.applyConfig({motion:1}); f.api.start(30); f.api.applyMedia({kind:'video',url});
    const el = f.elements.at(-1);
    el.currentTime = 1.25; el.totalFrames = 15;
    el.getVideoPlaybackQuality = () => ({totalVideoFrames:el.totalFrames});
    el.frameReady(0,{mediaTime:1.25});
    return {f,el};
  }
  const {f:confirmedPause,el:confirmedEl} = pausableVideo();
  confirmedPause.api.stop(7);
  assert.equal(confirmedEl.paused,true);
  assert.equal(receipts(confirmedPause).filter(item=>item.event==='mediaPaused').length,0,'pause() alone is not proof');
  const pendingProof = [...confirmedPause.timers.values()][0];
  confirmedPause.api.stop(7);
  assert.equal(confirmedPause.timers.size,1,'repeated stop retains one check and deadline');
  confirmedPause.runTimers(200);
  assert.deepEqual(receipts(confirmedPause).at(-1),{...binding,event:'mediaPaused',pauseToken:7});
  assert.equal(confirmedPause.timers.size,0,'a confirmed pause does not start a permanent polling loop');
  confirmedPause.api.stop(7);
  assert.equal(confirmedPause.timers.size,0,'confirmed token is idempotent');
  confirmedPause.api.start(30);
  assert.equal(confirmedEl.paused,false);
  confirmedPause.api.stop(8);
  const previousCount = receipts(confirmedPause).length;
  pendingProof();
  assert.equal(receipts(confirmedPause).length,previousCount,'old check cannot acknowledge a later pause');
  confirmedPause.runTimers(400);
  assert.deepEqual(receipts(confirmedPause).at(-1),{...binding,event:'mediaPaused',pauseToken:8});
  confirmedPause.api.start(30); confirmedPause.api.stop(9);
  const releasedProof = [...confirmedPause.timers.values()][0];
  confirmedPause.api.unmount(); releasedProof();
  assert.equal(confirmedPause.timers.size,0);
  assert.equal(receipts(confirmedPause).some(item=>item.pauseToken===9),false,'released media cannot confirm a pause');

  for (const mode of ['pause-ignored','clock-advances','frames-advance']) {
    const {f,el} = pausableVideo();
    if(mode==='pause-ignored') el.pause = () => {};
    f.api.stop(1);
    for(let elapsed=200;elapsed<=1800;elapsed+=200) {
      if(mode==='clock-advances')el.currentTime+=.1;
      if(mode==='frames-advance')el.totalFrames++;
      f.runTimers(elapsed);
    }
    assert.equal(f.api.debug().media.state,'failed',mode+' must fail within the bounded drain period');
    assert.equal(el.removed,true);
    assert.equal(receipts(f).some(item=>item.event==='mediaPaused'),false);
    assert.ok(f.events.includes('wallpaper_media_failed media_pause_unconfirmed'));
    f.api.unmount();
  }

  const unsupported = fixture({ binding, noVideoFrames: true });
  assert.equal(unsupported.api.applyMedia({ kind: 'video', url }), false);
  unsupported.elements.at(-1).emit('loadeddata'); await flush();
  assert.equal(unsupported.api.debug().media.state, 'failed');
  const resume = fixture();
  resume.api.applyConfig({motion:1});resume.api.start(30);
  resume.api.applyMedia({kind:'video',url});
  const resumedVideo=resume.elements.at(-1);resumedVideo.frameReady();await flush();
  resume.api.stop();
  resumedVideo.play=()=>Promise.reject(new Error('resume rejected'));
  resume.api.start(30);await flush();
  assert.equal(resume.api.debug().media.state,'failed','rejected resume must enter the native failure/cover path');
  assert.equal(resumedVideo.removed,true);
  assert.ok(resume.events.includes('wallpaper_media_failed media_play_rejected'));
  const paused = fixture();
  paused.api.applyConfig({motion:1});paused.api.start(30);paused.api.applyMedia({kind:'video',url});
  const pausedVideo=paused.elements.at(-1);pausedVideo.frameReady();await flush();
  let rejectPlay;
  pausedVideo.play=()=>new Promise((_,reject)=>{rejectPlay=reject;});
  paused.api.stop();paused.api.start(30);paused.api.stop();
  rejectPlay(new Error('interrupted by pause'));await flush();
  assert.equal(paused.api.debug().media.state,'ready','an intentional pause supersedes an earlier play attempt');
  assert.equal(unsupported.api.debug().media.error, 'media_frame_callback_unsupported');
  assert.equal(receipts(unsupported).length, 1);
  unsupported.api.unmount();

  const restored = fixture({binding});
  restored.api.applyConfig({motion:1});restored.api.start(30);
  assert.equal(restored.api.applyMedia({kind:'video',url,resumePositionMs:1250}),true);
  const restoredVideo=restored.elements.at(-1);
  restoredVideo.duration=4;restoredVideo.currentTime=0;
  assert.equal(restoredVideo.paused,true,'restoring must not play the file start');
  assert.equal(restoredVideo.frameReady,undefined,'no start-frame callback is registered before the seek');
  restoredVideo.emit('loadedmetadata');
  assert.equal(restoredVideo.currentTime,1.25);
  restoredVideo.seeking=true;restoredVideo.emit('seeked');
  assert.equal(restoredVideo.frameReady,undefined,'a spurious seeked event cannot finish an active seek');
  restoredVideo.seeking=false;restoredVideo.emit('seeked');
  assert.equal(restoredVideo.paused,false);assert.equal(restored.api.debug().media.state,'loading');
  assert.match(restoredVideo.style.cssText,/visibility:hidden/);
  assert.notEqual(restoredVideo.style.visibility,'visible','seek completion alone is not a presented frame');
  restoredVideo.frameReady(0,{mediaTime:1.25});await flush();
  assert.equal(restored.api.debug().media.state,'ready');
  assert.equal(restored.api.debug().media.firstFrameTimeMs,1250);
  assert.deepEqual(receipts(restored).filter(item=>item.event==='firstFrame'),[{...binding,event:'firstFrame',frameKind:'video'}]);
  restoredVideo.currentTime=2.1;restored.api.stop();
  assert.deepEqual(receipts(restored).at(-1),{...binding,event:'mediaPosition',positionMs:2100});
  const count=receipts(restored).length;restored.api.stop();
  assert.equal(receipts(restored).length,count,'repeated native stop does not flood position receipts');
  const staleFrame=restoredVideo.frameReady;
  restored.api.applyMedia({kind:'video',url,resumePositionMs:500});
  const replacement=restored.elements.at(-1);
  restoredVideo.emit('seeked');staleFrame(0,{mediaTime:2.1});
  assert.equal(restored.api.debug().media.state,'loading','old seek/frame cannot reveal a replacement');
  replacement.duration=.4;replacement.emit('loadedmetadata');
  assert.equal(restored.api.debug().media.error,'media_resume_out_of_range');
  assert.equal(replacement.removed,true);
  for(const position of [-1,NaN,Infinity,'500',.5]) {
    assert.equal(fixture().api.applyMedia({kind:'video',url,resumePositionMs:position}),false);
  }
  assert.equal(fixture().api.applyMedia({kind:'image',url,resumePositionMs:5}),false);

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
