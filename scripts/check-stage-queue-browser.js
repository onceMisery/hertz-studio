#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin/ui/stage3d.js'), 'utf8');
function shippedFunction(name) {
  const at = source.indexOf('  function ' + name + '(');
  assert.ok(at >= 0, name);
  const next = source.indexOf('\n  function ', at + 3);
  return source.slice(at, next);
}
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent('<main id="s3d" class="s3d s3d-open s3d-chrome" data-scene="silk" tabindex="0"><aside id="s3d-queue-panel" class="s3d-queue" hidden><div class="s3d-queue-head"><span>播放队列<b id="s3d-queue-count"></b></span><button id="s3d-queue-close">关闭</button></div><div id="s3d-queue-list" class="s3d-queue-list"></div></aside><div id="s3d-settings" hidden></div><button id="s3d-queue" style="position:absolute;right:0;bottom:0">播放队列</button></main>');
    for (const file of ['style.css', 'stage3d.css']) await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'plugin/ui', file), 'utf8') });
    const prelude = 'var root=document.getElementById("s3d"),global=window,active=true,chromeTimer=null,dragging=false,seeking=false,CHROME_HIDE_MS=2600,queueOpen=false,queuePinned=false,shelf=null;var queueData=[{id:"a",title:"A",playing:true},{id:"b",title:"B"}];var controls=[];function $(id){return document.getElementById(id)}function text(id,v){$(id).textContent=v}function fmt(){return "3:00"}function control(a,v){controls.push([a,v])}';
    await page.addScriptTag({ content: prelude + ['chromeKeyboardFocus', 'pokeChrome', 'setQueuePinned', 'bindQueuePin', 'setQueuePanel', 'renderQueuePanel', 'isTyping', 'onKeyDown'].map(shippedFunction).join('\n') + '\nbindQueuePin();document.addEventListener("keydown",onKeyDown,true);' + source.split(/\r?\n/).find((line) => line.includes("$('s3d-queue-close').addEventListener('click'")) });
    await page.keyboard.press('q');
    assert.equal(await page.locator('#s3d-queue-panel').isVisible(), true);
    assert.equal(await page.locator('#s3d-queue-pin').getAttribute('aria-pressed'), 'false');
    await page.locator('#s3d-queue-pin').click();
    await page.locator('#s3d').click({ position: { x: 900, y: 450 } });
    await page.waitForTimeout(3000);
    const pinned = await page.locator('#s3d-queue-panel').evaluate((panel) => ({ opacity: getComputedStyle(panel).opacity, pointerEvents: getComputedStyle(panel).pointerEvents, chrome: panel.closest('#s3d').classList.contains('s3d-chrome') }));
    assert.deepEqual(pinned, { opacity: '1', pointerEvents: 'auto', chrome: false }, 'pinned queue stays visible independently of hidden chrome');
    await page.locator('#s3d-queue-pin').click();
    await page.locator('#s3d').click({ position: { x: 900, y: 450 } });
    await page.waitForTimeout(3000);
    assert.equal(await page.locator('#s3d-queue-panel').evaluate((panel) => getComputedStyle(panel).opacity), '0', 'unpin restores peek auto hide');
    await page.keyboard.press('q'); // close the still-open peek
    await page.keyboard.press('q'); // open again
    await page.locator('#s3d-queue-pin').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#s3d-queue-panel').isVisible(), false);
    assert.equal(await page.locator('#s3d-queue-pin').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 's3d-queue');
    await page.keyboard.press('q');
    await page.locator('#s3d-queue-pin').click();
    await page.locator('#s3d-queue-close').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 's3d-queue');
    assert.equal(await page.evaluate(() => queuePinned), false);
    assert.equal(await page.evaluate(() => queueData.length), 2);
    assert.deepEqual(await page.evaluate(() => controls), [], 'pin and close never dispatch audio commands');
    assert.deepEqual(errors, []);
    console.log('Stage queue: explicit pin, independent visibility, unpin, Escape/close focus and untouched playback passed.');
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
