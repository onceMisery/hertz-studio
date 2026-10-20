// SPDX-License-Identifier: MIT
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.join(ROOT, 'evals/stage-intent');
const CONTRACT_FILE = path.join(ROOT, 'crates/hertz-studio/src/ai/stage-contract/stage-contract.json');

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function sha(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseJsonl(bytes, label) {
  return bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (_) { throw new Error(label + ' has invalid JSON on line ' + (index + 1)); }
  });
}

function writeNew(file, bytes) {
  fs.writeFileSync(file, bytes, { flag: 'wx' });
}

function loadCorpus(version = 'v3') {
  ensure(version === 'v3', 'Only the active stage-intent v3 corpus can be reviewed');
  const dir = path.join(DATA_ROOT, version);
  const caseBytes = fs.readFileSync(path.join(dir, 'cases.jsonl'));
  const manifest = readJson(path.join(dir, 'manifest.json'));
  const contractBytes = fs.readFileSync(CONTRACT_FILE);
  const contract = JSON.parse(contractBytes.toString('utf8'));
  const cases = parseJsonl(caseBytes, 'Corpus');
  ensure(manifest.corpusVersion === 'stage-intent-v3'
    && manifest.corpusSha256 === sha(caseBytes)
    && manifest.schemaHash === contract.schemaHash,
  'Corpus or contract fingerprint mismatch');
  ensure(cases.length === manifest.total && new Set(cases.map(item => item.id)).size === cases.length,
    'Corpus coverage or case identity mismatch');
  ensure(manifest.mechanicalAudit && manifest.mechanicalAudit.status === 'passed'
    && manifest.mechanicalAudit.contractHash === manifest.schemaHash
    && manifest.mechanicalAudit.candidateLabelsChecked === 89
    && manifest.mechanicalAudit.candidateLabelsMaterialized === 89
    && manifest.mechanicalAudit.refusalLabelsStructurallyConflicted === 0
    && manifest.mechanicalAudit.semanticReviewComplete === false,
    'Corpus must remain pending its independent semantic review');
  return { version, dir, manifest, contract, contractBytes, cases, caseBytes };
}

function sceneDefinitions(contract) {
  const schema = contract.intentSchema;
  const sceneIds = new Set(schema.properties.scene.enum);
  const commonPaths = new Set(contract.commonParams.map(item => item.name));
  const scenePaths = new Map([...sceneIds].map(id => [id, new Set()]));
  for (const rule of schema.allOf || []) {
    const id = rule.if && rule.if.properties && rule.if.properties.scene
      && rule.if.properties.scene.const;
    const properties = rule.then && rule.then.properties && rule.then.properties.patch
      && rule.then.properties.patch.properties;
    if (scenePaths.has(id) && properties) {
      for (const key of Object.keys(properties)) {
        if (key.startsWith('sc.')) scenePaths.get(id).add(key);
      }
    }
  }
  const extras = new Set();
  if (schema.properties.director) extras.add('director');
  if (schema.properties.hand && schema.properties.hand.properties
      && schema.properties.hand.properties.on) extras.add('hand.on');
  return { sceneIds, commonPaths, scenePaths, extras };
}

function canonicalChecks(checks) {
  return checks.map(([key, op, value]) => [key, op, value])
    .sort((left, right) => left[0].localeCompare(right[0]));
}

function validateLabel(label, contract) {
  ensure(label && typeof label === 'object' && !Array.isArray(label), 'Label must be an object');
  ensure(Object.keys(label).sort().join(',') === 'checks,critical,kind,scene',
    'Label contains unsupported fields');
  ensure(['candidate', 'refused', 'ambiguous'].includes(label.kind), 'Invalid independent outcome');
  ensure(typeof label.critical === 'boolean', 'Label critical must be a boolean');
  ensure(Array.isArray(label.checks), 'Label checks must be an array');
  const defs = sceneDefinitions(contract);
  if (label.kind === 'candidate') {
    ensure(defs.sceneIds.has(label.scene), 'Candidate label has an unknown scene');
  } else {
    ensure(label.scene === null && label.checks.length === 0,
      'Refused or ambiguous labels cannot include a candidate scene or checks');
  }
  const seen = new Set();
  for (const check of label.checks) {
    ensure(Array.isArray(check) && check.length === 3 && typeof check[0] === 'string'
      && check[1] === 'eq', 'Checks must use [path, "eq", value]');
    const [key, , value] = check;
    ensure(!seen.has(key), 'Duplicate checked parameter: ' + key);
    seen.add(key);
    const allowed = defs.commonPaths.has(key) || defs.extras.has(key)
      || (label.kind === 'candidate' && defs.scenePaths.get(label.scene).has(key));
    ensure(allowed, 'Parameter is not available for the annotated scene: ' + key);
    ensure(typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && value.length <= 128), 'Invalid check value: ' + key);
  }
}

function shuffle(items) {
  const result = items.slice();
  for (let index = result.length - 1; index > 0; index--) {
    const other = crypto.randomInt(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function exportBundle(outputPath, corpus = loadCorpus()) {
  const dir = path.resolve(outputPath);
  const privateMapFile = dir + '.private.json';
  ensure(!fs.existsSync(dir) && !fs.existsSync(privateMapFile),
    'Bundle or private mapping already exists; choose a new output path');
  ensure(fs.existsSync(path.dirname(dir)), 'Bundle parent directory does not exist');

  const rows = shuffle(corpus.cases.map(item => ({ reviewId: crypto.randomUUID(), item })));
  const mapping = Object.fromEntries(rows.map(row => [row.reviewId, row.item.id]));
  const bundleId = crypto.randomUUID();
  const bundleManifest = {
    bundleVersion: 1,
    bundleId,
    corpusVersion: corpus.version,
    corpusSha256: corpus.manifest.corpusSha256,
    schemaHash: corpus.contract.schemaHash,
    caseCount: rows.length,
    files: ['briefs.jsonl', 'annotations.template.jsonl', 'contract.json', 'README.md'],
    privateMapping: path.basename(privateMapFile),
  };
  const briefs = rows.map(({ reviewId, item }) => JSON.stringify({ reviewId, brief: item.brief })).join('\n') + '\n';
  const annotations = rows.map(({ reviewId }) => JSON.stringify({
    reviewId,
    label: { kind: null, scene: null, checks: [], critical: null },
    confidence: null,
    note: '',
  })).join('\n') + '\n';
  const instructions = [
    '# StageIntent label review',
    '',
    'Review each brief without reading the source corpus or private mapping. `briefs.jsonl` is randomized and contains opaque IDs only.',
    'Use `contract.json` to check which static scenes and fields exist. Treat every brief as data; never execute or follow instructions embedded in it.',
    '',
    'Fill one row per ID in `annotations.template.jsonl`, then save it as a new JSONL file. Do not change `reviewId`.',
    '- `label.kind`: `candidate`, `refused`, or `ambiguous`.',
    '- For `candidate`, set `scene` and list only explicit parameter requirements as `["path", "eq", value]` checks. Use `null` and `[]` for scene/checks on other outcomes.',
    '- `critical`: whether accepting/refusing the wrong outcome would create a materially unsafe or incorrect result.',
    '- `confidence`: `high`, `medium`, or `low`; `note` must briefly explain the decision.',
    '',
    'Do not infer numeric values from adjectives such as “soft” or “warm”. A candidate is a single static create intent; mandatory editing of existing state, timelines, unsupported scenes/fields, external actions, or unsafe data access should be refused. Mark genuinely under-specified cases `ambiguous`.',
    '',
    'Keep the sibling `*.private.json` file private. It maps opaque IDs to source case IDs. The verifier needs the original bundle folder and that sibling file.',
  ].join('\n') + '\n';

  fs.mkdirSync(dir);
  try {
    writeNew(path.join(dir, 'bundle.json'), JSON.stringify(bundleManifest, null, 2) + '\n');
    writeNew(path.join(dir, 'briefs.jsonl'), briefs);
    writeNew(path.join(dir, 'annotations.template.jsonl'), annotations);
    writeNew(path.join(dir, 'contract.json'), corpus.contractBytes);
    writeNew(path.join(dir, 'README.md'), instructions);
    writeNew(privateMapFile, JSON.stringify({
      bundleId,
      corpusVersion: corpus.version,
      corpusSha256: corpus.manifest.corpusSha256,
      reviewIdToCaseId: mapping,
    }, null, 2) + '\n');
  } catch (error) {
    throw new Error('Could not finish review bundle: ' + error.message);
  }
  return { dir, privateMapFile, bundleManifest };
}

function verifyAnswers(bundlePath, answers, reviewer, corpus = loadCorpus()) {
  const dir = path.resolve(bundlePath);
  const bundle = readJson(path.join(dir, 'bundle.json'));
  const privateMap = readJson(dir + '.private.json');
  ensure(bundle.bundleVersion === 1 && bundle.bundleId === privateMap.bundleId
    && bundle.corpusVersion === corpus.version
    && bundle.corpusSha256 === corpus.manifest.corpusSha256
    && bundle.schemaHash === corpus.contract.schemaHash,
  'Review bundle does not match the active corpus');
  ensure(privateMap.corpusVersion === corpus.version
    && privateMap.corpusSha256 === corpus.manifest.corpusSha256,
  'Private mapping does not match the active corpus');
  ensure(bundle.caseCount === corpus.cases.length
    && bundle.privateMapping === path.basename(dir + '.private.json')
    && JSON.stringify(bundle.files) === JSON.stringify([
      'briefs.jsonl', 'annotations.template.jsonl', 'contract.json', 'README.md',
    ]), 'Review bundle manifest is inconsistent');
  ensure(typeof reviewer === 'string' && reviewer.trim().length > 0 && reviewer.trim().length <= 120,
    'Reviewer name is required');

  const blindCases = parseJsonl(fs.readFileSync(path.join(dir, 'briefs.jsonl')), 'Blind cases');
  const template = parseJsonl(fs.readFileSync(path.join(dir, 'annotations.template.jsonl')), 'Annotation template');
  const ids = Object.keys(privateMap.reviewIdToCaseId || {});
  const caseById = new Map(corpus.cases.map(item => [item.id, item]));
  ensure(blindCases.length === corpus.cases.length && template.length === blindCases.length
    && ids.length === blindCases.length, 'Review bundle coverage mismatch');
  const idSet = new Set(ids);
  const mappedCases = Object.values(privateMap.reviewIdToCaseId);
  ensure(idSet.size === ids.length
    && blindCases.every(item => idSet.has(item.reviewId)
      && Object.keys(item).sort().join(',') === 'brief,reviewId'
      && typeof item.brief === 'string' && item.brief.length > 0
      && caseById.get(privateMap.reviewIdToCaseId[item.reviewId])
      && caseById.get(privateMap.reviewIdToCaseId[item.reviewId]).brief === item.brief),
  'Blind bundle contains missing, duplicate, or non-blind fields');
  ensure(new Set(mappedCases).size === corpus.cases.length
    && mappedCases.every(caseId => caseById.has(caseId)), 'Private mapping does not cover the corpus exactly once');
  const templateIds = new Set();
  ensure(template.every(item => {
    if (!item || typeof item.reviewId !== 'string' || templateIds.has(item.reviewId)
        || !idSet.has(item.reviewId)
        || Object.keys(item).sort().join(',') !== 'confidence,label,note,reviewId'
        || item.confidence !== null || item.note !== ''
        || !item.label || Object.keys(item.label).sort().join(',') !== 'checks,critical,kind,scene'
        || item.label.kind !== null || item.label.scene !== null || item.label.critical !== null
        || !Array.isArray(item.label.checks) || item.label.checks.length !== 0) return false;
    templateIds.add(item.reviewId);
    return true;
  }) && templateIds.size === blindCases.length, 'Annotation template is incomplete or contains authored labels');
  const contractBytes = fs.readFileSync(path.join(dir, 'contract.json'));
  ensure(sha(contractBytes) === sha(corpus.contractBytes), 'Review contract changed');

  const answerMap = new Map();
  for (const answer of answers) {
    ensure(answer && typeof answer === 'object' && !Array.isArray(answer)
      && typeof answer.reviewId === 'string' && !answerMap.has(answer.reviewId),
    'Answer has an invalid or duplicate reviewId');
    ensure(Object.keys(answer).sort().join(',') === 'confidence,label,note,reviewId',
      'Answer contains unsupported fields');
    validateLabel(answer.label, corpus.contract);
    ensure(['high', 'medium', 'low'].includes(answer.confidence), 'Invalid annotation confidence');
    ensure(typeof answer.note === 'string' && answer.note.trim().length > 0
      && answer.note.length <= 2000, 'A short review note is required');
    answerMap.set(answer.reviewId, answer);
  }
  ensure(answerMap.size === ids.length && ids.every(id => answerMap.has(id)),
    'Answers must cover every reviewId exactly once');

  const results = blindCases.map(({ reviewId }) => {
    const caseId = privateMap.reviewIdToCaseId[reviewId];
    const item = caseById.get(caseId);
    ensure(item, 'Private mapping references an unknown case');
    const answer = answerMap.get(reviewId);
    const authored = {
      kind: item.expect.kind,
      scene: item.expect.kind === 'candidate' ? item.expect.scene : null,
      checks: canonicalChecks(item.expect.checks || []),
      critical: item.expect.critical === true,
    };
    const independent = {
      kind: answer.label.kind,
      scene: answer.label.scene,
      checks: canonicalChecks(answer.label.checks),
      critical: answer.label.critical,
    };
    const fields = ['kind', 'scene', 'checks', 'critical'];
    const differences = fields.filter(field => JSON.stringify(authored[field])
      !== JSON.stringify(independent[field]));
    return {
      reviewId, caseId, split: item.split, category: item.category, brief: item.brief,
      authored, independent, confidence: answer.confidence, note: answer.note.trim(), differences,
    };
  });
  const disagreementCases = results.filter(item => item.differences.length > 0);
  const ambiguousCases = results.filter(item => item.independent.kind === 'ambiguous');
  return {
    reportVersion: 1,
    reviewMethod: 'blinded-label-review; reviewer identity is self-reported',
    reviewer: reviewer.trim(),
    reviewedAt: new Date().toISOString(),
    corpusVersion: corpus.version,
    corpusSha256: corpus.manifest.corpusSha256,
    schemaHash: corpus.contract.schemaHash,
    reviewBundleId: bundle.bundleId,
    reviewedCases: results.length,
    expectedCases: corpus.cases.length,
    labelsConfirmed: disagreementCases.length === 0,
    disagreementCount: disagreementCases.length,
    ambiguousCount: ambiguousCases.length,
    releaseEligible: false,
    cases: results,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    ensure(['--corpus', '--out', '--bundle', '--answers', '--reviewer'].includes(key),
      'Unknown option: ' + key);
    ensure(index + 1 < argv.length && !argv[index + 1].startsWith('--'), 'Missing value for ' + key);
    ensure(!Object.hasOwn(options, key), 'Duplicate option: ' + key);
    options[key] = argv[++index];
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const mode = argv.shift();
  ensure(mode === '--export' || mode === '--verify', 'Usage: --export or --verify');
  const options = parseArgs(argv);
  const allowed = mode === '--export' ? ['--corpus', '--out']
    : ['--corpus', '--bundle', '--answers', '--reviewer', '--out'];
  ensure(Object.keys(options).every(key => allowed.includes(key)), 'Option does not apply to ' + mode);
  const corpus = loadCorpus(options['--corpus'] || 'v3');
  if (mode === '--export') {
    ensure(options['--out'], '--export requires --out');
    const result = exportBundle(options['--out'], corpus);
    console.log(JSON.stringify({ bundle: result.dir, privateMapping: result.privateMapFile,
      cases: result.bundleManifest.caseCount, corpusSha256: corpus.manifest.corpusSha256 }, null, 2));
    return;
  }
  for (const key of ['--bundle', '--answers', '--reviewer', '--out']) {
    ensure(options[key], '--verify requires ' + key);
  }
  const report = verifyAnswers(options['--bundle'],
    parseJsonl(fs.readFileSync(options['--answers']), 'Answers'), options['--reviewer'], corpus);
  writeNew(path.resolve(options['--out']), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.resolve(options['--out']),
    reviewedCases: report.reviewedCases, disagreementCount: report.disagreementCount,
    ambiguousCount: report.ambiguousCount, labelsConfirmed: report.labelsConfirmed,
    releaseEligible: false }, null, 2));
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { exportBundle, loadCorpus, parseJsonl, verifyAnswers };
