// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// HSCP1 framing only; CreativeStage remains the full-preset field owner.
(function () {
  'use strict';
  var MAX_BYTES = 128 * 1024, MAX_TEXT = 180000;
  function checksum(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (var bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
  }
  function base64url(bytes) {
    var text = '';
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unbase64url(text) {
    if (text.length > Math.ceil(MAX_BYTES * 4 / 3) || text.length % 4 === 1) throw new Error('分享码过大或编码无效');
    var raw;
    try { raw = atob(text.replace(/-/g, '+').replace(/_/g, '/')); }
    catch (e) { throw new Error('分享码的 base64url 编码无效'); }
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    if (bytes.length > MAX_BYTES || base64url(bytes) !== text) throw new Error('分享码过大或编码不完整');
    return bytes;
  }
  async function transform(bytes, Stream) {
    var work = StageJsonSource.reserve('creative-share-stream', bytes.length * 2 + MAX_BYTES * 3,
      'gzip Blob/input stream copies, bounded output buffer, current chunk and final typed bytes');
    var reader, pipe, buffer, out, blob, stream, total = 0, timer;
    var stopped = false, cancellation, controller = new AbortController();
    function stop() {
      if (stopped) return cancellation;
      stopped = true; controller.abort();
      if (reader) cancellation = reader.cancel().catch(function () {});
      return cancellation;
    }
    try {
    try {
      buffer = new Uint8Array(MAX_BYTES);
      blob = new Blob([bytes]); stream = new Stream('gzip');
      pipe = blob.stream().pipeTo(stream.writable, { signal: controller.signal }).catch(function (error) {
        if (!stopped) throw error;
      });
      // Observe pipe rejection immediately; cleanup still waits for settlement.
      pipe.catch(function () {});
      reader = stream.readable.getReader();
      timer = setTimeout(stop, 15000);
      while (true) {
        var part = await reader.read();
        if (stopped) throw new Error('分享码压缩处理超时');
        if (part.done) break;
        if (total + part.value.byteLength > MAX_BYTES) {
          await stop(); throw new Error('分享码解压后过大（最多 128 KiB）');
        }
        buffer.set(part.value, total); total += part.value.byteLength; part = null;
      }
      await pipe;
      out = buffer.slice(0, total);
    } finally {
      clearTimeout(timer);
      await stop();
      if (pipe) await pipe.catch(function () {});
      if (reader) reader.releaseLock();
      reader = pipe = buffer = blob = stream = part = null;
    }
    return work.finish(out, out.byteLength);
    } finally { out = null; work.release(); }
  }
  async function encodeLease(preset, options) {
    var full, text, byteWork, bytes, compressed, framed, work;
    try {
      full = preset === undefined ? CreativeStage.shareSnapshotLease({ includeProjectContext: true })
        : CreativeStage.normalizeShareLease(preset, { preserveProjectContext: true });
      text = StageJsonSource.stringify(full.value, { owner: 'creative-share-code', limit: MAX_BYTES,
        limitMessage: '创意预置过大（最多 128 KiB）' });
      var length = StageJsonSource.utf8Length(text.value);
      byteWork = StageJsonSource.reserve('creative-share-code', length, 'share UTF8 encoded typed bytes');
      bytes = byteWork.finish(new TextEncoder().encode(text.value), length);
      text.release(); text = null; full.release(); full = null;
      var mode = 'J';
      if (!(options && options.compress === false) && typeof window.CompressionStream === 'function') {
        try {
          compressed = await transform(bytes.value, window.CompressionStream);
          if (compressed.value.length < bytes.value.length) { bytes.release(); bytes = compressed; compressed = null; mode = 'G'; }
        } catch (error) {
          // Resource refusal is actionable, never a silent allocation fallback.
          if (error.resourceFailure) throw error;
          // J remains portable when the optional native compressor is unusable.
        }
        if (compressed) { compressed.release(); compressed = null; }
      }
      var base64Chars = Math.ceil(bytes.value.length / 3) * 4;
      work = StageJsonSource.reserve('creative-share-code', bytes.value.length * 4 + base64Chars * 10 + 64,
        'base64 binary text, replacement strings and complete HSCP1 frame');
      framed = 'HSCP1.' + mode + '.' + base64url(bytes.value) + '.' + checksum(bytes.value);
      return work.finish(framed, framed.length * 2);
    } finally {
      framed = null;
      if (work) work.release(); if (byteWork) byteWork.release();
      if (full) full.release(); if (text) text.release();
      if (bytes) bytes.release(); if (compressed) compressed.release();
    }
  }
  async function decodeLease(text) {
    if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error('分享码过大或不是文本');
    var work = StageJsonSource.reserve('creative-share-code', text.length * 24 + MAX_BYTES * 3 + 2048,
      'input/frame strings, base64 validation copies, UTF8 bytes and decoded text');
    var bytes, expanded, parsed, value;
    try {
      var pattern = /HSCP(\d+)\.([A-Z])\.([A-Za-z0-9_-]+)\.([a-fA-F0-9]{8})(?![A-Za-z0-9_-])/g;
      var frame = pattern.exec(text);
      if (!frame || pattern.exec(text)) throw new Error('请粘贴一份完整的创意舞台分享码');
      if (frame[1] !== '1') throw new Error('不支持这个分享码版本，请更新应用');
      if (frame[2] !== 'J' && frame[2] !== 'G') throw new Error('不支持这个分享码格式');
      bytes = unbase64url(frame[3]);
      if (checksum(bytes) !== frame[4].toLowerCase()) throw new Error('分享码校验失败，请重新复制完整内容');
      if (frame[2] === 'G') {
        if (typeof window.DecompressionStream !== 'function') throw new Error('当前环境不支持 gzip，请对方生成兼容码（不压缩）');
        try { expanded = await transform(bytes, window.DecompressionStream); bytes = expanded.value; }
        catch (error) {
          if (error.resourceFailure || /过大|超时/.test(error.message)) throw error;
          throw new Error('分享码的 gzip 数据损坏或当前环境不支持解压', { cause: error });
        }
      }
      try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (error) { throw new Error('分享码中的 UTF-8 / JSON 数据无效', { cause: error }); }
      try { parsed = StageJsonSource.parse(value, { owner: 'creative-share-code', limit: MAX_BYTES }); }
      catch (error) {
        if (error.resourceFailure) throw error;
        throw new Error('分享码中的 UTF-8 / JSON 数据无效', { cause: error });
      }
      return CreativeStage.normalizeShareLease(parsed.value, { preserveProjectContext: true });
    } finally {
      bytes = value = frame = text = null;
      if (expanded) expanded.release(); if (parsed) parsed.release(); work.release();
    }
  }
  window.CreativeShareCode = {
    encodeLease: encodeLease, decodeLease: decodeLease,
    encode: async function (preset, options) { return StageJsonSource.transfer(await encodeLease(preset, options)); },
    decode: async function (text) { return StageJsonSource.transfer(await decodeLease(text)); }
  };
})();
