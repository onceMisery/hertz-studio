// SPDX-License-Identifier: MIT
'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
(async()=>{
  const {createInputSampler}=await import(pathToFileURL(path.resolve(__dirname,'../tools/space-stage/src/composition/builtin.js')));
  const clock={spectrumCapacity:64,inputBankLength:75,inputBytes:1200};
  let resets=0;const sampler=createInputSampler(clock,{durationSeconds:2,loop:true},()=>resets++);
  const first=sampler.sample({sceneTime:.5,seek:true,level:.2,bands:{bass:.3,mid:.4,treble:.5},spectrum:[10,20],dt:.1});
  assert.equal(resets,1);assert.equal(sampler.stats().hasCommitted,false);
  const retry=sampler.sample({sceneTime:.5,seek:true,level:.9,spectrum:[99]});
  assert.equal(retry.level,.2);assert.deepEqual([...retry.spectrum],[10,20]);assert.equal(resets,1);
  sampler.commit();assert.equal(sampler.stats().committedTime,.5);
  const paused=sampler.sample({sceneTime:1.7,paused:true,level:.9,spectrum:[99]});
  assert.equal(paused.sceneTime,.5);assert.equal(paused.level,.2);assert.equal(paused.dt,0);sampler.commit();
  const reverse=sampler.sample({sceneTime:.1,paused:true,seek:true,level:.6,spectrum:[7]});
  assert.equal(reverse.sceneTime,.1);assert.equal(reverse.level,.6);assert.equal(resets,2);
  assert.equal(sampler.stats().committedTime,.5,'unsubmitted seek cannot change committed input');
  sampler.commit();assert.equal(sampler.stats().committedTime,.1);assert.equal(sampler.stats().inputBytes,1200);
  sampler.sample({sceneTime:1.2,level:.9});
  const interrupted=sampler.sample({sceneTime:.1,level:.3,paused:true});
  assert.equal(interrupted.sceneTime,.1);assert.equal(interrupted.level,.6);sampler.commit();
  sampler.sample({sceneTime:1.2,level:.9});const before=resets;
  sampler.sample({sceneTime:1.2,seek:true,level:.7});assert.equal(resets,before+1);
  assert.equal(sampler.sample({sceneTime:1.2,seek:true,level:.2}).level,.7);assert.equal(resets,before+1);
  for(const bad of [{spectrum:new Array(65).fill(0)},{spectrum:[NaN]},{level:Infinity},{bands:{bass:NaN}},{sceneTime:Infinity}])
    assert.throws(()=>sampler.sample({...bad,paused:true}),/composition-builtin/);
  console.log('Builtin sampling: pending retry, committed pause, reverse seek, exact input backing bytes and invalid-input refusal passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
