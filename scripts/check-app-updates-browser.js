#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real browser interaction with the production update UI and controlled responses.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), ui = path.join(root, 'plugin/ui');
const htmlSource = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
const markup = htmlSource.slice(htmlSource.indexOf('<fieldset class="set-group app-updates"'), htmlSource.indexOf('</fieldset>', htmlSource.indexOf('<fieldset class="set-group app-updates"')) + 11);
assert.ok(markup.includes('app-update-install'));
const output = path.join(root, 'output/playwright/application-updates-' + Date.now());
fs.mkdirSync(output, { recursive: true });
const checks = [], calls = [];
let value, initialFailure = false, failedSave = false, lateRead = false, holdDownload = false, holdCheck = false, holdSave = false;
const release = { version: '0.3.8', title: 'Hertz Studio 0.3.8', notes: '修复播放与更新\n<img src=x onerror="window.badUpdate=true">\n说明保留原始文本',
  releaseUrl: 'https://github.com/onceMisery/hertz-studio/releases/tag/hertz-studio-v0.3.8',
  downloadUrl: 'https://github.com/onceMisery/hertz-studio/releases/download/hertz-studio-v0.3.8/hertz-studio-0.3.8-x86_64-pc-windows-msvc.zip',
  fileName: 'hertz-studio-0.3.8-x86_64-pc-windows-msvc.zip', size: 8 * 1024 * 1024 };
function reset(extra = {}) {
  value = { currentVersion: '0.3.7', edition: 'full', distribution: 'standalone', target: 'x86_64-pc-windows-msvc', phase: 'idle',
    checkOnStartup: false, checkedAt: null, release: null, operationId: '9b474fad-92c4-4f4d-a31a-f66838c619f2',
    downloadedBytes: 0, totalBytes: release.size, canDownload: false, canInstall: false, installKind: 'portable', error: null, ...extra };
  calls.length = 0; initialFailure = false; failedSave = false; lateRead = false; holdDownload = false; holdCheck = false; holdSave = false;
}
function available() { value = { ...value, phase: 'available', release, canDownload: true, canInstall: false, error: null }; }
function mark(name) { checks.push(name); console.log('PASS ' + name); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function documentHtml(base = '') {
  return `<!doctype html><html lang="zh-CN" data-skin="hertz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    ${['design/design-base.css', 'components/button.css', 'components/form.css', 'style.css', 'skins/skin.hertz.css', 'app-updates.css'].map(file => `<link rel="stylesheet" href="${base}/ui/${file}">`).join('')}
    <style>body{display:block;margin:0;padding:24px;min-width:0;background:var(--bg);color:var(--text)}main{max-width:720px;margin:auto}fieldset{min-width:0}</style>
    </head><body><main id="view-settings">${markup}</main><script src="${base}/ui/app-updates.js"></script></body></html>`;
}
async function main() {
  reset();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(documentHtml()); return; }
    if (url.pathname.startsWith('/ui/')) {
      const file = path.resolve(ui, url.pathname.slice(4));
      if (!file.startsWith(ui + path.sep) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(fs.readFileSync(file)); return;
    }
    response.setHeader('Content-Type', 'application/json');
    let body = ''; for await (const chunk of request) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    calls.push({ method: request.method, path: url.pathname, body: parsed });
    if (request.method === 'GET') {
      if (initialFailure) { initialFailure = false; response.writeHead(503).end(JSON.stringify({ error: { message: '临时连接中断' } })); return; }
      if (lateRead) { lateRead = false; const stale = { ...value }; await delay(300); response.end(JSON.stringify(stale)); return; }
    }
    if (url.pathname.endsWith('/settings')) {
      if (failedSave) { response.writeHead(500).end(JSON.stringify({ error: { message: '设置写入失败' } })); return; }
      value.checkOnStartup = parsed.checkOnStartup;
      if (holdSave) await delay(300);
    }
    if (url.pathname.endsWith('/check')) {
      if (holdCheck) {
        value.phase = 'current';
        const cached = { ...value };
        await delay(300);
        response.end(JSON.stringify(cached)); return;
      }
      value.phase = 'checking'; value.error = null;
      setTimeout(available, 100);
    }
    if (url.pathname.endsWith('/download')) {
      value.phase = 'downloading'; value.downloadedBytes = 0; value.error = null;
      if (holdDownload) await delay(200);
    }
    if (url.pathname.endsWith('/cancel')) {
      value.phase = 'cancelling'; setTimeout(() => { value.phase = 'cancelled'; }, 100);
    }
    response.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_BROWSER_EXECUTABLE } : { channel: 'chrome' }) });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('https://**/*', route => route.abort());
  async function boot() {
    await page.goto(base);
    await page.evaluate(() => {
      window.HertzClipboard = { write: async text => { window.copiedUpdate = text; } };
      function send(method, path, body) {
        return fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async response => {
          const value = await response.json(); if (!response.ok) throw new Error(value.error.message); return value;
        });
      }
      window.HertzUpdates.init({ kind: 'server', get: path => send('GET', path), post: (path, body) => send('POST', path, body), put: (path, body) => send('PUT', path, body) });
    });
    await page.waitForFunction(() => !document.getElementById('app-update-check').disabled);
  }
  async function statusIncludes(text) { await page.waitForFunction(text => document.getElementById('app-update-status').textContent.includes(text), text); }
  try {
    initialFailure = true; await boot();
    await statusIncludes('临时连接中断');
    await page.locator('#app-update-check').click(); await statusIncludes('尚未检查');
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
    mark('初次状态读取失败可重试；默认启动不联网检查');

    failedSave = true;
    await page.locator('#app-update-auto').check(); await statusIncludes('设置写入失败');
    assert.equal(await page.locator('#app-update-auto').isChecked(), false);
    failedSave = false; await page.locator('#app-update-auto').check();
    await page.waitForFunction(() => !document.getElementById('app-update-auto').disabled);
    assert.equal(value.checkOnStartup, true);
    assert.equal(calls.filter(call => call.path.endsWith('/check')).length, 0);
    mark('启动检查设置持久化；写入失败恢复原值');

    reset(); holdCheck = true; await boot();
    await page.locator('#app-update-check').click();
    assert.equal(await page.locator('#app-update-auto').isEnabled(), false);
    await page.locator('#app-update-auto').evaluate(input => { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(calls.filter(call => call.method === 'PUT').length, 0);
    await statusIncludes('当前版本无需更新');
    assert.equal(await page.locator('#app-update-auto').isChecked(), false);
    holdSave = true;
    await page.locator('#app-update-auto').check();
    assert.equal(await page.locator('#app-update-check').isEnabled(), false);
    await page.locator('#app-update-check').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(calls.filter(call => call.path.endsWith('/check')).length, 1);
    await page.waitForFunction(() => !document.getElementById('app-update-auto').disabled);
    assert.equal(value.checkOnStartup, true);
    assert.equal(await page.locator('#app-update-auto').isChecked(), true);
    mark('延迟检查与设置保存互斥；缓存结果不会覆盖已保存开关');

    reset(); await boot();
    await page.locator('#app-update-check').click(); await statusIncludes('发现新版本 0.3.8');
    assert.equal(await page.locator('#app-update-install').isVisible(), false);
    await page.locator('.app-update-notes summary').click();
    assert.equal(await page.locator('#app-update-notes img').count(), 0);
    assert.equal(await page.evaluate(() => !!window.badUpdate), false);
    await page.locator('#app-update-copy').click();
    assert.equal(await page.evaluate(() => window.copiedUpdate), release.downloadUrl);
    mark('新版本及说明可读；说明按文本显示、复制对应包链接');

    lateRead = true;
    await page.evaluate(() => { void window.HertzUpdates.refresh(); });
    holdDownload = true;
    await page.locator('#app-update-download').evaluate(button => { button.click(); button.click(); });
    await statusIncludes('正在下载'); await delay(350);
    assert.equal(calls.filter(call => call.path.endsWith('/download')).length, 1);
    assert.ok((await page.locator('#app-update-status').textContent()).includes('正在下载'));
    value.downloadedBytes = 4 * 1024 * 1024;
    await page.evaluate(() => window.HertzUpdates.refresh());
    assert.equal(await page.locator('#app-update-progress').evaluate(element => element.tagName), 'PROGRESS');
    assert.equal(await page.locator('#app-update-progress').evaluate(element => element.value / element.max), 0.5);
    assert.ok((await page.locator('#app-update-transfer').textContent()).includes('50%'));
    assert.notEqual(await page.evaluate(() => document.activeElement.id), 'app-update-progress');
    await page.screenshot({ path: path.join(output, 'download-desktop.png'), fullPage: true });
    await page.locator('#app-update-cancel').click(); await statusIncludes('已取消');
    assert.equal(await page.locator('#app-update-download').isEnabled(), true);
    mark('原生进度、重复点击保护、过期读取隔离与取消下载');

    value.phase = 'failed'; value.error = { code: 'update_checksum_mismatch', message: '更新包校验失败，已丢弃下载，请重试' };
    await page.evaluate(() => window.HertzUpdates.refresh());
    await statusIncludes('校验失败');
    assert.equal(await page.locator('#app-update-install').isVisible(), false);
    await page.locator('#app-update-download').click(); await statusIncludes('正在下载');
    value.phase = 'ready'; value.error = null; value.canInstall = true; value.downloadedBytes = release.size;
    await page.evaluate(() => window.HertzUpdates.refresh());
    assert.equal(await page.locator('#app-update-install').isVisible(), false);
    mark('下载校验失败可重试；普通浏览器不能调用原生安装');

    await page.evaluate(() => {
      window.nativeInstalls = [];
      window.__hertzWindowHost = { updateVersion: 1, installUpdate: async operation => { window.nativeInstalls.push(operation); throw new Error('更新工具暂不可用'); } };
      window.dispatchEvent(new Event('hertz-native-host-confirmed'));
    });
    await page.locator('#app-update-install').click(); await statusIncludes('更新工具暂不可用');
    assert.equal(await page.locator('#app-update-install').isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => window.nativeInstalls), [value.operationId]);
    assert.equal(calls.filter(call => call.path.endsWith('/install')).length, 0);
    mark('安装经原生桥传递准确候选；桥失败可重试、不走 HTTP 安装入口');

    holdSave = true;
    await page.locator('#app-update-auto').check();
    assert.equal(await page.locator('#app-update-install').isEnabled(), false);
    await page.locator('#app-update-install').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.deepEqual(await page.evaluate(() => window.nativeInstalls), [value.operationId]);
    await page.waitForFunction(() => !document.getElementById('app-update-auto').disabled);
    assert.equal(await page.locator('#app-update-install').isEnabled(), true);
    mark('保存设置期间禁止原生安装，完成后可继续安装');

    value.phase = 'available'; value.canInstall = false; value.error = null;
    await page.evaluate(() => window.HertzUpdates.refresh());
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert.equal(overflow, false, 'viewport ' + width);
      const bounds = await page.locator('#application-updates').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    }
    await page.screenshot({ path: path.join(output, 'available-mobile.png'), fullPage: true });
    await page.locator('#app-update-check').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'app-update-auto');
    mark('320/390px 不横向溢出；键盘能进入启动检查控件');

    reset({ checkOnStartup: true }); await boot(); await statusIncludes('发现新版本');
    assert.equal(calls.filter(call => call.path.endsWith('/check')).length, 1);
    assert.equal(calls.find(call => call.path.endsWith('/check')).body.automatic, true);
    mark('启用后启动请求携带 automatic 标记，由服务频控');

    const pluginPage = await browser.newPage();
    const pluginHtml = documentHtml(base);
    await pluginPage.goto(base);
    await pluginPage.setContent('<iframe name="dbx-update" sandbox="allow-scripts" style="width:700px;height:700px;border:0"></iframe>');
    await pluginPage.locator('iframe').evaluate((frame, html) => { frame.srcdoc = html; }, pluginHtml);
    const frame = await pluginPage.frame({ name: 'dbx-update' });
    await frame.waitForFunction(() => !!window.HertzUpdates);
    await frame.evaluate(release => {
      window.hertzHost = { isDbx: true };
      window.HertzClipboard = { write: async text => { window.copiedUpdate = text; } };
      window.__hertzWindowHost = { updateVersion: 1, installUpdate() { throw new Error('must not run'); } };
      const status = { currentVersion: '0.3.7', distribution: 'plugin', edition: 'full', phase: 'available', release, checkOnStartup: false, canDownload: false, canInstall: true };
      window.HertzUpdates.init({ kind: 'dbx', get: async () => status });
    }, { ...release, downloadUrl: 'https://github.com/onceMisery/hertz-studio/releases/download/hertz-plugin-full-v0.3.8/io.github.oncemisery.hertz-studio.full-0.3.8-windows-x64.dbxp' });
    await frame.locator('#app-update-copy').waitFor({ state: 'visible' });
    assert.equal(await frame.locator('#app-update-install').isVisible(), false);
    assert.equal(await frame.locator('#app-update-page').isVisible(), false);
    await frame.locator('#app-update-copy').click();
    assert.ok((await frame.evaluate(() => window.copiedUpdate)).endsWith('.dbxp'));
    assert.equal(await frame.evaluate(() => location.origin), 'null');
    await pluginPage.close();
    mark('真实 opaque DBX iframe 可读取与复制插件链接，拒绝伪造原生安装能力');

    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, screenshots: ['download-desktop.png', 'available-mobile.png'], pageErrors: errors }, null, 2));
    console.log('Report: ' + path.join(output, 'report.json'));
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
