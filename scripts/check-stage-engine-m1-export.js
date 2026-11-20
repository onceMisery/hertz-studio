'use strict';
// Original VideoExport owner with the real document ledger. Synthetic timers
// prove allocation authority and cleanup contracts, never encoder performance.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { harness } = require('./check-video-export');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output/a09-m1-20261108/export-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive:true });
const report = { startedAt:new Date().toISOString(), scope:'Original export/ledger controlled contracts; source protection and native encoder workspace qualification remain open.',
  sourceSha256:Object.fromEntries(['plugin/ui/video-export.js','plugin/ui/stage-resource-budget.js'].map(file => [file,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')])), checks:[] };
async function check(name, run) {
  try { report.checks.push({name,passed:true,evidence:await run()}); console.log('PASS ' + name); }
  catch (error) { report.checks.push({name,passed:false,error:error.stack}); console.error('FAIL ' + name + ': ' + error.message); }
}
async function main() {
  const MiB = 1024 * 1024;
  await check('128MiB candidate starts a bounded recording and preserves final Blob space', async () => {
    const h = harness({ownedCpuBytes:128 * 1024 * 1024});
    const {done} = await h.start({systemAudio:true});
    assert.equal(h.api.status().maxBytes,32 * MiB); assert.equal(h.env.displayCalls,1);
    const live = h.ledger.snapshot(true);
    assert.equal(live.entries.filter(entry=>entry.basis.source.includes('envelope')).length,2);
    assert.ok(live.held.ownedCpuBytes <= 128 * MiB);
    h.recorders[0].chunk('recorded'); h.api.stop(); const result = await h.ended(done);
    assert.equal(result.failed,false); assert.equal(result.bytes,13); assert.equal(result.maxBytes,32 * MiB);
    h.window.emit('pagehide'); assert.equal(h.ledger.snapshot().resources,0);
    return {live,result:{bytes:result.bytes,maxBytes:result.maxBytes},closed:h.ledger.snapshot()};
  });
  await check('insufficient minimum refuses before capture or permission and preserves the prior result', async () => {
    const h = harness({ownedCpuBytes:128 * MiB}), {done} = await h.start();
    h.recorders[0].chunk('saved'); h.api.stop(); const prior = await h.ended(done);
    const occupied = h.ledger.port('other-owner').require({ownedCpuBytes:128 * MiB - prior.bytes - 19 * MiB},'test occupied resource',0);
    occupied.commit(); const baseline = h.ledger.snapshot(), trackCount = h.tracks.length;
    await assert.rejects(h.api.begin({preset:{id:'720p'},systemAudio:true}), /容量不足 8 MiB/);
    assert.equal(h.env.displayCalls,0); assert.equal(h.tracks.length,trackCount);
    assert.equal(prior.blob.size,prior.bytes); assert.equal(h.api.status().bytes,prior.bytes);
    assert.deepEqual(h.ledger.snapshot().held,baseline.held);
    occupied.release({apiReleased:true,allocationEnded:true}); h.window.emit('pagehide');
    assert.equal(h.ledger.snapshot().resources,0); return {baseline,closed:h.ledger.snapshot()};
  });
  await check('existing owners reduce a frozen limit and a full page still saves at that limit', async () => {
    const h = harness({ownedCpuBytes:128 * MiB});
    const occupied = h.ledger.port('other-owner').require({ownedCpuBytes:100 * MiB},'test occupied resource',0); occupied.commit();
    const {done} = await h.start(), maxBytes = h.api.status().maxBytes;
    assert.equal(maxBytes,12 * MiB);
    occupied.release({apiReleased:true,allocationEnded:true});
    assert.equal(h.api.status().maxBytes,maxBytes,'Capacity cannot grow after admission');
    const later = h.ledger.port('later-owner').require({ownedCpuBytes:128 * MiB - h.ledger.snapshot().held.ownedCpuBytes},'test later resource',0);
    later.commit(); const live = h.ledger.snapshot(true);
    h.recorders[0].chunk(new Uint8Array(maxBytes));
    assert.equal(h.api.status().phase,'stopping'); const result = await h.ended(done);
    assert.equal(result.failed,false); assert.equal(result.bytes,maxBytes); assert.equal(result.blob.size,maxBytes);
    assert.match(result.message,/本次.*12 MiB/); assert.ok(h.ledger.snapshot().peak.ownedCpuBytes <= 128 * MiB);
    assert.deepEqual(h.ledger.snapshot().violations,[]);
    later.release({apiReleased:true,allocationEnded:true}); h.window.emit('pagehide');
    assert.equal(h.ledger.snapshot().resources,0); return {live,bytes:result.bytes,maxBytes,closed:h.ledger.snapshot()};
  });
  await check('an oversized chunk preserves the preceding partial file within the actual cap', async () => {
    const h = harness({ownedCpuBytes:128 * MiB}), {done} = await h.start();
    h.recorders[0].chunk('part');
    h.recorders[0].ondataavailable({data:{size:h.api.status().maxBytes + 1}});
    const result = await h.ended(done);
    assert.equal(result.bytes,9); assert.match(result.message,/缓冲已满.*32 MiB/);
    h.window.emit('pagehide'); assert.equal(h.ledger.snapshot().resources,0); return {bytes:result.bytes,message:result.message};
  });
  await check('decoder and composition refusal clean only the admitted startup owner', async () => {
    const samples = [];
    for (const caps of [{decoderLeases:0},{canvases:0},{decodeReservedBytes:0}]) {
      const h = harness(caps); const rejected = h.api.begin({systemAudio:true}).catch(error=>error);
      await h.advance(1201); assert.equal((await rejected).resourceFailure.reason,'aggregate-budget');
      assert.ok(h.tracks.every(track=>track.readyState==='ended')); assert.equal(h.recorders.length,0);
      assert.equal(h.ledger.snapshot().resources,0); samples.push({caps,after:h.ledger.snapshot()});
    } return samples;
  });
  await check('twenty complete exports retain only the final encoded source and release it on page exit', async () => {
    const h = harness(), samples = [];
    for (let i=0;i<20;i++) {
      const {done} = await h.start(); h.recorders.at(-1).chunk('recorded'); const live = h.ledger.snapshot();
      assert.equal(live.held.canvases,1); assert.equal(live.held.decoderLeases,2);
      assert.ok(live.held.ownedCpuBytes>=2 * h.api.status().maxBytes);
      h.api.stop(); const result = await h.ended(done), after = h.ledger.snapshot(true);
      assert.equal(after.resources,1); assert.equal(after.held.ownedCpuBytes,result.bytes);
      assert.equal(after.held.decoderLeases,0); assert.equal(after.held.canvases,0);
      assert.equal(h.api.status().retiring,0); samples.push({bytes:result.bytes,after});
      assert.equal(h.env.sourceUses,0);
    }
    h.window.emit('pagehide'); assert.equal(h.ledger.snapshot().resources,0); return {samples,closed:h.ledger.snapshot()};
  });
  await check('one hundred canceled permission promises retain their quotas until late streams settle', async () => {
    const h = harness({ownedCpuBytes:101 * 80 * MiB,canvases:101,drawingBufferPixels:101 * 1920 * 1080}), late = [];
    for (let i=0;i<100;i++) {
      let resolve; h.env.media = new Promise(done=>{resolve=done;});
      const done = h.api.begin({systemAudio:true}); await h.api.stop(); await done; late.push(resolve);
    }
    const retired = h.ledger.snapshot(true);
    assert.equal(retired.resources,300); assert.equal(h.api.status().retiring,100);
    assert.ok(retired.entries.every(entry=>entry.cancelled && !entry.allocationEnded));
    const streams = late.map(resolve=>{const stream=new h.Stream([new h.Track('video'),new h.Track('audio')]);resolve(stream);return stream;});
    await h.flush(); assert.ok(streams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended')));
    assert.equal(h.ledger.snapshot().resources,0); assert.equal(h.api.status().retiring,0);
    return {retired,closed:h.ledger.snapshot()};
  });
  await check('late encoder stop releases only its retired generation after a finalization timeout', async () => {
    const h = harness(); let {done} = await h.start(); const old = h.recorders[0];
    old.chunk('part'); h.env.fail='stop-event'; h.api.stop(); await h.advance(5000); await h.ended(done);
    const retired = h.ledger.snapshot(true); assert.equal(h.api.status().retiring,1);
    assert.ok(retired.held.ownedCpuBytes>=32 * MiB);
    assert.equal(h.env.sourceUses,1);
    h.env.fail=''; ({done}=await h.start()); const current = h.ledger.snapshot();
    old.ondataavailable({data:new Blob(['late'])}); old.onstop(); await h.flush();
    assert.equal(h.api.status().phase,'recording'); assert.equal(h.api.status().retiring,0);
    assert.equal(h.env.sourceUses,1);
    assert.ok(h.ledger.snapshot().held.ownedCpuBytes<current.held.ownedCpuBytes);
    h.recorders.at(-1).chunk('new'); h.api.stop(); await h.ended(done); h.window.emit('pagehide');
    assert.equal(h.ledger.snapshot().resources,0); return {retired,current,closed:h.ledger.snapshot()};
  });
  await check('explicit output consumer leases survive result replacement until their final release', async () => {
    const h = harness(); let {done} = await h.start(); h.recorders[0].chunk('prior'); h.api.stop();
    const result = await h.ended(done), lease = result.retain(), retained = h.ledger.snapshot();
    ({done}=await h.start()); assert.equal(lease.blob.size,result.bytes);
    h.api.stop(); await h.ended(done); h.window.emit('pagehide');
    assert.equal(h.ledger.snapshot().resources,1); lease.release(); lease.release();
    assert.equal(lease.blob,null); assert.equal(h.ledger.snapshot().resources,0);
    return {retained,closed:h.ledger.snapshot()};
  });
  report.passed=report.checks.every(item=>item.passed);
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)); console.log(path.join(out,'report.json'));
  assert.ok(report.passed,'export resource checks');
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
