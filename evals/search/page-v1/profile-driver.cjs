// SPDX-License-Identifier: MIT
// Reproduction driver; the historical report retains its original fields.
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../../..');
const {startFixture}=require(path.join(ROOT,'scripts/ui-browser-fixture'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function main(){
 assert.ok(process.env.HERTZ_BIN,'Set HERTZ_BIN to an explicit isolated service candidate');
 const out=path.resolve(process.env.CANDIDATE_PROFILE_OUT || path.join(ROOT,'output/benchmarks/candidate-transport.json'));assert.ok(!fs.existsSync(out));
 const startedAt=new Date().toISOString();const serviceBinaryHash=hash(path.resolve(process.env.HERTZ_BIN));
 const fixture=await startFixture();
 try{
  process.env.VMUSIC_DATA_DIR=fixture.dataDir;
  const corpus=JSON.parse(execFileSync('python',[path.join(ROOT,'evals/search/v1/corpus.py'),path.join(fixture.dataDir,'vmusic.db')],{encoding:'utf8',timeout:120000}));
  const binary=path.resolve(process.env.CANDIDATE_PROFILE_BIN || path.join(ROOT,'target/release/examples/profile-search-candidates.exe'));
  const data=JSON.parse(execFileSync(binary,[fixture.dataDir],{encoding:'utf8',timeout:120000}));
  const production=fs.readFileSync(path.join(ROOT,'crates/vmusic-store/src/lib.rs'),'utf8').split('const SEARCH_CANDIDATE_SQL: &str = "')[1].split('";')[0];
  assert.equal(data.candidateSql.replace(/\s+/g,' '),production.replace(/\s+/g,' '));
  const http=[];
  if(data.storeObservations)for(const query of ['Track','静谧星河','晴天','%','']){
   const start=performance.now();const reply=await fixture.api('/v1/tracks?'+new URLSearchParams({q:query,limit:'20',sort:'title'}));
   http.push({query,elapsedMs:performance.now()-start});
   for(const row of data.storeObservations.filter(o=>o.query===query)){assert.equal(row.total,reply.total);assert.deepEqual(row.ids,reply.tracks.map(t=>t.id));}
   const samples=data.storeObservations.filter(o=>o.query===query&&o.round>=0);
   console.log(JSON.stringify({query,storeListMeanMs:samples.reduce((s,o)=>s+o.listMs,0)/samples.length,
    storeCountMeanMs:samples.reduce((s,o)=>s+o.countMs,0)/samples.length,httpMs:http.at(-1).elapsedMs}));
  }
  const hashes=Object.fromEntries(['Cargo.lock','crates/vmusic-store/src/lib.rs','crates/vmusic-store/examples/profile-search-candidates.rs'].map(file=>[file,hash(path.join(ROOT,file))]));
  assert.equal(hash(path.resolve(process.env.HERTZ_BIN)),serviceBinaryHash);
  const report={...data,http,startedAt,completedAt:new Date().toISOString(),serviceBinaryHash,corpusHash:corpus.contentHash,binaryHash:hash(binary),hashes,health:await fixture.api('/v1/health')};
  fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  for(const pattern of [...new Set(data.observations.map(o=>o.pattern))]){
   const means=Object.fromEntries(['rows','json'].map(mode=>{const rows=data.observations.filter(o=>o.pattern===pattern&&o.mode===mode&&o.round>=0);return [mode,rows.reduce((s,o)=>s+o.elapsedMs,0)/rows.length];}));
   console.log(JSON.stringify({pattern,meanMs:means}));
  }
 }finally{await fixture.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
