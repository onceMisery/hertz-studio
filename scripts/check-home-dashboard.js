#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin/ui/home-dashboard.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'plugin/ui/app.js'), 'utf8');
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture() {
  const nodes = {};
  for (const name of ['dashboard', 'art', 'status', 'title', 'detail', 'action', 'retry', 'daily', 'recent', 'library']) {
    nodes['home-' + name] = { textContent: '', disabled: false, hidden: false, dataset: {}, events: {}, addEventListener(name, cb) { this.events[name] = cb; } };
  }
  const ctx = { document: { getElementById: id => nodes[id] }, Promise };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(source, ctx);
  let snapshot = { current: null, playing: false, queueLength: 0, intent: 0, pending: false };
  const histories = [], arts = [], actions = [], coverWrites = [];
  const host = {
    read: () => snapshot,
    readRecent: () => { const p = deferred(); histories.push(p); return p.promise; },
    cover: track => { const p = deferred(); arts.push({ ...p, id: track.id }); return p.promise; },
    applyCover: (img, url) => { img.src = url; coverWrites.push(url); },
    resume: () => { actions.push('resume'); }, playRecent: track => { actions.push(['recent', track.id]); },
    navigate: key => { actions.push(key); }, notify: text => { actions.push(['error', text]); }
  };
  ctx.HomeDashboard.bind(host);
  return { api: ctx.HomeDashboard, host, nodes, histories, arts, actions, coverWrites,
    set: patch => { snapshot = { ...snapshot, ...patch }; ctx.HomeDashboard.update(); },
    click: () => nodes['home-action'].events.click() };
}
async function flush() { await Promise.resolve(); await Promise.resolve(); }
async function main() {
  const f = fixture();
  assert.deepEqual(f.actions, [], 'render never plays');
  const read = f.api.onViewEnter();
  assert.equal(f.nodes['home-action'].textContent, '去曲库');
  f.histories.shift().resolve({ id: 'recent', source: 'local', title: '上次的歌', artist: '歌手' }); await read;
  assert.equal(f.nodes['home-action'].textContent, '播放最近一首');
  assert.deepEqual(f.actions, [], 'history completion never plays');
  await f.click(); assert.deepEqual(f.actions, [['recent', 'recent']]);
  f.set({ current: { id: 'A', title: '当前曲目', cover: 'A.jpg' }, queueLength: 3, playing: false });
  const button = f.nodes['home-action'];
  assert.equal(button.textContent, '继续播放');
  await f.click(); assert.equal(f.actions.at(-1), 'resume');
  f.set({ playing: true }); await f.click(); assert.equal(f.actions.at(-1), 'queue', 'playing action never pauses');
  assert.equal(button, f.nodes['home-action'], 'state changes keep original action node');
  f.set({ current: { id: 'B', title: '新曲目', cover: 'B.jpg' } });
  f.arts.at(-1).resolve('B-final'); await flush();
  f.arts.find(a => a.id === 'A').resolve('A-late'); await flush();
  assert.equal(f.nodes['home-art'].src, 'B-final', 'late cover cannot overwrite current track');
  f.set({ current: null, queueLength: 0, intent: 2 });
  const old = f.api.onViewEnter(); const fresh = f.api.onViewEnter();
  f.histories[1].resolve({ id: 'fresh', title: '新记录' }); await fresh;
  f.histories[0].resolve({ id: 'stale', title: '旧记录' }); await old;
  assert.equal(f.nodes['home-title'].textContent, '新记录', 'new history request wins');
  f.histories.length = 0;
  const changedIntent = f.api.onViewEnter(); f.set({ intent: 3 });
  f.histories.shift().resolve({ id: 'stale-intent', title: '不该出现' }); await changedIntent;
  assert.notEqual(f.nodes['home-title'].textContent, '不该出现', 'playback intent invalidates history preparation');
  const restored = f.api.onViewEnter();
  f.set({ current: { id: 'restored', title: '已恢复队列' }, queueLength: 2 });
  f.histories.shift().resolve({ id: 'other', title: '旧历史' }); await restored;
  assert.equal(f.nodes['home-title'].textContent, '已恢复队列');
  f.set({ current: null, queueLength: 0, intent: 4 });
  const empty = f.api.onViewEnter(); f.histories.shift().resolve(null); await empty;
  assert.equal(f.nodes['home-action'].textContent, '添加音乐'); await f.click(); assert.equal(f.actions.at(-1), 'add');
  const fail = f.api.onViewEnter(); f.histories.shift().reject(Error('offline')); await fail;
  assert.equal(f.nodes['home-action'].textContent, '去曲库'); assert.equal(f.nodes['home-retry'].hidden, false);
  f.set({ pending: true }); const count = f.actions.length; await f.click(); assert.equal(f.actions.length, count);
  f.set({ pending: false, queueLength: 2, dailyVisible: false, recentVisible: false });
  assert.equal(f.nodes['home-action'].textContent, '查看队列');
  assert.equal(f.nodes['home-daily'].hidden, true); assert.equal(f.nodes['home-recent'].hidden, true);
  f.nodes['home-library'].events.click(); assert.equal(f.actions.at(-1), 'library');
  f.nodes['home-daily'].events.click(); assert.equal(f.actions.at(-1), 'daily');
  f.nodes['home-recent'].events.click(); assert.equal(f.actions.at(-1), 'recent');
  f.host.navigate = async () => { throw new Error('navigation failed'); };
  await f.nodes['home-recent'].events.click();
  assert.equal(f.actions.at(-1)[0], 'error', 'secondary navigation failures are caught and visible');

  // Execute app's real host boundary: restored queue/current selection and recent resolution.
  const start = app.indexOf('function homeSnapshot()');
  const end = app.indexOf('\n// ---------------------------------------------------------------------------', start);
  assert.ok(start >= 0 && end > start);
  const state = { snapshot: { track_id: null, playing: false }, queue: ['restore'], queueIndex: 0,
    current: null, byId: new Map([['restore', { id: 'restore', title: '恢复项' }]]), settings: {} };
  const gets = [], replies = [];
  const ctx = { state, window: {}, PlaybackIntent: { generation: 1, current(n) { return n === this.generation; } },
    transport: { get: async url => { gets.push(url); const next = replies.shift(); if (next instanceof Error) throw next; return next; } },
    encodeURIComponent };
  vm.createContext(ctx); vm.runInContext(app.slice(start, end), ctx);
  assert.equal(ctx.homeSnapshot().current.id, 'restore');
  replies.push({ items: [ { source: 'local', track_id: 'gone' }, { source: 'local', track_id: 'valid' } ] },
    Object.assign(Error('gone'), { status: 404 }), { id: 'valid', title: '还在曲库' });
  assert.equal((await ctx.readHomeRecent()).id, 'valid', 'deleted local history skipped');
  replies.push({ items: [{ source: 'qq', ref_id: 'mid', title: '在线历史', cover_url: 'cover' }] });
  const online = await ctx.readHomeRecent(); assert.equal(online.id, 'online:qq:mid'); assert.equal(online.onlineId, 'mid');
  replies.push({ items: [{ source: 'local', track_id: 'network' }] }, Object.assign(Error('offline'), { status: 503 }));
  await assert.rejects(ctx.readHomeRecent(), /offline/, 'temporary errors do not become an empty history');
  const commands = [];
  let bound;
  ctx.HomeDashboard = ctx.window.HomeDashboard = { bind: host => { bound = host; } };
  ctx.Online = ctx.window.Online = { playAll: (tracks, at) => commands.push({ tracks, at }), safeCoverUrl: url => url };
  ctx.setPlayback = action => commands.push(action);
  ctx.playTrack = (id, queue) => commands.push({ id, queue });
  ctx.applyCoverImg = () => {};
  ctx.toast = () => {};
  ctx.initHomeDashboard();
  await bound.resume(); assert.equal(commands[0], 'play', 'restored queue uses play, never pause or a replacement queue');
  await bound.playRecent({ id: 'local-a', source: 'local' });
  assert.equal(commands[1].id, 'local-a'); assert.deepEqual(Array.from(commands[1].queue), ['local-a']);
  await bound.playRecent(online);
  assert.equal(commands[2].tracks[0].source, 'qq'); assert.equal(commands[2].tracks[0].id, 'mid');
  const navigation = [];
  ctx.setView = (name, options) => { state.view = name; navigation.push({ name, options }); };
  const historyReady = deferred(); ctx.Online.reloadHistory = () => historyReady.promise;
  let focused = 0;
  ctx.$ = id => id === 'op-history' ? { hidden: false, scrollIntoView() { focused++; } } : { focus() { focused++; } };
  const navigate = ctx.homeNavigate('recent');
  assert.equal(navigation[0].name, 'online'); assert.equal(navigation[0].options.historyOnly, true, 'recent navigation does not trigger duplicate history requests');
  state.view = 'library'; historyReady.resolve(); await navigate;
  assert.equal(focused, 0, 'late history navigation cannot steal focus after user leaves');
  console.log('Home dashboard: snapshot actions, restored queue, no autoplay, history/cover races, empty/error/retry and recent identity passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
