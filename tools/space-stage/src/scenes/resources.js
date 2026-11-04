// SPDX-License-Identifier: MIT
// Visible resources only: callers retain current/neighbor rows and covers.
// 池资源受原生 shared-assets 信封约束时，逐资源在装载前记账（§8.1 先取预算再解码）；
// 没有原生信封的宿主（播放器页）沿用池自身条目上限。
import { layoutLyricText } from './text-layout.js';
export function createSpatialResources(THREE, onInvalidate, resolveCover = url => url,
  ledger = (typeof window !== 'undefined' && window.HertzSharedAssets) || null) {
  let disposed = false, stamp = null, uploaded = false;
  const texts = new Map(), covers = new Map(), queue = [], leases = new WeakMap(), coverLoads = new Set();
  function canvas(w, h) {
    if (typeof document === 'undefined') return null;
    const el = document.createElement('canvas'); el.width = w; el.height = h; return el;
  }
  // The pool itself owns this discrimination: pool textures are never trackTree'd,
  // scopes release consumer leases explicitly instead.
  function own(texture) {
    Object.defineProperty(texture, 'poolOwned', { value: true });
    return texture;
  }
  function remove(map, key, entry) {
    if (entry.consumers.size || entry.retired) return;
    entry.retired = true;
    const pending = queue.indexOf(entry); if (pending >= 0) queue.splice(pending, 1);
    entry.cancel?.(); entry.texture?.dispose(); entry.texture = null;
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
    const consumer = leases.get(lease);
    if (!consumer || !consumer.active || consumer.map !== map) return;
    consumer.active = false;
    consumer.signal?.removeEventListener('abort', consumer.abort);
    const entry = consumer.entry;
    entry.consumers.delete(consumer);
    remove(map, entry.key, entry);
  }
  function retain(map, entry, signal) {
    const consumer = {map, entry, signal, active: true, abort: null};
    const lease = {};
    // Consumers observe one shared result but cannot spend another consumer's lease.
    for (const field of ['key', 'line', 'font', 'maxWidth', 'aspect', 'layout', 'start', 'end', 'failed']) {
      Object.defineProperty(lease, field, {enumerable: true, get: () => entry[field]});
    }
    Object.defineProperty(lease, 'texture', {enumerable: true, get: () => consumer.active ? entry.texture : null});
    consumer.abort = () => release(map, lease);
    leases.set(lease, consumer);
    entry.consumers.add(consumer);
    signal?.addEventListener('abort', consumer.abort, {once: true});
    return Object.freeze(lease);
  }
  function coverUnits() {
    let count = covers.size;
    for (const entry of coverLoads) if (covers.get(entry.key) !== entry) count++;
    return count;
  }
  function loadCover(entry) {
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
        entry = { key, line, font, maxWidth, consumers: new Set(), texture: null, aspect: 8, asset: asset ?? undefined };
        texts.set(key, entry); queue.push(entry);
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
        entry = { key, consumers: new Set(), texture: null, failed: false, asset: asset ?? undefined }; covers.set(key, entry);
        if (typeof Image !== 'undefined') loadCover(entry);
      }
      if (!entry) return null;
      return retain(covers, entry, signal);
    },
    release(lease) { if (lease) release(covers, lease); }
  };
  return {
    text, cover,
    beginFrame(now) {
      if (disposed) return;
      if (stamp !== now) { stamp = now; uploaded = false; }
      if (uploaded) return;
      while (queue.length) {
        const entry = queue.shift();
        if (!entry.consumers.size || texts.get(entry.key) !== entry) continue;
        const el = canvas(1, 1), ctx = el?.getContext('2d');
        if (!ctx) break;
        const layout = layoutLyricText(ctx, entry.line, entry.font, entry.maxWidth);
        el.width = layout.width; el.height = layout.height; ctx.font = layout.font;
        entry.layout = layout; entry.aspect = layout.width / layout.height;
        entry.start = layout.rows[0].left; entry.end = layout.rows[0].right;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff';
        layout.rows.forEach(row => ctx.fillText(entry.line.slice(row.start, row.end), layout.width / 2, row.baseline));
        entry.texture = own(new THREE.CanvasTexture(el)); entry.texture.generateMipmaps = false;
        entry.texture.minFilter = THREE.LinearFilter; uploaded = true; break;
      }
      trim(texts, 7); trim(covers, 12);
      if (queue.length) onInvalidate?.();
    },
    stats() { return { textTextures: texts.size, coverTextures: covers.size, coverLoads: coverLoads.size, queued: queue.length,
      bytes: [...texts.values()].reduce((sum, entry) => sum + (entry.layout ? entry.layout.width * entry.layout.height * 4 : 0), 0) + coverUnits() * 768 * 768 * 4 * 4 / 3 }; },
    dispose() {
      if (disposed) return; disposed = true;
      for (const map of [texts, covers]) for (const entry of [...map.values()]) {
        for (const consumer of entry.consumers) {
          consumer.active = false; consumer.signal?.removeEventListener('abort', consumer.abort);
        }
        entry.consumers.clear(); remove(map, entry.key, entry);
      }
      queue.length = 0;
    }
  };
}
