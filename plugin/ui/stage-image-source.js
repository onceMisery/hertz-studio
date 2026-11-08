// SPDX-License-Identifier: MIT
// Bounded raster preparation for the original image consumers. No scheduler or image cache.
(function (global) {
  'use strict';
  function dimensions(bytes) {
    var n = bytes.length;
    function at(i) { return i >= 0 && i < n ? bytes[i] : undefined; }
    function match(i, value) {
      for (var j = 0; j < value.length; j++) if (at(i + j) !== value.charCodeAt(j)) return false;
      return true;
    }
    function le(i, count) {
      if (i + count > n) throw new Error('estimate-unavailable');
      var result = 0; for (var j = count - 1; j >= 0; j--) result = result * 256 + at(i + j); return result;
    }
    function be(i, count) {
      if (i + count > n) throw new Error('estimate-unavailable');
      var result = 0; for (var j = 0; j < count; j++) result = result * 256 + at(i + j); return result;
    }
    var width = 0, height = 0, frames = 1, i;
    if (n >= 33 && at(0) === 137 && match(1, 'PNG\r\n\x1a\n') && match(12, 'IHDR')) {
      width = be(16, 4); height = be(20, 4);
      for (i = 8; i + 12 <= n;) {
        var length = be(i, 4);
        if (i + length + 12 > n) throw new Error('estimate-unavailable');
        if (match(i + 4, 'acTL')) { if (length !== 8) throw new Error('estimate-unavailable'); frames = be(i + 8, 4); }
        if (match(i + 4, 'IDAT')) break;
        i += length + 12;
      }
    } else if (n >= 10 && (match(0, 'GIF87a') || match(0, 'GIF89a'))) {
      width = le(6, 2); height = le(8, 2); frames = 0;
      i = 13 + (at(10) & 128 ? 3 * Math.pow(2, (at(10) & 7) + 1) : 0);
      function blocks() {
        while (i < n) { var count = at(i++); if (!count) return; i += count; }
        throw new Error('estimate-unavailable');
      }
      while (i < n) {
        var tag = at(i++);
        if (tag === 59) break;
        if (tag === 33) { i++; blocks(); }
        else if (tag === 44) {
          if (i + 9 > n || le(i, 2) + le(i + 4, 2) > width || le(i + 2, 2) + le(i + 6, 2) > height)
            throw new Error('estimate-unavailable');
          var packed = at(i + 8); i += 9;
          if (packed & 128) i += 3 * Math.pow(2, (packed & 7) + 1);
          i++; blocks(); frames++;
        } else throw new Error('estimate-unavailable');
      }
    } else if (n >= 30 && match(0, 'RIFF') && match(8, 'WEBP')) {
      if (match(12, 'VP8X')) { width = 1 + le(24, 3); height = 1 + le(27, 3); }
      else if (match(12, 'VP8 ') && at(23) === 157 && at(24) === 1 && at(25) === 42) {
        width = le(26, 2) & 16383; height = le(28, 2) & 16383;
      } else if (match(12, 'VP8L') && at(20) === 47) {
        var bits = le(21, 4); width = 1 + (bits & 16383); height = 1 + ((bits >>> 14) & 16383);
      } else throw new Error('estimate-unavailable');
      if (match(12, 'VP8X') && (at(20) & 2)) {
        frames = 0;
        for (i = 12; i + 8 <= n;) {
          var size = le(i + 4, 4);
          if (i + size + 8 > n) throw new Error('estimate-unavailable');
          if (match(i, 'ANMF')) frames++;
          i += 8 + size + (size & 1);
        }
      }
    } else if (at(0) === 255 && at(1) === 216) {
      i = 2;
      while (i + 4 <= n) {
        if (at(i++) !== 255) throw new Error('estimate-unavailable');
        while (at(i) === 255) i++;
        var marker = at(i++);
        if (marker === 217 || marker === 218) break;
        if (marker === 216 || (marker >= 208 && marker <= 215) || marker === 1) continue;
        var segment = be(i, 2);
        if (segment < 2 || i + segment > n) throw new Error('estimate-unavailable');
        if ((marker >= 192 && marker <= 195) || (marker >= 197 && marker <= 199)
          || (marker >= 201 && marker <= 203) || (marker >= 205 && marker <= 207)) {
          if (segment < 8) throw new Error('estimate-unavailable');
          height = be(i + 3, 2); width = be(i + 5, 2); break;
        }
        i += segment;
      }
    } else throw new Error('estimate-unavailable');
    var pixels = width * height, workBytes = pixels * 4 * (frames + 2);
    if (!width || !height || !frames || !Number.isSafeInteger(workBytes) || workBytes <= 0)
      throw new Error('estimate-unavailable');
    return Object.freeze({ width: width, height: height, frames: frames, pixels: pixels, workBytes: workBytes });
  }
  function aborted() { var error = new Error('image preparation canceled'); error.name = 'AbortError'; return error; }
  async function decode(url, options) {
    options = options || {};
    var port = options.resources, signal = options.signal, generation = options.generation || 0;
    if (!port || port.contractVersion !== 1) throw new Error('resource-policy-required');
    var sourceTicket = null, decoderTicket = null, source = '', objectUrl = '', image = null, transferred = false;
    var parts = null, bytes = null, reader = null;
    function current() { if (signal && signal.aborted) throw aborted(); }
    function releaseTicket(ticket) { if (ticket) ticket.release({ apiReleased: true, allocationEnded: true }); }
    function cancel() {
      if (sourceTicket) sourceTicket.cancel(); if (decoderTicket) decoderTicket.cancel();
      if (image) image.removeAttribute('src');
    }
    function release() {
      if (image) { image.onload = image.onerror = null; image.removeAttribute('src'); }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      image = null; source = objectUrl = ''; parts = bytes = null;
      releaseTicket(decoderTicket); releaseTicket(sourceTicket); decoderTicket = sourceTicket = null;
    }
    if (signal) signal.addEventListener('abort', cancel);
    try {
      current(); source = options.resolve ? await options.resolve(url) : url; current();
      if (typeof source !== 'string' || !source) throw new Error('estimate-unavailable');
      if (/^data:/i.test(source)) {
        sourceTicket = port.require({ ownedCpuBytes: source.length * 2 }, 'retained UTF16 encoded raster source handoff', generation);
        var comma = source.indexOf(','), prefix = source.slice(0, comma);
        if (comma < 0 || !/^data:image\/(png|jpe?g|gif|webp);base64$/i.test(prefix)) throw new Error('estimate-unavailable');
        var base64Length = source.length - comma - 1;
        if (!base64Length || base64Length % 4) throw new Error('estimate-unavailable');
        var padding = source.endsWith('==') ? 2 : source.endsWith('=') ? 1 : 0;
        // A sparse byte view reads encoded headers without allocating a full atob copy.
        var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        var byteLength = base64Length / 4 * 3 - padding;
        bytes = new Proxy({ length: byteLength }, { get: function (target, key) {
          if (key === 'length') return byteLength;
          var at = Number(key); if (!Number.isInteger(at) || at < 0 || at >= byteLength) return undefined;
          var offset = comma + 1 + Math.floor(at / 3) * 4, group = 0;
          for (var j = 0; j < 4; j++) {
            var char = source.charAt(offset + j), value = char === '=' ? 0 : alphabet.indexOf(char);
            if (value < 0) throw new Error('estimate-unavailable'); group = group * 64 + value;
          }
          return (group >>> (16 - (at % 3) * 8)) & 255;
        } });
        sourceTicket.commit();
      } else {
        var response = await fetch(source, { signal: signal, credentials: 'same-origin' }); current();
        if (!response.ok || !response.body) throw new Error('封面来源读取失败');
        reader = response.body.getReader();
        var declared = Number(response.headers.get('content-length'));
        var maximum = options.maxEncodedBytes || 6 * 1024 * 1024;
        if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error('estimate-unavailable');
        var limit = Number.isSafeInteger(declared) && declared > 0 ? Math.min(declared, maximum) : maximum;
        if (declared > maximum) throw new Error('aggregate-budget');
        sourceTicket = port.require({ ownedCpuBytes: limit * 3 },
          'bounded HTTP encoded parts, contiguous header view and Blob source coexistence', generation, 'bounded-estimate');
        parts = []; var total = 0;
        while (true) {
          var part = await reader.read(); current(); if (part.done) break;
          total += part.value.byteLength;
          if (total > limit) {
            sourceTicket.materialize({ ownedCpuBytes: total });
            throw new Error('encoded raster exceeds declared source plan');
          }
          parts.push(part.value);
        }
        bytes = new Uint8Array(total); var offset = 0;
        parts.forEach(function (part) { bytes.set(part, offset); offset += part.length; });
        var blob = new Blob(parts, { type: response.headers.get('content-type') || 'application/octet-stream' });
        objectUrl = URL.createObjectURL(blob); source = objectUrl;
        sourceTicket.commit({ ownedCpuBytes: total * 3 });
      }
      var plan = dimensions(bytes); current();
      decoderTicket = port.require({ decoderLeases: 1, decodeReservedBytes: plan.workBytes },
        'validated raster header frames plus two RGBA decode work surfaces; browser workspace candidate estimate', generation, 'bounded-estimate');
      image = new Image(); image.crossOrigin = 'anonymous';
      var ready;
      if (!image.decode) ready = new Promise(function (resolve, reject) {
        image.onload = resolve; image.onerror = function () { reject(new Error('封面解码失败')); };
      });
      image.src = source;
      await (image.decode ? image.decode() : ready); current();
      var pixels = image.naturalWidth * image.naturalHeight;
      var committed = decoderTicket.commit({ decoderLeases: 1, decodeReservedBytes: pixels * 4 * (plan.frames + 2) });
      if (!pixels || !committed.ok) throw new Error('decoded raster exceeds declared pixel plan');
      transferred = true; var released = false;
      return Object.freeze({ image: image, plan: plan, release: function () { if (released) return; released = true; release(); } });
    } finally {
      if (signal) signal.removeEventListener('abort', cancel);
      try {
        if (reader) { try { await reader.cancel(); } catch (_) {} reader.releaseLock(); }
      } finally { if (!transferred) release(); }
    }
  }
  global.StageImageSource = Object.freeze({ dimensions: dimensions, decode: decode });
})(window);
