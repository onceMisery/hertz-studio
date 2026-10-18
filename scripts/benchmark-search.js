// SPDX-License-Identifier: MIT
// R0/R1-S: actual isolated 50k HTTP searches and controlled browser source latency.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const { performance } = require('node:perf_hooks');
const { startFixture } = require('./ui-browser-fixture');
const { uiUrl } = require('./ui-token');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.SEARCH_BENCH_OUT || path.join(ROOT, 'output/benchmarks/search.json'));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const fileHash = file => sha(fs.readFileSync(file));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, label, ms = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(label + ' timed out')), ms);
  })]); } finally { clearTimeout(timer); }
}
function memorySampler(processId, report) {
  assert.equal(process.platform, 'win32', 'Process memory sampling currently requires Windows');
  let phase = 'startup', stopping = false, failure;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const child = spawn(process.env.POWERSHELL || 'pwsh', ['-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'sample-process-memory.ps1'), '-TargetProcessId', String(processId)],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const fail = message => { failure = message; report.failure = message; readyReject(Error(message)); };
  child.on('error', () => fail('Cannot start process memory sampler'));
  child.on('exit', () => { if (!stopping) fail('Process memory sampler exited during measurement'); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      assert.ok(line.length <= 4096);
      const sample = JSON.parse(line);
      assert.equal(sample.pid, processId);
      for (const key of ['elapsedMs', 'workingSetBytes', 'privateBytes', 'virtualBytes', 'handles', 'threads'])
        assert.ok(Number.isFinite(sample[key]) && sample[key] >= 0, 'Invalid process memory counter');
      assert.ok(sample.workingSetBytes > 0 && sample.privateBytes > 0);
      const previous = report.samples.at(-1);
      if (previous) assert.ok(sample.elapsedMs > previous.elapsedMs, 'Memory sampler clock did not advance');
      assert.ok(report.samples.length < 4000, 'Process memory sample bound');
      report.samples.push({ ...sample, phase });
      readyResolve();
    } catch { fail('Invalid or excessive process memory samples'); child.kill(); }
  });
  return { ready: () => bounded(ready, 'First process memory sample'),
    phase: value => { phase = value; },
    async stop() {
      stopping = true;
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close'); child.kill(); await bounded(closed, 'Memory sampler exit');
      }
      lines.close();
    },
    finish() {
      assert.ok(!failure, failure);
      const groups = new Map();
      for (const sample of report.samples) {
        if (!groups.has(sample.phase)) groups.set(sample.phase, []);
        groups.get(sample.phase).push(sample);
      }
      report.phases = Object.fromEntries([...groups].map(([name, samples]) => [name,
        { count: samples.length,spanMs:samples.at(-1).elapsedMs-samples[0].elapsedMs,
          ...Object.fromEntries(['workingSetBytes', 'privateBytes', 'handles', 'threads']
          .flatMap(key => {
            const values = samples.map(sample => sample[key]).sort((a, b) => a - b);
            return [[key + 'Median', values[Math.floor(values.length / 2)]], [key + 'Max', values.at(-1)]];
          })) }]));
      for (const name of ['baseline-idle', 'after-load-idle'])
        assert.ok(report.phases[name]?.count >= 5, 'Insufficient idle process memory samples: ' + name);
      if (report.sustainedSeconds > 0) assert.ok(report.phases['sustained-local']?.count >= report.sustainedSeconds,
        'Insufficient sustained process memory coverage');
      report.idleDeltaBytes = Object.fromEntries(['workingSetBytes', 'privateBytes'].map(key =>
        [key, report.phases['after-load-idle'][key + 'Median'] - report.phases['baseline-idle'][key + 'Median']]));
      report.maxSampleGapMs = Math.max(...report.samples.slice(1).map((sample, index) =>
        sample.elapsedMs-report.samples[index].elapsedMs));
      report.observed = true;
    } };
}
function summary(samples) {
  const sorted = [...samples].sort((a,b) => a-b);
  const percentile = p => sorted[Math.ceil(sorted.length * p) - 1];
  return {count: samples.length, p50Ms:percentile(.5), p95Ms:percentile(.95), maxMs:sorted.at(-1), samplesMs:samples};
}
async function main() {
  assert.ok(!fs.existsSync(OUT), 'Choose a new SEARCH_BENCH_OUT; existing evidence is not overwritten');
  assert.ok(!fs.existsSync(OUT.replace(/\.json$/i,'')+'-partial.png'),
    'Choose a new SEARCH_BENCH_OUT; existing screenshot is not overwritten');
  assert.ok(process.env.HERTZ_BIN, 'Set HERTZ_BIN to an explicitly built isolated candidate');
  const binary = path.resolve(process.env.HERTZ_BIN);
  const sustainedSeconds = Number(process.env.SEARCH_SUSTAINED_SECONDS || 0);
  assert.ok(Number.isInteger(sustainedSeconds) && (sustainedSeconds === 0 || sustainedSeconds >= 60 && sustainedSeconds <= 600),
    'SEARCH_SUSTAINED_SECONDS must be 0 or an integer from 60 to 600');
  const measureMemory = process.env.SEARCH_PROCESS_MEMORY === '1';
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const report = {schemaVersion:1, startedAt:new Date().toISOString(), syntheticCorpus:true,
    realProvidersVerified:false, nativeDbxVerified:false, weakHardwareVerified:false, releaseEligible:false,
    environment:{os:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model,
      logicalCpus:os.cpus().length,totalMemoryBytes:os.totalmem(),node:process.version,
      compiler:execFileSync('rustc',['--version','--verbose'],{encoding:'utf8'}).trim()},
    candidate:{binaryHash:fileHash(binary),buildProfile:process.env.SEARCH_BUILD_PROFILE || 'unspecified',
      gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),
      dirty:!!execFileSync('git',['status','--porcelain'],{cwd:ROOT,encoding:'utf8'}).trim()},
    methodology:{local:'HTTP response including JSON decoding, limit 20; complete results checked against independent LIKE oracle',
      localWarmupRounds:2,localMeasuredRounds:30,concurrentClients:4,concurrentRoundsPerClient:3,
      browser:'submit click to first visible hit-testable row with enabled preview action after requestAnimationFrame; actual UI, intercepted source HTTP',
      browserWarmupRounds:2,browserMeasuredRounds:30,fastSourceDelayMs:200,slowSourceDelayMs:1200,
      thresholdLocalP95Ms:300,thresholdFirstSourceP95Ms:1000,
      sustainedLocalSeconds:sustainedSeconds,sustainedClients:4,sustainedPausePerClientMs:25,
      processMemory:measureMemory?'Windows whole isolated service WorkingSet64/private committed bytes, 500ms sampling; driver/browser excluded; no frozen memory threshold':'not measured'},
    hashes:Object.fromEntries(['Cargo.toml','Cargo.lock','crates/vmusic-store/src/lib.rs',
      'crates/hertz-studio/src/routes.rs','crates/hertz-studio/src/rpc/library.rs','crates/hertz-studio/src/online/search_gate.rs',
      'plugin/ui/search-session.js','plugin/ui/online.js','scripts/ui-browser-fixture.js',
      'scripts/benchmark-search.js','scripts/sample-process-memory.ps1','evals/search/v1/corpus.py'].map(file=>[file,fileHash(path.join(ROOT,file))]))};
  let fixture, browser, memory;
  try {
    fixture = await startFixture();
    process.env.VMUSIC_DATA_DIR = fixture.dataDir;
    report.health = await fixture.api('/v1/health');
    if (process.env.SEARCH_EXPECT_EDITION) assert.equal(report.health.edition, process.env.SEARCH_EXPECT_EDITION);
    if (measureMemory) {
      report.processMemory = { observed:false,processId:fixture.processId,intervalMs:500,sustainedSeconds,samples:[] };
      memory = memorySampler(fixture.processId, report.processMemory);
      await memory.ready();
    }
    const beforeQueue = await fixture.api('/v1/player/queue');
    const corpus = JSON.parse(execFileSync(process.env.PYTHON || 'python',
      [path.join(ROOT,'evals/search/v1/corpus.py'),path.join(fixture.dataDir,'vmusic.db')],
      {encoding:'utf8',timeout:120000}));
    report.corpus = corpus;
    assert.equal((await fixture.api('/v1/tracks?limit=1')).total, 50000);
    async function search(testCase) {
      const params = new URLSearchParams({q:testCase.q,limit:'20',sort:testCase.sort || 'title'});
      for (const key of ['artist','album']) if (testCase[key]) params.set(key,testCase[key]);
      const start = performance.now();
      const data = await fixture.api('/v1/tracks?' + params);
      const elapsed = performance.now()-start;
      assert.equal(data.total,testCase.expectedTotal,testCase.id+' total');
      assert.deepEqual(data.tracks.map(t=>t.id),testCase.expectedIds,testCase.id+' order/content');
      return elapsed;
    }
    // First-observed reads are kept, not called filesystem/OS cold-cache measurements.
    report.localFirstObserved = [];
    for (const c of corpus.cases) report.localFirstObserved.push({case:c.id,elapsedMs:await search(c)});
    for (let round=0;round<2;round++) for (const c of corpus.cases) await search(c);
    if (memory) { memory.phase('baseline-idle'); await delay(10000); }
    memory?.phase('local-sequential');
    const samples = new Map(corpus.cases.map(c=>[c.id,[]]));
    for (let round=0;round<30;round++) {
      // Rotate order so one case is not always first in a round.
      for (let i=0;i<corpus.cases.length;i++) {
        const c = corpus.cases[(i+round)%corpus.cases.length];
        samples.get(c.id).push(await search(c));
      }
    }
    report.local = [...samples].map(([id,values])=>({id,...summary(values)}));
    report.gates = {local:report.local.every(row=>row.p95Ms<=300),firstSource:null};
    console.log('Local sequential measurements complete');
    const loaded = [];
    memory?.phase('local-concurrent');
    await Promise.all(Array.from({length:4},async(_,client)=>{
      for (let round=0;round<3;round++) for (let i=0;i<corpus.cases.length;i++) {
        const c=corpus.cases[(i+client+round)%corpus.cases.length];
        loaded.push({case:c.id,client,elapsedMs:await search(c)});
      }
    }));
    report.localConcurrent = {...summary(loaded.map(x=>x.elapsedMs)),observations:loaded};
    if (sustainedSeconds) {
      memory?.phase('sustained-local');
      const started = performance.now(), observations = [];
      report.localSustained = { requestedSeconds:sustainedSeconds,clients:4,pausePerClientMs:25,observations };
      const progress = setInterval(() => console.log('Sustained local search: ' +
        Math.floor((performance.now()-started)/1000) + 's, ' + observations.length + ' checked queries'), 30000);
      try {
        await Promise.all(Array.from({length:4},async(_,client)=>{
          let ordinal = 0;
          while (performance.now()-started < sustainedSeconds*1000) {
            const c=corpus.cases[(ordinal+client)%corpus.cases.length];
            const elapsedMs=await search(c);
            assert.ok(observations.length < 100000,'Sustained observation bound');
            observations.push({case:c.id,client,ordinal:ordinal++,elapsedMs});
            await delay(25);
          }
        }));
      } finally { clearInterval(progress); }
      Object.assign(report.localSustained,summary(observations.map(x=>x.elapsedMs)),
        {actualSeconds:(performance.now()-started)/1000});
    }
    if (memory) { memory.phase('after-load-idle'); await delay(10000); }
    memory?.phase('browser-controlled-sources');
    report.localDuringControlledSources = [];
    browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
    const context = await browser.newContext({viewport:{width:1440,height:960}});
    await fixture.connect(context);
    const page = await context.newPage(), pageErrors=[], writes=[], external=[];
    page.on('pageerror',error=>pageErrors.push(error.message));
    let active=0,maxActive=0;
    const calls=[];
    const sources=['fixture-fast','fixture-slow','fixture-fail'].map((id,i)=>({id,label:['快源 fixture','慢源 fixture','失败源 fixture'][i],kind:'music',caps:[],cats:[]}));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if (url.origin!==fixture.base) {
        if (!['data:','blob:'].includes(url.protocol)) external.push(url.origin);
        return route.abort();
      }
      if (request.method()!=='GET' && /\/v1\/(player|ai\/jobs|online\/play)/.test(url.pathname)) {
        writes.push(url.pathname);return route.abort();
      }
      if (url.pathname==='/v1/online/sources') return route.fulfill({json:{sources}});
      if (url.pathname==='/v1/online/search') {
        const source=url.searchParams.get('source'),q=url.searchParams.get('q');
        assert.ok(sources.some(s=>s.id===source));
        active++;maxActive=Math.max(maxActive,active);calls.push({source,q});
        try {
          await new Promise(resolve=>setTimeout(resolve,source==='fixture-slow'?1200:source==='fixture-fast'?200:50));
          if(source==='fixture-fail') return await route.fulfill({status:503,json:{error:{code:'upstream_unavailable',message:'controlled source failure',request_id:'search-benchmark'}}});
          return await route.fulfill({json:{total:3,tracks:Array.from({length:3},(_,i)=>({source,id:String(i),title:q+' '+source,artist:'Fixture',album:'Benchmark',duration_ms:180000,playable:true}))}});
        } finally {active--;}
      }
      // Keep every provider-backed read inside the fixture, including homepage prefetch.
      if (url.pathname.startsWith('/v1/online/') || url.pathname.startsWith('/v1/recommend/daily/online')) return route.fulfill({json:{tracks:[]}});
      if (url.pathname==='/v1/home/quote') return route.fulfill({json:{hitokoto:'Controlled benchmark',from:'fixture'}});
      return route.continue();
    });
    await page.goto(uiUrl(fixture.base),{waitUntil:'domcontentloaded'});
    report.browser = {version:browser.version(),channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true,viewport:{width:1440,height:960}};
    report.embeddedAssetVersions = await page.evaluate(()=>[...new Set([...document.scripts].filter(s=>s.src)
      .map(s=>new URL(s.src).searchParams.get('v')).filter(Boolean))]);
    await page.waitForFunction(()=>Online.sources().length===3);
    await page.getByRole('button',{name:'在线曲库',exact:true}).click();
    await page.getByRole('combobox',{name:'音源',exact:true}).selectOption('all');
    const firstVisible=[];
    for(let round=-2;round<30;round++){
      const q='SearchBench '+round;
      await page.locator('#online-q').fill(q);
      await page.evaluate(q=>{
        window.benchFirstVisible = new Promise((resolve,reject)=>{
          let started,checking=false;
          const root=document.getElementById('online-body');
          const timer=setTimeout(()=>{observer.disconnect();reject(new Error('No clickable partial result'));},5000);
          const observer=new MutationObserver(()=>{
            if(checking || started===undefined)return;
            checking=true;
            requestAnimationFrame(()=>{
              checking=false;
              const row=root.querySelector('.online-row[data-online-id^="online:fixture-fast:"]');
              const button=row?.querySelector('[data-act="preview"]:not(:disabled)');
              if(!row?.textContent.includes(q) || !button || !row.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return;
              const rect=row.getBoundingClientRect();
              const hit=document.elementFromPoint(rect.left+rect.width*.4,rect.top+rect.height/2);
              if(!hit || !row.contains(hit))return;
              clearTimeout(timer);observer.disconnect();
              resolve({elapsedMs:performance.now()-started,stillLoading:Online.state.loading,rows:root.querySelectorAll('.online-row').length});
            });
          });
          observer.observe(root,{subtree:true,childList:true,attributes:true});
          document.getElementById('online-go').addEventListener('click',()=>{started=performance.now();},{once:true,capture:true});
        });
      },q);
      await page.locator('#online-go').click();
      const first=await page.evaluate(()=>window.benchFirstVisible);
      assert.equal(first.stillLoading,true,'fast result must be clickable while slow source is pending');
      assert.equal(first.rows,3);
      if(round>=0){
        firstVisible.push(first.elapsedMs);
        report.localDuringControlledSources.push(await search(corpus.cases[round%corpus.cases.length]));
      }
      if(round===0){
        fs.mkdirSync(path.dirname(OUT),{recursive:true});
        const shot=OUT.replace(/\.json$/i,'')+'-partial.png';
        await page.screenshot({path:shot});report.partialScreenshotHash=fileHash(shot);
      }
      await page.waitForFunction(()=>!Online.state.loading);
      assert.equal(await page.locator('#online-body .online-row').count(),6);
      assert.equal(await page.locator('#online-body [data-error-code="upstream_unavailable"]').count(),1);
    }
    assert.ok(maxActive<=2,'UI must retain shared two-source admission');
    assert.equal(calls.length,32*3,'fresh query for every measured/warmup run; no implicit retries');
    assert.deepEqual(pageErrors,[]);assert.deepEqual(writes,[]);assert.deepEqual(external,[]);
    assert.deepEqual(await fixture.api('/v1/player/queue'),beforeQueue,'search did not change queue');
    report.firstSource = {...summary(firstVisible),maxActiveSourceReads:maxActive,sourceCalls:calls.length};
    report.localDuringControlledSources = summary(report.localDuringControlledSources);
    report.checks = {allResultsMatchLikeOracle:true,partialBeforeSlowResult:true,sourceFailuresIsolated:true,
      noModelOrPlayerWrites:true,noExternalBrowserReads:true,queueUnchanged:true};
    report.gates = {local:report.local.every(row=>row.p95Ms<=300),firstSource:report.firstSource.p95Ms<=1000};
    if (memory) { await memory.stop(); memory.finish(); }
    assert.equal(fileHash(binary),report.candidate.binaryHash,'Candidate changed during measurement');
    for(const [file,hash] of Object.entries(report.hashes)) assert.equal(fileHash(path.join(ROOT,file)),hash,'Source changed during measurement: '+file);
    report.completedAt=new Date().toISOString();
    fs.mkdirSync(path.dirname(OUT),{recursive:true});
    fs.writeFileSync(OUT,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({out:OUT,localWorstP95Ms:Math.max(...report.local.map(x=>x.p95Ms)),concurrentP95Ms:report.localConcurrent.p95Ms,firstSource:report.firstSource.p95Ms,gates:report.gates}));
    assert.ok(report.gates.local && report.gates.firstSource,'Performance target missed; raw report retained');
  } catch(error) {
    report.failure = {name:error.name,message:error.message.replace(/([?&]token=)[^&\s]+/g,'$1[redacted]')};
    report.completedAt=new Date().toISOString();
    fs.mkdirSync(path.dirname(OUT),{recursive:true});
    fs.writeFileSync(OUT,JSON.stringify(report,null,2)+'\n');
    throw error;
  } finally {
    if(memory)await memory.stop();
    if(browser)await browser.close();
    if(fixture)await fixture.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
