// SPDX-License-Identifier: MIT
// The actual ImportJobs and ProbeHost own the resources throughout these faults.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const requestManagement = require('./desktop-native-management-client');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

module.exports = async function({output,configDir,inputs,cases,evidence,pages,wallpaper,settings,child,send,result,reference,derivedReceipts}) {
  const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0,32);
  const state = async () => {
    const reply = await requestManagement(pipe, {command:'status'});
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.wallpaper;
  };
  async function until(fn, label, timeout=5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await fn(); if (value) return value;
      assert.equal(child.exitCode, null); await delay(80);
    }
    throw new Error(label);
  }
  const database = () => JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-c',
    'import json,sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps({"qualifications":c.execute("SELECT * FROM media_qualifications ORDER BY cache_key").fetchall(),"derived":c.execute("SELECT cache_key,path,bytes,pipeline_version FROM derived_entries ORDER BY cache_key").fetchall()})); c.close()',
    path.join(configDir,'wallpaper.db')], {encoding:'utf8',windowsHide:true,timeout:15000}));
  const baseline = await state();
  assert.equal(baseline.decodeProbe, null);
  assert.equal(baseline.budget.prepareTasks, 0);
  const checks = evidence.closeFailures = [];
  let nonce = 70000;
  async function control(page, probeId, blocked, wait=true) {
    const request = {nonce:++nonce,probeId,blocked};
    await page.evaluate(request => window.ipc.postMessage('decode_probe_close '+JSON.stringify(request)), request);
    if (!wait) return;
    await page.waitForFunction(nonce => window.__nativeDecodeCloseProbe?.nonce===nonce, request.nonce);
    return page.evaluate(() => window.__nativeDecodeCloseProbe);
  }
  const pending = id => wallpaper.evaluate(id => window.__nativeImportProbes?.[id] ?? null, id);
  async function blocked(id, outcome, decoder) {
    const value = await until(async () => {
      const value = await state(), probe = value.decodeProbe;
      return probe?.closeError && probe.outcome===outcome && probe.fileReadersDrained && probe.closeAttempts>1 ? value : null;
    }, 'failed Close keeps the real probe, budget and unpublished job', outcome==='probe_inconclusive'?18000:5000);
    assert.equal(await pending(id), null, 'no job terminal reply before actual controller exit');
    assert.equal(value.decodeProbe.controllerClosed, false);
    assert.equal(value.decodeProbe.closeError, '0x80004005');
    assert.ok(value.decodeProbe.closeFailedAgeMs >= 0);
    assert.equal(value.budget.decoderSlots, baseline.budget.decoderSlots + decoder);
    assert.equal(value.budget.prepareTasks, 1, 'the actual job still owns the prepare slot');
    assert.ok(value.budget.releasePending > baseline.budget.releasePending);
    const page = pages().find(page => page.url().includes('/wallpaper-probe.html'));
    assert.ok(page && !page.isClosed());
    assert.equal(await page.locator('video,img').count(), 0, 'media is stopped while the decoder controller remains alive');
    return {value,page};
  }
  async function reclaimed(id, page, expected) {
    const value = await result(id);
    assert.equal(value.state, expected, JSON.stringify(value));
    assert.equal(value.prepareTasks, 0); assert.equal(value.prepareCpuBytes, 0);
    assert.equal(value.activeStreams, 0); assert.equal(value.decoderSlots, baseline.budget.decoderSlots);
    const final = await state(); assert.equal(final.decodeProbe, null);
    assert.deepEqual(final.budget, baseline.budget);
    assert.equal(page.isClosed(), true);
    assert.equal(settings.isClosed(), false); assert.equal(child.exitCode, null);
    return {value,final};
  }
  function oneCloseLog(probeId) {
    const lines = fs.readFileSync(path.join(configDir,'desktop.log'),'utf8').split(/\r?\n/);
    const matching = lines.filter(line => line.includes('probe controller close pending id='+probeId+' HRESULT=0x80004005'));
    assert.equal(matching.length, 1, 'repeated failed Close polls do not flood the log');
    return matching[0];
  }
  async function noPublication(name, before, id) {
    assert.equal(await pending(id), null);
    assert.deepEqual(database(), before, 'neither qualification nor derived content is published before real exit');
    assert.equal(fs.existsSync(path.join(configDir,'packages',hash(cases[name]))), false);
    assert.equal(fs.existsSync(path.join(configDir,'staging',name)), true, 'the job retains staging until its probe exits');
    assert.equal(hash(fs.readFileSync(path.join(inputs,name+'.hwpkg'))), hash(cases[name]));
  }

  let before = database();
  let id = await send('begin','close-success',false,null,null,null,true);
  let held = await blocked(id,'ok',1);
  await noPublication('close-success',before,id);
  const wrong = await control(held.page,held.value.decodeProbe.probeId+1,false);
  assert.equal(wrong.accepted,false); assert.equal(wrong.blocked,true);
  // Even an exact target id from the wallpaper's native callback has no probe authority.
  await wallpaper.evaluate(probeId => window.ipc.postMessage('decode_probe_close '+JSON.stringify({nonce:1,probeId,blocked:false})),held.value.decodeProbe.probeId);
  assert.equal(await wallpaper.evaluate(() => window.__nativeDecodeCloseProbe), undefined);
  await held.page.evaluate(() => {
    window.ipc.postMessage('decode_probe_close '+JSON.stringify({nonce:0,probeId:1,blocked:false}));
    window.ipc.postMessage('decode_probe_close '+'x'.repeat(513));
  });
  await delay(1200); const later = await state();
  assert.equal(later.decodeProbe.probeId,held.value.decodeProbe.probeId);
  assert.ok(later.decodeProbe.closeAttempts>held.value.decodeProbe.closeAttempts);
  assert.equal(later.decodeProbe.controllerClosed,false);
  await noPublication('close-success',before,id);
  const busy = await result(await send('begin','video')); assert.equal(busy.error,'budget_busy');
  const closeLog = oneCloseLog(held.value.decodeProbe.probeId);
  await control(held.page,held.value.decodeProbe.probeId,false,false);
  let done = await reclaimed(id,held.page,'done');
  assert.equal(done.value.cacheHits,0); assert.equal(done.value.probeRuns,1);
  assert.equal(fs.existsSync(path.join(configDir,'packages',hash(cases['close-success']))),true);
  assert.equal(fs.existsSync(path.join(configDir,'staging','close-success')),false);
  assert.equal(database().qualifications.length,before.qualifications.length+1,'the normal qualification path publishes only after actual Close');
  checks.push({name:'successful real video decode waits for Close and reader exit before publication; wrong identity and source cannot release it',held:held.value,later,closeLog,result:done});

  before = database(); id = await send('begin','close-cancel',false,null,null,null,true);
  held = await blocked(id,'ok',1); await noPublication('close-cancel',before,id);
  assert.equal((await result(await send('cancel','close-cancel'))).cancelRequested,true);
  const cancelled = await blocked(id,'cancelled',1);
  await delay(700); await noPublication('close-cancel',before,id);
  assert.equal((await result(await send('begin','video'))).error,'budget_busy');
  oneCloseLog(cancelled.value.decodeProbe.probeId);
  await control(held.page,held.value.decodeProbe.probeId,false,false);
  done = await reclaimed(id,held.page,'cancelled');
  assert.deepEqual(database(),before); assert.equal(fs.existsSync(path.join(configDir,'staging','close-cancel')),false);
  assert.equal(fs.existsSync(path.join(configDir,'packages',hash(cases['close-cancel']))),false);
  checks.push({name:'cancel after successful frames while Close fails overrides success, keeps staging and the single prepare owner, and never publishes qualification',held:held.value,cancelled:cancelled.value,result:done});

  before = database(); const started = Date.now();
  id = await send('begin','close-timeout',true,null,null,null,true);
  held = await blocked(id,'probe_inconclusive',1);
  assert.ok(Date.now()-started>=14500,'the actual 15-second probe deadline expires');
  await noPublication('close-timeout',before,id); await delay(700);
  assert.equal(await pending(id),null,'deadline expiry cannot return a still-live decoder or job slot');
  oneCloseLog(held.value.decodeProbe.probeId);
  await control(held.page,held.value.decodeProbe.probeId,false,false);
  done = await reclaimed(id,held.page,'failed'); assert.match(done.value.error,/^probe_inconclusive:/);
  assert.deepEqual(database(),before); assert.equal(fs.existsSync(path.join(configDir,'staging','close-timeout')),false);
  checks.push({name:'a real first-frame deadline changes the result but not the failed controller exit barrier or prepare ownership',held:held.value,result:done});

  // The previous ordinary planner case removed this import source. A new target
  // must still prepare from the installed immutable original with the same owner.
  assert.equal(fs.existsSync(path.join(inputs,'target.hwpkg')),false);
  const target = {width:53,height:53,fit:'cover',purpose:'low'};
  before = database(); const original = fs.readFileSync(path.join(configDir,'packages',reference.packageHash,'original.hwpkg'));
  id = await send('prepare','close-prepare',false,null,target,reference,true);
  held = await blocked(id,'ok',0);
  assert.ok(held.value.budget.cpuBytes>baseline.budget.cpuBytes,'decoded image storage remains charged');
  assert.deepEqual(database(),before,'new derived index and qualification remain unpublished');
  assert.equal(await pending(id),null);
  oneCloseLog(held.value.decodeProbe.probeId);
  await control(held.page,held.value.decodeProbe.probeId,false,false);
  done = await reclaimed(id,held.page,'done'); assert.equal(done.value.stagedBytes,0);
  assert.equal(hash(fs.readFileSync(path.join(configDir,'packages',reference.packageHash,'original.hwpkg'))),hash(original));
  assert.equal(database().derived.length,before.derived.length+1);
  assert.equal(database().qualifications.length,before.qualifications.length+1);
  assert.ok(derivedReceipts(configDir).some(receipt=>receipt.render?.width===106&&receipt.render?.height===53));
  checks.push({name:'installed-image preparation keeps decoded storage and unpublished target until real Close, then publishes without an import source',held:held.value,result:done});
  const stored = JSON.parse(fs.readFileSync(path.join(configDir,'config.json'),'utf8'));
  const domain = stored.activeProfile ? stored.profiles.find(entry=>JSON.stringify(entry.profile)===JSON.stringify(stored.activeProfile)) : stored.unboundDomain;
  const stopped = await requestManagement(pipe,{command:'wallpaper-apply',value:{expectedRevision:stored.revision,config:{...domain.wallpaper,enabled:false}}});
  assert.equal(stopped.ok,true,JSON.stringify(stopped));
  evidence.closeFailureFinal = await until(async()=>{
    const value=await state();
    return !value.enabled&&Object.values(value.budget).every(value=>value===0)&&value.retiringControllers===0&&value.retiringHandoffs===0?value:null;
  },'final native stop drains every budget and record');
  assert.equal(evidence.closeFailureFinal.decodeProbe,null);
  console.log('PASS 4 native probe Close failure groups');
};
