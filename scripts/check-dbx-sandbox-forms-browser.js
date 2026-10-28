// SPDX-License-Identifier: MIT
// DBX 沙箱里的表单提交：宿主给插件 iframe 的是 sandbox="allow-scripts"，没有
// allow-forms，浏览器根本不派发 submit。这条检查用真沙箱帧复现它，并证明
// hertzHost.onSubmit 的两条补偿路径各自生效、且不会和原生提交重复执行。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ui = path.resolve(__dirname, '../plugin/ui');
const hostSource = fs.readFileSync(path.join(ui, 'host.js'), 'utf8');

const FRAME_DOC = `<!doctype html><meta charset=utf-8><body style="margin:0">
<form id="f"><input id="q" type="url" required value="https://example.org/feed.xml">
<button id="go" class="btn" type="submit" style="width:120px;height:40px">订阅</button></form>
<form id="probe"><input id="p" value="x"><button id="pgo" type="submit" style="width:120px;height:40px">native</button></form>
<script>${hostSource}</script>
<script>
  window.__runs = 0;
  window.__clicks = 0;
  window.__native = 0;
  window.__name = new URLSearchParams(location.search).get('n') || '';
  window.hertzHost.onSubmit(document.getElementById('f'), function () { window.__runs += 1; });
  document.getElementById('go').addEventListener('click', function () { window.__clicks += 1; });
  document.getElementById('probe').addEventListener('submit', function (event) {
    event.preventDefault(); window.__native += 1;
  });
  window.__center = function (id) {
    var b = document.getElementById(id).getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
<\/script>
</body>`;

const HOST_DOC = `<!doctype html><meta charset=utf-8><body style="margin:0">
<iframe id="sandboxed" src="https://form.test/f?n=sandboxed" sandbox="allow-scripts" style="width:520px;height:220px;border:0"></iframe>
<iframe id="plain" src="https://form.test/f?n=plain" style="width:520px;height:220px;border:0;margin-top:240px"></iframe>
</body>`;

async function frameOf(page, name) {
  const box = await page.locator('#' + name).boundingBox();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    for (const frame of page.frames()) {
      try {
        if (await frame.evaluate(label => window.__name === label && typeof window.__runs === 'number', name)) {
          return { frame, box };
        }
      } catch (err) { /* 还没解析完 */ }
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(name + ' frame never ready');
}

async function click(page, box, frame, id) {
  const point = await frame.evaluate(name => window.__center(name), id);
  await page.mouse.click(box.x + point.x, box.y + point.y);
}

async function runs(frame) {
  return frame.evaluate(() => ({ runs: window.__runs, value: document.getElementById('q').value }));
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 560, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.hostname === 'form.test' && url.pathname === '/host',
      route => route.fulfill({ contentType: 'text/html', body: HOST_DOC }));
    await page.route(url => url.hostname === 'form.test' && url.pathname === '/f',
      route => route.fulfill({ contentType: 'text/html', body: FRAME_DOC }));
    await page.goto('https://form.test/host');

    const plain = await frameOf(page, 'plain');
    const sandboxed = await frameOf(page, 'sandboxed');

    // 沙箱帧：浏览器不派发 submit，只有补偿路径能让处理器跑到第二次。
    assert.equal((await runs(sandboxed.frame)).runs, 0, 'the bound handler has not run yet');
    await click(page, sandboxed.box, sandboxed.frame, 'go');
    assert.deepEqual(await runs(sandboxed.frame), { runs: 1, value: 'https://example.org/feed.xml' },
      'a real click subscribes inside the allow-scripts-only sandbox');
    await sandboxed.frame.evaluate(() => { document.getElementById('q').value = 'https://example.org/enter.xml'; });
    await click(page, sandboxed.box, sandboxed.frame, 'q');
    await page.keyboard.press('Enter');
    assert.equal((await runs(sandboxed.frame)).runs, 2, 'Enter in the input submits inside the sandbox too');
    assert.equal(await sandboxed.frame.evaluate(() => window.__clicks), 1,
      'Enter is taken by the keydown path instead of leaning on an engine-synthesized button click');
    await sandboxed.frame.evaluate(() => { document.getElementById('q').value = 'not-a-url'; });
    await click(page, sandboxed.box, sandboxed.frame, 'go');
    assert.equal((await runs(sandboxed.frame)).runs, 2, 'an invalid URL still stops at constraint validation');
    await click(page, sandboxed.box, sandboxed.frame, 'pgo');
    assert.equal(await sandboxed.frame.evaluate(() => window.__native), 0,
      'premise: the allow-scripts-only sandbox never dispatches submit at all');

    // 无沙箱帧：两条补偿路径不能和原生 submit 叠加成双次执行。
    await click(page, plain.box, plain.frame, 'go');
    assert.equal((await runs(plain.frame)).runs, 1, 'a click runs the handler exactly once without the sandbox');
    await plain.frame.evaluate(() => { document.getElementById('q').value = 'https://example.org/enter.xml'; });
    await click(page, plain.box, plain.frame, 'q');
    await page.keyboard.press('Enter');
    assert.equal((await runs(plain.frame)).runs, 2, 'Enter runs the handler exactly once without the sandbox');
    await plain.frame.evaluate(() => { document.getElementById('f').requestSubmit(); });
    assert.equal((await runs(plain.frame)).runs, 3, 'requestSubmit keeps working where forms are allowed');
    await click(page, plain.box, plain.frame, 'pgo');
    assert.equal(await plain.frame.evaluate(() => window.__native), 1,
      'outside the sandbox an ordinary submit listener still gets the native event');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('DBX sandbox forms: sandboxed click/Enter, constraint validation, single-run without sandbox and requestSubmit parity passed.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
