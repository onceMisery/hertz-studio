// SPDX-License-Identifier: MIT
// Exercise the production queues/transports with independent receipts and binary hashes.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const plain=v=>JSON.parse(JSON.stringify(v));
function env(api, overrides={}){
  const events=[],urls=[],revoked=[];
  const context={console,Uint8Array,Int32Array,DataView,TextEncoder,Blob,Date,Math,atob,btoa,Promise,AbortController,DOMException,
    setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},innerWidth:1280,innerHeight:720,
    URL:{createObjectURL(blob){urls.push(blob);return 'blob:test-'+urls.length;},revokeObjectURL(url){revoked.push(url);}},
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
    document:{hidden:false,dispatchEvent(e){events.push(e);}},VMusicTransport:api,...overrides};
  context.window=context;vm.createContext(context);
  for (const file of ['stage-resource-budget.js','stage-resource-policy.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../plugin/ui',file),'utf8'),context,{filename:file});
  const resourceLedger = context.StageResourceBudget.create(context.StageResourcePolicy);
  context.Stage = { resources: () => resourceLedger };
  for(const file of ['creative-draft.js','stage-media.js','stage-json-source.js','stage-persistence.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../plugin/ui',file),'utf8'),context,{filename:file});
  return {...context,events,urls,revoked};
}
function state(){return {state:{storeId:'service-a',current:{revision:0,initialized:false},library:{revision:0,initialized:false}},current:null,library:null};}
const current=name=>({version:1,scene:'orb',name,bg:{type:'theme'}});
function clock(){
  let time=0,id=0;const timers=new Map();
  function add(fn,ms,repeat){const key=++id;timers.set(key,{fn,ms,at:time+ms,repeat});return key;}
  return {timers,api:{setTimeout:(fn,ms)=>add(fn,ms,false),clearTimeout:key=>timers.delete(key),
    setInterval:(fn,ms)=>add(fn,ms,true),clearInterval:key=>timers.delete(key)},async advance(ms){
    const end=time+ms;
    for(let count=0;count<10000;count++){
      const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next){time=end;return;}
      const [key,t]=next;time=t.at;if(t.repeat)t.at+=t.ms;else timers.delete(key);t.fn();
      for(let i=0;i<12;i++)await Promise.resolve();
    }
    throw Error('timer loop did not settle');
  }};
}
async function leaseLifecycle(spec){
  const timer=clock(),lost=[],released=[];let renewals=0,settle;
  const e=env({async post(route,body){
    if(body.action==='lease.acquire')return {leaseId:'live',url:'/resource/live',media:'video',ttlMs:120000};
    if(body.action==='lease.renew'){renewals++;return new Promise((resolve,reject)=>settle={resolve,reject});}
    if(body.action==='lease.release'){released.push(body.leaseId);return {};}
    throw Error(body.action);
  }},timer.api);
  const lease=await e.StageMedia.acquire(spec,{onLost:error=>lost.push(error.message)});
  await timer.advance(90000);
  assert.equal(renewals,1,'slow renewals must never overlap');
  settle.reject(new Error('lease expired'));for(let i=0;i<12;i++)await Promise.resolve();
  assert.deepEqual(lost,['lease expired'],'expiry reaches the presentation owner once');
  assert.equal(timer.timers.size,0,'failed leases stop their renewal timer');
  await timer.advance(8*3600000);assert.equal(renewals,1,'failed leases do not poll for hours');
  lease.setActive(false);
  const resumedFailure=lease.setActive(true);assert.equal(renewals,2);
  settle.reject(new Error('still expired'));await resumedFailure.catch(()=>{});
  assert.deepEqual(lost,['lease expired','still expired'],'a later activation must notify its current owner even after a hidden failure');
  const retry=lease.renew();assert.equal(renewals,3);settle.resolve({ttlMs:120000});await retry;
  lease.setActive(false);assert.equal(timer.timers.size,0,'inactive presentations hold no renewal timer');
  await timer.advance(180000);assert.equal(renewals,3);
  const resume=lease.setActive(true);assert.equal(renewals,4,'resuming validates a potentially expired lease before playback');
  await lease.release();settle.reject(new Error('late failure'));await resume.catch(()=>{});
  assert.deepEqual(lost,['lease expired','still expired'],'a released owner cannot receive late callbacks');
  assert.equal(timer.timers.size,0);assert.deepEqual(released,['live']);
  const steady=clock();let renewed=0;
  const live=env({async post(route,body){
    if(body.action==='lease.acquire')return {leaseId:'steady',url:'/resource/steady',media:'video',ttlMs:120000};
    if(body.action==='lease.renew'){renewed++;return {ttlMs:120000};}
    if(body.action==='lease.release')return {};
    throw Error(body.action);
  }},steady.api);
  const longLease=await live.StageMedia.acquire(spec);
  await steady.advance(8*3600000);assert.equal(renewed,960,'eight simulated hours renew the same lease');
  assert.equal(steady.timers.size,1,'successful renewal retains exactly one timer');
  await longLease.release();assert.equal(steady.timers.size,0);
}
async function cancelledDbxRead(spec){
  const controller=new AbortController(),released=[];let reads=0,complete;
  const e=env({async post(route,body){
    if(body.action==='lease.acquire')return {leaseId:'cancelled-image',url:null,media:'image',length:CHUNK*2,mime:'image/png',contentKey:'same'};
    if(body.action==='lease.read'){reads++;return new Promise(resolve=>complete=resolve);}
    if(body.action==='lease.release'){released.push(body.leaseId);return {};}
    throw Error(body.action);
  }}),CHUNK=256*1024;
  const pending=e.StageMedia.acquire(spec,{signal:controller.signal});
  for(let i=0;i<12;i++)await Promise.resolve();
  assert.equal(reads,1);controller.abort();
  assert.deepEqual(released,['cancelled-image'],'cancellation revokes authority during an outstanding read');
  complete({offset:0,length:CHUNK*2,contentKey:'same',dataBase64:Buffer.alloc(CHUNK).toString('base64')});
  await assert.rejects(pending,error=>error.name==='AbortError');
  assert.equal(reads,1,'cancelled DBX assemblies never request the next block');assert.equal(e.urls.length,0);
}
async function main(){
  let server=state(),writes=[],mode='normal',release;
  const api={async get(){return structuredClone(server);},async put(route,request){
    assert.equal(route,'/v1/stage/presets');writes.push(plain(request));
    if(mode==='blocked'){mode='normal';await new Promise(r=>release=r);}
    if(mode==='conflict'){const e=new Error('revision conflict');e.code='stage_revision_conflict';throw e;}
    assert.equal(request.expectedPresetRevision,server.state[request.target].revision);
    const receipt={requestId:request.requestId,revision:request.expectedPresetRevision+1,target:request.target};
    server[request.target]=plain(request.payload);server.state[request.target]={revision:receipt.revision,initialized:true,lastCommit:receipt};
    if(mode==='lost'){mode='normal';throw new Error('response lost');}
    return receipt;
  }};
  let e=env(api),p=e.StagePersistence;
  await p.load(current('legacy'),[]);assert.equal(server.current.name,'legacy');assert.equal(writes.length,2);
  // An explicitly saved empty library must defeat a stale non-empty browser copy.
  e=env(api);p=e.StagePersistence;await p.load(current('stale'),[{id:'old',scene:'orb'}]);assert.equal(writes.length,2);assert.deepEqual(server.library,[]);
  mode='blocked';let a=p.save('current',current('first'));await Promise.resolve();
  let b=p.save('current',current('second')),c=p.save('current',current('latest'));release();await Promise.all([a,b,c]);
  assert.deepEqual(writes.slice(-2).map(w=>w.payload.name),['first','latest']);
  mode='lost';await p.save('current',current('ambiguous'));assert.equal(server.current.name,'ambiguous');assert.equal(p.status().current.error,null);
  mode='conflict';await assert.rejects(p.save('current',current('unsaved')),/conflict/);
  const before=writes.length;await assert.rejects(p.save('current',current('newer edit')),/conflict/);assert.equal(writes.length,before);
  assert.equal(p.status().current.dirty,true);mode='normal';await p.retry();assert.equal(server.current.name,'newer edit');
  const ref={storeId:'another-store',assetId:'a'.repeat(64)};
  assert.deepEqual(plain(p.sanitize({scene:'orb',bg:{type:'media',media:'image',assetRef:ref,url:'blob:dead'}}).value.bg),{type:'media',media:'image',assetRef:ref});
  assert.deepEqual(plain(p.sanitize({scene:'orb',bg:{type:'media',url:'blob:old'}}).value.bg),{type:'theme'});
  // Browser upload is chunked even without SubtleCrypto (opaque DBX iframe).
  const bytes=crypto.randomBytes(256*1024+29),chunks=[],commands=[];let status='uploading',cancelled=false;
  e=env({async post(route,body){
    commands.push(plain(body));
    if(body.action==='import.begin')return {importId:'test-import',uploadToken:'short-lived',offset:0};
    if(body.action==='import.finish'){status='committed';return {status,media:'image',assetRef:ref};}
    if(body.action==='import.cancel'){cancelled=true;return {status:'cancelled'};}
    throw Error(body.action);
  },async postRaw(route,blob){
    const query=new URL(route,'http://test').searchParams,data=Buffer.from(await blob.arrayBuffer());
    assert.ok(data.length<=256*1024);assert.equal(query.get('hash'),crypto.createHash('sha256').update(data).digest('hex'));
    assert.equal(Number(query.get('offset')),chunks.reduce((n,b)=>n+b.length,0));chunks.push(data);
  }});
  const file=new Blob([bytes],{type:'image/png'});file.name='upload.png';
  const spec=await e.StageMedia.importFile(file);assert.deepEqual(Buffer.concat(chunks),bytes);assert.equal(chunks.length,2);
  assert.deepEqual(plain(spec),{type:'media',media:'image',assetRef:ref});assert.equal(cancelled,false);
  const prepared=crypto.randomBytes(256*1024+9),reads=[],releases=[];
  e=env({async post(route,body){
    if(body.action==='lease.acquire')return {leaseId:'image-lease',media:'image',url:null,length:prepared.length,mime:'image/png',contentKey:'variant'};
    if(body.action==='lease.read'){
      reads.push(body.count);return {offset:body.offset,length:prepared.length,contentKey:'variant',dataBase64:prepared.subarray(body.offset,body.offset+body.count).toString('base64')};
    }
    if(body.action==='lease.release'){releases.push(body.leaseId);return {};}
    throw Error(body.action);
  }});
  const lease=await e.StageMedia.acquire(spec);assert.equal(e.urls.length,1);assert.deepEqual(Buffer.from(await e.urls[0].arrayBuffer()),prepared);
  assert.deepEqual(reads,[256*1024,256*1024]);await lease.release();await lease.release();assert.deepEqual(releases,['image-lease']);assert.equal(e.revoked.length,1);
  await leaseLifecycle(spec);
  await cancelledDbxRead(spec);
  console.log('Stage media: migration/CAS, receipt recovery, bounded upload/DBX reads, cancellation, serial renewal, eight-hour simulated lease clock and cleanup passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
