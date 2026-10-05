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
//     屏幕 + 分享系统音频」），只取音频轨，画面轨当场丢弃。用户取消授权
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
  function pickFormat() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (var i = 0; i < FORMATS.length; i += 1) {
      try { if (MediaRecorder.isTypeSupported(FORMATS[i].mimeType)) return FORMATS[i]; } catch (e) { /* 下一候选 */ }
    }
    return null;
  }

  function supported() {
    return typeof MediaRecorder !== 'undefined'
      && !!pickFormat()
      && !!(HTMLCanvasElement && HTMLCanvasElement.prototype.captureStream);
  }

  function isDbx() {
    return !!(window.hertzHost && window.hertzHost.isDbx);
  }

  function token() {
    return window.__VMUSIC_TOKEN__ || '';
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // 设置页同款的后端调用：Bearer 头鉴权（transport 同款）。查询串 token 只
  // 对 GET 生效——require_token 明确拒绝 POST 带查询串 token，写控制类请求
  // 必须走请求头。
  function api(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token()
      },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      if (!res.ok) throw new Error(path + ' -> ' + res.status);
      return res.json().catch(function () { return null; });
    });
  }

  // -------------------------------------------------------------------------
  // 歌词快照（OBS 浮层同款：500ms 轮询 + 本地时钟内插）
  // -------------------------------------------------------------------------

  var lyric = { title: '', artist: '', lines: [], playing: false, positionMs: 0, fetchedAt: 0, timer: 0 };

  function pollLyric() {
    if (isDbx()) return; // 插件形态没有本地 HTTP，歌词层静默缺席
    fetch('/v1/overlay/lyric?token=' + encodeURIComponent(token()), { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        lyric.title = data.title || '';
        lyric.artist = data.artist || '';
        lyric.lines = data.lines || [];
        lyric.playing = !!data.playing;
        lyric.positionMs = data.position_ms || 0;
        lyric.fetchedAt = performance.now();
      })
      .catch(function () { /* 瞬时失败保持上一帧 */ });
  }
  function startLyricPoll() {
    if (lyric.timer) return;
    pollLyric();
    lyric.timer = setInterval(pollLyric, 500);
  }
  function stopLyricPoll() {
    if (lyric.timer) { clearInterval(lyric.timer); lyric.timer = 0; }
  }
  function interpolatedPos() {
    if (!lyric.playing) return lyric.positionMs;
    return lyric.positionMs + Math.max(0, performance.now() - lyric.fetchedAt);
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

  // -------------------------------------------------------------------------
  // 对话框（模块自管 DOM，palette.js 同款路数）
  // -------------------------------------------------------------------------

  var dom = null;          // { scrim, body, startBtn, stopBtn, preset, origin, sysAudio }
  var recording = false;

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
    var ok = supported();
    var dbx = isDbx();
    var reason = '';
    if (dbx) reason = '插件形态没有本地歌词接口，导出请在浏览器里打开主界面使用。';
    else if (!ok) reason = '当前浏览器不支持 MediaRecorder / canvas.captureStream，无法录制。';
    dom.body.innerHTML = [
      errorText ? '<p class="vex-error">' + esc(errorText) + '</p>' : '',
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
          '  <div class="vex-row"><label for="vex-audio">系统声音</label>',
          '    <span class="vex-audio"><input id="vex-audio" type="checkbox" checked>',
          '    <span class="vex-hint">录制开始时会请求「共享屏幕」——选择整个屏幕并勾选「共享系统音频」；取消授权则只录画面。</span></span></div>',
          '  <p class="vex-note">开始后自动打开沉浸声场并隐藏操作界面，舞台左上角出现录制计时；点「停止并保存」生成文件。歌词与标题会作为画面的一部分烧进视频。录制期间请保持本页面在前台：切到别的标签页或最小化后画面会停住（声音不受影响）。</p>',
          '  <div class="vex-actions"><button type="button" class="btn" data-vex="cancel">取消</button>',
          '    <button type="button" class="btn vex-primary" data-vex="start">开始录制</button></div>'
        ].join('')
    ].join('');
    var startBtn = dom.body.querySelector('[data-vex="start"]');
    var cancelBtn = dom.body.querySelector('[data-vex="cancel"]');
    if (cancelBtn) cancelBtn.onclick = function () { close(); };
    if (startBtn) startBtn.onclick = function () {
      var preset = PRESETS.filter(function (p) { return p.id === dom.preset.value; })[0] || PRESETS[1];
      begin({
        preset: preset,
        fromStart: dom.origin.value === 'from-start',
        systemAudio: dom.audio.checked
      }).catch(function (err) {
        recording = false;
        stopLyricPoll();
        renderIdle(err && err.message ? err.message : '启动录制失败');
      });
    };
  }

  function renderRecording(startedAt) {
    dom.body.innerHTML = [
      '  <p class="vex-note vex-live"><span class="vex-dot"></span>正在录制… <span class="vex-elapsed" id="vex-elapsed">0:00</span></p>',
      '  <p class="vex-note">可以正常操作（界面会自动隐藏）；回到这里或点下面的按钮结束。</p>',
      '  <div class="vex-actions"><button type="button" class="btn vex-primary" data-vex="stop">停止并保存</button></div>'
    ].join('');
    var elapsed = dom.body.querySelector('#vex-elapsed');
    var tick = setInterval(function () {
      if (!recording) { clearInterval(tick); return; }
      var s = Math.floor((Date.now() - startedAt) / 1000);
      elapsed.textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    }, 500);
    dom.body.querySelector('[data-vex="stop"]').onclick = function () { stop(); };
  }

  function open() {
    ensureDom();
    renderIdle('');
    dom.scrim.hidden = false;
    if (supported() && !isDbx()) {
      dom.preset = dom.body.querySelector('#vex-preset');
      dom.origin = dom.body.querySelector('#vex-origin');
      dom.audio = dom.body.querySelector('#vex-audio');
      var last = null;
      try { last = localStorage.getItem('vmusic.video-export-preset'); } catch (e) { /* 私密模式 */ }
      if (last && dom.preset.querySelector('option[value="' + last + '"]')) dom.preset.value = last;
    }
  }
  function close() {
    if (!dom) return;
    dom.scrim.hidden = true;
  }

  // -------------------------------------------------------------------------
  // 悬浮的录制指示条（舞台 chrome 之上，任何页面都能看到/点停）
  // -------------------------------------------------------------------------

  var pill = null;
  function showPill() {
    if (pill) return;
    pill = document.createElement('div');
    pill.className = 'vex-pill';
    pill.innerHTML = '<span class="vex-dot"></span><span class="vex-pill-tx">REC</span>'
      + '<span class="vex-elapsed">0:00</span>'
      + '<button type="button" class="vex-pill-stop">停止</button>';
    pill.querySelector('.vex-pill-stop').onclick = function () { stop(); };
    document.body.appendChild(pill);
    var t0 = Date.now();
    pill.timer = setInterval(function () {
      var el = pill.querySelector('.vex-elapsed');
      if (!el) { clearInterval(pill.timer); return; }
      var s = Math.floor((Date.now() - t0) / 1000);
      el.textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
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
    if (s.pillTimer) clearInterval(s.pillTimer);
    s.streams.forEach(function (st) {
      st.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* 已停 */ } });
    });
    if (s.video) { s.video.pause(); s.video.srcObject = null; s.video.remove(); }
    if (s.out && s.out.parentNode) s.out.parentNode.removeChild(s.out);
    if (s.recorder && s.recorder.state !== 'inactive') {
      try { s.recorder.stop(); } catch (e) { /* 已停 */ }
    }
  }

  async function begin(opts) {
    if (recording) throw new Error('已经在录制中了');
    if (!supported()) throw new Error('当前浏览器不支持录制（需要 MediaRecorder）');
    if (isDbx()) throw new Error('插件形态不支持录制');
    var preset = opts.preset || PRESETS[1];

    // 1. 打开沉浸声场并等它出帧（GL 上下文创建 + 首次渲染）。已经在声场里
    //    就直接用现成的画布。
    try { if (window.Stage3D) Stage3D.open(); } catch (e) { /* 下面画布探测会兜底报错 */ }
    await wait(1200);
    var srcCanvas = document.querySelector('#s3d-canvas-wrap canvas.s3d-canvas');
    if (!srcCanvas) throw new Error('没有找到三维舞台画布（GL 不可用时舞台退化为平面渲染，无法录制）');

    // 2. 源画布 → 隐藏 <video>：captureStream 抓「已呈现帧」，绕开
    //    preserveDrawingBuffer=false 的读取限制（folia 同款管线）。
    var srcStream = srcCanvas.captureStream(FRAME_RATE);
    var video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;left:-99999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
    video.srcObject = new MediaStream([srcStream.getVideoTracks()[0]]);
    document.body.appendChild(video);
    await new Promise(function (resolve, reject) {
      var done = false;
      video.onloadedmetadata = function () {
        if (done) return; done = true;
        var p = video.play();
        if (p && p.catch) p.catch(function () { /* 自动播放策略：muted 不会拦 */ });
        resolve();
      };
      video.onerror = function () { if (!done) { done = true; reject(new Error('舞台画面解码失败')); } };
      setTimeout(function () { if (!done) { done = true; resolve(); } }, 3000);
    });

    // 3. 系统声音（可选）：只要音频轨，画面轨当场停掉。
    var audioTracks = [];
    if (opts.systemAudio && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
      try {
        var disp = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
        disp.getVideoTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* 已停 */ } });
        audioTracks = disp.getAudioTracks();
      } catch (e) { /* 用户取消：退化为纯画面 */ }
    }

    // 4. 合成画布：cover 重采样到目标画幅 + 自绘歌词层。
    var out = document.createElement('canvas');
    out.width = preset.width;
    out.height = preset.height;
    out.setAttribute('aria-hidden', 'true');
    var ctx = out.getContext('2d', { alpha: false });
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
        ctx.fillText(lyric.title + (lyric.artist ? ' · ' + lyric.artist : ''), w - Math.round(w * 0.04), h - Math.round(h * 0.045));
        ctx.restore();
      }
      if (idx < 0) return;
      var line = lyric.lines[idx];
      var next = lyric.lines[idx + 1] || null;
      // 行首/行尾 320ms 淡入淡出，切行不生硬。
      var startMs = line.startTime * 1000;
      var endMs = next ? next.startTime * 1000 : startMs + 6000;
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
      if (cur) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#f5f6f7';
        ctx.font = '700 ' + Math.round(h * 0.052) + 'px ' + font;
        ctx.shadowBlur = Math.round(h * 0.02);
        ctx.fillText(cur, w / 2, Math.round(h * 0.84), w * 0.88);
      }
      if (next && next.text) {
        ctx.globalAlpha = alpha * 0.55;
        ctx.fillStyle = '#f5f6f7';
        ctx.font = '400 ' + Math.round(h * 0.034) + 'px ' + font;
        ctx.shadowBlur = Math.round(h * 0.012);
        ctx.fillText(String(next.text).trim(), w / 2, Math.round(h * 0.9), w * 0.84);
      }
      ctx.restore();
    }

    // 5. 从头开始：先确保在播，再 seek 回 0（录的就是完整一遍）。
    if (opts.fromStart) {
      try {
        await api('/v1/player/play', {});
        await api('/v1/player/seek', { position_ms: 0 });
      } catch (e) { /* 播放控制失败不阻断录制本身 */ }
    }

    // 6. 录制器。装到 session 之前的任何一步抛错都要把源流/隐藏 video 清掉，
    //    不然舞台会一直多挂着一条 60fps 的采集轨。
    var outStream, recorder, fmt;
    try {
      outStream = out.captureStream(FRAME_RATE);
      audioTracks.forEach(function (t) { outStream.addTrack(t); });
      fmt = pickFormat();
      recorder = new MediaRecorder(outStream, {
        mimeType: fmt.mimeType,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
        videoBitsPerSecond: videoBitsPerSecond(preset)
      });
    } catch (err) {
      srcStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* 已停 */ } });
      video.pause(); video.srcObject = null; video.remove();
      throw err;
    }
    var chunks = [];
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onerror = function () { stop(); };
    recorder.onstop = function () {
      var resolveDone = session ? session.resolve : null;
      var blob = new Blob(chunks, { type: fmt.mimeType.split(';')[0] });
      var name = (lyric.title || 'hertz-studio').replace(/[\\/:*?"<>|]/g, '_').trim() || 'hertz-studio';
      var a = document.createElement('a');
      var url = URL.createObjectURL(blob);
      a.href = url;
      a.download = name + '-' + preset.width + 'x' + preset.height + '.' + fmt.extension;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      teardown();
      if (resolveDone) resolveDone();
    };

    session = {
      recorder: recorder, video: video, out: out, streams: [srcStream, outStream],
      raf: 0, resolve: null
    };
    var finishPromise = new Promise(function (resolve) { session.resolve = resolve; });
    startLyricPoll();
    (function loop() {
      if (!session || session.recorder !== recorder) return;
      drawCover();
      drawLyrics();
      session.raf = requestAnimationFrame(loop);
    })();

    recording = true;
    var startedAt = Date.now();
    recorder.start(1000);
    showPill();
    if (dom && !dom.scrim.hidden) renderRecording(startedAt);
    return finishPromise;
  }

  function teardown() {
    recording = false;
    stopLyricPoll();
    hidePill();
    if (session) {
      var s = session;
      session = null;
      cleanupSession(s);
    }
    if (dom && !dom.scrim.hidden) renderIdle('');
  }

  function stop() {
    if (!recording || !session || !session.recorder) return;
    try { session.recorder.stop(); } catch (e) { teardown(); }
  }

  return { supported: supported, open: open, close: close, begin: begin, stop: stop, isRecording: function () { return recording; } };
})();
