'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../../..');
const { startFixture } = require(path.join(ROOT, 'scripts/ui-browser-fixture'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function main() {
  const pinned = process.env.SEARCH_CROSSCHECK_PIN === '1';
  const out = path.resolve(process.env.SEARCH_CROSSCHECK_OUT || path.join(ROOT, 'output/benchmarks', pinned ? 'crosscheck-pinned.json' : 'crosscheck.json'));
  assert.ok(!fs.existsSync(out), 'Choose a new diagnostic output');
  const fixtures = [], report = {startedAt:new Date().toISOString(),diagnosticOnly:true,pinnedCoreZero:pinned,releaseEligible:false,editions:[],observations:[]};
  try {
    for (const edition of ['standard','full']) {
      process.env.HERTZ_BIN = path.resolve(process.env[edition === 'standard' ? 'SEARCH_STANDARD_BIN' : 'SEARCH_FULL_BIN'] || path.join(ROOT, 'target/search-validation', edition, 'hertz-studio.exe'));
      const fixture = await startFixture(); fixtures.push(fixture);
      if (pinned) execFileSync(process.env.POWERSHELL || 'pwsh', ['-NoProfile','-NonInteractive','-Command',
        '(Get-Process -Id '+fixture.processId+').ProcessorAffinity = [IntPtr]1'], {windowsHide:true});
      const health = await fixture.api('/v1/health'); assert.equal(health.edition, edition);
      process.env.VMUSIC_DATA_DIR = fixture.dataDir;
      const corpus = JSON.parse(execFileSync(process.env.PYTHON || 'python',
        [path.join(ROOT,'evals/search/v1/corpus.py'),path.join(fixture.dataDir,'vmusic.db')],{encoding:'utf8',timeout:120000}));
      if (report.corpus) assert.deepEqual(corpus, report.corpus); else report.corpus = corpus;
      report.editions.push({edition,health,binaryHash:sha(process.env.HERTZ_BIN)});
    }
    for (let round = -2; round < 5; round++) {
      for (let i = 0; i < report.corpus.cases.length; i++) {
        const c = report.corpus.cases[(i + round + 14) % 14];
        for (const index of (round % 2 === 0 ? [0,1] : [1,0])) {
          const params = new URLSearchParams({q:c.q,limit:'20',sort:c.sort || 'title'});
          for (const key of ['artist','album']) if(c[key]) params.set(key,c[key]);
          const start = performance.now();
          const data = await fixtures[index].api('/v1/tracks?' + params);
          const elapsedMs = performance.now() - start;
          assert.equal(data.total,c.expectedTotal);
          assert.deepEqual(data.tracks.map(t=>t.id),c.expectedIds);
          report.observations.push({edition:report.editions[index].edition,case:c.id,round,elapsedMs});
        }
      }
      console.log('Alternating diagnostic round ' + round + ' complete');
    }
    report.completedAt = new Date().toISOString();
    fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    for(const edition of ['standard','full']) {
      const means = report.corpus.cases.map(c=>({id:c.id,meanMs:report.observations.filter(o=>o.edition===edition && o.case===c.id && o.round>=0).reduce((s,o)=>s+o.elapsedMs,0)/5}));
      console.log(JSON.stringify({edition,means}));
    }
  } finally {for(const fixture of fixtures)await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
