// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 工坊「AI 生成」任务面板的浏览器契约。真实服务 + 真实 fake provider
//（零费用、即时完成），覆盖：
//   1. consent 默认关闭：面板显示已关闭、提交不可用；开启后可用；
//   2. 提交 → 任务到 succeeded（fake 即时）→ 查看提案 → 应用到舞台
//      → 舞台场景随提案切换；
//   3. 拒绝：提案进入 rejected，内容不再可应用；
//   4. WS ai_task 事件驱动刷新（事件比轮询先到也不重复渲染崩溃）。
//
//   node scripts/check-ai-tasks-browser.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { uiUrl } = require('./ui-token');

const root = path.resolve(__dirname, '..');
const output = process.env.AI_TASKS_OUTPUT
  ? path.resolve(process.env.AI_TASKS_OUTPUT)
  : path.join(root, 'output/playwright/ai-tasks');
const errors = [];
let passed = 0;
const pass = (name) => { passed += 1; console.log('PASS ' + name); };

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const fixture = await startFixture();
  // ui-token 从这里读隔离实例的令牌文件（与既有自启动检查同一招）。
  process.env.VMUSIC_DATA_DIR = fixture.dataDir;
  // consent 默认关闭是产品语义：第一段先验证关闭态，随后用官方 API 打开。
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    headless: process.env.SC_HEADED !== '1',
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await fixture.connect(context);
  const page = await context.newPage();
  let activeSocket = null;
  let aiStatusRequests = 0;
  await page.routeWebSocket(url => url.pathname === '/ws', ws => {
    ws.connectToServer();
    activeSocket = ws;
  });
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/v1/ai/status') aiStatusRequests += 1;
  });
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    await page.goto(uiUrl(fixture.base), { waitUntil: 'domcontentloaded' });

    // 打开工坊并切到 AI 页签（Workshop.open/setTab 是既有公共口）。
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('ai'); });
    await assert.equal(await page.locator('#ws-ai-brief').count(), 1, 'AI 页签应有输入框');
    pass('AI 页签打开');

    // consent 默认关闭：开关显示已关闭、提交禁用、状态行说明。
    assert.equal(await page.locator('#ws-ai-brief').isDisabled(), true, 'consent 关闭时提交必须禁用');
    const consentText = await page.locator('.ws-kv').filter({ hasText: '生成开关' }).innerText();
    assert.match(consentText, /已关闭/);
    pass('consent 默认关闭且提交禁用');

    // 面板内开启：PUT 设置 → 状态刷新 → 提交可用。
    await page.getByRole('button', { name: '开启生成', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#ws-ai-brief') && !document.querySelector('#ws-ai-brief').disabled);
    assert.equal(await page.locator('#ws-ai-brief').isDisabled(), false, '开启后提交应可用');
    pass('面板内开启 consent');

    // 提交 → fake provider 即时完成 → 列表出现 succeeded → 查看提案。
    await page.locator('#ws-ai-brief').fill('星云缓慢推进，霓虹颗粒');
    await page.getByRole('button', { name: '提交生成任务', exact: true }).click();
    await page.getByRole('button', { name: '查看提案', exact: true }).first().waitFor({ timeout: 15000 });
    const stateText = await page.locator('.ws-ai-state').first().innerText();
    assert.equal(stateText, '已完成');
    pass('任务跑到已完成并列出提案');

    assert.ok(activeSocket, '任务面板应已建立 WebSocket');
    const statusBeforeResync = aiStatusRequests;
    const resyncResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/v1/ai/status');
    activeSocket.send(JSON.stringify({ type: 'ai_tasks_resync' }));
    await resyncResponse;
    assert.ok(aiStatusRequests > statusBeforeResync, '掉队提示应触发任务快照重查');
    pass('ai_tasks_resync 事件触发任务快照重查');

    await page.locator('.ws-ai-budget').waitFor();
    assert.match(await page.locator('.ws-ai-budget').innerText(), /UTC 自然月/);
    assert.match(await page.locator('.ws-ai-usage').first().innerText(), /已报告费用 \$0\.000000 USD/);
    pass('费用面板显示 UTC 预算和 fake 零费用事实');

    // 展开提案：场景来自真实契约表，patch 有内容。
    await page.getByRole('button', { name: '查看提案', exact: true }).first().click();
    const head = await page.locator('.ws-ai-proposal .ws-prompt-head').first().innerText();
    assert.match(head, /提案 · 场景：/);
    const proposalScene = head.split('：')[1];
    assert.ok(await page.evaluate(scene => !!CreativeGL.sceneById(scene), proposalScene),
      '提案场景必须在真实契约表内: ' + proposalScene);
    pass('提案展开且场景来自契约表');

    // 应用到舞台：舞台场景随提案切换。
    const before = await page.evaluate(() => window.CreativeStage.preset());
    const [job] = (await fixture.api('/v1/ai/jobs?limit=20')).jobs;
    const proposal = await fixture.api('/v1/ai/proposals/' + job.resultProposalId);
    const expected = await page.evaluate(intent => CreativeStage.materializeIntent(null, intent).preset,
      proposal.validatedIntent);
    await page.locator('.ws-ai-proposal').getByRole('button', { name: '预览候选舞台' }).click();
    await page.locator('.ws-ai-proposal').getByRole('button', { name: '应用到当前舞台' }).waitFor();
    assert.deepEqual(await page.evaluate(() => CreativeStage.preset()), before, '预览不得提交');
    await page.locator('.ws-ai-proposal').getByRole('button', { name: '应用到当前舞台' }).click();
    await page.waitForFunction(() => !CreativeStage.preview());
    assert.deepEqual(await page.evaluate(() => CreativeStage.preset()), expected,
      '应用必须提交纯物化候选，包含全部 patch 值');
    pass('提案完整物化并应用（包含场景参数）');
    await page.getByRole('button', { name: '撤销本次应用', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => CreativeStage.preset()), before);
    pass('应用可整体撤销');

    // 拒绝另一单：提交第二个任务，拒绝其提案，行内状态转为已拒绝。
    await page.evaluate(() => Workshop.setTab('ai'));
    await page.locator('#ws-ai-brief').fill('第二单，随后拒绝');
    await page.getByRole('button', { name: '提交生成任务', exact: true }).click();
    await page.locator('.ws-ai-job').nth(1).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '查看提案', exact: true }).first().click();
    await page.locator('.ws-ai-proposal').getByRole('button', { name: '拒绝', exact: true })
      .last().click();
    await page.waitForFunction(() => document.body.innerText.includes('提案状态：rejected'),
      null, { timeout: 5000 });
    pass('提案拒绝后状态转为 rejected');

    assert.equal(await page.locator('.ws-ai-proposal').getByRole('button', { name: '应用到当前舞台' }).count(), 0);
    const countBeforeRetry = (await fixture.api('/v1/ai/jobs?limit=20')).jobs.length;
    let droppedReply = false;
    await page.route('**/v1/ai/jobs', async route => {
      if (route.request().method() === 'POST' && !droppedReply) {
        droppedReply = true;
        await route.fetch(); // Server accepts, but the browser loses its acknowledgement.
        await route.abort('failed');
      } else await route.continue();
    });
    await page.locator('#ws-ai-brief').fill('响应丢失后重试');
    await page.getByRole('button', { name: '提交生成任务', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#ws-toast').textContent.includes('提交失败'));
    await page.getByRole('button', { name: '提交生成任务', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#ws-ai-brief').value === '');
    assert.equal((await fixture.api('/v1/ai/jobs?limit=20')).jobs.length, countBeforeRetry + 1,
      '响应丢失后的同输入重试必须复用幂等键');
    pass('响应丢失后重试不重复创建任务');

    // Events arriving during an older snapshot must schedule one fresh read.
    let snapshotReady = false, releaseSnapshot;
    const snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
    await page.route('**/v1/ai/jobs?limit=20', async route => {
      if (snapshotReady) { await route.continue(); return; }
      const response = await route.fetch();
      snapshotReady = true;
      await snapshotGate;
      await route.fulfill({ response });
    });
    for (let i = 0; i < 100 && !snapshotReady; i++) {
      await page.evaluate(() => Workshop.onAiTask());
      await page.waitForTimeout(50);
    }
    assert.ok(snapshotReady);
    const concurrent = await fixture.api('/v1/ai/jobs', 'POST', { brief: '快照在途时到来的任务' });
    await page.evaluate(() => Workshop.onAiTask());
    releaseSnapshot();
    await page.locator('.ws-ai-job').filter({ hasText: concurrent.job.jobId.slice(0, 8) })
      .waitFor({ timeout: 1500 });
    pass('旧快照在途时的任务事件会补查新事实');
    await page.unroute('**/v1/ai/jobs?limit=20');

    // UI-only adapter fixture: keep task state/revision fixed and let its bill
    // move unknown -> reported. Rust tests cover the real ledger transaction.
    let billingPhase = 'unknown';
    await page.route('**/v1/ai/jobs?limit=20', async route => {
      const response = await route.fetch();
      const payload = await response.json();
      const job = payload.jobs[0];
      job.usage = { ...job.usage, usageState: billingPhase,
        accountedMicroUsd: billingPhase === 'unknown' ? 30000 : 137,
        usageRevision: billingPhase === 'unknown' ? 1 : 2 };
      await route.fulfill({ response, json: payload });
    });
    await page.getByRole('button', { name: '刷新任务与费用', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ws-ai-usage').textContent.includes('费用未确认'));
    billingPhase = 'reported';
    // No task event: polling must continue for an unknown bill after task completion.
    await page.waitForFunction(() => document.querySelector('.ws-ai-usage').textContent.includes('$0.000137'), null, { timeout: 6000 });
    pass('终态任务仍等待未知费用，独立 usage revision 更新显示');
    await page.unroute('**/v1/ai/jobs?limit=20');

    // A transient first snapshot failure must recover without a new task event
    // or a manual refresh, even when the panel has no known active jobs.
    let statusRequests = 0;
    await page.route('**/v1/ai/status', async route => {
      statusRequests++;
      if (statusRequests <= 2) {
        await route.fulfill({ status: 503, json: { error: {
          code: 'fixture_unavailable', message: 'fixture snapshot unavailable',
        } } });
      } else await route.continue();
    });
    await page.getByRole('button', { name: '刷新任务与费用', exact: true }).click();
    await page.getByText('fixture snapshot unavailable', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.body.innerText.includes('fixture snapshot unavailable'),
      null, { timeout: 10000 });
    assert.ok(statusRequests >= 2, '退避后再次读取 AI 状态');
    pass('AI 状态快照首次失败后自动退避重试并恢复');
    await page.unroute('**/v1/ai/status');

    // A task created by another entry point while this browser is offline has
    // no WebSocket event to deliver. Reconnect must refresh the open AI panel.
    await context.setOffline(true);
    assert.ok(activeSocket, '浏览器已建立可控的真实服务 WebSocket');
    await activeSocket.close({ code: 1001, reason: 'fixture disconnect' });
    await page.waitForFunction(() => {
      const banner = document.querySelector('#offline-banner');
      return banner && !banner.hidden;
    }, null, { timeout: 5000 });
    const disconnected = await fixture.api('/v1/ai/jobs', 'POST', { brief: '断线期间由另一入口提交的任务' });
    const disconnectedJobId = disconnected.job.jobId;
    let disconnectedJob = null;
    const jobDeadline = Date.now() + 10000;
    while (Date.now() < jobDeadline) {
      const jobs = await fixture.api('/v1/ai/jobs?limit=20');
      disconnectedJob = jobs.jobs.find(job => job.jobId === disconnectedJobId);
      if (disconnectedJob && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(disconnectedJob.state)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(disconnectedJob && disconnectedJob.state, 'succeeded', '断线期间的 fake 任务已完成');
    await context.setOffline(false);
    await page.waitForFunction(() => document.querySelector('#conn').textContent === '服务已连接',
      null, { timeout: 20000 });
    await page.locator('.ws-ai-job').filter({ hasText: disconnectedJobId.slice(0, 8) }).waitFor({ timeout: 5000 });
    pass('AI 面板打开时断线，重连后找回另一入口完成的任务');

    const pageOne = Array.from({ length: 20 }, (_, index) => ({
      ...job,
      jobId: 'newer-' + String(index).padStart(2, '0') + '-fixture',
      createdAt: job.createdAt + 100000 + (20 - index) * 1000,
      state: 'failed',
      resultProposalId: null,
      usage: null,
    }));
    let latestPage = pageOne;
    const olderJob = {
      ...job,
      jobId: 'fixture-older-proposal',
      createdAt: job.createdAt - 1000,
    };
    const historyPage = await context.newPage();
    let historyRouteHits = 0;
    historyPage.on('pageerror', error => console.error('AI history page error: ' + error.message));
    historyPage.on('console', message => {
      if (message.type() === 'error') console.error('AI history console: ' + message.text());
    });
    historyPage.on('request', request => {
      if (new URL(request.url()).pathname.includes('/v1/ai/')) {
        console.log('AI history request ' + request.method() + ' ' + request.url());
      }
    });
    await historyPage.routeWebSocket(url => url.pathname === '/ws', ws => ws.connectToServer());
    await historyPage.route('**/v1/ai/jobs?limit=20*', async route => {
      historyRouteHits += 1;
      const url = new URL(route.request().url());
      if (url.searchParams.has('before_created_at')) {
        assert.ok(url.searchParams.has('before_job_id'), 'older page carries the stable compound cursor');
        await route.fulfill({ json: { jobs: [olderJob] } });
      } else await route.fulfill({ json: { jobs: latestPage } });
    });
    await historyPage.goto(uiUrl(fixture.base), { waitUntil: 'domcontentloaded' });
    // app.js finishes several asynchronous startup steps before Workshop.init().
    // DOMContentLoaded only guarantees that the scripts were loaded, not that the
    // workshop API has bound its panel refs yet.
    await historyPage.waitForFunction(() => document.querySelector('#workshop .ws-targets'));
    await historyPage.evaluate(() => { Workshop.open(); Workshop.setTab('ai'); });
    try {
      await historyPage.waitForFunction(() => document.querySelectorAll('.ws-ai-job').length === 20, null, { timeout: 8000 });
    } catch (error) {
      console.error('AI history URL: ' + historyPage.url());
      console.error('AI history route hits: ' + historyRouteHits);
      console.error('AI history prompt: ' + await historyPage.locator('#ws-ai-brief').count());
      console.error('AI history text: ' + (await historyPage.locator('body').innerText()).slice(0, 1200));
      throw error;
    }
    await historyPage.getByRole('button', { name: '加载更早任务', exact: true }).click();
    await historyPage.waitForFunction(() => document.querySelectorAll('.ws-ai-job').length === 21);
    const olderRow = historyPage.locator('.ws-ai-job').filter({ hasText: olderJob.jobId.slice(0, 8) });
    const olderOps = olderRow.locator('xpath=following-sibling::div[contains(@class,"ws-ai-ops")]').first();
    await olderOps.getByRole('button', { name: '查看提案', exact: true }).click();
    await historyPage.locator('.ws-ai-proposal .ws-prompt-head').waitFor();
    assert.match(await historyPage.locator('.ws-ai-proposal .ws-prompt-head').innerText(), /提案 · 场景：/);
    pass('AI 任务历史使用稳定游标翻页并能读取较早提案');
    await olderOps.getByRole('button', { name: '收起提案', exact: true }).click();

    latestPage = [
      { ...pageOne[0], jobId: 'recent-00-fixture', createdAt: pageOne[0].createdAt + 2000 },
      { ...pageOne[0], jobId: 'recent-01-fixture', createdAt: pageOne[0].createdAt + 1000 },
      ...pageOne.slice(0, 18),
    ];
    await historyPage.getByRole('button', { name: '刷新任务与费用', exact: true }).click();
    await historyPage.waitForFunction(() => document.querySelectorAll('.ws-ai-job').length === 23);
    for (const shiftedJob of pageOne.slice(18)) {
      assert.equal(await historyPage.locator('.ws-ai-job').filter({ hasText: shiftedJob.jobId.slice(0, 8) }).count(), 1,
        'refresh must retain tasks shifted out of the latest page: ' + shiftedJob.jobId);
    }
    pass('刷新时保留已加载历史中被新任务挤出最近页的记录');
    await historyPage.unroute('**/v1/ai/jobs?limit=20*');

    // A delayed response must not redraw a closed panel or restart polling.
    let aiRequests = 0;
    let release;
    const responseGate = new Promise(resolve => { release = resolve; });
    await page.route('**/v1/ai/status', async route => {
      aiRequests += 1;
      await responseGate;
      await route.continue();
    });
    for (let i = 0; i < 100 && !aiRequests; i++) {
      await page.evaluate(() => Workshop.onAiTask());
      await page.waitForTimeout(50);
    }
    assert.ok(aiRequests > 0, '延迟刷新已发出');
    await page.evaluate(() => Workshop.close());
    release();
    await page.waitForTimeout(300);
    const stoppedAt = aiRequests;
    await page.waitForTimeout(2800);
    assert.equal(aiRequests, stoppedAt, '关闭后不再轮询');
    assert.equal(await page.evaluate(() => Workshop.isOpen()), false);
    pass('迟到刷新不重开面板或轮询');

    await page.screenshot({ path: path.join(output, 'ai-tasks.png') });
  } finally {
    await browser.close();
    await fixture.close();
  }

  if (errors.length) fail('页面错误: ' + errors.join(' | '));
  console.log(`✓ AI 任务面板浏览器契约全部通过（${passed} 项）`);

  function fail(message) {
    console.error('✗ ' + message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('✗ ' + (error && error.stack || error && error.message || error));
  process.exit(1);
});
