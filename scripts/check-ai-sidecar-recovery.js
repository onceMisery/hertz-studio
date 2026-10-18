// SPDX-License-Identifier: MIT
// Real DBX Rust sidecar process restart over JSON-RPC. No cloud calls.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const edition = process.env.HERTZ_EDITION || 'standard';
assert.ok(['standard', 'full'].includes(edition), 'HERTZ_EDITION must be standard or full');
const binary = path.resolve(process.env.HERTZ_PLUGIN_BIN || path.join(root, 'target', 'debug',
  process.platform === 'win32' ? 'dbx-plugin-hertz.exe' : 'dbx-plugin-hertz'));
const artifactDir = path.resolve(process.env.HERTZ_RECOVERY_ARTIFACT_DIR ||
  path.join(root, 'target', 'ai-sidecar-recovery'));
const reportPath = path.resolve(process.env.HERTZ_RECOVERY_REPORT ||
  path.join(artifactDir, `${edition}-${process.pid}-${Date.now()}.json`));
const activeBrief = 'dbx-sidecar-recovery-active-' + crypto.randomUUID();
const queuedBrief = 'dbx-sidecar-recovery-queued-' + crypto.randomUUID();
const requests = [];
const heldResponses = [];
const fixtureErrors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(probe, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(40);
  }
  throw new Error('Timed out: ' + label);
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createClient(child) {
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        for (const item of pending.values()) item.reject(new Error('Sidecar stdout was not JSON'));
        pending.clear();
        continue;
      }
      if (message.id === undefined) continue;
      const item = pending.get(message.id);
      if (item) {
        clearTimeout(item.timer);
        pending.delete(message.id);
        item.resolve(message);
      }
    }
  });
  child.on('close', (code, signal) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(`Sidecar exited before reply (code=${code}, signal=${signal})`));
    }
    pending.clear();
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}`));
        }, 12000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
  };
}

async function startSidecar(pluginDataDir) {
  const child = spawn(binary, [], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DBX_PLUGIN_DATA_DIR: pluginDataDir,
      VMUSIC_BACKEND: 'null',
      VMUSIC_SECRETS: 'memory',
      VMUSIC_LOG: 'error',
    },
  });
  const client = createClient(child);
  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => stderr.push(chunk));
  try {
    const initialized = await client.send('plugin/initialize', {
      host: { hostApiVersion: '1.4.0', protocolVersions: [1], features: [] },
    });
    assert.equal(initialized.result?.protocolVersion, 1, 'DBX protocol initialization');
    const health = await client.send('v1/health', { op: 'GET' });
    assert.equal(health.result?.status, 200, 'Sidecar health RPC');
    assert.equal(health.result?.body?.host, 'dbx');
    assert.equal(health.result?.body?.edition, edition);
    return { child, client, stderr };
  } catch (error) {
    await terminate(child).catch(() => {});
    throw error;
  }
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  assert.equal(child.kill(), true, 'Sidecar process must accept termination');
  await Promise.race([
    closed,
    delay(8000).then(() => { throw new Error('Sidecar process did not exit'); }),
  ]);
}

function rpc(sidecar, path, op, body) {
  return sidecar.client.send(path, { op, body }).then(message => {
    assert.ok(message.result, `${path} must return a domain envelope`);
    return message.result;
  });
}

async function main() {
  assert.ok(fs.existsSync(binary), 'Build dbx-plugin-hertz first');
  fs.mkdirSync(artifactDir, { recursive: true });
  assert.ok(!fs.existsSync(reportPath), 'Refusing to overwrite an existing recovery report');
  const artifactRoot = fs.realpathSync(artifactDir);
  const runDir = fs.mkdtempSync(path.join(artifactDir, `run-${edition}-`));
  assert.equal(path.dirname(fs.realpathSync(runDir)), artifactRoot,
    'Generated DBX data root must stay inside the D-drive artifact directory');
  const pluginDataDir = edition === 'full' ? path.join(runDir, 'data') : path.join(runDir, 'data');
  const actualDataDir = edition === 'full' ? pluginDataDir : path.join(pluginDataDir, 'standard');
  fs.mkdirSync(actualDataDir, { recursive: true });

  const server = http.createServer((req, res) => {
    res.on('close', () => {
      const held = heldResponses.find(item => item.response === res);
      if (held) held.closed = true;
    });
    (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const brief = body.messages?.[1]?.content;
      requests.push({ brief, method: req.method, url: req.url });
      heldResponses.push({ response: res, closed: false });
    })().catch(error => {
      fixtureErrors.push(error.message);
      res.destroy();
    });
  });

  let first;
  let second;
  let report;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    fs.writeFileSync(path.join(actualDataDir, 'config.toml'),
      '[ai]\nprovider = "ollama"\norigin = "' + origin + '"\nmodel = "dbx-recovery-fixture"\n');

    first = await startSidecar(pluginDataDir);
    const initial = await rpc(first, 'v1/ai/status', 'GET');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.provider.ready, true);
    assert.equal(initial.body.consent.inAppGeneration, false);
    assert.equal(requests.length, 0, 'Sidecar startup/status must not contact the provider');

    const consent = await rpc(first, 'v1/settings', 'PUT', { ai_generation_consent: true });
    assert.equal(consent.status, 200);
    const active = await rpc(first, 'v1/ai/jobs', 'POST', { brief: activeBrief });
    assert.equal(active.status, 200);
    await until(() => requests.length === 1, 'dispatched DBX loopback request');
    assert.equal(requests[0].brief, activeBrief);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/api/chat');
    const activeJob = active.body.job;
    const activeView = await rpc(first, 'v1/ai/jobs/' + activeJob.jobId, 'GET');
    assert.equal(activeView.body.state, 'running');

    const queued = await rpc(first, 'v1/ai/jobs', 'POST', { brief: queuedBrief });
    assert.equal(queued.status, 200);
    const queuedJob = queued.body.job;
    assert.equal(queuedJob.state, 'accepted');
    assert.equal(requests.length, 1, 'Queued DBX task must not share the active execution slot');

    await terminate(first.child);
    await until(() => heldResponses[0]?.closed, 'provider request closed with DBX sidecar');

    second = await startSidecar(pluginDataDir);
    const recoveredStatus = await rpc(second, 'v1/ai/status', 'GET');
    assert.equal(recoveredStatus.status, 200);
    const activeAfter = await rpc(second, 'v1/ai/jobs/' + activeJob.jobId, 'GET');
    const queuedAfter = await rpc(second, 'v1/ai/jobs/' + queuedJob.jobId, 'GET');
    assert.equal(activeAfter.body.state, 'interrupted');
    assert.equal(activeAfter.body.usage.usageState, 'unknown');
    assert.equal(queuedAfter.body.state, 'interrupted');
    assert.equal(queuedAfter.body.usage.usageState, 'released');
    assert.equal(requests.length, 1, 'DBX sidecar restart must not repeat a model POST');
    assert.deepEqual(fixtureErrors, []);
    await delay(500);
    assert.equal(requests.length, 1, 'Recovered DBX tasks must remain terminal');

    const files = [];
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else files.push(file);
      }
    };
    visit(actualDataDir);
    for (const file of files) {
      assert.ok(!fs.readFileSync(file).includes(Buffer.from(activeBrief)),
        'Dispatched generation brief must remain memory-only');
      assert.ok(!fs.readFileSync(file).includes(Buffer.from(queuedBrief)),
        'Queued generation brief must remain memory-only');
    }

    report = {
      result: 'passed',
      at: new Date().toISOString(),
      edition,
      scope: 'Two real Windows DBX Rust sidecar processes over SDK JSON-RPC stdin/stdout, same isolated plugin DataDir, loopback Ollama HTTP held across forced termination, memory secrets, null audio; no desktop DBX host or cloud model',
      binary,
      binarySha256: digest(binary),
      harnessSha256: digest(__filename),
      sources: Object.fromEntries([
        ['plugin-main.rs', path.join(root, 'plugin', 'backend', 'src', 'main.rs')],
        ['bootstrap.rs', path.join(root, 'crates', 'hertz-studio', 'src', 'bootstrap.rs')],
        ['jobs.rs', path.join(root, 'crates', 'hertz-studio', 'src', 'ai', 'jobs.rs')],
        ['usage.rs', path.join(root, 'crates', 'hertz-studio', 'src', 'ai', 'usage.rs')],
      ].map(([name, file]) => [name, digest(file)])),
      checks: [
        'actual plugin sidecar initializes and serves the DBX JSON-RPC protocol',
        'running dispatched task becomes interrupted/unknown after sidecar restart',
        'accepted queued task becomes interrupted/released after sidecar restart',
        'active loopback provider connection closes with the sidecar process',
        'restart does not repeat the provider POST',
        'generation briefs remain absent from persistent plugin DataDir files',
      ],
    };
  } finally {
    if (first) await terminate(first.child);
    if (second) await terminate(second.child);
    for (const held of heldResponses) {
      if (!held.response.destroyed) held.response.destroy();
    }
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    const resolved = fs.realpathSync(runDir);
    assert.equal(path.dirname(resolved), artifactRoot, 'Cleanup stays inside this run artifact directory');
    assert.ok(path.basename(resolved).startsWith(`run-${edition}-`), 'Cleanup targets only this run');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
