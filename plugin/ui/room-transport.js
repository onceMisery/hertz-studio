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

  global.HertzRoomTransport = {
    create(actions) {
      const bar = element('footer', 'room-global');
      bar.setAttribute('aria-label', '一起听播放器');
      bar.hidden = true;
      const info = element('button', 'room-global-info'); info.type = 'button';
      info.onclick = actions.open;
      const label = element('small', 'room-kicker');
      const title = element('strong', '', '一起听');
      const artist = element('small', 'room-sub');
      info.append(label, title, artist);
      const controls = element('div', 'room-global-controls');
      function control(text, action) {
        const node = element('button', 'btn', text); node.type = 'button';
        node.onclick = () => actions.playback(action);
        controls.append(node);
        return node;
      }
      const previous = control('上一首', 'previous');
      const play = control('播放', 'toggle'); play.classList.add('primary');
      const next = control('下一首', 'next');
      const progress = element('div', 'room-global-progress');
      const timestamp = element('span', 'room-mono');
      const seek = element('input'); seek.type = 'range'; seek.min = 0; seek.max = 1000; seek.step = 1;
      seek.setAttribute('aria-label', '房间播放进度');
      let instance = '', duration = 0, seeking = false, seekContext = null, adjustingVolume = false, workspaceVisible = false, roomActive = false, playbackUncertain = false, lastSnapshot = null;
      seek.oninput = () => { if (!seeking) seekContext = { instance, duration }; seeking = true; };
      seek.onblur = () => { seeking = false; seekContext = null; };
      seek.onchange = () => {
        const context = seekContext || { instance, duration };
        seeking = false; seekContext = null;
        if (context.instance === instance) actions.seek(context.instance, Math.round(Number(seek.value) * context.duration / 1000));
      };
      progress.append(timestamp, seek);
      const volumeLabel = element('label', 'room-global-volume', '本机音量');
      const volume = element('input'); volume.type = 'range'; volume.min = 0; volume.max = 100; volume.step = 1;
      volume.setAttribute('aria-label', '房间本机音量');
      volume.oninput = () => { adjustingVolume = true; };
      volume.onblur = () => { adjustingVolume = false; };
      volume.onchange = () => { adjustingVolume = false; actions.volume(Number(volume.value) / 100); };
      volumeLabel.append(volume);
      const notice = element('span', 'room-global-notice'); notice.setAttribute('role', 'status'); notice.hidden = true;
      bar.append(info, controls, progress, volumeLabel, notice);
      document.body.append(bar);
      return {
        render(snapshot) {
          lastSnapshot = snapshot;
          const active = snapshot.mode !== 'local';
          roomActive = active; bar.hidden = !active || workspaceVisible;
          document.body.classList.toggle('room-active', active);
          if (!active) return;
          const track = snapshot.current_track;
          const permissions = snapshot.permissions || {};
          const output = snapshot.output || {};
          instance = snapshot.track_instance_id || '';
          duration = Math.max(0, Number(track && track.duration_ms || 0));
          const position = Math.max(0, Number(snapshot.position_ms || 0));
          const connected = snapshot.mode === 'host' || snapshot.mode === 'guest';
          label.textContent = '一起听 · ' + (snapshot.mode === 'host' ? '房主' : connected ? '已连接' : '正在重连');
          title.textContent = track ? track.title : snapshot.name || '等待共享歌曲';
          artist.textContent = track ? track.artist || '未知歌手' : '打开房间查看队列';
          play.textContent = snapshot.playing ? '暂停' : '播放';
          [previous, play, next].forEach(node => { node.disabled = !connected || !permissions.transport || playbackUncertain; node.title = playbackUncertain ? '请打开房间查询原播放操作的结果' : node.textContent; });
          timestamp.textContent = time(position) + ' / ' + time(duration);
          seek.disabled = !connected || !permissions.transport || !duration || playbackUncertain;
          if (!seeking) seek.value = duration ? Math.round(Math.min(position / duration, 1) * 1000) : 0;
          volume.disabled = !output.enabled;
          if (!adjustingVolume) volume.value = Math.round(Number((output.settings || {}).volume ?? 1) * 100);
        },
        notice(text, error) {
          notice.textContent = text || '';
          notice.hidden = !text;
          notice.classList.toggle('room-error', !!error);
        },
        setWorkspaceVisible(visible) { workspaceVisible = !!visible; bar.hidden = !roomActive || workspaceVisible; },
        setPlaybackUncertain(value) { playbackUncertain = !!value; if (lastSnapshot) this.render(lastSnapshot); },
        destroy() { bar.remove(); document.body.classList.remove('room-active'); }
      };
    }
  };
})(window);
