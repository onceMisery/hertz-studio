// SPDX-License-Identifier: MIT
// Explicit Windows OS-keyring acceptance using only fresh, isolated AI scopes.
// Never enumerates credentials, contacts a model, or uses the browser fixture's memory backend.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const base = path.join(root, 'target', 'keyring-validation');
const helper = path.join(__dirname, 'windows-ai-credential-probe.ps1');
const powershell = process.env.POWERSHELL || 'pwsh';
const bins = Object.fromEntries(['standard', 'full'].map(edition => [edition,
  path.resolve(process.env['HERTZ_' + edition.toUpperCase() + '_BIN'] ||
    path.join(base, edition, 'hertz-studio.exe'))]));
const endpoint = '/v1/ai/provider-credential';
const services = ['hertz-studio-standard', 'hertz-studio', 'mmusic-studio'];
const service = edition => edition === 'standard' ? services[0] : services[1];
const expected = configured => ({ provider: 'openai', origin: 'https://api.openai.com', configured });
const keyA = 'fixture-keyring-' + crypto.randomUUID(), keyB = 'fixture-keyring-' + crypto.randomUUID();
const oversizedKey = 'fixture-keyring-' + 'a'.repeat(4096 - 'fixture-keyring-'.length);
const keys = [keyA, keyB, oversizedKey];

async function bounded(promise, label, ms = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(label + ' timed out')), ms);
  })]); } finally { clearTimeout(timer); }
}
async function until(probe, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const value = await probe(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(label + ' timed out');
}
function native(scope, keyringService, operation = 'read', expectedKey = keyA) {
  return new Promise((resolve, reject) => {
    const child = execFile(powershell, ['-NoProfile', '-NonInteractive', '-File', helper],
      { windowsHide: true, timeout: 20000, maxBuffer: 32768 }, (error, stdout) => {
        if (error) return reject(Error('Windows native credential fixture failed'));
        try { resolve(JSON.parse(stdout)); } catch { reject(Error('invalid native fixture summary')); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ scope, service: keyringService, operation, expectedKey }));
  });
}
function inspect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) inspect(file);
    else {
      const bytes = fs.readFileSync(file);
      for (const key of keys) assert.ok(!bytes.includes(Buffer.from(key)), 'fixture key persisted in DataDir');
    }
  }
}

async function main() {
  assert.ok(process.argv.includes('--windows-keyring'), 'Pass --windows-keyring to explicitly run the real Windows keyring check');
  assert.equal(process.platform, 'win32', 'Windows-only native acceptance');
  for (const binary of Object.values(bins)) assert.ok(fs.existsSync(binary), 'Build both isolated edition binaries first');
  fs.mkdirSync(base, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(base, 'data-'));
  const commonData = path.join(runDir, 'common'), otherData = path.join(runDir, 'other');
  const scopes = new Set(), children = new Set(), logs = [];
  let cleanupComplete = false;
  async function launch(edition, dataDir = commonData) {
    const env = { ...process.env, VMUSIC_BACKEND: 'null' };
    delete env.VMUSIC_SECRETS;
    const child = spawn(bins[edition], ['--bind', '127.0.0.1', '--port', '0', '--data-dir', dataDir],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    children.add(child);
    let launchError;
    child.on('error', error => { launchError = error; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      logs.push(Buffer.from(chunk));
    });
    const discovery = await until(() => {
      if (launchError) throw Error('fixture process launch failed');
      assert.equal(child.exitCode, null, 'fixture exited before readiness');
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(dataDir, 'vmusicd.json'), 'utf8'));
        const ai = JSON.parse(fs.readFileSync(path.join(dataDir, 'ai', 'ai-discovery.json'), 'utf8'));
        if (doc.pid !== child.pid || ai.pid !== child.pid) return null;
        assert.equal(ai.edition, edition);
        return { ...doc, owner: ai.ownerInstanceId };
      } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
    }, 'fixture discovery');
    assert.match(discovery.owner, /^[a-f0-9-]{36}$/);
    const identity = JSON.stringify(['v1', discovery.owner, 'openai', 'https://api.openai.com']);
    const scope = 'ai_provider_cred_v1_' + crypto.createHash('sha256').update(identity).digest('hex');
    scopes.add(scope);
    async function api(route, method = 'GET', body, expectedStatus = 200) {
      const response = await fetch('http://127.0.0.1:' + discovery.port + route, {
        method, headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, expectedStatus, method + ' ' + route + ' HTTP status');
      return response.json();
    }
    const health = await api('/v1/health');
    assert.equal(health.edition, edition); assert.equal(health.backend, 'null');
    const status = await api('/v1/ai/status');
    assert.equal(status.provider.id, 'fake'); assert.equal(status.consent.inAppGeneration, false);
    return { api, scope, async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill(); await bounded(exited, 'fixture exit');
      }
      children.delete(child);
    } };
  }
  try {
    let instance = await launch('standard');
    assert.deepEqual(await instance.api(endpoint), expected(false));
    assert.equal((await native(instance.scope, service('standard'))).exists, false);
    assert.deepEqual(await instance.api(endpoint, 'PUT', { api_key: keyA }), expected(true));
    const saved = await native(instance.scope, service('standard'));
    assert.equal(saved.envelope, true); assert.equal(saved.matches, true);
    assert.equal(saved.deviceExists, false);
    assert.match(saved.generation, /^[a-f0-9-]{36}$/);
    const originalScope = instance.scope;
    await instance.close();
    instance = await launch('standard');
    assert.equal(instance.scope, originalScope);
    assert.deepEqual(await instance.api(endpoint), expected(true));
    assert.deepEqual(await native(instance.scope, service('standard')), saved);
    await instance.api(endpoint, 'PUT', { api_key: keyA });
    const rotated = await native(instance.scope, service('standard'));
    assert.equal(rotated.matches, true); assert.notEqual(rotated.generation, saved.generation);
    const oversized = await instance.api(endpoint, 'PUT', { api_key: oversizedKey }, 503);
    assert.equal(oversized.error.code, 'ai_credential_unavailable');
    assert.ok(!JSON.stringify(oversized).includes(oversizedKey));
    assert.deepEqual(await native(instance.scope, service('standard')), rotated,
      'Windows blob limit failure must preserve the previous stored key and generation');
    await instance.close();

    instance = await launch('full');
    assert.equal(instance.scope, originalScope, 'same DataDir owner tests edition service isolation');
    assert.deepEqual(await instance.api(endpoint), expected(false));
    await instance.api(endpoint, 'PUT', { api_key: keyB });
    assert.equal((await native(instance.scope, service('full'), 'read', keyB)).matches, true);
    await instance.close();
    await native(originalScope, 'mmusic-studio', 'put-raw', keyB);
    await native(originalScope, 'mmusic-studio', 'put-device', keyB);
    instance = await launch('standard', otherData);
    assert.notEqual(instance.scope, originalScope);
    assert.deepEqual(await instance.api(endpoint), expected(false));
    await instance.close();
    instance = await launch('standard');
    assert.deepEqual(await native(instance.scope, service('standard')), rotated);
    assert.deepEqual(await instance.api(endpoint, 'DELETE'), expected(false));
    assert.deepEqual(await instance.api(endpoint, 'DELETE'), expected(false));
    const legacyAfterStandardDelete = await native(originalScope, 'mmusic-studio');
    assert.equal(legacyAfterStandardDelete.exists, true, 'Standard cannot mutate Full legacy credentials');
    assert.equal(legacyAfterStandardDelete.deviceExists, true);
    await instance.close();
    instance = await launch('standard');
    assert.deepEqual(await instance.api(endpoint), expected(false));
    await instance.close();

    instance = await launch('full');
    assert.deepEqual(await instance.api(endpoint), expected(true));
    assert.equal((await native(instance.scope, service('full'), 'read', keyB)).matches, true);
    await native(instance.scope, service('full'), 'put-device', keyB);
    await instance.api(endpoint, 'DELETE');
    for (const keyringService of [service('full'), 'mmusic-studio']) {
      const cleared = await native(instance.scope, keyringService);
      assert.equal(cleared.exists, false); assert.equal(cleared.deviceExists, false);
    }
    await native(instance.scope, 'mmusic-studio', 'put-raw', keyB);
    await native(instance.scope, 'mmusic-studio', 'put-device', keyB);
    assert.deepEqual(await instance.api(endpoint), expected(true));
    const migrated = await native(instance.scope, service('full'), 'read', keyB);
    assert.equal(migrated.envelope, true); assert.equal(migrated.matches, true);
    assert.equal(migrated.deviceExists, false);
    assert.equal((await native(instance.scope, 'mmusic-studio')).deviceExists, false,
      'clearing an auxiliary field must also remove its legacy fallback');
    assert.deepEqual(await instance.api(endpoint, 'DELETE'), expected(false));
    assert.equal((await native(instance.scope, 'mmusic-studio')).exists, false,
      'successful DELETE must remove legacy fallback and prevent credential resurrection');
    await instance.close();
    instance = await launch('full');
    assert.deepEqual(await instance.api(endpoint), expected(false));
    await native(instance.scope, service('full'), 'put-raw', keyB);
    assert.deepEqual(await instance.api(endpoint), expected(true));
    const rawMigrated = await native(instance.scope, service('full'), 'read', keyB);
    assert.equal(rawMigrated.envelope, true); assert.equal(rawMigrated.matches, true);
    await instance.close();
    instance = await launch('full');
    assert.deepEqual(await native(instance.scope, service('full'), 'read', keyB), rawMigrated);
    await instance.api(endpoint, 'DELETE');
    await instance.close();
    inspect(runDir);
    const allLogs = Buffer.concat(logs);
    for (const key of keys) assert.ok(!allLogs.includes(Buffer.from(key)), 'fixture key in service logs');
  } finally {
    const shutdown = await Promise.allSettled([...children].map(async child => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill(); await bounded(exited, 'fixture cleanup exit');
      }
    }));
    const cleanup = await Promise.allSettled([...scopes].flatMap(scope => services.map(async keyringService => {
      await native(scope, keyringService, 'delete');
      const cleared = await native(scope, keyringService);
      assert.equal(cleared.exists, false); assert.equal(cleared.deviceExists, false);
    })));
    cleanupComplete = shutdown.every(result => result.status === 'fulfilled') &&
      cleanup.every(result => result.status === 'fulfilled');
    if (cleanupComplete) {
      const resolved = fs.realpathSync(runDir);
      assert.equal(path.dirname(resolved), fs.realpathSync(base));
      assert.ok(path.basename(resolved).startsWith('data-'));
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    assert.equal(cleanupComplete, true, 'fixture credential cleanup failed; isolated data directory retained');
  }
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const report = { result: 'passed', at: new Date().toISOString(), platform: process.platform,
    scope: 'Windows Credential Manager, Standard and Full real processes, synthetic keys, null audio, fake provider and generation disabled',
    binaries: Object.fromEntries(Object.entries(bins).map(([edition, binary]) => [edition, { path: binary, sha256: digest(binary) }])),
    sources: Object.fromEntries(['crates/hertz-studio/src/secrets.rs', 'crates/hertz-studio/src/ai/credential.rs',
      'crates/hertz-studio/src/edition.rs', 'scripts/check-ai-credential-keyring.js', 'scripts/windows-ai-credential-probe.ps1']
      .map(file => [file, digest(path.join(root, file))])), cleanupComplete,
    checks: ['native stored record matches submitted synthetic key', 'restart persistence and stable generation',
      'same-key save rotates generation', 'edition services isolated for same DataDir owner', 'different owner isolated',
      'idempotent deletion persists after restart', 'legacy service migration and deletion without resurrection',
      'Standard leaves Full legacy targets intact', 'legacy and current auxiliary fields deleted',
      'Windows blob-limit rejection preserves the previous record and does not echo the key',
      'raw key migration persists after restart', 'no synthetic keys in DataDir or logs', 'exact native targets removed'] };
  const reportPath = path.resolve(process.env.HERTZ_KEYRING_REPORT || path.join(root, 'output', 'ai-credential-keyring.json'));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log('Windows keyring: both editions, native value matching, restart persistence, isolation, migration and deletion passed; fixture credentials removed; no model calls.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
