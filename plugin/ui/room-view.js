// SPDX-License-Identifier: MIT
// DOM and user intentions only. Session, transport, resources and receipts belong to HertzRoom.
(function (global) {
  'use strict';
  global.HertzRoomView = {
    create(api) {
      const { h, button, field, select, section, refs, selection, metadata, command, control, playback, run, status, sessionKey, current, confirmAction, loadLocal, appendResource, mutateQueue, loadChat, resetChat, sendChat } = api;
  function navigationButton(text, action, cls) { const node = h('button', 'btn ' + (cls || ''), text); node.type = 'button'; node.onclick = action; return node; }
  function iconButton(node, name, label) { node.replaceChildren(global.HertzRoomWorkspace.icon(name), h('span', 'room-visually-hidden', label)); node.setAttribute('aria-label', label); node.title = label; }
  function stageIcon(node, name) { const svg = global.HertzRoomWorkspace.icon(name); svg.setAttribute('class', 'room-stage-ic'); node.prepend(svg); return node; }
  const avatarPresets = global.HertzRoomWorkspace.avatarPresets;
  const legacyAvatars = { disc: 'disc', phones: 'headphones', heart: 'heart', radio: 'radio', queue: 'queue', crown: 'crown', user: 'user', play: 'play' };
  function person(name, preset, big) {
    const node = h('span', 'room-avatar' + (big ? ' room-avatar-big' : ''));
    const symbol = avatarPresets.some(item => item[0] === preset) ? preset : Object.hasOwn(legacyAvatars, preset) ? legacyAvatars[preset] : '';
    node.setAttribute('aria-label', name || '成员');
    if (symbol) { node.dataset.avatar = preset; node.append(global.HertzRoomWorkspace.icon(symbol)); }
    else node.textContent = [...(name || 'H')][0];
    return node;
  }
  function avatarPicker(parent, name) {
    let selected = api.avatar();
    const picker = h('div', 'room-avatar-picker'), preview = h('div', 'room-avatar-preview'), grid = h('div', 'room-avatar-options');
    grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', '选择头像');
    const choices = [];
    const paint = () => {
      preview.replaceChildren(person(name() || 'H', selected, true), h('span', 'room-sub', selected ? '已选择头像 · 仅在本机显示' : '未设置 · 使用昵称首字'));
      choices.forEach(([value, node]) => node.setAttribute('aria-pressed', String(value === selected)));
    };
    avatarPresets.forEach(([value, label]) => { const choice = navigationButton('', () => { selected = value; paint(); }, 'room-avatar-option'); choice.append(person(label, value)); choice.setAttribute('aria-label', '头像 ' + label); choices.push([value, choice]); grid.append(choice); });
    const none = navigationButton('使用昵称首字', () => { selected = ''; paint(); }, 'room-avatar-none'); choices.push(['', none]);
    picker.append(preview, grid, none); parent.append(picker); paint();
    return { value: () => selected, refresh: paint, save: () => api.rememberAvatar(selected) };
  }
  function statePanel(title, detail, symbol, tone) {
    const panel = h('div', 'room-flow-state' + (tone ? ' room-' + tone : '')), ring = h('span', 'room-flow-ring');
    ring.append(global.HertzRoomWorkspace.icon(symbol || 'headphones'));
    panel.append(ring, h('h3', '', title), h('p', 'room-sub', detail)); return panel;
  }
  function drawSummary(summary) {
    const workspace = api.workspace(), page = workspace.pages.summary;
    const passive = ['disconnected', 'dissolved', 'revoked'].includes(summary.reason);
    const passiveTitle = { dissolved: '房间已经结束了', disconnected: '已与房间断开连接', revoked: '你已不在这个房间' };
    page.replaceChildren(statePanel(passive ? passiveTitle[summary.reason] : summary.name + ' · ' + (summary.reason === 'left' ? '已退出' : '已结束'), passive ? summary.reason === 'revoked' ? '成员授权已失效。重新加入需要房主再次批准，或发给你一份新邀请。' : '同步收听已经停止。可以重新创建房间，或看看附近的房间。' : '谢谢大家，下次见。', passive ? 'power' : 'headphones', passive ? 'error' : ''));
    const metrics = h('div', 'room-flow-summary');
    [[summary.tracks.length, '一起听过的歌'], [Math.floor(summary.elapsed_ms / 60000), '分钟'], [summary.members.length, '位参与者']].forEach(([value, label]) => { const cell = h('div'); cell.append(h('b', 'room-mono', value), h('span', '', label)); metrics.append(cell); });
    const members = h('div', 'room-flow-card room-summary-members'); summary.members.forEach(member => members.append(person(member.name, member.avatar))); members.append(h('p', 'room-sub', summary.members.map(member => member.name).join(' · ') || '暂无成员记录'));
    const tracks = section(page, '这段时间里放过');
    if (!summary.tracks.length) tracks.append(h('p', 'room-sub', '还没有开始播放歌曲。'));
    summary.tracks.forEach((track, index) => { const row = h('div', 'room-summary-track'), copy = h('div'); copy.append(h('strong', '', track.title), h('small', 'room-sub', track.artist)); row.append(h('span', 'room-mono', String(index + 1).padStart(2, '0')), copy, h('span', 'room-mono', formatTime(track.duration_ms))); tracks.append(row); });
    page.insertBefore(metrics, tracks); page.insertBefore(members, tracks);
    const actions = h('div', 'room-flow-actions'); actions.append(navigationButton('再来一次', () => { workspace.navigate('lobby'); refs.openCreate(summary.name); }, 'primary'), button('保存收听小结', () => api.exportSummary()), navigationButton('看看附近', () => workspace.navigate('discover', true)), navigationButton('返回 Hertz', api.onReturn)); page.append(h('p', 'room-sub', '小结记录本页面观察到的播放曲目和参与者，不包含离线期间的活动。'), actions);
  }
  function roomArtwork(name, cover) {
    const node = h('div', 'room-card-artwork'); let signature;
    const update = (title, value) => {
      if (signature === title + '\n' + (value || '')) return;
      signature = title + '\n' + (value || '');
      const fallback = h('span', 'room-card-name', title); node.replaceChildren(fallback);
      if (typeof value !== 'string' || value.length > 32800 || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(value)) return;
      const image = h('img'); image.alt = title + '的房间封面'; image.decoding = 'async';
      image.onload = () => { fallback.hidden = true; };
      image.onerror = () => { image.remove(); fallback.hidden = false; };
      image.src = value; node.append(image);
    };
    update(name, cover); return { node, update };
  }
  async function prepareRoomCover(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 8 * 1024 * 1024) throw new Error('请选择 8 MiB 以内的 PNG、JPG 或 WebP 图片');
    const url = URL.createObjectURL(file), image = new Image();
    try {
      image.src = url; await image.decode();
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 8192 || image.naturalHeight > 8192 || image.naturalWidth * image.naturalHeight > 32 * 1024 * 1024) throw new Error('图片尺寸过大，请选择较小的图片');
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
      if (!context) throw new Error('无法处理图片，请重新选择');
      const scale = Math.min(image.naturalWidth / 16, image.naturalHeight / 9), width = scale * 16, height = scale * 9;
      // Keep enough pixels for the card on high-density displays. Photos use
      // JPEG compression before reducing resolution; flat artwork keeps PNG.
      for (const size of [512, 448, 384, 320]) {
        canvas.width = size; canvas.height = size * 9 / 16;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, (image.naturalWidth - width) / 2, (image.naturalHeight - height) / 2, width, height, 0, 0, canvas.width, canvas.height);
        const value = canvas.toDataURL('image/png');
        if (atob(value.split(',')[1]).length <= 24 * 1024) return value;
        context.globalCompositeOperation = 'destination-over';
        context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.globalCompositeOperation = 'source-over';
        for (const quality of [0.9, 0.82, 0.74, 0.66, 0.58]) {
          const photo = canvas.toDataURL('image/jpeg', quality);
          if (atob(photo.split(',')[1]).length <= 24 * 1024) return photo;
        }
      }
      throw new Error('图片无法缩小到可共享的大小，请选择其他图片');
    } catch (error) { throw new Error(error.message || '无法读取这张图片，请重新选择'); }
    finally { URL.revokeObjectURL(url); }
  }
  function coverEditor(parent, initial, roomName) {
    let value = initial || null, dirty = false, generation = 0;
    const key = sessionKey(), container = h('div', 'room-cover-editor'), artwork = roomArtwork(roomName(), value);
    const input = field(container, '房间封面（可选）', 'file'); input.accept = 'image/png,image/jpeg,image/webp';
    const tools = h('div', 'room-toolbar');
    const remove = button('移除封面', () => { generation++; value = null; dirty = true; input.value = ''; paint(); });
    tools.append(remove); container.append(artwork.node, h('p', 'room-sub', '选择本机图片，附近的人可在大厅查看；未设置时显示房间名称。'), tools); parent.append(container);
    const paint = () => { artwork.update(roomName(), value); remove.disabled = !value; if (editor.onchange) editor.onchange(dirty); };
    const editor = { value: () => value, dirty: () => dirty, onchange: null,
      confirm(confirmed) { if (!dirty && confirmed !== value) { value = confirmed || null; paint(); } },
      saved(confirmed) { generation++; dirty = false; value = confirmed || null; input.value = ''; paint(); },
      rename() { paint(); }
    };
    input.onchange = () => run(async () => {
      const file = input.files && input.files[0]; if (!file) return;
      const request = ++generation;
      try { const next = await prepareRoomCover(file); if (current(key) && generation === request) { value = next; dirty = true; paint(); } }
      finally { if (generation === request) input.value = ''; }
    });
    paint(); return editor;
  }
  function mountEntry() {
    const workspace = api.workspace(), page = workspace.pages.lobby, nearbyPage = workspace.pages.discover;
    const nicknameFields = [];
    function nicknameField(parent, initial) {
      const input = field(parent, '你的昵称', 'text', api.nickname() || ''); input.placeholder = initial === '房主' ? '朋友们会看到这个名字' : '输入朋友熟悉的昵称'; input.maxLength = 32; input.autocomplete = 'nickname';
      input.oninput = () => nicknameFields.forEach(other => { if (other !== input) other.value = input.value; });
      nicknameFields.push(input); return input;
    }
    function readNickname(input) {
      const value = input.value.trim();
      if (!value || [...value].length > 32 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('请输入 1–32 个字符的昵称，不含控制字符');
      api.rememberNickname(value); return value;
    }
    const createDialog = workspace.createEntryDialog('create', '创建房间'), joinDialog = workspace.createEntryDialog('join', '通过邀请加入');
    refs.openCreate = roomName => { if (typeof roomName === 'string') { name.value = [...roomName].slice(0, 64).join(''); createCover.rename(); } const draft = api.startDraft(); sourceHint.hidden = !draft; sourceHint.textContent = draft ? '将仅分享并添加你选中的 ' + draft.tracks.length + ' 首歌曲：' + draft.tracks.slice(0, 3).map(track => track.title || track.id).join('、') + '。创建后不会自动开始播放。' : ''; createDialog.open(name); };
    const applyDialog = workspace.createEntryDialog('apply', '申请加入房间'); let candidate = null;
    const applicantRoom = h('p', 'room-sub'); applyDialog.body.append(applicantRoom);
    const applicantName = nicknameField(applyDialog.body, '收听电脑'), applicantAvatar = avatarPicker(applyDialog.body, () => applicantName.value), applicantListen = field(applyDialog.body, '申请通过后在本机收听', 'checkbox'); applicantListen.checked = true;
    applyDialog.body.append(button('提交申请', async () => {
      if (!candidate) throw new Error('请先选择房间');
      const name = readNickname(applicantName), room = candidate, key = sessionKey();
      if (!await applyDialog.confirm('房间：' + room.name + '\n主机：' + (room.addresses || [])[0] + '\n指纹：' + room.fingerprint) || !current(key)) return { cancelled: true };
      const submitted = await api.applyForRoom(room, name, applicantListen.checked, true);
      if (submitted) { applicantAvatar.save(); applyDialog.close(); workspace.navigate('application', true); }
    }, 'primary'));
    const welcome = statePanel('和身边的人，听同一首歌', '创建一间房间，朋友们在同一网络里加入，进度实时同步。');
    const shortcuts = h('div', 'room-flow-actions'); welcome.append(shortcuts); page.append(welcome);
    page.append(navigationButton('看看附近的房间', () => workspace.navigate('discover', true), 'room-text-button'));
    const discovery = section(nearbyPage, '附近的房间', 'room-discovery');
    refs.applicationLinks = [page, nearbyPage].map(parent => { const link = navigationButton('查看入房申请', () => workspace.navigate('application', true)); link.hidden = !api.application(); parent.prepend(link); return link; });
    const search = field(discovery, '搜索房间名称或房间码', 'search');
    const count = h('p', 'room-sub', '尚未发现房间'); refs.nearby = h('div', 'room-nearby-grid');
    const discoveryError = h('div', 'room-discovery-error room-notice room-error'); discoveryError.hidden = true; discoveryError.setAttribute('role', 'alert');
    const refreshButtons = []; let rooms = [], discoverState = 'idle', discovered = false;
    const renderRooms = () => {
      const visible = rooms.filter(room => ((room.name || '') + ' ' + (room.room_code || '')).toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
      count.textContent = discoverState === 'loading' ? '正在刷新…' : rooms.length + ' 间房间可被发现 · 加入前由房主批准' + (search.value ? ' · ' + visible.length + ' 间符合搜索' : '') + (discoverState === 'error' ? ' · 刷新失败，仍显示上次结果' : ''); refs.nearby.replaceChildren();
      refs.nearby.setAttribute('aria-busy', String(discoverState === 'loading'));
      refreshButtons.forEach(node => { node.disabled = discoverState === 'loading'; });
      if (discoverState === 'loading') {
        for (let i = 0; i < Math.max(2, Math.min(rooms.length, 6)); i++) { const skeleton = h('div', 'room-discovery-skeleton'); skeleton.setAttribute('aria-hidden', 'true'); skeleton.append(h('span'), h('div'), h('span')); refs.nearby.append(skeleton); }
        return;
      }
      visible.forEach(room => {
        const card = h('article', 'room-nearby-card'), copy = h('div', 'room-card-copy'), actions = h('div', 'room-card-actions');
        const title = room.name || '音乐房间';
        const full = room.member_capacity != null && Number(room.online_count) >= Number(room.member_capacity);
        copy.append(h('h4', '', title), h('p', 'room-sub', room.room_code ? '房间码 ' + room.room_code + ' · 加入前由房主审批' : '加入前需要房主的一次性邀请'), h('span', 'room-tag' + (full ? ' room-tag-warn' : ''), full ? '已满 ' + room.online_count + '/' + room.member_capacity : room.room_code ? '可申请' : '仅邀请'));
        if (room.room_code && room.fingerprint) { const apply = navigationButton('申请加入', () => { candidate = room; applicantRoom.textContent = '申请加入「' + title + '」\n主机：' + (room.addresses || [])[0] + '\n指纹：' + room.fingerprint + '\n提交后等待房主批准。'; applicantAvatar.refresh(); applyDialog.open(applicantName); }, 'primary'); apply.disabled = full; apply.title = full ? '房间人数已满，请刷新列表或选择其他房间' : '提交申请，由房主批准'; actions.append(apply); }
        actions.append(navigationButton('使用邀请加入', () => joinDialog.open(invitation))); card.append(roomArtwork(title, room.cover).node, copy, actions);
        refs.nearby.append(card);
      });
      if (!visible.length) { const empty = statePanel(rooms.length ? '没有匹配的房间' : discoverState === 'error' ? '暂时无法发现房间' : '没有发现任何房间', rooms.length ? '试试其他房间名称或查找码。' : '确认大家连接同一个 Wi-Fi，检查 AP 隔离、房主的发现设置和系统防火墙。', 'radio', discoverState === 'error' ? 'error' : ''); empty.append(navigationButton('使用邀请加入', () => joinDialog.open(invitation))); refs.nearby.append(empty); }
    };
    search.oninput = renderRooms;
    refs.application = h('div', 'room-application'); refs.application.hidden = true; workspace.pages.application.append(refs.application); discovery.append(count);
    shortcuts.append(navigationButton('+ 创建房间', () => refs.openCreate(), 'primary'), navigationButton('使用邀请加入', () => joinDialog.open(invitation)));
    const create = createDialog.body; create.append(h('p', 'room-sub', '创建后可分享本地歌曲，或从在线歌曲列表加入一起听。'));
    const sourceHint = h('p', 'room-notice'); sourceHint.hidden = true; create.append(sourceHint);
    const name = field(create, '房间名称', 'text', '我的音乐房间'); name.maxLength = 64;
    const hostName = nicknameField(create, '房主');
    const hostAvatar = avatarPicker(create, () => hostName.value);
    const output = field(create, '本机同时收听', 'checkbox'); output.checked = true;
    const advanced = h('details', 'room-create-advanced'); advanced.append(h('summary', '', '封面与高级设置')); create.append(advanced);
    const createCover = coverEditor(advanced, null, () => name.value.trim() || '我的音乐房间'); name.oninput = () => createCover.rename();
    const address = select(create, '局域网网卡', [['', '先发现可用网卡']]);
    const networkHelp = h('p', 'room-sub'); create.append(networkHelp);
    const port = field(advanced, '端口（0 为自动选择）', 'number', '0'); port.min = 0; port.max = 65535;
    const rate = select(advanced, '房间采样率', [['44100', '44.1 kHz'], ['48000', '48 kHz'], ['96000', '96 kHz'], ['192000', '192 kHz']]); rate.value = '48000';
    const discoverable = field(advanced, '允许附近的人发现房间', 'checkbox'); discoverable.checked = true;
    create.append(button('创建房间', async () => { const host_name = readNickname(hostName); if (!address.value) throw new Error('请先选择网卡'); if (!name.value.trim()) throw new Error('请输入房间名称'); if (!Number.isInteger(Number(port.value)) || Number(port.value) < 0 || Number(port.value) > 65535) throw new Error('端口需为 0–65535 的整数'); hostAvatar.save(); await api.createRoom({ name: name.value.trim(), host_name, cover: createCover.value(), address: address.value + ':' + Number(port.value), sample_rate: Number(rate.value), local_output: output.checked, discoverable: discoverable.checked }); }, 'primary'));
    const join = joinDialog.body; join.append(h('p', 'room-sub', '粘贴房主发来的一次性邀请，核对主机指纹后加入。'));
    const nickname = nicknameField(join, '收听电脑');
    const avatarStep = workspace.createEntryDialog('join-avatar', '给自己一个头像');
    avatarStep.body.append(h('p', 'room-sub', '选择你在本机看到的头像。可以不设，也可以稍后更换；其他设备目前仍显示昵称首字。'));
    const guestAvatar = avatarPicker(avatarStep.body, () => nickname.value);
    let joinOpener;
    const returnToJoin = () => { avatarStep.close(); joinDialog.open(invitation, joinOpener); };
    avatarStep.body.append(navigationButton('保存并继续', () => { guestAvatar.save(); returnToJoin(); }, 'primary'), navigationButton('以后再说', returnToJoin));
    join.append(navigationButton('设置头像（可选）', () => { joinOpener = joinDialog.opener(); guestAvatar.refresh(); avatarStep.open(); }));
    const invitation = field(join, '邀请或 8 位查找码', 'textarea'); invitation.maxLength = 2048; invitation.autocomplete = 'off'; invitation.spellcheck = false;
    const listen = field(join, '在本机播放音频', 'checkbox'); listen.checked = true;
    const pin = h('p', 'room-mono room-pin'); join.append(pin);
    const invitationPreview = h('div', 'room-flow-card room-invitation-preview'); invitationPreview.hidden = true; join.append(invitationPreview);
    function inviteToken() { const text = invitation.value.trim(), token = text.match(/hertz-listen:v1:[A-Za-z0-9_-]+={0,2}/); return token ? token[0] : text; }
    invitation.oninput = () => { try { const data = JSON.parse(atob(inviteToken().replace(/^hertz-listen:v1:/, '').replace(/-/g, '+').replace(/_/g, '/'))); if (typeof data.address !== 'string' || typeof data.fingerprint !== 'string' || !data.address || !data.fingerprint) throw new Error(); pin.textContent = '主机：' + data.address + '\n指纹：' + data.fingerprint; const room = rooms.find(item => item.room_id === data.room_id); invitationPreview.replaceChildren(h('strong', '', room ? room.name : '收到一份一起听邀请'), h('p', 'room-sub', '一次性邀请仅限一人使用。有效期和参与权限以房主发出的邀请为准；请在加入前与房主核对完整指纹。')); invitationPreview.hidden = false; } catch (_) { pin.textContent = ''; invitationPreview.hidden = true; } };
    let joinUnknown = false;
    const joinButton = button('加入房间', async () => {
      if (joinUnknown) throw new Error('请先查看原加入结果，邀请可能已被使用，不能重复提交。');
      const guestName = readNickname(nickname), code = inviteToken(); guestAvatar.save();
      const key = sessionKey();
      if (/^[a-z0-9]{8}$/i.test(code)) {
        await discover(); if (!current(key)) return;
        const matches = rooms.filter(room => String(room.room_code || '').toUpperCase() === code.toUpperCase());
        if (matches.length !== 1) throw new Error(matches.length ? '发现了相同查找码，请从附近房间选择并核对房主。' : '未在当前局域网发现此房间，请检查是否连接同一网络，或使用完整邀请。');
        const room = matches[0];
        if (!await joinDialog.confirm('房间：' + room.name + '\n主机：' + (room.addresses || [])[0] + '\n指纹：' + room.fingerprint) || !current(key)) return { cancelled: true };
        if (await api.applyForRoom(room, guestName, listen.checked, true)) joinDialog.close(); return;
      }
      if (!pin.textContent) throw new Error('请粘贴有效的房主邀请，或输入 8 位查找码');
      if (!await joinDialog.confirm(pin.textContent) || !current(key)) return { cancelled: true };
      joinButton.disabled = true;
      try { await command({ action: 'join', invitation: code, name: guestName, listen: listen.checked }); }
      catch (error) {
        if (current(key) && api.uncertain(error)) { joinUnknown = true; joinCheck.hidden = false; status('加入结果尚未确认，邀请可能已使用。请查看加入结果，当前不会重复提交。', true); return; }
        const code = error.code || '';
        const full = /capacity|full|limit/.test(code + ' ' + error.message);
        const denied = /denied|expired|invitation|authorization|pairing rejected/i.test(code + ' ' + error.message);
        if (current(key) && (full || denied)) {
          const failure = statePanel(full ? '房间人数已满' : '这份邀请已经不能用了', full ? '房间的成员或音频位置已满。请等待有人离开，或看看其他房间。' : '邀请可能已使用、已过期或被撤销。请向房主索取新邀请，也可以用房间查找码申请加入。', full ? 'user' : 'power', 'error');
          failure.append(navigationButton('粘贴新的邀请', () => { failure.remove(); invitation.focus(); }), navigationButton('看看附近', () => { joinDialog.close(); workspace.navigate('discover', true); })); join.append(failure);
        }
        throw error;
      } finally { if (current(key)) joinButton.disabled = joinUnknown; }
    }, 'primary');
    const joinCheck = button('查看加入结果', async () => { const mode = await api.readJoinStatus(); if (mode === 'local') status('暂未确认已加入。请稍后再次查看；原邀请可能已使用，不会重新提交。', true); }); joinCheck.hidden = true;
    join.append(joinButton, joinCheck);
    const saved = h('p', 'room-sub', '正在读取上次加入的房间…');
    const resume = button('重新加入上次房间', () => command({ action: 'resume' })); resume.disabled = true; join.append(saved, resume);
    const entryKey = sessionKey();
    command({ action: 'saved_room' }).then(data => { if (!current(entryKey)) return; const room = data.saved_room; resume.disabled = !room; saved.textContent = room ? '上次以「' + room.name + '」加入 ' + room.address + '。点击重新加入后才会连接。' : '没有保存的房间。首次加入需要房主邀请。'; }).catch(e => { if (current(entryKey)) { saved.textContent = e.message || '无法读取保存的房间'; saved.classList.add('room-error'); } });
    let discovering = null;
    const discover = () => {
      if (discovering) return discovering;
      discovering = (async () => {
      const key = sessionKey(); discoverState = 'loading'; discoveryError.hidden = true; renderRooms();
      try {
      const data = await command({ action: 'discover' }); if (!current(key)) return;
      const selected = address.value; address.replaceChildren();
      const networks = (data.interfaces || []).filter(i => !i.loopback);
      const placeholder = h('option', '', networks.length > 1 ? '检测到多个网络，请选择朋友所在网络' : '选择可用网络'); placeholder.value = ''; address.append(placeholder);
      (data.interfaces || []).forEach(i => { const ip = i.address.includes(':') ? '[' + i.address + (i.address.startsWith('fe80:') && i.index ? '%' + i.index : '') + ']' : i.address; const option = h('option', '', i.name + ' · ' + i.address + (i.loopback ? '（本机）' : '')); option.value = ip; address.append(option); });
      if (selected && Array.from(address.children).some(option => option.value === selected)) address.value = selected;
      else if (networks.length === 1) { const i = networks[0]; address.value = i.address.includes(':') ? '[' + i.address + (i.address.startsWith('fe80:') && i.index ? '%' + i.index : '') + ']' : i.address; }
      else address.value = '';
      networkHelp.textContent = networks.length === 1 ? '已选择唯一可用的局域网，朋友需要连接同一网络。' : networks.length > 1 ? 'Wi-Fi、有线或虚拟网卡同时可用，请确认房间对外使用的网络。' : '未检测到局域网连接，本机回环地址仅能用于测试。';
      if (data.discovery_available === false) throw new Error('局域网发现服务暂不可用，仍可使用完整邀请加入。');
      rooms = Array.isArray(data.rooms) ? data.rooms : []; discoverState = 'idle'; discovered = true;
      } catch (error) { if (!current(key)) return; discoverState = 'error'; discoveryError.textContent = '没能拿到最新房间列表。' + (discovered ? '当前保留上次结果。' : '') + (error.message || '请检查网络后重试。'); discoveryError.hidden = false; }
      finally { if (current(key)) renderRooms(); }
      })().finally(() => { discovering = null; });
      return discovering;
    };
    const networkRefresh = button('刷新网卡', discover), refresh = button('发现房间与网卡', discover); refresh.setAttribute('aria-label', '刷新房间列表'); refreshButtons.push(networkRefresh, refresh);
    create.append(networkRefresh);
    discovery.append(refresh, discoveryError, h('p', 'room-sub', '没有找到？确认大家连接的是同一个 Wi-Fi，或让房主发一份邀请。'), refs.nearby, navigationButton('返回开始', () => workspace.navigate('lobby', true)));
    const recent = section(page, '最近一起听过', 'room-recent');
    const history = api.recentSessions();
    if (!history.length) recent.append(statePanel('这里还没有人', '第一次一起听过之后，房间和参与者会出现在这里，下次可以再开一间。', 'user'));
    history.forEach(record => { const row = h('div', 'room-history-row'), copy = h('div'); copy.append(h('strong', '', record.name), h('p', 'room-sub', record.members.map(member => member.name).join(' · ') + ' · 听过 ' + (record.track_count || record.tracks.length) + ' 首')); row.append(person(record.name), copy, navigationButton('再开一间', () => refs.openCreate(record.name))); recent.append(row); });
    const entrySettings = workspace.createEntryDialog('entry-settings', '一起听设置'), settingsName = nicknameField(entrySettings.body, '收听电脑');
    const settingsAvatar = avatarPicker(entrySettings.body, () => settingsName.value);
    entrySettings.body.append(button('保存资料', () => { readNickname(settingsName); settingsAvatar.save(); entrySettings.close(); status('本机资料已保存。'); }, 'primary'));
    refs.openEntrySettings = () => { settingsAvatar.refresh(); entrySettings.open(settingsName); };
    refs.renderEntryPage = next => { if (next === 'discover' && !discovered && discoverState !== 'loading') discover(); };
    if (api.summary()) { drawSummary(api.summary()); workspace.navigate('summary'); }
    renderRooms();
    discover().catch(error => { if (current(entryKey)) status(error.message || '发现房间失败，请点击重新发现。', true); });
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
  function mountDsp(parent, timerParent) {
    refs.dsp = section(parent, '房间音效'); const row = h('div', 'room-form-grid'); refs.dsp.append(row);
    const mode = refs.mode = select(row, '播放模式', [['repeat', '列表循环'], ['repeat_one', '单曲循环'], ['shuffle', '随机播放']]);
    refs.roomVolume = field(row, '房间音量（0–100）', 'number', 100); refs.roomVolume.min = 0; refs.roomVolume.max = 100;
    row.append(refs.volumeApply = button('应用房间音量', () => control('volume', { volume: Number(refs.roomVolume.value) / 100 })), refs.modeApply = button('应用播放模式', () => control('mode', { mode: mode.value })));
    refs.hostDsp = h('div', 'room-form-grid'); const loudness = refs.loudness = select(refs.hostDsp, '响度归一化', [['off', '关闭'], ['track', '曲目'], ['album', '专辑']]); const fade = refs.fade = field(refs.hostDsp, '交叉淡化（毫秒）', 'number', 0); fade.min = 0; fade.max = 8000;
    const preamp = refs.preamp = field(refs.hostDsp, '前置增益（dB）', 'number', 0); preamp.min = -24; preamp.max = 12;
    const eq = refs.eq = [60, 150, 400, 1000, 2400, 6000].map(f => { const input = field(refs.hostDsp, f + ' Hz（dB）', 'number', 0); input.min = -12; input.max = 12; return input; });
    refs.hostDsp.append(button('应用房间音效', () => command({ action: 'dsp', params: { eq_gains_db: eq.map(i => Number(i.value)), preamp_db: Number(preamp.value), track_gain_db: 0 }, crossfade_ms: Number(fade.value), loudness_mode: loudness.value }))); refs.dsp.append(refs.hostDsp);
    refs.sleep = section(timerParent, '睡眠定时');
    refs.sleepStatus = h('p', 'room-sub');
    const minutes = field(refs.sleep, '多少分钟后暂停（最多 480 分钟）', 'number', 30); minutes.min = 1; minutes.max = 480;
    refs.sleep.append(refs.sleepStatus, button('设置定时', async () => {
      const value = Number(minutes.value);
      if (!Number.isFinite(value) || value < 1 || value > 480) throw new Error('请输入 1 至 480 分钟');
      await command({ action: 'sleep_timer', seconds: Math.round(value * 60) });
    }), button('取消定时', () => command({ action: 'sleep_timer', seconds: null })), h('p', 'room-sub', '房主服务负责计时。关闭页面仍会到期安排全房间暂停。'));
  }
  function mountChat(parent, scene, stageDock) {
    const chat = section(parent, '房间聊天', 'room-chat-section'); refs.chat = h('ol', 'room-chat'); refs.chat.setAttribute('aria-label', '聊天消息'); chat.append(refs.chat);
    const chatDock = h('div', 'room-chat-compose-dock'), composer = h('div', 'room-chat-composer'); chat.append(chatDock);
    refs.chatStatus = h('p', 'room-sub room-composer-status'); composer.append(refs.chatStatus);
    refs.chatOperation = h('div', 'room-operations'); composer.append(refs.chatOperation);
    refs.chatSongPending = h('p', 'room-song-message'); refs.chatSongPending.hidden = true; composer.append(refs.chatSongPending);
    const form = h('form', 'room-chat-form'); refs.chatInput = field(form, '说点什么（最多 200 字）', 'textarea'); refs.chatInput.maxLength = 400;
    refs.chatSend = h('button', 'btn primary', '发送'); refs.chatSend.type = 'submit'; form.append(refs.chatSend);
    window.hertzHost.onSubmit(form, () => run(() => sendChat())); composer.append(form);
    refs.chatInput.placeholder = '发条弹幕，一起聊聊这首歌';
    const show = field(composer, '显示实时弹幕', 'checkbox');
    try { show.checked = localStorage.getItem('hertz.room.danmaku') !== 'off'; } catch (_) { show.checked = true; }
    refs.danmaku = h('div', 'room-danmaku'); refs.danmaku.hidden = !show.checked; refs.danmaku.setAttribute('aria-hidden', 'true'); scene.append(refs.danmaku);
    show.onchange = () => { refs.danmaku.hidden = !show.checked; if (!show.checked) refs.danmaku.replaceChildren(); try { localStorage.setItem('hertz.room.danmaku', show.checked ? 'on' : 'off'); } catch (_) {} };
    let stageOverlay = null, stageComposerDock = null, composerPage = api.workspace().currentPage();
    refs.placeChatComposer = page => {
      composerPage = page;
      (stageOverlay ? stageComposerDock : page === 'play' ? stageDock : chatDock).append(composer);
      refs.chatSend.textContent = stageOverlay || page === 'play' ? '发送弹幕' : '发送';
    };
    refs.setStageVisible = visible => {
      if (visible && !stageOverlay) {
        const stage = document.getElementById('stage3d'); if (!stage) return;
        stageOverlay = h('div', 'room-stage-overlay');
        const toolbar = h('div', 'room-stage-room-bar');
        refs.stageNotice = h('p', 'room-stage-notice'); refs.stageNotice.setAttribute('role', 'status'); refs.stageNotice.hidden = true;
        const back = stageIcon(navigationButton('返回一起听', () => { global.Stage3D.close(); api.onNavigate('room'); }, 'room-stage-pill'), 'arrow-left');
        const add = stageIcon(navigationButton('点歌 / 共同队列', () => { global.Stage3D.close(); api.onNavigate('room'); api.workspace().navigate('collaborate', true); refs.openSongPicker(); }, 'room-stage-pill'), 'queue');
        const note = h('span', 'room-stage-note', '我的舞台 · 画面设置仅对自己生效');
        toolbar.append(back, add, note);
        const chatFloat = h('div', 'room-stage-chat');
        const toggle = refs.stageChatToggle = stageIcon(h('button', 'room-stage-pill room-stage-chat-toggle', '弹幕'), 'chat');
        toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'room-stage-chat-panel');
        const panel = refs.stageChatPanel = h('div', 'room-stage-chat-panel'); panel.id = 'room-stage-chat-panel'; panel.hidden = true;
        const head = h('div', 'room-stage-chat-head'); head.append(h('strong', '', '聊天记录'));
        const close = stageIcon(h('button', 'room-stage-chat-close'), 'close'); close.type = 'button'; close.title = '收起聊天记录'; close.setAttribute('aria-label', '收起聊天记录');
        close.onclick = () => setStageChatPanel(false);
        head.append(close);
        const log = refs.stageChatLog = h('div', 'room-stage-chat-log'), tools = h('div', 'room-stage-chat-tools');
        stageComposerDock = h('div', 'room-stage-composer-dock');
        panel.append(head, log, tools, stageComposerDock);
        toggle.onclick = () => setStageChatPanel(panel.hidden);
        chatFloat.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { event.stopPropagation(); setStageChatPanel(false); toggle.focus(); } });
        chatFloat.append(toggle, panel);
        stageOverlay.append(toolbar, refs.stageNotice, chatFloat, refs.danmaku); stage.append(stageOverlay);
        stage.classList.add('s3d-room-live');
        log.append(refs.chat); tools.append(refs.chatOlder, refs.chatNewest);
        setStageChatPanel(false);
      } else if (!visible && stageOverlay) {
        chat.insertBefore(refs.chat, chatDock); chat.append(refs.chatOlder, refs.chatNewest);
        scene.append(refs.danmaku); refs.danmaku.replaceChildren(); refs.danmakuLanes = null;
        const stage = document.getElementById('stage3d'); if (stage) stage.classList.remove('s3d-room-live');
        const old = stageOverlay; stageOverlay = null; refs.placeChatComposer(composerPage); old.remove(); stageComposerDock = null;
        delete refs.stageNotice;
      }
      refs.placeChatComposer(composerPage);
    };
    function setStageChatPanel(open) {
      if (!refs.stageChatPanel) return;
      refs.stageChatPanel.hidden = !open;
      refs.stageChatToggle.setAttribute('aria-expanded', String(open));
      refs.stageChatToggle.classList.toggle('is-on', open);
      if (open) { refs.stageChatLog.scrollTop = refs.stageChatLog.scrollHeight; refs.chatInput.focus({ preventScroll: true }); }
    }
    refs.placeChatComposer(api.workspace().currentPage());
    refs.chatOlder = button('更早消息', async () => loadChat(true));
    chat.append(refs.chatOlder, refs.chatNewest = button('回到最新消息', async () => { resetChat(); await loadChat(); }));
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
    const previousScroll = refs.queue.scrollTop;
    const active = document.activeElement, activeRow = active && active.closest && active.closest('.room-track');
    const focusId = activeRow && refs.queue.contains && refs.queue.contains(activeRow) ? activeRow.dataset.instance : null;
    const focusLabel = focusId && (active.getAttribute('aria-label') || active.textContent);
    const opened = refs.queue.querySelector && refs.queue.querySelector('.room-track-more[open]');
    const openedId = opened && opened.closest('.room-track').dataset.instance;
    let restoreMenu, restoreFocus;
    global.HertzRoomWorkspace.closeMenus(refs.queue);
    refs.queue.replaceChildren(); refs.queuePreview.replaceChildren();
    if (!items.length) refs.queue.append(h('li', 'room-empty', '队列还没有歌曲。点击上方「点歌」，添加第一首。'));
    items.forEach((q, i) => {
      const t = metadata.get(q.resource_id), snapshot = api.snapshot(), p = { ...(snapshot.permissions || {}) };
      if (!['host', 'guest'].includes(snapshot.mode)) p.queue = p.transport = p.chat_send = false;
      const playing = q.instance_id === snapshot.track_instance_id, locked = playing || q.votable === false;
      const manual = !snapshot.collaboration || snapshot.collaboration.queue_order !== 'votes';
      const row = h('li', playing ? 'room-track active' : 'room-track'); row.dataset.instance = q.instance_id;
      row.setAttribute('aria-current', playing ? 'true' : 'false');
      const index = h('span', 'room-mono room-queue-index', playing ? '' : String(api.queueOffset() + i + 1).padStart(2, '0'));
      if (playing) { index.setAttribute('aria-label', '播放中'); index.append(h('i'), h('i'), h('i')); }
      row.append(index);
      const copy = h('div', 'room-track-copy'), title = h('strong', '', t ? t.title : '共享歌曲'); title.title = title.textContent; copy.append(title);
      const who = q.requester && q.requester.name ? (q.requester.id === snapshot.member_id ? '你点的' : q.requester.name + '点的') : '';
      const subtitle = h('small', 'room-sub', [t && t.artist, who].filter(Boolean).join(' · ')); subtitle.title = [subtitle.textContent, !playing && locked ? '即将播放 · 顺序已锁定' : ''].filter(Boolean).join(' · '); copy.append(subtitle); row.append(copy);
      if (!playing && locked) { const lock = h('span', 'room-track-lock', '待播'); lock.title = '即将播放，顺序已锁定'; row.append(lock); }
      const play = button('播放', () => playback('pick', { instance_id: q.instance_id }), 'room-queue-play');
      iconButton(play, 'play', '播放');
      play.disabled = !p.transport; play.title = p.transport ? '播放这首歌' : '房主尚未授权播控'; row.append(play);
      if (typeof q.votes === 'number') {
        const vote = button((q.voted_by_me ? '已支持 ' : '支持 ') + q.votes, () => api.vote(q.instance_id, !q.voted_by_me), 'room-vote' + (q.voted_by_me ? ' room-voted' : ''));
        vote.disabled = !p.queue || !q.votable; vote.title = locked ? '这首歌已经开始准备播放，顺序已锁定' : !p.queue ? '房主暂未开放点歌' : '支持这首歌排在前面';
        vote.setAttribute('aria-pressed', String(!!q.voted_by_me)); row.append(vote);
      }
      const menu = global.HertzRoomWorkspace.createMenu(h, '更多歌曲操作'), more = menu.node, actions = menu.panel;
      actions.append(h('strong', 'room-menu-title', t ? t.title : '共享歌曲'));
      if (!playing && locked) actions.append(h('span', 'room-sub', '即将播放 · 顺序已锁定'));
      if (t && t.duration_ms) actions.append(h('span', 'room-sub', '时长 ' + formatTime(t.duration_ms)));
      if (t) api.attachFavorite(actions, t);
      if (p.chat_send && t) actions.append(button('分享歌曲', () => api.shareSong(q.resource_id)));
      const move = direction => mutateQueue(all => {
        const index = all.findIndex(x => x.instance_id === q.instance_id), next = index + direction;
        if (index < 0 || next < 0 || next >= all.length) return null;
        [all[index], all[next]] = [all[next], all[index]]; return all;
      });
      if (p.queue) {
        for (const [label, direction] of [['上移', -1], ['下移', 1]]) {
          const control = button(label, () => move(direction)); control.disabled = !manual || locked || (direction < 0 && (api.queueOffset() + i === 0 || i > 0 && (items[i - 1].instance_id === snapshot.track_instance_id || items[i - 1].votable === false))) || direction > 0 && api.queueOffset() + i >= Number(snapshot.queue_count || 0) - 1;
          control.title = !manual ? '按票数排序时不能手动移动' : locked ? '这首歌的顺序已锁定' : label + '这首歌'; actions.append(control);
        }
        const remove = button('移除', () => { menu.close(); return mutateQueue(all => all.filter(x => x.instance_id !== q.instance_id)); }, 'room-menu-danger'); remove.disabled = locked; remove.title = locked ? '正在播放或准备中的歌曲不能移除' : '从共同队列移除'; actions.append(remove);
      }
      row.draggable = !!p.queue && manual && !locked; row.classList.toggle('is-draggable', row.draggable);
      row.ondragstart = event => { if (!row.draggable) { event.preventDefault(); return; } event.dataTransfer.setData('application/x-hertz-queue', q.instance_id); event.dataTransfer.effectAllowed = 'move'; };
      row.ondragover = event => { if (row.draggable && Array.from(event.dataTransfer.types).includes('application/x-hertz-queue')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } };
      row.ondrop = event => {
        const id = event.dataTransfer.getData('application/x-hertz-queue'); if (!row.draggable || !id || id === q.instance_id) return; event.preventDefault();
        run(() => mutateQueue(all => { const from = all.findIndex(x => x.instance_id === id), to = all.findIndex(x => x.instance_id === q.instance_id); if (from < 0 || to < 0) return null; const [entry] = all.splice(from, 1); all.splice(to, 0, entry); return all; }));
      };
      row.append(more); refs.queue.append(row);
      if (openedId === q.instance_id) restoreMenu = menu.open;
      if (focusId === q.instance_id) {
        const target = [...row.querySelectorAll('button,summary')].find(node => (node.getAttribute('aria-label') || node.textContent) === focusLabel);
        if (target) {
          const controls = [...actions.querySelectorAll('button')], index = controls.indexOf(target);
          restoreFocus = !target.disabled ? target : controls.slice(index + 1).find(node => !node.disabled) || controls.slice(0, index).reverse().find(node => !node.disabled) || more.querySelector('summary');
        }
      }
    });
    if (previousScroll != null) refs.queue.scrollTop = previousScroll;
    if (restoreMenu) restoreMenu();
    if (restoreFocus) restoreFocus.focus({ preventScroll: true });
  }
  function formatTime(ms) { const value = Math.max(0, Number(ms || 0)); return Math.floor(value / 60000) + ':' + String(Math.floor(value / 1000) % 60).padStart(2, '0'); }
  const addedResources = new Set();
  function drawLibrary(items) {
    global.HertzRoomWorkspace.closeMenus(refs.library);
    items.forEach(t => metadata.set(t.resource_id, t)); refs.library.replaceChildren();
    if (!items.length) refs.library.append(h('p', 'room-empty', refs.librarySearch && refs.librarySearch.value.trim() ? '没有匹配的共享歌曲，试试其他关键词。' : api.snapshot().mode === 'host' ? '还没有共享歌曲。可从本机曲库选择歌曲分享。' : '房主还没有分享歌曲。分享后即可在这里点歌。'));
    items.forEach(t => {
      const row = h('div', 'room-track'), label = h('div', 'room-track-copy'), session = sessionKey(), key = session + ':' + t.resource_id;
      label.append(h('strong', '', t.title), h('small', 'room-sub', t.artist || '未知歌手')); row.append(label);
      const add = button(addedResources.has(key) ? '再加入一次' : '加入队列', async () => {
        add.disabled = true; add.textContent = '正在添加…';
        try { await appendResource(t.resource_id); if (!current(session)) return; if (!api.queueUncertain()) { addedResources.add(key); status('已加入共同队列。'); add.textContent = '再加入一次'; } else add.textContent = '正在确认是否已加入'; }
        finally { add.disabled = !!api.queueUncertain(); if (add.textContent === '正在添加…') add.textContent = '加入队列'; }
      }, 'room-library-add');
      add.disabled = !(api.snapshot().permissions || {}).queue || !['host', 'guest'].includes(api.snapshot().mode) || api.queueUncertain(); add.title = !(api.snapshot().permissions || {}).queue ? '房主暂未开放点歌' : !['host', 'guest'].includes(api.snapshot().mode) ? '等待房间恢复连接' : '加入共同队列'; row.append(add);
      const menu = global.HertzRoomWorkspace.createMenu(h, '更多歌曲操作'); menu.panel.append(h('strong', 'room-menu-title', t.title)); api.attachFavorite(menu.panel, t); row.append(menu.node); refs.library.append(row);
    });
  }
  function drawMembers() {
    const snapshot = api.snapshot();
    const count = snapshot.online_count == null ? (snapshot.members || []).length : snapshot.online_count;
    const capacity = snapshot.member_capacity == null ? '' : ' / ' + snapshot.member_capacity;
    refs.members.replaceChildren(h('h3', '', '房间成员 · ' + count + capacity)); refs.memberPreview.replaceChildren(); refs.memberStrip.replaceChildren();
    const members = snapshot.members || [];
    if (!members.length) refs.memberPreview.append(h('p', 'room-sub', '等待成员状态'));
    members.forEach((m, index) => {
      const name = m.name || '成员', card = h('div', 'room-member'), copy = h('div', 'room-member-copy'); copy.append(h('strong', '', name + (m.owner ? ' · 房主' : '') + (m.id === snapshot.member_id ? ' · 你' : '')));
      const offline = !['host', 'guest'].includes(snapshot.mode);
      const state = offline && m.id !== snapshot.member_id ? '连接状态未知 · 同步已暂停' : m.connected === false ? '连接已断开' : m.audio === false ? '遥控端 · 不输出音频' : m.ready ? '输出已就绪' : m.connected === true ? '已连接 · 等待音频状态' : '等待状态';
      copy.append(h('p', 'room-sub', state)); card.append(person(name, m.id === snapshot.member_id ? api.avatar() : m.avatar), copy);
      if (snapshot.mode === 'host' && !m.owner) {
        const perms = m.permissions || {};
        copy.append(h('p', 'room-sub', [perms.queue ? '可以点歌' : '仅收听', perms.chat_send ? '可以聊天' : '不能发言', perms.transport ? '可以切歌' : '房主控制播放'].join(' · ')));
        const more = h('details', 'room-member-actions'); more.append(h('summary', '', '权限')); card.append(more);
        Object.keys(perms).forEach(k => { const input = field(more, { listen: '收听', queue: '点歌与队列', transport: '播放与切歌', volume: '房间音量', chat_read: '查看聊天', chat_send: '发送消息', invite: '邀请新成员' }[k] || k, 'checkbox'); input.checked = !!perms[k]; input.onchange = () => run(async () => { try { await command({ action: 'permissions', member_id: m.id, permissions: { ...perms, [k]: input.checked } }); } catch (error) { input.checked = !!perms[k]; throw error; } }); });
        more.append(button('移出房间', async () => { const key = sessionKey(); if (await confirmAction('移出「' + name + '」并撤销连接凭据？重新加入需要再次获得授权。') && current(key)) await command({ action: 'remove', member_id: m.id }); }));
      }
      refs.members.append(card);
      const avatar = () => { const node = person(name, m.id === snapshot.member_id ? api.avatar() : m.avatar); node.setAttribute('aria-label', name + ' · ' + state); return node; };
      if (index < 5) { const summary = h('button', 'room-member-summary'), copy = h('div'); summary.type = 'button'; summary.onclick = () => m.id === snapshot.member_id ? api.workspace().openSettings('output') : api.workspace().openSettings('members'); copy.append(h('strong', '', name + (m.owner ? ' · 房主' : '') + (m.id === snapshot.member_id ? ' · 你' : '')), h('small', '', state)); summary.append(avatar(), copy); refs.memberPreview.append(summary); }
      if (index < 8) refs.memberStrip.append(avatar());
    });
    if (members.length > 8) refs.memberStrip.append(h('span', 'room-avatar', '+' + (members.length - 8)));
  }
  function drawWaiting() {
    if (!refs.waiting) return;
    const snapshot = api.snapshot(), waiting = !snapshot.current_track && !snapshot.playing && !Number(snapshot.queue_count) && !refs.waitingDismissed;
    refs.waiting.hidden = !waiting; refs.playLayout.hidden = waiting;
    const members = snapshot.members || [], capacity = Number(snapshot.member_capacity) || 0;
    refs.waitingCount.textContent = members.length + ' 人已加入' + (capacity ? ' · ' + capacity + ' 个位置，还剩 ' + Math.max(0, capacity - members.length) + ' 个空位' : ' · 等待朋友加入');
    const signature = JSON.stringify([members, api.avatar(), capacity]);
    if (refs.waitingSeats.dataset.signature === signature) return;
    refs.waitingSeats.dataset.signature = signature; refs.waitingSeats.replaceChildren();
    members.forEach(member => { const seat = h('div', 'room-seat'); seat.append(person(member.name, member.id === snapshot.member_id ? api.avatar() : member.avatar, true), h('strong', '', member.id === snapshot.member_id ? '你 · ' + member.name : member.name), h('small', 'room-sub', member.owner ? '房主' : member.connected === false ? '连接已断开' : '已加入')); refs.waitingSeats.append(seat); });
    const emptyCount = capacity ? Math.min(3, Math.max(0, capacity - members.length)) : 1;
    for (let i = 0; i < emptyCount; i++) { const empty = navigationButton('', () => api.workspace().navigate('invite', true), 'room-seat room-seat-empty'); empty.append(person('+', '', true), h('strong', '', '空位'), h('small', 'room-sub', '邀请朋友')); refs.waitingSeats.append(empty); }
  }
  function drawConnection() {
    const snapshot = api.snapshot(), offline = !['host', 'guest'].includes(snapshot.mode);
    api.root().dataset.roomOffline = String(offline);
    refs.connectionBanner.hidden = !offline;
    refs.connectionText.textContent = snapshot.mode === 'reconnecting' ? '与房间的连接中断，正在重连。重连成功后会自动对齐房间进度。' : '房间连接已断开。请检查网络，或退出后重新加入。';
    refs.quickMode.disabled = offline || !(snapshot.permissions || {}).queue; refs.order.disabled = offline;
    refs.inviteCopy.disabled = offline; refs.revokeInvitation.disabled = offline || !api.validInvitation();
    refs.addSongButtons.forEach(node => { node.disabled = offline || !(snapshot.permissions || {}).queue && snapshot.mode !== 'host'; node.title = offline ? '等待连接恢复后点歌' : !(snapshot.permissions || {}).queue && snapshot.mode !== 'host' ? '房主未授权点歌' : '打开点歌'; });
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
    const first = !refs.application.dataset.state;
    refs.application.hidden = false; refs.application.replaceChildren(statePanel(application.state === 'pending' ? '已提交，等待房主批准' : ['rejected', 'expired', 'consumed'].includes(application.state) ? { rejected: '房主未批准这次申请', expired: '申请已过期', consumed: '这份申请已经使用过了' }[application.state] : '入房申请状态', application.name || '入房申请', application.state === 'pending' ? 'timer' : 'user'));
    refs.application.dataset.state = application.state;
    refs.applicationLinks.forEach(link => { link.hidden = false; });
    const request = api.application();
    if (request) refs.application.append(h('p', 'room-sub', '申请已保留 · 剩余约 ' + Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 60000)) + ' 分钟。关闭页面不会撤销房主批准。'));
    refs.application.append(h('p', 'room-sub', { pending: '已提交，等待房主审批。批准后点击查看结果即可加入。', approved: '房主已批准，正在加入房间。', approved_retry: '房主的批准仍有效。你可以显式重试加入。', join_failed: '本次连接失败。申请已保留，请先重新核对入房状态。', join_unknown: '加入结果尚未确认。请先查询状态，避免重复使用一次性邀请。', status_failed: '申请可能已过期，或房主暂时不可达。记录已保留，可以重新查询。', cleared: '本机申请记录已清除，房主的批准不会自动撤销。', rejected: '房主未批准这次申请。', expired: '申请已过期，请重新申请。', consumed: '该申请已经用于加入房间，请查看当前房间或重新申请。' }[application.state] || '正在读取结果'));
    if (application.state === 'pending') refs.application.append(button('查看申请结果', () => api.checkApplication()));
    if (['join_failed', 'join_unknown', 'status_failed'].includes(application.state)) refs.application.append(button('查看入房状态', () => api.checkApplication()));
    if (application.state === 'approved_retry') refs.application.append(button('重试加入房间', () => api.checkApplication(true), 'primary'));
    if (['pending', 'join_failed', 'join_unknown', 'status_failed', 'approved_retry'].includes(application.state)) refs.application.append(button('清除本机申请记录', () => api.forgetApplication()));
    refs.application.append(navigationButton('看看附近', () => api.workspace().navigate('discover', true)), navigationButton('返回开始', () => api.workspace().navigate('lobby', true)));
    if (first) api.workspace().navigate('application');
  }
  const announcedApplications = new Set();
  const admissionRoles = new Map();
  let admissionOwner = '';
  function drawAdmissionRows(list, applications) {
    const signature = JSON.stringify(applications.map(application => [application.id, application.name, application.state, application.member_id]));
    if (list.dataset.signature === signature) return;
    const active = document.activeElement, focusedRole = list.contains?.(active) && active?.dataset.applicationRole;
    let restoreFocus;
    list.dataset.signature = signature; list.replaceChildren();
    if (!applications.length) list.append(h('p', 'room-sub', '当前没有待处理的入房申请'));
    applications.forEach(application => { const row = h('div', 'room-admission-row'); row.append(h('strong', '', application.name || '申请人'), h('p', 'room-sub', { approved: '已批准，等待加入', rejected: '已拒绝', pending: '等待审批 · 过期后需重新申请', consumed: '已加入房间 · 如需移出请在成员中操作' }[application.state] || '等待更新'));
      if (application.state === 'pending') {
        const role = select(row, '批准后的参与方式', [['queue', '一起点歌'], ['listen', '仅收听'], ['control', '共同控制']]);
        role.value = admissionRoles.get(application.id) || 'queue'; role.dataset.applicationRole = application.id;
        role.onchange = () => admissionRoles.set(application.id, role.value);
        if (focusedRole === application.id) restoreFocus = role;
        row.append(button('批准加入', () => api.reviewApplication(application.id, true, role.value), 'primary'), button('拒绝', () => api.reviewApplication(application.id, false)));
      }
      else if (application.state === 'approved') row.append(button('撤销批准', () => api.revokeApplication(application.id)));
      list.append(row);
    });
    restoreFocus?.focus({ preventScroll: true });
  }
  function drawAdmissions(admission) {
    const snapshot = api.snapshot(), owner = [snapshot.room_id, snapshot.instance_id, snapshot.member_id].join(':');
    if (owner !== admissionOwner) { admissionOwner = owner; announcedApplications.clear(); admissionRoles.clear(); }
    refs.admissions.hidden = api.snapshot().mode !== 'host' || !admission;
    refs.asideAdmissions.hidden = refs.admissions.hidden;
    const code = admission && admission.room_code; refs.roomCodeRow.hidden = !code; refs.roomCode.textContent = code || ''; refs.copyRoomCode.disabled = !code;
    const applications = api.snapshot().mode === 'host' && admission ? admission.pending || [] : [];
    const pending = applications.filter(application => application.state === 'pending');
    refs.memberDot.hidden = !pending.length;
    refs.memberTab.setAttribute('aria-label', pending.length ? '成员，' + pending.length + ' 个待处理申请' : '成员');
    drawAdmissionRows(refs.admissionList, applications);
    drawAdmissionRows(refs.asideAdmissionList, applications);
    drawAdmissionRows(refs.admissionPopupList, pending);
    if (!pending.length) { refs.admissionDialog.close(); return; }
    // Defer while another form is open. Dismissing an application never
    // reopens it on the next poll; genuinely new IDs can notify again.
    const workspace = api.workspace();
    if (pending.some(application => !announcedApplications.has(application.id)) && !document.hidden && !api.root().hidden && (!workspace.hasOpenEntry() || refs.admissionDialog.isOpen())) {
      pending.forEach(application => announcedApplications.add(application.id));
      refs.admissionDialog.open();
    }
  }
  const invitationRecords = new Map(); let invitationOwner = '';
  function drawInvitationManagement() {
    const snapshot = api.snapshot(); refs.invitationManagement.hidden = snapshot.mode !== 'host';
    if (document.activeElement !== refs.discoverable) refs.discoverable.checked = snapshot.discoverable !== false;
    refs.discoveryStatus.textContent = snapshot.discoverable === false ? '发现已关闭，持有有效邀请的人仍可加入。' : snapshot.discovery_available === true ? '正在向同一网络广播房间。' : snapshot.discovery_available === false ? '广播暂不可用，仍可通过有效邀请加入。' : '等待发现服务状态';
    const owner = [snapshot.room_id, snapshot.instance_id, snapshot.member_id].join(':');
    if (invitationOwner !== owner) { invitationOwner = owner; invitationRecords.clear(); }
    const invitations = snapshot.invitations || [], active = new Set(invitations.map(invite => invite.id));
    invitations.forEach(invite => { if (!invitationRecords.has(invite.id)) invitationRecords.set(invite.id, { ...invite, expiresAt: Date.now() + Math.max(0, Number(invite.expires_in_seconds) || 0) * 1000, state: 'pending' }); });
    invitationRecords.forEach(record => { if (!active.has(record.id) && record.state === 'pending') record.state = record.expiresAt <= Date.now() ? 'expired' : 'used_or_invalid'; });
    while (invitationRecords.size > 32) invitationRecords.delete(invitationRecords.keys().next().value);
    const signature = JSON.stringify([[...invitationRecords.values()].map(record => [record.id, record.state]), (snapshot.members || []).map(member => [member.id, member.name])]);
    [refs.outstandingInvitations, refs.invitationResponses].forEach(list => {
      if (list.dataset.signature !== signature) {
        list.dataset.signature = signature; list.replaceChildren();
        if (!invitationRecords.size) list.append(h('p', 'room-sub', '还没有发出邀请。生成一份，发给同一网络的朋友。'));
        invitationRecords.forEach(record => { const row = h('div', 'room-invitation-row'), copy = h('div'), state = h('span', 'room-tag');
          copy.append(h('strong', '', '一次性邀请'), state);
          const countdown = h('small', 'room-sub'); countdown.dataset.invitationCountdown = record.id; copy.append(countdown);
          state.textContent = { pending: '待回应', expired: '已过期', revoked: '已撤销', used_or_invalid: '已使用或失效' }[record.state];
          state.className = 'room-tag' + (record.state === 'pending' ? ' room-tag-warn' : '');
          const actions = h('div', 'room-card-actions'); row.append(person('邀请', 'phones'), copy, actions);
          if (record.state === 'pending') actions.append(navigationButton('重新邀请', () => { refs.requestNewInvitation(); api.workspace().navigate('invite', true); }), button('撤销邀请', async () => { await api.revokeInvitation(record.id); record.state = 'revoked'; drawInvitationManagement(); }));
          else actions.append(navigationButton('重新邀请', () => { refs.requestNewInvitation(); api.workspace().navigate('invite', true); }));
          list.append(row);
        });
        (snapshot.members || []).filter(member => !member.owner).forEach(member => { const row = h('div', 'room-invitation-row'), copy = h('div'); copy.append(h('strong', '', member.name), h('span', 'room-tag room-tag-live', '已加入')); row.append(person(member.name, member.avatar), copy, navigationButton('权限', () => api.workspace().openSettings('members'))); list.append(row); });
      }
      list.querySelectorAll('[data-invitation-countdown]').forEach(node => { const record = invitationRecords.get(node.dataset.invitationCountdown); if (record) node.textContent = record.state === 'pending' ? '等待回应 · 剩余 ' + formatTime(Math.max(0, record.expiresAt - Date.now())) : ''; });
    });
  }
  function mountOnlinePicker(parent, picker) {
    const panel = section(parent, '在线点歌');
    panel.append(h('p', 'room-sub', '搜索喜欢的歌，加入共同队列。歌曲由房主提供给房间，大家无需分别登录音源。'));
    const form = h('form', 'room-online-search');
    const source = select(form, '音源', []), query = field(form, '搜索在线歌曲', 'search'); query.maxLength = 128; query.placeholder = '输入歌名或歌手，按回车搜索';
    const submit = h('button', 'btn primary', '搜索在线歌曲'); submit.type = 'submit'; form.append(submit);
    const feedback = h('p', 'room-sub'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    const results = h('div', 'room-online-results'), more = navigationButton('加载更多歌曲', () => search(true)); more.hidden = true;
    const footer = h('div', 'room-toolbar'); footer.append(navigationButton('查看共同队列', () => { picker.close(); api.workspace().navigate('collaborate', true); }), navigationButton('浏览在线歌单 / 登录音源', () => { picker.close(); api.onNavigate('online'); }));
    panel.append(form, feedback, results, more, footer);
    let network = null, epoch = 0, offset = 0, committed = '', selectedSource = '', loaded = false, loading = false, readyPromise = null;
    const rows = [];
    const connectedHost = () => api.snapshot().mode === 'host';
    const refresh = () => rows.forEach(({ add, track, pending }) => { add.disabled = pending || !track.playable || !connectedHost() || api.queueUncertain(); });
    const cancel = () => { const interrupted = loading; epoch++; if (network) network.cancel(); network = null; loading = false; submit.disabled = false; more.disabled = false; more.hidden = true; if (interrupted) feedback.textContent = '搜索已取消，可重新搜索。'; };
    async function ready() {
      if (loaded) return;
      if (readyPromise) return readyPromise;
      readyPromise = (async () => {
        feedback.textContent = '正在读取音源…';
        try {
          if (!global.Online) throw new Error('在线音源尚未就绪，请稍后重试或浏览在线歌单。');
          await global.Online.whenSearchReady();
          const sources = global.Online.sources();
          source.replaceChildren();
          global.Online.searchSources().forEach(id => { const info = sources.find(item => item.id === id); const option = h('option', '', global.Online.sourceLabel(id) || info && info.name || id); option.value = id; source.append(option); });
          const preferred = global.Online.searchSource('song');
          if ([...source.children].some(option => option.value === preferred)) source.value = preferred;
          loaded = source.children.length > 0;
          feedback.textContent = loaded ? '先选择音源，再搜索歌名或歌手。' : '当前没有可用音源，请先到在线音乐配置或登录。';
          submit.disabled = !loaded;
        } catch (error) { feedback.textContent = error.message || '音源读取失败，请重新打开点歌重试。'; }
        finally { readyPromise = null; }
      })();
      return readyPromise;
    }
    async function search(append) {
      if (loading || !connectedHost()) return;
      const preparing = epoch; loading = true; submit.disabled = true;
      if (!loaded) await ready();
      if (preparing !== epoch) return;
      loading = false; submit.disabled = false;
      const q = query.value.trim();
      if (!q) { feedback.textContent = '请输入歌名或歌手。'; query.focus(); return; }
      if (!loaded) return;
      if (!append) { cancel(); committed = q; selectedSource = source.value; offset = 0; rows.length = 0; results.replaceChildren(); network = api.beginOnlineSearch(); }
      if (!network || !network.active) return;
      const ticket = epoch, key = sessionKey(), ownerNetwork = network;
      loading = true; submit.disabled = true; more.disabled = true; feedback.textContent = append ? '正在加载更多…' : '正在搜索…';
      try {
        const page = await ownerNetwork.get('/v1/online/search?' + new URLSearchParams({ source: selectedSource, q: committed, limit: 20, offset }));
        if (ticket !== epoch || !current(key) || !ownerNetwork.active) return;
        const tracks = page.tracks || [], seen = new Set(rows.map(row => row.track.source + ':' + row.track.id));
        const before = rows.length;
        tracks.forEach(track => {
          track = { ...track, source: track.source || selectedSource };
          if (seen.has(track.source + ':' + track.id)) return; seen.add(track.source + ':' + track.id);
          const row = h('div', 'room-track room-online-track'), copy = h('div', 'room-track-copy');
          copy.append(h('strong', '', track.title), h('small', 'room-sub', [track.artist || '未知歌手', track.album].filter(Boolean).join(' · ')));
          const record = { track, pending: false }, add = record.add = button(track.playable ? '加入共同队列' : '暂不可播', async () => {
            record.pending = true; refresh(); add.textContent = '正在加入…';
            try { await api.addOnline([track]); if (current(key)) { add.textContent = '已加入 · 再点一次'; feedback.textContent = '已加入共同队列，按队列顺序播放。可继续点歌或查看共同队列。'; } }
            catch (error) { if (current(key)) { add.textContent = api.queueUncertain() ? '等待确认' : '重试加入'; feedback.textContent = error.message || '未能加入，请重试。'; } throw error; }
            finally { record.pending = false; if (current(key)) refresh(); }
          });
          if (!track.playable) add.title = '当前音源未提供可播放版本，请换一个音源搜索';
          row.append(copy, add); results.append(row); rows.push(record);
        });
        const cursor = page.pagination, next = cursor && Number.isSafeInteger(cursor.next_offset) ? cursor.next_offset : offset + tracks.length;
        more.hidden = !(next > offset && rows.length > before && (cursor ? cursor.has_more : page.total != null ? next < page.total : tracks.length >= 20)); offset = next;
        feedback.textContent = rows.length ? '已找到 ' + rows.length + ' 首歌曲 · 点右侧按钮加入共同队列' : '没有找到歌曲，试试更短的关键词或其他音源。'; refresh();
      } catch (error) {
        if (ticket !== epoch || !current(key) || error.name === 'AbortError') return;
        const failure = global.HertzSearch.failure(error); feedback.textContent = failure.label + '。' + (failure.retryable ? '请点击搜索重试。' : '请更换音源，或前往在线音乐登录。');
      } finally { if (ticket === epoch) { loading = false; submit.disabled = false; more.disabled = false; } }
    }
    window.hertzHost.onSubmit(form, () => search(false));
    const invalidate = () => { cancel(); more.hidden = true; feedback.textContent = '搜索条件已改变，按回车重新搜索。'; };
    query.oninput = invalidate; source.onchange = () => { invalidate(); results.replaceChildren(); rows.length = 0; };
    return { panel, focus: query, ready, cancel, refresh };
  }
  function mountActive() {
    const workspace = api.workspace(), pages = workspace.pages;
    const go = name => name === 'settings' ? workspace.openSettings('members') : workspace.navigate(name, true);
    const lobby = section(pages.lobby, '你的房间正在进行');
    refs.activeRoomName = h('h3', 'room-lobby-name', api.snapshot().name || '一起听房间');
    refs.activeRoomArtwork = roomArtwork(api.snapshot().name || '一起听房间', api.snapshot().room_cover);
    const currentCard = h('article', 'room-nearby-card room-current-card'), currentCopy = h('div', 'room-card-copy'), currentActions = h('div', 'room-card-actions');
    currentActions.append(navigationButton('继续一起听', () => go('play'), 'primary'), navigationButton('邀请新成员', () => go('invite')));
    currentCopy.append(refs.activeRoomName, h('p', 'room-sub', '返回大厅不会断开当前房间。'), currentActions); currentCard.append(refs.activeRoomArtwork.node, currentCopy); lobby.append(currentCard);
    refs.connectionBanner = h('div', 'room-connection-banner room-notice room-error'); refs.connectionBanner.hidden = true; refs.connectionBanner.setAttribute('role', 'status');
    refs.connectionText = h('span'); refs.connectionBanner.append(refs.connectionText, navigationButton('查看连接状态', () => workspace.openSettings('output')), button('离开房间', () => api.leaveRoom(), 'room-leave')); pages.play.append(refs.connectionBanner);
    refs.waiting = section(pages.play, '等朋友们进来', 'room-waiting'); refs.waitingCount = h('p', 'room-sub'); refs.waitingSeats = h('div', 'room-seats');
    const waitingActions = h('div', 'room-flow-actions'), firstSong = navigationButton('先放一首歌', () => refs.openSongPicker(), 'primary');
    refs.addSongButtons = [firstSong];
    waitingActions.append(navigationButton('邀请朋友', () => go('invite'), 'primary'), firstSong, navigationButton('查看共同队列', () => { refs.waitingDismissed = true; drawWaiting(); }));
    refs.waiting.append(refs.waitingCount, refs.waitingSeats, waitingActions, h('p', 'room-sub', '大家会看到同一份队列，可以提前点歌。开始播放后大家同步收听；中途加入的人会跟上当前进度。'));
    const playLayout = refs.playLayout = h('div', 'room-play-layout'), now = section(playLayout, '正在聆听', 'room-player');
    const scene = refs.playerScene = h('div', 'room-stage-scene'); scene.setAttribute('aria-label', '房间音乐舞台');
    scene.append(h('span', 'room-stage-label', '一起听 · 现场')); now.append(scene);
    const stageControls = h('div', 'room-stage-controls'); now.append(stageControls);
    const hero = h('div', 'room-hero'), art = h('button', 'room-art'); art.type = 'button';
    const lyricsToggle = navigationButton('展开歌词', () => setLyricsExpanded(scene.dataset.lyricsExpanded !== 'true'), 'room-lyrics-toggle');
    function setLyricsExpanded(expanded) {
      scene.dataset.lyricsExpanded = String(expanded);
      art.setAttribute('aria-pressed', String(expanded)); art.setAttribute('aria-label', expanded ? '收起歌词，显示歌曲封面' : '展开歌词');
      lyricsToggle.textContent = expanded ? '收起歌词' : '展开歌词'; lyricsToggle.setAttribute('aria-pressed', String(expanded));
      if (refs.drawLyrics) refs.drawLyrics();
    }
    art.onclick = () => setLyricsExpanded(scene.dataset.lyricsExpanded !== 'true'); setLyricsExpanded(false);
    scene.append(lyricsToggle);
    const emptyArt = h('div', 'room-art-empty'); emptyArt.setAttribute('aria-hidden', 'true'); emptyArt.append(h('span', '', 'H'), h('small', '', 'LISTEN TOGETHER'));
    refs.cover = h('img', 'room-cover'); refs.cover.alt = '当前共享歌曲封面'; refs.cover.hidden = true; refs.cover.onerror = () => { refs.cover.hidden = true; };
    art.append(emptyArt, refs.cover);
    const copy = h('div', 'room-hero-copy'); refs.playingBadge = h('span', 'room-playing-badge', '等待播放');
    refs.current = h('strong', 'room-current'); refs.artist = h('p', 'room-artist'); refs.album = h('p', 'room-sub');
    copy.append(refs.playingBadge, refs.current, refs.artist, refs.album);
    hero.append(art, copy); scene.append(hero);
    const seekLine = h('div', 'room-seek-line'); refs.position = h('span', 'room-mono', '0:00'); refs.duration = h('span', 'room-mono', '0:00');
    refs.progress = h('input', 'room-progress'); refs.progress.type = 'range'; refs.progress.min = 0; refs.progress.max = 1000; refs.progress.step = 1; refs.progress.value = 0; refs.progress.setAttribute('aria-label', '房间播放进度');
    let seekContext = null;
    refs.progress.oninput = () => { if (!seekContext) seekContext = { instance: api.snapshot().track_instance_id, duration: Number((api.snapshot().current_track || {}).duration_ms || 0) }; };
    refs.progress.onblur = () => { seekContext = null; };
    refs.progress.onchange = () => { const context = seekContext || { instance: api.snapshot().track_instance_id, duration: Number((api.snapshot().current_track || {}).duration_ms || 0) }; seekContext = null; if (context.instance === api.snapshot().track_instance_id && context.duration) run(() => playback('seek', { instance_id: context.instance, position_ms: String(Math.round(Number(refs.progress.value) / 1000 * context.duration)) })); };
    seekLine.append(refs.position, refs.progress, refs.duration); stageControls.append(seekLine);
    const controls = h('div', 'room-player-controls'); refs.prev = button('上一首', () => playback('previous')); refs.play = button('播放', () => playback(api.snapshot().playing ? 'pause' : 'play'), 'primary room-play-button'); refs.next = button('下一首', () => playback('next')); refs.stop = button('停止', () => playback('stop')); iconButton(refs.prev, 'prev', '上一首'); iconButton(refs.next, 'next', '下一首'); iconButton(refs.stop, 'stop', '停止'); controls.append(refs.prev, refs.play, refs.next, refs.stop); stageControls.append(controls);
    const quick = h('div', 'room-player-quick');
    const openStage = navigationButton('打开我的舞台', () => api.openStage(), 'room-open-stage'); openStage.title = '与大家同步听歌，独立选择自己的画面与效果'; quick.append(openStage);
    refs.songFavorite = h('div', 'room-song-favorite'); quick.append(refs.songFavorite);
    refs.quickMode = button('列表循环', () => api.cycleMode(), 'room-mode-button'); controls.prepend(refs.quickMode);
    const volumeLabel = h('label', 'room-player-volume', '本机音量'); refs.quickVolume = h('input'); refs.quickVolume.type = 'range'; refs.quickVolume.min = 0; refs.quickVolume.max = 100; refs.quickVolume.step = 1; refs.quickVolume.setAttribute('aria-label', '本机音量'); refs.quickVolume.onchange = () => run(() => api.localVolume(Number(refs.quickVolume.value) / 100)); volumeLabel.append(refs.quickVolume); quick.append(volumeLabel, navigationButton('共同队列', () => go('collaborate'))); stageControls.append(quick);
    const stageDock = h('div', 'room-stage-chat-dock'); stageControls.append(stageDock);
    const extras = h('details', 'room-stage-details'); extras.append(h('summary', '', '播放与同步详情')); now.append(extras);
    const precise = h('details', 'room-precise-seek'); precise.append(h('summary', '', '精确跳转'));
    const precisionLine = h('div', 'room-toolbar'); refs.seek = field(precisionLine, '跳转位置（秒）', 'number', 0); refs.seek.min = 0; refs.seekButton = button('跳转', () => playback('seek', { instance_id: api.snapshot().track_instance_id, position_ms: String(Math.max(0, Math.trunc(Number(refs.seek.value) * 1000))) })); precisionLine.append(refs.seekButton); precise.append(precisionLine); extras.append(precise);
    refs.operations = h('div', 'room-operations'); refs.queueOperations = h('div', 'room-operations'); refs.lyrics = h('div', 'room-lyrics'); refs.lyrics.setAttribute('aria-label', '同步歌词'); stageControls.append(refs.operations, refs.queueOperations); scene.append(refs.lyrics);
    const sync = h('div', 'room-sync-summary'); refs.connection = h('span', 'room-chip'); refs.format = h('span', 'room-chip'); sync.append(refs.connection, refs.format, navigationButton('查看同步与输出详情', () => workspace.openSettings('output'))); extras.append(sync);
    const aside = h('aside', 'room-play-aside'), asideTabs = h('div', 'room-stage-tabs');
    asideTabs.setAttribute('role', 'tablist'); asideTabs.setAttribute('aria-label', '一起听现场'); aside.append(asideTabs);
    const queuePanel = h('div', 'room-aside-panel'), chatPanel = h('div', 'room-aside-panel'), memberPanel = h('div', 'room-aside-panel');
    const memberPreview = section(memberPanel, '房间成员'); refs.memberPreview = h('div', 'room-members-preview');
    memberPreview.append(refs.memberPreview, navigationButton('管理成员与申请', () => workspace.openSettings('members')));
    refs.memberStrip = h('div', 'room-member-strip'); refs.activity = h('ol', 'room-activity'); memberPreview.append(refs.memberStrip, refs.activity);
    refs.queuePreview = h('ol', 'room-queue-preview'); refs.queuePreview.hidden = true;
    const queue = section(queuePanel, '共同队列', 'room-queue-section'), queueTools = h('div', 'room-queue-tools');
    refs.startDraftAction = button('继续添加选中的歌曲', () => api.addStartDraft(), 'primary'); refs.startDraftAction.hidden = !api.startDraft(); queue.append(refs.startDraftAction);
    refs.startDraftDismiss = button('清除这组选曲记录', () => api.dismissStartDraft()); refs.startDraftDismiss.hidden = !api.startDraft(); queue.append(refs.startDraftDismiss);
    const addSong = navigationButton('＋ 点歌', () => refs.openSongPicker(), 'primary room-add-song'); refs.addSongButtons.push(addSong); queueTools.append(addSong);
    refs.orderControl = h('div', 'room-toolbar'); refs.order = select(refs.orderControl, '队列排序', [['manual', '手动排序'], ['votes', '按票数排序']]);
    refs.order.onchange = () => run(() => api.queueOrder(refs.order.value)); queueTools.append(refs.orderControl); queue.append(queueTools);
    refs.queueCount = h('p', 'room-sub room-queue-count'); refs.queue = h('ol', 'room-queue'); refs.queue.setAttribute('aria-label', '共同播放队列'); refs.queue.tabIndex = 0; queue.append(refs.queueCount, refs.queue, refs.queuePreview);
    refs.queueNav = h('div', 'room-toolbar'); refs.queuePrev = button('上一页', () => api.pageQueue(-1)); refs.queueNext = button('下一页', () => api.pageQueue(1)); refs.queueNav.append(refs.queuePrev, refs.queueNext); queue.append(refs.queueNav);
    mountChat(chatPanel, scene, stageDock);
    const asideEntries = [['queue', '队列', queuePanel], ['chat', '聊天', chatPanel], ['members', '成员', memberPanel]].map(([key, label, panel]) => {
      const tab = navigationButton(label, () => selectAside(key)); tab.id = 'room-stage-tab-' + key; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'room-stage-panel-' + key);
      panel.id = 'room-stage-panel-' + key; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0; asideTabs.append(tab); aside.append(panel);
      return { key, tab, panel };
    });
    refs.chatTab = asideEntries.find(entry => entry.key === 'chat').tab;
    refs.memberTab = asideEntries.find(entry => entry.key === 'members').tab;
    refs.memberDot = h('span', 'room-member-dot'); refs.memberDot.hidden = true; refs.memberDot.setAttribute('aria-hidden', 'true'); refs.memberTab.append(refs.memberDot);
    refs.markChatRead = () => api.markChatRead();
    function selectAside(key) {
      if (!asideEntries.some(entry => entry.key === key)) return;
      api.root().dataset.roomAside = key;
      asideEntries.forEach(entry => { const selected = entry.key === key; entry.panel.hidden = !selected; entry.tab.setAttribute('aria-selected', String(selected)); entry.tab.tabIndex = selected ? 0 : -1; });
      if (refs.placeChatComposer) refs.placeChatComposer(key === 'chat' ? 'chat' : 'play');
      if (key === 'chat' && refs.markChatRead) refs.markChatRead();
    }
    refs.selectTab = selectAside;
    asideEntries.forEach((entry, index) => { entry.tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3;
      selectAside(asideEntries[next].key); asideEntries[next].tab.focus({ preventScroll: true });
    }; });
    selectAside('queue'); playLayout.append(aside); pages.play.append(playLayout);
    const picker = workspace.createEntryDialog('song-picker', '添加歌曲');
    const hostPicker = api.snapshot().mode === 'host', sourceTabs = h('div', 'room-song-source-tabs'); sourceTabs.setAttribute('role', 'tablist'); sourceTabs.setAttribute('aria-label', '点歌来源'); picker.body.append(sourceTabs);
    const online = hostPicker ? mountOnlinePicker(picker.body, picker) : null;
    let localPanel, localFocus, loadLocalPanel = () => {}, chosenSource = hostPicker ? 'online' : 'shared';
    const library = section(picker.body, '房间共享曲库');
    refs.librarySearch = field(library, '搜索已共享歌曲', 'search'); refs.librarySearch.placeholder = '歌名、歌手或专辑'; refs.librarySearch.maxLength = 128;
    refs.librarySearch.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); run(() => api.searchLibrary(refs.librarySearch.value)); } };
    library.append(button('搜索歌曲', () => api.searchLibrary(refs.librarySearch.value)));
    refs.library = h('div', 'room-list'); library.append(refs.library);
    refs.libraryNav = h('div', 'room-toolbar'); refs.libraryPrev = button('上一页', () => api.pageLibrary(-1)); refs.libraryNext = button('下一页', () => api.pageLibrary(1)); refs.libraryNav.append(refs.libraryPrev, refs.libraryNext); library.append(refs.libraryNav);
    if (api.snapshot().mode === 'host') {
      const local = localPanel = section(picker.body, '从本机点歌'), localQuery = localFocus = field(local, '搜索本机歌曲', 'search');
      local.append(h('p', 'room-sub', '仅将你点选的歌曲分享给当前房间，并加入共同队列。已有分享范围会保留。'));
      const localResults = h('div', 'room-local-picker-results'), localNav = h('div', 'room-toolbar');
      let localOffset = 0, localGeneration = 0, localSearch = '';
      const previous = button('上一页本机歌曲', () => { localOffset = Math.max(0, localOffset - 32); return searchLocal(); });
      const next = button('下一页本机歌曲', () => { localOffset += 32; return searchLocal(); }); localNav.append(previous, next);
      async function searchLocal() {
        const generation = ++localGeneration, key = sessionKey(); localResults.replaceChildren(h('p', 'room-sub', '正在查找本机歌曲…'));
        try {
          const page = await api.localPicker(localSearch, localOffset);
          if (!current(key) || generation !== localGeneration) return;
          const tracks = (page.tracks || []).filter(track => (!track.source || track.source === 'local') && !String(track.id).startsWith('online:'));
          localResults.replaceChildren(); previous.disabled = localOffset === 0; next.disabled = localOffset + 32 >= Number(page.total || 0); localNav.hidden = Number(page.total || 0) <= 32;
          if (!tracks.length) localResults.append(h('p', 'room-empty', '没有找到本机歌曲。可先回音乐库添加文件，已有房间会保持连接。'));
          tracks.forEach(track => {
            const row = h('div', 'room-track'), copy = h('div', 'room-track-copy'); copy.append(h('strong', '', track.title), h('small', 'room-sub', track.artist || '未知歌手'));
            const add = button('分享并点歌', async () => {
              add.disabled = true; add.textContent = '正在添加…';
              try { await api.addLocalSelection(track); if (current(key)) add.textContent = api.queueUncertain() ? '等待确认' : '再点一次'; }
              finally { if (current(key)) { add.disabled = api.queueUncertain(); if (add.textContent === '正在添加…') add.textContent = '分享并点歌'; } }
            }); row.append(copy, add); localResults.append(row);
          });
        } catch (error) { if (current(key) && generation === localGeneration) { localResults.replaceChildren(h('p', 'room-error', error.message || '本机曲库暂不可用，请重试')); } }
      }
      const search = button('搜索本机歌曲', () => { localOffset = 0; localSearch = localQuery.value.trim(); return searchLocal(); });
      localQuery.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); run(() => { localOffset = 0; localSearch = localQuery.value.trim(); return searchLocal(); }); } };
      local.append(search, localResults, localNav, navigationButton('管理歌曲分享范围', () => { picker.close(); workspace.openSettings('sharing'); }));
      loadLocalPanel = () => { if (!localResults.children.length) searchLocal(); };
    }
    const sourcePanels = hostPicker ? [['online', '在线歌曲', online.panel, online.focus], ['local', '本机歌曲', localPanel, localFocus], ['shared', '房间已共享', library, refs.librarySearch]] : [['shared', '房间已共享', library, refs.librarySearch]];
    const chooseSource = (id, focusTab) => {
      chosenSource = id;
      sourcePanels.forEach(([key, , panel, , tab]) => { panel.hidden = key !== id; tab.setAttribute('aria-selected', String(key === id)); tab.tabIndex = key === id ? 0 : -1; if (key === id && focusTab) tab.focus(); });
      if (online && id !== 'online') online.cancel();
      if (id === 'online') online.ready(); else if (id === 'local') loadLocalPanel();
    };
    sourcePanels.forEach((entry, index) => {
      const [id, label, panel] = entry, tab = navigationButton(label, () => chooseSource(id)); entry.push(tab);
      tab.id = 'room-song-source-' + id; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', tab.id + '-panel'); panel.id = tab.id + '-panel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
      tab.onkeydown = event => { const key = event.key; if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return; event.preventDefault(); const next = key === 'Home' ? 0 : key === 'End' ? sourcePanels.length - 1 : (index + (key === 'ArrowRight' ? 1 : -1) + sourcePanels.length) % sourcePanels.length; chooseSource(sourcePanels[next][0], true); };
      sourceTabs.append(tab); panel.hidden = id !== chosenSource; tab.setAttribute('aria-selected', String(id === chosenSource)); tab.tabIndex = id === chosenSource ? 0 : -1;
    });
    refs.openSongPicker = () => { picker.open(sourcePanels.find(entry => entry[0] === chosenSource)[3]); chooseSource(chosenSource); };
    refs.refreshSongPicker = () => { if (online) online.refresh(); };
    refs.disposeSongPicker = () => { if (online) online.cancel(); };
    picker.onClose = refs.disposeSongPicker;
    const inviteLayout = h('div', 'room-invite-layout'); pages.invite.append(inviteLayout);
    const invitationHelp = section(inviteLayout, '邀请朋友');
    refs.roomCodeRow = h('div', 'room-code-row'); const codeLabel = h('div'); codeLabel.append(h('small', 'room-sub', '房间查找码')); refs.roomCode = h('strong', 'room-code'); codeLabel.append(refs.roomCode);
    refs.copyRoomCode = button('复制房间码', async () => { const key = sessionKey(), code = api.snapshot().admission && api.snapshot().admission.room_code; if (!code) throw new Error('当前没有可复制的房间码'); await global.HertzClipboard.write(code); if (current(key)) status('房间码已复制。'); });
    refs.roomCodeRow.append(codeLabel, refs.copyRoomCode); invitationHelp.append(refs.roomCodeRow, h('p', 'room-sub', '查找码用于申请，不能直接收听。多人加入时，每人提交申请，由房主批准。'), navigationButton('查看房间成员', () => go('settings')));
    refs.invites = section(invitationHelp, '一次性邀请（限一人使用）', 'room-invite-generator');
    refs.invites.append(h('p', 'room-sub', '在同一网络的电脑上打开 Hertz，即可加入。每份邀请限一人使用。'));
    const host = api.snapshot().mode === 'host';
    const role = select(refs.invites, '参与方式', host ? [['queue', '一起点歌'], ['listen', '仅收听'], ['control', '共同控制'], ['custom', '自定义']] : [['listen', '收听与聊天']]);
    const roleHint = h('p', 'room-sub'); refs.invites.append(roleHint);
    const advanced = h('details', 'room-invite-advanced'); advanced.append(h('summary', '', '高级权限'));
    const invitePerms = refs.invitePerms = h('div', 'room-permissions'), permissions = {};
    let changed = false;
    refs.requestNewInvitation = () => { changed = true; };
    const explain = () => { roleHint.textContent = role.value === 'queue' ? '可以点歌、投票和聊天；播放由房主管理。' : role.value === 'control' ? '可以点歌、聊天和控制播放；房间音量由房主管理。' : role.value === 'listen' ? '可以收听和查看聊天；不修改共同队列。' : '使用下方单独选择的权限。'; };
    [['listen', '收听'], ['queue', '编辑队列'], ['transport', '播控'], ['volume', '房间音量'], ['chat_read', '查看聊天'], ['chat_send', '发言'], ['invite', '邀请新成员']].forEach(([key, label]) => {
      const input = field(invitePerms, label, 'checkbox'); permissions[key] = input;
      input.onchange = () => { role.value = 'custom'; changed = true; explain(); };
    });
    const preset = () => { Object.keys(permissions).forEach(key => { permissions[key].checked = ['listen', 'chat_read'].includes(key) || (key === 'chat_send' && (role.value !== 'listen' || !host)) || (key === 'queue' && ['queue', 'control'].includes(role.value)) || (key === 'transport' && role.value === 'control'); }); explain(); };
    role.onchange = () => { if (role.value !== 'custom') preset(); changed = true; explain(); }; preset();
    advanced.append(invitePerms); advanced.hidden = !host;
    const raw = h('details', 'room-invitation-content'); raw.append(h('summary', '', '查看邀请内容'));
    refs.invitation = field(raw, '一次性邀请', 'textarea'); refs.invitation.readOnly = true; refs.invitation.autocomplete = 'off';
    const qr = h('details', 'room-invitation-code'); qr.append(h('summary', '', '显示二维码'));
    refs.invitationQr = h('div', 'room-invitation-qr'); refs.invitationQr.setAttribute('aria-label', '一次性邀请二维码'); qr.append(refs.invitationQr, h('p', 'room-sub', '需要使用支持一起听的电脑 Hertz 完成加入。'));
    refs.invitationExpiry = h('p', 'room-sub', '尚未生成邀请');
    refs.inviteCopy = button('生成并复制邀请', async () => {
      const key = sessionKey(); let value = api.validInvitation();
      if (value && changed) { await api.revokeInvitation(); if (!current(key)) return; value = ''; }
      if (!value) {
        const p = {}; Object.keys(permissions).forEach(k => p[k] = permissions[k].checked);
        const result = await api.makeInvitation(p); if (!current(key)) return;
        api.invitationGenerated(result.invitation, result.invitation_id, result.expires_in_seconds); refs.invitation.value = result.invitation; changed = false; value = result.invitation;
      }
      try { await global.HertzClipboard.write('一起听「' + (api.snapshot().name || '音乐房间') + '」\n在同一网络的电脑 Hertz 中打开“一起听 → 使用邀请加入”，粘贴此消息。\n' + value + '\n每份邀请限一人使用，以房主显示的剩余有效时间为准。'); if (current(key)) status('邀请已复制，发给同一网络的朋友即可。'); }
      catch (_) { if (current(key)) { status('邀请已生成，剪贴板暂不可用。可再次复制或展开邀请内容手动复制。', true); } }
      if (current(key)) refs.inviteCopy.textContent = '再次复制邀请';
    }, 'primary');
    refs.revokeInvitation = button('撤销这份邀请', () => api.revokeInvitation()); refs.revokeInvitation.disabled = true;
    refs.refreshInvitation = remaining => {
      const valid = !!api.validInvitation();
      refs.inviteCopy.textContent = valid ? changed ? '撤销旧邀请并生成新邀请' : '再次复制邀请' : '生成并复制邀请';
      if (valid) refs.invitationExpiry.textContent = '限一人使用 · ' + Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0') + ' 后过期';
    };
    refs.invites.append(refs.inviteCopy, refs.invitationExpiry, refs.revokeInvitation, advanced, raw, qr);
    const responses = section(inviteLayout, '邀请与回应'); refs.invitationResponses = h('div', 'room-invitation-responses'); responses.append(refs.invitationResponses);
    refs.guestInvite = h('p', 'room-empty-state', '请联系房主获取一次性邀请。'); inviteLayout.append(refs.guestInvite);
    const settings = workspace.createSettings([
      ['members', '成员与申请'], ['profile', '房间资料', true], ['invitations', '邀请与发现', true], ['output', '本机输出'], ['sound', '房间音效'],
      ['timer', '睡眠定时', true], ['sharing', '歌曲分享', true], ['chat', '聊天管理', true], ['session', '房间会话']
    ]);
    refs.members = section(settings.members, '房间成员');
    const memberTools = h('div', 'room-flow-actions'); memberTools.append(navigationButton('邀请新成员', () => go('invite')), navigationButton('处理入房申请', () => { refs.admissions.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); }));
    if (api.snapshot().mode === 'host') { const transfer = navigationButton('转移房主', () => {}); transfer.disabled = true; transfer.title = '暂不支持房主转移。可以结束后由朋友重新创建房间。'; memberTools.append(transfer, button('结束房间', () => api.leaveRoom(), 'room-leave')); }
    settings.members.append(memberTools);
    const selfProfile = section(settings.members, '我的头像');
    const selfAvatar = avatarPicker(selfProfile, () => { const self = (api.snapshot().members || []).find(member => member.id === api.snapshot().member_id); return self ? self.name : api.nickname(); });
    selfProfile.append(button('保存我的头像', () => { selfAvatar.save(); drawMembers(); drawWaiting(); status('头像已保存到本机。'); }));
    if (api.snapshot().mode === 'host') {
      const profile = section(settings.profile, '房间封面');
      refs.roomCoverEditor = coverEditor(profile, api.snapshot().room_cover, () => api.snapshot().name || '一起听房间');
      const save = button('保存房间封面', async () => {
        const key = sessionKey(), cover = refs.roomCoverEditor.value(), editor = refs.roomCoverEditor;
        await command({ action: 'room_cover', cover });
        if (current(key)) { editor.saved(cover); status('房间封面已保存，附近的人刷新大厅后即可查看。'); }
      }, 'primary');
      save.disabled = true; refs.roomCoverEditor.onchange = dirty => { save.disabled = !dirty; }; profile.append(save);
    }
    refs.admissions = section(settings.members, '入房申请'); refs.admissionList = h('div', 'room-admission-list'); refs.admissions.append(refs.admissionList);
    refs.asideAdmissions = section(memberPanel, '入房申请'); refs.asideAdmissionList = h('div', 'room-admission-list'); refs.asideAdmissions.append(refs.asideAdmissionList); memberPanel.prepend(refs.asideAdmissions);
    refs.admissionDialog = workspace.createEntryDialog('admissions', '有人申请加入一起听');
    refs.admissionPopupList = h('div', 'room-admission-list');
    refs.admissionDialog.body.append(h('p', 'room-sub', '确认参与方式后批准加入，也可以稍后在成员中处理。'), refs.admissionPopupList, navigationButton('稍后处理', () => refs.admissionDialog.close()));
    refs.invitationManagement = section(settings.invitations, '邀请与发现'); refs.discoverable = field(refs.invitationManagement, '允许附近的人发现房间', 'checkbox'); refs.discoverable.onchange = () => run(() => api.setDiscoverable(refs.discoverable.checked)); refs.discoveryStatus = h('p', 'room-sub'); refs.outstandingInvitations = h('div'); refs.invitationManagement.append(refs.discoveryStatus, refs.outstandingInvitations);
    mountOutput(settings.output); mountDsp(settings.sound, settings.timer);
    refs.sharing = section(settings.sharing, '歌曲分享'); const search = field(refs.sharing, '搜索本地曲库', 'search'); refs.localTracks = h('div', 'room-local-tracks'); refs.sharedOnline = h('div', 'room-local-tracks'); refs.sharing.append(button('搜索', () => loadLocal(search.value)), refs.localTracks, h('h4', '', '已分享的在线歌曲'), refs.sharedOnline, button('更新分享范围', () => command({ action: 'share', track_ids: [...selection] }), 'primary'));
    mountChatAdmin(settings.chat);
    const leave = section(settings.session, '房间会话'); leave.append(h('p', 'room-sub', '返回 Hertz 会保持房间连接；成员退出只断开自己，房主结束房间会停止所有成员收听。'), navigationButton('返回 Hertz', api.onReturn), button(api.snapshot().mode === 'host' ? '结束并退出' : '退出房间', () => api.leaveRoom(), 'room-leave'));
  }
      return { mountEntry, mountActive, drawQueue, drawLibrary, drawMembers, drawWaiting, drawConnection, drawActivity, drawMessage, drawApplication, drawAdmissions, drawInvitationManagement, checkApplication: api.checkApplication,
        invitationRevoked(id) { const record = invitationRecords.get(id); if (record) record.state = 'revoked'; },
        drawRoomProfile(cover) { if (refs.roomCoverEditor) refs.roomCoverEditor.confirm(api.snapshot().room_cover); if (refs.activeRoomArtwork) refs.activeRoomArtwork.update(api.snapshot().name || '一起听房间', cover); },
        updatePlayMode(mode) {
          const labels = { repeat: '列表循环', repeat_one: '单曲循环', shuffle: '随机播放' };
          if (!labels[mode]) mode = 'repeat';
          if (refs.quickMode.dataset.mode === mode) return;
          refs.quickMode.dataset.mode = mode;
          iconButton(refs.quickMode, mode === 'shuffle' ? 'shuffle' : 'repeat', labels[mode]);
          refs.quickMode.title = labels[mode] + ' · 点击切换播放模式';
          if (mode === 'repeat_one') { const one = h('span', 'room-mode-one', '1'); one.setAttribute('aria-hidden', 'true'); refs.quickMode.append(one); }
        },
        updatePlayButton(playing) { api.root().dataset.roomPlaying = String(!!playing); iconButton(refs.play, playing ? 'pause' : 'play', playing ? '暂停' : '播放'); }, selectTab: value => { if (refs.selectTab) refs.selectTab(value); } };
    }
  };
})(window);
