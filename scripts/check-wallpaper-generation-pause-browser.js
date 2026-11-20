// SPDX-License-Identifier: MIT
// Production generation UI in Chromium; fixture transport never contacts a provider.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output/offline-design-completion/ai-pause');
fs.mkdirSync(out, { recursive: true });
const html = fs.readFileSync(path.join(root, 'crates/hertz-desktop/assets/wallpaper-settings.html'), 'utf8');
const panel = html.match(/<details id="wallpaper-generation"[\s\S]*?<\/details>/)[0];
const css = fs.readFileSync(path.join(root, 'crates/hertz-desktop/assets/wallpaper-ai.css'), 'utf8');
const source = fs.readFileSync(path.join(root, 'crates/hertz-desktop/assets/wallpaper-ai.js'), 'utf8');
const checks = [];

async function fixture(browser, width = 800) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent(`<style>:root{--line:#555;--muted:#bbb;--text:#eee;--control:#252525;--accent:#aaa}body{font:14px system-ui;background:#181818;color:#eee;margin:20px}button{font:inherit;padding:10px}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid white} [hidden]{display:none!important}${css}</style><section role="tabpanel">${panel}</section>`);
  await page.evaluate(() => {
    const state = window.fixture = { calls: [], connected: true, provider: 'ollama-local', context: 1, job: null, pause: null };
    window.hertzWallpaperSettings = {
      currentAiContext: () => ({ groupId: 'main', revision: state.context, profile: 'offline' }),
      releasePreview() {},
      async requestManagement(command, payload = {}) {
        state.calls.push({ command, payload: structuredClone(payload) });
        let result;
        if (command.endsWith('.invalidate')) result = {};
        else if (command.endsWith('.status')) result = { connected: state.connected, job: state.job, generationPause: state.pause };
        else if (command.endsWith('.capabilities')) result = { outputs: [{ kind: 'builtin', ready: true, provider: state.provider }], scenes: [{ id: 'fixture', label: '离线场景' }] };
        else if (command.endsWith('.candidates')) result = { candidates: [] };
        else if (command.endsWith('.generate.quote')) result = { provider: state.provider, model: 'offline', pricingMode: 'token-only', maxInputTokens: 100, maxOutputTokens: 100, executionSeconds: 30, maximumWaitSeconds: 90, expiresAt: Date.now() + 300000, confirmationToken: 'quote-token' };
        else if (command.endsWith('.generate.confirm')) {
          state.job = { jobId: 'job-original', state: 'running', stateRevision: 1, dispatchState: 'may_have_been_sent' };
          state.pause = { active: payload.pauseDynamic && state.provider === 'ollama-local', stopping: false, requests: [{ requestId: 'original', jobId: 'job-original', remainingSeconds: 90 }] };
          result = { job: state.job };
        } else if (command.endsWith('.generate.job')) result = state.job;
        else if (command.endsWith('.generate.cancel')) {
          state.job = { ...state.job, state: 'cancelled', stateRevision: 2 };
          state.pause = { ...state.pause, stopping: true, externalMayRun: true };
          result = state.job;
        } else if (command.endsWith('.pause.resume')) {
          state.pause = { active: false, externalMayRun: true, releaseReason: 'explicit', requests: [] }; result = state.pause;
        } else throw new Error('Unexpected fixture command ' + command);
        return { result };
      },
    };
  });
  await page.addScriptTag({ content: source });
  await page.locator('#wallpaper-generation summary').click();
  await page.waitForFunction(() => !document.getElementById('generation-brief').disabled);
  return { page, errors };
}
async function quote(page) {
  await page.locator('#generation-brief').fill('安静的夜空');
  await page.locator('#generation-quote').click();
  await page.waitForFunction(() => !document.getElementById('generation-confirm').disabled);
}
async function main() {
  const executablePath = process.env.HERTZ_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const { page, errors } = await fixture(browser);
    await quote(page);
    const option = page.getByRole('checkbox', { name: '生成期间暂停动态壁纸与预览' });
    assert.equal(await option.isChecked(), true);
    await page.screenshot({ path: path.join(out, 'local-pause-option.png'), fullPage: true });
    const before = await page.evaluate(() => fixture.calls.filter(call => call.command.endsWith('.generate.confirm')).length);
    await option.focus(); await page.keyboard.press('Space');
    assert.equal(await option.isChecked(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'generation-pause-dynamic');
    assert.equal(await page.evaluate(() => fixture.calls.filter(call => call.command.endsWith('.generate.confirm')).length), before);
    assert.match(await page.locator('#generation-pause-help').textContent(), /影响流畅度/);
    await page.locator('#generation-confirm').click();
    await page.waitForFunction(() => fixture.calls.some(call => call.command.endsWith('.generate.confirm')));
    assert.equal(await page.evaluate(() => fixture.calls.find(call => call.command.endsWith('.generate.confirm')).payload.pauseDynamic), false);
    checks.push('native labelled checkbox defaults on; Space changes only preference, preserves focus, and opt-out reaches submission');
    assert.deepEqual(errors, []); await page.close();

    const active = await fixture(browser, 390);
    await quote(active.page); await active.page.locator('#generation-confirm').click();
    await active.page.waitForFunction(() => !document.getElementById('generation-resume-dynamic').hidden);
    assert.match(await active.page.locator('#generation-pause-state').textContent(), /动态壁纸与预览已暂停/);
    await active.page.locator('#generation-cancel').click();
    await active.page.waitForFunction(() => document.getElementById('generation-pause-state').textContent.includes('外部模型可能仍在运行'));
    assert.equal(await active.page.locator('#generation-pause-state').getAttribute('role'), 'status');
    assert.equal(await active.page.locator('#generation-resume-dynamic').isVisible(), true);
    await active.page.evaluate(() => { fixture.connected = false; });
    await active.page.waitForFunction(() => !document.getElementById('generation-connect').hidden);
    await active.page.screenshot({ path: path.join(out, 'cancelled-mobile.png'), fullPage: true });
    const overflow = await active.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, 'narrow viewport must not overflow');
    await active.page.locator('#generation-resume-dynamic').focus(); await active.page.keyboard.press('Enter');
    await active.page.waitForFunction(() => document.getElementById('generation-resume-dynamic').hidden);
    assert.deepEqual(await active.page.evaluate(() => fixture.calls.find(call => call.command.endsWith('.pause.resume')).payload), { requestIds: ['original'] });
    assert.match(await active.page.locator('#generation-pause-state').textContent(), /其它暂停原因仍生效/);
    assert.equal(await active.page.evaluate(() => document.activeElement.id), 'generation-connect');
    checks.push('cancel and disconnect retain the pause warning; explicit keyboard resume carries exact request identity and remains available offline');
    assert.deepEqual(active.errors, []); await active.page.close();

    const overlapping = await fixture(browser);
    await overlapping.page.evaluate(() => {
      fixture.pause = { active: true, stopping: false, externalMayRun: true, releaseReason: 'deadline', requests: [{ requestId: 'second', jobId: 'job-second', remainingSeconds: 60 }] };
    });
    await overlapping.page.waitForFunction(() => document.getElementById('generation-pause-state').textContent.includes('外部模型可能仍在运行'));
    assert.equal(await overlapping.page.locator('#generation-resume-dynamic').isVisible(), true);
    await overlapping.page.evaluate(() => {
      fixture.pause = { active: false, stopping: false, externalMayRun: true, releaseReason: 'completed', requests: [] };
    });
    await overlapping.page.waitForFunction(() => document.getElementById('generation-resume-dynamic').hidden);
    assert.equal(await overlapping.page.locator('#generation-pause-state').isVisible(), true);
    assert.match(await overlapping.page.locator('#generation-pause-state').textContent(), /外部模型可能仍在运行/);
    checks.push('older unresolved external inference remains visible while another job runs and after that job completes');
    assert.deepEqual(overlapping.errors, []); await overlapping.page.close();

    const remote = await fixture(browser);
    await remote.page.evaluate(() => { fixture.provider = 'remote'; fixture.context++; window.dispatchEvent(new Event('wallpaper-ai-context')); });
    await remote.page.waitForFunction(() => !document.getElementById('generation-brief').disabled);
    await quote(remote.page);
    assert.equal(await remote.page.locator('#generation-pause-dynamic').isVisible(), false);
    checks.push('cloud provider does not expose a local-GPU pause option');
    assert.deepEqual(remote.errors, []); await remote.page.close();
    fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify({ checks, scope: 'Production generation script with offline transport; no live WebView2 or Ollama inference' }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
