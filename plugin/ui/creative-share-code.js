// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// HSCP1 is a full CreativeStage preset. This module owns framing only; the
// existing preset owner validates fields. CRC32 detects corruption, not authorship.
(function () {
  'use strict';
  var MAX_BYTES = 128 * 1024;
  var MAX_TEXT = 180000;

  function checksum(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i += 1) {
      crc ^= bytes[i];
      for (var bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
  }

  function base64url(bytes) {
    var text = '';
    for (var i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function unbase64url(text) {
    if (text.length > Math.ceil(MAX_BYTES * 4 / 3) || text.length % 4 === 1) throw new Error('分享码过大或编码无效');
    var raw;
    try { raw = atob(text.replace(/-/g, '+').replace(/_/g, '/')); }
    catch (e) { throw new Error('分享码的 base64url 编码无效'); }
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    if (bytes.length > MAX_BYTES || base64url(bytes) !== text) throw new Error('分享码过大或编码不完整');
    return bytes;
  }

  async function transform(bytes, Stream) {
    var reader = new Blob([bytes]).stream().pipeThrough(new Stream('gzip')).getReader();
    var chunks = [], total = 0;
    try {
      while (true) {
        var part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel().catch(function () {});
          throw new Error('分享码解压后过大（最多 128 KiB）');
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    var out = new Uint8Array(total), at = 0;
    chunks.forEach(function (chunk) { out.set(chunk, at); at += chunk.byteLength; });
    return out;
  }

  async function encode(preset, options) {
    var full = preset === undefined ? CreativeStage.shareSnapshot() : CreativeStage.normalizeSharePreset(preset);
    var bytes = new TextEncoder().encode(JSON.stringify(full));
    if (bytes.length > MAX_BYTES) throw new Error('创意预置过大（最多 128 KiB）');
    var mode = 'J';
    // Compression and decompression are independent capabilities. J remains
    // available explicitly even on a host that can emit G but cannot read it.
    if (!(options && options.compress === false) && typeof window.CompressionStream === 'function') {
      try {
        var compressed = await transform(bytes, window.CompressionStream);
        if (compressed.length < bytes.length) { bytes = compressed; mode = 'G'; }
      } catch (e) { /* J is the portable baseline if compression is unavailable. */ }
    }
    return 'HSCP1.' + mode + '.' + base64url(bytes) + '.' + checksum(bytes);
  }

  async function decode(text) {
    if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error('分享码过大或不是文本');
    var matches = Array.from(text.matchAll(/HSCP(\d+)\.([A-Z])\.([A-Za-z0-9_-]+)\.([a-fA-F0-9]{8})(?![A-Za-z0-9_-])/g));
    if (matches.length !== 1) throw new Error('请粘贴一份完整的创意舞台分享码');
    var frame = matches[0];
    if (frame[1] !== '1') throw new Error('不支持这个分享码版本，请更新应用');
    if (frame[2] !== 'J' && frame[2] !== 'G') throw new Error('不支持这个分享码格式');
    var bytes = unbase64url(frame[3]);
    if (checksum(bytes) !== frame[4].toLowerCase()) throw new Error('分享码校验失败，请重新复制完整内容');
    if (frame[2] === 'G') {
      if (typeof window.DecompressionStream !== 'function') throw new Error('当前环境不支持 gzip，请对方生成兼容码（不压缩）');
      try { bytes = await transform(bytes, window.DecompressionStream); }
      catch (e) {
        if (/过大/.test(e.message)) throw e;
        throw new Error('分享码的 gzip 数据损坏或当前环境不支持解压');
      }
    }
    var value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch (e) { throw new Error('分享码中的 UTF-8 / JSON 数据无效'); }
    return CreativeStage.normalizeSharePreset(value);
  }

  window.CreativeShareCode = { encode: encode, decode: decode };
})();
