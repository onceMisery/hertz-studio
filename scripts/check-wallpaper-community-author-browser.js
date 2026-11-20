// SPDX-License-Identifier: MIT
// Real Chromium interactions with shipped settings/author/report controllers.
// The native receipts are isolated fixtures; native package and Hub ledgers have Rust tests.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createFixture, sourceA, sourceB, workId, packageHash } = require('./wallpaper-community-author-fixture');
const output = path.resolve(process.env.HERTZ_COMMUNITY_BROWSER_OUTPUT || path.join(__dirname, '../output/playwright/community-author-20261119/browser'));
const checks = [], errors = [], dialogs = [];
const count = (fixture, command) => fixture.requests.filter(request => request.command === 'wallpaper.community.' + command).length;
async function control(page, url, values) { const response = await page.request.post(url + '/fixture-control', { data: values }); assert.equal(response.status(), 200); }
async function refresh(page) { await page.locator('#community-refresh').click(); }
async function openAuthor(page) {
  if (!await page.locator('#community-author-workspace').evaluate(node => node.open)) await page.locator('#community-author-workspace > summary').click();
}
async function prepare(page) {
  await page.locator('#community-author-local').click();
  await page.waitForFunction(() => document.getElementById('community-author-package').options.length === 2);
  await page.locator('#community-author-package').selectOption('local:' + workId + ':' + packageHash);
  await page.getByRole('button', { name: '核对发布版本', exact: true }).click();
  await page.locator('#community-author-review').waitFor({ state: 'visible' });
}
async function claim(page) {
  await page.locator('#community-author-consent').check();
  await page.locator('#community-author-create').click();
  await page.waitForFunction(() => document.getElementById('community-author-create').disabled && document.getElementById('community-loading').hidden);
}
async function reachable(page, selector) {
  const control = page.locator(selector);
  await control.scrollIntoViewIfNeeded();
  assert.equal(await control.evaluate(node => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === node || node.contains(hit);
  }), true, selector + ' must remain reachable inside the scrolling settings page');
}
async function setup(browser, action, clock = false) {
  const fixture = createFixture(), url = await fixture.start();
  const context = await browser.newContext({ viewport: { width: 1120, height: 800 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
  if (clock) await page.clock.install();
  try {
    await page.goto(url);
    await page.locator('#tab-community').click();
    await page.waitForFunction(() => document.getElementById('community-source').options.length === 2);
    await openAuthor(page);
    await action({ fixture, page, url });
  } finally { await context.close(); await fixture.close(); }
}
async function run() {
  fs.mkdirSync(output, { recursive: true });
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' }) });
  try {
    await setup(browser, async ({ fixture, page }) => {
      assert.equal(await page.locator('#community-author-package-error').isVisible(), false);
      await page.getByRole('button', { name: '核对发布版本', exact: true }).click();
      assert.equal(count(fixture, 'authorPrepare'), 0);
      assert.equal(await page.locator('#community-author-package-error').isVisible(), true);
      await prepare(page);
      assert.equal(await page.locator('#community-author-review-heading').evaluate(node => node === document.activeElement), true);
      assert.match(await page.locator('#community-author-facts').innerText(), new RegExp(packageHash));
      assert.equal(await page.locator('#community-author-facts img').count(), 0);
      await page.locator('#community-author-create').click();
      assert.equal(count(fixture, 'authorCreate'), 0);
      await page.locator('#community-author-consent').focus(); await page.keyboard.press('Space');
      await page.locator('#community-author-create').click();
      await page.waitForFunction(() => document.getElementById('community-author-create').disabled && document.getElementById('community-loading').hidden);
      await page.locator('#community-author-upload').click();
      await page.locator('#community-author-transfer').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.getElementById('community-loading').hidden);
      assert.equal(count(fixture, 'authorUpload'), 1);
      assert.match(await page.locator('#community-author-transfer-state').innerText(), /已完整接收/);
      assert.equal(await page.evaluate(() => localStorage.getItem('hertz.wallpaper.community.author.pending.v1')), null);
      await reachable(page, '#community-author-submit');
      await page.screenshot({ path: path.join(output, 'author-ready-desktop.png') });
      await page.reload(); await page.locator('#tab-community').click(); await openAuthor(page);
      assert.equal(await page.locator('#community-author-transfer').isVisible(), false);
      await page.locator('#community-author-mine').click();
      await page.locator('#community-author-transfer').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.getElementById('community-loading').hidden);
      assert.equal(count(fixture, 'authorUpload'), 1);
      assert.equal(await page.locator('#community-author-submit-consent').isChecked(), false);
      await page.locator('#community-author-submit').click(); assert.equal(count(fixture, 'authorSubmit'), 0);
      await page.locator('#community-author-submit-consent').check(); await page.locator('#community-author-submit').click();
      await page.locator('#community-author-transfer').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.getElementById('community-loading').hidden);
      await page.locator('#community-author-mine').click();
      await page.locator('#community-author-candidates > li').waitFor();
      assert.equal(count(fixture, 'authorSubmit'), 1);
      const submit = fixture.requests.find(request => request.command.endsWith('authorSubmit'));
      assert.equal(submit.payload.uploadId, fixture.uploads[0].id); assert.equal(submit.payload.packageHash, packageHash);
      assert.match(await page.locator('#community-author-candidates').innerText(), /等待审核/);
      assert.doesNotMatch(await page.locator('#community-author-candidates').innerText(), /已公开/);
      for (const width of [1120, 520, 360, 320]) {
        await page.setViewportSize({ width, height: 800 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'horizontal overflow at ' + width);
        await reachable(page, '#community-author-mine');
      }
      await page.locator('#community-author-candidates > li').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, 'author-narrow.png') });
      checks.push('native forms and keyboard consent; exact upload; reload recovery; explicit submit; private review state; 1120/520/360/320px layout');
    });
    await setup(browser, async ({ fixture, page, url }) => {
      await prepare(page); await claim(page); await control(page, url, { unknownUpload: true });
      await page.locator('#community-author-upload').click(); await page.locator('#community-uncertain').waitFor({ state: 'visible' });
      const original = JSON.parse(await page.evaluate(() => localStorage.getItem('hertz.wallpaper.community.author.pending.v1')));
      assert.equal(original.command, 'wallpaper.community.authorUpload'); assert.equal(original.sourceId, sourceA);
      assert.equal(original.accountSubject, 'author-a'); assert.ok(original.operationId);
      assert.equal(Object.hasOwn(original, 'ticket'), false); assert.equal(Object.hasOwn(original, 'packageHash'), false);
      assert.doesNotMatch(JSON.stringify(original), /fixture-ticket|IsolatedFixture|token|description/);
      await page.reload(); await page.locator('#tab-community').click(); await openAuthor(page);
      await page.locator('#community-uncertain').waitFor(); assert.equal(count(fixture, 'authorUpload'), 1);
      await page.locator('#community-source').selectOption(sourceB); await page.locator('#community-recover').click();
      assert.equal(count(fixture, 'authorOperation'), 0);
      await page.locator('#community-source').selectOption(sourceA);
      await control(page, url, { subject: null }); await refresh(page);
      await page.waitForFunction(() => document.getElementById('community-account').textContent.includes('尚未登录'));
      await page.locator('#community-recover').click(); assert.equal(count(fixture, 'authorOperation'), 0);
      assert.equal(await page.locator('#community-login').isEnabled(), true);
      await page.locator('#community-login').click();
      await page.waitForFunction(() => document.getElementById('community-account').textContent.includes('author-a') && document.getElementById('community-loading').hidden);
      assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('hertz.wallpaper.community.author.pending.v1'))).requestId, original.requestId);
      await control(page, url, { queryFound: false }); await page.locator('#community-recover').click();
      await page.waitForFunction(() => document.getElementById('community-message').textContent.includes('最终事实'));
      assert.equal(await page.locator('#community-uncertain').isVisible(), true);
      await control(page, url, { queryFound: true, localPending: true }); await page.locator('#community-recover').click();
      await page.locator('#community-author-transfer').waitFor(); assert.equal(await page.locator('#community-uncertain').isVisible(), true);
      for (const [state, label] of [['receiving', '正在接收'], ['validating', '正在核验']]) {
        await control(page, url, { localPending: false, uploadState: state }); await page.locator('#community-recover').click();
        await page.waitForFunction(text => document.getElementById('community-author-transfer-state').textContent.includes(text), label);
        assert.equal(await page.locator('#community-uncertain').isVisible(), true);
      }
      await control(page, url, { uploadState: 'reserved' }); await page.locator('#community-recover').click();
      await page.locator('#community-uncertain').waitFor({ state: 'hidden' });
      assert.equal(count(fixture, 'authorUpload'), 1);
      const queries = fixture.requests.filter(request => request.command.endsWith('authorOperation'));
      assert.ok(queries.length >= 4); queries.forEach(request => { assert.equal(request.payload.operationId, original.operationId); assert.equal(request.payload.originalRequestId, original.requestId); });
      await prepare(page);
      assert.equal(await page.locator('#community-author-upload').textContent(), '继续上传原版本');
      await page.locator('#community-author-consent').check();
      await control(page, url, { unknownUpload: false });
      await page.locator('#community-author-upload').click();
      await page.waitForFunction(() => document.getElementById('community-author-transfer-state').textContent.includes('已完整接收'));
      assert.equal(fixture.requests.filter(request => request.command.endsWith('authorUpload'))[1].payload.uploadId, fixture.uploads[0].id);
      checks.push('unknown request persists through reload and reauthentication; source/account isolation; no automatic replay; local/receiving/validating remain unresolved; explicit resume keeps original upload ID');
    });
    for (const command of ['authorCreate', 'authorSubmit', 'reportSubmit']) {
      await setup(browser, async ({ fixture, page, url }) => {
        let submitControl;
        if (command === 'reportSubmit') {
          await page.locator('#community-browse').click();
          await page.locator('[data-community-report]').click();
          await page.locator('#community-report-review').waitFor();
          await page.locator('#community-report-other').check();
          await page.locator('#community-report-description').fill('Original report evidence');
          await page.locator('#community-report-consent').check();
          submitControl = '#community-report-submit';
        } else {
          await prepare(page);
          await page.locator('#community-author-consent').check();
          if (command === 'authorSubmit') {
            await claim(page);
            await page.locator('#community-author-upload').click();
            await page.locator('#community-author-transfer').waitFor();
            await page.waitForFunction(() => document.getElementById('community-loading').hidden);
            await page.locator('#community-author-submit-consent').check();
            submitControl = '#community-author-submit';
          } else submitControl = '#community-author-create';
        }
        await control(page, url, { unknownCommand: command });
        await page.locator(submitControl).click();
        await page.locator('#community-uncertain').waitFor();
        const original = JSON.parse(await page.evaluate(() => localStorage.getItem('hertz.wallpaper.community.author.pending.v1')));
        assert.equal(original.command, 'wallpaper.community.' + command);
        assert.equal(original.sourceId, sourceA); assert.equal(original.accountSubject, 'author-a');
        assert.doesNotMatch(JSON.stringify(original), /Original report evidence|fixture-ticket|token|description/);
        if (command === 'authorSubmit') assert.equal(original.uploadId, fixture.uploads[0].id);
        await page.reload(); await page.locator('#tab-community').click(); await openAuthor(page);
        await page.locator('#community-uncertain').waitFor();
        assert.equal(count(fixture, command), 1, 'reload cannot replay ' + command);
        await page.locator('#community-recover').click();
        await page.locator('#community-uncertain').waitFor({ state: 'hidden' });
        assert.equal(count(fixture, command), 1);
        const query = fixture.requests.find(request => request.command.endsWith('authorOperation'));
        assert.equal(query.payload.operationId, original.operationId || original.requestId);
        assert.equal(query.payload.originalRequestId, original.requestId);
        if (command === 'authorSubmit') assert.equal(query.payload.uploadId, original.uploadId);
        assert.equal(query.payload.kind, command === 'authorCreate' ? 'work' : command === 'reportSubmit' ? 'report' : 'upload');
        assert.equal(await page.evaluate(() => localStorage.getItem('hertz.wallpaper.community.author.pending.v1')), null);
        if (command === 'reportSubmit') assert.equal(await page.locator('#community-report-id').inputValue(), fixture.reports[0].id);
        if (command === 'authorSubmit') assert.equal(fixture.candidates[0].state, 'pending_review');
        checks.push(command + ': accepted operation with missing receipt survives reload and queries its original identity without replay');
      });
    }
    await setup(browser, async ({ fixture, page, url }) => {
      await prepare(page); await page.locator('#community-author-consent').check();
      await control(page, url, { deniedCommand: 'authorCreate' });
      await page.locator('#community-author-create').click();
      await page.waitForFunction(() => document.getElementById('community-message').textContent.includes('explicitly denied'));
      assert.equal(fixture.works.length, 0); assert.equal(count(fixture, 'authorCreate'), 1);
      assert.equal(await page.locator('#community-uncertain').isVisible(), false);
      assert.equal(await page.evaluate(() => localStorage.getItem('hertz.wallpaper.community.author.pending.v1')), null);
      await control(page, url, { deniedCommand: null }); await page.locator('#community-author-create').click();
      await page.waitForFunction(() => document.getElementById('community-author-create').disabled && document.getElementById('community-loading').hidden);
      assert.equal(fixture.works.length, 1); assert.equal(count(fixture, 'authorCreate'), 2);
      checks.push('explicit permission rejection clears pending locator; valid confirmation can retry only through another user action');
    });
    await setup(browser, async ({ fixture, page, url }) => {
      await page.locator('#community-author-local').click();
      await page.waitForFunction(() => document.getElementById('community-author-package').options.length === 2);
      await page.locator('#community-author-package').selectOption('local:' + workId + ':' + packageHash);
      await control(page, url, { holdPrepare: true });
      await page.getByRole('button', { name: '核对发布版本', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('community-loading').hidden);
      await page.locator('#community-source').selectOption(sourceB);
      await control(page, url, { holdPrepare: false, releasePrepare: true });
      await page.waitForFunction(() => document.getElementById('community-loading').hidden);
      assert.equal(await page.locator('#community-author-review').isVisible(), false);
      await page.locator('#community-source').selectOption(sourceA); await prepare(page);
      await control(page, url, { subject: 'author-c' }); await refresh(page);
      await page.waitForFunction(() => document.getElementById('community-account').textContent.includes('author-c'));
      assert.equal(await page.locator('#community-author-review').isVisible(), false);
      await control(page, url, { subject: 'author-a' }); await refresh(page);
      await page.waitForFunction(() => document.getElementById('community-account').textContent.includes('author-a'));
      assert.equal(await page.locator('#community-author-review').isVisible(), false);
      await prepare(page); await page.clock.fastForward(300001);
      assert.equal(await page.locator('#community-author-review').isVisible(), false);
      assert.equal(count(fixture, 'authorCreate'), 0); assert.equal(count(fixture, 'authorUpload'), 0);
      checks.push('late prepare cannot cross source selection; changed/returned account discards old confirmation; five-minute expiry has no write side effect');
    }, true);
    await setup(browser, async ({ fixture, page, url }) => {
      await page.locator('#community-browse').click(); await page.locator('[data-community-report]').waitFor();
      await control(page, url, { subject: null }); await refresh(page);
      await page.waitForFunction(() => document.querySelector('[data-community-report]').disabled);
      assert.equal(count(fixture, 'reportPrepare'), 0);
      await page.locator('#community-login').click();
      await page.waitForFunction(() => !document.querySelector('[data-community-report]').disabled && document.getElementById('community-loading').hidden);
      await page.locator('[data-community-report]').click(); await page.locator('#community-report-review').waitFor();
      assert.equal(await page.locator('#community-report-heading').evaluate(node => node === document.activeElement), true);
      await page.locator('#community-report-other').check(); await page.locator('#community-report-consent').check();
      await page.locator('#community-report-description').fill(' \n '); await page.locator('#community-report-submit').click();
      assert.equal(count(fixture, 'reportSubmit'), 0); assert.equal(await page.locator('#community-report-description-error').isVisible(), true);
      await page.locator('#community-report-description').fill('可核查线索 <img src=x onerror=alert(1)>');
      await page.locator('#community-report-submit').click(); await page.locator('#community-report-review').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.getElementById('community-loading').hidden);
      const id = await page.locator('#community-report-id').inputValue(); assert.ok(id); assert.equal(count(fixture, 'reportSubmit'), 1);
      await page.locator('#community-report-id').fill('bad-id');
      await page.locator('#community-report-query-form button').click(); assert.equal(count(fixture, 'reportDetail'), 0);
      await page.locator('#community-report-id').fill(id); await page.locator('#community-report-id').press('Enter');
      await page.waitForFunction(() => document.getElementById('community-report-result').textContent.includes('已核查'));
      assert.equal(await page.locator('#community-report-result img').count(), 0);
      assert.match(await page.locator('#community-report-result').innerText(), /<img/);
      await page.locator('#community-source').selectOption(sourceB);
      assert.equal(await page.locator('#community-report-id').inputValue(), ''); assert.equal(await page.locator('#community-report-result').textContent(), '');
      checks.push('anonymous report disabled; exact version consent; whitespace/native UUID validation; keyboard query; text injection inert; source change clears private result');
    });
    assert.deepEqual(errors, []); assert.deepEqual(dialogs, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, dialogs, nativeReceipts: 'isolated fixture', widths: [1120, 520, 360, 320] }, null, 2) + '\n');
    console.log(JSON.stringify({ passed: checks.length, checks, errors, dialogs, output }, null, 2));
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
