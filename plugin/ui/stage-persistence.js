// SPDX-License-Identifier: MIT
// Server authority, separate CAS revisions and one coalescing save queue per target.
(function () {
  'use strict';
  var hydrated = false, state = null;
  var targets = { current: slot(), library: slot() };
  function slot() { return { revision: 0, pending: undefined, running: null, error: null }; }
  function copy(v) { return JSON.parse(JSON.stringify(v)); }
  function api() { if (!window.VMusicTransport) throw new Error('服务连接尚未就绪'); return VMusicTransport; }
  function event() { document.dispatchEvent(new CustomEvent('stage-persistence:change', { detail: status() })); }
  function status() {
    return { hydrated: hydrated, current: info(targets.current), library: info(targets.library) };
  }
  function info(s) { return { saving: !!s.running, dirty: s.pending !== undefined, error: s.error && s.error.message, revision: s.revision }; }
  function sanitize(value) {
    var out = copy(value), removed = false;
    (Array.isArray(out) ? out : [out]).forEach(function (p) {
      var bg = p && p.bg; if (!bg) return;
      if (bg.type === 'media' && !bg.assetRef) { p.bg = { type: 'theme' }; removed = true; return; }
      ['url','name','path','token','file','blob','lease'].forEach(function (key) { if (key in bg) { delete bg[key]; removed = true; } });
    });
    return { value: out, removed: removed };
  }
  function adopt(snapshot) {
    state = snapshot.state;
    ['current','library'].forEach(function (key) { targets[key].revision = state[key] && state[key].revision || 0; });
  }
  async function load(legacyCurrent, legacyLibrary) {
    var snapshot = await api().get('/v1/stage/presets');
    adopt(snapshot); hydrated = true;
    var removed = !!state.legacyMediaRemoved;
    for (var key of ['current','library']) {
      var legacy = key === 'current' ? legacyCurrent : legacyLibrary;
      if (!(state[key] && state[key].initialized) && legacy != null) {
        var clean = sanitize(legacy); removed = removed || clean.removed;
        try { await save(key, clean.value); snapshot[key] = clean.value; }
        catch (e) { targets[key].error = e; event(); throw e; }
      }
    }
    snapshot.legacyMediaRemoved = removed;
    event(); return snapshot;
  }
  function save(key, payload) {
    var s = targets[key];
    if (!s) return Promise.reject(new Error('未知保存目标'));
    s.pending = sanitize(payload).value;
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
      var payload = s.pending; s.pending = undefined;
      var request = { target: key, requestId: StageMedia.uid(), expectedPresetRevision: s.revision, payload: payload };
      var receipt;
      try { receipt = await api().put('/v1/stage/presets', request); }
      catch (e) {
        // A failed response may have committed. Read its receipt before deciding what failed;
        // never blindly repeat a write or overwrite a competing revision.
        try {
          var snapshot = await api().get('/v1/stage/presets');
          var commit = snapshot.state[key] && snapshot.state[key].lastCommit;
          if (commit && commit.requestId === request.requestId) receipt = commit;
        } catch (_) { /* preserve the edit and original failure */ }
        if (!receipt) {
          if (s.pending === undefined) s.pending = payload;
          s.error = e; event(); throw e;
        }
      }
      s.revision = receipt.revision;
    }
  }
  async function retry() {
    await Promise.all(Object.keys(targets).map(function (key) { return targets[key].running && targets[key].running.catch(function () {}); }));
    var snapshot = await api().get('/v1/stage/presets'); adopt(snapshot); hydrated = true;
    for (var key of ['current','library']) {
      var s = targets[key]; s.error = null;
      if (s.pending !== undefined) await save(key, s.pending);
    }
    event();
  }
  async function reload() {
    await Promise.all(Object.keys(targets).map(function (key) { return targets[key].running && targets[key].running.catch(function () {}); }));
    var snapshot = await api().get('/v1/stage/presets');
    targets = { current: slot(), library: slot() }; adopt(snapshot); hydrated = true; event(); return snapshot;
  }
  function hold(message) { targets.current.error = new Error(message); event(); }
  function flush(key) {
    var s = targets[key];
    if (s.error) return Promise.reject(s.error);
    if (s.running) return s.running;
    if (s.pending !== undefined) return save(key, s.pending);
    return Promise.resolve();
  }
  window.StagePersistence = { load: load, save: save, flush: flush, retry: retry, reload: reload, status: status, sanitize: sanitize, hold: hold };
})();
