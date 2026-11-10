// SPDX-License-Identifier: MIT
'use strict';
// Actual native projections and production planners; no media loading or GL.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),output=path.join(root,'output/playwright/wallpaper-builtin');
const source=file=>import(pathToFileURL(path.join(root,'tools/space-stage',file)));
(async()=>{
  const [{createRegistry},{compilePlan},{sourceIdentity,createBackground},{createScope},THREE,{sceneDefinitions}]=await Promise.all([
    source('src/registry.js'),source('src/composition/plan.js'),source('src/composition/builtin.js'),
    source('src/scope.js'),source('node_modules/three/build/three.module.js'),source('src/scenes/index.js')]);
  const catalog=require('../crates/hertz-wallpaper/contracts/catalog.json'),registry=createRegistry();
  for(const metadata of catalog.scenes){const original=sceneDefinitions.find(definition=>definition.id===metadata.id);
    registry.register({...metadata,apiVersion:1,compositionResourcePlan:original?.compositionResourcePlan,create:()=>({update(){},dispose(){}})});}
  const identity=await sourceIdentity(registry);assert.equal(identity.registryHash,catalog.registryHash);
  const projections=JSON.parse(fs.readFileSync(path.join(output,'native-projections.json'))),results=[];
  const base=projections['overlay-480-contain'].projection;
  const plan=compilePlan(base,registry,identity);assert.equal(plan.builtin.facts.stateVersion,1);
  const refuse=(label,mutate,pattern)=>{const value=structuredClone(base);mutate(value);assert.throws(()=>compilePlan(value,registry,identity),pattern);results.push(label);};
  const version=base.ir.nodes[0].propertySlots.stateVersion[0];
  refuse('structural numeric version cannot default to the current source',value=>value.ir.numericSlots[version].value=2,/version/);
  refuse('missing structural version is rejected',value=>delete value.ir.nodes[0].propertySlots.stateVersion,/version/);
  refuse('structural version cannot alias a default-valued parameter',value=>{
    value.ir.numericSlots[version].value=2;value.ir.nodes[0].propertySlots.stateVersion=value.ir.nodes[0].propertySlots.scale;
  },/version-slot/);
  refuse('stale original registry hash is rejected',value=>value.ir.sceneRegistryHash='0'.repeat(64),/projection-mismatch/);
  refuse('forged original source cost is rejected',value=>value.builtinTarget.profile.sourceResources.cpuPeakBytes=1,/projection-mismatch/);
  const ripple=base.ir.numericSlots.findIndex(slot=>slot.nodeIndex===0&&slot.builtinParameter&&slot.property==='ripples');
  refuse('nonzero final ripple is rejected before loading',value=>value.ir.numericSlots[ripple].value=1,/ripples/);
  refuse('missing default parameter cannot silently restore a source default',value=>value.ir.numericSlots[ripple].builtinParameter=false,/parameters-incomplete/);
  refuse('parameter mapping must identify its actual compiler slot',value=>value.ir.nodes[0].propertySlots.ripples=[version],/parameter-slot/);
  for(const dimension of ['ownedCpuBytes','renderTargetDeclaredBytes','programs','bufferDeclaredBytes','textureDeclaredBytes','decodeReservedBytes','decoderLeases'])
    refuse('understated complete '+dimension,value=>value.pageLimits[dimension]--,/page-projection-mismatch/);
  refuse('complete CPU memory limit is independent of GPU limit',value=>{
    const asset=value.resolvedAssets.find(asset=>asset.kind==='image');asset.width=5000;asset.height=5000;
  },/complete-memory-budget/);
  const memory=structuredClone(base),facts=memory.builtinTarget;
  facts.targetFacts.physicalWidth=1900;facts.targetFacts.physicalHeight=1200;
  facts.allowance.outputPixelRate=15000000;facts.nativePixelAllowance=1000000;
  facts.cssWidth=1900;facts.cssHeight=1200;facts.effectiveDpr=Math.sqrt(1000000/(1900*1200));
  memory.target.width=facts.target.width=Math.floor(1900*facts.effectiveDpr);
  memory.target.height=facts.target.height=Math.floor(1200*facts.effectiveDpr);
  const asset=memory.resolvedAssets.find(asset=>asset.kind==='image');asset.width=3500;asset.height=3500;
  const pixels=memory.target.width*memory.target.height,texture=3500*3500*4;
  assert(pixels*8+texture+plan.resources.bufferDeclaredBytes+96<facts.profile.memoryBytes);
  assert(pixels*20+texture+plan.resources.bufferDeclaredBytes+96>facts.profile.memoryBytes);
  assert.throws(()=>compilePlan(memory,registry,identity),/complete-memory-budget/);
  results.push('64MiB GPU counterexample passes single color target but fails complete 20P output');
  const scope=createScope(),sourcePlan=plan.builtin;
  const background=await createBackground(THREE,{renderer:{}},scope,sourcePlan,base.canvas,{},()=>true);
  const baseline=background.camera.clone();baseline.updateMatrixWorld(true);
  const cases=[];
  for(const [width,height]of [[408,272],[204,272]])for(const fit of ['contain','cover','stretch']){
    const sx=fit==='stretch'?width/256:fit==='contain'?Math.min(width/256,height/128):Math.max(width/256,height/128);
    const sy=fit==='stretch'?height/128:sx,left=(width-256*sx)/2,top=(height-128*sy)/2;
    background.resize(width,height,left,top,256*sx,128*sy);background.camera.updateMatrixWorld(true);
    for(const point of [[-2,-1,0],[1,2,-3],[0,0,0]]){
      const expected=new THREE.Vector3(...point).project(baseline),actual=new THREE.Vector3(...point).project(background.camera);
      const px=left+(expected.x+1)*128*sx,py=top+(1-expected.y)*64*sy;
      assert(Math.abs((actual.x+1)*width/2-px)<1e-9);assert(Math.abs((1-actual.y)*height/2-py)<1e-9);
      assert(Math.abs(actual.z-expected.z)<1e-12,'fit must retain depth');
    }
    for(const z of [-.05,-900]){
      const a=new THREE.Vector4(0,0,z,1).applyMatrix4(baseline.projectionMatrix);
      const b=new THREE.Vector4(0,0,z,1).applyMatrix4(background.camera.projectionMatrix);
      assert.equal(a.z,b.z);assert.equal(a.w,b.w);
    }
    cases.push({width,height,fit,near:background.camera.near,far:background.camera.far});
  }
  scope.dispose();results.push('original camera author-space fit oracle, inverse projection and unchanged near/far depth');
  fs.writeFileSync(path.join(output,'plan-report.json'),JSON.stringify({qualification:'native-projection-production-plan-and-camera',results,cases},null,2));
  console.log('Builtin plan: '+results.length+' checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
