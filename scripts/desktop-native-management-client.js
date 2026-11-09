// SPDX-License-Identifier: MIT
// Test-only raw JSON client shared by isolated native acceptance scripts.
'use strict';
const net = require('node:net');
const REQUEST_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 64 * 1024;
const TOTAL_TIMEOUT_MS = 4000;
const CONNECT_RETRY_MS = 10;

function failure(code, message) { return Object.assign(new Error(message), {code}); }

module.exports = function requestManagement(pipe, payload) { return new Promise((resolve, reject) => {
  let attempt, retryTimer, encoded, lastConnectError, settled = false, size = 0;
  let connected = false, sent = false;
  const chunks = [];
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  // Native harness preflight uses ENOENT to distinguish an absent host from an
  // occupied/busy pipe. Preserve its last error only while no connect occurred.
  const timeout = () => lastConnectError || failure('ERR_MANAGEMENT_TIMEOUT', 'native management total deadline');
  const current = candidate => !settled && candidate === attempt;
  function removeListeners(candidate) {
    if (!candidate.socket) return;
    for (const event of ['connect', 'data', 'error', 'end', 'close']) {
      candidate.socket.removeListener(event, candidate[event]);
    }
  }
  function retire(candidate) {
    if (!candidate || !candidate.socket || candidate.retired) return;
    candidate.retired = true;
    for (const event of ['connect', 'data', 'end']) {
      candidate.socket.removeListener(event, candidate[event]);
    }
    // A failed connect may still queue an error before close. Keep guarded error/close
    // handlers until close, when both are removed along with all request callbacks.
    try { candidate.socket.destroy(); }
    catch (_) { removeListeners(candidate); }
  }
  function finish(error, value) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(retryTimer);
    const previous = attempt;
    attempt = null;
    retire(previous);
    if (error) {
      const beforeConnect = !connected && !sent;
      try { error.beforeConnect = beforeConnect; }
      catch (_) { error = Object.assign(failure(error.code, error.message), {beforeConnect, cause: error}); }
      reject(error);
    } else { resolve(value); }
  }
  // This bounds the entire promise even when the peer stays silent or keeps sending fragments.
  const timer = setTimeout(() => finish(timeout()), TOTAL_TIMEOUT_MS);
  function failed(candidate, error) {
    if (!current(candidate)) return;
    // Match management::request_until: an absent/busy listener before connection
    // is safe to retry. Once connected or any write was attempted, never replay.
    if (!candidate.connected && !candidate.sent && ['ENOENT', 'EBUSY'].includes(error.code)) {
      lastConnectError = error;
      if (Date.now() >= deadline) { finish(error); return; }
      attempt = null;
      retire(candidate);
      if (Date.now() >= deadline) { finish(timeout()); return; }
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, Math.min(CONNECT_RETRY_MS, deadline - Date.now()));
    } else { finish(error); }
  }
  function connect() {
    if (settled) return;
    if (Date.now() >= deadline) { finish(timeout()); return; }
    const candidate = {socket: null, connected: false, sent: false, retired: false};
    attempt = candidate;
    candidate.connect = () => {
      if (!current(candidate)) return;
      candidate.connected = true;
      connected = true;
      lastConnectError = null;
      if (Date.now() >= deadline) { finish(timeout()); return; }
      candidate.sent = true;
      sent = true;
      try { candidate.socket.write(encoded); }
      catch (error) { finish(error); }
    };
    candidate.data = chunk => {
      if (!current(candidate) || !candidate.sent) return;
      if (Date.now() >= deadline) { finish(timeout()); return; }
      if (chunk.length > RESPONSE_LIMIT - size) {
        finish(failure('ERR_MANAGEMENT_RESPONSE_LIMIT', 'native management response exceeds 65536 bytes'));
        return;
      }
      size += chunk.length;
      chunks.push(chunk);
      let value;
      try { value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
      catch (_) { return; }
      finish(null, value);
    };
    candidate.error = error => failed(candidate, error);
    candidate.end = () => {
      if (current(candidate)) finish(failure('ERR_MANAGEMENT_INCOMPLETE', 'native management ended before complete JSON'));
    };
    candidate.close = () => {
      removeListeners(candidate);
      if (current(candidate)) finish(failure('ERR_MANAGEMENT_INCOMPLETE', 'native management closed before complete JSON'));
    };
    try {
      candidate.socket = net.connect(pipe);
      candidate.socket.once('connect', candidate.connect);
      candidate.socket.on('data', candidate.data);
      candidate.socket.on('error', candidate.error);
      candidate.socket.once('end', candidate.end);
      candidate.socket.once('close', candidate.close);
    } catch (error) { failed(candidate, error); }
  }
  try {
    encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded, 'utf8') > REQUEST_LIMIT) {
      finish(failure('ERR_MANAGEMENT_REQUEST_LIMIT', 'native management request exceeds 16384 bytes'));
      return;
    }
    connect();
  } catch (error) { finish(error); }
}); };
