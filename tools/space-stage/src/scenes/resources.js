// SPDX-License-Identifier: MIT
// Visible resources only: callers retain current/neighbor rows and covers.
// 池资源受原生 shared-assets 信封约束时，逐资源在装载前记账（§8.1 先取预算再解码）；
// 播放器页另外注入页面准入和有界解码端口，不用条目上限冒充像素预算。
import { layoutLyricText } from './text-layout.js';
import { createResourcePool, resourceKey } from '../resources/pool.js';
export function createSpatialResources(THREE, onInvalidate, resolveCover = url => url,
  ledger = (typeof window !== 'undefined' && window.HertzSharedAssets) || null, options = {}) {
  const pagePort = options.resources || null;
  if (pagePort && pagePort.contractVersion !== 1) throw new Error('resource-policy-required');
  const releaseTicket = ticket => ticket?.release({ apiReleased: true, allocationEnded: true });
  const pool = options.pool || createResourcePool({ contextId: options.contextId || 'legacy-spatial', maxEntries: 19 });
  let disposed = false, stamp = null, uploaded = false;
  let resourceFailure = '';
  const texts = new Map(), covers = new Map(), queue = [], leaseKinds = new WeakMap(), coverLoads = new Set();
  function canvas(w, h) {
    if (typeof document === 'undefined') return null;
    const el = document.createElement('canvas'); el.width = w; el.height = h; return el;
  }
  // The pool itself owns this discrimination: pool textures are never trackTree'd,
  // scopes release consumer leases explicitly instead.
  function own(texture) {
    return pool.markOwned(texture);
  }
  function remove(map, key, entry) {
    if (entry.cleaned) return;
    entry.cleaned = true;
    const pending = queue.indexOf(entry); if (pending >= 0) queue.splice(pending, 1);
    entry.cancel?.(); entry.texture?.dispose(); entry.texture = null;
    if (entry.canvas) entry.canvas.width = entry.canvas.height = 0;
    entry.canvas = entry.layout = null;
    releaseTicket(entry.textTicket); releaseTicket(entry.surfaceTicket);
    releaseTicket(entry.coverTicket); releaseTicket(entry.textureTicket);
    entry.textTicket = entry.surfaceTicket = null;
    entry.coverTicket = entry.textureTicket = null;
    if (entry.asset !== undefined) ledger.release(entry.asset);
    entry.asset = undefined;
    if (map.get(key) === entry) map.delete(key);
  }
  function trim(map, limit) {
    for (const [key, entry] of map) {
      if (map.size <= limit) break;
      remove(map, key, entry);
    }
  }
  function release(map, lease) {
    if (leaseKinds.get(lease) === map) pool.release(lease);
  }
  function retain(map, entry, signal) {
    const lease = pool.retain(entry, signal);
    if (lease) leaseKinds.set(lease, map);
    return lease;
  }
  function adopt(map, entry, adapterId, decodeOptions) {
    pool.adopt(resourceKey({ contentKey: entry.key, adapterId, adapterVersion: 1, decodeOptions }, options.contextId || 'legacy-spatial'),
      entry, () => remove(map, entry.key, entry));
    map.set(entry.key, entry);
    return entry;
  }
  function coverUnits() {
    let count = covers.size;
    for (const entry of coverLoads) if (covers.get(entry.key) !== entry) count++;
    return count;
  }
  function prepareText(entry) {
    try {
      if (pagePort && (!Number.isFinite(entry.maxWidth) || entry.maxWidth < 1 || entry.maxWidth > 1792
          || typeof entry.font !== 'string' || entry.font.length > 256)) throw new Error('text-layout-plan-unavailable');
      entry.textTicket = pagePort?.require({ canvases: 1, ownedCpuBytes: 240 * 4 },
        'Space text pool canvas identity and bounded original layout advance arrays', 0);
      entry.failed = false; entry.resourceFailure = ''; queue.push(entry);
    } catch (error) { entry.failed = true; entry.resourceFailure = resourceFailure = error.message; }
  }
  async function loadPageCover(entry) {
    const controller = new AbortController(); coverLoads.add(entry);
    entry.cancel = () => controller.abort();
    const alive = () => !disposed && !entry.retired && entry.consumers.size > 0 && covers.get(entry.key) === entry;
    let source = null, el = null, texture = null, accepted = false;
    try {
      if (typeof options.decodeImage !== 'function') throw new Error('estimate-unavailable');
      source = await options.decodeImage(entry.key, { resources: pagePort, signal: controller.signal, generation: 0 });
      if (!alive() || controller.signal.aborted) return;
      let mipPixels = 0;
      for (let edge = 768; ; edge = Math.max(1, Math.floor(edge / 2))) { mipPixels += edge * edge; if (edge === 1) break; }
      entry.coverTicket = pagePort.require({ canvases: 1, drawingBufferPixels: 768 * 768, ownedCpuBytes: 768 * 768 * 4 },
        'Space cover pool shared768 RGBA8 crop source', 0);
      entry.textureTicket = pagePort.require({ textureDeclaredBytes: mipPixels * 4 },
        'Space cover pool per-context RGBA8 complete768 mip chain upload', 0);
      el = canvas(768, 768); const ctx = el?.getContext('2d');
      if (!ctx) throw new Error('cover-surface-unavailable');
      const img = source.image, side = Math.min(img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 768, 768);
      entry.coverTicket.commit();
      texture = own(new THREE.CanvasTexture(el)); texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      const originalUpload = texture.onUpdate;
      texture.onUpdate = (...args) => {
        if (!entry.retired && entry.textureTicket) entry.textureTicket.commit();
        originalUpload?.(...args);
      };
      entry.canvas = el; entry.texture = texture; entry.failed = false; accepted = true;
      onInvalidate?.();
    } catch (error) {
      if (alive() && !controller.signal.aborted) {
        entry.failed = true; entry.resourceFailure = resourceFailure = error.message; onInvalidate?.();
      }
    } finally {
      try {
        if (!accepted) {
          texture?.dispose(); if (el) el.width = el.height = 0;
          releaseTicket(entry.coverTicket); releaseTicket(entry.textureTicket);
          entry.coverTicket = entry.textureTicket = null;
        }
      } finally {
        try { source?.release(); } finally { coverLoads.delete(entry); }
      }
    }
  }
  function loadCover(entry) {
    if (pagePort) { loadPageCover(entry).catch(error => { resourceFailure = error.message; }); return; }
    const controller = new AbortController(), img = new Image();
    let resolving = true, loading = false;
    coverLoads.add(entry);
    const alive = () => !disposed && !entry.retired && entry.consumers.size > 0 && covers.get(entry.key) === entry;
    const finish = () => { if (!resolving && !loading) coverLoads.delete(entry); };
    const fail = () => {
      loading = false;
      if (alive()) { entry.failed = true; onInvalidate?.(); }
      finish();
    };
    img.crossOrigin = 'anonymous'; img.decoding = 'async';
    entry.cancel = () => {
      controller.abort();
      img.onload = img.onerror = null; img.src = ''; loading = false;
      // A resolver that ignores abort still owns a bounded slot until it settles.
      finish();
    };
    img.onload = () => {
      loading = false;
      if (!alive()) { finish(); return; }
      const el = canvas(768, 768), ctx = el?.getContext('2d');
      if (!ctx) { fail(); return; }
      try {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 768, 768);
        entry.texture = own(new THREE.CanvasTexture(el)); entry.texture.colorSpace = THREE.SRGBColorSpace;
        entry.texture.minFilter = THREE.LinearMipmapLinearFilter;
        img.onload = img.onerror = null;
        onInvalidate?.();
      } catch { fail(); }
      finish();
    };
    img.onerror = fail;
    Promise.resolve().then(() => controller.signal.aborted ? null : resolveCover(entry.key, controller.signal)).then(url => {
      if (!alive()) return;
      if (url) { loading = true; img.src = url; } else fail();
    }).catch(fail).finally(() => { resolving = false; finish(); });
  }
  const text = {
    acquire(value, font = 'sans-serif', maxWidth = 1792) {
      if (disposed) return null;
      const line = String(value || '').slice(0, 120).replace(/[\uD800-\uDBFF]$/, ''), key = font + ':' + maxWidth + ':' + line;
      let entry = texts.get(key);
      if (!entry && texts.size < 7) {
        const asset = ledger?.admit('text');
        if (ledger && asset === null) return null;
        entry = adopt(texts, { key, line, font, maxWidth, texture: null, aspect: 8, asset: asset ?? undefined }, 'legacy-lyric-text', { font, maxWidth });
        // At most120 UTF16 units plus one row sentinel per unit.
        prepareText(entry);
      }
      if (!entry) return null;
      return retain(texts, entry);
    },
    release(lease) { if (lease) release(texts, lease); }
  };
  const cover = {
    acquire(url, signal) {
      if (!url || disposed || signal?.aborted) return null;
      const key = String(url); let entry = covers.get(key);
      if (!entry && coverUnits() < 12) {
        const asset = ledger?.admit('cover');
        if (ledger && asset === null) return null;
        entry = adopt(covers, { key, texture: null, failed: false, asset: asset ?? undefined }, 'legacy-cover768', { crop: 'square', size: 768 });
        if (typeof Image !== 'undefined') loadCover(entry);
      }
      if (!entry) return null;
      return retain(covers, entry, signal);
    },
    release(lease) { if (lease) release(covers, lease); }
  };
  return {
    text, cover,
    retryResources() {
      if (disposed) return;
      resourceFailure = '';
      for (const entry of texts.values()) if (entry.failed && entry.consumers.size && !entry.textTicket) prepareText(entry);
      for (const entry of covers.values()) if (entry.failed && entry.consumers.size && !coverLoads.has(entry)) {
        entry.failed = false; entry.resourceFailure = ''; loadCover(entry);
      }
      if (queue.length) onInvalidate?.();
    },
    beginFrame(now) {
      if (disposed) return;
      if (stamp !== now) { stamp = now; uploaded = false; }
      if (uploaded) return;
      while (queue.length) {
        const entry = queue.shift();
        if (!entry.consumers.size || texts.get(entry.key) !== entry) continue;
        let measureTicket = null, el = null;
        try {
          measureTicket = pagePort?.require({ drawingBufferPixels: 1, ownedCpuBytes: 4 },
            'Space text pool original one-pixel measurement surface', 0);
          el = canvas(1, 1); entry.canvas = el;
          const ctx = el?.getContext('2d'); if (!ctx) throw new Error('text-canvas-unavailable');
          measureTicket?.commit();
          entry.textTicket?.materialize({ canvases: 1 });
          const layout = layoutLyricText(ctx, entry.line, entry.font, entry.maxWidth);
          const arrayBytes = layout.rows.reduce((sum, row) => sum + row.advances.byteLength, 0);
          const pixels = layout.width * layout.height;
          entry.surfaceTicket = pagePort?.require({ drawingBufferPixels: pixels, ownedCpuBytes: pixels * 4,
            textureDeclaredBytes: pixels * 4 }, 'Space text pool measured CPU RGBA8 source and per-context no-mipmap upload', 0);
          el.width = layout.width; el.height = layout.height; ctx.font = layout.font;
          releaseTicket(measureTicket); measureTicket = null;
          entry.textTicket?.commit({ ownedCpuBytes: arrayBytes });
          entry.surfaceTicket?.materialize({ drawingBufferPixels: pixels, ownedCpuBytes: pixels * 4 });
          entry.layout = layout; entry.aspect = layout.width / layout.height;
          entry.start = layout.rows[0].left; entry.end = layout.rows[0].right;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff';
          layout.rows.forEach(row => ctx.fillText(entry.line.slice(row.start, row.end), layout.width / 2, row.baseline));
          entry.texture = own(new THREE.CanvasTexture(el)); entry.texture.generateMipmaps = false;
          entry.texture.minFilter = THREE.LinearFilter;
          // Three calls onUpdate only after this context's admitted upload.
          entry.texture.onUpdate = () => entry.surfaceTicket?.commit();
          resourceFailure = ''; uploaded = true; break;
        } catch (error) {
          entry.failed = true; entry.resourceFailure = resourceFailure = error.message;
          entry.texture?.dispose(); entry.texture = null;
          if (el) el.width = el.height = 0;
          entry.canvas = entry.layout = null;
          releaseTicket(entry.surfaceTicket); releaseTicket(entry.textTicket);
          entry.surfaceTicket = entry.textTicket = null;
          onInvalidate?.();
        } finally { releaseTicket(measureTicket); }
      }
      trim(texts, 7); trim(covers, 12);
      if (queue.length) onInvalidate?.();
    },
    stats() { return { textTextures: texts.size, coverTextures: covers.size, coverLoads: coverLoads.size, queued: queue.length,
      resourceFailure: [...texts.values(), ...covers.values()].find(entry => entry.failed && entry.resourceFailure)?.resourceFailure || '',
      bytes: [...texts.values()].reduce((sum, entry) => sum + (entry.layout ? entry.layout.width * entry.layout.height * 4 : 0), 0) + coverUnits() * 768 * 768 * 4 * 4 / 3 }; },
    dispose() {
      if (disposed) return; disposed = true;
      for (const map of [texts, covers]) for (const entry of [...map.values()]) {
        for (const consumer of [...entry.consumers]) consumer.lease.release();
      }
      queue.length = 0;
      if (!options.pool) pool.dispose();
    }
  };
}
