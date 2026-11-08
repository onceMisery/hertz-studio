// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// The native SMTC service is a separate owner of the system media session.
// Every renderer observes ownership, including ordinary tabs.
// Browser MediaSession remains the fallback when native ownership is absent.
(function (global) {
  'use strict';

  const PATH = '/v1/window/media-state';
  const POLL_MS = 5000;
  const REQUEST_TIMEOUT_MS = 5000;
  const FIRST_READ_ATTEMPTS = 3;
  let transport = null;
  let initialized = false;
  let generation = 0;
  let readFlight = null;
  let pollTimer = 0;
  let owner = false;
  let available = null;
  let phase = 'stopped';
  let error = null;
  let hasRead = false;
  let unknown = false;
  let firstReadFailures = 0;
  let serverInstance = null;

  function isServer(next) {
    return !!next && next.kind === 'server' && !(global.hertzHost && global.hertzHost.isDbx);
  }

  function snapshot() {
    return { available, owned: owner, phase, unknown, loading: !!readFlight, error, serverInstance };
  }

  function emitOwnerChanged(previous) {
    if (previous === owner || typeof global.dispatchEvent !== 'function') return;
    global.dispatchEvent(new CustomEvent('hertz-system-media-owner-changed', {
      detail: snapshot(),
    }));
  }

  function setOwner(next) {
    const previous = owner;
    owner = next === true;
    emitOwnerChanged(previous);
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = 0;
  }

  function schedulePoll(expectedGeneration) {
    stopPolling();
    if (!isServer(transport) || available === false
      || (available !== true && firstReadFailures >= FIRST_READ_ATTEMPTS)) return;
    pollTimer = setTimeout(() => {
      pollTimer = 0;
      if (expectedGeneration !== generation) return;
      refresh().catch(() => {});
    }, POLL_MS);
  }

  function accept(value, expectedGeneration) {
    if (expectedGeneration !== generation) return;
    if (!value || typeof value.available !== 'boolean'
      || (value.available && (typeof value.owned !== 'boolean'
        || !['starting', 'ready', 'failed', 'stopped'].includes(value.phase)))) {
      throw new Error('Invalid system media ownership state');
    }
    hasRead = true;
    unknown = false;
    firstReadFailures = 0;
    error = value.error || null;
    serverInstance = value.serverInstance || null;
    if (value.available !== true) {
      available = false;
      phase = value.phase || 'stopped';
      setOwner(false);
      stopPolling();
      return;
    }

    available = true;
    phase = value.phase;
    setOwner(value.owned);
  }

  function refresh() {
    if (!isServer(transport)) return Promise.resolve(snapshot());
    if (readFlight) return readFlight;
    stopPolling();
    const expectedGeneration = generation;
    const requestTransport = transport;
    readFlight = Promise.resolve().then(() => requestTransport.get(PATH, {
      retry: false, timeoutMs: REQUEST_TIMEOUT_MS, cache: 'no-store',
    })).then(value => accept(value, expectedGeneration)).catch(readError => {
      if (expectedGeneration !== generation) return;
      error = readError && readError.message || String(readError);
      unknown = true;
      if (!hasRead) firstReadFailures++;
      // A transport failure is not evidence that native ownership ended.
      // Keep the last confirmed owner. Before the first reply, reserve the
      // session rather than risk registering beside an existing native owner.
    }).finally(() => {
      if (expectedGeneration !== generation) return;
      readFlight = null;
      schedulePoll(expectedGeneration);
    }).then(snapshot);
    return readFlight;
  }

  function init(nextTransport) {
    if (initialized && transport === nextTransport) return readFlight || Promise.resolve(snapshot());
    initialized = true;
    generation++;
    stopPolling();
    readFlight = null;
    transport = nextTransport || null;
    available = null;
    phase = 'stopped';
    error = null;
    hasRead = false;
    unknown = false;
    firstReadFailures = 0;
    serverInstance = null;
    if (!isServer(transport)) {
      setOwner(false);
      return Promise.resolve(snapshot());
    }
    phase = 'starting';
    unknown = true;
    setOwner(true);
    return refresh();
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible' && isServer(transport) && available !== false) {
      firstReadFailures = 0;
      refresh();
    }
  }
  if (global.document && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  global.HertzSystemMedia = {
    init,
    refresh,
    ownsSession: () => owner === true,
    snapshot,
  };
})(window);
