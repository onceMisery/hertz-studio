// SPDX-License-Identifier: MIT
// Main-player lyrics settings with a controlled transport. No desktop host or user data.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), ui = path.join(root, 'plugin/ui');
const output = path.join(root, 'output/playwright/desktop-lyrics-settings-browser-' + Date.now());
const initialLyrics = {
  enabled: false, locked: true, layout: 'double', secondary: 'next', theme: 'dark', surface: 'glass', align: 'center',
  bilingual: false, showVocals: true, karaoke: true, readabilityBoost: false, fontFamily: 'Segoe UI', fontSize: 32, fontWeight: 600,
  sungColor: '#8fe3ff', unsungColor: '#ffffff', outlineColor: '#141419', outlineWidth: 2, opacity: .92,
  width: 760, anchorX: .43, anchorY: .78, monitor: null,
};
const checks = [], errors = [];
const mark = message => { checks.push(message); console.log('PASS ' + message); };

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const index = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
  const fieldsetStart = index.lastIndexOf('<fieldset', index.indexOf('id="desktop-lyrics-settings"'));
  assert.ok(fieldsetStart >= 0, 'Production desktop lyrics fieldset must exist before running this check');
  let depth = 0, fieldset = '';
  for (const tag of index.slice(fieldsetStart).matchAll(/<\/?fieldset\b[^>]*>/g)) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (!depth) { fieldset = index.slice(fieldsetStart, fieldsetStart + tag.index + tag[0].length); break; }
  }
  assert.ok(fieldset.includes('id="dls-apply"'), 'Fixture includes the whole production fieldset');
  const spriteStart = index.indexOf('<svg id="icon-sprite"');
  const sprite = index.slice(spriteStart, index.indexOf('</svg>', spriteStart) + 6);
  const css = ['design/design-base.css', 'components/button.css', 'components/form.css', 'style.css',
    'skins/skin.hertz.css', 'desktop-lyrics-settings.css'];
  const html = `<!doctype html><html lang="zh-CN" data-skin="hertz"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${css.map(file => `<link rel="stylesheet" href="/ui/${file}">`).join('')}
<style>body{display:block;min-width:0;height:auto;padding:24px;overflow:auto}main{max-width:960px;margin:auto}.set-group{max-width:100%;min-width:0}@media(max-width:500px){body{padding:12px}}</style>
</head><body>${sprite}<button id="open-lyrics" onclick="HertzDesktopLyricsSettings.open()">歌词样式与布局</button><main>${fieldset}</main><script src="/ui/design/design-themes.js"></script><script src="/ui/themes.js"></script><script src="/ui/desktop-lyrics-settings.js"></script></body></html>`;
  const server = http.createServer((request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
    const file = path.resolve(ui, decodeURIComponent(request.url.replace(/^\/ui\//, '').split('?')[0]));
    if (!file.startsWith(ui + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  let page;
  async function fixture(options = {}) {
    if (page) await page.close();
    page = await browser.newPage({ viewport: { width: 1120, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(({ lyrics, options }) => {
      Theme.init();
      window.hertzHost = { isDbx: !!options.dbx };
      window.test = { calls: [], revision: 9, lyrics, editing: false, owner: null, holdApply: false, failApply: false };
      const t = window.test;
      t.snapshot = owner => ({ ok: true, revision: t.revision, lyricsConfig: structuredClone(t.lyrics),
        positionEditing: t.editing, positionOwned: t.editing && t.owner === owner, positionLeaseMs: 120000,
        canLock: true, pendingSave: false, runtime: { enabled: t.editing || t.lyrics.enabled,
          locked: t.editing ? false : t.lyrics.locked, visible: t.editing, userHidden: false, source: 'no_content', policy: { noContent: true } } });
      t.transport = { async post(url, request, options) {
        t.calls.push({ url, ...structuredClone(request), options });
        const value = request.value || {}, command = request.command;
        if (command === 'lyrics-settings') return t.snapshot(value.owner);
        if (command === 'lyrics-apply') {
          if (t.holdApply) { t.holdApply = false; await new Promise(resolve => { t.resolveApply = resolve; }); }
          if (t.failApply) { t.failApply = false; throw new Error('夹具模拟磁盘写入失败'); }
          if (value.expectedRevision !== t.revision) return { ...t.snapshot(value.owner), ok: false, error: 'revision_conflict', message: '设置已在别处更新，请重新读取后再保存。' };
          t.lyrics = structuredClone(value.lyrics); t.revision++;
          return t.snapshot(value.owner);
        }
        if (command === 'lyrics-position-begin') {
          if (t.holdBegin) { t.holdBegin = false; await new Promise(resolve => { t.resolveBegin = resolve; }); }
          t.editing = true; t.owner = value.owner; return t.snapshot(value.owner);
        }
        if (command === 'lyrics-position-cancel' || command === 'lyrics-position-done') {
          if (command === 'lyrics-position-cancel' && t.failCancel) { t.failCancel = false; throw new Error('夹具模拟取消请求断网'); }
          if (t.owner !== value.owner) return { ...t.snapshot(value.owner), ok: false, error: 'position_owner_mismatch', message: '其他页面正在定位歌词' };
          t.editing = false; t.owner = null;
          return t.snapshot(value.owner);
        }
        throw new Error('Unexpected command: ' + command);
      } };
      HertzDesktopLyricsSettings.init(t.transport);
    }, { lyrics: structuredClone(initialLyrics), options });
    return page;
  }
  const calls = command => page.evaluate(command => test.calls.filter(call => call.command === command), command);
  const load = () => page.evaluate(() => HertzDesktopLyricsSettings.refresh());
  const settle = () => page.waitForFunction(() => !document.getElementById('dls-refresh').disabled);
  try {
    await fixture({ dbx: true });
    await load(); await page.evaluate(() => HertzDesktopLyricsSettings.focus());
    assert.equal(await page.locator('#desktop-lyrics-settings').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => test.calls), []);
    mark('DBX keeps the standalone settings hidden and sends no desktop request');

    await fixture();
    assert.deepEqual(await page.evaluate(() => test.calls), [], 'init must not start a desktop host');
    await page.evaluate(() => { delete test.lyrics.showVocals; });
    assert.equal(await page.locator('#desktop-lyrics-dialog').isVisible(), false);
    await page.locator('#open-lyrics').click(); await settle();
    assert.equal((await calls('lyrics-settings')).length, 1);
    assert.equal(await page.locator('#dls-enabled').isChecked(), false);
    assert.equal(await page.locator('#dls-locked').isChecked(), true);
    assert.equal(await page.locator('#dls-font-size').inputValue(), '32');
    assert.equal(await page.locator('#dls-show-vocals').isChecked(), true, 'Missing legacy preference adopts true');
    assert.equal(await page.locator('#dls-vocals-help').textContent(), '按作者标注显示同时演唱的内容，正文和副行合计最多四槽；空间不足时减少显示并提示');
    mark('Explicit read hydrates the full saved settings; initialization is side effect free');

    await page.locator('#dls-enabled').check();
    await page.locator('#dls-locked').uncheck();
    await page.locator('#dls-layout').selectOption('triple');
    await page.locator('#dls-bilingual').check();
    await page.locator('#dls-show-vocals').uncheck();
    await page.locator('#dls-font-size').fill('38');
    await page.locator('#dls-sung-color').fill('#cfbefa');
    assert.equal((await calls('lyrics-apply')).length, 0, 'previewing a draft must not save');
    await page.evaluate(() => { test.holdApply = true; });
    await page.locator('#dls-apply').click();
    await page.waitForFunction(() => !!test.resolveApply);
    assert.equal(await page.locator('#dls-apply').isDisabled(), true);
    const request = (await calls('lyrics-apply'))[0];
    assert.equal(request.url, '/v1/desktop/control');
    assert.equal(request.value.expectedRevision, 9);
    assert.deepEqual(request.value.lyrics, { ...initialLyrics, enabled: true, locked: false, layout: 'triple', bilingual: true, showVocals: false, fontSize: 38, sungColor: '#cfbefa' });
    assert.ok(!('wallpaper' in request.value) && !('config' in request.value));
    await page.evaluate(() => test.resolveApply()); await settle();
    assert.equal((await calls('lyrics-apply')).length, 1);
    assert.equal(await page.evaluate(() => test.revision), 10);
    assert.equal(await page.evaluate(() => test.lyrics.showVocals), false);
    mark('Draft changes preview locally; one guarded full-lyrics save preserves anchors and unrelated domains');

    await page.locator('#dls-font-size').fill('44');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#desktop-lyrics-dialog').isVisible(), false);
    assert.equal(await page.locator('#open-lyrics').evaluate(node => node === document.activeElement), true);
    await page.locator('#open-lyrics').click(); await settle();
    assert.equal(await page.locator('#dls-font-size').inputValue(), '44', 'Reopening preserves the unsaved draft');
    assert.equal(await page.evaluate(() => test.lyrics.fontSize), 38, 'Closing must not save the draft');
    mark('Native dialog Escape returns focus and reopening retains the unsaved draft');

    await page.locator('#dls-font-size').fill('46');
    await page.evaluate(() => { test.failApply = true; });
    await page.locator('#dls-apply').click(); await settle();
    assert.equal(await page.locator('#dls-font-size').inputValue(), '46');
    assert.equal(await page.evaluate(() => test.lyrics.fontSize), 38);
    assert.equal(await page.locator('#dls-apply').isEnabled(), true);
    assert.match(await page.locator('#dls-status').innerText(), /失败|未保存/);
    mark('A failed save retains the editable draft and leaves the saved configuration unchanged');

    await page.evaluate(() => { test.lyrics.fontSize = 29; test.revision++; });
    await page.locator('#dls-apply').click(); await settle();
    assert.equal(await page.locator('#dls-font-size').inputValue(), '46');
    assert.equal(await page.locator('#dls-conflict').isVisible(), true);
    assert.equal(await page.evaluate(() => test.lyrics.fontSize), 29);
    await page.locator('#dls-discard').click(); await settle();
    assert.equal(await page.locator('#dls-font-size').inputValue(), '29');
    mark('Revision conflict preserves the draft until explicit discard reloads the current settings');

    await page.locator('#dls-position-begin').click(); await settle();
    const began = (await calls('lyrics-position-begin')).at(-1);
    assert.match(began.value.owner, /^[0-9a-f-]{36}$/i);
    assert.equal(await page.locator('#dls-position-cancel').isVisible(), true);
    await page.locator('#dls-position-cancel').click(); await settle();
    assert.equal((await calls('lyrics-position-cancel')).at(-1).value.owner, began.value.owner);
    assert.equal(await page.evaluate(() => test.editing), false);
    mark('Position begin/cancel uses one document owner and returns to the saved state');

    await page.evaluate(() => { test.holdBegin = true; });
    await page.locator('#dls-position-begin').click();
    await page.waitForFunction(() => !!test.resolveBegin);
    await page.evaluate(() => { document.getElementById('desktop-lyrics-settings').hidden = true; test.resolveBegin(); });
    await page.waitForFunction(() => test.calls.filter(call => call.command === 'lyrics-position-cancel').length === 2 && !test.editing);
    assert.equal((await calls('lyrics-position-cancel')).at(-1).options.keepalive, true);
    await page.evaluate(() => { document.getElementById('desktop-lyrics-settings').hidden = false; });
    mark('Leaving settings while position begin is pending cancels the eventual session instead of leaking ownership');

    await page.clock.install();
    await page.locator('#dls-position-begin').click(); await settle();
    await page.evaluate(() => { test.failCancel = true; });
    await page.locator('#dls-position-cancel').click(); await settle();
    assert.equal(await page.evaluate(() => test.editing), true, 'failed request leaves the native lease unconfirmed');
    assert.equal(await page.locator('#dls-status').getAttribute('data-error'), 'true');
    const readsAfterCancel = (await calls('lyrics-settings')).length;
    await page.evaluate(() => document.getElementById('desktop-lyrics-settings').classList.add('cancel-review'));
    await page.clock.fastForward(11000); await settle();
    assert.equal((await calls('lyrics-settings')).length, readsAfterCancel, 'manual cancellation failure stops renewal even after visibility re-evaluation');
    await page.locator('#dls-refresh').click(); await settle();
    assert.equal((await calls('lyrics-settings')).length, readsAfterCancel + 1, 'explicit refresh can confirm the still-owned session');
    await page.clock.fastForward(11000); await settle();
    assert.equal((await calls('lyrics-settings')).length, readsAfterCancel + 1, 'an explicit check does not restart automatic renewal after cancellation');
    await page.locator('#dls-position-cancel').click(); await settle();
    assert.equal(await page.evaluate(() => test.editing), false);
    mark('Failed manual cancellation stops lease renewal until an explicit check or retry, allowing the native timeout to restore the original state');

    for (const theme of ['hertz-dark', 'hertz-light']) {
      await page.evaluate(value => Theme.apply(value), theme);
      for (const width of [1120, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        // 视口变化后布局在下一帧才稳定；连等两帧再量用户能感知的几何。
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        // 弹窗框架自身必须完整落在视口内；窄屏（H5）应为全屏形态。
        const frame = await page.locator('#desktop-lyrics-dialog').evaluate(el => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width,
            viewport: innerWidth, viewportHeight: innerHeight, cssWidth: getComputedStyle(el).width };
        });
        const geometry = await page.locator('#desktop-lyrics-settings').evaluate(el => {
          const bounds = el.getBoundingClientRect();
          return { scroll: el.scrollWidth, client: el.clientWidth, left: bounds.left, right: bounds.right, viewport: innerWidth,
            overflow: [...el.querySelectorAll('*')].filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => node.id || node.className) };
        });
        assert.ok(geometry.scroll <= geometry.client + 1 && geometry.left >= 0 && geometry.right <= geometry.viewport + 1,
          theme + ' ' + width + ' no horizontal overflow: ' + JSON.stringify(geometry) + ' frame=' + JSON.stringify(frame));
        assert.ok(frame.left >= -1 && frame.right <= frame.viewport + 1 && frame.top >= -1 && frame.bottom <= frame.viewportHeight + 1,
          theme + ' ' + width + ' modal fits the viewport: ' + JSON.stringify(frame));
        if (width < 768) assert.ok(frame.width >= frame.viewport - 1, theme + ' ' + width + ' H5 modal uses the full width');
        await page.locator('#dls-bilingual').focus();
        const before = await page.locator('#dls-bilingual').isChecked();
        await page.keyboard.press('Space');
        assert.equal(await page.locator('#dls-bilingual').isChecked(), !before);
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.getElementById('desktop-lyrics-settings').contains(document.activeElement)), true);
        await page.screenshot({ path: path.join(output, theme + '-' + width + '.png'), fullPage: true });
      }
    }
    mark('Dark/light at 1120 / 390 / 320px keep keyboard operation, a viewport-fitting modal and no horizontal overflow');
    // H5 首屏直接打开（视口自始至终是窄屏），而非从桌面宽度缩过来。
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.getElementById('desktop-lyrics-dialog').close());
    await page.locator('#open-lyrics').click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const mobile = await page.locator('#desktop-lyrics-dialog').evaluate(el => {
      const r = el.getBoundingClientRect(), body = el.querySelector('.dls-dialog-body');
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width,
        viewport: innerWidth, viewportHeight: innerHeight, bodyScroll: body.scrollWidth, bodyClient: body.clientWidth };
    });
    assert.ok(mobile.left >= -1 && mobile.right <= mobile.viewport + 1 && mobile.top >= -1 && mobile.bottom <= mobile.viewportHeight + 1,
      'H5 direct open fits the viewport: ' + JSON.stringify(mobile));
    assert.ok(mobile.width >= mobile.viewport - 1, 'H5 direct open uses the full width');
    assert.ok(mobile.bodyScroll <= mobile.bodyClient + 1, 'H5 direct open has no horizontal overflow: ' + JSON.stringify(mobile));
    mark('H5 direct open fills the screen, keeps the body scrollable and has no horizontal overflow');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks, errors, scope: 'Real production module and fieldset; controlled desktop transport, no native process.' }, null, 2));
    console.log('Desktop lyrics settings browser: ' + checks.length + ' groups; ' + output);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: false, checks, errors, error: error.stack }, null, 2));
    throw error;
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
