// SPDX-License-Identifier: MIT
// Run against an isolated hertz-studio. Upstream/playback responses are fixtures.
const fs = require('node:fs');
const { uiUrl } = require('./ui-token');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    if (process.env.SEARCH_LOCAL_ASSETS === '1') {
      await page.route('**/online.js', route => route.fulfill({contentType:'application/javascript',body:fs.readFileSync('plugin/ui/online.js','utf8')}));
    }
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    let active = false, fail = true, delayed = false, release;
    let trackIndex = 0;
    const tracks = [1,2,3].map(id => ({source:'netease', id:String(id),title:'FM 曲目 '+id,artist:'测试歌手',duration_ms:180000}));
    await page.route('**/v1/online/radio', async route => {
      if (route.request().method() === 'POST') {
        const action = route.request().postDataJSON().action;
        if (action === 'start' && delayed) {
          await new Promise(resolve => { release = resolve; });
          return route.fulfill({json:{active:true,loading:false,tracks,index:0}});
        }
        if (action === 'start' && fail) {
          fail = false;
          return route.fulfill({status:401,json:{error:{code:'auth_required',message:'此音源当前要求登录后使用 FM'}}});
        }
        if (action === 'start' || action === 'retry') active = true;
        if (action === 'stop') active = false;
        if (action === 'next') trackIndex++;
      }
      return route.fulfill({json:{active, loading:false,error:null,tracks:active?tracks:[],index:trackIndex}});
    });
    await page.goto(uiUrl(process.env.SEARCH_UI_URL || 'http://127.0.0.1:18766'));
    await page.getByRole('button',{name:'在线曲库',exact:true}).click();
    await page.locator('#radio-start').click();
    await page.waitForFunction(() => document.querySelector('#radio-status').textContent.includes('要求登录'));
    await page.locator('#radio-retry').click();
    await page.locator('#radio-track').filter({hasText:'FM 曲目 1'}).waitFor();
    await page.locator('#radio-next').click();
    await page.locator('#radio-track').filter({hasText:'FM 曲目 2'}).waitFor();
    fs.mkdirSync('output/playwright',{recursive:true});
    for (const width of [1440,390,320]) {
      await page.setViewportSize({width,height:960});
      await page.locator('.online-scroll').evaluate(el => { el.scrollTop = 0; });
      const overflow = await page.locator('.online-radio').evaluate(el => el.scrollWidth > el.clientWidth + 1);
      assert.equal(overflow,false,'FM overflows at '+width);
      await page.screenshot({path:'output/playwright/radio-'+width+'.png'});
    }
    await page.locator('#radio-stop').click();
    await page.locator('#radio-start').waitFor();
    delayed = true;
    await page.locator('#radio-start').click();
    await page.waitForFunction(() => document.querySelector('#radio-status').textContent.includes('加载'));
    // A second action can cancel the slow start; its late reply must stay inert.
    await page.locator('#radio-stop').click();
    await page.locator('#radio-start').waitFor();
    release();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#radio-start').isVisible(),true);
    assert.equal(await page.locator('#radio-track').isVisible(),false);
    assert.deepEqual(errors,[]);
    console.log('FM browser checks passed: auth error, retry, next, exit, late response, 320/390px layout.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e);process.exitCode=1; });
