// SPDX-License-Identifier: MIT
// Local control surface only. TLS credentials and PCM stay in native services.
(function (global) {
  'use strict';
  let root, transport, confirmAction, timer, snap = { mode: 'local' }, busy = false;
  let mounted = '', sequence = 1n, chatSequence = 1n, revision = '', polling = false;
  let libraryPage = 0, queuePage = 0, lastChatId = '', historyRevision = '', messages = [];
  const selection = new Set(), metadata = new Map(), refs = {}, pageSize = 32;
  let queueSignature = "", memberSignature = "", resourceKey = "", coverUrl = "", lyrics = [], resourceGeneration = 0, chatUnknown = null;
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  function button(text, fn, cls) { const e = h('button', 'btn ' + (cls || ''), text); e.type = 'button'; e.onclick = () => run(fn); return e; }
  function field(parent, label, type, value) { const l = h('label', 'room-field', label), e = h(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') e.type = type; e.value = value == null ? '' : value; l.append(e); parent.append(l); return e; }
  function select(parent, label, choices) { const l = h('label', 'room-field', label), e = h('select'); choices.forEach(([value, text]) => { const o = h('option', '', text); o.value = value; e.append(o); }); l.append(e); parent.append(l); return e; }
  function status(text, error) { if (!refs.notice) return; refs.notice.textContent = text || ''; refs.notice.classList.toggle('room-error', !!error); refs.notice.hidden = !text; }
  function counter(v) { return typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) ? BigInt(v) : 1n; }
  function op(chat) { if (chat) { chatSequence = chatSequence > counter(snap.next_chat_operation_id) ? chatSequence : counter(snap.next_chat_operation_id); return String(chatSequence++); } sequence = sequence > counter(snap.next_operation_id) ? sequence : counter(snap.next_operation_id); return String(sequence++); }
  function sessionKey() { return mounted + ':' + (snap.room_id || '') + ':' + (snap.instance_id || ''); }
  async function command(body) { return transport.post('/v1/room', body, { retry: false }); }
  async function peer(request) { return command({ action: 'peer', request }); }
  async function control(action, extra) { return peer({ action, operation_id: op(false), expected_revision: snap.revision, ...extra }); }
  async function playback(action, extra) {
    const id = op(false);
    let result;
    try { result = await peer({ action: 'playback', operation_id: id, expected_revision: snap.revision, command: { action, ...extra } }); }
    catch (e) { if (/timeout|unknown/.test(e.code || '')) status('操作结果尚未确认，可查询原操作。', true); throw e; }
    if (result && result.state && /preparing|scheduled/.test(result.state.status)) {
      refs.operations.replaceChildren(h('span', '', '正在安排播放边界'), button('查询操作结果', async () => { const v = await peer({ action: 'operation', operation_id: id }); status(operationText(v)); }));
    }
    status(operationText(result));
  }
  function operationText(v) { const labels = { preparing: '正在准备音频', scheduled: '已安排，等待生效', applied: '已生效', superseded: '已被后续操作取代', no_op: '当前已是此状态', failed: '操作未生效' }; const key = v && v.state && (v.state.status || v.state); return labels[key] || '操作已受理'; }
  async function run(fn) {
    if (busy) return;
    busy = true; root.setAttribute('aria-busy', 'true'); status('正在处理…');
    try { await fn(); await poll(true); }
    catch (e) { status(e.message || '操作失败，请检查连接后重试。', true); }
    finally { busy = false; root.setAttribute('aria-busy', 'false'); }
  }
  function section(parent, title, cls) { const e = h('section', 'room-section ' + (cls || '')); e.append(h('h3', '', title)); parent.append(e); return e; }
  function mount() {
    const key = snap.mode === 'local' ? 'local' : 'active';
    if (mounted === key) return;
    mounted = key; memberSignature = ''; queueSignature = ''; resourceGeneration++; resourceKey = ''; lyrics = []; if (coverUrl) URL.revokeObjectURL(coverUrl); coverUrl = ''; root.replaceChildren(); Object.keys(refs).forEach(k => delete refs[k]);
    const header = h('header', 'room-header'); header.append(h('div', 'room-kicker', 'HERTZ / LOCAL NETWORK'));
    refs.title = h('h2', '', '一起听'); header.append(refs.title, h('p', 'room-sub', '把本地音乐分享给同一网络里的电脑。')); root.append(header);
    refs.notice = h('p', 'room-notice'); refs.notice.setAttribute('role', 'status'); refs.notice.setAttribute('aria-live', 'polite'); refs.notice.hidden = true; root.append(refs.notice);
    if (key === 'local') mountEntry(); else mountActive();
  }
  function mountEntry() {
    const grid = h('div', 'room-entry'); root.append(grid);
    const create = section(grid, '创建房间'); create.append(h('p', 'room-sub', '选择网卡，只分享你明确选中的本地歌曲。'));
    const name = field(create, '房间名称', 'text', '我的音乐房间'); name.maxLength = 64;
    const address = select(create, '局域网网卡', [['', '先发现可用网卡']]);
    const port = field(create, '端口（0 为自动选择）', 'number', '0'); port.min = 0; port.max = 65535;
    const rate = select(create, '房间采样率', [['44100', '44.1 kHz'], ['48000', '48 kHz'], ['96000', '96 kHz'], ['192000', '192 kHz']]); rate.value = '48000';
    const output = field(create, '本机同时收听', 'checkbox'); output.checked = true;
    create.append(button('创建房间', async () => { if (!address.value) throw new Error('请先选择网卡'); await command({ action: 'create', name: name.value.trim(), address: address.value + ':' + Number(port.value), sample_rate: Number(rate.value), local_output: output.checked }); }, 'primary'));
    const join = section(grid, '加入房间'); join.append(h('p', 'room-sub', '从房主获取一次性邀请。邀请内含用于核对主机的证书指纹。'));
    const nickname = field(join, '显示名称', 'text', '收听电脑'); nickname.maxLength = 32;
    const invitation = field(join, '一次性邀请', 'textarea'); invitation.maxLength = 2048; invitation.autocomplete = 'off'; invitation.spellcheck = false;
    const listen = field(join, '在本机播放音频', 'checkbox'); listen.checked = true;
    const pin = h('p', 'room-mono room-pin'); join.append(pin);
    invitation.oninput = () => { try { const data = JSON.parse(atob(invitation.value.trim().replace(/^hertz-listen:v1:/, '').replace(/-/g, '+').replace(/_/g, '/'))); pin.textContent = '主机：' + data.address + '\n指纹：' + data.fingerprint; } catch (_) { pin.textContent = ''; } };
    join.append(button('加入房间', async () => { const code = invitation.value.trim(); if (!pin.textContent) throw new Error('请粘贴有效的房主邀请'); if (!await confirmAction(pin.textContent + '\n请与房主核对后加入。')) return; invitation.value = ''; pin.textContent = ''; await command({ action: 'join', invitation: code, name: nickname.value.trim(), listen: listen.checked }); }, 'primary'));
    const saved = h('p', 'room-sub', '正在读取上次加入的房间…');
    join.append(saved, button('重新加入上次房间', async () => { await command({ action: 'resume' }); }));
    command({ action: 'saved_room' }).then(data => {
      const room = data.saved_room;
      saved.textContent = room ? '上次以「' + room.name + '」加入 ' + room.address + '。点击重新加入后才会连接。' : '没有保存的房间。首次加入需要房主邀请。';
    }).catch(e => { saved.textContent = e.message || '无法读取保存的房间，请稍后重新加入。'; saved.classList.add('room-error'); });
    const discovery = section(root, '附近房间'); refs.nearby = h('div', 'room-list'); discovery.append(h('p', 'room-sub', '发现结果用于找到房主，加入仍需房主邀请。'), button('发现房间与网卡', async () => {
      const data = await command({ action: 'discover' }); address.replaceChildren();
      (data.interfaces || []).forEach(i => { const ip = i.address.includes(':') ? '[' + i.address + (i.address.startsWith('fe80:') && i.index ? '%' + i.index : '') + ']' : i.address; const o = h('option', '', i.name + ' · ' + i.address + (i.loopback ? '（本机）' : '')); o.value = ip; address.append(o); });
      refs.nearby.replaceChildren(); (data.rooms || []).forEach(r => refs.nearby.append(h('p', '', r.name + ' · ' + (r.addresses || []).join(', ')))); if (!(data.rooms || []).length) refs.nearby.append(h('p', 'room-sub', '暂未发现房间。可直接粘贴房主邀请。'));
    }), refs.nearby);
  }
  function mountActive() {
    const bar = h('div', 'room-toolbar'); refs.connection = h('span', 'room-chip'); refs.format = h('span', 'room-chip');
    bar.append(refs.connection, refs.format, button('离开房间', async () => { if (await confirmAction(snap.mode === 'host' ? '结束房间？所有成员将停止收听。' : '离开当前房间？')) { await command({ action: 'leave' }); messages = []; selection.clear(); } }, 'room-leave')); root.append(bar);
    const layout = h('div', 'room-layout'), main = h('div', 'room-main'), aside = h('aside', 'room-aside'); layout.append(main, aside); root.append(layout);
    const now = section(main, '正在聆听'); refs.current = h('strong', 'room-current'); refs.artist = h('p', 'room-sub'); refs.position = h('span', 'room-mono'); refs.cover = h('img', 'room-cover'); refs.cover.alt = ''; refs.cover.hidden = true; refs.cover.onerror = () => { refs.cover.hidden = true; }; now.append(refs.cover, refs.current, refs.artist, refs.position); refs.lyrics = h('div', 'room-lyrics'); refs.lyrics.setAttribute('aria-label', '同步歌词'); now.append(refs.lyrics);
    const controls = h('div', 'room-toolbar'); refs.play = button('播放', () => playback(snap.playing ? 'pause' : 'play'), 'primary'); refs.prev = button('上一首', () => playback('previous')); refs.next = button('下一首', () => playback('next')); refs.stop = button('停止', () => playback('stop')); controls.append(refs.prev, refs.play, refs.next, refs.stop); now.append(controls);
    const seekLine = h('div', 'room-toolbar'); refs.seek = field(seekLine, '跳转位置（秒）', 'number', 0); refs.seek.min = 0; refs.seekButton = button('跳转', () => playback('seek', { instance_id: snap.track_instance_id, position_ms: String(Math.max(0, Math.trunc(Number(refs.seek.value) * 1000))) })); seekLine.append(refs.seekButton); now.append(seekLine);
    refs.operations = h('div', 'room-operations'); now.append(refs.operations);
    const queue = section(main, '房间队列'); refs.queue = h('ol', 'room-queue'); queue.append(refs.queue); const queueNav = h('div', 'room-toolbar'); queueNav.append(button('上一页', async () => { queuePage = Math.max(0, queuePage - pageSize); await loadQueue(); }), button('下一页', async () => { if (queuePage + pageSize < (snap.queue_count || 0)) queuePage += pageSize; await loadQueue(); })); queue.append(queueNav);
    const library = section(main, '共享曲库'); refs.library = h('div', 'room-list'); library.append(refs.library); const libraryNav = h('div', 'room-toolbar'); libraryNav.append(button('上一页', async () => { libraryPage = Math.max(0, libraryPage - pageSize); await loadLibrary(); }), button('下一页', async () => { if (libraryPage + pageSize < (snap.shared_count || 0)) libraryPage += pageSize; await loadLibrary(); })); library.append(libraryNav);
    refs.sharing = section(main, '分享本地歌曲'); const search = field(refs.sharing, '搜索本地曲库', 'search'); refs.localTracks = h('div', 'room-local-tracks'); refs.sharing.append(button('搜索', async () => loadLocal(search.value)), refs.localTracks, button('更新分享范围', async () => { await command({ action: 'share', track_ids: [...selection] }); await loadLibrary(); }));
    refs.invites = section(aside, '邀请与成员'); const invitePerms = h('div', 'room-permissions'), permissions = {};
    [['listen', '收听'], ['queue', '编辑队列'], ['transport', '播控'], ['volume', '房间音量'], ['chat_read', '查看聊天'], ['chat_send', '发言']].forEach(([key, label]) => { const input = field(invitePerms, label, 'checkbox'); input.checked = ['listen', 'chat_read', 'chat_send'].includes(key); permissions[key] = input; });
    refs.invitation = field(refs.invites, '一次性邀请（五分钟有效）', 'textarea'); refs.invitation.readOnly = true; refs.invitation.autocomplete = 'off';
    refs.invites.append(invitePerms, button('生成邀请', async () => { const p = {}; Object.keys(permissions).forEach(k => p[k] = permissions[k].checked); const result = await command({ action: 'invite', permissions: p }); refs.invitation.value = result.invitation; }), button('复制邀请', async () => { if (refs.invitation.value) await global.HertzClipboard.write(refs.invitation.value); }));
    refs.members = h('div', 'room-members'); aside.append(refs.members);
    mountOutput(aside); mountChat(aside); mountDsp(main); mountChatAdmin(main);
    revision = ''; historyRevision = ''; messages = []; lastChatId = ''; libraryPage = 0; queuePage = 0;
  }
  function mountOutput(parent) {
    const output = section(parent, '本机输出'); refs.outputStatus = h('p', 'room-sub'); refs.metrics = h('dl', 'room-metrics'); output.append(refs.outputStatus, refs.metrics);
    refs.device = select(output, '输出设备', [['', '系统默认设备']]); output.append(button('刷新设备', async () => { const result = await command({ action: 'devices' }); const devices = Array.isArray(result) ? result : result.devices || []; const selected = refs.device.value; refs.device.replaceChildren(new Option('系统默认设备', '')); devices.forEach(d => refs.device.append(new Option(d.name || d.id, d.id))); refs.device.value = selected; }));
    refs.localVolume = field(output, '本机音量（0–100）', 'number', 100); refs.localVolume.min = 0; refs.localVolume.max = 100;
    refs.correction = field(output, '额外延迟补偿（毫秒）', 'number', 0); refs.correction.min = -500; refs.correction.max = 500;
    refs.device.onchange = () => { refs.correction.value = 0; status('设备已改变，延迟补偿已重置。应用输出后再为当前设备校准。'); };
    refs.outputEnabled = field(output, '启用本机音频', 'checkbox'); output.append(button('应用本机输出', () => command({ action: 'output', enabled: refs.outputEnabled.checked, settings: { device_id: refs.device.value || null, volume: Number(refs.localVolume.value) / 100, latency_correction_ms: Number(refs.correction.value), calibration_binding: snap.output && snap.output.binding || null } })));
    output.append(h('p', 'room-sub', '输出使用原生服务。驱动时间戳有效不等于已完成扬声器的物理校准。'));
  }
  function mountDsp(parent) {
    refs.dsp = section(parent, '房间音效'); const row = h('div', 'room-form-grid'); refs.dsp.append(row);
    const mode = refs.mode = select(row, '播放模式', [['repeat', '列表循环'], ['repeat_one', '单曲循环'], ['shuffle', '随机播放']]);
    refs.roomVolume = field(row, '房间音量（0–100）', 'number', 100); refs.roomVolume.min = 0; refs.roomVolume.max = 100;
    row.append(refs.volumeApply = button('应用房间音量', () => control('volume', { volume: Number(refs.roomVolume.value) / 100 })), refs.modeApply = button('应用播放模式', () => control('mode', { mode: mode.value })));
    refs.hostDsp = h('div', 'room-form-grid'); const loudness = refs.loudness = select(refs.hostDsp, '响度归一化', [['off', '关闭'], ['track', '曲目'], ['album', '专辑']]); const fade = refs.fade = field(refs.hostDsp, '交叉淡化（毫秒）', 'number', 0); fade.min = 0; fade.max = 8000;
    const preamp = refs.preamp = field(refs.hostDsp, '前置增益（dB）', 'number', 0); preamp.min = -24; preamp.max = 12;
    const eq = refs.eq = [60, 150, 400, 1000, 2400, 6000].map(f => { const input = field(refs.hostDsp, f + ' Hz（dB）', 'number', 0); input.min = -12; input.max = 12; return input; });
    refs.hostDsp.append(button('应用房间音效', () => command({ action: 'dsp', params: { eq_gains_db: eq.map(i => Number(i.value)), preamp_db: Number(preamp.value), track_gain_db: 0 }, crossfade_ms: Number(fade.value), loudness_mode: loudness.value }))); refs.dsp.append(refs.hostDsp);
  }
  function mountChat(parent) {
    const chat = section(parent, '房间聊天'); refs.chatStatus = h('p', 'room-sub'); refs.chat = h('ol', 'room-chat'); refs.chat.setAttribute('aria-label', '聊天消息'); chat.append(refs.chatStatus, refs.chat);
    refs.chatOperation = h('div', 'room-operations'); chat.append(refs.chatOperation);
    const form = h('form', 'room-chat-form'); refs.chatInput = field(form, '说点什么（最多 200 字）', 'textarea'); refs.chatInput.maxLength = 400;
    refs.chatSend = h('button', 'btn primary', '发送'); refs.chatSend.type = 'submit'; form.append(refs.chatSend); form.onsubmit = e => { e.preventDefault(); run(async () => { const text = refs.chatInput.value.trim(); if (!text) return; if ([...text].length > 200 || new TextEncoder().encode(text).length > 800) throw new Error('消息最多200字、800字节'); const id = op(true); try { await peer({ action: 'chat_send', operation_id: id, text }); chatUnknown = null; refs.chatOperation.replaceChildren(); refs.chatInput.value = ''; } catch (e) { if (/unknown|timeout|connection/.test(e.code || '')) { chatUnknown = id; refs.chatOperation.replaceChildren(button('查询这条消息的发送结果', async () => { const result = await peer({ action: 'chat_operation', operation_id: id }); if (result.status === 'applied') { refs.chatInput.value = ''; refs.chatOperation.replaceChildren(); chatUnknown = null; } })); } throw e; } await loadChat(); }); }; chat.append(form);
    const show = field(chat, '显示实时弹幕', 'checkbox'); show.checked = true; show.onchange = () => { refs.danmaku.hidden = !show.checked; }; refs.danmaku = h('div', 'room-danmaku'); refs.danmaku.setAttribute('aria-hidden', 'true'); root.append(refs.danmaku);
    chat.append(button('更早消息', async () => loadChat(true)));
  }
  function metric(label, value) { refs.metrics.append(h('dt', '', label), h('dd', 'room-mono', value == null ? '待测量' : value)); }
  function update() {
    mount(); if (mounted !== 'active') { if (snap.last_error) status(snap.last_error, true); return; }
    refs.title.textContent = snap.name || '一起听'; const host = snap.mode === 'host', p = snap.permissions || {};
    refs.connection.textContent = { host: '房主', guest: '已连接', reconnecting: '正在重连', disconnected: '连接已断开' }[snap.mode] || snap.mode;
    refs.format.textContent = snap.format ? snap.format.sample_rate / 1000 + ' kHz · ' + snap.format.channels + ' 声道 · 无损 PCM' : '等待房间格式';
    (snap.tracks || []).forEach(t => metadata.set(t.resource_id, t)); while (metadata.size > 2000) metadata.delete(metadata.keys().next().value);
    const item = (snap.queue || []).find(q => q.instance_id === snap.track_instance_id), track = snap.current_track || item && metadata.get(item.resource_id);
    refs.current.textContent = track ? track.title : snap.playing ? '正在播放共享歌曲' : '选择一首共享歌曲'; refs.artist.textContent = track && track.artist || '共享歌曲只在当前房间内可用'; refs.position.textContent = Math.floor(Number(snap.position_ms || 0) / 60000) + ':' + String(Math.floor(Number(snap.position_ms || 0) / 1000) % 60).padStart(2, '0');
    refs.play.textContent = snap.playing ? '暂停' : '播放'; [refs.play, refs.prev, refs.next, refs.stop, refs.seekButton].forEach(b => b.disabled = !p.transport || snap.mode === 'reconnecting');
    refs.sharing.hidden = !host; refs.invites.hidden = !host; refs.hostDsp.hidden = !host; refs.chatAdmin.hidden = !host; refs.volumeApply.disabled = !p.volume; refs.modeApply.disabled = !p.queue;
    refs.chatInput.disabled = !p.chat_send; refs.chatSend.disabled = !p.chat_send;
    refs.chatStatus.textContent = p.chat_read ? snap.chat_error || snap.chat && snap.chat.error || '聊天独立于音频播放。消息以纯文本显示。' : '房主未授权查看聊天。';
    const o = snap.output || {}; refs.outputStatus.textContent = !o.enabled ? '本机音频已关闭' : o.error || (o.ready ? '输出时钟已就绪' : '正在等待对时与设备时间戳');
    refs.metrics.replaceChildren(); metric('网络对时误差', o.clock ? (Number(o.clock.uncertainty_ns) / 1e6).toFixed(3) + ' ms' : null); metric('设备漂移', o.device ? Number(o.device.device_clock_ppm).toFixed(2) + ' ppm' : null); metric('输入缓冲', o.buffered_input_frames); metric('欠载帧数', o.underrun_frames); if (o.binding) { metric('实际设备', o.binding.device); metric('设备采样率', (o.binding.sample_rate / 1000) + ' kHz'); } if (o.preferences_error) status(o.preferences_error, true);
    if (revision === '') { refs.outputEnabled.checked = o.desired_enabled == null ? !!o.enabled : !!o.desired_enabled; const settings = o.settings || {}; refs.localVolume.value = Math.round((settings.volume == null ? 1 : settings.volume) * 100); if (settings.device_id) { refs.device.append(new Option(settings.device_id, settings.device_id)); refs.device.value = settings.device_id; } refs.correction.value = settings.latency_correction_ms || 0; refs.roomVolume.value = Math.round((snap.volume || 0) * 100); refs.mode.value = snap.play_mode || 'repeat'; refs.loudness.value = snap.loudness_mode || 'off'; refs.fade.value = snap.crossfade_ms || 0; refs.preamp.value = snap.dsp && snap.dsp.preamp_db || 0; refs.eq.forEach((e, i) => e.value = snap.dsp && snap.dsp.eq_gains_db[i] || 0); selection.clear(); (snap.shared_track_ids || []).forEach(id => selection.add(id)); if (host) loadLocal('').catch(() => {}); }
    const queueKey = String(snap.revision) + ':' + snap.track_instance_id; if (queueKey !== queueSignature) { queueSignature = queueKey; loadQueue().catch(e => status(e.message, true)); }
    if (revision !== snap.revision) { revision = snap.revision; loadLibrary().catch(e => status(e.message, true)); }
    const members = JSON.stringify(snap.members || []); if (members !== memberSignature) { memberSignature = members; drawMembers(); }
    updateResources(track);
    if (snap.error || snap.local_error) status(snap.local_error || snap.error, true);
    if (!p.chat_read) { messages = []; lastChatId = ''; historyRevision = ''; refs.chat.replaceChildren(); refs.danmaku.replaceChildren(); }
    if (p.chat_read) loadChat().catch(e => { refs.chatStatus.textContent = e.message || '聊天暂时不可用'; });
  }
  async function allQueue() { const result = []; for (let offset = 0; offset < Math.min(2000, snap.queue_count || 0); offset += pageSize) { const page = await peer({ action: 'queue_page', offset, limit: pageSize }); result.push(...page.queue); } return result; }
  async function appendResource(resource) { const queue = await allQueue(); await control('queue', { resources: queue.map(q => q.resource_id).concat(resource) }); }
  function drawQueue(items) {
    refs.queue.replaceChildren(); if (!items.length) refs.queue.append(h('li', 'room-empty', '队列为空。从下方共享曲库添加歌曲。'));
    items.forEach((q, i) => { const t = metadata.get(q.resource_id), row = h('li', q.instance_id === snap.track_instance_id ? 'room-track active' : 'room-track'); row.append(h('span', 'room-mono', String(queuePage + i + 1).padStart(2, '0')), h('span', '', t ? t.title : '共享歌曲')); if ((snap.permissions || {}).transport) row.append(button('播放', () => playback('pick', { instance_id: q.instance_id }))); if ((snap.permissions || {}).queue) { row.append(button('上移', async () => { const all = await allQueue(), index = all.findIndex(x => x.instance_id === q.instance_id); if (index > 0) { [all[index - 1], all[index]] = [all[index], all[index - 1]]; await control('queue', { resources: all.map(x => x.resource_id) }); } }), button('移除', async () => { const all = await allQueue(); await control('queue', { resources: all.filter(x => x.instance_id !== q.instance_id).map(x => x.resource_id) }); })); } refs.queue.append(row); });
  }
  function drawLibrary(items) { items.forEach(t => metadata.set(t.resource_id, t)); refs.library.replaceChildren(); if (!items.length) refs.library.append(h('p', 'room-empty', snap.mode === 'host' ? '先在“分享本地歌曲”中选择歌曲。' : '等待房主分享歌曲。')); items.forEach(t => { const row = h('div', 'room-track'); const label = h('div'); label.append(h('strong', '', t.title), h('small', 'room-sub', t.artist || '未知歌手')); row.append(label); if ((snap.permissions || {}).queue) row.append(button('加入队列', () => appendResource(t.resource_id))); refs.library.append(row); }); }
  async function loadQueue() { const key = sessionKey(); const v = await peer({ action: 'queue_page', offset: queuePage, limit: pageSize }); if (mounted !== 'active' || key !== sessionKey()) return; (v.tracks || []).forEach(t => metadata.set(t.resource_id, t)); drawQueue(v.queue || []); }
  async function loadLibrary() { const key = sessionKey(); const v = await peer({ action: 'library', offset: libraryPage, limit: pageSize }); if (key !== sessionKey() || mounted !== 'active') return; drawLibrary(v.tracks || []); }
  async function loadLocal(q) { const key = sessionKey(); const page = await transport.get('/v1/tracks?limit=1000&q=' + encodeURIComponent(q || '')); if (key !== sessionKey() || mounted !== 'active') return; refs.localTracks.replaceChildren(); (page.tracks || []).filter(t => t.source === 'local' && !t.id.startsWith('online:')).forEach(t => { const label = h('label', 'room-local-item'), input = h('input'); input.type = 'checkbox'; input.checked = selection.has(t.id); input.onchange = () => input.checked ? selection.add(t.id) : selection.delete(t.id); label.append(input, h('span', '', t.title)); refs.localTracks.append(label); }); }
  function drawMembers() {
    refs.members.replaceChildren(h('h3', '', '房间成员')); (snap.members || []).forEach(m => { const card = h('div', 'room-member'); card.append(h('strong', '', m.name || '成员')); if (snap.mode === 'host') { const perms = m.permissions || {}; Object.keys(perms).forEach(k => { const input = field(card, { listen: '收听', queue: '队列', transport: '播控', volume: '音量', chat_read: '读聊天', chat_send: '发言' }[k] || k, 'checkbox'); input.checked = !!perms[k]; input.onchange = () => run(() => command({ action: 'permissions', member_id: m.id, permissions: { ...perms, [k]: input.checked } })); }); card.append(button('移出房间', async () => { if (await confirmAction('移出这位成员并撤销连接凭据？')) await command({ action: 'remove', member_id: m.id }); })); } refs.members.append(card); });
  }
  let chatLoading = false;
  async function loadChat(older) {
    if (chatLoading || mounted !== 'active') return; const key = sessionKey(); chatLoading = true;
    try {
      const page = await peer({ action: 'chat_history', before: older && messages.length ? messages[0].message_id : null, revision: historyRevision || null });
      if (key !== sessionKey() || mounted !== 'active' || !(snap.permissions || {}).chat_read) return;
      const reset = !!page.cursor_invalidated || historyRevision && historyRevision !== page.history_revision; if (reset) { messages = []; lastChatId = ''; }
      historyRevision = page.history_revision; if (page.next_operation_id) chatSequence = chatSequence > counter(page.next_operation_id) ? chatSequence : counter(page.next_operation_id); const known = new Set(messages.map(m => m.message_id));
      (page.messages || []).concat(snap.recent_chat && snap.recent_chat.history_revision === page.history_revision ? snap.recent_chat.messages || [] : []).forEach(m => { if (!known.has(m.message_id)) { messages.push(m); if (!reset && !older && lastChatId && counter(m.message_id) > counter(lastChatId) && Date.now() - Number(m.received_at_ms) < 5000) animateMessage(m); } });
      messages.sort((a, b) => counter(a.message_id) < counter(b.message_id) ? -1 : 1); messages = messages.slice(-200); while (new TextEncoder().encode(JSON.stringify(messages)).length > 512 * 1024) messages.shift();
      if (messages.length) lastChatId = messages[messages.length - 1].message_id;
      refs.chat.replaceChildren(); messages.forEach(m => { const e = h('li'); e.append(h('strong', '', m.name + ' '), h('span', '', m.text)); refs.chat.append(e); });
      if (page.earlier_cleaned) refs.chatStatus.textContent = '较早消息已按保留策略清理。';
    } finally { chatLoading = false; }
  }
  function mountChatAdmin(parent) {
    const panel = refs.chatAdmin = section(parent, '聊天保留与清理');
    const grid = h('div', 'room-form-grid'); panel.append(grid);
    const enabled = field(grid, '启用房间聊天', 'checkbox'), retained = field(grid, '保存聊天历史', 'checkbox'); enabled.checked = retained.checked = true;
    const count = field(grid, '最多消息条数（100–50000）', 'number', 10000), days = field(grid, '保留天数（1–30）', 'number', 7), quota = field(grid, '磁盘上限 MiB（16–256）', 'number', 64);
    const stats = h('div', 'room-sub'); panel.append(stats);
    const config = () => ({ enabled: enabled.checked, retained: retained.checked, max_messages: Number(count.value), retention_days: Number(days.value), disk_quota_mib: Number(quota.value) });
    const refresh = async () => { const v = await command({ action: 'chat_admin', command: { action: 'stats' } }); const c = v.config; enabled.checked = c.enabled; retained.checked = c.retained; count.value = c.max_messages; days.value = c.retention_days; quota.value = c.disk_quota_mib; stats.replaceChildren(h('p', '', '文件占用 ' + (v.disk_bytes / 1048576).toFixed(2) + ' MiB'));
      (v.rooms || []).forEach(room => { const row = h('div', 'room-toolbar'); row.append(h('span', '', room.room_id + ' · ' + room.count + ' 条'), button('清空此房间历史', async () => { if (await confirmAction('永久删除该房间的全部聊天历史？')) { await command({ action: 'chat_admin', command: { action: 'clear', room_id: room.room_id, confirmed: true } }); historyRevision = ''; messages = []; await refresh(); } })); stats.append(row); });
    };
    panel.append(button('查看占用与历史房间', refresh), button('预览并保存设置', async () => { const c = config(); const preview = await command({ action: 'chat_admin', command: { action: 'preview', config: c } }); if (!await confirmAction('至少清理 ' + preview.at_least_deleted + ' 条消息。减少保留范围会永久删除记录，确认应用？')) return; await command({ action: 'chat_admin', command: { action: 'configure', config: c, expected_revision: preview.history_revision, confirmed: true } }); historyRevision = ''; messages = []; await refresh(); }));
  }
  async function resource(id, kind) {
    const chunks = []; let offset = 0, revision = null, total = 0, mime = '';
    do { const page = await peer({ action: 'resource', resource_id: id, kind, offset, revision });
      if (page.total > 2 * 1024 * 1024 || page.offset !== offset || (revision && revision !== page.revision)) throw new Error('资源快照已改变，请重新加载');
      revision = page.revision; total = page.total; mime = page.mime;
      const bytes = Uint8Array.from(atob(page.base64), c => c.charCodeAt(0)); if (!bytes.length && offset < total) throw new Error('资源分页没有推进'); chunks.push(bytes); offset += bytes.length;
    } while (offset < total);
    return new Blob(chunks, { type: mime });
  }
  function updateResources(track) {
    const key = track && track.resource_id || '';
    if (resourceKey !== key) { resourceKey = key; const generation = ++resourceGeneration; lyrics = []; refs.lyrics.replaceChildren(); refs.cover.hidden = true; if (coverUrl) URL.revokeObjectURL(coverUrl); coverUrl = '';
      if (key) { if (track.has_cover) resource(key, 'cover').then(blob => { if (generation !== resourceGeneration) return; coverUrl = URL.createObjectURL(blob); refs.cover.src = coverUrl; refs.cover.hidden = false; }).catch(() => {});
        resource(key, 'lyrics').then(blob => blob.text()).then(text => { if (generation !== resourceGeneration) return; const doc = JSON.parse(text); lyrics = Array.isArray(doc.lines) ? doc.lines : []; delete refs.lyrics.dataset.key; drawLyrics(); }).catch(() => {}); }
    }
    drawLyrics();
  }
  function drawLyrics() {
    const position = Number(snap.position_ms || 0); let index = 0; while (index + 1 < lyrics.length && lyrics[index + 1].start_ms <= position) index++;
    const key = resourceKey + ':' + index; if (refs.lyrics.dataset.key === key) return; refs.lyrics.dataset.key = key; refs.lyrics.replaceChildren();
    lyrics.slice(Math.max(0, index - 1), index + 3).forEach(line => refs.lyrics.append(h('p', line === lyrics[index] ? 'active' : '', line.text)));
  }
  let indicator;
  function updateIndicator() {
    if (!indicator) { indicator = button('一起听', () => { document.querySelector('[data-view="room"]').click(); }); indicator.classList.add('room-global'); document.body.append(indicator); }
    indicator.hidden = snap.mode === 'local'; indicator.textContent = '一起听 · ' + (snap.mode === 'host' ? '房主' : snap.mode === 'reconnecting' ? '重连中' : '房间') + (snap.name ? ' · ' + snap.name : '');
  }
  function animateMessage(message) { if (!refs.danmaku || refs.danmaku.hidden || refs.danmaku.childElementCount >= 20 || matchMedia('(prefers-reduced-motion: reduce)').matches) return; const el = h('span', '', message.name + '：' + message.text); el.style.setProperty('--lane', String(refs.danmaku.childElementCount % 5)); refs.danmaku.append(el); el.addEventListener('animationend', () => el.remove(), { once: true }); setTimeout(() => el.remove(), 6000); }
  async function poll(force) { if (polling || !root) return; polling = true; try { const value = await transport.get('/v1/room', { retry: false }); if (!root) return; snap = value; updateIndicator(); if (force || (!document.hidden && !root.hidden)) update(); } finally { polling = false; } }
  global.HertzRoom = {
    init(options) { root = options.root; transport = options.transport; confirmAction = options.confirm; if (!root) return; mounted = ''; mount(); if (timer) clearInterval(timer); timer = setInterval(() => poll(false).catch(e => status(e.message, true)), 1000); },
    onViewEnter() { return poll(true).catch(e => status(e.message, true)); },
    active() { return snap.mode !== 'local'; },
    playback(action, extra) { update(); return run(() => playback(action === 'toggle' ? (snap.playing ? 'pause' : 'play') : action, extra)); },
    snapshot() { return snap; },
    async localVolume(volume) { const o = snap.output || {}; if (!o.enabled) throw new Error('请先启用房间本机输出'); const result = await command({ action: 'output', enabled: true, settings: { ...(o.settings || {}), volume } }); await poll(true); return result; },
    destroy() { if (timer) clearInterval(timer); timer = 0; root = null; messages = []; }
  };
})(window);
