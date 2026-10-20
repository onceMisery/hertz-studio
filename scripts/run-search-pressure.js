// SPDX-License-Identifier: MIT
// Explicit Windows test-process pressure/memory observation, not production RSS.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const TEST = 'online::search_pressure::sustained_shared_search_budget';
const MARKER = 'HERTZ_SEARCH_PRESSURE_PHASE ';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function summarize(samples) {
  const phases = {};
  for (const sample of samples) (phases[sample.phase] ||= []).push(sample);
  return Object.fromEntries(Object.entries(phases).map(([name, rows]) => [name, {
    count: rows.length, spanMs: rows.at(-1).elapsedMs - rows[0].elapsedMs,
    ...Object.fromEntries(['workingSetBytes', 'privateBytes', 'handles', 'threads'].flatMap(key => [
      [key + 'Median', median(rows.map(s => s[key]))], [key + 'Max', Math.max(...rows.map(s => s[key]))],
    ])),
  }]));
}
function completion(child, label) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ label, code, signal }));
  });
}
async function run({ binary, out, long = false }) {
  assert.equal(process.platform, 'win32', 'Windows process-memory observation only');
  binary = path.resolve(binary); out = path.resolve(out);
  assert.equal(path.parse(out).root.toLowerCase(), path.parse(ROOT).root.toLowerCase(), 'Keep reports on workspace drive');
  const probePath = out.replace(/\.json$/i, '') + '-probe.json';
  const logPath = out.replace(/\.json$/i, '') + '-probe.log';
  const memoryPath = out.replace(/\.json$/i, '') + '-memory.jsonl';
  assert.ok(out.endsWith('.json'), 'Report must end in .json');
  assert.ok(fs.statSync(binary).isFile(), 'Build the Hertz library test executable first');
  for (const file of [out, probePath, logPath, memoryPath]) assert.ok(!fs.existsSync(file), 'Refusing to overwrite ' + file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = path.join(ROOT, 'target', 'search-pressure-v2', 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  let reportFd, logFd, memoryFd;
  const createdOutputs = [];
  try {
    reportFd = fs.openSync(out, 'wx'); createdOutputs.push(out);
    logFd = fs.openSync(logPath, 'wx'); createdOutputs.push(logPath);
    memoryFd = fs.openSync(memoryPath, 'wx'); createdOutputs.push(memoryPath);
  } catch (error) {
    for (const fd of [reportFd, logFd, memoryFd]) if (fd !== undefined) fs.closeSync(fd);
    for (const file of createdOutputs) fs.rmSync(file, { force: true });
    throw error;
  }
  const report = { schemaVersion: 1, releaseEligible: false, startedAt: new Date().toISOString(),
    environment: { os: process.platform, release: os.release(), arch: process.arch,
      cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version },
    binaryHash: hash(fs.readFileSync(binary)), probeFile: path.basename(probePath), logFile: path.basename(logPath),
    memoryFile: path.basename(memoryPath), processMemory: { observed: false,
      scope: 'test-process-including-driver-and-upstream', productionServiceRssVerified: false,
      phaseCorrelation: 'stdout-receipt', intervalMs: 500, phasesReceived: [], samples: [] } };
  let child, sampler, deadline, childResult, samplerResult, currentPhase = 'startup';
  let parseFailure, samplerError = '', logBytes = 0, phaseClock = performance.now();
  const memory = report.processMemory;
  function log(chunk) {
    logBytes += chunk.length;
    if (logBytes > 2 * 1024 * 1024) { parseFailure ||= Error('Probe log exceeded bound'); child?.kill(); return; }
    fs.writeSync(logFd, chunk);
  }
  try {
    const env = { ...process.env, TMP: tmp, TEMP: tmp, HERTZ_SEARCH_PRESSURE_REPORT: probePath };
    delete env.HERTZ_SEARCH_PRESSURE_LONG;
    if (long) env.HERTZ_SEARCH_PRESSURE_LONG = '1';
    child = spawn(binary, [TEST, '--exact', '--ignored', '--nocapture', '--test-threads=1'],
      { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    childResult = completion(child, 'probe');
    // Attach a handler immediately so a failed spawn cannot become unhandled.
    childResult.catch(() => {});
    assert.ok(child.pid, 'Probe did not start');
    memory.processId = child.pid;
    child.stderr.on('data', log); child.stdout.on('data', log);
    createInterface({ input: child.stdout }).on('line', line => {
      const index = line.indexOf(MARKER);
      if (index < 0) return;
      try {
        const event = JSON.parse(line.slice(index + MARKER.length));
        assert.ok(memory.phasesReceived.length < 20, 'Phase bound');
        currentPhase = event.name;
        memory.phasesReceived.push({ ...event, receivedMs: performance.now() - phaseClock });
        console.log('Search pressure: ' + event.name);
      } catch (error) { parseFailure ||= error; child.kill(); }
    });
    sampler = spawn(process.env.POWERSHELL || 'pwsh', ['-NoProfile', '-NonInteractive', '-File',
      path.join(ROOT, 'scripts', 'sample-process-memory.ps1'), '-TargetProcessId', String(child.pid),
      '-IntervalMs', '500', '-MaxDurationSeconds', '600'],
      { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    samplerResult = completion(sampler, 'sampler');
    samplerResult.then(exit => {
      if (exit.code !== 0) { parseFailure ||= Error('Memory sampler failed'); child.kill(); }
    }, error => { parseFailure ||= error; child.kill(); });
    sampler.stderr.on('data', chunk => { samplerError = (samplerError + chunk).slice(-4096); });
    createInterface({ input: sampler.stdout }).on('line', line => {
      try {
        assert.ok(memory.samples.length < 1500, 'Memory sample bound');
        const sample = { ...JSON.parse(line), receivedMs: performance.now() - phaseClock, phase: currentPhase };
        assert.equal(sample.pid, child.pid, 'Sampler process identity');
        fs.writeSync(memoryFd, JSON.stringify(sample) + '\n');
        memory.samples.push(sample);
      } catch (error) { parseFailure ||= error; child.kill(); sampler.kill(); }
    });
    deadline = setTimeout(() => { parseFailure ||= Error('Pressure observation exceeded 570 seconds');
      child.kill(); sampler.kill(); }, 570000);
    const exit = await childResult;
    const sampleExit = await samplerResult;
    clearTimeout(deadline);
    if (parseFailure) throw parseFailure;
    assert.deepEqual(exit, { label: 'probe', code: 0, signal: null }, 'Pressure probe failed; see preserved log');
    assert.deepEqual(sampleExit, { label: 'sampler', code: 0, signal: null }, samplerError || 'Memory sampler failed');
    const raw = fs.readFileSync(probePath);
    const probe = JSON.parse(raw);
    report.probeHash = hash(raw); report.probe = probe;
    assert.equal(probe.processId, child.pid);
    assert.equal(probe.testBinaryHash, report.binaryHash);
    assert.equal(probe.longMode, long);
    for (const [file, digest] of Object.entries(probe.sourceHashes))
      assert.equal(hash(fs.readFileSync(path.join(ROOT, file))), digest, 'Source changed: ' + file);
    memory.phases = summarize(memory.samples);
    memory.maxSampleGapMs = Math.max(...memory.samples.slice(1).map((s, i) => s.elapsedMs - memory.samples[i].elapsedMs));
    const delivery = memory.phasesReceived.map(e => e.receivedMs - e.startedMs);
    memory.phaseDeliverySkewMs = Math.max(...delivery) - Math.min(...delivery);
    memory.idleDeltas = long ? Object.fromEntries(probe.results.cycles.map(c => ['idle-' + c.cycle,
      Object.fromEntries(['workingSetBytes', 'privateBytes'].map(key => [key,
        memory.phases['idle-' + c.cycle][key + 'Median'] - memory.phases['baseline-idle'][key + 'Median']]))])) : {};
    assert.ok(memory.samples.length > 0 && memory.maxSampleGapMs <= 2000, 'Incomplete memory sampling');
    if (long) for (const name of ['baseline-idle', 'idle-0', 'idle-1', 'idle-2'])
      assert.ok(memory.phases[name]?.count >= 10, 'Missing idle samples: ' + name);
    memory.observed = true;
  } catch (error) {
    report.failure = { name: error.name, message: error.message };
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (sampler && sampler.exitCode === null && sampler.signalCode === null) sampler.kill();
    await Promise.allSettled([childResult, samplerResult].filter(Boolean));
    report.completedAt = new Date().toISOString();
    report.logHash = hash(fs.readFileSync(logPath)); report.memoryHash = hash(fs.readFileSync(memoryPath));
    fs.writeFileSync(reportFd, JSON.stringify(report, null, 2) + '\n');
    for (const fd of [reportFd, logFd, memoryFd]) fs.closeSync(fd);
  }
  if (report.failure) throw Error(report.failure.message + '; evidence retained in ' + out);
  console.log(JSON.stringify({ report: out, edition: report.probe.edition, requests: report.probe.results.requests,
    memorySamples: memory.samples.length, idleDeltas: memory.idleDeltas, releaseEligible: false }, null, 2));
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const value = key => args[args.indexOf(key) + 1];
  if (!args.includes('--binary') || !args.includes('--out') || args.some((a, i) =>
    !['--binary', '--out', '--long'].includes(a) && !['--binary', '--out'].includes(args[i - 1]))) {
    console.error('Usage: node scripts/run-search-pressure.js --binary library-test.exe --out report.json [--long]');
    process.exitCode = 1;
  } else run({ binary: value('--binary'), out: value('--out'), long: args.includes('--long') })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { summarize };
