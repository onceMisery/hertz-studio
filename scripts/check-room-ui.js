#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Exercise the real room controller with reordered transport completions.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sources = ['host.js', 'favorites.js', 'room-workspace.js', 'room-view.js', 'room.js'].map(name => ({ name, source: fs.readFileSync(path.join(__dirname, '../plugin/ui', name), 'utf8') }));
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.value = ''; this.dataset = {}; this._text = ''; this.attrs = {}; this.style = { setProperty() {} }; this.classList = { toggle() {}, add() {}, remove() {} }; }
  set textContent(text) { this._text = String(text); this.children = []; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  insertBefore(node, before) { const index = before ? this.children.indexOf(before) : this.children.length; this.children.splice(index, 0, node); return node; }
  prepend(...nodes) { this.children.unshift(...nodes); }
  focus() {}
  showModal() { this.open = true; if (this.onShowModal) this.onShowModal(this); }
  close() { this.open = false; }
  remove() {}
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener() {}
  querySelectorAll(selector) { return walk(this).filter(node => (node.className || '').split(/\s+/).includes(selector.slice(1))); }
  querySelector(selector) { return walk(this).find(node => node.tagName === selector); }
}
const walk = node => [node, ...node.children.flatMap(walk)];
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function fixture(themePicker) {
  const favoriteStore = new Set();
  const root = new Node('main'), calls = [], reads = [], hooks = new Map(), chromeEvents = [], copied = [];
  let now = Date.now(), confirmation = async () => true;
  class FixtureDate extends Date { static now() { return now; } }
  let snapshot = { mode: 'host', room_id: 'room', instance_id: 'instance', session_id: 's1', member_id: 'owner', revision: '1', sharing_revision: '1', next_operation_id: '1', next_chat_operation_id: '1', permissions: { transport: true, chat_read: true, chat_send: true }, output: {}, queue: [], members: [] };
  const history = Array.from({ length: 450 }, (_, i) => ({ message_id: String(i + 1), name: 'Guest', text: 'Message ' + (i + 1), received_at_ms: '0' }));
  snapshot.recent_chat = { history_revision: '1', messages: history.slice(-16) };
  const transport = {
    async get(url) { reads.push(url); if (url === '/v1/room' && hooks.has('snapshot')) return hooks.get('snapshot')(); return url === '/v1/room' ? structuredClone(snapshot) : { tracks: [] }; },
    async post(url, body) {
      const request = url === '/v1/favorites/membership' ? { ...body, action: 'favorite_membership' } : url === '/v1/favorites/toggle' ? { ...body, action: 'favorite_write' } : body.action === 'peer' ? body.request : body;
      calls.push(structuredClone(request));
      if (hooks.has(request.action)) return hooks.get(request.action)(request);
      switch (request.action) {
        case 'favorite_membership': return { ids: request.ids.filter(id => favoriteStore.has(request.source + ':' + id)) };
        case 'favorite_write': favoriteStore[request.favorited ? 'add' : 'delete'](request.source + ':' + request.ref_id); return { favorited: request.favorited };
        case 'queue': return { state: 'applied' };
        case 'library': return { revision: snapshot.sharing_revision, tracks: [] };
        case 'queue_page': return { revision: snapshot.revision, queue: [], tracks: [] };
        case 'chat_history': {
          const end = request.before ? Number(request.before) - 1 : history.length;
          const messages = history.slice(Math.max(0, end - 100), end);
          return { messages, history_revision: snapshot.chat && snapshot.chat.history_revision || '1', has_more: end > 100, next_before: end > 100 ? messages[0].message_id : null };
        }
        default: return {};
      }
    }
  };
  const context = { document: { createElement: tag => { const node = new Node(tag); node.onShowModal = async modal => { if (modal.attrs['aria-labelledby'] !== 'room-entry-title-leave') return; const accepted = await confirmation(modal.textContent); const action = walk(modal).find(child => child.tagName === 'button' && child.textContent === (accepted ? snapshot.mode === 'host' ? '结束房间' : '退出房间' : snapshot.mode === 'host' ? '继续一起听' : '继续听')); action.onclick(); }; return node; }, hidden: false }, Date: FixtureDate, TextEncoder, URL, Blob, atob, Option: function (text, value) { const n = new Node('option'); n.textContent = text; n.value = value; return n; }, navigator: {}, setInterval: () => 1, clearInterval() {}, setTimeout() {}, matchMedia: () => ({ matches: true }) };
  context.window = context;
  context.HertzClipboard = { write: async value => copied.push(value) };
  if (themePicker) context.ThemePicker = themePicker;
  context.HertzRoomTransport = { create: () => ({ render() {}, notice() {}, destroy() {}, setWorkspaceVisible: value => chromeEvents.push(value) }) };
  vm.createContext(context);
  sources.forEach(({ name, source }) => vm.runInContext(source, context, { filename: name }));
  context.VMusicTransport = transport;
  context.Favorites.bind({ ui: {}, state: { view: 'room' }, toast() {}, errText: (prefix, error) => prefix + error.message });
  context.HertzRoom.init({ root, transport, confirm: message => confirmation(message) });
  const nodes = () => walk(root);
  return {
    api: context.HertzRoom, favorites: context.Favorites, calls, reads, hooks, root, chromeEvents, history, copied,
    button: (text, scope) => { const parents = scope ? nodes().filter(n => n.className === scope) : [root]; assert.ok(parents.length, scope || 'root'); const n = parents.flatMap(walk).find(n => n.tagName === 'button' && n.textContent === text); assert.ok(n, text); return n; },
    field: (label, scope) => { const n = walk(scope || root).find(n => n.tagName === 'label' && n._text === label); assert.ok(n, label); return n.children[0]; },
    chat: () => nodes().find(n => n.tagName === 'ol' && n.className === 'room-chat'),
    form: () => nodes().find(n => n.tagName === 'form'),
    set: patch => { snapshot = { ...snapshot, ...patch }; },
    setConfirm: fn => { confirmation = fn; },
    advance: milliseconds => { now += milliseconds; },
    async poll() { await context.HertzRoom.onViewEnter(); await settle(); }
  };
}
async function applicantFixture() {
  const f = fixture(); await settle();
  f.set({ mode: 'local' }); await f.poll();
  f.hooks.set('discover', async () => ({ interfaces: [], rooms: [{ name: 'Approval room', room_id: 'approval-room', room_code: 'A1B2C3D4', addresses: ['192.0.2.5:17000'], fingerprint: 'ab'.repeat(32) }] }));
  f.hooks.set('apply', async () => ({ application_id: 'application-one', applicant_secret: 'fixture-applicant-secret', state: 'pending', expires_in_seconds: 300 }));
  await f.button('发现房间与网卡').onclick();
  await f.button('申请加入').onclick();
  const applicationDialog = walk(f.root).find(node => node.tagName === 'dialog' && node.attrs['aria-labelledby'] === 'room-entry-title-apply');
  f.field('你的昵称', applicationDialog).value = '申请听众';
  const applying = f.button('提交申请').onclick(); await settle();
  assert.equal(f.calls.some(call => call.action === 'apply'), false, 'application waits for inline fingerprint confirmation');
  await f.button('已核对，继续').onclick(); await applying;
  return f;
}
async function main() {
  {
    const f = fixture(); await settle(); f.set({ mode: 'local' }); await f.poll();
    const dialog = walk(f.root).find(node => node.tagName === 'dialog' && node.attrs['aria-labelledby'] === 'room-entry-title-join');
    const invitation = 'hertz-listen:v1:eyJhZGRyZXNzIjoiMTkyLjAuMi4xMDoxNzAwMCIsImZpbmdlcnByaW50IjoiYWFiYiJ9';
    await f.button('使用邀请加入').onclick();
    f.field('你的昵称', dialog).value = '超时听众';
    const inviteField = f.field('邀请或 8 位查找码', dialog); inviteField.value = invitation; inviteField.oninput();
    f.hooks.set('join', async () => { throw Object.assign(new Error('network timeout'), { code: 'timeout', status: 504 }); });
    const joining = f.button('加入房间').onclick(); await settle();
    await f.button('已核对，继续').onclick(); await joining;
    const originalJoin = f.calls.find(call => call.action === 'join');
    assert.equal(originalJoin.invitation, invitation, 'full-invite join submits the verified token');
    assert.equal(f.button('加入房间').disabled, true, 'unknown join disables the original write');
    assert.match(f.root.textContent, /加入结果尚未确认/);
    await walk(dialog).find(node => node.tagName === 'button' && node.textContent === '关闭').onclick();
    assert.equal(dialog.open, false);
    await f.button('使用邀请加入').onclick();
    assert.equal(f.field('邀请或 8 位查找码', dialog).value, invitation, 'closing and reopening keeps the uncertain invitation draft');
    assert.equal(f.button('加入房间').disabled, true, 'reopening never clears uncertain join protection');
    const writes = f.calls.length, reads = f.reads.length;
    await f.button('查看加入结果').onclick();
    assert.ok(f.reads.length > reads && f.reads.slice(reads).every(url => url === '/v1/room'), 'join status uses only authoritative snapshot GETs');
    assert.equal(f.calls.length, writes, 'checking an unknown join sends no command');
    await f.button('加入房间').onclick();
    assert.equal(f.calls.filter(call => call.action === 'join').length, 1, 'even invoking the old join handler cannot replay a consumed invitation');
    assert.equal(f.button('加入房间').disabled, true, 'local snapshot does not prove the original join failed');
    f.api.destroy();
  }
  for (const queueUnknown of [false, true]) {
    const f = fixture(); await settle(); f.set({ mode: 'local' }); await f.poll();
    const selected = [{ id: 'selected-local', source: 'local', title: 'Selected song' }];
    f.hooks.set('create', async () => { f.set({ mode: 'host', session_id: 'selected-host', permissions: { queue: true } }); return { mode: 'host' }; });
    f.hooks.set('share', async request => {
      assert.deepEqual(Array.from(request.track_ids), ['selected-local'], 'starting from a selection shares exactly those local IDs');
      return { tracks: [{ resource_id: 'selected-resource', favorite_key: 'selected-key' }], favorite_local_ids: { 'selected-key': 'selected-local' } };
    });
    if (queueUnknown) f.hooks.set('queue', async () => { throw Object.assign(new Error('timeout'), { code: 'room_outcome_unknown' }); });
    await f.api.startFromTracks(selected);
    assert.equal(f.calls.some(call => call.action === 'share'), false, 'the create draft requires explicit creation');
    f.field('局域网网卡').value = '192.0.2.10';
    f.field('你的昵称').value = '选曲房主';
    await f.button('创建房间').onclick(); await settle();
    assert.equal(f.calls.filter(call => call.action === 'create').length, 1);
    assert.equal(f.calls.filter(call => call.action === 'share').length, 1);
    assert.deepEqual(f.calls.find(call => call.action === 'queue').items, [{ instance_id: null, resource_id: 'selected-resource' }]);
    assert.equal(f.calls.some(call => call.action === 'playback'), false, 'creating with selected tracks does not start playback');
    assert.equal(f.api.active(), true, 'the created room remains available after selection processing');
    await f.poll();
    assert.equal(f.calls.filter(call => call.action === 'queue').length, 1, 'polling never replays selection queue writes');
    if (queueUnknown) {
      await assert.rejects(f.api.startFromTracks(selected), /待确认/);
      await f.button('继续添加选中的歌曲').onclick();
      assert.equal(f.calls.filter(call => call.action === 'share').length, 1, 'uncertain queue results never re-share selected tracks');
      assert.equal(f.calls.filter(call => call.action === 'queue').length, 1, 'uncertain queue results never append the selection twice');
      const staleContinue = f.button('继续添加选中的歌曲');
      f.hooks.set('operation', async () => ({ state: { status: 'applied' } }));
      await f.button('查询原队列操作结果').onclick();
      assert.equal(staleContinue.hidden, true, 'confirmed original success retires its source selection');
      await staleContinue.onclick();
      assert.equal(f.calls.filter(call => call.action === 'queue').length, 1, 'even a stale Continue callback cannot replay a confirmed selection');
    }
    f.api.destroy();
  }
  {
    const f = fixture(); await settle();
    const old = deferred(), firstCover = 'data:image/png;base64,YQ==', nextCover = 'data:image/png;base64,Yg==';
    f.hooks.set('room_profile', () => old.promise);
    f.set({ mode: 'guest', room_cover_revision: 'first-cover' }); await f.poll(); await f.poll();
    assert.equal(f.calls.filter(call => call.action === 'room_profile').length, 1, 'unchanged snapshots share a single cover read');
    f.hooks.set('room_profile', async () => ({ room_id: 'room', revision: 'next-cover', cover: nextCover }));
    f.set({ room_cover_revision: 'next-cover' }); await f.poll();
    old.resolve({ room_id: 'room', revision: 'first-cover', cover: firstCover }); await settle();
    assert.ok(walk(f.root).some(node => node.tagName === 'img' && node.src === nextCover), 'new cover remains visible after old read completes');
    assert.ok(!walk(f.root).some(node => node.tagName === 'img' && node.src === firstCover));
    const reads = f.calls.filter(call => call.action === 'room_profile').length;
    await f.poll(); assert.equal(f.calls.filter(call => call.action === 'room_profile').length, reads, 'confirmed cover is cached across polls');
    f.set({ room_cover_revision: null }); await f.poll();
    assert.ok(!walk(f.root).some(node => node.tagName === 'img' && node.src === nextCover), 'cover removal clears member artwork');
  }
  {
    const f = fixture(); await settle();
    f.setConfirm(async () => false);
    await f.button('结束并退出').onclick();
    assert.equal(f.calls.filter(call => call.action === 'leave').length, 0, 'cancelled host exit never sends leave');
    f.setConfirm(async () => true);
    f.hooks.set('leave', async () => { throw new Error('exit rejected'); });
    await f.button('结束并退出').onclick();
    assert.ok(f.root.textContent.includes('exit rejected'), 'exit failure is visible');
    assert.ok(f.button('结束并退出'), 'exit failure keeps the host room');
    f.hooks.set('leave', async () => { f.set({ mode: 'local' }); return { mode: 'local' }; });
    await f.button('结束并退出').onclick();
    assert.equal(f.root.dataset.roomPage, 'summary', 'confirmed host exit opens the listening summary');
  }
  {
    const f = fixture(); await settle(); f.set({ mode: 'guest' }); await f.poll();
    const pending = deferred(); f.hooks.set('leave', () => pending.promise);
    const exit = f.button('离开房间').onclick(); await settle();
    await f.button('离开房间').onclick();
    assert.equal(f.calls.filter(call => call.action === 'leave').length, 1, 'duplicate exit is suppressed');
    f.set({ mode: 'host', room_id: 'replacement', instance_id: 'new-instance', session_id: 'new-session' }); await f.poll();
    pending.resolve({ mode: 'local' }); await exit; await settle();
    assert.ok(f.button('结束并退出'), 'late exit response cannot close a replacement room');
  }
  {
    const f = fixture(); await settle();
    const oldPoll = deferred(); f.hooks.set('snapshot', () => oldPoll.promise);
    const poll = f.api.onViewEnter(); await settle();
    f.hooks.set('leave', async () => { f.set({ mode: 'local' }); return { mode: 'local' }; });
    await f.button('结束并退出').onclick();
    oldPoll.resolve({ mode: 'host', room_id: 'room', instance_id: 'instance', member_id: 'owner', session_id: 's1' });
    await poll; await settle();
    assert.equal(f.root.dataset.roomPage, 'summary', 'a poll started before confirmed exit cannot resurrect the old room');
  }
  {
    const f = fixture(); await settle();
    const key = 'ab'.repeat(32), song = { resource_id: 'online-resource', favorite_key: key, title: 'Online song' };
    const track = { source: 'ccmixter', id: 'song:with:colon', title: song.title, playable: true, ref: { license: 'fixture' } };
    f.set({ permissions: { queue: true, transport: true } }); await f.poll();
    f.hooks.set('share_online', async request => {
      assert.equal(request.tracks[0].ref.license, 'fixture', 'provider reference survives sharing');
      f.set({ revision: '8', sharing_revision: '2', favorite_local_ids: { [key]: 'online:ccmixter:song:with:colon' }, shared_track_ids: ['online:ccmixter:song:with:colon'], current_track: song });
      return { revision: '8', tracks: [song], favorite_local_ids: { [key]: 'online:ccmixter:song:with:colon' } };
    });
    f.hooks.set('queue_page', async request => { assert.equal(request.revision, '8', 'online sharing revision is used before the next poll'); return { revision: '8', queue: [], tracks: [] }; });
    f.hooks.set('library', async () => ({ revision: '2', tracks: [song] }));
    await f.api.addOnline([track]); await settle(); await f.poll();
    const write = f.calls.find(call => call.action === 'queue');
    assert.equal(write.items[0].resource_id, song.resource_id);
    assert.equal(write.items[0].instance_id, null, 'online append uses the same instance allocator');
    assert.equal(write.expected_revision, '8', 'append follows the confirmed share revision');
    const heart = walk(f.root).find(node => node.className === 't-act fav-act');
    assert.ok(heart, 'shared online songs expose favorites');
    await heart.onclick({ stopPropagation() {} }); await settle();
    const favorite = f.calls.find(call => call.action === 'favorite_write');
    assert.equal(favorite.source, 'ccmixter', 'host online favorite keeps the platform identity');
    assert.equal(favorite.ref_id, 'song:with:colon');
    f.set({ mode: 'guest' }); await f.poll();
    await assert.rejects(f.api.addOnline([track]), /房主分享/);
    f.set({ mode: 'local' }); await f.poll();
    await assert.rejects(f.api.addOnline([track]), /先.*创建房间/);
    assert.equal(f.calls.filter(call => call.action === 'share_online').length, 1, 'guest and local states cannot mutate room shares');
    f.api.destroy();
  }
  {
    const f = fixture(); await settle();
    const songs = Array.from({ length: 66 }, (_, index) => ({ resource_id: 'resource-' + index, favorite_key: String(index).padStart(64, '0'), title: 'Online page ' + index }));
    f.hooks.set('library', async request => ({ revision: '2', tracks: songs.slice(request.offset, request.offset + request.limit) }));
    f.set({ sharing_revision: '2', favorite_local_ids: Object.fromEntries(songs.map((song, index) => [song.favorite_key, 'online:ccmixter:' + index])) });
    await f.poll(); await settle();
    assert.ok(f.calls.some(call => call.action === 'library' && call.offset === 64 && call.limit === 64), 'sharing manager follows the server page limit beyond 64 tracks');
    assert.equal(walk(f.root).filter(node => node.className === 'room-local-item').length, 66, 'every shared online song can be revoked');
    f.api.destroy();
  }
  {
    const bindings = new Set();
    let destroyed = 0;
    const picker = {
      bind(button) { bindings.add(button); return { destroy() { bindings.delete(button); destroyed++; } }; },
      close() {}
    };
    const f = fixture(picker); await settle();
    const button = () => walk(f.root).find(n => n.className === 'iconbtn room-theme-button');
    assert.equal(button().attrs['aria-label'], '切换主题色');
    assert.equal(button().children[0].children[0].attrs.href, '#i-palette', 'same palette symbol as the application');
    assert.equal(bindings.size, 1, 'room delegates to shared picker');
    f.set({ mode: 'local' }); await f.poll();
    assert.ok(button(), 'lobby retains palette button');
    assert.equal(bindings.size, 1, 'workspace replacement releases previous trigger');
    assert.equal(f.calls.some(call => /theme/i.test(call.action)), false, 'themes never issue room operations');
    f.api.destroy();
    assert.equal(bindings.size, 0, 'destroy releases shared picker binding');
    assert.ok(destroyed >= 2);
  }
  {
  const targetKey = 'ab'.repeat(32), hostPin = 'cd'.repeat(32), lanRef = hostPin + ':' + targetKey;
  const song = { resource_id: 'ephemeral-resource', favorite_key: targetKey, title: 'Shared favorite', artist: 'Artist' };
  const hostFavorite = fixture(); await settle();
  hostFavorite.hooks.set('library', async () => ({ revision: '2', tracks: [song] }));
  hostFavorite.hooks.set('queue_page', async () => ({ revision: '2', queue: [{ instance_id: '1', resource_id: song.resource_id }, { instance_id: '2', resource_id: song.resource_id }], tracks: [song] }));
  hostFavorite.set({ revision: '2', sharing_revision: '2', fingerprint: hostPin, favorite_local_ids: { [targetKey]: 'original-local-track' }, current_track: song });
  await hostFavorite.poll();
  const hostHearts = walk(hostFavorite.root).filter(node => node.className === 't-act fav-act');
  assert.equal(hostHearts.length, 4, 'player, duplicate queue occurrences, and shared library expose favorites');
  await hostHearts[0].onclick({ stopPropagation() {} }); await settle();
  const hostWrite = hostFavorite.calls.find(call => call.action === 'favorite_write');
  assert.equal(hostWrite.source, 'local', 'host favorites reuse its existing local store identity');
  assert.equal(hostWrite.ref_id, 'original-local-track');
  assert.equal(hostWrite.favorited, true);
  assert.ok(hostHearts.every(heart => heart.attrs['aria-pressed'] === 'true'), 'all views and occurrences reflect one confirmed favorite');
  hostFavorite.api.destroy();

  const guestFavorite = fixture(); await settle();
  guestFavorite.hooks.set('library', async () => ({ revision: '2', tracks: [song] }));
  guestFavorite.set({ mode: 'guest', revision: '2', sharing_revision: '2', fingerprint: hostPin, favorite_local_ids: { [targetKey]: 'untrusted-local-id' }, permissions: { queue: true }, current_track: song });
  await guestFavorite.poll();
  const guestHeart = walk(guestFavorite.root).find(node => node.className === 't-act fav-act');
  await guestHeart.onclick({ stopPropagation() {} }); await settle();
  const guestWrite = guestFavorite.calls.find(call => call.action === 'favorite_write');
  assert.equal(guestWrite.source, 'lan'); assert.equal(guestWrite.ref_id, lanRef);
  assert.equal(guestWrite.cover, null, 'live cover capabilities never enter durable favorites');
  assert.doesNotMatch(JSON.stringify(guestWrite), /ephemeral-resource|untrusted-local-id/);
  const favorite = { source: 'lan', ref_id: lanRef };
  guestFavorite.hooks.set('resolve_favorites', async () => ({ tracks: [song] }));
  await guestFavorite.api.activateFavorite(favorite);
  let queueWrites = guestFavorite.calls.filter(call => call.action === 'queue');
  assert.equal(queueWrites.length, 1); assert.equal(queueWrites[0].items[0].resource_id, song.resource_id);
  assert.equal(queueWrites[0].items[0].instance_id, null, 'activating a durable favorite allocates a fresh queue occurrence');
  guestFavorite.set({ mode: 'reconnecting' });
  await assert.rejects(guestFavorite.api.activateFavorite(favorite), /离线|重连/);
  guestFavorite.set({ mode: 'guest', permissions: {} });
  await assert.rejects(guestFavorite.api.activateFavorite(favorite), /授权/);
  guestFavorite.set({ permissions: { queue: true }, fingerprint: 'ef'.repeat(32) });
  await assert.rejects(guestFavorite.api.activateFavorite(favorite), /来源不同/);
  guestFavorite.set({ fingerprint: hostPin });
  guestFavorite.hooks.set('resolve_favorites', async () => ({ tracks: [] }));
  await assert.rejects(guestFavorite.api.activateFavorite(favorite), /撤销.*分享/);
  guestFavorite.hooks.set('resolve_favorites', async () => ({ tracks: [song] }));
  guestFavorite.hooks.set('queue', async () => { throw Object.assign(new Error('timeout'), { code: 'room_outcome_unknown' }); });
  let unknownQueueError;
  await assert.rejects(guestFavorite.api.activateFavorite(favorite), error => { unknownQueueError = error; return /结果未确认/.test(error.message); });
  await guestFavorite.poll();
  queueWrites = guestFavorite.calls.filter(call => call.action === 'queue');
  assert.equal(queueWrites.length, 2, 'polling does not replay an uncertain favorite queue write');
  const originalUnknown = queueWrites.at(-1);
  assert.equal(unknownQueueError.operation_id, originalUnknown.operation_id, 'uncertain queue errors retain their original operation identity');
  assert.equal(unknownQueueError.owner, guestFavorite.api.operationContext());
  const resolveCount = guestFavorite.calls.filter(call => call.action === 'resolve_favorites').length;
  await assert.rejects(guestFavorite.api.activateFavorite(favorite), /原队列操作结果未确认/);
  assert.equal(guestFavorite.calls.filter(call => call.action === 'queue').length, 2, 'reclick after unknown cannot append again');
  assert.equal(guestFavorite.calls.filter(call => call.action === 'resolve_favorites').length, resolveCount, 'unknown gate applies before another favorite resolution');
  guestFavorite.hooks.set('operation', async () => { throw Object.assign(new Error('missing outcome'), { code: 'operation_unknown', status: 422 }); });
  await guestFavorite.button('查询原队列操作结果').onclick();
  await assert.rejects(guestFavorite.api.activateFavorite(favorite), /原队列操作结果未确认/);
  guestFavorite.hooks.set('operation', async request => { assert.equal(request.operation_id, originalUnknown.operation_id, 'query reads the original operation instead of allocating a fresh write'); return { state: 'applied' }; });
  await guestFavorite.button('查询原队列操作结果').onclick();
  assert.equal(guestFavorite.calls.filter(call => call.action === 'queue').length, 2, 'querying a committed append never replays it');
  assert.equal(walk(guestFavorite.root).some(node => node.tagName === 'button' && node.textContent === '查询原队列操作结果'), false, 'confirmed original outcome clears its pending receipt');

  const delayedResolution = deferred();
  guestFavorite.hooks.set('resolve_favorites', () => delayedResolution.promise);
  guestFavorite.hooks.set('queue', async () => ({ state: 'applied' }));
  const resolvingAppend = guestFavorite.api.activateFavorite(favorite); await settle();
  await assert.rejects(guestFavorite.api.activateFavorite(favorite), /正在处理原队列操作/);
  assert.equal(guestFavorite.calls.filter(call => call.action === 'queue').length, 2, 'pending reference resolution reserves the queue operation before any write');
  delayedResolution.resolve({ tracks: [song] }); await resolvingAppend;
  assert.equal(guestFavorite.calls.filter(call => call.action === 'queue').length, 3, 'late reference resolution after a double click still appends only once');
  guestFavorite.hooks.set('resolve_favorites', async () => ({ tracks: [song] }));
  const delayedWrite = deferred();
  guestFavorite.hooks.set('queue', () => delayedWrite.promise);
  const pendingAppend = guestFavorite.api.activateFavorite(favorite); await settle();
  await assert.rejects(guestFavorite.api.activateFavorite(favorite), /正在处理原队列操作/);
  assert.equal(guestFavorite.calls.filter(call => call.action === 'queue').length, 4, 'double click while a write is pending produces one new queue write');
  delayedWrite.resolve({ state: 'applied' }); await pendingAppend;
  assert.equal(guestFavorite.calls.filter(call => call.action === 'queue').length, 4);
  const late = deferred(); guestFavorite.hooks.set('resolve_favorites', () => late.promise);
  const staleActivation = guestFavorite.api.activateFavorite(favorite); await settle();
  guestFavorite.set({ room_id: 'different-room', member_id: 'different-member' }); await guestFavorite.poll();
  late.resolve({ tracks: [song] });
  await assert.rejects(staleActivation, /会话已改变/);
  assert.equal(guestFavorite.calls.filter(call => call.action === 'queue').length, 4, 'late resolution cannot write to another membership');
  guestFavorite.hooks.set('resolve_favorites', async () => ({ tracks: [song] }));
  const abandonedWrite = deferred(); guestFavorite.hooks.set('queue', () => abandonedWrite.promise);
  const oldMembershipWrite = guestFavorite.api.activateFavorite(favorite); await settle();
  guestFavorite.set({ room_id: 'newest-room', member_id: 'newest-member' }); await guestFavorite.poll();
  const newestWrite = deferred(); guestFavorite.hooks.set('queue', () => newestWrite.promise);
  const newestMembershipWrite = guestFavorite.api.activateFavorite(favorite); await settle();
  abandonedWrite.resolve({ state: 'applied' });
  await assert.rejects(oldMembershipWrite, /会话已改变/);
  await assert.rejects(guestFavorite.api.activateFavorite(favorite), /正在处理原队列操作/, 'late old success cannot clear the newer membership receipt');
  newestWrite.resolve({ state: 'applied' }); await newestMembershipWrite;
  guestFavorite.set({ mode: 'local' });
  await assert.rejects(guestFavorite.api.activateFavorite(favorite), /连接.*原房主/);
  assert.equal(guestFavorite.favorites.has('track', 'lan', lanRef), true, 'leaving preserves the personal favorite snapshot');
  guestFavorite.api.destroy();

  }
  {
    const f = fixture(); await settle();
    const targetKey = 'ab'.repeat(32), hostPin = 'cd'.repeat(32);
    const favorite = { source: 'lan', ref_id: hostPin + ':' + targetKey };
    const song = { resource_id: 'recoverable-resource', favorite_key: targetKey, title: 'Recoverable favorite' };
    const abandonLabel = '放弃这次待确认队列操作';
    const hasAbandon = () => walk(f.root).some(node => node.tagName === 'button' && node.textContent === abandonLabel);
    const writes = () => f.calls.filter(call => call.action === 'queue');
    f.set({ mode: 'guest', fingerprint: hostPin, permissions: { queue: true } }); await f.poll();
    const resolving = deferred(); f.hooks.set('resolve_favorites', () => resolving.promise);
    const sending = deferred(); f.hooks.set('queue', () => sending.promise);
    const first = f.api.activateFavorite(favorite); await settle();
    assert.equal(hasAbandon(), false, 'a preparing queue operation cannot be abandoned');
    resolving.resolve({ tracks: [song] }); await settle();
    assert.equal(writes().length, 1);
    assert.equal(hasAbandon(), false, 'a sending queue operation cannot be abandoned');
    sending.resolve({ state: 'applied' }); await first;

    f.hooks.set('resolve_favorites', async () => ({ tracks: [song] }));
    f.hooks.set('queue', async () => { throw Object.assign(new Error('timeout'), { code: 'room_outcome_unknown' }); });
    await assert.rejects(f.api.activateFavorite(favorite), /结果未确认/);
    const unknownWrite = writes().at(-1);
    f.hooks.set('operation', async () => { throw Object.assign(new Error('expired outcome'), { code: 'operation_unknown', status: 422 }); });
    await f.button('查询原队列操作结果').onclick();
    assert.equal(hasAbandon(), true, 'a missing or expired result can be explicitly abandoned');
    let confirmationText;
    f.setConfirm(async message => { confirmationText = message; return false; });
    await f.button(abandonLabel).onclick();
    assert.match(confirmationText, /可能已经生效.*检查共同队列/);
    assert.match(confirmationText, /不会撤销或重放/);
    assert.equal(hasAbandon(), true, 'cancel retains the original receipt');
    await assert.rejects(f.api.activateFavorite(favorite), /原队列操作结果未确认/);
    assert.equal(writes().length, 2, 'cancel and a blocked click cannot replay a queue write');
    f.setConfirm(async () => true);
    await f.button(abandonLabel).onclick();
    assert.equal(hasAbandon(), false, 'confirmation clears only the local pending receipt');
    assert.equal(writes().length, 2, 'abandon never sends or replays a queue write');
    assert.match(f.root.textContent, /已放弃本机待确认记录.*可能已经生效/);
    f.hooks.set('queue', async () => ({ state: 'applied' }));
    await f.api.activateFavorite(favorite);
    assert.equal(writes().length, 3, 'the next intentional append sends one fresh operation');
    assert.notEqual(writes().at(-1).operation_id, unknownWrite.operation_id);

    f.hooks.set('queue', async () => { throw Object.assign(new Error('timeout'), { code: 'room_outcome_unknown' }); });
    await assert.rejects(f.api.activateFavorite(favorite), /结果未确认/);
    const confirming = deferred(); f.setConfirm(() => confirming.promise);
    const abandoningOldOwner = f.button(abandonLabel).onclick(); await settle();
    f.set({ room_id: 'another-room', member_id: 'another-member' }); await f.poll();
    await assert.rejects(f.api.activateFavorite(favorite), /结果未确认/);
    const newestWrite = writes().at(-1);
    confirming.resolve(true); await abandoningOldOwner;
    assert.equal(hasAbandon(), true, 'late confirmation cannot clear the new membership receipt');
    await assert.rejects(f.api.activateFavorite(favorite), /原队列操作结果未确认/);
    assert.equal(writes().length, 5, 'owner changes and late confirmation never replay an operation');
    assert.equal(writes().at(-1).operation_id, newestWrite.operation_id);
    f.setConfirm(async () => true); await f.button(abandonLabel).onclick();
    f.api.destroy();
  }
  for (const [action, className, errorCode] of [['queue_page', 'room-queue', 'room_denied'], ['library', 'room-list', 'storage']]) {
    const projection = fixture(); await settle();
    const initialCalls = projection.calls.length;
    const notice = () => walk(walk(projection.root).find(node => node.className === 'room-workspace')).find(node => /(^| )room-notice( |$)/.test(node.className || ''));
    let attempts = 0;
    projection.hooks.set(action, async () => {
      if (++attempts === 1) throw Object.assign(new Error('队列已更新，请重新读取'), { code: 'revision_conflict', status: 409 });
      const tracks = [{ resource_id: 'projected-song', title: 'Recovered projection' }];
      return { revision: '2', queue: [{ instance_id: 'projected-instance', resource_id: 'projected-song' }], tracks };
    });
    projection.set({ revision: '2', sharing_revision: '2' }); await projection.poll();
    assert.equal(attempts, 1, action + ' conflict waits for the next poll');
    assert.equal(notice().hidden, true, action + ' background conflict does not surface a user error');
    assert.doesNotMatch(projection.root.textContent, /队列已更新，请重新读取/);
    await projection.poll();
    assert.equal(attempts, 2, action + ' invalidates its signature even when the next snapshot is unchanged');
    assert.match(walk(projection.root).find(node => node.className === className).textContent, /Recovered projection/, action + ' next poll renders the successful projection');
    assert.equal(notice().hidden, true, 'recovery leaves no stale global error');
    assert.ok(projection.calls.slice(initialCalls).every(call => ['queue_page', 'library', 'chat_history'].includes(call.action)), 'background recovery sends reads only');
    projection.hooks.set(action, async () => { throw Object.assign(new Error('Projection access failed'), { code: errorCode, status: 403 }); });
    projection.set({ revision: '3', sharing_revision: '3' }); await projection.poll();
    assert.equal(notice().hidden, false, action + ' genuine failure stays visible');
    assert.equal(notice().textContent, 'Projection access failed');
    projection.api.destroy();
  }

  const writeConflict = fixture(); await settle();
  writeConflict.hooks.set('queue_page', async () => ({ revision: '2', queue: [{ instance_id: 'existing', resource_id: 'song' }], tracks: [] }));
  writeConflict.hooks.set('queue', async () => { throw Object.assign(new Error('Write revision conflict'), { code: 'revision_conflict', status: 409 }); });
  writeConflict.set({ revision: '2', queue_count: 1, permissions: { queue: true } }); await writeConflict.poll();
  await writeConflict.button('移除').onclick();
  assert.ok(walk(writeConflict.root).some(node => node.className === 'room-notice' && !node.hidden && node.textContent === 'Write revision conflict'), 'user write conflicts remain visible');
  await writeConflict.poll();
  assert.equal(writeConflict.calls.filter(call => call.action === 'queue').length, 1, 'polling never replays a conflicted write');
  writeConflict.api.destroy();

  const retryAdmission = await applicantFixture();
  retryAdmission.hooks.set('admission_status', async () => ({ state: 'approved', invitation: 'first-approved-capability', expires_in_seconds: 300 }));
  retryAdmission.hooks.set('join', async () => {
    if (retryAdmission.calls.filter(call => call.action === 'join').length === 1) throw Object.assign(new Error('pinned TLS failed'), { code: 'room_pin', status: 400 });
    retryAdmission.set({ mode: 'guest', member_id: 'approved-member' }); return { mode: 'guest' };
  });
  await retryAdmission.button('查看申请结果').onclick();
  assert.equal(retryAdmission.calls.filter(call => call.action === 'join').length, 1, 'first approval attempts joining once');
  assert.match(retryAdmission.root.textContent, /本次连接失败/);
  assert.doesNotMatch(retryAdmission.root.textContent, /fixture-applicant-secret|first-approved-capability/, 'retained application capabilities never enter DOM text');
  await retryAdmission.poll();
  assert.equal(retryAdmission.calls.filter(call => call.action === 'join').length, 1, 'ordinary polling never retries a failed join');
  retryAdmission.hooks.set('admission_status', async () => ({ state: 'approved', invitation: 'checked-approved-capability', expires_in_seconds: 280 }));
  await retryAdmission.button('查看入房状态').onclick();
  const retainedStatus = retryAdmission.calls.filter(call => call.action === 'admission_status').at(-1);
  assert.equal(retainedStatus.application_id, 'application-one');
  assert.equal(retainedStatus.applicant_secret, 'fixture-applicant-secret', 'failed join preserves the original applicant identity for status checks');
  assert.equal(retryAdmission.calls.filter(call => call.action === 'join').length, 1, 'checking approval after failure does not repeat joining');
  const freshApproval = deferred(); retryAdmission.hooks.set('admission_status', () => freshApproval.promise);
  const retryingJoin = retryAdmission.button('重试加入房间').onclick(); await settle();
  assert.equal(retryAdmission.calls.filter(call => call.action === 'join').length, 1, 'explicit retry waits for fresh authoritative approval');
  freshApproval.resolve({ state: 'approved', invitation: 'fresh-approved-capability', expires_in_seconds: 270 }); await retryingJoin;
  assert.equal(retryAdmission.calls.filter(call => call.action === 'join').length, 2, 'explicit retry adds exactly one join');
  assert.equal(retryAdmission.calls.filter(call => call.action === 'join').at(-1).invitation, 'fresh-approved-capability', 'retry uses the freshly checked capability');
  assert.equal(retryAdmission.api.active(), true);
  await retryAdmission.poll();
  assert.equal(retryAdmission.calls.filter(call => call.action === 'join').length, 2, 'successful joining is not replayed by polling');
  retryAdmission.api.destroy();

  const consumedAdmission = await applicantFixture();
  consumedAdmission.hooks.set('admission_status', async () => ({ state: 'approved', invitation: 'uncertain-capability' }));
  consumedAdmission.hooks.set('join', async () => { throw Object.assign(new Error('request timed out'), { code: 'timeout', status: 504 }); });
  await consumedAdmission.button('查看申请结果').onclick();
  assert.match(consumedAdmission.root.textContent, /加入结果尚未确认/);
  consumedAdmission.hooks.set('admission_status', async () => ({ state: 'consumed', member_id: 'already-paired-member' }));
  await consumedAdmission.button('查看入房状态').onclick(); await consumedAdmission.poll();
  assert.equal(consumedAdmission.calls.filter(call => call.action === 'join').length, 1, 'consumed approval never replays an uncertain join');
  assert.match(consumedAdmission.root.textContent, /该申请已经用于加入房间/);
  assert.equal(walk(consumedAdmission.root).some(node => node.tagName === 'button' && node.textContent === '重试加入房间'), false, 'consumed capability exposes no retry action');
  consumedAdmission.api.destroy();

  const lateApproval = await applicantFixture();
  lateApproval.advance(301000); await lateApproval.poll();
  lateApproval.hooks.set('admission_status', async () => ({ state: 'approved', invitation: 'renewed-after-approval-capability', expires_in_seconds: 300 }));
  lateApproval.hooks.set('join', async () => { lateApproval.set({ mode: 'guest', member_id: 'late-approved-member' }); return { mode: 'guest' }; });
  await lateApproval.button('查看申请结果').onclick();
  assert.equal(lateApproval.calls.filter(call => call.action === 'admission_status').at(-1).applicant_secret, 'fixture-applicant-secret', 'original local TTL cannot discard a potentially renewed approval');
  assert.equal(lateApproval.calls.filter(call => call.action === 'join').length, 1, 'server-approved capability remains usable after original local TTL');
  assert.equal(lateApproval.api.active(), true);
  lateApproval.api.destroy();

  const navigation = fixture(); await settle();
  navigation.api.navigate('collaborate');
  navigation.field('说点什么（最多 200 字）').value = 'Unsent draft';
  const beforeNavigation = navigation.calls.length;
  navigation.api.navigate('settings'); navigation.api.navigate('collaborate');
  assert.equal(navigation.calls.length, beforeNavigation, 'page navigation never sends room writes');
  navigation.set({ session_id: 's2' }); await navigation.poll();
  assert.equal(navigation.root.dataset.roomPage, 'play', 'collaborate intent stays on the listening scene after reconnect');
  assert.equal(navigation.root.dataset.roomAside, 'queue', 'collaborate intent opens the queue aside');
  assert.equal(navigation.field('说点什么（最多 200 字）').value, 'Unsent draft', 'same-member reconnect preserves an unsent draft');
  navigation.api.onViewExit();
  assert.equal(navigation.chromeEvents.at(-1), false, 'returning to Hertz restores compact room controls');
  await navigation.poll();
  assert.equal(navigation.chromeEvents.at(-1), true, 'workspace hides duplicate compact controls');
  navigation.set({ member_id: 'different-member' }); await navigation.poll();
  assert.equal(navigation.root.dataset.roomPage, 'play', 'membership change starts a fresh workspace');
  assert.equal(navigation.field('说点什么（最多 200 字）').value, '', 'drafts never cross memberships');
  navigation.api.destroy();

  const admissions = fixture(); await settle();
  const popup = () => walk(admissions.root).find(n => n.attrs['aria-labelledby'] === 'room-entry-title-admissions');
  const dot = () => walk(admissions.root).find(n => n.className === 'room-member-dot');
  const application = { id: 'new-application', name: '临窗听众', state: 'pending' };
  admissions.set({ admission: { pending: [application] } }); await admissions.poll();
  assert.equal(popup().open, true, 'a new application opens a review dialog');
  assert.equal(dot().hidden, false, 'members retain a pending application dot');
  await admissions.button('稍后处理').onclick(); await admissions.poll();
  assert.equal(popup().open, false, 'polling cannot reopen a dismissed application');
  assert.equal(dot().hidden, false, 'dismissal does not mark a pending application as handled');
  admissions.set({ admission: { pending: [{ ...application, state: 'approved' }] } }); await admissions.poll();
  assert.equal(dot().hidden, true, 'handling the last application clears the dot');
  await admissions.button('＋ 点歌').onclick();
  admissions.set({ admission: { pending: [{ ...application, id: 'another-application' }] } }); await admissions.poll();
  assert.equal(popup().open, false, 'automatic review does not interrupt an open song picker');
  walk(admissions.root).find(n => n.tagName === 'dialog' && n.open).children[0].children[1].onclick(); await admissions.poll();
  assert.equal(popup().open, true, 'deferred application is presented when the form closes');
  admissions.api.destroy();

  const artwork = fixture(); await settle();
  let artworkReads = 0;
  artwork.hooks.set('resource', async request => {
    if (request.kind === 'cover' && ++artworkReads === 1) throw new Error('transient cover failure');
    const bytes = request.kind === 'cover' ? Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') : Buffer.from('{"lines":[]}');
    return { total: bytes.length, offset: 0, revision: 'cover-version', mime: request.kind === 'cover' ? 'image/gif' : 'application/json', base64: bytes.toString('base64') };
  });
  artwork.set({ current_track: { resource_id: 'artwork-song', has_cover: true, title: '夜航' } }); await artwork.poll();
  const cover = () => walk(artwork.root).find(n => n.className === 'room-cover');
  assert.equal(artworkReads, 1); assert.equal(cover().hidden, true);
  await artwork.poll(); assert.equal(artworkReads, 1, 'cover failure does not retry on every poll');
  artwork.advance(3001); await artwork.poll();
  assert.equal(artworkReads, 2); assert.equal(cover().hidden, false, 'transient failure recovers without changing songs');
  const previousCover = cover().src;
  cover().onerror(); artwork.advance(6001); await artwork.poll();
  assert.equal(artworkReads, 3); assert.notEqual(cover().src, previousCover, 'image decode failure revokes and refetches artwork');
  cover().onerror(); artwork.advance(9001); await artwork.poll();
  assert.equal(artworkReads, 3, 'retries stay bounded even for a permanently broken image');
  artwork.api.destroy();

  const song = fixture(); await settle();
  song.hooks.set('queue_page', async () => ({ revision: '2', queue: [{ instance_id: 'song-instance', resource_id: 'shared-song' }], tracks: [{ resource_id: 'shared-song', title: 'Shared song' }] }));
  song.set({ revision: '2', current_track: { resource_id: 'shared-song', title: '<script>song</script>' + '长标题'.repeat(100), artist: 'Artist' } }); await song.poll();
  song.hooks.set('chat_song', async () => { throw Object.assign(new Error('timeout'), { code: 'timeout', status: 504 }); });
  assert.equal(walk(song.root).some(n => n.tagName === 'button' && n.textContent === '分享歌曲到聊天'), false, 'now-playing shortcuts leave room for lyrics');
  await song.button('分享歌曲').onclick();
  const songRequest = song.calls.find(c => c.action === 'chat_song');
  assert.equal(songRequest.resource_id, 'shared-song', 'song share sends a typed authorized resource reference');
  assert.equal(song.calls.filter(c => c.action === 'chat_send').length, 0, 'song share does not encode executable markup or a fake text card');
  await song.button('分享歌曲').onclick();
  assert.equal(song.calls.filter(c => c.action === 'chat_song').length, 1, 'unknown song share cannot be sent again');
  song.hooks.set('chat_operation', async () => ({ status: 'applied' }));
  await song.button('查询这条消息的发送结果').onclick();
  assert.equal(song.calls.find(c => c.action === 'chat_operation').operation_id, songRequest.operation_id);
  song.api.destroy();

  const withdrawn = fixture(); await settle();
  Object.assign(withdrawn.history[300], { content_kind: 'song', song: { resource_id: 'withdrawn-resource', title: 'Withdrawn private title' }, sharing_revision: '1' });
  await withdrawn.button('更早消息').onclick(); await settle();
  assert.match(withdrawn.chat().textContent, /Withdrawn private title/, 'older history contains the shared card before withdrawal');
  const staleHistory = deferred(); withdrawn.hooks.set('chat_history', () => staleHistory.promise);
  withdrawn.set({ sharing_revision: '2' }); await withdrawn.poll();
  assert.doesNotMatch(withdrawn.chat().textContent, /Withdrawn private title/, 'withdrawal removes older rendered card metadata before a fresh history response');
  staleHistory.resolve({ messages: [withdrawn.history[300]], history_revision: '1', has_more: false }); await settle();
  assert.doesNotMatch(withdrawn.chat().textContent, /Withdrawn private title/, 'a delayed history projection cannot resurrect withdrawn metadata');
  withdrawn.api.destroy();

  const reconnectChat = fixture(); await settle();
  reconnectChat.hooks.set('chat_send', async () => { throw Object.assign(new Error('timeout'), { code: 'timeout', status: 504 }); });
  reconnectChat.field('说点什么（最多 200 字）').value = 'One uncertain message';
  reconnectChat.form().onsubmit({ preventDefault() {} }); await settle();
  const chatRequest = reconnectChat.calls.find(c => c.action === 'chat_send');
  reconnectChat.set({ session_id: 'replacement-session' }); await reconnectChat.poll();
  assert.equal(reconnectChat.field('说点什么（最多 200 字）').disabled, true, 'reconnect keeps an uncertain composer closed');
  reconnectChat.hooks.set('chat_operation', async () => ({ status: 'applied' }));
  await reconnectChat.button('查询这条消息的发送结果').onclick();
  assert.equal(reconnectChat.calls.find(c => c.action === 'chat_operation').operation_id, chatRequest.operation_id);
  assert.equal(reconnectChat.calls.filter(c => c.action === 'chat_send').length, 1);
  reconnectChat.api.destroy();
  const reconnect = fixture(); await settle();
  reconnect.set({ mode: 'guest', member_id: 'member' }); await reconnect.poll();
  reconnect.hooks.set('playback', async () => { throw Object.assign(new Error('connection closed'), { code: 'room_outcome_unknown', status: 504 }); });
  await reconnect.api.playback('next');
  const original = reconnect.calls.find(c => c.action === 'playback');
  await reconnect.api.playback('next');
  assert.equal(reconnect.calls.filter(c => c.action === 'playback').length, 1, 'uncertain playback cannot be replaced by another relative operation');
  reconnect.set({ mode: 'reconnecting' }); await reconnect.poll();
  reconnect.set({ mode: 'guest', session_id: 's2' }); await reconnect.poll();
  reconnect.hooks.set('operation', async () => ({ state: { status: 'applied' } }));
  await reconnect.button('查询操作结果').onclick();
  assert.equal(reconnect.calls.find(c => c.action === 'operation').operation_id, original.operation_id);
  assert.equal(reconnect.calls.filter(c => c.action === 'playback').length, 1, 'reconnect never repeats next');
  assert.equal(walk(reconnect.root).some(n => n.textContent === '查询操作结果'), false, 'terminal receipt clears the query');
  reconnect.api.destroy();

  for (const outcome of ['unknown', 'scheduled', 'applied']) {
    const late = fixture(), pending = deferred(); await settle();
    late.set({ mode: 'guest', member_id: 'member' }); await late.poll();
    late.hooks.set('playback', () => pending.promise);
    const sending = late.api.playback('next'); await settle();
    const sent = late.calls.find(c => c.action === 'playback');
    late.set({ session_id: 's2' }); await late.poll();
    assert.ok(late.button('查询操作结果'), 'receipt exists while the old request is still pending');
    if (outcome === 'unknown') pending.reject(Object.assign(new Error('connection closed'), { code: 'room_outcome_unknown', status: 504 }));
    else pending.resolve({ state: { status: outcome } });
    await sending;
    if (outcome !== 'applied') {
      late.hooks.set('operation', async () => ({ state: { status: 'scheduled' } }));
      await late.button('查询操作结果').onclick();
      assert.equal(late.calls.find(c => c.action === 'operation').operation_id, sent.operation_id);
    }
    assert.equal(late.calls.filter(c => c.action === 'playback').length, 1);
    late.api.destroy();
  }
  for (const patch of [{ member_id: 'other-member' }, { room_id: 'other-room' }, { instance_id: 'other-host-instance' }]) {
    const changed = fixture(), pending = deferred(); await settle();
    changed.hooks.set('playback', () => pending.promise);
    const sending = changed.api.playback('next'); await settle();
    changed.set(patch); await changed.poll();
    pending.reject(Object.assign(new Error('connection closed'), { code: 'room_outcome_unknown', status: 504 }));
    await sending;
    assert.equal(walk(changed.root).some(n => n.tagName === 'button' && n.textContent === '查询操作结果'), false, 'different membership rejects even a late unknown outcome');
    assert.equal(changed.calls.filter(c => c.action === 'playback').length, 1);
    changed.api.destroy();
  }

  const queue = fixture(); await settle();
  const duplicate = [{ instance_id: '1', resource_id: 'A' }, { instance_id: '2', resource_id: 'A' }, { instance_id: '3', resource_id: 'B' }];
  queue.hooks.set('queue_page', async () => ({ revision: '1', queue: duplicate, tracks: [] }));
  queue.hooks.set('library', async () => ({ revision: '1', tracks: [{ resource_id: 'A', title: 'A' }] }));
  queue.set({ queue_count: 3, track_instance_id: '2', permissions: { queue: true, transport: true } }); await queue.poll();
  await queue.button('移除').onclick();
  assert.deepEqual(queue.calls.find(c => c.action === 'queue').items, duplicate.slice(1), 'deletion retains the playing second occurrence by ID');
  const up = walk(queue.root).filter(n => n.tagName === 'button' && n.textContent === '上移');
  await up[1].onclick();
  assert.deepEqual(queue.calls.filter(c => c.action === 'queue').at(-1).items, [duplicate[1], duplicate[0], duplicate[2]], 'reorder sends both duplicate identities');
  await queue.button('加入队列', 'room-list').onclick();
  assert.deepEqual(queue.calls.filter(c => c.action === 'queue').at(-1).items, duplicate.concat({ instance_id: null, resource_id: 'A' }), 'append asks Host to assign a new instance');
  assert.ok(queue.calls.filter(c => c.action === 'queue').every(c => !('resources' in c)));
  queue.api.destroy();
  const f = fixture(); await settle();
  assert.equal(f.chat().children.length, 100, 'history and recent snapshot overlap renders once');
  await f.button('更早消息').onclick(); await settle();
  await f.button('更早消息').onclick(); await settle();
  assert.match(f.chat().children[0].children[1].textContent, /Message 151$/);
  assert.equal(f.chat().children.length, 200, 'history window stays bounded');
  const oldest = f.chat().children[0].textContent;
  await f.poll();
  assert.equal(f.chat().children[0].textContent, oldest, 'poll preserves the historical window');
  await f.button('更早消息').onclick(); await settle();
  assert.match(f.chat().children[0].children[1].textContent, /Message 51$/, 'independent server cursor advances beyond 200');
  await f.button('回到最新消息').onclick(); await settle();
  assert.match(f.chat().children.at(-1).children[1].textContent, /Message 450$/);

  f.hooks.set('library', async () => ({ revision: '2', tracks: [{ resource_id: 'shared', title: 'Shared song' }] }));
  f.hooks.set('queue_page', async () => ({ revision: '2', queue: [{ instance_id: '1', resource_id: 'shared' }], tracks: [] }));
  const permissions = { transport: false, queue: false, chat_read: true, chat_send: true };
  f.set({ revision: '2', sharing_revision: '2', permissions }); await f.poll();
  assert.equal(walk(f.root).some(n => n.tagName === 'button' && n.textContent === '加入队列' && !n.disabled), false);
  f.set({ permissions: { ...permissions, queue: true, transport: true } }); await f.poll();
  assert.ok(f.button('加入队列')); assert.ok(f.button('上移')); assert.ok(f.button('移除'));
  f.set({ permissions }); await f.poll();
  assert.equal(walk(f.root).some(n => n.tagName === 'button' && n.textContent === '加入队列' && !n.disabled), false, 'revocation rebuilds already displayed library actions');
  assert.equal(walk(f.root).some(n => n.tagName === 'button' && n.textContent === '移除'), false, 'revocation rebuilds already displayed queue actions');
  f.set({ permissions: { ...permissions, transport: true } }); await f.poll();
  f.set({ recent_chat: undefined, chat: { history_revision: '1' } }); await f.poll();
  await f.button('更早消息').onclick(); await settle();
  const requests = f.calls.filter(c => c.action === 'chat_history').length;
  f.set({ chat: { history_revision: '2' } }); await f.poll();
  assert.ok(f.calls.filter(c => c.action === 'chat_history').length > requests, 'host history invalidates from chat status without a recent projection');
  assert.match(f.chat().children.at(-1).children[1].textContent, /Message 450$/);

  f.hooks.set('chat_send', async () => { throw Object.assign(new Error('request timed out'), { code: 'timeout', status: 504 }); });
  const input = f.field('说点什么（最多 200 字）'); input.value = 'Keep this message';
  f.form().onsubmit({ preventDefault() {} }); await settle();
  assert.equal(input.disabled, true); assert.equal(input.value, 'Keep this message');
  f.form().onsubmit({ preventDefault() {} }); await settle();
  assert.equal(f.calls.filter(c => c.action === 'chat_send').length, 1, 'unknown send cannot get a second operation ID');
  f.hooks.set('chat_operation', async () => { throw Object.assign(new Error('expired'), { code: 'operation_unknown', status: 400 }); });
  await f.button('查询这条消息的发送结果').onclick();
  assert.equal(input.disabled, true, 'missing receipt never proves that sending failed');
  await f.button('放弃这次待确认消息').onclick();
  assert.equal(input.value, ''); assert.equal(input.disabled, false);

  f.hooks.set('playback', async () => { throw Object.assign(new Error('request timed out'), { code: 'timeout', status: 504 }); });
  f.hooks.set('operation', async () => ({ state: { status: 'applied' } }));
  await f.api.playback('next');
  const sent = f.calls.find(c => c.action === 'playback');
  await f.button('查询操作结果').onclick();
  assert.equal(f.calls.find(c => c.action === 'operation').operation_id, sent.operation_id, 'query uses the original playback ID');

  const invitation = deferred(); f.hooks.set('invite', () => invitation.promise);
  const pendingInvite = f.button('生成并复制邀请').onclick(); await settle();
  f.set({ session_id: 's2' }); await f.poll();
  invitation.resolve({ invitation: 'OLD-SESSION-SECRET' }); await pendingInvite;
  assert.equal(f.field('一次性邀请').value, '', 'late invitation cannot write into a new session');

  const send = deferred(); f.hooks.set('chat_send', () => send.promise);
  f.field('说点什么（最多 200 字）').value = 'Old session';
  f.form().onsubmit({ preventDefault() {} }); await settle();
  assert.equal(f.field('说点什么（最多 200 字）').disabled, true, 'pending send preserves the submitted text and blocks another draft');
  await f.poll();
  assert.equal(f.field('说点什么（最多 200 字）').disabled, true, 'poll cannot reopen a pending composer');
  f.set({ session_id: 's3' }); await f.poll();
  f.field('说点什么（最多 200 字）').value = 'New session draft';
  send.resolve({ status: 'applied' }); await settle();
  assert.equal(f.field('说点什么（最多 200 字）').value, 'New session draft', 'late chat acknowledgement cannot clear a new draft');
  const config = { enabled: true, retained: false, max_messages: 1000, retention_days: 1, disk_quota_mib: 16 };
  f.set({ session_id: 's4', chat: { config, history_revision: '2' } }); await f.poll();
  assert.equal(f.field('保存聊天历史').checked, false);
  assert.equal(f.field('最多消息条数（100–50000）').value, 1000);
  assert.equal(f.field('保留天数（1–30）').value, 1);
  assert.equal(f.field('磁盘上限 MiB（16–256）').value, 16);
  assert.match(f.root.textContent, /仅实时聊天，消息不保存，重启后不可恢复/);
  f.set({ chat: { config: { ...config, enabled: false }, history_revision: '2' } }); await f.poll();
  assert.equal(f.field('说点什么（最多 200 字）').disabled, true);
  f.api.destroy();
  const body = new Node('body'), seeks = [];
  const transportContext = { document: { body, createElement: tag => new Node(tag), addEventListener() {}, removeEventListener() {} } };
  transportContext.window = transportContext;
  vm.createContext(transportContext);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../plugin/ui/room-workspace.js'), 'utf8'), transportContext);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../plugin/ui/room-transport.js'), 'utf8'), transportContext);
  const playbackActions = []; let opened = 0;
  const bar = transportContext.HertzRoomTransport.create({ seek: (...args) => seeks.push(args), open: () => opened++, playback: action => playbackActions.push(action) });
  const trackSnapshot = (id, duration) => ({ mode: 'host', track_instance_id: id, current_track: { duration_ms: duration }, permissions: { transport: true } });
  bar.render(trackSnapshot('A', 100000));
  bar.setWorkspaceVisible(true);
  assert.equal(body.children[0].hidden, true);
  bar.render(trackSnapshot('A', 100000));
  assert.equal(body.children[0].hidden, true, 'polling does not reveal duplicate controls inside workspace');
  bar.setWorkspaceVisible(false);
  assert.equal(body.children[0].hidden, false);
  const seek = walk(body).find(n => n.tagName === 'input' && n.max === 1000);
  seek.value = 500; seek.oninput();
  bar.render(trackSnapshot('B', 200000)); seek.onchange();
  assert.equal(seeks.length, 0, 'a track change cancels an old seek gesture');
  seek.value = 500; seek.oninput(); seek.onchange();
  assert.deepEqual(seeks, [['B', 100000]], 'same-track seek uses the gesture duration');
  const collapse = walk(body).find(n => n.getAttribute('aria-controls') === 'room-global-player');
  assert.equal(collapse.getAttribute('aria-expanded'), 'true');
  collapse.onclick();
  assert.equal(collapse.getAttribute('aria-expanded'), 'false', 'collapse changes presentation');
  assert.equal(seeks.length, 1, 'collapse never seeks or stops playback');
  assert.deepEqual(playbackActions, [], 'collapse sends no playback operations');
  bar.render(trackSnapshot('B', 200000));
  assert.equal(collapse.getAttribute('aria-expanded'), 'false', 'polling retains collapsed state');
  bar.setWorkspaceVisible(true); bar.render(trackSnapshot('B', 200000));
  assert.equal(body.children[0].hidden, true, 'collapsed player stays hidden in the room');
  bar.setWorkspaceVisible(false);
  assert.equal(body.children[0].hidden, false);
  assert.equal(collapse.getAttribute('aria-expanded'), 'false', 'returning to the app preserves collapse');
  const returnButton = walk(body).find(n => n.className === 'room-global-return');
  returnButton.onclick();
  assert.equal(opened, 1, 'explicit room shortcut delegates to room navigation');
  const toggle = walk(body).find(n => n.getAttribute('aria-label') === '播放');
  toggle.onclick();
  assert.deepEqual(playbackActions, ['toggle'], 'mini player reuses room playback');
  bar.render({ ...trackSnapshot('B', 200000), mode: 'reconnecting' });
  assert.equal(toggle.disabled, true, 'reconnect disables mini player transport');
  bar.setPlaybackUncertain(true); bar.render(trackSnapshot('B', 200000));
  assert.equal(toggle.disabled, true, 'uncertain receipt also gates mini player');
  returnButton.onclick(); assert.equal(opened, 2, 'navigation remains available when playback is uncertain');
  bar.render({ mode: 'local' });
  assert.equal(body.children[0].hidden, true, 'leaving the room removes the mini player');
  bar.render(trackSnapshot('C', 300000));
  assert.equal(collapse.getAttribute('aria-expanded'), 'true', 'a new room starts expanded');
  console.log('Room UI: selected-track creation/no replay, application dialogs/dots/deferred review, bounded artwork recovery, background projection recovery, inline admission verification/retries, queue instance identity, reconnect receipts, history and session isolation passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
