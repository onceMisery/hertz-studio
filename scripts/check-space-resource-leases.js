// SPDX-License-Identifier: MIT
// Shared spatial assets: independent consumers and bounded underlying load lifetime.
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const images = [], textures = [];
global.Image = class {
  constructor() { images.push(this); this.naturalWidth=64; this.naturalHeight=32; this.assignments=[]; }
  set src(value) { this.assignments.push(value); this.url=value; }
  get src() { return this.url; }
  complete() { this.onload?.(); }
};
global.document = {createElement:()=>({width:0,height:0,getContext:()=>({drawImage(){},measureText:text=>({width:text.length*12}),fillText(){}})})};
const THREE = {CanvasTexture:class {
  constructor(image) { this.image=image; this.userData={}; this.disposals=0; textures.push(this); }
  dispose() { this.disposals++; }
}};
const flush = async()=>{ for(let i=0;i<10;i++)await Promise.resolve(); };
async function main() {
  const {createSpatialResources} = await import(pathToFileURL(path.resolve(__dirname,'../tools/space-stage/src/scenes/resources.js')));
  let invalidations=0, resolves=0;
  const pool=createSpatialResources(THREE,()=>invalidations++,url=>{resolves++;return url;});
  const firstOwner=new AbortController(), secondOwner=new AbortController();
  const first=pool.cover.acquire('shared',firstOwner.signal), second=pool.cover.acquire('shared',secondOwner.signal);
  await flush(); assert.equal(resolves,1,'consumers merge into one underlying load');
  const sharedImage=images.at(-1);
  firstOwner.abort(); sharedImage.complete();
  assert.equal(first.texture,null,'an aborted consumer no longer exposes the texture');
  const texture=second.texture; assert.ok(texture,'first consumer cancellation cannot cancel another consumer');
  assert.equal(invalidations,1);
  pool.cover.release(first); pool.cover.release(first);
  assert.equal(texture.disposals,0,'repeated release cannot consume another lease');
  secondOwner.abort(); pool.cover.release(second);
  assert.equal(texture.disposals,1,'last consumer releases the shared texture exactly once');
  assert.equal(pool.stats().coverTextures,0);

  const replacement=pool.cover.acquire('shared'); await flush(); images.at(-1).complete();
  pool.cover.release(second);
  assert.ok(replacement.texture); assert.equal(replacement.texture.disposals,0,'stale release cannot touch a new entry with the same key');
  pool.cover.release(replacement);
  const a=pool.text.acquire('one line'), b=pool.text.acquire('one line');
  pool.beginFrame(1); assert.equal(a.texture,b.texture);
  const textTexture=b.texture;
  pool.cover.release(a); assert.equal(a.texture,textTexture,'wrong resource kind cannot release a text lease');
  pool.text.release(a);pool.text.release(a);assert.equal(textTexture.disposals,0);
  pool.text.release(b);assert.equal(textTexture.disposals,1);
  const textReplacement=pool.text.acquire('one line');pool.beginFrame(2);pool.text.release(b);
  assert.ok(textReplacement.texture);assert.equal(textReplacement.texture.disposals,0);
  pool.dispose();pool.dispose();assert.equal(textReplacement.texture,null);
  assert.equal(pool.cover.acquire('late'),null);assert.equal(pool.text.acquire('late'),null);

  const completions=[], signals=[];
  const pending=createSpatialResources(THREE,()=>invalidations++,(_url,signal)=>{
    signals.push(signal);return new Promise(resolve=>completions.push(resolve));
  });
  const oldOwner=new AbortController(), old=pending.cover.acquire('same',oldOwner.signal);
  await flush();oldOwner.abort();
  assert.equal(signals[0].aborted,true,'underlying resolver receives only the last-consumer cancellation');
  assert.equal(pending.stats().coverLoads,1,'cancellation cannot pretend an unresolved task has exited');
  const current=pending.cover.acquire('same');await flush();
  completions[0]('late-old-url');await flush();
  assert.ok(images.every(image=>!image.assignments.includes('late-old-url')),'late resolution cannot resurrect cancelled work');
  assert.equal(pending.stats().coverLoads,1);
  completions[1]('current-url');await flush();
  const currentImage=images.at(-1), lateLoad=currentImage.onload;
  currentImage.complete();assert.ok(current.texture);
  pending.cover.release(old);assert.equal(current.texture.disposals,0);
  pending.cover.release(current);const beforeLate=textures.length;lateLoad();
  assert.equal(textures.length,beforeLate,'queued old image callback cannot allocate after release');
  assert.equal(pending.stats().coverLoads,0);
  for(let i=0;i<12;i++) {
    const lease=pending.cover.acquire('blocked-'+i);assert.ok(lease);await flush();pending.cover.release(lease);
  }
  assert.equal(pending.stats().coverLoads,12);
  assert.equal(pending.cover.acquire('overflow'),null,'retiring unresolved tasks retain bounded admission');
  assert.equal(pending.stats().bytes,12*768*768*4*4/3,'pending work remains accounted until actual resolver settlement');
  completions[2](null);await flush();assert.equal(pending.stats().coverLoads,11);
  const admitted=pending.cover.acquire('after-settlement');assert.ok(admitted);await flush();
  pending.dispose();pending.dispose();assert.equal(admitted.texture,null);
  for(const complete of completions)complete(null);await flush();
  assert.equal(pending.stats().coverLoads,0);assert.equal(pending.stats().bytes,0);
  assert.ok(textures.every(item=>item.disposals===1),'every allocated shared texture is released once');

  // ---- 原生 shared-assets 信封：装载前逐资源记账，退出时按条目归还 ----
  const liveTokens=new Set(); let nextToken=0, unplanned=[];
  const enforced=createSpatialResources(THREE,()=>invalidations++,url=>url,{
    admit(kind) {
      if (kind!=='text') { unplanned.push(kind); return null; }
      if (liveTokens.size>=2) return null;
      const token=++nextToken; liveTokens.add(token); return token;
    },
    release(token) { if(!liveTokens.delete(token)) throw new Error('unknown envelope token'); }
  });
  const textA=enforced.text.acquire('信封-一行'); assert.ok(textA,'envelope budget is reserved before any layout work');
  const textB=enforced.text.acquire('信封-第二行'); assert.ok(textB);
  assert.equal(enforced.text.acquire('信封-第三行'),null,'bounded envelope denies admission beyond its plan');
  enforced.beginFrame(3);
  assert.ok(textA.texture&&textA.texture.poolOwned,'pool marks its own textures as pool-owned');
  assert.equal(unplanned.length,0);
  const denied=enforced.cover.acquire('cover-url'); assert.equal(denied,null,'unplanned asset kind cannot bypass the native envelope');
  assert.equal(unplanned.length,1,'unplanned kind is surfaced to the trusted caller');
  enforced.text.release(textA); assert.equal(liveTokens.size,1,'entry eviction releases its envelope token exactly once');
  const textC=enforced.text.acquire('信封-第三行'); assert.ok(textC,'released envelope capacity admits new entries');
  enforced.dispose();
  assert.equal(liveTokens.size,0,'pool disposal releases every remaining envelope token');

  const full=createSpatialResources(THREE,()=>invalidations++,url=>url,{admit:()=>null,release(){throw new Error('never');}});
  assert.equal(full.text.acquire('超限'),null,'an exhausted envelope denies admission before creating an entry');
  assert.equal(full.stats().textTextures,0);

  // ---- scope.lease：池资源只释放租约，私有对象继续 track/dispose ----
  const {createScope} = await import(pathToFileURL(path.resolve(__dirname,'../tools/space-stage/src/scope.js')));
  const scope=createScope();
  let leaseReleases=0, privateDisposals=0;
  const textureLike={poolOwned:true,isTexture:true,dispose(){throw new Error('pool textures must not be disposed via scope track');}};
  const material={uniforms:{},map:textureLike,dispose(){privateDisposals++;}};
  const scene={traverse(fn){fn({material});}};
  scope.lease({release(){leaseReleases++;}});
  scope.track({dispose(){privateDisposals++;}});
  scope.trackTree(scene);
  assert.equal(privateDisposals,0);
  assert.equal(leaseReleases,0);
  scope.dispose();
  assert.equal(privateDisposals,2,'only private resources are disposed');
  assert.equal(leaseReleases,1,'pool lease is released exactly once at scope exit');
  assert.equal(scope.stats().leases,0);
  const disposedScope=createScope();
  disposedScope.dispose();
  let lateReleases=0;
  disposedScope.lease({release(){lateReleases++;}});
  assert.equal(lateReleases,1,'leasing a disposed scope releases immediately');
  assert.throws(()=>createScope().lease({}),'lease requires a releasable object');

  const {createResourcePool} = await import(pathToFileURL(path.resolve(__dirname,'../tools/space-stage/src/resources/pool.js')));
  const sharedPool=createResourcePool({contextId:'scope-ownership'}), scopeA=createScope(), scopeB=createScope();
  let sharedDisposals=0, materialDisposals=0;
  const sharedTexture=sharedPool.markOwned({isTexture:true,dispose(){sharedDisposals++;}});
  const identity={contentKey:'scope-shared-texture',decodeOptions:{},adapterId:'scope-test',adapterVersion:1};
  const spec={load:()=>sharedTexture,releaseValue(value){value.dispose();}};
  const leaseA=scopeA.lease(sharedPool.acquire(identity,{...spec,signal:scopeA.signal}));
  const leaseB=scopeB.lease(sharedPool.acquire(identity,{...spec,signal:scopeB.signal}));
  await Promise.all([leaseA.ready,leaseB.ready]);
  function sharedTree() {
    const material={map:sharedTexture,uniforms:{map:{value:sharedTexture}},dispose(){materialDisposals++;}};
    return {traverse(fn){fn({material});}};
  }
  assert.equal(scopeA.track(sharedTexture),sharedTexture,'direct tracking preserves borrowed pool resource identity');
  scopeA.trackTree(sharedTree());
  assert.equal(scopeA.stats().resources,1,'only the private material enters the scope resource set');
  scopeA.dispose();scopeA.dispose();leaseA.release();
  assert.equal(materialDisposals,1,'first scope releases its private material');
  assert.equal(sharedDisposals,0,'first direct/tree consumer exit cannot dispose the surviving shared texture');
  assert.equal(leaseB.value,sharedTexture,'second consumer can still use the shared texture');
  assert.deepEqual(sharedPool.stats(),{poolEntries:1,poolPending:0,poolLeases:1});
  disposedScope.track(sharedTexture);
  assert.equal(sharedDisposals,0,'tracking through an already disposed scope cannot dispose another consumer\'s pool texture');
  assert.throws(()=>disposedScope.track({poolOwned:true}),'pool ownership does not bypass disposable validation');
  scopeB.track(sharedTexture);scopeB.trackTree(sharedTree());scopeB.dispose();
  assert.equal(materialDisposals,2,'last scope still releases its private material');
  assert.equal(sharedDisposals,1,'the actual pool disposes its texture exactly once after the last lease exits');
  scopeB.dispose();leaseB.release();sharedPool.dispose();sharedPool.dispose();
  assert.equal(sharedDisposals,1,'repeated scope/lease/pool teardown cannot double dispose the texture');
  assert.deepEqual(sharedPool.stats(),{poolEntries:0,poolPending:0,poolLeases:0});
  console.log('shared resource leases passed: merged load, independent abort, idempotent/stale release, bounded cancellation, late callbacks, native envelope accounting, direct/tree/disposed-scope shared ownership and scope leases');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
