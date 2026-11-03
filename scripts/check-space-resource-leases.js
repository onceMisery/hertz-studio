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
  console.log('shared resource leases passed: merged load, independent abort, idempotent/stale release, bounded cancellation, late callbacks and disposal');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
