// SPDX-License-Identifier: MIT
// Local control surface only. TLS credentials and PCM stay in native services.
(function (global) {
  'use strict';
  let root, transport, confirmAction, timer, chrome, view, workspace, onModeChange, onReturn = () => {}, onNavigate = () => {}, workspaceVisible = false, invitationExpires = 0, snap = { mode: 'local' }, busy = false;
  let mountedSession = '', workspaceOwner = '', mediaKey = '', lifecycle = 0, playbackPending = null, queuePending = null, admissionRequest = null, invitationId = '';
  let mounted = '', sequence = 1n, chatSequence = 1n, revision = '', polling = false;
  let libraryQuery = '', libraryTotal = 0, libraryGeneration = 0;
  let rememberedNickname = '', preferenceWrite = Promise.resolve(), admissionChecking = false, unreadChat = 0;
  let startDraft = null, startDraftAdding = false;
  let libraryPage = 0, queuePage = 0, lastChatId = '', historyRevision = '', messages = [];
  let chatBefore = null, chatHasMore = false, chatBrowsing = false, chatLoading = null;
  let chatSharingRevision = '', chatHistorySharingRevision = '';
  let liveChatId = null;
  let roomProfileKey = '', roomProfileCover = null, roomProfileLoaded = false, roomProfileLoading = null, roomProfileRetryAt = 0;
  const selection = new Set(), metadata = new Map(), refs = {}, pageSize = 32;
  let favoriteSignature = '', queueSignature = "", librarySignature = "", memberSignature = "", resourceKey = "", resourceSignature = "", coverUrl = "", lyrics = [], resourceGeneration = 0, chatUnknown = null, chatSending = null, chatSongPending = null, chatReceipt = null;
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  function button(text, fn, cls) { const e = h('button', 'btn ' + (cls || ''), text); e.type = 'button'; e.onclick = () => run(fn); return e; }
  function field(parent, label, type, value) { const l = h('label', 'room-field', label), e = h(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') e.type = type; e.value = value == null ? '' : value; l.append(e); parent.append(l); return e; }
  function select(parent, label, choices) { const l = h('label', 'room-field', label), e = h('select'); e.setAttribute('aria-label', label); choices.forEach(([value, text]) => { const o = h('option', '', text); o.value = value; e.append(o); }); l.append(e); parent.append(l); return e; }
  function status(text, error) { if (chrome) chrome.notice(text, error); [refs.notice, refs.entryNotice].filter(Boolean).forEach(node => { node.textContent = text || ''; node.classList.toggle('room-error', !!error); node.hidden = !text; }); }
  function counter(v) { return typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) ? BigInt(v) : 1n; }
  function op(chat) { if (chat) { chatSequence = chatSequence > counter(snap.next_chat_operation_id) ? chatSequence : counter(snap.next_chat_operation_id); return String(chatSequence++); } sequence = sequence > counter(snap.next_operation_id) ? sequence : counter(snap.next_operation_id); return String(sequence++); }
  function sessionKey() { return [lifecycle, snap.mode === 'local' ? 'local' : 'active', snap.room_id || '', snap.instance_id || '', snap.member_id || '', snap.session_id || ''].join(':'); }
  function operationOwner() { return snap.mode !== 'local' && snap.room_id && snap.instance_id && snap.member_id ? [lifecycle, snap.room_id, snap.instance_id, snap.member_id].join(':') : ''; }
  function current(key) { return !!root && key === mountedSession && key === sessionKey(); }
  function uncertain(error) { return !error.status || /timeout|unknown|connection|network/i.test(error.code || error.message || ''); }
  async function command(body) { return transport.post('/v1/room', body, { retry: false }); }
  async function leaveRoom() {
    const key = sessionKey(), host = snap.mode === 'host';
    if (snap.mode === 'local') return;
    if (!await confirmAction(host ? '结束并退出房间？房间将结束，所有成员将停止收听。' : '退出当前房间？只会断开你的连接，其他成员可继续收听。') || !current(key)) return { cancelled: true };
    const actions = Array.from(root.querySelectorAll('.room-leave')); actions.forEach(node => { node.disabled = true; });
    try {
      const result = await command({ action: 'leave' });
      if (!current(key)) return;
      if (!result || result.mode !== 'local') throw new Error('服务尚未确认退出，请检查房间状态后重试。');
      resetChat(); selection.clear();
      applySnapshot(result, true);
      workspace.navigate('lobby');
      status(host ? '房间已结束。' : '已退出房间。');
    } finally { actions.forEach(node => { node.disabled = false; }); }
  }
  async function peer(request) { return command({ action: 'peer', request }); }
  function requireConnectedRoom() { if (snap.mode !== 'host' && snap.mode !== 'guest') throw Object.assign(new Error('房间连接尚未恢复，请先等待连接。'), { code: 'room_not_connected', status: 409 }); }
  async function control(action, extra) { requireConnectedRoom(); return peer({ action, operation_id: op(false), expected_revision: snap.revision, ...extra }); }
  async function playback(action, extra) {
    requireConnectedRoom();
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
      if (/^(applied|superseded|no_op|failed)$/.test(state || '')) {
        queuePending = null;
        if (startDraft && startDraft.phase === 'queue_unknown' && startDraft.queueOperation === receipt.id) {
          if (state === 'failed') startDraft.phase = 'ready';
          else { startDraft = null; if (refs.startDraftAction) refs.startDraftAction.hidden = true; }
        }
        drawQueueReceipt();
      }
      status(operationText(value));
    }), button('放弃这次待确认队列操作', async () => {
      const key = sessionKey();
      if (queuePending !== receipt || receipt.owner !== operationOwner() || receipt.phase !== 'unknown') return;
      if (!await confirmAction('原队列操作可能已经生效，请先检查共同队列。放弃本机待确认记录？这不会撤销或重放原操作。')) return;
      if (!current(key) || queuePending !== receipt || receipt.owner !== operationOwner() || receipt.phase !== 'unknown') return;
      queuePending = null; drawQueueReceipt();
      if (startDraft && startDraft.phase === 'queue_unknown' && startDraft.queueOperation === receipt.id) startDraft = null;
      status('已放弃本机待确认记录。原队列操作可能已经生效，请检查共同队列；原操作没有撤销或重放。');
    }));
  }
  function operationText(v) { const labels = { preparing: '正在准备音频', scheduled: '已安排，等待生效', applied: '已生效', superseded: '已被后续操作取代', no_op: '当前已是此状态', failed: '操作未生效' }; const key = v && v.state && (v.state.status || v.state); return labels[key] || '操作已受理'; }
  async function run(fn) {
    if (busy) return;
    if (!root) return;
    const key = sessionKey(), runRoot = root;
    busy = true; runRoot.setAttribute('aria-busy', 'true'); status('正在处理…');
    try { const result = await fn(); if (!current(key)) return; await poll(true); if (current(key) && refs.notice && refs.notice.textContent === '正在处理…') status(result && result.cancelled ? '已取消。' : result && result.state ? operationText(result) : '操作已受理'); }
    catch (e) { if (current(key)) status(e.message || '操作失败，请检查连接后重试。', true); }
    finally { busy = false; runRoot.setAttribute('aria-busy', 'false'); }
  }
  function section(parent, title, cls) { const e = h('section', 'room-section ' + (cls || '')); e.append(h('h3', '', title)); parent.append(e); return e; }
  function createView() {
    return global.HertzRoomView.create({
      h, button, field, select, section, refs, selection, metadata, command, control, playback, run, status,
      sessionKey, current, confirmAction, loadLocal, appendResource, mutateQueue, loadChat, resetChat, sendChat,
      queueUncertain: () => !!queuePending,
      uncertain,
      async readJoinStatus() { await poll(true); return snap.mode; },
      startDraft: () => startDraft,
      createRoom: async payload => {
        const draft = startDraft;
        await command({ action: 'create', ...payload });
        await poll(true);
        if (snap.mode !== 'host') throw new Error('创建结果尚未确认，请检查房间状态后继续。');
        if (draft && startDraft === draft) await addStartDraft();
      },
      addStartDraft,
      async dismissStartDraft() {
        const draft = startDraft, key = sessionKey(); if (!draft || startDraftAdding) return;
        if (!await confirmAction('清除本机这组选曲记录？已完成的分享和入队会保留，结果未确认的队列操作仍需单独查询。') || !current(key) || startDraft !== draft) return;
        startDraft = null; if (refs.startDraftAction) refs.startDraftAction.hidden = true; if (refs.startDraftDismiss) refs.startDraftDismiss.hidden = true;
      },
      async localPicker(query, offset = 0) { return transport.get('/v1/tracks?limit=32&offset=' + Math.max(0, offset) + '&q=' + encodeURIComponent(query || '')); },
      async addLocalSelection(track) {
        if (startDraftAdding || startDraft && startDraft.phase !== 'ready') throw new Error('请先处理上一组选曲的分享或入队结果。');
        startDraft = { tracks: [track], phase: 'ready' }; await addStartDraft();
      },
      markChatRead() { unreadChat = 0; if (refs.chatTab) refs.chatTab.textContent = '聊天'; },
      nickname: () => rememberedNickname,
      rememberNickname(value) {
        rememberedNickname = value;
        if (typeof transport.put === 'function') preferenceWrite = preferenceWrite.catch(() => {}).then(() => transport.put('/v1/settings', { room_nickname: value })).catch(() => status('昵称本次可用，但未能保存到本机设置。', true));
      },
      snapshot: () => snap, root: () => root, workspace: () => workspace, queueOffset: () => queuePage,
      onReturn: () => onReturn(), localVolume: volume => global.HertzRoom.localVolume(volume),
      leaveRoom,
      async pageQueue(direction) { queuePage = Math.max(0, Math.min(Math.max(0, Number(snap.queue_count || 0) - 1), queuePage + direction * pageSize)); queuePage = Math.floor(queuePage / pageSize) * pageSize; await loadQueue(); },
      async pageLibrary(direction) { libraryPage = Math.max(0, Math.min(Math.max(0, Number(libraryTotal || 0) - 1), libraryPage + direction * pageSize)); libraryPage = Math.floor(libraryPage / pageSize) * pageSize; await loadLibrary(); },
      async searchLibrary(query) { if (String(query || '').trim() && snap.library_search !== true) throw new Error('房主当前版本暂不支持搜索全部共享歌曲，请翻页浏览或请房主更新。'); libraryQuery = [...String(query || '').trim()].slice(0, 128).join(''); libraryPage = 0; await loadLibrary(); },
      cycleMode() { const modes = ['repeat', 'repeat_one', 'shuffle']; return control('mode', { mode: modes[(modes.indexOf(snap.play_mode) + 1) % modes.length] }); },
      vote(instance_id, voted) { return control('vote', { instance_id, voted }); },
      queueOrder(mode) { return control('queue_order', { mode }); },
      async applyForRoom(candidate, name, listen, verified = false) {
        if (admissionRequest) throw new Error('请先查看当前入房申请结果，或显式清除本机申请记录');
        const key = sessionKey(), address = (candidate.addresses || [])[0];
        if (!address || !candidate.fingerprint || !candidate.room_code) throw new Error('该房间尚不支持入房申请，请向房主获取邀请');
        if (!name.trim()) throw new Error('请输入显示名称');
        if ((!verified && !await confirmAction('申请加入「' + candidate.name + '」？\n主机：' + address + '\n指纹：' + candidate.fingerprint + '\n发现信息不能证明主机身份，请与房主核对指纹。')) || !current(key)) return;
        const target = { address, fingerprint: candidate.fingerprint, room_id: candidate.room_id };
        const result = await command({ action: 'apply', ...target, room_code: candidate.room_code, name: name.trim() });
        if (!current(key)) return;
        admissionRequest = { ...target, application_id: result.application_id, applicant_secret: result.applicant_secret, name: name.trim(), listen, roomName: candidate.name, expiresAt: Date.now() + Number(result.expires_in_seconds || 300) * 1000, nextCheck: Date.now() + 3000, joinAttempted: false };
        view.drawApplication({ name: candidate.name, state: 'pending' }); status('入房申请已提交，等待房主处理。');
        return true;
      },
      async checkApplication(retryJoin = false, automatic = false) {
        const request = admissionRequest, key = sessionKey();
        if (!request) throw new Error('当前没有待处理申请');
        request.nextCheck = Date.now() + 5000;
        const { address, fingerprint, room_id, application_id, applicant_secret } = request;
        let result;
        try { result = await command({ action: 'admission_status', address, fingerprint, room_id, application_id, applicant_secret }); }
        catch (error) { if (current(key) && admissionRequest === request) view.drawApplication({ name: request.roomName, state: 'status_failed' }); throw error; }
        if (!current(key) || admissionRequest !== request) return;
        if (automatic && (!workspaceVisible || root.hidden || document.hidden || workspace.hasOpenEntry())) return;
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
      reviewApplication(application_id, approve, role = 'queue') { return command({ action: 'admission_review', application_id, approve, permissions: { listen: true, queue: role !== 'listen', transport: role === 'control', volume: false, chat_read: true, chat_send: role !== 'listen', invite: false } }); },
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
      invitationGenerated(value, id, expiresInSeconds) {
        if (!value) throw new Error('服务未返回有效邀请');
        invitationExpires = Date.now() + Math.min(300, Math.max(1, Number(expiresInSeconds) || 300)) * 1000;
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
    if (startDraft && startDraft.owner && startDraft.owner !== operationOwner()) startDraft = null;
    if (mounted === key && mountedSession === roomSession) return;
    const preservePage = mounted === 'active' && key === 'active' && workspaceOwner === operationOwner() && workspace;
    const previousPage = preservePage && workspace.currentPage();
    const previousTab = preservePage && root.dataset.roomAside;
    const previousSetting = preservePage && workspace.pages.settings.dataset.setting;
    if (!preservePage) unreadChat = 0;
    const draft = preservePage && refs.chatInput ? refs.chatInput.value : '';
    const preservedReceipt = preservePage && chatReceipt && chatReceipt.owner === operationOwner() ? chatReceipt : null;
    mountedSession = roomSession; liveChatId = null; metadata.clear(); selection.clear(); chatReceipt = preservedReceipt; chatUnknown = preservedReceipt ? preservedReceipt.id : null; chatSending = null; chatSongPending = preservedReceipt && preservedReceipt.songTitle || null; resetChat(); chatLoading = null;
    if (workspace && workspace.destroy) workspace.destroy();
    mounted = key; favoriteSignature = ''; memberSignature = ''; queueSignature = ''; librarySignature = ''; resourceGeneration++; resourceKey = ''; resourceSignature = ''; lyrics = []; if (coverUrl) URL.revokeObjectURL(coverUrl); coverUrl = ''; root.replaceChildren(); Object.keys(refs).forEach(k => delete refs[k]);
    invitationExpires = 0; invitationId = '';
    workspace = global.HertzRoomWorkspace.create(root, { h, button, refs, active: key === 'active', onReturn, onNavigate, leaveRoom: () => run(leaveRoom) });
    if (key === 'local') view.mountEntry(); else { view.mountActive(); revision = ''; historyRevision = ''; messages = []; lastChatId = ''; libraryPage = 0; libraryQuery = ''; libraryGeneration++; queuePage = 0; }
    workspace.render(snap);
    workspaceOwner = operationOwner();
    if (previousPage) workspace.navigate(previousPage);
    if (previousTab) view.selectTab(previousTab);
    if (previousSetting) workspace.selectSettings(previousSetting);
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
  function syncChatComposer() { refs.chatInput.disabled = refs.chatSend.disabled = !(snap.permissions || {}).chat_send || ['reconnecting', 'disconnected'].includes(snap.mode) || !!chatUnknown || !!chatSending || !!(snap.chat && snap.chat.config && !snap.chat.config.enabled); refs.chatSongPending.hidden = !chatSongPending; refs.chatSongPending.textContent = chatSongPending ? '歌曲卡片' + (chatUnknown ? ' · 结果待确认：' : ' · 正在发送：') + chatSongPending : ''; }
  function resetChat() { messages = []; lastChatId = ''; historyRevision = ''; chatBefore = null; chatHasMore = false; chatBrowsing = false; chatLoading = null; chatSharingRevision = snap.sharing_revision || ''; chatHistorySharingRevision = ''; }
  function renderChatMessages() {
    const key = sessionKey();
    refs.chat.replaceChildren(); messages.forEach(m => { const e = h('li'); view.drawMessage(m, e); if (snap.mode === 'host') e.append(button('删除', async () => { if (!current(key) || !await confirmAction('删除这条聊天消息？') || !current(key)) return; await command({ action: 'chat_admin', command: { action: 'delete', message_id: m.message_id } }); if (!current(key)) return; resetChat(); await loadChat(); })); refs.chat.append(e); });
  }
  function metric(label, value) { refs.metrics.append(h('dt', '', label), h('dd', 'room-mono', value == null ? '待测量' : value)); }
  function drawRoomProfile() {
    if (snap.mode === 'host') { view.drawRoomProfile(snap.room_cover); return; }
    const key = sessionKey(), revision = snap.room_cover_revision || '', signature = key + ':' + revision;
    if (roomProfileKey !== signature) { roomProfileKey = signature; roomProfileCover = null; roomProfileLoaded = false; roomProfileLoading = null; roomProfileRetryAt = 0; }
    view.drawRoomProfile(roomProfileCover);
    if (!revision || snap.mode !== 'guest' || roomProfileLoaded || roomProfileLoading || Date.now() < roomProfileRetryAt) return;
    const request = {}; roomProfileLoading = request;
    peer({ action: 'room_profile' }).then(value => {
      if (!current(key) || roomProfileKey !== signature || roomProfileLoading !== request) return;
      if (!value || value.room_id !== snap.room_id || value.revision !== revision) { roomProfileRetryAt = Date.now() + 2000; return; }
      roomProfileCover = value.cover || null; roomProfileLoaded = true; view.drawRoomProfile(roomProfileCover);
    }).catch(() => { if (current(key) && roomProfileKey === signature && roomProfileLoading === request) roomProfileRetryAt = Date.now() + 5000; })
      .finally(() => { if (roomProfileLoading === request) roomProfileLoading = null; });
  }
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
    const connected = snap.mode === 'host' || snap.mode === 'guest';
    view.updatePlayButton(snap.playing); [refs.play, refs.prev, refs.next, refs.stop, refs.seekButton].forEach(b => { b.disabled = !p.transport || !connected || !!playbackBlocked; b.title = !p.transport ? '房主未授权播控' : playbackBlocked ? '请先查询原播放操作的结果' : !connected ? '等待房间恢复连接' : b.getAttribute ? b.getAttribute('aria-label') || b.textContent : b.textContent; });
    const duration = Number(track && track.duration_ms || 0);
    const elapsed = Math.max(0, Number(snap.position_ms || 0));
    refs.duration.textContent = Math.floor(duration / 60000) + ':' + String(Math.floor(duration / 1000) % 60).padStart(2, '0');
    if (document.activeElement !== refs.progress) refs.progress.value = duration ? Math.round(Math.min(elapsed / duration, 1) * 1000) : 0;
    refs.progress.disabled = !p.transport || !duration || !connected || !!playbackBlocked;
    refs.playingBadge.textContent = snap.pending && !snap.pending.prepared ? '正在准备歌曲' : snap.playing ? '正在播放' : track ? '已暂停' : '等待共享歌曲';
    refs.album.textContent = track && track.album || ''; refs.album.hidden = !refs.album.textContent;
    refs.quickMode.textContent = { repeat: '列表循环', repeat_one: '单曲循环', shuffle: '随机播放' }[snap.play_mode] || '列表循环'; refs.quickMode.disabled = !p.queue;
    refs.songAppend.disabled = !track || !p.queue; refs.songShare.disabled = !track || !p.chat_send;
    refs.guestInvite.hidden = host || !!p.invite; refs.invitePerms.hidden = !host; refs.activeRoomName.textContent = snap.name || '一起听房间';
    refs.queueCount.textContent = Number(snap.queue_count || 0) + ' 首歌曲';
    refs.queueNav.hidden = Number(snap.queue_count || 0) <= pageSize; refs.queuePrev.disabled = queuePage === 0; refs.queueNext.disabled = queuePage + pageSize >= Number(snap.queue_count || 0);
    refs.orderControl.hidden = !host || !snap.collaboration; refs.order.value = snap.collaboration && snap.collaboration.queue_order || 'manual';
    view.drawActivity(snap.collaboration && snap.collaboration.activity || []);
    view.drawAdmissions(snap.admission);
    const applications = host && snap.admission ? (snap.admission.pending || []).filter(application => application.state === 'pending') : [];
    if (refs.admissionAlert) {
      const signature = applications.map(application => application.id).join(':');
      if (refs.admissionAlert.dataset.signature !== signature) { refs.admissionAlert.dataset.signature = signature; refs.admissionAlert.replaceChildren();
        if (applications.length) refs.admissionAlert.append(h('span', '', applications.length === 1 ? applications[0].name + ' 申请加入一起听' : applications.length + ' 位朋友申请加入一起听'), button('查看申请', () => view.selectTab('members')));
      }
      refs.admissionAlert.hidden = !applications.length;
    }
    view.drawInvitationManagement();
    drawRoomProfile();
    if (invitationId && Array.isArray(snap.invitations) && !snap.invitations.some(invite => invite.id === invitationId)) {
      invitationExpires = 0; invitationId = ''; refs.revokeInvitation.disabled = true; refs.invitation.value = ''; refs.invitationQr.replaceChildren(); refs.invitationExpiry.textContent = '邀请已使用或失效，请为下一位朋友生成新邀请';
    }
    if (invitationExpires && Date.now() >= invitationExpires) { invitationExpires = 0; invitationId = ''; refs.revokeInvitation.disabled = true; refs.invitation.value = ''; refs.invitationQr.replaceChildren(); refs.invitationExpiry.textContent = '邀请已过期，请重新生成'; }
    if (refs.refreshInvitation) refs.refreshInvitation(Math.max(0, Math.ceil((invitationExpires - Date.now()) / 1000)));
    if (refs.startDraftAction) {
      refs.startDraftAction.hidden = !startDraft;
      refs.startDraftAction.disabled = startDraftAdding || !!queuePending || startDraft && startDraft.phase === 'queue_unknown';
      refs.startDraftAction.textContent = startDraft && startDraft.phase === 'share_unknown' ? '查询选曲分享结果' : '继续添加选中的歌曲';
    }
    if (refs.startDraftDismiss) { refs.startDraftDismiss.hidden = !startDraft; refs.startDraftDismiss.disabled = startDraftAdding; }
    if (refs.librarySearch) { refs.librarySearch.disabled = snap.library_search !== true; refs.librarySearch.title = snap.library_search === true ? '搜索房间全部共享歌曲' : '当前房主版本不支持全库搜索，可翻页浏览'; }
    refs.sharing.hidden = !host; refs.invites.hidden = !host && !p.invite; refs.hostDsp.hidden = !host; refs.chatAdmin.hidden = !host; refs.sleep.hidden = !host; refs.volumeApply.disabled = !p.volume; refs.modeApply.disabled = !p.queue;
    refs.sleepStatus.textContent = snap.sleep_timer_remaining_seconds == null ? '未设置定时' : '剩余 ' + Math.ceil(Number(snap.sleep_timer_remaining_seconds) / 60) + ' 分钟';
    const chatConfig = snap.chat && snap.chat.config || {};
    syncChatComposer();
    refs.chatStatus.textContent = p.chat_read ? snap.chat_error || snap.chat && snap.chat.error || (chatConfig.enabled === false ? '房间聊天已关闭。' : chatConfig.retained === false ? '仅实时聊天，消息不保存，重启后不可恢复。' : '文字与歌曲卡片只在房间内分享。') : '房主未授权查看聊天。';
    const o = snap.output || {}; refs.outputStatus.textContent = !o.enabled ? '本机音频已关闭' : o.error || (o.ready ? '可收听，设备已准备好' : '正在准备声音，可先查看共同队列');
    refs.quickVolume.disabled = !o.enabled; if (document.activeElement !== refs.quickVolume) refs.quickVolume.value = Math.round(Number((o.settings || {}).volume ?? 1) * 100);
    refs.testOutput.disabled = !o.ready || !!snap.playing || !!snap.pending || !!snap.scheduled;
    refs.metrics.replaceChildren(); metric('网络对时误差', o.clock ? (Number(o.clock.uncertainty_ns) / 1e6).toFixed(3) + ' ms' : null); metric('设备漂移', o.device ? Number(o.device.device_clock_ppm).toFixed(2) + ' ppm' : null); metric('输入缓冲', o.buffered_input_frames); metric('欠载帧数', o.underrun_frames); if (o.binding) { metric('实际设备', o.binding.device); metric('设备采样率', (o.binding.sample_rate / 1000) + ' kHz'); } if (o.preferences_error) status(o.preferences_error, true);
    if (revision === '') { refs.outputEnabled.checked = o.desired_enabled == null ? !!o.enabled : !!o.desired_enabled; const settings = o.settings || {}; refs.localVolume.value = Math.round((settings.volume == null ? 1 : settings.volume) * 100); if (settings.device_id) { refs.device.append(new Option(settings.device_id, settings.device_id)); refs.device.value = settings.device_id; } refs.correction.value = settings.latency_correction_ms || 0; refs.roomVolume.value = Math.round((snap.volume || 0) * 100); refs.mode.value = snap.play_mode || 'repeat'; refs.loudness.value = snap.loudness_mode || 'off'; refs.fade.value = snap.crossfade_ms || 0; refs.preamp.value = snap.dsp && snap.dsp.preamp_db || 0; refs.eq.forEach((e, i) => e.value = snap.dsp && snap.dsp.eq_gains_db[i] || 0); selection.clear(); (snap.shared_track_ids || []).forEach(id => selection.add(id)); if (host) loadLocal('').catch(() => {}); }
    const key = sessionKey(), queueKey = [snap.revision, snap.track_instance_id, snap.mode, !!queuePending, !!p.queue, !!p.transport, !!p.chat_send].join(':');
    // Background projections can race natural playback or sharing changes.
    // Invalidate only; the next poll rereads without replaying any writes.
    if (queueKey !== queueSignature) { queueSignature = queueKey; loadQueue().catch(e => { if (current(key) && queueSignature === queueKey) { queueSignature = ''; if (e.code !== 'revision_conflict') status(e.message, true); } }); }
    const libraryKey = [snap.sharing_revision || snap.revision, snap.mode, !!queuePending, !!p.queue, !!p.chat_send].join(':');
    if (libraryKey !== librarySignature) { librarySignature = libraryKey; loadLibrary().catch(e => { if (current(key) && librarySignature === libraryKey) { librarySignature = ''; if (e.code !== 'revision_conflict') status(e.message, true); } }); if (host) loadSharedOnline().catch(e => { if (current(key) && e.code !== 'revision_conflict') status(e.message, true); }); }
    revision = snap.revision;
    const members = JSON.stringify(snap.members || []); if (members !== memberSignature) { memberSignature = members; view.drawMembers(); }
    updateResources(track);
    if (snap.error || snap.local_error) status(snap.local_error || snap.error, true);
    if (!p.chat_read) { liveChatId = null; resetChat(); refs.chat.replaceChildren(); refs.danmaku.replaceChildren(); refs.chatOlder.disabled = true; }
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
    requireConnectedRoom();
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
    const online = localId && /^online:([^:]+):(.+)$/.exec(localId);
    return { kind: 'track', source: online ? online[1] : localId ? 'local' : 'lan', ref_id: online ? online[2] : localId || snap.fingerprint + ':' + track.favorite_key,
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
    const key = sessionKey(), expected = snap.sharing_revision || null, offset = libraryPage, query = libraryQuery, generation = ++libraryGeneration;
    const request = { action: 'library', offset, limit: pageSize, revision: expected };
    if (query) request.query = query;
    const v = await peer(request);
    if (!current(key) || generation !== libraryGeneration || libraryPage !== offset || query !== libraryQuery || expected !== (snap.sharing_revision || null) || (expected && v.revision !== expected)) return;
    libraryTotal = Number(v.total || 0);
    if (refs.libraryNav) { refs.libraryNav.hidden = libraryTotal <= pageSize; refs.libraryPrev.disabled = offset === 0; refs.libraryNext.disabled = offset + pageSize >= libraryTotal; }
    await syncFavorites(v.tracks || [], key);
    if (current(key) && generation === libraryGeneration) view.drawLibrary(v.tracks || []);
  }
  async function loadSharedOnline() {
    if (snap.mode !== 'host' || !refs.sharedOnline) return;
    const key = sessionKey(), revision = snap.sharing_revision, ids = snap.favorite_local_ids || {}, tracks = [];
    if (!Object.values(ids).some(id => /^online:/.test(id))) { refs.sharedOnline.replaceChildren(h('p', 'room-sub', '在在线歌曲列表点击“加入一起听”，即可分享并点歌。')); return; }
    for (let offset = 0; offset < 2000; offset += 64) {
      const value = await peer({ action: 'library', offset, limit: 64, revision });
      if (!current(key) || revision !== snap.sharing_revision) return;
      tracks.push(...(value.tracks || [])); if ((value.tracks || []).length < 64) break;
    }
    refs.sharedOnline.replaceChildren();
    tracks.filter(t => /^online:/.test(ids[t.favorite_key] || '')).forEach(t => {
      const id = ids[t.favorite_key], label = h('label', 'room-local-item'), input = h('input');
      input.type = 'checkbox'; input.checked = selection.has(id);
      input.onchange = () => input.checked ? selection.add(id) : selection.delete(id);
      label.append(input, h('span', '', t.title + (t.artist ? ' · ' + t.artist : ''))); refs.sharedOnline.append(label);
    });
    if (!refs.sharedOnline.childElementCount) refs.sharedOnline.append(h('p', 'room-sub', '在在线歌曲列表点击“加入一起听”，即可分享并点歌。'));
  }
  async function addOnline(tracks) {
    const fresh = await transport.get('/v1/room', { retry: false });
    if (fresh.mode !== 'host') throw new Error(fresh.mode === 'local' ? '请先在“一起听”中创建房间，再添加在线歌曲。' : '在线歌曲需由房主分享；你可以从房间共享曲库点歌。');
    if (fresh.room_id !== snap.room_id || fresh.instance_id !== snap.instance_id) throw queueContextError('房间会话已改变，请刷新后重试。');
    const key = sessionKey();
    const songs = tracks.map(t => ({ source: t.source, id: String(t.id), title: t.title, artist: t.artist || null, album: t.album || null, duration_ms: t.duration_ms || null, cover: t.cover || null, ref: t.ref || t.track_ref || {} }));
    const result = await command({ action: 'share_online', tracks: songs });
    if (!current(key)) throw queueContextError('房间会话已改变，请在原房间检查分享结果。');
    const ids = result.favorite_local_ids || {}, resources = new Map((result.tracks || []).map(t => [ids[t.favorite_key], t.resource_id]));
    const added = songs.map(t => { const id = 'online:' + t.source + ':' + t.id; selection.add(id); const resource = resources.get(id); if (!resource) throw new Error('歌曲已分享，请到一起听共享曲库中点歌。'); return { resource_id: resource }; });
    await mutateQueue(queue => queue.concat(added));
    await poll(true);
  }
  async function addStartDraft() {
    const draft = startDraft;
    if (!draft || startDraftAdding) return;
    if (snap.mode !== 'host') throw new Error('这些歌曲需要由房主分享。');
    if (queuePending || draft.phase === 'queue_unknown') throw new Error('请先查询原队列操作，再核对共同队列。不会重复添加选曲。');
    const key = sessionKey(), owner = operationOwner(); startDraftAdding = true;
    try {
      if (draft.owner && draft.owner !== owner) throw queueContextError('这组选曲属于之前的房间，请先在原房间核对操作结果。');
      draft.owner = owner;
      const ids = draft.tracks.map(track => track.id);
      let result;
      if (draft.resources) result = draft.resources;
      else if (draft.phase === 'share_unknown') {
        await poll(true);
        if (operationOwner() !== owner) throw queueContextError('房间已改变，请在原房间检查选曲分享结果。');
        const mapping = snap.favorite_local_ids || {}, tracks = [];
        for (let offset = 0; offset < 2000; offset += 64) {
          const page = await peer({ action: 'library', offset, limit: 64, revision: snap.sharing_revision });
          if (!current(key) || operationOwner() !== owner) return;
          tracks.push(...(page.tracks || [])); if ((page.tracks || []).length < 64) break;
        }
        result = ids.map(id => tracks.find(track => mapping[track.favorite_key] === id));
        if (result.some(track => !track)) throw new Error('尚不能确认全部歌曲已分享。请在歌曲分享设置中核对范围，再从点歌抽屉添加；本次不会重发分享操作。');
      } else {
        status('房间已创建，正在分享选中的 ' + ids.length + ' 首歌曲…');
        try { const shared = await command({ action: 'share', track_ids: [...new Set([...(snap.shared_track_ids || []), ...ids])] });
          if (!current(key) || operationOwner() !== owner) return;
          const mapping = shared.favorite_local_ids || {};
          result = ids.map(id => (shared.tracks || []).find(track => mapping[track.favorite_key] === id));
          if (result.some(track => !track)) throw new Error('歌曲分享已受理，请在点歌抽屉中核对已共享歌曲。');
        } catch (error) { if (uncertain(error)) draft.phase = 'share_unknown'; throw error; }
      }
      draft.resources = result;
      status('选曲已分享，正在加入共同队列…');
      await mutateQueue(queue => queue.concat(result.map(track => ({ resource_id: track.resource_id }))));
      if (!current(key) || startDraft !== draft) return;
      if (queuePending) { draft.phase = 'queue_unknown'; status('歌曲已分享，入队结果待确认。请查询原队列操作。', true); }
      else { startDraft = null; status('已把 ' + ids.length + ' 首歌曲加入共同队列，点击播放即可开始。'); }
      if (refs.startDraftAction) refs.startDraftAction.hidden = !startDraft;
    } catch (error) {
      if (current(key) && queuePending && queuePending.owner === owner && queuePending.phase === 'unknown' && draft.resources) {
        draft.phase = 'queue_unknown'; draft.queueOperation = queuePending.id;
      }
      if (current(key)) status('房间已保留。' + (draft.phase === 'share_unknown' ? '选曲分享结果尚未确认，可查询分享结果；不会自动重发。' : error.message), true);
      throw error;
    } finally { startDraftAdding = false; }
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
      const incoming = recent.concat(page.messages || []);
      if (!older) {
        const baseline = liveChatId;
        let newest = baseline == null ? 0n : counter(baseline);
        const seen = new Set();
        incoming.forEach(message => {
          const id = counter(message.message_id), age = Date.now() - Number(message.received_at_ms);
          if (!seen.has(message.message_id) && baseline != null && !reset && id > counter(baseline)) {
            if (!workspaceVisible || workspace.currentPage() !== 'play' || root.dataset.roomAside !== 'chat' || document.hidden) unreadChat++;
            if (age >= 0 && age < 5000 && message.content_kind !== 'song') animateMessage(message);
          }
          seen.add(message.message_id); if (id > newest) newest = id;
        });
        liveChatId = String(newest);
        if (refs.chatTab) refs.chatTab.textContent = unreadChat ? '聊天 · ' + Math.min(unreadChat, 99) + (unreadChat > 99 ? '+' : '') : '聊天';
      }
      incoming.forEach(m => {
        // A fresh history read can revoke a song reference without changing
        // the message identity. Replace its projection, including null songs.
        if (known.has(m.message_id)) { messages[known.get(m.message_id)] = m; return; }
        known.set(m.message_id, messages.length); messages.push(m);
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
  function animateMessage(message) {
    if (!workspaceVisible || !workspace || workspace.currentPage() !== 'play' || document.hidden || !refs.danmaku || refs.danmaku.hidden || refs.danmaku.childElementCount >= 20 || !(snap.permissions || {}).chat_read || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const layer = refs.danmaku, now = Date.now(), lanes = refs.danmakuLanes || (refs.danmakuLanes = [0, 0, 0, 0]);
    const lane = lanes.findIndex(free => free <= now); if (lane < 0) return;
    const el = h('span', '', message.name + '：' + message.text); el.style.setProperty('--lane', String(lane)); layer.append(el);
    const width = el.offsetWidth, travel = layer.clientWidth + width, seconds = travel / 110;
    lanes[lane] = now + (width + 32) / 110 * 1000;
    el.style.setProperty('--room-travel', travel + 'px'); el.style.setProperty('--room-flight', seconds + 's');
    el.addEventListener('animationend', () => el.remove(), { once: true }); setTimeout(() => el.remove(), seconds * 1000 + 100);
  }
  function applySnapshot(value, force) { const wasActive = snap.mode !== 'local'; snap = value; mount(); chrome.render(snap); syncMediaSession(); if (wasActive !== (snap.mode !== 'local') && onModeChange) onModeChange(snap.mode !== 'local'); if (force || (!document.hidden && !root.hidden)) update(); }
  async function poll(force) { if (polling || !root) return; const generation = lifecycle, key = sessionKey(); polling = true; try { const value = await transport.get('/v1/room', { retry: false }); if (!root || generation !== lifecycle || key !== sessionKey()) return; applySnapshot(value, force); } finally { polling = false; } }
  global.HertzRoom = {
    init(options) {
      lifecycle++; root = options.root; transport = options.transport; confirmAction = options.confirm; onModeChange = options.onModeChange;
      onReturn = options.onReturn || (() => {}); onNavigate = options.onNavigate || (() => {});
      if (!root) return;
      const preferenceLifecycle = lifecycle;
      transport.get('/v1/settings').then(settings => {
        if (!root || preferenceLifecycle !== lifecycle || rememberedNickname) return;
        const nickname = settings && settings.room_nickname;
        if (typeof nickname === 'string' && nickname.trim() && [...nickname].length <= 32 && !/[\u0000-\u001f\u007f-\u009f]/.test(nickname)) {
          rememberedNickname = nickname;
          root.querySelectorAll('input[autocomplete="nickname"]').forEach(input => { if (!input.value) input.value = nickname; });
        }
      }).catch(() => {});
      if (chrome) chrome.destroy();
      chrome = global.HertzRoomTransport.create({ open: () => { document.querySelector('[data-view="room"]').click(); global.HertzRoom.navigate('play'); }, playback: action => global.HertzRoom.playback(action), seek: (instance_id, position) => run(() => playback('seek', { instance_id, position_ms: String(position) })), volume: volume => run(() => global.HertzRoom.localVolume(volume)) });
      view = createView(); mounted = ''; mount();
      if (timer) clearInterval(timer);
      timer = setInterval(async () => {
        try {
          await poll(false);
          const request = admissionRequest;
          if (!request || snap.mode !== 'local' || busy || admissionChecking || !workspaceVisible || root.hidden || document.hidden || !workspace || workspace.currentPage() !== 'lobby' || workspace.hasOpenEntry() || request.joinAttempted || Date.now() < request.nextCheck) return;
          if (Date.now() >= request.expiresAt) { view.drawApplication({ name: request.roomName, state: 'status_failed' }); request.nextCheck = Infinity; return; }
          admissionChecking = true;
          try { await view.checkApplication(false, true); await poll(true); }
          catch (error) { request.nextCheck = Date.now() + 15000; status('申请状态暂时无法更新，可点击查看结果重试。', true); }
          finally { admissionChecking = false; }
        } catch (error) { status(error.message, true); }
      }, 1000); poll(false).catch(e => status(e.message, true));
    },
    async onViewEnter() { workspaceVisible = true; if (chrome.setWorkspaceVisible) chrome.setWorkspaceVisible(true); try { await poll(true); const key = sessionKey(); await syncFavorites([...metadata.values(), snap.current_track].filter(Boolean), key); } catch (e) { status(e.message, true); } },
    onViewExit() { workspaceVisible = false; if (workspace) workspace.closeEntryDialogs(); if (refs.danmaku) refs.danmaku.replaceChildren(); if (chrome && chrome.setWorkspaceVisible) chrome.setWorkspaceVisible(false); },
    navigate(page) { if (workspace) workspace.navigate(page, true); },
    active() { return snap.mode !== 'local'; },
    playback(action, extra) { update(); return run(() => playback(action === 'toggle' ? (snap.playing ? 'pause' : 'play') : action, extra)); },
    snapshot() { return snap; },
    async startFromTracks(tracks) {
      const selected = (tracks || []).filter(Boolean);
      if (!selected.length) throw new Error('请先选择歌曲。');
      if (selected.length > 2000) throw new Error('每次最多分享 2000 首歌曲，请缩小选曲范围。');
      if (selected.some(track => !track.id || /^online:/.test(track.id) || track.source && track.source !== 'local')) throw new Error('请从本机曲库发起；在线歌曲请使用在线列表中的“加入一起听”。');
      if (queuePending || startDraftAdding || startDraft && startDraft.phase !== 'ready') throw new Error('请先处理上一组选曲的待确认结果。');
      if (snap.mode !== 'local' && snap.mode !== 'host') throw new Error('你已加入其他人的房间，请从房间共享曲库点歌。');
      if (snap.mode === 'host') {
        if (!await confirmAction('将选中的 ' + selected.length + ' 首歌曲分享给当前房间，并加入共同队列？现有共享范围会保留。')) return;
        startDraft = { tracks: selected, phase: 'ready' }; await run(addStartDraft); return;
      }
      startDraft = { tracks: selected, phase: 'ready' };
      workspace.navigate('lobby'); if (refs.openCreate) refs.openCreate();
    },
    activateFavorite,
    addOnline,
    operationContext: operationOwner,
    syncMediaSession,
    async localVolume(volume) { const o = snap.output || {}; if (!o.enabled) throw new Error('请先启用房间本机输出'); const result = await command({ action: 'output', enabled: true, settings: { ...(o.settings || {}), volume } }); await poll(true); return result; },
    destroy() { if (workspace && workspace.destroy) workspace.destroy(); lifecycle++; resourceGeneration++; if (coverUrl) URL.revokeObjectURL(coverUrl); coverUrl = ''; if (timer) clearInterval(timer); timer = 0; if (chrome) chrome.destroy(); if (refs.invitation) refs.invitation.value = ''; if (refs.invitationQr) refs.invitationQr.replaceChildren(); invitationId = ''; invitationExpires = 0; root = null; workspace = null; view = null; messages = []; playbackPending = null; queuePending = null; chatReceipt = null; chatUnknown = null; chatSending = null; chatSongPending = null; admissionRequest = null; startDraft = null; }
  };
})(window);
