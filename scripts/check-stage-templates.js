// SPDX-License-Identifier: MIT
// Post-implementation checks of catalog compatibility and the original owner.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {harness}=require('./check-stage-project');
async function main(){
  const h=harness(),{CS,P}=h;
  h.sandbox.VMusicTransport.put=async()=>({});
  for(const file of ['creative-draft.js','creative-templates.js']){
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../plugin/ui',file),'utf8'),h.sandbox,{filename:file});
    Object.assign(h.sandbox,h.sandbox.window);
  }
  const T=h.sandbox.CreativeTemplates,D=h.sandbox.CreativeDraft;
  const source=CS.canonicalBaseline('lyric');source.name='Private current piece';
  source.cues=[{at:2,len:1000,set:{'look.bloom':1}}];
  source.bindings=[{target:'look.bloom',source:'energy',gain:1}];CS.setPreset(source);
  CS.setBackground({type:'media',url:'file:///private.png'});
  const before=JSON.stringify(CS.preset());
  assert.equal(T.list().length,3);
  for(const template of T.list()){
    assert.equal(template.compatible,true);assert.equal(template.reviewStatus,'candidate');
    const draft=await T.prepare(template.id);
    assert.equal(JSON.stringify(CS.preset()),before,'Preparing a template must not mutate committed state');
    assert.equal(draft.preset.scene,template.scene);assert.equal(draft.preset.name,template.title);
    assert.equal(draft.preset.cues.length,0);assert.equal(draft.preset.bindings.length,0);
    assert.equal(draft.preset.director,false);assert.equal(draft.preset.bg.type,'theme');
    assert.ok(draft.diagnostics.every(d=>!d.clamped),'Reviewed recipes must not depend on silent clamping');
    assert.equal(draft.proposalHash,(await T.prepare(template.id)).proposalHash);
    assert.equal(D.canonical(await h.sandbox.CreativeShareCode.decode(draft.shareCode)),D.canonical(draft.preset));
    const token=CS.beginPreview(draft.preset,draft.proposalHash);
    assert.equal(CS.scene(),template.scene);assert.equal(JSON.stringify(CS.preset()),before);
    const exported=await P.capture(false);assert.equal(exported.project.preset.name,source.name);
    assert.equal(CS.applyPreview(token.previewId,'wrong-hash').ok,false);
    CS.cancelPreview();assert.equal(CS.scene(),'lyric');
  }
  const draft=await T.prepare('quiet-orb'),token=CS.beginPreview(draft.preset,draft.proposalHash);
  assert.equal(CS.applyPreview(token.previewId,draft.proposalHash).ok,true);
  assert.equal(CS.preset().name,'静夜星球');
  CS.savePreset('Template copy');assert.equal(CS.library()[0].name,'Template copy');
  assert.equal(CS.library()[0].scene,'orb');
  assert.equal(h.requests(),0,'Templates never read media or call a model');
  const info=T.list();info[0].version=999;assert.equal(T.list()[0].version,1);
  draft.artifact.intent.patch['look.bloom']=99;
  assert.equal((await T.prepare('quiet-orb')).preset.look.bloom,.12);
  await assert.rejects(()=>T.prepare('missing'),/未知/);
  const contract=h.sandbox.CreativeStageContract,original=contract.schemaHash;
  contract.schemaHash='0'.repeat(64);assert.equal(T.list().every(t=>!t.compatible),true);
  await assert.rejects(()=>T.prepare('quiet-orb'),/不兼容/);contract.schemaHash=original;
  const base=contract.basePresetHashes.orb;contract.basePresetHashes.orb='0'.repeat(64);
  await assert.rejects(()=>T.prepare('quiet-orb'),/不兼容/);contract.basePresetHashes.orb=base;
  console.log('Stage templates: fixed compatibility, pure canonical creation, named content identity, preview isolation, explicit apply, collection and share roundtrips passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
