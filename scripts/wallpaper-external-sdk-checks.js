// SPDX-License-Identifier: MIT
// Official rmcp SDK -> real adapter -> service -> owned native settings fixture.
// NDJSON below is the test driver's control channel, never an MCP transport.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');

const names = ['wallpaper_catalog_get', 'wallpaper_generate_request', 'wallpaper_request_get', 'wallpaper_switch_request'];
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failureSummary = error => String(error.message).split('\n')[0].slice(0, 400);
const operationId = label => 'ai06:' + label + ':' + crypto.randomUUID();
const toolNames = ready => ready.tools.tools.map(tool => tool.name).sort();
const controlResult = result => {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content?.find(item => item.type === 'text');
  assert.ok(content, 'SDK result has structured or JSON text content');
  return JSON.parse(content.text);
};
function safeReceipt(receipt) {
  const allowed = ['requestId', 'operationId', 'state', 'outputKind', 'jobId', 'nativeOperationId', 'createdAt', 'expiresAt', 'errorCode'];
  assert.ok(receipt && typeof receipt === 'object');
  assert.ok(Object.keys(receipt).every(key => allowed.includes(key)), 'receipt contains only its safe projection');
  assert.match(receipt.requestId, uuid); assert.equal(typeof receipt.operationId, 'string');
  assert.ok(Number.isInteger(receipt.createdAt) && Number.isInteger(receipt.expiresAt));
  return receipt;
}
function safeCatalog(catalog) {
  assert.deepEqual(Object.keys(catalog).sort(), ['expiresAt', 'nextCursor', 'targetHandle', 'works']);
  assert.match(catalog.targetHandle, hex); assert.ok(Number.isInteger(catalog.expiresAt));
  assert.ok(Array.isArray(catalog.works) && catalog.works.length <= 32);
  for (const work of catalog.works) {
    assert.deepEqual(Object.keys(work).sort(), ['kind', 'packageHash', 'tags', 'title', 'version', 'workKey']);
    assert.match(work.workKey, /^[A-Za-z0-9_-]{1,128}$/); assert.match(work.packageHash, hex);
    assert.ok(['builtin', 'image', 'video', 'composition'].includes(work.kind));
    assert.ok(Number.isInteger(work.version) && work.version > 0);
    assert.ok(typeof work.title === 'string' && work.title.length > 0);
    assert.ok(Array.isArray(work.tags) && work.tags.every(tag => typeof tag === 'string'));
  }
  return catalog;
}

async function createExternalChecks(context) {
  const { root, output, binary, dataDir, page, api, native, nativeStatus, execute, until, delay, probe, ownerPid, pass } = context;
  const driver = path.resolve(process.env.HERTZ_MCP_SDK_BIN || path.join(root, 'target/debug/examples/wallpaper_mcp_client.exe'));
  assert.ok(fs.existsSync(driver), 'Build the official wallpaper_mcp_client example before external SDK acceptance');
  const report = { passed: false, mode: context.standalone ? 'standalone' : 'embedded', transport: 'official-rmcp-stdio',
    checks: [], errors: [], tools: {}, receipts: [], candidates: [], cleanup: [] };
  const sessions = [], grants = [];
  let closed = false;
  const record = label => { report.checks.push(label); pass('external SDK: ' + label); };
  const persist = () => fs.writeFileSync(path.join(output, 'external-sdk-results.json'), JSON.stringify(report, null, 2));
  persist();

  // A second dialog probe changes only the owned dialog title; all clicks still
  // target the actual PID supplied by the original fixture.
  const switchProbe = path.join(output, 'external-switch-consent.ps1');
  fs.writeFileSync(switchProbe, fs.readFileSync(probe, 'utf8').replaceAll('Hertz 壁纸生成', 'Hertz 壁纸切换'), 'utf8');

  async function session(label, scopes) {
    const created = await api('/v1/ai/grants', 'POST', { label: 'AI06 fixture ' + label, scopes });
    const grantId = created.grant_id;
    assert.match(grantId, uuid); grants.push(grantId);
    const process = spawn(driver, [binary, dataDir, grantId], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...global.process.env, VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory' } });
    // Deliberately drain, never publish process stderr or credential locations.
    process.stderr.resume();
    const lines = readline.createInterface({ input: process.stdout });
    let waiter, queued = [], fatal, ending = false;
    const fail = error => { fatal = error; if (waiter) { waiter.reject(error); waiter = null; } };
    lines.on('line', line => {
      let value;
      try { assert.ok(Buffer.byteLength(line) <= 1024 * 1024); value = JSON.parse(line); }
      catch { fail(new Error('Official SDK driver emitted invalid bounded JSON')); return; }
      if (waiter) { const current = waiter; waiter = null; current.resolve(value); }
      else if (queued.length < 2) queued.push(value);
      else fail(new Error('Unexpected unsolicited SDK control output'));
    });
    process.once('error', () => fail(new Error('Official SDK driver could not start')));
    process.once('exit', () => { if (!ending) fail(new Error('Official SDK driver exited before fixture completion')); });
    process.stdin.on('error', () => fail(new Error('Official SDK driver control input closed')));
    const read = () => {
      if (fatal) return Promise.reject(fatal);
      if (queued.length) return Promise.resolve(queued.shift());
      assert.ok(!waiter, 'one serial SDK call at a time');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiter = null; reject(new Error('Official SDK driver control timeout')); }, 20000);
        waiter = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      });
    };
    const current = { label, grantId, process, async call(name, arguments_) {
      if (fatal) throw fatal;
      const response = read();
      process.stdin.write(JSON.stringify({ name, arguments: arguments_ }) + '\n');
      const result = await response, value = controlResult(result);
      return { isError: result.isError === true, value };
    }, async close() {
      if (ending) return;
      ending = true; process.stdin.end();
      let natural = true;
      try { await until(() => process.exitCode !== null || process.signalCode !== null, 'owned SDK and adapter natural exit', 12000); }
      catch {
        natural = false;
        // Tree termination is confined to the driver created above and its own
        // adapter. Never enumerate or terminate another Hertz process.
        await execute('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }).catch(() => {});
        await until(() => process.exitCode !== null || process.signalCode !== null, 'owned SDK forced exit', 5000);
      }
      lines.close();
      report.cleanup.push({ label, driverPid: process.pid, natural, exitCode: process.exitCode,
        adapterCleanup: natural && process.exitCode === 0 ? 'driver-confirmed' : 'owned-tree-fallback' });
      if (!natural || process.exitCode !== 0) throw new Error('Owned SDK/adapter did not exit cleanly: ' + label);
    } };
    sessions.push(current);
    const ready = await read(); assert.equal(ready.ready, true); assert.ok(ready.peer);
    current.tools = ready.tools.tools; report.tools[label] = toolNames(ready);
    return current;
  }
  async function ok(client, name, input) {
    const result = await client.call(name, input);
    assert.equal(result.isError, false, name + ' failed with ' + result.value?.code);
    return result.value;
  }
  async function denied(client, name, input, codes) {
    const result = await client.call(name, input);
    assert.equal(result.isError, true, name + ' must be rejected');
    assert.ok(codes.includes(result.value.code), name + ' unexpected rejection: ' + result.value.code);
    return result.value.code;
  }
  const get = async (client, id) => safeReceipt(await ok(client, 'wallpaper_request_get', { requestId: id }));
  const generate = async (client, label, brief = '柔和夜色，宁静频谱') => {
    const input = { operationId: operationId(label), brief, outputKind: 'builtin' };
    const receipt = safeReceipt(await ok(client, 'wallpaper_generate_request', input));
    assert.equal(receipt.state, 'pending_confirmation'); assert.equal(receipt.operationId, input.operationId);
    assert.equal(receipt.outputKind, 'builtin'); assert.equal(receipt.jobId, undefined);
    assert.equal(receipt.nativeOperationId, undefined); assert.equal(receipt.expiresAt - receipt.createdAt, 120);
    report.receipts.push(receipt); return { input, receipt };
  };
  async function settle(client, id, expected) {
    return until(async () => {
      const receipt = await get(client, id);
      if (['failed', 'expired', 'interrupted', 'cancelled'].includes(receipt.state) && receipt.state !== expected)
        throw new Error('External request ended unexpectedly: ' + receipt.state + '/' + (receipt.errorCode || ''));
      return receipt.state === expected && receipt;
    }, 'external request ' + expected, 45000, 2100);
  }
  const row = id => page.locator('.external-request-list li[data-request-id="' + id + '"]');
  async function action(id, command) {
    await row(id).locator('button[data-external-action="' + command + '"]:enabled').click();
  }
  async function panel(visible) {
    await page.evaluate(visible => {
      document.getElementById('wallpaper-ai').open = false;
      document.getElementById('wallpaper-generation').open = visible;
    }, visible);
    await delay(150);
    await until(async () => {
      const result = await native('external.panel', { visible });
      return result.ok && result.result.visible === visible;
    }, 'real external panel registration');
    if (visible) await page.locator('.external-wallpaper-requests').waitFor({ state: 'visible' });
  }
  async function installObservation() {
    await page.evaluate(() => {
      if (window.externalFixtureObserverInstalled) return;
      window.externalFixtureObserverInstalled = true; window.externalFixtureConfirmations = [];
      window.externalFixtureConfigurationSerial = 0;
      window.externalFixtureSwitchProgress = [];
      const ai = window.hertzWallpaperAI, progress = ai.applyProgress;
      ai.applyProgress = function (value) {
        window.externalFixtureSwitchProgress.push(value);
        return progress.call(this, value);
      };
      const settings = hertzWallpaperSettings, request = settings.requestManagement, apply = settings.applyStatus;
      settings.applyStatus = function (payload) {
        if (payload?.config) {
          window.externalFixtureConfiguration = { revision: payload.revision, config: payload.config };
          window.externalFixtureConfigurationSerial++;
        }
        return apply.call(this, payload);
      };
      settings.requestManagement = async function (command, payload, ...args) {
        try {
          const receipt = await request.call(this, command, payload, ...args);
          if (command === 'wallpaper.ai.generate.confirm' || command === 'wallpaper.ai.external.confirm')
            window.externalFixtureConfirmations.push({ command, requestId: payload.externalRequestId || payload.requestId, ok: receipt.ok, result: receipt.result });
          return receipt;
        } catch (error) {
          if (command === 'wallpaper.ai.generate.confirm' || command === 'wallpaper.ai.external.confirm')
            window.externalFixtureConfirmations.push({ command, requestId: payload.externalRequestId || payload.requestId, ok: false, errorCode: error.code });
          throw error;
        }
      };
      window.ipc.postMessage(JSON.stringify({ cmd: 'status' }));
    });
    await until(() => page.evaluate(() => !!window.externalFixtureConfiguration), 'native configuration observation');
  }
  async function configuration() {
    const previous = await page.evaluate(() => {
      const serial = window.externalFixtureConfigurationSerial;
      window.ipc.postMessage(JSON.stringify({ cmd: 'status' }));
      return serial;
    });
    return until(() => page.evaluate(previous => window.externalFixtureConfigurationSerial > previous && window.externalFixtureConfiguration, previous), 'original saved native configuration');
  }
  function allFixtureJobs() {
    // The official jobs route intentionally lists only local-owner jobs. Read
    // the owned fixture's original store to include native-session generation.
    // No grant, credentials, input, proof or provider secret columns are read.
    const database = new DatabaseSync(path.join(dataDir, 'vmusic.db'), { readOnly: true });
    try {
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000;');
      return { jobs: database.prepare('SELECT job_id AS jobId, capability, state, state_revision AS stateRevision, dispatch_state AS dispatchState, provider, model FROM ai_jobs ORDER BY job_id').all().map(item => ({ ...item })) };
    } finally { database.close(); }
  }
  async function effects() {
    const [ledger, config] = await Promise.all([api('/v1/ai/ledger'), configuration()]);
    return { jobs: allFixtureJobs(), entries: ledger.entries, budget: ledger.budget, config };
  }
  async function unchanged(before, label) { assert.deepEqual(await effects(), before, label); }
  async function consent(title, button) {
    const output = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', title === 'switch' ? switchProbe : probe,
      '-TargetPid', String(ownerPid), '-Button', String(button)], { windowsHide: true, timeout: 25000, encoding: 'utf8' });
    const text = JSON.parse(output.stdout.trim());
    assert.ok(text.some(item => item.includes('default=7')), 'real native consent defaults to No');
    if (title === 'generation') assert.ok(text.some(item => item.includes('免费')), 'external generation uses free fake');
    return text;
  }
  async function quote(id) {
    await page.waitForFunction(() => document.getElementById('wallpaper-generation').getAttribute('aria-busy') !== 'true');
    await action(id, 'open');
    await page.waitForFunction(() => document.getElementById('wallpaper-generation').getAttribute('aria-busy') !== 'true');
    await page.waitForSelector('#generation-quote:enabled');
    await page.locator('#generation-quote').click(); await page.waitForSelector('#generation-confirm:enabled');
    assert.match(await page.locator('#generation-price-text').innerText(), /免费/);
  }
  async function confirmGeneration(id, button) {
    await page.locator('#generation-confirm').click(); await consent('generation', button);
    return until(() => page.evaluate(id => window.externalFixtureConfirmations.find(receipt => receipt.requestId === id), id), 'external native generation confirmation');
  }

  async function beforePairing() {
    try {
      await installObservation(); await panel(true);
      assert.equal((await nativeStatus()).connected, false);
      const client = await session('unpaired', ['wallpaper:request']);
      assert.deepEqual(report.tools.unpaired, ['wallpaper_generate_request', 'wallpaper_request_get']);
      const before = await effects(), pending = await generate(client, 'unpaired');
      await action(pending.receipt.requestId, 'open');
      await page.waitForSelector('#generation-connect:enabled');
      assert.equal(await page.locator('#generation-brief').inputValue(), pending.input.brief);
      assert.equal(await page.locator('#generation-brief').isDisabled(), true);
      assert.equal(await page.locator('#generation-quote').isDisabled(), true);
      assert.equal((await nativeStatus()).connected, false);
      await unchanged(before, 'unpaired external generation only offers the original connection entry');
      await action(pending.receipt.requestId, 'reject');
      report.receipts.push(await settle(client, pending.receipt.requestId, 'rejected'));
      await client.close();
      record('unpaired generate opens only the original connection entry; rejection creates no job, usage or configuration');
      // End this document's form association through the normal navigation
      // lifecycle. The original generation regression then starts a fresh form.
      await page.reload(); await page.waitForSelector('#generation-connect', { state: 'attached' });
      await page.locator('#wallpaper-generation > summary').click();
    } catch (error) { report.errors.push(failureSummary(error)); persist(); throw error; }
  }

  async function run(saved) {
    try {
      await installObservation(); await panel(true); assert.equal((await nativeStatus()).connected, true);
      const full = await session('full', ['wallpaper:catalog_read', 'wallpaper:request']);
      const requestOnly = await session('request-only', ['wallpaper:request']);
      const catalogOnly = await session('catalog-only', ['wallpaper:catalog_read']);
      const legacy = await session('legacy', ['playback:read']);
      assert.deepEqual(report.tools.full, [...names].sort());
      assert.deepEqual(report.tools['request-only'], ['wallpaper_generate_request', 'wallpaper_request_get']);
      assert.deepEqual(report.tools['catalog-only'], ['wallpaper_catalog_get']);
      assert.ok(report.tools.legacy.every(name => !names.includes(name)));
      for (const tool of full.tools) {
        assert.equal(tool.inputSchema.additionalProperties, false);
        assert.equal(tool.annotations?.readOnlyHint, tool.name === 'wallpaper_catalog_get' || tool.name === 'wallpaper_request_get');
        assert.equal(tool._meta?.budgetClass, 'no_provider_call');
        const scopes = tool.name === 'wallpaper_catalog_get' ? ['wallpaper:catalog_read']
          : tool.name === 'wallpaper_switch_request' ? ['wallpaper:request', 'wallpaper:catalog_read'] : ['wallpaper:request'];
        assert.deepEqual(tool._meta?.requiredScopes, scopes);
        if (tool.name === 'wallpaper_switch_request' || tool.name === 'wallpaper_generate_request')
          assert.ok(tool.inputSchema.required.includes('operationId'));
      }
      const scopeCodes = ['scope_required', 'capability_unsupported'];
      await denied(requestOnly, 'wallpaper_catalog_get', {}, scopeCodes);
      await denied(requestOnly, 'wallpaper_switch_request', { operationId: operationId('no-scope'), workKey: saved.workKey, packageHash: saved.packageHash, targetHandle: 'a'.repeat(64) }, scopeCodes);
      await denied(legacy, 'wallpaper_generate_request', { operationId: operationId('legacy'), brief: 'fixture', outputKind: 'builtin' }, scopeCodes);
      record('four tools advertise explicit scopes and read/mutate schemas; request-only and legacy grants do not gain catalog or switch');

      let catalog = safeCatalog(await ok(full, 'wallpaper_catalog_get', { limit: 32 }));
      let work = catalog.works.find(item => item.workKey === saved.workKey && item.packageHash === saved.packageHash);
      assert.ok(work, 'safe catalog contains the original saved immutable package');
      assert.match(work.workKey, /^local-[a-f0-9-]{36}$/); assert.equal(work.title, saved.title);
      assert.equal(work.kind, 'builtin'); assert.equal(work.version, 1);
      report.candidates.push(work); report.catalogHash = sha(catalog.works);
      record('safe catalog retains exact local workKey, package SHA, title, tags, kind and version without paths or display identifiers');

      let before = await effects();
      await denied(full, 'wallpaper_generate_request', { brief: 'missing operation', outputKind: 'builtin' }, ['invalid_request']);
      const pending = await generate(full, 'idempotent', '<img src=x onerror="window.externalFixtureInjection=true"> 宁静夜色');
      assert.deepEqual(safeReceipt(await ok(full, 'wallpaper_generate_request', pending.input)), pending.receipt);
      assert.deepEqual(await get(full, pending.receipt.requestId), pending.receipt);
      await denied(full, 'wallpaper_generate_request', { ...pending.input, brief: 'different digest' }, ['request_conflict']);
      await denied(requestOnly, 'wallpaper_request_get', { requestId: pending.receipt.requestId }, ['request_not_found']);
      await row(pending.receipt.requestId).waitFor({ state: 'visible' });
      assert.equal(await row(pending.receipt.requestId).locator('img').count(), 0);
      assert.equal(await page.evaluate(() => !!window.externalFixtureInjection), false);
      assert.ok((await row(pending.receipt.requestId).innerText()).includes(pending.input.brief));
      await unchanged(before, 'pending request, same-key readback and invalid inputs create no effects');
      await action(pending.receipt.requestId, 'reject');
      report.receipts.push(await settle(full, pending.receipt.requestId, 'rejected'));
      await unchanged(before, 'explicit reject creates no effects');
      record('required operationId, same digest readback, changed digest conflict, cross-grant receipt refusal and text-only cards; pending/reject have no effects');

      // Each limit has a fresh grant, so earlier scenarios cannot consume the
      // measured minute window. A different grant tests the fifth global slot.
      const capacity = await session('capacity', ['wallpaper:request']);
      const fifth = await session('fifth-slot', ['wallpaper:request']);
      before = await effects();
      const active = [];
      for (let index = 0; index < 4; index++) active.push(await generate(capacity, 'slot-' + index));
      await denied(fifth, 'wallpaper_generate_request', { operationId: operationId('fifth-slot'), brief: 'fixture', outputKind: 'builtin' }, ['requests_full']);
      for (const item of active) {
        await action(item.receipt.requestId, 'reject'); report.receipts.push(await settle(capacity, item.receipt.requestId, 'rejected'));
      }
      await denied(capacity, 'wallpaper_generate_request', { operationId: operationId('fifth-minute'), brief: 'fixture', outputKind: 'builtin' }, ['rate_limited']);
      await unchanged(before, 'four pending slots, refusals and rate limit create no effects');
      await capacity.close(); await fifth.close();
      record('four global pending slots reject the fifth grant; after rejection the fifth admission within a minute is rate limited');

      const hidden = await session('hidden-panel', ['wallpaper:request']);
      before = await effects(); await panel(false);
      await denied(hidden, 'wallpaper_generate_request', { operationId: operationId('hidden'), brief: 'fixture', outputKind: 'builtin' }, ['desktop_unavailable']);
      await unchanged(before, 'hidden panel refuses new requests');
      await panel(true); await hidden.close();
      catalog = safeCatalog(await ok(full, 'wallpaper_catalog_get', { limit: 32 }));
      const cross = await session('cross-grant', ['wallpaper:catalog_read', 'wallpaper:request']);
      await denied(cross, 'wallpaper_switch_request', { operationId: operationId('cross-handle'), workKey: work.workKey, packageHash: work.packageHash, targetHandle: catalog.targetHandle }, ['target_expired']);
      await cross.close();
      record('hidden real panel refuses admission and a current targetHandle is rejected for another grant');

      const generation = await session('generation', ['wallpaper:request']);
      before = await effects();
      const candidatesBefore = (await native('candidates')).result.candidates;
      const no = await generate(generation, 'generation-no'); await quote(no.receipt.requestId);
      await unchanged(before, 'entering original form and quoting do not create a task');
      const cancelled = await confirmGeneration(no.receipt.requestId, 7);
      assert.equal(cancelled.ok, false); assert.equal(cancelled.errorCode, 'generation_cancelled');
      report.receipts.push(await settle(generation, no.receipt.requestId, 'rejected'));
      await unchanged(before, 'native default-No rejection creates no task, usage or config');
      assert.equal(await page.locator('#generation-confirm').isVisible(), false);
      const yes = await generate(generation, 'generation-yes'); await quote(yes.receipt.requestId);
      const accepted = await confirmGeneration(yes.receipt.requestId, 6);
      assert.equal(accepted.ok, true);
      const nativeJob = accepted.result.job || accepted.result;
      assert.ok(nativeJob.jobId);
      const generated = await settle(generation, yes.receipt.requestId, 'succeeded');
      assert.equal(generated.jobId, nativeJob.jobId); assert.equal(generated.nativeOperationId, undefined);
      const after = await effects(), beforeIds = new Set(before.jobs.jobs.map(job => job.jobId));
      const newJobs = after.jobs.jobs.filter(job => !beforeIds.has(job.jobId));
      assert.equal(newJobs.length, 1); assert.equal(newJobs[0].jobId, nativeJob.jobId);
      assert.deepEqual(after.config, before.config, 'generation never applies a wallpaper');
      const candidates = (await native('candidates')).result.candidates;
      assert.deepEqual(candidates, candidatesBefore, 'generation does not automatically receive or save a candidate');
      report.receipts.push(generated); report.generatedJobId = nativeJob.jobId;
      await generation.close();
      record('original quote and default-No reject without effects; a new request and new quote Yes produce one original job linked to SDK succeeded receipt, without receive/save/apply');

      // A fresh catalog accompanies each explicit switch; no mutation retries.
      const switches = await session('switch', ['wallpaper:catalog_read', 'wallpaper:request']);
      async function switchRequest(label) {
        const current = safeCatalog(await ok(switches, 'wallpaper_catalog_get', { limit: 32 }));
        const exact = current.works.find(item => item.workKey === saved.workKey && item.packageHash === saved.packageHash);
        assert.ok(exact);
        const receipt = safeReceipt(await ok(switches, 'wallpaper_switch_request', { operationId: operationId(label), workKey: exact.workKey, packageHash: exact.packageHash, targetHandle: current.targetHandle }));
        assert.equal(receipt.state, 'pending_confirmation'); assert.equal(receipt.jobId, undefined); return { receipt, exact };
      }
      before = await effects();
      const switchNo = await switchRequest('switch-no'); await unchanged(before, 'pending switch creates no config');
      await action(switchNo.receipt.requestId, 'confirm'); await consent('switch', 7);
      report.receipts.push(await settle(switches, switchNo.receipt.requestId, 'rejected'));
      await unchanged(before, 'default-No switch preserves config and jobs');
      const switchYes = await switchRequest('switch-yes');
      const targetGroup = await page.evaluate(() => hertzWallpaperSettings.currentAiContext().groupId);
      await action(switchYes.receipt.requestId, 'confirm');
      const switchText = await consent('switch', 6);
      assert.ok(switchText.some(item => item.includes(switchYes.exact.title) && item.includes('v' + switchYes.exact.version)));
      const switched = await settle(switches, switchYes.receipt.requestId, 'succeeded');
      assert.equal(switched.nativeOperationId, switchYes.receipt.requestId); assert.equal(switched.jobId, undefined);
      const operation = await until(async () => {
        const response = await page.evaluate(async requestId => {
          try { return await hertzWallpaperSettings.requestManagement('wallpaper.operations.get', { requestId, command: 'wallpaper.ai.confirm' }); }
          catch (error) { return { ok: false, errorCode: error.code }; }
        }, switched.nativeOperationId);
        let value = response.result;
        if (value?.protocol === 2) value = value.result;
        return response.ok && value?.saved === true && value;
      }, 'original switch configuration receipt');
      assert.equal(operation.requestId, switched.nativeOperationId); assert.equal(operation.command, 'wallpaper.ai.confirm');
      const progress = await until(() => page.evaluate(requestId => window.externalFixtureSwitchProgress.find(item => item.requestId === requestId && item.saved), switched.nativeOperationId), 'original native switch progress');
      assert.equal(progress.packageHash, saved.packageHash); assert.equal(progress.workKey, saved.workKey);
      assert.equal(progress.groupId, targetGroup); assert.equal(progress.configRevision, operation.configRevision);
      await until(async () => (await configuration()).revision > before.config.revision, 'native switch config revision');
      const switchedConfig = await configuration(), target = switchedConfig.config.groups.find(group => group.id === targetGroup);
      assert.equal(target.selection.kind, 'package'); assert.equal(target.selection.packageHash, saved.packageHash);
      assert.equal(target.selection.workKey, saved.workKey);
      assert.deepEqual((await effects()).jobs, before.jobs, 'switching never creates a generation job');
      report.receipts.push(switched); report.switchOperation = { requestId: operation.requestId, command: operation.command,
        workKey: progress.workKey, packageHash: progress.packageHash, saved: operation.saved, configRevision: operation.configRevision };
      report.appliedConfigurationHash = sha(switchedConfig.config);
      await switches.close();
      record('switch default-No leaves config intact; new request and fresh targetHandle Yes commit the exact work/version through the original config operation and safe SDK receipt');

      const revoked = await session('revoke-before-confirm', ['wallpaper:catalog_read', 'wallpaper:request']);
      catalog = safeCatalog(await ok(revoked, 'wallpaper_catalog_get', { limit: 32 }));
      work = catalog.works.find(item => item.workKey === saved.workKey && item.packageHash === saved.packageHash);
      const revokeRequest = safeReceipt(await ok(revoked, 'wallpaper_switch_request', { operationId: operationId('revoked'), workKey: work.workKey, packageHash: work.packageHash, targetHandle: catalog.targetHandle }));
      before = await effects(); await api('/v1/ai/grants/' + revoked.grantId, 'DELETE');
      grants.splice(grants.indexOf(revoked.grantId), 1);
      await denied(revoked, 'wallpaper_request_get', { requestId: revokeRequest.requestId }, ['grant_revoked', 'unauthorized', 'not_connected']);
      await action(revokeRequest.requestId, 'confirm'); await consent('switch', 6);
      await until(() => page.evaluate(id => window.externalFixtureConfirmations.some(item => item.requestId === id && item.ok === false), revokeRequest.requestId), 'revoked grant confirmation rejected');
      await unchanged(before, 'revocation before confirmation prevents original config acceptance');
      await revoked.close();
      // Retire the rejected fixture request through the existing panel owner.
      await action(revokeRequest.requestId, 'reject');
      record('revocation wins before native acceptance; SDK lookup and one explicit native confirmation fail without retry or effects');

      await panel(false); report.passed = true; persist();
    } catch (error) { report.errors.push(failureSummary(error)); report.passed = false; persist(); throw error; }
  }
  async function close() {
    if (closed) return; closed = true;
    for (const client of sessions) {
      try { await client.close(); }
      catch (error) { report.errors.push(failureSummary(error)); report.passed = false; }
    }
    for (const grant of grants) {
      try { await api('/v1/ai/grants/' + grant, 'DELETE'); }
      catch { report.errors.push('Owned external fixture grant cleanup failed'); report.passed = false; }
    }
    persist();
    if (report.errors.length) throw new Error('External SDK acceptance failed; see its sanitized report');
  }
  return { beforePairing, run, close };
}

module.exports = { createExternalChecks };
