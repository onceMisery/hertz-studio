// SPDX-License-Identifier: MIT
// Recompute long mixed-pressure and test-process memory evidence independently.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const ROOT = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function bytes(file) { const b = fs.readFileSync(file); return file.endsWith('.gz') ? zlib.gunzipSync(b) : b; }
function distribution(values) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  sorted.forEach(v => assert.ok(Number.isFinite(v) && v >= 0));
  return { count: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) };
}
function verifyAlternatingActualStart(rowsByKind, counts) {
  for (const [httpKind, rpcKind] of [[0, 1], [2, 3]]) {
    assert.equal(counts[httpKind], counts[rpcKind], 'Paired entries must have equal schedules');
    const bySequence = kind => new Map(rowsByKind[kind].map(row => [row.sequence, row]));
    const httpRows = bySequence(httpKind), rpcRows = bySequence(rpcKind);
    assert.equal(httpRows.size, counts[httpKind]);
    assert.equal(rpcRows.size, counts[rpcKind]);
    for (let sequence = 0; sequence < counts[httpKind]; sequence++) {
      const http = httpRows.get(sequence), rpc = rpcRows.get(sequence);
      assert.ok(http && rpc, `Missing paired observation ${httpKind}/${rpcKind}:${sequence}`);
      const httpStart = http.scheduledMs + http.startLagMs;
      const rpcStart = rpc.scheduledMs + rpc.startLagMs;
      const firstStart = sequence % 2 === 0 ? httpStart : rpcStart;
      const secondStart = sequence % 2 === 0 ? rpcStart : httpStart;
      assert.ok(firstStart <= secondStart,
        `Actual dispatch order reversed for ${httpKind}/${rpcKind}:${sequence} ` +
        `(HTTP ${httpStart}ms, RPC ${rpcStart}ms)`);
    }
  }
}
function verifyBalanced(b, verifySources = false, verifyFailureCodes = false, verifySchedule = false) {
  assert.ok(b && typeof b === 'object');
  assert.equal(b.durationSeconds, 60);
  assert.equal(b.targetSourceCallsPerSecondPerEntry, 16);
  assert.ok(Array.isArray(b.readySources) && b.readySources.length > 0);
  assert.equal(new Set(b.readySources).size, b.readySources.length);
  assert.ok(b.readySources.every(s => typeof s === 'string' && s.length > 0));
  const sourceCount = b.readySources.length;
  const target = b.durationSeconds * b.targetSourceCallsPerSecondPerEntry;
  const offered = Math.floor(target / sourceCount) * sourceCount;
  assert.equal(b.sourceCallsOfferedPerEntry, offered);
  assert.ok(offered > 0);
  assert.equal(b.peakLocalExecution, 4);
  assert.equal(b.finalLocalExecution, 0);
  assert.equal(b.finalUpstreamActive, 0);
  assert.deepEqual(b.finalAvailable, [4, 16]);
  const names = ['http-single', 'rpc-single', 'http-aggregate', 'rpc-aggregate'];
  assert.deepEqual(b.entries.map(e => e.name), names);
  const counts = [offered, offered, offered / sourceCount, offered / sourceCount];
  if (verifySchedule) assert.equal(b.scheduleVersion, 2);
  assert.equal(b.observations.length, counts.reduce((sum, n) => sum + n, 0));
  const seen = new Set(), rowsByKind = Array.from({ length: 4 }, () => []);
  for (const row of b.observations) {
    assert.ok(Number.isInteger(row.kind) && row.kind >= 0 && row.kind < 4);
    assert.ok(Number.isInteger(row.sequence) && row.sequence >= 0 && row.sequence < counts[row.kind]);
    const id = row.kind + ':' + row.sequence;
    assert.ok(!seen.has(id), 'Duplicate balanced observation ' + id); seen.add(id);
    assert.ok(Number.isFinite(row.scheduledMs) && row.scheduledMs >= 0 && row.scheduledMs < 60000);
    if (verifySchedule) {
      const intervalNs = Math.floor(b.durationSeconds * 1e9 / counts[row.kind]);
      const phase = row.kind % 2 === row.sequence % 2 ? 0 : 1;
      const expectedNs = row.sequence * intervalNs + phase * Math.floor(intervalNs / 2);
      assert.ok(Math.abs(row.scheduledMs - expectedNs / 1e6) < 0.00001,
        `Unexpected scheduled time for ${row.kind}:${row.sequence}`);
    }
    assert.ok(Number.isFinite(row.startLagMs) && row.startLagMs >= 0);
    assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs >= row.startLagMs);
    assert.ok([[200, 'ok'], [429, 'search_busy'], [502, 'upstream_rejected'], [504, 'upstream_timeout']]
      .some(([status, code]) => row.status === status && row.code === code));
    const calls = row.kind < 2 ? 1 : sourceCount;
    assert.equal(row.sourceCalls, calls);
    assert.ok(Number.isInteger(row.sourceSuccesses) && row.sourceSuccesses >= 0 && row.sourceSuccesses <= calls);
    assert.ok(Number.isInteger(row.sourceFailures) && row.sourceFailures >= 0 && row.sourceFailures <= calls);
    assert.equal(row.sourceSuccesses + row.sourceFailures, calls);
    if (row.kind < 2 && row.status === 200) assert.deepEqual(
      [row.sourceSuccesses, row.sourceFailures], [1, 0]);
    if (row.kind < 2 && row.status !== 200) assert.deepEqual(
      [row.sourceSuccesses, row.sourceFailures], [0, 1]);
    if (row.kind >= 2 && row.status !== 200) assert.deepEqual(
      [row.sourceSuccesses, row.sourceFailures], [0, sourceCount]);
    if (verifySources) {
      const expectedSources = row.kind < 2
        ? [b.readySources[row.sequence % sourceCount]] : [...b.readySources];
      assert.deepEqual(row.sources, expectedSources);
      assert.ok(Array.isArray(row.successfulSources) && Array.isArray(row.failedSources));
      assert.equal(new Set(row.successfulSources).size, row.successfulSources.length);
      assert.equal(new Set(row.failedSources).size, row.failedSources.length);
      assert.equal(row.successfulSources.length, row.sourceSuccesses);
      assert.equal(row.failedSources.length, row.sourceFailures);
      assert.ok(row.successfulSources.every(source => expectedSources.includes(source)));
      assert.ok(row.failedSources.every(source => expectedSources.includes(source)));
      assert.ok(row.successfulSources.every(source => !row.failedSources.includes(source)));
      assert.deepEqual([...row.successfulSources, ...row.failedSources].sort(), [...expectedSources].sort());
    }
    if (verifyFailureCodes) {
      assert.ok(Array.isArray(row.sourceFailureDetails));
      assert.equal(row.sourceFailureDetails.length, row.sourceFailures);
      assert.deepEqual(row.sourceFailureDetails.map(failure => failure.source).sort(), [...row.failedSources].sort());
      assert.ok(row.sourceFailureDetails.every(failure =>
        ['search_busy', 'upstream_rejected', 'upstream_timeout'].includes(failure.code)));
    }
    rowsByKind[row.kind].push(row);
  }
  if (verifySchedule) verifyAlternatingActualStart(rowsByKind, counts);
  const entries = b.entries.map((entry, kind) => {
    const rows = rowsByKind[kind].sort((a, c) => a.sequence - c.sequence);
    assert.equal(rows.length, counts[kind]);
    rows.forEach((row, sequence) => assert.equal(row.sequence, sequence));
    const sourceCalls = rows.reduce((sum, row) => sum + row.sourceCalls, 0);
    const sourceSuccesses = rows.reduce((sum, row) => sum + row.sourceSuccesses, 0);
    const sourceFailures = rows.reduce((sum, row) => sum + row.sourceFailures, 0);
    assert.equal(sourceCalls, offered);
    assert.equal(sourceSuccesses + sourceFailures, sourceCalls);
    const outerOutcomes = rows.reduce((acc, row) => {
      const key = row.status + ':' + row.code; acc[key] = (acc[key] || 0) + 1; return acc;
    }, {});
    assert.equal(entry.kind, kind); assert.equal(entry.offeredOuterCalls, rows.length);
    assert.equal(entry.expectedSourceCalls, sourceCalls);
    assert.equal(entry.sourceSuccesses, sourceSuccesses); assert.equal(entry.sourceFailures, sourceFailures);
    assert.ok(Math.abs(entry.sourceSuccessRate - sourceSuccesses / sourceCalls) < 1e-12);
    assert.deepEqual(entry.outerOutcomes, outerOutcomes);
    let sourceOutcomes;
    let sourceFailureCodes;
    if (verifySources) {
      sourceOutcomes = b.readySources.map(source => {
        const sourceRows = rows.filter(row => row.sources.includes(source));
        const successes = sourceRows.filter(row => row.successfulSources.includes(source)).length;
        const failures = sourceRows.filter(row => row.failedSources.includes(source)).length;
        const outcome = { source, offered: sourceRows.length, successes, failures,
          successRate: successes / sourceRows.length };
        assert.equal(outcome.offered, offered / sourceCount);
        return outcome;
      });
      assert.deepEqual(entry.sourceOutcomes, sourceOutcomes);
    }
    if (verifyFailureCodes) {
      sourceFailureCodes = rows.flatMap(row => row.sourceFailureDetails)
        .reduce((acc, failure) => {
          acc[failure.code] = (acc[failure.code] || 0) + 1; return acc;
        }, {});
      assert.deepEqual(entry.sourceFailureCodes, sourceFailureCodes);
    }
    return { kind, name: entry.name, offeredOuterCalls: rows.length, sourceCalls,
      sourceSuccesses, sourceFailures, sourceSuccessRate: sourceSuccesses / sourceCalls,
      successfulSourceOpsPerSecond: sourceSuccesses / b.durationSeconds, outerOutcomes,
      sourceOutcomes, sourceFailureCodes,
      scheduledToResponse: distribution(rows.map(row => row.elapsedMs)),
      startLag: distribution(rows.map(row => row.startLagMs)) };
  });
  const rates = entries.map(entry => entry.sourceSuccessRate);
  return { durationSeconds: b.durationSeconds, readySourceCount: sourceCount,
    offeredSourceCallsPerEntry: offered, peakLocalExecution: b.peakLocalExecution,
    entries, sourceSuccessRateSpread: Math.max(...rates) - Math.min(...rates),
    releaseEligible: false };
}
function verify(file, { binary, current = false } = {}) {
  const raw = bytes(file), r = JSON.parse(raw), p = r.probe, v = p?.results, m = r.processMemory;
  assert.equal(r.schemaVersion, 1); assert.equal(r.failure, undefined);
  assert.equal(r.releaseEligible, false); assert.ok([2, 3, 4, 5, 6, 7].includes(p.schemaVersion));
  assert.equal(typeof p.longMode, 'boolean'); assert.ok(['standard', 'full'].includes(p.edition));
  assert.equal(p.os, 'windows'); assert.equal(p.profile, 'test');
  assert.equal(p.runtimeWorkers, 4);
  assert.deepEqual(p.productionGate, { permits: 4, waiters: 16, waitSeconds: 2, totalSeconds: 6 });
  for (const key of ['realProvidersVerified', 'nativeDbxVerified', 'weakHardwareVerified', 'wholeProcessRssVerified', 'releaseEligible'])
    assert.equal(p[key], false, key);
  assert.equal(p.testBinaryHash, r.binaryHash);
  if (binary) assert.equal(hash(fs.readFileSync(binary)), r.binaryHash, 'Test executable changed');
  for (const [name, digest] of Object.entries(p.sourceHashes)) {
    assert.match(digest, /^[a-f0-9]{64}$/);
    const resolved = path.resolve(ROOT, name);
    assert.ok(resolved.startsWith(ROOT + path.sep));
    if (current) assert.equal(hash(fs.readFileSync(resolved)), digest, name + ' changed since measurement');
  }
  assert.equal(Object.keys(p.sourceHashes).length, p.schemaVersion >= 5 ? 14 : 13);
  const long = p.longMode;
  assert.equal(v.idleSeconds, long ? 10 : 0); assert.equal(v.observationCapacity, 65536);
  assert.equal(v.cycles.length, long ? 3 : 1); assert.equal(v.requests, v.observations.length);
  assert.ok(v.requests > 0 && v.requests <= v.observationCapacity);
  assert.equal(v.requests, v.waves * 32);
  assert.ok(v.overflowRejectMs >= 0 && v.overflowRejectMs < 1000);
  assert.equal(v.admissionTimeoutMs.length, 2);
  v.admissionTimeoutMs.forEach(ms => assert.ok(ms >= 1800 && ms < 3000));
  assert.deepEqual(v.deadlineCases.map(c => c.mode), ['hold-header-deadline', 'body-stall-deadline']);
  for (const c of v.deadlineCases) {
    assert.equal(c.elapsedMs.length, 4);
    c.elapsedMs.forEach(ms => assert.ok(ms >= 5500 && ms < 7500));
  }
  assert.equal(v.peakLocalExecution, 4); assert.equal(v.finalLocalExecution, 0);
  assert.deepEqual(v.finalAvailable, [4, 16]);
  assert.equal(v.upstreamStarted, v.upstreamReplied + v.upstreamDisconnected);
  assert.ok(v.upstreamDisconnected >= 12 && v.upstreamReplied > 0);
  const names = ['boundary-matrix', ...(p.schemaVersion >= 3 ? ['balanced-throughput'] : []),
    'baseline-idle', 'load-0', 'idle-0', ...(long ? ['load-1', 'idle-1', 'load-2', 'idle-2'] : []), 'complete'];
  assert.deepEqual(v.phases.map(s => s.name), names);
  v.phases.forEach((phase, i) => {
    assert.ok(Number.isFinite(phase.startedMs) && phase.startedMs >= 0);
    if (i) assert.ok(phase.startedMs > v.phases[i - 1].startedMs);
  });
  for (const name of (long ? ['baseline-idle', 'idle-0', 'idle-1', 'idle-2'] : [])) {
    const i = names.indexOf(name);
    assert.ok(v.phases[i + 1].startedMs - v.phases[i].startedMs >= 10000, name);
  }
  const cycleRows = [], kinds = Array.from({ length: 4 }, () => []);
  let firstWave = 0;
  for (const [cycle, c] of v.cycles.entries()) {
    const requestedSeconds = long ? 120 : 60;
    assert.equal(c.cycle, cycle); assert.equal(c.requestedSeconds, requestedSeconds);
    assert.ok(c.actualSeconds >= requestedSeconds && c.actualSeconds < requestedSeconds + 5);
    assert.equal(c.firstWave, firstWave); assert.ok(Number.isInteger(c.waves) && c.waves >= 10);
    assert.equal(c.requests, c.waves * 32); assert.deepEqual(c.finalAvailable, [4, 16]);
    assert.equal(c.finalLocalExecution, 0); assert.equal(c.finalUpstreamActive, 0);
    const rows = v.observations.filter(s => s.cycle === cycle);
    assert.equal(rows.length, c.requests);
    for (let wave = firstWave; wave < firstWave + c.waves; wave++) {
      const clients = rows.filter(s => s.wave === wave).sort((a, b) => a.client - b.client);
      assert.deepEqual(clients.map(s => s.client), Array.from({ length: 32 }, (_, i) => i));
      for (const s of clients) {
        assert.equal(s.kind, s.client % 4);
        assert.ok(['0:cancelled', '200:ok', '429:search_busy', '502:upstream_rejected', '504:upstream_timeout'].includes(s.status + ':' + s.code));
        if (s.status === 0) assert.equal(s.client % 5, 0);
        kinds[s.kind].push(s);
      }
    }
    cycleRows.push({ cycle, waves: c.waves, actualSeconds: c.actualSeconds,
      allOuterRepliesAndCancellations: distribution(rows.map(s => s.elapsedMs)) });
    firstWave += c.waves;
  }
  assert.equal(firstWave, v.waves);
  assert.equal(cycleRows.reduce((n, c) => n + c.allOuterRepliesAndCancellations.count, 0), v.requests);
  assert.ok(v.sustainedSeconds >= (long ? 390 : 60) && v.sustainedSeconds < (long ? 420 : 65));
  const balancedThroughput = p.schemaVersion >= 3
    ? verifyBalanced(v.balancedThroughput, p.schemaVersion >= 4, p.schemaVersion >= 6,
      p.schemaVersion >= 7) : undefined;
  assert.equal(m.observed, true); assert.equal(m.productionServiceRssVerified, false);
  assert.equal(m.scope, 'test-process-including-driver-and-upstream'); assert.equal(p.memoryScope, m.scope);
  assert.equal(m.phaseCorrelation, 'stdout-receipt'); assert.equal(m.intervalMs, 500);
  assert.equal(m.processId, p.processId); assert.ok(Number.isInteger(m.processId) && m.processId > 0);
  assert.deepEqual(m.phasesReceived.map(({ name, startedMs }) => ({ name, startedMs })), v.phases);
  const deliveryOffsets = m.phasesReceived.map(e => e.receivedMs - e.startedMs);
  const skew = Math.max(...deliveryOffsets) - Math.min(...deliveryOffsets);
  assert.equal(m.phaseDeliverySkewMs, skew); assert.ok(skew < 1000, 'Unreliable phase delivery');
  let maxGap = 0;
  const groups = {};
  assert.ok(m.samples.length > 0 && m.samples.length < 1500);
  m.samples.forEach((s, i) => {
    assert.equal(s.pid, m.processId);
    for (const key of ['elapsedMs', 'receivedMs', 'workingSetBytes', 'privateBytes', 'virtualBytes', 'handles', 'threads'])
      assert.ok(Number.isFinite(s[key]) && s[key] >= 0, key);
    assert.ok(s.workingSetBytes > 0 && s.privateBytes > 0);
    if (i) {
      assert.ok(s.elapsedMs > m.samples[i - 1].elapsedMs && s.receivedMs > m.samples[i - 1].receivedMs);
      maxGap = Math.max(maxGap, s.elapsedMs - m.samples[i - 1].elapsedMs);
    }
    const currentPhase = m.phasesReceived.filter(p => p.receivedMs <= s.receivedMs).at(-1)?.name || 'startup';
    assert.equal(s.phase, currentPhase);
    (groups[s.phase] ||= []).push(s);
  });
  assert.equal(m.maxSampleGapMs, maxGap); assert.ok(maxGap <= 2000);
  const phases = {};
  for (const [name, rows] of Object.entries(groups)) {
    const stats = { count: rows.length, spanMs: rows.at(-1).elapsedMs - rows[0].elapsedMs };
    for (const key of ['workingSetBytes', 'privateBytes', 'handles', 'threads']) {
      const sorted = rows.map(s => s[key]).sort((a, b) => a - b);
      stats[key + 'Median'] = sorted[Math.floor(sorted.length / 2)]; stats[key + 'Max'] = sorted.at(-1);
    }
    phases[name] = stats;
  }
  assert.deepEqual(m.phases, phases);
  if (long) for (const name of ['baseline-idle', 'idle-0', 'idle-1', 'idle-2']) assert.ok(phases[name]?.count >= 10, name);
  for (const name of (long ? ['load-0', 'load-1', 'load-2'] : ['load-0'])) {
    assert.ok(phases[name]?.count >= (long ? 120 : 80), name);
    if (!long) assert.ok(phases[name].spanMs >= 58000, name);
  }
  if (p.schemaVersion >= 3) {
    assert.ok(phases['balanced-throughput']?.count >= 80);
    assert.ok(phases['balanced-throughput'].spanMs >= 58000);
  }
  const idleDeltas = long ? Object.fromEntries([0, 1, 2].map(i => ['idle-' + i,
    Object.fromEntries(['workingSetBytes', 'privateBytes'].map(key => [key,
      phases['idle-' + i][key + 'Median'] - phases['baseline-idle'][key + 'Median']]))])) : {};
  assert.deepEqual(m.idleDeltas, idleDeltas);
  for (const [field, digestKey] of [['probeFile', 'probeHash'], ['logFile', 'logHash'], ['memoryFile', 'memoryHash']]) {
    assert.equal(path.basename(r[field]), r[field], 'Unsafe evidence filename');
    let related = path.join(path.dirname(file), r[field]);
    if (!fs.existsSync(related)) related += '.gz';
    const b = bytes(related);
    assert.equal(hash(b), r[digestKey], field + ' identity');
    if (field === 'probeFile') assert.deepEqual(JSON.parse(b), p);
    if (field === 'memoryFile') assert.deepEqual(b.toString('utf8').trim().split('\n').map(line => JSON.parse(line)), m.samples);
  }
  return { edition: p.edition, rawHash: hash(raw), storedHash: hash(fs.readFileSync(file)), binaryHash: r.binaryHash,
    sourceHashes: p.sourceHashes, environment: r.environment, compiler: p.compiler, debugAssertions: p.debugAssertions,
    startedAt: r.startedAt, completedAt: r.completedAt, requests: v.requests, waves: v.waves,
    balancedThroughput,
    overflowRejectMs: v.overflowRejectMs, admissionTimeoutMs: v.admissionTimeoutMs, deadlineCases: v.deadlineCases,
    upstream: { started: v.upstreamStarted, replied: v.upstreamReplied, disconnected: v.upstreamDisconnected,
      peakLocalExecution: v.peakLocalExecution, peakUpstream: v.peakUpstream, finalAvailable: v.finalAvailable },
    cycles: cycleRows, kinds: kinds.map((rows, kind) => ({ kind, outerOutcomes: rows.reduce((acc, s) => {
      const key = s.status + ':' + s.code; acc[key] = (acc[key] || 0) + 1; return acc;
    }, {}), allOuterRepliesAndCancellations: distribution(rows.map(s => s.elapsedMs)) })),
    processMemory: { scope: m.scope, samples: m.samples.length, maxGapMs: maxGap, phaseDeliverySkewMs: skew,
      phases, idleDeltas, productionServiceRssVerified: false }, releaseEligible: false };
}
if (require.main === module) {
  const args = process.argv.slice(2), current = args.includes('--current');
  const positional = args.filter(a => a !== '--current');
  try {
    assert.ok(positional.length >= 1 && positional.length <= 2,
      'Usage: node scripts/check-search-pressure-evidence.js report.json[.gz] [library-test.exe] [--current]');
    console.log(JSON.stringify(verify(positional[0], { binary: positional[1], current }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { verify, verifyAlternatingActualStart };
