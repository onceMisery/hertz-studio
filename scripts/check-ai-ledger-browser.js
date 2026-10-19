// SPDX-License-Identifier: MIT
// Read-only ledger against a real isolated service and historical SQLite facts.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {startFixture}=require('./ui-browser-fixture');
const {uiUrl}=require('./ui-token');
const output=path.resolve(process.env.AI_LEDGER_OUTPUT || path.join(__dirname,'../output/playwright/ai-ledger'));
async function main(){
  fs.mkdirSync(output,{recursive:true});
  const fixture=await startFixture();process.env.VMUSIC_DATA_DIR=fixture.dataDir;
  await fixture.api('/v1/ai/status');
  const date=new Date();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()-1);
  const month=date.toISOString().slice(0,7);
  execFileSync(process.env.PYTHON || 'python',['-c',`
import sqlite3,sys,json,time,datetime
db=sqlite3.connect(sys.argv[1]); month=sys.argv[2]; now=int(time.time()*1000)
owner=db.execute('SELECT owner_instance_id FROM ai_instance LIMIT 1').fetchone()[0]
accepted=int(datetime.datetime.fromisoformat(month+'-02T00:00:00+00:00').timestamp()*1000)
snapshot=json.dumps(dict(provider='fixture',model='v1',pricingVersion='fixture-v1',reservationMicroUsd=50000,inputMicroUsdPerMillion=1000,outputMicroUsdPerMillion=2000,maxInputTokens=1000,maxOutputTokens=1000))
for i in range(22):
 db.execute('INSERT INTO ai_usage_entries (job_id,accepted_month,reservation_micro_usd,accounted_micro_usd,usage_state,pricing_snapshot,revision,created_at,owner_instance_id,principal,task_state,accepted_at,reported_usage) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  (f'ledger-{i:03}',month,50000,137,'reported',snapshot,2,now,owner,'grant-archived','cancelled',accepted+i,json.dumps(dict(inputTokens=7,outputTokens=65))))
db.execute('INSERT INTO ai_usage_entries (job_id,accepted_month,reservation_micro_usd,accounted_micro_usd,usage_state,pricing_snapshot,created_at) VALUES (?,?,?,?,?,?,?)',
 ('legacy-orphan',month,50000,9007199254740993,'reported',json.dumps(dict(provider='old',model='old-v0',pricingVersion='legacy-unverified',secret='DO-NOT-RETURN')),now))
db.execute('INSERT INTO ai_usage_entries (job_id,accepted_month,reservation_micro_usd,accounted_micro_usd,usage_state,pricing_snapshot,created_at,owner_instance_id,principal,task_state,accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
 ('unknown-bill',month,50000,50000,'unknown',snapshot,now,owner,'local-owner','failed',accepted+100))
token_snapshot=json.dumps(dict(provider='stepfun',model='step-5-preview',pricingVersion='token-usage-unpriced-v1',reservationMicroUsd=0,inputMicroUsdPerMillion=0,outputMicroUsdPerMillion=0,maxInputTokens=20000,maxOutputTokens=8000))
db.execute('INSERT INTO ai_usage_entries (job_id,accepted_month,reservation_micro_usd,accounted_micro_usd,usage_state,pricing_snapshot,revision,created_at,owner_instance_id,principal,task_state,accepted_at,reported_usage) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
 ('unpriced-stepfun',month,0,0,'unpriced',token_snapshot,2,now,owner,'official-stage-draft','succeeded',accepted+101,json.dumps(dict(inputTokens=23,outputTokens=7))))
db.execute('INSERT INTO ai_budget_months (month,charged_micro_usd,reserved_micro_usd,revision) VALUES (?,?,0,2)',(month,9007199254740993+22*137+50000))
db.execute("UPDATE ai_budget_guard SET halted=1,reason='历史费用超过预留',trigger_job='legacy-orphan',revision=revision+1")
db.commit();db.close()
`,path.join(fixture.dataDir,'vmusic.db'),month],{stdio:'pipe'});
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:960}});await fixture.connect(context);
  const page=await context.newPage(),errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',request=>{if(request.url().includes('/v1/ai/'))requests.push({method:request.method(),url:request.url()});});
  try{
    // A restricted playback credential must never become a ledger credential.
    assert.equal((await fetch(fixture.base+'/v1/ai/ledger')).status,401);
    const grant=await fixture.api('/v1/ai/grants','POST',{label:'ledger-denied-fixture',scopes:['playback:read']});
    const secret=fs.readFileSync(grant.credential_path,'utf8').trim();
    assert.equal((await fetch(fixture.base+'/v1/ai/ledger',{headers:{Authorization:'Bearer '+secret}})).status,401);
    const first=await fixture.api('/v1/ai/ledger?month='+month+'&limit=20');
    assert.equal(first.entries.length,20);assert.ok(first.nextCursor);
    assert.equal(first.entries[0].accountedMicroUsd,'9007199254740993');
    assert.equal(first.entries[0].acceptedAt,null);assert.equal(first.entries[0].principal,null);
    assert.ok(!JSON.stringify(first).includes('DO-NOT-RETURN'));
    const next=await fixture.api('/v1/ai/ledger?'+new URLSearchParams({month,limit:'20',before_sort_at:first.nextCursor.sortAt,before_job_id:first.nextCursor.jobId}));
    assert.equal(next.entries.length,5);assert.equal(next.nextCursor,null);
    assert.equal(new Set(first.entries.concat(next.entries).map(entry=>entry.jobId)).size,25);
    assert.equal(next.budget.chargedMicroUsd,first.budget.chargedMicroUsd);
    assert.ok(first.entries.concat(next.entries).every(entry=>!entry.taskRetained));
    const unpricedApi=await fixture.api('/v1/ai/ledger?'+new URLSearchParams({month,usage_state:'unpriced'}));
    assert.equal(unpricedApi.entries.length,1);
    assert.equal(unpricedApi.entries[0].accountedMicroUsd,null);
    assert.deepEqual(unpricedApi.entries[0].reportedUsage,{inputTokens:'23',outputTokens:'7'});

    await page.goto(uiUrl(fixture.base),{waitUntil:'domcontentloaded'});
    await page.evaluate(()=>{Workshop.open();Workshop.setTab('ledger');});
    await page.getByRole('combobox',{name:'已有账本月份',exact:true}).selectOption(month);
    await page.waitForFunction(()=>document.querySelectorAll('.ws-ledger-entry').length===20);
    const legacy=page.locator('.ws-ledger-entry[data-job-id="legacy-orphan"]');
    assert.match(await legacy.innerText(),/\$9007199254\.740993 USD/);
    assert.match(await legacy.innerText(),/历史归因不完整/);
    assert.match(await legacy.innerText(),/任务已清理/);
    await legacy.locator('summary').click();
    assert.match(await legacy.locator('pre').innerText(),/legacy-unverified/);
    assert.ok(!(await legacy.locator('pre').innerText()).includes('DO-NOT-RETURN'));
    const budgetText=await page.locator('.ws-ledger-budget').innerText();
    await page.getByRole('button',{name:'下一页账本',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.ws-ledger-entry').length===5);
    assert.equal(await page.getByRole('button',{name:'下一页账本',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'上一页账本',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.ws-ledger-entry').length===20);
    await page.getByRole('combobox',{name:'费用状态',exact:true}).selectOption('unknown');
    await page.waitForFunction(()=>document.querySelectorAll('.ws-ledger-entry').length===1);
    assert.match(await page.locator('.ws-ledger-entry').innerText(),/费用未确认[\s\S]*可信计量迟到时仍可校正/);
    assert.equal(await page.locator('.ws-ledger-budget').innerText(),budgetText,'state filter never replaces the monthly total');
    await page.getByRole('combobox',{name:'费用状态',exact:true}).selectOption('unpriced');
    await page.waitForFunction(()=>document.querySelectorAll('.ws-ledger-entry').length===1);
    const unpriced=page.locator('.ws-ledger-entry[data-job-id="unpriced-stepfun"]');
    const unpricedText=await unpriced.innerText();
    assert.match(unpricedText,/费用未知，已记录 token/);
    assert.match(unpricedText,/输入 23 tokens · 输出 7 tokens · 金额未核价/);
    assert.doesNotMatch(unpricedText,/\$0(?:\.0+)? USD/);
    await unpriced.locator('summary').click();
    const unpricedDiagnostic=JSON.parse(await unpriced.locator('pre').innerText());
    assert.equal(unpricedDiagnostic.accountedMicroUsd,null);
    assert.deepEqual(unpricedDiagnostic.reportedUsage,{inputTokens:'23',outputTokens:'7'});
    assert.equal(await page.locator('.ws-ledger-budget').innerText(),budgetText,'unpriced tokens never change the monetary total');
    await page.getByRole('combobox',{name:'费用状态',exact:true}).selectOption('reported');
    await page.waitForFunction(()=>document.querySelectorAll('.ws-ledger-entry').length===20);
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:960});
      await page.screenshot({path:path.join(output,'ledger-'+width+'.png')});
      assert.equal(await page.locator('.ws-body').evaluate(el=>el.scrollWidth>el.clientWidth+1),false,'ledger does not overflow at '+width);
    }
    // A month/scope change wins over an older in-flight read.
    let release,started;
    const began=new Promise(resolve=>{started=resolve;});
    await page.route('**/v1/ai/ledger?**',async route=>{
      if(new URL(route.request().url()).searchParams.get('usage_state')==='released'){
        started();await new Promise(resolve=>{release=resolve;});
      }
      try{await route.continue();}catch(e){if(!/closed|handled/i.test(e.message))throw e;}
    });
    await page.getByRole('combobox',{name:'费用状态',exact:true}).selectOption('released');await began;
    await page.getByRole('combobox',{name:'费用状态',exact:true}).selectOption('unknown');
    await page.waitForFunction(()=>document.querySelectorAll('.ws-ledger-entry').length===1);
    release();
    await page.getByRole('button',{name:'刷新账本',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.ws-ledger')?.getAttribute('aria-busy')==='false');
    assert.equal(await page.locator('.ws-ledger-entry[data-job-id="unknown-bill"]').count(),1);
    await page.evaluate(()=>Workshop.close());
    const stopped=requests.length;await page.waitForTimeout(2800);
    assert.equal(requests.length,stopped,'ledger has no background polling after close');
    assert.equal(requests.filter(request=>request.method!=='GET').length,0,'browsing never mutates fees or submits jobs');
    assert.deepEqual(errors,[]);
    console.log('AI ledger: historical/purged facts, manager authorization, exact amounts, token-only unknown pricing, stable pages, filters, diagnostics/redaction, stale-read isolation, responsive layout and no model calls/polling passed');
  }finally{await browser.close();await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
