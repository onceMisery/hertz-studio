// SPDX-License-Identifier: MIT
// Real Windows service restart with a loopback model fixture. No cloud calls.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const binary = path.resolve(process.env.HERTZ_BIN || path.join(root, 'target', 'debug',
  process.platform === 'win32' ? 'hertz-studio.exe' : 'hertz-studio'));
const artifactDir = path.resolve(process.env.HERTZ_RECOVERY_ARTIFACT_DIR ||
  path.join(root, 'target', 'ai-runner-recovery'));
const reportPath = path.resolve(process.env.HERTZ_RECOVERY_REPORT ||
  path.join(artifactDir, `process-recovery-${process.pid}-${Date.now()}.json`));
const queueBrief = 'process-recovery-queued-' + crypto.randomUUID();
const activeBrief = 'process-recovery-active-' + crypto.randomUUID();
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

async function startService(dataDir) {
  const child = spawn(binary, ['--bind', '127.0.0.1', '--port', '0', '--data-dir', dataDir], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', VMUSIC_LOG: 'error' },
  });
  let launchError;
  child.on('error', error => { launchError = error; });
  try {
    const discoveryPath = path.join(dataDir, 'vmusicd.json');
    const discovery = await until(async () => {
      if (launchError) throw launchError;
      assert.equal(child.exitCode, null, 'Service exited before readiness');
      try {
        const value = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
        if (value.pid !== child.pid) return null;
        const response = await fetch('http://127.0.0.1:' + value.port + '/v1/health', {
          signal: AbortSignal.timeout(500),
        });
        return response.ok ? value : null;
      } catch {
        return null;
      }
    }, 'new service discovery');
    const base = 'http://127.0.0.1:' + discovery.port;
    const api = async (route, method = 'GET', body) => {
      const response = await fetch(base + route, {
        method,
        headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200, route + ' HTTP status');
      return response.json();
    };
    await api('/v1/health');
    return { child, api };
  } catch (error) {
    await terminate(child).catch(() => {});
    throw error;
  }
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  assert.equal(child.kill(), true, 'Service process must accept termination');
  await Promise.race([
    exited,
    delay(8000).then(() => { throw new Error('Service process did not exit'); }),
  ]);
}

async function main() {
  assert.ok(fs.existsSync(binary), 'Build the service binary first: cargo build -p hertz-studio');
  fs.mkdirSync(artifactDir, { recursive: true });
  assert.ok(!fs.existsSync(reportPath), 'Refusing to overwrite an existing recovery report');
  const dataDir = fs.mkdtempSync(path.join(artifactDir, 'data-'));
  const resolvedArtifactDir = fs.realpathSync(artifactDir);
  assert.equal(path.dirname(fs.realpathSync(dataDir)), resolvedArtifactDir,
    'Generated DataDir must stay inside the D-drive artifact directory');

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
      const pending = { response: res, closed: false };
      heldResponses.push(pending);
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
    fs.writeFileSync(path.join(dataDir, 'config.toml'),
      '[ai]\nprovider = "ollama"\norigin = "' + origin + '"\nmodel = "process-recovery-fixture"\n');

    first = await startService(dataDir);
    const edition = (await first.api('/v1/health')).edition;
    assert.ok(['standard', 'full'].includes(edition));
    const initialStatus = await first.api('/v1/ai/status');
    assert.equal(initialStatus.provider.ready, true);
    assert.equal(initialStatus.consent.inAppGeneration, false);
    assert.equal(requests.length, 0, 'Startup and status must not contact the provider');

    await first.api('/v1/settings', 'PUT', { ai_generation_consent: true });
    const active = (await first.api('/v1/ai/jobs', 'POST', { brief: activeBrief })).job;
    await until(() => requests.length === 1, 'dispatched loopback request');
    assert.equal(requests[0].brief, activeBrief);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/api/chat');
    const activeView = await first.api('/v1/ai/jobs/' + active.jobId);
    assert.equal(activeView.state, 'running');
    const queued = (await first.api('/v1/ai/jobs', 'POST', { brief: queueBrief })).job;
    assert.equal(queued.state, 'accepted');
    assert.equal(requests.length, 1, 'Queued job must not dispatch beside the held request');

    await terminate(first.child);
    await until(() => heldResponses[0]?.closed, 'loopback request closed with the service');

    second = await startService(dataDir);
    const recoveredStatus = await second.api('/v1/ai/status');
    assert.equal(recoveredStatus.provider.ready, true);
    const activeAfter = await second.api('/v1/ai/jobs/' + active.jobId);
    const queuedAfter = await second.api('/v1/ai/jobs/' + queued.jobId);
    assert.equal(activeAfter.state, 'interrupted');
    assert.equal(activeAfter.usage.usageState, 'unknown',
      'A dispatched request without a trusted response must retain unknown accounting');
    assert.equal(queuedAfter.state, 'interrupted');
    assert.equal(queuedAfter.usage.usageState, 'released',
      'A queued request that was never dispatched must release its reservation');
    assert.equal(requests.length, 1, 'Restart must not repeat a model POST');
    assert.deepEqual(fixtureErrors, []);
    await delay(500);
    assert.equal(requests.length, 1, 'Recovered terminal tasks must remain terminal');

    const files = [];
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else files.push(file);
      }
    };
    visit(dataDir);
    for (const file of files) {
      assert.ok(!fs.readFileSync(file).includes(Buffer.from(activeBrief)),
        'Original generation brief must remain memory-only');
      assert.ok(!fs.readFileSync(file).includes(Buffer.from(queueBrief)),
        'Queued generation brief must remain memory-only');
    }

    report = {
      result: 'passed',
      at: new Date().toISOString(),
      edition,
      scope: 'Two real Windows service processes, same isolated DataDir, loopback Ollama HTTP held across forced termination, memory secrets, null audio; no cloud calls',
      binary,
      binarySha256: digest(binary),
      harnessSha256: digest(__filename),
      sources: Object.fromEntries(['bootstrap.rs', 'jobs.rs', 'usage.rs'].map(name =>
        [name, digest(path.join(root, 'crates', 'hertz-studio', 'src', name === 'bootstrap.rs' ? name : 'ai/' + name))])),
      checks: [
        'startup recovery completes before the restarted service accepts HTTP requests',
        'running dispatched task becomes interrupted/unknown',
        'accepted queued task becomes interrupted/released',
        'active loopback provider connection closes on forced service termination',
        'restart does not repeat the provider POST',
        'generation briefs are absent from persistent DataDir files',
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
    const resolved = fs.realpathSync(dataDir);
    assert.equal(path.dirname(resolved), resolvedArtifactDir, 'Cleanup stays inside the artifact directory');
    assert.ok(path.basename(resolved).startsWith('data-'), 'Cleanup targets only this run DataDir');
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
