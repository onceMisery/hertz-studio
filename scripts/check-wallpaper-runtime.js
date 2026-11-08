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
  const rafs = new Map(), timers = new Map(), timerDeadlines = new Map(), events = [], elements = [], frames = [], selected = [];
  const host = { style: {}, appendChild() {} };
  function element(kind) {
    const listeners = new Map();
    let resolveDecode;
    const el = {
      kind, style: {}, paused: true, loads: 0, removed: false, src: '', frameCallbacks: new Map(), playCalls: 0,
      getContext: () => ({ setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, stroke() {}, fill() {}, createRadialGradient: () => ({ addColorStop() {} }) }),
      addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
      removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
      setAttribute() {}, removeAttribute(name) { if (name === 'src') this.src = ''; },
      remove() { this.removed = true; },
      play() { this.playCalls++; this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; }, load() { this.loads++; },
      requestVideoFrameCallback: options.noVideoFrames ? undefined : function(callback) {
        const id = nextId++;
        this.frameReady = (...args) => { this.frameCallbacks.delete(id); callback(...args); };
        this.frameCallbacks.set(id, this.frameReady); return id;
      },
      cancelVideoFrameCallback(id) { this.frameCancelled = true; this.frameCallbacks.delete(id); },
      decode() { return new Promise(resolve => { resolveDecode = resolve; }); },
      finishDecode() { resolveDecode(); }, emit(name) { [...(listeners.get(name) || [])].forEach(callback => callback()); },
      listenerCount(name) { return listeners.get(name)?.size || 0; },
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
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, callback); timerDeadlines.set(id, now + delay); return id; },
    clearTimeout: id => { timers.delete(id); timerDeadlines.delete(id); }, setInterval: () => nextId++, clearInterval() {},
  };
  vm.runInNewContext(source, context);
  return {
    api: window.hertzWallpaper, events, frames, elements, timers, timerDeadlines, selected, host,
    get selections() { return selections; },
    get now() { return now; },
    tick(stamp) { now = stamp; const callbacks = [...rafs.values()]; rafs.clear(); callbacks.forEach(callback => callback(now)); },
    setNow(stamp) { now = stamp; },
    runTimers(stamp) { now = stamp; const callbacks = [...timers.values()]; timers.clear(); timerDeadlines.clear(); callbacks.forEach(callback => callback()); },
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
  boundImage.api.start(30);
  assert.equal(receipts(boundImage).length, 1);
  boundImage.elements.at(-1).finishDecode(); await flush();
  assert.deepEqual(receipts(boundImage)[1], { ...binding, event: 'firstFrame', frameKind: 'image' });
  const imageReveals = () => receipts(boundImage).filter(item => item.event === 'revealed');
  assert.equal(boundImage.api.reveal(), true);
  boundImage.tick(16);
  boundImage.api.stop();
  assert.equal(boundImage.api.reveal(), false, 'a stopped image cannot acknowledge a release');
  boundImage.tick(32);
  assert.equal(imageReveals().length, 0, 'pause between reveal frames cancels the old image receipt');
  boundImage.api.start(30);
  assert.equal(boundImage.api.reveal(), true);
  boundImage.api.reveal();
  boundImage.tick(48);
  boundImage.api.stop(); boundImage.api.stop(); boundImage.api.start(30);
  assert.equal(boundImage.api.reveal(), true);
  boundImage.tick(64);
  assert.equal(imageReveals().length, 0, 'an earlier resume cannot acknowledge the next release');
  boundImage.tick(80);
  assert.deepEqual(imageReveals(), [{ ...binding, event: 'revealed' }]);
  boundImage.api.reveal(); boundImage.tick(96); boundImage.tick(112);
  assert.equal(imageReveals().length, 1, 'repeated reveal is idempotent within one running period');
  boundImage.api.stop(); boundImage.api.start(30); boundImage.api.reveal();
  boundImage.tick(128); boundImage.tick(144);
  assert.equal(imageReveals().length, 2, 'a retained image can acknowledge a later resume');
  boundImage.api.stop(); boundImage.api.start(30); boundImage.api.reveal();
  boundImage.tick(160);
  boundImage.api.applyMedia({ kind: 'image', url });
  boundImage.elements.at(-1).finishDecode(); await flush();
  boundImage.api.reveal(); boundImage.tick(176);
  assert.equal(imageReveals().length, 2, 'a replaced image cannot acknowledge the current source');
  boundImage.tick(192);
  assert.equal(imageReveals().length, 3, 'only the replacement image produces its reveal receipt');
  assert.equal(receipts(boundImage).filter(item => item.event === 'firstFrame').length, 1, 'resume keeps one native first-frame identity');
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

  function groupVideo({positionMs = 0, durationMs = 10000, motion = 1, ready = true} = {}) {
    const f = fixture({binding});
    f.api.applyConfig({motion});
    assert.equal(f.api.applyMedia({kind:'video',url,groupClock:true}),true);
    const el = f.elements.at(-1), seeks = [];
    let position = positionMs / 1000;
    Object.defineProperty(el,'currentTime',{get:()=>position,set:value=>{position=value;seeks.push(value * 1000);el.seeking=true;}});
    el.duration = durationMs / 1000;
    el.setPosition = value => { position = value / 1000; };
    el.finishSeek = () => { el.seeking = false; el.emit('seeked'); };
    el.present = (value = el.currentTime * 1000, presentationTime = f.now) => el.frameReady(f.now,{mediaTime:value / 1000,presentationTime});
    f.api.start(30);
    if (ready) el.present();
    return {f,el,seeks};
  }
  const clockRequest = (timeMs, pageDispatchMs = 0, token = 1, running = true) => ({token,timeMs,pageDispatchMs,running});
  const revealedReceipts = f => receipts(f).filter(item=>item.event==='mediaClockRevealed');
  assert.equal(fixture().api.applyMedia({kind:'video',url,groupClock:true}),false,'a native controller identity is required');
  assert.equal(fixture({binding}).api.applyMedia({kind:'image',url,groupClock:true}),false);
  assert.equal(fixture({binding}).api.applyMedia({kind:'video',url,groupClock:'true'}),false);

  const held = groupVideo({ready:false});
  assert.equal(held.el.paused,false,'hidden decoding must run until a real frame arrives');
  held.el.emit('loadeddata');
  assert.equal(held.f.api.debug().media.state,'loading');
  assert.equal(held.f.api.revealMediaClock(clockRequest(0)),false);
  held.el.present();
  assert.equal(held.el.paused,true,'the first real group frame enters hold');
  assert.equal(held.f.api.debug().media.clock.held,true);
  assert.equal(held.f.api.debug().media.clock.firstFrameHeld,true);
  assert.equal(held.f.host.style.visibility,'hidden');
  held.f.api.start();held.f.api.applyConfig({motion:1});
  assert.equal(held.el.paused,true,'ordinary start/config cannot release the barrier');
  assert.equal(held.f.api.reveal(),false,'ordinary reveal cannot bypass the group clock');
  assert.equal(held.f.api.syncMediaClock(clockRequest(0)),false,'periodic sync cannot release held video');
  assert.equal(held.f.api.revealMediaClock(clockRequest(0)),true);
  assert.equal(held.el.paused,false);
  assert.equal(held.f.host.style.visibility,'visible');
  assert.equal(held.f.api.revealMediaClock(clockRequest(0)),true,'duplicate release is idempotent before its receipt');
  held.f.tick(16);held.f.tick(32);
  assert.equal(revealedReceipts(held.f).length,1);
  assert.deepEqual(revealedReceipts(held.f)[0],{...binding,event:'mediaClockRevealed',clockToken:1});
  assert.equal(receipts(held.f).some(item=>item.event==='revealed'),false,'group releases emit only the token-bound reveal receipt');
  assert.equal(held.f.api.debug().media.clock.releases,1);

  for(const [positionMs,targetMs] of [[1100,1000],[900,1000],[9950,50],[50,9950]]) {
    const g=groupVideo({positionMs});
    assert.equal(g.f.api.revealMediaClock(clockRequest(targetMs)),true);
    assert.equal(g.seeks.length,0,'exactly 100ms circular deviation must not seek');
    assert.equal(g.f.host.style.visibility,'visible');
    g.f.api.unmount();
  }
  const circular=groupVideo({positionMs:9960});
  circular.f.api.revealMediaClock(clockRequest(40));
  assert.equal(circular.seeks.length,0,'loop-end and loop-start may be only 80ms apart');
  assert.equal(circular.f.api.debug().media.clock.driftMs,-80);

  const aligned=groupVideo();
  assert.equal(aligned.f.api.revealMediaClock(clockRequest(1250)),true);
  assert.deepEqual(aligned.seeks,[1250]);
  assert.equal(aligned.f.api.reveal(),false);
  aligned.el.emit('loadeddata');aligned.el.emit('seeked');
  assert.equal(aligned.f.host.style.visibility,'hidden','data and spurious seek events cannot reveal');
  aligned.el.present(0,-1);
  assert.equal(aligned.f.host.style.visibility,'hidden','an old pre-seek frame is not proof');
  aligned.el.finishSeek();
  assert.equal(aligned.f.host.style.visibility,'hidden','seek completion still needs a real aligned frame');
  aligned.el.present(1250);
  assert.equal(aligned.f.host.style.visibility,'visible');
  assert.equal(aligned.el.listenerCount('seeked'),0);
  assert.equal(aligned.el.frameCallbacks.size,0);
  assert.equal(aligned.f.timers.size,0,'completed release clears its alignment deadline');
  const earlyFrame=groupVideo();
  earlyFrame.f.api.revealMediaClock(clockRequest(1500,0,1,false));
  earlyFrame.el.present(1500);
  assert.equal(earlyFrame.f.host.style.visibility,'hidden','a paused seek frame may precede seeked, but cannot replace it');
  earlyFrame.el.finishSeek();
  assert.equal(earlyFrame.f.host.style.visibility,'visible');
  assert.equal(earlyFrame.el.paused,true);
  earlyFrame.f.api.start();assert.equal(earlyFrame.el.paused,true,'ordinary start respects a stopped group clock');

  const delivery=groupVideo();
  delivery.f.setNow(450);
  delivery.f.api.revealMediaClock(clockRequest(1000));
  assert.deepEqual(delivery.seeks,[1450],'running group phase includes bounded page delivery age');
  delivery.el.finishSeek();delivery.el.present(1450);
  assert.equal(delivery.f.api.debug().media.clock.deliveryAgeMs,450);
  const stoppedDelivery=groupVideo();
  stoppedDelivery.f.setNow(450);
  stoppedDelivery.f.api.revealMediaClock(clockRequest(1000,0,1,false));
  assert.deepEqual(stoppedDelivery.seeks,[1000],'a stopped group phase does not include delivery age');
  stoppedDelivery.el.finishSeek();stoppedDelivery.el.present();
  assert.equal(stoppedDelivery.el.paused,true);

  const sampled=groupVideo();
  sampled.f.api.revealMediaClock(clockRequest(0,0,5));
  sampled.f.setNow(1999);sampled.el.setPosition(0);
  assert.equal(sampled.f.api.syncMediaClock(clockRequest(2000,1999,5)),false);
  assert.equal(sampled.seeks.length,0,'sync frequency is capped at one check per 2000ms');
  sampled.f.setNow(2000);sampled.el.setPosition(2100);
  assert.equal(sampled.f.api.syncMediaClock(clockRequest(2000,2000,5)),true);
  assert.equal(sampled.seeks.length,0,'periodic exact-100ms deviation also does not seek');
  sampled.f.setNow(4000);sampled.el.setPosition(4100.01);
  assert.equal(sampled.f.api.syncMediaClock(clockRequest(4000,4000,5)),true);
  assert.deepEqual(sampled.seeks,[4000],'same token accepts subsequent sync and strict >100ms corrects');
  assert.equal(sampled.f.host.style.visibility,'visible','periodic correction does not restart the hidden release barrier');
  sampled.el.finishSeek();sampled.el.present();
  sampled.f.setNow(6000);sampled.el.setPosition(9990);
  assert.equal(sampled.f.api.syncMediaClock(clockRequest(20,6000,5)),true);
  assert.equal(sampled.seeks.length,1,'periodic checks use circular distance at the loop boundary');
  assert.equal(sampled.f.api.revealMediaClock(clockRequest(20,6000,4)),false,'a lower token cannot replace a current clock');
  sampled.f.setNow(6100);
  assert.equal(sampled.f.api.revealMediaClock(clockRequest(20,5999,5)),false,'queued older dispatches for the same token are stale');
  for(const invalid of [null,{...clockRequest(0),token:0},{...clockRequest(0),token:1.5},
    {...clockRequest(0),token:Number.MAX_SAFE_INTEGER+1},{...clockRequest(0),timeMs:-1},
    {...clockRequest(0),timeMs:NaN},{...clockRequest(0),timeMs:.5},
    {...clockRequest(0),pageDispatchMs:-1},{...clockRequest(0),pageDispatchMs:Infinity},
    {...clockRequest(0),running:1}]) assert.equal(sampled.f.api.revealMediaClock(invalid),false);
  assert.equal(sampled.f.api.debug().media.clock.token,5,'invalid requests do not consume newer tokens');
  assert.equal(sampled.f.api.revealMediaClock(clockRequest(0,5599,6)),false,'delivery age >500ms is rejected');
  assert.equal(sampled.f.api.revealMediaClock(clockRequest(0,6601,6)),false,'an implausibly future PageClock is rejected');
  sampled.f.setNow(8000);sampled.el.setPosition(7000);
  assert.equal(sampled.f.api.syncMediaClock(clockRequest(8000,8000,5,false)),true);
  assert.equal(sampled.f.api.debug().media.clock.syncs,4);
  assert.equal(sampled.f.api.debug().media.clock.lastSyncAtMs,8000);
  assert.equal(sampled.el.paused,true);
  assert.equal(sampled.el.currentTime,7,'running:false freezes the existing frame even if native content phase advances');
  assert.equal(sampled.seeks.length,1);

  const frozen=groupVideo({motion:0});
  frozen.f.api.revealMediaClock(clockRequest(1200));
  frozen.el.finishSeek();frozen.el.present();
  assert.equal(frozen.el.paused,true,'release never overrides motion=0');
  frozen.f.setNow(2000);
  assert.equal(frozen.f.api.syncMediaClock(clockRequest(5000,2000)),true);
  assert.deepEqual(frozen.seeks,[1200],'periodic samples cannot move a zero-motion video');

  const resumedGroup=groupVideo();
  resumedGroup.f.api.revealMediaClock(clockRequest(0));
  resumedGroup.f.tick(16);resumedGroup.f.tick(32);
  assert.equal(revealedReceipts(resumedGroup.f).length,1);
  resumedGroup.f.api.stop();
  assert.equal(resumedGroup.el.paused,true);
  assert.equal(resumedGroup.f.host.style.visibility,'visible','policy stop retains the last frozen frame');
  resumedGroup.f.api.start();
  assert.equal(resumedGroup.f.host.style.visibility,'hidden','resume hides stale content before group sampling');
  assert.equal(resumedGroup.el.paused,true);
  assert.equal(resumedGroup.f.api.reveal(),false);
  assert.equal(resumedGroup.f.api.revealMediaClock(clockRequest(0)),false,'queued pre-stop dispatch cannot release the resumed page');
  resumedGroup.f.setNow(1000);
  resumedGroup.f.api.revealMediaClock(clockRequest(1000,1000,2));
  resumedGroup.el.finishSeek();resumedGroup.el.present();
  resumedGroup.f.tick(1016);resumedGroup.f.tick(1032);
  assert.equal(revealedReceipts(resumedGroup.f).length,2,'group resume rearms the existing identity reveal receipt');
  assert.equal(revealedReceipts(resumedGroup.f).at(-1).clockToken,2);

  const interrupted=groupVideo();
  interrupted.f.api.revealMediaClock(clockRequest(1500));
  const interruptedFrame=interrupted.el.frameReady, interruptedDeadline=[...interrupted.f.timers.values()][0];
  interrupted.f.api.stop(7);
  assert.equal(interrupted.el.listenerCount('seeked'),0);
  assert.equal(interrupted.el.frameCallbacks.size,0);
  interrupted.el.finishSeek();interruptedFrame(0,{mediaTime:1.5});interruptedDeadline();
  assert.equal(interrupted.f.host.style.visibility,'hidden','stop fences late seek, frame, and timeout callbacks');
  interrupted.f.runTimers(200);
  assert.equal(receipts(interrupted.f).filter(item=>item.event==='mediaPaused').length,1,'alignment cleanup preserves ordinary pause proof');
  assert.equal(interrupted.f.timers.size,0);
  assert.equal(interrupted.f.api.debug().media.state,'ready');

  for(const {motion,running,positionMs,stoppedPositionMs=positionMs} of [
    {motion:0,running:false,positionMs:1500},
    {motion:1,running:false,positionMs:0},
    {motion:0,running:true,positionMs:0,stoppedPositionMs:9999.9995},
  ]) {
    const lostProof=groupVideo({motion,positionMs:positionMs===0?500:0});
    lostProof.f.api.revealMediaClock(clockRequest(positionMs,0,1,running));
    const cancelledFrame=lostProof.el.frameReady, cancelledDeadline=[...lostProof.f.timers.values()][0];
    lostProof.f.api.stop();lostProof.el.setPosition(stoppedPositionMs);lostProof.el.finishSeek();
    cancelledFrame(0,{mediaTime:positionMs/1000,presentationTime:0});
    assert.equal(lostProof.f.api.debug().session.revealed,false);
    lostProof.f.api.start();
    assert.equal(lostProof.f.api.revealMediaClock(clockRequest(positionMs,0,2,running)),true);
    assert.equal(lostProof.seeks.length,2,'release renews a lost paused-frame proof even inside drift tolerance');
    const renewedPosition=lostProof.seeks[1];
    assert.ok(renewedPosition>=0&&renewedPosition<10000);
    assert.ok(Math.abs(renewedPosition-stoppedPositionMs)>0&&Math.abs(renewedPosition-stoppedPositionMs)<=.001000001,'proof seek uses at most one microsecond inside video bounds');
    assert.equal(lostProof.el.paused,true,'proof renewal cannot run a frozen video');
    assert.equal(lostProof.f.api.debug().media.clock.corrections,1,'proof renewal is separate from drift correction count');
    cancelledDeadline();cancelledFrame(0,{mediaTime:positionMs/1000,presentationTime:0});
    assert.equal(lostProof.f.host.style.visibility,'hidden','cancelled release callbacks cannot satisfy the new token');
    lostProof.el.finishSeek();lostProof.el.present(positionMs);
    assert.equal(lostProof.f.host.style.visibility,'visible');
    assert.equal(lostProof.el.paused,true);
    lostProof.f.tick(16);lostProof.f.tick(32);
    assert.deepEqual(revealedReceipts(lostProof.f),[{...binding,event:'mediaClockRevealed',clockToken:2}]);
    assert.equal(lostProof.f.timers.size,0);assert.equal(lostProof.el.frameCallbacks.size,0);
    lostProof.f.runTimers(3001);
    assert.equal(lostProof.f.api.debug().media.state,'ready','renewed proof prevents the original three-second resume timeout');
    lostProof.f.api.unmount();
  }
  const sparseFrames=groupVideo({motion:0});
  sparseFrames.f.setNow(10);
  sparseFrames.f.api.revealMediaClock(clockRequest(1250,10,1,false));
  sparseFrames.el.present(1000,9);
  assert.equal(sparseFrames.f.host.style.visibility,'hidden','old presentation timestamps still cannot prove a new seek');
  sparseFrames.el.present(1000,10);
  assert.equal(sparseFrames.f.host.style.visibility,'hidden','fresh sparse-frame evidence still requires seeked');
  sparseFrames.el.finishSeek();
  assert.equal(sparseFrames.f.host.style.visibility,'visible','2fps frame PTS may precede desired phase by 250ms');
  assert.equal(sparseFrames.el.currentTime,1.25);
  assert.equal(sparseFrames.el.paused,true);sparseFrames.f.api.unmount();

  const queuedReveal=groupVideo();
  queuedReveal.f.api.revealMediaClock(clockRequest(0));
  queuedReveal.f.api.stop();queuedReveal.f.tick(16);queuedReveal.f.tick(32);
  assert.equal(revealedReceipts(queuedReveal.f).length,0,'a queued reveal receipt cannot escape after stop');
  const replacedGroup=groupVideo();
  replacedGroup.f.api.revealMediaClock(clockRequest(1500));
  const staleGroupFrame=replacedGroup.el.frameReady, staleGroupDeadline=[...replacedGroup.f.timers.values()][0];
  replacedGroup.f.api.applyMedia({kind:'video',url,groupClock:true});
  assert.equal(replacedGroup.el.frameCallbacks.size,0);
  staleGroupFrame(0,{mediaTime:1.5});staleGroupDeadline();replacedGroup.el.finishSeek();
  assert.equal(replacedGroup.f.api.debug().media.state,'loading');
  assert.equal(replacedGroup.f.api.debug().media.clock.token,0,'old callbacks cannot mutate a replacement record');
  assert.equal(replacedGroup.f.host.style.visibility,'hidden');
  replacedGroup.f.api.unmount();
  assert.equal(replacedGroup.f.timers.size,0);

  const slowAlign=groupVideo();
  slowAlign.f.api.revealMediaClock(clockRequest(1000));
  const originalDeadline=[...slowAlign.f.timerDeadlines.values()][0];
  slowAlign.f.setNow(2500);
  slowAlign.f.api.revealMediaClock(clockRequest(3500,2500));
  assert.equal([...slowAlign.f.timerDeadlines.values()][0],originalDeadline,'same-token release retries cannot extend the alignment deadline');
  slowAlign.f.setNow(2800);
  slowAlign.f.api.revealMediaClock(clockRequest(3800,2800,2));
  assert.equal([...slowAlign.f.timerDeadlines.values()][0],3000,'superseding alignment preserves the pending deadline too');
  slowAlign.el.finishSeek();slowAlign.el.emit('loadeddata');
  slowAlign.f.runTimers(3000);
  assert.equal(slowAlign.f.api.debug().media.error,'media_clock_alignment_timeout');
  assert.equal(slowAlign.el.paused,true);
  assert.equal(slowAlign.el.removed,true);
  assert.equal(slowAlign.el.frameCallbacks.size,0);
  assert.equal(slowAlign.el.listenerCount('seeked'),0);
  assert.equal(slowAlign.f.timers.size,0);
  const lateAlignedFrame=groupVideo();
  lateAlignedFrame.f.api.revealMediaClock(clockRequest(1500,0,1,false));
  lateAlignedFrame.el.finishSeek();
  lateAlignedFrame.f.setNow(3001);lateAlignedFrame.el.present();
  assert.equal(lateAlignedFrame.f.api.debug().media.error,'media_clock_alignment_timeout','a delayed frame cannot beat a due timeout merely by winning task-queue order');
  const advancingGroup=groupVideo();
  advancingGroup.f.api.revealMediaClock(clockRequest(1000));
  advancingGroup.f.setNow(150);advancingGroup.el.finishSeek();advancingGroup.el.present();
  assert.deepEqual(advancingGroup.seeks,[1000,1150],'release rechecks phase after an expensive seek');
  assert.equal(advancingGroup.f.host.style.visibility,'hidden');
  advancingGroup.el.finishSeek();advancingGroup.el.present();
  assert.equal(advancingGroup.f.host.style.visibility,'visible');
  const rejectedGroupPlay=groupVideo();
  rejectedGroupPlay.el.play=()=>Promise.reject(new Error('blocked'));
  rejectedGroupPlay.f.api.revealMediaClock(clockRequest(1000));
  rejectedGroupPlay.el.finishSeek();await flush();
  assert.equal(rejectedGroupPlay.f.api.debug().media.error,'media_play_rejected');
  assert.equal(rejectedGroupPlay.el.frameCallbacks.size,0);
  assert.equal(rejectedGroupPlay.f.timers.size,0);
  const interruptedGroupPlay=groupVideo();
  let rejectGroupPlay;
  interruptedGroupPlay.el.play=()=>new Promise((_,reject)=>{rejectGroupPlay=reject;});
  interruptedGroupPlay.f.api.revealMediaClock(clockRequest(1000));
  interruptedGroupPlay.el.finishSeek();interruptedGroupPlay.f.api.stop();
  rejectGroupPlay(new Error('stopped'));await flush();
  assert.equal(interruptedGroupPlay.f.api.debug().media.state,'ready','intentional stop supersedes rejected in-flight alignment play');
  const tokenFencedReveal=groupVideo();
  tokenFencedReveal.f.api.revealMediaClock(clockRequest(0));
  tokenFencedReveal.f.api.revealMediaClock(clockRequest(0,0,2));
  tokenFencedReveal.f.tick(16);tokenFencedReveal.f.tick(32);
  assert.deepEqual(revealedReceipts(tokenFencedReveal.f),[{...binding,event:'mediaClockRevealed',clockToken:2}],'a superseded release cannot acknowledge the later native ticket');
  for(const group of [held,circular,aligned,earlyFrame,delivery,stoppedDelivery,sampled,frozen,resumedGroup,interrupted,queuedReveal,slowAlign,lateAlignedFrame,advancingGroup,rejectedGroupPlay,interruptedGroupPlay,tokenFencedReveal]) group.f.api.unmount();

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
  {
  const frozen = fixture({ binding });
  frozen.api.applyConfig({ source: 'fixed', scene: 'coast', audioInput: { kind: 'hertz', gain: 1, attackMs: 0, releaseMs: 0 } });
  frozen.api.applyFeed({ ...hertzFeed, playing: true });
  frozen.api.start(60); await flush(); frozen.tick(16); frozen.tick(32);
  const frozenFrame = frozen.frames.at(-1);
  assert.ok(frozenFrame.level > 0);
  frozen.api.stop();
  frozen.setNow(285000);
  frozen.api.applyFeed({ ...hertzFeed, playing: false, positionMs: 99999, spectrum: { bands: Array(64).fill(0), energy: 0, ageMs: 0 } });
  assert.equal(frozen.api.requestCapture({ ...binding, token: 'c'.repeat(32), width: 96, height: 54 }), true);
  frozen.tick(285016);
  const captureFrame = frozen.frames.at(-1);
  for (const field of ['now', 'time', 'position', 'sceneTime', 'playing', 'motionActive', 'level']) {
    assert.equal(captureFrame[field], frozenFrame[field], 'paused capture preserves last submitted ' + field);
  }
  assert.deepEqual(Array.from(captureFrame.spectrum), Array.from(frozenFrame.spectrum));
  assert.equal(captureFrame.dynamicDt, 0); assert.equal(captureFrame.dt, 0);
  const frozenCount = frozen.frames.length; frozen.tick(285032);
  assert.equal(frozen.frames.length, frozenCount, 'capture does not restart the paused scheduler');
  frozen.api.unmount();
  }
  console.log('wallpaper runtime checks passed: scheduling, source/audio isolation, native identity, real first frames, group hold/release, circular 100ms drift, 2s sampling, pause/resume, stale clocks, bounded alignment, and callback cleanup');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
