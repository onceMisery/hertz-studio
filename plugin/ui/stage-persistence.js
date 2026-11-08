// SPDX-License-Identifier: MIT
// Server authority, separate CAS revisions and one coalescing save queue per target.
(function () {
  'use strict';
  var hydrated = false, state = null, disposed = false, resources = null, snapshotSource = null;
  var snapshotSources = new WeakMap(), activeReads = new Set(), queuedRead = null, sequence = 0;
  // Existing store limits: current <=512 KiB, library <=4 MiB; bounded state/receipt margin.
  // Logical JSON data (8-byte values/slots, UTF16 strings) and wire work are declared
  // separately from JS engine object headers/GC, which remain process observations.
  var SNAPSHOT_BYTES = 4 * 1024 * 1024 + 512 * 1024 + 64 * 1024;
  function port() {
    if (disposed) throw new Error('舞台设置已关闭');
    if (!resources) {
      var ledger = window.Stage && Stage.resources && Stage.resources();
      if (!ledger) throw new Error('resource-policy-required');
      resources = ledger.port('stage-persistence');
    }
    return resources;
  }
  function releaseTicket(ticket) { if (ticket) ticket.release({ apiReleased: true, allocationEnded: true }); }
  function measure(value) { return StageJsonSource.measure(value); }
  function representation(value, ticket, bytes) { return StageJsonSource.representation(value, ticket, bytes, port()); }
  function copy(value) { return StageJsonSource.clone(value, { resources: port(), generation: ++sequence }); }
  var targets = { current: slot(), library: slot() };
  function slot() { return { revision: 0, pending: undefined, running: null, error: null, refused: false }; }
  function api() { if (!window.VMusicTransport) throw new Error('服务连接尚未就绪'); return VMusicTransport; }
  function event() { document.dispatchEvent(new CustomEvent('stage-persistence:change', { detail: status() })); }
  function status() {
    return { hydrated: hydrated, current: info(targets.current), library: info(targets.library) };
  }
  function info(s) { return { saving: !!s.running, dirty: s.pending !== undefined || s.refused,
    error: s.error && s.error.message, refused: s.refused, revision: s.revision }; }
  function sanitize(value) {
    var source = copy(value), out = source.value, removed = false;
    function clean(p) {
      var bg = p && p.bg; if (!bg) return;
      if (bg.type === 'media' && !bg.assetRef) { p.bg = { type: 'theme' }; removed = true; return; }
      ['url','name','path','token','file','blob','lease'].forEach(function (key) { if (key in bg) { delete bg[key]; removed = true; } });
    }
    if (Array.isArray(out)) out.forEach(clean); else clean(out);
    return { value: out, removed: removed, source: source, release: source.release };
  }
  function adopt(snapshot, source) {
    var previous = snapshotSource;
    snapshotSource = source;
    state = snapshot.state;
    ['current','library'].forEach(function (key) { targets[key].revision = state[key] && state[key].revision || 0; });
    if (previous && previous !== source) previous.release();
  }
  async function readSnapshot() {
    if (disposed) throw new Error('舞台设置已关闭');
    if (activeReads.size) {
      // One unresolved read plus the latest queued demand. Replaced controllers
      // lose interest without releasing the original transport's authority.
      if (queuedRead) queuedRead.reject(new DOMException('Read replaced', 'AbortError'));
      return new Promise(function (resolve, reject) { queuedRead = { resolve: resolve, reject: reject }; });
    }
    var p = port(), ticket = p.require({ ownedCpuBytes: SNAPSHOT_BYTES * 16 },
      'store-bounded snapshot wire parts/text/parse and declared logical JSON data; JS heap overhead observed separately', ++sequence, 'bounded-estimate');
    var controller = new AbortController(), operation = { ticket: ticket, controller: controller };
    activeReads.add(operation);
    var snapshot = null;
    try {
      snapshot = await api().get('/v1/stage/presets', { signal: controller.signal, waitForSettlement: true,
        jsonBudget: { ticket: ticket, maxBytes: SNAPSHOT_BYTES } });
      if (disposed || controller.signal.aborted) throw new Error('舞台设置读取已取消');
      var plan = measure(snapshot), result = ticket.commit({ ownedCpuBytes: plan.bytes + 64 });
      if (!result.ok) throw new Error(result.reason);
      var source = representation(snapshot, ticket, plan.bytes + 64); snapshotSources.set(snapshot, source);
      ticket = null; return { snapshot: snapshot, source: source };
    } finally {
      snapshot = null; activeReads.delete(operation); releaseTicket(ticket);
      var queued = queuedRead; queuedRead = null;
      if (queued) Promise.resolve().then(readSnapshot).then(queued.resolve, queued.reject);
    }
  }
  async function load(legacyCurrent, legacyLibrary) {
    var read = await readSnapshot(), snapshot = read.snapshot;
    adopt(snapshot, read.source); hydrated = true;
    var removed = !!state.legacyMediaRemoved;
    for (var key of ['current','library']) {
      var legacy = key === 'current' ? legacyCurrent : legacyLibrary;
      if (!(state[key] && state[key].initialized) && legacy != null) {
        var clean = sanitize(legacy); removed = removed || clean.removed;
        try { await save(key, clean.value); }
        catch (e) { targets[key].error = e; event(); throw e; }
        finally { clean.release(); }
        // Reload the committed representation; a sanitized temporary must not be
        // assigned into another source's lifetime and then released underneath it.
        read = await readSnapshot(); snapshot = read.snapshot; adopt(snapshot, read.source);
      }
    }
    snapshot.legacyMediaRemoved = removed;
    event(); return snapshot;
  }
  function save(key, payload) {
    var s = targets[key];
    if (!s) return Promise.reject(new Error('未知保存目标'));
    var clean;
    try { clean = sanitize(payload); }
    catch (error) { s.error = error; s.refused = true; event(); return Promise.reject(error); }
    var previous = s.pending; s.pending = clean.source;
    s.refused = false;
    if (previous) previous.release();
    if (!hydrated) { event(); return Promise.reject(new Error('舞台设置尚未读取，修改暂未保存')); }
    if (s.error) { event(); return Promise.reject(s.error); }
    if (!s.running) {
      s.running = drain(key).finally(function () { s.running = null; event(); });
    }
    event(); return s.running;
  }
  async function drain(key) {
    var s = targets[key];
    while (s.pending !== undefined) {
      var source = s.pending; s.pending = undefined;
      var request = null;
      var receipt;
      var wire = null, recovery = null, scratch = null, dispatched = false;
      try {
        scratch = port().require({ ownedCpuBytes: 2048 }, 'CAS request/traversal fixed workspace', ++sequence, 'bounded-estimate');
        request = { target: key, requestId: StageMedia.uid(), expectedPresetRevision: s.revision, payload: source.value };
        var plan = measure(request);
        wire = port().require({ ownedCpuBytes: plan.chars * 8 + plan.bytes + 64 * 1024 },
          'CAS outgoing UTF16/UTF8/DBX JSON copies plus bounded response work', ++sequence, 'bounded-estimate');
        dispatched = true;
        receipt = await api().put('/v1/stage/presets', request, { waitForSettlement: true,
          jsonBudget: { ticket: wire, maxBytes: 4096 } });
      }
      catch (e) {
        releaseTicket(wire); wire = null;
        // A failed response may have committed. Read its receipt before deciding what failed;
        // never blindly repeat a write or overwrite a competing revision.
        try {
          if (dispatched) {
            recovery = await readSnapshot(); var snapshot = recovery.snapshot;
            var commit = snapshot.state[key] && snapshot.state[key].lastCommit;
            if (commit && commit.requestId === request.requestId) receipt = commit;
          }
        } catch (_) { /* preserve the edit and original failure */ }
        if (!receipt) {
          if (!disposed && s.pending === undefined) { s.pending = source; source = null; }
          s.error = e; event(); throw e;
        }
      }
      finally {
        request = null; releaseTicket(wire); releaseTicket(scratch);
        if (recovery) recovery.source.release();
        if (source) source.release();
      }
      if (disposed) return;
      s.revision = receipt.revision;
    }
  }
  async function retry() {
    await Promise.all(Object.keys(targets).map(function (key) { return targets[key].running && targets[key].running.catch(function () {}); }));
    if (targets.current.refused || targets.library.refused)
      throw new Error('最新修改未进入保存队列，请用当前修改重试');
    var read = await readSnapshot(); adopt(read.snapshot, read.source); hydrated = true;
    for (var key of ['current','library']) {
      var s = targets[key]; s.error = null;
      if (s.pending !== undefined) {
        s.running = drain(key).finally(function () { s.running = null; event(); }); await s.running;
      }
    }
    event();
  }
  async function reload() {
    await Promise.all(Object.keys(targets).map(function (key) { return targets[key].running && targets[key].running.catch(function () {}); }));
    var read = await readSnapshot(), snapshot = read.snapshot;
    Object.keys(targets).forEach(function (key) { if (targets[key].pending) targets[key].pending.release(); });
    targets = { current: slot(), library: slot() }; adopt(snapshot, read.source); hydrated = true; event(); return snapshot;
  }
  function hold(message) { targets.current.error = new Error(message); event(); }
  function flush(key) {
    var s = targets[key];
    if (s.error) return Promise.reject(s.error);
    if (s.running) return s.running;
    if (s.pending !== undefined) {
      s.running = drain(key).finally(function () { s.running = null; event(); }); return s.running;
    }
    return Promise.resolve();
  }
  function borrowSnapshot(snapshot) {
    var source = snapshotSources.get(snapshot); if (!source) throw new Error('resource-unavailable');
    return source.borrow();
  }
  function destroy() {
    if (disposed) return; disposed = true; hydrated = false; state = null;
    Object.keys(targets).forEach(function (key) {
      var s = targets[key]; if (s.pending) s.pending.release(); s.pending = undefined;
    });
    activeReads.forEach(function (op) { op.ticket.cancel(); op.controller.abort(); });
    if (queuedRead) queuedRead.reject(new DOMException('Read canceled', 'AbortError')); queuedRead = null;
    if (snapshotSource) snapshotSource.release(); snapshotSource = null;
    // In-flight writes/readbacks retain their authority until transport settlement.
  }
  window.StagePersistence = { load: load, save: save, flush: flush, retry: retry, reload: reload, status: status,
    sanitize: sanitize, hold: hold, borrowSnapshot: borrowSnapshot, destroy: destroy };
})();
