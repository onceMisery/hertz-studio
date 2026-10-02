#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Run actual library request/playback functions with controlled HTTP ordering.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../plugin/ui/app.js'), 'utf8');
function between(start, end) {
  const at = source.indexOf(start);
  const to = source.indexOf(end, at);
  assert(at >= 0 && to > at, 'actual library function boundaries exist');
  return source.slice(at, to);
}
const pending = [];
const plays = [];
const notices = [];
const state = { tracks: [], total: 0, loading: false, q: '', sort: 'title', offset: 0, rows: new Map(), byId: new Map(), libFilter: { artist: '', album: '' }, selected: new Set() };
const context = vm.createContext({
  state, PAGE: 200, Map,
  ui: { libList: { innerHTML: '' }, libSentinel: {} },
  transport: { get: (url) => new Promise((resolve, reject) => pending.push({ url, resolve, reject })) },
  renderLibrary() {}, toast: (...args) => notices.push(args), errText: (label) => label,
  playTrack: async (id, ids) => plays.push({ id, ids }),
});
vm.runInContext(between('const PlaybackIntent =', 'const ServerTransport =') + '\n' +
  between('let libraryEpoch =', 'function renderLibrary()') + '\n' +
  between('async function playFromList(', 'async function playTrack('), context);
function request(fn) { return vm.runInContext(fn, context); }
function page(from, count, total = 205) {
  return { total, tracks: Array.from({ length: count }, (_, i) => ({ id: String(from + i) })) };
}
(async () => {
  const first = request('loadTracks(true)');
  assert(pending[0].url.includes('sort=title'));
  pending.shift().resolve(page(0, 200)); await first;
  const failed = request('loadTracks(false)');
  assert(pending[0].url.endsWith('offset=200'));
  pending.shift().reject(new Error('temporary')); await failed;
  assert.equal(state.tracks.length, 200);
  const retry = request('loadTracks(false)');
  assert(pending[0].url.endsWith('offset=200'));
  pending.shift().resolve(page(200, 5)); await retry;
  assert.equal(state.tracks.length, 205);
  const old = request('loadTracks(true)');
  state.q = 'new'; state.sort = 'artist';
  const fresh = request('loadTracks(true)');
  const oldRequest = pending.shift();
  const newRequest = pending.shift();
  assert(newRequest.url.includes('q=new&sort=artist'));
  newRequest.resolve(page(999, 1, 1)); await fresh;
  oldRequest.resolve(page(0, 200)); await old;
  assert.deepEqual(Array.from(state.tracks, t => t.id), ['999']);
  // The visible page is deliberately only one track; the queue must still use all IDs.
  const playback = request('playFromList("999")');
  assert(pending[0].url.startsWith('/v1/tracks/ids?q=new&sort=artist'));
  const ids = Array.from({ length: 205 }, (_, i) => String(999 + i));
  pending.shift().resolve({ track_ids: ids }); await playback;
  assert.equal(plays[0].ids.length, 205);
  assert.equal(plays[0].ids[204], '1203');
  const stalePlay = request('playFromList("999")');
  const freshPlay = request('playFromList("1000")');
  const staleReq = pending.shift(); const freshReq = pending.shift();
  freshReq.resolve({ track_ids: ids }); await freshPlay;
  staleReq.resolve({ track_ids: ids }); await stalePlay;
  assert.equal(plays.length, 2);
  assert.equal(plays[1].id, '1000');
  const abandoned = request('playFromList("999")');
  request('PlaybackIntent.command("/v1/online/play")');
  pending.shift().resolve({ track_ids: ids }); await abandoned;
  assert.equal(plays.length, 2, 'new playback from another view cancels queued preparation');
  // Load the actual playback function too: late load replies must not restore old UI queues.
  const posts = [];
  const committed = [];
  context.transport.post = (url, body) => {
    request('PlaybackIntent.command("/v1/player/load")');
    return new Promise((resolve) => posts.push({ body, resolve }));
  };
  context.ui.playpause = { classList: { add() {}, remove() {} } };
  let serverQueue = { queue: ['B'], index: 0 };
  context.transport.get = async (url) => {
    assert.equal(url, '/v1/player/queue');
    return serverQueue;
  };
  context.renderQueue = () => committed.push(state.queue[state.queueIndex]);
  vm.runInContext(between('async function playTrack(', 'function setStateQueue(') + '\n' +
    between('let queueReadEpoch =', 'function staleCommand('), context);
  const a = request('playTrack("A", ["A"])');
  const b = request('playTrack("B", ["B"])');
  posts[1].resolve({}); await b;
  posts[0].resolve({}); await a;
  assert.deepEqual(committed, ['B']);
  const paused = request('playTrack("C", ["C", "D"])');
  request('PlaybackIntent.command("/v1/player/pause")');
  serverQueue = { queue: ['C', 'D'], index: 0 };
  posts[2].resolve({}); await paused;
  assert.deepEqual(state.queue, ['C', 'D'], 'pause retains submitted queue');
  const empty = request('playTrack("E", ["E"])');
  request('PlaybackIntent.command("/v1/player/queue")');
  state.queue = []; // applyQueue optimistically commits the newer queue edit.
  serverQueue = { queue: [], index: null };
  posts[3].resolve({}); await empty;
  assert.deepEqual(state.queue, [], 'late reply must not revive a cleared queue');
  const editing = request('playTrack("F", ["F"])');
  request('PlaybackIntent.command("/v1/player/queue")');
  state.queue = ['F', 'G'];
  serverQueue = { queue: ['F'], index: 0 }; // Newer PUT is still pending.
  const beforeEdit = committed.length;
  posts[4].resolve({}); await editing;
  assert.deepEqual(state.queue, ['F', 'G']);
  assert.equal(committed.length, beforeEdit, 'old load cannot read pre-PUT queue over optimistic edit');
  console.log('Library pagination, retry, stale-query and complete-queue checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
