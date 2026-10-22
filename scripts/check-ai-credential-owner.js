// SPDX-License-Identifier: MIT
// Two isolated service processes, memory secrets and null audio. No model calls.
'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {startFixture}=require('./ui-browser-fixture');
const root=path.resolve(__dirname,'..');
const binary=path.resolve(process.env.HERTZ_BIN||path.join(root,'target','debug',process.platform==='win32'?'hertz-studio.exe':'hertz-studio'));
process.env.HERTZ_BIN=binary;
const reportPath=path.resolve(process.env.HERTZ_CREDENTIAL_OWNER_REPORT||path.join(root,'output','ai-credential-owner.json'));
const endpoint='/v1/ai/provider-credential', synthetic='fixture-lifecycle-never-real';
const expected=configured=>({provider:'openai',origin:'https://api.openai.com',configured});
async function until(probe){const end=Date.now()+20000; while(Date.now()<end){const value=probe(); if(value) return value; await new Promise(r=>setTimeout(r,50));}throw Error('second instance readiness timed out');}
(async()=>{
 const fixture=await startFixture(); let second;
 try {
  const edition=(await fixture.api('/v1/health')).edition;
  assert.ok(['standard','full'].includes(edition),'fixture must report a known edition');
  assert.equal((await fixture.api('/v1/ai/status')).consent.inAppGeneration,false);
  await fixture.api('/v1/settings','PUT',{ai_generation_consent:true});
  assert.deepEqual(await fixture.api(endpoint,'PUT',{api_key:synthetic}),expected(true));
  assert.deepEqual(await fixture.api(endpoint),expected(true));
  const jobsBefore=await fixture.api('/v1/ai/jobs?limit=50');
  const budgetBefore=(await fixture.api('/v1/ai/status')).budget;
  const old=JSON.parse(fs.readFileSync(path.join(fixture.dataDir,'vmusicd.json'),'utf8'));
  second=spawn(process.env.HERTZ_BIN,['--bind','127.0.0.1','--port','0','--data-dir',fixture.dataDir],{
   windowsHide:true,stdio:'ignore',env:{...process.env,VMUSIC_BACKEND:'null',VMUSIC_SECRETS:'memory'}});
  let launchError; second.on('error',error=>{launchError=error;});
  const discovery=await until(()=>{
   if(launchError) throw launchError; assert.equal(second.exitCode,null);
   try {const doc=JSON.parse(fs.readFileSync(path.join(fixture.dataDir,'vmusicd.json'),'utf8')); return doc.pid===second.pid?doc:null;}catch{return null;}
  });
  assert.notEqual(discovery.pid,old.pid);
  const secondBase='http://127.0.0.1:'+discovery.port;
  const deniedTask=await fetch(secondBase+'/v1/ai/jobs',{method:'POST',
   headers:{Authorization:'Bearer '+discovery.token,'Content-Type':'application/json'},
   body:JSON.stringify({brief:'second runner budget probe'}),signal:AbortSignal.timeout(10000)});
  assert.equal(deniedTask.status,503,'non-runner task admission must be denied even with consent enabled');
  assert.equal((await deniedTask.json()).error.code,'ai_locked');
  const jobsAfter=await fixture.api('/v1/ai/jobs?limit=50');
  const budgetAfter=(await fixture.api('/v1/ai/status')).budget;
  assert.deepEqual(jobsAfter.jobs.map(job=>job.jobId),jobsBefore.jobs.map(job=>job.jobId),
   'non-runner cannot create a persisted task');
  assert.equal(budgetAfter.reservedMicroUsd,budgetBefore.reservedMicroUsd,
   'non-runner cannot reserve budget');
  assert.equal(budgetAfter.chargedMicroUsd,budgetBefore.chargedMicroUsd,
   'non-runner cannot charge budget');
  for(const method of ['GET','PUT','DELETE']){
   const response=await fetch(secondBase+endpoint,{method,headers:{Authorization:'Bearer '+discovery.token,'Content-Type':'application/json'},
    body:method==='PUT'?JSON.stringify({api_key:synthetic}):undefined,signal:AbortSignal.timeout(10000)});
   assert.equal(response.status,503,'non-runner credential management must be denied');
   const body=await response.text(); assert.equal(JSON.parse(body).error.code,'ai_locked'); assert.ok(!body.includes(synthetic));
  }
  assert.deepEqual(await fixture.api(endpoint),expected(true));
  assert.deepEqual(await fixture.api(endpoint,'PUT',{api_key:synthetic}),expected(true));
  assert.deepEqual(await fixture.api(endpoint,'DELETE'),expected(false));
  assert.deepEqual(await fixture.api(endpoint,'DELETE'),expected(false));
  assert.equal((await fetch(fixture.base+endpoint)).status,401);
  function inspect(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory()) inspect(file);else assert.ok(!fs.readFileSync(file).includes(Buffer.from(synthetic)));}}
  inspect(fixture.dataDir);
  const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const files=['credential.rs','jobs.rs','usage.rs','provider.rs','evaluation.rs'];
  const report={result:'passed',at:new Date().toISOString(),scope:edition+', two real processes sharing DataDir; memory secrets, null audio, no model calls',
   binary:process.env.HERTZ_BIN,binarySha256:digest(process.env.HERTZ_BIN),
   harnessSha256:digest(__filename),workshopSha256:digest(path.join(root,'plugin/ui/workshop.js')),
   sources:Object.fromEntries(files.map(n=>[n,digest(path.join(root,'crates/hertz-studio/src/ai',n))])),
   checks:['second process task submission denied with consent enabled and no task or budget mutation',
    'primary management while generation enabled','second process GET/PUT/DELETE denied by runner ownership',
    'auth','three-field status','same-key save','idempotent delete','no persisted key']};
  fs.mkdirSync(path.dirname(reportPath),{recursive:true});
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
 } finally {
  if(second && second.exitCode===null && second.signalCode===null){const closed=once(second,'exit');second.kill();await closed;}
  await fixture.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
