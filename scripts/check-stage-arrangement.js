// SPDX-License-Identifier: MIT
// Post-implementation checks against the real preset owner, project and rules.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {harness}=require('./check-stage-project');
async function main(){
  const h=harness(),{CS,P}=h;
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../plugin/ui/creative-arrangement.js'),'utf8'),h.sandbox);
  const A=h.sandbox.window.CreativeArrangement;
  const source=CS.canonicalBaseline('nebula');source.name='Manual section piece';source.look.bloom=.8;
  source.cues=[{every:4,len:200,set:{'look.bloom':1}}];
  source.bindings=[{target:'look.bloom',source:'energy',gain:10}];CS.setPreset(source);
  const sections=[{at:0,mode:'quiet',fade:1000},{at:2,mode:'chorus',fade:1000},{at:4,mode:'original',fade:1000}];
  const original=JSON.stringify(CS.preset()),plan=A.prepare(sections);
  assert.equal(JSON.stringify(CS.preset()),original,'Preparing sections cannot mutate the owner');
  assert.equal(h.requests(),0);
  assert.equal(plan.replacedCueCount,1);assert.equal(plan.bindingCount,1);assert.equal(plan.directorWasOn,true);
  assert.equal(plan.prepared.project.preset.scene,'nebula');
  assert.deepEqual(JSON.parse(JSON.stringify(plan.prepared.project.preset.sc)),JSON.parse(JSON.stringify(source.sc)));
  assert.equal(plan.prepared.project.preset.director,false);
  assert.equal(plan.prepared.project.preset.cues[0].set['look.bloom'],CS.sectionRules().quiet['look.bloom']);
  assert.equal(plan.prepared.project.preset.cues[2].set['look.bloom'],.8);
  // Consumers cannot mutate the shared director rules.
  const rules=CS.sectionRules();rules.quiet['look.bloom']=99;
  assert.equal(CS.sectionRules().quiet['look.bloom'],.18);
  for(const bad of [[],Array(33).fill(sections[0]),[{at:1,mode:'quiet',fade:1000}],
    [{at:0,mode:'missing',fade:1000}],[{at:0,mode:'quiet',fade:NaN}],
    [{at:0,mode:'quiet',fade:1000}, {at:.9996,mode:'verse',fade:100}],
    [sections[0],sections[0]],[sections[0],{at:Infinity,mode:'verse',fade:1000}],
    [{...sections[0],url:'file:///private'}]]) assert.throws(()=>A.prepare(bad));
  assert.equal(JSON.stringify(CS.preset()),original);
  A.apply(plan);assert.match(P.status(),/未绑定/);h.position(2500);
  assert.equal(CS.runtime()['look.bloom'],.8,'Generated track waits for explicit media confirmation');
  await P.bindCurrent();h.onset.energy=.8;
  for(const [ms,want]of [[1000,.18],[2500,.3],[4500,.61],[9000,.8],[2500,.3],[0,.8]]){
    h.position(ms);assert.ok(Math.abs(CS.runtime()['look.bloom']-want)<1e-9,'Recomputed section at '+ms);
  }
  // File reopening keeps the generated editable cues and media identity, not a
  // second runtime section owner. Existing share transport remains v1.
  const captured=await P.capture(true),reopened=P.prepare(JSON.stringify(captured.project));
  assert.equal(JSON.stringify(reopened.project.preset.cues),JSON.stringify(plan.prepared.project.preset.cues));
  const code=await h.sandbox.CreativeShareCode.encode(CS.shareSnapshot());
  const shared=await h.sandbox.CreativeShareCode.decode(code);
  assert.equal(JSON.stringify(shared.cues),JSON.stringify(reopened.project.preset.cues));
  const second=A.prepare(sections);assert.deepEqual(JSON.parse(JSON.stringify(second.prepared.project.media)),h.identity);
  let notifiedRevision;
  CS.onChange(kind=>{if(kind==='param')notifiedRevision=CS.revision();});
  CS.setParam('look.bloom',.9);const edited=JSON.stringify(CS.preset());
  assert.equal(notifiedRevision,CS.revision(),'Param observers must see the committed revision');
  assert.throws(()=>A.apply(second),/已修改/);assert.equal(JSON.stringify(CS.preset()),edited);
  h.changed();assert.match(P.status(),/等待/);
  CS.setBackground({type:'media',url:'file:///private.png'});
  assert.ok(A.prepare(sections).prepared.warnings.some(w=>w.includes('另选素材')));
  console.log('Stage arrangement: pure section compilation, shared rules, bounds, explicit replacement/media confirmation, reversible seeks, stale rejection and project/share roundtrips passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
