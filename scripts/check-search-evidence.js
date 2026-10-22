// SPDX-License-Identifier: MIT
// Independently recompute the two-edition sustained search evidence statistics.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const ROOT = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(file);
function stats(values) {
  assert.ok(values.length > 0);
  for (const value of values) assert.ok(Number.isFinite(value) && value >= 0);
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) };
}
function checkStats(row, values = row.samplesMs) {
  assert.ok(Array.isArray(values));
  const actual = stats(values);
  for (const key of Object.keys(actual)) assert.equal(row[key], actual[key], key);
  if (row.samplesMs) assert.deepEqual(row.samplesMs, values);
  return actual;
}
function verify(file, { binary, current = false, screenshot } = {}) {
  const compressed = read(file);
  const raw = file.endsWith('.gz') ? zlib.gunzipSync(compressed) : compressed;
  const r = JSON.parse(raw);
  if (r.failure !== undefined) assert.deepEqual(r.failure,
    {name:'AssertionError',message:'Performance target missed; raw report retained'}, 'Incomplete benchmark');
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.syntheticCorpus, true);
  for (const key of ['releaseEligible', 'realProvidersVerified', 'nativeDbxVerified', 'weakHardwareVerified'])
    assert.equal(r[key], false, key);
  assert.equal(r.health.status, 'ok');
  assert.ok(['standard', 'full'].includes(r.health.edition));
  assert.equal(r.health.backend, 'null');
  assert.equal(r.candidate.buildProfile, 'release');
  assert.equal(r.corpus.tracks, 50000);
  assert.equal(r.corpus.edits, 500);
  assert.equal(r.corpus.contentHash, '835286f6fed0b719c940132d237047937c6caa99d8364b3d7673866f777999fb');
  const cases = r.corpus.cases.map(c => c.id);
  assert.equal(cases.length, 14); assert.equal(new Set(cases).size, 14);
  for (const [key, value] of Object.entries({localWarmupRounds:2,localMeasuredRounds:30,
    concurrentClients:4,concurrentRoundsPerClient:3,browserWarmupRounds:2,browserMeasuredRounds:30,
    fastSourceDelayMs:200,slowSourceDelayMs:1200,thresholdLocalP95Ms:300,thresholdFirstSourceP95Ms:1000,
    sustainedClients:4,sustainedPausePerClientMs:25})) assert.equal(r.methodology[key], value, key);
  assert.deepEqual(r.localFirstObserved.map(s => s.case), cases);
  stats(r.localFirstObserved.map(s => s.elapsedMs));
  assert.deepEqual(r.local.map(row => row.id), cases);
  for (const row of r.local) { assert.equal(row.count, 30); checkStats(row); }
  const concurrent = r.localConcurrent;
  assert.equal(concurrent.observations.length, 168);
  checkStats(concurrent, concurrent.observations.map(s => s.elapsedMs));
  for (let client = 0; client < 4; client++) {
    const rows = concurrent.observations.filter(s => s.client === client);
    assert.equal(rows.length, 42);
    assert.deepEqual(rows.map(s => s.case), Array.from({length:42}, (_, i) =>
      cases[(i % 14 + client + Math.floor(i / 14)) % 14]));
  }
  const sustained = r.localSustained;
  assert.ok(Number.isInteger(sustained.requestedSeconds) && sustained.requestedSeconds >= 300 && sustained.requestedSeconds <= 600);
  assert.equal(sustained.requestedSeconds, r.methodology.sustainedLocalSeconds);
  assert.equal(sustained.clients, 4); assert.equal(sustained.pausePerClientMs, 25);
  assert.ok(Number.isFinite(sustained.actualSeconds) && sustained.actualSeconds >= sustained.requestedSeconds);
  assert.ok(sustained.count <= 100000);
  checkStats(sustained, sustained.observations.map(s => s.elapsedMs));
  for (let client = 0; client < 4; client++) {
    const rows = sustained.observations.filter(s => s.client === client);
    assert.ok(rows.length >= 14);
    rows.forEach((s, i) => { assert.equal(s.ordinal, i); assert.equal(s.case, cases[(i + client) % 14]); });
  }
  assert.equal(sustained.observations.filter(s => Number.isInteger(s.client) && s.client >= 0 && s.client < 4).length, sustained.count);
  const perCase = Object.fromEntries(cases.map(id => [id, stats(sustained.observations.filter(s => s.case === id).map(s => s.elapsedMs))]));
  assert.equal(r.firstSource.count, 30); checkStats(r.firstSource);
  assert.equal(r.firstSource.maxActiveSourceReads, 2); assert.equal(r.firstSource.sourceCalls, 96);
  assert.equal(r.localDuringControlledSources.count, 30); checkStats(r.localDuringControlledSources);
  assert.deepEqual(r.checks, {allResultsMatchLikeOracle:true,partialBeforeSlowResult:true,
    sourceFailuresIsolated:true,noModelOrPlayerWrites:true,noExternalBrowserReads:true,queueUnchanged:true});
  assert.deepEqual(r.gates, {local:r.local.every(row => row.p95Ms <= 300),firstSource:r.firstSource.p95Ms <= 1000});
  const targetPassed = r.gates.local && r.gates.firstSource;
  assert.equal(r.failure === undefined, targetPassed, 'Failure and target status disagree');
  const m = r.processMemory;
  assert.equal(m.observed, true); assert.equal(m.failure, undefined);
  assert.equal(m.intervalMs, 500); assert.equal(m.sustainedSeconds, sustained.requestedSeconds);
  assert.ok(m.samples.length > 0 && m.samples.length <= 4000);
  const phases = {};
  let maxGap = 0;
  m.samples.forEach((s, i) => {
    assert.equal(s.pid, m.processId);
    for (const key of ['elapsedMs','workingSetBytes','privateBytes','virtualBytes','handles','threads'])
      assert.ok(Number.isFinite(s[key]) && s[key] >= 0, key);
    assert.ok(s.workingSetBytes > 0 && s.privateBytes > 0);
    if (i) { const gap = s.elapsedMs - m.samples[i - 1].elapsedMs; assert.ok(gap > 0); maxGap = Math.max(maxGap, gap); }
    (phases[s.phase] ||= []).push(s);
  });
  const computed = Object.fromEntries(Object.entries(phases).map(([name, rows]) => [name,
    {count:rows.length,spanMs:rows.at(-1).elapsedMs-rows[0].elapsedMs,
      ...Object.fromEntries(['workingSetBytes','privateBytes','handles','threads'].flatMap(key => {
        const sorted = rows.map(s => s[key]).sort((a,b) => a-b);
        return [[key+'Median',sorted[Math.floor(sorted.length/2)]],[key+'Max',sorted.at(-1)]];
      }))}]));
  assert.deepEqual(m.phases, computed); assert.equal(m.maxSampleGapMs, maxGap);
  for (const name of ['startup','baseline-idle','local-sequential','local-concurrent','sustained-local','after-load-idle','browser-controlled-sources'])
    assert.ok(computed[name]?.count > 0, name);
  for (const name of ['baseline-idle','after-load-idle']) assert.ok(computed[name].count >= 5);
  assert.ok(computed['sustained-local'].count >= sustained.requestedSeconds);
  assert.deepEqual(m.idleDeltaBytes, Object.fromEntries(['workingSetBytes','privateBytes'].map(key =>
    [key, computed['after-load-idle'][key+'Median'] - computed['baseline-idle'][key+'Median']])));
  assert.ok(Date.parse(r.completedAt) > Date.parse(r.startedAt));
  assert.match(r.candidate.binaryHash, /^[a-f0-9]{64}$/);
  for (const [name, digest] of Object.entries(r.hashes)) {
    assert.match(digest, /^[a-f0-9]{64}$/);
    if (current) {
      const resolved = path.resolve(ROOT, name);
      assert.ok(resolved.startsWith(ROOT + path.sep));
      assert.equal(hash(read(resolved)), digest, name + ' changed since measurement');
    }
  }
  if (binary) assert.equal(hash(read(binary)), r.candidate.binaryHash, 'Binary identity');
  const shot = screenshot || file.replace(/\.json(?:\.gz)?$/, '-partial.png');
  assert.equal(hash(read(shot)), r.partialScreenshotHash, 'Screenshot identity');
  return {edition:r.health.edition,rawHash:hash(raw),storedHash:hash(compressed),
    binaryHash:r.candidate.binaryHash,candidate:r.candidate,sourceHashes:r.hashes,screenshotHash:r.partialScreenshotHash,
    environment:r.environment,startedAt:r.startedAt,completedAt:r.completedAt,
    localWorstP95Ms:Math.max(...r.local.map(row => row.p95Ms)),concurrent:stats(concurrent.samplesMs),
    firstSource:stats(r.firstSource.samplesMs),sustained:{...stats(sustained.samplesMs),actualSeconds:sustained.actualSeconds,perCase},
    processMemory:{sampleCount:m.samples.length,maxSampleGapMs:maxGap,phases:computed,idleDeltaBytes:m.idleDeltaBytes},
    gates:r.gates,targetPassed,releaseEligible:false};
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), current = args.includes('--current');
    const positional = args.filter(a => a !== '--current');
    assert.ok(positional.length >= 1 && positional.length <= 2,
      'Usage: node scripts/check-search-evidence.js report.json[.gz] [candidate.exe] [--current]');
    const result = verify(positional[0], {binary:positional[1],current});
    console.log(JSON.stringify(result, null, 2));
    if (!result.targetPassed) process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { verify };
