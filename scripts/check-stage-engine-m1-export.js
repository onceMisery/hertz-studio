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
  await check('128MiB candidate refuses the original256MiB envelope before capture or permission', async () => {
    const h = harness({ownedCpuBytes:128 * 1024 * 1024});
    await assert.rejects(h.api.begin({systemAudio:true}), /aggregate-budget/);
    assert.equal(h.env.displayCalls,0); assert.equal(h.tracks.length,0); assert.equal(h.ledger.snapshot().resources,0);
    assert.equal(h.api.status().phase,'idle'); return h.ledger.snapshot();
  });
  await check('decoder and composition refusal clean only the admitted startup owner', async () => {
    const samples = [];
    for (const caps of [{decoderLeases:0},{canvases:0},{decodeReservedBytes:0}]) {
      const h = harness(caps); const rejected = h.api.begin({systemAudio:true}).catch(error=>error);
      await h.advance(1201); assert.match((await rejected).message,/aggregate-budget/);
      assert.ok(h.tracks.every(track=>track.readyState==='ended')); assert.equal(h.recorders.length,0);
      assert.equal(h.ledger.snapshot().resources,0); samples.push({caps,after:h.ledger.snapshot()});
    } return samples;
  });
  await check('twenty complete exports retain only the final encoded source and release it on page exit', async () => {
    const h = harness(), samples = [];
    for (let i=0;i<20;i++) {
      const {done} = await h.start(); h.recorders.at(-1).chunk('recorded'); const live = h.ledger.snapshot();
      assert.equal(live.held.canvases,1); assert.equal(live.held.decoderLeases,2);
      assert.ok(live.held.ownedCpuBytes>=256 * 1024 * 1024);
      h.api.stop(); const result = await h.ended(done), after = h.ledger.snapshot(true);
      assert.equal(after.resources,1); assert.equal(after.held.ownedCpuBytes,result.bytes);
      assert.equal(after.held.decoderLeases,0); assert.equal(after.held.canvases,0);
      assert.equal(h.api.status().retiring,0); samples.push({bytes:result.bytes,after});
      assert.equal(h.env.sourceUses,0);
    }
    h.window.emit('pagehide'); assert.equal(h.ledger.snapshot().resources,0); return {samples,closed:h.ledger.snapshot()};
  });
  await check('one hundred canceled permission promises retain their quotas until late streams settle', async () => {
    const h = harness({ownedCpuBytes:101 * 256 * 1024 * 1024}), late = [];
    for (let i=0;i<100;i++) {
      let resolve; h.env.media = new Promise(done=>{resolve=done;});
      const done = h.api.begin({systemAudio:true}); await h.api.stop(); await done; late.push(resolve);
    }
    const retired = h.ledger.snapshot(true);
    assert.equal(retired.resources,100); assert.equal(h.api.status().retiring,100);
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
    assert.ok(retired.held.ownedCpuBytes>=256 * 1024 * 1024);
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
