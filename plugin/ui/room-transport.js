// SPDX-License-Identifier: MIT
// Presentation only: the room snapshot remains the single playback authority.
(function (global) {
  'use strict';
  const element = (tag, cls, text) => {
    const node = document.createElement(tag);
    node.className = cls || '';
    if (text != null) node.textContent = text;
    return node;
  };
  const time = ms => Math.floor(ms / 60000) + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  const icon = name => global.HertzRoomWorkspace.icon(name);
  function labelButton(node, name, label) {
    node.replaceChildren(icon(name));
    node.setAttribute('aria-label', label);
    node.title = label;
  }

  global.HertzRoomTransport = {
    create(actions) {
      const bar = element('footer', 'room-global');
      bar.setAttribute('aria-label', '一起听播放器');
      bar.hidden = true;
      bar.id = 'room-global-player';
      const info = element('button', 'room-global-info'); info.type = 'button';
      info.onclick = actions.open;
      info.setAttribute('aria-label', '返回一起听房间');
      info.title = '返回一起听房间';
      const mark = element('span', 'room-global-mark'); mark.append(icon('headphones'));
      const copy = element('span', 'room-global-copy');
      const label = element('small', 'room-kicker');
      const title = element('strong', '', '一起听');
      const artist = element('small', 'room-sub');
      copy.append(label, title, artist); info.append(mark, copy);
      const controls = element('div', 'room-global-controls');
      function control(text, action, name) {
        const node = element('button', 'room-global-button'); node.type = 'button';
        labelButton(node, name, text);
        node.onclick = () => actions.playback(action);
        controls.append(node);
        return node;
      }
      const previous = control('上一首', 'previous', 'prev');
      const play = control('播放', 'toggle', 'play'); play.classList.add('room-global-play');
      const next = control('下一首', 'next', 'next');
      const progress = element('div', 'room-global-progress');
      const timestamp = element('span', 'room-mono');
      const seek = element('input'); seek.type = 'range'; seek.min = 0; seek.max = 1000; seek.step = 1;
      seek.setAttribute('aria-label', '房间播放进度');
      let instance = '', duration = 0, seeking = false, seekContext = null, adjustingVolume = false, workspaceVisible = false, roomActive = false, playbackUncertain = false, lastSnapshot = null, collapsed = false;
      seek.oninput = () => { if (!seeking) seekContext = { instance, duration }; seeking = true; };
      seek.onblur = () => { seeking = false; seekContext = null; };
      seek.onchange = () => {
        const context = seekContext || { instance, duration };
        seeking = false; seekContext = null;
        if (context.instance === instance) actions.seek(context.instance, Math.round(Number(seek.value) * context.duration / 1000));
      };
      progress.append(timestamp, seek);
      const volumeControl = element('div', 'room-global-volume');
      const volumeButton = element('button', 'room-global-button'); volumeButton.type = 'button';
      labelButton(volumeButton, 'volume', '调整本机音量');
      volumeButton.setAttribute('aria-expanded', 'false');
      volumeButton.setAttribute('aria-controls', 'room-global-volume-panel');
      const volumePanel = element('div', 'room-global-volume-panel'); volumePanel.id = 'room-global-volume-panel'; volumePanel.hidden = true;
      volumePanel.setAttribute('role', 'group'); volumePanel.setAttribute('aria-label', '本机音量控制');
      const volumeValue = element('output', 'room-global-volume-value', '100');
      const volume = element('input'); volume.type = 'range'; volume.min = 0; volume.max = 100; volume.step = 1;
      volume.setAttribute('aria-label', '房间本机音量');
      volume.setAttribute('aria-orientation', 'vertical');
      function updateVolume() { volumeValue.textContent = volume.value; volume.setAttribute('aria-valuetext', volume.value + '%'); volume.style.setProperty('--room-volume-level', volume.value + '%'); }
      function closeVolume(restoreFocus) {
        volumePanel.hidden = true; volumeButton.setAttribute('aria-expanded', 'false');
        if (restoreFocus) volumeButton.focus();
      }
      volumeButton.onclick = () => {
        if (!volumePanel.hidden) { closeVolume(false); return; }
        volumePanel.hidden = false; volumeButton.setAttribute('aria-expanded', 'true'); volume.focus();
      };
      function outsideVolume(event) { if (!volumeControl.contains(event.target)) closeVolume(false); }
      function volumeKeydown(event) { if (event.key === 'Escape' && !volumePanel.hidden) { event.preventDefault(); closeVolume(true); } }
      volumeControl.onfocusout = event => { if (!volumeControl.contains(event.relatedTarget)) closeVolume(false); };
      document.addEventListener('pointerdown', outsideVolume);
      document.addEventListener('keydown', volumeKeydown);
      volume.oninput = () => { adjustingVolume = true; updateVolume(); };
      volume.onblur = () => { adjustingVolume = false; };
      volume.onchange = () => { adjustingVolume = false; actions.volume(Number(volume.value) / 100); };
      volumePanel.append(volumeValue, volume); volumeControl.append(volumeButton, volumePanel);
      const returnButton = element('button', 'room-global-return'); returnButton.type = 'button';
      returnButton.append(icon('headphones'), element('span', '', '返回房间'));
      returnButton.onclick = actions.open;
      const collapse = element('button', 'room-global-button room-global-collapse'); collapse.type = 'button';
      collapse.setAttribute('aria-controls', bar.id);
      function updateVisibility() {
        bar.hidden = !roomActive || workspaceVisible;
        bar.classList.toggle('is-collapsed', collapsed);
        document.body.classList.toggle('room-player-collapsed', roomActive && collapsed);
        collapse.setAttribute('aria-expanded', String(!collapsed));
        labelButton(collapse, 'chevron-down', collapsed ? '展开一起听播放栏' : '收起一起听播放栏');
      }
      collapse.onclick = () => { closeVolume(false); collapsed = !collapsed; updateVisibility(); };
      const notice = element('span', 'room-global-notice'); notice.setAttribute('role', 'status'); notice.hidden = true;
      bar.append(info, controls, progress, volumeControl, returnButton, collapse, notice);
      document.body.append(bar);
      updateVisibility();
      return {
        render(snapshot) {
          lastSnapshot = snapshot;
          const active = snapshot.mode !== 'local';
          if (!active) { collapsed = false; closeVolume(false); }
          roomActive = active; updateVisibility();
          document.body.classList.toggle('room-active', active);
          if (!active) return;
          const track = snapshot.current_track;
          const permissions = snapshot.permissions || {};
          const output = snapshot.output || {};
          instance = snapshot.track_instance_id || '';
          duration = Math.max(0, Number(track && track.duration_ms || 0));
          const position = Math.max(0, Number(snapshot.position_ms || 0));
          const connected = snapshot.mode === 'host' || snapshot.mode === 'guest';
          bar.classList.toggle('is-reconnecting', !connected);
          label.textContent = '一起听 · ' + (snapshot.mode === 'host' ? '房主' : connected ? '已连接' : '正在重连');
          title.textContent = track ? track.title : snapshot.name || '等待共享歌曲';
          artist.textContent = track ? track.artist || '未知歌手' : '打开房间查看队列';
          labelButton(play, snapshot.playing ? 'pause' : 'play', snapshot.playing ? '暂停' : '播放');
          [previous, play, next].forEach(node => { node.disabled = !connected || !permissions.transport || playbackUncertain; node.title = playbackUncertain ? '请打开房间查询原播放操作的结果' : !connected ? '房间正在重连' : !permissions.transport ? '房主尚未授予播放控制权限' : node.getAttribute('aria-label'); });
          timestamp.textContent = time(position) + ' / ' + time(duration);
          seek.disabled = !connected || !permissions.transport || !duration || playbackUncertain;
          if (!seeking) seek.value = duration ? Math.round(Math.min(position / duration, 1) * 1000) : 0;
          volume.disabled = !output.enabled;
          volumeButton.disabled = !output.enabled;
          volumeButton.title = output.enabled ? '调整本机音量' : '请先在房间设置中启用本机输出';
          if (!output.enabled) closeVolume(false);
          if (!adjustingVolume) { volume.value = Math.round(Number((output.settings || {}).volume ?? 1) * 100); updateVolume(); }
        },
        notice(text, error) {
          notice.textContent = text || '';
          notice.hidden = !text;
          notice.classList.toggle('room-error', !!error);
        },
        setWorkspaceVisible(visible) { workspaceVisible = !!visible; closeVolume(false); updateVisibility(); },
        setPlaybackUncertain(value) { playbackUncertain = !!value; if (lastSnapshot) this.render(lastSnapshot); },
        destroy() { document.removeEventListener('pointerdown', outsideVolume); document.removeEventListener('keydown', volumeKeydown); bar.remove(); document.body.classList.remove('room-active', 'room-player-collapsed'); }
      };
    }
  };
})(window);
