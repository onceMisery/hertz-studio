// SPDX-License-Identifier: MIT
// Real Hertz service + controlled loopback Ollama HTTP server + official UI.
// Verifies adapter wiring, never model quality or an installed Ollama runtime.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { uiUrl } = require('./ui-token');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(probe, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(40);
  }
  throw new Error('Timed out: ' + label);
}

async function main() {
  const requests = [];
  const held = [];
  const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const parts = [];
      for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts));
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      const brief = body.messages[1].content;
      const reply = () => {
        let content = JSON.stringify({ version: 1, scene: 'orb', patch: { 'sc.radius': 2 } });
        let reason = 'stop';
        if (brief.includes('duplicate')) content = '{"version":1,"scene":"orb","scene":"towers","patch":{}}';
        if (brief.includes('unsupported')) content = '{"unsupported":true}';
        if (brief.includes('truncated')) reason = 'length';
        if (brief.includes('redirect')) {
          res.writeHead(307, { Location: '/should-never-follow' });
          res.end('private-provider-error');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'fixture-local', done: true, done_reason: reason,
          message: { role: 'assistant', content }, prompt_eval_count: 876, eval_count: 45 }));
      };
      if (brief.includes('hold')) {
        const pending = { reply, closed: false };
        res.on('close', () => { pending.closed = true; });
        held.push(pending);
      }
      else reply();
    } catch (error) {
      errors.push(error);
      res.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  let fixture;
  let invalid;
  let browser;
  try {
    fixture = await startFixture({ prepareData(data) {
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(data, 'config.toml'),
        '[ai]\nprovider = "ollama"\norigin = "' + origin + '"\nmodel = "fixture-local"\n');
    } });
    process.env.VMUSIC_DATA_DIR = fixture.dataDir;
    const status = await fixture.api('/v1/ai/status');
    assert.equal(status.provider.id, 'ollama-local');
    assert.equal(status.provider.model, 'fixture-local');
    assert.equal(status.provider.ready, true);
    assert.equal(status.consent.inAppGeneration, false);
    assert.equal(requests.length, 0, 'boot/status must never contact the model');

    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await fixture.connect(context);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error));
    await page.goto(uiUrl(fixture.base), { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('ai'); });
    await page.getByText('当前使用本地 Ollama 模型：', { exact: false }).waitFor();
    assert.equal(await page.locator('#ws-ai-brief').isDisabled(), true);
    await page.getByRole('button', { name: '开启生成', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#ws-ai-brief').disabled);
    await page.locator('#ws-ai-brief').fill('a dark static orb');
    await page.getByRole('button', { name: '提交生成任务', exact: true }).click();
    await page.getByRole('button', { name: '查看提案', exact: true }).first().waitFor();
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/chat');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.body.stream, false);
    assert.equal(request.body.think, false);
    assert.equal(request.body.options.num_predict, 512);
    assert.equal(request.body.messages.length, 2);
    assert.equal(request.body.messages[1].content, 'a dark static orb');
    assert.match(request.body.messages[0].content, /basePresetHashes/);
    assert.equal(request.body.tools, undefined);
    const generated = (await fixture.api('/v1/ai/jobs?limit=20')).jobs[0];
    assert.equal(generated.state, 'succeeded');
    assert.equal(generated.usage.usageState, 'reported');
    assert.equal(generated.usage.accountedMicroUsd, 0);
    assert.equal(generated.usage.reservationMicroUsd, 0);
    const proposal = await fixture.api('/v1/ai/proposals/' + generated.resultProposalId);
    assert.equal(proposal.validatedIntent.scene, 'orb');
    assert.ok(proposal.artifact.schemaHash);
    await page.getByRole('button', { name: '查看提案', exact: true }).first().click();
    const committed = await page.evaluate(() => CreativeStage.preset());
    await page.locator('.ws-ai-proposal').getByRole('button', { name: '预览候选舞台' }).click();
    await page.locator('.ws-ai-proposal').getByRole('button', { name: '应用到当前舞台' }).waitFor();
    assert.deepEqual(await page.evaluate(() => CreativeStage.preset()), committed);
    await page.evaluate(() => Workshop.close());

    async function submit(brief) {
      return (await fixture.api('/v1/ai/jobs', 'POST', { brief })).job;
    }
    async function terminal(id) {
      return until(async () => {
        const job = await fixture.api('/v1/ai/jobs/' + id);
        return !['accepted', 'running'].includes(job.state) && job;
      }, 'terminal task ' + id);
    }
    for (const brief of ['duplicate output', 'unsupported sequence', 'truncated result', 'redirect result']) {
      const count = requests.length;
      const job = await submit(brief);
      const done = await terminal(job.jobId);
      assert.equal(done.state, 'failed');
      assert.equal(done.resultProposalId, null);
      assert.equal(done.usage.usageState, brief.includes('redirect') ? 'unknown' : 'reported');
      assert.equal(requests.length, count + 1, 'no repair, redirect or POST retry');
    }

    const heldJob = await submit('hold the local model response');
    await until(() => held.length === 1, 'model request in flight');
    const running = await fixture.api('/v1/ai/jobs/' + heldJob.jobId);
    assert.equal(running.state, 'running');
    const queued = await submit('do not dispatch after disabling generation');
    assert.equal((await fixture.api('/v1/ai/jobs/' + queued.jobId)).state, 'accepted');
    await fixture.api('/v1/settings', 'PUT', { ai_generation_consent: false });
    const callsBeforeCancel = requests.length;
    const cancelled = await fixture.api('/v1/ai/jobs/' + heldJob.jobId + '/cancel', 'POST',
      { expected_state_revision: running.stateRevision });
    assert.equal(cancelled.state, 'cancelled');
    await until(() => held[0].closed, 'cancelled model HTTP connection closed');
    held.shift().reply();
    const late = await fixture.api('/v1/ai/jobs/' + heldJob.jobId);
    assert.equal(late.state, 'cancelled');
    assert.equal(late.resultProposalId, null);
    assert.equal(late.usage.usageState, 'unknown', 'closed transport cannot invent remote usage');
    assert.equal((await terminal(queued.jobId)).usage.usageState, 'released');
    assert.equal(requests.length, callsBeforeCancel, 'disabled queued task cannot contact the model');
    await fixture.api('/v1/settings', 'PUT', { ai_generation_consent: true });
    const resumed = await submit('new local model request after cancellation');
    assert.equal((await terminal(resumed.jobId)).state, 'succeeded');
    assert.equal(requests.length, callsBeforeCancel + 1, 'cancelled request relinquishes execution slot after transport exits');
    const ledger = await fixture.api('/v1/ai/ledger');
    assert.equal(ledger.budget.chargedMicroUsd, '0');
    assert.equal(ledger.budget.reservedMicroUsd, '0');

    invalid = await startFixture({ prepareData(data) {
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(data, 'config.toml'),
        '[ai]\nprovider="ollama"\norigin="https://example.com"\nmodel="fixture-local"\n');
    } });
    const invalidStatus = await invalid.api('/v1/ai/status');
    assert.equal(invalidStatus.provider.id, 'unavailable');
    assert.equal(invalidStatus.provider.ready, false);
    assert.ok(invalidStatus.provider.diagnostic);
    assert.deepEqual(errors, []);
    const root = path.resolve(__dirname, '..');
    const binary = path.resolve(process.env.HERTZ_BIN || path.join(root, 'target', 'debug',
      process.platform === 'win32' ? 'hertz-studio.exe' : 'hertz-studio'));
    const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const reportPath = path.resolve(process.env.HERTZ_PROVIDER_BROWSER_REPORT ||
      path.join(root, 'output', 'ai-provider-browser.json'));
    const report = { result: 'passed', at: new Date().toISOString(),
      scope: 'isolated service and real Chrome, controlled Ollama HTTP, memory secrets, null audio; no actual model',
      binary, binarySha256: digest(binary), harnessSha256: digest(__filename),
      sources: Object.fromEntries(['jobs.rs', 'provider.rs', 'evaluation.rs'].map(name =>
        [name, digest(path.join(root, 'crates/hertz-studio/src/ai', name))])),
      checks: ['explicit consent and request data scope', 'preview isolation', 'zero-price ledger',
        'invalid, duplicate, truncated and refused output', 'no redirect or POST retry',
        'cancelled request closes real HTTP before server reply', 'missing usage stays unknown',
        'disabled queued job never dispatches', 'execution resumes after transport exits'] };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log('Local provider: configured real HTTP/UI path, explicit consent, schema/data scope, preview isolation, zero-price ledger, invalid/duplicate/truncated/refused output, no redirect/retry, cancellation closes real HTTP, unknown usage, execution recovery and disabled queue passed (controlled Ollama fixture; no model-quality claim)');
  } finally {
    held.splice(0).forEach(pending => pending.reply());
    if (browser) await browser.close();
    if (invalid) await invalid.close();
    if (fixture) await fixture.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
