// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Native sleep belongs to the service. This module only observes and edits it.
(function () {
  'use strict';

  const PATH = '/v1/window/sleep-timer';
  let options = null, current = null, observedAt = 0;
  let initialized = false, started = false, available = false, unknown = false;
  let loading = false, pending = false, message = '', epoch = 0;
  let reading = null, poll = 0, unavailableReads = 0;

  function isNative() {
    return !(window.hertzHost && window.hertzHost.isDbx)
      && !(options && options.transport.kind === 'dbx')
      && !!window.__hertzWindowHost && window.__hertzWindowHost.lifecycleVersion === 1;
  }

  function snapshot() {
    const elapsed = Math.max(0, performance.now() - observedAt);
    return {
      managed: isNative(), available, loading, pending, unknown,
      phase: current ? current.phase : 'idle', revision: current ? current.revision : null,
      remainingMs: current && current.phase === 'armed' ? Math.max(0, current.remainingMs - elapsed) : 0,
      error: message || (current && current.error === 'sleep_timer_pause_failed' ? '暂停播放失败，请取消定时或重新设置。' : current && current.error) || '',
    };
  }

  function emit() { if (options && options.onChange) options.onChange(snapshot()); }
  function notice(text, failed) { if (options && options.onNotice) options.onNotice(text, failed ? 'error' : undefined); }
  function errorText(error) { return error && error.message ? error.message : '请稍后重试'; }

  function accept(value) {
    if (!value || value.available !== true) {
      available = false;
      unknown = true;
      message = '原生睡眠定时暂不可用，请刷新状态后重试。';
      unavailableReads++;
      return;
    }
    if (!Number.isSafeInteger(value.revision) || value.revision < 0
      || !['idle', 'armed', 'expired', 'failed', 'cancelled'].includes(value.phase)
      || !Number.isFinite(value.remainingMs) || value.remainingMs < 0) {
      throw new Error('睡眠定时状态无效');
    }
    // Revisions are ordered across GET, mutations and service expiry. In
    // addition, the request epoch below rejects reads begun before a write.
    if (current && value.revision < current.revision) return;
    const previous = current;
    current = value;
    observedAt = performance.now();
    available = true;
    unknown = false;
    message = '';
    unavailableReads = 0;
    if (previous && value.revision !== previous.revision) {
      if (value.phase === 'expired') notice('睡眠定时到了，已暂停播放');
      if (value.phase === 'failed') notice('睡眠定时暂停失败，请取消定时或重新设置。', true);
    }
  }

  function schedule() {
    clearTimeout(poll);
    poll = 0;
    if (!started || !isNative() || unavailableReads >= 3) return;
    poll = setTimeout(() => { poll = 0; refresh(); }, document.hidden || unknown ? 5000 : 1000);
  }

  function refresh() {
    if (!options || !isNative()) return Promise.resolve(snapshot());
    if (reading) return reading;
    if (pending) return Promise.resolve(snapshot());
    const requestEpoch = epoch;
    loading = !current;
    emit();
    reading = (async () => {
      try {
        const value = await Promise.resolve().then(() => options.transport.get(PATH, { retry: false, timeoutMs: 5000 }));
        if (requestEpoch === epoch) accept(value);
      } catch (error) {
        if (requestEpoch === epoch) {
          unknown = true;
          message = '睡眠定时状态未确认：' + errorText(error);
        }
      } finally {
        if (requestEpoch === epoch) loading = false;
        reading = null;
        emit();
        schedule();
      }
      return snapshot();
    })();
    return reading;
  }

  async function change(seconds) {
    if (!isNative()) return false;
    if (pending) { notice('正在更新睡眠定时，请稍候。'); return false; }
    if (!available || unknown || !current) {
      await refresh();
      notice('请确认最新睡眠定时状态后重新操作。', true);
      return false;
    }
    if (seconds !== null && (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400)) {
      notice('请输入 1–1440 之间的分钟数', true);
      return false;
    }
    const revision = current.revision;
    // A pending GET may complete later, but must not undo this mutation.
    epoch++;
    pending = true;
    loading = false;
    emit();
    let conflict = false, succeeded = false;
    try {
      accept(await options.transport.put(PATH, { seconds, expectedRevision: revision }));
      succeeded = available && !unknown;
      if (succeeded) notice(seconds === null ? '已取消睡眠定时' : `将在 ${seconds / 60} 分钟后暂停播放`);
    } catch (error) {
      conflict = error.code === 'sleep_timer_revision_conflict';
      unknown = true;
      message = conflict ? '睡眠定时已在其他位置变更，正在读取最新状态。'
        : error.code === 'sleep_timer_room_active' ? '一起听房间中请使用房间的睡眠定时。'
          : '睡眠定时更新未确认：' + errorText(error);
      notice(message, true);
    } finally {
      // Also invalidate GETs that happened to start while the mutation ran.
      epoch++;
      pending = false;
      emit();
      schedule();
    }
    if (conflict) {
      // Refresh only; replaying the user's stale write could overwrite a newer
      // timer or re-arm a timer that the service has already expired.
      if (reading) await reading;
      await refresh();
    }
    return succeeded;
  }

  function start() {
    if (!options || !isNative() || started) return;
    started = true;
    setInterval(() => { if (!document.hidden) emit(); }, 500);
    refresh();
  }

  function init(next) {
    if (initialized) { start(); return; }
    initialized = true;
    options = next;
    window.addEventListener('hertz-native-host-ready', start);
    document.addEventListener('visibilitychange', () => {
      if (!isNative()) return;
      if (!document.hidden) { emit(); refresh(); }
      else schedule();
    });
    start();
  }

  window.HertzWindowSleep = {
    init, isNative, snapshot, refresh,
    arm: seconds => change(seconds), cancel: () => change(null),
  };
})();
