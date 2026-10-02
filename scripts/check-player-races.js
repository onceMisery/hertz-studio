'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../plugin/ui/app.js'), 'utf8').replace(/\r\n/g, '\n');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};

async function run() {
  const requests = [];
  const state = { snapshot: { track_id: 'one', duration_ms: 100000, position_ms: 0 }, settings: {} };
  const range = { value: '20', setAttribute() {} };
  const box = vm.createContext({ Promise, DOMException, Date, state,
    ui: { volume: range, setCoverFollow: {} }, np: {}, Stage: null,
    request(url, options) {
      const pending = deferred();
      requests.push({ url, body: JSON.parse(options.body || '{}'), ...pending });
      return pending.promise;
    }, toast() {}, errText: message => message, markSettingsDirty() {},
    playbackDuration: snapshot => snapshot.duration_ms,
    renderPlaybackProgress() {}, syncMediaSession() {},
    applySnapshot(snapshot) { state.snapshot = snapshot; },
  });
  vm.runInContext(section('const PlaybackIntent =', 'const REQUEST_TIMEOUT')
    + '\nthis.transport = ServerTransport; this.intent = PlaybackIntent;', box);
  const first = box.transport.post('/v1/player/play');
  const second = box.transport.post('/v1/player/stop');
  assert.equal(box.intent.generation, 2);
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/player/play');
  requests[0].resolve({}); await first; await tick();
  assert.equal(requests[1].url, '/v1/player/stop');
  requests[1].resolve({}); await second;
  console.log('PASS playback commands preserve submission order');

  const failing = box.transport.post('/v1/player/pause');
  const recovered = box.transport.post('/v1/player/play');
  await tick(); requests[2].reject(new Error('offline'));
  await assert.rejects(failing); await tick();
  assert.equal(requests[3].url, '/v1/player/play');
  requests[3].resolve({}); await recovered;
  console.log('PASS failed command does not discard subsequent intent');

  const active = box.transport.post('/v1/player/pause');
  const obsolete = box.transport.post('/v1/player/seek', { position_ms: 30000 });
  const obsoleteCheck = assert.rejects(obsolete, { name: 'AbortError' });
  await tick(); box.intent.command('/v1/player/load');
  requests[4].resolve({}); await active; await obsoleteCheck;
  assert.equal(requests.length, 5);
  console.log('PASS replacing queue discards unsent old-track command');

  vm.runInContext(section('let seekRequestEpoch =', 'async function seekRelative')
    + section('let volumeTarget =', 'function playbackDuration')
    + section('let coverFollowWrite =', '// ---------------------------------------------------------------------------')
    + section('let playbackCommandEpoch =', 'function togglePlay'), box);
  const seekFirst = box.seekTo(30000);
  const seekLast = box.seekTo(90000);
  await tick(); requests[5].resolve({}); await seekFirst; await tick();
  assert.equal(state.snapshot.position_ms, 0);
  requests[6].resolve({}); await seekLast;
  assert.equal(state.snapshot.position_ms, 90000);
  console.log('PASS only latest seek updates presentation');

  const lateSeek = box.seekTo(10000);
  await tick(); const stopped = box.setPlayback('stop');
  requests[7].resolve({}); await lateSeek; await tick();
  assert.equal(state.snapshot.position_ms, 0);
  requests[8].resolve({}); await stopped;
  console.log('PASS stop invalidates in-flight seek presentation');

  const volume = box.setVolumeFromInput();
  await tick(); range.value = '90'; box.setVolumeFromInput();
  requests[9].reject(new Error('transient')); await tick();
  assert.equal(requests[10].body.volume, 0.9);
  requests[10].resolve({}); await volume;
  console.log('PASS volume failure retains newest slider target');

  box.setCoverFollow(false, true); box.setCoverFollow(true, true);
  await tick(); assert.equal(requests.length, 12);
  assert.equal(requests[11].body.cover_follow, false);
  requests[11].reject(new Error('transient')); await tick();
  assert.equal(requests[12].body.cover_follow, true);
  requests[12].resolve({}); await tick();
  assert.equal(state.settings.cover_follow, true);
  console.log('PASS cover follow persists latest selection after failure');

  const offset = requests.length;
  const playing = box.transport.post('/v1/player/play');
  const stopAfterEdit = box.transport.post('/v1/player/stop');
  await tick();
  const edited = box.transport.put('/v1/player/queue', { track_ids: ['one', 'two'] });
  requests[offset + 1].resolve({}); await edited;
  requests[offset].resolve({}); await playing; await tick();
  assert.equal(requests[offset + 2].url, '/v1/player/stop');
  requests[offset + 2].resolve({}); await stopAfterEdit;
  console.log('PASS queue editing cannot discard pending stop');

  const nextOffset = requests.length;
  const preparing = box.transport.post('/v1/player/next');
  const urgentStop = box.transport.post('/v1/player/stop');
  await tick();
  assert.equal(requests[nextOffset].url, '/v1/player/next');
  assert.equal(requests[nextOffset + 1].url, '/v1/player/stop');
  requests[nextOffset + 1].resolve({}); await urgentStop;
  requests[nextOffset].resolve({}); await preparing;
  console.log('PASS stop reaches backend without waiting for next-track preparation');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
