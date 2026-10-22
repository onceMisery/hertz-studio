// SPDX-License-Identifier: MIT
// Frozen synthetic stage-intent evaluation. Default validation is offline.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { isIP } = require('node:net');
const { uiToken } = require('./ui-token');

const ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.join(ROOT, 'evals/stage-intent');
const DEFAULT_CORPUS_VERSION = 'v3';
const CORPUS_VERSIONS = Object.freeze({ v3: 'v3' });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const THRESHOLDS = Object.freeze({ supportedSchemaRate: 0.98, protocolStructureRate: 0.98,
  humanSemanticPassRate: 0.9, maxTruncationRate: 0.01, p95MsBelow: 30000 });
const LOCAL_KINDS = ['candidate','refused','truncated','invalid_intent','invalid_json',
  'invalid_protocol','transport_or_configuration','timeout'];
const MANAGED_KINDS = [...LOCAL_KINDS,'provider_error','cancelled'];
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const DRIVER_FINGERPRINT = sha(fs.readFileSync(__filename,'utf8').replace(/\r\n/g,'\n'));
function ensure(value, message) { if (!value) throw Error(message); }
function readJson(file) {
  ensure(fs.statSync(file).size <= 2 * 1024 * 1024, 'Evaluation JSON exceeds 2 MiB');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadCorpus(version = DEFAULT_CORPUS_VERSION) {
  ensure(Object.hasOwn(CORPUS_VERSIONS, version), 'Unsupported stage-intent corpus version: ' + version);
  const data = path.join(DATA_ROOT, CORPUS_VERSIONS[version]);
  const manifest = readJson(path.join(data, 'manifest.json'));
  const bytes = fs.readFileSync(path.join(data, 'cases.jsonl'));
  ensure(sha(bytes) === manifest.corpusSha256, 'Frozen corpus hash changed: create a new corpus version');
  const cases = bytes.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const contract = readJson(path.join(ROOT, 'crates/hertz-studio/src/ai/stage-contract/stage-contract.json'));
  ensure(manifest.corpusVersion === 'stage-intent-' + version, 'Manifest corpus version mismatch');
  ensure(contract.schemaHash === manifest.schemaHash, 'Corpus contract version changed: review labels before refreezing');
  const audit = manifest.mechanicalAudit;
  ensure(audit && audit.status === 'passed' && audit.contractHash === manifest.schemaHash
    && audit.candidateLabelsChecked === 89 && audit.candidateLabelsMaterialized === 89
    && audit.refusalLabelsStructurallyConflicted === 0 && audit.semanticReviewComplete === false,
  'Invalid v3 mechanical audit or semantic review status');
  const ids = new Set();
  const briefs = new Set();
  const counts = { development: 0, holdout: 0 };
  const categories = {};
  for (const item of cases) {
    ensure(/^[a-z0-9-]{1,80}$/.test(item.id) && !ids.has(item.id), 'Missing/duplicate case id');
    ensure(typeof item.brief === 'string' && item.brief.trim() && Buffer.byteLength(item.brief) <= 16384,
      'Invalid brief: ' + item.id);
    ensure(!briefs.has(item.brief.normalize('NFKC').trim()), 'Duplicate prompt across splits: ' + item.id);
    ensure(Object.hasOwn(counts, item.split), 'Invalid split: ' + item.id);
    ensure(['candidate', 'refused'].includes(item.expect.kind), 'Invalid expected outcome: ' + item.id);
    if (item.expect.kind === 'candidate') {
      const scene = contract.scenes.find(scene => scene.id === item.expect.scene);
      ensure(scene, 'Unknown expected scene: ' + item.id);
      const params = [...contract.commonParams, ...scene.params.map(p => ({ ...p, name: 'sc.' + p.name }))];
      for (const [key, op, value] of item.expect.checks || []) {
        ensure(op === 'eq', 'Unknown assertion operator');
        if (key === 'director' || key === 'hand.on') ensure(typeof value === 'boolean', 'Invalid boolean check');
        else {
          const param = params.find(p => p.name === key);
          ensure(param && Number.isFinite(value) && value >= param.min && value <= param.max,
            'Expected value is outside canonical contract: ' + item.id);
        }
      }
    } else ensure(item.expect.critical === true, 'Refusal counterexamples must be marked critical');
    ids.add(item.id); briefs.add(item.brief.normalize('NFKC').trim());
    counts[item.split]++;
    categories[item.category] = (categories[item.category] || 0) + 1;
  }
  ensure(cases.length === manifest.total && JSON.stringify(counts) === JSON.stringify(manifest.splits),
    'Manifest sample counts differ');
  ensure(JSON.stringify(categories) === JSON.stringify(manifest.categories), 'Manifest category counts differ');
  const dev = cases.filter(c => c.split === 'development');
  ensure(dev.length >= 120 && cases.filter(c => c.split === 'holdout').length >= 40, 'Insufficient frozen samples');
  ensure(dev.filter(c => ['negation','conflict'].includes(c.category)).length >= 20, 'Missing negation/conflict coverage');
  ensure(dev.filter(c => ['boundary','cross_scene','unknown','injection'].includes(c.category)).length >= 20,
    'Missing illegal/injection/range coverage');
  return { version, manifest, cases, contract };
}

function stageHarness() {
  const sandbox = { window: {}, console, Blob, TextEncoder, TextDecoder, CompressionStream, DecompressionStream,
    btoa: text => Buffer.from(text, 'binary').toString('base64'),
    atob: text => Buffer.from(text, 'base64').toString('binary'), setTimeout, clearTimeout,
    document: { hidden: false, addEventListener() {}, dispatchEvent() {}, getElementById() { return null; },
      body: { classList: { contains() { return false; } } } } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const files = ['creative-gl.js','backgrounds.js','handdrawn.js','creative-anime.js',
    'creative-share-code.js','creative-stage.js','creative-contract.js','creative-draft.js','creative-prompt.js'];
  const sources = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, 'plugin/ui', file), 'utf8').replace(/\r\n/g,'\n');
    sources.push(file + '\0' + source);
    vm.runInContext(source, sandbox, { filename: file, timeout: 3000 });
    Object.assign(sandbox, sandbox.window);
  }
  const stage = sandbox.window.CreativeStage;
  return { stage, prompt: sandbox.window.CreativePrompt, draft: sandbox.window.CreativeDraft,
    fingerprint: sha(sources.join('\0')) };
}

function offlineOutcome(compiled) {
  if (compiled.ok) return 'candidate';
  return compiled.code === 'unsatisfiable_constraints'
    || compiled.code === 'unrecognized_constraints'
    || compiled.code === 'unsafe_instruction'
    || compiled.code === 'unsupported_edit'
    || compiled.code === 'unsupported_timeline' ? 'refused' : 'baseline_no_match';
}

function assess(item, result, harness) {
  if (result.kind !== 'candidate') return { matched: item.expect.kind === 'refused' && result.kind === 'refused',
    criticalFailure: false, failedChecks: [], materialized: false };
  let materialized;
  try {
    harness.draft.validateIntent(result.intent);
    materialized = harness.stage.materializeIntent(null, result.intent);
  } catch (_) { /* reported as a failure below, never silently normalized */ }
  if (!materialized || !materialized.ok || materialized.ignored.length) {
    return { matched: false, criticalFailure: true, failedChecks: ['materialization'], materialized: false };
  }
  const failed = [];
  if (item.expect.kind !== 'candidate') failed.push('unexpected_acceptance');
  else {
    if (result.intent.scene !== item.expect.scene) failed.push('scene');
    for (const [key, , wanted] of item.expect.checks || []) {
      const actual = key.split('.').reduce((object, field) => object && object[field], materialized.preset);
      if (typeof wanted === 'number' ? typeof actual !== 'number' || Math.abs(actual - wanted) > 1e-6 : actual !== wanted) {
        failed.push(key);
      }
    }
  }
  return { matched: failed.length === 0, criticalFailure: !!item.expect.critical && failed.length > 0,
    failedChecks: failed, materialized: true };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a,b) => a-b);
  return sorted[Math.max(0, Math.ceil(sorted.length*p)-1)];
}

function summarize(cases, rows, reviews, meta, harness) {
  ensure(Array.isArray(reviews), 'Human reviews must be an array');
  ensure(reviews.every(review => review && typeof review.caseId === 'string'
    && (review.pass === null || typeof review.pass === 'boolean')
    && typeof review.reviewer === 'string' && typeof review.note === 'string'), 'Invalid human review fields');
  const ids = new Set();
  const indexed = new Map(cases.map(item => [item.id, item]));
  const failures = {};
  const categories = {};
  let matched = 0, accepted = 0, falseAccept = 0, falseReject = 0, critical = 0;
  let supportedAccepted = 0, reviewed = 0, semanticPass = 0, usageKnown = 0, outputExceeded = 0;
  const expectedSupported = cases.filter(c => c.expect.kind === 'candidate').length;
  for (const row of rows) {
    ensure(indexed.has(row.caseId) && !ids.has(row.caseId), 'Unknown/duplicate result case');
    ids.add(row.caseId);
    ensure(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0, 'Invalid elapsed time');
    const item = indexed.get(row.caseId);
    const check = assess(item, row, harness);
    if (check.matched) matched++;
    if (row.kind === 'candidate' && check.materialized) accepted++;
    if (row.kind === 'candidate' && check.materialized && item.expect.kind === 'candidate') supportedAccepted++;
    if (row.kind === 'candidate' && item.expect.kind === 'refused') falseAccept++;
    if (row.kind !== 'candidate' && item.expect.kind === 'candidate') falseReject++;
    if (check.criticalFailure) critical++;
    if (row.usage) { usageKnown++; if (row.usage.withinOutputBound === false) outputExceeded++; }
    failures[row.kind] = (failures[row.kind] || 0)+1;
    const category = categories[item.category] ||= { samples: 0, autoMatched: 0, criticalFailures: 0 };
    category.samples++; category.autoMatched += Number(check.matched); category.criticalFailures += Number(check.criticalFailure);
    const review = reviews.find(review => review.caseId === row.caseId);
    if (item.expect.kind === 'candidate' && review && typeof review.pass === 'boolean'
        && typeof review.reviewer === 'string' && review.reviewer.trim()
        && typeof review.note === 'string' && review.note.trim()) {
      reviewed++;
      if (review.pass && check.matched && row.kind === 'candidate') semanticPass++;
    }
  }
  ensure(new Set(reviews.map(r => r.caseId)).size === reviews.length && reviews.every(r => indexed.has(r.caseId)),
    'Unknown/duplicate human review');
  const complete = rows.length === cases.length && meta.sampleComplete === true && meta.status === 'completed';
  const latency = { p50Ms: percentile(rows.map(r => r.elapsedMs),0.5), p95Ms: percentile(rows.map(r => r.elapsedMs),0.95) };
  const rate = (n,d) => d ? n/d : null;
  const accountingMetrics = meta.executionMode === 'managed'
    ? { accounting: 'not_recorded' }
    : { usageKnown, usageMissing: rows.length-usageKnown, outputBoundExceeded: outputExceeded,
      localPriceMicroUsd: '0', externalInvoiceVerified: false };
  const metrics = { samples: rows.length, expectedSamples: cases.length, autoMatched: matched,
    supportedSamples: expectedSupported, supportedSchemaRate: rate(supportedAccepted,expectedSupported),
    protocolStructureRate: rate(accepted+(failures.refused || 0),cases.length),
    falseAcceptances: falseAccept, falseRejections: falseReject, criticalFailures: critical,
    truncated: failures.truncated || 0, truncationRate: rate(failures.truncated || 0,rows.length),
    humanReviewedSupported: reviewed, humanSemanticPassRate: reviewed === expectedSupported ? rate(semanticPass,expectedSupported) : null,
    ...accountingMetrics, ...latency, outcomes: failures, categories };
  const reasons = [];
  if (expectedSupported && metrics.supportedSchemaRate < THRESHOLDS.supportedSchemaRate) reasons.push('supported_schema_below_candidate_threshold');
  if (metrics.protocolStructureRate === null || metrics.protocolStructureRate < THRESHOLDS.protocolStructureRate) reasons.push('protocol_structure_below_candidate_threshold');
  if (metrics.truncationRate > THRESHOLDS.maxTruncationRate) reasons.push('truncation_above_candidate_threshold');
  if (latency.p95Ms === null || latency.p95Ms >= THRESHOLDS.p95MsBelow) reasons.push('latency_outside_execution_budget');
  if (critical || falseAccept || outputExceeded) reasons.push('critical_or_bound_failure');
  if (metrics.humanSemanticPassRate !== null && metrics.humanSemanticPassRate < THRESHOLDS.humanSemanticPassRate) reasons.push('human_semantics_below_candidate_threshold');
  if (!complete) reasons.push('incomplete_sample');
  return { reportVersion: 1, runId: meta.runId, executionMode: meta.executionMode || 'offline',
    provider: meta.provider, split: meta.split,
    corpusVersion: meta.corpusVersion,
    model:meta.model, round:meta.round, protocolFingerprint:meta.protocolFingerprint,
    materializerFingerprint:meta.materializerFingerprint, evaluatorFingerprint:meta.evaluatorFingerprint,
    binarySha256:meta.binarySha256,
    corpusSha256: meta.corpusSha256, sampleComplete: complete, metrics,
    candidateThresholds: THRESHOLDS,
    candidateChecks: reasons.length ? 'failed' : reviewed < expectedSupported ? 'pending_human_review' : 'passed', reasons,
    releaseEligible: false,
    outstanding: ['thresholds_not_frozen_for_a_verified_model', 'two_model_rounds_and_reserved_split_required',
      'actual_model_digest_runtime_and_hardware_acceptance_required', ...(!complete ? ['incomplete_sample'] : [])] };
}

function validateRow(row, meta, contract) {
  ensure(row && row.evaluationVersion === 1 && row.provider === meta.provider && row.model === meta.model,
    'Evaluator model/provider/version mismatch');
  ensure(row.schemaHash === contract.schemaHash && isHash(row.protocolFingerprint) && isHash(row.requestHash),
    'Evaluator contract/fingerprint mismatch');
  ensure(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0, 'Invalid elapsed time');
  const allowedKinds = meta.executionMode === 'managed' ? MANAGED_KINDS
    : meta.provider === 'ollama-local' ? LOCAL_KINDS : ['candidate','refused','baseline_no_match'];
  ensure(allowedKinds.includes(row.kind),
    'Unknown evaluation outcome');
  ensure(row.kind === 'candidate' ? row.intent && typeof row.intent === 'object' : row.intent === null,
    'Outcome and intent disagree');
  if (meta.executionMode === 'managed') {
    ensure(row.accounting === 'not_recorded' && !Object.hasOwn(row,'usage')
      && !Object.hasOwn(row,'reservationMicroUsd') && !Object.hasOwn(row,'localPriceMicroUsd')
      && !Object.hasOwn(row,'externalInvoiceVerified'), 'Managed evaluation must omit usage and cost fields');
  } else ensure(row.reservationMicroUsd === '0' && row.localPriceMicroUsd === '0'
    && row.externalInvoiceVerified === false, 'Local-only evaluation pricing mismatch');
  if (meta.provider === 'ollama-local' && meta.executionMode === 'local') {
    ensure(typeof row.buildVersion === 'string' && row.buildVersion && Number.isSafeInteger(row.requestBytes)
      && row.requestBytes > 0 && row.requestBytes <= 128*1024, 'Missing CLI build/request identity');
    ensure(row.basePresetHashes && Object.keys(row.basePresetHashes).length === Object.keys(contract.basePresetHashes).length
      && Object.entries(contract.basePresetHashes).every(([key,hash]) => row.basePresetHashes[key] === hash),
    'Evaluator base preset mismatch');
  }
  if (meta.executionMode !== 'managed') {
    ensure(row.usage === null || (row.usage && ['inputTokens','outputTokens'].every(key =>
      typeof row.usage[key] === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(row.usage[key])
      && BigInt(row.usage[key]) <= 18446744073709551615n)
      && row.usage.withinOutputBound === (BigInt(row.usage.outputTokens) <= 512n)), 'Invalid normalized usage');
  }
}

function loadRun(dir, corpus, harness, reviewFile) {
  const meta = readJson(path.join(dir,'run.json'));
  ensure(meta.corpusVersion === corpus.version && meta.corpusSha256 === corpus.manifest.corpusSha256
    && meta.schemaHash === corpus.manifest.schemaHash,
    'Run corpus/contract mismatch');
  ensure(meta.materializerFingerprint === harness.fingerprint,
    'Evaluation sources changed: use the original revision or create a new run');
  ensure(meta.evaluatorFingerprint === DRIVER_FINGERPRINT,
    'Evaluation driver changed: use the original revision or create a new run');
  const validProvider = meta.executionMode === 'managed'
    ? ['fake','ollama-local','openai','stepfun'].includes(meta.provider)
    : ['offline-rules','ollama-local'].includes(meta.provider);
  ensure(validProvider && ['development','holdout'].includes(meta.split)
    && typeof meta.model === 'string' && meta.model, 'Invalid run identity');
  if (meta.executionMode === 'local' && meta.provider === 'ollama-local') {
    ensure(isHash(meta.binarySha256), 'Missing CLI executable fingerprint');
  }
  const cases = corpus.cases.filter(item => item.split === meta.split);
  ensure(Array.isArray(meta.selectedCases) && meta.selectedCases.length > 0 && meta.selectedCases.length <= cases.length
    && meta.selectedCases.every((id,i) => id === cases[i].id), 'Invalid selected case coverage');
  ensure(typeof meta.sampleComplete === 'boolean' && meta.sampleComplete === (meta.selectedCases.length === cases.length)
    && ['completed','interrupted'].includes(meta.status), 'Invalid run completion metadata');
  const resultFile = path.join(dir,'results.jsonl');
  ensure(fs.statSync(resultFile).size <= 16*1024*1024, 'Saved results exceed bounded evaluation size');
  const bytes = fs.readFileSync(resultFile);
  ensure(sha(bytes) === meta.resultsSha256, 'Saved results changed');
  const rows = bytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  ensure(rows.length === meta.completedCases && rows.length <= meta.selectedCases.length
    && rows.every((row,i) => row.caseId === meta.selectedCases[i]), 'Saved result coverage differs from metadata');
  ensure(meta.status !== 'completed' || rows.length === meta.selectedCases.length, 'Completed run is missing results');
  for (const row of rows) {
    validateRow(row,meta,corpus.contract);
    ensure(row.protocolFingerprint === meta.protocolFingerprint, 'Saved protocol identity changed within a round');
    if (meta.executionMode === 'local' && meta.provider === 'ollama-local') {
      ensure(row.buildVersion === rows[0].buildVersion, 'CLI build changed within a round');
    }
  }
  const reviews = readJson(reviewFile || path.join(dir,'reviews.json'));
  const report = summarize(cases,rows,reviews,meta,harness);
  return { meta, rows, report };
}

async function childCase(binary, origin, model, item, signal, contract = loadCorpus().contract) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--evaluate-stage','--origin',origin,'--model',model],
      { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let stdout = '', stderr = '', failed;
    const interrupt = () => {
      failed ||= Error('Evaluation interrupted; no automatic retry');
      child.kill();
    };
    const cleanup = () => signal?.removeEventListener('abort', interrupt);
    const timer = setTimeout(() => { failed = Error('Evaluation process deadline exceeded; no automatic retry'); child.kill(); },45000);
    child.stdout.on('data', chunk => {
      if (failed) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 256*1024) { failed = Error('Evaluation stdout limit'); child.kill(); }
    });
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); cleanup(); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      cleanup();
      if (failed) return reject(failed);
      if (code !== 0) return reject(Error('Evaluation process failed for ' + item.id + ' (stderr withheld; no automatic retry)'));
      try {
        const result = JSON.parse(stdout);
        ensure(result.caseId === item.id, 'Evaluator case identity mismatch');
        validateRow(result,{provider:'ollama-local',model},contract);
        resolve(result);
      } catch (error) { reject(error); }
    });
    if (signal?.aborted) interrupt();
    else signal?.addEventListener('abort', interrupt, { once:true });
    child.stdin.end(JSON.stringify({ caseId: item.id, brief: item.brief }));
  });
}

async function managedFetch(server, token, pathname, options = {}, signal, responseLimit = 256*1024) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 45000);
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once:true });
  try {
    const response = await fetch(new URL(pathname,server), {
      method: options.method || 'GET',
      headers: { Authorization:'Bearer '+token, ...(options.body ? {'Content-Type':'application/json'} : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect:'error', signal:controller.signal,
    });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      ensure(size <= responseLimit, 'Managed evaluator response exceeds its bound');
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (_) { throw Error('Managed evaluator returned invalid JSON; no automatic retry'); }
    if (!response.ok) {
      const code = value?.error?.code;
      throw Error('Managed evaluator request failed ('+response.status+(code ? ', '+code : '')+'); no automatic retry');
    }
    return value;
  } catch (error) {
    if (error.message?.includes('no automatic retry') || error.message?.includes('exceeds its bound')) throw error;
    throw Error('Managed evaluator request failed; no automatic retry');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort',abort);
  }
}

async function managedIdentity(server, token, signal) {
  const status = await managedFetch(server,token,'/v1/ai/evaluation/status',{},signal,16*1024);
  ensure(typeof status.provider === 'string' && typeof status.model === 'string'
    && typeof status.providerReady === 'boolean' && typeof status.generationConsent === 'boolean'
    && typeof status.runnerReady === 'boolean', 'Managed evaluator status is malformed');
  ensure(['fake','ollama-local','openai','stepfun'].includes(status.provider),
    'Configured provider is not supported by managed stage evaluation');
  ensure(status.runnerReady, 'Managed evaluator requires the active local AI runner');
  ensure(status.generationConsent, 'Managed evaluator requires generation consent');
  ensure(status.providerReady, 'Configured provider is not ready');
  return status;
}

async function managedCase(server, token, item, meta, signal, contract = loadCorpus().contract) {
  const row = await managedFetch(server,token,'/v1/ai/evaluation/case',{
    method:'POST',body:{caseId:item.id,brief:item.brief},timeoutMs:45000,
  },signal,256*1024);
  ensure(row.caseId === item.id, 'Managed evaluator case identity mismatch');
  ensure(row.provider === meta.provider && row.model === meta.model,
    'Configured provider/model changed during this round');
  validateRow(row,meta,contract);
  return row;
}

function options(argv) {
  const flags = new Set(['--validate','--baseline','--run-local','--run-managed','--allow-holdout']);
  const values = new Set(['--corpus','--out','--split','--model','--origin','--server','--binary','--limit','--round','--report','--reviews','--export-review',
    '--compare','--against','--before-reviews','--after-reviews']);
  const result = {};
  for (let i=0; i<argv.length; i++) {
    const arg = argv[i];
    ensure(!Object.hasOwn(result,arg), 'Duplicate option: ' + arg);
    if (flags.has(arg)) result[arg] = true;
    else { ensure(values.has(arg) && argv[i+1] && !argv[i+1].startsWith('--'), 'Unknown/missing option: ' + arg); result[arg] = argv[++i]; }
  }
  return result;
}

async function fileSha(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function localOrigin(input) {
  let url;
  try { url = new URL(input); } catch (_) { throw Error('Invalid local evaluation origin'); }
  const host = url.hostname.replace(/^\[|\]$/g,'');
  ensure(input.length <= 2048 && !/[\x00-\x20\x7f]/.test(input)
    && ['http:','https:'].includes(url.protocol) && !url.username && !url.password
    && url.pathname === '/' && !url.search && !url.hash && url.port !== '0'
    && (isIP(host) === 4 && host.startsWith('127.') || isIP(host) === 6 && host === '::1'),
  'Evaluation requires a numeric loopback origin without path or credentials');
  return url.origin;
}

function compareRuns(before, after, corpus, harness) {
  ensure(before.meta.split === after.meta.split
    && JSON.stringify(before.meta.selectedCases) === JSON.stringify(after.meta.selectedCases),
  'Comparison requires the same split and selected cases');
  ensure(before.report.sampleComplete && after.report.sampleComplete, 'Comparison requires complete runs');
  const indexed = new Map(corpus.cases.map(item => [item.id,item]));
  let improved = 0, regressed = 0, bothMatched = 0, bothUnmatched = 0;
  const changedCases = [];
  for (let i=0; i<before.rows.length; i++) {
    const left = before.rows[i], right = after.rows[i], item = indexed.get(left.caseId);
    const was = assess(item,left,harness).matched, now = assess(item,right,harness).matched;
    if (!was && now) improved++;
    else if (was && !now) regressed++;
    else if (was) bothMatched++;
    else bothUnmatched++;
    if (was !== now) changedCases.push({caseId:item.id,category:item.category,beforeMatched:was,afterMatched:now});
  }
  const side = run => ({ runId:run.meta.runId, provider:run.meta.provider, model:run.meta.model,
    round:run.meta.round, protocolFingerprint:run.meta.protocolFingerprint,
    candidateChecks:run.report.candidateChecks, metrics:run.report.metrics });
  return { comparisonVersion:1, corpusVersion:corpus.version,
    corpusSha256:corpus.manifest.corpusSha256, split:before.meta.split,
    before:side(before), after:side(after), automaticExpectations:{improved,regressed,bothMatched,bothUnmatched},
    changedCases, releaseEligible:false,
    note:'Paired synthetic expectation comparison; human semantics and formal release evidence remain separate' };
}

async function exportReview(dir, run, corpus, harness) {
  ensure(!fs.existsSync(dir), 'Review directory already exists; never overwrite a review bundle');
  const indexed = new Map(corpus.cases.map(item => [item.id,item]));
  const entries = [];
  fs.mkdirSync(path.dirname(dir),{recursive:true}); fs.mkdirSync(dir);
  for (const row of run.rows) {
    const item = indexed.get(row.caseId);
    const check = assess(item,row,harness);
    let artifactFile = null, preparation = 'no_candidate';
    if (row.kind === 'candidate') {
      preparation = 'rejected';
      let prepared;
      try {
        // Use the product's own version envelope, baseline verification and
        // sharing roundtrip. Rejected candidates never become import files.
        const artifact = harness.draft.artifact(row.intent);
        prepared = await harness.draft.prepare(artifact);
      } catch (_) { /* expose a fixed state, never an untrusted exception */ }
      if (prepared) {
        artifactFile = row.caseId+'.artifact.json';
        fs.writeFileSync(path.join(dir,artifactFile),JSON.stringify(prepared.artifact,null,2)+'\n');
        preparation = 'ready_for_manual_preview';
      }
    }
    entries.push({caseId:row.caseId,category:item.category,brief:item.brief,expect:item.expect,
      kind:row.kind,automatic:check,preparation,artifactFile});
  }
  const index = { reviewBundleVersion:1,runId:run.meta.runId,corpusVersion:run.meta.corpusVersion,
    corpusSha256:run.meta.corpusSha256,
    resultsSha256:run.meta.resultsSha256,sampleComplete:run.report.sampleComplete,
    note:'Import each ready artifact into the official draft preview; do not apply it for scoring. Score the original run reviews.json.',
    entries };
  fs.writeFileSync(path.join(dir,'index.json'),JSON.stringify(index,null,2)+'\n');
  return index;
}

async function main(argv = process.argv.slice(2)) {
  const opts = options(argv);
  const modes = ['--validate','--baseline','--run-local','--run-managed','--report','--compare','--export-review'].filter(key=>opts[key]);
  ensure(modes.length <= 1, 'Choose exactly one evaluation mode');
  if (modes.length) {
    const allowed = {
      '--validate': ['--corpus'], '--baseline':['--corpus','--split','--allow-holdout','--out','--limit'],
      '--run-local':['--corpus','--split','--allow-holdout','--out','--limit','--binary','--origin','--model','--round'],
      '--run-managed':['--corpus','--split','--allow-holdout','--out','--limit','--server','--round'],
      '--report':['--corpus','--reviews'], '--compare':['--corpus','--against','--before-reviews','--after-reviews'],
      '--export-review':['--corpus','--out'],
    }[modes[0]];
    ensure(Object.keys(opts).every(key => key === modes[0] || allowed.includes(key)), 'Option does not apply to selected mode');
  }
  const corpus = loadCorpus(opts['--corpus'] || DEFAULT_CORPUS_VERSION);
  if (opts['--validate'] || !argv.length) {
    console.log('Frozen stage evaluation ' + corpus.version + ': ' + corpus.cases.length
      + ' unique synthetic cases, 120 development / 40 reserved; corpus hash and contract hash passed');
    return;
  }
  const harness = stageHarness();
  if (opts['--export-review']) {
    ensure(opts['--out'], 'Review export requires a new --out directory');
    const index = await exportReview(path.resolve(opts['--out']),
      loadRun(path.resolve(opts['--export-review']),corpus,harness),corpus,harness);
    console.log(JSON.stringify({runId:index.runId,samples:index.entries.length,
      previewArtifacts:index.entries.filter(entry=>entry.artifactFile).length,sampleComplete:index.sampleComplete}));
    return;
  }
  if (opts['--compare']) {
    ensure(opts['--against'], 'Comparison requires --against RUN_DIR');
    console.log(JSON.stringify(compareRuns(loadRun(path.resolve(opts['--compare']),corpus,harness,opts['--before-reviews']),
      loadRun(path.resolve(opts['--against']),corpus,harness,opts['--after-reviews']),corpus,harness),null,2));
    return;
  }
  if (opts['--report']) {
    const dir = path.resolve(opts['--report']);
    const { report } = loadRun(dir,corpus,harness,opts['--reviews']);
    fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
    return;
  }
  ensure(Number(!!opts['--baseline']) + Number(!!opts['--run-local']) + Number(!!opts['--run-managed']) === 1,
    'Choose exactly one of --baseline / --run-local / --run-managed');
  const split = opts['--split'] || 'development';
  ensure(split === 'development' || (split === 'holdout' && opts['--allow-holdout']), 'Reserved split requires --allow-holdout');
  ensure(opts['--out'], 'A new --out directory is required');
  const dir = path.resolve(opts['--out']);
  ensure(!fs.existsSync(dir), 'Run directory already exists; never overwrite a model round');
  const allCases = corpus.cases.filter(item => item.split === split);
  const defaultLimit = opts['--run-managed'] ? 1 : allCases.length;
  const limit = opts['--limit'] === undefined ? defaultLimit : Number(opts['--limit']);
  ensure(Number.isSafeInteger(limit) && limit > 0 && limit <= allCases.length, 'Invalid sample limit');
  const cases = allCases.slice(0,limit);
  const binary = path.resolve(opts['--binary'] || process.env.HERTZ_BIN || path.join(ROOT,'target/debug',process.platform==='win32'?'hertz-studio.exe':'hertz-studio'));
  if (opts['--run-local']) ensure(opts['--model'] && opts['--origin'] && opts['--round'], 'Local run requires explicit --model, --origin and --round');
  if (opts['--run-managed']) ensure(opts['--server'] && opts['--round'], 'Managed run requires explicit --server and --round');
  if (opts['--run-local']) {
    ensure(/^[1-9][0-9]{0,2}$/.test(opts['--round']), 'Round must be a positive integer below 1000');
    ensure(/^[A-Za-z0-9._/:\-]{1,128}$/.test(opts['--model']) && !/cloud/i.test(opts['--model']),
      'Select an installed local model');
    opts['--origin'] = localOrigin(opts['--origin']);
  }
  if (opts['--run-managed']) {
    ensure(/^[1-9][0-9]{0,2}$/.test(opts['--round']), 'Round must be a positive integer below 1000');
    opts['--server'] = localOrigin(opts['--server']);
  }
  const token = opts['--run-managed'] ? uiToken() : null;
  const managed = opts['--run-managed']
    ? await managedIdentity(opts['--server'],token,new AbortController().signal) : null;
  const meta = { runId:crypto.randomUUID(), startedAt:new Date().toISOString(), split,
    executionMode:opts['--run-managed'] ? 'managed' : opts['--run-local'] ? 'local' : 'offline',
    accounting:opts['--run-managed'] ? 'not_recorded' : undefined,
    corpusVersion:corpus.version,
    corpusSha256:corpus.manifest.corpusSha256, schemaHash:corpus.manifest.schemaHash,
    provider:managed?.provider || (opts['--baseline']?'offline-rules':'ollama-local'),
    model:managed?.model || opts['--model'] || 'offline-rules',
    round:opts['--round'] || 'baseline', selectedCases:cases.map(item=>item.id), sampleComplete:cases.length === allCases.length,
    materializerFingerprint:harness.fingerprint,
    evaluatorFingerprint:DRIVER_FINGERPRINT,
    binarySha256:opts['--run-local'] ? await fileSha(binary) : null,
    origin:opts['--origin'] || null,
    serverOrigin:opts['--server'] || null,
    baselineContext:opts['--baseline'] ? 'canonical towers when offline rules omit a scene; no active user preset' : null,
    status:'running' };
  fs.mkdirSync(path.dirname(dir),{recursive:true}); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify(meta,null,2)+'\n');
  const rows = [];
  const results = path.join(dir,'results.jsonl');
  fs.writeFileSync(results,'');
  const interruption = new AbortController();
  const stop = () => interruption.abort();
  process.on('SIGINT',stop);
  process.on('SIGTERM',stop);
  try {
    for (const item of cases) {
      ensure(!interruption.signal.aborted, 'Evaluation interrupted; no automatic retry');
      let row;
      if (opts['--baseline']) {
        const started = performance.now();
        const compiled = harness.prompt.compile(item.brief, {
          scenes: corpus.contract.scenes.map(scene => scene.id),
          paths: [...corpus.contract.commonParams.map(param => param.name),
            ...corpus.contract.scenes.flatMap(scene => scene.params.map(param => 'sc.'+param.name))],
        });
        const intent = compiled.ok ? clone(compiled.intent) : null;
        if (intent) { intent.scene ||= 'towers'; intent.patch ||= {}; }
        row = { evaluationVersion:1, caseId:item.id, provider:'offline-rules', model:'offline-rules',
          protocolFingerprint:harness.fingerprint, requestHash:sha(item.brief),
          schemaHash:corpus.manifest.schemaHash, elapsedMs:performance.now()-started,
          kind:offlineOutcome(compiled), intent, usage:null,
          reservationMicroUsd:'0', localPriceMicroUsd:'0', externalInvoiceVerified:false,
          baselineWarnings:clone(compiled.warnings) };
      } else if (opts['--run-managed']) {
        row = await managedCase(opts['--server'],token,item,meta,interruption.signal,corpus.contract);
      } else row = await childCase(binary,opts['--origin'],opts['--model'],item,interruption.signal,corpus.contract);
      validateRow(row,meta,corpus.contract);
      if (rows.length) ensure(row.protocolFingerprint === rows[0].protocolFingerprint, 'Model protocol changed within a round');
      if (rows.length && opts['--run-local']) ensure(row.buildVersion === rows[0].buildVersion, 'CLI build changed within a round');
      rows.push(row);
      fs.appendFileSync(results,JSON.stringify(row)+'\n');
      process.stderr.write(item.id + ': ' + row.kind + '\n');
      if (opts['--run-managed']
          && ['provider_error','transport_or_configuration','timeout','cancelled'].includes(row.kind)) {
        throw Error('Managed provider stopped this round after '+row.kind+'; no automatic retry');
      }
    }
    if (opts['--run-local']) ensure(await fileSha(binary) === meta.binarySha256, 'CLI executable changed within a round');
    ensure(!interruption.signal.aborted, 'Evaluation interrupted; no automatic retry');
    meta.status = 'completed';
  } catch (error) { meta.status = 'interrupted'; meta.failure = 'evaluator_failed_without_retry'; throw error; }
  finally {
    process.off('SIGINT',stop);
    process.off('SIGTERM',stop);
    meta.completedCases = rows.length;
    meta.finishedAt = new Date().toISOString();
    meta.resultsSha256 = sha(fs.readFileSync(results));
    meta.protocolFingerprint = rows.length ? rows[0].protocolFingerprint : null;
    fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify(meta,null,2)+'\n');
    fs.writeFileSync(path.join(dir,'reviews.json'),JSON.stringify(rows.map(row=>({caseId:row.caseId,pass:null,reviewer:'',note:''})),null,2)+'\n');
  }
  const report = summarize(allCases,rows,[],meta,harness);
  fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}

module.exports = { loadCorpus, stageHarness, offlineOutcome, assess, summarize, validateRow, loadRun, compareRuns,
  exportReview, childCase, managedFetch, managedIdentity, managedCase, main,
  driverFingerprint:DRIVER_FINGERPRINT };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode=1; });
