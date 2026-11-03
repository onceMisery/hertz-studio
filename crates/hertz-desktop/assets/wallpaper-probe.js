// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
(() => {
  'use strict';
  let current = null;
  let used = false;
  const error = (code) => Object.assign(new Error(code), { code });
  const post = (value) => window.ipc.postMessage(typeof value === 'string' ? value : JSON.stringify(value));

  function poster(media) {
    // One readback during preparation, never a playback frame loop or another decoder.
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 320 / Math.max(media.videoWidth, media.videoHeight));
    canvas.width = Math.max(1, Math.floor(media.videoWidth * scale));
    canvas.height = Math.max(1, Math.floor(media.videoHeight * scale));
    try {
      canvas.getContext('2d', {alpha:false}).drawImage(media, 0, 0, canvas.width, canvas.height);
      for (const quality of [.8, .6, .4, .2, .1]) {
        const data = canvas.toDataURL('image/jpeg', quality);
        if (data.startsWith('data:image/jpeg;base64,') && data.length <= 32791) return data.slice(23);
      }
    } catch (_) { /* Optional poster failure keeps the media and its verified decode result. */ }
    finally { canvas.width = canvas.height = 0; }
    return null;
  }

  function stop() {
    const state = current;
    if (!state) return;
    current = null;
    state.abort.abort(error('probe_inconclusive'));
    clearTimeout(state.timer);
    const media = state.media;
    if (state.frame !== null && media.cancelVideoFrameCallback) media.cancelVideoFrameCallback(state.frame);
    if (media.tagName === 'VIDEO') media.pause();
    media.removeAttribute('src');
    if (media.tagName === 'VIDEO') media.load();
    media.remove();
  }

  function event(state, name) {
    return new Promise((resolve, reject) => {
      const signal = state.abort.signal;
      const clean = () => {
        state.media.removeEventListener(name, done);
        signal.removeEventListener('abort', aborted);
      };
      const done = () => { clean(); resolve(); };
      const aborted = () => { clean(); reject(signal.reason); };
      if (signal.aborted) { reject(signal.reason); return; }
      state.media.addEventListener(name, done, { once: true });
      signal.addEventListener('abort', aborted, { once: true });
    });
  }

  function frame(state, target = null) {
    return new Promise((resolve, reject) => {
      const signal = state.abort.signal;
      const aborted = () => {
        if (state.frame !== null) state.media.cancelVideoFrameCallback(state.frame);
        state.frame = null;
        reject(signal.reason);
      };
      if (signal.aborted) { reject(signal.reason); return; }
      signal.addEventListener('abort', aborted, { once: true });
      const callback = (_, info) => {
        state.frame = null;
        // seek 前已排队的回调不能作为新目标的帧证据。
        if (target !== null && (state.media.seeking || info.mediaTime < target - state.tolerance || info.mediaTime > target + state.tolerance)) {
          state.frame = state.media.requestVideoFrameCallback(callback);
          return;
        }
        signal.removeEventListener('abort', aborted);
        if (!Number.isFinite(info.mediaTime) || !info.width || !info.height) reject(error('decode_failed'));
        else resolve(info.mediaTime);
      };
      state.frame = state.media.requestVideoFrameCallback(callback);
    });
  }

  async function run(config) {
    if (used) return;
    used = true;
    const media = document.createElement(config.kind === 'image' ? 'img' : 'video');
    const state = { media, abort: new AbortController(), timer: null, frame: null, tolerance: 0.1, stage: 'metadata', frames: [] };
    current = state;
    state.timer = setTimeout(() => state.abort.abort(error('probe_inconclusive')), 15000);
    media.addEventListener('error', () => state.abort.abort(error('decode_failed')), { signal: state.abort.signal });
    document.getElementById('media').append(media);
    let result;
    try {
      if (config.kind === 'image') {
        state.stage = 'image';
        media.src = config.url;
        // decode 会验证压缩像素，不能用 onload/图片头代替。
        await Promise.race([
          media.decode(),
          new Promise((_, reject) => state.abort.signal.addEventListener('abort', () => reject(state.abort.signal.reason), { once: true })),
        ]);
        if (!media.naturalWidth || !media.naturalHeight) throw error('decode_failed');
        if (media.naturalWidth !== config.metadata.displayWidth || media.naturalHeight !== config.metadata.displayHeight) throw error('decode_failed');
        result = { ok: true, code: '', stage: state.stage, frames: [], width: media.naturalWidth, height: media.naturalHeight };
      } else {
        if (!media.requestVideoFrameCallback) throw error('probe_inconclusive');
        if (!media.canPlayType(config.mime)) throw error('format_unsupported');
        media.muted = true;
        media.crossOrigin = 'anonymous';
        media.defaultMuted = true;
        media.volume = 0;
        media.playsInline = true;
        media.preload = 'auto';
        const metadata = event(state, 'loadedmetadata');
        media.src = config.url;
        await metadata;
        if (media.videoWidth !== config.metadata.displayWidth || media.videoHeight !== config.metadata.displayHeight) throw error('decode_failed');
        const duration = media.duration;
        const expected = config.metadata.durationMs / 1000;
        if (!Number.isFinite(duration) || duration <= 0 || !expected || Math.abs(duration - expected) > Math.max(0.25, expected * 0.01)) throw error('decode_failed');
        const fps = config.metadata.fpsUpperBound || config.metadata.sourceFps;
        state.tolerance = Math.max(0.1, 2 / fps);
        const play = () => media.play().catch((failure) => {
          throw error(failure.name === 'NotAllowedError' ? 'probe_inconclusive' : 'decode_failed');
        });
        state.stage = 'first_frame';
        const first = await Promise.all([frame(state), play()]);
        const frames = state.frames;
        let cover = null;
        frames.push(first[0]);
        media.pause();
        for (const target of [duration * 0.5, duration * 0.9]) {
          state.stage = frames.length === 1 ? 'middle_seek' : 'tail_seek';
          // 保持 play 与帧回调一起等待，目标附近必须有真实帧且完成 seek。
          const seeked = event(state, 'seeked');
          const arrived = frame(state, target);
          media.currentTime = target;
          const evidence = await Promise.all([arrived, seeked, play()]);
          frames.push(evidence[0]);
          media.pause();
          if (config.poster && frames.length === 2) cover = poster(media);
        }
        if (media.error) throw error('decode_failed');
        result = { ok: true, code: '', stage: state.stage, frames, width: media.videoWidth, height: media.videoHeight, poster: cover };
      }
    } catch (failure) {
      result = { ok: false, code: failure.code === 'format_unsupported' ? 'format_unsupported' : failure.code === 'probe_inconclusive' ? 'probe_inconclusive' : 'decode_failed', stage: state.stage, frames: state.frames, width: 0, height: 0 };
    }
    if (current !== state) return;
    stop();
    post(result);
  }

  window.hertzDecodeProbe = { run, stop };
  post('ready');
})();
