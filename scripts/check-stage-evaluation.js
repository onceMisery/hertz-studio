// SPDX-License-Identifier: MIT
// Offline evaluator checks; --live additionally uses the built production CLI
// against a controlled loopback HTTP server. Never runs an actual model.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { startFixture } = require('./ui-browser-fixture');
const { loadCorpus, stageHarness, assess, summarize, validateRow, loadRun, compareRuns, exportReview, childCase,
  offlineOutcome, main:runEvaluation, driverFingerprint } = require('./evaluate-ai-stage');

async function checkManagedCli(corpus,harness) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hertz-managed-eval-'));
  const requests=[],errors=[];
  let mode='candidate';
  const server=http.createServer(async(req,res)=>{
    try {
      assert.equal(req.headers.authorization,'Bearer managed-fixture-token');
      if(req.method==='GET') {
        assert.equal(req.url,'/v1/ai/evaluation/status');
        requests.push('status');
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({provider:'fake',model:'fake-intent-v1',providerReady:true,
          generationConsent:mode!=='no-consent',runnerReady:true}));
        return;
      }
      assert.equal(req.method,'POST');
      assert.equal(req.url,'/v1/ai/evaluation/case');
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.deepEqual(Object.keys(body).sort(),['brief','caseId']);
      requests.push(body.caseId);
      const failed=mode==='provider-error';
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({evaluationVersion:1,caseId:body.caseId,provider:'fake',model:'fake-intent-v1',
        schemaHash:corpus.contract.schemaHash,protocolFingerprint:'a'.repeat(64),requestHash:'b'.repeat(64),
        elapsedMs:1,kind:failed?'provider_error':'candidate',
        intent:failed?null:{version:1,scene:'orb',patch:{}},accounting:'not_recorded'}));
    } catch(error) { errors.push(error);res.statusCode=500;res.end('{}'); }
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const previousToken=process.env.VMUSIC_UI_TOKEN;
  const previousLog=console.log,previousStderr=process.stderr.write;
  process.env.VMUSIC_UI_TOKEN='managed-fixture-token';
  console.log=()=>{};process.stderr.write=()=>true;
  const run=(dir,limit)=>runEvaluation(['--run-managed','--server',origin,'--round','1',
    ...(limit===undefined?[]:['--limit',String(limit)]),'--out',dir]);
  try {
    const defaultDir=path.join(temp,'default-limit');
    await run(defaultDir);
    assert.equal(loadRun(defaultDir,corpus,harness).rows.length,1,
      'Managed evaluation defaults to one sample unless a larger limit is explicit');

    const completedDir=path.join(temp,'completed');
    await run(completedDir,2);
    const completed=loadRun(completedDir,corpus,harness);
    assert.equal(completed.meta.executionMode,'managed');
    assert.equal(completed.meta.accounting,'not_recorded');
    assert.equal(completed.rows.length,2);
    assert.equal(Object.hasOwn(completed.rows[0],'usage'),false);
    assert.equal(completed.report.metrics.accounting,'not_recorded');
    assert.equal(Object.hasOwn(completed.report.metrics,'localPriceMicroUsd'),false);
    assert.deepEqual(requests.slice(0,5),[
      'status',corpus.cases[0].id,
      'status',corpus.cases[0].id,corpus.cases[1].id,
    ]);

    mode='no-consent';
    const deniedDir=path.join(temp,'denied');
    await assert.rejects(()=>run(deniedDir,1),/generation consent/);
    assert.equal(fs.existsSync(deniedDir),false);

    mode='provider-error';
    const failedDir=path.join(temp,'provider-error');
    await assert.rejects(()=>run(failedDir,2),/stopped this round/);
    const failed=loadRun(failedDir,corpus,harness);
    assert.equal(failed.meta.status,'interrupted');
    assert.equal(failed.rows.length,1);
    assert.equal(failed.rows[0].kind,'provider_error');
    assert.equal(requests.filter(id=>id===corpus.cases[0].id).length,3,
      'A provider error is recorded once and never retried within the round');
    assert.equal(requests.filter(id=>id===corpus.cases[1].id).length,1,
      'The round stops before sending the next cloud case after a provider error');
    assert.deepEqual(errors,[]);
  } finally {
    console.log=previousLog;process.stderr.write=previousStderr;
    if(previousToken===undefined)delete process.env.VMUSIC_UI_TOKEN;else process.env.VMUSIC_UI_TOKEN=previousToken;
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
}

async function main() {
  const corpus = loadCorpus();
  assert.equal(corpus.version,'v3','Current evaluation corpus must follow the active contract');
  assert.equal(loadCorpus('v3').manifest.schemaHash,corpus.contract.schemaHash);
  const historicalCases = fs.readFileSync(path.join(__dirname,'../evals/stage-intent/v2/cases.jsonl'));
  const activeCases = fs.readFileSync(path.join(__dirname,'../evals/stage-intent/v3/cases.jsonl'));
  assert.equal(historicalCases.compare(activeCases),0,'v3 must preserve the frozen v2 sample lines byte-for-byte');
  assert.equal(crypto.createHash('sha256').update(activeCases).digest('hex'),corpus.manifest.corpusSha256);
  assert.throws(()=>loadCorpus('v2'),/Unsupported stage-intent corpus version/,
    'Frozen v2 evidence must not be silently loaded under the current contract');
  assert.throws(()=>loadCorpus('v1'),/Unsupported stage-intent corpus version/,
    'Historical v1 evidence must be reproduced with its original evaluator revision');
  const harness = stageHarness();
  const contractContext = {
    scenes: corpus.contract.scenes.map(scene=>scene.id),
    paths: [...corpus.contract.commonParams.map(param=>param.name),
      ...corpus.contract.scenes.flatMap(scene=>scene.params.map(param=>'sc.'+param.name))],
  };
  let candidateLabelsChecked = 0, candidateLabelsMaterialized = 0, refusalLabelsStructurallyConflicted = 0;
  for (const item of corpus.cases) {
    if (item.expect.kind === 'candidate') {
      candidateLabelsChecked++;
      const intent = { version:1,scene:item.expect.scene,patch:{} };
      for (const [key,,value] of item.expect.checks || []) {
        if (key === 'director') intent.director = value;
        else if (key === 'hand.on') intent.hand = { on:value };
        else intent.patch[key] = value;
      }
      harness.draft.validateIntent(intent);
      const result = harness.stage.materializeIntent(null,intent);
      assert.ok(result.ok && result.ignored.length === 0,`Candidate label did not fully materialize: ${item.id}`);
      candidateLabelsMaterialized++;
    } else {
      const compiled = harness.prompt.compile(item.brief,contractContext);
      if (compiled.ok) refusalLabelsStructurallyConflicted++;
    }
  }
  assert.equal(candidateLabelsChecked,corpus.manifest.mechanicalAudit.candidateLabelsChecked);
  assert.equal(candidateLabelsMaterialized,corpus.manifest.mechanicalAudit.candidateLabelsMaterialized);
  assert.equal(refusalLabelsStructurallyConflicted,corpus.manifest.mechanicalAudit.refusalLabelsStructurallyConflicted);
  const positive = corpus.cases.find(c=>c.id==='dev-common-01');
  const negative = corpus.cases.find(c=>c.id==='dev-neg-01');
  const unsupported = corpus.cases.find(c=>c.id==='dev-inject-01');
  const conflict = corpus.cases.find(c=>c.id==='dev-conflict-06');
  const temporal = corpus.cases.find(c=>c.id==='hold-time-01');
  assert.equal(offlineOutcome({ok:false,code:'unrecognized_constraints'}),'refused',
    'An explicit fail-closed constraint result must count as a refusal, not a missing parse');
  assert.equal(offlineOutcome({ok:false,code:'unsafe_instruction'}),'refused',
    'An out-of-domain instruction must count as a refusal');
  assert.equal(offlineOutcome({ok:false,code:'unsupported_edit'}),'refused',
    'An unsupported relative edit must count as a refusal');
  assert.equal(offlineOutcome({ok:false,code:'unsupported_timeline'}),'refused',
    'An unsupported temporal plan must count as a refusal');
  assert.equal(offlineOutcome({ok:false,code:'no_match'}),'baseline_no_match');
  const candidate = { caseId:positive.id, kind:'candidate',elapsedMs:12,
    intent:{version:1,scene:'orb',patch:{}}, usage:{withinOutputBound:true} };
  const noShake = { ...candidate, caseId:negative.id, intent:{version:1,scene:'orb',patch:{'cam.shake':0}} };
  const refused = { caseId:unsupported.id,kind:'refused',intent:null,elapsedMs:10,usage:null };
  assert.equal(assess(negative,{...candidate,caseId:negative.id},harness).matched,false,
    'An omitted negative parameter must use the actual baseline rather than count as satisfied');
  assert.equal(assess(negative,noShake,harness).matched,true);
  assert.equal(assess(unsupported,candidate,harness).criticalFailure,true);
  assert.equal(assess(unsupported,{kind:'invalid_json'},harness).matched,false,
    'A broken response must never earn correct-refusal credit');
  const bad = { ...candidate, intent:{version:1,scene:'orb',patch:{'sc.height':2}} };
  assert.equal(assess(positive,bad,harness).materialized,false);
  const cases = [positive,negative,unsupported];
  const rows = [candidate,noShake,refused];
  const meta = {runId:'self-check',provider:'fixture',split:'development',sampleComplete:true,status:'completed'};
  let report = summarize(cases,rows,[],meta,harness);
  assert.equal(report.metrics.supportedSchemaRate,1);
  assert.equal(report.metrics.humanSemanticPassRate,null);
  assert.equal(report.candidateChecks,'pending_human_review');
  assert.equal(report.releaseEligible,false);
  const reviews = [positive,negative].map(c=>({caseId:c.id,pass:true,reviewer:'test reviewer',note:'test-only score'}));
  report = summarize(cases,rows,reviews,meta,harness);
  assert.equal(report.metrics.humanSemanticPassRate,1);
  assert.equal(report.releaseEligible,false,'Single-round provisional checks never authorize release');
  assert.equal(summarize(cases,[candidate,{...candidate,caseId:negative.id},refused],reviews,meta,harness)
    .metrics.humanSemanticPassRate,0.5,'Human pass cannot override a known automatic negative failure');
  assert.equal(summarize(cases,[bad,noShake,refused],reviews,meta,harness).metrics.supportedSchemaRate,0.5);
  assert.equal(summarize(cases,rows,[],{...meta,sampleComplete:false},harness).sampleComplete,false);
  assert.equal(summarize(cases,rows,reviews,{...meta,sampleComplete:false},harness).candidateChecks,'failed',
    'A fully reviewed partial selection must never pass candidate checks');
  assert.equal(summarize(cases,rows,reviews,{...meta,status:'interrupted'},harness).candidateChecks,'failed');
  assert.equal(summarize(cases,rows.slice(0,2),reviews,meta,harness).metrics.protocolStructureRate,2/3,
    'Missing unsupported results remain in the structure denominator');
  assert.equal(summarize(cases,[candidate,noShake,{...refused,kind:'timeout'}],reviews,meta,harness).candidateChecks,'failed',
    'Transport failure cannot replace an explicit refusal in the structure gate');
  assert.throws(()=>summarize(cases,[candidate,candidate],[],meta,harness),/duplicate/);
  assert.throws(()=>summarize(cases,rows,[...reviews,reviews[0]],meta,harness),/duplicate/);
  assert.equal(corpus.cases.filter(c=>c.split==='holdout').length,40);
  const savedDir = fs.mkdtempSync(path.join(os.tmpdir(),'hertz-eval-report-'));
  const valid = { ...candidate,evaluationVersion:1,caseId:corpus.cases[0].id,provider:'offline-rules',model:'offline-rules',
    schemaHash:corpus.contract.schemaHash,protocolFingerprint:harness.fingerprint,requestHash:harness.fingerprint,
    usage:null,reservationMicroUsd:'0',localPriceMicroUsd:'0',externalInvoiceVerified:false };
  const conflictCompile = harness.prompt.compile(conflict.brief, {
    scenes: corpus.contract.scenes.map(scene=>scene.id),
    paths: [...corpus.contract.commonParams.map(param=>param.name),
      ...corpus.contract.scenes.flatMap(scene=>scene.params.map(param=>'sc.'+param.name))],
  });
  assert.equal(conflictCompile.code,'unsatisfiable_constraints');
  const temporalCompile = harness.prompt.compile(temporal.brief, {
    scenes: corpus.contract.scenes.map(scene=>scene.id),
    paths: [...corpus.contract.commonParams.map(param=>param.name),
      ...corpus.contract.scenes.flatMap(scene=>scene.params.map(param=>'sc.'+param.name))],
  });
  assert.equal(temporalCompile.code,'unsupported_timeline');
  const offlineRefusal = { ...valid,caseId:conflict.id,kind:'refused',intent:null };
  validateRow(offlineRefusal,{provider:'offline-rules',model:'offline-rules'},corpus.contract);
  assert.equal(assess(conflict,offlineRefusal,harness).matched,true,
    'An explicit compiler refusal must match the frozen impossible-constraint case');
  let savedMeta = { ...meta,provider:'offline-rules',model:'offline-rules',sampleComplete:false,
    corpusVersion:corpus.version,
    corpusSha256:corpus.manifest.corpusSha256,schemaHash:corpus.contract.schemaHash,
    materializerFingerprint:harness.fingerprint,protocolFingerprint:harness.fingerprint,
    evaluatorFingerprint:driverFingerprint,
    selectedCases:[valid.caseId],completedCases:1 };
  const save = (savedRows=[valid]) => {
    const bytes = savedRows.map(row=>JSON.stringify(row)+'\n').join('');
    savedMeta.resultsSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(savedDir,'results.jsonl'),bytes);
    fs.writeFileSync(path.join(savedDir,'run.json'),JSON.stringify(savedMeta));
    fs.writeFileSync(path.join(savedDir,'reviews.json'),'[]');
  };
  try {
    save();
    const loaded = loadRun(savedDir,corpus,harness);
    assert.equal(loaded.report.sampleComplete,false);
    assert.equal(loaded.report.candidateChecks,'failed');
    assert.throws(()=>compareRuns(loaded,loaded,corpus,harness),/complete/);
    const completeFixture = {...loaded,meta:{...savedMeta,selectedCases:[valid.caseId]},report:{...loaded.report,sampleComplete:true}};
    assert.equal(compareRuns(completeFixture,completeFixture,corpus,harness).automaticExpectations.bothMatched,1);
    const bundleDir = path.join(savedDir,'preview-bundle');
    const bundle = await exportReview(bundleDir,{...loaded,rows:[valid,{...valid,caseId:negative.id,intent:bad.intent},
      {...valid,caseId:unsupported.id,kind:'baseline_no_match',intent:null}]},corpus,harness);
    assert.equal(bundle.entries[0].preparation,'ready_for_manual_preview');
    assert.equal(bundle.entries[1].preparation,'rejected');
    assert.equal(bundle.entries[1].artifactFile,null);
    assert.equal(bundle.entries[2].preparation,'no_candidate');
    const imported = await harness.draft.prepare(JSON.parse(fs.readFileSync(path.join(bundleDir,bundle.entries[0].artifactFile),'utf8')));
    assert.equal(imported.preset.scene,'orb','Reviewer artifacts must use the product envelope and share roundtrip');
    await assert.rejects(()=>exportReview(bundleDir,loaded,corpus,harness),/already exists/);
    fs.unlinkSync(path.join(bundleDir,bundle.entries[0].artifactFile));
    fs.unlinkSync(path.join(bundleDir,'index.json')); fs.rmdirSync(bundleDir);
    fs.appendFileSync(path.join(savedDir,'results.jsonl'),'\n');
    assert.throws(()=>loadRun(savedDir,corpus,harness),/results changed/);
    save([{...valid,model:'different-model'}]);
    assert.throws(()=>loadRun(savedDir,corpus,harness),/model\/provider/);
    save([{...valid,protocolFingerprint:'0'.repeat(64)}]);
    assert.throws(()=>loadRun(savedDir,corpus,harness),/protocol identity/);
    save([{...valid,kind:'unknown_failure'}]);
    assert.throws(()=>loadRun(savedDir,corpus,harness),/Unknown evaluation/);
    savedMeta = {...savedMeta,materializerFingerprint:'0'.repeat(64)};
    save();
    assert.throws(()=>loadRun(savedDir,corpus,harness),/sources changed/);
    savedMeta = {...savedMeta,materializerFingerprint:harness.fingerprint,completedCases:2};
    save();
    assert.throws(()=>loadRun(savedDir,corpus,harness),/coverage/);
    assert.throws(()=>validateRow({...valid,usage:{inputTokens:'1',outputTokens:'513',withinOutputBound:true}},
      savedMeta,corpus.contract),/usage/);
  } finally {
    for(const file of ['run.json','results.jsonl','reviews.json']) fs.unlinkSync(path.join(savedDir,file));
    fs.rmdirSync(savedDir);
  }
  await checkManagedCli(corpus,harness);
  console.log('Stage evaluation offline: frozen coverage, actual baseline defaults, false acceptance/refusal, invalid materialization, sample/review denominators and release gates passed');

  if (!process.argv.includes('--live')) return;
  const binary = path.resolve(process.env.HERTZ_BIN || path.join(__dirname,'../target/debug',
    process.platform==='win32'?'hertz-studio.exe':'hertz-studio'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'hertz-eval-check-'));
  const dataDir = path.join(temp,'must-not-be-created');
  const originalDataDir = process.env.VMUSIC_DATA_DIR;
  process.env.VMUSIC_DATA_DIR = dataDir;
  const requests = [];
  const serverErrors = [];
  let nextHold = null;
  const server = http.createServer(async(req,res)=>{
    try {
      const chunks=[]; for await(const chunk of req) chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks)); requests.push(body);
      if(nextHold){
        if(nextHold.skip > 0) nextHold.skip--;
        else {
          const held=nextHold; nextHold=null;
          res.on('close',held.closed);
          held.seen(body);
          return;
        }
      }
      const brief=body.messages[1].content;
      const content=brief==='refuse'?' {"unsupported":true}':JSON.stringify({version:1,scene:'orb',patch:{}});
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({model:'fixture-local',done:true,done_reason:brief==='truncate'?'length':'stop',
        message:{role:'assistant',content},prompt_eval_count:150,eval_count:30}));
    } catch(error){serverErrors.push(error);res.destroy();}
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  try {
    const good=await childCase(binary,origin,'fixture-local',{id:'case-a',brief:'new static orb'});
    assert.equal(good.kind,'candidate');
    assert.equal(good.usage.inputTokens,'150');
    assert.equal(good.localPriceMicroUsd,'0');
    assert.equal(good.externalInvoiceVerified,false);
    const no=await childCase(binary,origin,'fixture-local',{id:'case-b',brief:'refuse'});
    const truncated=await childCase(binary,origin,'fixture-local',{id:'case-c',brief:'truncate'});
    assert.equal(no.kind,'refused');
    assert.equal(truncated.kind,'truncated');
    assert.equal(truncated.usage.outputTokens,'30');
    assert.equal(good.protocolFingerprint,no.protocolFingerprint);
    assert.notEqual(good.requestHash,no.requestHash);
    assert.equal(requests.length,3,'One local POST for each explicit case');
    assert.equal(requests[0].stream,false);
    assert.equal(fs.existsSync(dataDir),false,'Evaluation must branch before configuration, database and audio boot');
    await assert.rejects(()=>childCase(binary,'https://example.com','fixture-local',{id:'bad-origin',brief:'orb'}));
    assert.equal(requests.length,3);
    const runDir = path.join(temp,'local-driver-run');
    const driver = (...args) => promisify(execFile)(process.execPath,[path.join(__dirname,'evaluate-ai-stage.js'),...args],
      {windowsHide:true,timeout:45000,maxBuffer:1024*1024});
    const run = await driver('--run-local','--model','fixture-local','--origin',origin,'--round','1',
      '--limit','2','--out',runDir,'--binary',binary);
    assert.equal(JSON.parse(run.stdout).candidateChecks,'failed','Limited smoke run must not pass candidate checks');
    const saved = loadRun(runDir,corpus,harness);
    assert.match(saved.meta.binarySha256,/^[a-f0-9]{64}$/);
    assert.equal(saved.meta.origin,origin);
    assert.equal(saved.rows.length,2);
    const regenerated = await driver('--report',runDir);
    assert.equal(JSON.parse(regenerated.stdout).sampleComplete,false);
    await assert.rejects(()=>driver('--validate','--run-local','--model','fixture-local','--origin',origin));
    const invalidDir = path.join(temp,'invalid-origin-run');
    await assert.rejects(()=>driver('--run-local','--model','fixture-local','--origin','http://user:secret@127.0.0.1',
      '--round','1','--out',invalidDir,'--binary',binary));
    assert.equal(fs.existsSync(invalidDir),false,'Invalid credentials must not be persisted in run metadata');
    assert.equal(requests.length,5,'Driver makes one POST per selected sample, report and invalid options make none');
    assert.equal(fs.existsSync(dataDir),false);
    for(const file of ['run.json','results.jsonl','reviews.json','report.json']) fs.unlinkSync(path.join(runDir,file));
    fs.rmdirSync(runDir);

    const interruptedDir=path.join(temp,'interrupted-driver-run');
    let heldResolve,closedResolve;
    const heldRequest=new Promise(resolve=>{heldResolve=resolve;});
    const closedRequest=new Promise(resolve=>{closedResolve=resolve;});
    nextHold={skip:1,seen:heldResolve,closed:closedResolve};
    const interrupted=runEvaluation(['--run-local','--model','fixture-local','--origin',origin,'--round','1',
      '--limit','2','--out',interruptedDir,'--binary',binary]).then(
        value=>({value}), error=>({error}));
    let signalSent=false;
    const interrupt=()=>{if(!signalSent){signalSent=true;process.emit('SIGINT');}};
    try {
      await Promise.race([heldRequest,new Promise((_,reject)=>setTimeout(()=>reject(Error('Interrupted-run fixture was not reached')),5000))]);
      interrupt();
      const outcome=await interrupted;
      assert.match(outcome.error?.message || '',/interrupted/i,'SIGINT should stop the active CLI child');
      await Promise.race([closedRequest,new Promise((_,reject)=>setTimeout(()=>reject(Error('SIGINT did not close the local provider connection')),5000))]);
      const partial=loadRun(interruptedDir,corpus,harness);
      assert.equal(partial.meta.status,'interrupted');
      assert.equal(partial.rows.length,1,'Completed samples before SIGINT must remain saved');
      assert.equal(partial.rows[0].caseId,corpus.cases[0].id);
      assert.equal(partial.report.sampleComplete,false);
      assert.equal(partial.report.candidateChecks,'failed');
      const partialReport=await driver('--report',interruptedDir);
      assert.equal(JSON.parse(partialReport.stdout).sampleComplete,false,
        'A signal-interrupted run must still be reportable from its saved results');
    } finally {
      interrupt();
      await interrupted;
      for(const file of ['run.json','results.jsonl','reviews.json','report.json']) {
        const filePath=path.join(interruptedDir,file);
        if(fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      if(fs.existsSync(interruptedDir)) fs.rmdirSync(interruptedDir);
    }
    assert.equal(requests.length,7,'SIGINT interrupts after saving one result and sending the next local POST');
    assert.deepEqual(serverErrors,[]);
    const appFixture = await startFixture({backend:'null'});
    const priorFixtureDataDir = process.env.VMUSIC_DATA_DIR;
    const priorUiToken = process.env.VMUSIC_UI_TOKEN;
    try {
      process.env.VMUSIC_DATA_DIR = appFixture.dataDir;
      delete process.env.VMUSIC_UI_TOKEN;
      const unauthenticated = await fetch(appFixture.base+'/v1/ai/evaluation/status');
      assert.equal(unauthenticated.status,401,'Managed evaluation status requires the app bearer token');
      const status = await appFixture.api('/v1/ai/evaluation/status');
      assert.equal(status.provider,'fake');
      assert.equal(status.providerReady,true);
      assert.equal(status.generationConsent,false);
      await appFixture.api('/v1/settings','PUT',{ai_generation_consent:true});
      const managedDir = path.join(temp,'managed-driver-run');
      const managed = await driver('--run-managed','--server',appFixture.base,'--round','1',
        '--limit','2','--out',managedDir);
      assert.equal(JSON.parse(managed.stdout).candidateChecks,'failed',
        'A partial managed run cannot pass its sample gate');
      const managedRun = loadRun(managedDir,corpus,harness);
      assert.equal(managedRun.meta.executionMode,'managed');
      assert.equal(managedRun.meta.provider,'fake');
      assert.equal(managedRun.rows.length,2);
      assert.equal(managedRun.report.metrics.accounting,'not_recorded');
      assert.equal(Object.hasOwn(managedRun.report.metrics,'usageKnown'),false);
      assert.equal(Object.hasOwn(managedRun.report.metrics,'localPriceMicroUsd'),false);
      for(const row of managedRun.rows) {
        assert.equal(row.accounting,'not_recorded');
        assert.equal(Object.hasOwn(row,'usage'),false);
        assert.equal(Object.hasOwn(row,'reservationMicroUsd'),false);
        assert.equal(Object.hasOwn(row,'localPriceMicroUsd'),false);
      }
      assert.equal((await appFixture.api('/v1/ai/jobs')).jobs.length,0,
        'Managed evaluation does not create persistent generation jobs');
      const deniedDir = path.join(temp,'managed-denied-run');
      await appFixture.api('/v1/settings','PUT',{ai_generation_consent:false});
      await assert.rejects(()=>driver('--run-managed','--server',appFixture.base,'--round','1',
        '--limit','1','--out',deniedDir),/generation consent/);
      assert.equal(fs.existsSync(deniedDir),false,'A disabled consent gate must make no model call or run record');
      for(const file of ['run.json','results.jsonl','reviews.json','report.json']) {
        const filePath=path.join(managedDir,file);
        if(fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      fs.rmdirSync(managedDir);
    } finally {
      if(priorFixtureDataDir===undefined) delete process.env.VMUSIC_DATA_DIR;
      else process.env.VMUSIC_DATA_DIR=priorFixtureDataDir;
      if(priorUiToken===undefined) delete process.env.VMUSIC_UI_TOKEN;
      else process.env.VMUSIC_UI_TOKEN=priorUiToken;
      await appFixture.close();
    }
    const managedOllamaFixture = await startFixture({backend:'null',prepareData:async dataDir=>{
      fs.mkdirSync(dataDir,{recursive:true});
      fs.writeFileSync(path.join(dataDir,'config.toml'),
        `[ai]\nprovider = "ollama"\norigin = "${origin}"\nmodel = "fixture-local"\n`);
    }});
    try {
      await managedOllamaFixture.api('/v1/settings','PUT',{ai_generation_consent:true});
      const status = await managedOllamaFixture.api('/v1/ai/evaluation/status');
      assert.equal(status.provider,'ollama-local');
      assert.equal(status.providerReady,true);
      const token = JSON.parse(fs.readFileSync(path.join(managedOllamaFixture.dataDir,'vmusicd.json'),'utf8')).token;
      const priorOllamaDataDir = process.env.VMUSIC_DATA_DIR;
      const priorOllamaUiToken = process.env.VMUSIC_UI_TOKEN;
      try {
        process.env.VMUSIC_DATA_DIR = managedOllamaFixture.dataDir;
        delete process.env.VMUSIC_UI_TOKEN;
        const managedOllamaDir = path.join(temp,'managed-ollama-run');
        const managedOllama = await driver('--run-managed','--server',managedOllamaFixture.base,
          '--round','1','--limit','1','--out',managedOllamaDir);
        assert.equal(JSON.parse(managedOllama.stdout).candidateChecks,'failed',
          'A single managed Ollama sample cannot pass the full-sample gate');
        const managedOllamaRun = loadRun(managedOllamaDir,corpus,harness);
        assert.equal(managedOllamaRun.meta.executionMode,'managed');
        assert.equal(managedOllamaRun.meta.provider,'ollama-local');
        assert.equal(managedOllamaRun.meta.binarySha256,null,
          'Managed mode identifies the configured server provider, not a standalone CLI binary');
        assert.equal(managedOllamaRun.rows.length,1);
        assert.equal(managedOllamaRun.rows[0].kind,'candidate');
        assert.equal(Object.hasOwn(managedOllamaRun.rows[0],'usage'),false);
        for(const file of ['run.json','results.jsonl','reviews.json','report.json']) {
          const filePath=path.join(managedOllamaDir,file);
          if(fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        fs.rmdirSync(managedOllamaDir);
      } finally {
        if(priorOllamaDataDir===undefined) delete process.env.VMUSIC_DATA_DIR;
        else process.env.VMUSIC_DATA_DIR=priorOllamaDataDir;
        if(priorOllamaUiToken===undefined) delete process.env.VMUSIC_UI_TOKEN;
        else process.env.VMUSIC_UI_TOKEN=priorOllamaUiToken;
      }
      const requestCount = requests.length;
      let heldManagedResolve, closedManagedResolve;
      const heldManaged = new Promise(resolve=>{heldManagedResolve=resolve;});
      const closedManaged = new Promise(resolve=>{closedManagedResolve=resolve;});
      nextHold={skip:0,seen:heldManagedResolve,closed:closedManagedResolve};
      const controller = new AbortController();
      const pending = fetch(managedOllamaFixture.base+'/v1/ai/evaluation/case',{
        method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify({caseId:'dev-common-01',brief:'dark static orb'}),signal:controller.signal,
      }).then(()=>null,error=>error);
      try {
        await Promise.race([heldManaged,new Promise((_,reject)=>setTimeout(()=>reject(
          Error('Managed request did not reach the local provider fixture')),5000))]);
        controller.abort();
        assert.equal((await pending)?.name,'AbortError','Abort the managed HTTP observer');
        await Promise.race([closedManaged,new Promise((_,reject)=>setTimeout(()=>reject(
          Error('Managed request cancellation left the local provider connection open')),5000))]);
        assert.equal(requests.length,requestCount+1,'Disconnect cancellation must not retry the provider POST');
        let recovered;
        for(let attempt=0;attempt<20 && !recovered;attempt++) {
          const response = await fetch(managedOllamaFixture.base+'/v1/ai/evaluation/case',{
            method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
            body:JSON.stringify({caseId:'dev-common-02',brief:'dark static orb'}),
          });
          if(response.status===429) {
            await response.arrayBuffer();
            await delay(50);
            continue;
          }
          assert.equal(response.status,200,'The next sample should be admitted after cancellation cleanup');
          recovered=await response.json();
        }
        assert.ok(recovered,'The execution slot should return after the cancelled adapter exits');
        assert.equal(recovered.kind,'candidate','The execution slot is released after the cancelled adapter exits');
        assert.equal(requests.length,requestCount+2,'The next sample creates exactly one provider request');
        assert.equal((await managedOllamaFixture.api('/v1/ai/jobs')).jobs.length,0,
          'Aborted managed evaluation must not create a persistent job');
      } finally {
        controller.abort();
        nextHold=null;
      }
    } finally {
      await managedOllamaFixture.close();
    }
    console.log('Stage evaluation CLI: local Ollama adapter and managed fake-provider route, bearer auth, explicit consent, no persistent jobs or accounting fields, fingerprints, refusal/truncation separation, SIGINT handling and loopback-only origin passed');
  } finally {
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    if(originalDataDir===undefined) delete process.env.VMUSIC_DATA_DIR; else process.env.VMUSIC_DATA_DIR=originalDataDir;
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
