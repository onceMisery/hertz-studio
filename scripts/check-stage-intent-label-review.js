// SPDX-License-Identifier: MIT
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportBundle, loadCorpus, parseJsonl, verifyAnswers } = require('./review-stage-intent-labels');

const corpus = loadCorpus();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hertz-stage-label-review-'));
try {
  const bundlePath = path.join(tempRoot, 'blind-review');
  const bundle = exportBundle(bundlePath, corpus);
  const blindCases = parseJsonl(fs.readFileSync(path.join(bundlePath, 'briefs.jsonl')), 'Blind cases');
  const template = parseJsonl(fs.readFileSync(path.join(bundlePath, 'annotations.template.jsonl')), 'Template');
  const privateMap = JSON.parse(fs.readFileSync(bundle.privateMapFile, 'utf8'));
  const serializedBlind = fs.readFileSync(path.join(bundlePath, 'briefs.jsonl'), 'utf8');

  assert.equal(blindCases.length, 160);
  assert.equal(template.length, 160);
  assert.equal(fs.existsSync(path.join(bundlePath, 'private-map.json')), false);
  assert.equal(Object.keys(blindCases[0]).sort().join(','), 'brief,reviewId');
  assert.equal(new Set(blindCases.map(item => item.reviewId)).size, 160);
  assert.equal(Object.keys(privateMap.reviewIdToCaseId).length, 160);
  assert.ok(corpus.cases.every(item => !serializedBlind.includes(item.id)),
    'blind case file must not reveal source case ids');
  assert.ok(!serializedBlind.includes('"expect"') && !serializedBlind.includes('"category"')
    && !serializedBlind.includes('"split"'), 'blind case file must not reveal authored labels or grouping');

  const originalBriefs = fs.readFileSync(path.join(bundlePath, 'briefs.jsonl'));
  const alteredBriefs = blindCases.map((item, index) => JSON.stringify(index === 0
    ? { ...item, brief: item.brief + ' altered' } : item)).join('\n') + '\n';
  fs.writeFileSync(path.join(bundlePath, 'briefs.jsonl'), alteredBriefs);
  assert.throws(() => verifyAnswers(bundlePath, [], 'fixture reviewer', corpus), /non-blind fields/);
  fs.writeFileSync(path.join(bundlePath, 'briefs.jsonl'), originalBriefs);

  const answers = blindCases.map(item => {
    const source = corpus.cases.find(row => row.id === privateMap.reviewIdToCaseId[item.reviewId]);
    return {
      reviewId: item.reviewId,
      label: {
        kind: source.expect.kind,
        scene: source.expect.kind === 'candidate' ? source.expect.scene : null,
        checks: source.expect.checks || [],
        critical: source.expect.critical === true,
      },
      confidence: 'high',
      note: 'Synthetic answer used only to verify the review importer.',
    };
  });
  const accepted = verifyAnswers(bundlePath, answers, 'fixture reviewer', corpus);
  assert.equal(accepted.reviewedCases, 160);
  assert.equal(accepted.labelsConfirmed, true);
  assert.equal(accepted.releaseEligible, false);

  const mismatch = answers.map(answer => ({ ...answer, label: { ...answer.label } }));
  const candidate = mismatch.find(answer => answer.label.kind === 'candidate');
  candidate.label.critical = !candidate.label.critical;
  const rejected = verifyAnswers(bundlePath, mismatch, 'fixture reviewer', corpus);
  assert.equal(rejected.labelsConfirmed, false);
  assert.equal(rejected.disagreementCount, 1);
  assert.throws(() => verifyAnswers(bundlePath, answers.slice(1), 'fixture reviewer', corpus), /cover every reviewId/);
  assert.throws(() => verifyAnswers(bundlePath, [...answers, answers[0]], 'fixture reviewer', corpus), /duplicate reviewId/);
  const invalidPath = answers.map(answer => ({ ...answer, label: { ...answer.label, checks: answer.label.checks.slice() } }));
  invalidPath.find(answer => answer.label.kind === 'candidate').label.checks.push(['sc.not-a-field', 'eq', 1]);
  assert.throws(() => verifyAnswers(bundlePath, invalidPath, 'fixture reviewer', corpus), /not available/);

  console.log('StageIntent blind label review: 160 opaque cases, private mapping, complete coverage, mismatch reporting, and invalid answer rejection passed');
} finally {
  assert.ok(path.dirname(tempRoot) === os.tmpdir(), 'temporary review path must stay under the OS temp directory');
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
