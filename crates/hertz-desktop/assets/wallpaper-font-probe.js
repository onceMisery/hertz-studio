// SPDX-License-Identifier: MIT
// Typed font adapter in the original single-slot ProbeHost.
(() => {
  'use strict';
  let current = null, used = false;
  const fail = code => Object.assign(new Error(code), { code });
  const post = value => window.ipc.postMessage(JSON.stringify(value));
  function cleanup(state) {
    if (state.font) document.fonts.delete(state.font);
    if (state.canvas) { state.canvas.width = state.canvas.height = 0; state.canvas.remove(); }
  }
  function stop() {
    if (!current) return;
    current.cancelled = true;
    // Retain the Face until its non-cancellable load settles. Native retains
    // the reservation and prepares no next job until this receipt plus Close/Drain.
    if (current.settled) cleanup(current);
  }
  async function run(config) {
    if (used) return;
    used = true;
    const state = { font: null, canvas: null, cancelled: false, settled: false };
    current = state;
    let result = { kind: 'font', ok: false, code: 'probe_inconclusive', settled: true,
      fontStatus: 'error', alphaPixels: 0, width: 256, height: 128 };
    try {
      if (config.kind !== 'font' || typeof FontFace !== 'function' || !document.fonts
          || typeof config.url !== 'string' || !/^https:\/\/[0-9a-f]{32}\.[0-9a-f]{32}\.wallpaper\.invalid\/files\//.test(config.url)
          || !Number.isSafeInteger(config.metadata.sfntBytes) || config.metadata.sfntBytes < 1
          || config.metadata.sfntBytes > 16 * 1024 * 1024
          || typeof config.metadata.probeText !== 'string' || !config.metadata.probeText.length
          || config.metadata.probeText.length > 64) throw fail('font_format_not_prepared');
      state.font = new FontFace('HertzProbe', 'url(' + JSON.stringify(config.url) + ')');
      try { await state.font.load(); } catch (_) { throw fail('font_decode_failed'); }
      if (state.cancelled) throw fail('probe_inconclusive');
      if (state.font.status !== 'loaded') throw fail('font_decode_failed');
      document.fonts.add(state.font);
      state.canvas = document.createElement('canvas');
      state.canvas.width = 256; state.canvas.height = 128;
      document.getElementById('media').append(state.canvas);
      const ctx = state.canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw fail('probe_inconclusive');
      ctx.font = '32px "HertzProbe"'; ctx.fillStyle = '#fff';
      ctx.fillText(config.metadata.probeText, 8, 64);
      const pixels = ctx.getImageData(0, 0, 256, 128).data;
      let alphaPixels = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) alphaPixels++;
      if (!alphaPixels || !document.fonts.check(ctx.font, config.metadata.probeText)) throw fail('font_decode_failed');
      result = { ...result, ok: true, code: '', fontStatus: state.font.status, alphaPixels };
    } catch (error) { result.code = error.code || 'probe_inconclusive'; }
    finally {
      state.settled = true;
      cleanup(state);
      if (state.cancelled) { result.ok = false; result.code = 'probe_inconclusive'; }
      current = null;
      post(result);
    }
  }
  window.hertzDecodeProbe = { run, stop };
  window.ipc.postMessage('ready');
})();
