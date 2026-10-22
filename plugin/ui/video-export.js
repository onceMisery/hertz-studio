// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 歌词视频导出（folia 的 video export，浏览器版）：把三维舞台画面 + 当前
// 歌词行 + 可选的系统声音录成视频文件（Chromium 能力允许时优先 MP4，否则
// WebM）。
//
// 与 folia（Electron desktopCapturer 录窗口）的差别：hertz-studio 的声音由
// 服务端 cpal 直接送输出设备，页面里没有 <audio> 元素可抓，所以
//   · 画面 = 舞台 GL 画布 .captureStream(60)（preserveDrawingBuffer=false 也能
//     用 captureStream 抓已呈现帧），经隐藏 <video> 解码后按「cover」模式
//     重采样到目标画幅（folia createCroppedVideoStream 的同款管线，解决
//     源宽高比 ≠ 目标宽高比的黑边问题）；
//   · 歌词 = 轮询 /v1/overlay/lyric（OBS 浮层同款数据），在合成画布上自绘
//     当前行大字 + 下一行小字 + 标题/歌手水印——DOM 歌词层不在画布里，
//     captureStream 抓不到，必须自己画；
//   · 声音 = 可选 getDisplayMedia 抓系统音频（Windows/Chromium 支持「整个
//     屏幕 + 分享系统音频」），只有音频轨进入文件，共享流随会话释放。用户取消授权
//     就退化为纯画面录制，不阻断。
//
// 零依赖 IIFE，只暴露 window.VideoExport：
//   VideoExport.supported()   能力检测（MediaRecorder + canvas.captureStream）
//   VideoExport.open()        打开导出对话框
//   VideoExport.begin(opts)   直接开始（对话框内部用）
//   VideoExport.stop()        停止并保存

'use strict';

window.VideoExport = (function () {
  // 画幅：与 folia 的 DEFAULT_VIDEO_EXPORT_PRESET_VALUES 一致
  // （1280x720 / 1920x1080 / 1080x1920）。
  var PRESETS = [
    { id: '720p', label: '1280 × 720（横屏）', width: 1280, height: 720 },
    { id: '1080p', label: '1920 × 1080（横屏）', width: 1920, height: 1080 },
    { id: 'portrait', label: '1080 × 1920（竖屏）', width: 1080, height: 1920 }
  ];
  var FRAME_RATE = 60;
  // Real-time recording is buffered by the browser, so stop before it can grow
  // without bound. These limits are recording limits, not output-file promises.
  var MAX_BYTES = 256 * 1024 * 1024;
  var MAX_DURATION_MS = 10 * 60 * 1000;
  var AUDIO_BITS_PER_SECOND = 320000;
  // folia 的码率阶梯：像素越多给得越足，避免高分辨率糊成一团。
  function videoBitsPerSecond(preset) {
    var px = preset.width * preset.height;
    if (px >= 3600000) return 50000000;
    if (px >= 1900000) return 28000000;
    return 14000000;
  }
  // folia getSupportedVideoExportFormat 的候选顺序：MP4 优先（新 Chromium
  // 原生支持 MP4 封装，手机剪辑软件都吃），否则一路退到 WebM。
  var FORMATS = [
    { mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', extension: 'mp4' },
    { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', extension: 'mp4' },
    { mimeType: 'video/mp4', extension: 'mp4' },
    { mimeType: 'video/webm;codecs=vp8,opus', extension: 'webm' },
    { mimeType: 'video/webm;codecs=vp9,opus', extension: 'webm' },
    { mimeType: 'video/webm', extension: 'webm' }
  ];
  function pickFormat(container) {
    if (typeof MediaRecorder === 'undefined') return null;
    for (var i = 0; i < FORMATS.length; i += 1) {
      if (container && container !== 'auto' && FORMATS[i].extension !== container) continue;
      try { if (MediaRecorder.isTypeSupported(FORMATS[i].mimeType)) return FORMATS[i]; } catch (e) { /* 下一候选 */ }
    }
    return null;
  }

  function supported() {
    return typeof MediaRecorder !== 'undefined'
      && !!pickFormat()
      && typeof HTMLCanvasElement !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
  }

  function isDbx() {
    return !!(window.hertzHost && window.hertzHost.isDbx);
  }

  function token() {
    return window.__VMUSIC_TOKEN__ || '';
  }

  // 设置页同款的后端调用：Bearer 头鉴权（transport 同款）。查询串 token 只
  // 对 GET 生效——require_token 明确拒绝 POST 带查询串 token，写控制类请求
  // 必须走请求头。
  function api(s, path, body) {
    return fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token()
      },
      body: JSON.stringify(body || {}), signal: s.control.signal
    }).then(function (res) {
      if (!res.ok) throw new Error(path + ' -> ' + res.status);
      return res.json().catch(function () { return null; });
    });
  }

  // -------------------------------------------------------------------------
  // 歌词快照（OBS 浮层同款：500ms 轮询 + 本地时钟内插）
  // -------------------------------------------------------------------------

  var lyric = { title: '', artist: '', lines: [], playing: false, positionMs: 0, fetchedAt: 0 };

  function pollLyric(s) {
    if (session !== s || s.phase !== 'recording' || s.lyricPending) return;
    s.lyricPending = true;
    var request = new AbortController();
    s.lyricAbort = request;
    var timeout = setTimeout(function () { request.abort(); }, 3000);
    // 这里是 fetch，能给请求头 —— 凭据走 Bearer，不必进查询串。
    fetch('/v1/overlay/lyric', {
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + token() },
      signal: request.signal,
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || session !== s || s.phase !== 'recording' || request.signal.aborted) return;
        if (s.hasPresentation && data.track_id !== s.trackId) { stop('曲目已切换，停止并保留此前片段。'); return; }
        lyric.title = data.title || '';
        lyric.artist = data.artist || '';
        lyric.lines = Array.isArray(data.lines) ? data.lines : [];
        lyric.playing = !!data.playing;
        lyric.positionMs = data.position_ms || 0;
        lyric.fetchedAt = performance.now();
        if (!s.title && lyric.title) s.title = lyric.title;
      })
      .catch(function () { /* A stale or failed snapshot must not advance forever. */ })
      .finally(function () { clearTimeout(timeout); s.lyricPending = false; });
  }
  function interpolatedPos() {
    if (window.Stage && Stage.position) return Stage.position();
    if (!lyric.playing) return lyric.positionMs;
    return lyric.positionMs + Math.min(1500, Math.max(0, performance.now() - lyric.fetchedAt));
  }
  function activeIndexAt(posMs) {
    var lines = lyric.lines;
    var lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].startTime * 1000 <= posMs) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  var lyricGraphemeSegmenter = null;
  function graphemes(text) {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      if (!lyricGraphemeSegmenter) {
        lyricGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      }
      return Array.from(lyricGraphemeSegmenter.segment(text), function (part) { return part.segment; });
    }
    return Array.from(text);
  }

  function wrapLyricText(ctx, text, maxWidth) {
    var words = String(text || '').trim().split(/\s+/).filter(Boolean);
    var lines = [];
    var line = '';
    words.forEach(function (word) {
      var candidate = line ? line + ' ' + word : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        return;
      }
      if (line) {
        lines.push(line);
        line = '';
      }
      if (ctx.measureText(word).width <= maxWidth) {
        line = word;
        return;
      }
      graphemes(word).forEach(function (part) {
        var next = line + part;
        if (line && ctx.measureText(next).width > maxWidth) {
          lines.push(line);
          line = part;
        } else {
          line = next;
        }
      });
    });
    if (line) lines.push(line);
    return lines;
  }

  function limitLyricLines(ctx, lines, maxLines, maxWidth) {
    if (lines.length <= maxLines) return lines;
    var limited = lines.slice(0, maxLines);
    var lastIndex = limited.length - 1;
    var last = graphemes(limited[lastIndex]);
    var suffix = '…';
    while (last.length && ctx.measureText(last.join('') + suffix).width > maxWidth) last.pop();
    limited[lastIndex] = last.join('') + suffix;
    return limited;
  }

  function fitLyricWatermark(ctx, text, maxWidth) {
    var parts = graphemes(String(text || '').trim());
    if (ctx.measureText(parts.join('')).width <= maxWidth) return parts.join('');
    var lo = 0, hi = parts.length;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      var candidate = parts.slice(0, mid).join('').replace(/\s+$/, '') + '…';
      if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    var prefix = parts.slice(0, lo).join('').replace(/\s+$/, '');
    if (!prefix && ctx.measureText('…').width > maxWidth) return '';
    return prefix + '…';
  }

  // -------------------------------------------------------------------------
  // 对话框（模块自管 DOM，palette.js 同款路数）
  // -------------------------------------------------------------------------

  var dom = null;          // { scrim, body, startBtn, stopBtn, preset, origin, sysAudio }
  var recording = false;
  var lastResult = null, downloadUrl = null, downloadTimer = 0;

  function ensureDom() {
    if (dom) return;
    var scrim = document.createElement('div');
    scrim.className = 'vex-scrim';
    scrim.hidden = true;
    scrim.innerHTML = [
      '<div class="vex-card" role="dialog" aria-modal="true" aria-label="录制歌词视频">',
      '  <h3 class="vex-title">录制歌词视频</h3>',
      '  <div class="vex-body"></div>',
      '</div>'
    ].join('');
    document.body.appendChild(scrim);
    scrim.addEventListener('mousedown', function (e) {
      if (e.target === scrim && !recording) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !scrim.hidden && !recording) close();
    });
    dom = { scrim: scrim, body: scrim.querySelector('.vex-body') };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderIdle(errorText) {
    if (dom.timer) { clearInterval(dom.timer); dom.timer = 0; }
    var ok = supported();
    var dbx = isDbx();
    var reason = '';
    if (dbx) reason = '插件形态没有本地歌词接口，导出请在浏览器里打开主界面使用。';
    else if (!ok) reason = '当前浏览器不支持 MediaRecorder / canvas.captureStream，无法录制。';
    dom.body.innerHTML = [
      errorText ? '<p class="vex-error">' + esc(errorText) + '</p>' : '',
      lastResult ? '<p class="vex-note" role="status">' + esc(lastResult.message) + '</p>' : '',
      lastResult && lastResult.blob ? '<button type="button" class="btn" data-vex="download">再次下载上次文件</button>' : '',
      reason
        ? '<p class="vex-note">' + esc(reason) + '</p>'
        : [
          '  <div class="vex-row"><label for="vex-preset">画幅</label>',
          '    <select id="vex-preset" class="vex-select">' + PRESETS.map(function (p) {
            return '<option value="' + p.id + '">' + esc(p.label) + '</option>';
          }).join('') + '</select></div>',
          '  <div class="vex-row"><label for="vex-origin">起点</label>',
          '    <select id="vex-origin" class="vex-select">',
          '      <option value="current">从当前位置开始</option>',
          '      <option value="from-start">从曲目开头开始</option>',
          '    </select></div>',
          '  <div class="vex-row"><label for="vex-format">格式</label><select id="vex-format" class="vex-select">',
          '    <option value="auto">自动选择</option>',
          pickFormat('mp4') ? '<option value="mp4">MP4</option>' : '',
          pickFormat('webm') ? '<option value="webm">WebM</option>' : '',
          '  </select></div>',
          '  <div class="vex-row"><label for="vex-audio">系统声音</label>',
          '    <span class="vex-audio"><input id="vex-audio" type="checkbox" checked>',
          '    <span class="vex-hint">录制开始时会请求「共享屏幕」——选择整个屏幕并勾选「共享系统音频」；取消授权则只录画面。</span></span></div>',
          '  <p class="vex-note">支持沉浸声场和高级编排的三维画布，按目标画幅居中裁切；外部背景、页面与 DOM 歌词特效不进入文件，歌词按当前行/下一行另行合成。系统音轨可能包含其它应用声音；实际有无音轨会在开始后显示。离开前台、共享结束或发生异常时停止并尝试保留已有片段。最长 10 分钟，缓冲达到 256 MiB 时停止。新录制会替换上轮文件缓存；下载后请确认文件已保存。</p>',
          '  <div class="vex-actions"><button type="button" class="btn" data-vex="cancel">取消</button>',
          '    <button type="button" class="btn vex-primary" data-vex="start">开始录制</button></div>'
        ].join('')
    ].join('');
    var startBtn = dom.body.querySelector('[data-vex="start"]');
    var cancelBtn = dom.body.querySelector('[data-vex="cancel"]');
    var downloadBtn = dom.body.querySelector('[data-vex="download"]');
    if (downloadBtn) downloadBtn.onclick = function () {
      try { download(lastResult); } catch (_) { renderIdle('下载未发起，请重试或检查浏览器下载权限。'); }
    };
    dom.preset = dom.body.querySelector('#vex-preset');
    dom.origin = dom.body.querySelector('#vex-origin');
    dom.audio = dom.body.querySelector('#vex-audio');
    dom.format = dom.body.querySelector('#vex-format');
    var last = null;
    try { last = localStorage.getItem('vmusic.video-export-preset'); } catch (_) { /* Optional preference. */ }
    if (dom.preset && PRESETS.some(function (p) { return p.id === last; })) dom.preset.value = last;
    if (cancelBtn) cancelBtn.onclick = function () { close(); };
    if (startBtn) startBtn.onclick = function () {
      var preset = PRESETS.filter(function (p) { return p.id === dom.preset.value; })[0] || PRESETS[1];
      begin({
        preset: preset,
        fromStart: dom.origin.value === 'from-start',
        systemAudio: dom.audio.checked, format:dom.format.value
      }).catch(function (err) {
        if (!session) renderIdle(err && err.message ? err.message : '启动录制失败');
      });
    };
  }

  function audioLabel(s) {
    return s.audioMode === 'system' ? '已包含系统音轨（可能包含其它应用声音）'
      : s.audioMode === 'pending' ? '等待共享选择；可随时取消'
      : '纯画面 · ' + (s.audioReason || '未请求系统声音');
  }

  function renderSession(s) {
    if (dom.timer) clearInterval(dom.timer);
    var pending = s.phase === 'starting', stopping = s.phase === 'stopping';
    dom.body.innerHTML = [
      '  <p class="vex-note vex-live" role="status"><span class="vex-dot"></span>'
        + (pending ? '正在准备…' : stopping ? '正在生成文件…' : '正在录制…')
        + ' <span class="vex-elapsed" id="vex-elapsed">0:00</span></p>',
      '  <p class="vex-note">' + esc(audioLabel(s)) + '</p>',
      s.mimeType ? '<p class="vex-note">' + esc(s.mimeType + ' · ' + s.preset.width + ' × ' + s.preset.height) + '</p>' : '',
      '  <div class="vex-actions"><button type="button" class="btn vex-primary" data-vex="stop"'
        + (stopping ? ' disabled' : '') + '>' + (pending ? '取消准备' : '停止并保存') + '</button></div>'
    ].join('');
    var elapsed = dom.body.querySelector('#vex-elapsed');
    function tick() {
      var seconds = s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0;
      elapsed.textContent = Math.floor(seconds / 60) + ':' + ('0' + (seconds % 60)).slice(-2);
    }
    tick(); dom.timer = setInterval(tick, 500);
    dom.body.querySelector('[data-vex="stop"]').onclick = function () { stop(); };
  }

  function open() {
    ensureDom();
    dom.scrim.hidden = false;
    if (session) renderSession(session);
    else renderIdle('');
  }
  function close() {
    if (!dom) return;
    dom.scrim.hidden = true;
    if (dom.timer) { clearInterval(dom.timer); dom.timer = 0; }
  }

  // -------------------------------------------------------------------------
  // 悬浮的录制指示条（舞台 chrome 之上，任何页面都能看到/点停）
  // -------------------------------------------------------------------------

  var pill = null;
  function showPill(s) {
    if (pill) return;
    pill = document.createElement('div');
    pill.className = 'vex-pill';
    pill.innerHTML = '<span class="vex-dot"></span><span class="vex-pill-tx">' + (s.phase === 'starting' ? '准备中' : 'REC') + '</span>'
      + '<span class="vex-elapsed">0:00</span>'
      + '<button type="button" class="vex-pill-stop">停止</button>';
    pill.querySelector('.vex-pill-stop').onclick = function () { stop(); };
    document.body.appendChild(pill);
    pill.timer = setInterval(function () {
      var el = pill.querySelector('.vex-elapsed');
      if (!el) { clearInterval(pill.timer); return; }
      var seconds = s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0;
      el.textContent = Math.floor(seconds / 60) + ':' + ('0' + (seconds % 60)).slice(-2);
    }, 500);
  }
  function hidePill() {
    if (!pill) return;
    if (pill.timer) clearInterval(pill.timer);
    pill.remove();
    pill = null;
  }

  // -------------------------------------------------------------------------
  // 录制主流程
  // -------------------------------------------------------------------------

  var session = null; // 活跃录制的全部可清理资源

  function cleanupSession(s) {
    if (!s) return;
    if (s.raf) cancelAnimationFrame(s.raf);
    s.timers.forEach(clearTimeout); s.timers.clear();
    s.dispose.forEach(function (dispose) { dispose(); }); s.dispose.length = 0;
    s.control.abort();
    if (s.lyricAbort) s.lyricAbort.abort();
    if (s.recorder) {
      s.recorder.ondataavailable = s.recorder.onerror = s.recorder.onstop = s.recorder.onstart = null;
      if (s.recorder.state !== 'inactive') { try { s.recorder.stop(); } catch (_) { /* Already stopped. */ } }
    }
    s.streams.forEach(function (st) {
      st.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* 已停 */ } });
    });
    if (s.video) { s.video.onloadeddata = s.video.onerror = null; s.video.pause(); s.video.srcObject = null; s.video.remove(); }
    if (s.out && s.out.parentNode) s.out.parentNode.removeChild(s.out);
  }

  function revokeDownload() {
    if (downloadTimer) clearTimeout(downloadTimer);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null; downloadTimer = 0;
  }

  function download(result) {
    if (!result || !result.blob || !result.blob.size) throw new Error('没有可下载的视频');
    revokeDownload();
    downloadUrl = URL.createObjectURL(result.blob);
    var a = document.createElement('a');
    a.href = downloadUrl; a.download = result.filename;
    try { document.body.appendChild(a); a.click(); result.downloadRequested = true; }
    finally { a.remove(); downloadTimer = setTimeout(revokeDownload, 30000); }
  }

  function finish(s, save, reason) {
    if (s.finished) return;
    s.finished = true; s.cancelWait();
    var result = { audioMode:s.audioMode, mimeType:s.mimeType || '', bytes:0, filename:'',
      downloadRequested:false, message:reason || s.reason || '已停止。' };
    try {
      if (save && s.chunks.length) {
        result.blob = new Blob(s.chunks, { type:s.mimeType.split(';')[0] });
        result.bytes = result.blob.size;
        var name = (s.title || 'hertz-studio').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0,80) || 'hertz-studio';
        result.filename = name + '-' + s.preset.width + 'x' + s.preset.height + (s.audioMode === 'system' ? '' : '-silent') + '.' + s.extension;
        result.message += ' 已生成' + (s.reason ? '此前片段' : '视频') + '（' + audioLabel(s) + '），请确认下载已保存。';
        try { download(result); } catch (_) { result.message += ' 自动下载未发起，可再次下载。'; }
      } else if (save) result.message += ' 编码器未返回视频数据，没有生成空文件；可换一种格式重新录制。';
    } catch (_) { result.blob = null; result.message = '视频生成失败，无法生成可保存的片段。'; }
    finally {
      s.chunks.length = 0;
      try { cleanupSession(s); }
      finally {
        try {
          if (session === s) {
            session = null; recording = false; lastResult = result;
            hidePill();
            if (save && !document.hidden) { ensureDom(); dom.scrim.hidden = false; }
            if (dom && !dom.scrim.hidden) renderIdle('');
          }
        } finally { s.resolve(result); }
      }
    }
  }

  function check(s) {
    if (session !== s || s.finished || s.phase !== 'starting') throw new Error('录制准备已取消');
  }

  async function bounded(s, promise, timeout, message) {
    var timer;
    try {
      var expired = new Promise(function (_, reject) {
        timer = setTimeout(function () { reject(new Error(message)); }, timeout); s.timers.add(timer);
      });
      var value = await Promise.race([promise, expired, s.cancelled]);
      check(s); return value;
    } finally { clearTimeout(timer); s.timers.delete(timer); }
  }

  function watchTrack(s, track, reason) {
    var ended = function () { if (session === s && !s.finished) stop(reason); };
    track.addEventListener('ended', ended);
    s.dispose.push(function () { track.removeEventListener('ended', ended); });
  }

  async function begin(opts) {
    if (session) throw new Error('录制正在准备、进行或保存中');
    if (!supported()) throw new Error('当前浏览器不支持录制（需要 MediaRecorder）');
    if (isDbx()) throw new Error('插件形态不支持录制');
    if (document.hidden) throw new Error('请在前台页面开始录制');
    opts = opts || {};
    var requested = opts.preset && opts.preset.id || '1080p';
    var preset = PRESETS.find(function (p) { return p.id === requested; });
    if (!preset) throw new Error('不支持这个录制画幅');
    if (opts.format && ['auto','mp4','webm'].indexOf(opts.format) < 0) throw new Error('不支持这个录制格式');
    if (!pickFormat(opts.format)) throw new Error('当前浏览器不支持所选录制格式');
    var s = {phase:'starting',preset:preset,streams:[],dispose:[],timers:new Set(),chunks:[],bytes:0,
      control:new AbortController(),audioMode:opts.systemAudio ? 'pending' : 'silent',audioReason:'未请求系统声音'};
    s.done = new Promise(function (resolve) { s.resolve = resolve; });
    s.cancelled = new Promise(function (resolve) { s.cancelWait = resolve; });
    session = s; recording = true;
    try {
      revokeDownload(); lastResult = null;
      showPill(s);
      if (dom && !dom.scrim.hidden) renderSession(s);

      // Request screen/audio permission in the original user activation, before
      // stage setup awaits. A cancelled/expired session owns any late stream too.
      var audioRequest = Promise.resolve(null);
      if (opts.systemAudio && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
        try {
          audioRequest = Promise.resolve(navigator.mediaDevices.getDisplayMedia({video:true,
            audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}})).then(function (stream) {
            if (session !== s || s.finished) { stream.getTracks().forEach(function (t) { t.stop(); }); return null; }
            s.streams.push(stream); return stream;
          }, function () { s.audioReason = '未获共享授权'; return null; });
        } catch (_) { s.audioReason = '系统声音共享不可用'; }
      } else if (opts.systemAudio) s.audioReason = '浏览器不支持系统声音共享';

      var disp = await bounded(s,audioRequest,60000,'共享选择超时，请重新开始');
      var audioTracks = disp ? disp.getAudioTracks().filter(function (t) { return t.readyState === 'live'; }) : [];
      s.audioMode = audioTracks.length ? 'system' : 'silent';
      if (disp && !audioTracks.length) s.audioReason = '共享中没有音轨';
      if (dom && !dom.scrim.hidden) renderSession(s);

      // 1. 打开沉浸声场并等它出帧（GL 上下文创建 + 首次渲染）。已经在声场里
      //    就直接用现成的画布。
      try { if (window.Stage3D) Stage3D.open(); } catch (e) { /* 下面画布探测会兜底报错 */ }
      await bounded(s,new Promise(function (resolve) {
        var timer = setTimeout(resolve,1200); s.timers.add(timer);
      }),2000,'舞台启动超时');
      var surface = window.Stage3D && Stage3D.recordingSurface ? Stage3D.recordingSurface() : null;
      var srcCanvas = surface && surface.canvas;
      if (!srcCanvas) throw new Error('当前舞台没有可录制的三维画布，请选择沉浸声场或高级编排的三维场景');
      var lost = function () { stop('舞台图形上下文中断，尝试保留此前片段。'); };
      srcCanvas.addEventListener('webglcontextlost',lost);
      s.dispose.push(function () { srcCanvas.removeEventListener('webglcontextlost',lost); });

      // 2. 源画布 → 隐藏 <video>：captureStream 抓「已呈现帧」，绕开
      //    preserveDrawingBuffer=false 的读取限制（folia 同款管线）。
      var srcStream = srcCanvas.captureStream(FRAME_RATE);
      s.streams.push(srcStream);
      if (!srcStream.getVideoTracks().length) throw new Error('舞台没有可采集的视频轨');
      var video = document.createElement('video');
      s.video = video;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('aria-hidden', 'true');
      video.style.cssText = 'position:fixed;left:-99999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
      var decoded = new Promise(function (resolve, reject) {
        video.onloadeddata = resolve;
        video.onerror = function () { reject(new Error('舞台画面解码失败')); };
      });
      video.srcObject = new MediaStream([srcStream.getVideoTracks()[0]]);
      document.body.appendChild(video);
      // A paused creative scene sleeps after its last presented frame. Its owner
      // must paint once after capture starts; do not read a discarded GL buffer
      // or change playback just to make the capture video receive its first frame.
      if (surface.requestFrame) surface.requestFrame();
      await bounded(s,Promise.all([decoded,video.play()]),5000,'未收到舞台画面，请检查舞台是否可见');
      video.onloadeddata = video.onerror = null;

      // The display video track is never recorded or read. Keep its permission
      // lifetime until cleanup: stopping it early can also end the audio capture.

      // 4. 合成画布：cover 重采样到目标画幅 + 自绘歌词层。
      var out = document.createElement('canvas');
      s.out = out;
      out.width = preset.width;
      out.height = preset.height;
      out.setAttribute('aria-hidden', 'true');
      var ctx = out.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('无法创建录制合成画布');
      ctx.imageSmoothingQuality = 'high';

      function drawCover() {
        var sw = video.videoWidth || srcCanvas.width || preset.width;
        var sh = video.videoHeight || srcCanvas.height || preset.height;
        var scale = Math.max(preset.width / sw, preset.height / sh);
        var dw = Math.round(sw * scale);
        var dh = Math.round(sh * scale);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, preset.width, preset.height);
        ctx.drawImage(video, Math.round((preset.width - dw) / 2), Math.round((preset.height - dh) / 2), dw, dh);
      }

      function drawLyrics() {
        if (surface.ownsLyrics || !lyric.fetchedAt || performance.now() - lyric.fetchedAt > 2000) return;
        var pos = interpolatedPos();
        var idx = activeIndexAt(pos);
        var w = preset.width, h = preset.height;
        var base = Math.round(h * 0.028);
        // 标题/歌手水印：右下角常驻，音源信息进视频更有出处感。
        if (lyric.title) {
          ctx.save();
          ctx.globalAlpha = 0.82;
          ctx.fillStyle = '#f5f6f7';
          ctx.font = '600 ' + base + 'px "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
          ctx.shadowColor = 'rgba(0,0,0,0.6)';
          ctx.shadowBlur = Math.round(base * 0.6);
          ctx.textAlign = 'right';
          ctx.textBaseline = 'alphabetic';
          var margin = Math.round(w * 0.04);
          var watermark = lyric.title + (lyric.artist ? ' · ' + lyric.artist : '');
          ctx.fillText(fitLyricWatermark(ctx, watermark, w - margin * 2), w - margin, h - Math.round(h * 0.045));
          ctx.restore();
        }
        if (idx < 0) return;
        var line = lyric.lines[idx];
        var next = lyric.lines[idx + 1] || null;
        // 行首/行尾 320ms 淡入淡出，切行不生硬。
        var startMs = line.startTime * 1000;
        var endMs = Number.isFinite(line.endTime) ? line.endTime * 1000 : next ? next.startTime * 1000 : startMs + 6000;
        var age = pos - startMs;
        var left = endMs - pos;
        var alpha = 1;
        if (age < 320) alpha = age / 320;
        if (left < 320) alpha = Math.min(alpha, Math.max(0, left / 320));
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.shadowColor = 'rgba(0,0,0,0.65)';
        var font = '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
        var cur = String(line.text || '').trim();
        var currentFontSize = Math.round(h * 0.052);
        var currentLineHeight = Math.round(currentFontSize * 1.2);
        var currentLines = [];
        if (cur) {
          ctx.font = '700 ' + currentFontSize + 'px ' + font;
          currentLines = limitLyricLines(ctx, wrapLyricText(ctx, cur, w * 0.88), 3, w * 0.88);
        }
        var nextFontSize = Math.round(h * 0.034);
        var nextLineHeight = Math.round(nextFontSize * 1.2);
        var nextLines = [];
        if (next && next.text) {
          ctx.font = '400 ' + nextFontSize + 'px ' + font;
          nextLines = limitLyricLines(ctx, wrapLyricText(ctx, String(next.text).trim(), w * 0.84), 2, w * 0.84);
        }
        var bottom = Math.round(h * 0.875);
        var nextFirstBaseline = bottom - Math.max(0, nextLines.length - 1) * nextLineHeight;
        var currentBottom = nextLines.length
          ? nextFirstBaseline - (currentLines.length ? Math.round(currentFontSize * 1.1) : 0)
          : bottom;
        var currentFirstBaseline = currentBottom - Math.max(0, currentLines.length - 1) * currentLineHeight;
        if (currentLines.length) {
          ctx.globalAlpha = alpha;
          ctx.fillStyle = '#f5f6f7';
          ctx.font = '700 ' + currentFontSize + 'px ' + font;
          ctx.shadowBlur = Math.round(h * 0.02);
          currentLines.forEach(function (text, index) {
            ctx.fillText(text, w / 2, currentFirstBaseline + index * currentLineHeight);
          });
        }
        if (nextLines.length) {
          ctx.globalAlpha = alpha * 0.55;
          ctx.fillStyle = '#f5f6f7';
          ctx.font = '400 ' + nextFontSize + 'px ' + font;
          ctx.shadowBlur = Math.round(h * 0.012);
          nextLines.forEach(function (text, index) {
            ctx.fillText(text, w / 2, nextFirstBaseline + index * nextLineHeight);
          });
        }
        ctx.restore();
      }

      // Playback writes must succeed when explicitly requested; failure cannot be
      // presented as a successful "from start" recording.
      if (opts.fromStart) {
        await bounded(s,api(s,'/v1/player/play', {}),6000,'播放控制超时，未开始录制');
        await bounded(s,api(s,'/v1/player/seek', { position_ms: 0 }),6000,'回到曲首超时，未开始录制');
      }
      var presentation = window.Stage && Stage.presentation ? Stage.presentation() : null;
      s.hasPresentation = !!(window.Stage && Stage.presentation);
      s.trackId = presentation && presentation.track && presentation.track.id || null;
      s.title = presentation && presentation.track && presentation.track.title || '';

      var outStream = out.captureStream(FRAME_RATE);
      s.streams.push(outStream);
      if (!outStream.getVideoTracks().length) throw new Error('合成画布没有可录制的视频轨');
        audioTracks.forEach(function (t) { outStream.addTrack(t); });
      var fmt = pickFormat(opts.format);
      if (!fmt) throw new Error('浏览器没有可用的视频编码格式');
      var recorder = new MediaRecorder(outStream, {
          mimeType: fmt.mimeType,
          audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
          videoBitsPerSecond: videoBitsPerSecond(preset)
      });
      s.recorder = recorder;
      s.mimeType = recorder.mimeType || fmt.mimeType;
      s.extension = /^video\/mp4(?:;|$)/.test(s.mimeType) ? 'mp4' : /^video\/webm(?:;|$)/.test(s.mimeType) ? 'webm' : null;
      if (!s.extension) throw new Error('浏览器返回了无法识别的视频格式');
      // start() only requests startup. Chromium may initialize its encoder for
      // seconds before emitting start; stopping in that window can yield zero
      // bytes. Keep the UI in preparation until the native event arrives.
      var encoderReady = new Promise(function (resolve) {
        recorder.onstart = function () {
          if (session !== s || s.finished) return;
          s.mimeType = recorder.mimeType || s.mimeType;
          resolve();
        };
      });
      recorder.ondataavailable = function (e) {
        if (s.finished || session !== s || !e.data || !e.data.size) return;
        if (s.bytes + e.data.size <= MAX_BYTES) { s.chunks.push(e.data); s.bytes += e.data.size; }
        else s.reason = '录制缓冲已满，尝试保存此前片段，文件可能不完整。';
        if (s.bytes >= MAX_BYTES || s.reason) stop(s.reason || '达到录制大小限制。');
      };
      recorder.onerror = function () { stop('录制器发生异常，尝试保存此前片段，文件可能不完整。'); };
      recorder.onstop = function () {
        s.mimeType = recorder.mimeType || s.mimeType;
        finish(s,true,s.reason || '录制已停止。');
      };
      [srcStream,outStream].concat(disp ? [disp] : []).forEach(function (stream) {
        stream.getTracks().forEach(function (track) {
          if (track.readyState === 'ended') throw new Error('采集轨已结束，请重新开始');
          watchTrack(s,track,'采集或系统声音共享已结束，停止并保留此前片段。');
        });
      });
      check(s);
      lyric = {title:'',artist:'',lines:[],playing:false,positionMs:0,fetchedAt:0};
      drawCover();
      recorder.start(1000);
      (function loop() {
        if (session !== s || (s.phase !== 'starting' && s.phase !== 'recording')) return;
        try {
          var currentSurface = Stage3D.recordingSurface();
          if (!currentSurface || currentSurface.canvas !== srcCanvas || currentSurface.source !== surface.source) {
            stop('舞台来源已切换或关闭，停止并保留此前片段。'); return;
          }
          surface.ownsLyrics = currentSurface.ownsLyrics;
          if (s.hasPresentation) {
            var current = Stage.presentation();
            if ((current.track && current.track.id || null) !== s.trackId) { stop('曲目已切换，停止并保留此前片段。'); return; }
          }
          drawCover(); drawLyrics();
          s.raf = requestAnimationFrame(loop);
        } catch (_) { stop('画面合成中断，尝试保留此前片段。'); }
      })();
      await bounded(s,encoderReady,10000,'视频编码器启动超时，未开始录制');
      s.phase = 'recording'; s.startedAt = Date.now();
      pollLyric(s);
      s.timers.add(setInterval(function () { pollLyric(s); },500));
      s.timers.add(setTimeout(function () { stop('达到 10 分钟录制限制，保存此前片段。'); },MAX_DURATION_MS));
      try { localStorage.setItem('vmusic.video-export-preset',preset.id); } catch (_) { /* Optional. */ }
      hidePill(); showPill(s);
      if (dom && !dom.scrim.hidden) renderSession(s);
    } catch (error) {
      if (s.finished) return s.done;
      finish(s,false,'启动录制失败，采集资源已释放。');
      throw error;
    }
    return s.done;
  }

  function stop(reason) {
    var s = session;
    if (!s) return Promise.resolve(null);
    if (reason && !s.reason) s.reason = reason;
    if (s.phase === 'starting') { finish(s,false,s.reason || '已取消录制准备。'); return s.done; }
    if (s.phase === 'stopping') return s.done;
    s.phase = 'stopping';
    if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; }
    if (s.lyricAbort) s.lyricAbort.abort();
    if (dom && !dom.scrim.hidden) renderSession(s);
    // Keep tracks until the final dataavailable/stop events. A broken recorder
    // still has a bounded finalization path and preserves already received data.
    s.timers.add(setTimeout(function () { finish(s,true,'视频结束等待超时，尝试保留已收到的片段。'); },5000));
    try { if (s.recorder.state !== 'inactive') s.recorder.stop(); }
    catch (_) { s.reason = '录制器停止失败，尝试保留已收到的片段。'; }
    return s.done;
  }

  document.addEventListener('visibilitychange',function () {
    if (document.hidden && session) stop('页面离开前台，停止并保留此前片段。');
  });
  window.addEventListener('beforeunload',function (event) {
    if (!session) return;
    event.preventDefault(); event.returnValue = '';
  });
  window.addEventListener('pagehide',function () { if (session) stop('页面已关闭，尝试保留此前片段。'); revokeDownload(); });

  return { supported:supported,open:open,close:close,begin:begin,stop:stop,isRecording:function () { return !!session; },
    status:function () { return session ? {phase:session.phase,audioMode:session.audioMode,mimeType:session.mimeType || '',bytes:session.bytes}
      : {phase:'idle',audioMode:lastResult && lastResult.audioMode || null,mimeType:lastResult && lastResult.mimeType || '',
        bytes:lastResult && lastResult.bytes || 0,downloadRequested:!!(lastResult && lastResult.downloadRequested)}; } };
})();
