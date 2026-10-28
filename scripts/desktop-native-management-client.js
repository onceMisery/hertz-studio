// SPDX-License-Identifier: MIT
// Test-only raw JSON client shared by isolated native acceptance scripts.
'use strict';
const net = require('node:net');
const RESPONSE_LIMIT = 8192;
const TOTAL_TIMEOUT_MS = 4000;

function failure(code, message) { return Object.assign(new Error(message), {code}); }

module.exports = function requestManagement(pipe, payload) { return new Promise((resolve, reject) => {
  let socket, settled = false, size = 0;
  const chunks = [];
  function finish(error, value) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (socket) socket.destroy();
    if (error) reject(error); else resolve(value);
  }
  // This bounds the entire promise even when the peer stays silent or keeps sending fragments.
  const timer = setTimeout(() => finish(failure('ERR_MANAGEMENT_TIMEOUT', 'native management total deadline')), TOTAL_TIMEOUT_MS);
  try {
    const encoded = JSON.stringify(payload);
    socket = net.connect(pipe);
    socket.once('connect', () => socket.write(encoded));
    socket.on('data', chunk => {
      if (settled) return;
      if (chunk.length > RESPONSE_LIMIT - size) {
        finish(failure('ERR_MANAGEMENT_RESPONSE_LIMIT', 'native management response exceeds 8192 bytes'));
        return;
      }
      size += chunk.length;
      chunks.push(chunk);
      let value;
      try { value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
      catch (_) { return; }
      finish(null, value);
    });
    socket.once('error', error => finish(error));
    socket.once('end', () => finish(failure('ERR_MANAGEMENT_INCOMPLETE', 'native management ended before complete JSON')));
    socket.once('close', () => finish(failure('ERR_MANAGEMENT_INCOMPLETE', 'native management closed before complete JSON')));
  } catch (error) { finish(error); }
}); };
