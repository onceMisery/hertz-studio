// SPDX-License-Identifier: MIT
// Isolated service + in-memory secrets + real browser. No cloud requests/keys.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { uiToken, uiUrl } = require('./ui-token');
const endpoint = '/v1/ai/provider-credential';
const synthetic = 'fixture-credential-never-a-real-key';
const stepfun = process.argv.includes('--stepfun');
const providerId = stepfun ? 'stepfun' : 'openai';
const providerName = stepfun ? 'StepFun' : 'OpenAI';
const origin = stepfun ? 'https://api.stepfun.com/step_plan/v1' : 'https://api.openai.com';
const output = path.resolve(__dirname, '../output/playwright/ai-credential' + (stepfun ? '-stepfun' : ''));

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const fixture = await startFixture(stepfun ? {
    prepareData(data) {
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(data, 'config.toml'), '[ai]\nprovider="stepfun"\norigin="' + origin + '"\nmodel="step-5-preview"\n');
    }
  } : {});
  process.env.VMUSIC_DATA_DIR = fixture.dataDir;
  let browser;
  try {
    const expected = configured => ({ provider: providerId, origin, configured });
    assert.deepEqual(await fixture.api(endpoint), expected(false));
    assert.equal((await fetch(fixture.base + endpoint)).status, 401);
    const grant = await fixture.api('/v1/ai/grants', 'POST', { label: 'credential-denied-fixture', scopes: ['playback:read'] });
    const bearer = fs.readFileSync(grant.credential_path, 'utf8').trim();
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await fetch(fixture.base + endpoint, {
        method, headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
        body: method === 'PUT' ? JSON.stringify({ api_key: synthetic }) : undefined,
      });
      assert.equal(response.status, 401, 'restricted grants cannot manage keys');
      assert.ok(!(await response.text()).includes(synthetic));
    }
    assert.deepEqual(await fixture.api(endpoint), expected(false));

    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
    await fixture.connect(context);
    for (const [data, status] of [
      [JSON.stringify({ api_key: synthetic, origin: 'https://invalid.example' }), 400],
      ['{"api_key":"' + synthetic + '","api_key":"duplicate"}', 400],
      ['{"api_key":"' + synthetic + '"', 400],
      [JSON.stringify({ api_key: 'x'.repeat(9000) }), 413],
    ]) {
      const response = await context.request.put(fixture.base + endpoint, { data, headers: { Authorization: 'Bearer ' + uiToken(), 'Content-Type': 'application/json' } });
      assert.equal(response.status(), status);
      assert.ok(!(await response.text()).includes(synthetic));
    }
    for (const key of ['openai_api_key', 'ai_api_key', 'ai_provider_cred_v1_private-fixture']) {
      const response = await context.request.put(fixture.base + '/v1/settings', { data: { [key]: synthetic }, headers: { Authorization: 'Bearer ' + uiToken() } });
      assert.equal(response.status(), 400);
      assert.ok(!(await response.text()).includes(synthetic));
    }
    const page = await context.newPage(), errors = [], writes = [], responses = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.url().includes('/v1/ai/') && request.method() !== 'GET') writes.push({ url: request.url(), method: request.method() });
    });
    page.on('response', response => {
      if (response.url().endsWith(endpoint)) responses.push(response.text().catch(() => ''));
    });
    await page.goto(uiUrl(fixture.base), { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('ai'); });
    const panel = page.locator('.ws-ai-credential');
    await panel.locator('summary').click();
    await page.getByText(`尚未配置 ${providerName} 密钥。`, { exact: true }).waitFor();
    const input = page.getByLabel(`${providerName} API key`, { exact: true });
    assert.equal(await input.getAttribute('type'), 'password');
    assert.ok((await panel.innerText()).includes(origin), 'display the bound credential destination');
    await input.fill(synthetic);
    await page.getByRole('button', { name: `保存 ${providerName} 密钥`, exact: true }).click();
    await page.getByText(`已配置 ${providerName} 密钥；云端生成尚未启用。`, { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '');
    assert.deepEqual(await fixture.api(endpoint), expected(true));
    assert.equal((await fixture.api('/v1/ai/status')).consent.inAppGeneration, false);
    assert.deepEqual((await fixture.api('/v1/ai/jobs')).jobs, []);
    assert.ok(!JSON.stringify(await fixture.api('/v1/settings')).includes(synthetic));
    assert.ok(!(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).includes(synthetic));

    // No secret survives closing, changing tabs, or a hidden page.
    await input.fill(synthetic);
    await page.evaluate(() => Workshop.close());
    assert.equal(await input.inputValue(), '');
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('ai'); });
    await panel.locator('summary').click();
    await page.getByText(`已配置 ${providerName} 密钥；云端生成尚未启用。`, { exact: true }).waitFor();
    await input.fill(synthetic);
    await page.evaluate(() => Workshop.setTab('io'));
    assert.equal(await page.locator('#ws-ai-key').count(), 0);
    await page.evaluate(() => Workshop.setTab('ai'));
    await panel.locator('summary').click();
    await page.getByText(`已配置 ${providerName} 密钥；云端生成尚未启用。`, { exact: true }).waitFor();

    await input.fill(synthetic);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Hiding rebuilds the panel before its destination has been queried again.
    assert.equal(await page.locator('#ws-ai-key').inputValue(), '', 'controlled hide event clears the input');
    await panel.locator('summary').click();
    await page.getByText(`已配置 ${providerName} 密钥；云端生成尚未启用。`, { exact: true }).waitFor();

    let getCount = 0;
    await page.route('**' + endpoint, async route => {
      if (route.request().method() === 'GET') {
        getCount++;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ai_credential_unavailable', message: synthetic, request_id: 'credential-fixture' } }) });
      } else await route.continue();
    });
    await page.getByRole('button', { name: '查询密钥状态', exact: true }).click();
    await page.getByText(/系统钥匙串不可用.*credential-fixture/).waitFor();
    assert.equal(getCount, 1, 'keyring errors are not automatically retried');
    assert.ok(!(await panel.innerText()).includes(synthetic), 'even a hostile error body cannot echo the key');
    assert.equal(await page.getByRole('button', { name: `删除 ${providerName} 密钥`, exact: true }).isDisabled(), true, 'unknown destination disables mutation');
    await page.unroute('**' + endpoint);
    await page.getByRole('button', { name: '查询密钥状态', exact: true }).click();
    await page.getByText(`已配置 ${providerName} 密钥；云端生成尚未启用。`, { exact: true }).waitFor();
    await page.getByRole('button', { name: `删除 ${providerName} 密钥`, exact: true }).click();
    await page.getByText(`尚未配置 ${providerName} 密钥。`, { exact: true }).waitFor();
    assert.deepEqual(await fixture.api(endpoint), expected(false));
    assert.deepEqual(await fixture.api(endpoint, 'DELETE'), expected(false));
    assert.deepEqual(writes.map(item => item.method), ['PUT', 'DELETE']);
    assert.ok(writes.every(item => item.url.endsWith(endpoint)), 'no generation request');
    // Only successful status replies are inspected; the deliberately hostile
    // browser interception above is not a reply from the product server.
    const replyBodies = await Promise.all(responses);
    assert.equal(replyBodies.filter(body => body.includes(synthetic)).length, 1);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, 'credential-' + width + '.png') });
      assert.equal(await panel.evaluate(el => el.scrollWidth > el.clientWidth + 1), false, 'narrow credential panel');
    }
    function inspectFiles(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) inspectFiles(file);
        else assert.ok(!fs.readFileSync(file).includes(Buffer.from(synthetic)), 'synthetic key must not be persisted');
      }
    }
    inspectFiles(fixture.dataDir);
    assert.deepEqual(errors, []);
    console.log('AI credential: auth, write-only memory backend, secret clearing, errors, no jobs, storage and narrow UI passed; no OS keyring/cloud acceptance.');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
