// SPDX-License-Identifier: MIT
// DOM and user intentions only. Session, transport, resources and receipts belong to HertzRoom.
(function (global) {
  'use strict';
  global.HertzRoomView = {
    create(api) {
      const { h, button, field, select, section, refs, selection, metadata, command, control, playback, run, status, sessionKey, current, confirmAction, loadLocal, appendResource, mutateQueue, loadChat, resetChat, sendChat } = api;
  function navigationButton(text, action, cls) { const node = h('button', 'btn ' + (cls || ''), text); node.type = 'button'; node.onclick = action; return node; }
  function iconButton(node, name, label) { node.replaceChildren(global.HertzRoomWorkspace.icon(name), h('span', 'room-visually-hidden', label)); node.setAttribute('aria-label', label); node.title = label; }
  function mountEntry() {
    const page = api.workspace().pages.lobby;
    const intro = h('div', 'room-lobby-intro'); intro.append(h('h3', '', '听见相同的此刻'), h('p', 'room-sub', '把正在喜欢的音乐，分享给同一网络里的人。')); page.append(intro);
    const shortcuts = h('div', 'room-toolbar'); page.append(shortcuts);
    const discovery = section(page, '附近房间');
    const search = field(discovery, '搜索房间名称或房间码', 'search');
    const count = h('p', 'room-sub', '尚未发现房间'); refs.nearby = h('div', 'room-nearby-grid');
    let rooms = [];
    const renderRooms = () => {
      const visible = rooms.filter(room => ((room.name || '') + ' ' + (room.room_code || '')).toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
      count.textContent = rooms.length + ' 间附近房间' + (search.value ? ' · ' + visible.length + ' 间符合搜索' : ''); refs.nearby.replaceChildren();
      visible.forEach(room => { const card = h('article', 'room-nearby-card'); card.append(h('small', 'room-kicker', '局域网 · 已发现'), h('h4', '', room.name || '音乐房间'), h('p', 'room-sub', room.room_code ? '房间码 ' + room.room_code + ' · 加入前由房主审批' : '加入前需要房主的一次性邀请')); if (room.room_code && room.fingerprint) card.append(button('申请加入', () => api.applyForRoom(room, applicantName.value, applicantListen.checked), 'primary')); card.append(navigationButton('使用邀请加入', () => { joinDetails.open = true; invitation.focus(); })); refs.nearby.append(card); });
      if (!visible.length) refs.nearby.append(h('p', 'room-empty', rooms.length ? '没有匹配的房间，试试其他名称。' : '暂未发现房间。创建一间，或直接使用房主邀请加入。'));
    };
    search.oninput = renderRooms;
    const applicantName = field(discovery, '申请时的显示名称', 'text', '收听电脑'); applicantName.maxLength = 32; const applicantListen = field(discovery, '申请通过后在本机收听', 'checkbox'); applicantListen.checked = true; refs.application = h('div', 'room-application'); refs.application.hidden = true; discovery.append(count, refs.application);
    const grid = h('div', 'room-entry');
    const createDetails = h('details', 'room-entry-details'), joinDetails = h('details', 'room-entry-details');
    createDetails.append(h('summary', '', '创建一起听房间')); joinDetails.append(h('summary', '', '通过邀请加入'));
    grid.append(createDetails, joinDetails); page.append(grid);
    shortcuts.append(navigationButton('+ 创建房间', () => { createDetails.open = true; name.focus(); }, 'primary'), navigationButton('使用邀请加入', () => { joinDetails.open = true; invitation.focus(); }));
    const create = section(createDetails, '创建房间'); create.append(h('p', 'room-sub', '只分享你明确选中的本地歌曲。'));
    const name = field(create, '房间名称', 'text', '我的音乐房间'); name.maxLength = 64;
    const address = select(create, '局域网网卡', [['', '先发现可用网卡']]);
    const port = field(create, '端口（0 为自动选择）', 'number', '0'); port.min = 0; port.max = 65535;
    const rate = select(create, '房间采样率', [['44100', '44.1 kHz'], ['48000', '48 kHz'], ['96000', '96 kHz'], ['192000', '192 kHz']]); rate.value = '48000';
    const output = field(create, '本机同时收听', 'checkbox'); output.checked = true; const discoverable = field(create, '允许附近的人发现房间', 'checkbox'); discoverable.checked = true;
    create.append(button('创建房间', async () => { if (!address.value) throw new Error('请先选择网卡'); if (!name.value.trim()) throw new Error('请输入房间名称'); await command({ action: 'create', name: name.value.trim(), address: address.value + ':' + Number(port.value), sample_rate: Number(rate.value), local_output: output.checked, discoverable: discoverable.checked }); }, 'primary'));
    const join = section(joinDetails, '加入房间'); join.append(h('p', 'room-sub', '从房主获取一次性邀请。加入前请核对主机指纹。'));
    const nickname = field(join, '显示名称', 'text', '收听电脑'); nickname.maxLength = 32;
    const invitation = field(join, '一次性邀请', 'textarea'); invitation.maxLength = 2048; invitation.autocomplete = 'off'; invitation.spellcheck = false;
    const listen = field(join, '在本机播放音频', 'checkbox'); listen.checked = true;
    const pin = h('p', 'room-mono room-pin'); join.append(pin);
    invitation.oninput = () => { try { const data = JSON.parse(atob(invitation.value.trim().replace(/^hertz-listen:v1:/, '').replace(/-/g, '+').replace(/_/g, '/'))); pin.textContent = '主机：' + data.address + '\n指纹：' + data.fingerprint; } catch (_) { pin.textContent = ''; } };
    join.append(button('加入房间', async () => { const code = invitation.value.trim(); if (!pin.textContent) throw new Error('请粘贴有效的房主邀请'); const key = sessionKey(); if (!await confirmAction(pin.textContent + '\n请与房主核对后加入。') || !current(key)) return; invitation.value = ''; pin.textContent = ''; await command({ action: 'join', invitation: code, name: nickname.value.trim(), listen: listen.checked }); }, 'primary'));
    const saved = h('p', 'room-sub', '正在读取上次加入的房间…');
    const resume = button('重新加入上次房间', () => command({ action: 'resume' })); resume.disabled = true; join.append(saved, resume);
    const entryKey = sessionKey();
    command({ action: 'saved_room' }).then(data => { if (!current(entryKey)) return; const room = data.saved_room; resume.disabled = !room; saved.textContent = room ? '上次以「' + room.name + '」加入 ' + room.address + '。点击重新加入后才会连接。' : '没有保存的房间。首次加入需要房主邀请。'; }).catch(e => { if (current(entryKey)) { saved.textContent = e.message || '无法读取保存的房间'; saved.classList.add('room-error'); } });
    const discover = async () => {
      const key = sessionKey(), data = await command({ action: 'discover' }); if (!current(key)) return;
      const selected = address.value; address.replaceChildren();
      (data.interfaces || []).forEach(i => { const ip = i.address.includes(':') ? '[' + i.address + (i.address.startsWith('fe80:') && i.index ? '%' + i.index : '') + ']' : i.address; const option = h('option', '', i.name + ' · ' + i.address + (i.loopback ? '（本机）' : '')); option.value = ip; address.append(option); });
      if (selected) address.value = selected;
      rooms = data.rooms || []; renderRooms();
    };
    discovery.append(button('发现房间与网卡', discover), h('p', 'room-sub', '发现只用于找到房间，不能替代房主授权。'), refs.nearby);
    renderRooms();
  }
  function mountOutput(parent) {
    const output = section(parent, '本机输出'); refs.outputStatus = h('p', 'room-sub'); refs.metrics = h('dl', 'room-metrics'); output.append(refs.outputStatus, refs.metrics);
    refs.device = select(output, '输出设备', [['', '系统默认设备']]); output.append(button('刷新设备', async () => { const key = sessionKey(), result = await command({ action: 'devices' }); if (!current(key)) return; const devices = Array.isArray(result) ? result : result.devices || []; const selected = refs.device.value; refs.device.replaceChildren(new Option('系统默认设备', '')); devices.forEach(d => refs.device.append(new Option(d.name || d.id, d.id))); refs.device.value = selected; }));
    refs.localVolume = field(output, '本机音量（0–100）', 'number', 100); refs.localVolume.min = 0; refs.localVolume.max = 100;
    refs.correction = field(output, '额外延迟补偿（毫秒）', 'number', 0); refs.correction.min = -500; refs.correction.max = 500;
    refs.device.onchange = () => { refs.correction.value = 0; status('设备已改变，延迟补偿已重置。应用输出后再为当前设备校准。'); };
    refs.outputEnabled = field(output, '启用本机音频', 'checkbox'); output.append(button('应用本机输出', () => command({ action: 'output', enabled: refs.outputEnabled.checked, settings: { device_id: refs.device.value || null, volume: Number(refs.localVolume.value) / 100, latency_correction_ms: Number(refs.correction.value), calibration_binding: api.snapshot().output && api.snapshot().output.binding || null } })));
    output.append(refs.testOutput = button('播放设备测试音', async () => {
      const key = sessionKey(); await command({ action: 'test_output' });
      if (current(key)) status('已安排本机 440 Hz 测试音（250 毫秒），使用当前输出设备和本机音量。');
    }));
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
    refs.sleep = section(parent, '睡眠定时');
    refs.sleepStatus = h('p', 'room-sub');
    const minutes = field(refs.sleep, '多少分钟后暂停（最多 480 分钟）', 'number', 30); minutes.min = 1; minutes.max = 480;
    refs.sleep.append(refs.sleepStatus, button('设置定时', async () => {
      const value = Number(minutes.value);
      if (!Number.isFinite(value) || value < 1 || value > 480) throw new Error('请输入 1 至 480 分钟');
      await command({ action: 'sleep_timer', seconds: Math.round(value * 60) });
    }), button('取消定时', () => command({ action: 'sleep_timer', seconds: null })), h('p', 'room-sub', '房主服务负责计时。关闭页面仍会到期安排全房间暂停。'));
  }
  function mountChat(parent) {
    const chat = section(parent, '房间聊天'); refs.chatStatus = h('p', 'room-sub'); refs.chat = h('ol', 'room-chat'); refs.chat.setAttribute('aria-label', '聊天消息'); chat.append(refs.chatStatus, refs.chat);
    refs.chatOperation = h('div', 'room-operations'); chat.append(refs.chatOperation);
    refs.chatSongPending = h('p', 'room-song-message'); refs.chatSongPending.hidden = true; chat.append(refs.chatSongPending);
    const form = h('form', 'room-chat-form'); refs.chatInput = field(form, '说点什么（最多 200 字）', 'textarea'); refs.chatInput.maxLength = 400;
    refs.chatSend = h('button', 'btn primary', '发送'); refs.chatSend.type = 'submit'; form.append(refs.chatSend);
    form.onsubmit = e => { e.preventDefault(); run(() => sendChat()); }; chat.append(form);
    const show = field(chat, '显示实时弹幕', 'checkbox'); show.checked = true; show.onchange = () => { refs.danmaku.hidden = !show.checked; }; refs.danmaku = h('div', 'room-danmaku'); refs.danmaku.setAttribute('aria-hidden', 'true'); api.root().append(refs.danmaku);
    refs.chatOlder = button('更早消息', async () => loadChat(true));
    chat.append(refs.chatOlder, button('回到最新消息', async () => { resetChat(); await loadChat(); }));
  }
  function mountChatAdmin(parent) {
    const key = sessionKey();
    const panel = refs.chatAdmin = section(parent, '聊天保留与清理');
    const grid = h('div', 'room-form-grid'); panel.append(grid);
    const initial = api.snapshot().chat && api.snapshot().chat.config || {};
    const enabled = field(grid, '启用房间聊天', 'checkbox'), retained = field(grid, '保存聊天历史', 'checkbox'); enabled.checked = initial.enabled !== false; retained.checked = initial.retained !== false;
    const count = field(grid, '最多消息条数（100–50000）', 'number', initial.max_messages ?? 10000), days = field(grid, '保留天数（1–30）', 'number', initial.retention_days ?? 7), quota = field(grid, '磁盘上限 MiB（16–256）', 'number', initial.disk_quota_mib ?? 64);
    const stats = h('div', 'room-sub'); panel.append(stats);
    const config = () => ({ enabled: enabled.checked, retained: retained.checked, max_messages: Number(count.value), retention_days: Number(days.value), disk_quota_mib: Number(quota.value) });
    const refresh = async () => { if (!current(key)) return; const v = await command({ action: 'chat_admin', command: { action: 'stats' } }); if (!current(key)) return; const c = v.config; enabled.checked = c.enabled; retained.checked = c.retained; count.value = c.max_messages; days.value = c.retention_days; quota.value = c.disk_quota_mib; stats.replaceChildren(h('p', '', '文件占用 ' + (v.disk_bytes / 1048576).toFixed(2) + ' MiB'));
      (v.rooms || []).forEach(room => { const row = h('div', 'room-toolbar'); row.append(h('span', '', room.room_id + ' · ' + room.count + ' 条'), button('清空此房间历史', async () => { if (await confirmAction('永久删除该房间的全部聊天历史？') && current(key)) { await command({ action: 'chat_admin', command: { action: 'clear', room_id: room.room_id, confirmed: true } }); if (!current(key)) return; resetChat(); await refresh(); } })); stats.append(row); });
    };
    panel.append(button('查看占用与历史房间', refresh), button('预览并保存设置', async () => { const c = config(); const preview = await command({ action: 'chat_admin', command: { action: 'preview', config: c } }); if (!current(key) || !await confirmAction('至少清理 ' + preview.at_least_deleted + ' 条消息。减少保留范围会永久删除记录，确认应用？') || !current(key)) return; await command({ action: 'chat_admin', command: { action: 'configure', config: c, expected_revision: preview.history_revision, confirmed: true } }); if (!current(key)) return; resetChat(); await refresh(); }));
  }
  function drawQueue(items) {
    refs.queue.replaceChildren(); refs.queuePreview.replaceChildren();
    if (!items.length) { refs.queue.append(h('li', 'room-empty', '队列为空。从下方共享曲库添加歌曲。')); refs.queuePreview.append(h('li', 'room-empty', '还没有歌曲，来点第一首。')); }
    items.forEach((q, i) => {
      const t = metadata.get(q.resource_id), snapshot = api.snapshot(), p = snapshot.permissions || {};
      const row = h('li', q.instance_id === snapshot.track_instance_id ? 'room-track active' : 'room-track');
      row.append(h('span', 'room-mono', String(api.queueOffset() + i + 1).padStart(2, '0')));
      const copy = h('div'); copy.append(h('strong', '', t ? t.title : '共享歌曲'));
      const attribution = [t && t.artist, q.requester && q.requester.name ? q.requester.name + ' 点的歌' : ''].filter(Boolean).join(' · ');
      copy.append(h('small', 'room-sub', attribution)); row.append(copy);
      if (t && t.duration_ms) row.append(h('span', 'room-mono room-track-duration', formatTime(t.duration_ms)));
      if (typeof q.votes === 'number') {
        const vote = button((q.voted_by_me ? '已投票 ' : '投票 ') + q.votes, () => api.vote(q.instance_id, !q.voted_by_me), q.voted_by_me ? 'room-voted' : '');
        vote.disabled = !p.queue || !q.votable; vote.title = !q.votable ? '当前播放与已冻结的音频前缀不能投票' : !p.queue ? '房主未授权编辑队列' : '每位成员可为此队列实例投一票';
        vote.setAttribute('aria-pressed', String(!!q.voted_by_me)); row.append(vote);
      }
      if (p.chat_send && t) row.append(button('分享歌曲', () => api.shareSong(q.resource_id)));
      if (p.transport) row.append(button('播放', () => playback('pick', { instance_id: q.instance_id })));
      if (p.queue) {
        const up = button('上移', async () => { await mutateQueue(all => { const index = all.findIndex(x => x.instance_id === q.instance_id); if (index <= 0) return null; [all[index - 1], all[index]] = [all[index], all[index - 1]]; return all; }); });
        up.disabled = snapshot.collaboration && snapshot.collaboration.queue_order === 'votes'; up.title = up.disabled ? '切换为手动排序后移动歌曲' : '移动此队列实例';
        row.append(up, button('移除', () => mutateQueue(all => all.filter(x => x.instance_id !== q.instance_id))));
      }
      refs.queue.append(row);
      if (i < 4) { const preview = h('li'); preview.append(h('strong', '', t ? t.title : '共享歌曲'), h('small', '', attribution || '来自共同队列')); if (typeof q.votes === 'number') preview.append(h('span', 'room-preview-votes', q.votes + ' 票')); refs.queuePreview.append(preview); }
    });
  }
  function formatTime(ms) { const value = Math.max(0, Number(ms || 0)); return Math.floor(value / 60000) + ':' + String(Math.floor(value / 1000) % 60).padStart(2, '0'); }
  function drawLibrary(items) { items.forEach(t => metadata.set(t.resource_id, t)); refs.library.replaceChildren(); if (!items.length) refs.library.append(h('p', 'room-empty', api.snapshot().mode === 'host' ? '先在“分享本地歌曲”中选择歌曲。' : '等待房主分享歌曲。')); items.forEach(t => { const row = h('div', 'room-track'); const label = h('div'); label.append(h('strong', '', t.title), h('small', 'room-sub', t.artist || '未知歌手')); row.append(label); if ((api.snapshot().permissions || {}).queue) row.append(button('加入队列', () => appendResource(t.resource_id))); if ((api.snapshot().permissions || {}).chat_send) row.append(button('分享歌曲', () => api.shareSong(t.resource_id))); refs.library.append(row); }); }
  function drawMembers() {
    const snapshot = api.snapshot();
    const count = snapshot.online_count == null ? (snapshot.members || []).length : snapshot.online_count;
    const capacity = snapshot.member_capacity == null ? '' : ' / ' + snapshot.member_capacity;
    refs.members.replaceChildren(h('h3', '', '房间成员 · ' + count + capacity)); refs.memberPreview.replaceChildren(); refs.memberStrip.replaceChildren();
    const members = snapshot.members || [];
    if (!members.length) refs.memberPreview.append(h('p', 'room-sub', '等待成员状态'));
    members.forEach((m, index) => {
      const name = m.name || '成员', card = h('div', 'room-member'); card.append(h('strong', '', name + (m.owner ? ' · 房主' : '')));
      const state = m.connected === false ? '连接已断开' : m.audio === false ? '遥控端 · 不输出音频' : m.ready ? '输出已就绪' : m.connected === true ? '已连接 · 等待音频状态' : '等待状态';
      card.append(h('p', 'room-sub', state));
      if (snapshot.mode === 'host' && !m.owner) {
        const perms = m.permissions || {};
        Object.keys(perms).forEach(k => { const input = field(card, { listen: '收听', queue: '队列', transport: '播控', volume: '音量', chat_read: '读聊天', chat_send: '发言', invite: '邀请新成员' }[k] || k, 'checkbox'); input.checked = !!perms[k]; input.onchange = () => run(async () => { try { await command({ action: 'permissions', member_id: m.id, permissions: { ...perms, [k]: input.checked } }); } catch (error) { input.checked = !!perms[k]; throw error; } }); });
        card.append(button('移出房间', async () => { const key = sessionKey(); if (await confirmAction('移出这位成员并撤销连接凭据？') && current(key)) await command({ action: 'remove', member_id: m.id }); }));
      }
      refs.members.append(card);
      const avatar = () => { const node = h('span', 'room-avatar', [...name][0]); node.setAttribute('aria-label', name + ' · ' + state); return node; };
      if (index < 5) { const summary = h('div', 'room-member-summary'), copy = h('div'); copy.append(h('strong', '', name + (m.owner ? ' · 房主' : '')), h('small', '', state)); summary.append(avatar(), copy); refs.memberPreview.append(summary); }
      if (index < 8) refs.memberStrip.append(avatar());
    });
    if (members.length > 8) refs.memberStrip.append(h('span', 'room-avatar', '+' + (members.length - 8)));
  }
  function drawActivity(items) {
    const signature = items.slice(-4).map(item => item.seq).join(':');
    if (refs.activity.dataset.signature === signature) return;
    refs.activity.dataset.signature = signature; refs.activity.replaceChildren();
    const labels = { join: '加入了房间', leave: '离开了房间', queue_add: '添加了歌曲', vote: '为歌曲投票', unvote: '取消了投票', playback: '更新了房间播放' };
    items.slice(-4).forEach(item => { const row = h('li', '', (item.name || '成员') + ' ' + (labels[item.kind] || '更新了房间')); row.dataset.sequence = item.seq; refs.activity.append(row); });
  }
  function drawMessage(message, node) {
    node.append(h('strong', '', message.name + ' '), h('span', '', message.text));
    if (message.content_kind === 'song') {
      const song = message.sharing_revision && message.sharing_revision !== api.snapshot().sharing_revision ? null : message.song;
      const card = h('div', 'room-song-message');
      if (song) { card.append(h('strong', '', song.title), h('small', 'room-sub', song.artist || '共享歌曲')); if ((api.snapshot().permissions || {}).queue) card.append(button('加入队列', () => appendResource(song.resource_id))); }
      else card.append(h('small', 'room-sub', '这首歌曲已不在共享范围内'));
      node.append(card);
    }
  }
  function drawApplication(application) {
    if (!refs.application) return;
    refs.application.hidden = false; refs.application.replaceChildren(h('strong', '', application.name || '入房申请'));
    refs.application.append(h('p', 'room-sub', { pending: '已提交，等待房主审批。批准后点击查看结果即可加入。', approved: '房主已批准，正在加入房间。', approved_retry: '房主的批准仍有效。你可以显式重试加入。', join_failed: '本次连接失败。申请已保留，请先重新核对入房状态。', join_unknown: '加入结果尚未确认。请先查询状态，避免重复使用一次性邀请。', status_failed: '申请可能已过期，或房主暂时不可达。记录已保留，可以重新查询。', cleared: '本机申请记录已清除，房主的批准不会自动撤销。', rejected: '房主未批准这次申请。', expired: '申请已过期，请重新申请。', consumed: '该申请已经用于加入房间，请查看当前房间或重新申请。' }[application.state] || '正在读取结果'));
    if (application.state === 'pending') refs.application.append(button('查看申请结果', () => api.checkApplication()));
    if (['join_failed', 'join_unknown', 'status_failed'].includes(application.state)) refs.application.append(button('查看入房状态', () => api.checkApplication()));
    if (application.state === 'approved_retry') refs.application.append(button('重试加入房间', () => api.checkApplication(true), 'primary'));
    if (['pending', 'join_failed', 'join_unknown', 'status_failed', 'approved_retry'].includes(application.state)) refs.application.append(button('清除本机申请记录', () => api.forgetApplication()));
  }
  function drawAdmissions(admission) {
    refs.admissions.hidden = api.snapshot().mode !== 'host' || !admission;
    const code = admission && admission.room_code; refs.roomCode.hidden = !code; refs.roomCode.textContent = code ? '房间查找码 · ' + code : '';
    if (!admission) return;
    const signature = JSON.stringify((admission.pending || []).map(application => [application.id, application.name, application.state, application.member_id]));
    if (refs.admissionList.dataset.signature === signature) return;
    refs.admissionList.dataset.signature = signature; refs.admissionList.replaceChildren();
    const pending = admission.pending || [];
    if (!pending.length) refs.admissionList.append(h('p', 'room-sub', '当前没有待处理的入房申请'));
    pending.forEach(application => { const row = h('div', 'room-admission-row'); row.append(h('strong', '', application.name || '申请人'), h('p', 'room-sub', { approved: '已批准，等待加入', rejected: '已拒绝', pending: '等待审批 · 过期后需重新申请', consumed: '已加入房间 · 如需移出请在成员中操作' }[application.state] || '等待更新'));
      if (application.state === 'pending') row.append(button('同意收听与聊天', () => api.reviewApplication(application.id, true), 'primary'), button('拒绝', () => api.reviewApplication(application.id, false)));
      else if (application.state === 'approved') row.append(button('撤销批准', () => api.revokeApplication(application.id)));
      refs.admissionList.append(row);
    });
  }
  function drawInvitationManagement() {
    const snapshot = api.snapshot(); refs.invitationManagement.hidden = snapshot.mode !== 'host';
    if (document.activeElement !== refs.discoverable) refs.discoverable.checked = snapshot.discoverable !== false;
    refs.discoveryStatus.textContent = snapshot.discoverable === false ? '发现已关闭，持有有效邀请的人仍可加入。' : snapshot.discovery_available === true ? '正在向同一网络广播房间。' : snapshot.discovery_available === false ? '广播暂不可用，仍可通过有效邀请加入。' : '等待发现服务状态';
    const invitations = snapshot.invitations || [], signature = JSON.stringify(invitations.map(invite => [invite.id, invite.issuer]));
    if (refs.outstandingInvitations.dataset.signature === signature) return;
    refs.outstandingInvitations.dataset.signature = signature; refs.outstandingInvitations.replaceChildren();
    if (!invitations.length) refs.outstandingInvitations.append(h('p', 'room-sub', '当前没有未使用的直接邀请'));
    invitations.forEach(invite => { const issuer = (snapshot.members || []).find(member => member.id === invite.issuer); const row = h('div', 'room-admission-row'); row.append(h('p', 'room-sub', (issuer ? issuer.name : '房主') + ' 发出的有效邀请'), button('撤销邀请', () => api.revokeInvitation(invite.id))); refs.outstandingInvitations.append(row); });
  }
  function mountActive() {
    const workspace = api.workspace(), pages = workspace.pages;
    const go = name => workspace.navigate(name, true);
    const lobby = section(pages.lobby, '你的房间正在进行');
    refs.activeRoomName = h('h3', 'room-lobby-name', api.snapshot().name || '一起听房间');
    lobby.append(refs.activeRoomName, h('p', 'room-sub', '返回大厅不会断开当前房间。'), navigationButton('继续一起听', () => go('play'), 'primary'), navigationButton('邀请新成员', () => go('invite')));
    const playLayout = h('div', 'room-play-layout'), now = section(playLayout, '正在聆听', 'room-player');
    const hero = h('div', 'room-hero'), art = h('div', 'room-art');
    const emptyArt = h('div', 'room-art-empty'); emptyArt.setAttribute('aria-hidden', 'true'); emptyArt.append(h('span', '', 'H'), h('small', '', 'LISTEN TOGETHER'));
    refs.cover = h('img', 'room-cover'); refs.cover.alt = '当前共享歌曲封面'; refs.cover.hidden = true; refs.cover.onerror = () => { refs.cover.hidden = true; };
    art.append(emptyArt, refs.cover);
    const copy = h('div', 'room-hero-copy'); refs.playingBadge = h('span', 'room-playing-badge', '等待播放');
    refs.current = h('strong', 'room-current'); refs.artist = h('p', 'room-artist'); refs.album = h('p', 'room-sub');
    const actions = h('div', 'room-toolbar');
    refs.songShare = button('分享歌曲到聊天', () => api.shareCurrentSong());
    refs.songAppend = button('加入队列', () => api.appendCurrentSong());
    actions.append(refs.songShare, refs.songAppend); copy.append(refs.playingBadge, refs.current, refs.artist, refs.album, actions);
    hero.append(art, copy); now.append(hero);
    const seekLine = h('div', 'room-seek-line'); refs.position = h('span', 'room-mono', '0:00'); refs.duration = h('span', 'room-mono', '0:00');
    refs.progress = h('input', 'room-progress'); refs.progress.type = 'range'; refs.progress.min = 0; refs.progress.max = 1000; refs.progress.step = 1; refs.progress.value = 0; refs.progress.setAttribute('aria-label', '房间播放进度');
    let seekContext = null;
    refs.progress.oninput = () => { if (!seekContext) seekContext = { instance: api.snapshot().track_instance_id, duration: Number((api.snapshot().current_track || {}).duration_ms || 0) }; };
    refs.progress.onblur = () => { seekContext = null; };
    refs.progress.onchange = () => { const context = seekContext || { instance: api.snapshot().track_instance_id, duration: Number((api.snapshot().current_track || {}).duration_ms || 0) }; seekContext = null; if (context.instance === api.snapshot().track_instance_id && context.duration) run(() => playback('seek', { instance_id: context.instance, position_ms: String(Math.round(Number(refs.progress.value) / 1000 * context.duration)) })); };
    seekLine.append(refs.position, refs.progress, refs.duration); now.append(seekLine);
    const controls = h('div', 'room-player-controls'); refs.prev = button('上一首', () => playback('previous')); refs.play = button('播放', () => playback(api.snapshot().playing ? 'pause' : 'play'), 'primary room-play-button'); refs.next = button('下一首', () => playback('next')); refs.stop = button('停止', () => playback('stop')); iconButton(refs.prev, 'prev', '上一首'); iconButton(refs.next, 'next', '下一首'); iconButton(refs.stop, 'stop', '停止'); controls.append(refs.prev, refs.play, refs.next, refs.stop); now.append(controls);
    const quick = h('div', 'room-player-quick');
    refs.quickMode = button('列表循环', () => api.cycleMode());
    const volumeLabel = h('label', 'room-player-volume', '本机音量'); refs.quickVolume = h('input'); refs.quickVolume.type = 'range'; refs.quickVolume.min = 0; refs.quickVolume.max = 100; refs.quickVolume.step = 1; refs.quickVolume.setAttribute('aria-label', '本机音量'); refs.quickVolume.onchange = () => run(() => api.localVolume(Number(refs.quickVolume.value) / 100)); volumeLabel.append(refs.quickVolume); quick.append(refs.quickMode, volumeLabel, navigationButton('共同队列', () => go('collaborate'))); now.append(quick);
    const precise = h('details', 'room-precise-seek'); precise.append(h('summary', '', '精确跳转'));
    const precisionLine = h('div', 'room-toolbar'); refs.seek = field(precisionLine, '跳转位置（秒）', 'number', 0); refs.seek.min = 0; refs.seekButton = button('跳转', () => playback('seek', { instance_id: api.snapshot().track_instance_id, position_ms: String(Math.max(0, Math.trunc(Number(refs.seek.value) * 1000))) })); precisionLine.append(refs.seekButton); precise.append(precisionLine); now.append(precise);
    refs.operations = h('div', 'room-operations'); refs.lyrics = h('div', 'room-lyrics'); refs.lyrics.setAttribute('aria-label', '同步歌词'); now.append(refs.operations, refs.lyrics);
    const sync = h('div', 'room-sync-summary'); refs.connection = h('span', 'room-chip'); refs.format = h('span', 'room-chip'); sync.append(refs.connection, refs.format, navigationButton('查看同步与输出详情', () => go('settings'))); now.append(sync);
    refs.memberStrip = h('div', 'room-member-strip'); refs.activity = h('ol', 'room-activity'); now.append(refs.memberStrip, refs.activity);
    const aside = h('aside', 'room-play-aside'), memberPreview = section(aside, '房间成员'); refs.memberPreview = h('div', 'room-members-preview'); memberPreview.append(refs.memberPreview, navigationButton('查看全部成员', () => go('settings')));
    const queuePreview = section(aside, '接下来一起听'); refs.queuePreview = h('ol', 'room-queue-preview'); queuePreview.append(refs.queuePreview, navigationButton('+ 添加歌曲到共同队列', () => go('collaborate'), 'room-add-song')); playLayout.append(aside); pages.play.append(playLayout);
    const tabs = h('div', 'room-collaboration-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '共同队列与聊天');
    const collaboration = h('div', 'room-collaboration');
    const queueColumn = h('div', 'room-collaboration-queue'), chatColumn = h('div', 'room-collaboration-chat');
    const queueTab = navigationButton('共同队列', () => selectTab('queue')), chatTab = navigationButton('聊天', () => selectTab('chat'));
    function selectTab(value) { pages.collaborate.dataset.tab = value; queueTab.setAttribute('aria-selected', String(value === 'queue')); chatTab.setAttribute('aria-selected', String(value === 'chat')); queueTab.tabIndex = value === 'queue' ? 0 : -1; chatTab.tabIndex = value === 'chat' ? 0 : -1; }
    refs.selectTab = selectTab;
    [queueTab, chatTab].forEach((node, index) => { node.setAttribute('role', 'tab'); node.onkeydown = event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const target = event.key === 'Home' ? queueTab : event.key === 'End' ? chatTab : index ? queueTab : chatTab; selectTab(target === queueTab ? 'queue' : 'chat'); target.focus(); }; });
    tabs.append(queueTab, chatTab); selectTab('queue'); pages.collaborate.append(tabs, collaboration); collaboration.append(queueColumn, chatColumn);
    const queue = section(queueColumn, '共同队列'); refs.orderControl = h('div', 'room-toolbar'); refs.order = select(refs.orderControl, '队列排序', [['manual', '手动排序'], ['votes', '按票数排序']]); refs.order.onchange = () => run(() => api.queueOrder(refs.order.value)); queue.append(refs.orderControl); refs.queueCount = h('p', 'room-sub'); refs.queue = h('ol', 'room-queue'); queue.append(refs.queueCount, refs.queue);
    const queueNav = h('div', 'room-toolbar'); queueNav.append(button('上一页', () => api.pageQueue(-1)), button('下一页', () => api.pageQueue(1))); queue.append(queueNav);
    const library = section(queueColumn, '点歌 · 共享曲库'); refs.library = h('div', 'room-list'); library.append(refs.library); const libraryNav = h('div', 'room-toolbar'); libraryNav.append(button('上一页', () => api.pageLibrary(-1)), button('下一页', () => api.pageLibrary(1))); library.append(libraryNav);
    mountChat(chatColumn);
    const inviteLayout = h('div', 'room-invite-layout'); pages.invite.append(inviteLayout);
    const invitationHelp = section(inviteLayout, '把音乐分享给身边的人'); refs.roomCode = h('p', 'room-code'); invitationHelp.append(refs.roomCode); invitationHelp.append(h('p', 'room-sub', '生成一次性邀请后，将邀请发给同一网络中的 Hertz 用户。邀请包含主机指纹，加入前请与房主核对。'), navigationButton('查看房间成员', () => go('settings')));
    refs.invites = section(inviteLayout, '邀请进入房间'); const invitePerms = refs.invitePerms = h('div', 'room-permissions'), permissions = {};
    [['listen', '收听'], ['queue', '编辑队列'], ['transport', '播控'], ['volume', '房间音量'], ['chat_read', '查看聊天'], ['chat_send', '发言'], ['invite', '邀请新成员']].forEach(([key, label]) => { const input = field(invitePerms, label, 'checkbox'); input.checked = ['listen', 'chat_read', 'chat_send'].includes(key); permissions[key] = input; });
    refs.invitation = field(refs.invites, '一次性邀请（五分钟有效）', 'textarea'); refs.invitation.readOnly = true; refs.invitation.autocomplete = 'off';
    refs.invitationQr = h('div', 'room-invitation-qr'); refs.invitationQr.setAttribute('aria-label', '一次性邀请二维码');
    refs.invitationExpiry = h('p', 'room-sub', '尚未生成邀请');
    refs.revokeInvitation = button('撤销这份邀请', () => api.revokeInvitation()); refs.revokeInvitation.disabled = true; refs.invites.append(refs.revokeInvitation, refs.invitationQr, refs.invitationExpiry, invitePerms, button('生成邀请', async () => { const key = sessionKey(), p = {}; Object.keys(permissions).forEach(k => p[k] = permissions[k].checked); const result = await api.makeInvitation(p); if (current(key)) { api.invitationGenerated(result.invitation, result.invitation_id); refs.invitation.value = result.invitation; } }), button('复制邀请', async () => { const value = api.validInvitation(); if (!value) throw new Error('请先生成有效邀请'); await global.HertzClipboard.write(value); status('邀请已复制。'); }));
    refs.guestInvite = h('p', 'room-empty-state', '请联系房主获取一次性邀请。'); inviteLayout.append(refs.guestInvite);
    const settings = h('div', 'room-settings-grid'); pages.settings.append(settings); refs.admissions = section(settings, '入房申请'); refs.admissionList = h('div', 'room-admission-list'); refs.admissions.append(refs.admissionList); refs.invitationManagement = section(settings, '邀请与发现'); refs.discoverable = field(refs.invitationManagement, '允许附近的人发现房间', 'checkbox'); refs.discoverable.onchange = () => run(() => api.setDiscoverable(refs.discoverable.checked)); refs.discoveryStatus = h('p', 'room-sub'); refs.outstandingInvitations = h('div'); refs.invitationManagement.append(refs.discoveryStatus, refs.outstandingInvitations);
    refs.members = section(settings, '房间成员'); mountOutput(settings); mountDsp(settings);
    refs.sharing = section(settings, '分享本地歌曲'); const search = field(refs.sharing, '搜索本地曲库', 'search'); refs.localTracks = h('div', 'room-local-tracks'); refs.sharing.append(button('搜索', () => loadLocal(search.value)), refs.localTracks, button('更新分享范围', () => command({ action: 'share', track_ids: [...selection] }), 'primary'));
    mountChatAdmin(settings);
    const leave = section(settings, '房间会话'); leave.append(h('p', 'room-sub', '返回 Hertz 会保持房间连接；结束或离开会停止这台电脑的房间会话。'), navigationButton('返回 Hertz', api.onReturn), button('离开房间', async () => { const key = sessionKey(); if (await confirmAction(api.snapshot().mode === 'host' ? '结束房间？所有成员将停止收听。' : '离开当前房间？') && current(key)) { await command({ action: 'leave' }); if (current(key)) { resetChat(); selection.clear(); } } }, 'room-leave'));
  }
      return { mountEntry, mountActive, drawQueue, drawLibrary, drawMembers, drawActivity, drawMessage, drawApplication, drawAdmissions, drawInvitationManagement, updatePlayButton(playing) { iconButton(refs.play, playing ? 'pause' : 'play', playing ? '暂停' : '播放'); }, selectTab: value => { if (refs.selectTab) refs.selectTab(value); } };
    }
  };
})(window);
