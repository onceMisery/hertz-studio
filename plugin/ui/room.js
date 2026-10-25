// SPDX-License-Identifier: MIT
// Local control surface only. TLS credentials and PCM stay in native services.
(function (global) {
  'use strict';
  let root, transport, confirmAction, timer, chrome, view, workspace, onModeChange, onReturn = () => {}, onNavigate = () => {}, workspaceVisible = false, invitationExpires = 0, snap = { mode: 'local' }, busy = false;
  let mountedSession = '', workspaceOwner = '', mediaKey = '', lifecycle = 0, playbackPending = null, queuePending = null, admissionRequest = null, invitationId = '';
  let mounted = '', sequence = 1n, chatSequence = 1n, revision = '', polling = false;
  let libraryPage = 0, queuePage = 0, lastChatId = '', historyRevision = '', messages = [];
  let chatBefore = null, chatHasMore = false, chatBrowsing = false, chatLoading = null;
  let chatSharingRevision = '', chatHistorySharingRevision = '';
  const selection = new Set(), metadata = new Map(), refs = {}, pageSize = 32;
  let favoriteSignature = '', queueSignature = "", librarySignature = "", memberSignature = "", resourceKey = "", resourceSignature = "", coverUrl = "", lyrics = [], resourceGeneration = 0, chatUnknown = null, chatSending = null, chatSongPending = null, chatReceipt = null;
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  function button(text, fn, cls) { const e = h('button', 'btn ' + (cls || ''), text); e.type = 'button'; e.onclick = () => run(fn); return e; }
  function field(parent, label, type, value) { const l = h('label', 'room-field', label), e = h(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') e.type = type; e.value = value == null ? '' : value; l.append(e); parent.append(l); return e; }
  function select(parent, label, choices) { const l = h('label', 'room-field', label), e = h('select'); e.setAttribute('aria-label', label); choices.forEach(([value, text]) => { const o = h('option', '', text); o.value = value; e.append(o); }); l.append(e); parent.append(l); return e; }
  function status(text, error) { if (chrome) chrome.notice(text, error); if (!refs.notice) return; refs.notice.textContent = text || ''; refs.notice.classList.toggle('room-error', !!error); refs.notice.hidden = !text; }
  function counter(v) { return typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) ? BigInt(v) : 1n; }
  function op(chat) { if (chat) { chatSequence = chatSequence > counter(snap.next_chat_operation_id) ? chatSequence : counter(snap.next_chat_operation_id); return String(chatSequence++); } sequence = sequence > counter(snap.next_operation_id) ? sequence : counter(snap.next_operation_id); return String(sequence++); }
  function sessionKey() { return [lifecycle, snap.mode === 'local' ? 'local' : 'active', snap.room_id || '', snap.instance_id || '', snap.member_id || '', snap.session_id || ''].join(':'); }
  function operationOwner() { return snap.mode !== 'local' && snap.room_id && snap.instance_id && snap.member_id ? [lifecycle, snap.room_id, snap.instance_id, snap.member_id].join(':') : ''; }
  function current(key) { return !!root && key === mountedSession && key === sessionKey(); }
  function uncertain(error) { return !error.status || /timeout|unknown|connection|network/i.test(error.code || error.message || ''); }
  async function command(body) { return transport.post('/v1/room', body, { retry: false }); }
  async function peer(request) { return command({ action: 'peer', request }); }
  async function control(action, extra) { return peer({ action, operation_id: op(false), expected_revision: snap.revision, ...extra }); }
  async function playback(action, extra) {
    const owner = operationOwner();
    if (!owner) throw new Error('正在读取房间身份，请稍后重试。');
    if (playbackPending && playbackPending.owner === owner && playbackPending.phase !== 'scheduled') throw new Error('请先查询原播放操作的结果，再发送新的播放命令。');
    const id = op(false), receipt = { id, owner, phase: 'sending' };
    // Store before sending: a new transport session may arrive before the
    // original request reports its outcome. Reconnection never resends it.
    playbackPending = receipt; drawPlaybackReceipt();
    let result;
    try { result = await peer({ action: 'playback', operation_id: id, expected_revision: snap.revision, command: { action, ...extra } }); }
    catch (e) {
      if (operationOwner() !== owner || playbackPending !== receipt) return;
      if (!uncertain(e)) { playbackPending = null; drawPlaybackReceipt(); throw e; }
      receipt.phase = 'unknown';
      drawPlaybackReceipt();
      status('操作结果尚未确认，请查询原操作。不要重复执行下一首等相对操作。', true);
      return;
    }
    if (operationOwner() !== owner || playbackPending !== receipt) return;
    if (result && result.state && /preparing|scheduled/.test(result.state.status)) receipt.phase = 'scheduled';
    else playbackPending = null;
    drawPlaybackReceipt();
    status(operationText(result));
  }
  function drawPlaybackReceipt() {
    if (chrome && chrome.setPlaybackUncertain) chrome.setPlaybackUncertain(!!playbackPending && playbackPending.owner === operationOwner() && playbackPending.phase !== 'scheduled');
    if (!refs.operations) return;
    const receipt = playbackPending;
    refs.operations.replaceChildren();
    if (!receipt || receipt.owner !== operationOwner()) return;
    refs.operations.append(h('span', '', '操作 ' + receipt.id), button('查询操作结果', async () => {
      const key = sessionKey();
      if (playbackPending !== receipt || receipt.owner !== operationOwner()) return;
      const value = await peer({ action: 'operation', operation_id: receipt.id });
      if (!current(key) || playbackPending !== receipt || receipt.owner !== operationOwner()) return;
      if (value && value.state && /^(applied|superseded|no_op|failed)$/.test(value.state.status || value.state)) { playbackPending = null; drawPlaybackReceipt(); }
      else if (value && value.state && /^(preparing|scheduled)$/.test(value.state.status || value.state)) { receipt.phase = 'scheduled'; drawPlaybackReceipt(); }
      status(operationText(value));
    }));
  }
  function queueContextError(message) { return Object.assign(new Error(message), { code: 'room_context_changed', status: 409 }); }
  function drawQueueReceipt() {
    if (!refs.queueOperations) return;
    refs.queueOperations.replaceChildren();
    const receipt = queuePending;
    if (!receipt || receipt.owner !== operationOwner()) return;
    refs.queueOperations.append(h('p', '', receipt.id ? '队列操作 ' + receipt.id + (receipt.phase === 'unknown' ? ' · 结果未确认，请先查询原操作。' : ' · 正在提交，请勿重复添加。') : '正在准备队列操作，请勿重复添加。'));
    if (receipt.id && receipt.phase === 'unknown') refs.queueOperations.append(button('查询原队列操作结果', async () => {
      const key = sessionKey();
      if (queuePending !== receipt || receipt.owner !== operationOwner()) return;
      let value;
      try { value = await peer({ action: 'operation', operation_id: receipt.id }); }
      catch (error) {
        if (!current(key) || queuePending !== receipt) return;
        if (error.code === 'operation_unknown') { status('原队列操作记录不存在或已过期，无法证明它未生效。请核对共同队列；结果确认前不会重复添加。', true); return; }
        throw error;
      }
      if (!current(key) || queuePending !== receipt || receipt.owner !== operationOwner()) return;
      const state = value && value.state && (value.state.status || value.state);
      if (/^(applied|superseded|no_op|failed)$/.test(state || '')) { queuePending = null; drawQueueReceipt(); }
      status(operationText(value));
    }), button('放弃这次待确认队列操作', async () => {
      const key = sessionKey();
      if (queuePending !== receipt || receipt.owner !== operationOwner() || receipt.phase !== 'unknown') return;
      if (!await confirmAction('原队列操作可能已经生效，请先检查共同队列。放弃本机待确认记录？这不会撤销或重放原操作。')) return;
      if (!current(key) || queuePending !== receipt || receipt.owner !== operationOwner() || receipt.phase !== 'unknown') return;
      queuePending = null; drawQueueReceipt();
      status('已放弃本机待确认记录。原队列操作可能已经生效，请检查共同队列；原操作没有撤销或重放。');
    }));
  }
  function operationText(v) { const labels = { preparing: '正在准备音频', scheduled: '已安排，等待生效', applied: '已生效', superseded: '已被后续操作取代', no_op: '当前已是此状态', failed: '操作未生效' }; const key = v && v.state && (v.state.status || v.state); return labels[key] || '操作已受理'; }
  async function run(fn) {
    if (busy) return;
    if (!root) return;
    const key = sessionKey(), runRoot = root;
    busy = true; runRoot.setAttribute('aria-busy', 'true'); status('正在处理…');
    try { const result = await fn(); if (!current(key)) return; await poll(true); if (current(key) && refs.notice && refs.notice.textContent === '正在处理…') status(result && result.state ? operationText(result) : '操作已受理'); }
    catch (e) { if (current(key)) status(e.message || '操作失败，请检查连接后重试。', true); }
    finally { busy = false; runRoot.setAttribute('aria-busy', 'false'); }
  }
  function section(parent, title, cls) { const e = h('section', 'room-section ' + (cls || '')); e.append(h('h3', '', title)); parent.append(e); return e; }
  function createView() {
    return global.HertzRoomView.create({
      h, button, field, select, section, refs, selection, metadata, command, control, playback, run, status,
      sessionKey, current, confirmAction, loadLocal, appendResource, mutateQueue, loadChat, resetChat, sendChat,
      snapshot: () => snap, root: () => root, workspace: () => workspace, queueOffset: () => queuePage,
      onReturn: () => onReturn(), localVolume: volume => global.HertzRoom.localVolume(volume),
      async pageQueue(direction) { queuePage = Math.max(0, Math.min(Math.max(0, Number(snap.queue_count || 0) - 1), queuePage + direction * pageSize)); queuePage = Math.floor(queuePage / pageSize) * pageSize; await loadQueue(); },
      async pageLibrary(direction) { libraryPage = Math.max(0, Math.min(Math.max(0, Number(snap.shared_count || 0) - 1), libraryPage + direction * pageSize)); libraryPage = Math.floor(libraryPage / pageSize) * pageSize; await loadLibrary(); },
      cycleMode() { const modes = ['repeat', 'repeat_one', 'shuffle']; return control('mode', { mode: modes[(modes.indexOf(snap.play_mode) + 1) % modes.length] }); },
      vote(instance_id, voted) { return control('vote', { instance_id, voted }); },
      queueOrder(mode) { return control('queue_order', { mode }); },
      async applyForRoom(candidate, name, listen) {
        if (admissionRequest) throw new Error('请先查看当前入房申请结果，或显式清除本机申请记录');
        const key = sessionKey(), address = (candidate.addresses || [])[0];
        if (!address || !candidate.fingerprint || !candidate.room_code) throw new Error('该房间尚不支持入房申请，请向房主获取邀请');
        if (!name.trim()) throw new Error('请输入显示名称');
        if (!await confirmAction('申请加入「' + candidate.name + '」？\n主机：' + address + '\n指纹：' + candidate.fingerprint + '\n发现信息不能证明主机身份，请与房主核对指纹。') || !current(key)) return;
        const target = { address, fingerprint: candidate.fingerprint, room_id: candidate.room_id };
        const result = await command({ action: 'apply', ...target, room_code: candidate.room_code, name: name.trim() });
        if (!current(key)) return;
        admissionRequest = { ...target, application_id: result.application_id, applicant_secret: result.applicant_secret, name: name.trim(), listen, roomName: candidate.name, expiresAt: Date.now() + Number(result.expires_in_seconds || 300) * 1000, joinAttempted: false };
        view.drawApplication({ name: candidate.name, state: 'pending' }); status('入房申请已提交，等待房主处理。');
      },
      async checkApplication(retryJoin = false) {
        const request = admissionRequest, key = sessionKey();
        if (!request) throw new Error('当前没有待处理申请');
        const { address, fingerprint, room_id, application_id, applicant_secret } = request;
        let result;
        try { result = await command({ action: 'admission_status', address, fingerprint, room_id, application_id, applicant_secret }); }
        catch (error) { if (current(key) && admissionRequest === request) view.drawApplication({ name: request.roomName, state: 'status_failed' }); throw error; }
        if (!current(key) || admissionRequest !== request) return;
        if (Number.isFinite(Number(result.expires_in_seconds))) request.expiresAt = Date.now() + Number(result.expires_in_seconds) * 1000;
        if (result.state === 'approved') {
          if (!result.invitation) { view.drawApplication({ name: request.roomName, state: 'status_failed' }); throw new Error('审批已通过，但未取得有效邀请，请重新核对申请状态'); }
          request.invitation = result.invitation;
          // A failed/uncertain join is never repeated by status polling. The
          // user must explicitly retry after a fresh approved response.
          if (request.joinAttempted && !retryJoin) { view.drawApplication({ name: request.roomName, state: 'approved_retry' }); return; }
          request.joinAttempted = true; view.drawApplication({ name: request.roomName, state: 'approved' });
          try {
            await command({ action: 'join', invitation: request.invitation, name: request.name, listen: request.listen });
            if (current(key) && admissionRequest === request) admissionRequest = null;
          } catch (error) {
            if (current(key) && admissionRequest === request) view.drawApplication({ name: request.roomName, state: uncertain(error) ? 'join_unknown' : 'join_failed' });
            throw error;
          }
        } else {
          view.drawApplication({ name: request.roomName, state: result.state });
          if (result.state === 'rejected' || result.state === 'consumed' || result.state === 'expired') admissionRequest = null;
        }
      },
      async forgetApplication() {
        const request = admissionRequest, key = sessionKey();
        if (!request || !await confirmAction('清除本机申请记录？申请可能已批准或用于入房，此操作不会撤销房主的批准。') || !current(key) || admissionRequest !== request) return;
        admissionRequest = null; view.drawApplication({ name: request.roomName, state: 'cleared' });
      },
      reviewApplication(application_id, approve) { return command({ action: 'admission_review', application_id, approve, permissions: { listen: true, queue: false, transport: false, volume: false, chat_read: true, chat_send: true, invite: false } }); },
      revokeApplication(application_id) { return command({ action: 'admission_revoke', application_id }); },
      makeInvitation(permissions) { return snap.mode === 'host' ? command({ action: 'invite', permissions }) : peer({ action: 'invite' }); },
      async revokeInvitation(id) {
        const key = sessionKey(), target = id || invitationId;
        if (!target) throw new Error('当前没有可撤销的邀请');
        const result = await (snap.mode === 'host' ? command({ action: 'revoke_invitation', invitation_id: target }) : peer({ action: 'revoke_invitation', invitation_id: target }));
        if (current(key) && target === invitationId) { invitationId = ''; invitationExpires = 0; refs.invitation.value = ''; refs.invitationQr.replaceChildren(); refs.invitationExpiry.textContent = '邀请已撤销'; refs.revokeInvitation.disabled = true; }
        return result;
      },
      async setDiscoverable(enabled) { try { return await command({ action: 'discoverable', enabled }); } catch (error) { if (refs.discoverable) refs.discoverable.checked = snap.discoverable !== false; throw error; } },
      attachFavorite,
      appendCurrentSong() { if (!snap.current_track) throw new Error('当前没有共享歌曲'); return appendResource(snap.current_track.resource_id); },
      shareSong(resource) { return shareSong(resource); },
      shareCurrentSong() {
        if (!snap.current_track) throw new Error('当前没有共享歌曲');
        return shareSong(snap.current_track.resource_id);
      },
      invitationGenerated(value, id) {
        if (!value) throw new Error('服务未返回有效邀请');
        invitationExpires = Date.now() + 5 * 60 * 1000;
        invitationId = id || ''; refs.revokeInvitation.disabled = !invitationId;
        refs.invitationExpiry.textContent = '一次性邀请 · 五分钟内有效'; refs.invitationQr.replaceChildren();
        try {
          if (!global.qrcode) throw new Error('二维码组件不可用');
          const qr = global.qrcode(0, 'M'); qr.addData(value); qr.make();
          const size = qr.getModuleCount(), quiet = 4, scale = Math.max(2, Math.floor(256 / (size + quiet * 2)));
          const canvas = h('canvas'); canvas.width = canvas.height = (size + quiet * 2) * scale;
          const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#130921';
          for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (qr.isDark(row, col)) context.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
          refs.invitationQr.append(canvas);
        } catch (_) { refs.invitationQr.append(h('p', 'room-sub', '二维码暂时不可用，请复制邀请。')); }
      },
      validInvitation() { return Date.now() < invitationExpires ? refs.invitation.value : ''; }
    });
  }
  function shareSong(resource) {
    if (chatUnknown || chatSending || refs.chatInput.value.trim()) throw new Error('请先处理聊天输入框中的消息');
    workspace.navigate('collaborate', true); view.selectTab('chat');
    return sendChat(resource);
  }
  function mount() {
    const key = snap.mode === 'local' ? 'local' : 'active';
    const roomSession = sessionKey();
    if (playbackPending && playbackPending.owner !== operationOwner()) playbackPending = null;
    if (queuePending && queuePending.owner !== operationOwner()) queuePending = null;
    if (mounted === key && mountedSession === roomSession) return;
    const preservePage = mounted === 'active' && key === 'active' && workspaceOwner === operationOwner() && workspace;
    const previousPage = preservePage && workspace.currentPage();
    const previousTab = preservePage && workspace.pages.collaborate.dataset.tab;
    const draft = preservePage && refs.chatInput ? refs.chatInput.value : '';
    const preservedReceipt = preservePage && chatReceipt && chatReceipt.owner === operationOwner() ? chatReceipt : null;
    mountedSession = roomSession; metadata.clear(); selection.clear(); chatReceipt = preservedReceipt; chatUnknown = preservedReceipt ? preservedReceipt.id : null; chatSending = null; chatSongPending = preservedReceipt && preservedReceipt.songTitle || null; resetChat(); chatLoading = null;
    mounted = key; favoriteSignature = ''; memberSignature = ''; queueSignature = ''; librarySignature = ''; resourceGeneration++; resourceKey = ''; resourceSignature = ''; lyrics = []; if (coverUrl) URL.revokeObjectURL(coverUrl); coverUrl = ''; root.replaceChildren(); Object.keys(refs).forEach(k => delete refs[k]);
    invitationExpires = 0; invitationId = '';
    workspace = global.HertzRoomWorkspace.create(root, { h, button, refs, active: key === 'active', onReturn, onNavigate });
    if (key === 'local') view.mountEntry(); else { view.mountActive(); revision = ''; historyRevision = ''; messages = []; lastChatId = ''; libraryPage = 0; queuePage = 0; }
    workspace.render(snap);
    workspaceOwner = operationOwner();
    if (previousPage) workspace.navigate(previousPage);
    if (previousTab) view.selectTab(previousTab);
    if (draft && refs.chatInput) refs.chatInput.value = draft;
    if (key === 'active') admissionRequest = null;
    drawPlaybackReceipt(); drawQueueReceipt();
    if (key === 'active') { drawChatReceipt(); syncChatComposer(); }
  }
  async function sendChat(songResource) {
    if (chatReceipt || chatUnknown || chatSending) throw new Error('请先确认上一条消息的发送结果。');
    if (snap.chat && snap.chat.config && !snap.chat.config.enabled) throw new Error('房间聊天已关闭。');
    const key = sessionKey(), text = refs.chatInput.value.trim();
    if (!songResource && !text) return;
    if (!songResource && ([...text].length > 200 || new TextEncoder().encode(text).length > 800)) throw new Error('消息最多200字、800字节');
    if (songResource) { const song = snap.current_track && snap.current_track.resource_id === songResource ? snap.current_track : metadata.get(songResource); chatSongPending = song ? song.title : '共享歌曲'; }
    const id = op(true), receipt = { id, owner: operationOwner(), draft: refs.chatInput.value, songTitle: chatSongPending, kind: songResource ? 'song' : 'text' };
    chatReceipt = receipt; chatSending = id; syncChatComposer();
    try {
      await peer(songResource ? { action: 'chat_song', operation_id: id, resource_id: songResource } : { action: 'chat_send', operation_id: id, text });
      if (!current(key) || chatReceipt !== receipt || receipt.owner !== operationOwner()) return;
      clearChatReceipt();
    } catch (error) {
      if (!current(key) || chatReceipt !== receipt || receipt.owner !== operationOwner()) return;
      if (!uncertain(error)) { clearChatReceipt(false); throw error; }
      chatUnknown = id; drawChatReceipt(); syncChatComposer();
      status('发送结果未确认，请先查询原操作。', true); return;
    } finally {
      if (current(key) && chatSending === id) { chatSending = null; syncChatComposer(); }
    }
    resetChat(); await loadChat();
  }
  function drawChatReceipt() {
    refs.chatOperation.replaceChildren();
    const receipt = chatReceipt;
    if (!receipt || receipt.owner !== operationOwner() || !chatUnknown) return;
    refs.chatOperation.append(h('p', '', receipt.kind === 'song' ? '歌曲卡片发送结果未确认。' : '发送结果未确认，原文已保留。'), button('查询这条消息的发送结果', async () => {
      const key = sessionKey();
      if (chatReceipt !== receipt || receipt.owner !== operationOwner()) return;
      try {
        const result = await peer({ action: 'chat_operation', operation_id: receipt.id });
        if (!current(key) || chatReceipt !== receipt || receipt.owner !== operationOwner()) return;
        if (result.status === 'applied') { clearChatReceipt(); resetChat(); await loadChat(); status('消息已发送。'); }
      } catch (queryError) {
        if (!current(key) || chatReceipt !== receipt) return;
        if (queryError.code === 'operation_unknown') status('该操作记录不存在或已过期，无法证明消息未发送。可检查历史，或显式放弃这次待确认消息。', true);
        else throw queryError;
      }
    }), button('放弃这次待确认消息', async () => {
      const key = sessionKey();
      if (chatReceipt !== receipt || !await confirmAction('消息可能已经发送。放弃待确认状态并清空原文？不会重新发送。') || !current(key) || chatReceipt !== receipt) return;
      clearChatReceipt();
    }));
  }
  function clearChatReceipt(clearDraft = true) {
    const receipt = chatReceipt;
    if (clearDraft && receipt && refs.chatInput.value === receipt.draft) refs.chatInput.value = '';
    chatReceipt = null; chatUnknown = null; chatSending = null; chatSongPending = null; refs.chatOperation.replaceChildren();
    syncChatComposer();
  }
  function syncChatComposer() { refs.chatInput.disabled = refs.chatSend.disabled = !(snap.permissions || {}).chat_send || !!chatUnknown || !!chatSending || !!(snap.chat && snap.chat.config && !snap.chat.config.enabled); refs.chatSongPending.hidden = !chatSongPending; refs.chatSongPending.textContent = chatSongPending ? '歌曲卡片' + (chatUnknown ? ' · 结果待确认：' : ' · 正在发送：') + chatSongPending : ''; }
  function resetChat() { messages = []; lastChatId = ''; historyRevision = ''; chatBefore = null; chatHasMore = false; chatBrowsing = false; chatLoading = null; chatSharingRevision = snap.sharing_revision || ''; chatHistorySharingRevision = ''; }
  function renderChatMessages() {
    const key = sessionKey();
    refs.chat.replaceChildren(); messages.forEach(m => { const e = h('li'); view.drawMessage(m, e); if (snap.mode === 'host') e.append(button('删除', async () => { if (!current(key) || !await confirmAction('删除这条聊天消息？') || !current(key)) return; await command({ action: 'chat_admin', command: { action: 'delete', message_id: m.message_id } }); if (!current(key)) return; resetChat(); await loadChat(); })); refs.chat.append(e); });
  }
  function metric(label, value) { refs.metrics.append(h('dt', '', label), h('dd', 'room-mono', value == null ? '待测量' : value)); }
  function update() {
    mount(); workspace.render(snap); if (mounted !== 'active') { if (snap.last_error) status(snap.last_error, true); return; }
    refs.title.textContent = snap.name || '一起听'; const host = snap.mode === 'host', p = snap.permissions || {};
    refs.connection.textContent = { host: '房主', guest: '已连接', reconnecting: '正在重连', disconnected: '连接已断开' }[snap.mode] || snap.mode;
    refs.format.textContent = snap.format ? snap.format.sample_rate / 1000 + ' kHz · ' + snap.format.channels + ' 声道 · 无损 PCM' : '等待房间格式';
    (snap.tracks || []).forEach(t => metadata.set(t.resource_id, t)); while (metadata.size > 2000) metadata.delete(metadata.keys().next().value);
    const item = (snap.queue || []).find(q => q.instance_id === snap.track_instance_id), track = snap.current_track || item && metadata.get(item.resource_id);
    updateCurrentFavorite(track);
    refs.current.textContent = track ? track.title : snap.playing ? '正在播放共享歌曲' : '选择一首共享歌曲'; refs.artist.textContent = track && track.artist || '共享歌曲只在当前房间内可用'; refs.position.textContent = Math.floor(Number(snap.position_ms || 0) / 60000) + ':' + String(Math.floor(Number(snap.position_ms || 0) / 1000) % 60).padStart(2, '0');
    const playbackBlocked = playbackPending && playbackPending.owner === operationOwner() && playbackPending.phase !== 'scheduled';
    view.updatePlayButton(snap.playing); [refs.play, refs.prev, refs.next, refs.stop, refs.seekButton].forEach(b => { b.disabled = !p.transport || snap.mode === 'reconnecting' || !!playbackBlocked; b.title = !p.transport ? '房主未授权播控' : playbackBlocked ? '请先查询原播放操作的结果' : snap.mode === 'reconnecting' ? '等待房间恢复连接' : b.getAttribute ? b.getAttribute('aria-label') || b.textContent : b.textContent; });
    const duration = Number(track && track.duration_ms || 0);
    const elapsed = Math.max(0, Number(snap.position_ms || 0));
    refs.duration.textContent = Math.floor(duration / 60000) + ':' + String(Math.floor(duration / 1000) % 60).padStart(2, '0');
    if (document.activeElement !== refs.progress) refs.progress.value = duration ? Math.round(Math.min(elapsed / duration, 1) * 1000) : 0;
    refs.progress.disabled = !p.transport || !duration || snap.mode === 'reconnecting' || !!playbackBlocked;
    refs.playingBadge.textContent = snap.playing ? '正在播放' : track ? '已暂停' : '等待共享歌曲';
    refs.album.textContent = track && track.album || ''; refs.album.hidden = !refs.album.textContent;
    refs.quickMode.textContent = { repeat: '列表循环', repeat_one: '单曲循环', shuffle: '随机播放' }[snap.play_mode] || '列表循环'; refs.quickMode.disabled = !p.queue;
    refs.songAppend.disabled = !track || !p.queue; refs.songShare.disabled = !track || !p.chat_send;
    refs.guestInvite.hidden = host || !!p.invite; refs.invitePerms.hidden = !host; refs.activeRoomName.textContent = snap.name || '一起听房间';
    refs.queueCount.textContent = Number(snap.queue_count || 0) + ' 首歌曲';
    refs.orderControl.hidden = !host || !snap.collaboration; refs.order.value = snap.collaboration && snap.collaboration.queue_order || 'manual';
    view.drawActivity(snap.collaboration && snap.collaboration.activity || []);
    view.drawAdmissions(snap.admission);
    view.drawInvitationManagement();
    if (invitationExpires && Date.now() >= invitationExpires) { invitationExpires = 0; invitationId = ''; refs.revokeInvitation.disabled = true; refs.invitation.value = ''; refs.invitationQr.replaceChildren(); refs.invitationExpiry.textContent = '邀请已过期，请重新生成'; }
    refs.sharing.hidden = !host; refs.invites.hidden = !host && !p.invite; refs.hostDsp.hidden = !host; refs.chatAdmin.hidden = !host; refs.sleep.hidden = !host; refs.volumeApply.disabled = !p.volume; refs.modeApply.disabled = !p.queue;
    refs.sleepStatus.textContent = snap.sleep_timer_remaining_seconds == null ? '未设置定时' : '剩余 ' + Math.ceil(Number(snap.sleep_timer_remaining_seconds) / 60) + ' 分钟';
    const chatConfig = snap.chat && snap.chat.config || {};
    syncChatComposer();
    refs.chatStatus.textContent = p.chat_read ? snap.chat_error || snap.chat && snap.chat.error || (chatConfig.enabled === false ? '房间聊天已关闭。' : chatConfig.retained === false ? '仅实时聊天，消息不保存，重启后不可恢复。' : '文字与歌曲卡片只在房间内分享。') : '房主未授权查看聊天。';
    const o = snap.output || {}; refs.outputStatus.textContent = !o.enabled ? '本机音频已关闭' : o.error || (o.ready ? '输出时钟已就绪' : '正在等待对时与设备时间戳');
    refs.quickVolume.disabled = !o.enabled; if (document.activeElement !== refs.quickVolume) refs.quickVolume.value = Math.round(Number((o.settings || {}).volume ?? 1) * 100);
    refs.testOutput.disabled = !o.ready || !!snap.playing || !!snap.pending || !!snap.scheduled;
    refs.metrics.replaceChildren(); metric('网络对时误差', o.clock ? (Number(o.clock.uncertainty_ns) / 1e6).toFixed(3) + ' ms' : null); metric('设备漂移', o.device ? Number(o.device.device_clock_ppm).toFixed(2) + ' ppm' : null); metric('输入缓冲', o.buffered_input_frames); metric('欠载帧数', o.underrun_frames); if (o.binding) { metric('实际设备', o.binding.device); metric('设备采样率', (o.binding.sample_rate / 1000) + ' kHz'); } if (o.preferences_error) status(o.preferences_error, true);
    if (revision === '') { refs.outputEnabled.checked = o.desired_enabled == null ? !!o.enabled : !!o.desired_enabled; const settings = o.settings || {}; refs.localVolume.value = Math.round((settings.volume == null ? 1 : settings.volume) * 100); if (settings.device_id) { refs.device.append(new Option(settings.device_id, settings.device_id)); refs.device.value = settings.device_id; } refs.correction.value = settings.latency_correction_ms || 0; refs.roomVolume.value = Math.round((snap.volume || 0) * 100); refs.mode.value = snap.play_mode || 'repeat'; refs.loudness.value = snap.loudness_mode || 'off'; refs.fade.value = snap.crossfade_ms || 0; refs.preamp.value = snap.dsp && snap.dsp.preamp_db || 0; refs.eq.forEach((e, i) => e.value = snap.dsp && snap.dsp.eq_gains_db[i] || 0); selection.clear(); (snap.shared_track_ids || []).forEach(id => selection.add(id)); if (host) loadLocal('').catch(() => {}); }
    const key = sessionKey(), queueKey = [snap.revision, snap.track_instance_id, !!p.queue, !!p.transport, !!p.chat_send].join(':');
    // Background projections can race natural playback or sharing changes.
    // Invalidate only; the next poll rereads without replaying any writes.
    if (queueKey !== queueSignature) { queueSignature = queueKey; loadQueue().catch(e => { if (current(key) && queueSignature === queueKey) { queueSignature = ''; if (e.code !== 'revision_conflict') status(e.message, true); } }); }
    const libraryKey = [snap.sharing_revision || snap.revision, !!p.queue, !!p.chat_send].join(':');
    if (libraryKey !== librarySignature) { librarySignature = libraryKey; loadLibrary().catch(e => { if (current(key) && librarySignature === libraryKey) { librarySignature = ''; if (e.code !== 'revision_conflict') status(e.message, true); } }); }
    revision = snap.revision;
    const members = JSON.stringify(snap.members || []); if (members !== memberSignature) { memberSignature = members; view.drawMembers(); }
    updateResources(track);
    if (snap.error || snap.local_error) status(snap.local_error || snap.error, true);
    if (!p.chat_read) { resetChat(); refs.chat.replaceChildren(); refs.danmaku.replaceChildren(); refs.chatOlder.disabled = true; }
    if (p.chat_read && chatSharingRevision !== (snap.sharing_revision || '')) {
      chatSharingRevision = snap.sharing_revision || ''; chatLoading = null;
      messages = messages.map(message => message.content_kind === 'song' ? { ...message, song: null } : message);
      // Revoke already-rendered cards synchronously; never leave their old
      // metadata/actions visible while a replacement history read is pending.
      renderChatMessages();
    }
    if (p.chat_read) { const key = sessionKey(); loadChat().catch(e => { if (current(key)) refs.chatStatus.textContent = e.message || '聊天暂时不可用'; }); }
  }
  async function allQueue() {
    const key = sessionKey(), revision = snap.revision, count = snap.queue_count || 0, queue = [];
    for (let offset = 0; offset < Math.min(2000, count); offset += pageSize) {
      const page = await peer({ action: 'queue_page', offset, limit: pageSize, revision });
      if (key !== sessionKey() || page.revision !== revision) throw new Error('队列已经更新，请刷新后重试。');
      queue.push(...page.queue);
    }
    return { queue, revision };
  }
  async function mutateQueue(change) {
    const owner = operationOwner();
    if (!owner) throw queueContextError('正在读取房间身份，请稍后重试。');
    if (queuePending && queuePending.owner === owner) throw Object.assign(new Error(queuePending.phase === 'unknown' ? '原队列操作结果未确认，请返回一起听查询原队列操作结果后再添加。' : '正在处理原队列操作，请勿重复添加。'), { code: 'room_queue_pending', status: 409, operation_id: queuePending.id });
    // Reserve before any read or stable-reference resolution. Every queue edit,
    // including Favorites entry points, shares this one pending operation.
    const receipt = { owner, id: null, phase: 'reading' };
    queuePending = receipt; drawQueueReceipt();
    try {
      const snapshot = await allQueue();
      const queue = await change(snapshot.queue);
      if (operationOwner() !== owner || queuePending !== receipt) throw queueContextError('房间会话已改变，请重新选择收藏');
      if (!queue) { queuePending = null; drawQueueReceipt(); return; }
      receipt.id = op(false); receipt.phase = 'sending'; drawQueueReceipt();
      const result = await peer({ action: 'queue', operation_id: receipt.id, expected_revision: snapshot.revision, items: queue.map(q => ({ instance_id: q.instance_id == null ? null : q.instance_id, resource_id: q.resource_id })) });
      if (operationOwner() !== owner || queuePending !== receipt) throw queueContextError('房间会话已改变，请在原房间核对队列结果');
      const state = result && result.state && (result.state.status || result.state);
      if (state === 'failed') throw Object.assign(new Error('队列操作未生效'), { code: 'room_queue_failed', status: 422 });
      if (!/^(applied|no_op)$/.test(state || '')) throw Object.assign(new Error('队列结果未确认'), { code: 'room_outcome_unknown' });
      queuePending = null; drawQueueReceipt(); return result;
    } catch (error) {
      if (operationOwner() !== owner || queuePending !== receipt) throw queueContextError('房间会话已改变，请在原房间核对队列结果');
      if (receipt.id && uncertain(error)) {
        receipt.phase = 'unknown'; drawQueueReceipt();
        error.operation_id = receipt.id; error.owner = owner;
        error.message = '队列操作 ' + receipt.id + ' 结果未确认，请返回一起听查询原队列操作结果后再添加；未自动重试。';
      } else { queuePending = null; drawQueueReceipt(); }
      throw error;
    }
  }
  async function appendResource(resource) { return mutateQueue(queue => queue.concat({ resource_id: resource })); }
  function favoriteInput(track, key = sessionKey()) {
    if (!track || !track.favorite_key || !global.Favorites || !/^[a-f0-9]{64}$/.test(track.favorite_key)) return null;
    const localId = snap.mode === 'host' && (snap.favorite_local_ids || {})[track.favorite_key];
    if (snap.mode === 'host' && !localId) return null;
    if (!localId && !/^[a-f0-9]{64}$/.test(snap.fingerprint || '')) return null;
    return { kind: 'track', source: localId ? 'local' : 'lan', ref_id: localId || snap.fingerprint + ':' + track.favorite_key,
      title: track.title, artist: track.artist, album: track.album, duration_ms: track.duration_ms, isCurrent: () => current(key) };
  }
  function attachFavorite(parent, track) {
    const input = favoriteInput(track);
    if (input) {
      const button = global.Favorites.attachHeart(parent, input);
      if (button) button.classList.add('room-favorite');
    }
  }
  async function syncFavorites(tracks, key) {
    if (!global.Favorites) return;
    const groups = new Map();
    tracks.forEach(track => { const input = favoriteInput(track, key); if (!input) return; if (!groups.has(input.source)) groups.set(input.source, new Set()); groups.get(input.source).add(input.ref_id); });
    await Promise.all([...groups].map(([source, ids]) => global.Favorites.syncMembership('track', source, [...ids], () => current(key))));
  }
  function updateCurrentFavorite(track) {
    if (!refs.songFavorite) return;
    const input = favoriteInput(track), signature = input ? input.source + ':' + input.ref_id : '';
    if (signature === favoriteSignature) return;
    favoriteSignature = signature; refs.songFavorite.replaceChildren();
    if (input) { attachFavorite(refs.songFavorite, track); const key = sessionKey(); syncFavorites([track], key); }
  }
  async function activateFavorite(favorite) {
    if (!favorite || favorite.source !== 'lan' || !/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(favorite.ref_id || '')) throw new Error('局域网收藏引用无效，请重新收藏');
    await poll(true);
    if (!root || snap.mode === 'local') throw new Error('请先连接收藏歌曲的原房主');
    const [host, target] = favorite.ref_id.split(':');
    if (host !== snap.fingerprint) throw new Error('当前房主与收藏来源不同，请连接原房主');
    if (snap.mode !== 'host' && snap.mode !== 'guest') throw new Error('原房主当前离线或正在重连，请连接恢复后再试');
    if (!(snap.permissions || {}).queue) throw new Error('房主尚未授权编辑共同队列');
    const key = sessionKey();
    return mutateQueue(async queue => {
      const resolved = await peer({ action: 'resolve_favorites', keys: [target] });
      if (!current(key)) throw queueContextError('房间会话已改变，请重新选择收藏');
      const track = (resolved.tracks || []).find(track => track.favorite_key === target);
      if (!track) throw Object.assign(new Error('原房主已撤销这首歌曲的分享；收藏信息仍保留'), { code: 'room_share_revoked', status: 403 });
      return queue.concat({ resource_id: track.resource_id });
    });
  }
  async function loadQueue() {
    const key = sessionKey(), expected = snap.revision, offset = queuePage;
    const v = await peer({ action: 'queue_page', offset, limit: pageSize, revision: expected });
    if (!current(key) || queuePage !== offset || snap.revision !== expected || v.revision !== expected) return;
    (v.tracks || []).forEach(t => metadata.set(t.resource_id, t));
    await syncFavorites(v.tracks || [], key);
    if (current(key) && queuePage === offset && snap.revision === expected) view.drawQueue(v.queue || []);
  }
  async function loadLibrary() {
    const key = sessionKey(), expected = snap.sharing_revision || null, offset = libraryPage;
    const v = await peer({ action: 'library', offset, limit: pageSize, revision: expected });
    if (!current(key) || libraryPage !== offset || expected !== (snap.sharing_revision || null) || (expected && v.revision !== expected)) return;
    await syncFavorites(v.tracks || [], key);
    if (current(key) && libraryPage === offset && expected === (snap.sharing_revision || null)) view.drawLibrary(v.tracks || []);
  }
  async function loadLocal(q) { const key = sessionKey(); const page = await transport.get('/v1/tracks?limit=1000&q=' + encodeURIComponent(q || '')); if (key !== sessionKey() || mounted !== 'active') return; refs.localTracks.replaceChildren(); (page.tracks || []).filter(t => t.source === 'local' && !t.id.startsWith('online:')).forEach(t => { const label = h('label', 'room-local-item'), input = h('input'); input.type = 'checkbox'; input.checked = selection.has(t.id); input.onchange = () => input.checked ? selection.add(t.id) : selection.delete(t.id); label.append(input, h('span', '', t.title)); refs.localTracks.append(label); }); }
  async function loadChat(older) {
    if (chatLoading || mounted !== 'active' || !(snap.permissions || {}).chat_read) return;
    if (chatBrowsing && !older) {
      const latest = snap.chat && snap.chat.history_revision || snap.recent_chat && snap.recent_chat.history_revision;
      if ((!latest || latest === historyRevision) && chatHistorySharingRevision === (snap.sharing_revision || '')) return;
      resetChat();
    }
    if (older && !chatHasMore) return;
    const key = sessionKey(), request = {}, sharing = snap.sharing_revision || '';
    const before = older ? chatBefore : null;
    chatLoading = request;
    try {
      const page = await peer({ action: 'chat_history', before, revision: historyRevision || null });
      if (chatLoading !== request || !current(key) || !(snap.permissions || {}).chat_read || sharing !== (snap.sharing_revision || '')) return;
      const reset = !!page.cursor_invalidated || historyRevision && historyRevision !== page.history_revision;
      if (reset) resetChat();
      historyRevision = page.history_revision;
      chatHistorySharingRevision = sharing;
      if (page.cursor_invalidated) { status('聊天历史已更新，正在重新加载。'); return; }
      chatBrowsing = !!older;
      chatHasMore = !!page.has_more; chatBefore = page.next_before || null;
      if (page.next_operation_id) chatSequence = chatSequence > counter(page.next_operation_id) ? chatSequence : counter(page.next_operation_id);
      const known = new Map(messages.map((m, index) => [m.message_id, index]));
      const recent = !older && snap.recent_chat && snap.recent_chat.history_revision === page.history_revision ? snap.recent_chat.messages || [] : [];
      recent.concat(page.messages || []).forEach(m => {
        // A fresh history read can revoke a song reference without changing
        // the message identity. Replace its projection, including null songs.
        if (known.has(m.message_id)) { messages[known.get(m.message_id)] = m; return; }
        known.set(m.message_id, messages.length); messages.push(m);
        if (!reset && !older && lastChatId && counter(m.message_id) > counter(lastChatId) && Date.now() - Number(m.received_at_ms) < 5000) animateMessage(m);
      });
      messages.sort((a, b) => counter(a.message_id) < counter(b.message_id) ? -1 : 1);
      messages = older ? messages.slice(0, 200) : messages.slice(-200);
      while (new TextEncoder().encode(JSON.stringify(messages)).length > 512 * 1024) { if (older) messages.pop(); else messages.shift(); }
      if (messages.length) lastChatId = messages[messages.length - 1].message_id;
      refs.chatOlder.disabled = !chatHasMore;
      renderChatMessages();
      if (page.earlier_cleaned) refs.chatStatus.textContent = '较早消息已按保留策略清理。';
    } finally { if (chatLoading === request) chatLoading = null; }
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
    const id = track && track.resource_id || '';
    const signature = JSON.stringify([id, snap.sharing_revision || '', !!(track && track.has_cover)]);
    // A shared resource UUID survives re-sharing and cover replacement. Bind
    // each fetch generation to its authorized sharing projection as well.
    if (resourceSignature !== signature) { resourceSignature = signature; resourceKey = id; const generation = ++resourceGeneration; lyrics = []; refs.lyrics.replaceChildren(); delete refs.lyrics.dataset.key; refs.cover.hidden = true; if (coverUrl) URL.revokeObjectURL(coverUrl); coverUrl = '';
      if (id) { if (track.has_cover) resource(id, 'cover').then(blob => { if (generation !== resourceGeneration) return; coverUrl = URL.createObjectURL(blob); refs.cover.src = coverUrl; refs.cover.hidden = false; }).catch(() => {});
        resource(id, 'lyrics').then(blob => blob.text()).then(text => { if (generation !== resourceGeneration) return; const doc = JSON.parse(text); lyrics = Array.isArray(doc.lines) ? doc.lines : []; delete refs.lyrics.dataset.key; drawLyrics(); }).catch(() => {}); }
    }
    drawLyrics();
  }
  function drawLyrics() {
    const position = Number(snap.position_ms || 0); let index = 0; while (index + 1 < lyrics.length && lyrics[index + 1].start_ms <= position) index++;
    const key = resourceKey + ':' + resourceGeneration + ':' + index; if (refs.lyrics.dataset.key === key) return; refs.lyrics.dataset.key = key; refs.lyrics.replaceChildren();
    lyrics.slice(Math.max(0, index - 1), index + 3).forEach(line => refs.lyrics.append(h('p', line === lyrics[index] ? 'active' : '', line.text)));
  }
  function syncMediaSession() {
    if (snap.mode === 'local' || !('mediaSession' in navigator)) return;
    const track = snap.current_track;
    const duration = Number(track && track.duration_ms || 0) / 1000;
    const position = Math.min(duration, Math.max(0, Number(snap.position_ms || 0) / 1000));
    const key = JSON.stringify([snap.room_id, snap.track_instance_id, snap.playing, duration, position]);
    if (key === mediaKey) return;
    try {
      navigator.mediaSession.metadata = track ? new global.MediaMetadata({ title: track.title, artist: track.artist || '', album: track.album || '' }) : null;
      navigator.mediaSession.playbackState = track ? snap.playing ? 'playing' : 'paused' : 'none';
      if (duration > 0) navigator.mediaSession.setPositionState({ duration, position, playbackRate: 1 });
      else navigator.mediaSession.setPositionState();
      mediaKey = key;
    } catch (_) { /* Browser media controls are optional; native playback is authoritative. */ }
  }
  function animateMessage(message) { if (!refs.danmaku || refs.danmaku.hidden || refs.danmaku.childElementCount >= 20 || matchMedia('(prefers-reduced-motion: reduce)').matches) return; const el = h('span', '', message.name + '：' + message.text); el.style.setProperty('--lane', String(refs.danmaku.childElementCount % 5)); refs.danmaku.append(el); el.addEventListener('animationend', () => el.remove(), { once: true }); setTimeout(() => el.remove(), 6000); }
  async function poll(force) { if (polling || !root) return; const generation = lifecycle; polling = true; try { const value = await transport.get('/v1/room', { retry: false }); if (!root || generation !== lifecycle) return; const wasActive = snap.mode !== 'local'; snap = value; mount(); chrome.render(snap); syncMediaSession(); if (wasActive !== (snap.mode !== 'local') && onModeChange) onModeChange(snap.mode !== 'local'); if (force || (!document.hidden && !root.hidden)) update(); } finally { polling = false; } }
  global.HertzRoom = {
    init(options) {
      lifecycle++; root = options.root; transport = options.transport; confirmAction = options.confirm; onModeChange = options.onModeChange;
      onReturn = options.onReturn || (() => {}); onNavigate = options.onNavigate || (() => {});
      if (!root) return;
      if (chrome) chrome.destroy();
      chrome = global.HertzRoomTransport.create({ open: () => document.querySelector('[data-view="room"]').click(), playback: action => global.HertzRoom.playback(action), seek: (instance_id, position) => run(() => playback('seek', { instance_id, position_ms: String(position) })), volume: volume => run(() => global.HertzRoom.localVolume(volume)) });
      view = createView(); mounted = ''; mount();
      if (timer) clearInterval(timer);
      timer = setInterval(() => poll(false).catch(e => status(e.message, true)), 1000); poll(false).catch(e => status(e.message, true));
    },
    async onViewEnter() { workspaceVisible = true; if (chrome.setWorkspaceVisible) chrome.setWorkspaceVisible(true); try { await poll(true); const key = sessionKey(); await syncFavorites([...metadata.values(), snap.current_track].filter(Boolean), key); } catch (e) { status(e.message, true); } },
    onViewExit() { workspaceVisible = false; if (chrome && chrome.setWorkspaceVisible) chrome.setWorkspaceVisible(false); },
    navigate(page) { if (workspace) workspace.navigate(page, true); },
    active() { return snap.mode !== 'local'; },
    playback(action, extra) { update(); return run(() => playback(action === 'toggle' ? (snap.playing ? 'pause' : 'play') : action, extra)); },
    snapshot() { return snap; },
    activateFavorite,
    operationContext: operationOwner,
    syncMediaSession,
    async localVolume(volume) { const o = snap.output || {}; if (!o.enabled) throw new Error('请先启用房间本机输出'); const result = await command({ action: 'output', enabled: true, settings: { ...(o.settings || {}), volume } }); await poll(true); return result; },
    destroy() { lifecycle++; resourceGeneration++; if (coverUrl) URL.revokeObjectURL(coverUrl); coverUrl = ''; if (timer) clearInterval(timer); timer = 0; if (chrome) chrome.destroy(); if (refs.invitation) refs.invitation.value = ''; if (refs.invitationQr) refs.invitationQr.replaceChildren(); invitationId = ''; invitationExpires = 0; root = null; workspace = null; view = null; messages = []; playbackPending = null; queuePending = null; chatReceipt = null; chatUnknown = null; chatSending = null; chatSongPending = null; admissionRequest = null; }
  };
})(window);
