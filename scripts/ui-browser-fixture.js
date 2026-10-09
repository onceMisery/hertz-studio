// SPDX-License-Identifier: MIT
// Isolated real service and tagged audio for browser regression checks.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const TITLE = 'Layout Audit Fixture';
const ARTIST = 'Hertz Audit Artist';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(probe, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}

function writeTaggedWav(file) {
  const chunk = (id, data) => {
    const header = Buffer.alloc(8);
    header.write(id);
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
  };
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(44100, 4);
  format.writeUInt32LE(88200, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);
  const payload = Buffer.concat([
    Buffer.from('WAVE'), chunk('fmt ', format),
    chunk('LIST', Buffer.concat([Buffer.from('INFO'),
      chunk('INAM', Buffer.from(TITLE + '\0')), chunk('IART', Buffer.from(ARTIST + '\0'))])),
    chunk('data', Buffer.alloc(44100 * 2 * 30)),
  ]);
  fs.writeFileSync(file, chunk('RIFF', payload));
}

async function startFixture() {
  const binary = path.resolve(process.env.HERTZ_BIN || path.join(__dirname, '..', 'target', 'debug',
    process.platform === 'win32' ? 'hertz-studio.exe' : 'hertz-studio'));
  assert.ok(fs.existsSync(binary), 'Build the service first: cargo build --locked -p hertz-studio');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hertz-ui-check-'));
  const data = path.join(dir, 'data');
  const child = spawn(binary, ['--bind', '127.0.0.1', '--port', '0', '--data-dir', data], {
    windowsHide: true, stdio: 'ignore',
    env: { ...process.env, VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory' },
  });
  let launchError;
  child.on('error', error => { launchError = error; });
  async function close() {
    if (child.exitCode === null && child.signalCode === null && !launchError) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()), 'Cleanup stays in the temporary directory');
    assert.ok(path.basename(resolved).startsWith('hertz-ui-check-'), 'Cleanup targets this fixture');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  try {
    const discoveryFile = path.join(data, 'vmusicd.json');
    const discovery = await until(() => {
      if (launchError) throw launchError;
      assert.equal(child.exitCode, null, 'Fixture service exited before readiness');
      if (!fs.existsSync(discoveryFile)) return null;
      try { return JSON.parse(fs.readFileSync(discoveryFile, 'utf8')); } catch { return null; }
    }, 'service discovery');
    const base = 'http://127.0.0.1:' + discovery.port;
    async function api(route, method = 'GET', body) {
      const response = await fetch(base + route, {
        method, headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200, route + ' HTTP status');
      return response.json();
    }
    assert.equal((await api('/v1/health')).backend, 'null', 'Fixture must not use the audio device');
    return {
      base, api, close, dataDir: data,
      async connect(context) {
        await context.addCookies([{ name: 'vmusic_session', value: discovery.token,
          url: base, httpOnly: true, sameSite: 'Strict' }]);
      },
      async seed() {
        const music = path.join(dir, 'music');
        fs.mkdirSync(music);
        writeTaggedWav(path.join(music, 'layout.wav'));
        await api('/v1/library/roots', 'POST', { path: music, enabled: true });
        await api('/v1/library/scan', 'POST', { root: music });
        await until(async () => {
          const status = await api('/v1/library/status');
          return !status.running && status.total > 0;
        }, 'tagged WAV scan');
        const track = (await api('/v1/tracks?limit=10')).tracks.find(t => t.title === TITLE);
        assert.ok(track, 'Scanner read WAV title');
        assert.equal(track.artist, ARTIST, 'Scanner read WAV artist');
        await api('/v1/player/volume', 'POST', { volume: 0 });
        await api('/v1/player/load', 'POST', { track_id: track.id });
        await api('/v1/player/pause', 'POST', {});
        return track;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { startFixture, TITLE, ARTIST };
