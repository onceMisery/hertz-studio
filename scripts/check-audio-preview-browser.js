// SPDX-License-Identifier: MIT
// Exercise production preview controls and the saved form through native Chrome events.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ui = path.resolve(__dirname, '../plugin/ui');
const index = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
const from = index.indexOf('<form class="set-group" id="dsp-settings"');
const to = index.indexOf('</form>', from);
assert.ok(from >= 0 && to > from);
const form = index.slice(from, to + 7);
const css = ['design/design-base.css', 'components/button.css', 'components/form.css',
  'style.css', 'skins/skin.hertz.css', 'audio-quality.css'];
const html = `<!doctype html><html lang="zh-CN" data-skin="hertz"><head><meta charset="utf-8">
${css.map(file => `<link rel="stylesheet" href="/${file}">`).join('')}
<style>body{display:block;overflow:auto;padding:16px}main{max-width:900px;margin:auto}</style></head>
<body><main id="fixture-settings">${form}</main>
<script src="/design/design-themes.js"></script><script src="/themes.js"></script>
<script src="/audio-preview-settings.js"></script><script src="/dsp-settings.js"></script><script>
Theme.apply('hertz-dark', {silent:true});
window.fixture = {
  calls: [], hidden: false, pending: {}, block: {}, failures: {},
  clone(value) { return structuredClone(value); },
  cfg: {
    revision: '0', applied_revision: '0', application_state: 'applied', issues: [],
    requested: {schema_version:2,revision:'0',eq:{enabled:false,
      bands:[60,150,400,1000,2400,6000].map(f=>({frequency_hz:f,q:1.2,gain_db:0}))},
      preamp_db:0,limiter:'true_peak',loudness_source:'file_tags',target_lufs:-18,
      impulse_id:null,tone:{crossfeed:false,crossfeed_amount:0.25,loudness_compensation:false,
        saturation:false,drive:0.15,mix:0.1},headroom_mode:'off',loudness_mode:'off',crossfade_ms:0},
    capabilities:{preview:{available:true},saturation:{available:true},impulse:{available:true}},
    output:{active:true,actual:{device_id:'fixture-local',sample_rate:48000,
      sample_format:'f32',valid_bits:32,mode:'shared'}},
    effective:{eq:{active:true},preview:null}
  },
  preview(body) {
    return {request_id:body.request_id,state:'active',side:'enhanced',
      phase:body.impulse_path?'unknown':'linear_phase',
      matching:body.match_loudness?{residual_lu:0.01,enhanced_attenuation_db:-6,
        bypass_attenuation_db:0,common_attenuation_db:-1}:null};
  },
  reply(key, value) {
    if(this.failures[key]) {delete this.failures[key];return Promise.reject(new Error('fixture lost reply'));}
    if(this.block[key]) {delete this.block[key];return new Promise(resolve=>this.pending[key]=()=>{
      delete this.pending[key];resolve(value);
    });}
    return Promise.resolve(value);
  },
  transport: {
    get(url) {
      fixture.calls.push({method:'GET',url});
      return fixture.reply('get', fixture.clone(fixture.cfg));
    },
    post(url,body) {
      const f=fixture; f.calls.push({method:'POST',url,body:f.clone(body)});
      if(url==='/v1/player/audio-quality/preview') {
        f.cfg.effective.preview=f.preview(body);return f.reply('prepare',f.clone(f.cfg));
      }
      if(url.endsWith('/preview/select')) {
        if(f.cfg.effective.preview && f.cfg.effective.preview.request_id===body.request_id)
          f.cfg.effective.preview.side=body.side;
        return f.reply('select',f.clone(f.cfg));
      }
      if(url.endsWith('/preview/cancel')) {
        if(f.cfg.effective.preview && f.cfg.effective.preview.request_id===body.request_id)
          f.cfg.effective.preview=null;
        return f.reply('cancel',{cancelled:true,message:'试听已结束，恢复当前保存配置。'});
      }
      if(url.endsWith('/preview/refresh')) {
        if(f.expireOnRefresh) f.cfg.effective.preview=null;
        return f.reply('refresh',{refreshed:!!f.cfg.effective.preview});
      }
      if(url==='/v1/player/audio-quality') {
        if(body.expected_revision!==f.cfg.revision) return Promise.reject(new Error('audio_quality_conflict'));
        Object.assign(f.cfg.requested,body.patch);
        if(f.cfg.requested.impulse_id==='')f.cfg.requested.impulse_id=null;
        f.cfg.revision=String(Number(f.cfg.revision)+1);f.cfg.requested.revision=f.cfg.revision;
        f.cfg.applied_revision=f.cfg.revision;f.cfg.effective.preview=null;
        return f.reply('save',f.clone(f.cfg));
      }
      throw new Error(url);
    }
  }
};
window.Stage={isDocumentHidden(){return fixture.hidden;}};
window.controller=HertzDspSettings.init({transport:fixture.transport,toast(){}});
controller.load();</script></body></html>`;

async function main() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(html); return;
    }
    const file = path.resolve(ui, '.' + url.pathname);
    if (!file.startsWith(ui + path.sep) || !fs.existsSync(file)) {
      response.writeHead(404); response.end(); return;
    }
    response.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',
      executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH,headless:true});
    const page = await browser.newPage({viewport:{width:1000,height:850}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}/`;
    async function reset() {
      await page.goto(base);
      await page.waitForFunction(() => document.querySelector('#dsp-status').textContent.includes('已应用到播放输出'));
    }
    async function begin() {
      await page.getByRole('button', {name:'试听当前草稿'}).click();
      await page.waitForFunction(() => document.querySelector('#audio-preview-status').textContent.includes('正在试听'));
    }
    async function end() {
      await page.getByRole('button', {name:'结束试听'}).click();
      await page.waitForFunction(() => !document.querySelector('#audio-preview-start').disabled);
    }

    await reset();
    await page.locator('#dsp-preamp').fill('-4');
    await page.locator('#audio-preview-path').fill('D:\\audio\\unknown-phase.wav');
    await page.getByRole('button', {name:'试听当前草稿'}).click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'audio-preview-phase');
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.method === 'POST').length), 0);
    await page.getByRole('button', {name:'保存音效'}).click();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.url === '/v1/player/audio-quality' && c.method === 'POST').length), 1,
      'A preview-only acknowledgement must not block native saved-form submission');
    assert.equal(await page.evaluate(() => fixture.cfg.requested.preamp_db), -4);
    assert.equal(await page.evaluate(() => 'impulse_path' in fixture.cfg.requested), false);
    console.log('PASS unknown-phase acknowledgement blocks preview and preserves ordinary native save');

    await reset();
    await page.locator('#dsp-preamp').fill('-3');
    await page.locator('#audio-preview-path').fill('D:\\audio\\unknown-phase.wav');
    await page.getByRole('button', {name:'试听当前草稿'}).click();
    await page.locator('#dsp-preamp').press('Enter');
    await page.waitForFunction(() => fixture.cfg.revision === '1');
    assert.equal(await page.evaluate(() => fixture.cfg.requested.preamp_db), -3);
    console.log('PASS implicit keyboard submit clears only preview validation');

    await reset();
    await page.locator('#dsp-preamp').fill('100');
    await page.getByRole('button', {name:'保存音效'}).click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'dsp-preamp');
    assert.equal(await page.evaluate(() => fixture.calls.some(c => c.method === 'POST')), false);
    console.log('PASS native saved-value validation remains active');

    await reset();
    await page.locator('#dsp-preamp').fill('-6');
    await begin();
    assert.match(await page.locator('#audio-preview-status').textContent(), /同响度已匹配.*0.01 LU/);
    assert.match(await page.locator('#dsp-status').textContent(), /临时试听.*原版本/);
    assert.equal(await page.evaluate(() => fixture.cfg.revision), '0');
    await page.getByRole('radio', {name:'旁路',exact:true}).check();
    await page.waitForFunction(() => document.querySelector('#audio-preview-status').textContent.includes('正在试听旁路'));
    assert.equal(await page.locator('#dsp-preamp').inputValue(), '-6');
    await end();
    assert.equal(await page.locator('#dsp-preamp').inputValue(), '-6');
    console.log('PASS matched comparison switches the same reference and keeps the draft and revision');

    await page.locator('#audio-preview-match').uncheck();
    await page.locator('#audio-preview-path').fill('D:\\audio\\unknown-phase.wav');
    await page.locator('#audio-preview-phase').check();
    await begin();
    assert.match(await page.locator('#audio-preview-status').textContent(), /普通旁路，响度未匹配/);
    assert.match(await page.locator('#audio-preview-status').textContent(), /内在相位和群延迟未知/);
    const unknown = await page.evaluate(() => fixture.calls.filter(c => c.url.endsWith('/preview')).at(-1).body);
    assert.equal(unknown.acknowledge_unknown_phase, true);
    assert.equal(unknown.match_loudness, false);
    assert.equal('volume' in unknown.patch, false);
    assert.equal('limiter' in unknown.patch, false);
    assert.equal('crossfade_ms' in unknown.patch, false);
    await end();
    console.log('PASS ordinary bypass and unknown-phase explanation preserve frozen controls');

    await reset();
    await begin();
    await page.evaluate(() => {fixture.block.cancel=true;});
    await page.getByRole('button', {name:'保存音效'}).click();
    await page.waitForFunction(() => !!fixture.pending.cancel);
    assert.equal(await page.evaluate(() => fixture.calls.some(c => c.url === '/v1/player/audio-quality' && c.method === 'POST')), false);
    assert.equal(await page.locator('#audio-preview-start').isDisabled(), true);
    await page.evaluate(() => fixture.pending.cancel());
    await page.waitForFunction(() => fixture.cfg.revision === '1');
    const order = await page.evaluate(() => fixture.calls.filter(c => c.method === 'POST').map(c => c.url));
    assert.deepEqual(order, ['/v1/player/audio-quality/preview','/v1/player/audio-quality/preview/cancel','/v1/player/audio-quality']);
    console.log('PASS save waits for cancellation and disables a competing preview');

    await reset();
    await page.evaluate(() => {fixture.block.prepare=true;});
    await page.getByRole('button', {name:'试听当前草稿'}).click();
    await page.waitForFunction(() => !!fixture.pending.prepare);
    await page.locator('#dsp-preamp').fill('-7');
    await page.waitForFunction(() => !fixture.cfg.effective.preview);
    await page.evaluate(() => fixture.pending.prepare());
    await page.waitForFunction(() => !document.querySelector('#audio-preview-start').disabled);
    assert.equal(await page.locator('#dsp-preamp').inputValue(), '-7');
    assert.equal(await page.locator('#audio-preview-enhanced').isDisabled(), true);
    assert.doesNotMatch(await page.locator('#audio-preview-status').textContent(), /同响度已匹配/);
    console.log('PASS cancelled late preparation cannot re-adopt or overwrite a newer draft');

    await reset();
    await begin();
    await page.evaluate(() => {fixture.block.select=true;});
    await page.getByRole('radio', {name:'旁路',exact:true}).check();
    await page.waitForFunction(() => !!fixture.pending.select);
    await end();
    await page.evaluate(() => fixture.pending.select());
    assert.equal(await page.locator('#audio-preview-enhanced').isDisabled(), true);
    assert.doesNotMatch(await page.locator('#dsp-status').textContent(), /临时试听/);
    console.log('PASS late side-selection receipt cannot restore cancelled preview');

    await reset();
    await begin();
    await page.evaluate(() => {fixture.failures.cancel=true;});
    await end();
    await page.waitForFunction(() => !document.querySelector('#audio-preview-start').disabled);
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.url.endsWith('/preview/cancel')).length), 1);
    assert.equal(await page.locator('#audio-preview-enhanced').isDisabled(), true);
    console.log('PASS lost cancel receipt reconciles through GET without repeated cancellation');

    await reset();
    await page.locator('#dsp-preamp').fill('-8');
    await page.evaluate(() => {
      fixture.cfg.effective.preview=fixture.preview({request_id:'b0000000-0000-4000-8000-000000000000',match_loudness:false});
      controller.load();
    });
    await page.waitForFunction(() => document.querySelector('#audio-preview-status').textContent.includes('另一界面'));
    assert.equal(await page.locator('#audio-preview-start').isDisabled(), true);
    assert.equal(await page.locator('#audio-preview-end').isDisabled(), false);
    assert.equal(await page.locator('#audio-preview-enhanced').isDisabled(), true);
    await end();
    assert.equal(await page.locator('#dsp-preamp').inputValue(), '-8');
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.url.endsWith('/preview/cancel')).at(-1).body.request_id),
      'b0000000-0000-4000-8000-000000000000');
    console.log('PASS foreign preview offers explicit cancellation and preserves local draft');

    await reset();
    await begin();
    await page.evaluate(() => {
      fixture.failures.refresh=true;
      fixture.expireOnRefresh=true;
    });
    await page.waitForFunction(() => fixture.calls.some(c => c.url.endsWith('/preview/refresh')), null, {timeout:8000});
    await page.waitForFunction(() => !document.querySelector('#audio-preview-start').disabled);
    assert.equal(await page.locator('#audio-preview-enhanced').isDisabled(), true);
    console.log('PASS disconnected heartbeat reconciles expired server preview through GET');

    await reset();
    await begin();
    await page.evaluate(() => {document.querySelector('#fixture-settings').hidden=true;});
    await page.waitForFunction(() => !fixture.cfg.effective.preview);
    await page.evaluate(() => {document.querySelector('#fixture-settings').hidden=false;});
    await page.waitForFunction(() => !document.querySelector('#audio-preview-start').disabled);
    await begin();
    await page.evaluate(() => {fixture.hidden=true;window.dispatchEvent(new Event('hertz-native-presentation'));});
    await page.waitForFunction(() => !fixture.cfg.effective.preview);
    const hiddenCalls = await page.evaluate(() => fixture.calls.length);
    await page.waitForTimeout(1100);
    assert.equal(await page.evaluate(() => fixture.calls.length), hiddenCalls);
    await page.evaluate(() => {fixture.hidden=false;window.dispatchEvent(new Event('hertz-native-presentation'));});
    await begin();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForFunction(() => !fixture.cfg.effective.preview);
    const closedCalls = await page.evaluate(() => fixture.calls.length);
    await page.evaluate(() => {
      controller.load();
      document.querySelector('#dsp-settings').dispatchEvent(new Event('submit',{cancelable:true}));
      document.querySelector('#audio-preview-start').click();
    });
    assert.equal(await page.evaluate(() => fixture.calls.length), closedCalls);
    console.log('PASS ancestor hiding, native hiding and page exit cancel and retire subscriptions');

    await reset();
    await page.locator('#audio-preview-match').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#audio-preview-match').isChecked(), false);
    await page.locator('#audio-preview-start').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#audio-preview-status').textContent.includes('普通旁路'));
    await page.locator('#audio-preview-enhanced').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('#audio-preview-status').textContent.includes('正在试听旁路'));
    console.log('PASS keyboard controls activate preview and switch reference sides');

    await page.setViewportSize({width:390,height:844});
    for (const theme of ['dark','light']) {
      const observed = await page.evaluate(theme => {
        Theme.apply('hertz-' + theme, {silent:true});
        document.documentElement.dataset.hzTone=theme;
        document.documentElement.style.zoom='2';
        const rgb = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g).map(Number);
        return {id:Theme.current().id, luminance:rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722};
      }, theme);
      assert.equal(observed.id, 'hertz-' + theme);
      assert.equal(observed.luminance > 150, theme === 'light', 'Theme must change the rendered palette');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth+2), false);
      assert.equal(await page.locator('#audio-preview-start').isVisible(), true);
      assert.equal(await page.locator('#audio-preview-status').isVisible(), true);
      const artifactDir = path.resolve(__dirname, '../output/playwright/audio-preview');
      fs.mkdirSync(artifactDir, {recursive:true});
      await page.locator('#audio-quality-preview').screenshot({path:path.join(artifactDir, `390-200-${theme}.png`)});
    }
    assert.deepEqual(errors, []);
    console.log('PASS 390 px at 200 percent, both themes and clean browser execution');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
