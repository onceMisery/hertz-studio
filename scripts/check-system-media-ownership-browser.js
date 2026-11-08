// SPDX-License-Identifier: MIT
// Real ownership observer and production MediaSession functions in Chrome.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'plugin/ui/app.js'), 'utf8').replace(/\r\n/g, '\n');
const room = fs.readFileSync(path.join(root, 'plugin/ui/room.js'), 'utf8').replace(/\r\n/g, '\n');
const moduleSource = fs.readFileSync(path.join(root, 'plugin/ui/system-media.js'), 'utf8');
const appSource = app.slice(app.indexOf('const MEDIA_SESSION_ACTIONS ='), app.indexOf('\n// ---------------------------------------------------------------------------\n// 控件', app.indexOf('const MEDIA_SESSION_ACTIONS =')));
const roomSource = room.slice(room.indexOf('  function syncMediaSession('), room.indexOf('  function animateMessage('));
assert(appSource.includes('hertz-system-media-owner-changed'));
assert(roomSource.includes('HertzSystemMedia'));
assert(app.includes('await window.HertzSystemMedia.init(transport);'), 'initial ownership must resolve before room/app MediaSession startup');
const actions = ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekto', 'seekforward', 'seekbackward'];
const ready = { available: true, owned: true, phase: 'ready', serverInstance: 'service-a' };

async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, args: ['--no-proxy-server'] });
  const errors = [], checks = [];
  let page;
  const mark = text => { checks.push(text); console.log('PASS ' + text); };
  async function fixture(options = {}) {
    if (page) await page.close();
    page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1/**', route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><html><head><meta charset="utf-8"><title>Media ownership fixture</title></head><body></body></html>' }));
    await page.goto('http://127.0.0.1/');
    await page.clock.install({ time: new Date('2026-11-06T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-11-06T12:00:01Z'));
    await page.evaluate(({ options, moduleSource, appSource, roomSource }) => {
      const test = window.test = {
        gets: [], dispatched: [], actionWrites: [], positionWrites: [], handlers: {}, timers: new Set(),
        reads: [], hold: !!options.hold, fail: !!options.fail, server: options.server || { available: false }, room: !!options.room,
      };
      const set = window.setTimeout, clear = window.clearTimeout;
      window.setTimeout = (fn, ms, ...args) => {
        const id = set(() => { test.timers.delete(id); fn(...args); }, ms);
        test.timers.add(id); return id;
      };
      window.clearTimeout = id => { test.timers.delete(id); clear(id); };
      window.hertzHost = { isDbx: !!options.dbx };
      if (options.native) window.__hertzWindowHost = { lifecycleVersion: 1 };
      test.transport = {
        kind: options.kind || 'server',
        async get(url, requestOptions) {
          test.gets.push({ url, options: requestOptions });
          if (test.fail) throw new Error('connection interrupted');
          const value = structuredClone(test.server);
          if (test.hold) return new Promise((resolve, reject) => test.reads.push({ resolve, reject, value }));
          return value;
        },
      };
      const media = navigator.mediaSession;
      const setAction = media.setActionHandler.bind(media), setPosition = media.setPositionState.bind(media);
      media.setActionHandler = (name, handler) => {
        test.actionWrites.push([name, !!handler]); test.handlers[name] = handler; setAction(name, handler);
      };
      media.setPositionState = value => { test.positionWrites.push(value || null); return setPosition(value); };
      window.state = {
        snapshot: { track_id: 'local-track', playing: true, position_ms: 3400, duration_ms: 206000 },
        current: { id: 'local-track', title: 'Local song', artist: 'Local artist', album: 'Local album', cover: '/local-cover.jpg' }, stopped: false,
      };
      window.Stage = { coverUrl: () => state.current.cover };
      window.playbackDuration = snapshot => snapshot.duration_ms;
      window.setPlayback = action => test.dispatched.push([action]);
      window.stopPlayback = () => test.dispatched.push(['stop']);
      window.post = url => test.dispatched.push([url]);
      window.seekTo = position => test.dispatched.push(['seek', position]);
      window.seekRelative = position => test.dispatched.push(['seek-relative', position]);
      new Function(moduleSource)();
      // Observe the ownership event before app's clearing listener to exercise
      // a browser callback already queued at the instant native takes ownership.
      window.addEventListener('hertz-system-media-owner-changed', () => {
        if (HertzSystemMedia.ownsSession() && test.stale) test.stale({});
      });
      new Function('global', `let mediaKey = ''; let snap = {
        mode: 'host', room_id: 'room-one', track_instance_id: 'room-track', playing: true, position_ms: '3400',
        current_track: { title: 'Room song', artist: 'Room artist', album: 'Room album', duration_ms: '206000' }
      };\n${roomSource}\nglobal.HertzRoom = { active: () => test.room, syncMediaSession };`)(window);
      new Function(`let mediaSessionStateKey = '';\n${appSource}\nwindow.mediaControls = { bindMediaSession, updateMediaSessionMetadata, syncMediaSession };`)();
      test.start = async () => {
        await HertzSystemMedia.init(test.transport);
        mediaControls.bindMediaSession();
        mediaControls.updateMediaSessionMetadata(state.current, state.current.cover);
        mediaControls.syncMediaSession();
      };
    }, { options, moduleSource, appSource, roomSource });
    if (!options.hold) await page.evaluate(() => test.start());
  }
  const inspect = () => page.evaluate(() => ({
    state: HertzSystemMedia.snapshot(), reads: test.gets.length, timers: test.timers.size,
    handlers: Object.entries(test.handlers).filter(([, handler]) => !!handler).map(([name]) => name),
    metadata: navigator.mediaSession.metadata && { title: navigator.mediaSession.metadata.title, artwork: navigator.mediaSession.metadata.artwork.map(art => art.src) },
    playback: navigator.mediaSession.playbackState, positions: test.positionWrites, dispatched: test.dispatched,
  }));
  try {
    for (const native of [false, true]) {
      for (const room of [false, true]) {
        await fixture({ server: ready, native, room });
        const result = await inspect();
        assert.equal(result.state.owned, true);
        assert.equal(result.state.serverInstance, 'service-a');
        assert.deepEqual(result.handlers, []);
        assert.equal(result.metadata, null);
        assert.equal(result.playback, 'none');
        assert.equal(result.reads, 1);
        assert.equal(result.timers, 1);
        await page.evaluate(() => {
          mediaControls.bindMediaSession();
          mediaControls.updateMediaSessionMetadata({ title: 'Late cover callback' }, '/late.jpg');
          HertzRoom.syncMediaSession();
          HertzSystemMedia.init(test.transport);
          HertzSystemMedia.init(test.transport);
        });
        assert.equal((await inspect()).metadata, null);
        assert.equal((await inspect()).reads, 1);
      }
    }
    mark('native windows and separate browser tabs suppress local and room MediaSession');

    await fixture({ server: { available: true, owned: false, phase: 'starting' } });
    assert.deepEqual((await inspect()).handlers.sort(), actions.slice().sort());
    await page.evaluate(async ready => {
      test.stale = test.handlers.nexttrack;
      test.server = ready;
      await HertzSystemMedia.refresh();
      await test.stale({});
      state.current = { ...state.current, title: 'Latest native song', cover: '/new-cover.jpg' };
      mediaControls.updateMediaSessionMetadata(state.current, state.current.cover);
      mediaControls.syncMediaSession();
    }, ready);
    let result = await inspect();
    assert.deepEqual(result.dispatched, []);
    assert.deepEqual(result.handlers, []);
    assert.equal(result.metadata, null);
    assert.equal(result.playback, 'none');
    assert.equal(result.positions.at(-1), null);
    assert.deepEqual(await page.evaluate(() => test.actionWrites.filter(([, on]) => !on).slice(-8).map(([name]) => name)), actions);
    mark('ownership clears eight handlers, metadata and position; stale callbacks cannot dispatch');

    await page.evaluate(async () => {
      test.fail = true;
      await HertzSystemMedia.refresh();
      await test.stale({});
    });
    result = await inspect();
    assert.equal(result.state.owned, true);
    assert.equal(result.state.unknown, true);
    assert.equal(result.metadata, null);
    assert.deepEqual(result.dispatched, []);
    await page.clock.runFor(5000);
    assert.equal((await inspect()).state.owned, true);
    await page.evaluate(async () => {
      test.fail = false;
      test.server = { available: true, owned: false, phase: 'failed', error: 'smtc_failed', serverInstance: 'service-a' };
      await HertzSystemMedia.refresh();
      await test.handlers.nexttrack({});
    });
    result = await inspect();
    assert.equal(result.state.owned, false);
    assert.equal(result.state.phase, 'failed');
    assert.equal(result.metadata.title, 'Latest native song');
    assert(result.metadata.artwork[0].endsWith('/new-cover.jpg'));
    assert.equal(result.playback, 'playing');
    assert.deepEqual(result.dispatched, [['/v1/player/next']]);
    mark('unknown transport status preserves native owner; verified failure restores latest browser metadata and actions');

    await fixture({ room: true, server: { available: true, owned: false, phase: 'starting' } });
    assert.equal((await inspect()).metadata.title, 'Room song');
    await page.evaluate(async ready => {
      test.server = ready; await HertzSystemMedia.refresh();
      test.server = { available: true, owned: false, phase: 'failed' }; await HertzSystemMedia.refresh();
    }, ready);
    result = await inspect();
    assert.equal(result.metadata.title, 'Room song');
    assert.equal(result.playback, 'playing');
    assert.equal(result.positions.at(-1).position, 3.4);
    mark('room fallback restores an unchanged room snapshot after native metadata clearing');

    for (const options of [{ dbx: true }, { kind: 'dbx' }, { kind: 'demo' }]) {
      await fixture({ ...options, server: ready });
      result = await inspect();
      assert.equal(result.reads, 0);
      assert.equal(result.timers, 0);
      assert.equal(result.metadata.title, 'Local song');
      assert.deepEqual(result.handlers.sort(), actions.slice().sort());
      await page.evaluate(async () => { await HertzSystemMedia.refresh(); document.dispatchEvent(new Event('visibilitychange')); });
      assert.equal((await inspect()).reads, 0);
    }
    await fixture({ server: { available: false } });
    await page.clock.runFor(60000);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    result = await inspect();
    assert.equal(result.reads, 1);
    assert.equal(result.timers, 0);
    assert.equal(result.metadata.title, 'Local song');
    mark('DBX/demo never query or poll; an unmanaged service is checked once and retains browser controls');

    await fixture({ fail: true });
    assert.equal((await inspect()).metadata, null);
    for (let attempt = 0; attempt < 5; attempt++) await page.clock.runFor(5000);
    result = await inspect();
    assert.equal(result.reads, 3);
    assert.equal(result.timers, 0);
    assert.equal(result.state.owned, true);
    await page.evaluate(() => HertzSystemMedia.init(test.transport));
    assert.equal((await inspect()).reads, 3);
    await page.evaluate(async ready => { test.fail = false; test.server = ready; document.dispatchEvent(new Event('visibilitychange')); }, ready);
    await page.waitForFunction(() => !HertzSystemMedia.snapshot().loading);
    assert.equal((await inspect()).state.owned, true);
    mark('first-read failures cannot create duplicate ownership; three attempts are bounded and visibility refresh recovers');

    await fixture({ server: ready });
    await page.evaluate(() => {
      test.hold = true;
      test.flight = HertzSystemMedia.refresh();
      test.sameFlight = test.flight === HertzSystemMedia.refresh();
      document.dispatchEvent(new Event('visibilitychange'));
      HertzSystemMedia.init(test.transport);
    });
    await page.clock.runFor(15000);
    assert.equal((await inspect()).reads, 2);
    assert.equal(await page.evaluate(() => test.sameFlight), true);
    await page.evaluate(async () => { test.hold = false; test.reads.shift().resolve({ available: true, owned: false, phase: 'failed' }); await test.flight; });
    assert.equal((await inspect()).timers, 1);
    await page.clock.runFor(5000);
    assert.equal((await inspect()).reads, 3);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => !HertzSystemMedia.snapshot().loading);
    assert.equal((await inspect()).reads, 4);
    mark('polls, repeated initialization, explicit refresh and visible-page refresh share one flight and one timer');

    await fixture({ server: ready, hold: true });
    await page.evaluate(() => { test.oldStart = test.start(); });
    await page.waitForFunction(() => test.reads.length === 1);
    await page.evaluate(async () => {
      test.newTransport = { kind: 'server', get: async () => ({ available: true, owned: false, phase: 'failed', serverInstance: 'service-b' }) };
      await HertzSystemMedia.init(test.newTransport);
      test.reads.shift().resolve({ available: true, owned: true, phase: 'ready', serverInstance: 'service-a' });
      await test.oldStart;
    });
    result = await inspect();
    assert.equal(result.state.owned, false);
    assert.equal(result.state.serverInstance, 'service-b');
    assert.equal(result.timers, 1);
    mark('a late old-transport response cannot overwrite the current service context');

    await fixture({ server: ready });
    await page.evaluate(async () => {
      test.server = { available: true, phase: 'failed' };
      await HertzSystemMedia.refresh();
    });
    result = await inspect();
    assert.equal(result.state.owned, true);
    assert.equal(result.state.unknown, true);
    assert.equal(result.metadata, null);
    await page.evaluate(async () => { test.server = { available: false }; await HertzSystemMedia.refresh(); });
    result = await inspect();
    assert.equal(result.state.owned, false);
    assert.equal(result.timers, 0);
    assert.equal(result.metadata.title, 'Local song');
    assert.deepEqual(errors, []);
    mark('malformed ownership is unconfirmed; verified unsupported status restores browser fallback and stops polling');
    console.log(`Verified ${checks.length} system-media ownership scenarios in Chrome.`);
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
