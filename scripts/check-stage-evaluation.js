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
const { loadCorpus, stageHarness, assess, summarize, validateRow, loadRun, compareRuns, exportReview, childCase,
  main:runEvaluation, driverFingerprint } = require('./evaluate-ai-stage');

async function main() {
  const corpus = loadCorpus();
  assert.equal(corpus.version,'v2','Current evaluation corpus must follow the active contract');
  assert.equal(loadCorpus('v2').manifest.schemaHash,corpus.contract.schemaHash);
  assert.throws(()=>loadCorpus('v1'),/Unsupported stage-intent corpus version/,
    'Historical v1 evidence must be reproduced with its original evaluator revision');
  const harness = stageHarness();
  const positive = corpus.cases.find(c=>c.id==='dev-common-01');
  const negative = corpus.cases.find(c=>c.id==='dev-neg-01');
  const unsupported = corpus.cases.find(c=>c.id==='dev-inject-01');
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
    console.log('Stage evaluation CLI: real adapter, one local POST, stable protocol/request fingerprints, preserved counters, refusal/truncation separation, resumable SIGINT report, forbidden origin and zero DataDir side effects passed');
  } finally {
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    if(originalDataDir===undefined) delete process.env.VMUSIC_DATA_DIR; else process.env.VMUSIC_DATA_DIR=originalDataDir;
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
