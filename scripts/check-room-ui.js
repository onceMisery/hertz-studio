#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Exercise the real room controller with reordered transport completions.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../plugin/ui/room.js'), 'utf8');
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.value = ''; this.dataset = {}; this._text = ''; this.style = { setProperty() {} }; this.classList = { toggle() {}, add() {}, remove() {} }; }
  set textContent(text) { this._text = String(text); this.children = []; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  setAttribute() {}
  addEventListener() {}
}
const walk = node => [node, ...node.children.flatMap(walk)];
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function fixture() {
  const root = new Node('main'), calls = [], hooks = new Map();
  let snapshot = { mode: 'host', room_id: 'room', instance_id: 'instance', session_id: 's1', member_id: 'owner', revision: '1', sharing_revision: '1', next_operation_id: '1', next_chat_operation_id: '1', permissions: { transport: true, chat_read: true, chat_send: true }, output: {}, queue: [], members: [] };
  const history = Array.from({ length: 450 }, (_, i) => ({ message_id: String(i + 1), name: 'Guest', text: 'Message ' + (i + 1), received_at_ms: '0' }));
  snapshot.recent_chat = { history_revision: '1', messages: history.slice(-16) };
  const transport = {
    async get(url) { return url === '/v1/room' ? structuredClone(snapshot) : { tracks: [] }; },
    async post(url, body) {
      const request = body.action === 'peer' ? body.request : body;
      calls.push(structuredClone(request));
      if (hooks.has(request.action)) return hooks.get(request.action)(request);
      switch (request.action) {
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
  const context = { document: { createElement: tag => new Node(tag), hidden: false }, TextEncoder, URL, Blob, Option: function (text, value) { const n = new Node('option'); n.textContent = text; n.value = value; return n; }, navigator: {}, setInterval: () => 1, clearInterval() {}, setTimeout() {}, matchMedia: () => ({ matches: true }) };
  context.window = context;
  context.HertzRoomTransport = { create: () => ({ render() {}, notice() {}, destroy() {} }) };
  vm.createContext(context); vm.runInContext(source, context);
  context.HertzRoom.init({ root, transport, confirm: async () => true });
  const nodes = () => walk(root);
  return {
    api: context.HertzRoom, calls, hooks, root,
    button: text => { const n = nodes().find(n => n.tagName === 'button' && n.textContent === text); assert.ok(n, text); return n; },
    field: label => { const n = nodes().find(n => n.tagName === 'label' && n._text === label); assert.ok(n, label); return n.children[0]; },
    chat: () => nodes().find(n => n.tagName === 'ol' && n.className === 'room-chat'),
    form: () => nodes().find(n => n.tagName === 'form'),
    set: patch => { snapshot = { ...snapshot, ...patch }; },
    async poll() { await context.HertzRoom.onViewEnter(); await settle(); }
  };
}
async function main() {
  const reconnect = fixture(); await settle();
  reconnect.set({ mode: 'guest', member_id: 'member' }); await reconnect.poll();
  reconnect.hooks.set('playback', async () => { throw Object.assign(new Error('connection closed'), { code: 'room_outcome_unknown', status: 504 }); });
  await reconnect.api.playback('next');
  const original = reconnect.calls.find(c => c.action === 'playback');
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
  await queue.button('加入队列').onclick();
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
  assert.equal(walk(f.root).some(n => n.tagName === 'button' && n.textContent === '加入队列'), false);
  f.set({ permissions: { ...permissions, queue: true, transport: true } }); await f.poll();
  assert.ok(f.button('加入队列')); assert.ok(f.button('上移')); assert.ok(f.button('移除'));
  f.set({ permissions }); await f.poll();
  assert.equal(walk(f.root).some(n => n.tagName === 'button' && n.textContent === '加入队列'), false, 'revocation rebuilds already displayed library actions');
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
  const pendingInvite = f.button('生成邀请').onclick(); await settle();
  f.set({ session_id: 's2' }); await f.poll();
  invitation.resolve({ invitation: 'OLD-SESSION-SECRET' }); await pendingInvite;
  assert.equal(f.field('一次性邀请（五分钟有效）').value, '', 'late invitation cannot write into a new session');

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
  const transportContext = { document: { body, createElement: tag => new Node(tag) } };
  transportContext.window = transportContext;
  vm.createContext(transportContext);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../plugin/ui/room-transport.js'), 'utf8'), transportContext);
  const bar = transportContext.HertzRoomTransport.create({ seek: (...args) => seeks.push(args) });
  const trackSnapshot = (id, duration) => ({ mode: 'host', track_instance_id: id, current_track: { duration_ms: duration }, permissions: { transport: true } });
  bar.render(trackSnapshot('A', 100000));
  const seek = walk(body).find(n => n.tagName === 'input' && n.max === 1000);
  seek.value = 500; seek.oninput();
  bar.render(trackSnapshot('B', 200000)); seek.onchange();
  assert.equal(seeks.length, 0, 'a track change cancels an old seek gesture');
  seek.value = 500; seek.oninput(); seek.onchange();
  assert.deepEqual(seeks, [['B', 100000]], 'same-track seek uses the gesture duration');
  console.log('Room UI: queue instance identity, reconnect receipts, history and session isolation passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
