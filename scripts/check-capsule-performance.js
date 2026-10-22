// SPDX-License-Identifier: MIT
// Exercise production scheduling and state/metadata paths with deterministic clocks.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../plugin/ui/app.js'), 'utf8').replace(/\r\n/g, '\n');
function grab(name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  const end = source.indexOf('\n}\n', start);
  assert(start >= 0 && end > start, name);
  return source.slice(start, end + 3);
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function el() {
  const classes = new Set();
  return { textContent: '', style: {}, attrs: {}, hidden: false,
    setAttribute(key, value) { this.attrs[key] = value; },
    classList: { contains: key => classes.has(key), toggle(key, on) { on ? classes.add(key) : classes.delete(key); } } };
}

async function main() {
  let now = 0, reads = 0, motion = false, serial = 0;
  const timers = new Map(), listeners = {}, mediaListeners = {};
  const title = el(), artist = el(), capsule = el();
  let width = 40, textWidth = 30;
  for (const element of [title, artist]) {
    element.parentNode = { get clientWidth() { reads++; return width; } };
    Object.defineProperty(element, 'offsetWidth', { get() { reads++; return textWidth; } });
  }
  let resize;
  const scheduler = vm.createContext({ ui: { capsule, capsuleTitle: title, capsuleArtist: artist },
    document: { hidden: false, addEventListener(name, fn) { listeners[name] = fn; } },
    window: { addEventListener() {}, matchMedia: () => ({ addEventListener(name, fn) { mediaListeners[name] = fn; } }) },
    performance: { now: () => now }, prefersReducedMotion: () => motion,
    getComputedStyle: () => ({ fontSize: '10px' }),
    ResizeObserver: class { constructor(fn) { resize = fn; } observe() {} },
    setTimeout(fn, ms) { timers.set(++serial, { fn, at: now + ms }); return serial; },
    clearTimeout(id) { timers.delete(id); },
  });
  const start = source.indexOf('const CAPSULE_MARQUEE_STEP_MS');
  vm.runInContext(source.slice(start, source.indexOf('// 曲目信息 → 弹窗', start)), scheduler);
  const advance = duration => {
    const end = now + duration;
    while (timers.size) {
      const [id, job] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (job.at > end) break;
      now = job.at; timers.delete(id); job.fn();
    }
    now = end;
  };
  scheduler.initCapsuleMarquee();
  assert.equal(timers.size, 0, 'short titles stay idle');
  textWidth = 130; resize();
  assert.equal(timers.size, 1, 'both lines share one timer');
  const measured = reads;
  // Advance at a simulated 144Hz; display refresh rate cannot increase layout work.
  for (let i = 0; i < 1440; i++) advance(1000 / 144);
  assert.equal(reads, measured, 'high refresh never remeasures text');
  assert.match(title.style.transform, /^translateX\(/);
  scheduler.document.hidden = true; listeners.visibilitychange();
  assert.equal(timers.size, 0);
  assert.equal(title.style.transform, '');
  scheduler.document.hidden = false; listeners.visibilitychange();
  assert.equal(timers.size, 1, 'restored window resumes');
  motion = true; mediaListeners.change();
  assert.equal(timers.size, 0, 'reduced motion stops');
  motion = false; mediaListeners.change();
  assert.equal(timers.size, 1);
  width = 200; resize();
  assert.equal(timers.size, 0, 'resized text that fits stops');
  width = 40; resize(); capsule.hidden = true; scheduler.refreshCapsuleMarquee();
  assert.equal(timers.size, 0, 'expanded page leaves no capsule timer');

  const requests = [], covers = [], metadata = [];
  const pendingTracks = new Map(), pendingCovers = new Map();
  const state = { snapshot: { track_id: null, playing: false }, byId: new Map(),
    queue: [], queueIndex: -1, settings: {}, modeLabel: {} };
  const hidden = () => { throw Error('hidden full-player work'); };
  const online = { meta: new Map(), getMeta(id) { return this.meta.get(id); },
    safeCoverUrl: url => url || null, fetchCover: async () => null, paintNowPlaying: hidden,
    remember() {}, bigCoverUrl: hidden };
  const ui = { capsuleLabel: el(), capsulePlay: el() };
  let mediaCalls = 0;
  const runtime = vm.createContext({ state, ui, window: { HertzCapsuleOnly: true, Online: online },
    document: { body: el(), title: '', dispatchEvent() { return true; } }, console,
    CustomEvent: class CustomEvent {
      constructor(type, options) { this.type = type; this.detail = options && options.detail; }
    },
    PlaybackIntent: { queueRevision: 0, generation: 0, current: () => true },
    Stage: new Proxy({}, { get: () => hidden }),
    staleCommand: () => false, volumeTarget: null, capsuleMediaKey: '',
    syncMediaSession() { mediaCalls++; },
    syncCapsule(track, url) { covers.push({ id: track && track.id, title: track && track.title, url }); },
    syncBufferingIndicator(active, pct) {
      ui.capsulePlay.title = active ? (pct != null ? `缓冲中 ${pct}%` : '缓冲中…') : '';
    },
    updateMediaSessionMetadata(track, url) { metadata.push({ id: track.id, url }); },
    transport: {
      get(url) {
        requests.push(url);
        if (pendingTracks.has(url)) return pendingTracks.get(url).promise;
        return Promise.resolve(null);
      },
      ensureCover(id) { return pendingCovers.has(id) ? pendingCovers.get(id).promise : Promise.resolve(null); },
      coverUrl: id => 'cover:' + id,
    },
    resolveCover: async url => url, probeImage: async () => true,
    isRemoteCoverUrl: () => false, setBarFavoriteTrack: hidden, HomeDashboard: { update: hidden },
    loadBeatStatus: hidden, syncNpTrack: hidden, pushStageQueue: hidden, refreshLyrics: hidden,
    renderQueue() {}, syncQueuePlaying: hidden,
    cancelSeek: hidden, noticeCapsule(message) { runtime.notice = message; },
  });
  vm.runInContext(['loadNowPlaying', 'applySnapshot', 'handleEvent', 'renderQueue'].map(grab).join('\n'), runtime);
  const one = { id: 'one', title: 'Local', has_cover: true };
  const two = { id: 'two', title: 'Next', has_cover: true };
  state.byId.set(one.id, one); state.byId.set(two.id, two);
  pendingCovers.set('one', deferred()); pendingCovers.set('two', deferred());
  runtime.applySnapshot({ track_id: 'one', playing: true, position_ms: 0 });
  runtime.applySnapshot({ track_id: 'two', playing: true, position_ms: 0 });
  pendingCovers.get('two').resolve('data:two'); await flush();
  pendingCovers.get('one').resolve('data:one'); await flush();
  assert.deepEqual(covers.at(-1), { id: 'two', title: 'Next', url: 'data:two' }, 'late cover cannot replace new track');
  const calls = mediaCalls;
  for (let i = 0; i < 1000; i++) {
    runtime.handleEvent({ type: 'state', track_id: 'two', playing: true, position_ms: i % 1000 });
    runtime.handleEvent({ type: 'spectrum', bands: [1] });
  }
  assert.equal(mediaCalls, calls, 'snapshot bursts do not spam OS media state');
  runtime.handleEvent({ type: 'buffering', active: true, pct: 42 });
  assert.equal(ui.capsulePlay.title, '缓冲中 42%');
  runtime.handleEvent({ type: 'error', source: 'qq', message: '播放错误' });
  assert.equal(runtime.notice, '播放错误');
  for (const type of ['scan', 'library_changed', 'beatmap_ready']) runtime.handleEvent({ type });

  const onlineId = 'online:qq:123';
  pendingTracks.set('/v1/online/detail?source=qq&id=123', deferred());
  runtime.applySnapshot({ track_id: onlineId, playing: false });
  assert.equal(covers.at(-1).title, '在线曲目');
  pendingTracks.get('/v1/online/detail?source=qq&id=123').resolve({ title: 'Online title', cover: 'data:online' });
  await flush();
  assert.equal(covers.at(-1).title, 'Online title');
  assert.equal(covers.at(-1).url, 'data:online');
  assert.equal(requests.filter(url => url.includes('source=qq')).length, 1, 'detail/cover share one request');
  const podcast = { id: 'online:podcast:episode', source: 'podcast', onlineId: 'episode',
    title: 'Episode', artist: 'Host', cover: 'data:podcast' };
  state.byId.set(podcast.id, podcast);
  runtime.applySnapshot({ track_id: podcast.id, playing: false }); await flush();
  assert.equal(covers.at(-1).url, 'data:podcast');

  pendingTracks.set('/v1/tracks/late', deferred());
  runtime.applySnapshot({ track_id: 'late', playing: false });
  runtime.applySnapshot({ track_id: 'two', playing: false }); await flush();
  pendingTracks.get('/v1/tracks/late').resolve({ id: 'late', title: 'Old metadata' }); await flush();
  assert.equal(covers.at(-1).id, 'two', 'late local metadata cannot replace new track');
  pendingTracks.set('/v1/online/detail?source=qq&id=late', deferred());
  runtime.applySnapshot({ track_id: 'online:qq:late', playing: false });
  runtime.applySnapshot({ track_id: 'two', playing: false }); await flush();
  pendingTracks.get('/v1/online/detail?source=qq&id=late').resolve({ title: 'Old online', cover: 'data:old' }); await flush();
  assert.equal(covers.at(-1).id, 'two', 'late online detail cannot replace new track');

  const relayed = { id: 'online:netease:relay', title: 'Relayed', cover: 'data:relay' };
  online.relayMeta = () => relayed;
  runtime.toast = () => {};
  runtime.handleEvent({ type: 'source_switched', from_track_id: 'two', track_id: relayed.id });
  assert.equal(covers.at(-1).id, relayed.id, 'source relay updates the visible capsule');

  // Restored queue has a cursor before the audio engine has a current track.
  state.snapshot = { track_id: null, playing: false };
  state.queue = ['two']; state.queueIndex = 0;
  await runtime.loadNowPlaying('two');
  assert.equal(covers.at(-1).id, 'two');
  assert.equal(metadata.at(-1).id, 'two');

  // Reconnecting uses the same small dependency list, without reinitializing views.
  const startup = [];
  runtime.transport.get = async url => {
    startup.push(url);
    if (url === '/v1/settings') return { reduce_motion: true };
    if (url === '/v1/state') return { track_id: 'two', playing: false };
    if (url === '/v1/player/queue') return { queue: ['two'], index: 0 };
    return null;
  };
  runtime.refreshCapsuleMarquee = () => {};
  vm.runInContext('let queueReadEpoch = 0; let bootAutoPlayArmed = true;\n'
    + ['restoreQueue', 'refreshFloatingCapsule', 'refreshAll'].map(grab).join('\n'), runtime);
  await runtime.refreshAll();
  assert.deepEqual(startup.sort(), ['/v1/player/queue', '/v1/settings', '/v1/state']);
  assert.equal(state.settings.reduce_motion, true);

  // OS handlers must work while Stage is deliberately uninitialized.
  const actions = {}, commands = [];
  runtime.navigator = { mediaSession: { setActionHandler(name, fn) { actions[name] = fn; } } };
  runtime.playbackDuration = () => 100000;
  runtime.renderPlaybackProgress = hidden;
  runtime.transport.post = async (url, body) => { commands.push({ url, body }); };
  runtime.post = url => runtime.transport.post(url, {});
  runtime.errText = text => text;
  vm.runInContext('let seekRequestEpoch = 0, seekEpoch = 0, seekGesture = null, playbackCommandEpoch = 0;\n'
    + ['bindMediaSession', 'seekTo', 'seekRelative', 'cancelSeek', 'setPlayback', 'stopPlayback'].map(grab).join('\n'), runtime);
  runtime.bindMediaSession();
  state.snapshot = { track_id: 'two', playing: false, position_ms: 15000 };
  await actions.seekforward({ seekOffset: 5 });
  assert.equal(commands.at(-1).body.position_ms, 20000, 'seek uses live snapshot instead of idle Stage clock');
  await actions.seekto({ seekTime: 30 });
  assert.equal(commands.at(-1).body.position_ms, 30000);
  await actions.play(); await actions.pause(); await actions.stop();
  assert.deepEqual(commands.slice(-3).map(command => command.url), ['/v1/player/play', '/v1/player/pause', '/v1/player/stop']);
  assert.equal(state.snapshot.playing, false);

  // Identical native resize requests coalesce, failures remain retryable.
  let sizes = 0;
  const failure = deferred();
  ui.capsule = { getBoundingClientRect: () => ({ width: 252.2, height: 55.4 }) };
  runtime.window.dbxPlugin = { floating: { setSize() { sizes++; return sizes === 1 ? failure.promise : Promise.resolve(); } } };
  vm.runInContext(grab('fitFloatingWindowToCapsule'), runtime);
  for (let i = 0; i < 50; i++) runtime.fitFloatingWindowToCapsule();
  await flush(); assert.equal(sizes, 1);
  failure.reject(Error('host unavailable')); await flush();
  runtime.fitFloatingWindowToCapsule(); await flush(); assert.equal(sizes, 2);
  runtime.fitFloatingWindowToCapsule(); await flush(); assert.equal(sizes, 2);
  console.log('Capsule performance: demand scheduling, high refresh/visibility/motion/resize, hidden events, local/online/podcast metadata, cover races, restored cursor, reconnect, OS media controls and resize retry passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
